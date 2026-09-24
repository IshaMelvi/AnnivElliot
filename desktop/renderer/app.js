import { io } from 'socket.io-client';
import { normalizeAudioSettings } from './voice-gate.mjs';
import { microphoneError } from './audio.js';
import { createAudioSettings } from './audio-settings.js';
import { startDiagnostics } from './diagnostics.js';
import { normalizeQuality, screenBitrate } from './video-quality.mjs';
import { createChat } from './chat.js';

const SIGNAL_URL = 'https://annivelliot-signaling.onrender.com';
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const $ = (selector) => document.querySelector(selector);
const join = $('#join');
const joinForm = $('#join-form');
const displayNameInput = $('#display-name');
const roomInput = $('#room');
const joinStatus = $('#join-status');
const picker = $('#picker');
const pickerStatus = $('#picker-status');
const sourcesList = $('#sources');
const startShareButton = $('#start-share');
const call = $('#call');
const videoArea = $('#video-area');
const callStatus = $('#call-status');
const mainVideo = $('#main-video');
const pipVideo = $('#pip-video');
const remoteMic = $('#remote-mic');
const remoteSystem = $('#remote-system');
const splitView = $('#split-view');
const splitRemote = $('#split-remote');
const splitLocal = $('#split-local');
const splitRemoteVideo = $('#split-remote-video');
const splitLocalVideo = $('#split-local-video');
const splitRemoteEmpty = $('#split-remote-empty');
const splitLocalEmpty = $('#split-local-empty');
const mainMute = $('#main-mute');
const splitMute = $('#split-mute');
const pipMute = $('#pip-mute');
const pip = $('#pip');
const pipLabel = $('#pip-label');
const pipResize = $('#pip-resize');
const localPip = $('#local-pip');
const localPipVideo = $('#local-pip-video');
const localPipLabel = $('#local-pip-label');
const localPipResize = $('#local-pip-resize');
const stage = $('#stage');
const emptyStage = $('#empty-stage');
const emptyStageText = $('#empty-stage-text');
const toolbar = $('#toolbar');
const muteButton = $('#mute');
const cameraButton = $('#camera');
const shareButton = $('#share');
const fullscreenButton = $('#fullscreen');
const selfName = $('#self-name');
const selfAvatar = $('#self-avatar');
const remotePerson = $('#remote-person');
const remoteName = $('#remote-name');
const remoteAvatar = $('#remote-avatar');
const remoteState = $('#remote-state');
const remoteMutedMark = $('#remote-muted-mark');
const personMenu = $('#person-menu');
const personMenuName = $('#person-menu-name');
const personVolumeInput = $('#person-volume');
const personVolumeValue = $('#person-volume-value');
const personMuteButton = $('#person-mute');
const videoVolumeInput = $('#video-volume');
const videoVolumeValue = $('#video-volume-value');
const PROFILE_KEY = 'annivelliot.profile.v1';

function volumeOr(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : fallback;
}

function loadProfile() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; }
  catch (error) { console.warn('Profil local illisible :', error); }
  const quality = stored.quality || {};
  return {
    id: typeof stored.id === 'string' && /^[0-9a-f-]{36}$/i.test(stored.id)
      ? stored.id : crypto.randomUUID(),
    displayName: typeof stored.displayName === 'string' ? stored.displayName.slice(0, 32) : '',
    defaultVideoVolume: volumeOr(stored.defaultVideoVolume, 100),
    audio: normalizeAudioSettings(stored.audio),
    quality: normalizeQuality(quality),
    friends: stored.friends && typeof stored.friends === 'object' && !Array.isArray(stored.friends)
      ? stored.friends : {}
  };
}

let profile = loadProfile();
function saveProfile() {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); }
  catch (error) { console.warn('Enregistrement du profil impossible :', error); }
}
saveProfile();
displayNameInput.value = profile.displayName;
for (const radio of document.querySelectorAll('input[name="resolution"]')) {
  radio.checked = Number(radio.value) === profile.quality.height;
}
for (const radio of document.querySelectorAll('input[name="fps"]')) {
  radio.checked = Number(radio.value) === profile.quality.fps;
}
displayNameInput.addEventListener('input', () => {
  profile.displayName = displayNameInput.value.trim().slice(0, 32);
  saveProfile();
});

