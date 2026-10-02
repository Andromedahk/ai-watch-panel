const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { boundedFile } = require('./session-files.cjs');
const FRESH_MS = 10 * 60 * 1000;
const WINDOWS = [['fh', '全部模型', '5 小时'], ['sd', '全部模型', '1 周'],
  ['so', 'Opus', '1 周'], ['sn', 'Sonnet', '1 周'], ['oa', 'OAuth 应用', '1 周'], ['cw', 'Cowork', '1 周']];

function resolveClaudePaths({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const expand = value => value === '~' ? home : value.startsWith('~/') || value.startsWith('~\\') ? paths.join(home, value.slice(2)) : paths.resolve(value);
  return { config: env.CLAUDE_CONFIG_DIR ? expand(env.CLAUDE_CONFIG_DIR) : paths.join(home, '.claude'),
    desktop: env.CLAUDE_USER_DATA_DIR ? expand(env.CLAUDE_USER_DATA_DIR) : platform === 'darwin'
      ? paths.join(home, 'Library', 'Application Support', 'Claude') : platform === 'win32'
        ? paths.join(env.APPDATA || paths.join(home, 'AppData', 'Roaming'), 'Claude')
        : paths.join(env.XDG_CONFIG_HOME || paths.join(home, '.config'), 'Claude') };
}
function normalizeClaudeUsage(payload, now) {
  if (![1, 2].includes(payload?.version) || !Array.isArray(payload.samples)) return null;
  const latest = payload.samples.filter(s => Number.isFinite(s?.t) && s.t > 0 && s.t <= now + 120000).sort((a, b) => b.t - a.t)[0];
  if (!latest) return null;
  // An empty newest sample must clear older paid-plan/account values.
  const usage = payload.version === 2 ? latest.u : latest;
  const quotas = WINDOWS.flatMap(([key, model, period]) => {
    const used = usage?.[key];
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return [];
    return [{ model, period, remaining: Math.round((100 - used) * 10) / 10, reset: '', stale: now - latest.t > 1800000 }];
  });
  return { quotas, observedAt: new Date(latest.t).toISOString() };
}
function isCodeProcess(command) {
  return /(?:^|[/\\])claude(?:\.exe)?$/.test(command)
    || /[/\\]claude[/\\]versions[/\\]\d+\.\d+\.\d+(?:\.exe)?$/.test(command);
}
class ClaudeStatusReader {
  constructor(options = {}) { this.paths = resolveClaudePaths(options); }
  async poll(processes, now = Date.now()) {
    const { desktop, config } = this.paths;
    const desktopOpen = processes?.some(p => /(?:^|[/\\])Claude(?:\.exe)?$/.test(p.command)) || false;
    const codeProcesses = processes?.filter(p => isCodeProcess(p.command)) || [];
    const pids = new Set(codeProcesses.map(p => p.pid));
    let usage = null;
    try { usage = normalizeClaudeUsage(JSON.parse(await boundedFile(path.join(desktop, 'plan-usage-history.json'), desktop, 4 * 1024 * 1024)), now); }
    catch { /* Optional cache, never fall back to invented allowance. */ }
    let names = []; let failed = false;
    const sessions = path.join(config, 'sessions');
    try { names = (await fs.readdir(sessions)).filter(n => /^\d+\.json$/.test(n)); }
    catch (error) { failed = error.code !== 'ENOENT'; }
    const states = new Map();
    for (const name of names.filter(n => pids.has(Number(n.slice(0, -5)))).slice(0, 128)) {
      try {
        const file = path.join(sessions, name);
        const row = JSON.parse(await boundedFile(file, config, 65536));
        if (!Number.isInteger(row.pid) || row.pid !== Number(name.slice(0, -5))) continue;
        const stat = await fs.stat(file);
        const fresh = stat.mtimeMs <= now + 120000 && now - stat.mtimeMs <= FRESH_MS;
        const phase = row.status === 'idle' ? 'idle' : fresh && row.status === 'busy' ? 'running'
          : fresh && row.status === 'waiting' ? 'waiting' : 'unknown';
        // A PID appears once even if both desktop and CLI present the same session.
        states.set(row.pid, { phase, surface: row.entrypoint === 'claude-desktop' ? 'desktop' : 'terminal', at: stat.mtimeMs });
      } catch { failed = true; }
    }
    const values = [...states.values()];
    const activeTasks = values.filter(s => s.phase === 'running').length;
    const waiting = values.filter(s => s.phase === 'waiting').length;
    const incomplete = failed || states.size < pids.size || values.some(s => s.phase === 'unknown');
    const activity = processes === null ? 'unknown' : activeTasks ? 'running' : waiting ? 'waiting'
      : incomplete ? 'unknown' : values.length ? 'idle' : desktopOpen ? 'unknown' : 'offline';
    const desktopCount = values.filter(s => s.surface === 'desktop').length;
    const terminalCount = values.filter(s => s.surface === 'terminal').length;
    const surfaces = { desktop: desktopCount ? `桌面 ${desktopCount} 个 Code 会话` : desktopOpen ? '桌面已打开 · 无 Code 运行记录' : '桌面未运行',
      terminal: terminalCount ? `终端 ${terminalCount} 个会话` : codeProcesses.length > states.size ? 'Code 进程缺少会话记录' : '终端无运行会话' };
    const task = activeTasks ? `${activeTasks} 项 Code 任务有近期活动` : waiting ? `${waiting} 项任务等待确认`
      : activity === 'idle' ? '已连接会话暂无运行任务' : activity === 'offline' ? 'Claude Code 未运行'
        : desktopOpen && !codeProcesses.length ? '桌面已打开 · 暂无 Code 状态' : 'Code 当前任务状态未知';
    return { id: 'claude', source: usage || values.length ? 'cache' : 'unavailable',
      connection: processes === null ? 'error' : desktopOpen || codeProcesses.length ? 'ready' : 'offline',
      activity, activeTasks, task, quotas: usage?.quotas || [], observedAt: usage?.observedAt || null,
      surfaces, activityObservedAt: values.length ? new Date(Math.max(...values.map(s => s.at))).toISOString() : null,
      activityDetail: `${surfaces.desktop}；${surfaces.terminal}。只读会话登记并校验进程和十分钟时效；后台子任务不单独计数。`,
      detail: usage?.quotas.length ? '桌面用量历史中的额度快照；未返回的窗口和重置时间不作推测。'
        : '本地未提供 Code 额度。Free 账号不包含 Code 权限；普通聊天额度无法由这些记录读取。有可用记录后会自动识别。' };
  }
}
module.exports = { ClaudeStatusReader, normalizeClaudeUsage, resolveClaudePaths, isCodeProcess };
