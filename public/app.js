'use strict';
const $ = (id) => document.getElementById(id);
let joining = false;
let session = null;
let current = null;
let source = null;
let busy = false;
let toastHandle = null;
const modeNames = { chispa:'CHISPA', fuego:'FUEGO', intenso:'SIN TIMIDEZ +18', todo:'TODO VALE · +18' };
const storageKey = 'ados.sala.v1';
const safe = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// La clave se genera en el móvil y viaja en el fragmento #k= del enlace:
// los fragmentos no se envían al servidor. El servidor retransmite únicamente
// contenido cifrado con AES-GCM; retiene fragmentos cifrados temporalmente
// en memoria y nunca recibe ni almacena la clave privada.
let pendingSecret = null;
let selectedMedia = null;
let selectedMediaUrl = null;
let visibleMediaUrl = null;
let incomingMedia = null;
let mediaCleanupTimer = null;
let mediaStageKey = '';
let sendingMedia = false;
const MiB = 1024 * 1024;
const maxPhotoBytes = 15 * MiB;
const maxVideoBytes = 150 * MiB;
const maxVoiceBytes = 15 * MiB;
let lastChatSignature = '';
let selectedDuration = null;
let voiceRecording = null;
let voiceRecorded = null;
let voiceTimer = null;
let viewerUrl = null;
let viewing = false;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
function makeSecret() {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function mediaSecretFromInvite() {
  const k = new URLSearchParams(window.location.hash.slice(1)).get('k');
  return /^[A-Za-z0-9_-]{43}$/.test(k || '') ? k : null;
}
function secretBytes(secret) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret || '')) throw Error('No tienes la clave privada para compartir fotos o vídeos. Pide a tu pareja el enlace completo de la sala.');
  const text = atob(secret.replace(/-/g,'+').replace(/_/g,'/') + '=');
  return Uint8Array.from(text, c => c.charCodeAt(0));
}
async function aesKey() {
  if (!window.crypto?.subtle) throw Error('Para archivos privados abre el juego con HTTPS (o localhost).');
  return crypto.subtle.importKey('raw',secretBytes(session?.secret),{name:'AES-GCM'},false,['encrypt','decrypt']);
}
function toBase64(bytes) {
  const parts = [];
  for (let pos=0;pos<bytes.length;pos+=32768) parts.push(String.fromCharCode(...bytes.subarray(pos,pos+32768)));
  return btoa(parts.join(''));
}
function fromBase64(value) {
  const normalized = value.replace(/-/g,'+').replace(/_/g,'/');
  const data = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(data, c=>c.charCodeAt(0));
}
function clearMedia() {
  clearTimeout(mediaCleanupTimer);
  if (selectedMediaUrl) URL.revokeObjectURL(selectedMediaUrl);
  if (visibleMediaUrl) URL.revokeObjectURL(visibleMediaUrl);
  selectedMediaUrl = null; visibleMediaUrl = null;
  selectedMedia = null; selectedDuration = null; incomingMedia = null;
  if ($('mediaFile')) $('mediaFile').value = '';
  for (const id of ['mediaLocalPreview','mediaRemotePreview']) {if ($(id)) {$(id).replaceChildren();$(id).hidden = true;}}
  if ($('mediaIncoming')) $('mediaIncoming').hidden = true;
  if ($('closeMedia')) $('closeMedia').hidden = true;
  if ($('sendMedia')) {$('sendMedia').disabled = true; $('sendMedia').textContent = 'Enviar cifrado a mi pareja ♡';}
  if ($('mediaSendStatus')) $('mediaSendStatus').textContent='';
}
function mediaPreview(container, blob, mime) {
  const node = document.createElement(mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'img');
  if (node.tagName !== 'IMG') {node.controls = true;node.playsInline=true;node.preload='metadata';}
  else node.alt = 'Previsualización del archivo privado';
  const url = URL.createObjectURL(blob);
  node.src = url;
  container.replaceChildren(node);
  container.hidden = false;
  return url;
}
function actualMime(file) {
  if (file.type && file.type !== 'application/octet-stream') return file.type.toLowerCase();
  const extension = (file.name||'').split('.').pop().toLowerCase();
  return ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',mp3:'audio/mpeg',m4a:'audio/mp4',ogg:'audio/ogg',oga:'audio/ogg',wav:'audio/wav',aac:'audio/aac',amr:'audio/3gpp'})[extension] || '';
}
function renderMedia() {
  const game = current.game;
  const key = `${game.round}:${game.stage}:${game.card?.text || ''}`;
  if (mediaStageKey !== key) {clearMedia();mediaStageKey=key;}
  const active = game.stage === 'prompt' && Boolean(game.card?.media) && current.settings.cameraActive;
  const mine = game.turn === current.me;
  $('mediaSender').hidden = !active || !mine;
  $('mediaReceiver').hidden = !active || mine;
  if (!active) return;
  if (mine) {
    $('mediaFile').accept = game.card.media === 'foto' ? 'image/*' : 'video/*';
    $('mediaSendStatus').textContent ||= session.secret ? '' : 'Necesitas la clave privada del enlace de invitación.';
    $('sendMedia').disabled = !selectedMedia || !session.secret || sendingMedia;
  } else if (!incomingMedia) {
    $('mediaReceiverText').textContent = 'Si tu pareja decide compartir algo, aparecerá aquí. Puedes abrirlo o ignorarlo.';
  }
}
function base64url(bytes) {return toBase64(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function nonceFor(prefix,i) {
  const iv = new Uint8Array(12);iv.set(prefix);
  new DataView(iv.buffer).setUint32(8,i,false);
  return iv;
}
function sleep(ms) {return new Promise(r=>setTimeout(r,ms));}
function fileDuration(file,tag) {
  return new Promise((resolve,reject)=>{
    const el=document.createElement(tag);
    const url=URL.createObjectURL(file);
    const timeout=setTimeout(()=>finish(Error('No se pudo leer la duración. Prueba con MP4 o WebM.')),30000);
    let finished=false;
    function finish(err,duration) {
      if (finished) return;
      finished=true;clearTimeout(timeout);
      el.removeAttribute('src');el.load();URL.revokeObjectURL(url);
      if (err) reject(err);else resolve(duration);
    }
    el.preload='metadata';
    el.onloadedmetadata=()=>{
      const d=el.duration;
      if (!Number.isFinite(d)||d<=0) finish(Error('Este archivo no indica su duración. Usa un MP4 compatible.'));
      else finish(null,d);
    };
    el.onerror=()=>finish(Error('Tu navegador no puede analizar este formato. Prueba con un MP4.'));
    el.src=url;
  });
}
async function uploadEncrypted(file,kind,context,duration,onProgress) {
  if (!session?.secret) throw Error('Para enviar archivos o audios necesitáis el enlace privado completo.');
  const key=await aesKey();
  const prefix=crypto.getRandomValues(new Uint8Array(8));
  const mime=actualMime(file).split(';')[0];
  const body={room:session.room,token:session.token,kind,context,size:file.size,
    duration:kind==='foto'?null:duration,mime,nonce:base64url(prefix)};
  let transferId=null;
  try {
    const start=await request('/api/upload/start',body);
    transferId=start.id;
    for(let i=0;i<start.chunks;i++) {
      const plain=await file.slice(i*start.chunkSize,Math.min(file.size,(i+1)*start.chunkSize)).arrayBuffer();
      const aad=encoder.encode(`${session.room}:${start.id}:${i}`);
      const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonceFor(prefix,i),additionalData:aad},key,plain);
      let done=false;
      for(let attempt=0;attempt<4&&!done;attempt++) {
        try {
          const r=await fetch('/api/upload/chunk',{method:'POST',headers:{
            'Content-Type':'application/octet-stream',
            'X-ADOS-Room':session.room,'X-ADOS-Token':session.token,
            'X-ADOS-Upload':start.id,'X-ADOS-Index':String(i)
          },body:encrypted});
          if(!r.ok) {const x=await r.json().catch(()=>({}));throw Error(x.error||`Error de subida (${r.status})`);}
          done=true;
        }catch(e) {
          if(attempt===3 || /consentimiento|ronda|demasiado grande|no tienes acceso|lleno|servidor tiene demasiado/i.test(e.message)) throw e;
          await sleep(600*(attempt+1));
        }
      }
      onProgress?.(Math.round((i+1)/start.chunks*100));
    }
    const complete=await request('/api/upload/finish',{room:session.room,token:session.token,id:start.id});
    return complete;
  }catch(e) {
    if(transferId) request('/api/upload/cancel',{room:session.room,token:session.token,id:transferId}).catch(()=>{});
    throw e;
  }
}
async function downloadEncrypted(meta,onProgress) {
  const downloadSession = session;
  if (!downloadSession?.secret) throw Error('Necesitas el enlace completo con clave privada.');
  const key=await aesKey();
  const prefix=fromBase64(meta.nonce);
  const parts=[];
  for(let i=0;i<meta.chunks;i++) {
    let response;
    for(let attempt=0;attempt<4;attempt++) {
      if (session !== downloadSession) throw Error('La sala ha cambiado.');
      try {
        response=await fetch(`/api/upload/chunk?id=${encodeURIComponent(meta.id)}&i=${i}`,{
          headers:{'X-ADOS-Room':downloadSession.room,'X-ADOS-Token':downloadSession.token}
        });
        if(!response.ok) {const data=await response.json().catch(()=>({}));throw Error(data.error||'No se pudo descargar el archivo.');}
        break;
      }catch(e){if(attempt===3)throw e;await sleep(600*(attempt+1));}
    }
    const ciphertext=await response.arrayBuffer();
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:nonceFor(prefix,i),additionalData:encoder.encode(`${downloadSession.room}:${meta.id}:${i}`)},key,ciphertext);
    parts.push(plain);
    onProgress?.(Math.round((i+1)/meta.chunks*100));
  }
  return new Blob(parts,{type:meta.mime});
}
async function sendSelectedMedia() {
  if (!session || !selectedMedia || sendingMedia) return;
  if (!current?.settings?.cameraActive || current.game.turn !== current.me || !current.game.card?.media) return;
  if (!window.confirm('¿Compartir este archivo con tu pareja? Quien lo reciba puede guardarlo o hacer una captura.'))return;
  sendingMedia=true;
  $('sendMedia').disabled=true;
  $('mediaSendStatus').textContent='Preparando envío… 0 %';
  try {
    const file=selectedMedia,kind=current.game.card.media,duration=selectedDuration;
    await uploadEncrypted(file,kind,'round',duration,percent=>{
      $('mediaSendStatus').textContent=`Enviando cifrado… ${percent} %`;
    });
    $('sendMedia').textContent='Enviado ✓';
    $('mediaSendStatus').textContent='¡Entregado! Tu pareja puede abrirlo desde el chat privado durante 15 minutos.';
    selectedMedia=null;selectedDuration=null;
    if(selectedMediaUrl) URL.revokeObjectURL(selectedMediaUrl);
    selectedMediaUrl=null;
    $('mediaLocalPreview').replaceChildren();$('mediaLocalPreview').hidden=true;
    $('mediaFile').value='';
  }catch(e){$('mediaSendStatus').textContent=e.message;notify(e.message);}
  finally {sendingMedia=false;$('sendMedia').disabled=!selectedMedia;}
}
async function showIncomingMedia() {
  if (!incomingMedia) return;
  $('openMedia').disabled = true;
  try {
    const key = await aesKey();
    const iv = fromBase64(incomingMedia.iv);
    const decrypted = await crypto.subtle.decrypt({name:'AES-GCM',iv},key,fromBase64(incomingMedia.data));
    const file = new Blob([decrypted],{type:incomingMedia.mime});
    if (visibleMediaUrl) URL.revokeObjectURL(visibleMediaUrl);
    visibleMediaUrl = mediaPreview($('mediaRemotePreview'),file,incomingMedia.mime);
    $('openMedia').hidden=true;
    $('closeMedia').hidden=false;
    $('mediaReceiverText').textContent = 'Archivo descifrado solo en tu dispositivo. Esta vista se cerrará automáticamente.';
  } catch {
    notify('No se pudo abrir el archivo. Comprueba que entraste usando el enlace privado completo.');
  } finally {$('openMedia').disabled=false;}
}

