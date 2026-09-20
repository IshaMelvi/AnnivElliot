const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const testRoot = path.resolve(__dirname, '..');
const resultFile = path.join(testRoot, '.tmp-integration-result.json');
let server;
let fixture;
let windows = [];
const results = [];
let failed = false;

function record(label, value) {
  results.push({ label, value });
  fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

async function waitFor(window, expression, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await window.webContents.executeJavaScript(expression);
    if (value) return value;
    await delay(250);
  }
  throw new Error('Délai dépassé : ' + expression);
}

function prepareFixture(port) {
  fixture = fs.mkdtempSync(path.join(testRoot, '.tmp-webrtc-'));
  const renderer = path.join(testRoot, 'renderer');
  let html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  html = html.replace('connect-src https: wss: http://localhost:3000 ws://localhost:3000;', 'connect-src *;');
  html = html.replace('<script src="bundle.js" defer></script>',
    '<script src="stub.js"></script><script src="bundle-test.js" defer></script>');
  fs.writeFileSync(path.join(fixture, 'index.html'), html);
  fs.copyFileSync(path.join(renderer, 'style.css'), path.join(fixture, 'style.css'));
  for (const name of ['voice-gate-worklet.js', 'voice-gate.mjs']) {
    fs.copyFileSync(path.join(renderer, name), path.join(fixture, name));
  }
  const bundle = fs.readFileSync(path.join(renderer, 'bundle.js'), 'utf8');
  fs.writeFileSync(path.join(fixture, 'bundle-test.js'),
    bundle.replace('https://annivelliot-signaling.onrender.com', 'http://127.0.0.1:' + port));
  fs.writeFileSync(path.join(fixture, 'stub.js'), `
    window.desktop = {
      platform: 'win32',
      listSources: async () => [
        { id: 'window:test', kind: 'window', name: 'Fenêtre de test', thumbnail: '' },
        { id: 'screen:test', kind: 'screen', name: 'Écran de test', thumbnail: '' }
      ],
      selectSource: async (id, audio) => { window.lastSelection = { id, audio }; }
    };
    const keepAlive = [];
    window.testPeers = [];
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(config) { super(config); window.testPeers.push(this); }
    };
    window.testAudioInputs = [];
    window.testMicrophoneTracks = [];
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'audioinput', deviceId: 'default', label: 'Micro Windows' },
      { kind: 'audioinput', deviceId: 'usb-mic', label: 'Micro USB' },
      { kind: 'audioinput', deviceId: 'broken-mic', label: 'Micro indisponible' },
      { kind: 'audiooutput', deviceId: 'headphones', label: 'Casque' },
      { kind: 'audiooutput', deviceId: 'broken-output', label: 'Sortie indisponible' }
    ];
    HTMLMediaElement.prototype.setSinkId = async function(id) {
      if (id === 'broken-output' && this.id === 'remote-system') throw new DOMException('Absent', 'NotFoundError');
      Object.defineProperty(this, 'sinkId', { configurable: true, value: id });
    };
    function audioTrack() {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      keepAlive.push(context, oscillator);
      const track = destination.stream.getAudioTracks()[0];
      track.testSetLevel = (value) => { gain.gain.value = value; };
      return track;
    }
    function videoStream(fps) {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext('2d');
      let tick = 0;
      const timer = setInterval(() => {
        context.fillStyle = tick++ % 2 ? '#e780b2' : '#5056ab';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }, 100);
      keepAlive.push(canvas, timer);
      return canvas.captureStream(fps);
    }
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints.audio) {
        window.testAudioInputs.push(constraints.audio);
        if (constraints.audio.deviceId?.exact === 'broken-mic') throw new DOMException('Could not start audio source', 'NotReadableError');
      }
      const stream = constraints.video ? videoStream(30) : new MediaStream();
      if (constraints.audio) {
        const track = audioTrack();
        window.testMicrophoneTracks.push(track);
        stream.addTrack(track);
      }
      return stream;
    };
    navigator.mediaDevices.getDisplayMedia = async (constraints) => {
      window.lastDisplayConstraints = constraints;
      if (window.failNextSystemAudio && constraints.audio) {
        window.failNextSystemAudio = false;
        throw new DOMException('Could not start audio source', 'NotReadableError');
      }
      const stream = videoStream(constraints.video.frameRate.ideal);
      if (constraints.audio) stream.addTrack(audioTrack());
      return stream;
    };
  `);
}

