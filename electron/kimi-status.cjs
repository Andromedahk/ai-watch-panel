const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { boundedFile } = require('./session-files.cjs');
const execute = promisify(execFile);
const MAX_BYTES = 128 * 1024;
const HEARTBEAT_MS = 60000;
const USAGE_PATH = '/coding/v1/usages';
const PROFILE_PATH = '/coding/v1/me';
const SESSION_PATHS = {
  running: '/api/v2/sessions?activity.status=running&fields=id%2Carchived&page_size=100',
  waiting: '/api/v2/sessions?activity.status=approval&activity.status=question&fields=id%2Carchived&page_size=100',
};
const GLOBAL_SLOT = 'kimi-code-env-' + createHash('sha256')
  .update(JSON.stringify({ oauthHost: 'https://auth.kimi.ai', baseUrl: 'https://api.kimi.ai/coding/v1' }))
  .digest('hex').slice(0, 16);
class KimiError extends Error {
  constructor(code, retryMs = 60000) { super(code); this.code = code; this.retryMs = retryMs; }
}
function resolveKimiPaths({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const expand = (value, fallback) => typeof value !== 'string' || !value.trim() ? p.join(home, fallback)
    : value === '~' ? home : /^~[/\\]/.test(value) ? p.join(home, value.slice(2)) : p.resolve(value);
  return { current: expand(env.KIMI_CODE_HOME, '.kimi-code'), legacy: expand(env.KIMI_SHARE_DIR, '.kimi') };
}
function validToken(value) { return typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/.test(value); }
async function privateFile(file, root, platform) {
  const data = await boundedFile(file, root, 65536);
  const stat = await fs.stat(file);
  if (platform !== 'win32' && (stat.mode & 0o077)) throw new KimiError('permissions');
  return data.toString('utf8');
}
async function readOAuth(paths, env, platform, now) {
  // A custom environment must never cause an account token to reach a guessed host.
  const allowed = { KIMI_CODE_BASE_URL: ['https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1'],
    KIMI_CODE_OAUTH_HOST: ['https://auth.kimi.com', 'https://auth.kimi.ai'],
    KIMI_OAUTH_HOST: ['https://auth.kimi.com', 'https://auth.kimi.ai'] };
  for (const [key, values] of Object.entries(allowed)) {
    if (env[key] && !values.includes(env[key].replace(/\/+$/, ''))) throw new KimiError('unsupported');
  }
  let root = paths.current;
  try { await fs.stat(root); }
  catch (error) { if (error.code !== 'ENOENT') throw new KimiError('unreadable'); root = paths.legacy; }
  const entries = [];
  for (const [slot, host] of [['kimi-code', 'api.kimi.com'], [GLOBAL_SLOT, 'api.kimi.ai']]) {
    try {
      const raw = JSON.parse(await privateFile(path.join(root, 'credentials', slot + '.json'), root, platform));
      if (!validToken(raw.access_token) || !Number.isFinite(raw.expires_at) || raw.token_type?.toLowerCase() !== 'bearer') throw new KimiError('format');
      entries.push({ token: raw.access_token, expires: raw.expires_at * 1000, host });
    } catch (error) { if (error.code !== 'ENOENT') throw error instanceof KimiError ? error : new KimiError('format'); }
  }
  // Region/account ambiguity is visible instead of silently choosing a cached login.
  if (!entries.length) throw new KimiError('login');
  if (entries.length !== 1) throw new KimiError('ambiguous');
  const grant = entries[0];
  const hosts = Object.keys(allowed).map(key => env[key]?.replace(/\/+$/, '')).filter(Boolean);
  if (hosts.some(value => new URL(value).hostname.endsWith('.ai') !== grant.host.endsWith('.ai'))) throw new KimiError('unsupported');
  if (grant.expires <= now + 5000) throw new KimiError('expired');
  return { ...grant, identity: createHash('sha256').update(grant.host + '\n' + grant.token).digest('hex') };
}
function requestJson({ hostname, port, endpoint, token }, { transport, timeoutMs = 5000 } = {}) {
  const local = ['127.0.0.1', '::1'].includes(hostname);
  const valid = local ? Number.isInteger(port) && port > 0 && port <= 65535 && Object.values(SESSION_PATHS).includes(endpoint)
    : ['api.kimi.com', 'api.kimi.ai'].includes(hostname) && port === undefined && [USAGE_PATH, PROFILE_PATH].includes(endpoint);
  if (!valid || !validToken(token)) return Promise.reject(new KimiError('endpoint'));
  return new Promise((resolve, reject) => {
    const request = (transport || (local ? http : https)).request({ protocol: local ? 'http:' : 'https:', hostname,
      port, path: endpoint, method: 'GET', agent: false, headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }, response => {
      response.on('error', () => reject(new KimiError('network')));
      if (response.statusCode !== 200) {
        const value = response.headers['retry-after'];
        const retryValue = typeof value === 'string' ? /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now() : NaN;
        const retry = Number.isFinite(retryValue) ? Math.min(86400000, Math.max(60000, retryValue)) : 60000;
        reject(new KimiError([401, 403].includes(response.statusCode) ? 'login' : response.statusCode === 429 ? 'rate' : 'network', retry));
        response.destroy(); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) { reject(new KimiError('format')); response.destroy(); }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new KimiError('format')); }
      });
    });
    const deadline = setTimeout(() => request.destroy(), timeoutMs);
    request.on('error', () => reject(new KimiError('network')));
    request.on('close', () => { clearTimeout(deadline); reject(new KimiError('network')); });
    request.end();
  });
}
function number(value) { return typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN; }
function resetTime(value) {
  const date = typeof value === 'string' && value.length < 64 ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? new Date(date).toISOString() : '';
}
function normalizeKimiUsage(payload) {
  const quotas = [];
  if (payload?.usages && typeof payload.usages === 'object') {
    for (const [key, model, period] of [['limit_5h', '全部模型', '5 小时'], ['limit_7d', '全部模型', '1 周'],
      ['limit_month_total', '全部模型', '月额度'], ['limit_month_code', 'Code', '月额度']]) {
      const row = payload.usages[key]; const used = number(row?.used_ratio);
      if (!Number.isFinite(used) || used < 0 || used > 1) continue;
      quotas.push({ model, period, remaining: Math.round((1 - used) * 1000) / 10, reset: resetTime(row.reset_time) });
    }
  } else if (payload && (payload.usage || Array.isArray(payload.limits))) {
    const rows = [[payload.usage, '1 周']];
    for (const item of (Array.isArray(payload.limits) ? payload.limits : []).slice(0, 16)) {
      const row = item?.detail || item; const window = item?.window || item;
      const duration = number(window?.duration); const unit = window?.timeUnit;
      const hours = unit === 'TIME_UNIT_MINUTE' || unit === 'MINUTE' ? duration / 60 : unit === 'TIME_UNIT_HOUR' || unit === 'HOUR' ? duration : NaN;
      const period = hours === 5 ? '5 小时' : hours === 168 || (['DAY', 'TIME_UNIT_DAY'].includes(unit) && duration === 7) ? '1 周' : '其他窗口';
      rows.push([row, period]);
    }
    for (const [row, period] of rows) {
      const limit = number(row?.limit); const used = row?.used == null ? limit - number(row?.remaining) : number(row.used);
      if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used) || used < 0 || used > limit) continue;
      quotas.push({ model: '全部模型', period, remaining: Math.round((1 - used / limit) * 1000) / 10,
        reset: resetTime(row.reset_time || row.reset_at || row.resetAt || row.resetTime) });
    }
  } else throw new KimiError('format');
  return quotas;
}
function normalizeKimiPlan(payload) {
  // This is the official /me product field, never nickname, user ID or quota size.
  if (!payload || typeof payload.user_id !== 'string' || !payload.user_id || payload.user_id.length > 256) throw new KimiError('format');
  const names = new Map(['Free', 'Adagio', 'Andante', 'Moderato', 'Allegretto', 'Vivace', 'Allegro', 'Plus', 'Pro', 'Max', 'Ultra']
    .map(name => [name.toLowerCase(), name]));
  const value = typeof payload.user_level_name === 'string' ? payload.user_level_name.trim().toLowerCase() : '';
  return { name: names.get(value) || null };
}
function isKimiProcess(command) { return /(?:^|[/\\])kimi(?:-code)?(?:\.exe)?$/i.test(command || ''); }
function validInstance(row, name, processes, now) {
  return /^[A-Za-z0-9_-]{1,80}\.json$/.test(name) && row?.server_id === name.slice(0, -5)
    && Number.isInteger(row.pid) && row.pid > 0 && processes.some(p => p.pid === row.pid)
    && ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(row.host)
    && Number.isInteger(row.port) && row.port > 0 && row.port <= 65535
    && Number.isFinite(row.heartbeat_at) && now - row.heartbeat_at <= HEARTBEAT_MS && row.heartbeat_at <= now + 5000;
}
async function ownsPort(pid, port, platform) {
  if (platform === 'win32') return false;
  try {
    const { stdout } = await execute('lsof', ['-a', '-p', String(pid), '-iTCP:' + port, '-sTCP:LISTEN', '-F', 'p'], { timeout: 1500, maxBuffer: 65536 });
    return stdout.split('\n').includes('p' + pid);
  } catch { return false; }
}
function sessionIds(payload) {
  const data = payload?.data;
  if (payload?.code !== 0 || !Array.isArray(data?.items) || data.items.length > 100 || data.has_more !== false
    || !Number.isInteger(data.total) || data.total !== data.items.length) throw new KimiError('format');
  const ids = data.items.map(row => row?.id);
  if (ids.some(id => typeof id !== 'string' || id.length < 1 || id.length > 200) || new Set(ids).size !== ids.length) throw new KimiError('format');
  return ids;
}
const DETAILS = {
  login: '未发现可用的 Kimi Code 登录态；在本设备的客户端登录后会自动识别。',
  expired: 'Kimi 登录令牌已过期，请打开客户端完成续期；面板不会修改登录信息。',
  permissions: 'Kimi 登录文件权限不符合要求，请在客户端检查登录状态。',
  ambiguous: '发现多个区域的 Kimi 登录记录，暂不选择账户；请在客户端清理不再使用的登录。',
  unsupported: '当前自定义 Kimi 登录环境暂不支持，只查询官方账户服务。',
  format: 'Kimi 数据格式暂不兼容，额度保持未知。',
  unreadable: '暂时无法读取 Kimi 本地记录。',
  network: 'Kimi 额度查询暂时失败，历史快照不代表当前剩余额度。',
  rate: 'Kimi 账户服务要求稍后重试。',
};
class KimiStatusReader {
  constructor({ home = os.homedir(), env = process.env, platform = process.platform, request = requestJson, requestPlan = request, checkPort = ownsPort } = {}) {
    this.paths = resolveKimiPaths({ home, env, platform }); this.env = env; this.platform = platform;
    this.request = request; this.requestPlan = requestPlan; this.checkPort = checkPort;
    this.cache = null; this.planCache = null; this.planError = null; this.identity = null; this.nextAt = 0; this.error = 'login'; this.pending = null;
  }
  async usage(now) {
    let grant;
    try { grant = await readOAuth(this.paths, this.env, this.platform, now); }
    catch (error) { this.cache = null; this.planCache = null; this.planError = null; this.identity = null; this.nextAt = 0; this.error = error.code || 'unreadable'; return; }
    if (this.identity !== grant.identity) { this.identity = grant.identity; this.cache = null; this.planCache = null; this.planError = null; this.nextAt = 0; }
    if (now < this.nextAt) return;
    // A profile failure must not hide valid usage, or vice versa. Neither query renews a login.
    const [usage, profile] = await Promise.allSettled([
      Promise.resolve().then(() => this.request({ hostname: grant.host, endpoint: USAGE_PATH, token: grant.token })).then(normalizeKimiUsage),
      Promise.resolve().then(() => this.requestPlan({ hostname: grant.host, endpoint: PROFILE_PATH, token: grant.token })).then(normalizeKimiPlan),
    ]);
    const failure = usage.status === 'rejected' ? usage.reason instanceof KimiError ? usage.reason : new KimiError('network') : null;
    const planFailure = profile.status === 'rejected' ? profile.reason instanceof KimiError ? profile.reason : new KimiError('network') : null;
    // Discard a result if another client changed the login while it was in flight.
    try {
      const latest = await readOAuth(this.paths, this.env, this.platform, now);
      if (latest.identity !== grant.identity) throw new KimiError('login');
    } catch (error) { this.cache = null; this.planCache = null; this.planError = null; this.identity = null; this.nextAt = 0; this.error = error.code || 'login'; return; }
    this.nextAt = now + Math.max(failure?.retryMs || 60000, planFailure?.retryMs || 60000);
    this.error = failure?.code || null; this.planError = planFailure?.code || null;
    if (failure?.code === 'login' || planFailure?.code === 'login') {
      this.cache = null; this.planCache = null; this.error = 'login'; return;
    }
    if (!failure) this.cache = { quotas: usage.value, at: now };
    if (!planFailure) this.planCache = { plan: profile.value, at: now };
  }
  async activity(processes, now) {
    const fallback = { activity: processes === null ? 'unknown' : processes.some(p => isKimiProcess(p.command)) ? 'unknown' : 'offline', activeTasks: 0, waitingTasks: 0, live: false };
    if (processes === null) return fallback;
    let names = [];
    try {
      const dir = await fs.opendir(path.join(this.paths.current, 'server', 'instances'));
      let inspected = 0;
      for await (const item of dir) { if (++inspected > 32) return { ...fallback, activity: 'unknown' }; if (item.isFile() && item.name.endsWith('.json')) names.push(item.name); }
    } catch (error) { return error.code === 'ENOENT' ? fallback : { ...fallback, activity: 'unknown' }; }
    const running = new Set(); const waiting = new Set(); let live = false; let incomplete = false;
    const candidates = [];
    for (const name of names) {
      try {
        const row = JSON.parse(await boundedFile(path.join(this.paths.current, 'server', 'instances', name), this.paths.current, 16384));
        if (!validInstance(row, name, processes, now)) continue;
        if (candidates.length >= 4) { incomplete = true; continue; }
        candidates.push(row);
      } catch { incomplete = true; }
    }
    await Promise.all(candidates.map(async row => {
      try {
        if (!await this.checkPort(row.pid, row.port, this.platform)) { incomplete = true; return; }
        const token = (await privateFile(path.join(this.paths.current, 'server.token'), this.paths.current, this.platform)).trim();
        if (!validToken(token)) throw new KimiError('format');
        const hostname = ['::', '::1'].includes(row.host) ? '::1' : '127.0.0.1';
        const results = await Promise.all(Object.values(SESSION_PATHS).map(endpoint => this.request({ hostname, port: row.port, endpoint, token })));
        const [activeIds, waitingIds] = results.map(sessionIds);
        for (const id of activeIds) running.add(id);
        for (const id of waitingIds) waiting.add(id);
        live = true;
      } catch { incomplete = true; }
    }));
    return { activity: running.size ? 'running' : waiting.size ? 'waiting' : incomplete ? 'unknown' : live ? 'idle' : fallback.activity,
      activeTasks: running.size, waitingTasks: waiting.size, live };
  }
  async poll(processes, now = Date.now()) {
    if (this.pending) return this.pending;
    this.pending = this.collect(processes, now).finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect(processes, now) {
    const [activity] = await Promise.all([this.activity(processes, now), this.usage(now)]);
    const stale = Boolean(this.error) || Boolean(this.cache && now - this.cache.at > 120000);
    const planStale = Boolean(this.planError) || Boolean(this.planCache && now - this.planCache.at > 120000);
    return { id: 'kimi', source: this.cache ? stale ? 'cache' : 'account'
      : this.planCache ? planStale ? 'cache' : 'account' : activity.live ? 'local-api' : 'unavailable',
      connection: activity.live || (this.cache && !stale) || (this.planCache && !planStale) ? 'ready' : ['login', 'expired'].includes(this.error) ? 'auth-required' : this.error ? 'error' : 'offline',
      activity: activity.activity, activeTasks: activity.activeTasks, waitingTasks: activity.waitingTasks,
      task: activity.activeTasks ? `${activity.activeTasks} 项 Kimi 任务正在运行` : activity.waitingTasks ? `${activity.waitingTasks} 项任务等待回应`
        : activity.activity === 'idle' ? 'Kimi 本机服务暂无运行任务' : activity.activity === 'offline' ? 'Kimi Code 未运行' : 'Kimi 当前任务状态未知',
      quotas: (this.cache?.quotas || []).map(q => ({ ...q, stale: stale || Boolean(q.reset && Date.parse(q.reset) <= now) })),
      plan: this.planCache ? { ...this.planCache.plan, stale: planStale } : { name: null },
      observedAt: this.cache ? new Date(this.cache.at).toISOString() : null,
      sampledAt: new Date(now).toISOString(), activityObservedAt: activity.live ? new Date(now).toISOString() : null,
      detail: this.error ? DETAILS[this.error] || DETAILS.unreadable : '使用本设备 Kimi OAuth 登录态，每分钟只读查询官方额度和套餐；未返回的字段保持未知。'
        + (this.planError ? '套餐查询暂时失败，已有套餐仅作历史快照。' : ''),
      activityDetail: activity.live ? '读取本机 Kimi 服务的实时任务状态；校验进程、监听端口及一分钟内的心跳，不读取对话正文。'
        : '未发现可验证的本机 Kimi 服务；普通终端会话和旧版 CLI 的任务状态暂不可读，进程存在不代表正在运行。' };
  }
}
module.exports = { KimiStatusReader, KimiError, resolveKimiPaths, normalizeKimiUsage, normalizeKimiPlan, requestJson, readOAuth,
  isKimiProcess, validInstance, sessionIds, SESSION_PATHS, PROFILE_PATH, GLOBAL_SLOT };
