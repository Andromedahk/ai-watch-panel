const { taskDetail } = require('./task-details.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
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
// The CLI names why a registered session waits (terminal dialogs and the
// host-driven Desktop Code session both write it). Unknown labels stay generic.
const APPROVAL_WAITS = new Set(['permission prompt', 'sandbox request']);
const INPUT_WAITS = new Set(['input needed', 'dialog open', 'goal proposal']);
function registrationWaitReason(label) {
  return APPROVAL_WAITS.has(label) ? 'approval' : INPUT_WAITS.has(label) ? 'input' : undefined;
}
function isCodeProcess(command) {
  return /(?:^|[/\\])claude(?:\.exe)?$/.test(command)
    || /[/\\]claude[/\\]versions[/\\]\d+\.\d+\.\d+(?:\.exe)?$/.test(command);
}
// PID numbers can be reused. Compare the logger's captured start time with one
// bounded native query per poll; do not add process arguments or paths to state.
async function readOwnerStarts(pids) {
  const selected = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 1))].slice(0, 64);
  if (!selected.length) return new Map();
  try {
    const { stdout } = await execFile('/bin/ps', ['-p', selected.join(','), '-o', 'pid=,lstart='], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 1000, maxBuffer: 32768, windowsHide: true,
    });
    const starts = new Map();
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]), start = match[2].trim().replace(/\s+/g, ' ');
      if (selected.includes(pid) && /^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(start)) starts.set(pid, start);
    }
    return starts;
  } catch { return new Map(); }
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
// Claude Desktop's chat renderer is near-idle (< 3 %) unless it is streaming a reply,
// animating the thinking indicator or the user is interacting with it. Two
// consecutive busy samples are treated as a likely reply in progress; this is an
// inference used only when the accessibility probe cannot answer.
const RENDERER = /[/\\]Claude\.app[/\\]Contents[/\\]Frameworks[/\\]Claude Helper \(Renderer\)\.app[/\\]/;
const BUSY_CPU = 12;
function rendererLoad(processes) {
  if (!Array.isArray(processes)) return null;
  const rows = processes.filter(p => RENDERER.test(p.command) && Number.isFinite(p.cpu));
  return rows.length ? Math.round(rows.reduce((total, p) => total + p.cpu, 0) * 10) / 10 : null;
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
    this.usageReader = options.usageReader || new (require('./claude-usage.cjs').ClaudeUsageReader)({ paths: this.paths, platform: this.platform });
    this.desktopPlanCache = null; this.desktopPlanCacheFile = null; this.persistedDesktopPlan = null; this.loadSamples = [];
    this.hooks = options.hooks || null; // optional ClaudeHooks reader (Claude Code lifecycle events)
    this.ownerStartsReader = options.ownerStartsReader || readOwnerStarts;
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
    this.usageReader.clearSource();
  }
  setNetworkAllowed(value) {
    if (typeof value !== 'boolean') throw new TypeError('Invalid Claude network setting');
    if (this.usageReader.allowed === value) return;
    this.generation++; this.usageReader.setAllowed(value);
  }
  async requestActivityAccess() {
    const result = await this.desktopActivityReader(null, { platform: this.platform, requestAccess: true });
    return { trusted: result.trusted === true ? true : result.trusted === false ? false : null, supported: result.supported === true,
      ...(require('./claude-desktop.cjs').ACTIVITY_PROBE_ERRORS.includes(result.probeError) ? { probeError: result.probeError } : {}) };
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
  async poll(processes, now = Date.now(), force = false) {
    const source = this.source, generation = this.generation;
    const networkPromise = this.usageReader.poll(source, now, force);
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
    let desktopActivity = { activity: 'unknown', trusted: null, supported: this.platform === 'darwin', plan: null };
    if (source === 'desktop' && desktopOpen) desktopActivity = await this.desktopActivityReader(desktopProcess.pid, { platform: this.platform });
    const load = source === 'desktop' && desktopOpen ? rendererLoad(processes) : null;
    this.loadSamples = load === null ? [] : [...this.loadSamples, { at: now, load }].filter(s => now - s.at <= 20000).slice(-3);
    const recent = this.loadSamples.slice(-2);
    const inferredBusy = desktopActivity.activity === 'unknown' && recent.length === 2 && recent.every(s => s.load >= BUSY_CPU);
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
    const network = await networkPromise;
    // A successful empty server window clears older local windows. Expired
    // authorization must never be masked by a previously cached allowance.
    if (network.usage) { usage = network.usage; plan = network.plan; }
    else if (network.state === 'auth') { usage = null; plan = { name: null }; }
    let names = []; let failed = false;
    const sessions = path.join(config, 'sessions');
    try { names = (await fs.readdir(sessions)).filter(n => /^\d+\.json$/.test(n)); }
    catch (error) { failed = error.code !== 'ENOENT'; }
    const states = new Map(), classified = new Set(), registrations = new Map(), rows = [];
    for (const name of names.filter(n => pids.has(Number(n.slice(0, -5)))).slice(0, 128)) {
      try {
        const file = path.join(sessions, name);
        const row = JSON.parse(await boundedFile(file, config, 65536));
        if (!Number.isInteger(row.pid) || row.pid !== Number(name.slice(0, -5))) continue;
        classified.add(row.pid);
        const surface = isDesktopEntry(row.entrypoint) ? 'desktop' : 'terminal';
        const session = typeof row.sessionId === 'string' && row.sessionId ? row.sessionId : null;
        registrations.set(row.pid, { session, surface });
        rows.push({ row, surface, session, stat: await fs.stat(file) });
      } catch { failed = true; }
    }
    // The CLI rewrites its registration only when the status changes, so a long
    // turn leaves an old mtime. A procStart equal to the live PID's start time
    // proves the file belongs to this process and its status is still current.
    let rowStarts = new Map();
    const startPids = [...new Set(rows.filter(r => typeof r.row.procStart === 'string').map(r => r.row.pid))].slice(0, 64);
    if (startPids.length) {
      try { rowStarts = await this.ownerStartsReader(startPids); } catch { /* No owner identity: keep the freshness rule. */ }
    }
    for (const { row, surface, session, stat } of rows) {
      const registeredStart = typeof row.procStart === 'string' ? row.procStart.trim().replace(/\s+/g, ' ') : '';
      const nativeStart = rowStarts instanceof Map ? rowStarts.get(row.pid) : null;
      const ownerStart = typeof nativeStart === 'string' ? nativeStart.trim().replace(/\s+/g, ' ') : '';
      // A positive mismatch proves PID reuse. Even a recent file then belongs
      // to another process; do not let its old session block the new owner's hook.
      if (registeredStart && ownerStart && registeredStart !== ownerStart) {
        registrations.delete(row.pid); classified.delete(row.pid); continue;
      }
      if ((source === 'desktop') !== (surface === 'desktop')) continue;
      const live = Boolean(registeredStart && ownerStart && registeredStart === ownerStart);
      const fresh = live || (stat.mtimeMs <= now + 120000 && now - stat.mtimeMs <= FRESH_MS);
      const phase = row.status === 'idle' ? 'idle' : fresh && row.status === 'busy' ? 'running'
        : fresh && row.status === 'waiting' ? 'waiting' : 'unknown';
      const updated = live && Number.isFinite(row.statusUpdatedAt) && row.statusUpdatedAt <= now + 120000 ? row.statusUpdatedAt : 0;
      const reason = phase === 'waiting' ? registrationWaitReason(row.waitingFor) : undefined;
      states.set(row.pid, { phase, ...(reason ? { reason } : {}), surface, session, registrationVerified: live, at: Math.max(stat.mtimeMs, updated), ...(this.taskDetailsEnabled ? { title: require('./task-details.cjs').safeText(row.title || row.taskName || row.name) } : {}) });
    }
    // The logger captures the nearest actual Claude Code owner when the event
    // occurs. It must still be alive: never fall back to a surviving ancestor of
    // an exited nested CLI, even when that parent has no session registration.
    const hookByPid = new Map();
    if (this.hooks?.enabled && pids.size) {
      const candidates = [];
      for (const hook of (await this.hooks.read(now)) || []) {
        if (!hook || typeof hook.session !== 'string' || !hook.session
          || !['running', 'waiting', 'idle'].includes(hook.phase) || !Number.isFinite(hook.at)
          || !Array.isArray(hook.ancestors) || !Number.isSafeInteger(hook.ownerPid) || hook.ownerPid <= 1
          || typeof hook.ownerStart !== 'string' || !hook.ownerStart) continue;
        const pid = hook.ownerPid;
        if (!pids.has(pid) || !hook.ancestors.includes(pid)) continue;
        const registration = registrations.get(pid);
        if (registration?.session && registration.session !== hook.session) continue;
        const surface = registration?.surface || hook.surface;
        if (!['desktop', 'terminal'].includes(surface)) continue;
        candidates.push({ hook, pid, surface });
      }
      let ownerStarts = new Map();
      const ownerPids = [...new Set(candidates.map(candidate => candidate.pid))].slice(0, 64);
      if (ownerPids.length) {
        try { ownerStarts = await this.ownerStartsReader(ownerPids); } catch { /* No reliable owner identity: keep file/AX evidence only. */ }
      }
      for (const { hook, pid, surface } of candidates) {
        if (!(ownerStarts instanceof Map) || ownerStarts.get(pid) !== hook.ownerStart) continue;
        classified.add(pid);
        if ((source === 'desktop') !== (surface === 'desktop')) continue;
        // Without a registration, a CLI may have moved to another session. Only
        // its newest hook session is evidence of its current state.
        if (!hookByPid.has(pid) || hookByPid.get(pid).at <= hook.at) hookByPid.set(pid, { ...hook, surface });
      }
    }
    const hookSessions = [...hookByPid.values()];
    for (const [pid, hook] of hookByPid) {
      // A verified registration names its wait itself (permission prompt vs
      // input needed); keep that label over a hook-derived reason.
      const registered = states.get(pid);
      const reason = hook.phase === 'waiting' && registered?.registrationVerified && registered.phase === 'waiting' && registered.reason ? registered.reason : hook.reason;
      states.set(pid, { ...registered, registrationVerified: false, phase: hook.phase, reason,
        session: hook.session, surface: hook.surface, at: hook.at, hook: true });
    }
    // A session can have more than one registered PID. Prefer its hook state over
    // an older registration, then keep the freshest evidence for one task count.
    const bySession = new Map();
    for (const [pid, state] of states) {
      const key = state.session ? `session:${state.session}` : `pid:${pid}`;
      const previous = bySession.get(key);
      if (!previous || (state.hook && !previous.hook) || (Boolean(state.hook) === Boolean(previous.hook) && state.at >= previous.at)) bySession.set(key, state);
    }
    const values = [...bySession.values()];
    const sessionActive = values.filter(s => s.phase === 'running').length;
    // AX describes the visible desktop conversation, which may be the same Code
    // session already counted above. It establishes at least one task, not another.
    const desktopRunning = source === 'desktop' && (desktopActivity.activity === 'running' || inferredBusy);
    const activeTasks = Math.max(sessionActive, desktopRunning ? 1 : 0);
    const desktopWaiting = source === 'desktop' && desktopActivity.activity === 'waiting' ? desktopActivity.waiting : null;
    const waitingSessions = values.filter(s => s.phase === 'waiting');
    const waiting = Math.max(waitingSessions.length, desktopWaiting ? 1 : 0);
    const reasons = new Set([...waitingSessions.map(s => s.reason), desktopWaiting].filter(Boolean));
    const waitingReason = !waiting ? undefined : reasons.size === 1 && waitingSessions.every(s => s.reason) ? [...reasons][0] : 'both';
    const incomplete = failed || (source === 'code' && classified.size < pids.size) || values.some(s => s.phase === 'unknown');
    // A question or permission prompt outranks a running task, as for Codex.
    const activity = processes === null ? 'unknown' : waiting ? 'waiting' : activeTasks ? 'running'
      : incomplete ? 'unknown' : source === 'desktop'
        ? desktopOpen ? desktopActivity.activity === 'idle' ? 'idle' : 'unknown' : values.length ? 'idle' : 'offline'
        : values.length ? 'idle' : codeProcesses.length && classified.size < pids.size ? 'unknown' : 'offline';
    const surfaces = source === 'desktop'
      ? { desktop: values.length ? `桌面 ${values.length} 个 Code 会话` : desktopOpen ? '桌面已打开' : '桌面未运行', terminal: '终端独立接入' }
      : { desktop: '桌面独立接入', terminal: values.length ? `终端 ${values.length} 个会话` : pids.size > classified.size ? 'Code 进程缺少会话记录' : '终端无运行会话' };
    const task = waiting ? waitingReason === 'approval' ? waiting > 1 ? `${waiting} 项任务等你授权工具` : 'Claude 在等你授权工具'
      : waitingReason === 'input' ? waiting > 1 ? `${waiting} 项任务等你回答问题` : 'Claude 在等你回答问题' : `${waiting} 项任务等你回答或确认`
      : activeTasks ? source === 'desktop' && !sessionActive ? inferredBusy && desktopActivity.activity !== 'running' ? 'Claude 桌面可能正在生成回复（按进程负载推测）' : 'Claude 桌面正在生成回复' : source === 'desktop' ? `${activeTasks} 项桌面任务有近期活动` : `${activeTasks} 项 Code 任务有近期活动`
      : activity === 'idle' ? '已连接会话暂无运行任务'
        : activity === 'offline' ? source === 'desktop' ? 'Claude 桌面未运行' : 'Claude Code 未运行'
          : source === 'desktop' ? '桌面当前任务状态未知' : 'Code 当前任务状态未知';
    // A verified registration remains current while its owner lives, even when
    // its last status transition is old. Keep that real transition timestamp.
    const taskDetails = this.taskDetailsEnabled ? values.slice(0, 8).map(s => taskDetail({ title: s.title, state: s.phase, updatedAt: s.at },
      { now, live: true, freshMs: s.registrationVerified ? Infinity : FRESH_MS })) : [];
    if (this.taskDetailsEnabled && source === 'desktop' && ['running', 'idle'].includes(desktopActivity.activity)) {
      taskDetails.unshift(taskDetail({ title: null, state: desktopActivity.activity, updatedAt: now, operation: desktopActivity.activity === 'running' ? 'agentMessage' : undefined }, { now, live: true }));
    }
    const result = { id: 'claude', claudeSource: source, source: network.usage && network.state === 'ready' ? 'account' : usage || values.length || plan.name || desktopActivity.trusted ? 'cache' : 'unavailable',
      connection: processes === null ? 'error' : source === 'desktop' ? desktopOpen || values.length ? 'ready' : 'offline' : values.length || pids.size > classified.size ? 'ready' : 'offline',
      activity, activeTasks, task, plan, waitingTasks: waiting, ...(waitingReason ? { waitingReason } : {}),
      ...(inferredBusy && desktopActivity.activity !== 'running' ? { activityInferred: true } : {}), ...(this.taskDetailsEnabled ? { taskDetails: taskDetails.slice(0, 8) } : {}),
      quotas: usage?.quotas || [], observedAt: usage?.observedAt || plan.observedAt || null, surfaces,
      activityAccessRequired: source === 'desktop' && desktopOpen && desktopActivity.supported && desktopActivity.trusted === false,
      ...(source === 'desktop' ? { activityAccessState: !desktopActivity.supported ? 'unsupported' : desktopActivity.trusted === true ? 'granted' : desktopActivity.trusted === false ? 'denied' : 'unknown' } : {}),
      ...(source === 'desktop' && require('./claude-desktop.cjs').ACTIVITY_PROBE_ERRORS.includes(desktopActivity.probeError) ? { activityProbeError: desktopActivity.probeError } : {}),
      activityObservedAt: source === 'desktop' && (['running', 'idle', 'waiting'].includes(desktopActivity.activity) || inferredBusy) ? new Date(now).toISOString()
        : values.length || hookSessions.length ? new Date(Math.max(...values.map(s => s.at), ...hookSessions.map(s => s.at))).toISOString() : null,
      ...(this.hooks?.enabled ? { activityHooks: true } : {}),
      activityDetail: (this.hooks?.enabled ? 'Claude Code 状态钩子已启用：Code 会话的运行、工具授权和提问由钩子即时上报。' : '') + (source === 'desktop'
        ? '桌面普通聊天由 macOS 辅助功能只读发送、停止和工具授权按钮；未授权或无法读取时，按 Claude 渲染进程的负载推测是否正在生成。桌面 Code 会话单独核对存活进程与登记的启动时间；无法核对时使用十分钟时效。'
        : '仅监看终端 Code 会话，核对存活进程与登记的启动时间；无法核对时使用十分钟时效。桌面 Code 不计入终端任务。'),
      detail: network.state !== 'disabled' ? network.detail : source === 'desktop'
        ? '桌面额度来自当前登录账号的本地用量快照。套餐读取匹配账号和组织的桌面套餐快照，历史档位会标记为历史；Free 或未提供窗口的额度保持未知。'
        : '终端套餐只读取有效的文件型登录；额度仅复用账号和组织均一致的桌面用量快照，无法匹配时保持未知。' };
    if (generation !== this.generation) return { id: 'claude', claudeSource: this.source, source: 'unavailable', connection: 'unavailable', activity: 'unknown', activeTasks: 0, task: '当前任务状态未知', plan: { name: null }, quotas: [], observedAt: null };
    return result;
  }
}
module.exports = { ClaudeStatusReader, normalizeClaudeUsage, normalizeClaudePlan, readClaudePlan, resolveClaudePaths, isCodeProcess, isDesktopEntry, readCodeIdentity, readOwnerStarts };
