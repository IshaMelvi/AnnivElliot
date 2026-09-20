const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');

// Keep the existing Chromium profile when the visible app name changes.
const profileDirectory = path.join(app.getPath('appData'), 'annivelliot-desktop');
fs.mkdirSync(profileDirectory, { recursive: true });
app.setPath('userData', profileDirectory);
app.setPath('sessionData', profileDirectory);
app.setName('CherubLink');
if (process.platform === 'win32') app.setAppUserModelId('ch.annivelliot.stream');

let window;
let sources = new Map();
let selectedSource = null;

function ownWindow(event) {
  return window && event.sender === window.webContents;
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
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  const allowed = (contents, permission) =>
    contents === window?.webContents && ['media', 'display-capture', 'fullscreen'].includes(permission);

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(allowed(contents, permission));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => {
    return allowed(contents, permission);
  });

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (request.frame !== window?.webContents.mainFrame || !selectedSource) {
      callback(null);
      return;
    }
    const source = selectedSource;
    selectedSource = null;
    callback(process.platform === 'win32'
      ? { video: source, audio: 'loopback' }
      : { video: source });
  });

  ipcMain.handle('list-sources', async (event) => {
    if (!ownWindow(event)) throw new Error('Accès refusé.');
    const found = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 }
    });
    sources = new Map(found.map((source) => [source.id, source]));
    return found.map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: source.thumbnail.toDataURL()
    }));
  });

  ipcMain.handle('select-source', (event, id) => {
    if (!ownWindow(event) || typeof id !== 'string' || !sources.has(id)) {
      throw new Error('Source d’écran invalide.');
    }
    selectedSource = sources.get(id);
    sources.clear();
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