let roomHash = null;
let socket = null;
let peer = null;
let negotiation = null;
let polite = false;
let micStream = null;
let localAvStream = null;
let cameraStream = null;
let screenStream = null;
let cameraSender = null;
let screenSenders = [];
let remoteMap = null;
let remoteStreams = new Map();
let pendingIce = [];
let signalQueue = Promise.resolve();
let cameraIsMain = false;
let localCameraIsMain = false;
let viewMode = 'remote';
let displayName = profile.displayName;
let remotePresent = false;
let personVolume = 100;
let personMuted = false;
let videoVolume = profile.defaultVideoVolume;
let activeRemoteKey = null;
let audioWarning = '';
let busy = false;
let sessionVersion = 0;
let allSources = [];
let activeTab = 'window';
let selectedSourceId = null;
let screenSettings = { ...profile.quality };
let hideTimer = null;
let pickerGeneration = 0;
let extendedSources = false;
const remoteVideoElements = [mainVideo, pipVideo, splitRemoteVideo];
const playbackAudio = new Map();
const audioOnlyStreams = new WeakMap();
const chat = createChat({ getSocket: () => socket, getPeerName: () => remoteName.textContent || 'Votre ami' });

const audioSettings = createAudioSettings({
  settings: profile.audio, save: saveProfile, outputs: [remoteMic, remoteSystem, ...remoteVideoElements],
  onVolume: applyIncomingVolume,
  onNotice: (text) => { if (call.hidden) joinStatus.textContent = text; else status(text); },
  onInputEnded: () => { refreshButtons(); sendMediaMap(); }
});
startDiagnostics(() => ({ peer,
  sender: screenSenders.find((sender) => sender.track?.kind === 'video'),
  remoteTrack: remoteMap?.screenEnabled ? remoteStreams.get(remoteMap.screen)?.getVideoTracks()[0] : null,
  remoteCameraTrack: remoteMap?.cameraEnabled ? remoteStreams.get(remoteMap.camera)?.getVideoTracks()[0] : null,
  remoteMicTrack: remoteStreams.get(remoteMap?.mic)?.getAudioTracks()[0],
  conversationGrouped: remoteMap?.cameraEnabled === true && remoteMap?.camera === remoteMap?.mic,
  capture: screenStream?.getVideoTracks()[0]?.getSettings(), target: screenSettings
}));
function updateBitrateLabels() {
  $('#share-bitrate').value = String(screenSettings.bitrate);
  $('#live-bitrate').value = String(screenSettings.bitrate);
  $('#live-bitrate-value').textContent = screenBitrate(screenSettings) / 1e6 + ' Mbit/s';
  const selected = { height: Number($('input[name="resolution"]:checked').value),
    fps: Number($('input[name="fps"]:checked').value), bitrate: Number($('#share-bitrate').value) };
  $('#bitrate-hint').textContent = 'Plafond : ' + screenBitrate(selected) / 1e6 + ' Mbit/s. Le débit réellement utilisé dépend de votre liaison et du contenu.';
}
updateBitrateLabels();
$('#share-bitrate').addEventListener('change', () => {
  screenSettings.bitrate = Number($('#share-bitrate').value);
  profile.quality.bitrate = screenSettings.bitrate;
  saveProfile(); updateBitrateLabels(); configureVideoSenders();
});
$('#live-bitrate').addEventListener('change', () => {
  screenSettings.bitrate = Number($('#live-bitrate').value);
  profile.quality.bitrate = screenSettings.bitrate;
  saveProfile(); updateBitrateLabels(); configureVideoSenders();
});
document.querySelectorAll('input[name="resolution"], input[name="fps"]').forEach((input) => input.addEventListener('change', updateBitrateLabels));

function status(message) {
  callStatus.textContent = audioWarning ? message + ' · ' + audioWarning : message;
}

function errorText(error) {
  if (error?.name === 'NotAllowedError') return 'Autorisation de capture refusée.';
  if (error?.name === 'NotFoundError') return 'Périphérique ou source introuvable.';
  return error?.message?.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || 'Une erreur est survenue.';
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
  setButton(muteButton, micOn, 'Couper mon micro', 'Réactiver mon micro', true);
  setButton(cameraButton, Boolean(cameraStream), 'Désactiver ma webcam', 'Activer ma webcam', true);
  setButton(shareButton, Boolean(screenStream), 'Arrêter le partage', 'Partager mon écran');
}

