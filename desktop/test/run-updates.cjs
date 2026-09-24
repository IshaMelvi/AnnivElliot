const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(root, '.tmp-updates-'));
const env = { ...process.env, CHERUBLINK_UPDATE_TEST_DIR: fixture };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, 'updates.cjs')], {
  cwd: root, env, windowsHide: true, stdio: 'inherit'
});
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('close', (code) => {
  // Chromium releases its profile files only after Electron has exited on Windows.
  if (path.resolve(fixture).startsWith(root + path.sep)) {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  const resultFile = path.join(root, '.tmp-updates-result.json');
  if (fs.existsSync(resultFile)) console.log(fs.readFileSync(resultFile, 'utf8'));
  process.exitCode = code === 0 ? 0 : 1;
});
