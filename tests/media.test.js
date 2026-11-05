'use strict';
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto, randomBytes } = require('node:crypto');
const {server, ROOMS} = require('../server');
let base;
before(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
async function api(route, body, expected = 200) {
  const r = await fetch(base + route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await r.json();
  assert.equal(r.status,expected,JSON.stringify(data));
  return data;
}
async function getSse(reader, event) {
  const decoder = new TextDecoder();
  let buffer='';
  const deadline = Date.now()+4000;
  while (Date.now() < deadline) {
    const result = await Promise.race([reader.read(),new Promise((_,reject)=>setTimeout(()=>reject(Error('SSE timeout')),4000))]);
    if (result.done) throw Error('SSE stream closed');
    buffer += decoder.decode(result.value,{stream:true});
    const lines=buffer.split(/\n\n/);
    for(const frame of lines.slice(0,-1)) {
      if (frame.startsWith(`event: ${event}\n`)) return JSON.parse(frame.slice(frame.indexOf('data: ')+6));
    }
    buffer = lines.at(-1);
  }
  throw Error(`No SSE event ${event}`);
}
test('archivo cifrado va a la persona invitada, no aparece en el estado y no permite duplicados',async () => {
  const a=await api('/api/create',{name:'Uno',adult:true,level:'intenso',cameraEnabled:true,mediaConsent:true});
  const b=await api('/api/join',{name:'Dos',code:a.room,adult:true,mediaConsent:true});
  await api('/api/action',{room:a.room,token:a.token,type:'ready',value:true});
  await api('/api/action',{room:b.room,token:b.token,type:'ready',value:true});
  await api('/api/action',{room:a.room,token:a.token,type:'start'});
  const room = ROOMS.get(a.room);
  room.game.turn = a.playerId;
  room.game.stage = 'prompt';
  room.game.card = {kind:'dare',media:'foto',text:'Foto privada voluntaria'};
  const abort = new AbortController();
  const stream = await fetch(`${base}/api/events?room=${a.room}&token=${b.token}`,{signal:abort.signal});
  const reader = stream.body.getReader();
  await getSse(reader,'state');
  const raw = Buffer.from('private bytes for a fictitious photo');
  const secret = randomBytes(32);
  const key = await webcrypto.subtle.importKey('raw',secret,'AES-GCM',false,['encrypt','decrypt']);
  const iv = randomBytes(12);
  const cipher = Buffer.from(await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,raw));
  const item = {kind:'foto',mime:'image/png',iv:iv.toString('base64url'),data:cipher.toString('base64')};
  await api('/api/media',{room:a.room,token:b.token,item},403);
  await api('/api/media',{room:a.room,token:a.token,item:{...item,mime:'text/html'}},400);
  await api('/api/media',{room:a.room,token:a.token,item});
  const event = await getSse(reader,'media');
  assert.equal(event.kind,'foto');
  assert.equal(event.round,1);
  assert.equal(event.from,'Uno');
  assert.equal(event.data,item.data);
  assert.equal(Buffer.from(event.data,'base64').equals(raw),false);
  const plain = Buffer.from(await webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(event.iv,'base64url')},key,Buffer.from(event.data,'base64')));
  assert.deepEqual(plain,raw);
  await api('/api/media',{room:a.room,token:a.token,item},409);
  const state = await (await fetch(`${base}/api/state?room=${a.room}&token=${b.token}`)).json();
  assert.equal(JSON.stringify(state).includes(item.data),false);
  await api('/api/action',{room:b.room,token:b.token,type:'mediaConsent',value:false});
  await api('/api/media',{room:a.room,token:a.token,item},403);
  abort.abort();
  await api('/api/leave',{room:a.room,token:a.token});
});
