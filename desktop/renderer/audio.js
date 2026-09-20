export function microphoneError(error) {
  if (error?.name === 'NotAllowedError') return 'Autorisez le microphone dans les paramètres de confidentialité de Windows.';
  if (['NotFoundError', 'OverconstrainedError'].includes(error?.name)) return 'Ce microphone est débranché ou indisponible. Choisissez une autre entrée audio.';
  if (error?.name === 'NotReadableError' || /audio source/i.test(error?.message || '')) {
    return 'Impossible d’ouvrir ce microphone. Vérifiez le périphérique et son mode exclusif dans Windows, puis réessayez.';
  }
  return error?.message || 'Le microphone ne peut pas démarrer.';
}

async function captureMicrophone(deviceId) {
  return navigator.mediaDevices.getUserMedia({ audio: {
    ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1
  }, video: false });
}

export class Microphone {
  static async create(settings, onLevel, onEnded) {
    const raw = await captureMicrophone(settings.inputDeviceId);
    let context;
    try {
      context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      await context.audioWorklet.addModule('voice-gate-worklet.js');
      const gate = new AudioWorkletNode(context, 'microphone-gate', {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
        outputChannelCount: [1], processorOptions: settings
      });
      const destination = context.createMediaStreamDestination();
      gate.connect(destination);
      gate.port.onmessage = ({ data }) => onLevel(data);
      const mic = new Microphone();
      Object.assign(mic, { context, gate, stream: destination.stream, onEnded, revision: 0, closed: false });
      mic.attach(raw);
      await context.resume();
      return mic;
    } catch (error) {
      raw.getTracks().forEach((track) => track.stop());
      await context?.close();
      throw error;
    }
  }
  attach(raw) {
    const source = this.context.createMediaStreamSource(raw);
    source.connect(this.gate);
    this.raw = raw;
    this.source = source;
    raw.getAudioTracks()[0].addEventListener('ended', () => {
      if (this.raw === raw && !this.closed) this.onEnded();
    });
  }
  async switchInput(deviceId) {
    const revision = ++this.revision;
    const raw = await captureMicrophone(deviceId);
    if (this.closed || this.revision !== revision) {
      raw.getTracks().forEach((track) => track.stop());
      return false;
    }
    const previousRaw = this.raw;
    const previousSource = this.source;
    try { this.attach(raw); }
    catch (error) { raw.getTracks().forEach((track) => track.stop()); throw error; }
    previousSource.disconnect();
    previousRaw.getTracks().forEach((track) => track.stop());
    // The processed track and stream ID stay the same: no renegotiation or mute reset.
    return true;
  }
  configure(settings) { this.gate.port.postMessage(settings); }
  stop() {
    if (this.closed) return;
    this.closed = true;
    this.revision++;
    this.raw.getTracks().forEach((track) => track.stop());
    this.stream.getTracks().forEach((track) => track.stop());
    this.source.disconnect();
    this.gate.disconnect();
    this.gate.port.close();
    this.context.close().catch(() => {});
  }
}
