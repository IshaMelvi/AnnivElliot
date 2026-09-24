const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const windows = require('../windows-sources.cjs');
const { createCaptureSources } = require('../capture-sources.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  let window;
  let result;
  const fixture = path.join(__dirname, '..', '.tmp-native-capture.html');
  try {
    // A small disposable window; never restore or capture another application.
    const area = screen.getPrimaryDisplay().workArea;
    window = new BrowserWindow({ show: false, x: area.x + area.width - 340, y: area.y + area.height - 260, width: 320, height: 240,
      title: 'CherubLink native capture test', webPreferences: { sandbox: true } });
    fs.writeFileSync(fixture, '<!doctype html><title>CherubLink native capture test</title><h1>Capture test</h1>');
    await window.loadFile(fixture);
    window.showInactive();
    window.minimize();
    await delay(300);
    const title = 'CherubLink native capture test';
    const found = (await windows.listWindows()).find((item) => item.name === title);
    assert.ok(found, 'The native helper must enumerate a minimized application window');
    assert.equal(found.minimized, true);
    const registry = createCaptureSources((options) => desktopCapturer.getSources(options), windows);
    const sources = await registry.list(true);
    const chosen = sources.find((item) => item.name === title);
    assert.ok(chosen);
    await registry.select(chosen.id, false);
    await delay(300);
    assert.equal(window.isMinimized(), false, 'Only the explicitly chosen window should be restored');
    window.webContents.session.setPermissionCheckHandler(() => true);
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(true));
    window.webContents.session.setDisplayMediaRequestHandler((_request, callback) => callback(registry.consume(false, 'win32')));
    const capture = await window.webContents.executeJavaScript(`(async () => {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = stream.getVideoTracks()[0];
      const video = document.createElement('video'); video.muted = true; video.srcObject = stream;
      const frame = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No captured video frame')), 7000);
        video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
      });
      await video.play(); await frame;
      const settings = track.getSettings();
      stream.getTracks().forEach(track => track.stop());
      video.srcObject = null;
      return { stopped: track.readyState === 'ended', width: settings.width, height: settings.height, displaySurface: settings.displaySurface };
    })()`, true);
    assert.ok(capture.width > 0 && capture.height > 0, 'The native window handle must produce a real video capture');
    assert.equal(capture.displaySurface, 'window');
    result = { ok: true, extendedEnumeration: true, restoreSelectedWindow: true, capture };
  } catch (error) { result = { ok: false, error: error.stack }; }
  finally {
    fs.writeFileSync(path.join(__dirname, '..', '.tmp-native-result.json'), JSON.stringify(result, null, 2));
    window?.destroy();
    if (fs.existsSync(fixture)) fs.unlinkSync(fixture);
    app.exit(result.ok ? 0 : 1);
  }
});
