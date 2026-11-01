const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ScreenStream, bridgeCommand, streamAvailability } = require('../electron/screen-stream.cjs');

test('Studio routes packaged and source RYUO video and brightness without replacing other transports', async () => {
  // Existing files stand in for the executables; spawn is observed, never run.
  const env = { RYUO_STUDIO_BRIDGE: process.execPath, RYUO_ADB: __filename,
    RYUO_FFMPEG: require.resolve('../electron/screen-stream.cjs'), RYUO_AI_WATCH_SERIAL: 'fixture-device',
    RYUO_AI_WATCH_APP_ROOT: __dirname };
  const resourcesPath = path.resolve('missing-fixture-resources');
  const root = path.resolve('source-fixture');
  const options = { platform: 'win32', device: 'ryuo4', env, resourcesPath, root };
  const expected = { executable: env.RYUO_STUDIO_BRIDGE, args: ['--studio-v1'], cwd: path.dirname(env.RYUO_STUDIO_BRIDGE) };
  for (const packaged of [true, false]) {
    assert.deepEqual(bridgeCommand({ ...options, packaged }), expected);
    assert.deepEqual(streamAvailability({ ...options, packaged }), { available: true, unavailableReason: null });
  }
  for (const key of Object.keys(env)) {
    const broken = { ...env, [key]: key === 'RYUO_STUDIO_BRIDGE' ? path.join(root, 'missing.exe') : '' };
    assert.equal(streamAvailability({ ...options, packaged: true, env: broken }).available, false, key);
    assert.throws(() => bridgeCommand({ ...options, packaged: true, env: broken }), /RYUO Studio/, key);
  }
  const packagedBridge = path.join(resourcesPath, 'screen-bridge', 'XANALI-Panel-Bridge.exe');
  const macBridge = path.join(resourcesPath, 'screen-bridge', 'XANALI-Panel-Bridge');
  const originalFiles = file => file === packagedBridge || file === macBridge;
  assert.deepEqual(bridgeCommand({ ...options, device: 'zhanyu', packaged: true, fileExists: originalFiles }),
    { executable: packagedBridge, args: [], cwd: path.dirname(packagedBridge) });
  assert.deepEqual(bridgeCommand({ ...options, platform: 'darwin', packaged: true, fileExists: originalFiles }),
    { executable: macBridge, args: [], cwd: path.dirname(macBridge) });
  assert.equal(streamAvailability({ ...options, device: 'zhanyu', packaged: true }).available, false,
    'Studio resources must not make the other device available');
  assert.equal(bridgeCommand({ ...options, packaged: false, env: {} }).args[0], '-u',
    'unconfigured launches keep the original source adapter');
  const manifest = require('../electron/ryuo-studio-adapter.json');
  assert.deepEqual(manifest, { protocol: 'dev.ryuo.aiwatch-studio.v1', bridge_argument: '--studio-v1',
    devices: ['ryuo4'], platforms: ['win32'] });
  assert.ok(require('../package.json').build.win.extraResources.some(resource =>
    resource.from === 'electron/ryuo-studio-adapter.json' && resource.to === 'ryuo-studio-adapter.json'));

  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const config = { device: 'ryuo4', width: 2240, height: 1080, fps: 30, bitrateMbps: 6 };
  let spawned;
  const stream = new ScreenStream({ app: { isPackaged: true }, getConfig: () => config,
    spawnProcess(executable, args, spawnOptions) {
      spawned = { executable, args, spawnOptions };
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'ready' }) + '\n'));
      return child;
    } });
  try {
    Object.assign(process.env, env);
    assert.deepEqual(stream.brightness.command(), expected, 'brightness uses the RYUO adapter');
    await stream.startBridge(config, stream.generation);
    assert.equal(spawned.executable, expected.executable);
    assert.deepEqual(spawned.args.slice(0, 3), ['--studio-v1', '--device', 'ryuo4']);
    assert.equal(spawned.spawnOptions.cwd, expected.cwd);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (stream.child) for (const pipe of [stream.child.stdin, stream.child.stdout, stream.child.stderr]) pipe.destroy();
  }
});
