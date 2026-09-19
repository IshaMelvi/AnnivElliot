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
      selectSource: async () => {},
      toggleFullscreen: async () => false,
      onFullscreenChange: () => () => {}
    };
    const keepAlive = [];
    function audioTrack() {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      keepAlive.push(context, oscillator);
      return destination.stream.getAudioTracks()[0];
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
      const stream = constraints.video ? videoStream(30) : new MediaStream();
      if (constraints.audio) stream.addTrack(audioTrack());
      return stream;
    };
    navigator.mediaDevices.getDisplayMedia = async (constraints) => {
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
  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health');
      if (response.ok) { healthy = true; break; }
    } catch {}
    await delay(100);
  }
  if (!healthy) throw new Error('Serveur local indisponible');

  for (let i = 0; i < 2; i++) {
    const window = new BrowserWindow({
      show: false, width: 1200, height: 750,
      webPreferences: { partition: 'test-user-' + port + '-' + i,
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    windows.push(window);
    await window.loadFile(path.join(fixture, 'index.html'));
  }
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
    document.querySelector('#tab-screen').click();
    document.querySelector('#sources .source').click();
    document.querySelector('input[name="resolution"][value="1080"]').checked = true;
    document.querySelector('input[name="fps"][value="60"]').checked = true;
    document.querySelector('#start-share').click();
  `);
  await waitFor(windows[1], "!document.querySelector('#pip').hidden");
  const screenAudio = await windows[1].webContents.executeJavaScript(
    "Boolean(document.querySelector('#remote-system').srcObject?.getAudioTracks().length)");
  if (!screenAudio) throw new Error('L’audio système distant a disparu lors du changement de vue');
  const mixedVolume = await windows[1].webContents.executeJavaScript(`
    Math.abs(document.querySelector('#remote-system').volume - 0.1) < 0.001 &&
    Math.abs(document.querySelector('#remote-mic').volume - 0.4) < 0.001
  `);
  if (!mixedVolume) throw new Error('Le curseur vidéo ne doit modifier que l’audio du partage');
  record('écran reçu avec webcam en PiP', true);

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

  await windows[0].webContents.executeJavaScript("document.querySelector('#camera').click()");
  await waitFor(windows[1], "!document.querySelector('#main-video').srcObject");
  await windows[0].webContents.executeJavaScript("document.querySelector('#camera').click()");
  await waitFor(windows[1], "Boolean(document.querySelector('#main-video').srcObject?.getVideoTracks().length)");
  record('webcam arrêtée puis réactivée', true);

  await windows[1].webContents.executeJavaScript("document.querySelector('#person-mute').click()");
  await windows[0].webContents.executeJavaScript("document.querySelector('#leave').click()");
  await waitFor(windows[1], "document.querySelector('#remote-person').hidden");
  record('personne retirée de la liste à la déconnexion', true);

  await windows[1].webContents.executeJavaScript("document.querySelector('#leave').click()");
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
    "Math.abs(document.querySelector('#remote-mic').volume - 0.4) < 0.001");
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
