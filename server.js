'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fallbackDecks = require('./v6-decks');
const {
  cards, cameraCards,
  cameraCardsIntenso = fallbackDecks.cameraCardsIntenso,
  todoValeCards = fallbackDecks.todoValeCards
} = require('./cards');
const {createTransferLayer} = require('./transfer-layer');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOMS = new Map();
const ACCESS_LOG = new Map();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOT = path.resolve(__dirname, 'public');
const MAX_ROOMS = 500;
const MAX_AGE = 6 * 60 * 60 * 1000;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
const MAX_MEDIA_POST_BYTES = 17 * 1024 * 1024;

function randomCode() {
  let s;
  do { s = Array.from(crypto.randomBytes(6), n => ALPHABET[n % ALPHABET.length]).join(''); }
  while (ROOMS.has(s));
  return s;
}
function player(name, mediaConsent, todoConsent) {
  return {
    id: crypto.randomUUID(), token: crypto.randomBytes(24).toString('hex'),
    name: String(name || '').trim().replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 22),
    mediaConsent: Boolean(mediaConsent), todoConsent: Boolean(todoConsent), ready: false, points: 0, streams: new Set()
  };
}
function error(msg, status = 400) { const e = new Error(msg); e.status = status; throw e; }
function corsSafe(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
}
function json(res, status, data) {
  corsSafe(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function readBody(req, maxBytes = 12_000) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return reject(Object.assign(new Error('Usa solicitudes JSON.'), { status: 415 }));
    }
    let total = 0;
    const chunks = [];
    let failed = false;
    req.on('data', chunk => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        failed = true; reject(Object.assign(new Error('Solicitud demasiado grande.'), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('JSON no válido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function throttle(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const current = Date.now();
  let entry = ACCESS_LOG.get(ip);
  if (!entry || current - entry.start > 60_000) { entry = { start:current, count:0 }; ACCESS_LOG.set(ip, entry); }
  if (++entry.count > 120) error('Demasiadas solicitudes. Prueba dentro de un minuto.', 429);
}
function allowCamera(room) {
  return room.settings.cameraEnabled && room.players.length === 2 && room.players.every(p => p.mediaConsent);
}
function allowTodo(room) {
  return allowCamera(room) && room.players.every(p => p.todoConsent);
}
function publicState(room, requester) {
  return {
    code: room.code, me: requester.id, host: room.players[0]?.id,
    players: room.players.map(p => ({ id:p.id, name:p.name, ready:p.ready, mediaConsent:p.mediaConsent, todoConsent:p.todoConsent, online:p.streams.size > 0, points:p.points })),
    settings: { ...room.settings, cameraActive: allowCamera(room), todoValeActive: allowTodo(room), customCount: room.customCards.length, customPhotoCount: room.customCards.filter(c => c.kind === 'dare' && c.media === 'foto').length, customVideoCount: room.customCards.filter(c => c.kind === 'dare' && c.media === 'video').length },
    game: {
      started: room.game.started, stage: room.game.stage, turn: room.game.turn,
      card: room.game.card, round:room.game.round, timerEnd:room.game.timerEnd,
      history: room.game.history.slice(-7).reverse()
    },
    messages: room.messages.slice(-65)
  };
}
function broadcast(room) {
  room.lastActivity = Date.now();
  for (const p of room.players) {
    const frame = `event: state\ndata: ${JSON.stringify(publicState(room, p))}\n\n`;
    for (const s of p.streams) { try { s.write(frame); } catch { p.streams.delete(s); } }
  }
}
function findRoomAndPlayer(body) {
  const code = String(body.room || '').trim().toUpperCase();
  const room = ROOMS.get(code);
  if (!room) error('Esa sala ya no existe. Cread otra.', 404);
  const p = room.players.find(x => x.token === body.token);
  if (!p) error('Tu acceso a esta sala no es válido.', 403);
  return { room, p };
}
function deckPick(room, key, pool) {
  if (!pool.length) error('No hay cartas disponibles para esta selección.');
  if (!room.used.has(key)) room.used.set(key, new Set());
  const seen = room.used.get(key);
  if (seen.size >= pool.length) seen.clear();
  const indexes = pool.map((_,i) => i).filter(i => !seen.has(i));
  const index = indexes[crypto.randomInt(indexes.length)];
  seen.add(index);
  return pool[index];
}
function nextTurn(room, outcome) {
  const game = room.game;
  const current = room.players.find(p => p.id === game.turn);
  if (current) {
    if (outcome === 'done') current.points += game.card?.media ? 3 : game.card?.kind === 'dare' ? 2 : 1;
    if (game.card) game.history.push({ player:current.name, kind:game.card.kind, media:game.card.media || null, outcome, round: game.round });
  }
  game.turn = room.players.find(p => p.id !== game.turn)?.id || game.turn;
  game.round++;
  game.stage = 'choose'; game.card = null; game.timerEnd = null;
}
function requireHost(room,p) { if (room.players[0]?.id !== p.id) error('Solo quien creó la sala puede hacer eso.',403); }
function act(room, p, type, value) {
  room.lastActivity = Date.now();
  if (type === 'addCard') {
    if (!value || typeof value !== 'object') error('Carta incorrecta.');
    const kind = value.kind === 'truth' ? 'truth' : value.kind === 'dare' ? 'dare' : null;
    const media = ['foto','video'].includes(value.media) ? value.media : null;
    const content = typeof value.text === 'string' ? value.text.trim().replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,220) : '';
    if (!kind || content.length < 8) error('Escribe al menos 8 caracteres y elige verdad o reto.');
    if (media && kind !== 'dare') error('Las cartas de cámara deben ser retos.');
    if (room.customCards.length >= 100) error('El máximo es de 100 cartas personalizadas.');
    room.customCards.push({ kind, media, text:content });
    return;
  }
  if (type === 'mediaConsent') {
    p.mediaConsent = Boolean(value);
    if (room.game.card?.media && (room.settings.level === 'todo' ? !allowTodo(room) : !allowCamera(room))) {
      room.game.stage = 'choose'; room.game.card = null; room.game.timerEnd = null;
    }
    return;
  }
  if (type === 'todoConsent') {
    p.todoConsent = Boolean(value);
    if (room.settings.level === 'todo' && !allowTodo(room)) {
      room.game.stage = 'choose'; room.game.card = null; room.game.timerEnd = null;
    }
    return;
  }
  if (type === 'ready') {
    if (room.game.started) error('La partida ya ha comenzado.');
    p.ready = Boolean(value);
    return;
  }
  if (type === 'settings') {
    requireHost(room,p);
    if (room.game.started) error('Las reglas se cambian antes de comenzar.');
    if (!value || typeof value !== 'object') error('Configuración no válida.');
    if (['chispa','fuego','intenso','todo'].includes(value.level)) room.settings.level = value.level;
    if (typeof value.onlyCustomTodo === 'boolean') room.settings.onlyCustomTodo = value.onlyCustomTodo;
    if (room.settings.level === 'todo') room.settings.cameraEnabled = true;
    else if (typeof value.cameraEnabled === 'boolean') room.settings.cameraEnabled = value.cameraEnabled;
    room.players.forEach(x => x.ready = false);
    return;
  }
  if (type === 'start') {
    requireHost(room,p);
    if (room.game.started) error('La partida ya está empezada.');
    if (room.players.length !== 2 || !room.players.every(x => x.ready)) error('Deben estar las dos personas y marcar Listo.');
    if (room.settings.level === 'todo' && !allowTodo(room)) error('TODO VALE requiere que ambos aceptéis los retos +18 y la cámara.');
    if (room.settings.level === 'todo' && room.settings.onlyCustomTodo && !['foto','video'].every(media => room.customCards.some(c => c.kind === 'dare' && c.media === media))) error('Para usar solo vuestros retos, añadid al menos uno de foto y uno de vídeo.');
    room.game = { started:true, stage:'choose', turn:room.players[crypto.randomInt(2)].id, card:null, round:1, timerEnd:null, history:[] };
    return;
  }
  if (type === 'restart') {
    requireHost(room,p);
    room.game = { started:false, stage:'choose', turn:null, card:null, round:1, timerEnd:null, history:[] };
    room.players.forEach(x => { x.ready=false; x.points=0; });
    room.used.clear();
    return;
  }
  if (!room.game.started || room.players.length !== 2) error('Todavía no se puede jugar.');
  if (room.game.turn !== p.id) error('Ahora es el turno de la otra persona.',403);
  if (type === 'pick') {
    if (room.game.stage !== 'choose') error('Termina antes la carta actual.');
    if (room.settings.level === 'todo') {
      if (!allowTodo(room)) error('TODO VALE necesita el consentimiento de ambos para fotos, vídeos y desnudez.', 403);
      let media = String(value);
      if (media === 'random') media = crypto.randomInt(2) ? 'foto' : 'video';
      if (!['foto','video'].includes(media)) error('En TODO VALE solo existen retos de foto o vídeo.');
      const options = room.customCards.filter(c => c.kind === 'dare' && c.media === media);
      const custom = room.settings.onlyCustomTodo || (options.length && crypto.randomInt(100) < 35);
      if (room.settings.onlyCustomTodo && !options.length) error('Añadid al menos un reto privado de ese tipo.');
      const selected = custom ? deckPick(room, `custom:todo:${media}`, options) : deckPick(room, `todo:${media}`, todoValeCards[media]);
      room.game.card = {kind:'dare',text:selected.text,media};
      room.game.stage = 'prompt'; room.game.timerEnd = null;
      return;
    }
    let kind = String(value);
    if (kind === 'random') kind = crypto.randomInt(2) ? 'truth' : 'dare';
    if (!['truth','dare'].includes(kind)) error('Tipo de carta no válido.');
    const camera = kind === 'dare' && allowCamera(room) && crypto.randomInt(room.settings.level === 'intenso' ? 2 : 4) === 0;
    const options = room.customCards.filter(c => c.kind === kind && (allowCamera(room) || !c.media) && (camera ? Boolean(c.media) : !c.media));
    const custom = options.length && crypto.randomInt(100) < 40;
    const selected = custom
      ? deckPick(room, `custom:${kind}:${camera}`, options)
      : camera ? deckPick(room, room.settings.level === 'intenso' ? 'camera:intenso' : 'camera', room.settings.level === 'intenso' ? cameraCardsIntenso : cameraCards)
      : deckPick(room, `${room.settings.level}:${kind}`, cards[room.settings.level][kind]);
    room.game.card = { kind, text:selected.text || selected, media: selected.media || null };
    room.game.stage = 'prompt'; room.game.timerEnd = null;
    return;
  }
  if (type === 'timer') {
    if (room.game.stage !== 'prompt') error('No hay un reto activo.');
    if (room.game.timerEnd) error('El temporizador ya ha comenzado.');
    room.game.timerEnd = Date.now() + (room.game.card?.media === 'video' ? 300_000 : 60_000);
    return;
  }
  if (type === 'finish' || type === 'skip') {
    if (room.game.stage !== 'prompt') error('No hay una carta pendiente.');
    nextTurn(room, type === 'finish' ? 'done' : 'skip');
    return;
  }
  error('Acción desconocida.');
}
const transferLayer = createTransferLayer({findRoomAndPlayer,allowCamera,allowTodo,broadcast,json,corsSafe,error,readBody});
function cleanOldRooms() {
  const now = Date.now();
  for (const [code, room] of ROOMS) {
    if (now - room.lastActivity > MAX_AGE && room.players.every(p => p.streams.size === 0)) { transferLayer.eraseRoom(room); ROOMS.delete(code); }
  }
  transferLayer.prune();
  for (const [ip, rec] of ACCESS_LOG) if (now - rec.start > 90_000) ACCESS_LOG.delete(ip);
}
setInterval(cleanOldRooms, 60_000).unref();
function serveFile(req, res, pathname) {
  const fileName = pathname === '/' ? '/index.html' : pathname;
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(fileName) || fileName.includes('..')) return json(res,404,{error:'No encontrado.'});
  const full = path.resolve(ROOT, '.' + fileName);
  if (!full.startsWith(ROOT + path.sep)) return json(res,404,{error:'No encontrado.'});
  const mime = ({ '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' })[path.extname(full)] || 'application/octet-stream';
  fs.readFile(full, (err, data) => {
    if (err) return json(res,404,{error:'No encontrado.'});
    corsSafe(res); res.setHeader('Cache-Control', /\.(html|js|css)$/.test(full) ? 'no-cache, must-revalidate' : 'public, max-age=300');
    res.writeHead(200, { 'Content-Type':mime }); res.end(data);
  });
}
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health') return json(res,200,{ok:true,rooms:ROOMS.size});
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const {room,p} = findRoomAndPlayer({room:url.searchParams.get('room'),token:url.searchParams.get('token')});
      corsSafe(res);
      res.writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.write(': connected\n\n');
      p.streams.add(res);
      // Heartbeat mantiene la conexión cuando no hay acciones.
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); } }, 22_000);
      broadcast(room);
      req.on('close', () => {
        clearInterval(heartbeat); p.streams.delete(res);
        setTimeout(() => { if (ROOMS.has(room.code)) broadcast(room); }, 1500).unref();
      });
      return;
    }
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const {room,p} = findRoomAndPlayer({room:url.searchParams.get('room'),token:url.searchParams.get('token')});
      return json(res,200,{ok:true,state:publicState(room,p)});
    }
    // Fragmentos binarios: ruta independiente del límite JSON de la versión anterior.
    if (url.pathname === '/api/upload/chunk' && req.method === 'POST') return await transferLayer.writeChunk(req,res);
    if (url.pathname === '/api/upload/chunk' && req.method === 'GET') return transferLayer.download(req,res,url);
    if (url.pathname.startsWith('/api/') && req.method === 'POST') {
      throttle(req);
      const body = await readBody(req, url.pathname === '/api/media' ? MAX_MEDIA_POST_BYTES : 12_000);
      if (url.pathname === '/api/upload/start') return json(res,200,await transferLayer.start(body));
      if (url.pathname === '/api/upload/finish') return json(res,200,transferLayer.finish(body));
      if (url.pathname === '/api/upload/cancel') return json(res,200,transferLayer.cancel(body));
      if (url.pathname === '/api/chat/text') return json(res,200,transferLayer.sendText(body));
      if (url.pathname === '/api/media') {
        const {room,p} = findRoomAndPlayer(body);
        if (!allowCamera(room) || (room.settings.level === 'todo' && !allowTodo(room))) error('Los dos tenéis que aceptar el modo cámara y TODO VALE.', 403);
        const game = room.game;
        if (!game.started || game.stage !== 'prompt' || game.turn !== p.id || !game.card?.media) error('Solo puedes enviar medios en tu reto de cámara activo.', 403);
        const item = body.item;
        const mediaType = game.card.media;
        const recipient = room.players.find(x => x.id !== p.id);
        if (!recipient || !recipient.streams.size) error('Tu pareja no está conectada. Vuelve a intentarlo.', 409);
        if (game.mediaSentRound === game.round) error('Ya enviaste un archivo en esta ronda.', 409);
        if (!item || typeof item !== 'object' || item.kind !== mediaType || typeof item.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(item.iv) || typeof item.data !== 'string') error('Archivo cifrado no válido.');
        const allowed = mediaType === 'foto' ? ['image/jpeg','image/png','image/webp','image/heic','image/heif'] : ['video/mp4','video/webm','video/quicktime'];
        if (!allowed.includes(item.mime) || !/^[a-zA-Z0-9+/]+={0,2}$/.test(item.data) || item.data.length < 20) error('Formato multimedia no admitido.');
        const bytes = Math.floor(item.data.length * 3 / 4) - (item.data.endsWith('==') ? 2 : item.data.endsWith('=') ? 1 : 0);
        if (bytes > MAX_MEDIA_BYTES + 16) error('Archivo demasiado grande. Máximo 12 MB.',413);
        if (bytes < 17) error('Archivo no válido.');
        const frame = `event: media\ndata: ${JSON.stringify({kind:mediaType,mime:item.mime,iv:item.iv,data:item.data,round:game.round,from:p.name})}\n\n`;
        let forwarded = false;
        for (const stream of recipient.streams) {
          if (stream.writable && !stream.destroyed && stream.writableLength < 256 * 1024) {
            try { stream.write(frame); forwarded = true; break; } catch {}
          }
        }
        if (!forwarded) error('No se pudo entregar el archivo. Reinténtalo.', 409);
        game.mediaSentRound = game.round;
        room.lastActivity = Date.now();
        return json(res,200,{ok:true});
      }
      if (url.pathname === '/api/create') {
        if (!body.adult) error('Este juego está reservado para mayores de 18 años.');
        if (typeof body.name !== 'string' || !body.name.trim()) error('Escribe un nombre.');
        if (ROOMS.size >= MAX_ROOMS) error('El servidor tiene muchas salas activas. Prueba más tarde.',503);
        const code = randomCode();
        const p = player(body.name,body.mediaConsent,body.todoConsent);
        if (!p.name) error('Nombre no válido.');
        const level = ['chispa','fuego','intenso','todo'].includes(body.level) ? body.level : 'fuego';
        const room = {
          code, players:[p], settings:{level,cameraEnabled:level === 'todo' || Boolean(body.cameraEnabled),onlyCustomTodo:false},
          game:{started:false,stage:'choose',turn:null,card:null,round:1,timerEnd:null,history:[]},
          used:new Map(),customCards:[],messages:[],lastActivity:Date.now()
        };
        ROOMS.set(code,room);
        return json(res,200,{ok:true, room:code, token:p.token, playerId:p.id, state:publicState(room,p)});
      }
      if (url.pathname === '/api/join') {
        if (!body.adult) error('Este juego está reservado para mayores de 18 años.');
        if (typeof body.name !== 'string' || !body.name.trim()) error('Escribe un nombre.');
        const code = String(body.code || '').trim().toUpperCase();
        const room = ROOMS.get(code);
        if (!room) error('No encontramos esa sala. Comprueba el código.',404);
        if (room.players.length >= 2) error('Esta sala ya está completa.',409);
        if (room.game.started) error('La partida ya está comenzada.',409);
        const p = player(body.name,body.mediaConsent,body.todoConsent);
        if (!p.name) error('Nombre no válido.');
        room.players.push(p);broadcast(room);
        return json(res,200,{ok:true,room:code,token:p.token,playerId:p.id,state:publicState(room,p)});
      }
      if (url.pathname === '/api/leave') {
        const {room,p} = findRoomAndPlayer(body);
        const isHost = room.players[0]?.id === p.id;
        if (isHost) {
          for (const member of room.players) for (const stream of member.streams) {
            try { stream.write('event: closed\ndata: {}\n\n'); stream.end(); } catch {}
          }
          transferLayer.eraseRoom(room);
          ROOMS.delete(room.code);
        } else {
          for (const stream of p.streams) {try {stream.write('event: closed\ndata: {}\n\n');stream.end();}catch{}}
          transferLayer.eraseRoom(room);
          room.messages=[];
          room.players = room.players.filter(x => x.id !== p.id);
          room.game = {started:false,stage:'choose',turn:null,card:null,round:1,timerEnd:null,history:[]};
          room.players.forEach(x => {x.ready=false;x.points=0;});
          room.used.clear();broadcast(room);
        }
        return json(res,200,{ok:true});
      }
      if (url.pathname === '/api/action') {
        const {room,p} = findRoomAndPlayer(body);
        act(room,p,body.type,body.value);
        if ((body.type === 'mediaConsent' || body.type === 'todoConsent') && !body.value) transferLayer.revokeRound(room);
        if (body.type === 'settings' && !allowCamera(room)) transferLayer.revokeRound(room);
        broadcast(room);
        return json(res,200,{ok:true,state:publicState(room,p)});
      }
      return json(res,404,{error:'Ruta no encontrada.'});
    }
    if (url.pathname.startsWith('/api/')) return json(res,404,{error:'Ruta no encontrada.'});
    if (req.method === 'GET') return serveFile(req,res,url.pathname);
    return json(res,405,{error:'Método no permitido.'});
  } catch (err) {
    if (!res.headersSent && !res.destroyed) return json(res,err.status || 500,{ok:false,error:err.status ? err.message : 'Error interno del servidor.'});
  }
});
if (require.main === module) server.listen(PORT,HOST,() => console.log(`A DOS listo en http://localhost:${PORT}`));
module.exports = { server, ROOMS, act, publicState, transferLayer };
