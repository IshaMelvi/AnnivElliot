import { io } from 'socket.io-client';

const SIGNAL_URL = 'https://annivelliot-signaling.onrender.com';
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const BITRATES = { '720-30': 4_000_000, '720-60': 6_000_000,
  '1080-30': 8_000_000, '1080-60': 12_000_000 };

const $ = (selector) => document.querySelector(selector);
const join = $('#join');
const joinForm = $('#join-form');
const roomInput = $('#room');
const joinStatus = $('#join-status');
const picker = $('#picker');
const pickerStatus = $('#picker-status');
const sourcesList = $('#sources');
const startShareButton = $('#start-share');
const call = $('#call');
const callStatus = $('#call-status');
const mainVideo = $('#main-video');
const pipVideo = $('#pip-video');
const remoteMic = $('#remote-mic');
const pip = $('#pip');
const pipLabel = $('#pip-label');
const stage = $('#stage');
const emptyStage = $('#empty-stage');
const toolbar = $('#toolbar');
const muteButton = $('#mute');
const cameraButton = $('#camera');
const shareButton = $('#share');
const fullscreenButton = $('#fullscreen');

let roomHash = null;
let socket = null;
let peer = null;
let negotiation = null;
let polite = false;
let micStream = null;
let cameraStream = null;
let screenStream = null;
let cameraSender = null;
let screenSenders = [];
let remoteMap = null;
let remoteStreams = new Map();
let pendingIce = [];
let signalQueue = Promise.resolve();
let cameraIsMain = false;
let audioWarning = '';
let busy = false;
let sessionVersion = 0;
let allSources = [];
let activeTab = 'window';
let selectedSourceId = null;
let screenSettings = { height: 720, fps: 30 };
let hideTimer = null;

function status(message) {
  callStatus.textContent = audioWarning ? message + ' · ' + audioWarning : message;
}

function errorText(error) {
  if (error?.name === 'NotAllowedError') return 'Autorisation de capture refusée.';
  if (error?.name === 'NotFoundError') return 'Périphérique ou source introuvable.';
  return error?.message || 'Une erreur est survenue.';
}

function setButton(button, active, activeLabel, inactiveLabel, slashWhenInactive = false) {
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', active ? activeLabel : inactiveLabel);
  button.title = active ? activeLabel : inactiveLabel;
  button.classList.toggle('is-active', active);
  button.classList.toggle('is-off', slashWhenInactive && !active);
}

function refreshButtons() {
  const micOn = Boolean(micStream?.getAudioTracks()[0]?.enabled);
  setButton(muteButton, !micOn, 'Réactiver mon micro', 'Couper mon micro');
  muteButton.classList.toggle('is-off', !micOn);
  setButton(cameraButton, Boolean(cameraStream), 'Désactiver ma webcam', 'Activer ma webcam', true);
  setButton(shareButton, Boolean(screenStream), 'Arrêter le partage', 'Partager mon écran');
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!toolbar.matches(':hover') && !toolbar.contains(document.activeElement) && picker.hidden) {
      call.classList.remove('controls-visible');
    }
  }, 2500);
}

function revealControls() {
  if (call.hidden) return;
  call.classList.add('controls-visible');
  scheduleHide();
}

call.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'mouse') revealControls();
});
call.addEventListener('pointerdown', revealControls);
toolbar.addEventListener('pointerenter', () => clearTimeout(hideTimer));
toolbar.addEventListener('pointerleave', scheduleHide);
document.addEventListener('keydown', (event) => {
  if (!call.hidden && event.key === 'Tab') revealControls();
  if (event.key === 'Escape' && !picker.hidden) closePicker();
});

async function hashRoom(name) {
  const bytes = new TextEncoder().encode(name.trim().normalize('NFC'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const name = roomInput.value.trim().normalize('NFC');
  if (name.length < 6) {
    joinStatus.textContent = 'Choisis au moins 6 caractères pour le salon.';
    return;
  }
  busy = true;
  joinStatus.textContent = 'Activation du micro…';
  try {
    const nextHash = await hashRoom(name);
    const capturedMic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false
    });
    micStream = capturedMic;
    roomHash = nextHash;
    sessionVersion += 1;
    refreshButtons();
    join.hidden = true;
    call.hidden = false;
    status('Connexion au serveur…');
    connectSignaling();
  } catch (error) {
    joinStatus.textContent = errorText(error);
  } finally {
    busy = false;
  }
});

