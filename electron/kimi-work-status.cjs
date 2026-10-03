const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { KimiWorkError, normalizeKimiWorkSubscription, requestKimiWorkSubscription } = require('./kimi-work-api.cjs');

const execute = promisify(execFile);
const REFRESH_MS = 60 * 1000;
const HISTORY_FRESH_MS = 2 * REFRESH_MS;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 16 * 1024;
const CONTEXT_TIMEOUT_MS = 2000;
const CLIENT_ID = 'ai-watch-panel';

const DETAILS = {
  login: 'Kimi Work 当前没有可验证的登录态；请在客户端确认登录状态。',
  expired: 'Kimi Work 登录已过期；请打开客户端完成续期。面板不会刷新或修改令牌。',
  permissions: 'Kimi Work 本地登录记录或身份通道的权限不符合要求。',
  unsupported: '当前 Kimi Work 账户区域或自定义数据目录尚未验证，额度保持未知。',
  ambiguous: '发现多个可用的 Kimi Work 身份通道，暂不选择账户。',
  unavailable: '未发现可验证的 Kimi Work 主进程与身份通道。',
  format: 'Kimi Work 本地记录或额度格式暂不兼容。',
  network: 'Kimi Work 额度查询暂时失败，历史快照不代表当前剩余额度。',
  rate: 'Kimi Work 账户服务要求稍后重试。',
};

class KimiWorkStatusError extends Error {
  constructor(code, retryMs = REFRESH_MS) { super(code); this.code = code; this.retryMs = retryMs; }
}

function resolveKimiWorkPaths({ home = os.homedir(), platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new KimiWorkStatusError('unsupported');
  const userData = path.join(home, 'Library', 'Application Support', 'kimi-desktop');
  const share = path.join(userData, 'daimon-share');
  return { userData, pointer: path.join(userData, 'daimon-storage.json'), share,
    config: path.join(share, 'daimon', 'config.json') };
}

function isKimiWorkProcess(command) {
  return typeof command === 'string' && /(?:^|\/)Kimi\.app\/Contents\/MacOS\/Kimi$/.test(command);
}

function hash(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function lstatOrNull(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function ensureContainedPath(file, root) {
  const resolvedRoot = path.resolve(root); const resolvedFile = path.resolve(file);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new KimiWorkStatusError('permissions');
  let canonicalRoot;
  try { canonicalRoot = await fs.realpath(resolvedRoot); }
  catch (error) { if (error.code === 'ENOENT') throw error; throw new KimiWorkStatusError('permissions'); }
  const rootStat = await fs.lstat(resolvedRoot);
  if (canonicalRoot !== resolvedRoot || rootStat.isSymbolicLink() || !rootStat.isDirectory()
    || rootStat.uid !== process.getuid?.()) throw new KimiWorkStatusError('permissions');
  let current = resolvedRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (stat?.isSymbolicLink()) throw new KimiWorkStatusError('permissions');
  }
}

async function readPrivateJson(file, root, maxBytes = MAX_CONFIG_BYTES) {
  await ensureContainedPath(file, root);
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes
    || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600) throw new KimiWorkStatusError('permissions');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes
      || opened.uid !== before.uid || (opened.mode & 0o777) !== 0o600) throw new KimiWorkStatusError('permissions');
    const buffer = Buffer.alloc(maxBytes + 1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset > maxBytes) throw new KimiWorkStatusError('format');
    try { return { value: JSON.parse(buffer.subarray(0, offset).toString('utf8')), stat: opened }; }
    catch { throw new KimiWorkStatusError('format'); }
  } finally { await handle.close(); }
}

