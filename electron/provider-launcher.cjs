const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { PROVIDER_ORDER } = require('./window-policy.cjs');

// Discovery uses verified bundle identities, never a guessed URL scheme or a shell command.
const MAC_BUNDLE_IDS = Object.freeze({
  claude: ['com.anthropic.claudefordesktop'],
  codex: ['com.openai.codex'],
  antigravity: ['com.google.antigravity'],
  deepseek: ['com.deepseek.dsh'],
  zcode: [], kimi: [],
  qwen: ['com.alibaba.tongyi'],
  workbuddy: ['com.tencent.workbuddy.mac'],
});
const LABELS = Object.freeze({ claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', deepseek: 'DeepSeek Harness', zcode: 'ZCode', kimi: 'Kimi Code', qwen: '千问', workbuddy: 'WorkBuddy' });
const MISSING_MESSAGE = '未找到桌面应用，请在设置中选择启动应用。';
function isProvider(value) { return typeof value === 'string' && PROVIDER_ORDER.includes(value); }
function requireProvider(value) { if (!isProvider(value)) throw new Error('Invalid provider'); }

async function readPlist(file, key) {
  const result = await execFileAsync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], { timeout: 3000, maxBuffer: 4096 });
  return result.stdout.trim();
}
async function validateExecutable(file, platform = process.platform, io = fs.promises, plist = readPlist) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || file.length > 4096) return null;
  try {
    const resolved = await io.realpath(file);
    const stat = await io.stat(resolved);
    if (platform === 'darwin') {
      if (!stat.isDirectory() || path.extname(resolved).toLowerCase() !== '.app') return null;
      const info = path.join(resolved, 'Contents', 'Info.plist');
      const executable = await plist(info, 'CFBundleExecutable');
      if (!executable || executable === '.' || executable === '..' || /[\\/\0]/.test(executable)) return null;
      const binary = path.join(resolved, 'Contents', 'MacOS', executable);
      const binaryStat = await io.stat(binary);
      if (!binaryStat.isFile() || !(binaryStat.mode & 0o111)) return null;
    } else if (platform === 'win32') {
      if (!stat.isFile() || path.extname(resolved).toLowerCase() !== '.exe') return null;
    } else if (platform === 'linux') {
      if (!stat.isFile() || !(stat.mode & 0o111)) return null;
      const handle = await io.open(resolved, 'r');
      try {
        const magic = Buffer.alloc(4);
        const { bytesRead } = await handle.read(magic, 0, 4, 0);
        if (bytesRead !== 4 || !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return null;
      } finally { await handle.close(); }
    } else return null;
    return resolved;
  } catch { return null; }
}

async function discoverMacApp(id, options = {}) {
  requireProvider(id);
  const io = options.io || fs.promises;
  const plist = options.plist || readPlist;
  const identities = id === 'kimi' && options.kimiSource === 'work' ? ['com.moonshot.kimichat'] : MAC_BUNDLE_IDS[id];
  if (!identities.length) return null;
  const roots = options.roots || ['/Applications', path.join(os.homedir(), 'Applications')];
  // Scan only the two conventional application folders and one category level.
  // Bound the scan; never traverse app contents, home directories, or mounted disks.
  let scanned = 0;
  for (const root of roots) {
    let entries;
    try { entries = await io.readdir(root, { withFileTypes: true }); } catch { continue; }
    const candidates = [];
    for (const entry of entries.slice(0, 512)) {
      if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
      const file = path.join(root, entry.name);
      if (entry.name.toLowerCase().endsWith('.app')) candidates.push(file);
      else if (entry.isDirectory()) {
        try {
          const nested = await io.readdir(file, { withFileTypes: true });
          for (const child of nested.slice(0, 128)) {
            if ((child.isDirectory() || child.isSymbolicLink()) && child.name.toLowerCase().endsWith('.app')) candidates.push(path.join(file, child.name));
          }
        } catch { /* Missing or inaccessible categories are skipped. */ }
      }
    }
    for (const candidate of candidates) {
      if (++scanned > 512) return null;
      try {
        const identity = await plist(path.join(candidate, 'Contents', 'Info.plist'), 'CFBundleIdentifier');
        if (identities.includes(identity)) {
          const valid = await validateExecutable(candidate, 'darwin', io, plist);
          if (valid) return valid;
        }
      } catch { /* A broken app or unrelated bundle is not a match. */ }
    }
  }
  return null;
}

