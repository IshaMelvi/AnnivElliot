export function summarizeRtp(now, previous, direction) {
  const elapsed = previous?.id === now.id ? (now.timestamp - previous.timestamp) / 1000 : 0;
  const delta = (key) => elapsed > 0 && Number.isFinite(now[key]) && Number.isFinite(previous?.[key])
    ? Math.max(0, now[key] - previous[key]) : null;
  const bytes = delta(direction === 'send' ? 'bytesSent' : 'bytesReceived');
  const frames = delta(direction === 'send' ? 'framesEncoded' : 'framesDecoded');
  const packets = delta('packetsReceived');
  const lost = delta('packetsLost');
  const encode = delta('totalEncodeTime');
  const buffer = delta('jitterBufferDelay');
  const emitted = delta('jitterBufferEmittedCount');
  const targetBuffer = delta('jitterBufferTargetDelay');
  return {
    width: now.frameWidth, height: now.frameHeight,
    fps: elapsed > 0 && frames !== null ? frames / elapsed : now.framesPerSecond,
    mbps: bytes === null ? null : bytes * 8 / elapsed / 1e6,
    loss: packets !== null && lost !== null && packets + lost > 0 ? lost / (packets + lost) * 100 : null,
    encodeMs: frames > 0 && encode !== null ? encode / frames * 1000 : null,
    bufferMs: emitted > 0 && buffer !== null ? buffer / emitted * 1000 : null,
    targetBufferMs: emitted > 0 && targetBuffer !== null ? targetBuffer / emitted * 1000 : null,
    quantizer: frames > 0 && delta('qpSum') !== null ? delta('qpSum') / frames : null,
    dropped: delta('framesDropped'), freezes: delta('freezeCount'),
    limitation: now.qualityLimitationReason || null,
    encoder: now.encoderImplementation || null, decoder: now.decoderImplementation || null,
    powerEfficient: now.powerEfficientEncoder ?? now.powerEfficientDecoder ?? null
  };
}
