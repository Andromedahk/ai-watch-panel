'use strict';
// Optional Claude Code lifecycle metadata. The shell starts the app's own
// runtime; the JSON logger accesses only top-level allowlisted metadata.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const SCRIPT_NAME = 'ai-watch-claude-hook.sh';
const LOGGER_NAME = 'ai-watch-claude-hook-logger.cjs';
const EVENTS_NAME = 'claude-hook-events.log';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'Notification', 'Elicitation', 'ElicitationResult', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStop'];
const DESKTOP_ENTRYPOINTS = new Set(['claude-desktop', 'claude-desktop-3p', 'local-agent']);
const INPUT_NOTIFICATIONS = new Set(['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const RUNNING_MS = 10 * 60 * 1000;
const WAITING_MS = 6 * 60 * 60 * 1000;
const READ_BYTES = 256 * 1024, TRIM_BYTES = 512 * 1024;
const MAX_PENDING = 128, MAX_AGENTS = 64;
const OWNER = 'ai-watch:claude-status:v1';
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,128}$/.test(value);
const shellQuote = value => `"${String(value).replace(/["\\$`]/g, '\\$&')}"`;

function scriptSource(eventsFile, { runtime = process.execPath, loggerFile = path.join(path.dirname(eventsFile), LOGGER_NAME) } = {}) {
  return `#!/bin/sh
# AI Watch Claude Code metadata hook. No stdout, context or permission decisions.
# Uses the app's bundled runtime, independently of the user's PATH.
umask 077
ELECTRON_RUN_AS_NODE=1 ${shellQuote(runtime)} ${shellQuote(loggerFile)} ${shellQuote(eventsFile)} "$1" >/dev/null 2>&1
exit 0
`;
}
function legacyHookCommand(scriptFile, event) {
  const quoted = shellQuote(scriptFile);
  return `test -f ${quoted} && /bin/sh ${quoted} ${event} || true`;
}
function hookCommand(scriptFile, event) { return `${legacyHookCommand(scriptFile, event)} # ${OWNER}`; }
function isOurs(hook, event, scriptFile) {
  return typeof scriptFile === 'string' && EVENTS.includes(event) && hook?.type === 'command'
    && [hookCommand(scriptFile, event), legacyHookCommand(scriptFile, event)].includes(hook.command);
}
function withoutOurHooks(settings, scriptFile) {
  const next = { ...settings };
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) return next;
  const hooks = {};
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = groups.map(group => Array.isArray(group?.hooks)
      ? { ...group, hooks: group.hooks.filter(hook => !isOurs(hook, event, scriptFile)) } : group)
      .filter(group => !Array.isArray(group?.hooks) || group.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
  return next;
}
function withOurHooks(settings, scriptFile) {
  const next = withoutOurHooks(settings, scriptFile), hooks = { ...(next.hooks || {}) };
  for (const event of EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...groups, { hooks: [{ type: 'command', command: hookCommand(scriptFile, event), timeout: 5 }] }];
  }
  return { ...next, hooks };
}
function countOurHooks(settings, scriptFile) {
  if (!settings?.hooks || typeof settings.hooks !== 'object') return 0;
  return Object.entries(settings.hooks).reduce((total, [event, groups]) => total + (Array.isArray(groups)
    ? groups.reduce((sum, group) => sum + (Array.isArray(group?.hooks) ? group.hooks.filter(h => isOurs(h, event, scriptFile)).length : 0), 0) : 0), 0);
}
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs].join(':');
async function readSettings(file) {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return { settings: {}, exists: false, text: null, signature: null }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('settings-unreadable');
  const text = await fs.readFile(file, 'utf8');
  if (signature(await fs.lstat(file)) !== signature(stat)) throw new Error('settings-changed');
  const settings = text.trim() ? JSON.parse(text) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)))
    || Object.values(settings.hooks || {}).some(groups => !Array.isArray(groups))) throw new SyntaxError('Invalid settings object');
  return { settings, exists: true, text, signature: signature(stat), mode: stat.mode & 0o777 };
}
function unchanged(file, expected) {
  let stat;
  try { stat = fsSync.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT' && !expected.exists) return; throw new Error('settings-changed'); }
  if (!expected.exists || !stat.isFile() || stat.isSymbolicLink() || signature(stat) !== expected.signature
    || fsSync.readFileSync(file, 'utf8') !== expected.text || signature(fsSync.lstatSync(file)) !== expected.signature) throw new Error('settings-changed');
}
async function writeAtomic(file, text, mode, beforeRename) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporary, text, { mode, flag: 'wx' });
    await fs.chmod(temporary, mode);
    // No await between the final check and rename: an in-process writer cannot
    // interleave here. External, non-cooperating writers still need their own coordination.
    if (beforeRename) beforeRename();
    fsSync.renameSync(temporary, file);
  } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}
