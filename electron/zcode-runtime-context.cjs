const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const HELPER_TIMEOUT_MS = 2000;
const HELPER_MAX_BYTES = 16 * 1024;
const COMMAND_MAX_BYTES = 1024 * 1024;
const MAX_CHILDREN = 32;
const MAIN_SUFFIX = '/ZCode.app/Contents/MacOS/ZCode';
const HELPER_SUFFIX = '/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper';
const TASKS_SUFFIX = '/.zcode/v2/tasks-index.sqlite';

class ZcodeRuntimeContextError extends Error {
  constructor(code = 'unavailable') { super(code); this.code = code; }
}

function output(value) {
  return typeof value === 'string' ? value : typeof value?.stdout === 'string' ? value.stdout : '';
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function absoluteHome(home) {
  if (typeof home !== 'string' || !home) throw new ZcodeRuntimeContextError();
  return path.resolve(home);
}

function pidValue(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function optionalSelector(selectors, name) {
  const value = selectors[name];
  return value === undefined || value === null ? undefined : typeof value === 'string' ? value : null;
}

function exactOrigin(value, origin, pathname = '/') {
  if (typeof value !== 'string' || !value.trim()) return true;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' && parsed.origin === origin && parsed.pathname === pathname
      && !parsed.search && !parsed.hash && !parsed.username && !parsed.password;
  } catch { return false; }
}

function validateSelectors(selectors, home, secretOverride) {
  if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors) || secretOverride !== false) {
    throw new ZcodeRuntimeContextError('unsupported');
  }
  const normal = {};
  const primaryHome = optionalSelector(selectors, 'HOME');
  if (primaryHome === null || !primaryHome?.trim() || !path.isAbsolute(primaryHome.trim()) || path.resolve(primaryHome.trim()) !== home) {
    throw new ZcodeRuntimeContextError('unsupported');
  }
  normal.HOME = home;
  for (const name of ['USERPROFILE', 'ZCODE_DESKTOP_HOME_DIR', 'ZCODE_DATA_BASE_DIR']) {
    const value = optionalSelector(selectors, name);
    if (value === null) throw new ZcodeRuntimeContextError('unsupported');
    if (value?.trim()) {
      if (!path.isAbsolute(value.trim()) || path.resolve(value.trim()) !== home) throw new ZcodeRuntimeContextError('unsupported');
      normal[name] = home;
    }
  }
  const env = optionalSelector(selectors, 'ZCODE_ENV');
  if (env === null || (env !== undefined && env.trim() && env.trim().toLowerCase() !== 'production')) {
    throw new ZcodeRuntimeContextError('unsupported');
  }
  normal.ZCODE_ENV = env?.trim().toLowerCase() || '';
  for (const name of ['BIGMODEL_API_BASE_URL', 'BIGMODEL_PRODUCTION_API_BASE_URL']) {
    const value = optionalSelector(selectors, name);
    if (value === null || !exactOrigin(value, 'https://bigmodel.cn')) throw new ZcodeRuntimeContextError('unsupported');
    normal[name] = value?.trim() || '';
  }
  const userinfo = optionalSelector(selectors, 'BIGMODEL_OAUTH_USERINFO_URL');
  if (userinfo === null || !exactOrigin(userinfo, 'https://bigmodel.cn', '/api/biz/customer/getCustomerInfo')) {
    throw new ZcodeRuntimeContextError('unsupported');
  }
  normal.BIGMODEL_OAUTH_USERINFO_URL = userinfo?.trim() || '';
  // Test-only addresses are deliberately ignored after ZCODE_ENV has established production.
  for (const name of ['ZCODE_BASE_URL', 'ZCODE_PRODUCTION_BASE_URL', 'ZCODE_ENDPOINT_ORIGIN']) {
    const value = optionalSelector(selectors, name);
    if (value === null || !exactOrigin(value, 'https://zcode.z.ai')) throw new ZcodeRuntimeContextError('unsupported');
    normal[name] = value?.trim() || '';
  }
  return normal;
}

function parseHelper(value, expectedPid) {
  const text = output(value);
  if (!text || Buffer.byteLength(text, 'utf8') > HELPER_MAX_BYTES) throw new ZcodeRuntimeContextError();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new ZcodeRuntimeContextError(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || pidValue(parsed.pid) !== expectedPid
    || !Number.isSafeInteger(parsed.uid) || parsed.uid !== process.getuid?.() || !pidValue(parsed.ppid)
    || !Number.isSafeInteger(parsed.startSeconds) || parsed.startSeconds < 0
    || !Number.isSafeInteger(parsed.startMicros) || parsed.startMicros < 0 || typeof parsed.secretOverride !== 'boolean'
    || typeof parsed.executable !== 'string' || !parsed.executable || parsed.executable.length > 4096) {
    throw new ZcodeRuntimeContextError();
  }
  return parsed;
}