function remoteSettingsKey(map) {
  if (typeof map?.profileId === 'string' && /^[0-9a-f-]{36}$/i.test(map.profileId)) {
    return 'id:' + map.profileId.toLowerCase();
  }
  const name = typeof map?.displayName === 'string' ? map.displayName.trim().toLocaleLowerCase() : '';
  return name ? 'name:' + name.slice(0, 32) : null;
}

function selectRemoteSettings(map) {
  const key = remoteSettingsKey(map);
  if (key === activeRemoteKey) return;
  activeRemoteKey = key;
  const saved = key ? profile.friends[key] : null;
  personVolume = volumeOr(saved?.personVolume, 100);
  personMuted = saved?.personMuted === true;
  videoVolume = volumeOr(saved?.videoVolume, profile.defaultVideoVolume);
  personVolumeInput.value = String(personVolume);
  videoVolumeInput.value = String(videoVolume);
  applyIncomingVolume();
}

function saveFriendSettings() {
  if (activeRemoteKey) {
    profile.friends[activeRemoteKey] = { personVolume, personMuted, videoVolume };
  } else {
    profile.defaultVideoVolume = videoVolume;
  }
  saveProfile();
}

function updateRoster() {
  selfName.textContent = displayName || 'Vous';
  selfAvatar.textContent = (displayName || 'Vous').charAt(0).toLocaleUpperCase();
  remotePerson.hidden = !remotePresent;
  const name = typeof remoteMap?.displayName === 'string' && remoteMap.displayName.trim()
    ? remoteMap.displayName.trim().slice(0, 32) : 'Votre ami';
  remoteName.textContent = name;
  remoteAvatar.textContent = name.charAt(0).toLocaleUpperCase();
  personMenuName.textContent = name;
  remoteState.textContent = peer?.connectionState === 'connected' ? 'Connecté' : 'Connexion…';
  remoteMutedMark.hidden = !personMuted && personVolume > 0;
  if (!remotePresent) personMenu.hidden = true;
}

function applyIncomingVolume() {
  const personLevel = personMuted ? 0 : personVolume / 100 * profile.audio.masterVolume / 100;
  remoteMic.volume = personLevel;
  remoteSystem.volume = personLevel * videoVolume / 100;
  for (const element of remoteVideoElements) element.volume = personLevel * (playbackAudio.get(element) === 'screen' ? videoVolume / 100 : 1);
  personVolumeValue.textContent = personVolume + ' %';
  videoVolumeValue.textContent = videoVolume + ' %';
  personMuteButton.setAttribute('aria-pressed', String(personMuted));
  personMuteButton.textContent = personMuted ? 'Rétablir le son' : 'Rendre muet';
  updateRoster();
}

function openPersonMenu() {
  if (!remotePresent) return;
  personMenu.hidden = false;
  updateRoster();
}

remotePerson.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  openPersonMenu();
});
remotePerson.addEventListener('click', () => {
  personMenu.hidden = !personMenu.hidden;
  updateRoster();
});
document.addEventListener('pointerdown', (event) => {
  if (!personMenu.contains(event.target) && !remotePerson.contains(event.target)) personMenu.hidden = true;
});
personVolumeInput.addEventListener('input', () => {
  personVolume = Number(personVolumeInput.value);
  applyIncomingVolume();
  saveFriendSettings();
});
personMuteButton.addEventListener('click', () => {
  personMuted = !personMuted;
  applyIncomingVolume();
  saveFriendSettings();
});
videoVolumeInput.addEventListener('input', () => {
  videoVolume = Number(videoVolumeInput.value);
  applyIncomingVolume();
  saveFriendSettings();
});
videoVolumeInput.value = String(videoVolume);
applyIncomingVolume();

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!toolbar.querySelector(':focus-visible') && picker.hidden) {
      call.classList.remove('controls-visible');
    }
  }, 3000);
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
toolbar.addEventListener('pointerleave', scheduleHide);
toolbar.addEventListener('focusin', revealControls);
toolbar.addEventListener('focusout', scheduleHide);
document.addEventListener('keydown', (event) => {
  if (!call.hidden && event.key === 'Tab') revealControls();
  if (event.key === 'Escape' && !picker.hidden) closePicker();
  if (event.key === 'Escape') personMenu.hidden = true;
});