function notify(message) {
  const el = $('toast'); el.textContent = message; el.hidden = false;
  clearTimeout(toastHandle); toastHandle = setTimeout(() => { el.hidden = true; }, 3800);
}
function setEntryMode(isJoin) {
  joining = isJoin;
  $('tabJoin').classList.toggle('active', isJoin);
  $('tabCreate').classList.toggle('active', !isJoin);
  $('tabJoin').setAttribute('aria-selected', String(isJoin));
  $('tabCreate').setAttribute('aria-selected', String(!isJoin));
  $('joinCodeBlock').hidden = !isJoin;
  $('createOptions').hidden = isJoin;
  $('submitEntry').innerHTML = isJoin ? 'Entrar en la sala <span>↗</span>' : 'Crear nuestra sala <span>↗</span>';
  $('joinCode').required = isJoin;
}
async function request(endpoint, body, method='POST') {
  const opt = {method, headers:{'Content-Type':'application/json'}};
  if (body) opt.body = JSON.stringify(body);
  const response = await fetch(endpoint, opt);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudo conectar con el servidor.');
  return data;
}
function persist() { if (session) sessionStorage.setItem(storageKey,JSON.stringify(session)); }
const roomPages = ['roomLobby', 'roomChallenges', 'chatPanel'];
let activeRoomPage = 'roomLobby';
let gameWasStarted = false;
let newestChatId = null;
const chatBubbles = new Map();
let microphonePending = false;
let sendingVoice = false;