async function helperInfo(pid, helperPath, runCommand) {
  let result;
  try {
    result = await runCommand(helperPath, [String(pid)], { timeout: HELPER_TIMEOUT_MS, maxBuffer: HELPER_MAX_BYTES });
  } catch { throw new ZcodeRuntimeContextError(); }
  return parseHelper(result, pid);
}

function parsePs(value) {
  const rows = [];
  for (const line of output(value).split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]); const ppid = Number(match[2]);
    if (pidValue(pid) && pidValue(ppid) && match[3].length <= 4096) rows.push({ pid, ppid, executable: match[3] });
  }
  return rows;
}

function parseLsof(value) {
  const files = new Map(); let current = null;
  for (const line of output(value).split(/\r?\n/)) {
    if (line.startsWith('p')) { const pid = Number(line.slice(1)); current = pidValue(pid) ? pid : null; if (current && !files.has(current)) files.set(current, []); }
    else if (current && line.startsWith('n')) files.get(current).push(line.slice(1));
  }
  return files;
}

async function command(runCommand, name, args, maxBuffer) {
  try { return output(await runCommand(name, args, { timeout: HELPER_TIMEOUT_MS, maxBuffer })); }
  catch { throw new ZcodeRuntimeContextError(); }
}

function isMain(info) {
  return info.executable.endsWith(MAIN_SUFFIX);
}

async function collect(mainPid, { home, runCommand, helperPath }) {
  const resolvedHome = absoluteHome(home);
  const main = await helperInfo(mainPid, helperPath, runCommand);
  if (!isMain(main)) throw new ZcodeRuntimeContextError();
  const appBundle = main.executable.slice(0, -MAIN_SUFFIX.length);
  const helperExecutable = `${appBundle}${HELPER_SUFFIX}`;
  const ps = parsePs(await command(runCommand, 'ps', ['-axo', 'pid=,ppid=,comm='], COMMAND_MAX_BYTES));
  const children = ps.filter(row => row.ppid === mainPid && row.executable === helperExecutable);
  if (!children.length || children.length > MAX_CHILDREN) throw new ZcodeRuntimeContextError();
  const childIds = children.map(row => row.pid).sort((a, b) => a - b);
  const lsof = parseLsof(await command(runCommand, 'lsof', ['-n', '-P', '-b', '-a', '-p', childIds.join(','), '-Fpn'], COMMAND_MAX_BYTES));
  const canonical = `${resolvedHome}${TASKS_SUFFIX}`;
  const roots = new Set(); const holders = [];
  for (const pid of childIds) {
    const names = lsof.get(pid) || [];
    for (const name of names) if (name.endsWith(TASKS_SUFFIX)) roots.add(name);
    if (names.includes(canonical)) holders.push(pid);
  }
  if (!holders.length) throw new ZcodeRuntimeContextError();
  if (roots.size !== 1 || !roots.has(canonical)) throw new ZcodeRuntimeContextError('unsupported');
  const verified = [];
  for (const pid of holders) {
    const info = await helperInfo(pid, helperPath, runCommand);
    if (info.ppid !== mainPid || info.executable !== helperExecutable) throw new ZcodeRuntimeContextError();
    const selectors = validateSelectors(info.selectors, resolvedHome, info.secretOverride);
    verified.push({ pid: info.pid, uid: info.uid, ppid: info.ppid, startSeconds: info.startSeconds, startMicros: info.startMicros, selectors });
  }
  verified.sort((a, b) => a.pid - b.pid);
  return { main: { pid: main.pid, uid: main.uid, ppid: main.ppid, startSeconds: main.startSeconds, startMicros: main.startMicros, executable: main.executable },
    holders: verified, defaultDataRoot: canonical };
}

function defaultHelperPath(appDir = __dirname) {
  const bundled = path.join(appDir, 'native', 'bin', 'zcode-process-context');
  return bundled.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

async function readZcodeRuntimeContext(mainPid, { home = os.homedir(), runCommand = execute,
  helperPath = defaultHelperPath() } = {}) {
  if (!pidValue(mainPid) || typeof helperPath !== 'string' || !helperPath) throw new ZcodeRuntimeContextError();
  const first = await collect(mainPid, { home, runCommand, helperPath });
  const second = await collect(mainPid, { home, runCommand, helperPath });
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new ZcodeRuntimeContextError();
  return { fingerprint: hash(first) };
}

module.exports = { ZcodeRuntimeContextError, validateSelectors, parseHelper, parsePs, parseLsof, defaultHelperPath, readZcodeRuntimeContext };