async function hashRoom(name) {
  const bytes = new TextEncoder().encode(name.trim().normalize('NFC'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await joinRoom();
});
$('#join-without-mic').addEventListener('click', () => { if (joinForm.reportValidity()) joinRoom(true); });
async function joinRoom(withoutMic = false) {
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
    const capturedMic = withoutMic ? null : await audioSettings.start();
    micStream = capturedMic;
    localAvStream = new MediaStream();
    if (withoutMic) await audioSettings.listenOnly();
    displayName = displayNameInput.value.trim().slice(0, 32);
    profile.displayName = displayName;
    saveProfile();
    roomHash = nextHash;
    sessionVersion += 1;
    chat.reset();
    refreshButtons();
    updateRoster();
    join.hidden = true;
    call.hidden = false;
    status('Connexion au serveur…');
    connectSignaling();
  } catch (error) {
    audioSettings.stop();
    joinStatus.textContent = microphoneError(error);
    $('#join-without-mic').hidden = false;
  } finally {
    busy = false;
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
      chat.connected(true);
      call.style.setProperty('--local-accent', polite ? '#a5b4fc' : '#c4b5fd');
      call.style.setProperty('--remote-accent', polite ? '#c4b5fd' : '#a5b4fc');
      remotePresent = Boolean(response.peerPresent);
      updateRoster();
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
    chat.connected(false);
    status('Connexion au serveur perdue. Reconnexion…');
  });
  current.on('peer-joined', () => {
    if (socket !== current) return;
    remotePresent = true;
    updateRoster();
    status('Votre ami arrive. Connexion WebRTC…');
  });
  current.on('peer-left', () => {
    if (socket !== current) return;
    closePeer();
    status('Votre ami a quitté le salon. En attente…');
  });
  current.on('chat-message', (data) => { if (socket === current) chat.receive(data); });
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
  if (!localAvStream) return;
  // Les identifiants inactifs gardent la compatibilité avec le serveur Render existant.
  send('media-map', {
    mic: localAvStream.id,
    camera: cameraStream ? localAvStream.id : 'inactive-camera',
    screen: screenStream?.id || 'inactive-screen',
    cameraEnabled: Boolean(cameraStream),
    screenEnabled: Boolean(screenStream),
    micEnabled: Boolean(micStream?.getAudioTracks()[0]?.enabled),
    displayName,
    profileId: profile.id
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
    for (const stream of event.streams) {
      remoteStreams.set(stream.id, stream);
      stream.onremovetrack = () => { if (peer === connection) updateVideos(); };
    }
    updateVideos();
  };
  connection.onconnectionstatechange = () => {
    if (peer !== connection) return;
    updateRoster();
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

  connection.onsignalingstatechange = () => {
    if (peer === connection && connection.signalingState === 'stable') configureVideoSenders();
  };

  for (const track of micStream?.getAudioTracks() || []) connection.addTrack(track, localAvStream);
  if (cameraStream) cameraSender = connection.addTrack(cameraStream.getVideoTracks()[0], localAvStream);
  if (screenStream) {
    screenSenders = screenStream.getTracks().map((track) => connection.addTrack(track, screenStream));
    configureVideoSenders();
  }
  sendMediaMap();
  return connection;
}

async function handleSignal(message) {
  if (!message || !socket?.connected) return;
  if (message.type === 'media-map') {
    const previous = remoteMap;
    remoteMap = message.data;
    remotePresent = true;
    selectRemoteSettings(remoteMap);
    if (previous?.camera !== remoteMap.camera && previous?.camera !== remoteMap.mic) remoteStreams.delete(previous.camera);
    if (previous?.screen !== remoteMap.screen) remoteStreams.delete(previous.screen);
    updateVideos();
    updateRoster();
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
  const remoteMain = cameraIsMain && hasCamera ? camera : hasScreen ? screen : hasCamera ? camera : null;
  const remoteOther = hasScreen && hasCamera ? (remoteMain === screen ? camera : screen) : null;
  const localScreen = screenStream?.getVideoTracks().length ? screenStream : null;
  const localCamera = cameraStream?.getVideoTracks().length ? cameraStream : null;
  const localMain = localCameraIsMain && localCamera ? localCamera : localScreen || localCamera;
  const localOther = localScreen && localCamera ? (localMain === localScreen ? localCamera : localScreen) : null;
  const split = viewMode === 'split';
  const main = viewMode === 'remote' ? remoteMain : viewMode === 'local' ? localMain : null;
  const small = viewMode === 'remote' ? remoteOther : viewMode === 'local' ? remoteMain : null;
  const localSmall = viewMode === 'local' ? localOther : null;
  const remoteMuted = remoteMap?.micEnabled === false;
  stage.dataset.view = viewMode;
  emptyStage.dataset.owner = viewMode === 'local' || !remotePresent ? 'local' : 'remote';

  // Each received AV group has exactly one audible element. When its video is
  // visible, play audio on that same element so Chromium controls AV playout together.
  for (const element of remoteVideoElements) element.muted = true;
  remoteMic.muted = true;
  remoteSystem.muted = true;
  playbackAudio.clear();
  showMedia(mainVideo, main);
  showMedia(pipVideo, small);
  showMedia(localPipVideo, localSmall);
  showMedia(splitRemoteVideo, split ? remoteMain : null);
  showMedia(splitLocalVideo, split ? localMain : null);
  routeGroupAudio('mic', mic, remoteMic, camera);
  routeGroupAudio('screen', screen, remoteSystem, screen);
  applyIncomingVolume();

  mainVideo.hidden = split || !main;
  splitView.hidden = !split;
  pip.hidden = split || !small;
  localPip.hidden = split || !localSmall;
  emptyStage.hidden = split || Boolean(main);
  emptyStageText.textContent = viewMode === 'local'
    ? 'Activez votre webcam ou partagez votre écran. Cliquez ici pour revenir aux deux vues.'
    : remoteMap ? 'Votre ami ne partage pas de vidéo. Cliquez ici pour revenir aux deux vues.'
      : 'En attente de l’autre personne… Cliquez ici pour afficher les deux vues.';
  splitRemoteEmpty.hidden = Boolean(remoteMain);
  splitLocalEmpty.hidden = Boolean(localMain);
  pipLabel.textContent = viewMode === 'local' ? 'Votre ami'
    : small === screen ? 'Écran' : 'Webcam';
  pip.setAttribute('aria-label', viewMode === 'local'
    ? 'Afficher la vidéo de votre ami en grand' : 'Inverser les vidéos de votre ami');
  localPipLabel.textContent = localSmall === localScreen ? 'Votre écran' : 'Votre webcam';
  localPip.setAttribute('aria-label', localSmall === localScreen
    ? 'Afficher votre écran en grand' : 'Afficher votre webcam en grand');
  mainMute.hidden = !(remoteMuted && viewMode === 'remote' && remoteMain);
  splitMute.hidden = !(remoteMuted && split && remoteMain);
  pipMute.hidden = !(remoteMuted && viewMode === 'local' && small);
  if (!pip.hidden) fitPip(pip);
  if (!localPip.hidden) fitPip(localPip);
}

function audioOnly(stream) {
  const tracks = stream?.getAudioTracks() || [];
  if (!tracks.length) return null;
  const previous = audioOnlyStreams.get(stream);
  if (previous && previous.getAudioTracks().length === tracks.length && tracks.every((track) => previous.getTracks().includes(track))) return previous;
  const audio = new MediaStream(tracks);
  audioOnlyStreams.set(stream, audio);
  return audio;
}
function routeGroupAudio(kind, stream, fallback, videoStream) {
  // Keep the fallback attached to audio tracks only, avoiding a second video decoder.
  showMedia(fallback, audioOnly(stream));
  const visible = videoStream && remoteVideoElements.find((element) => element.srcObject === videoStream && videoStream.getAudioTracks().length);
  if (visible) { playbackAudio.set(visible, kind); visible.muted = false; }
  else fallback.muted = false;
}

function showMedia(element, stream) {
  if (element.srcObject !== stream) {
    // Libère l'aperçu masqué sans arrêter la piste encore envoyée à l'autre personne.
    element.pause();
    element.srcObject = stream;
  }
  if (stream && element.paused) element.play().catch(() => {});
}

function showSplit() {
  if (viewMode === 'split') return;
  viewMode = 'split';
  updateVideos();
}

stage.addEventListener('click', (event) => {
  if (viewMode === 'split' || event.target.closest('#split-view, #pip, #local-pip')) return;
  showSplit();
});
mainVideo.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    showSplit();
  }
});
splitRemote.addEventListener('click', () => {
  viewMode = 'remote';
  updateVideos();
});
splitLocal.addEventListener('click', () => {
  viewMode = 'local';
  updateVideos();
});