function parseJwt(token, now) {
  if (typeof token !== 'string' || token.length > 16384 || !/^[\x21-\x7e]+$/.test(token)) throw new KimiWorkStatusError('login');
  const parts = token.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new KimiWorkStatusError('login');
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { throw new KimiWorkStatusError('login'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256
    || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw new KimiWorkStatusError('login');
  if (payload.exp * 1000 <= now + 5000) throw new KimiWorkStatusError('expired');
  return { sub: payload.sub, exp: payload.exp };
}

async function readCredentials(paths, now) {
  if (await lstatOrNull(paths.pointer)) throw new KimiWorkStatusError('unsupported');
  let record;
  try { record = await readPrivateJson(paths.config, paths.userData); }
  catch (error) { if (error.code === 'ENOENT') throw new KimiWorkStatusError('login'); throw error; }
  const credentials = record.value?.credentials?.kimiWeb;
  const token = credentials?.accessToken; const uid = credentials?.userId;
  const jwt = parseJwt(token, now);
  if (typeof uid !== 'string' || !uid || uid.length > 256 || uid !== jwt.sub) throw new KimiWorkStatusError('login');
  return { token, uid, credential: hash([uid, token]),
    snapshot: hash([record.stat.dev, record.stat.ino, record.stat.size, record.stat.mtimeMs]) };
}

function commandOutput(value) {
  return typeof value === 'string' ? value : typeof value?.stdout === 'string' ? value.stdout : '';
}

async function verifyProcess(processes, runCommand = execute) {
  if (!Array.isArray(processes)) throw new KimiWorkStatusError('unavailable');
  const matches = processes.filter(row => Number.isSafeInteger(row?.pid) && row.pid > 0 && isKimiWorkProcess(row.command));
  if (matches.length !== 1) throw new KimiWorkStatusError(matches.length > 1 ? 'ambiguous' : 'unavailable');
  const row = matches[0]; let output;
  try { output = commandOutput(await runCommand('ps', ['-ww', '-p', String(row.pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'comm='], { timeout: 2000, maxBuffer: 65536 })); }
  catch { throw new KimiWorkStatusError('unavailable'); }
  const match = output.trim().match(/^(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
  if (!match || Number(match[1]) !== process.getuid?.() || !isKimiWorkProcess(match[3]) || match[3] !== row.command) throw new KimiWorkStatusError('unavailable');
  return { pid: row.pid, command: row.command, fingerprint: hash([row.pid, match[1], match[2], match[3]]) };
}

async function socketRecord(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 512) throw new KimiWorkStatusError('permissions');
  let canonical; let original;
  try { original = await fs.lstat(endpoint); canonical = await fs.realpath(endpoint); }
  catch { throw new KimiWorkStatusError('unavailable'); }
  if (original.isSymbolicLink() || !original.isSocket()) throw new KimiWorkStatusError('permissions');
  if (!/^\/private\/tmp\/kimi-work-[^/]+\/context\.sock$/.test(canonical)
    && !/^\/tmp\/kimi-work-[^/]+\/context\.sock$/.test(canonical)) throw new KimiWorkStatusError('permissions');
  const directory = path.dirname(canonical);
  const [socket, parent] = await Promise.all([fs.lstat(canonical), fs.lstat(directory)]);
  if (socket.isSymbolicLink() || !socket.isSocket() || parent.isSymbolicLink() || !parent.isDirectory()
    || socket.uid !== process.getuid?.() || parent.uid !== process.getuid?.()
    || (socket.mode & 0o777) !== 0o600 || (parent.mode & 0o777) !== 0o700) throw new KimiWorkStatusError('permissions');
  return { endpoint: canonical, dev: socket.dev, ino: socket.ino, directoryDev: parent.dev, directoryIno: parent.ino };
}

async function discoverSocket(processInfo, runCommand = execute) {
  let output;
  try { output = commandOutput(await runCommand('lsof', ['-a', '-p', String(processInfo.pid), '-U', '-Fn'], { timeout: 2000, maxBuffer: 65536 })); }
  catch { throw new KimiWorkStatusError('unavailable'); }
  const names = [...new Set(output.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1))
    .filter(name => /(?:^|\/)kimi-work-[^/]+\/context\.sock$/.test(name)))];
  if (names.length !== 1) throw new KimiWorkStatusError(names.length > 1 ? 'ambiguous' : 'unavailable');
  return socketRecord(names[0]);
}

function queryContext(endpoint, { connect = net.createConnection, timeoutMs = CONTEXT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let socket; let done = false; let bytes = 0; const chunks = [];
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); socket?.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new KimiWorkStatusError('unavailable')), Math.max(1, Math.min(CONTEXT_TIMEOUT_MS, timeoutMs)));
    try {
      socket = connect(endpoint);
      socket.once('connect', () => socket.write(JSON.stringify({ op: 'get_user_info', client_id: CLIENT_ID }) + '\n'));
      socket.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_CONTEXT_BYTES) { finish(new KimiWorkStatusError('format')); return; }
        chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        if (buffer.subarray(newline + 1).some(byte => ![10, 13, 32, 9].includes(byte))) { finish(new KimiWorkStatusError('format')); return; }
        let value;
        try { value = JSON.parse(buffer.subarray(0, newline).toString('utf8')); }
        catch { finish(new KimiWorkStatusError('format')); return; }
        finish(null, value);
      });
      socket.once('error', () => finish(new KimiWorkStatusError('unavailable')));
      socket.once('end', () => finish(new KimiWorkStatusError('format')));
    } catch { finish(new KimiWorkStatusError('unavailable')); }
  });
}

