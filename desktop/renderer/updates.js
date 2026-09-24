export function createUpdates() {
  const api = window.desktop?.updates;
  const $ = (id) => document.getElementById(id);
  const notices = [...document.querySelectorAll('.update-notice')];
  let state = { phase: 'disabled', currentVersion: '', sessionActive: false };
  let received = false;

  function render(next) {
    state = next;
    $('app-version').textContent = state.currentVersion ? 'Version ' + state.currentVersion : 'CherubLink';
    const version = state.availableVersion || '';
    const messages = {
      disabled: 'Les mises à jour sont disponibles dans la version Windows installée.',
      idle: 'Les nouvelles versions sont recherchées au lancement.',
      checking: 'Recherche d’une nouvelle version…',
      current: 'Vous utilisez la dernière version disponible.',
      available: 'La version ' + version + ' est disponible.',
      downloading: 'Téléchargement de la version ' + version + '…',
      downloaded: 'La version ' + version + ' est prête à être installée.',
      installing: 'Redémarrage pour installer la mise à jour…',
      error: state.error
    };
    $('update-status').textContent = messages[state.phase] || '';
    $('update-check').hidden = !['idle', 'checking', 'current', 'available', 'error'].includes(state.phase);
    $('update-check').disabled = state.phase === 'checking';
    $('update-download').hidden = state.phase !== 'available';
    $('update-download').disabled = state.sessionActive;
    $('update-install').hidden = !['downloaded', 'installing'].includes(state.phase);
    $('update-install').disabled = state.sessionActive || state.phase === 'installing';
    $('update-progress-wrap').hidden = state.phase !== 'downloading';
    $('update-progress').value = state.percent || 0;
    $('update-percent').textContent = (state.percent || 0) + ' %';
    $('update-help').textContent = state.sessionActive
      ? 'Quittez le salon pour télécharger ou installer une mise à jour. Votre appel continue normalement.'
      : 'Le téléchargement démarre à votre demande et s’arrête si vous entrez dans un salon. L’installation attend votre accord ; votre profil et vos réglages sont conservés.';
    for (const notice of notices) {
      notice.hidden = !['available', 'downloading', 'downloaded'].includes(state.phase);
      notice.textContent = state.phase === 'downloaded' ? 'Mise à jour prête à installer'
        : state.phase === 'downloading' ? 'Mise à jour · ' + (state.percent || 0) + ' %'
          : 'Nouvelle version ' + version;
    }
  }
  async function invoke(action) {
    try { await api[action](); }
    catch { $('update-status').textContent = 'Impossible de joindre le service de mise à jour. Réessayez.'; }
  }
  $('update-check').addEventListener('click', () => invoke('check'));
  $('update-download').addEventListener('click', () => invoke('download'));
  $('update-install').addEventListener('click', () => invoke('install'));
  for (const notice of notices) notice.addEventListener('click', () => $('update-section').scrollIntoView({ block: 'nearest' }));
  if (api) {
    const unsubscribe = api.subscribe((next) => { received = true; render(next); });
    // Do not overwrite an event that arrived while the initial snapshot was in flight.
    api.snapshot().then((next) => { if (!received) render(next); }).catch(() => render(state));
    window.addEventListener('pagehide', unsubscribe, { once: true });
  } else render(state);
  return {
    async setSessionActive(active) {
      // Old browser fixtures have no Electron bridge. Production always provides it.
      if (!api) return true;
      try { return await api.setSessionActive(active); }
      catch { return false; }
    }
  };
}