function connectSignaling() {
  const current = io(SIGNAL_URL, {
    autoConnect: false,
    reconnection: true,
    timeout: 20000,
    transports: ['websocket']
  });
  socket = current;

  current.on('connect', () => {
    status('Entrée dans le salon…');
    current.timeout(15000).emit('join-room', roomHash, (error, response) => {
      if (socket !== current) return;
      if (error) {
        status('Le serveur ne répond pas. Nouvelle tentative…');
        current.disconnect().connect();
        return;
      }
      if (!response?.ok) {
        leave(response?.error || 'Impossible de rejoindre le salon.');
        return;
      }
      polite = !response.peerPresent;
      if (response.peerPresent) {
        status('Connexion avec votre ami…');
        createPeer();
      } else {
        status('En attente de votre ami…');
      }
    });
  });

  current.on('connect_error', () => {
    if (socket === current) status('Serveur inaccessible. Nouvelle tentative…');
  });
  current.on('disconnect', () => {
    if (socket !== current) return;
    closePeer();
    status('Connexion au serveur perdue. Reconnexion…');
  });
  current.on('peer-joined', () => {
    if (socket === current) status('Votre ami arrive. Connexion WebRTC…');
  });
  current.on('peer-left', () => {
    if (socket !== current) return;
    closePeer();
    status('Votre ami a quitté le salon. En attente…');
  });
  current.on('signal', (message) => {
    signalQueue = signalQueue.then(() => {
      if (socket === current) return handleSignal(message);
    }).catch((error) => {
      console.error('Signalisation WebRTC :', error);
      if (socket === current) status('Erreur WebRTC : ' + errorText(error));
    });
  });
  current.connect();
}

function send(type, data) {
  if (socket?.connected) socket.emit('signal', { type, data });
}

function sendMediaMap() {
  if (!micStream) return;
  // Les identifiants inactifs gardent la compatibilité avec le serveur Render existant.
  send('media-map', {
    mic: micStream.id,
    camera: cameraStream?.id || 'inactive-camera',
    screen: screenStream?.id || 'inactive-screen',
    cameraEnabled: Boolean(cameraStream),
    screenEnabled: Boolean(screenStream)
  });
}

function createPeer() {
  if (peer) return peer;
  const connection = new RTCPeerConnection(RTC_CONFIG);
  peer = connection;
  const state = { connection, makingOffer: false, ignoreOffer: false, isSettingRemoteAnswerPending: false };
  negotiation = state;

  connection.onicecandidate = (event) => {
    if (event.candidate && peer === connection) send('ice', event.candidate.toJSON());
  };
  connection.ontrack = (event) => {
    if (peer !== connection) return;
    for (const stream of event.streams) remoteStreams.set(stream.id, stream);
    updateVideos();
  };
  connection.onconnectionstatechange = () => {
    if (peer !== connection) return;
    if (connection.connectionState === 'connected') status('Connectés · Profitez du moment ♡');
    if (connection.connectionState === 'disconnected') status('Connexion instable…');
    if (connection.connectionState === 'failed') status('Connexion P2P impossible. Un relais TURN peut être nécessaire.');
  };
  connection.onnegotiationneeded = async () => {
    try {
      state.makingOffer = true;
      await connection.setLocalDescription();
      if (peer === connection) send(connection.localDescription.type, connection.localDescription.toJSON());
    } catch (error) {
      if (peer === connection) status('Erreur de négociation : ' + errorText(error));
      console.error('Négociation WebRTC :', error);
    } finally {
      state.makingOffer = false;
    }
  };

  for (const track of micStream.getTracks()) connection.addTrack(track, micStream);
  if (cameraStream) cameraSender = connection.addTrack(cameraStream.getVideoTracks()[0], cameraStream);
  if (screenStream) {
    screenSenders = screenStream.getTracks().map((track) => connection.addTrack(track, screenStream));
    configureScreenSender(screenSenders[0]);
  }
  sendMediaMap();
  return connection;
}