async function readWorkIdentity(processes, { home = os.homedir(), platform = process.platform, now = Date.now(), runCommand = execute,
  query = queryContext } = {}) {
  if (platform !== 'darwin') throw new KimiWorkStatusError('unsupported');
  const paths = resolveKimiWorkPaths({ home, platform });
  const processInfo = await verifyProcess(processes, runCommand);
  const beforeCredential = await readCredentials(paths, now);
  const beforeSocket = await discoverSocket(processInfo, runCommand);
  const user = await query(beforeSocket.endpoint);
  if (user?.error) throw new KimiWorkStatusError(user.error === 'not_authenticated' ? 'login' : 'unavailable');
  if (!user || typeof user !== 'object' || Array.isArray(user) || Object.keys(user).some(key => !['uid', 'user_region'].includes(key))
    || typeof user.uid !== 'string' || user.uid !== beforeCredential.uid) throw new KimiWorkStatusError('login');
  if (user.user_region !== 'cn') throw new KimiWorkStatusError('unsupported');
  const [afterCredential, afterProcess] = await Promise.all([
    readCredentials(paths, now), verifyProcess(processes, runCommand),
  ]);
  const afterSocket = await discoverSocket(afterProcess, runCommand);
  if (afterCredential.credential !== beforeCredential.credential || afterCredential.snapshot !== beforeCredential.snapshot
    || afterCredential.uid !== beforeCredential.uid
    || afterSocket.endpoint !== beforeSocket.endpoint || afterSocket.dev !== beforeSocket.dev || afterSocket.ino !== beforeSocket.ino
    || afterSocket.directoryDev !== beforeSocket.directoryDev || afterSocket.directoryIno !== beforeSocket.directoryIno
    || afterProcess.fingerprint !== processInfo.fingerprint) throw new KimiWorkStatusError('unavailable');
  return { token: beforeCredential.token, uid: beforeCredential.uid, region: 'cn',
    signature: hash([beforeCredential.credential, processInfo.fingerprint, beforeSocket.dev, beforeSocket.ino,
      beforeSocket.directoryDev, beforeSocket.directoryIno]) };
}

function identityShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.token !== 'string'
    || typeof value.uid !== 'string' || !value.uid || value.uid.length > 256 || value.region !== 'cn'
    || typeof value.signature !== 'string' || !/^[a-f0-9]{64}$/.test(value.signature)) throw new KimiWorkStatusError('unavailable');
  return value;
}

