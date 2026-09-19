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
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    windows.push(window);
    await window.loadFile(path.join(fixture, 'index.html'));
  }
  for (const window of windows) {
    await window.webContents.executeJavaScript(`
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

  await Promise.all(windows.map((window) =>
    window.webContents.executeJavaScript("document.querySelector('#camera').click()")));
  await Promise.all(windows.map((window) =>
    waitFor(window, "Boolean(document.querySelector('#main-video').srcObject?.getVideoTracks().length)")));
  record('webcams activées simultanément', true);

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
  record('écran reçu avec webcam en PiP', true);

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