function showRoomPage(page) {
  activeRoomPage = page;
  for (const id of roomPages) $(id).hidden = id !== page;
  for (const button of document.querySelectorAll('.room-nav button')) {
    if (button.dataset.roomPage === page) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  if (page !== 'chatPanel') {
    for (const {audio} of chatBubbles.values()) audio?.pause();
  }
  if (page === 'chatPanel') {
    $('chatUnread').hidden = true;
    $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
  }
}

$('roomScreen').addEventListener('click', event => {
  const button = event.target.closest('button[data-room-page]');
  if (button) showRoomPage(button.dataset.roomPage);
});

function showRoom() {
  $('landing').hidden = true;
  $('roomScreen').hidden = false;
  document.body.classList.add('in-room');
  showRoomPage(current.game.started ? 'roomChallenges' : 'roomLobby');
  window.scrollTo({top:0, behavior:'instant'});
}

function clearSession() {
  if (source) { source.close(); source = null; }
  clearMedia(); closeViewer(); cancelRecording(); voiceRecorded=null; lastChatSignature=''; mediaStageKey='';
  session = null; current = null; sessionStorage.removeItem(storageKey);
  $('landing').hidden = false; $('roomScreen').hidden = true;
  document.body.classList.remove('in-room');
  gameWasStarted = false; newestChatId = null;
  clearChatBubbles();
  $('chatUnread').hidden = true;
  $('chatText').value = '';
  discardVoice();
  window.history.replaceState({},'',window.location.pathname);
}
function openRoom(data) {
  session = { room:data.room, token:data.token, playerId:data.playerId, secret:pendingSecret };
  pendingSecret = null;
  persist();
  current = data.state;
  showRoom();
  window.history.replaceState({},'',`?s=${encodeURIComponent(data.room)}`);
  render(); listen();
}
function listen() {
  if (!session) return;
  if (source) source.close();
  source = new EventSource(`/api/events?room=${encodeURIComponent(session.room)}&token=${encodeURIComponent(session.token)}`);
  source.addEventListener('state', event => {
    try { current = JSON.parse(event.data); render(); } catch(e) { console.warn('Estado incorrecto',e); }
  });
  source.addEventListener('closed', () => { clearSession(); notify('La sala se ha cerrado. Puedes crear otra.'); });
  source.addEventListener('media', event => {
    try {
      const item = JSON.parse(event.data);
      if (!current?.game?.started || current.game.round !== item.round || current.game.turn === current.me || !current.settings.cameraActive) return;
      incomingMedia = item;
      $('mediaIncoming').hidden = false;
      $('openMedia').hidden = false;
      $('mediaReceiverText').textContent = `${item.from} te ha enviado un archivo privado. Ábrelo solo si quieres.`;
      clearTimeout(mediaCleanupTimer);
      mediaCleanupTimer = setTimeout(() => {clearMedia();$('mediaReceiverText').textContent='El archivo recibido ha caducado y ya no está disponible.';},90000);
      notify('♡ Tu pareja te ha enviado un archivo privado.');
    } catch { notify('No se pudo procesar el archivo recibido.'); }
  });
  source.addEventListener('open', () => { $('connectionLabel')?.setAttribute('title','Conectado'); });
  source.onerror = () => { if (session) $('roomCode').title = 'Reconectando con el servidor…'; };
}
async function send(type, value) {
  if (!session || busy) return false;
  busy = true;
  try {
    const data = await request('/api/action',{room:session.room,token:session.token,type,value});
    current = data.state; render(); return true;
  } catch (e) { notify(e.message); return false; }
  finally { busy = false; }
}
function renderPlayers() {
  const me = current.me;
  const all = current.players;
  const placeholders = [...all];
  while (placeholders.length < 2) placeholders.push(null);
  $('players').innerHTML = placeholders.map((p,i) => {
    if (!p) return '<div class="player"><div class="player-avatar">+</div><div><div class="player-name">Esperando…</div><div class="player-sub">Comparte el código</div></div></div>';
    const sub = p.id === me ? 'TÚ' : (i===0 ? 'ANFITRIÓN / A' : 'INVITADO / A');
    const label = current.game.started ? `${p.points} puntos` : (p.ready ? '✓ Listo/a' : (p.online ? 'Sin preparar' : 'Sin conexión'));
    return `<div class="player"><div class="player-avatar">${safe(p.name.slice(0,1).toUpperCase())}</div><div class="player-identity"><div class="player-name">${safe(p.name)}</div><div class="player-sub">${safe(sub)}</div></div><div class="player-state ${p.online?'':'offline'}">${safe(label)}</div></div>`;
  }).join('');
}
function renderWaiting() {
  const isHost = current.host === current.me;
  const n = current.players.length;
  const mine = current.players.find(p => p.id === current.me);
  const full = n === 2;
  const everyoneReady = full && current.players.every(p => p.ready);
  $('waitingPanel').hidden = false; $('gamePanel').hidden = true;
  $('waitingMessage').textContent = !full ? 'Falta una persona. Comparte el código o el enlace de arriba para invitarla.' : everyoneReady ? '¡Los dos estáis listos! Ya podéis empezar.' : 'Estáis los dos. Marcad «Estoy listo/a» para empezar la partida.';
  for (const button of $('roomLevels').querySelectorAll('[data-level]')) {
    button.classList.toggle('active',button.dataset.level === current.settings.level);
    button.disabled = !isHost;
  }
  $('roomCameraSetting').checked = current.settings.cameraEnabled;
  $('roomCameraSetting').disabled = !isHost;
  $('myMediaConsent').checked = mine?.mediaConsent || false;
  $('myTodoConsent').checked = mine?.todoConsent || false;
  $('roomCameraSetting').disabled = !isHost || current.settings.level === 'todo';
  $('roomOnlyCustomLabel').hidden = current.settings.level !== 'todo';
  $('roomOnlyCustom').checked = Boolean(current.settings.onlyCustomTodo);
  $('roomOnlyCustom').disabled = !isHost;
  $('customMediaStatus').textContent = `${current.settings.customPhotoCount || 0} de foto · ${current.settings.customVideoCount || 0} de vídeo`;
  $('todoStatus').textContent = current.settings.level === 'todo' ? (current.settings.todoValeActive ? '✓ TODO VALE activado por los dos.' : `TODO VALE: ${current.players.filter(p=>p.todoConsent).length}/2 aceptan el nivel +18. Ambos debéis aceptar también la cámara.`) : 'TODO VALE solo se activa cuando ambos lo aceptáis.';
  const kindOptions = $('customKind').options;
  for (const opt of kindOptions) opt.disabled = current.settings.level === 'todo' && ['truth','dare'].includes(opt.value);
  if (current.settings.level === 'todo' && ['truth','dare'].includes($('customKind').value)) $('customKind').value = 'foto';
  const agreed = current.players.filter(p => p.mediaConsent).length;
  $('cameraStatus').textContent = current.settings.cameraEnabled ? (current.settings.cameraActive ? '♥ Activado: ambos lo habéis aceptado.' : `Consentimiento de cámara: ${agreed}/2 · Hasta que ambos aceptéis, no saldrán estos retos.`) : 'La cámara está desactivada en esta sala.';
  $('readyBtn').textContent = mine?.ready ? 'Preparado/a ✓ (desmarcar)' : 'Estoy listo/a ✓';
  $('readyBtn').disabled = !full;
  $('startBtn').hidden = !isHost;
  $('startBtn').disabled = !everyoneReady || (current.settings.level === 'todo' && (!current.settings.todoValeActive || (current.settings.onlyCustomTodo && (!current.settings.customPhotoCount || !current.settings.customVideoCount))));
}
function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
}
function renderTimer() {
  if (!current?.game?.started || current.game.stage !== 'prompt') return;
  const end = current.game.timerEnd;
  const seconds = current.game.card?.media === 'video' ? 300 : 60;
  $('timerValue').textContent = formatTime(end ? (end - Date.now()) / 1000 : seconds);
  $('timerStart').textContent = seconds === 300 ? 'Iniciar 5 min' : 'Iniciar 60 s';
  $('timerStart').hidden = !!end || current.game.turn !== current.me;
}
function renderGame() {
  $('waitingPanel').hidden = true; $('gamePanel').hidden = false;
  const game = current.game;
  const turn = current.players.find(p => p.id === game.turn);
  const mine = game.turn === current.me;
  $('roundLabel').textContent = `RONDA ${String(game.round).padStart(2,'0')}`;
  $('modeLabel').textContent = modeNames[current.settings.level];
  $('cameraBadge').textContent = current.settings.cameraActive ? '◉ CÁMARA ON' : 'CÁMARA OFF';
  const todo = current.settings.level === 'todo';
  $('gamePanel').classList.toggle('todo-mode', todo);
  document.querySelector('.game-stage').classList.toggle('todo-mode', todo);
  $('pickTruth').hidden = todo;
  $('pickDare').hidden = todo;
  $('pickRandom').textContent = todo ? 'Sacar reto al azar' : 'Sacar una carta al azar';
  $('pickRandom').classList.toggle('primary-btn', todo);
  $('turnOverline').textContent = mine ? 'TU TURNO' : `TURNO DE ${turn?.name.toUpperCase() || 'TU PAREJA'}`;
  $('turnTitle').textContent = game.stage === 'choose' ? (todo ? 'Todo Vale' : '¿Verdad o reto?') : (game.card.kind === 'truth' ? 'Carta de verdad' : 'Carta de reto');
  $('turnDescription').textContent = game.stage === 'choose' ? (mine ? (todo && !current.settings.todoValeActive ? 'Modo pausado. Ambos debéis aceptar TODO VALE y la cámara.' : todo ? 'La baraja decide: 80 % vídeo, 20 % foto.' : 'Elige cómo quieres jugar esta ronda.') : `Esperando a que ${turn?.name || 'tu pareja'} elija una carta…`) : (mine ? 'Tu decisión. Puedes hacerlo o pasar, sin dar explicaciones.' : `${turn?.name || 'Tu pareja'} tiene la palabra. Dale su tiempo.`);
  $('chooseButtons').hidden = game.stage !== 'choose';
  $('activeCard').hidden = game.stage !== 'prompt';
  for (const id of ['pickTruth','pickDare','pickRandom']) $(id).disabled = !mine || (todo && !current.settings.todoValeActive);
  if (game.stage === 'prompt' && game.card) {
    $('activeCard').dataset.kind = game.card.kind;
    $('cardTag').textContent = game.card.media ? (game.card.media === 'foto' ? 'RETO DE FOTO' : 'RETO DE VÍDEO') : game.card.kind === 'truth' ? 'VERDAD' : 'RETO';
    $('cardIndex').textContent = `RONDA Nº ${game.round}`;
    $('cardText').textContent = game.card.text;
    $('cameraNotice').hidden = !game.card.media;
    $('skipCard').disabled = !mine;
    $('doneCard').disabled = !mine;
    $('doneCard').textContent = game.card.kind === 'truth' ? 'He respondido ✓' : 'Reto cumplido ✓';
    renderTimer();
  }
  renderMedia();
  $('gameMediaConsent').checked = current.players.find(p => p.id === current.me)?.mediaConsent || false;
  $('gameTodoConsent').checked = current.players.find(p => p.id === current.me)?.todoConsent || false;
  $('gameTodoConsent').parentElement.hidden = !todo;
  $('restartBtn').hidden = current.me !== current.host;
  const hist = game.history;
  $('roundHistory').innerHTML = hist.length ? hist.map(h => `<div class="history-row"><span>${safe(h.player)} · ${h.media ? safe(h.media) : (h.kind === 'truth'?'Verdad':'Reto')}</span><small>${h.outcome==='done'?'✓ Hecho':'↷ Pasó'}</small></div>`).join('') : '<span class="empty-history">Aún no hay rondas anteriores.</span>';
}
function render() {
  if (!current || !session) return;
  $('roomCode').textContent = current.code;
  renderPlayers();
  $('customCount').textContent = `${current.settings.customCount || 0} añadidas`;
  const started = current.game.started;
  $('challengesWaiting').hidden = started;
  $('roomGameDetails').hidden = !started;
  if (started) renderGame(); else renderWaiting();
  if (started !== gameWasStarted && activeRoomPage !== 'chatPanel') {
    showRoomPage(started ? 'roomChallenges' : 'roomLobby');
  }
  gameWasStarted = started;
  renderChat();
}
async function copyText(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {
      const input = document.createElement('textarea');input.value = value;input.style.position='fixed';input.style.opacity='0';document.body.appendChild(input);input.select();
      if (!document.execCommand('copy')) throw new Error('No disponible');
      input.remove();
    }
    notify('Copiado. Ya puedes compartirlo.');
  } catch { window.prompt('Copia este texto para compartirlo:',value); }
}
function inviteUrl() { return `${window.location.origin}/?s=${encodeURIComponent(session.room)}${session.secret ? `#k=${session.secret}` : ''}`; }
function renderChat() {
  const panel=$('chatPanel');
  if(!panel||!current||!session) return;
  const messages=current.messages||[];
  const lastSeenIndex = messages.findIndex(message => message.id === newestChatId);
  if (activeRoomPage !== 'chatPanel' &&
      messages.slice(lastSeenIndex + 1).some(message => message.fromId !== current.me)) {
    $('chatUnread').hidden = false;
  }
  newestChatId = messages.at(-1)?.id ?? null;
  const signature=messages.map(m=>`${m.id}:${m.file?.expires||''}`).join('|');
  $('chatKeyNotice').hidden=Boolean(session.secret);
  $('chatSend').disabled=!session.secret||current.players.length!==2;
  $('recordVoice').disabled=microphonePending||!session.secret||current.players.length!==2;
  $('voiceFileLabel').hidden=!session.secret||current.players.length!==2;
  if(signature===lastChatSignature)return;
  lastChatSignature=signature;
  const list=$('chatMessages');
  const atBottom=list.scrollHeight-list.scrollTop-list.clientHeight<100;
  const visibleIds = new Set(messages.map(message => message.id));
  for (const [id, bubble] of chatBubbles) {
    if (!visibleIds.has(id)) removeChatBubble(id, bubble);
  }
  if (!messages.length && !list.querySelector('.chat-empty')) {
    const empty = document.createElement('p');
    empty.className = 'chat-empty';
    empty.textContent = 'Aún no hay mensajes. Escribid algo o mandad un audio ♡';
    list.append(empty);
  } else if (messages.length) {
    list.querySelector('.chat-empty')?.remove();
  }
  for (const m of messages) {
    if (chatBubbles.has(m.id)) continue;
    const mine=m.fromId===current.me;
    const item=document.createElement('div');item.className='chat-bubble '+(mine?'mine':'theirs');
    const bubble = {item};
    chatBubbles.set(m.id, bubble);
    const header=document.createElement('small');header.textContent=`${mine?'Tú':m.fromName} · ${new Date(m.at).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}`;
    item.append(header);
    if(m.kind==='text'){
      const text=document.createElement('p');text.textContent='Descifrando…';item.append(text);
      decryptChatText(m,text);
    } else if (m.kind === 'voice' && m.file) {
      item.classList.add('voice-bubble');
      addVoicePlayer(bubble, m.file);
    }else if(m.file){
      const title=document.createElement('p');
      title.textContent=m.file.kind==='video'?'🎥 Vídeo privado':'📷 Foto privada';
      item.append(title);
      if(mine){const msg=document.createElement('span');msg.className='chat-hint';msg.textContent='Enviado de forma cifrada';item.append(msg);}
      else if(Date.now()>=m.file.expires){const msg=document.createElement('span');msg.className='chat-hint';msg.textContent='Archivo caducado';item.append(msg);}
      else {const btn=document.createElement('button');btn.type='button';btn.className='chat-download';btn.textContent='Abrir archivo privado ↗';btn.addEventListener('click',()=>openAttachment(m.file));item.append(btn);}
    }
    list.append(item);
  }
  if(atBottom && activeRoomPage === 'chatPanel')list.scrollTop=list.scrollHeight;
}
function removeChatBubble(id, bubble) {
  bubble.item.remove();
  clearTimeout(bubble.expiry);
  bubble.audio?.pause();
  if (bubble.url) URL.revokeObjectURL(bubble.url);
  chatBubbles.delete(id);
}

function clearChatBubbles() {
  for (const [id, bubble] of chatBubbles) removeChatBubble(id, bubble);
  $('chatMessages').replaceChildren();
}

function addVoicePlayer(bubble, file) {
  const player = document.createElement('div');
  player.className = 'chat-voice';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-download';
  button.textContent = '▶ Reproducir audio';
  const duration = document.createElement('span');
  duration.textContent = formatTime(file.duration);
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.hidden = true;
  audio.setAttribute('aria-label', 'Mensaje de voz');
  audio.addEventListener('play', () => {
    for (const other of chatBubbles.values()) {
      if (other.audio !== audio) other.audio?.pause();
    }
  });
  bubble.audio = audio;
  player.append(button, duration, audio);
  bubble.item.append(player);

  function expire() {
    bubble.expired = true;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (bubble.url) URL.revokeObjectURL(bubble.url);
    bubble.url = null;
    player.textContent = 'Audio caducado';
  }

  if (Date.now() >= file.expires) {
    expire();
    return;
  }
  bubble.expiry = setTimeout(expire, file.expires - Date.now());
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Cargando audio…';
    try {
      const blob = await downloadEncrypted(file);
      if (!bubble.item.isConnected || bubble.expired) return;
      bubble.url = URL.createObjectURL(blob);
      audio.src = bubble.url;
      button.hidden = true;
      audio.hidden = false;
      if (activeRoomPage === 'chatPanel') await audio.play().catch(() => {});
    } catch (error) {
      if (bubble.item.isConnected && !bubble.expired) {
        button.disabled = false;
        button.textContent = '↻ Reintentar audio';
        notify(error.message);
      }
    }
  });
}