class KimiWorkStatusReader {
  constructor({ home = os.homedir(), platform = process.platform, readIdentity = readWorkIdentity,
    request = requestKimiWorkSubscription, runCommand = execute } = {}) {
    this.home = home; this.platform = platform; this.readIdentity = readIdentity; this.request = request; this.runCommand = runCommand;
    this.cache = null; this.identity = null; this.nextAt = 0; this.error = 'unavailable'; this.pending = null;
    this.cooldowns = new Map();
  }
  clear(code) { this.cache = null; this.identity = null; this.nextAt = 0; this.error = code; }
  async sample(processes, now, force) {
    const started = Date.now();
    const currentTime = () => now + Math.max(0, Date.now() - started);
    let grant;
    try { grant = identityShape(await this.readIdentity(processes, { home: this.home, platform: this.platform, now, runCommand: this.runCommand })); }
    catch (error) { this.clear(error?.code || 'unavailable'); return; }
    if (this.identity !== grant.signature) { this.cache = null; this.nextAt = 0; this.identity = grant.signature; }
    const account = hash([grant.region, grant.uid]);
    for (const [key, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(key);
    if (now < (this.cooldowns.get(account) || 0)) { this.error = 'rate'; return; }
    if (now < this.nextAt && (!force || this.error === 'rate')) return;
    if (!force && this.cache && now - this.cache.at < REFRESH_MS) return;
    let normalized; let failure = null;
    try { normalized = normalizeKimiWorkSubscription(await this.request(grant.token), now); }
    catch (error) { failure = error instanceof KimiWorkError || error instanceof KimiWorkStatusError ? error : new KimiWorkStatusError('network'); }
    if (failure?.code === 'rate') {
      if (this.cooldowns.size >= 16 && !this.cooldowns.has(account)) this.cooldowns.delete(this.cooldowns.keys().next().value);
      this.cooldowns.set(account, currentTime() + Math.max(REFRESH_MS, failure.retryMs));
    }
    let latest;
    try { latest = identityShape(await this.readIdentity(processes, { home: this.home, platform: this.platform, now: currentTime(), runCommand: this.runCommand })); }
    catch (error) { this.clear(error?.code || 'unavailable'); return; }
    if (latest.signature !== grant.signature) { this.clear('unavailable'); return; }
    this.nextAt = currentTime() + Math.max(REFRESH_MS, failure?.retryMs || 0);
    this.error = failure?.code || null;
    if (failure?.code === 'login' || failure?.code === 'expired') { this.cache = null; return; }
    if (!failure) this.cache = { ...normalized, at: now };
  }
  async poll(processes, now = Date.now(), force = false) {
    if (this.pending) return this.pending;
    this.pending = this.collect(processes, now, force).finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect(processes, now, force) {
    await this.sample(processes, now, force);
    const cache = this.cache; const stale = Boolean(this.error) || Boolean(cache && now - cache.at > HISTORY_FRESH_MS);
    return { id: 'kimi', kimiSource: 'work', source: cache ? stale ? 'cache' : 'account' : 'unavailable',
      connection: cache && !stale ? 'ready' : ['login', 'expired'].includes(this.error) ? 'auth-required'
        : this.error === 'network' || this.error === 'format' ? 'error' : 'unavailable',
      activity: 'unknown', activeTasks: 0, waitingTasks: 0, task: 'Kimi Work 任务状态未知',
      quotas: (cache?.quotas || []).map(row => ({ ...row, stale: stale || Boolean(row.reset && Date.parse(row.reset) <= now) })),
      plan: cache ? { ...cache.plan, stale } : { name: null, stale: false },
      observedAt: cache ? new Date(cache.at).toISOString() : null, sampledAt: new Date(now).toISOString(), activityObservedAt: null,
      detail: this.error ? DETAILS[this.error] || DETAILS.unavailable
        : '使用 Kimi Work 当前客户端账户只读查询共享积分；不会续期登录、创建密钥或读取对话内容。',
      activityDetail: 'Kimi Work 任务活动接口尚未验证，保持未知。' };
  }
}

module.exports = { KimiWorkStatusReader, KimiWorkStatusError, resolveKimiWorkPaths, isKimiWorkProcess, readPrivateJson,
  parseJwt, readCredentials, verifyProcess, socketRecord, discoverSocket, queryContext, readWorkIdentity,
  REFRESH_MS, HISTORY_FRESH_MS, MAX_CONTEXT_BYTES, CLIENT_ID };