function closePeer() {
  if (peer) {
    peer.onicecandidate = null;
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    peer.onnegotiationneeded = null;
    peer.onsignalingstatechange = null;
    peer.close();
  }
  peer = null;
  negotiation = null;
  cameraSender = null;
  screenSenders = [];
  remoteMap = null;
  remotePresent = false;
  remoteStreams.clear();
  pendingIce = [];
  cameraIsMain = false;
  localCameraIsMain = false;
  viewMode = 'remote';
  personVolume = 100;
  personMuted = false;
  personVolumeInput.value = '100';
  videoVolume = profile.defaultVideoVolume;
  videoVolumeInput.value = String(videoVolume);
  activeRemoteKey = null;
  applyIncomingVolume();
  updateVideos();
}

muteButton.addEventListener('click', async () => {
  const mic = micStream?.getAudioTracks()[0];
  if (!mic) {
    if (busy || !roomHash) return;
    busy = true;
    const version = sessionVersion;
    try {
      const captured = await audioSettings.start();
      if (version !== sessionVersion) { audioSettings.stop(); return; }
      micStream = captured;
      if (peer) peer.addTrack(captured.getAudioTracks()[0], localAvStream);
      sendMediaMap(); refreshButtons();
    } catch (error) { status(microphoneError(error)); }
    finally { busy = false; }
    return;
  }
  mic.enabled = !mic.enabled;
  refreshButtons();
  sendMediaMap();
});

