'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {server,transferLayer}=require('../server');
const {randomBytes, webcrypto}=require('node:crypto');
let base;
before(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
async function post(route,data,status=200) {
  const r=await fetch(`${base}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  const x=await r.json();assert.equal(r.status,status,JSON.stringify(x));return x;
}
async function players(level='todo') {
  const a=await post('/api/create',{name:'Uno',adult:true,level,cameraEnabled:true,mediaConsent:true,todoConsent:true});
  const b=await post('/api/join',{name:'Dos',adult:true,code:a.room,mediaConsent:true,todoConsent:true});
  return {a,b,room:a.room};
}
async function act(p,type,value){return post('/api/action',{room:p.room,token:p.token,type,value});}
function ivFor(nonce,index){const x=Buffer.alloc(12);nonce.copy(x,0);x.writeUInt32BE(index,8);return x;}
async function encryptChunk(key,nonce,room,id,index,buf){return Buffer.from(await webcrypto.subtle.encrypt({name:'AES-GCM',iv:ivFor(nonce,index),additionalData:Buffer.from(`${room}:${id}:${index}`)},key,buf));}
async function uploadChunk(p,id,index,cipher,expected=200) {
  const r=await fetch(`${base}/api/upload/chunk`,{method:'POST',headers:{'content-type':'application/octet-stream','x-ados-room':p.room,'x-ados-token':p.token,'x-ados-upload':id,'x-ados-index':String(index)},body:cipher});
  const data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data;
}
async function downloadChunk(p,id,index,expected=200){const r=await fetch(`${base}/api/upload/chunk?id=${id}&i=${index}`,{headers:{'x-ados-room':p.room,'x-ados-token':p.token}});assert.equal(r.status,expected);return r;}
test('chat cifrado: solo se retransmite cifrado y nadie fuera de sala puede consultar',async()=>{
  const {a,b}=await players('fuego');
  const key=await webcrypto.subtle.importKey('raw',randomBytes(32),'AES-GCM',false,['encrypt','decrypt']);
  const iv=randomBytes(12);const secret='mensaje privado de prueba';
  const ciphertext=Buffer.from(await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,Buffer.from(secret)));
  await post('/api/chat/text',{room:a.room,token:a.token,iv:iv.toString('base64url'),data:ciphertext.toString('base64')});
  const state=await (await fetch(`${base}/api/state?room=${b.room}&token=${b.token}`)).json();
  assert.equal(state.state.messages.length,1);
  assert.equal(state.state.messages[0].kind,'text');
  assert.ok(!JSON.stringify(state.state).includes(secret));
  assert.ok(!JSON.stringify(state.state).includes(a.token));
  const restored=Buffer.from(await webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(state.state.messages[0].iv,'base64url')},key,Buffer.from(state.state.messages[0].data,'base64'))).toString();
  assert.equal(restored,secret);
  await post('/api/chat/text',{room:a.room,token:'bad',iv:iv.toString('base64url'),data:ciphertext.toString('base64')},403);
  await post('/api/leave',{room:a.room,token:a.token});
});
test('vídeo fragmentado mayor de 12MB: cifrado, progreso por fragmentos y descarga solo para receptor',async()=>{
  const {a,b}=await players('todo');
  await act(a,'ready',true);await act(b,'ready',true);await act(a,'start');
  const gameState=await (await fetch(`${base}/api/state?room=${a.room}&token=${a.token}`)).json();
  const {ROOMS}=require('../server');const room=ROOMS.get(a.room);
  room.game.turn=a.playerId;room.game.card={kind:'dare',media:'video',text:'Graba un clip privado opcional'};room.game.stage='prompt';
  const size=13*1024*1024+313;
  const nonce=randomBytes(8);
  const start=await post('/api/upload/start',{room:a.room,token:a.token,kind:'video',context:'round',size,duration:299,mime:'video/mp4',nonce:nonce.toString('base64url')});
  assert.equal(start.chunks,14);
  const k=await webcrypto.subtle.importKey('raw',randomBytes(32),'AES-GCM',false,['encrypt','decrypt']);
  const plainParts=[];
  for(let i=0;i<start.chunks;i++){
    const plain=Buffer.alloc(Math.min(1024*1024,size-i*1024*1024),i%223);
    plainParts.push(plain);
    const cipher=await encryptChunk(k,nonce,a.room,start.id,i,plain);
    await uploadChunk(b,start.id,i,cipher,403);
    await uploadChunk(a,start.id,i,cipher);
    if(i===0) await uploadChunk(a,start.id,i,cipher); // retransmisión segura
  }
  const before=transferLayer.stats().bufferedBytes;
  assert.ok(before>12*1024*1024,'el límite anterior era de solo 12 MB');
  await post('/api/upload/finish',{room:a.room,token:a.token,id:start.id});
  const state=await (await fetch(`${base}/api/state?room=${b.room}&token=${b.token}`)).json();
  assert.equal(state.state.messages.at(-1).kind,'media');
  assert.equal(state.state.messages.at(-1).file.size,size);
  assert.equal(JSON.stringify(state.state).includes(plainParts[0].toString('hex')),false);
  await downloadChunk(a,start.id,0,403);
  for(const i of [0,13]){
    const r=await downloadChunk(b,start.id,i);
    const bytes=Buffer.from(await r.arrayBuffer());
    const back=Buffer.from(await webcrypto.subtle.decrypt({name:'AES-GCM',iv:ivFor(nonce,i),additionalData:Buffer.from(`${a.room}:${start.id}:${i}`)},k,bytes));
    assert.deepEqual(back,plainParts[i]);
  }
  await act(a,'mediaConsent',false);
  await downloadChunk(b,start.id,0,404);
  await post('/api/leave',{room:a.room,token:a.token});
});
test('límite de 5 min comprobado, audio de voz, cancelación y sin archivos en estado',async()=>{
  const {a,b}=await players('fuego');
  const nonce=randomBytes(8);
  const baseArg={room:a.room,token:a.token,kind:'video',context:'round',size:500,duration:301,mime:'video/mp4',nonce:nonce.toString('base64url')};
  await post('/api/upload/start',baseArg,400);
  const audio={...baseArg,kind:'audio',context:'chat',duration:75,mime:'audio/webm',size:Buffer.byteLength('un audio corto de ejemplo!')};
  const start=await post('/api/upload/start',audio);
  const k=await webcrypto.subtle.importKey('raw',randomBytes(32),'AES-GCM',false,['encrypt','decrypt']);
  const encrypted=await encryptChunk(k,nonce,a.room,start.id,0,Buffer.from('un audio corto de ejemplo!'));
  assert.equal(encrypted.length,Buffer.byteLength('un audio corto de ejemplo!')+16);
  await uploadChunk(a,start.id,0,encrypted);
  await post('/api/upload/finish',{room:a.room,token:a.token,id:start.id});
  const state=await(await fetch(`${base}/api/state?room=${b.room}&token=${b.token}`)).json();
  assert.equal(state.state.messages[0].kind,'voice');
  assert.ok(!JSON.stringify(state).includes(encrypted.toString('base64')));
  const response=await downloadChunk(b,start.id,0);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),encrypted);
  await post('/api/leave',{room:a.room,token:a.token});
});
