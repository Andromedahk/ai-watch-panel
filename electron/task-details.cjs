const fs = require('node:fs');
const path = require('node:path');
const MAX_TASKS = 8;
const STATES = ['running', 'waiting', 'completed', 'failed', 'cancelled', 'unknown', 'idle'];
const OPERATIONS = new Set(['commandExecution', 'fileChange', 'webSearch', 'toolCall', 'agentMessage', 'reasoning',
  'turn/start', 'turn/end', 'approval/asked', 'approval/decided', 'tool/start', 'tool/end', 'turn_started', 'turn_completed']);
function safeText(value, limit = 120) {
  if (typeof value !== 'string') return null;
  const text = value.slice(0, 4096).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/(?:https?:\/\/|file:\/\/)[^\s]+/gi, '…')
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|Volumes|private|var|tmp|etc)\/)[^\s,;，；]+/g, '…')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '…')
    .replace(/(?:sk-|sess-|Bearer\s+)[A-Za-z0-9_.-]+/gi, '…')
    .replace(/\b(?:token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/gi, '…')
    .replace(/\s+/g, ' ').trim();
  return text ? [...text].slice(0, limit).join('') : null;
}
function timestamp(value, now = Date.now()) {
  if (value && typeof value === 'object' && /^\d{1,12}$/.test(String(value.seconds)) && Number.isInteger(value.nanos ?? 0) && (value.nanos ?? 0) >= 0 && (value.nanos ?? 0) < 1000000000) value = Number(value.seconds) * 1000 + Math.floor((value.nanos || 0) / 1000000);
  const number = typeof value === 'number' ? value < 1e11 ? value * 1000 : value : typeof value === 'string' && value.length < 64 ? Date.parse(value) : NaN;
  return Number.isFinite(number) && number > 0 && number <= now + 120000 ? new Date(number).toISOString() : null;
}
function taskDetail(row, { now = Date.now(), live = false, freshMs = 600000, source = 'cache' } = {}) {
  const updatedAt = timestamp(row.updatedAt, now);
  const stale = !live || Boolean(updatedAt && now - Date.parse(updatedAt) > freshMs);
  const state = STATES.includes(row.state) ? row.state : 'unknown';
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : null;
  // Only this allowlist crosses the bridge. No IDs, file paths, prompts or tool arguments.
  return { title: safeText(row.title), state: stale && ['running', 'waiting'].includes(state) ? 'unknown' : state,
    updatedAt, stale, source: ['cache', 'local-api'].includes(source) ? source : 'cache',
    operation: OPERATIONS.has(row.operation) ? row.operation : null,
    steps: count(row.steps), toolCalls: count(row.toolCalls),
    progress: typeof row.progress === 'number' && Number.isFinite(row.progress) && row.progress >= 0 && row.progress <= 100 ? row.progress : null };
}
function database(file, root, callback) {
  const real = fs.realpathSync(file), base = fs.realpathSync(root);
  // SQLite reads selected pages rather than loading the whole file. A long-lived
  // history can exceed 1 GiB; bound query results instead of rejecting that history.
  if (!real.startsWith(base + path.sep) || !fs.statSync(real).isFile()) throw new Error('Invalid task database');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(real, { readOnly: true, timeout: 300 });
  try { db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=300;'); return callback(db); }
  finally { db.close(); }
}
function codexDetails(root, active, attention, detected, now = Date.now()) {
  try {
    const rows = database(path.join(root, 'state_5.sqlite'), root, db => {
      const columns = db.prepare('PRAGMA table_info(threads)').all().map(row => row.name);
      if (!['id', 'title', 'updated_at', 'archived'].every(name => columns.includes(name))) return [];
      const title = columns.includes('name') ? "SUBSTR(COALESCE(NULLIF(TRIM(name),''),title),1,4096) AS title" : 'SUBSTR(title,1,4096) AS title';
      const ids = [...new Set([...attention.waitingThreads, ...active.map(row => row.thread_id)])].slice(0, MAX_TASKS);
      return ids.length ? db.prepare(`SELECT id,${title},updated_at FROM threads WHERE archived=0 AND id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 8`).all(...ids)
        : db.prepare(`SELECT id,${title},updated_at FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 3`).all();
    });
    let items = new Map();
    try {
      items = database(path.join(root, 'thread_history_1.sqlite'), root, db => new Map(rows.map(row => {
        const turn = active.find(turn => turn.thread_id === row.id);
        const args = [row.id, ...(turn?.turn_id ? [turn.turn_id] : [])];
        const item = db.prepare(`SELECT item_type,created_at_ms FROM thread_items WHERE thread_id=? ${turn?.turn_id ? 'AND turn_id=?' : ''}
          AND item_type IN ('commandExecution','fileChange','webSearch','toolCall','agentMessage','reasoning',
            'mcpToolCall','dynamicToolCall','collabAgentToolCall','subAgentActivity','imageGeneration','imageView') ORDER BY created_at_ms DESC LIMIT 1`).get(...args);
        return [row.id, item];
      })));
    } catch { /* Earlier schemas still have a usable task title and timestamp. */ }
    return rows.map(row => {
      const turn = active.find(turn => turn.thread_id === row.id), item = items.get(row.id);
      const waiting = attention.waitingThreads.has(row.id);
      // A title's update timestamp cannot by itself turn an old conversation into an active job.
      const updatedAt = turn?.last_item_at || item?.created_at_ms || row.updated_at;
      const operation = item && (OPERATIONS.has(item.item_type) ? item.item_type : 'toolCall');
      return taskDetail({ title: row.title, state: waiting ? 'waiting' : turn ? 'running' : 'unknown', updatedAt, operation },
        { now, live: detected && (waiting && attention.connected || Boolean(turn)), freshMs: waiting && attention.connected ? Infinity : 600000,
          source: waiting && attention.connected ? 'local-api' : 'cache' });
    });
  } catch { return []; }
}
function antigravityDetails(rows, live, now = Date.now()) {
  return rows.slice(0, 200).filter(row => row && typeof row === 'object').map(row => taskDetail({
    title: row.title || row.summary, state: row.status === 'CASCADE_RUN_STATUS_RUNNING' ? 'running'
      : row.status === 'CASCADE_RUN_STATUS_IDLE' ? 'idle' : 'unknown',
    updatedAt: row.lastModifiedTime || row.last_modified_time, steps: typeof row.stepCount === 'string' ? Number(row.stepCount) : row.stepCount,
  }, { now, live, source: live ? 'local-api' : 'cache' })).sort((a, b) =>
    Number(b.state === 'running') - Number(a.state === 'running') || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).slice(0, MAX_TASKS);
}
module.exports = { MAX_TASKS, safeText, timestamp, taskDetail, codexDetails, antigravityDetails };
