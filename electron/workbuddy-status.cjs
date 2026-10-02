const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const Big = require('big.js');
const execute = promisify(execFile);
const SUMMARY_PATH = '/billing/meter/get-user-resource-summary';
const ENTERPRISE_PATH = '/v2/billing/meter/get-enterprise-user-usage';
const REFRESH_MS = 60000;
const FRESH_MS = 2 * 60000;
const MAX_FRAME = 1024 * 1024;
const MAX_ROWS = 128;
class WorkBuddyError extends Error {
  constructor(code, retryMs = REFRESH_MS) { super(code); this.code = code; this.retryMs = retryMs; }
}
function resolveWorkBuddyPaths({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const root = env.WORKBUDDY_CONFIG_DIR?.trim() ? p.resolve(env.WORKBUDDY_CONFIG_DIR.trim()) : p.join(home, '.workbuddy');
  const authRoot = p.join(home, ...(platform === 'darwin' ? ['Library', 'Application Support']
    : platform === 'win32' ? ['AppData', 'Local'] : ['.local', 'share']), 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  return { root, discovery: p.join(root, 'wbipc', 'endpoint.json'), database: p.join(root, 'workbuddy.db'), authRoot,
    auth: p.join(authRoot, 'workbuddy-desktop.info') };
}
function isWorkBuddyProcess(command) {
  return typeof command === 'string' && (/\/WorkBuddy\.app\/Contents\/(?:MacOS|Frameworks)\//.test(command)
    || /(?:^|[/\\])workbuddy(?:\.exe)?$/i.test(command));
}
async function readPrivateJson(file, max, platform, strict = false) {
  const before = await fs.lstat(file);
  if (before.isSymbolicLink() || !before.isFile() || before.size > max
    || (platform !== 'win32' && (before.uid !== process.getuid?.() || (before.mode & (strict ? 0o077 : 0o022))))) throw new WorkBuddyError('permissions');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > max) throw new WorkBuddyError('permissions');
    const data = Buffer.alloc(max + 1); let offset = 0;
    while (offset < data.length) { const read = await handle.read(data, offset, data.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    if (offset > max) throw new WorkBuddyError('format');
    return JSON.parse(data.subarray(0, offset).toString('utf8'));
  } finally { await handle.close(); }
}
async function readIdentity(paths, platform) {
  try { await fs.lstat(paths.auth + '.logged-out'); throw new WorkBuddyError('login'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const raw = await readPrivateJson(paths.auth, 65536, platform);
  const uid = raw?.account?.uid;
  const enterprise = raw?.account?.enterpriseId;
  if (typeof uid !== 'string' || !uid || uid.length > 256 || !raw?.auth?.accessToken) throw new WorkBuddyError('login');
  // Only the official domestic endpoint is supported. No token is decrypted or read into a request.
  if (!['www.workbuddy.cn', 'https://www.workbuddy.cn', 'https://www.workbuddy.cn/'].includes(raw.auth.domain)) throw new WorkBuddyError('unsupported');
  if (enterprise != null && (typeof enterprise !== 'string' || enterprise.length > 256)) throw new WorkBuddyError('format');
  return { uid, enterprise: Boolean(enterprise), identity: createHash('sha256').update(JSON.stringify([uid, enterprise || '', raw.auth.domain, raw.auth.accessToken])).digest('hex') };
}
async function ownsSocket(endpoint, processes, platform) {
  if (platform === 'win32' || !processes?.length) return false;
  try {
    const { stdout } = await execute('lsof', ['-nP', '-F', 'p', '--', endpoint], { timeout: 2000, maxBuffer: 65536 });
    const pids = stdout.split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1)));
    return pids.length === 1 && processes.some(row => row.pid === pids[0] && isWorkBuddyProcess(row.command));
  } catch { return false; }
}
async function readDiscovery(paths, processes, platform, checkSocket) {
  // Windows pipe ACL / server PID verification is not implemented yet; never fall back to an unverified pipe.
  if (platform === 'win32') throw new WorkBuddyError('platform');
  const directory = path.dirname(paths.discovery); const parent = await fs.lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)) throw new WorkBuddyError('permissions');
  const raw = await readPrivateJson(paths.discovery, 4096, platform, true);
  if (typeof raw?.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.ticket)
    || typeof raw.endpoint !== 'string' || raw.endpoint.length > 512 || !path.isAbsolute(raw.endpoint)
    || !/^b-[a-f0-9]{16}\.sock$/.test(path.basename(raw.endpoint)) || path.basename(path.dirname(raw.endpoint)) !== 'wbipc') throw new WorkBuddyError('endpoint');
  const [socket, dir] = await Promise.all([fs.lstat(raw.endpoint), fs.lstat(path.dirname(raw.endpoint))]);
  if (!socket.isSocket() || socket.isSymbolicLink() || !dir.isDirectory() || dir.isSymbolicLink()
    || socket.uid !== process.getuid?.() || dir.uid !== process.getuid?.() || (socket.mode & 0o077) || (dir.mode & 0o077)
    || !(await checkSocket(raw.endpoint, processes, platform))) throw new WorkBuddyError('endpoint');
  return { endpoint: raw.endpoint, ticket: raw.ticket };
}
function proof(ticket, role, endpoint, clientNonce, serverNonce) {
  const chunks = [];
  for (const part of [role === 'server' ? 'wbipc-s' : 'wbipc-c', '1', endpoint, clientNonce, serverNonce]) {
    const bytes = Buffer.from(part, 'utf8'); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); chunks.push(length, bytes);
  }
  return createHmac('sha256', Buffer.from(ticket, 'utf8')).update(Buffer.concat(chunks)).digest('base64url');
}
function readBrokerUsage({ endpoint, ticket, enterprise = false }, { connect = net.createConnection, timeoutMs = 8000 } = {}) {
  if (typeof endpoint !== 'string' || endpoint.length > 512 || !/^[A-Za-z0-9_-]{43}$/.test(ticket || '')) return Promise.reject(new WorkBuddyError('endpoint'));
  return new Promise((resolve, reject) => {
    let socket; let finished = false; let buffer = Buffer.alloc(0); let total = 0; let state = 'challenge';
    const clientNonce = randomBytes(16).toString('base64url');
    const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); socket?.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new WorkBuddyError('network')), timeoutMs);
    const send = frame => socket.write(JSON.stringify(frame) + '\n');
    const frame = value => {
      if (!value || typeof value !== 'object') throw new WorkBuddyError('format');
      if (value.type === 'pipe_revoked' || value.type === 'session_hello_error') throw new WorkBuddyError('login');
      if (state === 'challenge') {
        if (value.type !== 'session_challenge' || value.protocol !== 1 || !/^[A-Za-z0-9_-]{22}$/.test(value.server_nonce || '')
          || !/^[A-Za-z0-9_-]{43}$/.test(value.server_proof || '')) throw new WorkBuddyError('protocol');
        const expected = proof(ticket, 'server', endpoint, clientNonce, value.server_nonce);
        if (!timingSafeEqual(Buffer.from(expected), Buffer.from(value.server_proof))) throw new WorkBuddyError('endpoint');
        state = 'ack'; send({ type: 'session_prove', client_proof: proof(ticket, 'client', endpoint, clientNonce, value.server_nonce) });
      } else if (state === 'ack') {
        if (value.type !== 'session_hello_ack' || value.protocol !== 1) throw new WorkBuddyError('protocol');
        state = 'pipe'; send({ jsonrpc: '2.0', id: 1, method: 'broker/GetPipe', params: { pipe: 'wb.request' } });
      } else if (state === 'pipe') {
        if (value.error) throw new WorkBuddyError('login');
        if (value.jsonrpc !== '2.0' || value.id !== 1 || value.result?.channel !== 'c:wb.request'
          || !Array.isArray(value.result.methods) || !value.result.methods.includes('http.fetch')) throw new WorkBuddyError('protocol');
        state = 'usage'; send({ jsonrpc: '2.0', id: 2, method: 'c:wb.request/http.fetch', mode: 'call', params: {
          method: 'POST', path: enterprise ? ENTERPRISE_PATH : SUMMARY_PATH,
          headers: { 'content-type': 'application/json', accept: 'application/json' }, body_b64: 'e30=' } });
      } else if (state === 'usage') {
        if (value.error) throw new WorkBuddyError('network');
        if (value.jsonrpc !== '2.0' || value.id !== 2) throw new WorkBuddyError('protocol');
        const result = value.result;
        if (result?.status === 401 || result?.status === 403) throw new WorkBuddyError('login');
        if (result?.status === 429) {
          const seconds = result?.headers?.['retry-after'];
          const retry = typeof seconds === 'string' && /^\d{1,6}$/.test(seconds) ? Math.min(86400000, Math.max(REFRESH_MS, Number(seconds) * 1000)) : REFRESH_MS;
          throw new WorkBuddyError('rate', retry);
        }
        if (result?.status !== 200) throw new WorkBuddyError('network');
        if (typeof result.body_b64 !== 'string' || result.body_b64.length > 180000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.body_b64)) throw new WorkBuddyError('format');
        const parsed = JSON.parse(Buffer.from(result.body_b64, 'base64').toString('utf8'));
        finish(null, parsed);
      }
    };
    try { socket = connect({ path: endpoint }); }
    catch { finish(new WorkBuddyError('network')); return; }
    socket.once('connect', () => send({ type: 'session_hello', protocol_min: 1, protocol_max: 1, client_nonce: clientNonce,
      ticket_id: createHash('sha256').update(ticket, 'utf8').digest('hex').slice(0, 16), client: { kind: 'monitor', id: 'ai-watch' } }));
    socket.on('data', chunk => {
      if (finished) return;
      try {
        total += chunk.length; if (total > MAX_FRAME * 2 || buffer.length + chunk.length > MAX_FRAME) throw new WorkBuddyError('format');
        buffer = Buffer.concat([buffer, chunk]); let at;
        while (!finished && (at = buffer.indexOf(10)) >= 0) {
          const line = buffer.subarray(0, at); buffer = buffer.subarray(at + 1); if (line.length) frame(JSON.parse(line.toString('utf8')));
        }
      } catch (error) { finish(error instanceof WorkBuddyError ? error : new WorkBuddyError('format')); }
    });
    socket.on('error', () => finish(new WorkBuddyError('network')));
    socket.on('close', () => finish(new WorkBuddyError('network')));
  });
}
const CODES = {
  free: 'TCACA_code_001_PqouKr6QWV', proMon: 'TCACA_code_002_AkiJS3ZHF5', proYear: 'TCACA_code_003_FAnt7lcmRT',
  proMonPlus: 'TCACA_code_005_maRGyrHhw1', gift: 'TCACA_code_006_DbXS0lrypC', activity: 'TCACA_code_007_nzdH5h4Nl0',
  freeMon: 'TCACA_code_008_cfWoLwvjU4', extra: 'TCACA_code_009_0XmEQc2xOf', youth: 'TCACA_code_023_4xbGhMrE6q',
  advanced: 'TCACA_code_026_BaESVICNoi', flagship: 'TCACA_code_027_0FCGVA6vSa', bonus28: 'TCACA_code_028_NtpWi0jzXs',
  bonus29: 'TCACA_code_029_6wCGEWquYy', bonus30: 'TCACA_code_030_BjSt89qTvr', extra38: 'TCACA_code_038_OhvqZtiPKr',
};
const PLAN_NAMES = Object.fromEntries(Object.entries({ free: '体验版', gift: '体验版', freeMon: '体验版', proMon: '标准版',
  proMonPlus: '标准版', proYear: '标准版', youth: '青春版', advanced: '高级版', flagship: '旗舰版' }).map(([code, name]) => [CODES[code], name]));
