// The helper contains native Python extensions and cannot be reused across hosts.
const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('builder-util');

function readArchitecture(file) {
  const header = Buffer.alloc(8);
  const descriptor = fs.openSync(file, 'r');
  let length;
  try { length = fs.readSync(descriptor, header, 0, 8, 0); }
  finally { fs.closeSync(descriptor); }
  if (length !== 8 || header.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`Expected a native 64-bit Mach-O file: ${path.basename(file)}`);
  }
  const cpu = header.readUInt32LE(4);
  if (cpu === 0x0100000c) return 'arm64';
  if (cpu === 0x01000007) return 'x64';
  throw new Error(`Unsupported Mach-O CPU: ${path.basename(file)}`);
}

function validateOptionalAdb(file, arch) {
  if (!fs.existsSync(file)) return;
  const bytes = fs.readFileSync(file);
  const magic = bytes.length >= 8 ? bytes.readUInt32BE(0) : 0;
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) {
    if (readArchitecture(file) !== arch) throw new Error('Wrong architecture in optional RYUO IV ADB runtime');
    return;
  }
  const count = bytes.readUInt32BE(4), size = magic === 0xcafebabf ? 32 : 20;
  if (count < 1 || count > 8 || bytes.length < 8 + count * size) throw new Error('Invalid universal ADB runtime');
  const expected = arch === 'arm64' ? 0x0100000c : 0x01000007;
  let supported = false;
  for (let index = 0; index < count; index++) {
    const cpu = bytes.readUInt32BE(8 + index * size);
    if (![0x0100000c, 0x01000007].includes(cpu)) throw new Error('Unsupported architecture in optional ADB runtime');
    supported ||= cpu === expected;
  }
  if (!supported) throw new Error('Wrong architecture in optional RYUO IV ADB runtime');
}

function validateBridge(root, arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Build macOS arm64 and x64 separately on matching native hosts.');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'build-manifest.json'), 'utf8'));
  if (manifest.platform !== 'darwin' || manifest.arch !== arch || manifest.minimumMacOS !== '15.0') {
    throw new Error(`Build the macOS ${arch} screen bridge with npm run build:screen-bridge:mac before packaging.`);
  }
  for (const relative of ['XANALI-Panel-Bridge', '_internal/resources/ffmpeg/ffmpeg', '_internal/resources/libusb/libusb-1.0.0.dylib']) {
    if (readArchitecture(path.join(root, relative)) !== arch) throw new Error(`Wrong architecture in screen-bridge/${relative}`);
  }
  validateOptionalAdb(path.join(root, '_internal/resources/adb/adb'), arch);
  const daemon = fs.readFileSync(path.join(root, '_internal/resources/streamd-arm64'));
  if (daemon.length < 20 || !daemon.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) || daemon.readUInt16LE(18) !== 183) {
    throw new Error('The display daemon must be Linux ARM64 on either Mac architecture.');
  }
}

module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = typeof context.arch === 'string' ? context.arch : Arch[context.arch];
  validateBridge(path.join(context.packager.projectDir, '.local/screen-bridge/XANALI-Panel-Bridge'), arch);
};
module.exports.validateBridge = validateBridge;
module.exports.readArchitecture = readArchitecture;
module.exports.validateOptionalAdb = validateOptionalAdb;
