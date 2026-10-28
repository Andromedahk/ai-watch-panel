const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { PROVIDER_ORDER } = require('./window-policy.cjs');

const INTERVAL = 5000;
const MAX_BYTES = 256 * 1024;
const CONNECTIONS = new Set(['ready', 'offline', 'unavailable', 'error', 'auth-required']);
const ACTIVITIES = new Set(['running', 'waiting', 'idle', 'unknown', 'offline']);
const text = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// This is an allowlist projection, never a copy of a provider's raw state.
function projectStatus(status, { enabledProviders = PROVIDER_ORDER, requests = [], sample = false, now = Date.now() } = {}) {
  const sampled = typeof status?.sampledAt === 'string' ? Date.parse(status.sampledAt) : NaN;
  const stale = !Number.isFinite(sampled) || now - sampled > 30000 || sampled - now > 300000;
  const visibleRequests = []; let requestBytes = 0;
  if (!stale && !sample && status?.isTestData !== true) for (const request of requests) {
    if (request.fullContentUnavailable) continue;
    const size = Buffer.byteLength(JSON.stringify(request));
    if (visibleRequests.length < 32 && requestBytes + size <= 64 * 1024) { visibleRequests.push(request); requestBytes += size; }
  }
  return {
    p: PROVIDER_ORDER.filter(id => enabledProviders.includes(id)).map(id => {
      const item = status?.[id] || {};
      return { i: id, c: CONNECTIONS.has(item.connection) ? item.connection : 'unavailable',
        a: ACTIVITIES.has(item.activity) ? item.activity : 'unknown',
        n: Number.isSafeInteger(item.activeTasks) ? Math.max(0, Math.min(9999, item.activeTasks)) : 0,
        ...(['input', 'approval', 'both'].includes(item.waitingReason) && item.waitingTasks > 0 ? { w: item.waitingReason } : {}),
        q: (Array.isArray(item.quotas) ? item.quotas : []).slice(0, 12).map(q => ({
          m: text(q.model, 64), p: text(q.period, 48),
          r: typeof q.remaining === 'number' && Number.isFinite(q.remaining) && q.remaining >= 0 && q.remaining <= 100 ? Math.round(q.remaining * 10) / 10 : null,
          ...(stale || q.stale === true || !['ready'].includes(item.connection) ? { s: true } : {}),
          ...(typeof q.reset === 'string' && Number.isFinite(Date.parse(q.reset)) ? { z: new Date(q.reset).toISOString() } : {}),
        })),
      };
    }),
    requests: visibleRequests, sample: sample || status?.isTestData === true,
    ...(stale ? { stale: true } : {}),
    ...(!stale && !sample && status?.isTestData !== true && visibleRequests.length < requests.length ? { limited: true } : {}),
  };
}

function normalizeEndpoint(value, allowHttp = false) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid-endpoint');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('invalid-endpoint'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowHttp && local && url.protocol === 'http:') ||
      url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('invalid-endpoint');
  return url.origin;
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}