function settingsError(error) {
  if (['settings-invalid', 'settings-unreadable', 'settings-changed'].includes(error.message)) return error;
  const failure = new Error(error instanceof SyntaxError ? 'settings-invalid' : 'settings-unreadable'); failure.cause = error; return failure;
}

class ClaudeHooks {
  constructor({ settingsFile, dataDir, platform = process.platform, runtime = process.execPath }) {
    this.settingsFile = settingsFile; this.platform = platform; this.runtime = runtime;
    this.scriptFile = path.join(dataDir, SCRIPT_NAME); this.loggerFile = path.join(dataDir, LOGGER_NAME);
    this.eventsFile = path.join(dataDir, EVENTS_NAME);
    this.sessions = new Map(); this.offset = 0; this.inode = null; this.enabled = false; this.mutation = Promise.resolve();
  }
  get supported() { return this.platform !== 'win32'; }
  async status() {
    if (!this.supported) return { supported: false, installed: false };
    try {
      const { settings } = await readSettings(this.settingsFile);
      const installed = EVENTS.every(event => (settings.hooks?.[event] || []).reduce((count, group) => count
        + (Array.isArray(group?.hooks) ? group.hooks.filter(h => isOurs(h, event, this.scriptFile)).length : 0), 0) === 1);
      return { supported: true, installed };
    } catch { return { supported: true, installed: false, error: 'settings-unreadable' }; }
  }
  enqueue(work) {
    const operation = this.mutation.then(work, work);
    this.mutation = operation.catch(() => {}); return operation;
  }
  install() { return this.enqueue(() => this.installNow()); }
  async installNow() {
    this.enabled = false;
    if (!this.supported) throw new Error('unsupported-platform');
    let current;
    try { current = await readSettings(this.settingsFile); } catch (error) { throw settingsError(error); }
    await fs.mkdir(path.dirname(this.scriptFile), { recursive: true, mode: 0o700 });
    await writeAtomic(this.loggerFile, await fs.readFile(path.join(__dirname, 'claude-hook-logger.cjs'), 'utf8'), 0o600);
    await writeAtomic(this.scriptFile, scriptSource(this.eventsFile, { runtime: this.runtime, loggerFile: this.loggerFile }), 0o700);
    await fs.mkdir(path.dirname(this.settingsFile), { recursive: true, mode: 0o700 });
    await writeAtomic(this.settingsFile, `${JSON.stringify(withOurHooks(current.settings, this.scriptFile), null, 2)}\n`, current.mode ?? 0o600,
      () => unchanged(this.settingsFile, current));
    this.enabled = true;
  }
  uninstall() { return this.enqueue(() => this.uninstallNow()); }
  async uninstallNow() {
    this.enabled = false; this.sessions.clear(); this.offset = 0; this.inode = null;
    if (!this.supported) return;
    let failure;
    try {
      const current = await readSettings(this.settingsFile);
      if (current.exists && countOurHooks(current.settings, this.scriptFile)) {
        await writeAtomic(this.settingsFile, `${JSON.stringify(withoutOurHooks(current.settings, this.scriptFile), null, 2)}\n`, current.mode,
          () => unchanged(this.settingsFile, current));
      }
    } catch (error) { failure = settingsError(error); }
    for (const file of [this.scriptFile, this.loggerFile, this.eventsFile]) {
      try { await fs.unlink(file); } catch (error) { if (error.code !== 'ENOENT') failure ||= error; }
    }
    if (failure) throw failure;
  }
  async read(now = Date.now()) {
    if (!this.enabled) return [];
    try {
      const stat = await fs.stat(this.eventsFile);
      if (this.inode !== stat.ino || stat.size < this.offset) { this.inode = stat.ino; this.offset = 0; this.sessions.clear(); }
      if (stat.size > this.offset) {
        const start = Math.max(this.offset, stat.size - READ_BYTES), length = stat.size - start;
        const buffer = Buffer.alloc(length); const handle = await fs.open(this.eventsFile, 'r');
        let bytesRead;
        try { ({ bytesRead } = await handle.read(buffer, 0, length, start)); } finally { await handle.close(); }
        let text = buffer.subarray(0, bytesRead).toString('utf8');
        let skipped = 0;
        if (start > this.offset) { const first = text.indexOf('\n'); skipped = first < 0 ? text.length : first + 1; text = text.slice(skipped); }
        const complete = text.lastIndexOf('\n');
        if (complete >= 0) { this.apply(text.slice(0, complete)); this.offset = start + skipped + complete + 1; }
        else if (start > this.offset) this.offset = start + skipped;
      }
      if (stat.size > TRIM_BYTES) await this.trim();
    } catch (error) { if (error.code !== 'ENOENT') return null; }
    return this.live(now);
  }
  apply(text) {
    for (const line of text.split('\n')) {
      if (line.length > 4096) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; } // legacy TSV has no trustworthy process association
      if (!row || row.v !== 1 || !EVENTS.includes(row.event) || !token(row.session)
        || !Number.isSafeInteger(row.at) || row.at <= 0 || !Array.isArray(row.ancestors)
        || row.ancestors.length > 24 || row.ancestors.some(pid => !Number.isSafeInteger(pid) || pid <= 1)
        || row.ownerPid !== undefined && (!Number.isSafeInteger(row.ownerPid) || !row.ancestors.includes(row.ownerPid))
        || row.ownerStart !== undefined && (typeof row.ownerStart !== 'string' || !/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(row.ownerStart))) continue;
      for (const key of ['agent', 'tool', 'toolUse', 'elicitation', 'kind', 'entry']) if (row[key] !== undefined && !token(row[key])) delete row[key];
      this.applyEvent(row);
    }
  }
  applyEvent(row) {
    const { event, session, at, kind, tool, toolUse, elicitation } = row;
    const agent = row.agent || '';
    if (event === 'SessionEnd' && !agent) { this.sessions.delete(session); return; }
    const ordinaryNotification = event === 'Notification' && !['permission_prompt', 'idle_prompt', 'agent_completed', ...INPUT_NOTIFICATIONS].includes(kind);
    if (ordinaryNotification || event === 'Notification' && kind === 'agent_completed' && !agent) return;
    // Untargeted completion notifications describe the agent view, not the
    // current session's root turn. Never guess their target from message text.
    let state = this.sessions.get(session);
    if (!state || event === 'SessionStart' && !agent) state = { session, agents: new Map(), pending: new Map(), tools: new Map() };
    const ownPending = () => [...state.pending].filter(([, pending]) => pending.agent === agent);
    const ownTools = () => [...state.tools].filter(([, call]) => call.agent === agent);
    const clearAgent = () => {
      for (const [key] of ownPending()) state.pending.delete(key);
      for (const [key] of ownTools()) state.tools.delete(key);
    };
    const setPhase = phase => state.agents.set(agent, { phase, at });
    const addPending = (reason, type, details = {}, scope = agent) => {
      const key = `${scope}\0${type}\0${details.toolUse || details.elicitation || details.tool || details.notification || reason}`;
      const old = state.pending.get(key);
      if (!old || old.reason !== reason) state.pending.set(key, { agent: scope, reason, type, at, ...details });
    };
    if (event === 'SessionStart') { clearAgent(); setPhase('idle'); }
    else if (event === 'UserPromptSubmit') { clearAgent(); setPhase('running'); }
    else if (['Stop', 'StopFailure', 'SubagentStop', 'SessionEnd'].includes(event)
      || event === 'Notification' && ['idle_prompt', 'agent_completed'].includes(kind)) { clearAgent(); setPhase('idle'); }
    else if (event === 'PreToolUse') {
      setPhase('running');
      if (tool) state.tools.set(`${agent}\0${toolUse || tool}`, { agent, tool, toolUse, at });
      if (tool === 'AskUserQuestion') addPending('input', 'tool', { tool, toolUse });
    } else if (event === 'PermissionRequest') {
      const candidates = ownTools().map(([, call]) => call).filter(call => call.tool === tool);
      const linked = toolUse || (candidates.length === 1 ? candidates[0].toolUse : undefined);
      addPending('approval', 'tool', { tool, toolUse: linked,
        ...(linked ? {} : { candidates: candidates.map(call => call.toolUse).filter(Boolean) }) });
    } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
      setPhase('running');
      for (const [key, pending] of ownPending()) {
        if (pending.type !== 'tool') continue;
        // A same-tool fallback is safe only when the protocol supplied no call
        // id for either side and there is no competing call for that agent/tool.
        const competing = ownTools().filter(([, call]) => call.tool === tool).length;
        if (toolUse && pending.candidates?.includes(toolUse)) {
          pending.candidates = pending.candidates.filter(id => id !== toolUse);
          if (!pending.candidates.length) state.pending.delete(key);
          continue;
        }
        if (toolUse && pending.toolUse === toolUse || !toolUse && !pending.toolUse && tool && pending.tool === tool && competing <= 1) state.pending.delete(key);
      }
      for (const [key, call] of ownTools()) if (toolUse ? call.toolUse === toolUse : call.tool === tool && !call.toolUse) state.tools.delete(key);
    } else if (event === 'Elicitation') addPending('input', 'elicitation', { elicitation });
    else if (event === 'ElicitationResult') {
      setPhase('running');
      for (const [key, pending] of ownPending()) if (pending.type === 'elicitation' && pending.elicitation === elicitation) state.pending.delete(key);
    } else if (event === 'Notification' && kind === 'agent_needs_input') {
      // This notification has no guaranteed target agent. It cannot consume or
      // resolve a root tool call merely because that is the only known call.
      addPending('input', 'notification', { notification: kind }, agent || '\u0001unassigned-background');
    } else if (event === 'Notification') {
      const reason = kind === 'permission_prompt' ? 'approval' : 'input';
      if (!ownPending().some(([, pending]) => pending.reason === reason)) {
        const calls = ownTools().map(([, call]) => call);
        if (calls.length === 1) addPending(reason, 'tool', { tool: calls[0].tool, toolUse: calls[0].toolUse });
        else addPending(reason, 'notification');
      }
    }
    state.at = at;
    // In-process and separate subagents share a session id, but a child process
    // must never replace the main session's already-observed owner identity.
    if (!state.ownerIsRoot || !agent) {
      state.ancestors = [...new Set(row.ancestors)]; state.ownerPid = row.ownerPid; state.ownerStart = row.ownerStart;
      state.surface = DESKTOP_ENTRYPOINTS.has(row.entry) ? 'desktop' : row.entry ? 'terminal' : state.surface || 'terminal';
      if (!agent) state.ownerIsRoot = true;
    }
    while (state.pending.size > MAX_PENDING) state.pending.delete(state.pending.keys().next().value);
    while (state.tools.size > MAX_PENDING) state.tools.delete(state.tools.keys().next().value);
    while (state.agents.size > MAX_AGENTS) state.agents.delete(state.agents.keys().next().value);
    this.sessions.delete(session); this.sessions.set(session, state);
    if (this.sessions.size > 64) this.sessions.delete(this.sessions.keys().next().value);
  }
  live(now) {
    const result = [];
    for (const state of this.sessions.values()) {
      const pending = [...state.pending.values()].filter(value => value.at <= now + 120000 && now - value.at <= WAITING_MS);
      const agents = [...state.agents.values()].filter(value => value.at <= now + 120000 && (value.phase !== 'running' || now - value.at <= RUNNING_MS));
      if (!pending.length && !agents.length) continue;
      const running = agents.filter(value => value.phase === 'running');
      const reasons = new Set(pending.map(value => value.reason));
      const phase = pending.length ? 'waiting' : running.length ? 'running' : 'idle';
      const at = Math.max(...(pending.length ? pending : running.length ? running : agents).map(value => value.at));
      result.push({ session: state.session, phase, ...(pending.length ? { reason: reasons.size === 1 ? [...reasons][0] : 'both' } : {}),
        at, surface: state.surface, ancestors: state.ancestors, ...(state.ownerPid ? { ownerPid: state.ownerPid } : {}), ...(state.ownerStart ? { ownerStart: state.ownerStart } : {}) });
    }
    return result;
  }
  async trim() {
    // Skip rotation if a writer changed the file while it was being read. Keep
    // the in-memory pending states, rather than dropping older live sessions.
    const before = await fs.stat(this.eventsFile), text = await fs.readFile(this.eventsFile, 'utf8');
    const kept = text.split('\n').slice(-2001).join('\n');
    try {
      await writeAtomic(this.eventsFile, kept, 0o600, () => {
        if (signature(fsSync.statSync(this.eventsFile)) !== signature(before)) throw new Error('events-changed');
      });
      const stat = await fs.stat(this.eventsFile); this.inode = stat.ino; this.offset = stat.size;
    } catch (error) { if (error.message !== 'events-changed') throw error; }
  }
}
// Pure compatibility helper; the reader maintains pending requests separately.
function phaseOf(event, kind, tool, previous) {
  if (event === 'PermissionRequest') return { phase: 'waiting', reason: 'approval' };
  if (event === 'Elicitation' || event === 'PreToolUse' && tool === 'AskUserQuestion') return { phase: 'waiting', reason: 'input' };
  if (event === 'Notification') {
    if (kind === 'permission_prompt') return { phase: 'waiting', reason: 'approval' };
    if (INPUT_NOTIFICATIONS.has(kind)) return { phase: 'waiting', reason: 'input' };
    if (kind === 'idle_prompt' || kind === 'agent_completed') return { phase: 'idle' };
    return typeof previous === 'object' && previous ? { ...previous } : { phase: previous || 'idle' };
  }
  if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'ElicitationResult'].includes(event)) return { phase: 'running' };
  return { phase: 'idle' };
}
module.exports = { ClaudeHooks, EVENTS, SCRIPT_NAME, LOGGER_NAME, EVENTS_NAME, withOurHooks, withoutOurHooks, countOurHooks, phaseOf, scriptSource, hookCommand };