async function handleSignal(message) {
  if (!message || !socket?.connected) return;
  if (message.type === 'media-map') {
    const previous = remoteMap;
    remoteMap = message.data;
    if (previous?.camera !== remoteMap.camera) remoteStreams.delete(previous.camera);
    if (previous?.screen !== remoteMap.screen) remoteStreams.delete(previous.screen);
    updateVideos();
    return;
  }
  if (message.type === 'ice') {
    if (negotiation?.ignoreOffer) return;
    if (!peer?.remoteDescription) {
      pendingIce.push(message.data);
    } else {
      try { await peer.addIceCandidate(message.data); }
      catch (error) { if (!negotiation?.ignoreOffer) throw error; }
    }
    return;
  }
  if (message.type !== 'offer' && message.type !== 'answer') return;
  if (message.type === 'answer' && !peer) return;
  const connection = createPeer();
  const state = negotiation;
  const readyForOffer = !state.makingOffer &&
    (connection.signalingState === 'stable' || state.isSettingRemoteAnswerPending);
  const offerCollision = message.type === 'offer' && !readyForOffer;
  state.ignoreOffer = !polite && offerCollision;
  if (state.ignoreOffer) return;
  state.isSettingRemoteAnswerPending = message.type === 'answer';
  try {
    await connection.setRemoteDescription(message.data);
  } finally {
    state.isSettingRemoteAnswerPending = false;
  }
  await flushIce(connection);
  if (message.type === 'offer') {
    await connection.setLocalDescription();
    send('answer', connection.localDescription.toJSON());
  }
}

async function flushIce(connection) {
  const candidates = pendingIce;
  pendingIce = [];
  for (const candidate of candidates) {
    try { await connection.addIceCandidate(candidate); }
    catch (error) { if (!negotiation?.ignoreOffer) throw error; }
  }
}

function updateVideos() {
  const screen = remoteMap?.screenEnabled ? remoteStreams.get(remoteMap.screen) : null;
  const camera = remoteMap?.cameraEnabled ? remoteStreams.get(remoteMap.camera) : null;
  const mic = remoteMap?.mic ? remoteStreams.get(remoteMap.mic) : null;
  const hasScreen = Boolean(screen?.getVideoTracks().length);
  const hasCamera = Boolean(camera?.getVideoTracks().length);
  const main = cameraIsMain && hasCamera ? camera : hasScreen ? screen : hasCamera ? camera : null;
  const small = hasScreen && hasCamera ? (main === screen ? camera : screen) : null;

  if (mainVideo.srcObject !== main) mainVideo.srcObject = main;
  if (pipVideo.srcObject !== small) pipVideo.srcObject = small;
  if (remoteMic.srcObject !== mic) remoteMic.srcObject = mic;
  mainVideo.hidden = !main;
  pip.hidden = !small;
  emptyStage.hidden = Boolean(main);
  emptyStage.textContent = remoteMap ? 'Votre ami ne partage pas de vidéo.' : 'En attente de l’autre personne…';
  pipLabel.textContent = small === screen ? 'Écran' : 'Webcam';
  if (main) mainVideo.play().catch(() => {});
  if (small) pipVideo.play().catch(() => {});
  if (mic) remoteMic.play().catch(() => {});
}

function closePeer() {
  if (peer) {
    peer.onicecandidate = null;
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    peer.onnegotiationneeded = null;
    peer.close();
  }
  peer = null;
  negotiation = null;
  cameraSender = null;
  screenSenders = [];
  remoteMap = null;
  remoteStreams.clear();
  pendingIce = [];
  cameraIsMain = false;
  updateVideos();
}

muteButton.addEventListener('click', () => {
  const mic = micStream?.getAudioTracks()[0];
  if (!mic) return;
  mic.enabled = !mic.enabled;
  refreshButtons();
});

