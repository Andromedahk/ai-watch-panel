const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveHarnessHome } = require('./deepseek-status.cjs');
const { boundedFile, directories, harnessEvents } = require('./session-files.cjs');
const execute = promisify(execFile);
const FRESH_MS = 10 * 60 * 1000;

function classifyHarness(events, owned, now) {
  const valid = events.filter(e => Number.isFinite(e.time) && e.time <= now + 120000);
  const boundary = valid.findLast(e => e.type === 'turn/start' || e.type === 'turn/end');
  const at = valid.at(-1)?.time || null;
  if (!boundary) return { phase: valid.length ? 'unknown' : 'idle', at };
  if (boundary.type === 'turn/end') return { phase: 'idle', at };
  if (!owned || !at || now - at > FRESH_MS) return { phase: 'unknown', at };
  const approval = valid.findLast(e => e.seq > boundary.seq && ['approval/asked', 'approval/decided'].includes(e.type));
  return { phase: approval?.type === 'approval/asked' ? 'waiting' : 'running', at };
}
async function heldSessionLocks(pids, root) {
  if (process.platform === 'win32') return null;
  let output;
  try { output = (await execute('lsof', ['-nP', '-a', '-p', pids.join(','), '-F', 'n'], { timeout: 2500, maxBuffer: 1024 * 1024 })).stdout; }
  catch { return null; }
  let real;
  try { real = await fs.realpath(root); } catch { return new Set(); }
  return new Set(output.split('\n').filter(line => line.startsWith('n' + real + path.sep) && line.endsWith(path.sep + 'session.lock')).map(line => line.slice(1)));
}
class DeepSeekActivityReader {
  constructor(options = {}) { this.options = options; this.cache = new Map(); this.locks = options.locks || heldSessionLocks; }
  async poll(processes, now = Date.now()) {
    const root = path.join(resolveHarnessHome(this.options), 'sessions');
    const pids = processes?.filter(p => /(?:^|[/\\])(?:DeepSeek Harness|dsh)(?:\.exe)?$/.test(p.command)).map(p => p.pid) || [];
    const state = (activity, task, activeTasks = 0, at = null) => ({ activity, task, activeTasks,
      activityObservedAt: at ? new Date(at).toISOString() : null, activitySource: 'cache',
      activityDetail: '只读 Harness 会话开始、结束与确认事件，结合进程持有的会话锁及十分钟活动时效；不读取任务内容到界面。' });
    if (processes === null) return state('unknown', '进程状态暂不可读');
    if (!pids.length) return state('offline', 'Harness 未运行');
    const owned = await this.locks(pids, root);
    const files = []; let scanned = 0; let truncated = false;
    try {
      scan: for (const workspace of await directories(root, 128)) {
        for (const session of await directories(workspace, 256)) {
          if (++scanned > 1024) { truncated = true; break scan; }
          for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
            const file = path.join(session, name);
            try { const stat = await fs.stat(file); files.push({ file, session, stat, compressed: name.endsWith('.zstd') }); break; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        }
      }
    } catch { return state('unknown', '会话记录暂不可读'); }
    if (!files.length) return state('unknown', '尚无本地任务记录');
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const selected = files.slice(0, 40); const results = [];
    for (const { file, session, stat, compressed } of selected) {
      try {
        const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        let cached = this.cache.get(file);
        if (cached?.stamp !== stamp) {
          cached = { stamp, events: await harnessEvents(await boundedFile(file, root), compressed) };
          this.cache.set(file, cached);
        }
        const realSession = await fs.realpath(session);
        results.push(classifyHarness(cached.events, owned?.has(path.join(realSession, 'session.lock')) || false, now));
      } catch { this.cache.delete(file); results.push({ phase: 'unknown', at: null }); }
    }
    const keep = new Set(selected.map(f => f.file));
    for (const key of this.cache.keys()) if (!keep.has(key)) this.cache.delete(key);
    const active = results.filter(r => r.phase === 'running').length;
    const waiting = results.filter(r => r.phase === 'waiting').length;
    const at = Math.max(...results.map(r => r.at || 0));
    if (active) return state('running', `${active} 项任务有近期活动${waiting ? ` · ${waiting} 项待确认` : ''}`, active, at);
    if (waiting) return state('waiting', `${waiting} 项任务等待确认`, 0, at);
    if (truncated || results.some(r => r.phase === 'unknown') || (files.length > 40 && now - files[40].stat.mtimeMs < FRESH_MS)) return state('unknown', '部分任务缺少当前运行证据', 0, at);
    return state('idle', '本地记录暂无运行任务', 0, at);
  }
}
module.exports = { DeepSeekActivityReader, classifyHarness, heldSessionLocks };