class CloudStatusController {
  constructor({ userData, safeStorage, getSnapshot, actions, onChange = () => {}, fetch = globalThis.fetch,
    now = Date.now, allowHttp = false, setTimer = setInterval, clearTimer = clearInterval } = {}) {
    Object.assign(this, { safeStorage, getSnapshot, actions, onChange, fetch, now, allowHttp, setTimer, clearTimer });
    this.file = path.join(userData, 'cloud-sync.json'); this.ledgerFile = path.join(userData, 'cloud-command-results.json');
    this.config = { enabled: false, endpoint: '', allowActions: false, uploadFullContent: false };
    this.deviceId = crypto.randomUUID(); this.session = crypto.randomUUID(); this.sequence = 0; this.generation = 0;
    this.token = ''; this.ledger = {}; this.lastHash = ''; this.timer = null; this.busy = false; this.abort = null;
    this.acknowledged = new Set(); this.actionQueue = Promise.resolve();
    this.inFlight = new Set(); this.queued = new Set();
    this.state = 'off'; this.error = null; this.lastSyncedAt = null; this.lastBytes = 0; this.totalBytes = 0;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (/^[a-f0-9-]{36}$/.test(saved.deviceId)) this.deviceId = saved.deviceId;
      if (saved.endpoint) this.config.endpoint = normalizeEndpoint(saved.endpoint, this.allowHttp);
      if (saved.encryptedToken) {
        if (!this.secureStorageAvailable()) throw new Error('secure-storage-unavailable');
        this.token = safeStorage.decryptString(Buffer.from(saved.encryptedToken, 'base64'));
      }
      this.config.allowActions = saved.allowActions === true;
      this.config.uploadFullContent = saved.uploadFullContent === true && this.config.allowActions;
      this.config.enabled = saved.enabled === true && Boolean(this.config.endpoint && this.validToken(this.token));
    } catch (error) { if (error.message === 'secure-storage-unavailable') this.error = error.message; }
    try {
      const saved = JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8'));
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const [id, result] of Object.entries(saved)) {
        if (/^[a-f0-9-]{36}$/i.test(id) && ['succeeded', 'failed'].includes(result?.status) && Number.isFinite(result.at)) this.ledger[id] = result;
      }
    } catch {}
  }
  validToken(value) { return typeof value === 'string' && /^[\x21-\x7e]{32,512}$/.test(value); }
  secureStorageAvailable() {
    return this.safeStorage?.isEncryptionAvailable() === true && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  }
  summary() {
    return { ...this.config, configured: Boolean(this.token), state: this.state, error: this.error,
      lastSyncedAt: this.lastSyncedAt, lastBytes: this.lastBytes, totalBytes: this.totalBytes, intervalMs: INTERVAL,
      secureStorageAvailable: this.secureStorageAvailable() };
  }
  save() {
    if (this.token && !this.secureStorageAvailable()) throw new Error('secure-storage-unavailable');
    atomicWrite(this.file, { ...this.config, deviceId: this.deviceId,
      encryptedToken: this.token ? this.safeStorage.encryptString(this.token).toString('base64') : '' });
  }
  configure(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['enabled', 'endpoint', 'token', 'allowActions', 'uploadFullContent'].includes(key)) ||
      typeof input.enabled !== 'boolean' || typeof input.allowActions !== 'boolean' || input.uploadFullContent !== undefined && typeof input.uploadFullContent !== 'boolean') throw new Error('invalid-config');
    const endpoint = input.endpoint ? normalizeEndpoint(input.endpoint, this.allowHttp) : '';
    const token = input.token === undefined || input.token === '' ? this.token : input.token;
    if (token && !this.validToken(token) || input.enabled && !(endpoint && this.validToken(token))) throw new Error('invalid-token');
    if (input.enabled && !this.secureStorageAvailable()) throw new Error('secure-storage-unavailable');
    const previous = { ...this.config }, oldToken = this.token;
    this.config = { enabled: input.enabled, endpoint, allowActions: input.allowActions, uploadFullContent: input.allowActions && input.uploadFullContent === true }; this.token = token;
    try { this.save(); } catch (error) { this.config = previous; this.token = oldToken; throw error; }
    this.stop(); this.error = null; this.lastHash = ''; this.session = crypto.randomUUID(); this.sequence = 0;
    this.acknowledged.clear(); this.start(); this.onChange(); return this.summary();
  }
  forget() {
    this.stop(); this.config = { enabled: false, endpoint: '', allowActions: false, uploadFullContent: false }; this.token = '';
    this.lastHash = ''; this.lastSyncedAt = null; this.error = null; this.save(); this.onChange(); return this.summary();
  }
  start() {
    if (!this.config.enabled || this.timer) return;
    this.state = 'connecting';
    this.timer = this.setTimer(() => { void this.tick(); }, INTERVAL); this.timer?.unref?.();
    void this.tick();
  }
  stop() {
    this.generation++; if (this.timer) this.clearTimer(this.timer); this.timer = null;
    this.abort?.abort(); this.abort = null; this.actions?.dispose?.(); this.state = 'off';
  }
  record(result) {
    this.ledger[result.id] = { ...result, at: this.now() };
    // Retain a full day, much longer than the server's 120s command lease.
    for (const [id, item] of Object.entries(this.ledger)) if (this.now() - item.at > 86400000) delete this.ledger[id];
    if (Object.keys(this.ledger).length > 2000) throw new Error('command-ledger-full');
    atomicWrite(this.ledgerFile, this.ledger);
  }
  async execute(command, generation) {
    if (this.ledger[command.id]) return;
    const valid = /^[a-f0-9-]{36}$/i.test(command.id || '') && typeof command.requestId === 'string' && command.requestId.length <= 256 &&
      ['answer', 'approve', 'deny'].includes(command.kind) && Number.isFinite(command.expiresAt) && command.expiresAt > this.now() && command.expiresAt <= this.now() + 125000;
    if (!valid) return;
    const failure = { id: command.id, status: 'failed', error: 'remote-actions-disabled' };
    if (!this.config.allowActions || !this.actions || generation !== this.generation) { this.record(failure); return; }
    // Persist intent before side effects: a restart must never repeat an approval.
    this.record({ ...failure, error: 'execution-interrupted' });
    this.inFlight.add(command.id);
    try {
      const result = await this.actions.execute(command);
      this.record({ id: command.id, status: result.status === 'succeeded' ? 'succeeded' : 'failed',
        ...(result.status === 'succeeded' ? {} : { error: text(result.error || 'action-failed', 80) }) });
    } catch { this.record({ ...failure, error: 'action-failed' }); }
    finally { this.inFlight.delete(command.id); }
  }
  async tick() {
    if (!this.config.enabled || this.busy) return;
    this.busy = true; const generation = this.generation;
    try {
      const snapshot = await this.getSnapshot(this.config.allowActions, this.config.uploadFullContent === true);
      if (generation !== this.generation) return;
      const digest = hash(snapshot);
      const results = Object.values(this.ledger).filter(item => !this.inFlight.has(item.id) && !this.acknowledged.has(`${item.id}:${item.status}:${item.error || ''}`) && this.now() - item.at < 86400000).slice(-64).map(({ at, ...result }) => result);
      const body = { v: 1, d: this.deviceId, s: this.session, n: ++this.sequence, t: this.now(), h: digest,
        ...(digest !== this.lastHash ? { snapshot } : {}), ...(results.length ? { results } : {}) };
      const raw = Buffer.from(JSON.stringify(body));
      if (raw.length > MAX_BYTES) throw new Error('snapshot-too-large');
      const packed = raw.length > 1024 ? zlib.gzipSync(raw) : raw;
      this.abort = new AbortController(); const timeout = setTimeout(() => this.abort?.abort(), 4500);
      let data;
      try {
        const response = await this.fetch(`${this.config.endpoint}/v1/sync`, { method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(packed !== raw ? { 'content-encoding': 'gzip' } : {}) },
          body: packed, signal: this.abort.signal });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'unauthorized' : `server-${response.status}`);
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) throw new Error('response-too-large'); chunks.push(Buffer.from(chunk)); }
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || data.ok !== true || !Array.isArray(data.commands) || data.commands.length > 32 || typeof data.needSnapshot !== 'boolean') throw new Error('invalid-response');
      } finally { clearTimeout(timeout); this.abort = null; }
      if (generation !== this.generation) return;
      if (!data.needSnapshot) for (const result of results) this.acknowledged.add(`${result.id}:${result.status}:${result.error || ''}`);
      this.lastHash = data.needSnapshot ? '' : digest;
      this.lastBytes = packed.length; this.totalBytes += packed.length; this.lastSyncedAt = this.now(); this.error = null; this.state = 'connected';
      for (const command of data.commands) {
        if (!command || typeof command.id !== 'string' || this.queued.has(command.id) || this.inFlight.has(command.id)) continue;
        this.queued.add(command.id);
        this.actionQueue = this.actionQueue.then(() => {
          if (generation === this.generation) return this.execute(command, generation);
        }).catch(() => { this.error = 'action-storage-failed'; this.onChange(); }).finally(() => this.queued.delete(command.id));
      }
    } catch (error) {
      if (generation === this.generation) {
        this.state = 'error'; this.error = /^(unauthorized|server-\d{3}|snapshot-too-large|response-too-large|invalid-response|command-ledger-full)$/.test(error.message) ? error.message : 'connection-failed';
      }
    } finally { this.busy = false; if (generation === this.generation) this.onChange(); }
  }
}

module.exports = { CloudStatusController, projectStatus, normalizeEndpoint, hash, INTERVAL };
