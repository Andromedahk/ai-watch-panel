const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { DEFAULT_STREAM_CONFIG, streamPreferences, validateStreamConfig } = require('../electron/screen-stream-policy.cjs');
const { FramePump, ScreenStream, bridgeCommand, streamAvailability, streamDeviceAvailability } = require('../electron/screen-stream.cjs');
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

test('RYUO uses native HEVC defaults and rejects dimensions outside the physical screen', () => {
  const config = validateStreamConfig({ device: 'ryuo4' });
  assert.equal(config.width, 2240); assert.equal(config.height, 1080);
  assert.equal(config.bitrateMbps, 6); assert.equal(config.fps, 30);
  assert.equal(config.agentsPerPage, 4);
  assert.equal(validateStreamConfig({ device: 'ryuo4', agentsPerPage: 6 }).agentsPerPage, 6);
  assert.throws(() => validateStreamConfig({ agentsPerPage: 5 }), /page size/);
  assert.throws(() => validateStreamConfig({ agentsPerPage: '6' }), /page size/);
  assert.equal(validateStreamConfig({ device: 'ryuo4', width: 1920, height: 1080 }).height, 1080);
  for (const dimensions of [{ width: 2242, height: 926 }, { width: 1920, height: 1090 }, { width: 1080, height: 1920 }]) {
    assert.throws(() => validateStreamConfig({ device: 'ryuo4', ...dimensions }), /resolution/);
  }
  assert.equal(validPreferences({ stream: { device: 'ryuo4', enabled: true } }).stream.device, 'ryuo4');
  assert.equal(validPreferences({ stream: { device: 'ryuo4', enabled: true } }).stream.width, 2240);
  assert.equal(validPreferences({ stream: { device: 'ryuo4', enabled: true } }).stream.enabled, true);
});

test('packaged RYUO needs its own ADB resources and does not depend on the Zhanyu daemon or libusb', () => {
  const resourcesPath = path.resolve('ryuo-fixture'), bundle = path.join(resourcesPath, 'screen-bridge');
  const resources = path.join(bundle, '_internal', 'resources');
  const files = new Set([path.join(bundle, 'XANALI-Panel-Bridge'), path.join(resources, 'ffmpeg', 'ffmpeg')]);
  const options = { packaged: true, platform: 'darwin', osRelease: '24.0.0', arch: 'arm64', resourcesPath,
    env: { RYUO_ADB: '/external/adb', PATH: '/external' }, fileExists: file => files.has(file) };
  files.add('/external/adb');
  assert.match(streamAvailability({ ...options, device: 'ryuo4' }).unavailableReason, /缺少 ADB/);
  files.add(path.join(resources, 'adb', 'adb'));
  assert.deepEqual(streamAvailability({ ...options, device: 'ryuo4' }), { available: true, unavailableReason: null });
  const capabilities = streamDeviceAvailability(options);
  assert.equal(capabilities.ryuo4.available, true);
  assert.equal(capabilities.zhanyu.available, false);
  assert.equal(Object.hasOwn(capabilities.ryuo4, 'adbPath'), false, 'renderer gets capabilities, never local tool paths');
  assert.equal(streamAvailability({ ...options, device: '__proto__', preview: true }).available, false);
});

test('Windows RYUO bundle requires both platform-tools DLLs', () => {
  const resourcesPath = path.resolve('ryuo-win-fixture'), bundle = path.join(resourcesPath, 'screen-bridge');
  const resources = path.join(bundle, '_internal', 'resources');
  const files = new Set(['XANALI-Panel-Bridge.exe', '_internal/resources/ffmpeg/ffmpeg.exe', '_internal/resources/adb/adb.exe'].map(name => path.join(bundle, name)));
  const options = { packaged: true, device: 'ryuo4', platform: 'win32', resourcesPath, fileExists: file => files.has(file) };
  assert.match(streamAvailability(options).unavailableReason, /运行库不完整/);
  files.add(path.join(resources, 'adb', 'AdbWinApi.dll'));
  assert.equal(streamAvailability(options).available, false);
  files.add(path.join(resources, 'adb', 'AdbWinUsbApi.dll'));
  assert.equal(streamAvailability(options).available, true);
});

test('only source-mode RYUO resolves an explicitly supplied or PATH ADB', () => {
  const root = path.resolve('ryuo-source-fixture');
  const files = new Set(['app/panel_stream_bridge.py', 'resources/ffmpeg/ffmpeg'].map(name => path.join(root, 'screen-bridge', name)));
  files.add('/dev-tools/adb');
  const options = { root, device: 'ryuo4', platform: 'darwin', osRelease: '24.0.0', arch: 'arm64', fileExists: file => files.has(file) };
  assert.equal(streamAvailability({ ...options, env: { RYUO_ADB: '/dev-tools/adb' } }).available, true);
  assert.equal(streamAvailability({ ...options, env: { PATH: '/dev-tools' } }).available, true);
  assert.equal(streamAvailability({ ...options, env: { RYUO_ADB: '/missing/adb', PATH: '/dev-tools' } }).available, false);
  files.add(path.join(root, '.local/screen-bridge/XANALI-Panel-Bridge/XANALI-Panel-Bridge'));
  assert.equal(streamAvailability({ ...options, env: { RYUO_ADB: '/dev-tools/adb' } }).available, false);
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
  for (const options of [{ platform: 'linux' }, { platform: 'darwin', osRelease: '23.6.0' }, { platform: 'darwin', osRelease: 'unknown' }]) {
    const state = streamAvailability({ ...options, fileExists: () => assert.fail('unsupported platforms must not probe a bridge') });
    assert.equal(state.available, false);
    assert.match(state.unavailableReason, /Windows|macOS 15/);
  }
  assert.deepEqual(streamAvailability({ platform: 'darwin', packaged: true, preview: true,
    fileExists: () => assert.fail('fixture preview must not require production components') }), { available: true, unavailableReason: null });
});

