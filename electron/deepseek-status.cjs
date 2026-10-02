const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { createHash } = require('node:crypto');
const YAML = require('yaml');
const Big = require('big.js');

const ORIGIN = 'https://platform.deepseek.com';
const MAX_BYTES = 65536;
class BalanceError extends Error {
  constructor(code, retryMs = 60000) { super(code); this.code = code; this.retryMs = retryMs; }
}

// Match Harness's portable home selection; never encode a particular device/user.
function resolveHarnessHome({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (!configured) return paths.join(home, '.dsh');
  if (configured === '~') configured = home;
  else if (/^~[/\\]/.test(configured)) configured = paths.join(home, configured.slice(2));
  return paths.resolve(configured);
}
function parseGrant(text) {
  try {
    const doc = YAML.parseDocument(text, { uniqueKeys: true, stringKeys: true, schema: 'core',
      merge: false, prettyErrors: false, logLevel: 'silent' });
    if (doc.errors.length || doc.warnings.length) throw new BalanceError('format');
    const data = doc.toJS({ maxAliasCount: 0 });
    if (data?.version !== 1) throw new BalanceError('format');
    const record = data.records?.['deepseek-account-platform/default'];
    if (!record) throw new BalanceError('login');
    const grant = record.payload;
    if (record.kind !== 'grant' || grant?.version !== 1) throw new BalanceError('format');
    if (grant.issuer !== ORIGIN) throw new BalanceError('issuer');
    if (typeof grant.token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(grant.token)) throw new BalanceError('format');
    return { token: grant.token, identity: createHash('sha256').update(`${ORIGIN}\n${grant.token}`).digest('hex') };
  } catch (error) {
    // YAML diagnostics can contain credential text. Only return our fixed error codes.
    throw error instanceof BalanceError ? error : new BalanceError('format');
  }
}
async function readGrant(options) {
  const file = path.join(resolveHarnessHome(options), '.credentials.yaml');
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new BalanceError('format');
    if ((options.platform || process.platform) !== 'win32' && (stat.mode & 0o077)) throw new BalanceError('permissions');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new BalanceError('format');
    return parseGrant(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch (error) {
    if (error instanceof BalanceError) throw error;
    throw new BalanceError(error.code === 'ENOENT' ? 'login' : 'unreadable');
  } finally { await handle?.close(); }
}
function retryDelay(value, now = Date.now()) {
  if (typeof value !== 'string') return 60000;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(60000, Math.min(86400000, ms)) : 60000;
}
function requestBalance(token, { transport = https, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    // Fixed HTTPS destination. Node does not follow redirects; no cookies or disk cache.
    const request = transport.request({ protocol: 'https:', hostname: 'platform.deepseek.com',
      path: '/api/v0/users/get_user_summary', method: 'GET', agent: false,
      headers: { Accept: 'application/json', 'x-dsh-auth-token': token, 'User-Agent': 'AIWatch/0.3.0' } }, (response) => {
      const chunks = []; let bytes = 0;
      response.on('error', () => reject(new BalanceError('network')));
      if ([401, 403].includes(response.statusCode)) { response.destroy(); reject(new BalanceError('login')); return; }
      if (response.statusCode === 429) { const delay = retryDelay(response.headers['retry-after']); response.destroy(); reject(new BalanceError('rate', delay)); return; }
      if (response.statusCode !== 200) { response.destroy(); reject(new BalanceError('network')); return; }
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { reject(new BalanceError('format')); response.destroy(); }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new BalanceError('format')); }
      });
    });
    const deadline = setTimeout(() => request.destroy(), timeoutMs);
    request.on('close', () => { clearTimeout(deadline); reject(new BalanceError('network')); });
    request.on('error', () => reject(new BalanceError('network')));
    request.end();
  });
}
function normalizeWallets(root) {
  if (root?.code === 40003 || root?.data?.biz_code === 40003) throw new BalanceError('login');
  if (root?.code !== 0 || root?.data?.biz_code !== 0) throw new BalanceError('format');
  const data = root.data.biz_data;
  const groups = new Map();
  for (const [field, key] of [['normal_wallets', 'paid'], ['bonus_wallets', 'bonus']]) {
    const rows = data?.[field];
    if (!Array.isArray(rows) || rows.length > 32) throw new BalanceError('format');
    const seen = new Set();
    for (const row of rows) {
      if (!['CNY', 'USD'].includes(row?.currency) || seen.has(row.currency)
        || typeof row.balance !== 'string' || row.balance.length > 96
        || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/.test(row.balance)) throw new BalanceError('format');
      seen.add(row.currency);
      const amount = new Big(row.balance);
      if (amount.e > 12 || amount.e < -32) throw new BalanceError('format');
      const wallet = groups.get(row.currency) || { currency: row.currency, paid: '0', bonus: '0' };
      wallet[key] = amount.toFixed();
      groups.set(row.currency, wallet);
    }
  }
  // An absent wallet is unknown, not an invented zero balance. Currencies stay separate.
  return [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency))
    .map((wallet) => ({ ...wallet, total: new Big(wallet.paid).plus(wallet.bonus).toFixed() }));
}
const DETAILS = {
  login: '请先在本设备的 DeepSeek Harness 中登录账号；面板会自动识别，无需复制 Key。',
  permissions: 'Harness 登录文件权限不符合要求，请在 Harness 中检查或重新登录。',
  unreadable: '暂时无法读取 Harness 登录状态，请检查本设备的文件访问权限。',
  format: 'Harness 登录记录或余额格式暂不兼容，请更新面板后重试。',
  issuer: '当前 Harness 登录服务暂不支持，面板仅连接 DeepSeek 官方账户服务。',
  network: '余额查询暂时失败，稍后自动重试；历史金额不代表当前余额。',
  rate: '账户服务要求稍后重试，手动刷新也会遵守等待时间。',
};
class DeepSeekBalanceReader {
  constructor({ home = os.homedir(), env = process.env, platform = process.platform,
    request = requestBalance, now = Date.now } = {}) {
    this.options = { home, env, platform }; this.request = request; this.now = now;
    this.identity = null; this.cache = null; this.nextAt = 0; this.blockedUntil = 0; this.error = 'login';
    this.pending = null;
  }
  snapshot() {
    return { id: 'deepseek', source: this.cache ? this.error ? 'cache' : 'account' : 'unavailable',
      connection: this.error === 'login' ? 'auth-required' : this.error ? 'error' : 'ready',
      activity: 'unknown', activeTasks: 0, task: '任务状态尚未接入', quotas: [],
      balance: { wallets: this.cache?.wallets || [], stale: Boolean(this.cache && this.error) },
      observedAt: this.cache ? new Date(this.cache.at).toISOString() : null,
      sampledAt: new Date(this.now()).toISOString(),
      detail: this.error ? DETAILS[this.error] || DETAILS.network : '使用本设备 Harness 已有登录态查询官方账户余额，每分钟更新。余额连接不代表任务正在运行。' };
  }
  reset(identity = null) {
    this.identity = identity; this.cache = null; this.nextAt = 0; this.blockedUntil = 0; this.error = null;
  }
  async poll(force = false) {
    if (this.pending) return this.pending;
    this.pending = this.collect(force).finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect(force) {
    let grant;
    try { grant = await readGrant(this.options); }
    catch (error) { this.reset(); this.error = error.code; return this.snapshot(); }
    if (this.identity !== grant.identity) this.reset(grant.identity);
    if (this.now() < this.blockedUntil || (!force && this.now() < this.nextAt)) return this.snapshot();
    let wallets; let failure;
    try { wallets = normalizeWallets(await this.request(grant.token)); }
    catch (error) { failure = error instanceof BalanceError ? error : new BalanceError('network'); }
    // A login/logout/account change during the network request invalidates its result.
    try {
      const latest = await readGrant(this.options);
      if (latest.identity !== grant.identity) {
        this.reset(latest.identity); this.error = 'login'; return this.snapshot();
      }
    } catch (error) { this.reset(); this.error = error.code; return this.snapshot(); }
    this.nextAt = this.now() + 60000;
    this.error = failure?.code || null;
    if (!failure) this.cache = { wallets, at: this.now() };
    else if (failure.code === 'login') this.cache = null;
    else if (failure.code === 'rate') this.blockedUntil = this.now() + failure.retryMs;
    return this.snapshot();
  }
}
module.exports = { resolveHarnessHome, parseGrant, readGrant, normalizeWallets,
  requestBalance, retryDelay, BalanceError, DeepSeekBalanceReader };
