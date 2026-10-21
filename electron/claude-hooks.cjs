'use strict';
// Claude Code status hooks.
//
// When the user turns this on, AI Watch registers one small shell script in the
// user-level Claude Code settings. Claude Code runs it at lifecycle events
// (prompt submitted, tool used, permission requested, notification, stop, ...)
// in the terminal, IDE and Desktop "Code" sessions alike. The script appends a
// single line per event to a private file in AI Watch's own data folder:
//
//   <unix seconds> \t <event> \t <session id> \t <notification type> \t <tool name> \t <entrypoint>
//
// It never records prompts, replies, file paths or tool input, prints nothing
// (so it cannot add context or make permission decisions) and always exits 0.
// This gives an exact running / waiting-for-approval / waiting-for-answer state
// for Claude Code without the macOS accessibility permission.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const SCRIPT_NAME = 'ai-watch-claude-hook.sh';
const EVENTS_NAME = 'claude-hook-events.log';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'Notification', 'Elicitation', 'ElicitationResult', 'Stop', 'StopFailure', 'SessionEnd'];
const DESKTOP_ENTRYPOINTS = new Set(['claude-desktop', 'claude-desktop-3p', 'local-agent']);
const INPUT_NOTIFICATIONS = new Set(['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const QUESTION_TOOLS = new Set(['AskUserQuestion']);
const RUNNING_MS = 10 * 60 * 1000; // a running turn with no event for 10 min is no longer trusted
const WAITING_MS = 6 * 60 * 60 * 1000; // an unanswered prompt stays visible for up to 6 h
const READ_BYTES = 256 * 1024; const TRIM_BYTES = 512 * 1024;

const shellQuote = value => `"${String(value).replace(/["\\$`]/g, '\\$&')}"`;

function scriptSource(eventsFile) {
  return `#!/bin/sh
# AI Watch · Claude Code status hook (registered from AI Watch settings; turn it off there to remove).
# Records only: time, event, session id, notification type, tool name, entrypoint. Prints nothing, always exits 0.
umask 077
out=${shellQuote(eventsFile)}
event=$(printf '%s' "$1" | tr -cd 'A-Za-z')
payload=$(head -c 65536 | tr -d '\\n\\r')
field() { printf '%s' "$payload" | grep -o "\\"$1\\"[[:space:]]*:[[:space:]]*\\"[A-Za-z0-9_.:-]\\{1,128\\}\\"" | head -n 1 | sed 's/.*:[[:space:]]*"\\(.*\\)"$/\\1/'; }
sid=$(field session_id); kind=$(field notification_type); tool=$(field tool_name)
entry=$(printf '%s' "\${CLAUDE_CODE_ENTRYPOINT:-}" | tr -cd 'A-Za-z0-9_.-' | cut -c1-40)
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(date +%s)" "$event" "$sid" "$kind" "$tool" "$entry" >> "$out" 2>/dev/null
exit 0
`;
}

function hookCommand(scriptFile, event) {
  const quoted = shellQuote(scriptFile);
  return `test -f ${quoted} && /bin/sh ${quoted} ${event} || true`;
}
const isOurs = hook => typeof hook?.command === 'string' && hook.command.includes(SCRIPT_NAME);

/** Remove AI Watch entries from a parsed settings object (pure). */
function withoutOurHooks(settings) {
  const next = { ...settings };
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) return next;
  const hooks = {};
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = groups.map(group => Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter(hook => !isOurs(hook)) } : group)
      .filter(group => !Array.isArray(group?.hooks) || group.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
  return next;
}
/** Add AI Watch entries for every event, keeping the user's own hooks untouched (pure). */
function withOurHooks(settings, scriptFile) {
  const next = withoutOurHooks(settings);
  const hooks = { ...(next.hooks || {}) };
  for (const event of EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...groups, { hooks: [{ type: 'command', command: hookCommand(scriptFile, event), timeout: 5 }] }];
  }
  return { ...next, hooks };
}
function countOurHooks(settings) {
  if (!settings?.hooks || typeof settings.hooks !== 'object') return 0;
  return Object.values(settings.hooks).flat().reduce((total, group) => total + (Array.isArray(group?.hooks) ? group.hooks.filter(isOurs).length : 0), 0);
}

async function readSettings(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { settings: {}, exists: false }; throw error; }
  if (!text.trim()) return { settings: {}, exists: true };
  const settings = JSON.parse(text); // malformed user settings are never rewritten
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new SyntaxError('Settings must be an object');
  return { settings, exists: true };
}
async function writeAtomic(file, text, mode) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporary, text, { mode, flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}

class ClaudeHooks {
  /** @param {{ settingsFile: string, dataDir: string, platform?: string }} options */
  constructor({ settingsFile, dataDir, platform = process.platform }) {
    this.settingsFile = settingsFile; this.platform = platform;
    this.scriptFile = path.join(dataDir, SCRIPT_NAME); this.eventsFile = path.join(dataDir, EVENTS_NAME);
    this.sessions = new Map(); this.offset = 0; this.inode = null; this.enabled = false;
  }
  get supported() { return this.platform !== 'win32'; }

