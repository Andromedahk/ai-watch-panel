const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { DEFAULT_STREAM_CONFIG, streamPreferences, validateStreamConfig } = require('../electron/screen-stream-policy.cjs');
const { FramePump, ScreenStream, bridgeCommand, streamAvailability } = require('../electron/screen-stream.cjs');
const { validPreferences } = require('../electron/window-policy.cjs');

test('screen settings validate resolutions, resource bounds and device identities before launching', () => {
  assert.throws(() => validateStreamConfig({ width: 2241 }), /resolution/);
  assert.throws(() => validateStreamConfig({ width: 4096, height: 4096 }), /resolution/);
  assert.throws(() => validateStreamConfig({ fps: 61 }), /range/);
  assert.throws(() => validateStreamConfig({ fps: '30' }), /integers/);
  assert.throws(() => validateStreamConfig({ device: 'shell command' }), /Unsupported/);
  for (const device of ['__proto__', 'constructor', 'toString', {}, null]) assert.throws(() => validateStreamConfig({ device }), /Unsupported/);
  assert.throws(() => validateStreamConfig({ executable: 'anything' }), /Unknown/);
  assert.throws(() => validateStreamConfig({ enabled: true }), /Unknown/);
  assert.throws(() => validateStreamConfig({ showMascot: 'yes' }), /mascot/);
  assert.deepEqual(validateStreamConfig({ fps: 15 }, { partial: true }), { fps: 15 });
  assert.deepEqual(validateStreamConfig({ height: 2240 }, { partial: true }), { height: 2240 });
  assert.equal(validateStreamConfig({ width: 1080, height: 2240 }).height, 2240);
});

test('saved stream mode survives ordinary preferences migration; corrupt input resets safely', () => {
  const prefs = validPreferences({ stream: { enabled: true, width: 1920, height: 1080, fps: 24, pageSeconds: 9, showMascot: false } });
  assert.equal(prefs.stream.enabled, true);
  assert.equal(prefs.stream.width, 1920);
  assert.equal(prefs.stream.showMascot, false);
  assert.deepEqual(streamPreferences({ enabled: true, device: 'missing-adapter' }), DEFAULT_STREAM_CONFIG);
  assert.deepEqual(streamPreferences(null), DEFAULT_STREAM_CONFIG);
});

test('packaged availability requires the bridge, FFmpeg and device daemon before enabling streaming', () => {
  const resourcesPath = path.resolve('fixture-resources');
  const bundle = path.join(resourcesPath, 'screen-bridge');
  const files = new Set();
  const options = { packaged: true, platform: 'win32', resourcesPath, fileExists: file => files.has(file) };
  assert.equal(streamAvailability(options).available, false);
  assert.match(streamAvailability(options).unavailableReason, /未包含串流组件/);
  files.add(path.join(bundle, 'XANALI-Panel-Bridge.exe'));
  assert.match(streamAvailability(options).unavailableReason, /不完整/);
  files.add(path.join(bundle, '_internal', 'resources', 'ffmpeg', 'ffmpeg.exe'));
  assert.equal(streamAvailability(options).available, false);
  files.add(path.join(bundle, '_internal', 'resources', 'streamd-arm64'));
  assert.deepEqual(streamAvailability(options), { available: true, unavailableReason: null });
});

test('unsupported platforms are unavailable while isolated preview requires no bridge resources', () => {
  for (const platform of ['darwin', 'linux']) {
    const state = streamAvailability({ platform, fileExists: () => assert.fail('unsupported platforms must not probe a bridge') });
    assert.equal(state.available, false);
    assert.match(state.unavailableReason, /Windows/);
  }
  assert.deepEqual(streamAvailability({ platform: 'darwin', packaged: true, preview: true,
    fileExists: () => assert.fail('fixture preview must not require production components') }), { available: true, unavailableReason: null });
});

