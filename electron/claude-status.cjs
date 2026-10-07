const { taskDetail } = require('./task-details.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
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
function normalizeClaudePlan(payload, now) {
  const oauth = payload?.claudeAiOauth;
  // CLI file-backed login only. Desktop encrypted caches and ordinary quota history
  // are not evidence of a current plan, and are never decrypted here.
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken
    || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= now) return { name: null };
  const names = { free: 'Free', pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };
  const type = typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType.toLowerCase() : '';
  let name = Object.hasOwn(names, type) ? names[type] : null;
  if (type === 'max') {
    if (oauth.rateLimitTier === 'default_claude_max_5x') name = 'Max 5×';
    if (oauth.rateLimitTier === 'default_claude_max_20x') name = 'Max 20×';
  }
  return { name };
}
async function readClaudePlan(config, platform, now) {
  const file = path.join(config, '.credentials.json');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (platform !== 'win32' && (stat.mode & 0o077))) return { name: null };
    const buffer = await boundedFile(file, config, 65536);
    try {
      const plan = normalizeClaudePlan(JSON.parse(buffer.toString('utf8')), now);
      const latest = await fs.lstat(file);
      if (latest.ino !== stat.ino || latest.size !== stat.size || latest.mtimeMs !== stat.mtimeMs) return { name: null };
      return plan.name ? { ...plan, status: '终端登录', stale: stat.mtimeMs > now + 120000 || now - stat.mtimeMs > 1800000 } : plan;
    }
    finally { buffer.fill(0); }
  } catch { return { name: null }; }
}
function isDesktopEntry(entrypoint) {
  return ['claude-desktop', 'claude-desktop-3p', 'local-agent'].includes(entrypoint);
}
async function readCodeIdentity(file, root) {
  let buffer;
  try {
    buffer = await boundedFile(file, root, 1024 * 1024);
    const oauth = JSON.parse(buffer.toString('utf8')).oauthAccount;
    const account = oauth?.accountUuid; const org = oauth?.organizationUuid;
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    return uuid.test(account || '') && uuid.test(org || '') ? { account, org } : null;
  } catch { return null; } finally { buffer?.fill(0); }
}
class ClaudeStatusReader {
  constructor(options = {}) {
    this.paths = resolveClaudePaths(options); this.platform = options.platform || process.platform;
    this.source = options.source === 'desktop' ? 'desktop' : 'code'; this.generation = 0;
    const home = options.home || os.homedir(); const env = options.env || process.env;
    const paths = this.platform === 'win32' ? path.win32 : path.posix;
    this.codeIdentityPath = env.CLAUDE_CONFIG_DIR ? paths.join(this.paths.config, '.claude.json') : paths.join(home, '.claude.json');
    this.codeIdentityRoot = env.CLAUDE_CONFIG_DIR ? this.paths.config : home;
    this.desktopActivityReader = options.desktopActivityReader || require('./claude-desktop.cjs').readDesktopActivity;
    this.desktopPlanCache = null; this.desktopPlanCacheFile = null; this.persistedDesktopPlan = null;
    if (options.desktopPlanCacheFile) this.setDesktopPlanCacheFile(options.desktopPlanCacheFile);
  }
  setDesktopPlanCacheFile(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== 'claude-desktop-plan.json') throw new TypeError('Invalid Claude plan cache');
    this.desktopPlanCacheFile = file; this.persistedDesktopPlan = null; this.desktopPlanCache = null;
  }
  setSource(source) {
    if (!['desktop', 'code'].includes(source)) throw new TypeError('Invalid Claude source');
    if (source === this.source) return;
    this.source = source; this.generation++; this.desktopPlanCache = null; this.persistedDesktopPlan = null;
  }
  async requestActivityAccess() {
    const result = await this.desktopActivityReader(null, { platform: this.platform, requestAccess: true });
    return { trusted: result.trusted === true, supported: result.supported === true };
  }
  async restoreDesktopPlan(identityKey, now) {
    if (!this.desktopPlanCacheFile) return null;
    if (this.persistedDesktopPlan?.identity === identityKey) {
      const at = Date.parse(this.persistedDesktopPlan.observedAt);
      if (Number.isFinite(at) && at <= now + 120000 && now - at <= 30 * 86400000) return this.persistedDesktopPlan;
      this.persistedDesktopPlan = null;
    }
    let buffer;
    try {
      const file = this.desktopPlanCacheFile;
      const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
      buffer = await boundedFile(file, path.dirname(file), 4096);
      const payload = JSON.parse(buffer.toString('utf8'));
      const at = Date.parse(payload.observedAt);
      if (payload.version !== 1 || payload.identity !== identityKey || !Number.isFinite(at) || at > now + 120000 || now - at > 30 * 86400000
        || (payload.name !== null && !['Free', 'Pro', 'Max', 'Max 5×', 'Max 20×', 'Team', 'Enterprise'].includes(payload.name))) return null;
      this.persistedDesktopPlan = { identity: identityKey, name: payload.name, observedAt: payload.observedAt }; return this.persistedDesktopPlan;
    } catch { return null; } finally { buffer?.fill(0); }
  }
  async persistDesktopPlan(identityKey, plan) {
    if (!this.desktopPlanCacheFile || !plan.observedAt) return;
    const payload = { version: 1, identity: identityKey, name: plan.name, observedAt: plan.observedAt };
    if (this.persistedDesktopPlan?.identity === identityKey && this.persistedDesktopPlan?.name === payload.name
      && this.persistedDesktopPlan?.observedAt === payload.observedAt) return;
    let temporary;
    try {
      const dir = path.dirname(this.desktopPlanCacheFile);
      // main chooses the application's existing userData directory. Never create
      // arbitrary directories or write back into the provider's storage.
      if (!(await fs.stat(dir)).isDirectory()) return;
      temporary = path.join(dir, `.claude-desktop-plan-${randomBytes(8).toString('hex')}.tmp`);
      await fs.writeFile(temporary, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.desktopPlanCacheFile); temporary = null;
      this.persistedDesktopPlan = payload;
    } catch { /* Caching is optional; failed writes never replace live evidence. */ }
    finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
  }
  async readDesktopPlan(identity, now) {
    const { desktop } = this.paths;
    if (!identity) { this.desktopPlanCache = null; this.persistedDesktopPlan = null; return { name: null }; }
    const identityKey = createHash('sha256').update(`${identity.account.toLowerCase()}:${identity.org.toLowerCase()}:${identity.loginAt}`).digest('hex');
    const cached = await this.restoreDesktopPlan(identityKey, now);
    let plan = { name: null };
    try {
      const directory = path.join(desktop, 'Local Storage', 'leveldb');
      const names = (await fs.readdir(directory)).filter(n => /^\d{6,}\.(log|ldb|sst)$/.test(n)).sort().slice(-16);
      const stats = await Promise.all(names.map(async name => { const s = await fs.stat(path.join(directory, name)); return `${name}:${s.ino}:${s.size}:${s.mtimeMs}`; }));
      const signature = `${identityKey}:${stats.join('|')}`;
      if (this.desktopPlanCache?.signature === signature && now - this.desktopPlanCache.at < 60000) plan = this.desktopPlanCache.plan;
      else {
        plan = await require('./claude-desktop.cjs').readDesktopPlan(desktop, identity, now);
        this.desktopPlanCache = { signature, plan, at: now };
      }
    } catch { this.desktopPlanCache = null; }
    if (cached && (!plan.observedAt || Date.parse(cached.observedAt) > Date.parse(plan.observedAt))) {
      plan = { name: cached.name, observedAt: cached.observedAt, ...(cached.name ? { status: '桌面套餐快照', stale: true } : {}) };
    }
    if (plan.observedAt) await this.persistDesktopPlan(identityKey, plan);
    return plan;
  }
  async poll(processes, now = Date.now()) {
    const source = this.source, generation = this.generation;
    const { desktop, config } = this.paths;
    const desktopProcess = processes?.find(p => /(?:^|[/\\])Claude(?:\.exe)?$/.test(p.command));
    const desktopOpen = Boolean(desktopProcess);
    const codeProcesses = processes?.filter(p => isCodeProcess(p.command)) || [];
    const pids = new Set(codeProcesses.map(p => p.pid));
    let usage = null, usagePayload = null;
    let buffer;
    try {
      buffer = await boundedFile(path.join(desktop, 'plan-usage-history.json'), desktop, 4 * 1024 * 1024);
      usagePayload = JSON.parse(buffer.toString('utf8')); usage = normalizeClaudeUsage(usagePayload, now);
    } catch { /* Optional cache; missing or expired allowance remains unknown. */ }
    finally { buffer?.fill(0); }
    const identity = await require('./claude-desktop.cjs').readDesktopIdentity(desktop, usagePayload, now);
    let plan = source === 'code' ? await readClaudePlan(config, this.platform, now) : await this.readDesktopPlan(identity, now);
    let desktopActivity = { activity: 'unknown', trusted: false, supported: this.platform === 'darwin', plan: null };
    if (source === 'desktop' && desktopOpen) desktopActivity = await this.desktopActivityReader(desktopProcess.pid, { platform: this.platform });
    if (source === 'desktop' && desktopActivity.plan && ['Free', 'Pro', 'Max', 'Max 5×', 'Max 20×', 'Team', 'Enterprise'].includes(desktopActivity.plan)) {
      plan = { name: desktopActivity.plan, status: '桌面界面', stale: false, observedAt: new Date(now).toISOString() };
    }
    // Shared usage is valid only when the current CLI login and Desktop snapshot
    // explicitly identify the same account AND organization.
    if (source === 'code') {
      const codeIdentity = await readCodeIdentity(this.codeIdentityPath, this.codeIdentityRoot);
      if (!plan.name || !identity || !codeIdentity || codeIdentity.account.toLowerCase() !== identity.account.toLowerCase()
        || codeIdentity.org.toLowerCase() !== identity.org.toLowerCase()) usage = null;
    } else if (!identity) usage = null;
    let names = []; let failed = false;
    const sessions = path.join(config, 'sessions');
    try { names = (await fs.readdir(sessions)).filter(n => /^\d+\.json$/.test(n)); }
    catch (error) { failed = error.code !== 'ENOENT'; }
    const states = new Map(), classified = new Set();
    for (const name of names.filter(n => pids.has(Number(n.slice(0, -5)))).slice(0, 128)) {
      try {
        const file = path.join(sessions, name);
        const row = JSON.parse(await boundedFile(file, config, 65536));
        if (!Number.isInteger(row.pid) || row.pid !== Number(name.slice(0, -5))) continue;
        classified.add(row.pid);
        const surface = isDesktopEntry(row.entrypoint) ? 'desktop' : 'terminal';
        if ((source === 'desktop') !== (surface === 'desktop')) continue;
        const stat = await fs.stat(file);
        const fresh = stat.mtimeMs <= now + 120000 && now - stat.mtimeMs <= FRESH_MS;
        const phase = row.status === 'idle' ? 'idle' : fresh && row.status === 'busy' ? 'running'
          : fresh && row.status === 'waiting' ? 'waiting' : 'unknown';
        states.set(row.pid, { phase, surface, at: stat.mtimeMs, ...(this.taskDetailsEnabled ? { title: require('./task-details.cjs').safeText(row.title || row.taskName) } : {}) });
      } catch { failed = true; }
    }
    const values = [...states.values()];
    const sessionActive = values.filter(s => s.phase === 'running').length;
    // The visible Stop button can belong to a registered desktop Code session;
    // use the larger signal rather than double-counting the same task.
    const activeTasks = Math.max(sessionActive, source === 'desktop' && desktopActivity.activity === 'running' ? 1 : 0);
    const waiting = values.filter(s => s.phase === 'waiting').length;
    const incomplete = failed || (source === 'code' && classified.size < pids.size) || values.some(s => s.phase === 'unknown');
    const activity = processes === null ? 'unknown' : activeTasks ? 'running' : waiting ? 'waiting'
      : incomplete ? 'unknown' : source === 'desktop'
        ? desktopOpen ? desktopActivity.activity === 'idle' ? 'idle' : 'unknown' : values.length ? 'idle' : 'offline'
        : values.length ? 'idle' : codeProcesses.length && classified.size < pids.size ? 'unknown' : 'offline';
    const surfaces = source === 'desktop'
      ? { desktop: values.length ? `桌面 ${values.length} 个 Code 会话` : desktopOpen ? '桌面已打开' : '桌面未运行', terminal: '终端独立接入' }
      : { desktop: '桌面独立接入', terminal: values.length ? `终端 ${values.length} 个会话` : pids.size > classified.size ? 'Code 进程缺少会话记录' : '终端无运行会话' };
    const task = activeTasks ? source === 'desktop' && !sessionActive ? 'Claude 桌面正在生成回复' : source === 'desktop' ? `${activeTasks} 项桌面任务有近期活动` : `${activeTasks} 项 Code 任务有近期活动`
      : waiting ? `${waiting} 项任务等待确认` : activity === 'idle' ? '已连接会话暂无运行任务'
        : activity === 'offline' ? source === 'desktop' ? 'Claude 桌面未运行' : 'Claude Code 未运行'
          : source === 'desktop' ? '桌面当前任务状态未知' : 'Code 当前任务状态未知';
    const taskDetails = this.taskDetailsEnabled ? values.slice(0, 8).map(s => taskDetail({ title: s.title, state: s.phase, updatedAt: s.at }, { now, live: true })) : [];
    if (this.taskDetailsEnabled && source === 'desktop' && ['running', 'idle'].includes(desktopActivity.activity)) {
      taskDetails.unshift(taskDetail({ title: null, state: desktopActivity.activity, updatedAt: now, operation: desktopActivity.activity === 'running' ? 'agentMessage' : undefined }, { now, live: true }));
    }
    const result = { id: 'claude', claudeSource: source, source: usage || values.length || plan.name || desktopActivity.trusted ? 'cache' : 'unavailable',
      connection: processes === null ? 'error' : source === 'desktop' ? desktopOpen || values.length ? 'ready' : 'offline' : values.length || pids.size > classified.size ? 'ready' : 'offline',
      activity, activeTasks, task, plan, ...(this.taskDetailsEnabled ? { taskDetails: taskDetails.slice(0, 8) } : {}),
      quotas: usage?.quotas || [], observedAt: usage?.observedAt || plan.observedAt || null, surfaces,
      activityAccessRequired: source === 'desktop' && desktopOpen && desktopActivity.supported && !desktopActivity.trusted,
      activityObservedAt: source === 'desktop' && ['running', 'idle'].includes(desktopActivity.activity) ? new Date(now).toISOString()
        : values.length ? new Date(Math.max(...values.map(s => s.at))).toISOString() : null,
      activityDetail: source === 'desktop'
        ? '桌面普通聊天由 macOS 辅助功能只读发送和停止按钮；桌面 Code 会话单独校验进程和十分钟时效。后台或不可见聊天无法确认时保持未知。'
        : '仅监看终端 Code 会话，校验进程和十分钟时效；桌面 Code 不计入终端任务。',
      detail: source === 'desktop'
        ? '桌面额度来自当前登录账号的本地用量快照。套餐读取匹配账号和组织的桌面套餐快照，历史档位会标记为历史；Free 或未提供窗口的额度保持未知。'
        : '终端套餐只读取有效的文件型登录；额度仅复用账号和组织均一致的桌面用量快照，无法匹配时保持未知。' };
    if (generation !== this.generation) return { id: 'claude', claudeSource: this.source, source: 'unavailable', connection: 'unavailable', activity: 'unknown', activeTasks: 0, task: '当前任务状态未知', plan: { name: null }, quotas: [], observedAt: null };
    return result;
  }
}
module.exports = { ClaudeStatusReader, normalizeClaudeUsage, normalizeClaudePlan, readClaudePlan, resolveClaudePaths, isCodeProcess, isDesktopEntry, readCodeIdentity };
