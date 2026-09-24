// Exercise real electron-updater downloads against an isolated local release feed.
// Payloads are inert bytes. No installer is executed and the user's profile is untouched.
const { app, BrowserWindow, ipcMain } = require('electron');
const { NsisUpdater } = require('electron-updater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const { createUpdater } = require('../updater.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const fixture = process.env.CHERUBLINK_UPDATE_TEST_DIR;
if (!fixture || !path.resolve(fixture).startsWith(root + path.sep + '.tmp-updates-')) {
  throw new Error('Run via npm run test:updates to provide an isolated profile.');
}
app.setPath('userData', fixture);
const results = [];
const resultFile = path.join(root, '.tmp-updates-result.json');
const record = (label) => { results.push(label); fs.writeFileSync(resultFile, JSON.stringify(results, null, 2)); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let window, server, failed = false;

app.whenReady().then(async () => {
  try {
    let releaseVersion = '1.4.1';
    let corrupt = false;
    let requests = 0;
    const payload = Buffer.alloc(256 * 1024, 'CherubLink update integrity test');
    const sha512 = crypto.createHash('sha512').update(payload).digest('base64');
    server = http.createServer((req, res) => {
      if (req.url.startsWith('/latest.yml')) {
        res.end(`version: ${releaseVersion}\nfiles:\n  - url: CherubLink-Setup.exe\n    sha512: ${sha512}\n    size: ${payload.length}\npath: CherubLink-Setup.exe\nsha512: ${sha512}\n`);
      } else if (req.url.startsWith('/CherubLink-Setup.exe')) {
        requests++;
        res.setHeader('Content-Length', payload.length);
        res.end(corrupt ? Buffer.alloc(payload.length, 'invalid') : payload);
      } else { res.statusCode = 404; res.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const config = path.join(fixture, 'app-update.yml');
    fs.writeFileSync(config, 'updaterCacheDirName: isolated-cache\n');
    function create(cacheName) {
      const updater = new NsisUpdater(null, {
        version: '1.4.0', name: 'CherubLink-test', isPackaged: true,
        appUpdateConfigPath: config, userDataPath: fixture, baseCachePath: path.join(fixture, cacheName),
        whenReady: async () => {}, quit: () => { throw new Error('Unexpected quit'); },
        relaunch: () => { throw new Error('Unexpected relaunch'); },
        onQuit: () => { throw new Error('Automatic install on quit must remain disabled'); }
      });
      updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
      updater.httpExecutor = new ElectronHttpExecutor();
      updater.disableDifferentialDownload = true;
      updater.setFeedURL({ provider: 'generic', url }); // Test only; production uses packaged GitHub config.
      updater.quitAndInstall = () => { throw new Error('No installer may run in this test'); };
      return { updater, controller: createUpdater({ updater, enabled: true, version: '1.4.0',
        publish: (state) => window?.webContents.send('updates:state', state) }) };
    }
    const { updater, controller } = create('valid');
    controller.check(); await controller.settled();
    assert.equal(controller.snapshot().phase, 'available');
    assert.equal(requests, 0);
    record('real NSIS updater detects a higher version without automatic download');

    window = new BrowserWindow({ show: false, width: 1280, height: 800,
      webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
    for (const action of ['snapshot', 'check', 'download', 'install', 'setSessionActive']) {
      ipcMain.handle('updates:' + action, (event, value) => {
        assert.equal(event.sender, window.webContents);
        assert.equal(event.senderFrame, window.webContents.mainFrame);
        return controller[action](value);
      });
    }
    await window.loadFile(path.join(root, 'renderer', 'index.html'));
    async function waitFor(expression) {
      for (let i = 0; i < 100; i++) {
        if (await window.webContents.executeJavaScript(expression)) return;
        await delay(50);
      }
      throw new Error('UI timeout: ' + expression);
    }
    await waitFor("!document.querySelector('.update-notice').hidden");
    await window.webContents.executeJavaScript("document.querySelector('.update-notice').click()");
    await waitFor("document.querySelector('#settings-dialog').open && document.querySelector('#app-version').textContent === 'Version 1.4.0'");
    fs.writeFileSync(path.join(os.tmpdir(), 'cherublink-update-available.png'), (await window.webContents.capturePage()).toPNG());
    controller.setSessionActive(true);
    await waitFor("document.querySelector('#update-download').disabled");
    await window.webContents.executeJavaScript('window.desktop.updates.download()');
    assert.equal(requests, 0);
    controller.setSessionActive(false);
    await waitFor("!document.querySelector('#update-download').disabled");
    await window.webContents.executeJavaScript("document.querySelector('#update-download').click()");
    await waitFor("!document.querySelector('#update-install').hidden");
    await controller.settled();
    assert.equal(controller.snapshot().phase, 'downloaded');
    assert.deepEqual(fs.readFileSync(updater.installerPath), payload);
    controller.setSessionActive(true);
    await waitFor("document.querySelector('#update-install').disabled");
    await window.webContents.executeJavaScript('window.desktop.updates.install()');
    assert.equal(controller.snapshot().phase, 'downloaded');
    controller.setSessionActive(false);
    window.setSize(760, 520);
    await delay(200);
    fs.writeFileSync(path.join(os.tmpdir(), 'cherublink-update-ready.png'), (await window.webContents.capturePage()).toPNG());
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true);
    record('real download, checksum verification, safe preload IPC, UI and room install guard');

    const cached = create('valid').controller;
    cached.check(); await cached.settled();
    cached.download(); await cached.settled();
    assert.equal(cached.snapshot().phase, 'downloaded');
    assert.equal(requests, 1, 'download after relaunch should reuse the verified cache');
    record('verified downloaded installer survives relaunch without another download');

    corrupt = true;
    const invalid = create('invalid').controller;
    invalid.check(); await invalid.settled();
    invalid.download(); await invalid.settled();
    assert.equal(invalid.snapshot().phase, 'error');
    assert.equal(invalid.install().phase, 'error');
    record('corrupt installer is rejected by real SHA-512 verification');

    for (const version of ['1.4.0', '1.3.0']) {
      releaseVersion = version;
      const current = create('current').controller;
      current.check(); await current.settled();
      assert.equal(current.snapshot().phase, 'current');
    }
    record('equal and older releases are never installed');
    record('OK');
  } catch (error) {
    failed = true; record(error.stack || String(error));
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    if (server) { server.closeAllConnections(); server.close(); }
    app.exit(failed ? 1 : 0);
  }
});