test('development availability follows the chosen prebuilt or Python bridge and its matching resources', () => {
  const root = path.resolve('fixture-repo'), files = new Set();
  const options = { root, platform: 'win32', env: {}, fileExists: file => files.has(file) };
  assert.equal(streamAvailability(options).available, false);
  for (const name of ['app/panel_stream_bridge.py', 'resources/ffmpeg/ffmpeg.exe', 'resources/streamd-arm64']) files.add(path.join(root, 'screen-bridge', name));
  assert.equal(streamAvailability(options).available, true);
  const bundle = path.join(root, '.local', 'screen-bridge', 'XANALI-Panel-Bridge');
  files.add(path.join(bundle, 'XANALI-Panel-Bridge.exe'));
  assert.equal(streamAvailability(options).available, false, 'a selected incomplete prebuilt bridge must not appear ready');
  assert.equal(streamAvailability({ ...options, env: { XANALI_PYTHON: 'python' } }).available, true);
  files.add(path.join(bundle, '_internal', 'resources', 'ffmpeg', 'ffmpeg.exe'));
  files.add(path.join(bundle, '_internal', 'resources', 'streamd-arm64'));
  assert.equal(streamAvailability(options).available, true);
});

test('frame pump keeps one write in flight and replaces outdated frames under backpressure', () => {
  const writes = [], callbacks = [];
  const pump = new FramePump({ write: (frame, done) => { writes.push(frame); callbacks.push(done); } });
  pump.update(Buffer.from('first')); pump.tick();
  pump.update(Buffer.from('superseded')); pump.tick();
  pump.update(Buffer.from('latest')); pump.tick();
  assert.equal(writes.length, 1);
  assert.equal(pump.droppedFrames, 2);
  callbacks.shift()(); pump.tick();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].toString(), 'latest');
  callbacks.shift()(); pump.tick();
  assert.equal(writes[2].toString(), 'latest', 'unchanged frames maintain H.264 timing and device keepalive');
  pump.close(); callbacks.shift()(); pump.tick();
  assert.equal(writes.length, 3);
  assert.equal(pump.latest, null);
});

test('write failures surface once and late callbacks after stop cannot restart work', () => {
  const errors = [];
  let callback;
  const pump = new FramePump({ write: (_frame, done) => { callback = done; }, onError: error => errors.push(error.message) });
  pump.update(Buffer.from('x')); pump.tick(); callback(new Error('broken'));
  assert.deepEqual(errors, ['broken']);
  pump.tick(); pump.close(); callback(new Error('closed')); pump.tick();
  assert.deepEqual(errors, ['broken']);
});

function fixture() {
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false;
      const contents = new EventEmitter();
      contents.mainFrame = {}; contents.sent = [];
      contents.setWindowOpenHandler = callback => { contents.openHandler = callback; };
      contents.setFrameRate = value => { contents.rate = value; };
      contents.enableDeviceEmulation = options => { contents.emulation = options; };
      contents.startPainting = () => { contents.painting = true; };
      contents.invalidate = () => queueMicrotask(() => contents.emit('paint', {}, {}, {
        isEmpty: () => false, getSize: () => this.contentSize,
        toBitmap: () => Buffer.alloc(this.contentSize.width * this.contentSize.height * 4),
      }));
      contents.send = (...args) => contents.sent.push(args);
      this.webContents = contents; windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    setContentSize(width, height) { this.contentSize = { width, height }; }
    destroy() { this.destroyed = true; }
    async loadFile(file, options) { this.file = file; this.loadOptions = options; }
  }
  let config = { ...DEFAULT_STREAM_CONFIG, enabled: true, width: 640, height: 360 };
  let changes = 0;
  const stream = new ScreenStream({ app: { isPackaged: false }, BrowserWindow: FakeWindow, preview: true,
    getConfig: () => config, getState: () => ({ stream: config, collapsed: true, stored: true, layout: 'single' }),
    getStatus: () => ({}), onChange: () => changes++, spawnProcess: () => { throw new Error('preview must never spawn USB bridge'); } });
  return { stream, windows, setConfig: next => { config = next; }, getChanges: () => changes };
}