async function decryptChatText(m,target) {
  try {
    const key=await aesKey();
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64(m.iv)},key,fromBase64(m.data));
    const txt=decoder.decode(plain);
    if(target.isConnected) target.textContent=txt;
  }catch {if(target.isConnected)target.textContent='🔒 No se pudo descifrar. Usad el mismo enlace privado.';}
}
async function openAttachment(meta) {
  if(viewing)return;
  viewing=true;
  $('viewerModal').hidden=false;
  $('viewerStatus').textContent='Recibiendo archivo… 0 %';
  $('viewerContent').replaceChildren();
  try {
    const blob=await downloadEncrypted(meta,p=>{$('viewerStatus').textContent=`Descargando y descifrando… ${p} %`;});
    if(viewerUrl)URL.revokeObjectURL(viewerUrl);
    viewerUrl=mediaPreview($('viewerContent'),blob,meta.mime);
    $('viewerStatus').textContent='Archivo abierto solo en tu móvil. Ciérralo cuando termines.';
  }catch(e){$('viewerStatus').textContent=e.message;notify(e.message);}
  finally{viewing=false;}
}
function closeViewer() {
  if(!$('viewerModal'))return;
  $('viewerContent').replaceChildren();$('viewerModal').hidden=true;
  if(viewerUrl)URL.revokeObjectURL(viewerUrl);
  viewerUrl=null;
}
async function sendChatText(event) {
  event.preventDefault();
  const message=$('chatText').value.trim();
  if(!message||!session||!session.secret)return;
  if(message.length>1000)return notify('Máximo 1000 caracteres por mensaje.');
  $('chatSend').disabled=true;
  try {
    const key=await aesKey();const iv=crypto.getRandomValues(new Uint8Array(12));
    const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,encoder.encode(message)));
    await request('/api/chat/text',{room:session.room,token:session.token,iv:base64url(iv),data:toBase64(encrypted)});
    $('chatText').value='';
  }catch(e){notify(e.message);}
  finally{$('chatSend').disabled=false;}
}
function setRecordingIndicator(recording) {
  const button = $('recordVoice');
  const label = recording ? 'Detener audio' : 'Grabar audio';
  button.classList.toggle('recording', recording);
  button.setAttribute('aria-label', label);
  button.title = label;
}
function cancelRecording() {
  clearTimeout(voiceTimer);
  if(voiceRecording){try{voiceRecording.recorder.onstop=null;voiceRecording.recorder.stop();}catch{}
    voiceRecording.stream.getTracks().forEach(t=>t.stop());voiceRecording=null;}
  setRecordingIndicator(false);
  $('voiceStatus').hidden = true;
}
async function toggleVoiceRecording() {
  if (voiceRecording) {
    if (voiceRecording.recorder.state === 'recording') voiceRecording.recorder.stop();
    return;
  }
  if (microphonePending) return;
  if(!session?.secret)return notify('Para enviar audios necesitas el enlace privado completo.');
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)return notify('Tu navegador no permite grabar. Usa «Elegir audio».');
  const recordingSession = session;
  let stream;
  microphonePending = true;
  $('recordVoice').disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio:true});
    if (session !== recordingSession || current?.players.length !== 2) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    const supported=['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));
    const recorder=new MediaRecorder(stream,supported?{mimeType:supported}:{});
    const chunks=[];
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    recorder.onerror=()=>notify('Ha ocurrido un problema al grabar.');
    recorder.onstop=()=>{
      clearTimeout(voiceTimer);stream.getTracks().forEach(t=>t.stop());
      const started=voiceRecording?.started||Date.now();
      voiceRecording=null;setRecordingIndicator(false);
      $('voiceStatus').hidden = true;
      const mime=(recorder.mimeType||supported||'audio/webm').split(';')[0];
      const blob=new Blob(chunks,{type:mime});
      if(blob.size===0||blob.size>maxVoiceBytes){return notify('El audio está vacío o es demasiado grande (15 MB).');}
      showVoiceReady(blob,Math.min(120,(Date.now()-started)/1000));
    };
    recorder.start(1000);
    voiceRecording={recorder,stream,started:Date.now()};
    setRecordingIndicator(true);
    $('voiceStatus').hidden = false;
    $('voiceStatus').textContent='Grabando… pulsa Detener cuando termines (máx. 2 min).';
    voiceTimer=setTimeout(()=>{if(voiceRecording?.recorder.state==='recording')voiceRecording.recorder.stop();},120000);
  } catch {
    stream?.getTracks().forEach(track => track.stop());
    notify('No se pudo usar el micrófono. Revisa los permisos del navegador.');
  } finally {
    microphonePending = false;
    $('recordVoice').disabled = !session?.secret || current?.players.length !== 2;
  }
}
function showVoiceReady(blob,duration) {
  voiceRecorded={file:blob,duration};
  const audio=$('voicePreview');
  if(audio.src.startsWith('blob:'))URL.revokeObjectURL(audio.src);
  audio.src=URL.createObjectURL(blob);
  $('voicePreviewBox').hidden=false;
  $('voiceStatus').hidden = false;
  $('voiceStatus').textContent=`Audio preparado: ${formatTime(duration)} · ${(blob.size/MiB).toFixed(1)} MB`;
}
async function chooseVoiceFile(e) {
  const file=e.target.files?.[0];if(!file)return;
  const mime=actualMime(file).split(';')[0];
  if(!['audio/webm','audio/mp4','audio/ogg','audio/mpeg','audio/wav','audio/aac','audio/x-m4a','audio/3gpp'].includes(mime)||file.size>maxVoiceBytes||!file.size) return notify('Usa un audio compatible de hasta 15 MB.');
  try{const duration=await fileDuration(file,'audio');if(duration>120.5)throw Error('El audio debe durar 2 minutos o menos.');showVoiceReady(file,duration);}
  catch(err){notify(err.message);}
}
async function sendVoice() {
  if (!voiceRecorded || !session || sendingVoice) return;
  const draft = voiceRecorded;
  const {file, duration} = draft;
  sendingVoice = true;
  $('sendVoice').disabled=true;
  try {
    await uploadEncrypted(file,'audio','chat',duration,p=>{$('voiceStatus').textContent=`Enviando audio cifrado… ${p} %`;});
    if (voiceRecorded === draft) discardVoice();
    $('voiceStatus').hidden = false;
    $('voiceStatus').textContent='Mensaje de voz enviado ✓';
  }catch(e){$('voiceStatus').textContent=e.message;notify(e.message);}
  finally{sendingVoice=false;$('sendVoice').disabled=false;}
}
function discardVoice(){$('voiceStatus').hidden=true;voiceRecorded=null;$('voicePreviewBox').hidden=true;const audio=$('voicePreview');
  if(audio.src.startsWith('blob:'))URL.revokeObjectURL(audio.src);audio.removeAttribute('src');$('voiceFile').value='';}
