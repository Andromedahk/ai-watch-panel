const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const FRESH_MS = 10 * 60 * 1000;
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_ROWS = 128;
const TERMINAL = new Set(['completed', 'error', 'cancelled']);

// Official ZCode storage defaults and environment overrides. No device-specific path is persisted.
function resolveZcodePaths({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const expand = value => value === '~' ? home : /^~[/\\]/.test(value)
    ? paths.join(home, value.slice(2)) : paths.resolve(value);
  const base = typeof env.ZCODE_DATA_BASE_DIR === 'string' && env.ZCODE_DATA_BASE_DIR.trim()
    ? expand(env.ZCODE_DATA_BASE_DIR.trim()) : home;
  const explicit = env.ZCODE_SESSION_DB_PATH || env.ZCODE_SESSION_DB;
  const defaultFile = paths.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  const files = typeof explicit === 'string' && explicit.trim() ? [expand(explicit.trim())]
    : [...new Set([paths.join(base, '.zcode', 'cli', 'db', 'db.sqlite'), defaultFile])];
  return files.map(file => ({ file, root: paths.dirname(file) }));
}
function isZcodeProcess(command) {
  return typeof command === 'string' && (
    /(?:^|[/\\])zcode(?:-agent)?(?:\.exe)?$/i.test(command)
    || /[/\\]ZCode\.app[/\\]Contents[/\\]MacOS[/\\]ZCode$/i.test(command)
  );
}
async function checkedDatabase(file, root) {
  const [real, base] = await Promise.all([fs.realpath(file), fs.realpath(root)]);
  if (!real.startsWith(base + path.sep)) throw new Error('unsupported');
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DATABASE_BYTES) throw new Error('unsupported');
    } catch (error) { if (candidate === file || error.code !== 'ENOENT') throw error; }
  }
  return real;
}
async function readZcodeTurns({ file, root }) {
  const real = await checkedDatabase(file, root);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(real, { readOnly: true, timeout: 300 });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=300;');
    // Only bounded numeric telemetry and opaque deduplication IDs enter memory. Never SELECT message bodies.
    return db.prepare(`SELECT t.session_id, t.turn_id, t.status, t.started_at,
      t.first_model_start_at, t.first_token_at, t.completed_at, t.model_request_count,
      t.tool_call_count, t.input_tokens, t.output_tokens, t.reasoning_tokens
      FROM turn_usage t JOIN session s ON s.id=t.session_id
      WHERE s.parent_id IS NULL AND s.time_archived IS NULL
      ORDER BY t.started_at DESC LIMIT ${MAX_ROWS + 1}`).all();
  } finally { db.close(); }
}
function fresh(time, now) {
  return typeof time === 'number' && Number.isFinite(time) && time > 0
    && time <= now + 2000 && now - time <= FRESH_MS;
}
function signature(row) {
  return [row.status, row.first_model_start_at, row.first_token_at, row.completed_at,
    row.model_request_count, row.tool_call_count, row.input_tokens, row.output_tokens, row.reasoning_tokens].join(':');
}
class ZcodeStatusReader {
  constructor(options = {}) {
    this.paths = resolveZcodePaths(options);
    this.readTurns = options.readTurns || readZcodeTurns;
    this.previous = new Map(); this.advanced = new Map(); this.sampled = false;
    this.processKey = null;
  }
  async poll(processes, now = Date.now()) {
    const matches = processes?.filter(p => isZcodeProcess(p.command)) || [];
    const processKey = matches.map(p => p.pid).sort((a, b) => a - b).join(',');
    // A process restart cannot inherit confidence from a previous runtime.
    if (processKey !== this.processKey || processes === null) {
      this.previous.clear(); this.advanced.clear(); this.sampled = false; this.processKey = processKey;
    }
    let available = false; let failed = false; let incomplete = false;
    const latest = new Map();
    for (const location of this.paths) {
      try {
        const rows = await this.readTurns(location);
        if (!Array.isArray(rows)) { incomplete = true; continue; }
        if (rows.length > MAX_ROWS) incomplete = true;
        available = true;
        for (const row of rows.slice(0, MAX_ROWS)) {
          if (typeof row.session_id !== 'string' || row.session_id.length > 256
            || typeof row.turn_id !== 'string' || row.turn_id.length > 256
            || typeof row.started_at !== 'number' || !Number.isFinite(row.started_at)) { incomplete = true; continue; }
          // Session IDs are globally unique in the official runtime. Deduplicate alternate default roots.
          const old = latest.get(row.session_id);
          if (!old || row.started_at > old.started_at) latest.set(row.session_id, row);
        }
      } catch (error) { if (error.code !== 'ENOENT') failed = true; }
    }
    const next = new Map(); let activeTasks = 0; let uncertain = failed || incomplete; let observed = null;
    for (const [session, row] of latest) {
      const key = `${session}\0${row.turn_id}`;
      const current = signature(row);
      next.set(key, current);
      const telemetryTime = Math.max(row.started_at, row.first_model_start_at || 0, row.first_token_at || 0);
      if (row.status === 'running') {
        // A historical unfinished turn is not proof. Require telemetry observed to advance during monitoring.
        const prior = this.previous.get(key);
        if (matches.length && this.sampled && prior !== current
          && (prior !== undefined || fresh(telemetryTime, now)) && row.started_at <= now + 2000) {
          this.advanced.set(key, now);
        }
        const at = this.advanced.get(key);
        if (matches.length && fresh(at, now)) { activeTasks++; observed = Math.max(observed || 0, at); }
        else uncertain = true;
      } else if (TERMINAL.has(row.status)) {
        this.advanced.delete(key);
        if (fresh(row.completed_at, now)) observed = Math.max(observed || 0, row.completed_at);
      } else uncertain = true;
    }
    this.previous = next;
    for (const key of this.advanced.keys()) if (!next.has(key)) this.advanced.delete(key);
    this.sampled = available && !failed;
    const activity = processes === null ? 'unknown' : !matches.length ? 'offline'
      : activeTasks ? 'running' : !available || uncertain ? 'unknown' : 'idle';
    return { id: 'zcode', source: available ? 'cache' : 'unavailable',
      connection: processes === null || failed ? 'error' : matches.length ? available ? 'ready' : 'unavailable' : 'offline',
      activity, activeTasks, task: activeTasks ? `${activeTasks} 项任务有已确认的新活动`
        : activity === 'idle' ? '已读取记录 · 暂无运行任务' : activity === 'offline' ? 'ZCode 未运行'
          : available ? '等待新的任务活动证据' : 'ZCode 当前任务状态未知',
      quotas: [], observedAt: null, sampledAt: new Date(now).toISOString(),
      activityObservedAt: observed ? new Date(observed).toISOString() : null,
      detail: '已接入本地任务遥测；套餐额度暂不可读，请在 ZCode 的使用统计中查看。无需为面板复制 Key。',
      activityDetail: '只读官方运行时的回合遥测，并核对本地进程。首次采样或历史未结束记录显示未知；观察到新回合或遥测推进后点亮，十分钟没有新证据则恢复未知。授权与提问等待状态暂不可区分。' };
  }
}
module.exports = { ZcodeStatusReader, resolveZcodePaths, isZcodeProcess, readZcodeTurns, FRESH_MS };