test('preview offscreen window is isolated, read-only, independent of desktop storage, and torn down on stop', async () => {
  const { stream, windows } = fixture();
  try {
    await stream.start();
    const output = windows[0];
    assert.equal(stream.status, 'running');
    assert.equal(stream.state().available, true);
    assert.equal(stream.state().unavailableReason, null);
    assert.equal(output.options.show, false);
    assert.equal(output.options.webPreferences.backgroundThrottling, false);
    assert.equal(output.options.webPreferences.offscreen, true);
    assert.equal(output.options.webPreferences.sandbox, true);
    assert.equal(output.options.webPreferences.nodeIntegration, false);
    assert.deepEqual(output.contentSize, { width: 640, height: 360 });
    assert.deepEqual(output.webContents.emulation.viewSize, { width: 640, height: 360 });
    assert.equal(output.webContents.emulation.deviceScaleFactor, 1);
    assert.deepEqual(output.loadOptions.query, { surface: 'screen' });
    assert.equal(stream.screenState().stored, false);
    assert.equal(stream.screenState().collapsed, false);
    assert.equal(stream.screenState().layout, 'fullscreen');
    assert.equal(stream.accepts({ sender: output.webContents, senderFrame: output.webContents.mainFrame }), true);
    assert.equal(stream.accepts({ sender: output.webContents, senderFrame: {} }), false);
    assert.equal(stream.accepts({ sender: {}, senderFrame: output.webContents.mainFrame }), false);
    const firstFrame = stream.pump.latest;
    output.webContents.emit('paint', {}, {}, { isEmpty: () => false, getSize: () => ({ width: 600, height: 300 }), toBitmap: () => assert.fail('clamped frame must not be stretched') });
    assert.equal(stream.pump.latest, firstFrame);
    output.webContents.emit('paint', {}, {}, { isEmpty: () => false, getSize: () => ({ width: 640, height: 360 }), toBitmap: () => Buffer.alloc(640 * 360 * 4) });
    stream.pump.tick();
    assert.equal(stream.state().frames, 1);
    stream.broadcast('panel:status-changed', { sample: true });
    assert.deepEqual(output.webContents.sent[0], ['panel:status-changed', { sample: true }]);
    await stream.stop();
    assert.equal(output.destroyed, true);
    assert.equal(stream.status, 'stopped');
    assert.equal(stream.pump.latest, null);
  } finally { await stream.stop(); }
});

test('renderer failure restores stopped resources and retry creates a fresh output window', async () => {
  const { stream, windows } = fixture();
  try {
    await stream.start();
    windows[0].webContents.emit('render-process-gone');
    await stream.operation;
    assert.equal(stream.status, 'error');
    assert.match(stream.error, /渲染进程/);
    assert.equal(windows[0].destroyed, true);
    await stream.start();
    assert.equal(stream.status, 'running');
    assert.equal(stream.error, null);
    assert.equal(windows.length, 2);
  } finally { await stream.stop(); }
});

test('development bridge selection uses argv and a fixed repository entry point', () => {
  const result = bridgeCommand({ root: 'C:/example/repo', env: { XANALI_PYTHON: 'C:/python path/python.exe' } });
  assert.equal(result.executable, 'C:/python path/python.exe');
  assert.equal(result.args[0], '-u');
  assert.match(result.args[1], /panel_stream_bridge\.py$/);
  assert.equal(result.cwd, path.join('C:/example/repo', 'screen-bridge'));
  assert.equal(result.args[1], path.join(result.cwd, 'app', 'panel_stream_bridge.py'));
});

test('bridge stop waits for EOF restoration and exposes restoration failures rather than reporting success', async () => {
  for (const restored of [true, false]) {
    const { stream } = fixture();
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.kill = () => assert.fail('graceful EOF must not require killing');
    child.stdin.on('finish', () => {
      child.exitCode = restored ? 0 : 1; child.emit('exit', child.exitCode);
      child.stdout.write(JSON.stringify({ type: 'stopped', data: { restored, failed: !restored } }) + '\n');
      if (!restored) {
        const bytes = Buffer.from(JSON.stringify({ type: 'error', data: '恢复失败' }) + '\n');
        for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
      }
      child.emit('close', child.exitCode);
    });
    stream.spawnProcess = () => {
      queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'ready', data: { protocol: 1 } }) + '\n'));
      return child;
    };
    stream.status = 'starting';
    await stream.startBridge(DEFAULT_STREAM_CONFIG, stream.generation);
    stream.status = 'running';
    if (restored) {
      await stream.stop(); assert.equal(stream.status, 'stopped'); assert.equal(stream.error, null);
    } else {
      await assert.rejects(stream.stop(), /恢复失败/);
      assert.equal(stream.status, 'error'); assert.equal(stream.error, '恢复失败');
    }
  }
});