cameraButton.addEventListener('click', async () => {
  if (busy || !micStream) return;
  if (cameraStream) {
    stopCamera();
    return;
  }
  busy = true;
  cameraButton.disabled = true;
  const version = sessionVersion;
  try {
    const captured = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false
    });
    if (version !== sessionVersion) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }
    cameraStream = captured;
    if (peer) cameraSender = peer.addTrack(captured.getVideoTracks()[0], captured);
    sendMediaMap();
    refreshButtons();
    status('Webcam activée.');
  } catch (error) {
    status('Webcam : ' + errorText(error));
    revealControls();
  } finally {
    busy = false;
    cameraButton.disabled = false;
  }
});

function stopCamera() {
  if (!cameraStream) return;
  const captured = cameraStream;
  if (peer && cameraSender) peer.removeTrack(cameraSender);
  cameraSender = null;
  cameraStream = null;
  sendMediaMap();
  captured.getTracks().forEach((track) => track.stop());
  refreshButtons();
  status('Webcam désactivée.');
}

shareButton.addEventListener('click', async () => {
  if (busy || !micStream) return;
  if (screenStream) {
    stopScreen();
    return;
  }
  await openPicker();
});

async function openPicker() {
  busy = true;
  pickerStatus.textContent = '';
  try {
    allSources = await window.desktop.listSources();
    if (!allSources.length) throw new Error('Aucune fenêtre ou écran disponible.');
    activeTab = allSources.some((source) => source.kind === 'window') ? 'window' : 'screen';
    selectedSourceId = null;
    renderSources();
    picker.hidden = false;
    $('#picker-close').focus();
  } catch (error) {
    status('Partage : ' + errorText(error));
    revealControls();
  } finally {
    busy = false;
  }
}

function renderSources() {
  $('#tab-window').setAttribute('aria-selected', String(activeTab === 'window'));
  $('#tab-screen').setAttribute('aria-selected', String(activeTab === 'screen'));
  sourcesList.replaceChildren();
  const visible = allSources.filter((source) => source.kind === activeTab);
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'no-sources';
    empty.textContent = 'Aucune source disponible dans cet onglet.';
    sourcesList.append(empty);
  }
  for (const source of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'source';
    button.setAttribute('aria-pressed', String(selectedSourceId === source.id));
    const image = document.createElement('img');
    image.src = source.thumbnail;
    image.alt = '';
    const label = document.createElement('span');
    label.textContent = source.name;
    button.append(image, label);
    button.addEventListener('click', () => {
      selectedSourceId = source.id;
      for (const element of sourcesList.querySelectorAll('.source')) {
        element.setAttribute('aria-pressed', String(element === button));
      }
      startShareButton.disabled = false;
    });
    sourcesList.append(button);
  }
  startShareButton.disabled = !selectedSourceId;
}

$('#tab-window').addEventListener('click', () => {
  activeTab = 'window';
  selectedSourceId = null;
  renderSources();
});
$('#tab-screen').addEventListener('click', () => {
  activeTab = 'screen';
  selectedSourceId = null;
  renderSources();
});
$('#picker-close').addEventListener('click', closePicker);

function closePicker() {
  if (busy || picker.hidden) return;
  picker.hidden = true;
  selectedSourceId = null;
  shareButton.focus();
  scheduleHide();
}

