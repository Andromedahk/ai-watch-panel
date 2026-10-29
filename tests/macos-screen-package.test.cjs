const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const beforePack = require('../scripts/check-screen-package.cjs');

function bundle(t, arch = 'arm64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-watch-native-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'build-manifest.json'), JSON.stringify({ platform: 'darwin', arch, minimumMacOS: '15.0' }));
  for (const relative of ['XANALI-Panel-Bridge', '_internal/resources/ffmpeg/ffmpeg', '_internal/resources/libusb/libusb-1.0.0.dylib']) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
    fs.writeFileSync(file, header);
  }
  const daemon = Buffer.alloc(64);
  daemon.set([127, 69, 76, 70, 2, 1]);
  daemon.writeUInt16LE(183, 18);
  fs.writeFileSync(path.join(root, '_internal/resources/streamd-arm64'), daemon);
  return root;
}

for (const arch of ['arm64', 'x64']) {
  test(`Mac package accepts native ${arch} helper with device ARM64 daemon`, t => {
    beforePack.validateBridge(bundle(t, arch), arch);
  });
}
test('Mac packaging rejects a cached helper from the other architecture', t => {
  assert.throws(() => beforePack.validateBridge(bundle(t), 'x64'), /Build the macOS x64/);
});
test('Mac packaging inspects actual Mach-O CPU rather than trusting metadata', t => {
  const root = bundle(t);
  const file = path.join(root, '_internal/resources/libusb/libusb-1.0.0.dylib');
  const bytes = fs.readFileSync(file);
  bytes.writeUInt32LE(0x01000007, 4);
  fs.writeFileSync(file, bytes);
  assert.throws(() => beforePack.validateBridge(root, 'arm64'), /Wrong architecture/);
});
test('Mac packaging rejects Windows executables and host-built device daemons', t => {
  const root = bundle(t);
  const helper = path.join(root, 'XANALI-Panel-Bridge');
  const bytes = fs.readFileSync(helper);
  fs.writeFileSync(helper, 'MZ-Windows-helper');
  assert.throws(() => beforePack.validateBridge(root, 'arm64'), /Mach-O/);
  fs.writeFileSync(helper, bytes);
  fs.writeFileSync(path.join(root, '_internal/resources/streamd-arm64'), bytes);
  assert.throws(() => beforePack.validateBridge(root, 'arm64'), /Linux ARM64/);
});
test('Packaging hook does not require a Mac bridge for Windows or Linux', async () => {
  await beforePack({ electronPlatformName: 'win32' });
  await beforePack({ electronPlatformName: 'linux' });
});
test('Mac packaging checks optional RYUO ADB CPU and permits a compatible universal executable', t => {
  const root = bundle(t);
  const adb = path.join(root, '_internal/resources/adb/adb');
  fs.mkdirSync(path.dirname(adb), { recursive: true });
  fs.copyFileSync(path.join(root, 'XANALI-Panel-Bridge'), adb);
  beforePack.validateBridge(root, 'arm64');
  const bytes = fs.readFileSync(adb);
  bytes.writeUInt32LE(0x01000007, 4);
  fs.writeFileSync(adb, bytes);
  assert.throws(() => beforePack.validateBridge(root, 'arm64'), /Wrong architecture.*ADB/);
  const universal = Buffer.alloc(48);
  universal.writeUInt32BE(0xcafebabe, 0); universal.writeUInt32BE(2, 4);
  universal.writeUInt32BE(0x01000007, 8); universal.writeUInt32BE(0x0100000c, 28);
  fs.writeFileSync(adb, universal);
  beforePack.validateBridge(root, 'arm64');
});

// Execute the real QA bootstrap with mocked process launch: regressions here
// could otherwise open USB from an encoder test on a developer's Mac.
for (const platform of ['win32', 'darwin']) {
  test(`Encoder QA always adds --dry-run to the ${platform} native helper`, () => {
    const launched = [];
    const childProcess = { spawn(command, args) {
      launched.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      return child;
    } };
    const context = {
      process: { platform, env: { AI_WATCH_TEST_PROFILE: 'ai-watch-screen-encoder-unit', AI_WATCH_TEST_STATUS: 'fixture' } },
      __dirname: path.resolve('tests/fixtures'), global: {},
      require(name) {
        if (name === 'node:child_process') return childProcess;
        if (name === 'node:fs') return { statSync: () => ({ isFile: () => true }) };
        if (name === '../../electron/main.cjs') return {};
        return require(name);
      },
    };
    vm.runInNewContext(fs.readFileSync(path.resolve('tests/fixtures/screen-encoder-main.cjs'), 'utf8'), context);
    const name = platform === 'win32' ? 'XANALI-Panel-Bridge.exe' : 'XANALI-Panel-Bridge';
    childProcess.spawn(path.resolve('.local/screen-bridge/XANALI-Panel-Bridge', name), ['--fps', '15']);
    assert.equal(launched.length, 1);
    assert.equal(launched[0].args.at(-1), '--dry-run');
    assert.throws(() => childProcess.spawn(path.resolve('unverified', name), []), /Only the verified local helper/);
    assert.throws(() => childProcess.spawn('python3', ['panel_stream_bridge.py']), /Python bridge fallback/);
    assert.equal(launched.length, 1, 'Rejected launches never reach the OS');
  });
}
