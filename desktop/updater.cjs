// Only the main process can select the update provider or start an installer.
function createUpdater({ updater, version, enabled, publish = () => {}, schedule = setImmediate }) {
  let state = { phase: enabled ? 'idle' : 'disabled', currentVersion: version,
    availableVersion: null, percent: 0, sessionActive: false, error: '' };
  let task = null;
  let cancellation = null;
  const snapshot = () => ({ ...state });
  const change = (values) => { state = { ...state, ...values }; publish(snapshot()); };
  const failure = () => change({ phase: 'error', error:
    'La mise à jour est indisponible pour le moment. Vérifiez votre connexion et réessayez.' });

  if (enabled) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.on('error', failure);
    updater.on('download-progress', ({ percent }) => {
      if (state.phase !== 'downloading') return;
      const rounded = Math.max(0, Math.min(100, Math.floor(Number(percent) || 0)));
      if (rounded !== state.percent) change({ percent: rounded });
    });
    updater.on('update-downloaded', (info) => change({
      phase: 'downloaded', availableVersion: info.version, percent: 100, error: ''
    }));
  }

  // Return immediately to IPC callers. The state stream reports completion/errors.
  function run(work) {
    task = Promise.resolve().then(work).catch(failure).finally(() => { task = null; });
  }
  function check() {
    if (!enabled || task || ['downloaded', 'installing'].includes(state.phase)) return snapshot();
    change({ phase: 'checking', error: '' });
    run(async () => {
      const result = await updater.checkForUpdates();
      if (!result) throw new Error('Updater unavailable');
      cancellation = result.cancellationToken;
      // The library compares semantic versions and filters prereleases/downgrades.
      change({ phase: result.isUpdateAvailable ? 'available' : 'current',
        availableVersion: result.isUpdateAvailable ? result.updateInfo.version : null, percent: 0 });
    });
    return snapshot();
  }
  function download() {
    if (!enabled || task || state.sessionActive || state.phase !== 'available') return snapshot();
    const token = cancellation;
    change({ phase: 'downloading', percent: 0, error: '' });
    run(async () => {
      try { await updater.downloadUpdate(token); }
      catch (error) { if (!token?.cancelled) throw error; }
      finally {
        if (token?.cancelled && state.phase !== 'downloaded') {
          change({ phase: 'idle', percent: 0, availableVersion: null, error: '' });
        }
      }
    });
    return snapshot();
  }
  function setSessionActive(active) {
    if (active && state.phase === 'installing') return false;
    change({ sessionActive: active === true });
    // Joining a room always takes priority over an update download.
    if (active && state.phase === 'downloading') cancellation?.cancel();
    return true;
  }
  function install() {
    if (!enabled || state.sessionActive || state.phase !== 'downloaded') return snapshot();
    change({ phase: 'installing', error: '' });
    schedule(() => {
      try { updater.quitAndInstall(true, true); }
      catch { failure(); }
    });
    return snapshot();
  }
  return { snapshot, check, download, install, setSessionActive,
    // A deterministic completion hook for main-process tests (never exposed to IPC).
    settled: () => task || Promise.resolve() };
}

module.exports = { createUpdater };