async function openExecutable(file, platform) {
  if (platform === 'darwin') {
    await execFileAsync('/usr/bin/open', ['-a', file], { timeout: 8000, maxBuffer: 4096 });
    return;
  }
  await new Promise((resolve, reject) => {
    const child = spawn(file, [], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

class ProviderLauncher {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.fixtureMode = options.fixtureMode === true;
    this.discover = options.discover || ((id, source) => discoverMacApp(id, { kimiSource: source }));
    this.validate = options.validate || (file => validateExecutable(file, this.platform));
    this.open = options.open || (file => openExecutable(file, this.platform));
    this.now = options.now || Date.now;
    this.pending = new Map();
    this.recent = new Map();
  }
  async launch(id, customPath, kimiSource = 'code') {
    requireProvider(id);
    if (!['code', 'work'].includes(kimiSource)) throw new Error('Invalid Kimi source');
    const label = id === 'kimi' && kimiSource === 'work' ? 'Kimi Work' : LABELS[id];
    const key = id === 'kimi' ? `${id}:${kimiSource}` : id;
    if (this.fixtureMode) return { status: 'test', message: `测试模式：已模拟打开 ${label}。` };
    if (!['darwin', 'win32', 'linux'].includes(this.platform)) return { status: 'unsupported', message: '当前系统暂不支持打开应用。' };
    if (this.pending.has(key)) return this.pending.get(key);
    const previous = this.recent.get(key);
    if (previous && previous.path === customPath && this.now() - previous.at < 2000) return previous.result;
    const attempt = (async () => {
      try {
        // An explicitly selected app always wins. Missing selections are not replaced silently.
        const file = customPath ? await this.validate(customPath) : (this.platform === 'darwin' ? await this.discover(id, kimiSource) : null);
        if (!file) return { status: 'missing', message: MISSING_MESSAGE };
        await this.open(file);
        return { status: 'opened', message: `已请求打开 ${label}。` };
      } catch { return { status: 'error', message: '应用未能打开，请检查安装状态或重新选择启动应用。' }; }
    })();
    this.pending.set(key, attempt);
    try {
      const result = await attempt;
      if (result.status === 'opened') this.recent.set(key, { at: this.now(), path: customPath, result });
      return result;
    } finally { this.pending.delete(key); }
  }
  async choose(id, showDialog, save, kimiSource = 'code') {
    requireProvider(id);
    if (!['code', 'work'].includes(kimiSource)) throw new Error('Invalid Kimi source');
    const label = id === 'kimi' && kimiSource === 'work' ? 'Kimi Work' : LABELS[id];
    if (this.fixtureMode) return { status: 'selected', message: `测试模式：已模拟选择 ${label} 的启动应用。` };
    if (!['darwin', 'win32', 'linux'].includes(this.platform)) return { status: 'error', message: '当前系统暂不支持选择启动应用。' };
    try {
      const result = await showDialog({
        title: `选择 ${label} 的启动应用`, properties: ['openFile'],
        ...(this.platform === 'darwin' ? { filters: [{ name: '应用', extensions: ['app'] }] }
          : this.platform === 'win32' ? { filters: [{ name: '应用', extensions: ['exe'] }] } : {}),
      });
      if (result.canceled) return { status: 'cancelled', message: '已取消选择。' };
      if (result.filePaths?.length !== 1) return { status: 'error', message: '请选择一个有效的应用。' };
      const valid = await this.validate(result.filePaths[0]);
      if (!valid) return { status: 'error', message: this.platform === 'linux' ? '请选择可执行的应用程序或 AppImage。' : '请选择有效的已安装应用。' };
      await save(id, valid);
      this.recent.delete(id);
      this.recent.delete(`${id}:${kimiSource}`);
      return { status: 'selected', message: `已设置 ${label} 的启动应用。` };
    } catch { return { status: 'error', message: '无法保存启动应用，请重试。' }; }
  }
}
module.exports = { ProviderLauncher, isProvider, validateExecutable, discoverMacApp, MAC_BUNDLE_IDS };