  async status() {
    if (!this.supported) return { supported: false, installed: false };
    try { return { supported: true, installed: countOurHooks((await readSettings(this.settingsFile)).settings) === EVENTS.length }; }
    catch { return { supported: true, installed: false, error: 'settings-unreadable' }; }
  }
  async install() {
    if (!this.supported) throw new Error('unsupported-platform');
    let current;
    try { current = await readSettings(this.settingsFile); }
    catch (error) { const failure = new Error(error instanceof SyntaxError ? 'settings-invalid' : 'settings-unreadable'); failure.cause = error; throw failure; }
    await writeAtomic(this.scriptFile, scriptSource(this.eventsFile), 0o700);
    await fs.chmod(this.scriptFile, 0o700);
    await fs.mkdir(path.dirname(this.settingsFile), { recursive: true, mode: 0o700 });
    const mode = current.exists ? (await fs.stat(this.settingsFile)).mode & 0o777 : 0o600;
    await writeAtomic(this.settingsFile, `${JSON.stringify(withOurHooks(current.settings, this.scriptFile), null, 2)}\n`, mode);
    this.enabled = true;
  }
  async uninstall() {
    this.enabled = false; this.sessions.clear(); this.offset = 0; this.inode = null;
    if (!this.supported) return;
    let current;
    try { current = await readSettings(this.settingsFile); } catch { current = null; }
    if (current?.exists && countOurHooks(current.settings)) {
      const mode = (await fs.stat(this.settingsFile)).mode & 0o777;
      await writeAtomic(this.settingsFile, `${JSON.stringify(withoutOurHooks(current.settings), null, 2)}\n`, mode);
    }
    await fs.unlink(this.scriptFile).catch(() => {});
    await fs.unlink(this.eventsFile).catch(() => {});
  }

  /** Read new event lines and return the live per-session states. */
  async read(now = Date.now()) {
    if (!this.enabled) return [];
    try {
      const stat = await fs.stat(this.eventsFile);
      if (this.inode !== stat.ino || stat.size < this.offset) { this.inode = stat.ino; this.offset = 0; this.sessions.clear(); }
      if (stat.size > this.offset) {
        // Only the newest READ_BYTES matter; a start inside a line drops that partial line.
        const start = Math.max(this.offset, stat.size - READ_BYTES), length = stat.size - start;
        const buffer = Buffer.alloc(length); const handle = await fs.open(this.eventsFile, 'r');
        try { await handle.read(buffer, 0, length, start); } finally { await handle.close(); }
        let text = buffer.toString('utf8');
        if (start > this.offset) text = text.slice(text.indexOf('\n') + 1);
        const complete = text.lastIndexOf('\n');
        if (complete >= 0) this.apply(text.slice(0, complete));
        this.offset = complete >= 0 ? stat.size - (text.length - complete - 1) : start > this.offset ? start : this.offset;
      }
      if (stat.size > TRIM_BYTES) await this.trim();
    } catch (error) { if (error.code !== 'ENOENT') return null; }
    return this.live(now);
  }
  apply(text) {
    for (const line of text.split('\n')) {
      const [seconds, event, session, kind, tool, entry] = line.split('\t');
      const at = Number(seconds) * 1000;
      if (!Number.isFinite(at) || !EVENTS.includes(event) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(session || '')) continue;
      if (event === 'SessionEnd') { this.sessions.delete(session); continue; }
      const previous = this.sessions.get(session);
      const phase = phaseOf(event, kind, tool, previous?.phase);
      this.sessions.set(session, { session, phase: phase.phase, reason: phase.reason, at,
        surface: DESKTOP_ENTRYPOINTS.has(entry) ? 'desktop' : entry ? 'terminal' : previous?.surface || 'terminal' });
      if (this.sessions.size > 64) this.sessions.delete(this.sessions.keys().next().value);
    }
  }
  live(now) {
    return [...this.sessions.values()].filter(s => s.at <= now + 120000 && (s.phase === 'running' ? now - s.at <= RUNNING_MS : s.phase === 'waiting' ? now - s.at <= WAITING_MS : true));
  }
  async trim() {
    // Keep the most recent lines; the hook keeps appending to the same path.
    const text = await fs.readFile(this.eventsFile, 'utf8');
    const lines = text.split('\n'); const kept = lines.slice(-2001).join('\n');
    await writeAtomic(this.eventsFile, kept, 0o600);
    this.offset = 0; this.inode = null;
  }
}
function phaseOf(event, kind, tool, previous) {
  if (event === 'PermissionRequest') return { phase: 'waiting', reason: 'approval' };
  if (event === 'Elicitation') return { phase: 'waiting', reason: 'input' };
  if (event === 'PreToolUse' && QUESTION_TOOLS.has(tool)) return { phase: 'waiting', reason: 'input' };
  if (event === 'Notification') {
    if (kind === 'permission_prompt') return { phase: 'waiting', reason: 'approval' };
    if (INPUT_NOTIFICATIONS.has(kind)) return { phase: 'waiting', reason: 'input' };
    if (kind === 'idle_prompt' || kind === 'agent_completed') return { phase: 'idle' };
    return { phase: previous || 'idle' }; // other notifications carry no state
  }
  if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'ElicitationResult'].includes(event)) return { phase: 'running' };
  return { phase: 'idle' }; // SessionStart, Stop, StopFailure
}

module.exports = { ClaudeHooks, EVENTS, SCRIPT_NAME, EVENTS_NAME, withOurHooks, withoutOurHooks, countOurHooks, phaseOf, scriptSource, hookCommand };
