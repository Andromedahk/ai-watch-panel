const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { discoverMacApp } = require('./provider-launcher.cjs');
const { normalizeCodexRates, normalizeCodexPlan, unknownCodexQuotas, QUOTA_FRESH_MS } = require('./status-normalizers.cjs');

const INTERVAL_MS = 60000;
const MANUAL_INTERVAL_MS = 15000;
const MAX_BYTES = 2 * 1024 * 1024;

async function findCodexExecutable({ platform = process.platform, home = os.homedir(),
  env = process.env, discover = discoverMacApp, io = fs } = {}) {
  const candidates = [];
  if (platform === 'darwin') {
    const app = await discover('codex', { roots: ['/Applications', path.join(home, 'Applications')] });
    if (app) for (const relative of ['Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      'Contents/Resources/codex-cli/bin/codex', 'Contents/Resources/codex']) candidates.push(path.join(app, relative));
  }
  const separator = platform === 'win32' ? ';' : ':';
  for (const directory of (env.PATH || env.Path || '').split(separator).slice(0, 128)) {
    if (path.isAbsolute(directory)) candidates.push(path.join(directory, platform === 'win32' ? 'codex.exe' : 'codex'));
  }
  for (const candidate of candidates) {
    try {
      const resolved = await io.realpath(candidate);
      const stat = await io.stat(resolved);
      if (stat.isFile() && (platform === 'win32' || stat.mode & 0o111)) return resolved;
    } catch { /* No download or shell lookup: use an already installed official client. */ }
  }
  return null;
}

function accountIdentity(account) {
  if (account?.type !== 'chatgpt' || typeof account.email !== 'string' || !account.email) return null;
  // Internal comparison only; never expose account fields or this fingerprint to the renderer.
  return createHash('sha256').update(JSON.stringify([account.email, account.accountId ?? account.id ?? null])).digest('hex');
}

function queryCodexRates(binary, { codexHome, signal, onAccount = () => {}, timeoutMs = 12000,
  spawnImpl = spawn, now = Date.now } = {}) {
  return new Promise(resolve => {
    let child; let ended = false; let exited = false; let buffer = ''; let bytes = 0; let nextId = 0;
    const decoder = new StringDecoder('utf8');
    const requests = new Map();
    let deadline; let killTimer;
    function finish(result) {
      if (ended) return;
      ended = true; clearTimeout(deadline); signal?.removeEventListener('abort', abort);
      for (const request of requests.values()) request.reject(new Error('Query stopped'));
      requests.clear();
      if (child) {
        child.stdin.end(); child.kill('SIGTERM');
        if (!exited) {
          killTimer = setTimeout(() => child.kill('SIGKILL'), 700);
          killTimer.unref?.();
        }
      }
      resolve(result);
    }
    function abort() { finish({ status: 'error' }); }
    function write(value) { child.stdin.write(JSON.stringify(value) + '\n'); }
    function request(method, params) {
      const id = ++nextId;
      return new Promise((resolveRequest, reject) => {
        requests.set(id, { resolve: resolveRequest, reject });
        write({ id, method, ...(params === undefined ? {} : { params }) });
      });
    }
    if (signal?.aborted) { finish({ status: 'error' }); return; }
    try {
      child = spawnImpl(binary, ['app-server', '--listen', 'stdio://'], { cwd: os.tmpdir(),
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) } });
    } catch { finish({ status: 'error' }); return; }
    signal?.addEventListener('abort', abort, { once: true });
    deadline = setTimeout(() => finish({ status: 'error' }), timeoutMs);
    child.on('error', abort);
    child.on('exit', () => { exited = true; clearTimeout(killTimer); if (!ended) abort(); });
    child.stdin.on('error', abort);
    child.stdout.on('error', abort);
    // Server diagnostics may contain account or machine information. Drain without logging/storing.
    child.stderr.on('data', () => {});
    child.stderr.on('error', abort);
    child.stdout.on('data', chunk => {
      if (ended) return;
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { abort(); return; }
      buffer += decoder.write(chunk);
      let newline;
      while (!ended && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { abort(); return; }
        if (!message || typeof message !== 'object') { abort(); return; }
        const pending = requests.get(message.id);
        if (pending && !message.method) {
          requests.delete(message.id);
          if (message.error) pending.reject(new Error('Official query failed'));
          else pending.resolve(message.result);
        } else if (message.id != null && message.method) {
          // Never execute server requests, turns, approvals or client tools.
          write({ id: message.id, error: { code: -32601, message: 'Unsupported method' } });
        }
      }
    });
    void (async () => {
      try {
        await request('initialize', { clientInfo: { name: 'ai_watch', version: require('../package.json').version }, capabilities: {} });
        if (ended) return;
        write({ method: 'initialized' });
        const first = (await request('account/read', { refreshToken: false }))?.account;
        const identity = accountIdentity(first);
        onAccount(identity);
        if (!identity) { finish({ status: 'auth-required' }); return; }
        const payload = await request('account/rateLimits/read');
        if (!payload || typeof payload !== 'object' || (!Object.hasOwn(payload, 'rateLimits') && !Object.hasOwn(payload, 'rateLimitsByLimitId'))) throw new Error('Invalid rate response');
        const second = (await request('account/read', { refreshToken: false }))?.account;
        const checkedIdentity = accountIdentity(second);
        onAccount(checkedIdentity);
        if (!checkedIdentity) { finish({ status: 'auth-required' }); return; }
        if (checkedIdentity !== identity) { finish({ status: 'account-changed' }); return; }
        const at = now();
        const plan = normalizeCodexPlan(payload, at, at);
        if (!plan.name) plan.name = normalizeCodexPlan({ planType: second.planType }, at, at).name;
        finish({ status: 'ready', at, quotas: normalizeCodexRates(payload, at, at, { includeMissing: false }),
          plan: { ...plan, status: '官方查询' } });
      } catch { finish({ status: 'error' }); }
    })();
  });
}