startShareButton.addEventListener('click', async () => {
  if (busy || !selectedSourceId) return;
  busy = true;
  startShareButton.disabled = true;
  pickerStatus.textContent = 'Activation du partage…';
  const version = sessionVersion;
  let captured;
  try {
    const height = Number($('input[name="resolution"]:checked').value);
    const fps = Number($('input[name="fps"]:checked').value);
    const width = height === 1080 ? 1920 : 1280;
    await window.desktop.selectSource(selectedSourceId);
    captured = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } },
      audio: window.desktop.platform === 'win32'
    });
    if (version !== sessionVersion) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }
    const video = captured.getVideoTracks()[0];
    if (!video) throw new Error('La source sélectionnée ne contient pas de vidéo.');
    video.contentHint = 'motion';
    screenSettings = { height, fps };
    screenStream = captured;
    video.addEventListener('ended', () => {
      if (screenStream === captured) stopScreen('Le partage a été arrêté par le système.');
    });
    audioWarning = window.desktop.platform === 'win32' && !captured.getAudioTracks().length
      ? 'audio système indisponible' : '';
    if (peer) {
      screenSenders = captured.getTracks().map((track) => peer.addTrack(track, captured));
      configureScreenSender(screenSenders.find((sender) => sender.track?.kind === 'video'));
    }
    sendMediaMap();
    picker.hidden = true;
    selectedSourceId = null;
    pickerStatus.textContent = '';
    refreshButtons();
    status('Partage actif.');
    revealControls();
  } catch (error) {
    captured?.getTracks().forEach((track) => track.stop());
    pickerStatus.textContent = errorText(error);
  } finally {
    busy = false;
    startShareButton.disabled = !selectedSourceId;
  }
});

async function configureScreenSender(sender) {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = BITRATES[screenSettings.height + '-' + screenSettings.fps];
    params.encodings[0].maxFramerate = screenSettings.fps;
    params.encodings[0].scaleResolutionDownBy = 1;
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
  } catch (error) {
    console.warn('Réglage de qualité indisponible :', error);
  }
}

function stopScreen(message = 'Partage arrêté.') {
  if (!screenStream) return;
  const captured = screenStream;
  if (peer) for (const sender of screenSenders) peer.removeTrack(sender);
  screenSenders = [];
  screenStream = null;
  audioWarning = '';
  sendMediaMap();
  captured.getTracks().forEach((track) => track.stop());
  refreshButtons();
  status(message);
}

fullscreenButton.addEventListener('click', async () => {
  try { await window.desktop.toggleFullscreen(); }
  catch (error) { status('Plein écran : ' + errorText(error)); }
});
window.desktop.onFullscreenChange((enabled) => {
  setButton(fullscreenButton, enabled, 'Quitter le plein écran', 'Passer en plein écran');
});

let drag = null;
pip.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const box = pip.getBoundingClientRect();
  drag = { id: event.pointerId, offsetX: event.clientX - box.left,
    offsetY: event.clientY - box.top, startX: event.clientX, startY: event.clientY, moved: false };
  pip.setPointerCapture(event.pointerId);
});
pip.addEventListener('pointermove', (event) => {
  if (!drag || drag.id !== event.pointerId) return;
  if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5 && !drag.moved) return;
  drag.moved = true;
  const bounds = stage.getBoundingClientRect();
  const left = Math.max(0, Math.min(bounds.width - pip.offsetWidth, event.clientX - bounds.left - drag.offsetX));
  const top = Math.max(0, Math.min(bounds.height - pip.offsetHeight, event.clientY - bounds.top - drag.offsetY));
  pip.style.right = 'auto';
  pip.style.left = left + 'px';
  pip.style.top = top + 'px';
});
pip.addEventListener('pointerup', (event) => {
  if (!drag || drag.id !== event.pointerId) return;
  if (!drag.moved) {
    cameraIsMain = !cameraIsMain;
    updateVideos();
  }
  drag = null;
  pip.releasePointerCapture(event.pointerId);
});
pip.addEventListener('pointercancel', () => { drag = null; });
pip.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    cameraIsMain = !cameraIsMain;
    updateVideos();
  }
});

function leave(message = '') {
  sessionVersion += 1;
  const previousSocket = socket;
  socket = null;
  previousSocket?.disconnect();
  closePeer();
  for (const stream of [micStream, cameraStream, screenStream]) {
    stream?.getTracks().forEach((track) => track.stop());
  }
  micStream = null;
  cameraStream = null;
  screenStream = null;
  roomHash = null;
  audioWarning = '';
  busy = false;
  picker.hidden = true;
  call.hidden = true;
  call.classList.remove('controls-visible');
  join.hidden = false;
  joinStatus.textContent = message;
  refreshButtons();
}

$('#leave').addEventListener('click', () => leave());
