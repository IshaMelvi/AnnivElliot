import { io } from 'socket.io-client';

// À remplacer par l'URL HTTPS du service Render avant de créer l'installateur.
const SIGNAL_URL = 'https://annivelliot-signaling.onrender.com';
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const join = document.querySelector('#join');
const joinForm = document.querySelector('#join-form');
const roomInput = document.querySelector('#room');
const joinStatus = document.querySelector('#join-status');
const picker = document.querySelector('#picker');
const sourcesList = document.querySelector('#sources');
const call = document.querySelector('#call');
const callStatus = document.querySelector('#call-status');
const mainVideo = document.querySelector('#main-video');
const pipVideo = document.querySelector('#pip-video');
const pip = document.querySelector('#pip');
const pipLabel = document.querySelector('#pip-label');
const stage = document.querySelector('#stage');
const emptyStage = document.querySelector('#empty-stage');
const muteButton = document.querySelector('#mute');

let roomHash = null;
let socket = null;
let peer = null;
let screenStream = null;
let cameraStream = null;
let remoteMap = null;
let remoteStreams = new Map();
let pendingIce = [];
let signalQueue = Promise.resolve();
let cameraIsMain = false;
let audioWarning = '';
let joining = false;

function status(message) {
  callStatus.textContent = audioWarning ? `${message} · ${audioWarning}` : message;
}

function errorText(error) {
  if (error?.name === 'NotAllowedError') return 'Capture refusée. Autorise l’écran, la webcam et le micro.';
  if (error?.name === 'NotFoundError') return 'Écran, webcam ou micro introuvable.';
  return error?.message || 'Une erreur est survenue.';
}

async function hashRoom(name) {
  const bytes = new TextEncoder().encode(name.trim().normalize('NFC'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (joining) return;
  const name = roomInput.value.trim().normalize('NFC');
  if (name.length < 6) {
    joinStatus.textContent = 'Choisis au moins 6 caractères pour le salon.';
    return;
  }
  joining = true;
  joinStatus.textContent = '';
  try {
    roomHash = await hashRoom(name);
    const sources = await window.desktop.listSources();
    if (!sources.length) throw new Error('Aucun écran ou fenêtre à partager.');
    sourcesList.replaceChildren();
    for (const source of sources) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source';
      const image = document.createElement('img');
      image.src = source.thumbnail;
      image.alt = '';
      const label = document.createElement('span');
      label.textContent = source.name;
      button.append(image, label);
      button.addEventListener('click', () => startWithSource(source.id));
      sourcesList.append(button);
    }
    picker.hidden = false;
  } catch (error) {
    joinStatus.textContent = errorText(error);
  } finally {
    joining = false;
  }
});

document.querySelector('#back').addEventListener('click', () => { picker.hidden = true; });

async function startWithSource(sourceId) {
  if (joining) return;
  joining = true;
  picker.hidden = true;
  joinStatus.textContent = 'Activation de l’écran, de la webcam et du micro…';
  let capturedScreen;
  try {
    await window.desktop.selectSource(sourceId);
    capturedScreen = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: window.desktop.platform === 'win32'
    });
    const capturedCamera = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    screenStream = capturedScreen;
    cameraStream = capturedCamera;
    screenStream.getVideoTracks()[0].contentHint = 'motion';
    screenStream.getVideoTracks()[0].addEventListener('ended', () => leave('Partage d’écran terminé.'));
    audioWarning = window.desktop.platform === 'win32' && !screenStream.getAudioTracks().length
      ? 'audio système indisponible' : '';
    join.hidden = true;
    call.hidden = false;
    status('Connexion au serveur…');
    connectSignaling();
  } catch (error) {
    capturedScreen?.getTracks().forEach((track) => track.stop());
    cameraStream?.getTracks().forEach((track) => track.stop());
    screenStream = null;
    cameraStream = null;
    joinStatus.textContent = errorText(error);
  } finally {
    joining = false;
  }
}

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
    current.timeout(15000).emit('join-room', roomHash, async (error, response) => {
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
      if (response.peerPresent) {
        status('Connexion avec votre ami…');
        try { await makeOffer(); } catch (failure) { status(errorText(failure)); }
      } else {
        status('En attente de votre ami…');
      }
    });
  });

  current.on('connect_error', () => status('Serveur inaccessible. Nouvelle tentative…'));
  current.on('disconnect', () => {
    closePeer();
    if (socket === current) status('Connexion au serveur perdue. Reconnexion…');
  });
  current.on('peer-joined', () => status('Votre ami arrive. Connexion WebRTC…'));
  current.on('peer-left', () => {
    closePeer();
    status('Votre ami a quitté le salon. En attente…');
  });
  current.on('signal', (message) => {
    signalQueue = signalQueue.then(() => {
      if (socket === current) return handleSignal(message);
    }).catch((error) => {
      console.error('Signalisation WebRTC :', error);
      status(`Erreur WebRTC : ${errorText(error)}`);
    });
  });

  current.connect();
}

function send(type, data) {
  if (socket?.connected) socket.emit('signal', { type, data });
}