cameraButton.addEventListener('click', async () => {
  if (busy || !roomHash) return;
  if (cameraStream) {
    stopCamera();
    return;
  }
  busy = true;
  cameraButton.disabled = true;
  const version = sessionVersion;
  try {
    const captured = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: false
    });
    if (version !== sessionVersion) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }
    cameraStream = captured;
    captured.getVideoTracks()[0].contentHint = 'motion';
    if (peer) cameraSender = peer.addTrack(captured.getVideoTracks()[0], localAvStream);
    configureVideoSenders();
    sendMediaMap();
    refreshButtons();
    updateVideos();
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
  localCameraIsMain = false;
  sendMediaMap();
  captured.getTracks().forEach((track) => track.stop());
  refreshButtons();
  updateVideos();
  status('Webcam désactivée.');
}

shareButton.addEventListener('click', async () => {
  if (busy || !roomHash) return;
  if (screenStream) {
    stopScreen();
    return;
  }
  await openPicker();
});

async function openPicker(extended = false, preserve = false) {
  busy = true;
  pickerStatus.textContent = '';
  $('#share-without-audio').hidden = true;
  const version = sessionVersion;
  const request = ++pickerGeneration;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    const found = await window.desktop.listSources(extended);
    if (version !== sessionVersion || request !== pickerGeneration) return;
    allSources = found;
    extendedSources = extended;
    if (!allSources.length) throw new Error('Aucune fenêtre ou écran disponible.');
    if (!preserve) activeTab = allSources.some((source) => source.kind === 'window') ? 'window' : 'screen';
    if (!preserve || !allSources.some((source) => source.id === selectedSourceId)) selectedSourceId = null;
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
    const image = document.createElement(source.thumbnail ? 'img' : 'span');
    if (source.thumbnail) { image.src = source.thumbnail; image.alt = ''; }
    else { image.className = 'source-placeholder'; image.textContent = 'Fenêtre · aperçu indisponible'; }
    const label = document.createElement('span');
    label.textContent = source.name + (source.minimized ? ' · réduite, sera restaurée' : '');
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
$('#refresh-sources').addEventListener('click', () => { if (!busy) openPicker(extendedSources, true); });
$('#extended-sources').hidden = window.desktop.platform !== 'win32';
$('#extended-sources').addEventListener('click', () => { if (!busy) openPicker(true, true); });
$('#system-audio').disabled = window.desktop.platform !== 'win32';
$('#system-audio').checked = window.desktop.platform === 'win32';

function closePicker() {
  if (busy || picker.hidden) return;
  picker.hidden = true;
  selectedSourceId = null;
  shareButton.focus();
  scheduleHide();
}

async function startScreenShare() {
  if (busy || !selectedSourceId) return;
  busy = true;
  startShareButton.disabled = true;
  pickerStatus.textContent = 'Activation du partage…';
  const version = sessionVersion;
  const captureAudio = window.desktop.platform === 'win32' && $('#system-audio').checked;
  $('#share-without-audio').hidden = true;
  let captured;
  try {
    const height = Number($('input[name="resolution"]:checked').value);
    const fps = Number($('input[name="fps"]:checked').value);
    const width = height === 1080 ? 1920 : 1280;
    await window.desktop.selectSource(selectedSourceId, captureAudio);
    if (version !== sessionVersion) return;
    captured = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: width, max: width }, height: { ideal: height, max: height }, frameRate: { ideal: fps, max: fps } },
      audio: captureAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: 2, restrictOwnAudio: true } : false
    });
    if (version !== sessionVersion) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }
    const video = captured.getVideoTracks()[0];
    if (!video) throw new Error('La source sélectionnée ne contient pas de vidéo.');
    video.contentHint = 'motion';
    screenSettings = { height, fps, bitrate: Number($('#share-bitrate').value) };
    profile.quality = { ...screenSettings };
    saveProfile();
    updateBitrateLabels();
    screenStream = captured;
    video.addEventListener('ended', () => {
      if (screenStream === captured) stopScreen('Le partage a été arrêté par le système.');
    });
    audioWarning = captureAudio && !captured.getAudioTracks().length
      ? 'Le son du partage est indisponible. Arrêtez le partage et réessayez avec une sortie Windows active.' : '';
    if (peer) {
      screenSenders = captured.getTracks().map((track) => peer.addTrack(track, captured));
      configureVideoSenders();
    }
    sendMediaMap();
    picker.hidden = true;
    selectedSourceId = null;
    pickerStatus.textContent = '';
    refreshButtons();
    updateVideos();
    status('Partage actif.');
    revealControls();
  } catch (error) {
    captured?.getTracks().forEach((track) => track.stop());
    if (version !== sessionVersion) return;
    const audioFailed = captureAudio && /audio|loopback/i.test(error?.message || '');
    pickerStatus.textContent = audioFailed
      ? 'Windows n’a pas pu capturer le son du partage. Vérifiez qu’une sortie audio est active (casque ou haut-parleurs), puis réessayez. Si besoin, fermez les applications audio ou désactivez leur mode exclusif. Vous pouvez aussi tester le partage sans son.'
      : error?.name === 'NotReadableError'
        ? 'Windows n’a pas pu capturer cette fenêtre. Restaurez-la ou partagez l’écran entier où elle s’affiche.'
        : errorText(error);
    $('#share-without-audio').hidden = !audioFailed;
  } finally {
    busy = false;
    startShareButton.disabled = !selectedSourceId;
  }
}
startShareButton.addEventListener('click', startScreenShare);
$('#share-without-audio').addEventListener('click', () => {
  if (busy) return;
  $('#system-audio').checked = false;
  startScreenShare();
});

