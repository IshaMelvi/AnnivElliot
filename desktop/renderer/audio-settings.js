import { Microphone, microphoneError } from './audio.js';

export function createAudioSettings({ settings, save, outputs, onVolume, onNotice, onInputEnded }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('settings-dialog');
  const input = $('audio-input');
  const output = $('audio-output');
  const message = $('settings-status');
  let microphone = null;
  let activeCall = false;
  let creating = null;
  let generation = 0;
  let outputBusy = false;
  let deviceRefresh = 0;

  function notice(text) { message.textContent = text; onNotice(text); }
  function updateLevel(level) {
    if (!dialog.open) return;
    $('mic-level').value = Math.max(-80, level.db);
    const enabled = microphone?.stream.getAudioTracks()[0]?.enabled;
    $('mic-level').classList.toggle('voice-active', level.open && enabled);
    $('mic-level-text').textContent = enabled
      ? Math.round(level.db) + ' dB · ' + (level.open ? 'Voix détectée' : 'Silence') : 'Micro coupé';
    if (settings.sensitivityMode === 'auto') $('mic-threshold-value').textContent = Math.round(level.threshold) + ' dB';
  }
  function render() {
    $('master-volume').value = settings.masterVolume;
    $('master-volume-value').textContent = settings.masterVolume + ' %';
    $('sensitivity-mode').value = settings.sensitivityMode;
    $('mic-threshold').value = settings.thresholdDb;
    $('mic-threshold').disabled = settings.sensitivityMode !== 'manual';
    $('mic-threshold-value').textContent = settings.sensitivityMode === 'auto' ? 'Auto' : settings.thresholdDb + ' dB';
    $('test-microphone').hidden = activeCall;
    $('test-microphone').textContent = microphone ? 'Arrêter le test' : 'Tester la détection';
    if (!microphone) {
      $('mic-level').value = -80;
      $('mic-level').classList.remove('voice-active');
      $('mic-level-text').textContent = 'Micro inactif';
    }
  }
  function options(select, devices, kind, selected) {
    select.replaceChildren(new Option(kind === 'audioinput' ? 'Microphone par défaut' : 'Sortie par défaut', 'default'));
    let index = 0;
    for (const device of devices.filter((item) => item.kind === kind && item.deviceId && item.deviceId !== 'default')) {
      select.add(new Option(device.label || 'Périphérique ' + (++index), device.deviceId));
    }
    if (![...select.options].some((option) => option.value === selected)) {
      select.add(new Option('Périphérique enregistré (non détecté)', selected));
    }
    select.value = selected;
  }
  async function refreshDevices() {
    const version = ++deviceRefresh;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (version !== deviceRefresh) return;
      options(input, devices, 'audioinput', settings.inputDeviceId);
      options(output, devices, 'audiooutput', settings.outputDeviceId);
      return devices;
    } catch { message.textContent = 'Impossible de lister les périphériques audio.'; }
  }
  async function routeOutput(id) {
    if (outputs.some((element) => typeof element.setSinkId !== 'function')) {
      if (id !== 'default') throw new Error('Le choix de sortie est indisponible sur ce système.');
      return;
    }
    const previous = outputs.map((element) => element.sinkId);
    const results = await Promise.allSettled(outputs.map((element) => element.setSinkId(id === 'default' ? '' : id)));
    if (results.some((result) => result.status === 'rejected')) {
      await Promise.allSettled(outputs.map((element, index) => element.setSinkId(previous[index])));
      throw new Error('Cette sortie est indisponible. Vérifiez son branchement puis choisissez une autre sortie.');
    }
  }
  async function ensureOutput() {
    if (outputBusy) return;
    outputBusy = true;
    output.disabled = true;
    try { await routeOutput(settings.outputDeviceId); }
    catch {
      try {
        await routeOutput('default');
        settings.outputDeviceId = 'default';
        save();
        notice('La sortie enregistrée est indisponible. La sortie Windows par défaut est utilisée.');
      } catch (error) { notice(error.message); }
    } finally { outputBusy = false; output.disabled = false; await refreshDevices(); }
  }
  async function start(forCall = true) {
    if (forCall) activeCall = true;
    if (microphone) { render(); await ensureOutput(); return microphone.stream; }
    if (creating) return creating;
    const version = generation;
    input.disabled = true;
    $('test-microphone').disabled = true;
    creating = (async () => {
      let captured;
      try {
        try {
          captured = await Microphone.create(settings, updateLevel, () => {
            microphone?.stream.getAudioTracks().forEach((track) => { track.enabled = false; });
            notice('Microphone déconnecté. Choisissez une autre entrée, puis réactivez le micro.');
            onInputEnded();
          });
        } catch (error) {
          if (settings.inputDeviceId === 'default' || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error;
          // Saved devices may disappear between launches. A live, explicit switch never silently falls back.
          const fallback = { ...settings, inputDeviceId: 'default' };
          captured = await Microphone.create(fallback, updateLevel, () => {
            microphone?.stream.getAudioTracks().forEach((track) => { track.enabled = false; });
            notice('Microphone déconnecté. Choisissez une autre entrée.');
            onInputEnded();
          });
          settings.inputDeviceId = 'default';
          save();
          notice('Microphone enregistré introuvable. Le microphone par défaut est utilisé.');
        }
        if (version !== generation) {
          captured.stop();
          throw new DOMException('Activation annulée.', 'AbortError');
        }
        microphone = captured;
        await ensureOutput();
        if (version !== generation) throw new DOMException('Activation annulée.', 'AbortError');
        return microphone.stream;
      } catch (error) { if (version === generation) activeCall = false; throw error; }
      finally { creating = null; input.disabled = false; $('test-microphone').disabled = false; render(); }
    })();
    return creating;
  }
  function stop() {
    generation++;
    microphone?.stop();
    microphone = null;
    activeCall = false;
    render();
  }

  document.querySelectorAll('.settings-open').forEach((button) => button.addEventListener('click', () => {
    message.textContent = '';
    render();
    dialog.showModal();
    refreshDevices();
  }));
  $('settings-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if (!activeCall) stop(); });
  $('test-microphone').addEventListener('click', async () => {
    if (activeCall) return;
    if (microphone) { stop(); return; }
    message.textContent = 'Activation du microphone…';
    try { await start(false); message.textContent = 'Parlez pour vérifier le seuil. Votre voix n’est pas diffusée.'; }
    catch (error) { if (error.name !== 'AbortError') message.textContent = microphoneError(error); }
  });
  input.addEventListener('change', async () => {
    const selected = input.value;
    const version = generation;
    input.disabled = true;
    try {
      if (microphone && !await microphone.switchInput(selected)) return;
      if (version !== generation) return;
      settings.inputDeviceId = selected;
      save();
      message.textContent = 'Entrée audio enregistrée.';
    } catch (error) { input.value = settings.inputDeviceId; message.textContent = microphoneError(error); }
    finally { input.disabled = false; }
  });
  output.addEventListener('change', async () => {
    if (outputBusy) return;
    outputBusy = true;
    output.disabled = true;
    try {
      const selected = output.value;
      await routeOutput(selected);
      settings.outputDeviceId = selected;
      save();
      message.textContent = 'Sortie audio enregistrée.';
    } catch (error) { output.value = settings.outputDeviceId; message.textContent = error.message; }
    finally { outputBusy = false; output.disabled = false; }
  });
  $('master-volume').addEventListener('input', () => {
    settings.masterVolume = Number($('master-volume').value);
    $('master-volume-value').textContent = settings.masterVolume + ' %';
    save();
    onVolume();
  });
  function sensitivityChanged() {
    settings.sensitivityMode = $('sensitivity-mode').value;
    settings.thresholdDb = Number($('mic-threshold').value);
    microphone?.configure(settings);
    save();
    render();
  }
  $('sensitivity-mode').addEventListener('change', sensitivityChanged);
  $('mic-threshold').addEventListener('input', sensitivityChanged);
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    const devices = await refreshDevices();
    if (devices && settings.outputDeviceId !== 'default' && !devices.some((device) => device.kind === 'audiooutput' && device.deviceId === settings.outputDeviceId)) {
      await ensureOutput();
    }
  });
  render();
  return { start, stop, dialog };
}
