// Optional read-only subscription query. Credentials remain in the main process;
// only normalized quota/plan fields leave this module. No refresh or inference.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, createDecipheriv, pbkdf2Sync, timingSafeEqual } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { boundedFile } = require('./session-files.cjs');
const execute = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CLIENT = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ORIGIN = 'https://api.anthropic.com';
const ENDPOINTS = Object.freeze({ profile: '/api/oauth/profile', usage: '/api/oauth/usage' });
const BASE_SCOPES = ['user:inference', 'user:file_upload', 'user:profile'];
const SCOPES = new Set([...BASE_SCOPES, 'user:sessions:claude_code', 'user:plugins']);
const WINDOWS = Object.freeze([['five_hour', '全部模型', '5 小时'], ['seven_day', '全部模型', '1 周'],
  ['seven_day_opus', 'Opus', '1 周'], ['seven_day_sonnet', 'Sonnet', '1 周'],
  ['seven_day_oauth_apps', 'OAuth 应用', '1 周'], ['seven_day_cowork', 'Cowork', '1 周']]);
class ClaudeUsageError extends Error {
  constructor(code, retryMs = 60000) { super(code); this.code = code; this.retryMs = retryMs; }
}
const DETAILS = Object.freeze({
  ready: '使用所选客户端的本地登录，查询 Claude 官方额度和套餐。',
  login: '未找到所选客户端的有效登录，请在该客户端重新登录。',
  auth: 'Claude 登录已失效，请在所选客户端重新登录。',
  keychain: 'Claude 钥匙串暂不可读；处理系统授权后请手动刷新，不会自动反复弹窗。',
  network: 'Claude 联网查询暂时失败；保留的数值仅为历史快照。',
  rate: 'Claude 服务要求稍后重试，手动刷新也会遵守等待时间。',
  format: 'Claude 登录或服务端数据格式暂不兼容，未提供的额度保持未知。',
  platform: '当前平台暂不支持读取 Claude 桌面登录；仍显示本地记录。',
  disabled: '已关闭 Claude 联网查询，当前仅显示本地记录。',
});
function expiry(value) {
  try { return Number((BigInt(value) - 11644473600000000n) / 1000n); } catch { return NaN; }
}
async function contained(file, root, limit) {
  const [real, base] = await Promise.all([fs.realpath(file), fs.realpath(root)]);
  const stat = await fs.lstat(file);
  if (!real.startsWith(base + path.sep) || stat.isSymbolicLink() || !stat.isFile() || stat.size > limit) throw new ClaudeUsageError('format');
  return real;
}
async function readDesktopSnapshot(root, now) {
  let buffer;
  try {
    const configFile = await contained(path.join(root, 'config.json'), root, 1024 * 1024);
    buffer = await boundedFile(configFile, root, 1024 * 1024);
    const config = JSON.parse(buffer.toString('utf8'));
    const encryptedCache = config['oauth:tokenCacheV2'];
    if (!UUID.test(config.lastKnownAccountUuid || '') || typeof encryptedCache !== 'string'
      || encryptedCache.length > 512 * 1024 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encryptedCache)) throw new ClaudeUsageError('login');
    const file = await contained(path.join(root, 'Cookies'), root, 64 * 1024 * 1024);
    for (const suffix of ['-wal', '-shm']) {
      try { await contained(file + suffix, root, 16 * 1024 * 1024); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true, timeout: 200 });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
      const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value);
      // Only the selected organization is decrypted. The session cookie is used
      // solely to establish login presence / changes and is never sent anywhere.
      const rows = db.prepare(`SELECT name, host_key, value, encrypted_value, CAST(expires_utc AS TEXT) AS expires,
        CAST(creation_utc AS TEXT) AS created, has_expires FROM cookies
        WHERE host_key = '.claude.ai' AND path = '/' AND name IN ('sessionKey', 'lastActiveOrg') LIMIT 3`).all();
      if (!Number.isInteger(version) || version < 1 || rows.length !== 2
        || rows.some(row => ![0, 1].includes(row.has_expires)
          || (row.has_expires && (!Number.isFinite(expiry(row.expires)) || expiry(row.expires) <= now)))
        || rows.some(row => !row.value && !row.encrypted_value?.length)) throw new ClaudeUsageError('login');
      const session = rows.find(row => row.name === 'sessionKey'), org = rows.find(row => row.name === 'lastActiveOrg');
      if (!session || !org) throw new ClaudeUsageError('login');
      const identity = createHash('sha256').update(encryptedCache).update(config.lastKnownAccountUuid.toLowerCase())
        .update(Buffer.from(session.encrypted_value)).update(session.value).update(session.created)
        .update(Buffer.from(org.encrypted_value)).update(org.value).digest('hex');
      return { identity, account: config.lastKnownAccountUuid.toLowerCase(), encryptedCache, org, version };
    } finally { db.close(); }
  } catch (error) { throw error instanceof ClaudeUsageError ? error : new ClaudeUsageError(error.code === 'ENOENT' ? 'login' : 'format'); }
  finally { buffer?.fill(0); }
}
async function getClaudePassword() {
  try {
    const { stdout } = await execute('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Claude Safe Storage'],
      { timeout: 15000, maxBuffer: 2048, encoding: 'utf8' });
    const value = stdout.replace(/\r?\n$/, '');
    if (!/^[\x20-\x7e]{1,1024}$/.test(value)) throw new Error();
    return value;
  } catch { throw new ClaudeUsageError('keychain'); }
}
function decryptStorage(input, password, host) {
  let bytes, key, clear;
  try {
    if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) throw new ClaudeUsageError('format');
    bytes = Buffer.from(input);
    if (bytes.length < 19 || bytes.length > 512 * 1024 || bytes.subarray(0, 3).toString() !== 'v10'
      || (bytes.length - 3) % 16 !== 0 || typeof password !== 'string' || !/^[\x20-\x7e]{1,1024}$/.test(password)) throw new ClaudeUsageError('format');
    key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const cipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
    clear = Buffer.concat([cipher.update(bytes.subarray(3)), cipher.final()]);
    if (host) {
      const digest = createHash('sha256').update(host).digest();
      if (clear.length <= 32 || !timingSafeEqual(clear.subarray(0, 32), digest)) throw new ClaudeUsageError('format');
      return new TextDecoder('utf8', { fatal: true }).decode(clear.subarray(32));
    }
    return new TextDecoder('utf8', { fatal: true }).decode(clear);
  } catch { throw new ClaudeUsageError('format'); }
  finally { key?.fill(0); clear?.fill(0); bytes?.fill(0); }
}
function desktopCredential(snapshot, password, now) {
  if (!UUID.test(snapshot?.account || '') || !snapshot.org || typeof snapshot.encryptedCache !== 'string'
    || !/^[a-zA-Z0-9+/]+={0,2}$/.test(snapshot.encryptedCache) || snapshot.encryptedCache.length > 512 * 1024) throw new ClaudeUsageError('format');
  const org = snapshot.org.encrypted_value?.length
    ? decryptStorage(snapshot.org.encrypted_value, password, snapshot.version >= 24 ? '.claude.ai' : null) : snapshot.org.value;
  if (!UUID.test(org || '')) throw new ClaudeUsageError('format');
  let cache, encrypted;
  try { encrypted = Buffer.from(snapshot.encryptedCache, 'base64'); cache = JSON.parse(decryptStorage(encrypted, password)); }
  catch { throw new ClaudeUsageError('format'); }
  finally { encrypted?.fill(0); }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache) || Object.keys(cache).length > 64) throw new ClaudeUsageError('format');
  const account = snapshot.account.toLowerCase();
  const prefix = `acct:${account}|${CLIENT}:${org.toLowerCase()}:${ORIGIN}:`;
  const candidates = Object.entries(cache).filter(([key, entry]) => key.startsWith(prefix)
    && validDesktopScope(key.slice(prefix.length)) && entry && !Array.isArray(entry) && validToken(entry.token)
    && Number.isFinite(entry.expiresAt) && entry.expiresAt > now + 30000);
  candidates.sort((a, b) => a[0].length - b[0].length);
  if (!candidates.length) throw new ClaudeUsageError('login');
  return { token: candidates[0][1].token, account, org: org.toLowerCase() };
}
function validDesktopScope(value) {
  if (!/^[a-z_:]+(?: [a-z_:]+)*$/.test(value) || value.length > 256) return false;
  const scopes = value.split(' ');
  return new Set(scopes).size === scopes.length && BASE_SCOPES.every(scope => scopes.includes(scope))
    && scopes.every(scope => SCOPES.has(scope));
}
function validToken(value) { return typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/.test(value); }
async function readCodeSnapshot(config, platform, now) {
  let buffer;
  try {
    const file = path.join(config, '.credentials.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (platform !== 'win32' && (stat.mode & 0o077))) throw new ClaudeUsageError('login');
    buffer = await boundedFile(file, config, 65536);
    const oauth = JSON.parse(buffer.toString('utf8')).claudeAiOauth;
    if (!validToken(oauth?.accessToken) || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= now + 30000
      || !Array.isArray(oauth.scopes) || oauth.scopes.length > 32 || !oauth.scopes.includes('user:profile')
      || oauth.scopes.some(scope => typeof scope !== 'string' || !/^[a-z_:]{1,64}$/.test(scope))) throw new ClaudeUsageError('login');
    const latest = await fs.lstat(file);
    if (!latest.isFile() || latest.isSymbolicLink() || (platform !== 'win32' && (latest.mode & 0o077))
      || stat.dev !== latest.dev || stat.ino !== latest.ino || stat.mtimeMs !== latest.mtimeMs || stat.size !== latest.size) throw new ClaudeUsageError('login');
    return { identity: createHash('sha256').update(oauth.accessToken).update(String(oauth.expiresAt)).digest('hex'),
      credential: { token: oauth.accessToken } };
  } catch (error) { throw error instanceof ClaudeUsageError ? error : new ClaudeUsageError('login'); }
  finally { buffer?.fill(0); }
}
async function defaultFetch(url, options) {
  const electron = require('electron');
  return typeof electron?.net?.fetch === 'function' ? electron.net.fetch(url, options) : fetch(url, options);
}
async function requestJson(kind, token, { fetcher = defaultFetch, timeoutMs = 8000, signal } = {}) {
  if (!Object.hasOwn(ENDPOINTS, kind) || !validToken(token) || !Number.isInteger(timeoutMs)
    || timeoutMs < 100 || timeoutMs > 15000 || typeof fetcher !== 'function') throw new ClaudeUsageError('format');
  const url = ORIGIN + ENDPOINTS[kind]; const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  let rejectAbort, reader;
  const aborted = new Promise((resolve, reject) => { rejectAbort = () => reject(new ClaudeUsageError('network')); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  const run = async () => {
    if (controller.signal.aborted) throw new ClaudeUsageError('network');
    const response = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
      signal: controller.signal, headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' } });
    if (controller.signal.aborted) { response.body?.cancel().catch(() => {}); throw new ClaudeUsageError('network'); }
    if (response.url && response.url !== url) { response.body?.cancel().catch(() => {}); throw new ClaudeUsageError('format'); }
    if (response.status !== 200) {
      const value = response.headers.get('retry-after');
      const seconds = value === null || value.trim() === '' ? NaN : Number(value);
      const dateMs = typeof value === 'string' ? Date.parse(value) - Date.now() : NaN;
      const wait = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(dateMs) ? dateMs : 300000;
      const retryMs = Math.min(86400000, Math.max(60000, wait));
      response.body?.cancel().catch(() => {});
      throw new ClaudeUsageError([401, 403].includes(response.status) ? 'auth' : response.status === 429 ? 'rate' : 'network', retryMs);
    }
    reader = response.body?.getReader(); if (!reader) throw new ClaudeUsageError('format');
    const chunks = []; let size = 0, bytes;
    try {
      while (true) {
        const row = await reader.read(); if (row.done) break;
        if (!(row.value instanceof Uint8Array)) throw new ClaudeUsageError('format');
        size += row.value.length;
        if (size > 256 * 1024) throw new ClaudeUsageError('format');
        chunks.push(Buffer.from(row.value));
      }
      try { bytes = Buffer.concat(chunks); return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
      catch { throw new ClaudeUsageError('format'); }
    } finally { chunks.forEach(chunk => chunk.fill(0)); bytes?.fill(0); }
  };
  try {
    return await Promise.race([run(), aborted]);
  } catch (error) { throw error instanceof ClaudeUsageError ? error : new ClaudeUsageError('network'); }
  finally {
    clearTimeout(deadline); controller.signal.removeEventListener('abort', rejectAbort);
    signal?.removeEventListener('abort', forwardAbort);
    reader?.cancel().catch(() => {});
  }
}
function normalizeProfile(payload, credential) {
  const account = payload?.account?.uuid, org = payload?.organization?.uuid;
  if (!UUID.test(account || '') || !UUID.test(org || '') || (credential.account && account.toLowerCase() !== credential.account)
    || (credential.org && org.toLowerCase() !== credential.org)) throw new ClaudeUsageError('auth');
  const names = { claude_free: 'Free', claude_pro: 'Pro', claude_max: 'Max', claude_team: 'Team', claude_enterprise: 'Enterprise' };
  const type = payload.organization.organization_type;
  let name = Object.hasOwn(names, type) ? names[type] : null;
  const tier = payload.organization.rate_limit_tier;
  if (name === 'Max' && tier === 'default_claude_max_5x') name = 'Max 5×';
  if (name === 'Max' && tier === 'default_claude_max_20x') name = 'Max 20×';
  return { name, stale: false };
}
function normalizeUsage(payload, now) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ClaudeUsageError('format');
  const quotas = [];
  const add = (window, model, period, percentKey = 'utilization') => {
    const used = window?.[percentKey];
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return;
    const at = typeof window.resets_at === 'string' && window.resets_at.length < 64 ? Date.parse(window.resets_at)
      : typeof window.resets_at === 'number' && Number.isFinite(window.resets_at) ? window.resets_at * 1000 : NaN;
    const reset = Number.isFinite(at) && Math.abs(at) <= 8640000000000000 ? new Date(at).toISOString() : '';
    quotas.push({ model, period, remaining: Math.round((100 - used) * 10) / 10, reset, stale: !!reset && at <= now });
  };
  for (const [key, model, period] of WINDOWS) add(payload[key], model, period);
  if (payload.limits != null && (!Array.isArray(payload.limits) || payload.limits.length > 32)) throw new ClaudeUsageError('format');
  if (Array.isArray(payload.limits) && payload.limits.length <= 32) for (const row of payload.limits) {
    const model = row?.scope?.model?.display_name;
    if (row?.kind !== 'weekly_scoped' || typeof model !== 'string' || !/^(?:Claude )?(?:Opus|Sonnet|Haiku)(?: \d+(?:\.\d+)?)?$/.test(model)) continue;
    add(row, model, '1 周', 'percent');
  }
  // Empty/null windows are a valid response, particularly for free accounts.
  // Never manufacture 0% or 100% for windows the service did not provide.
  if (!Object.keys(payload).some(key => key === 'limits' || key === 'extra_usage' || WINDOWS.some(([known]) => key === known))) throw new ClaudeUsageError('format');
  return { quotas, observedAt: new Date(now).toISOString() };
}
class ClaudeUsageReader {
  constructor({ paths, platform = process.platform, allowed = false, getPassword = getClaudePassword,
    readDesktop = readDesktopSnapshot, readCode = readCodeSnapshot, request = requestJson } = {}) {
    this.paths = paths; this.platform = platform; this.allowed = allowed === true; this.getPassword = getPassword;
    this.readDesktop = readDesktop; this.readCode = readCode; this.request = request;
    this.epoch = 0; this.password = null; this.keychainFailed = false; this.rateUntil = 0; this.reset();
  }
  reset() {
    this.pending?.controller.abort(); this.pending = null;
    this.identity = null; this.cache = null; this.source = null; this.nextAt = 0; this.minAt = 0; this.error = null; this.authIdentity = null;
  }
  setAllowed(value) {
    if (this.allowed === (value === true)) return;
    this.allowed = value === true; this.epoch++; this.password = null; this.keychainFailed = false; this.reset();
  }
  clearSource() { this.epoch++; this.password = null; this.reset(); }
  async poll(source, now = Date.now(), force = false) {
    if (!this.allowed) return { state: 'disabled', detail: DETAILS.disabled };
    if (!['desktop', 'code'].includes(source) || !Number.isFinite(now) || now < 0 || now > 8640000000000000) return { state: 'format', detail: DETAILS.format };
    if (source === 'desktop' && this.platform !== 'darwin') return { state: 'platform', detail: DETAILS.platform };
    if (this.source !== source) { this.epoch++; this.password = null; this.reset(); this.source = source; }
    if (this.pending) return this.pending.promise;
    const epoch = this.epoch;
    const pending = { controller: new AbortController() };
    pending.promise = this.pollCurrent(source, now, force === true, epoch, pending.controller.signal);
    this.pending = pending;
    try { return await pending.promise; }
    finally { if (this.pending === pending) this.pending = null; }
  }
  async pollCurrent(source, now, force, epoch, signal) {
    const current = () => epoch === this.epoch && this.allowed;
    const disabled = () => ({ state: 'disabled', detail: DETAILS.disabled });
    let snapshot;
    const read = () => source === 'desktop' ? this.readDesktop(this.paths.desktop, now) : this.readCode(this.paths.config, this.platform, now);
    try { snapshot = await read(); }
    catch (error) {
      if (!current()) return disabled();
      this.cache = null; this.identity = null;
      this.error = error instanceof ClaudeUsageError && Object.hasOwn(DETAILS, error.code) ? error.code : 'login'; return this.result(now);
    }
    if (!current()) return disabled();
    if (!snapshot || typeof snapshot.identity !== 'string' || !snapshot.identity || snapshot.identity.length > 256) {
      this.cache = null; this.error = 'format'; return this.result(now);
    }
    if (this.identity !== snapshot.identity) {
      this.cache = null; this.identity = snapshot.identity; this.nextAt = 0; this.minAt = 0; this.authIdentity = null; this.error = null;
    }
    // A provider rate limit also applies after token rotation or a source change.
    if (now < this.rateUntil) { this.error = 'rate'; return this.result(now); }
    if (this.authIdentity === snapshot.identity || now < this.minAt || (!force && now < this.nextAt)) return this.result(now);
    let credential;
    const unchanged = async () => {
      const latest = await read();
      if (!current()) return false;
      if (latest.identity !== snapshot.identity) throw new ClaudeUsageError('auth');
      return true;
    };
    try {
      if (source === 'desktop') {
        if (!this.password) {
          if (this.keychainFailed && !force) throw new ClaudeUsageError('keychain');
          let password;
          try { password = await this.getPassword(); }
          catch { if (current()) this.keychainFailed = true; throw new ClaudeUsageError('keychain'); }
          if (!current()) return disabled();
          this.password = password; this.keychainFailed = false;
        }
        if (!current()) return disabled();
        credential = desktopCredential(snapshot, this.password, now);
      } else credential = snapshot.credential;
      if (!validToken(credential?.token)) throw new ClaudeUsageError('login');
      if (!(await unchanged())) return disabled();
      this.minAt = now + 15000;
      // Confirm the selected identity before asking for its subscription quota.
      const profile = await this.request('profile', credential.token, { signal });
      if (!current()) return disabled();
      const plan = normalizeProfile(profile, credential);
      if (!(await unchanged())) return disabled();
      const usage = await this.request('usage', credential.token, { signal });
      if (!current() || !(await unchanged())) return disabled();
      const normalized = normalizeUsage(usage, now);
      if (!current()) return disabled();
      this.cache = { plan: { ...plan, observedAt: normalized.observedAt }, usage: normalized, at: now };
      this.error = null; this.nextAt = now + 300000;
    } catch (error) {
      if (!current()) return disabled();
      const failure = error instanceof ClaudeUsageError && Object.hasOwn(DETAILS, error.code) ? error : new ClaudeUsageError('network');
      this.error = failure.code; this.nextAt = now + 60000;
      if (failure.code === 'rate') this.rateUntil = now + (Number.isFinite(failure.retryMs) ? Math.min(86400000, Math.max(60000, failure.retryMs)) : 300000);
      if (failure.code === 'auth') this.authIdentity = snapshot.identity;
      if (['auth', 'login', 'format', 'keychain'].includes(failure.code)) this.cache = null;
    }
    return this.result(now);
  }
  result(now) {
    const stale = !!this.error || !this.cache || now - this.cache.at > 600000;
    return { state: this.error || 'ready', detail: DETAILS[this.error] || DETAILS.ready,
      ...(this.cache ? { plan: { ...this.cache.plan, stale }, usage: { ...this.cache.usage,
        quotas: this.cache.usage.quotas.map(row => ({ ...row, stale: stale || row.stale || (!!row.reset && Date.parse(row.reset) <= now) })) } } : {}) };
  }
}
module.exports = { ClaudeUsageReader, ClaudeUsageError, readDesktopSnapshot, getClaudePassword, decryptStorage,
  desktopCredential, readCodeSnapshot, requestJson, normalizeProfile, normalizeUsage, DETAILS, CLIENT, ORIGIN, ENDPOINTS };
