const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function normalizeAudioSettings(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return {
    inputDeviceId: typeof value.inputDeviceId === 'string' ? value.inputDeviceId : 'default',
    outputDeviceId: typeof value.outputDeviceId === 'string' ? value.outputDeviceId : 'default',
    masterVolume: Number.isFinite(value.masterVolume) ? clamp(value.masterVolume, 0, 100) : 100,
    sensitivityMode: value.sensitivityMode === 'manual' ? 'manual' : 'auto',
    thresholdDb: Number.isFinite(value.thresholdDb) ? clamp(value.thresholdDb, -65, -10) : -45
  };
}

// Hysteresis and a 250 ms hold preserve quiet ends of words. Only the mic uses this gate.
export class VoiceGate {
  constructor(settings = {}) {
    this.settings = normalizeAudioSettings(settings);
    this.noiseDb = -65;
    this.openUntil = -1;
    this.open = false;
    this.lastTime = 0;
  }
  update(settings) { this.settings = normalizeAudioSettings(settings); }
  sample(db, time) {
    const dt = clamp(time - this.lastTime, 0, 0.1);
    this.lastTime = time;
    // Follow quiet noise quickly, louder noise slowly; never raise the floor above -40 dBFS.
    const targetNoise = Math.min(db, -40);
    const rate = targetNoise < this.noiseDb ? 2 : 0.12;
    this.noiseDb += (targetNoise - this.noiseDb) * (1 - Math.exp(-dt * rate));
    const threshold = this.settings.sensitivityMode === 'manual'
      ? this.settings.thresholdDb : clamp(this.noiseDb + 10, -58, -30);
    if (db >= threshold - (this.open ? 4 : 0)) this.openUntil = time + 0.25;
    this.open = time < this.openUntil;
    return { open: this.open, threshold, db };
  }
}
