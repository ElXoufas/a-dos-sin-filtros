'use strict';
// Entrega privada de archivos cifrados por el navegador. Solo se retiene
// temporalmente el contenido cifrado en RAM; no se escribe en disco.
const crypto = require('node:crypto');
const MiB = 1024 * 1024;
const CHUNK_BYTES = MiB;
const MAX_VIDEO_BYTES = 150 * MiB;
const MAX_PHOTO_BYTES = 15 * MiB;
const MAX_VOICE_BYTES = 15 * MiB;
const MAX_BUFFERED_BYTES = 230 * MiB;
const UPLOAD_TTL = 10 * 60_000;
const DELIVERED_TTL = 15 * 60_000;
const FILES = new Map();
let storedBytes = 0;

function createTransferLayer({findRoomAndPlayer, allowCamera, allowTodo, broadcast, json, corsSafe, error, readBody}) {
  function erase(file) {
    if (!file || !FILES.has(file.id)) return;
    storedBytes = Math.max(0, storedBytes - file.received);
    file.parts.length = 0;
    FILES.delete(file.id);
  }
  function prune() {
    const now = Date.now();
    for (const f of FILES.values()) if (f.expires < now) erase(f);
  }
  function eraseRoom(room) {
    for (const f of FILES.values()) if (f.room === room) erase(f);
  }
  function revokeRound(room) {
    for (const f of FILES.values()) if (f.room === room && f.context === 'round') erase(f);
  }
  function validFile(room, id) {
    const f = FILES.get(String(id || ''));
    if (!f || f.room !== room || Date.now() > f.expires) error('El archivo ya no está disponible. Pide que lo vuelvan a enviar.',404);
    return f;
  }
  function validateSender(room, p, f) {
    if (f.fromId !== p.id) error('No tienes acceso a este envío.',403);
    if (f.context === 'round') {
      if (!allowCamera(room) || (room.settings.level === 'todo' && !allowTodo(room))) error('Se ha retirado el consentimiento de cámara.',403);
      if (!room.game.started || room.game.stage !== 'prompt' || room.game.turn !== p.id || room.game.round !== f.round || room.game.card?.media !== f.kind) error('Esta ronda ha terminado. Elige otro archivo.',409);
      if (room.game.mediaSentRound === f.round) error('Ya se ha enviado el archivo de esta ronda.',409);
    } else if (room.players.length !== 2) error('Tu pareja ya no está en la sala.',409);
  }
  function message(room, msg) {
    room.messages.push(msg);
    if (room.messages.length > 65) room.messages.splice(0,room.messages.length-65);
  }
  function fileMeta(f) {
    return {id:f.id,kind:f.kind,mime:f.mime,size:f.size,duration:f.duration,
      nonce:f.nonce,chunks:f.chunkCount,partSize:CHUNK_BYTES,expires:f.expires};
  }
  async function start(body) {
    prune();
    const {room,p} = findRoomAndPlayer(body);
    const {kind,context} = body;
    if (!(context === 'round' && (kind === 'foto' || kind === 'video')) && !(context === 'chat' && kind === 'audio')) error('Tipo de envío no válido.');
    const mime = String(body.mime || '').toLowerCase().split(';')[0];
    const formats = {
      foto:['image/jpeg','image/png','image/webp','image/heic','image/heif'],
      video:['video/mp4','video/webm','video/quicktime'],
      audio:['audio/webm','audio/mp4','audio/ogg','audio/mpeg','audio/wav','audio/aac','audio/x-m4a','audio/3gpp']
    };
    if (!formats[kind].includes(mime)) error('Formato no compatible. Usa MP4, WebM o un formato habitual de audio o fotografía.');
    const size = Number(body.size);
    const limit = kind === 'video' ? MAX_VIDEO_BYTES : kind === 'foto' ? MAX_PHOTO_BYTES : MAX_VOICE_BYTES;
    if (!Number.isSafeInteger(size) || size < 1 || size > limit) error(`El archivo es demasiado grande. Límite: ${limit / MiB} MB.`,413);
    const duration = Number(body.duration);
    if (kind !== 'foto' && (!Number.isFinite(duration) || duration <= 0 || duration > (kind === 'video' ? 300 : 120.5))) error(kind === 'video' ? 'Los vídeos deben durar 5 minutos o menos.' : 'Los audios deben durar 2 minutos o menos.');
    const nonce = String(body.nonce || '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(nonce)) error('Identificador criptográfico incorrecto.');
    if (room.players.length !== 2) error('Deben estar las dos personas en la sala.',409);
    if (context === 'round') {
      const mock = {fromId:p.id,context,round:room.game.round,kind};
      validateSender(room,p,mock);
    }
    // No se aceptan varias cargas pendientes a la vez desde la misma sala.
    const active = [...FILES.values()].find(f=>f.room === room && !f.complete);
    if (active && active.fromId === p.id) erase(active);
    else if (active) error('Tu pareja tiene un envío en curso. Esperad a que termine.',409);
    const id = crypto.randomBytes(16).toString('hex');
    const count = Math.ceil(size / CHUNK_BYTES);
    const f = {id,room,fromId:p.id,toId:room.players.find(x=>x.id!==p.id).id,context,kind,mime,
      size,duration:kind === 'foto' ? null : duration,nonce,chunkCount:count,parts:Array(count).fill(null),
      received:0,complete:false,round:context === 'round'?room.game.round:null,expires:Date.now()+UPLOAD_TTL};
    FILES.set(id,f);
    return {ok:true,id,chunkSize:CHUNK_BYTES,chunks:count};
  }
  async function receiveBytes(req, max) {
    if (Number(req.headers['content-length']) > max) error('Fragmento demasiado grande.',413);
    const chunks=[];let total=0;
    for await (const chunk of req) {
      total+=chunk.length;
      if (total>max) error('Fragmento demasiado grande.',413);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks,total);
  }
  async function writeChunk(req,res) {
    const {room,p} = findRoomAndPlayer({room:req.headers['x-ados-room'],token:req.headers['x-ados-token']});
    const f = validFile(room,req.headers['x-ados-upload']);
    validateSender(room,p,f);
    if (f.complete) error('Este envío ya está terminado.',409);
    const index = Number(req.headers['x-ados-index']);
    if (!Number.isSafeInteger(index) || index < 0 || index >= f.chunkCount) error('Número de fragmento incorrecto.');
    const expected = Math.min(CHUNK_BYTES,f.size-index*CHUNK_BYTES)+16;
    const chunk = await receiveBytes(req,expected);
    if (chunk.length !== expected) error('Fragmento cifrado incompleto.',400);
    // Reenvíos idempotentes: nunca sobreescriben otro fragmento con distinto contenido.
    if (f.parts[index]) {
      if (!f.parts[index].equals(chunk)) error('Fragmento repetido con contenido diferente.',409);
      return json(res,200,{ok:true,index,reused:true});
    }
    if (storedBytes + chunk.length > MAX_BUFFERED_BYTES) error('El servidor tiene demasiado contenido temporal. Esperad unos minutos y volved a probar.',503);
    f.parts[index] = chunk;
    f.received += chunk.length;
    storedBytes += chunk.length;
    f.expires=Date.now()+UPLOAD_TTL;
    return json(res,200,{ok:true,index});
  }
  function finish(body) {
    const {room,p} = findRoomAndPlayer(body);
    const f=validFile(room,body.id);
    validateSender(room,p,f);
    if (f.complete) error('Este archivo ya se ha compartido.',409);
    if (f.parts.some(x=>!x) || f.received !== f.size + 16*f.chunkCount) error('Faltan partes del archivo. Reanuda o repite el envío.',409);
    f.complete=true;
    f.expires=Date.now()+DELIVERED_TTL;
    if (f.context==='round') room.game.mediaSentRound=f.round;
    message(room,{id:crypto.randomUUID(),fromId:p.id,fromName:p.name,
      at:Date.now(),kind:f.context==='chat'?'voice':'media',file:fileMeta(f)});
    broadcast(room);
    return {ok:true,id:f.id};
  }
  function sendText(body) {
    const {room,p} = findRoomAndPlayer(body);
    if (room.players.length!==2) error('Espera a que entre tu pareja.',409);
    const iv = String(body.iv||''),data=String(body.data||'');
    if (!/^[A-Za-z0-9_-]{16}$/.test(iv) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length < 24 || data.length>5500) error('Mensaje cifrado incorrecto.');
    const now=Date.now();
    if (now-(p.lastChatAt||0)<500) error('Envía los mensajes un poco más despacio.',429);
    p.lastChatAt=now;
    message(room,{id:crypto.randomUUID(),fromId:p.id,fromName:p.name,at:now,kind:'text',iv,data});
    broadcast(room);
    return {ok:true};
  }
  function download(req,res,url) {
    const {room,p}=findRoomAndPlayer({room:req.headers['x-ados-room'],token:req.headers['x-ados-token']});
    const f=validFile(room,url.searchParams.get('id'));
    if (!f.complete || f.toId!==p.id) error('Archivo no disponible para tu cuenta.',403);
    if (f.context==='round' && (!allowCamera(room) || (room.settings.level === 'todo' && !allowTodo(room)))) error('Ya no hay consentimiento para este contenido.',403);
    const i=Number(url.searchParams.get('i'));
    if (!Number.isSafeInteger(i)||i<0||i>=f.chunkCount||!f.parts[i]) error('Fragmento no encontrado.',404);
    corsSafe(res);
    res.setHeader('Content-Type','application/octet-stream');
    res.setHeader('Content-Length',f.parts[i].length);
    res.end(f.parts[i]);
  }
  function cancel(body) {
    const {room,p}=findRoomAndPlayer(body);
    const f=validFile(room,body.id);
    if (f.fromId!==p.id || f.complete) error('No se puede cancelar este archivo.',403);
    erase(f);
    return {ok:true};
  }
  return {start,writeChunk,finish,sendText,download,cancel,prune,eraseRoom,revokeRound,
    stats:()=>({transfers:FILES.size,bufferedBytes:storedBytes})};
}
module.exports = {createTransferLayer, CHUNK_BYTES, MAX_VIDEO_BYTES, MAX_VOICE_BYTES};
