'use strict';
const $ = (id) => document.getElementById(id);
let joining = false;
let session = null;
let current = null;
let source = null;
let busy = false;
let toastHandle = null;
const modeNames = { chispa:'CHISPA', fuego:'FUEGO', intenso:'INTENSO' };
const storageKey = 'ados.sala.v1';
const safe = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// La clave se genera en el móvil y viaja en el fragmento #k= del enlace:
// los fragmentos no se envían al servidor. El servidor retransmite únicamente
// texto cifrado mediante AES-GCM y no guarda archivos ni claves.
let pendingSecret = null;
let selectedMedia = null;
let selectedMediaUrl = null;
let visibleMediaUrl = null;
let incomingMedia = null;
let mediaCleanupTimer = null;
let mediaStageKey = '';
let sendingMedia = false;
const maxMediaBytes = 12 * 1024 * 1024;
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
  selectedMedia = null; incomingMedia = null;
  if ($('mediaFile')) $('mediaFile').value = '';
  for (const id of ['mediaLocalPreview','mediaRemotePreview']) {if ($(id)) {$(id).replaceChildren();$(id).hidden = true;}}
  if ($('mediaIncoming')) $('mediaIncoming').hidden = true;
  if ($('closeMedia')) $('closeMedia').hidden = true;
  if ($('sendMedia')) {$('sendMedia').disabled = true; $('sendMedia').textContent = 'Enviar cifrado a mi pareja ♡';}
  if ($('mediaSendStatus')) $('mediaSendStatus').textContent='';
}
function mediaPreview(container, blob, mime) {
  const node = document.createElement(mime.startsWith('video/') ? 'video':'img');
  if (node.tagName === 'VIDEO') {node.controls = true;node.playsInline=true;node.preload='metadata';}
  else node.alt = 'Previsualización del archivo privado';
  const url = URL.createObjectURL(blob);
  node.src = url;
  container.replaceChildren(node);
  container.hidden = false;
  return url;
}
function actualMime(file) {
  if (file.type && file.type !== 'application/octet-stream') return file.type.toLowerCase();
  const extension = file.name.split('.').pop().toLowerCase();
  return ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime'})[extension] || '';
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
async function sendSelectedMedia() {
  if (!session || !selectedMedia || sendingMedia) return;
  if (!current?.settings?.cameraActive || current.game.turn !== current.me || !current.game.card?.media) return;
  if (!window.confirm('¿Enviar este archivo SOLO a tu pareja? Aunque lo transmitamos cifrado, quien lo reciba podría hacer una captura o guardarlo.')) return;
  sendingMedia = true;
  $('sendMedia').disabled = true;
  $('mediaSendStatus').textContent = 'Cifrando y enviando…';
  try {
    const key = await aesKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,await selectedMedia.arrayBuffer()));
    await request('/api/media',{room:session.room,token:session.token,item:{kind:current.game.card.media,mime:actualMime(selectedMedia),iv:toBase64(iv).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''),data:toBase64(encrypted)}});
    $('sendMedia').textContent = 'Enviado a tu pareja ✓';
    $('mediaSendStatus').textContent = 'Archivo entregado cifrado. Puedes seguir con la ronda.';
    selectedMedia = null;
    if (selectedMediaUrl) URL.revokeObjectURL(selectedMediaUrl);
    selectedMediaUrl=null;
    $('mediaLocalPreview').replaceChildren();$('mediaLocalPreview').hidden=true;
    $('mediaFile').value='';
  } catch(error) {
    $('mediaSendStatus').textContent = error.message;
    notify(error.message);
  } finally {
    sendingMedia=false;
    $('sendMedia').disabled=!selectedMedia;
  }
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
function clearSession() {
  if (source) { source.close(); source = null; }
  clearMedia(); mediaStageKey='';
  session = null; current = null; sessionStorage.removeItem(storageKey);
  $('landing').hidden = false; $('roomScreen').hidden = true;
  window.history.replaceState({},'',window.location.pathname);
}
function openRoom(data) {
  session = { room:data.room, token:data.token, playerId:data.playerId, secret:pendingSecret };
  pendingSecret = null;
  persist();
  current = data.state;
  $('landing').hidden = true; $('roomScreen').hidden = false;
  window.history.replaceState({},'',`?s=${encodeURIComponent(data.room)}`);
  render(); listen(); window.scrollTo({top:0,behavior:'smooth'});
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
    if (!p) return '<div class="player"><div class="player-avatar">＋</div><div><div class="player-name">Esperando…</div><div class="player-sub">Comparte el código</div></div></div>';
    const sub = p.id === me ? 'TÚ' : (i===0 ? 'ANFITRIÓN / A' : 'INVITADO / A');
    const label = current.game.started ? `${p.points} puntos` : (p.ready ? '✓ Listo/a' : (p.online ? 'Sin preparar' : 'Sin conexión'));
    return `<div class="player"><div class="player-avatar">${safe(p.name.slice(0,1).toUpperCase())}</div><div style="min-width:0"><div class="player-name">${safe(p.name)}</div><div class="player-sub">${safe(sub)}</div></div><div class="player-state ${p.online?'':'offline'}">${safe(label)}</div></div>`;
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
  const agreed = current.players.filter(p => p.mediaConsent).length;
  $('cameraStatus').textContent = current.settings.cameraEnabled ? (current.settings.cameraActive ? '♥ Activado: ambos lo habéis aceptado.' : `Consentimiento de cámara: ${agreed}/2 · Hasta que ambos aceptéis, no saldrán estos retos.`) : 'La cámara está desactivada en esta sala.';
  $('readyBtn').textContent = mine?.ready ? 'Preparado/a ✓ (desmarcar)' : 'Estoy listo/a ✓';
  $('readyBtn').disabled = !full;
  $('startBtn').hidden = !isHost;
  $('startBtn').disabled = !everyoneReady;
}
function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
}
function renderTimer() {
  if (!current?.game?.started || current.game.stage !== 'prompt') return;
  const end = current.game.timerEnd;
  $('timerValue').textContent = formatTime(end ? (end - Date.now()) / 1000 : 60);
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
  $('turnOverline').textContent = mine ? 'AHORA TE TOCA' : `TURNO DE ${turn?.name.toUpperCase() || 'TU PAREJA'}`;
  $('turnTitle').textContent = game.stage === 'choose' ? '¿Verdad o reto?' : (game.card.kind === 'truth' ? 'La verdad primero.' : 'Atrévete a hacerlo.');
  $('turnDescription').textContent = game.stage === 'choose' ? (mine ? 'Elige cómo quieres jugar esta ronda.' : `Esperando a que ${turn?.name || 'tu pareja'} elija una carta…`) : (mine ? 'Tu decisión. Puedes hacerlo o pasar, sin dar explicaciones.' : `${turn?.name || 'Tu pareja'} tiene la palabra. Dale su tiempo.`);
  $('chooseButtons').hidden = game.stage !== 'choose';
  $('activeCard').hidden = game.stage !== 'prompt';
  for (const id of ['pickTruth','pickDare','pickRandom']) $(id).disabled = !mine;
  if (game.stage === 'prompt' && game.card) {
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
  $('restartBtn').hidden = current.me !== current.host;
  const hist = game.history;
  $('roundHistory').innerHTML = hist.length ? hist.map(h => `<div class="history-row"><span>${safe(h.player)} · ${h.media ? safe(h.media) : (h.kind === 'truth'?'Verdad':'Reto')}</span><small>${h.outcome==='done'?'✓ Hecho':'↷ Pasó'}</small></div>`).join('') : '<span class="empty-history">Aún no hay rondas anteriores.</span>';
}
function render() {
  if (!current || !session) return;
  $('roomCode').textContent = current.code;
  renderPlayers();
  $('customCount').textContent = `${current.settings.customCount || 0} añadidas`;
  if (current.game.started) renderGame(); else renderWaiting();
}
async function copyText(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {
      const input = document.createElement('textarea');input.value = value;input.style.position='fixed';input.style.opacity='0';document.body.appendChild(input);input.select();
      if (!document.execCommand('copy')) throw new Error('No disponible');
      input.remove();
    }
    notify('¡Copiado! Ya puedes enviárselo.');
  } catch { window.prompt('Copia este texto para compartirlo:',value); }
}
function inviteUrl() { return `${window.location.origin}/?s=${encodeURIComponent(session.room)}${session.secret ? `#k=${session.secret}` : ''}`; }
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
  const params = {name,adult:true,mediaConsent:$('mediaConsentEntry').checked && Boolean(pendingSecret)};
  if (joining && $('mediaConsentEntry').checked && !pendingSecret) notify('Has entrado sin clave privada: podrás jugar, pero no activar los retos con fotos o vídeos.');
  const endpoint = joining ? '/api/join' : '/api/create';
  if (joining) params.code = $('joinCode').value.trim().toUpperCase();
  else {params.level = document.querySelector('[name="level"]:checked').value;params.cameraEnabled = $('enableCamera').checked;}
  busy = true;$('submitEntry').disabled = true;
  try { const data = await request(endpoint,params);openRoom(data);notify('¡Ya estáis más cerca de empezar!'); }
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
$('myMediaConsent').addEventListener('change',e=>{if(e.target.checked&&!session.secret){e.target.checked=false;return notify('Para fotos y vídeos necesitas el enlace privado completo.');}send('mediaConsent',e.target.checked);});
$('gameMediaConsent').addEventListener('change',e=>{if(e.target.checked&&!session.secret){e.target.checked=false;return notify('Para fotos y vídeos necesitas el enlace privado completo.');}send('mediaConsent',e.target.checked);});
$('pickTruth').addEventListener('click',()=>send('pick','truth'));
$('pickDare').addEventListener('click',()=>send('pick','dare'));
$('pickRandom').addEventListener('click',()=>send('pick','random'));
$('timerStart').addEventListener('click',()=>send('timer'));
$('doneCard').addEventListener('click',()=>send('finish'));
$('skipCard').addEventListener('click',()=>send('skip'));
$('restartBtn').addEventListener('click',()=> {if(window.confirm('¿Reiniciar la partida y los puntos para ambos?')) send('restart');});
$('mediaFile').addEventListener('change',e => {
  const file=e.target.files?.[0];
  if (!file) return;
  const mime=actualMime(file);
  const kind=current?.game?.card?.media;
  const goodTypes=kind==='foto'?['image/jpeg','image/png','image/webp','image/heic','image/heif']:['video/mp4','video/webm','video/quicktime'];
  if (!goodTypes.includes(mime) || file.size>maxMediaBytes || file.size===0) {
    e.target.value='';selectedMedia=null;$('sendMedia').disabled=true;
    return notify('Usa una imagen o vídeo compatible de hasta 12 MB.');
  }
  selectedMedia=file;
  if (selectedMediaUrl) URL.revokeObjectURL(selectedMediaUrl);
  selectedMediaUrl=mediaPreview($('mediaLocalPreview'),file,mime);
  $('sendMedia').textContent='Enviar cifrado a mi pareja ♡';
  $('mediaSendStatus').textContent='Revísalo antes de enviarlo. No se comparte automáticamente.';
  $('sendMedia').disabled=false;
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
    $('landing').hidden = true; $('roomScreen').hidden = false; render(); listen();
  } catch { clearSession();if (code) {setEntryMode(true);$('joinCode').value = code.toUpperCase().slice(0,6);} }
})();