async function main() {
  const port = await freePort();
  prepareFixture(port);
  server = spawn('node', ['server.js'], {
    cwd: path.resolve(testRoot, '..', 'signaling'),
    env: { ...process.env, PORT: String(port) },
    windowsHide: true
  });
  let serverError = '';
  server.stderr.on('data', (chunk) => { serverError += chunk; });
  server.on('error', (error) => { serverError += error.message; });
  let healthy = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health');
      if (response.ok) { healthy = true; break; }
    } catch {}
    await delay(100);
  }
  if (!healthy) throw new Error('Serveur local indisponible : ' + serverError);

  for (let i = 0; i < 2; i++) {
    const window = new BrowserWindow({
      show: false, width: 1200, height: 750,
      webPreferences: { partition: 'test-user-' + port + '-' + i,
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    windows.push(window);
    await window.loadFile(path.join(fixture, 'index.html'));
    await waitFor(window, "Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0)");
  }
  record('logos CherubLink chargés dans les deux interfaces', true);
  for (const [index, window] of windows.entries()) {
    await window.webContents.executeJavaScript(`
      document.querySelector('#display-name').value = '${index === 0 ? 'Alice' : 'Bob'}';
      document.querySelector('#room').value = 'salon-integration-secret';
      document.querySelector('#join-form').requestSubmit();
    `);
  }
  await Promise.all(windows.map((window) =>
    waitFor(window, "document.querySelector('#call-status').textContent.includes('Connectés')")));
  for (const window of windows) {
    const privateByDefault = await window.webContents.executeJavaScript(`
      document.querySelector('#camera').classList.contains('is-off') &&
      !document.querySelector('#main-video').srcObject &&
      Boolean(document.querySelector('#remote-mic').srcObject?.getAudioTracks().length)
    `);
    if (!privateByDefault) throw new Error('La webcam doit être coupée et le micro actif au départ');
  }
  record('micro seulement et connexion', true);

  await windows[0].webContents.executeJavaScript("document.querySelector('#call .settings-open').click()");
  await waitFor(windows[0], "document.querySelector('#audio-input').options.length === 3");
  const micIdBefore = await windows[1].webContents.executeJavaScript("document.querySelector('#remote-mic').srcObject.id");
  await windows[0].webContents.executeJavaScript(`
    document.querySelector('#audio-input').value = 'usb-mic';
    document.querySelector('#audio-input').dispatchEvent(new Event('change'));
  `);
  await waitFor(windows[0], "JSON.parse(localStorage.getItem('annivelliot.profile.v1')).audio.inputDeviceId === 'usb-mic'");
  const switched = await windows[0].webContents.executeJavaScript("window.testMicrophoneTracks[0].readyState === 'ended' && window.testMicrophoneTracks[1].readyState === 'live'");
  if (!switched) throw new Error('L’ancien microphone doit être libéré après le changement');
  if (await windows[1].webContents.executeJavaScript("document.querySelector('#remote-mic').srcObject.id") !== micIdBefore) throw new Error('Le changement de micro a recréé le flux distant');
  await windows[0].webContents.executeJavaScript(`
    document.querySelector('#audio-input').value = 'broken-mic';
    document.querySelector('#audio-input').dispatchEvent(new Event('change'));
  `);
  await waitFor(windows[0], "document.querySelector('#settings-status').textContent.includes('Impossible d’ouvrir')");
  const keptMic = await windows[0].webContents.executeJavaScript("document.querySelector('#audio-input').value === 'usb-mic' && window.testMicrophoneTracks[1].readyState === 'live'");
  if (!keptMic) throw new Error('Une entrée défectueuse a interrompu le microphone précédent');
  await windows[0].webContents.executeJavaScript(`
    document.querySelector('#sensitivity-mode').value = 'manual';
    document.querySelector('#sensitivity-mode').dispatchEvent(new Event('change'));
    document.querySelector('#mic-threshold').value = '-38';
    document.querySelector('#mic-threshold').dispatchEvent(new Event('input'));
  `);
  await waitFor(windows[0], "document.querySelector('#mic-level').value > -50 && document.querySelector('#mic-level').classList.contains('voice-active')");
  await windows[0].webContents.executeJavaScript("window.testMicrophoneTracks[1].testSetLevel(0)");
  await waitFor(windows[0], "document.querySelector('#mic-level').value < -70 && !document.querySelector('#mic-level').classList.contains('voice-active')");
  await windows[0].webContents.executeJavaScript("window.testMicrophoneTracks[1].testSetLevel(1)");
  await waitFor(windows[0], "document.querySelector('#mic-level').classList.contains('voice-active')");
  await windows[0].webContents.executeJavaScript("document.querySelector('#settings-close').click()");
  record('changement de micro sans renégociation, erreur réversible et détection réelle AudioWorklet', true);

  await windows[0].webContents.executeJavaScript(`
    document.activeElement?.blur();
    document.querySelector('#call').dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
  `);
  await delay(2600);
  const hudStillVisible = await windows[0].webContents.executeJavaScript(
    "document.querySelector('#call').classList.contains('controls-visible')");
  if (!hudStillVisible) throw new Error('Le HUD disparaît avant trois secondes');
  await delay(850);
  const hudHidden = await windows[0].webContents.executeJavaScript(
    "!document.querySelector('#call').classList.contains('controls-visible')");
  if (!hudHidden) throw new Error('Le HUD ne se masque pas après trois secondes');
  await windows[0].webContents.executeJavaScript(`
    document.querySelector('#call').dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
  `);
  const hudRevealed = await windows[0].webContents.executeJavaScript(
    "document.querySelector('#call').classList.contains('controls-visible')");
  if (!hudRevealed) throw new Error('Le mouvement de souris ne réaffiche pas le HUD');
  record('HUD masqué après trois secondes et réaffiché au mouvement', true);

  const differentProfiles = await Promise.all(windows.map((window) =>
    window.webContents.executeJavaScript("JSON.parse(localStorage.getItem('annivelliot.profile.v1')).id")));
  if (differentProfiles[0] === differentProfiles[1]) throw new Error('Les profils locaux doivent être distincts');
  const logoColors = await windows[1].webContents.executeJavaScript(`
    [getComputedStyle(document.querySelector('#split-local .empty-logo')).color,
      getComputedStyle(document.querySelector('#split-remote .empty-logo')).color]
  `);
  if (logoColors[0] === logoColors[1]) throw new Error('Les vues vides des deux personnes ont la même couleur');
  record('profils distincts et logos colorés', true);

  await waitFor(windows[1], "document.querySelector('#remote-name').textContent === 'Alice'");
  const roster = await windows[0].webContents.executeJavaScript(`
    document.querySelector('#self-name').textContent === 'Alice' &&
    document.querySelector('#remote-name').textContent === 'Bob' &&
    !document.querySelector('#remote-person').hidden
  `);
  if (!roster) throw new Error('Les personnes du salon ne sont pas affichées avec leur prénom');
  await windows[1].webContents.executeJavaScript(`
    document.querySelector('#remote-person').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  `);
  const menuOpened = await windows[1].webContents.executeJavaScript(
    "!document.querySelector('#person-menu').hidden && document.querySelector('#person-menu-name').textContent === 'Alice'");
  if (!menuOpened) throw new Error('Le clic droit n’ouvre pas le réglage de la personne');
  await windows[1].webContents.executeJavaScript(`
    document.querySelector('#person-volume').value = '40';
    document.querySelector('#person-volume').dispatchEvent(new Event('input', { bubbles: true }));
  `);
  const personVolumeWorks = await windows[1].webContents.executeJavaScript(
    "Math.abs(document.querySelector('#remote-mic').volume - 0.4) < 0.001");
  if (!personVolumeWorks) throw new Error('Le volume du micro distant ne suit pas le curseur de la personne');
  await windows[1].webContents.executeJavaScript("document.querySelector('#person-mute').click()");
  const personMuted = await windows[1].webContents.executeJavaScript(`
    document.querySelector('#remote-mic').volume === 0 &&
    !document.querySelector('#remote-muted-mark').hidden
  `);
  if (!personMuted) throw new Error('Rendre muet ne coupe pas la personne');
  await windows[1].webContents.executeJavaScript("document.querySelector('#person-mute').click()");
  await windows[1].webContents.executeJavaScript(`
    document.querySelector('#video-volume').value = '25';
    document.querySelector('#video-volume').dispatchEvent(new Event('input', { bubbles: true }));
  `);
  record('personnes du salon et réglages audio', true);

  await windows[1].webContents.executeJavaScript("document.querySelector('#empty-stage').click(); document.querySelector('#split-local').click()");
  const emptyLocal = await windows[1].webContents.executeJavaScript(`
    document.querySelector('#stage').dataset.view === 'local' &&
    !document.querySelector('#empty-stage').hidden
  `);
  if (!emptyLocal) throw new Error('La vue locale vide ne s’affiche pas');
  await windows[1].webContents.executeJavaScript("document.querySelector('#empty-stage').click(); document.querySelector('#split-remote').click()");
  const recoveredView = await windows[1].webContents.executeJavaScript(`
    document.querySelector('#stage').dataset.view === 'remote' &&
    document.querySelector('#split-view').hidden
  `);
  if (!recoveredView) throw new Error('Impossible de revenir au partage depuis la vue locale vide');
  record('retour au split depuis une vue sans vidéo locale', true);

  await Promise.all(windows.map((window) =>
    window.webContents.executeJavaScript("document.querySelector('#camera').click()")));
  await Promise.all(windows.map((window) =>
    waitFor(window, "Boolean(document.querySelector('#main-video').srcObject?.getVideoTracks().length)")));
  record('webcams activées simultanément', true);

  await windows[1].webContents.executeJavaScript("document.querySelector('#fullscreen').click()", true);
  await waitFor(windows[1], "document.fullscreenElement?.id === 'video-area'");
  await waitFor(windows[1], "document.querySelector('#fullscreen').getAttribute('aria-pressed') === 'true'");
  const videoFullscreen = await windows[1].webContents.executeJavaScript(`
    (() => {
      const area = document.fullscreenElement;
      const bounds = area.getBoundingClientRect();
      return area.contains(document.querySelector('#main-video')) &&
        area.contains(document.querySelector('#pip')) &&
        area.contains(document.querySelector('#toolbar')) &&
        !area.contains(document.querySelector('.sidebar')) &&
        Math.abs(bounds.width - innerWidth) < 2 &&
        Math.abs(bounds.height - innerHeight) < 2;
    })()
  `);
  if (!videoFullscreen) throw new Error('Le plein écran doit cibler les vidéos et leurs commandes, sans la colonne des participants');
  await windows[1].webContents.executeJavaScript("document.exitFullscreen()");
  await waitFor(windows[1], "document.querySelector('#fullscreen').getAttribute('aria-pressed') === 'false'");
  await windows[1].webContents.executeJavaScript("document.querySelector('#fullscreen').click()", true);
  await waitFor(windows[1], "document.fullscreenElement?.id === 'video-area'");
  await windows[1].webContents.executeJavaScript("document.querySelector('#fullscreen').click()", true);
  await waitFor(windows[1], "!document.fullscreenElement");
  record('plein écran vidéo avec PiP, HUD et retour à la vue normale', true);

  await windows[1].webContents.executeJavaScript("document.querySelector('#main-video').click()");
  const splitReady = await windows[1].webContents.executeJavaScript(`
    !document.querySelector('#split-view').hidden &&
    Boolean(document.querySelector('#split-remote-video').srcObject?.getVideoTracks().length) &&
    Boolean(document.querySelector('#split-local-video').srcObject?.getVideoTracks().length)
  `);
  if (!splitReady) throw new Error('Les deux webcams ne sont pas visibles côte à côte');
  const localStreamId = await windows[1].webContents.executeJavaScript(
    "document.querySelector('#split-local-video').srcObject.id");
  await windows[1].webContents.executeJavaScript("document.querySelector('#split-local').click()");
  const localMain = await windows[1].webContents.executeJavaScript(`
    document.querySelector('#main-video').srcObject?.id === '${localStreamId}' &&
    !document.querySelector('#pip').hidden
  `);
  if (!localMain) throw new Error('Le flux local ne passe pas en vue principale');
  await windows[1].webContents.executeJavaScript("document.querySelector('#main-video').click(); document.querySelector('#split-remote').click()");
  for (let i = 0; i < 3; i++) {
    const cycle = await windows[1].webContents.executeJavaScript(`
      (() => {
        document.querySelector('#main-video').click();
        const opened = document.querySelector('#stage').dataset.view === 'split';
        document.querySelector('#split-remote').click();
        return opened && document.querySelector('#stage').dataset.view === 'remote';
      })()
    `);
    if (!cycle) throw new Error('La vue se bloque après plusieurs changements');
  }
  record('vue côte à côte et sélection du flux principal', true);

  await windows[0].webContents.executeJavaScript("document.querySelector('#mute').click()");
  await waitFor(windows[1], "!document.querySelector('#main-mute').hidden");
  const mutedStyle = await windows[0].webContents.executeJavaScript(`
    document.querySelector('#mute').classList.contains('is-off') &&
    !document.querySelector('#mute').classList.contains('is-active') &&
    document.querySelector('#camera').classList.contains('is-active') &&
    document.querySelector('#mute').getAttribute('aria-pressed') === 'false'
  `);
  if (!mutedStyle) throw new Error('Le bouton micro désactivé ne suit pas la logique webcam');
  await windows[1].webContents.executeJavaScript("document.querySelector('#main-video').click()");
  const splitMuteVisible = await windows[1].webContents.executeJavaScript(
    "!document.querySelector('#split-mute').hidden");
  if (!splitMuteVisible) throw new Error('Le micro coupé n’est pas indiqué dans la vue côte à côte');
  await windows[1].webContents.executeJavaScript("document.querySelector('#split-local').click()");
  const pipMuteVisible = await windows[1].webContents.executeJavaScript(
    "!document.querySelector('#pip-mute').hidden");
  if (!pipMuteVisible) throw new Error('Le micro coupé n’est pas indiqué dans le PiP distant');
  await windows[1].webContents.executeJavaScript(`
    document.querySelector('#pip').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  `);
  await windows[0].webContents.executeJavaScript("document.querySelector('#mute').click()");
  await waitFor(windows[1], "document.querySelector('#main-mute').hidden");
  record('état du micro transmis et boutons cohérents', true);

  await windows[0].webContents.executeJavaScript("document.querySelector('#share').click()");
  await waitFor(windows[0], "!document.querySelector('#picker').hidden");
  await windows[0].webContents.executeJavaScript(`
    window.failNextSystemAudio = true;
    document.querySelector('#tab-screen').click();
    document.querySelector('#sources .source').click();
    document.querySelector('input[name="resolution"][value="1080"]').checked = true;
    document.querySelector('input[name="fps"][value="60"]').checked = true;
    document.querySelector('#start-share').click();
  `);
  await waitFor(windows[0], "!document.querySelector('#share-without-audio').hidden");
  const retryAvailable = await windows[0].webContents.executeJavaScript("!document.querySelector('#start-share').disabled && document.querySelector('#picker-status').textContent.includes('son du partage')");
  if (!retryAvailable) throw new Error('Une erreur audio empêche de réessayer la même source');
  await windows[0].webContents.executeJavaScript("document.querySelector('#start-share').click()");
  await waitFor(windows[1], "!document.querySelector('#pip').hidden");
  await waitFor(windows[0], `window.testPeers.at(-1).getSenders().some(sender => sender.track?.kind === 'video' && sender.getParameters().encodings?.[0]?.maxBitrate === 12000000 && sender.getParameters().degradationPreference === 'maintain-framerate')`);
  const captureLimits = await windows[0].webContents.executeJavaScript(`
    window.lastDisplayConstraints.video.width.max === 1920 &&
    window.lastDisplayConstraints.video.height.max === 1080 &&
    window.lastDisplayConstraints.video.frameRate.max === 60 &&
    window.lastDisplayConstraints.audio.noiseSuppression === false &&
    window.lastDisplayConstraints.audio.restrictOwnAudio === true
  `);
  if (!captureLimits) throw new Error('La capture ne respecte pas les plafonds choisis ou traite le son du film comme de la voix');
  record('reprise après erreur audio et qualité appliquée au véritable émetteur vidéo', true);
  const screenAudio = await windows[1].webContents.executeJavaScript(
    "Boolean(document.querySelector('#remote-system').srcObject?.getAudioTracks().length)");
  if (!screenAudio) throw new Error('L’audio système distant a disparu lors du changement de vue');
  const mixedVolume = await windows[1].webContents.executeJavaScript(`
    Math.abs(document.querySelector('#remote-system').volume - 0.1) < 0.001 &&
    Math.abs(document.querySelector('#remote-mic').volume - 0.4) < 0.001
  `);
  if (!mixedVolume) throw new Error('Le curseur vidéo ne doit modifier que l’audio du partage');
  record('écran reçu avec webcam en PiP', true);

  await windows[1].webContents.executeJavaScript(`
    document.querySelector('#call .settings-open').click();
    document.querySelector('#master-volume').value = '50';
    document.querySelector('#master-volume').dispatchEvent(new Event('input'));
  `);
  await waitFor(windows[1], "document.querySelector('#audio-output').options.length === 3");
  const masterIndependent = await windows[1].webContents.executeJavaScript(`
    Math.abs(document.querySelector('#remote-mic').volume - 0.2) < .001 &&
    Math.abs(document.querySelector('#remote-system').volume - 0.05) < .001 &&
    document.querySelector('#person-volume').value === '40' && document.querySelector('#video-volume').value === '25'
  `);
  if (!masterIndependent) throw new Error('Le volume général écrase les réglages individuels');
  await windows[1].webContents.executeJavaScript(`
    document.querySelector('#audio-output').value = 'headphones';
    document.querySelector('#audio-output').dispatchEvent(new Event('change'));
  `);
  await waitFor(windows[1], "document.querySelector('#remote-mic').sinkId === 'headphones' && document.querySelector('#remote-system').sinkId === 'headphones'");
  await windows[1].webContents.executeJavaScript(`
    document.querySelector('#audio-output').value = 'broken-output';
    document.querySelector('#audio-output').dispatchEvent(new Event('change'));
  `);
  await waitFor(windows[1], "document.querySelector('#settings-status').textContent.includes('indisponible')");
  const restoredOutput = await windows[1].webContents.executeJavaScript("document.querySelector('#remote-mic').sinkId === 'headphones' && document.querySelector('#remote-system').sinkId === 'headphones' && document.querySelector('#audio-output').value === 'headphones'");
  if (!restoredOutput) throw new Error('Le routage ne revient pas au casque après un échec partiel');
  await waitFor(windows[1], "document.querySelector('#stats-receive').textContent.includes('Mbit/s')");
  await windows[1].webContents.executeJavaScript("document.querySelector('#settings-close').click()");
  record('sortie commune, retour après erreur, volume général indépendant et mesures WebRTC', true);

  await windows[0].webContents.executeJavaScript(
    "document.querySelector('#main-video').click(); document.querySelector('#split-local').click()");
  const ownPip = await windows[0].webContents.executeJavaScript(`
    !document.querySelector('#local-pip').hidden &&
    !document.querySelector('#pip').hidden &&
    Boolean(document.querySelector('#local-pip-video').srcObject?.getVideoTracks().length) &&
    document.querySelector('#local-pip-video').srcObject.id !== document.querySelector('#main-video').srcObject.id
  `);
  if (!ownPip) throw new Error('La webcam locale doit rester en PiP sur le partage personnel');
  const ownCameraId = await windows[0].webContents.executeJavaScript(
    "document.querySelector('#local-pip-video').srcObject.id");
  await windows[0].webContents.executeJavaScript(`
    document.querySelector('#local-pip').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  `);
  const ownSwapped = await windows[0].webContents.executeJavaScript(
    "document.querySelector('#main-video').srcObject.id === '" + ownCameraId + "'");
  if (!ownSwapped) throw new Error('Le clic sur le PiP local n’agrandit pas la webcam');
  await windows[0].webContents.executeJavaScript(`
    document.querySelector('#local-pip').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  `);
  record('webcam locale en PiP avec le partage personnel', true);

  const ownScreenId = await windows[0].webContents.executeJavaScript(
    "document.querySelector('#main-video').srcObject.id");
  await windows[0].webContents.executeJavaScript(
    "document.querySelector('#main-video').click(); document.querySelector('#split-remote').click()");
  const detachedPreview = await windows[0].webContents.executeJavaScript(`
    (() => {
      const localIds = new Set(['${ownScreenId}', '${ownCameraId}']);
      const videos = ['#main-video', '#pip-video', '#local-pip-video',
        '#split-remote-video', '#split-local-video'];
      return videos.every((selector) => !localIds.has(document.querySelector(selector).srcObject?.id)) &&
        document.querySelector('#local-pip').hidden &&
        document.querySelector('#share').getAttribute('aria-pressed') === 'true';
    })()
  `);
  const friendStillReceives = await windows[1].webContents.executeJavaScript(
    "document.querySelector('#main-video').srcObject?.id === '" + ownScreenId + "'");
  if (!detachedPreview || !friendStillReceives) {
    throw new Error('L’aperçu local doit être détaché sans interrompre le partage envoyé');
  }
  record('aperçus locaux arrêtés quand la vue distante est principale', true);

  const resized = await windows[1].webContents.executeJavaScript(`
    (() => {
      const pip = document.querySelector('#pip');
      const handle = document.querySelector('#pip-resize');
      const stage = document.querySelector('#stage');
      const original = pip.offsetWidth;
      handle.setPointerCapture = () => {};
      handle.hasPointerCapture = () => false;
      const event = (type, x) => new PointerEvent(type, { bubbles: true, pointerId: 77, button: 0, clientX: x, clientY: 300 });
      handle.dispatchEvent(event('pointerdown', 300));
      handle.dispatchEvent(event('pointermove', 1300));
      handle.dispatchEvent(event('pointerup', 1300));
      return pip.offsetWidth > original && pip.offsetWidth <= stage.clientWidth / 2 &&
        pip.offsetHeight <= stage.clientHeight / 2 &&
        pip.classList.contains('is-resizing') === false;
    })()
  `);
  if (!resized) throw new Error('Le PiP ne se redimensionne pas dans la limite d’un quadrant');
  record('redimensionnement du PiP plafonné à un quadrant', true);

  await windows[0].webContents.executeJavaScript("document.querySelector('#share').click()");
  await waitFor(windows[1], "document.querySelector('#pip').hidden");
  const micContinues = await windows[1].webContents.executeJavaScript(
    "Boolean(document.querySelector('#remote-mic').srcObject?.getAudioTracks().length)");
  if (!micContinues) throw new Error('Le micro a disparu après arrêt du partage');
  record('arrêt du partage et micro conservé', true);

  await windows[0].webContents.executeJavaScript("document.querySelector('#share').click()");
  await waitFor(windows[0], "!document.querySelector('#picker').hidden");
  await windows[0].webContents.executeJavaScript(`
    window.failNextSystemAudio = true;
    document.querySelector('#sources .source').click();
    document.querySelector('#start-share').click();
  `);
  await waitFor(windows[0], "!document.querySelector('#share-without-audio').hidden");
  await windows[0].webContents.executeJavaScript("document.querySelector('#share-without-audio').click()");
  await waitFor(windows[1], "!document.querySelector('#pip').hidden");
  const videoOnly = await windows[0].webContents.executeJavaScript("window.lastSelection.audio === false && window.lastDisplayConstraints.audio === false");
  const noSystemAudio = await windows[1].webContents.executeJavaScript("document.querySelector('#remote-system').srcObject === null && !!document.querySelector('#remote-mic').srcObject");
  if (!videoOnly || !noSystemAudio) throw new Error('Le repli explicite sans son modifie le micro ou demande encore le loopback');
  await windows[0].webContents.executeJavaScript("document.querySelector('#share').click()");
  await waitFor(windows[1], "document.querySelector('#pip').hidden");
  record('repli explicite sans audio système avec microphone conservé', true);

  await windows[0].webContents.executeJavaScript("document.querySelector('#camera').click()");
  await waitFor(windows[1], "!document.querySelector('#main-video').srcObject");
  await windows[0].webContents.executeJavaScript("document.querySelector('#camera').click()");
  await waitFor(windows[1], "Boolean(document.querySelector('#main-video').srcObject?.getVideoTracks().length)");
  record('webcam arrêtée puis réactivée', true);

  await windows[1].webContents.executeJavaScript("document.querySelector('#person-mute').click()");
  await windows[0].webContents.executeJavaScript("document.querySelector('#fullscreen').click()", true);
  await waitFor(windows[0], "document.fullscreenElement?.id === 'video-area'");
  await windows[0].webContents.executeJavaScript("document.querySelector('#leave').click()");
  await waitFor(windows[0], "!document.fullscreenElement && !document.querySelector('#join').hidden");
  record('sortie du plein écran en quittant le salon', true);
  await waitFor(windows[1], "document.querySelector('#remote-person').hidden");
  record('personne retirée de la liste à la déconnexion', true);

  await windows[1].webContents.executeJavaScript("document.querySelector('#leave').click()");
  for (const window of windows) {
    if (!await window.webContents.executeJavaScript("window.testMicrophoneTracks.every(track => track.readyState === 'ended')")) throw new Error('Un micro reste capturé après la sortie');
  }
  for (const window of windows) await window.loadFile(path.join(fixture, 'index.html'));
  const restored = await Promise.all(windows.map((window, index) =>
    window.webContents.executeJavaScript(`
      document.querySelector('#display-name').value === '${index === 0 ? 'Alice' : 'Bob'}' &&
      JSON.parse(localStorage.getItem('annivelliot.profile.v1')).id === '${differentProfiles[index]}'
    `)));
  if (!restored.every(Boolean)) throw new Error('Le profil local ne revient pas après rechargement');
  const qualityRestored = await windows[0].webContents.executeJavaScript(`
    document.querySelector('input[name="resolution"][value="1080"]').checked &&
    document.querySelector('input[name="fps"][value="60"]').checked
  `);
  if (!qualityRestored) throw new Error('La qualité du partage n’est pas mémorisée');
  const audioRestored = await windows[0].webContents.executeJavaScript(`
    (() => { const audio = JSON.parse(localStorage.getItem('annivelliot.profile.v1')).audio;
      return audio.inputDeviceId === 'usb-mic' && audio.sensitivityMode === 'manual' && audio.thresholdDb === -38; })()
  `);
  if (!audioRestored) throw new Error('Le périphérique ou le seuil du micro n’a pas été conservé');
  for (const window of windows) {
    await window.webContents.executeJavaScript(`
      document.querySelector('#room').value = 'salon-integration-secret';
      document.querySelector('#join-form').requestSubmit();
    `);
  }
  await Promise.all(windows.map((window) =>
    waitFor(window, "document.querySelector('#call-status').textContent.includes('Connectés')")));
  const friendRestored = await windows[1].webContents.executeJavaScript(`
    document.querySelector('#person-volume').value === '40' &&
    document.querySelector('#video-volume').value === '25' &&
    document.querySelector('#person-mute').getAttribute('aria-pressed') === 'true' &&
    document.querySelector('#remote-mic').volume === 0
  `);
  if (!friendRestored) throw new Error('Les volumes de cet ami ne reviennent pas à la reconnexion');
  await windows[1].webContents.executeJavaScript("document.querySelector('#person-mute').click()");
  const unmutedVolume = await windows[1].webContents.executeJavaScript(
    "Math.abs(document.querySelector('#remote-mic').volume - 0.2) < 0.001 && document.querySelector('#remote-system').sinkId === 'headphones' && document.querySelector('#master-volume').value === '50'");
  if (!unmutedVolume) throw new Error('Le volume enregistré ne revient pas après réactivation du son');
  record('prénom, qualité et volumes conservés à la reconnexion', true);
}

app.whenReady().then(async () => {
  try {
    await main();
    record('résultat', 'OK');
  } catch (error) {
    failed = true;
    record('erreur', error.stack || String(error));
  } finally {
    for (const window of windows) if (!window.isDestroyed()) window.close();
    if (server) server.kill();
    if (fixture && path.resolve(fixture).startsWith(testRoot + path.sep)) {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
    app.exit(failed ? 1 : 0);
  }
});