$('chatForm').addEventListener('submit',sendChatText);
$('recordVoice').addEventListener('click',toggleVoiceRecording);
$('voiceFileLabel').addEventListener('click',()=> $('voiceFile').click());
$('voiceFile').addEventListener('change',chooseVoiceFile);
$('sendVoice').addEventListener('click',sendVoice);
$('discardVoice').addEventListener('click',discardVoice);
$('closeViewer').addEventListener('click',closeViewer);
$('tabCreate').addEventListener('click', () => setEntryMode(false));
$('tabJoin').addEventListener('click', () => setEntryMode(true));
$('entryForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (busy) return;
  if (!$('confirmAdult').checked) return notify('Debes confirmar que tienes 18 años o más.');
  const name = $('nickname').value.trim();
  if (!name) return notify('Introduce un nombre.');
  pendingSecret = joining ? ($('joinMediaKey').value.trim() || mediaSecretFromInvite()) : makeSecret();
  if (joining && !/^[A-Za-z0-9_-]{43}$/.test(pendingSecret || '')) pendingSecret = null;
  const params = {name,adult:true,mediaConsent:$('mediaConsentEntry').checked && Boolean(pendingSecret),todoConsent:$('todoConsentEntry').checked};
  if (joining && $('mediaConsentEntry').checked && !pendingSecret) notify('Has entrado sin clave privada: podrás jugar, pero no activar los retos con fotos o vídeos.');
  const endpoint = joining ? '/api/join' : '/api/create';
  if (joining) params.code = $('joinCode').value.trim().toUpperCase();
  else {params.level = document.querySelector('[name="level"]:checked').value;params.cameraEnabled = $('enableCamera').checked || params.level === 'todo';}
  busy = true;$('submitEntry').disabled = true;
  try { const data = await request(endpoint,params);openRoom(data); }
  catch(err) {notify(err.message);}
  finally {busy = false;$('submitEntry').disabled = false;}
});
$('addCustomCard').addEventListener('click', async () => {
  const selected = $('customKind').value;
  const text = $('customText').value.trim();
  if (text.length < 8) return notify('Escribe una pregunta o reto de al menos 8 caracteres.');
  const value = {kind:selected === 'truth' ? 'truth' : 'dare', media: ['foto','video'].includes(selected) ? selected : null, text};
  if (await send('addCard', value)) { $('customText').value = ''; notify('Carta añadida a vuestra baraja privada.'); }
});
$('copyCode').addEventListener('click', () => { if (session) copyText(session.room); });
$('copyLink').addEventListener('click', async () => {
  if (!session) return;
  const url = inviteUrl();
  if (navigator.share) {try { await navigator.share({title:'A DOS · Sin filtros',text:'Entra en nuestra sala privada para jugar ❤️',url});return; } catch {} }
  copyText(url);
});
$('readyBtn').addEventListener('click', () => send('ready',!current.players.find(p => p.id === current.me)?.ready));
$('startBtn').addEventListener('click', () => send('start'));
$('roomLevels').addEventListener('click',e => { const b=e.target.closest('[data-level]');if(b&&!b.disabled)send('settings',{level:b.dataset.level}); });
$('roomCameraSetting').addEventListener('change',e=>send('settings',{cameraEnabled:e.target.checked}));
$('roomOnlyCustom').addEventListener('change',e=>send('settings',{onlyCustomTodo:e.target.checked}));
$('myTodoConsent').addEventListener('change',e=>send('todoConsent',e.target.checked));
$('gameTodoConsent').addEventListener('change',e=>send('todoConsent',e.target.checked));
$('initialLevels').addEventListener('change',()=>{
  const todo = document.querySelector('[name="level"]:checked').value === 'todo';
  if (todo) $('entryPermissions').open = true;
  if (todo) $('enableCamera').checked = true;
  $('enableCamera').disabled = todo;
});
$('myMediaConsent').addEventListener('change',e=>{if(e.target.checked&&!session.secret){e.target.checked=false;return notify('Para fotos y vídeos necesitas el enlace privado completo.');}send('mediaConsent',e.target.checked);});
$('gameMediaConsent').addEventListener('change',e=>{if(e.target.checked&&!session.secret){e.target.checked=false;return notify('Para fotos y vídeos necesitas el enlace privado completo.');}send('mediaConsent',e.target.checked);});
$('pickTruth').addEventListener('click',()=>send('pick','truth'));
$('pickDare').addEventListener('click',()=>send('pick','dare'));
$('pickRandom').addEventListener('click',()=>send('pick','random'));
$('timerStart').addEventListener('click',()=>send('timer'));
$('doneCard').addEventListener('click',()=>send('finish'));
$('skipCard').addEventListener('click',()=>send('skip'));
$('restartBtn').addEventListener('click',()=> {if(window.confirm('¿Reiniciar la partida y los puntos para ambos?')) send('restart');});
$('mediaFile').addEventListener('change',async e => {
  const file=e.target.files?.[0];
  if (!file) return;
  const mime=actualMime(file);
  const kind=current?.game?.card?.media;
  const goodTypes=kind==='foto'?['image/jpeg','image/png','image/webp','image/heic','image/heif']:['video/mp4','video/webm','video/quicktime'];
  const max=kind==='foto'?maxPhotoBytes:maxVideoBytes;
  if(!goodTypes.includes(mime) || file.size>max || file.size===0) {
    e.target.value='';selectedMedia=null;$('sendMedia').disabled=true;
    return notify(`Usa un archivo compatible de hasta ${max/MiB} MB.`);
  }
  selectedMedia=null;selectedDuration=null;$('sendMedia').disabled=true;
  $('mediaSendStatus').textContent=kind==='video'?'Comprobando duración (máximo 5 minutos)…':'Preparando imagen…';
  try {
    const duration=kind==='video'?await fileDuration(file,'video'):null;
    if(kind==='video'&&duration>300) throw Error('Este vídeo dura más de 5 minutos. Recórtalo antes de enviarlo.');
    if(current?.game?.card?.media!==kind) throw Error('La ronda ha cambiado. Vuelve a elegir tu archivo.');
    selectedDuration=duration;selectedMedia=file;
    if(selectedMediaUrl) URL.revokeObjectURL(selectedMediaUrl);
    selectedMediaUrl=mediaPreview($('mediaLocalPreview'),file,mime);
    $('sendMedia').textContent='Enviar cifrado a mi pareja ♡';
    $('mediaSendStatus').textContent=`Preparado: ${(file.size/MiB).toFixed(1)} MB${duration?` · ${formatTime(duration)}`:''}. Confirma cuando quieras.`;
    $('sendMedia').disabled=false;
  }catch(err){e.target.value='';$('mediaSendStatus').textContent=err.message;notify(err.message);}
});
$('sendMedia').addEventListener('click',sendSelectedMedia);
$('openMedia').addEventListener('click',showIncomingMedia);
$('closeMedia').addEventListener('click',()=> {clearMedia();$('mediaReceiverText').textContent='Has cerrado el archivo privado.';});
$('leaveRoom').addEventListener('click',async()=> {
  if (!session || !window.confirm('¿Quieres salir de la sala?')) return;
  const old = session;clearSession();
  try {await request('/api/leave',{room:old.room,token:old.token});}catch{}
  notify('Has salido de la sala.');
});
$('brand').addEventListener('click',e=> { if (session) {e.preventDefault();notify('Para abandonar la partida usa «Salir».');} });
setInterval(renderTimer,500);
(async function restore() {
  const code = new URLSearchParams(window.location.search).get('s');
  if (code) {setEntryMode(true);$('joinCode').value = code.replace(/[^a-z0-9]/gi,'').toUpperCase().slice(0,6);$('joinMediaKey').value=mediaSecretFromInvite() || '';}
  try {
    const stored = sessionStorage.getItem(storageKey);
    if (!stored) return;
    session = JSON.parse(stored);
    const url = `/api/state?room=${encodeURIComponent(session.room)}&token=${encodeURIComponent(session.token)}`;
    const data = await request(url,null,'GET');
    current = data.state;
    showRoom(); render(); listen();
  } catch { clearSession();if (code) {setEntryMode(true);$('joinCode').value = code.toUpperCase().slice(0,6);} }
})();