test('macOS 15+ on both native architectures requires its native bridge, encoder and libusb', () => {
  const resourcesPath = path.resolve('mac-fixture-resources'), bundle = path.join(resourcesPath, 'screen-bridge');
  const files = new Set([path.join(bundle, 'XANALI-Panel-Bridge.exe'),
    path.join(bundle, '_internal/resources/ffmpeg/ffmpeg.exe'), path.join(bundle, '_internal/resources/streamd-arm64')]);
  for (const arch of ['arm64', 'x64']) {
    const options = { packaged: true, platform: 'darwin', osRelease: '24.0.0', arch, resourcesPath, fileExists: file => files.has(file) };
    assert.equal(streamAvailability(options).available, false, 'Windows executables never satisfy a native Mac build');
    files.add(path.join(bundle, 'XANALI-Panel-Bridge'));
    files.add(path.join(bundle, '_internal/resources/ffmpeg/ffmpeg'));
    assert.equal(streamAvailability(options).available, false, 'libusb is mandatory before enabling Mac USB streaming');
    files.add(path.join(bundle, '_internal/resources/libusb/libusb-1.0.0.dylib'));
    assert.equal(streamAvailability(options).available, true);
    assert.equal(streamAvailability({ ...options, osRelease: '25.1.0' }).available, true);
    assert.equal(streamAvailability({ ...options, arch: 'ia32' }).available, false);
    assert.deepEqual(bridgeCommand(options), { executable: path.join(bundle, 'XANALI-Panel-Bridge'), args: [], cwd: bundle });
    files.delete(path.join(bundle, 'XANALI-Panel-Bridge'));
    files.delete(path.join(bundle, '_internal/resources/libusb/libusb-1.0.0.dylib'));
  }
});

test('Mac source and prebuilt bridge resolve within the project, with python3 only as a source fallback', () => {
  const root = path.resolve('mac-fixture-repo'), files = new Set();
  const options = { platform: 'darwin', osRelease: '24.3.0', arch: 'arm64', root, env: {}, fileExists: file => files.has(file) };
  for (const name of ['app/panel_stream_bridge.py', 'resources/ffmpeg/ffmpeg', 'resources/streamd-arm64', 'resources/libusb/libusb-1.0.0.dylib']) {
    files.add(path.join(root, 'screen-bridge', name));
  }
  assert.equal(streamAvailability(options).available, true);
  assert.equal(bridgeCommand(options).executable, 'python3');
  const binary = path.join(root, '.local/screen-bridge/XANALI-Panel-Bridge/XANALI-Panel-Bridge');
  files.add(binary);
  assert.equal(bridgeCommand(options).executable, binary);
  assert.equal(streamAvailability(options).available, false, 'an incomplete chosen bundle is not replaced silently');
  const source = { ...options, env: { XANALI_PYTHON: '/fixture/python3' } };
  assert.equal(bridgeCommand(source).executable, '/fixture/python3');
  assert.equal(streamAvailability(source).available, true);
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

test('frame pump waits for bridge readiness then sends new paints without a polling interval', () => {
  const writes = [];
  const pump = new FramePump({ write: (frame, done) => { writes.push(frame.toString()); done(); } });
  pump.update(Buffer.from('initial')); pump.tick();
  assert.deepEqual(writes, [], 'no input before the bridge is ready');
  pump.update(Buffer.from('ready'));
  pump.start();
  assert.deepEqual(writes, ['ready']);
  pump.update(Buffer.from('paint'));
  assert.deepEqual(writes, ['ready', 'paint'], 'a paint is sent immediately without waiting for a timer');
  pump.tick(); pump.start();
  assert.deepEqual(writes, ['ready', 'paint'], 'the bridge, not the parent pipe, repeats static frames');
  assert.equal(pump.frames, 2);
  assert.equal(pump.droppedFrames, 1, 'count only the obsolete bitmap that was replaced');
  pump.close(); pump.start(); pump.update(Buffer.from('closed'));
  assert.deepEqual(writes, ['ready', 'paint']);
});

test('frame pump keeps one write in flight and immediately drains the latest paint under backpressure', () => {
  const writes = [], callbacks = [];
  const pump = new FramePump({ write: (frame, done) => { writes.push(frame); callbacks.push(done); } });
  pump.start(); pump.update(Buffer.from('first'));
  pump.update(Buffer.from('superseded'));
  pump.update(Buffer.from('latest'));
  assert.equal(writes.length, 1);
  assert.equal(pump.droppedFrames, 1);
  callbacks.shift()();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].toString(), 'latest');
  pump.update(Buffer.from('pending-at-stop'));
  pump.close(); callbacks.shift()(); pump.tick();
  assert.equal(writes.length, 2, 'a late pipe callback cannot resume a closed stream');
  assert.equal(pump.latest, null);
});

test('write failures surface once and late callbacks after stop cannot restart work', () => {
  const errors = [];
  let callback;
  const pump = new FramePump({ write: (_frame, done) => { callback = done; }, onError: error => errors.push(error.message) });
  pump.start(); pump.update(Buffer.from('x')); callback(new Error('broken'));
  assert.deepEqual(errors, ['broken']);
  pump.update(Buffer.from('retry')); pump.tick(); pump.close(); callback(new Error('closed')); pump.tick();
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
    const sent = stream.state().frames;
    output.webContents.emit('paint', {}, {}, { isEmpty: () => false, getSize: () => ({ width: 640, height: 360 }), toBitmap: () => Buffer.alloc(640 * 360 * 4) });
    assert.equal(stream.state().frames, sent + 1, 'the running output sends a new paint immediately');
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
