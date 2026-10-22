'use strict';
// Runs with the app's own Node/Electron runtime. Only explicitly named top-level
// lifecycle metadata leaves this process; prompts and tool bodies are never accessed.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const MAX_PAYLOAD = 4 * 1024 * 1024;
const MAX_ANCESTORS = 24;
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Elicitation', 'ElicitationResult', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStop']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
const NOTIFICATION_TYPES = new Set(['permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog',
  'elicitation_url_dialog', 'elicitation_complete', 'elicitation_response', 'agent_needs_input', 'agent_completed',
  'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled', 'plugin_notification']);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,128}$/.test(value) ? value : undefined;
const field = (object, key) => Object.hasOwn(object, key) ? token(object[key]) : undefined;

function ancestorInfo({ ppid = process.ppid, processList } = {}) {
  // Executable names are used transiently to identify the nearest Claude owner.
  // Never retain/log names, arguments, working directories or bodies.
  const text = processList === undefined ? execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,lstart=,comm='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 1000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  }) : processList;
  const parents = new Map();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(line);
    if (match) parents.set(Number(match[1]), { ppid: Number(match[2]), claude: isClaudeCommand(match[4]), start: match[3].replace(/\s+/g, ' ') });
  }
  const ancestors = [], seen = new Set(); let ownerPid, ownerStart;
  for (let pid = ppid; Number.isSafeInteger(pid) && pid > 1 && !seen.has(pid) && ancestors.length < MAX_ANCESTORS; pid = parents.get(pid)?.ppid) {
    seen.add(pid); ancestors.push(pid);
    if (ownerPid === undefined && parents.get(pid)?.claude) { ownerPid = pid; ownerStart = parents.get(pid).start; }
  }
  return { ancestors, ...(ownerPid ? { ownerPid, ownerStart } : {}) };
}
function isClaudeCommand(command) {
  return /(?:^|[/\\])claude(?:\.exe)?$/.test(command)
    || /[/\\]claude[/\\]versions[/\\]\d+\.\d+\.\d+(?:\.exe)?$/.test(command);
}
function ancestorPids(options) { return ancestorInfo(options).ancestors; }

function metadata(payload, event, { at = Date.now(), entry = process.env.CLAUDE_CODE_ENTRYPOINT, ancestors = [], ownerPid, ownerStart } = {}) {
  if (!EVENTS.has(event) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const session = field(payload, 'session_id');
  if (!session) return null;
  const row = { v: 1, at, event, session, ancestors };
  if (Number.isSafeInteger(ownerPid) && ownerPid > 1 && ancestors.includes(ownerPid)) {
    row.ownerPid = ownerPid;
    if (typeof ownerStart === 'string' && /^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(ownerStart)) row.ownerStart = ownerStart;
  }
  const agent = field(payload, 'agent_id');
  if (agent) row.agent = agent;
  const safeEntry = token(entry);
  if (safeEntry) row.entry = safeEntry;
  if (TOOL_EVENTS.has(event)) {
    const tool = field(payload, 'tool_name'), toolUse = field(payload, 'tool_use_id');
    if (tool) row.tool = tool;
    if (toolUse) row.toolUse = toolUse;
  }
  if (event === 'Notification') {
    const kind = field(payload, 'notification_type');
    if (NOTIFICATION_TYPES.has(kind)) row.kind = kind;
  }
  if (event === 'Elicitation' || event === 'ElicitationResult') {
    const elicitation = field(payload, 'elicitation_id');
    if (elicitation) row.elicitation = elicitation;
  }
  return row;
}

async function main() {
  const [file, event] = process.argv.slice(2);
  if (!file || !path.isAbsolute(file) || !EVENTS.has(event)) return;
  const chunks = []; let bytes = 0;
  // Drain oversized input without retaining it, so a large tool result cannot
  // break the caller's stdin writer or cause unbounded memory use.
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes <= MAX_PAYLOAD) chunks.push(chunk);
  }
  if (bytes > MAX_PAYLOAD) return;
  let identity;
  try { identity = ancestorInfo(); } catch { identity = { ancestors: [] }; }
  const row = metadata(JSON.parse(Buffer.concat(chunks).toString('utf8')), event, identity);
  if (!row) return;
  // O_NOFOLLOW avoids following an unexpected file in the private data folder.
  const handle = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.fchmodSync(handle, 0o600); fs.writeSync(handle, `${JSON.stringify(row)}\n`); }
  finally { fs.closeSync(handle); }
}

if (require.main === module) main().catch(() => {}); // no output, no permission decisions, always exit successfully
module.exports = { metadata, ancestorInfo, ancestorPids, MAX_PAYLOAD, MAX_ANCESTORS };
