import { summarizeRtp } from './stream-stats.mjs';

export function startDiagnostics(getState) {
  const $ = (id) => document.getElementById(id);
  let previous = {};
  let lastPeer = null;
  let sampling = false;
  let latest = { message: 'Aucune mesure disponible. Ouvrez les paramètres pendant un partage.' };
  const number = (value, suffix, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) + suffix : '—';
  function describe(data) {
    if (!data) return 'Aucun partage';
    return `${data.width || '—'} × ${data.height || '—'} · ${number(data.fps, ' fps')}
${number(data.mbps, ' Mbit/s', 2)} · ${data.codec || 'codec en attente'}
${data.encodeMs !== null ? 'Encodage : ' + number(data.encodeMs, ' ms/image', 1) : 'Pertes : ' + number(data.loss, ' %', 1)}
${data.bufferMs !== null ? 'Tampon : ' + number(data.bufferMs, ' ms') : 'Limite : ' + ({ cpu: 'processeur', bandwidth: 'réseau', none: 'aucune', other: 'autre' }[data.limitation] || '—')}`;
  }
  async function sampleDirection(endpoint, direction, key = direction) {
    if (!endpoint) { previous[key] = null; return null; }
    const report = await endpoint.getStats();
    const stats = [...report.values()].find((item) => item.type === (direction === 'send' ? 'outbound-rtp' : 'inbound-rtp') && item.kind === endpoint.track.kind && !item.isRemote);
    if (!stats) return null;
    const summary = summarizeRtp(stats, previous[key], direction);
    previous[key] = stats;
    summary.codec = report.get(stats.codecId)?.mimeType?.replace('video/', '');
    const transport = report.get(stats.transportId);
    const pair = report.get(transport?.selectedCandidatePairId);
    summary.roundTripMs = pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null;
    summary.availableMbps = pair?.availableOutgoingBitrate != null ? pair.availableOutgoingBitrate / 1e6 : null;
    // Deliberately exclude addresses, SDP, room names and device labels from copied diagnostics.
    return summary;
  }
  async function sample() {
    if (sampling || !$('settings-dialog').open) return;
    sampling = true;
    try {
      const state = getState();
      if (state.peer !== lastPeer) { previous = {}; lastPeer = state.peer; }
      const receiver = state.peer?.getReceivers().find((item) => item.track === state.remoteTrack);
      const cameraReceiver = state.peer?.getReceivers().find((item) => item.track === state.remoteCameraTrack);
      const micReceiver = state.peer?.getReceivers().find((item) => item.track === state.remoteMicTrack);
      const [send, receive, camera, microphone] = await Promise.all([
        sampleDirection(state.sender, 'send'), sampleDirection(receiver, 'receive'),
        sampleDirection(cameraReceiver, 'receive', 'camera'), sampleDirection(micReceiver, 'receive', 'microphone')
      ]);
      if (getState().peer !== state.peer) return;
      const capture = state.capture ? { width: state.capture.width, height: state.capture.height, fps: state.capture.frameRate } : null;
      latest = { measuredAt: new Date().toISOString(), target: state.target, capture, send, receive,
        conversation: { camera, microphone, sharedStream: state.conversationGrouped } };
      $('stats-send').textContent = describe(send);
      $('stats-receive').textContent = describe(receive);
      let advice = 'Le débit et la résolution s’adaptent à la connexion pour préserver la fluidité. Pour un film, commencez en 1080p / 30 fps.';
      if (send?.limitation === 'cpu') advice = 'Votre ordinateur limite l’encodage. Essayez 30 fps, puis 720p si nécessaire, et fermez les autres captures vidéo.';
      else if (send?.limitation === 'bandwidth' || receive?.loss > 2) advice = 'Le réseau limite le partage. Essayez une connexion Ethernet et une qualité inférieure. Le débit montant de la personne qui partage compte aussi.';
      else if (receive?.freezes > 0 || receive?.dropped > 5 || receive?.bufferMs > 250) advice = 'La réception présente des retards. Comparez ce diagnostic à celui de votre ami pour vérifier le réseau et le traitement vidéo.';
      $('stats-advice').textContent = state.sender || receiver ? advice : 'Démarrez un partage pour mesurer la résolution, les images par seconde et le débit réels.';
    } catch (error) { console.warn('Mesure du partage :', error); }
    finally { sampling = false; }
  }
  setInterval(sample, 2000);
  document.querySelectorAll('.settings-open').forEach((button) => button.addEventListener('click', () => {
    previous = {};
    sample();
  }));
  $('copy-diagnostics').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(latest, null, 2));
      $('settings-status').textContent = 'Diagnostic copié. Comparez-le à celui de votre ami.';
    } catch { $('settings-status').textContent = 'Impossible de copier le diagnostic.'; }
  });
}
