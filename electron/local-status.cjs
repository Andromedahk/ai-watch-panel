const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { normalizeCodexRates, unknownCodexQuotas, normalizeAntigravityQuotas,
  normalizeCodexActivity, normalizeAntigravityActivity } = require('./status-normalizers.cjs');

const SERVICE = '/exa.language_server_pb.LanguageServerService/';
const METHODS = new Set(['GetUserStatus', 'GetAllCascadeTrajectories']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
async function readTail(file, bytes = MAX_RESPONSE_BYTES) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - bytes);
    const buffer = Buffer.alloc(Math.min(stat.size, bytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const result = buffer.subarray(0, bytesRead).toString('utf8');
    return start ? result.slice(result.indexOf('\n') + 1) : result;
  } finally { await handle.close(); }
}
function withDatabase(file, read) {
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(file, { readOnly: true, timeout: 500 });
  try { return read(database); } finally { database.close(); }
}
async function processes() {
  if (process.platform === 'win32') return null;
  const { stdout } = await execute('ps', ['-ax', '-o', 'pid=,comm='], { timeout: 2000, maxBuffer: 1024 * 1024 });
  return stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}
function postLocal(port, token, method) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token || !METHODS.has(method)) {
    return Promise.reject(new Error('Local endpoint unavailable'));
  }
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: SERVICE + method, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': token, 'Content-Length': '2' }, agent: false }, (response) => {
      const chunks = []; let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) response.destroy(new Error('Local response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error('Local service unavailable'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Invalid local response')); }
      });
    });
    // A total deadline also covers a service that trickles response bytes.
    const deadline = setTimeout(() => request.destroy(new Error('Local service timeout')), 3500);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
    request.end('{}');
  });
}
function unavailable(id) {
  return { id, source: 'unavailable', connection: 'unavailable', activity: 'unknown', activeTasks: 0,
    task: '正在读取本地状态', quotas: id === 'codex' ? unknownCodexQuotas() : [],
    observedAt: null, sampledAt: null, detail: '等待首次读取' };
}
class LocalStatusReader {
  constructor({ home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex') } = {}) {
    this.home = home;
    this.codexHome = codexHome;
    this.antigravityHome = path.join(home, '.gemini', 'antigravity');
    this.codexRateCache = null;
    this.antigravityRateCache = null;
    this.current = { sampledAt: null, codex: unavailable('codex'), antigravity: unavailable('antigravity') };
    this.pending = null;
  }
  async poll(force = false) {
    if (this.pending) return this.pending;
    this.pending = this.collect(force).finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect(force) {
    let list;
    try { list = await processes(); } catch { list = null; }
    const results = await Promise.allSettled([this.codex(list, force), this.antigravity(list, force)]);
    const sampledAt = new Date().toISOString();
    const next = { sampledAt };
    for (const [index, id] of ['codex', 'antigravity'].entries()) {
      const result = results[index];
      next[id] = result.status === 'fulfilled' ? result.value : {
        ...unavailable(id), task: '本地状态暂不可读', detail: '读取失败，稍后自动重试', connection: 'error' };
      next[id].sampledAt = sampledAt;
    }
    this.current = next;
    return next;
  }
  async codex(list, force) {
    const now = Date.now();
    const detected = list?.some(({ command }) => /(?:^|\/)codex(?:\.exe)?$/.test(command)) ?? false;
    let rows = null; let latest = null;
    try {
      ({ rows, latest } = withDatabase(path.join(this.codexHome, 'thread_history_1.sqlite'), (db) => ({
        rows: db.prepare(`SELECT status, started_at,
          (SELECT MAX(created_at_ms) FROM thread_items i WHERE i.thread_id=t.thread_id AND i.turn_id=t.turn_id) AS last_item_at
          FROM thread_turns t WHERE status=? LIMIT 100`).all('inProgress'),
        latest: db.prepare('SELECT status, started_at, completed_at FROM thread_turns ORDER BY started_at DESC LIMIT 1').get(),
      })));
    } catch { /* CLI-only installs can still supply quota snapshots without desktop history. */ }
    if (force || !this.codexRateCache || now - this.codexRateCache.checkedAt >= 15000) {
      let files = [];
      try {
        files = withDatabase(path.join(this.codexHome, 'state_5.sqlite'), (db) =>
          db.prepare('SELECT rollout_path FROM threads ORDER BY updated_at DESC LIMIT 6').all().map((row) => row.rollout_path));
      } catch { /* The cache is optional and must never create a missing database. */ }
      let newest = null;
      for (const file of files) {
        if (typeof file !== 'string' || !path.isAbsolute(file)) continue;
        // Reject metadata paths outside the configured Codex home, including symlinks.
        try {
          const real = await fs.realpath(file);
          const root = await fs.realpath(this.codexHome);
          if (!real.startsWith(root + path.sep)) continue;
          const tail = await readTail(real);
          for (const line of tail.split('\n')) {
            if (!line.includes('token_count') || !line.includes('rate_limits')) continue;
            let event;
            try { event = JSON.parse(line); } catch { continue; }
            if (event.type !== 'event_msg' || event.payload?.type !== 'token_count' || !event.payload.rate_limits) continue;
            const at = Date.parse(event.timestamp);
            if (Number.isFinite(at) && at <= now + 120000 && (!newest || at > newest.at)) {
              // Discard tokens, costs, credits, account data, and conversation content.
              newest = { at, quotas: normalizeCodexRates(event.payload.rate_limits, at, now) };
            }
          }
        } catch { /* A session can disappear while the app rotates its files. */ }
      }
      this.codexRateCache = { checkedAt: now, snapshot: newest };
    }
    const cached = this.codexRateCache?.snapshot;
    const quotas = cached?.quotas.map((quota) => ({ ...quota,
      stale: quota.stale || now - cached.at > 1800000 || Boolean(quota.reset && Date.parse(quota.reset) <= now) })) || unknownCodexQuotas();
    const activity = normalizeCodexActivity(rows, latest, detected, now);
    if (list === null) Object.assign(activity, { activity: 'unknown', task: '进程状态暂不可读' });
    return { id: 'codex', source: cached ? 'cache' : 'unavailable', connection: list === null ? 'error' : detected ? 'ready' : 'offline',
      ...activity, quotas, observedAt: cached ? new Date(cached.at).toISOString() : null,
      detail: '只读本地额度快照与任务记录；十分钟无活动的未结束任务不显示为运行中。缺少的额度窗口显示未知。' };
  }
  async antigravity(list, force) {
    const now = Date.now();
    const service = list?.find(({ command }) => /antigravity/i.test(command) && /(?:^|\/)language_server(?:\.exe)?$/.test(command));
    let rows = null; let source = 'unavailable'; let live = false;
    if (service) {
      try {
        const { stdout } = await execute('ps', ['-p', String(service.pid), '-o', 'args='], { timeout: 2000, maxBuffer: 65536 });
        const token = stdout.match(/(?:^|\s)--csrf_token(?:=|\s+)([^\s]+)/)?.[1];
        const listeners = await execute('lsof', ['-nP', '-a', '-p', String(service.pid), '-iTCP', '-sTCP:LISTEN', '-F', 'n'], { timeout: 2000, maxBuffer: 32768 });
        const ownedPorts = [...new Set(listeners.stdout.split('\n').flatMap((line) => {
          const match = line.match(/^n(?:127\.0\.0\.1|\[::1\]|\*|localhost):(\d+)$/);
          return match ? [Number(match[1])] : [];
        }))].slice(0, 8);
        if (this.antigravityRateCache && !ownedPorts.some((port) => this.antigravityRateCache.endpoint === `${service.pid}:${port}`)) {
          this.antigravityRateCache = null;
        }
        const logs = process.platform === 'darwin' ? path.join(this.home, 'Library', 'Logs', 'Antigravity', 'language_server.log') : null;
        let log = '';
        try { if (logs) log = await readTail(logs, 256 * 1024); } catch { /* Rotated logs are optional. */ }
        const ports = [...log.matchAll(/listening on \w+ port at (\d+) for HTTP(?:\r?\n|$)/gi)];
        const loggedPort = Number(ports.at(-1)?.[1]);
        const priorPort = this.antigravityEndpoint?.pid === service.pid ? this.antigravityEndpoint.port : null;
        // Only ports owned by this process are eligible. A stale log cannot send the runtime token elsewhere.
        const candidates = [...new Set([loggedPort, priorPort, ...ownedPorts])].filter((port) => ownedPorts.includes(port));
        for (const port of candidates) {
          const endpoint = `${service.pid}:${port}`;
          const cached = this.antigravityRateCache;
          const needQuota = force || !cached || cached.endpoint !== endpoint || now - cached.at >= 30000;
          const replies = await Promise.allSettled([
            postLocal(port, token, 'GetAllCascadeTrajectories'),
            needQuota ? postLocal(port, token, 'GetUserStatus') : Promise.resolve(null),
          ]);
          if (replies[0].status === 'fulfilled' && replies[0].value?.trajectorySummaries && typeof replies[0].value.trajectorySummaries === 'object') {
            rows = Object.values(replies[0].value.trajectorySummaries).slice(0, 200).map((row) => ({ status: row?.status }));
            live = true; source = 'local-api';
          }
          let quotaRead = false;
          if (replies[1].status === 'fulfilled' && replies[1].value) {
            const quotas = normalizeAntigravityQuotas(replies[1].value, now, now);
            if (quotas.length) { this.antigravityRateCache = { at: now, endpoint, quotas }; quotaRead = true; }
          }
          if (live || quotaRead) {
            this.antigravityEndpoint = { pid: service.pid, port };
            if (cached && cached.endpoint !== endpoint && !quotaRead) this.antigravityRateCache = null;
            break;
          }
        }
        // The runtime token and raw provider payloads are neither retained nor sent to the renderer.
      } catch { /* Fall back to allowlisted SQLite metadata if the service changes. */ }
    }
    if (!rows) {
      try {
        rows = withDatabase(path.join(this.antigravityHome, 'conversation_summaries.db'), (db) =>
          db.prepare('SELECT status, not_fully_idle, killed, last_modified_time FROM conversation_summaries LIMIT 200').all());
        source = 'cache';
        // Cached running flags alone cannot prove a job is still active.
        rows = rows.map((row) => ({ ...row, status: row.status === 'CASCADE_RUN_STATUS_RUNNING' ? 'UNKNOWN_CACHED_RUN' : row.status }));
      } catch { /* Missing data remains explicitly unknown. */ }
    }
    const cached = this.antigravityRateCache;
    const quotas = cached?.quotas.map((quota) => ({ ...quota, stale: !service || quota.stale
      || now - cached.at > 1800000 || Boolean(quota.reset && Date.parse(quota.reset) <= now) })) || [];
    const activity = normalizeAntigravityActivity(rows, Boolean(service));
    if (service && source === 'cache' && activity.activity === 'idle') {
      Object.assign(activity, { activity: 'unknown', task: '仅有任务缓存，当前状态未知' });
    }
    if (list === null) Object.assign(activity, { activity: 'unknown', task: '进程状态暂不可读' });
    return { id: 'antigravity', source, connection: list === null ? 'error' : live ? 'ready' : service ? 'error' : 'offline',
      ...activity, quotas, observedAt: cached ? new Date(cached.at).toISOString() : null,
      detail: live ? '读取正在运行的本地服务。额度按服务返回的模型列出，未返回的周期不作推测。'
        : '本地服务未连接；尝试只读任务缓存，历史运行标记不作为当前运行证据。' };
  }
}
module.exports = { LocalStatusReader, postLocal, readTail };
