const { taskDetail } = require('./task-details.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { createHash, createDecipheriv, pbkdf2Sync, timingSafeEqual } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const ENDPOINTS = Object.freeze({ credits: '/api/entitlement/credits/query', plan: '/api/member/level/query' });
const MAX_RESPONSE = 256 * 1024;
const FRESH_MS = 90000;
const COOKIE_NAMES = ['tongyi_sso_ticket', 'tongyi_sso_ticket_hash'];
class QwenError extends Error {
  constructor(code, retryMs = 60000) { super(code); this.code = code; this.retryMs = retryMs; }
}
async function contained(file, root) {
  const [real, base] = await Promise.all([fs.realpath(file), fs.realpath(root)]);
  if (!real.startsWith(base + path.sep)) throw new QwenError('format');
  return real;
}
function cookieExpiry(value) {
  try { return Number((BigInt(value) - 11644473600000000n) / 1000n); } catch { return NaN; }
}
async function readCookieSnapshot(root, now) {
  const file = await contained(path.join(root, 'Default', 'Cookies'), root);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new QwenError('format');
  for (const suffix of ['-wal', '-shm']) {
    try {
      const sidecar = await contained(file + suffix, root);
      const info = await fs.stat(sidecar);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new QwenError('format');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(file, { readOnly: true, timeout: 400 });
  try {
    const version = Number(database.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value);
    if (!Number.isInteger(version) || version < 1) throw new QwenError('format');
    // Never query browser passwords, arbitrary cookies or account/profile records.
    const rows = database.prepare(`SELECT host_key, name, value, encrypted_value, CAST(expires_utc AS TEXT) AS expires,
      has_expires, path FROM cookies WHERE (host_key = '.qianwen.com' AND name IN ('tongyi_sso_ticket', 'tongyi_sso_ticket_hash'))
      OR (host_key IN ('.qianwen.com', 'www.qianwen.com') AND name = 'XSRF-TOKEN') LIMIT 9`).all();
    if (rows.length > 8) throw new QwenError('format');
    const valid = rows.filter(row => row.path === '/' && (!row.has_expires || cookieExpiry(row.expires) > now));
    const login = valid.filter(row => row.name === COOKIE_NAMES[0]);
    if (login.length !== 1) throw new QwenError('login');
    const identity = createHash('sha256').update(Buffer.from(login[0].encrypted_value)).update(login[0].value).update(login[0].expires).digest('hex');
    return { version, rows: valid, identity };
  } finally { database.close(); }
}
async function getQianwenPassword() {
  try {
    // This dedicated application item can prompt macOS. Call only after explicit opt-in.
    const { stdout } = await execute('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Qianwen Safe Storage'],
      { timeout: 15000, maxBuffer: 2048, encoding: 'utf8' });
    const password = stdout.replace(/\r?\n$/, '');
    if (!/^[\x20-\x7e]{1,1024}$/.test(password)) throw new Error();
    return password;
  } catch { throw new QwenError('keychain'); }
}
function decryptCookie(row, version, password) {
  let clear;
  const input = Buffer.from(row.encrypted_value);
  if (!input.length) clear = Buffer.from(row.value || '', 'utf8');
  else {
    if (!/^[\x20-\x7e]{1,1024}$/.test(password || '') || input.subarray(0, 3).toString() !== 'v10'
      || input.length > 16384 || (input.length - 3) % 16 !== 0) throw new QwenError('format');
    const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    try {
      const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
      clear = Buffer.concat([decipher.update(input.subarray(3)), decipher.final()]);
    } catch { throw new QwenError('format'); }
    finally { key.fill(0); }
    if (version >= 24) {
      const digest = createHash('sha256').update(row.host_key).digest();
      if (clear.length <= 32 || !timingSafeEqual(clear.subarray(0, 32), digest)) { clear.fill(0); throw new QwenError('format'); }
      clear = clear.subarray(32);
    }
  }
  const value = clear.toString('utf8'); clear.fill(0);
  if (!/^[\x21-\x3a\x3c-\x7e]{1,8192}$/.test(value)) throw new QwenError('format');
  return value;
}
function authHeaders(snapshot, password) {
  const cookie = []; let csrf;
  for (const row of snapshot.rows) {
    if (!COOKIE_NAMES.includes(row.name) && row.name !== 'XSRF-TOKEN') continue;
    const value = decryptCookie(row, snapshot.version, password);
    if (COOKIE_NAMES.includes(row.name)) cookie.push(row.name + '=' + value);
    if (row.name === 'XSRF-TOKEN') {
      try { csrf = decodeURIComponent(value); } catch { throw new QwenError('format'); }
      if (!/^[\x21-\x7e]{1,8192}$/.test(csrf)) throw new QwenError('format');
    }
  }
  if (!cookie.some(value => value.startsWith(COOKIE_NAMES[0] + '='))) throw new QwenError('login');
  return { Cookie: cookie.join('; '), ...(csrf ? { 'X-XSRF-TOKEN': csrf } : {}) };
}
function requestJson(kind, auth, { transport = https, timeoutMs = 5000 } = {}) {
  if (!Object.hasOwn(ENDPOINTS, kind) || !auth || !/^[\x20-\x7e]{1,20000}$/.test(auth.Cookie || '')
    || (auth['X-XSRF-TOKEN'] && !/^[\x21-\x7e]{1,8192}$/.test(auth['X-XSRF-TOKEN']))) return Promise.reject(new QwenError('endpoint'));
  return new Promise((resolve, reject) => {
    let deadline; let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    const body = kind === 'plan' ? '{}' : '';
    const request = transport.request({ hostname: 'member.qianwen.com', protocol: 'https:', path: ENDPOINTS[kind],
      method: kind === 'plan' ? 'POST' : 'GET', agent: false, headers: { Accept: 'application/json',
        'Content-Type': 'application/json', 'X-Platform': 'pc_tongyi', Origin: 'https://www.qianwen.com',
        Referer: 'https://www.qianwen.com/', Cookie: auth.Cookie,
        ...(auth['X-XSRF-TOKEN'] ? { 'X-XSRF-TOKEN': auth['X-XSRF-TOKEN'] } : {}),
        ...(body ? { 'Content-Length': '2' } : {}) } }, response => {
      response.on('error', () => finish(new QwenError('network')));
      if (response.statusCode !== 200) {
        const seconds = Number(response.headers['retry-after']);
        const retry = Number.isFinite(seconds) ? Math.min(86400000, Math.max(60000, seconds * 1000)) : 60000;
        finish(new QwenError([401, 403].includes(response.statusCode) ? 'login' : response.statusCode === 429 ? 'rate' : 'network', retry));
        response.destroy(); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length;
        if (size > MAX_RESPONSE) { finish(new QwenError('format')); response.destroy(); } else chunks.push(chunk); });
      response.on('end', () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new QwenError('format')); } });
    });
    deadline = setTimeout(() => { finish(new QwenError('network')); request.destroy(); }, timeoutMs);
    request.on('error', () => finish(new QwenError('network')));
    request.on('close', () => finish(new QwenError('network')));
    request.end(body);
  });
}
function dataOf(payload) {
  if (payload?.success !== true || payload.httpCode !== 200 || !payload.data || typeof payload.data !== 'object') {
    if ([401, 403].includes(payload?.httpCode)) throw new QwenError('login');
    throw new QwenError('format');
  }
  return payload.data;
}
function decimal(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}
function timestamp(value) {
  const numeric = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  return typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric > 0 && numeric <= 8640000000000000
    ? new Date(numeric).toISOString() : null;
}
function normalizeCredits(payload) {
  const data = dataOf(payload); const items = []; const quotas = [];
  if (typeof data.creditsRemain !== 'boolean') throw new QwenError('format');
  const total = decimal(data.totalBalance);
  if (total !== null) items.push({ label: '总剩余积分', remaining: total, unit: '积分' });
  if (Array.isArray(data.creditsDetail)) {
    if (data.creditsDetail.length > 32) throw new QwenError('format');
    for (const [index, row] of data.creditsDetail.entries()) {
      const remaining = decimal(row?.balance); const poolTotal = decimal(row?.total);
      if (remaining === null || poolTotal === null || Number(remaining) > Number(poolTotal)) continue;
      const reset = timestamp(row.expireAt);
      items.push({ label: '积分池 ' + (index + 1), remaining, total: poolTotal, unit: '积分', ...(reset ? { reset } : {}) });
    }
  }
  for (const [scope, label, period] of [['5H', '5小时额度', '5 小时'], ['WEEKLY', '每周额度', '1 周']]) {
    const rows = Array.isArray(data.scopes) && data.scopes.length <= 16 ? data.scopes.filter(row => row?.scope === scope) : [];
    if (rows.length !== 1) continue;
    const row = rows[0];
    if (typeof row.usedPercent !== 'number' || !Number.isFinite(row.usedPercent) || row.usedPercent < 0 || row.usedPercent > 100) continue;
    const remaining = Math.round((100 - row.usedPercent) * 100) / 100; const reset = timestamp(row.refreshAt);
    // The official frontend calls freqBalance "Used"; no unsupported count/point conversion.
    items.push({ label, remaining: String(remaining), total: '100', unit: '%', ...(reset ? { reset } : {}) });
    quotas.push({ model: '千问', period, remaining, reset: reset || '' });
  }
  if (!items.length) throw new QwenError('format');
  return { credits: { items, stale: false }, quotas };
}
function normalizePlan(payload) {
  const data = dataOf(payload);
  if (typeof data.memberName !== 'string' || typeof data.memberType !== 'string') throw new QwenError('format');
  // Product names only: never render an arbitrary server field as an account or plan name.
  const type = data.memberType.trim().toLowerCase();
  const names = { free: '免费版', lite: 'Lite', plus: 'Plus', pro: 'Pro', ultra: 'Ultra', max: 'Max' };
  const name = Object.hasOwn(names, type) ? names[type] : null;
  return { name, status: type === 'free' ? 'free' : name ? 'member' : 'unknown', expiresAt: timestamp(data.expireTime), stale: false };
}
function isQianwen(command) { return /(?:^|[/\\])Qianwen(?:\.exe)?$/i.test(command || ''); }
async function childDirs(root, base, budget) {
  let dir;
  try { dir = await fs.opendir(await contained(root, base)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for await (const entry of dir) {
    if (--budget.left < 0) throw new QwenError('limit');
    if (entry.isDirectory()) result.push(path.join(root, entry.name));
  }
  return result;
}
async function eventTail(file, root) {
  const handle = await fs.open(await contained(file, root), 'r');
  try {
    const stat = await handle.stat(); if (!stat.isFile()) throw new QwenError('format');
    const size = Math.min(stat.size, 256 * 1024); const start = stat.size - size;
    const buffer = Buffer.alloc(size); await handle.read(buffer, 0, size, start);
    let text = buffer.toString('utf8'); if (start) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split('\n'); let last = null; let boundary = null;
    if (lines.length > 4096) throw new QwenError('limit');
    for (const line of lines) {
      if (!line.trim() || line.length > 65536) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const at = typeof row.timestamp === 'string' && row.timestamp.length < 64 ? Date.parse(row.timestamp) : NaN;
      if (row.schemaVersion !== 2 || !Number.isSafeInteger(row.seq) || row.seq < 0 || !Number.isFinite(at)) continue;
      const event = { seq: row.seq, at, type: row.type };
      if (!last || event.seq > last.seq) last = event;
      if (['turn_started', 'turn_completed'].includes(event.type) && (!boundary || event.seq > boundary.seq)) boundary = event;
    }
    return { last, boundary, size: stat.size, ino: stat.ino };
  } finally { await handle.close(); }
}
const DETAILS = {
  login: '未发现可用的千问桌面登录态，请在本设备的千问客户端登录。',
  consent: '读取千问登录需要允许访问其专属安全存储；当前仅监看本地智能体活动。',
  keychain: '千问安全存储暂不可读或授权已取消；手动刷新后才会再次尝试。',
  platform: '当前仅支持 macOS 千问桌面登录读取；其他平台额度暂不可用。',
  format: '千问返回的数据或登录格式暂不兼容，无法确认当前套餐与积分。',
  network: '千问只读查询暂时失败，已保留的数值仅为历史快照。',
  rate: '千问服务要求稍后重试。',
  unreadable: '暂时无法读取千问本地状态。',
};
class QwenStatusReader {
  constructor({ home = os.homedir(), platform = process.platform, allowKeychain = false, getPassword = getQianwenPassword,
    request = requestJson, readCookies = readCookieSnapshot, now = Date.now } = {}) {
    this.root = path.join(home, 'Library', 'Application Support', 'Qianwen'); this.platform = platform;
    this.allowKeychain = allowKeychain; this.getPassword = getPassword; this.request = request; this.readCookies = readCookies; this.now = now;
    this.identity = null; this.cache = null; this.nextAt = 0; this.retryAt = 0; this.error = 'login'; this.password = null;
    this.keychainFailed = false; this.events = new Map(); this.pids = ''; this.activityBaseline = false; this.pending = null; this.epoch = 0;
  }
  resetAccount() { this.identity = null; this.cache = null; this.nextAt = 0; this.retryAt = 0; }
  setKeychainAllowed(value) {
    const allowed = value === true;
    if (allowed === this.allowKeychain) return;
    this.allowKeychain = allowed; this.epoch++; this.password = null; this.keychainFailed = false;
    this.resetAccount(); this.error = allowed ? 'login' : 'consent';
  }
  async usage(now, force) {
    const epoch = this.epoch;
    if (this.platform !== 'darwin') { this.resetAccount(); this.error = 'platform'; return; }
    let snapshot;
    try { snapshot = await this.readCookies(this.root, now); }
    catch (error) { if (epoch === this.epoch) { this.resetAccount(); this.error = ['ENOENT', 'login'].includes(error.code) ? 'login' : 'unreadable'; } return; }
    if (epoch !== this.epoch) return;
    if (snapshot.identity !== this.identity) { this.resetAccount(); this.identity = snapshot.identity; }
    if (!this.allowKeychain) { this.cache = null; this.error = 'consent'; return; }
    if (now < this.retryAt || (!force && now < this.nextAt)) return;
    let auth;
    try {
      if (!this.password) {
        if (this.keychainFailed && !force) throw new QwenError('keychain');
        try {
          const password = await this.getPassword();
          if (epoch !== this.epoch || !this.allowKeychain) return;
          this.password = password; this.keychainFailed = false;
        }
        catch { if (epoch !== this.epoch) return; this.keychainFailed = true; throw new QwenError('keychain'); }
      }
      auth = authHeaders(snapshot, this.password);
    } catch (error) { this.cache = null; this.error = error instanceof QwenError ? error.code : 'format'; return; }
    try {
      if ((await this.readCookies(this.root, now)).identity !== snapshot.identity) throw new QwenError('login');
    } catch { if (epoch === this.epoch) { this.resetAccount(); this.error = 'login'; } return; }
    if (epoch !== this.epoch || !this.allowKeychain) return;
    const results = await Promise.allSettled([this.request('credits', auth), this.request('plan', auth)]);
    if (epoch !== this.epoch || !this.allowKeychain) return;
    try {
      const latest = await this.readCookies(this.root, now);
      if (latest.identity !== snapshot.identity) throw new QwenError('login');
    } catch { if (epoch === this.epoch) { this.resetAccount(); this.error = 'login'; } return; }
    if (epoch !== this.epoch || !this.allowKeychain) return;
    const errors = []; const values = {};
    for (const [index, key] of ['credits', 'plan'].entries()) {
      try {
        if (results[index].status === 'rejected') throw results[index].reason;
        values[key] = key === 'credits' ? normalizeCredits(results[index].value) : normalizePlan(results[index].value);
      } catch (error) { errors.push(error instanceof QwenError ? error : new QwenError('network')); }
    }
    const failure = errors.find(e => e.code === 'login') || errors.find(e => e.code === 'rate') || errors[0];
    this.nextAt = now + 60000; this.retryAt = failure?.code === 'rate' ? now + failure.retryMs : 0;
    this.error = failure?.code || null;
    if (failure?.code === 'login') { this.cache = null; return; }
    if (values.credits || values.plan) {
      this.cache = { at: now, plan: values.plan || { name: null, status: 'unknown' },
        credits: values.credits?.credits || { items: [], stale: false }, quotas: values.credits?.quotas || [], partial: !!failure };
    }
  }
  async activity(processes, now) {
    const matched = Array.isArray(processes) ? processes.filter(p => isQianwen(p.command)) : null;
    const pids = matched?.map(p => p.pid).sort().join(',') || '';
    if (pids !== this.pids || !matched?.length) { this.events.clear(); this.activityBaseline = false; this.pids = pids; }
    const fallback = { activity: matched?.length === 0 ? 'offline' : 'unknown', activeTasks: 0, activityObservedAt: null };
    if (!matched?.length || this.platform !== 'darwin') return fallback;
    let running = 0; let latest = 0; let completed = false; const next = new Map();
    try {
      const budget = { left: 512 };
      for (const account of await childDirs(path.join(this.root, 'qwen-agent'), this.root, budget)) {
        for (const project of await childDirs(path.join(account, 'projects'), this.root, budget)) {
          for (const session of await childDirs(path.join(project, 'sessions'), this.root, budget)) {
            if (next.size >= 64) throw new QwenError('limit');
            const file = path.join(session, 'thread-events.jsonl'); let current;
            try { current = await eventTail(file, this.root); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            const old = this.events.get(file); const sameFile = old && old.ino === current.ino && current.size >= old.size;
            if (!current.boundary && sameFile) current.boundary = old.boundary;
            const fresh = current.last && now - current.last.at <= FRESH_MS && current.last.at <= now + 5000;
            const grew = this.activityBaseline && current.last && (sameFile ? current.last.seq > (old.last?.seq ?? -1) : !old);
            current.verifiedAt = sameFile ? old.verifiedAt : 0;
            if (fresh && grew && current.boundary?.type === 'turn_started') current.verifiedAt = now;
            if (current.boundary?.type === 'turn_completed') current.verifiedAt = 0;
            if (fresh && current.verifiedAt && now - current.verifiedAt <= FRESH_MS && current.boundary?.type === 'turn_started') running++;
            if (fresh && current.boundary?.type === 'turn_completed') completed = true;
            if (fresh) latest = Math.max(latest, current.last.at);
            next.set(file, current);
          }
        }
      }
      this.events = next; this.activityBaseline = true;
      return { activity: running ? 'running' : completed ? 'idle' : 'unknown', activeTasks: running,
        activityObservedAt: latest ? new Date(latest).toISOString() : null,
        ...(this.taskDetailsEnabled ? { taskDetails: [...next.values()].sort((a,b) => (b.last?.at || 0) - (a.last?.at || 0)).slice(0,8).map(row => taskDetail({ state: row.verifiedAt && now - row.verifiedAt <= FRESH_MS && row.boundary?.type === 'turn_started' ? 'running' : row.boundary?.type === 'turn_completed' ? 'completed' : 'unknown', updatedAt: row.last?.at, operation: row.last?.type }, { now, live: !!row.verifiedAt, freshMs: FRESH_MS })) } : {}) };
    } catch { this.events.clear(); this.activityBaseline = false; return fallback; }
  }
  poll(processes, force = false) {
    if (this.pending) return this.pending;
    this.pending = this.collect(processes, force === true).finally(() => { this.pending = null; }); return this.pending;
  }
  async collect(processes, force) {
    const now = this.now(); const [, activity] = await Promise.all([this.usage(now, force), this.activity(processes, now)]);
    const cache = this.cache; const stale = !!this.error || !cache || now - cache.at > 120000;
    const expired = value => !!value && Date.parse(value) <= now;
    const credits = cache ? { items: cache.credits.items.map(item => ({ ...item })),
      stale: stale || cache.credits.items.some(item => expired(item.reset)) } : { items: [], stale: false };
    const plan = cache ? { ...cache.plan, stale: stale || expired(cache.plan.expiresAt) } : { name: null, status: 'unknown', stale: false };
    return { id: 'qwen', source: cache ? stale ? 'cache' : 'account' : 'unavailable',
      connection: cache ? stale ? 'error' : 'ready' : ['login', 'consent', 'keychain'].includes(this.error) ? 'auth-required' : 'unavailable',
      accessRequired: ['consent', 'keychain'].includes(this.error),
      ...activity, task: activity.activity === 'running' ? `${activity.activeTasks} 个本地智能体任务运行中`
        : activity.activity === 'idle' ? '本地智能体刚完成任务' : activity.activity === 'offline' ? '千问客户端未运行' : '本地任务状态未知',
      plan, credits, quotas: cache ? cache.quotas.map(q => ({ ...q, stale: stale || expired(q.reset) })) : [],
      observedAt: cache ? new Date(cache.at).toISOString() : null, sampledAt: new Date(now).toISOString(),
      detail: this.error ? DETAILS[this.error] || DETAILS.unreadable : '读取本设备千问登录态并查询官方套餐与额度；服务端总积分和分池分别展示。',
      activityDetail: '仅覆盖千问桌面的本地智能体事件；普通聊天、云端任务和等待授权暂无可靠状态接口。进程或历史未完成记录不会单独视为运行。' };
  }
}
module.exports = { QwenStatusReader, QwenError, normalizeCredits, normalizePlan, readCookieSnapshot, decryptCookie,
  authHeaders, requestJson, getQianwenPassword, ENDPOINTS, cookieExpiry };
