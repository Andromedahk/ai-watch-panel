const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, createDecipheriv } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readZcodeRuntimeContext } = require('./zcode-runtime-context.cjs');
const { ZcodeAccountError, rawToken, normalizeIdentity, normalizeSubscription, normalizeQuota,
  normalizeDisplayQuotas, requestZcodeJson } = require('./zcode-account-api.cjs');

const execute = promisify(execFile);
const MAX_FILE_BYTES = 1024 * 1024;
const REFRESH_MS = 60 * 1000;
const HISTORY_FRESH_MS = 2 * REFRESH_MS;
const MAX_COOLDOWNS = 16;
const FAMILY = 'bigmodel';
const KIND = 'individual-coding-plan';

const DETAILS = {
  login: '未发现可验证的 ZCode 当前账户凭据；请在 ZCode 客户端确认登录状态。',
  unsupported: '当前 ZCode 账户类型、数据目录或服务地址尚未支持。',
  permissions: 'ZCode 账户文件的归属或权限不符合只读要求。',
  unavailable: '未发现唯一且可验证的 ZCode 主进程。',
  format: 'ZCode 账户或额度格式暂不兼容。',
  identity: 'ZCode 本地账户与官方账户响应不一致，额度保持未知。',
  network: 'ZCode 账户查询暂时失败，历史快照不代表当前剩余额度。',
  rate: 'ZCode 账户服务要求稍后重试。',
};

class ZcodeAccountStatusError extends Error {
  constructor(code, retryMs = REFRESH_MS) { super(code); this.code = code; this.retryMs = retryMs; }
}

