const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CancellationToken } = require('builder-util-runtime');
const { createUpdater } = require('../updater.cjs');

function fixture() {
  const updater = new EventEmitter();
  let checks = 0;
  let installs = 0;
  let token;
  updater.checkForUpdates = async () => {
    checks++;
    token = new CancellationToken();
    return { isUpdateAvailable: true, updateInfo: { version: '1.4.1' }, cancellationToken: token };
  };
  updater.downloadUpdate = async () => { updater.emit('update-downloaded', { version: '1.4.1' }); };
  updater.quitAndInstall = (...args) => { assert.deepEqual(args, [true, true]); installs++; };
  const scheduled = [];
  const controller = createUpdater({ updater, version: '1.4.0', enabled: true,
    schedule: (callback) => scheduled.push(callback) });
  return { updater, controller, scheduled, counts: () => ({ checks, installs }), token: () => token };
}

test('updates are opt-in; checks are single flight and installation cannot interrupt a room', async () => {
  const f = fixture();
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowPrerelease, false);
  assert.equal(f.updater.allowDowngrade, false);
  f.controller.check(); f.controller.check();
  await f.controller.settled();
  assert.equal(f.counts().checks, 1);
  assert.equal(f.controller.snapshot().phase, 'available');
  f.controller.setSessionActive(true);
  assert.equal(f.controller.download().phase, 'available');
  f.controller.setSessionActive(false);
  f.controller.download(); await f.controller.settled();
  assert.equal(f.counts().installs, 0);
  f.controller.check(); await f.controller.settled();
  assert.equal(f.counts().checks, 1, 'a pending installer must not be forgotten by another check');
  f.controller.setSessionActive(true);
  assert.equal(f.controller.install().phase, 'downloaded');
  f.controller.setSessionActive(false);
  f.controller.install(); f.controller.install();
  assert.equal(f.controller.setSessionActive(true), false, 'joining and installing are mutually exclusive');
  assert.equal(f.scheduled.length, 1);
  f.scheduled[0]();
  assert.equal(f.counts().installs, 1);
});

test('joining cancels an in-progress download and a fresh check permits retry', async () => {
  const f = fixture();
  f.updater.downloadUpdate = (token) => token.createPromise((_resolve, _reject, onCancel) => {
    onCancel(() => {});
  });
  f.controller.check(); await f.controller.settled();
  f.controller.download();
  await Promise.resolve();
  f.controller.setSessionActive(true);
  await f.controller.settled();
  assert.equal(f.token().cancelled, true);
  assert.equal(f.controller.snapshot().phase, 'idle');
  f.controller.setSessionActive(false);
  f.controller.check(); await f.controller.settled();
  assert.equal(f.token().cancelled, false);
  assert.equal(f.controller.snapshot().phase, 'available');
});

test('offline errors can be retried and dev builds perform no network calls', async () => {
  const f = fixture();
  const check = f.updater.checkForUpdates;
  f.updater.checkForUpdates = async () => { throw new Error('offline'); };
  f.controller.check(); await f.controller.settled();
  assert.equal(f.controller.snapshot().phase, 'error');
  f.updater.checkForUpdates = check;
  f.controller.check(); await f.controller.settled();
  assert.equal(f.controller.snapshot().phase, 'available');
  const dev = createUpdater({ updater: null, version: '1.4.0', enabled: false });
  assert.equal(dev.check().phase, 'disabled');
  assert.equal(dev.download().phase, 'disabled');
  assert.equal(dev.install().phase, 'disabled');
});
