const { codexDetails, antigravityDetails } = require('./task-details.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DeepSeekBalanceReader } = require('./deepseek-status.cjs');
const { DeepSeekActivityReader } = require('./deepseek-activity.cjs');
const { ClaudeStatusReader } = require('./claude-status.cjs');
const { CodexAttentionReader } = require('./codex-attention.cjs');
const { CodexQuotaReader } = require('./codex-quota.cjs');
const { ZcodeStatusReader } = require('./zcode-status.cjs');
const { KimiStatusReader } = require('./kimi-status.cjs');
const { KimiWorkStatusReader } = require('./kimi-work-status.cjs');
const { isKimiSource } = require('./window-policy.cjs');
const { QwenStatusReader } = require('./qwen-status.cjs');
const { WorkBuddyStatusReader } = require('./workbuddy-status.cjs');
const execute = promisify(execFile);
const { normalizeCodexRates, unknownCodexQuotas, normalizeAntigravityQuotas,
  normalizeCodexPlan, normalizeAntigravityPlan, normalizeCodexActivity, normalizeAntigravityActivity } = require('./status-normalizers.cjs');

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
  constructor({ home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex'),
    deepseekReader = new DeepSeekBalanceReader({ home }),
    deepseekActivityReader = new DeepSeekActivityReader({ home }), claudeReader = new ClaudeStatusReader({ home }),
    zcodeReader = new ZcodeStatusReader({ home }), kimiReader = new KimiStatusReader({ home }),
    kimiWorkReader = new KimiWorkStatusReader({ home }), kimiSource = 'code',
    qwenReader = new QwenStatusReader({ home }), workbuddyReader = new WorkBuddyStatusReader({ home }),
    codexQuotaReader = new CodexQuotaReader({ home, codexHome }), runCommand = execute, requestLocal = postLocal } = {}) {
    this.home = home;
    this.codexHome = codexHome;
    this.codexAttention = new CodexAttentionReader({ codexHome });
    this.codexQuotaReader = codexQuotaReader;
    this.antigravityHome = path.join(home, '.gemini', 'antigravity');
    this.codexRateCache = null;
    this.antigravityRateCache = null;
    this.runCommand = runCommand; this.requestLocal = requestLocal;
    this.deepseekReader = deepseekReader;
    this.deepseekActivityReader = deepseekActivityReader;
    this.claudeReader = claudeReader;
    this.zcodeReader = zcodeReader; this.kimiReader = kimiReader;
    this.kimiWorkReader = kimiWorkReader; this.kimiSource = isKimiSource(kimiSource) ? kimiSource : 'code'; this.kimiGeneration = 0;
    this.qwenReader = qwenReader; this.workbuddyReader = workbuddyReader;
    this.current = { sampledAt: null, claude: unavailable('claude'), codex: unavailable('codex'), antigravity: unavailable('antigravity'), deepseek: unavailable('deepseek'), zcode: unavailable('zcode'), kimi: unavailable('kimi'), qwen: unavailable('qwen'), workbuddy: unavailable('workbuddy') };
    this.pending = null;
    this.taskDetailsEnabled = false; this.taskGeneration = 0;
  }
  setTaskDetailsEnabled(enabled) {
    this.taskDetailsEnabled = enabled === true; this.taskGeneration++;
    for (const reader of [this.deepseekActivityReader, this.claudeReader, this.zcodeReader, this.kimiReader, this.qwenReader, this.workbuddyReader]) reader.taskDetailsEnabled = this.taskDetailsEnabled;
    this.current = { ...this.current, sampledAt: new Date().toISOString() };
    for (const id of ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy']) { this.current[id] = { ...this.current[id] }; delete this.current[id].taskDetails; }
  }
  setKimiSource(source) {
    if (!isKimiSource(source)) throw new Error('Invalid Kimi source');
    if (source === this.kimiSource) return;
    this.kimiSource = source; this.kimiGeneration++;
    for (const reader of [this.kimiReader, this.kimiWorkReader]) this.clearKimiCache(reader);
    this.current = { ...this.current, kimi: { ...unavailable('kimi'), kimiSource: source,
      task: '正在核对所选客户端', detail: '来源已切换，等待新的套餐和额度。' } };
  }
  clearKimiCache(reader) {
    reader.cache = null; reader.planCache = null;
    if (reader.error !== 'rate') reader.nextAt = 0;
  }
  async poll(force = false) {
    if (this.pending) return this.pending;
    this.pending = this.collect(force).finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect(force) {
    let list;
    try { list = await processes(); } catch { list = null; }
    const taskGeneration = this.taskGeneration;
    const kimiGeneration = this.kimiGeneration;
    const kimiSource = this.kimiSource;
    const results = await Promise.allSettled([this.codex(list, force), this.antigravity(list, force), this.deepseek(list, force), this.claudeReader.poll(list), this.zcodeReader.poll(list, Date.now(), force),
      kimiSource === 'work' ? this.kimiWorkReader.poll(list, Date.now(), force) : this.kimiReader.poll(list), this.qwenReader.poll(list, force), this.workbuddyReader.poll(list, force)]);
    const sampledAt = new Date().toISOString();
    const next = { sampledAt };
    for (const [index, id] of ['codex', 'antigravity', 'deepseek', 'claude', 'zcode', 'kimi', 'qwen', 'workbuddy'].entries()) {
      const result = results[index];
      next[id] = result.status === 'fulfilled' ? result.value : {
        ...unavailable(id), task: '本地状态暂不可读', detail: '读取失败，稍后自动重试', connection: 'error' };
      next[id].sampledAt = sampledAt;
      if (!this.taskDetailsEnabled || taskGeneration !== this.taskGeneration) delete next[id].taskDetails;
      if (id === 'kimi') {
        if (kimiGeneration !== this.kimiGeneration) this.clearKimiCache(kimiSource === 'work' ? this.kimiWorkReader : this.kimiReader);
        next[id] = kimiGeneration === this.kimiGeneration ? { ...next[id], kimiSource } : { ...this.current.kimi, sampledAt };
      }
    }
    this.current = next;
    return next;
  }
  async deepseek(list, force) {
    const [balance, activity] = await Promise.allSettled([this.deepseekReader.poll(force), this.deepseekActivityReader.poll(list)]);
    // Task discovery and network balance errors must not hide each other's successful data.
    return { ...(balance.status === 'fulfilled' ? balance.value : { ...unavailable('deepseek'), connection: 'error', detail: '余额暂不可读' }),
      ...(activity.status === 'fulfilled' ? activity.value : { activity: 'unknown', activeTasks: 0, task: '任务记录暂不可读', activityDetail: '稍后自动重试' }) };
  }
  async codex(list, force) {
    const officialPromise = this.codexQuotaReader.poll(force);
    const now = Date.now();
    const detected = list?.some(({ command }) => /(?:^|\/)codex(?:\.exe)?$/.test(command)) ?? false;
    let rows = null; let latest = null;
    try {
      ({ rows, latest } = withDatabase(path.join(this.codexHome, 'thread_history_1.sqlite'), (db) => ({
        rows: db.prepare(`SELECT thread_id, turn_id, status, started_at,
          (SELECT MAX(created_at_ms) FROM thread_items i WHERE i.thread_id=t.thread_id AND i.turn_id=t.turn_id) AS last_item_at
          FROM thread_turns t WHERE status=? ORDER BY started_at DESC LIMIT 100`).all('inProgress'),
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
            if (event.type !== 'event_msg' || event.payload?.type !== 'token_count' || !Object.hasOwn(event.payload, 'rate_limits')) continue;
            const at = Date.parse(event.timestamp);
            if (Number.isFinite(at) && at <= now + 120000 && (!newest || at >= newest.at)) {
              // Keep only normalized allowances and an allowlisted plan name.
              newest = { at, quotas: normalizeCodexRates(event.payload.rate_limits, at, now),
                plan: normalizeCodexPlan(event.payload.rate_limits, at, now) };
            }
          }
        } catch { /* A session can disappear while the app rotates its files. */ }
      }
      this.codexRateCache = { checkedAt: now, snapshot: newest };
    }
    const cached = this.codexRateCache?.snapshot;
    const quotas = cached?.quotas.map((quota) => ({ ...quota,
      stale: quota.stale || now - cached.at > 1800000 || Boolean(quota.reset && Date.parse(quota.reset) <= now) })) || unknownCodexQuotas();
    let attentionThreads = rows?.map(row => row.thread_id).filter(Boolean) || [];
    try {
      const recent = withDatabase(path.join(this.codexHome, 'state_5.sqlite'), db => db.prepare('SELECT id FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 24').all().map(row => row.id));
      attentionThreads = [...new Set([...attentionThreads, ...recent])];
    } catch { /* Older schemas can still monitor current desktop turns. */ }
    const attention = await this.codexAttention.poll(attentionThreads, detected && list !== null, now);
    const activity = normalizeCodexActivity(rows?.filter(row => !attention.waitingThreads.has(row.thread_id)), latest, detected, now);
    if (attention.waitingThreads.size) {
      const parts = [];
      if (attention.inputThreads.size) parts.push(`${attention.inputThreads.size} 项待回答`);
      if (attention.approvalThreads.size) parts.push(`${attention.approvalThreads.size} 项待授权`);
      if (activity.activeTasks) parts.push(`${activity.activeTasks} 项运行`);
      Object.assign(activity, { activity: 'waiting', task: parts.join(' · '), waitingTasks: attention.waitingThreads.size,
        waitingReason: attention.inputThreads.size && attention.approvalThreads.size ? 'both' : attention.inputThreads.size ? 'input' : 'approval' });
    }
    if (list === null) Object.assign(activity, { activity: 'unknown', task: '进程状态暂不可读' });
    const official = await officialPromise;
    const quotaStatus = official.useLocal ? {
      source: cached ? 'cache' : 'unavailable', connection: list === null ? 'error' : detected ? 'ready' : 'offline',
      quotas, plan: cached ? { ...cached.plan, stale: cached.plan.stale || now - cached.at > 1800000 }
        : normalizeCodexPlan(null, null, now), observedAt: cached ? new Date(cached.at).toISOString() : null,
      detail: `${official.detail} 套餐与额度来自同一条本地快照；最新记录缺少套餐时显示未知。`,
    } : { source: official.source, connection: official.connection, quotas: official.quotas, plan: official.plan,
      observedAt: official.observedAt, detail: official.detail };
    return { id: 'codex', ...quotaStatus,
      ...(this.taskDetailsEnabled ? { taskDetails: codexDetails(this.codexHome, rows || [], attention, detected && list !== null, now) } : {}),
      ...activity,
      attentionAvailable: attention.connected && attention.observedThreads > 0,
      activityDetail: attention.connected && attention.observedThreads > 0 ? '通过 Codex 本地客户端状态通道监看待回答与待授权请求；红灯优先，处理后自动恢复。' : '任务活动来自本地记录；等待提醒通道暂不可用，不能确认是否有待回答或待授权请求。',
    };
  }
  async antigravity(list, force) {
    const now = Date.now();
    const service = list?.find(({ command }) => /antigravity/i.test(command) && /(?:^|\/)language_server(?:\.exe)?$/.test(command));
    let rows = null; let source = 'unavailable'; let live = false; let taskDetails = [];
    if (service && this.antigravityRateCache && !this.antigravityRateCache.endpoint.startsWith(`${service.pid}:`)) {
      this.antigravityRateCache = null;
    }
    if (service) {
      try {
        const { stdout } = await this.runCommand('ps', ['-p', String(service.pid), '-o', 'args='], { timeout: 2000, maxBuffer: 65536 });
        const token = stdout.match(/(?:^|\s)--csrf_token(?:=|\s+)([^\s]+)/)?.[1];
        const listeners = await this.runCommand('lsof', ['-nP', '-a', '-p', String(service.pid), '-iTCP', '-sTCP:LISTEN', '-F', 'n'], { timeout: 2000, maxBuffer: 32768 });
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
            this.requestLocal(port, token, 'GetAllCascadeTrajectories'),
            needQuota ? this.requestLocal(port, token, 'GetUserStatus') : Promise.resolve(null),
          ]);
          if (replies[0].status === 'fulfilled' && replies[0].value?.trajectorySummaries && typeof replies[0].value.trajectorySummaries === 'object') {
            if (this.taskDetailsEnabled) taskDetails = antigravityDetails(Object.values(replies[0].value.trajectorySummaries), true, now);
            rows = Object.values(replies[0].value.trajectorySummaries).slice(0, 200).map((row) => ({ status: row?.status }));
            live = true; source = 'local-api';
          }
          let quotaRead = false;
          if (needQuota && replies[1].status === 'fulfilled') {
            const payload = replies[1].value;
            // A successful response with no entitlement clears the previous account's data.
            if (payload?.userStatus && typeof payload.userStatus === 'object' && !Array.isArray(payload.userStatus)) {
              this.antigravityRateCache = { at: now, endpoint, quotas: normalizeAntigravityQuotas(payload, now, now),
                plan: normalizeAntigravityPlan(payload, now, now), readFailed: false };
              quotaRead = true; source = 'local-api';
            } else this.antigravityRateCache = null;
          } else if (needQuota && this.antigravityRateCache?.endpoint === endpoint) {
            this.antigravityRateCache.readFailed = true;
          }
          if (live || quotaRead) {
            this.antigravityEndpoint = { pid: service.pid, port };
            if (cached && cached.endpoint !== endpoint && !quotaRead) this.antigravityRateCache = null;
            break;
          }
        }
        // The runtime token and raw provider payloads are neither retained nor sent to the renderer.
      } catch {
        if (this.antigravityRateCache) this.antigravityRateCache.readFailed = true;
        // Fall back to allowlisted SQLite metadata if the service changes.
      }
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
    const quotas = cached?.quotas.map((quota) => ({ ...quota, stale: !service || cached.readFailed || quota.stale
      || now - cached.at > 1800000 || Boolean(quota.reset && Date.parse(quota.reset) <= now) })) || [];
    const activity = normalizeAntigravityActivity(rows, Boolean(service));
    if (service && source === 'cache' && activity.activity === 'idle') {
      Object.assign(activity, { activity: 'unknown', task: '仅有任务缓存，当前状态未知' });
    }
    if (list === null) Object.assign(activity, { activity: 'unknown', task: '进程状态暂不可读' });
    return { id: 'antigravity', ...(this.taskDetailsEnabled ? { taskDetails } : {}), source, connection: list === null ? 'error' : live ? 'ready' : service ? 'error' : 'offline',
      ...activity, quotas, plan: cached ? { ...cached.plan, stale: !service || cached.readFailed || cached.plan.stale || now - cached.at > 1800000 }
        : normalizeAntigravityPlan(null, null, now), observedAt: cached ? new Date(cached.at).toISOString() : null,
      detail: live ? '套餐与额度来自正在运行的本地服务，只显示已识别的产品档位；未返回的套餐与周期不作推测。'
        : '本地服务未连接；尝试只读任务缓存，历史运行标记不作为当前运行证据。' };
  }
}
module.exports = { LocalStatusReader, postLocal, readTail };