const senderUpdates = new WeakMap();
function configureSender(sender, screen) {
  if (!sender?.track) return;
  if (senderUpdates.has(sender)) { senderUpdates.get(sender).dirty = true; return; }
  const state = { dirty: true };
  senderUpdates.set(sender, state);
  (async () => {
    try {
      while (state.dirty && sender.track) { state.dirty = false; await applySenderQuality(sender, screen); }
    } finally { senderUpdates.delete(sender); }
  })();
}
function configureVideoSenders() {
  configureSender(screenSenders.find((sender) => sender.track?.kind === 'video'), true);
  configureSender(cameraSender, false);
}
async function applySenderQuality(sender, screen) {
  try {
    const params = sender.getParameters();
    // Chromium may expose no encodings until SDP is negotiated; retry at stable signaling.
    if (!params.encodings?.length) return;
    params.encodings[0].maxBitrate = screen ? screenBitrate(screenSettings) : 2_500_000;
    params.encodings[0].maxFramerate = screen ? screenSettings.fps : 30;
    params.encodings[0].priority = 'medium';
    params.degradationPreference = 'maintain-framerate';
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
  localCameraIsMain = false;
  audioWarning = '';
  sendMediaMap();
  captured.getTracks().forEach((track) => track.stop());
  refreshButtons();
  updateVideos();
  status(message);
}

fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement === videoArea) await document.exitFullscreen();
    else await videoArea.requestFullscreen();
  }
  catch (error) { status('Plein écran : ' + errorText(error)); }
});
document.addEventListener('fullscreenchange', () => {
  const enabled = document.fullscreenElement === videoArea;
  setButton(fullscreenButton, enabled, 'Quitter le plein écran vidéo', 'Afficher la vidéo en plein écran');
  fitPip(pip);
  fitPip(localPip);
  revealControls();
});