function decimal(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw new WorkBuddyError('format');
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (!/^\d{1,15}(?:\.\d{1,8})?$/.test(text)) throw new WorkBuddyError('format');
  return new Big(text).toFixed();
}
function normalizeWorkBuddyUsage(payload, enterprise = false) {
  if (!payload || (payload.code !== undefined && payload.code !== 0)) throw new WorkBuddyError('format');
  const quotas = [];
  if (enterprise) {
    const data = payload?.data?.data || payload?.data || payload;
    if (data.limitNum === -1) return { plan: { name: '企业版', stale: false }, credits: { items: [{ label: '企业积分（不限量）', remaining: null, unit: '积分' }], stale: false }, quotas };
    const total = decimal(data.limitNum); const used = decimal(data.credit);
    const remaining = Big(total).minus(used); if (remaining.lt(0)) throw new WorkBuddyError('format');
    return { plan: { name: '企业版', stale: false }, credits: { items: [{ label: '企业积分', remaining: remaining.toFixed(), total, unit: '积分' }], stale: false }, quotas };
  }
  const data = payload.data;
  if (!data || !Array.isArray(data.Packages) || data.Packages.length > 64 || typeof data.SubscriptionPackageCode !== 'string'
    || data.SubscriptionPackageCode.length > 128 || typeof data.IsPaidUser !== 'boolean') throw new WorkBuddyError('format');
  const seen = new Set(); const items = []; let total = Big(0); let left = Big(0);
  for (const row of data.Packages) {
    if (typeof row?.PackageCode !== 'string' || row.PackageCode.length > 128 || !row.PackageCode || seen.has(row.PackageCode)) throw new WorkBuddyError('format');
    seen.add(row.PackageCode);
    const capacity = decimal(row.CycleTotalCapacity); const remain = decimal(row.CycleRemainCapacity);
    if (Big(remain).gt(capacity)) throw new WorkBuddyError('format');
    // Authoritative summary is already deduplicated by the server (official sumSummaryCapacity).
    total = total.plus(capacity); left = left.plus(remain);
    const code = row.PackageCode;
    const label = PLAN_NAMES[code] ? `${PLAN_NAMES[code]}积分` : [CODES.extra, CODES.extra38].includes(code) ? '加量积分'
      : [CODES.activity, CODES.bonus28, CODES.bonus29, CODES.bonus30].includes(code) ? '奖励积分' : '其他积分';
    items.push({ label, remaining: remain, total: capacity, unit: '积分' });
  }
  // Empty official summary is a verified zero balance. Unknown package names never enter the UI.
  if (items.length !== 1) items.unshift({ label: '总积分', remaining: left.toFixed(), total: total.toFixed(), unit: '积分' });
  const freePool = data.Packages.some(row => [CODES.free, CODES.gift, CODES.freeMon].includes(row.PackageCode));
  const plan = PLAN_NAMES[data.SubscriptionPackageCode] || (data.SubscriptionPackageCode === '' && data.IsPaidUser === false && freePool ? '体验版' : null);
  if (total.gt(0)) quotas.push({ model: '全部积分', period: '当前周期', remaining: Math.round(Number(left.div(total).times(100).toFixed(1)) * 10) / 10, reset: '' });
  return { plan: { name: plan, stale: false }, credits: { items, stale: false }, quotas };
}
async function readActivityRows(paths, uid) {
  for (const file of [paths.database, `${paths.database}-wal`, `${paths.database}-shm`]) {
    try { const stat = await fs.lstat(file); if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 512 * 1024 * 1024) throw new WorkBuddyError('format'); }
    catch (error) { if (file === paths.database || error.code !== 'ENOENT') throw error; }
  }
  const real = await fs.realpath(paths.database); const root = await fs.realpath(paths.root);
  if (!real.startsWith(root + path.sep)) throw new WorkBuddyError('format');
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(real, { readOnly: true, timeout: 300 });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=300;');
    return db.prepare(`SELECT s.id,s.status,s.updated_at,s.last_activity_at,u.updated_at AS usage_at,u.used
      FROM sessions s LEFT JOIN session_usage u ON u.session_id=s.id
      WHERE s.user_id=? AND (s.deleted_at IS NULL OR s.deleted_at=-1) AND (s.transport IS NULL OR s.transport='local')
      ORDER BY s.last_activity_at DESC LIMIT ${MAX_ROWS + 1}`).all(uid);
  } finally { db.close(); }
}
const DETAILS = {
  login: '请在本设备登录并打开 WorkBuddy；面板自动使用客户端现有登录态。',
  unavailable: '未发现 WorkBuddy 本机查询服务；请打开客户端后刷新。',
  endpoint: '无法确认 WorkBuddy 本机服务身份，额度保持未知。', permissions: 'WorkBuddy 本机记录权限不符合要求，暂不读取。',
  unsupported: '当前 WorkBuddy 登录区域暂不支持；仅支持官方国内版。', platform: '当前系统尚未实现 WorkBuddy 管道归属验证，额度暂不可用。',
  format: 'WorkBuddy 数据格式暂不兼容，额度保持未知。', protocol: 'WorkBuddy 本机查询协议暂不兼容。',
  network: 'WorkBuddy 额度查询暂时失败；历史快照不代表当前剩余积分。', rate: 'WorkBuddy 额度查询需要稍后重试。',
};
class WorkBuddyStatusReader {
  constructor(options = {}) {
    this.paths = resolveWorkBuddyPaths(options); this.platform = options.platform || process.platform; this.now = options.now || Date.now;
    this.readIdentity = options.readIdentity || readIdentity; this.readDiscovery = options.readDiscovery || readDiscovery;
    this.checkSocket = options.checkSocket || ownsSocket; this.request = options.request || readBrokerUsage;
    this.readActivityRows = options.readActivityRows || readActivityRows;
    this.cache = null; this.identity = null; this.nextAt = 0; this.error = 'unavailable'; this.pending = null;
    this.previous = new Map(); this.advanced = new Map(); this.sampled = false; this.processKey = null;
  }
  async usage(processes, force, now) {
    let account;
    try { account = await this.readIdentity(this.paths, this.platform); }
    catch (error) { this.cache = null; this.identity = null; this.nextAt = 0; this.error = error.code === 'ENOENT' ? 'login' : error.code || 'login'; return null; }
    if (account.identity !== this.identity) { this.identity = account.identity; this.cache = null; this.nextAt = 0; this.previous.clear(); this.advanced.clear(); this.sampled = false; }
    if (now < this.nextAt && (!force || this.error === 'rate')) return account;
    let result; let failure;
    try {
      const discovery = await this.readDiscovery(this.paths, processes, this.platform, this.checkSocket);
      result = normalizeWorkBuddyUsage(await this.request({ ...discovery, enterprise: account.enterprise }), account.enterprise);
    } catch (error) { failure = error instanceof WorkBuddyError ? error : new WorkBuddyError(error.code === 'ENOENT' ? 'unavailable' : 'network'); }
    try {
      const latest = await this.readIdentity(this.paths, this.platform);
      if (latest.identity !== account.identity) throw new WorkBuddyError('login');
    } catch { this.cache = null; this.identity = null; this.nextAt = 0; this.error = 'login'; return null; }
    this.nextAt = now + (failure?.retryMs || REFRESH_MS); this.error = failure?.code || null;
    if (!failure) this.cache = { ...result, at: now };
    else if (['login', 'unsupported', 'permissions', 'endpoint'].includes(failure.code)) this.cache = null;
    return account;
  }
  async activity(processes, account, now) {
    const matches = processes?.filter(p => isWorkBuddyProcess(p.command)) || [];
    const key = matches.map(p => p.pid).sort((a, b) => a - b).join(',');
    if (key !== this.processKey || processes === null || !account) { this.processKey = key; this.previous.clear(); this.advanced.clear(); this.sampled = false; }
    const base = { activity: processes === null ? 'unknown' : matches.length ? 'unknown' : 'offline', activeTasks: 0,
      activityDetail: '本地状态需观察到新鲜变化；云端及后台子任务状态暂不可确认。' };
    if (!matches.length || !account) return base;
    let rows; try { rows = await this.readActivityRows(this.paths, account.uid); } catch { return base; }
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) return base;
    const next = new Map(); let activeTasks = 0; let observed = null;
    for (const row of rows) {
      if (typeof row.id !== 'string' || row.id.length > 256 || typeof row.status !== 'string') continue;
      const state = ['planning', 'working', 'streaming'].includes(row.status) ? 'running'
        : ['pending', 'waiting_permission', 'waiting_question', 'paused'].includes(row.status) ? 'waiting' : null;
      const sig = JSON.stringify([row.status, row.last_activity_at, row.usage_at, row.used]); next.set(row.id, sig);
      const stamp = Math.max(...[row.last_activity_at, row.usage_at].filter(value => typeof value === 'number' && Number.isFinite(value)), 0);
      if (!state) { this.advanced.delete(row.id); continue; }
      if (this.sampled && this.previous.get(row.id) !== sig && stamp > 0 && stamp <= now + 2000 && now - stamp <= FRESH_MS) this.advanced.set(row.id, stamp);
      const advanced = this.advanced.get(row.id);
      // Persisted pending may be orphaned; no red/waiting claim without a live HITL API.
      if (state === 'running' && advanced && now - advanced <= FRESH_MS) { activeTasks++; observed = Math.max(observed || 0, advanced); }
    }
    this.previous = next; this.sampled = true;
    for (const id of this.advanced.keys()) if (!next.has(id)) this.advanced.delete(id);
    return activeTasks ? { activity: 'running', activeTasks, activityObservedAt: new Date(observed).toISOString(),
      activityDetail: '已观察到本地任务的新鲜状态变化；超过两分钟无进展后回到未知。' } : base;
  }
  async poll(processes, force = false) {
    if (this.pending) return this.pending;
    this.pending = this.sample(processes, force).finally(() => { this.pending = null; }); return this.pending;
  }
  async sample(processes, force) {
    const now = this.now(); const account = await this.usage(processes, force, now); const activity = await this.activity(processes, account, now);
    const cache = this.cache; const stale = Boolean(this.error || (cache && now - cache.at > 2 * REFRESH_MS));
    return { id: 'workbuddy', source: cache ? stale ? 'cache' : 'local-api' : 'unavailable',
      connection: this.error === 'login' ? 'auth-required' : cache && !stale ? 'ready' : this.error === 'network' ? 'error' : 'unavailable',
      ...activity, task: activity.activity === 'running' ? `${activity.activeTasks} 个本地任务运行中` : activity.activity === 'offline' ? '客户端未运行' : '任务状态待确认',
      plan: cache ? { ...cache.plan, stale } : { name: null, stale: false },
      credits: cache ? { ...cache.credits, items: cache.credits.items.map(item => ({ ...item })), stale } : undefined,
      quotas: cache && !stale ? cache.quotas.map(row => ({ ...row })) : [],
      observedAt: cache ? new Date(cache.at).toISOString() : null, sampledAt: new Date(now).toISOString(),
      detail: this.error ? DETAILS[this.error] || DETAILS.unavailable : '通过 WorkBuddy 本机服务读取当前套餐与积分；不保存或解密登录令牌。' };
  }
}
module.exports = { WorkBuddyStatusReader, WorkBuddyError, resolveWorkBuddyPaths, isWorkBuddyProcess, readIdentity, readDiscovery,
  ownsSocket, readBrokerUsage, proof, normalizeWorkBuddyUsage, readActivityRows, CODES, SUMMARY_PATH, ENTERPRISE_PATH };