function hash(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function hasCustomHost(env) {
  return Object.entries(env || {}).some(([name, value]) => typeof value === 'string' && value.trim()
    && (/^ZAI_(?:.*_)?BUSINESS_BASE_URL$/.test(name) || /^BIGMODEL_(?:.*_)?API_BASE_URL$/.test(name)
      || name === 'BIGMODEL_OAUTH_USERINFO_URL'));
}

function resolveZcodeAccountPaths({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  if (platform !== 'darwin' || hasCustomHost(env)) throw new ZcodeAccountStatusError('unsupported');
  const environment = typeof env?.ZCODE_ENV === 'string' ? env.ZCODE_ENV.trim().toLowerCase() : '';
  if (environment && environment !== 'production') throw new ZcodeAccountStatusError('unsupported');
  const resolvedHome = path.resolve(home);
  for (const name of ['ZCODE_DATA_BASE_DIR', 'ZCODE_DESKTOP_HOME_DIR', 'HOME', 'USERPROFILE']) {
    const value = env?.[name];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!path.isAbsolute(value.trim()) || path.resolve(value.trim()) !== resolvedHome) throw new ZcodeAccountStatusError('unsupported');
  }
  const root = path.join(resolvedHome, '.zcode', 'v2');
  return { home: resolvedHome, root, setting: path.join(root, 'setting.json'), credentials: path.join(root, 'credentials.json') };
}

function isZcodeMainProcess(command) {
  return command === 'ZCode' || (typeof command === 'string' && /(?:^|\/)ZCode\.app\/Contents\/MacOS\/ZCode$/.test(command));
}

function commandOutput(value) {
  return typeof value === 'string' ? value : typeof value?.stdout === 'string' ? value.stdout : '';
}

async function verifyZcodeProcess(processes, runCommand = execute) {
  if (!Array.isArray(processes)) throw new ZcodeAccountStatusError('unavailable');
  const matches = processes.filter(row => Number.isSafeInteger(row?.pid) && row.pid > 0 && isZcodeMainProcess(row.command));
  if (matches.length !== 1) throw new ZcodeAccountStatusError('unavailable');
  const row = matches[0]; let output;
  try { output = commandOutput(await runCommand('ps', ['-ww', '-p', String(row.pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'comm='], { timeout: 2000, maxBuffer: 65536 })); }
  catch { throw new ZcodeAccountStatusError('unavailable'); }
  const match = output.trim().match(/^(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
  if (!match || Number(match[1]) !== process.getuid?.() || !isZcodeMainProcess(match[3])) throw new ZcodeAccountStatusError('unavailable');
  return { pid: row.pid, fingerprint: hash([row.pid, match[1], match[2], match[3]]) };
}

function sameMeta(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.mode === right.mode && left.uid === right.uid);
}

function sameNode(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid);
}

async function verifyRoot(root) {
  let canonical; let stat;
  try { [canonical, stat] = await Promise.all([fs.realpath(root), fs.lstat(root)]); }
  catch (error) { if (error.code === 'ENOENT') throw new ZcodeAccountStatusError('login'); throw new ZcodeAccountStatusError('permissions'); }
  if (canonical !== path.resolve(root) || stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new ZcodeAccountStatusError('permissions');
  }
  return stat;
}

async function readSecureJson(file, root, modes) {
  const rootBefore = await verifyRoot(root);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new ZcodeAccountStatusError('permissions');
  let before;
  try { before = await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') throw new ZcodeAccountStatusError('login'); throw new ZcodeAccountStatusError('permissions'); }
  const mode = before.mode & 0o777;
  if (before.isSymbolicLink() || !before.isFile() || before.uid !== process.getuid?.() || before.size > MAX_FILE_BYTES
    || !modes.includes(mode) || (mode & 0o022)) throw new ZcodeAccountStatusError('permissions');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!sameMeta(before, opened)) throw new ZcodeAccountStatusError('unavailable');
    const data = Buffer.alloc(MAX_FILE_BYTES + 1); let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset > MAX_FILE_BYTES) throw new ZcodeAccountStatusError('format');
    if (!sameMeta(opened, after)) throw new ZcodeAccountStatusError('unavailable');
    let value;
    try { value = JSON.parse(data.subarray(0, offset).toString('utf8')); }
    catch { throw new ZcodeAccountStatusError('format'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ZcodeAccountStatusError('format');
    let pathAfter; let canonicalFile; let rootAfter;
    try { [pathAfter, canonicalFile, rootAfter] = await Promise.all([fs.lstat(file), fs.realpath(file), verifyRoot(root)]); }
    catch (error) { if (error instanceof ZcodeAccountStatusError) throw error; throw new ZcodeAccountStatusError('unavailable'); }
    if (!sameMeta(after, pathAfter) || canonicalFile !== path.resolve(file) || !sameNode(rootBefore, rootAfter)) {
      throw new ZcodeAccountStatusError('unavailable');
    }
    return { value, meta: after, root: rootAfter };
  } finally { await handle.close(); }
}

function credentialKey({ env, platform, home, username }) {
  const secret = typeof env?.ZCODE_CREDENTIAL_SECRET === 'string' && env.ZCODE_CREDENTIAL_SECRET
    ? env.ZCODE_CREDENTIAL_SECRET : `zcode-credential-fallback:${platform}:${home}:${username}`;
  return createHash('sha256').update(secret).digest();
}

function decryptCredential(value, key) {
  if (typeof value !== 'string' || value.length > MAX_FILE_BYTES) throw new ZcodeAccountStatusError('login');
  if (!value.startsWith('enc:v1:')) return value;
  const pieces = value.slice(7).split('.');
  if (pieces.length !== 3 || pieces.some(piece => !/^[A-Za-z0-9_-]+$/.test(piece))) throw new ZcodeAccountStatusError('login');
  let iv; let tag; let body;
  try { [iv, tag, body] = pieces.map(piece => Buffer.from(piece, 'base64url')); }
  catch { throw new ZcodeAccountStatusError('login'); }
  if (iv.length !== 12 || tag.length !== 16 || body.length > MAX_FILE_BYTES) throw new ZcodeAccountStatusError('login');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch { throw new ZcodeAccountStatusError('login'); }
}

function metaSignature(meta) {
  return [meta.dev, meta.ino, meta.size, meta.mtimeMs, meta.mode, meta.uid];
}

function sessionExpiry(token, now) {
  const raw = rawToken(token);
  const parts = raw?.split('.');
  // The desktop client treats an absent/unreadable exp as unknown, and only
  // invalidates a cached BigModel session on a positively expired JWT.
  if (!parts || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { return; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= 0) return;
  if (payload.exp * 1000 <= now + 30000) {
    throw new ZcodeAccountStatusError('login');
  }
}

async function readBundle(paths) {
  const setting = await readSecureJson(paths.setting, paths.root, [0o600, 0o644]);
  const credentials = await readSecureJson(paths.credentials, paths.root, [0o600]);
  let settingAfter; let credentialsAfter;
  try { [settingAfter, credentialsAfter] = await Promise.all([fs.lstat(paths.setting), fs.lstat(paths.credentials)]); }
  catch { throw new ZcodeAccountStatusError('unavailable'); }
  const finalRoot = await verifyRoot(paths.root);
  if (!sameMeta(setting.meta, settingAfter) || !sameMeta(credentials.meta, credentialsAfter)
    || !sameNode(setting.root, credentials.root) || !sameNode(setting.root, finalRoot)) throw new ZcodeAccountStatusError('unavailable');
  return { setting: setting.value, credentials: credentials.value,
    generation: hash([metaSignature(setting.meta), metaSignature(credentials.meta)]) };
}

async function readZcodeAccountIdentity(processes, { home = os.homedir(), env = process.env, platform = process.platform,
  username = os.userInfo().username, runCommand = execute, now = Date.now(), readRuntimeContext = readZcodeRuntimeContext } = {}) {
  const paths = resolveZcodeAccountPaths({ home, env, platform });
  const runtime = await verifyZcodeProcess(processes, runCommand);
  const context = await readRuntimeContext(runtime.pid, { home: paths.home, runCommand });
  if (!context || !/^[a-f0-9]{64}$/.test(context.fingerprint || '')) throw new ZcodeAccountStatusError('unavailable');
  const bundle = await readBundle(paths);
  const setting = bundle.setting; const store = bundle.credentials;
  if (setting.dataBaseDir !== undefined && (typeof setting.dataBaseDir !== 'string'
    || setting.dataBaseDir.trim() && (!path.isAbsolute(setting.dataBaseDir.trim())
      || path.resolve(setting.dataBaseDir.trim()) !== paths.home))) throw new ZcodeAccountStatusError('unsupported');
  const family = setting.providerFamilyDomain;
  const kind = setting.providerFamilyConnectionSelections?.[family]?.kind;
  if (family !== FAMILY || kind !== KIND) throw new ZcodeAccountStatusError('unsupported');
  const key = credentialKey({ env, platform, home: paths.home, username });
  const session = store.zcodejwttoken === undefined ? '' : decryptCredential(store.zcodejwttoken, key).trim();
  if (session) sessionExpiry(session, now);
  if (decryptCredential(store['oauth:active_provider'], key) !== family) throw new ZcodeAccountStatusError('unsupported');
  let user;
  try { user = JSON.parse(decryptCredential(store[`oauth:${family}:user_info`], key)); }
  catch (error) { if (error instanceof ZcodeAccountStatusError) throw error; throw new ZcodeAccountStatusError('login'); }
  const uid = user?.id;
  if (typeof uid !== 'string' || !uid || uid.length > 256 || uid === 'unknown') throw new ZcodeAccountStatusError('login');
  const provider = `account:${family}-individual-coding-plan`;
  const apiKeyName = `account-provider:coding-plan:${provider}:account:${encodeURIComponent(uid)}:api-key`;
  const oauthToken = rawToken(decryptCredential(store[`oauth:${family}:access_token`], key));
  const apiKey = rawToken(decryptCredential(store[apiKeyName], key));
  if (!oauthToken || !apiKey) throw new ZcodeAccountStatusError('login');
  const accountKey = hash([family, uid]);
  const signature = hash([paths.root, family, uid, kind, oauthToken, apiKey, session]);
  return { family, kind, uid, oauthToken, apiKey, accountKey, signature,
    runtime: hash([runtime.fingerprint, context.fingerprint]), snapshot: bundle.generation };
}

function validIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.family !== FAMILY || value.kind !== KIND
    || typeof value.uid !== 'string' || !value.uid || value.uid.length > 256 || value.uid === 'unknown'
    || rawToken(value.oauthToken) !== value.oauthToken || rawToken(value.apiKey) !== value.apiKey
    || !/^[a-f0-9]{64}$/.test(value.accountKey || '') || !/^[a-f0-9]{64}$/.test(value.signature || '')
    || !/^[a-f0-9]{64}$/.test(value.runtime || '') || !/^[a-f0-9]{64}$/.test(value.snapshot || '')) {
    throw new ZcodeAccountStatusError('unavailable');
  }
  return value;
}

function failure(error) {
  return error instanceof ZcodeAccountError || error instanceof ZcodeAccountStatusError ? error : new ZcodeAccountStatusError('network');
}

class ZcodeAccountStatusReader {
  constructor({ home = os.homedir(), env = process.env, platform = process.platform, username = os.userInfo().username,
    readIdentity = readZcodeAccountIdentity, request = requestZcodeJson, runCommand = execute, clock = Date.now,
    readRuntimeContext = readZcodeRuntimeContext } = {}) {
    this.home = home; this.env = env; this.platform = platform; this.username = username;
    this.readIdentity = readIdentity; this.request = request; this.runCommand = runCommand; this.clock = clock;
    this.readRuntimeContext = readRuntimeContext;
    this.identity = null; this.runtime = null; this.planCache = null; this.quotaCache = null;
    this.planError = 'unavailable'; this.quotaError = 'unavailable'; this.nextAt = 0; this.pending = null;
    this.cooldowns = new Map();
  }
  clear(code, identity = true) {
    this.planCache = null; this.quotaCache = null; this.planError = code; this.quotaError = code; this.nextAt = 0;
    if (identity) { this.identity = null; this.runtime = null; }
  }
  cooldown(accountKey, until) {
    const current = this.cooldowns.get(accountKey) || 0;
    this.cooldowns.delete(accountKey); this.cooldowns.set(accountKey, Math.max(current, until));
    while (this.cooldowns.size > MAX_COOLDOWNS) this.cooldowns.delete(this.cooldowns.keys().next().value);
  }
  async getIdentity(processes, now) {
    return validIdentity(await this.readIdentity(processes, { home: this.home, env: this.env, platform: this.platform,
      username: this.username, runCommand: this.runCommand, now, readRuntimeContext: this.readRuntimeContext }));
  }
  async sample(processes, now, force) {
    const clockStarted = this.clock();
    const responseNow = () => now + Math.max(0, this.clock() - clockStarted);
    let grant;
    try { grant = await this.getIdentity(processes, now); }
    catch (error) { this.clear(error?.code || 'unavailable'); return; }
    if (grant.signature !== this.identity || grant.runtime !== this.runtime) {
      this.clear('unavailable', false); this.identity = grant.signature; this.runtime = grant.runtime;
    }
    const cooldownUntil = this.cooldowns.get(grant.accountKey) || 0;
    if (now < cooldownUntil) {
      if (!this.planCache && !this.quotaCache) { this.planError = 'rate'; this.quotaError = 'rate'; }
      return;
    }
    if (!force && now < this.nextAt) return;
    let remoteIdentity; let remoteFailure = null;
    try { remoteIdentity = normalizeIdentity(await this.request(grant.family, 'identity', grant.oauthToken)); }
    catch (error) { remoteFailure = failure(error); }
    if (!remoteFailure && remoteIdentity.customerNumber !== grant.uid) remoteFailure = new ZcodeAccountStatusError('identity');
    if (remoteFailure?.code === 'rate') this.cooldown(grant.accountKey, responseNow() + remoteFailure.retryMs);
    if (remoteFailure) {
      let latest;
      try { latest = await this.getIdentity(processes, responseNow()); }
      catch (error) { this.clear(error?.code || 'unavailable'); return; }
      if (latest.signature !== grant.signature || latest.runtime !== grant.runtime || latest.snapshot !== grant.snapshot) {
        this.clear('unavailable'); return;
      }
      if (['login', 'identity'].includes(remoteFailure.code)) { this.clear(remoteFailure.code); return; }
      this.planError = remoteFailure.code; this.quotaError = remoteFailure.code;
      this.nextAt = responseNow() + Math.max(REFRESH_MS, remoteFailure.retryMs || 0); return;
    }
    let confirmed;
    try { confirmed = await this.getIdentity(processes, responseNow()); }
    catch (error) { this.clear(error?.code || 'unavailable'); return; }
    if (confirmed.signature !== grant.signature || confirmed.runtime !== grant.runtime || confirmed.snapshot !== grant.snapshot) {
      this.clear('unavailable'); return;
    }
    const [subscription, quota] = await Promise.allSettled([
      Promise.resolve().then(() => this.request(grant.family, 'subscription', grant.apiKey)).then(normalizeSubscription),
      Promise.resolve().then(() => this.request(grant.family, 'quota', grant.apiKey)).then(normalizeQuota).then(normalizeDisplayQuotas),
    ]);
    const planFailure = subscription.status === 'rejected' ? failure(subscription.reason) : null;
    const quotaFailure = quota.status === 'rejected' ? failure(quota.reason) : null;
    for (const issue of [planFailure, quotaFailure]) {
      if (issue?.code === 'rate') this.cooldown(grant.accountKey, responseNow() + issue.retryMs);
    }
    let latest;
    try { latest = await this.getIdentity(processes, responseNow()); }
    catch (error) { this.clear(error?.code || 'unavailable'); return; }
    if (latest.signature !== grant.signature || latest.runtime !== grant.runtime || latest.snapshot !== grant.snapshot) {
      this.clear('unavailable'); return;
    }
    if (planFailure?.code === 'login' || quotaFailure?.code === 'login') { this.clear('login'); return; }
    const completedAt = responseNow();
    this.planError = planFailure?.code || null; this.quotaError = quotaFailure?.code || null;
    if (!planFailure) this.planCache = { plan: subscription.value.plan, at: completedAt };
    if (!quotaFailure) this.quotaCache = { quotas: quota.value, at: completedAt };
    this.nextAt = completedAt + REFRESH_MS;
  }
  async poll(processes, now = Date.now(), force = false) {
    if (this.pending) return this.pending;
    this.pending = this.collect(processes, now, force).finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect(processes, now, force) {
    await this.sample(processes, now, force);
    const planStale = Boolean(this.planError) || Boolean(this.planCache && now - this.planCache.at > HISTORY_FRESH_MS);
    const quotaStale = Boolean(this.quotaError) || Boolean(this.quotaCache && now - this.quotaCache.at > HISTORY_FRESH_MS);
    const caches = [this.planCache, this.quotaCache].filter(Boolean);
    const anyFresh = Boolean(this.planCache && !planStale) || Boolean(this.quotaCache && !quotaStale);
    const errors = [this.planError, this.quotaError].filter(Boolean);
    const primary = errors.find(code => ['login', 'identity', 'rate', 'network', 'format'].includes(code)) || errors[0];
    return { id: 'zcode', source: caches.length ? anyFresh ? 'account' : 'cache' : 'unavailable',
      connection: anyFresh ? 'ready' : primary === 'login' ? 'auth-required'
        : ['network', 'format', 'identity', 'rate'].includes(primary) ? 'error' : 'unavailable',
      plan: this.planCache ? { ...this.planCache.plan, stale: planStale } : { name: null, stale: false },
      quotas: (this.quotaCache?.quotas || []).map(row => ({ ...row,
        stale: quotaStale || Boolean(row.reset && Date.parse(row.reset) <= now) })),
      observedAt: caches.length ? new Date(Math.max(...caches.map(cache => cache.at))).toISOString() : null,
      sampledAt: new Date(now).toISOString(),
      detail: primary ? DETAILS[primary] || DETAILS.unavailable
        : '使用 ZCode 当前 BigModel 个人账户只读查询套餐与额度；不会续期登录、创建密钥或读取对话内容。' };
  }
}

module.exports = { ZcodeAccountStatusReader, ZcodeAccountStatusError, resolveZcodeAccountPaths, isZcodeMainProcess,
  verifyZcodeProcess, readSecureJson, credentialKey, decryptCredential, readBundle, readZcodeAccountIdentity,
  FAMILY, KIND, REFRESH_MS, HISTORY_FRESH_MS, MAX_COOLDOWNS };