function activatePip() {
  if (viewMode === 'local') viewMode = 'remote';
  else cameraIsMain = !cameraIsMain;
  updateVideos();
}

function pipMaxWidth() {
  return Math.min(stage.clientWidth / 2, stage.clientHeight / 2 * 16 / 9) / 1.04;
}

function fitPip(element) {
  if (element.hidden) return;
  const width = Math.min(element.offsetWidth, pipMaxWidth());
  if (width < element.offsetWidth) element.style.width = width + 'px';
  const left = Math.max(0, Math.min(element.offsetLeft, stage.clientWidth - width));
  const top = Math.max(0, Math.min(element.offsetTop, stage.clientHeight - width * 9 / 16));
  element.style.right = 'auto';
  element.style.bottom = 'auto';
  element.style.left = left + 'px';
  element.style.top = top + 'px';
}

window.addEventListener('resize', () => {
  fitPip(pip);
  fitPip(localPip);
});

function setupPip(element, handle, activate) {
  let drag = null;
  let resizing = null;
  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const box = element.getBoundingClientRect();
    drag = { id: event.pointerId, offsetX: event.clientX - box.left,
      offsetY: event.clientY - box.top, startX: event.clientX, startY: event.clientY, moved: false };
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5 && !drag.moved) return;
    drag.moved = true;
    const bounds = stage.getBoundingClientRect();
    const left = Math.max(0, Math.min(bounds.width - element.offsetWidth, event.clientX - bounds.left - drag.offsetX));
    const top = Math.max(0, Math.min(bounds.height - element.offsetHeight, event.clientY - bounds.top - drag.offsetY));
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    element.style.left = left + 'px';
    element.style.top = top + 'px';
  });
  element.addEventListener('pointerup', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    if (!drag.moved) activate();
    drag = null;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  });
  element.addEventListener('pointercancel', () => { drag = null; });
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const left = element.offsetLeft;
    const top = element.offsetTop;
    const width = element.offsetWidth;
    element.classList.add('is-resizing');
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    element.style.left = left + 'px';
    element.style.top = top + 'px';
    element.style.width = width + 'px';
    resizing = { id: event.pointerId, startX: event.clientX, width, left, top };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!resizing || resizing.id !== event.pointerId) return;
    event.stopPropagation();
    const max = pipMaxWidth();
    const width = Math.max(Math.min(160, max), Math.min(max, resizing.width + event.clientX - resizing.startX));
    element.style.width = width + 'px';
    element.style.left = Math.max(0, Math.min(resizing.left, stage.clientWidth - width)) + 'px';
    element.style.top = Math.max(0, Math.min(resizing.top, stage.clientHeight - width * 9 / 16)) + 'px';
  });
  const finishResize = (event) => {
    if (!resizing || resizing.id !== event.pointerId) return;
    event.stopPropagation();
    resizing = null;
    element.classList.remove('is-resizing');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };
  handle.addEventListener('pointerup', finishResize);
  handle.addEventListener('pointercancel', finishResize);
}

setupPip(pip, pipResize, activatePip);
setupPip(localPip, localPipResize, () => {
  localCameraIsMain = !localCameraIsMain;
  updateVideos();
});

function leave(message = '') {
  if (document.fullscreenElement === videoArea) {
    document.exitFullscreen().catch((error) => console.warn('Sortie du plein écran :', error));
  }
  sessionVersion += 1;
  pickerGeneration++;
  chat.reset();
  audioSettings.stop();
  audioSettings.dialog.close();
  const previousSocket = socket;
  socket = null;
  previousSocket?.disconnect();
  closePeer();
  for (const stream of [micStream, cameraStream, screenStream]) {
    stream?.getTracks().forEach((track) => track.stop());
  }
  micStream = null;
  localAvStream = null;
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
