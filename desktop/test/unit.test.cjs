const test = require('node:test');
const assert = require('node:assert/strict');
const { createCaptureSources } = require('../capture-sources.cjs');
const source = (id) => ({ id, name: id, thumbnail: { toDataURL: () => 'data:image/png;base64,test' } });

test('a failed audio capture can retry the same source; tickets are single use', async () => {
  const registry = createCaptureSources(async () => [source('window:1')]);
  await registry.list();
  await registry.select('window:1', true);
  assert.equal(registry.consume(true, 'win32').audio, 'loopback');
  assert.equal(registry.consume(true, 'win32'), null);
  await registry.select('window:1', true);
  assert.equal(registry.consume(true, 'win32').video.id, 'window:1');
});
test('video-only retries never open loopback, even with a stale audio request', async () => {
  const registry = createCaptureSources(async () => [source('screen:1')]);
  await registry.list();
  for (const [selectedAudio, requestedAudio, platform] of [[false, true, 'win32'], [true, false, 'win32'], [true, true, 'linux']]) {
    await registry.select('screen:1', selectedAudio);
    assert.equal(registry.consume(requestedAudio, platform).audio, undefined);
  }
});
test('closed windows and unoffered IDs cannot be captured', async () => {
  let available = [source('window:1')];
  const registry = createCaptureSources(async () => available);
  await registry.list();
  await assert.rejects(registry.select('window:secret'), /liste/);
  available = [];
  await assert.rejects(registry.select('window:1'), /fermée/);
  assert.equal(registry.consume(true, 'win32'), null);
});
test('refreshing the source list invalidates an in-flight selection', async () => {
  let resolveSelection;
  let calls = 0;
  const registry = createCaptureSources(async () => {
    if (++calls === 2) return new Promise((resolve) => { resolveSelection = resolve; });
    return [source('window:1')];
  });
  await registry.list();
  const selecting = registry.select('window:1');
  await registry.list();
  resolveSelection([source('window:1')]);
  await assert.rejects(selecting, /changé/);
  assert.equal(registry.consume(true, 'win32'), null);
});
test('voice threshold, hysteresis and release preserve ends of words', async () => {
  const { VoiceGate } = await import('../renderer/voice-gate.mjs');
  const gate = new VoiceGate({ sensitivityMode: 'manual', thresholdDb: -40 });
  assert.equal(gate.sample(-60, 0).open, false);
  assert.equal(gate.sample(-30, .1).open, true);
  assert.equal(gate.sample(-42, .2).open, true);
  assert.equal(gate.sample(-70, .4).open, true);
  assert.equal(gate.sample(-70, .5).open, false);
  gate.update({ sensitivityMode: 'manual', thresholdDb: -60 });
  assert.equal(gate.sample(-55, .6).open, true);
});
test('automatic gate follows the noise floor within a usable range', async () => {
  const { VoiceGate, normalizeAudioSettings } = await import('../renderer/voice-gate.mjs');
  const gate = new VoiceGate();
  let value;
  for (let i = 0; i < 2000; i++) value = gate.sample(-50, i / 100);
  assert.ok(value.threshold > -45 && value.threshold <= -30);
  assert.equal(value.open, false);
  assert.equal(gate.sample(-20, 20).open, true);
  assert.equal(normalizeAudioSettings(null).masterVolume, 100);
  assert.equal(normalizeAudioSettings({ masterVolume: 999, thresholdDb: -200 }).thresholdDb, -65);
});
test('diagnostics use interval deltas, not lifetime averages', async () => {
  const { summarizeRtp } = await import('../renderer/stream-stats.mjs');
  const before = { id: 'r', timestamp: 1000, bytesReceived: 1000000, framesDecoded: 100, packetsReceived: 1000, packetsLost: 10, jitterBufferDelay: 10, jitterBufferEmittedCount: 100 };
  const after = { ...before, timestamp: 3000, bytesReceived: 3000000, framesDecoded: 160, packetsReceived: 1198, packetsLost: 12, jitterBufferDelay: 16, jitterBufferEmittedCount: 160 };
  const result = summarizeRtp(after, before, 'receive');
  assert.equal(result.mbps, 8);
  assert.equal(result.fps, 30);
  assert.equal(result.loss, 1);
  assert.equal(result.bufferMs, 100);
  assert.equal(summarizeRtp({ ...after, id: 'new' }, before, 'receive').mbps, null);
});

test('extended Windows enumeration adds missing windows, deduplicates handles and restores only the chosen one', async () => {
  let restored = null;
  let found = [{ id: 'window:12:0', name: 'Game', minimized: true }, { id: 'window:10:0', name: 'Duplicate' }];
  const registry = createCaptureSources(async () => [source('window:10:1')], {
    listWindows: async () => found, restoreWindow: async (id) => { restored = id; }
  });
  const normal = await registry.list();
  assert.equal(normal.length, 1);
  await assert.rejects(registry.select('window:12:0'), /liste/);
  const extended = await registry.list(true);
  assert.equal(extended.length, 2);
  assert.equal(extended[1].minimized, true);
  assert.equal(restored, null);
  await registry.select('window:12:0');
  assert.equal(restored, 'window:12:0');
  assert.equal(registry.consume(true, 'win32').video.name, 'Game');
  found = [];
  await assert.rejects(registry.select('window:12:0'), /fermée/);
});
test('bitrate settings are bounded and survive changes of resolution', async () => {
  const { normalizeQuality, screenBitrate } = await import('../renderer/video-quality.mjs');
  assert.equal(screenBitrate(normalizeQuality({ height: 1080, fps: 60 })), 20_000_000);
  assert.equal(screenBitrate(normalizeQuality({ height: 720, fps: 30, bitrate: 8 })), 8_000_000);
  assert.equal(normalizeQuality({ bitrate: 1e12 }).bitrate, 0);
});
test('chat requires membership and a peer, validates text, and limits message frequency', () => {
  const { attachChat } = require('../../signaling/chat.cjs');
  let handler;
  const sent = [];
  const socket = { data: {}, rooms: new Set(), on: (_, callback) => { handler = callback; },
    to: (room) => ({ emit: (event, data) => sent.push({ room, event, data }) }) };
  const rooms = new Map([['secret', new Set(['self', 'friend'])]]);
  attachChat({ sockets: { adapter: { rooms } } }, socket);
  let result;
  const emit = (data) => handler(data, (ack) => { result = ack; });
  emit({ text: 'hello' }); assert.equal(result.ok, false);
  socket.data.room = 'secret'; socket.rooms.add('secret');
  emit({ text: 'x'.repeat(1001) }); assert.equal(result.ok, false);
  emit({ text: '   ' }); assert.equal(result.ok, false);
  rooms.set('secret', new Set(['self']));
  emit({ text: 'hello' }); assert.equal(result.ok, false);
  rooms.set('secret', new Set(['self', 'friend']));
  emit({ text: '<img src=x onerror=alert(1)>', room: 'another-room' });
  assert.equal(result.ok, true);
  assert.equal(sent[0].room, 'secret');
  assert.equal(sent[0].data.text, '<img src=x onerror=alert(1)>');
  emit({ text: 'spam' }); assert.equal(result.ok, false);
  assert.equal(sent.length, 1);
});
