import { VoiceGate } from './voice-gate.mjs';

class MicrophoneGate extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.gate = new VoiceGate(options.processorOptions);
    this.gain = 0;
    this.meterFrames = 0;
    // Look ahead 20 ms so detection doesn't truncate the start of a syllable.
    this.delay = new Float32Array(Math.max(1, Math.round(sampleRate * 0.02)));
    this.position = 0;
    this.port.onmessage = ({ data }) => this.gate.update(data);
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    let energy = 0;
    if (input) for (const sample of input) energy += sample * sample;
    const db = Math.max(-100, 10 * Math.log10(energy / (input?.length || 1) || 1e-10));
    const level = this.gate.sample(db, currentTime);
    const target = level.open ? 1 : 0;
    const smoothing = 1 - Math.exp(-1 / (sampleRate * (level.open ? 0.003 : 0.035)));
    for (let i = 0; i < output.length; i++) {
      this.gain += (target - this.gain) * smoothing;
      output[i] = this.delay[this.position] * this.gain;
      this.delay[this.position] = input?.[i] || 0;
      this.position = (this.position + 1) % this.delay.length;
    }
    this.meterFrames += output.length;
    if (this.meterFrames >= sampleRate / 10) {
      this.meterFrames = 0;
      this.port.postMessage(level);
    }
    return true;
  }
}
registerProcessor('microphone-gate', MicrophoneGate);
