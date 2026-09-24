const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
let script;
function run(action, handle = '0') {
  if (!['List', 'Restore'].includes(action) || !/^\d{1,16}$/.test(handle)) return Promise.reject(new Error('Source invalide.'));
  script ??= fs.readFileSync(path.join(__dirname, 'windows-sources.ps1'), 'utf8');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Only bundled source and validated digits enter this command; window titles never do.
  const command = `& { ${script} } -Action ${action} -WindowId ${handle}`;
  return new Promise((resolve, reject) => {
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command],
      { windowsHide: true, timeout: 8000, maxBuffer: 512 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) return reject(new Error('Recherche Windows indisponible. Utilisez la liste standard ou le partage d’écran entier.'));
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); } catch { reject(new Error('Réponse Windows illisible.')); }
      });
  });
}
async function listWindows() {
  if (process.platform !== 'win32') return [];
  const found = await run('List');
  return (Array.isArray(found) ? found : []).filter((item) => /^window:\d{1,16}:0$/.test(item.id) && typeof item.name === 'string')
    .map((item) => ({ id: item.id, name: item.name.slice(0, 1024), minimized: item.minimized === true }));
}
async function restoreWindow(id) {
  const match = /^window:(\d{1,16}):0$/.exec(id);
  if (!match) throw new Error('Source invalide.');
  await run('Restore', match[1]);
}
module.exports = { listWindows, restoreWindow };
