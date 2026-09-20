const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const { createCaptureSources } = require('./capture-sources.cjs');

// Keep the existing Chromium profile when the visible app name changes.
const profileDirectory = path.join(app.getPath('appData'), 'annivelliot-desktop');
fs.mkdirSync(profileDirectory, { recursive: true });
app.setPath('userData', profileDirectory);
app.setPath('sessionData', profileDirectory);
app.setName('CherubLink');
if (process.platform === 'win32') app.setAppUserModelId('ch.annivelliot.stream');

let window;
const captureSources = createCaptureSources((options) => desktopCapturer.getSources(options));

function ownWindow(event) {
  return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}

app.whenReady().then(() => {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'CherubLink',
    icon: path.join(__dirname, 'assets', 'cherublink-logo.png'),
    backgroundColor: '#0b1020',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep capture and negotiation running when the movie player is foregrounded.
      backgroundThrottling: false
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  const allowed = (contents, permission) =>
    contents === window?.webContents && ['media', 'display-capture', 'fullscreen', 'speaker-selection'].includes(permission);

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(allowed(contents, permission));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => {
    return allowed(contents, permission);
  });

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (request.frame !== window?.webContents.mainFrame) {
      callback(null);
      return;
    }
    callback(captureSources.consume(request.audioRequested, process.platform));
  });

  ipcMain.handle('list-sources', async (event) => {
    if (!ownWindow(event)) throw new Error('Accès refusé.');
    return captureSources.list();
  });

  ipcMain.handle('select-source', async (event, id, systemAudio) => {
    if (!ownWindow(event)) throw new Error('Accès refusé.');
    await captureSources.select(id, systemAudio);
  });

  window.on('closed', () => { window = null; });
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!BrowserWindow.getAllWindows().length) app.quit();
});