function createPeer() {
  if (peer) return peer;
  const connection = new RTCPeerConnection(RTC_CONFIG);
  peer = connection;
  remoteStreams = new Map();

  connection.onicecandidate = (event) => {
    if (event.candidate) send('ice', event.candidate.toJSON());
  };
  connection.ontrack = (event) => {
    for (const stream of event.streams) remoteStreams.set(stream.id, stream);
    updateVideos();
  };
  connection.onconnectionstatechange = () => {
    if (peer !== connection) return;
    if (connection.connectionState === 'connected') status('Connectés · Profitez du moment ♡');
    if (connection.connectionState === 'disconnected') status('Connexion instable…');
    if (connection.connectionState === 'failed') status('Connexion P2P impossible. Un relais TURN peut être nécessaire.');
  };

  const screenVideo = screenStream.getVideoTracks()[0];
  const screenSender = connection.addTrack(screenVideo, screenStream);
  for (const track of screenStream.getAudioTracks()) connection.addTrack(track, screenStream);
  for (const track of cameraStream.getTracks()) connection.addTrack(track, cameraStream);
  send('media-map', { screen: screenStream.id, camera: cameraStream.id });
  configureScreenSender(screenSender);
  return connection;
}

async function configureScreenSender(sender) {
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = 8_000_000;
    params.encodings[0].maxFramerate = 30;
    params.encodings[0].scaleResolutionDownBy = 1;
    await sender.setParameters(params);
  } catch (error) {
    console.warn('Réglage de qualité indisponible :', error);
  }
}

async function makeOffer() {
  const connection = createPeer();
  await connection.setLocalDescription(await connection.createOffer());
  send('offer', connection.localDescription.toJSON());
}

async function handleSignal(message) {
  if (!message || !socket?.connected) return;
  if (message.type === 'media-map') {
    remoteMap = message.data;
    updateVideos();
    return;
  }
  if (message.type === 'ice') {
    if (!peer?.remoteDescription) pendingIce.push(message.data);
    else await peer.addIceCandidate(message.data);
    return;
  }
  if (message.type === 'offer') {
    const connection = createPeer();
    await connection.setRemoteDescription(message.data);
    await flushIce(connection);
    await connection.setLocalDescription(await connection.createAnswer());
    send('answer', connection.localDescription.toJSON());
    return;
  }
  if (message.type === 'answer' && peer) {
    await peer.setRemoteDescription(message.data);
    await flushIce(peer);
  }
}

async function flushIce(connection) {
  const candidates = pendingIce;
  pendingIce = [];
  for (const candidate of candidates) await connection.addIceCandidate(candidate);
}

function updateVideos() {
  const screen = remoteMap ? remoteStreams.get(remoteMap.screen) : null;
  const camera = remoteMap ? remoteStreams.get(remoteMap.camera) : null;
  const main = cameraIsMain ? camera : screen;
  const small = cameraIsMain ? screen : camera;
  if (mainVideo.srcObject !== main) mainVideo.srcObject = main || null;
  if (pipVideo.srcObject !== small) pipVideo.srcObject = small || null;
  mainVideo.hidden = !main;
  pipVideo.hidden = !small;
  emptyStage.hidden = Boolean(main);
  pipLabel.textContent = cameraIsMain ? 'Écran' : 'Webcam';
  if (main) mainVideo.play().catch(() => {});
  if (small) pipVideo.play().catch(() => {});
}

function swapVideos() {
  cameraIsMain = !cameraIsMain;
  updateVideos();
}

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
  pip.style.left = `${left}px`;
  pip.style.top = `${top}px`;
});
pip.addEventListener('pointerup', (event) => {
  if (!drag || drag.id !== event.pointerId) return;
  if (!drag.moved) swapVideos();
  drag = null;
  pip.releasePointerCapture(event.pointerId);
});
pip.addEventListener('pointercancel', () => { drag = null; });
pip.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    swapVideos();
  }
});

muteButton.addEventListener('click', () => {
  const mic = cameraStream?.getAudioTracks()[0];
  if (!mic) return;
  mic.enabled = !mic.enabled;
  muteButton.setAttribute('aria-pressed', String(!mic.enabled));
  muteButton.textContent = mic.enabled ? '🎙 Couper mon micro' : '🔇 Réactiver mon micro';
});

function closePeer() {
  if (peer) {
    peer.ontrack = null;
    peer.onicecandidate = null;
    peer.onconnectionstatechange = null;
    peer.close();
  }
  peer = null;
  remoteMap = null;
  remoteStreams.clear();
  pendingIce = [];
  cameraIsMain = false;
  updateVideos();
}

function leave(message = '') {
  const oldSocket = socket;
  socket = null;
  oldSocket?.disconnect();
  closePeer();
  for (const stream of [screenStream, cameraStream]) stream?.getTracks().forEach((track) => track.stop());
  screenStream = null;
  cameraStream = null;
  roomHash = null;
  audioWarning = '';
  call.hidden = true;
  join.hidden = false;
  picker.hidden = true;
  joinStatus.textContent = message;
  muteButton.setAttribute('aria-pressed', 'false');
  muteButton.textContent = '🎙 Couper mon micro';
}

document.querySelector('#leave').addEventListener('click', () => leave());