class CodexQuotaReader {
  constructor({ home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex'),
    find = () => findCodexExecutable({ home }), query = queryCodexRates, now = Date.now } = {}) {
    this.codexHome = codexHome; this.find = find; this.query = query; this.now = now;
    this.cache = null; this.identity = null; this.allowLocal = true;
    this.lastAttempt = null; this.retryAt = 0; this.failures = 0;
    this.pending = null; this.closed = false; this.state = 'unavailable';
  }
  onAccount(identity) {
    if (!identity || (this.identity && identity !== this.identity)) {
      this.cache = null;
      this.allowLocal = false; // Unbound local rollouts may belong to the previous login.
    }
    this.identity = identity;
  }
  view() {
    const now = this.now();
    if (this.cache) {
      const historical = this.state !== 'ready';
      return { useLocal: false, source: historical ? 'cache' : 'account', connection: historical ? 'error' : 'ready',
        quotas: this.cache.quotas.map(quota => ({ ...quota, stale: historical || quota.stale || now - this.cache.at > QUOTA_FRESH_MS
          || Boolean(quota.reset && Date.parse(quota.reset) <= now) })),
        plan: { ...this.cache.plan, status: historical ? '官方查询缓存' : '官方查询', stale: historical || now - this.cache.at > QUOTA_FRESH_MS },
        observedAt: new Date(this.cache.at).toISOString(),
        detail: historical ? '官方额度查询暂时失败，显示上次查询的历史值，稍后自动重试；不是当前余额。'
          : '使用本机已登录的 Codex 查询官方账号额度，每分钟更新；仅显示服务实际返回的窗口，未返回的五小时额度不推测。' };
    }
    return { useLocal: this.allowLocal, source: 'unavailable', connection: this.state === 'auth-required' ? 'auth-required' : this.state === 'error' ? 'error' : 'unavailable',
      quotas: unknownCodexQuotas(), plan: { name: null }, observedAt: null,
      detail: this.state === 'auth-required' ? '请在本设备 Codex 中使用 ChatGPT 账号登录；API Key 登录不提供订阅额度。'
        : this.state === 'account-changed' ? '登录账号发生变化，已清除旧额度，稍后重新查询。'
          : '官方查询暂不可用；可使用本地额度记录，记录不能单独确认当前登录账号。' };
  }
  async poll(force = false) {
    if (this.pending) return this.pending;
    const now = this.now();
    if (this.closed || now < this.retryAt || (this.lastAttempt !== null && now - this.lastAttempt < (force ? MANUAL_INTERVAL_MS : INTERVAL_MS))) return this.view();
    this.lastAttempt = now;
    this.controller = new AbortController();
    this.pending = (async () => {
      let result;
      try {
        const binary = await this.find();
        result = binary && !this.closed ? await this.query(binary, { codexHome: this.codexHome,
          signal: this.controller.signal, onAccount: identity => this.onAccount(identity), now: this.now }) : { status: 'unavailable' };
      } catch { result = { status: 'error' }; }
      if (this.closed) return this.view();
      this.state = result.status;
      if (result.status === 'ready') {
        this.cache = { at: result.at, quotas: result.quotas, plan: result.plan }; this.failures = 0; this.retryAt = 0;
      } else {
        if (result.status === 'auth-required' || result.status === 'account-changed') { this.cache = null; this.allowLocal = false; }
        this.failures = Math.min(5, this.failures + 1);
        this.retryAt = this.now() + Math.min(300000, 30000 * 2 ** (this.failures - 1));
      }
      return this.view();
    })().finally(() => { this.pending = null; this.controller = null; });
    return this.pending;
  }
  close() { this.closed = true; this.controller?.abort(); this.cache = null; }
}

module.exports = { CodexQuotaReader, queryCodexRates, findCodexExecutable, INTERVAL_MS, MANUAL_INTERVAL_MS };
