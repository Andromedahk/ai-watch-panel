'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ClaudeHooks, EVENTS, withOurHooks, withoutOurHooks, countOurHooks, hookCommand } = require('../electron/claude-hooks.cjs');
const { metadata, ancestorInfo, MAX_ANCESTORS } = require('../electron/claude-hook-logger.cjs');

const baseTime = 1700000000000;
const ownerStart = 'Tue Nov 14 22:00:00 2023';
const row = (event, extra = {}) => ({ v: 1, at: baseTime, event, session: 'session-1', ancestors: [22, 33], ownerPid: 33, ownerStart, entry: 'cli', ...extra });
const reader = () => new ClaudeHooks({ settingsFile: '/unused/settings.json', dataDir: '/unused', platform: 'darwin' });
const apply = (hooks, event, extra) => hooks.apply(JSON.stringify(row(event, extra)));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-hook regression-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const settingsFile = path.join(root, 'claude', 'settings.json');
  const hooks = new ClaudeHooks({ settingsFile, dataDir: root, platform: 'darwin' });
  return { root, settingsFile, hooks };
}

test('logger reads only event-specific top-level metadata, never a prompt or tool body', () => {
  const payload = { session_id: 'root-session', agent_id: 'agent-1', tool_name: 'Read', tool_use_id: 'tool-1',
    notification_type: 'permission_prompt', elicitation_id: 'elicit-1', pid: 99999, ownerPid: 99999, ancestors: [99999] };
  for (const key of ['prompt', 'tool_input', 'tool_response', 'last_assistant_message', 'cwd']) {
    Object.defineProperty(payload, key, { enumerable: true, get() { throw new Error(`Accessed private field ${key}`); } });
  }
  assert.deepEqual(metadata(payload, 'PreToolUse', { at: baseTime, entry: 'cli', ancestors: [20, 30], ownerPid: 30 }),
    { v: 1, at: baseTime, event: 'PreToolUse', session: 'root-session', ancestors: [20, 30], ownerPid: 30,
      agent: 'agent-1', entry: 'cli', tool: 'Read', toolUse: 'tool-1' });
  assert.deepEqual(metadata(payload, 'Notification', { at: baseTime, ancestors: [] }),
    { v: 1, at: baseTime, event: 'Notification', session: 'root-session', ancestors: [], agent: 'agent-1', kind: 'permission_prompt' });
  assert.equal(metadata({ tool_input: { session_id: 'nested-session' } }, 'PreToolUse'), null);
  assert.equal(metadata(payload, 'unknown-event'), null);
  assert.equal(metadata({ session_id: 's', notification_type: 'PRIVATE_UNKNOWN_KIND' }, 'Notification').kind, undefined);
});

test('ancestor metadata identifies the nearest Claude owner without retaining executable paths', () => {
  const info = ancestorInfo({ ppid: 101, processList: [
    `101 102 ${ownerStart} /bin/sh`, `102 103 ${ownerStart} /runtime/claude/versions/2.1.0`, `103 104 ${ownerStart} /bin/sh`,
    `104 105 ${ownerStart} /other/claude`, `105 1 ${ownerStart} /private/Terminal.app/Contents/MacOS/Terminal`,
  ].join('\n') });
  assert.deepEqual(info, { ancestors: [101, 102, 103, 104, 105], ownerPid: 102, ownerStart });
  assert.doesNotMatch(JSON.stringify(info), /private|runtime|Terminal|claude/);
  const lines = Array.from({ length: 40 }, (_, i) => `${i + 100} ${i + 101} ${ownerStart} /bin/sh`).join('\n');
  assert.equal(ancestorInfo({ ppid: 100, processList: lines }).ancestors.length, MAX_ANCESTORS);
  assert.deepEqual(ancestorInfo({ ppid: 100, processList: `100 101 ${ownerStart} /bin/sh\n101 100 ${ownerStart} /bin/sh` }), { ancestors: [100, 101] });
});

test('bundled-runtime shell logger is silent, uses system PATH and ignores nested body/PID spoofs', { skip: process.platform === 'win32' }, async t => {
  const { hooks } = await fixture(t); await hooks.install();
  const payload = {
    tool_input: { notification_type: 'PRIVATE_INPUT', session_id: 'PRIVATE_SESSION', tool_name: 'PRIVATE_TOOL' },
    tool_response: { notification_type: 'PRIVATE_RESPONSE' },
    session_id: 'actual-session', tool_name: 'Read', tool_use_id: 'actual-tool',
    pid: 99999, ownerPid: 99999, ancestors: [99999], prompt: 'PRIVATE_PROMPT',
  };
  const output = execFileSync('/bin/sh', ['-c', hookCommand(hooks.scriptFile, 'PreToolUse')], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CLAUDE_CODE_ENTRYPOINT: 'cli' },
  });
  assert.equal(output, '');
  const text = await fs.readFile(hooks.eventsFile, 'utf8');
  assert.doesNotMatch(text, /PRIVATE|99999|tool_input|tool_response|prompt/);
  const event = JSON.parse(text);
  assert.equal(event.session, 'actual-session'); assert.equal(event.tool, 'Read'); assert.equal(event.toolUse, 'actual-tool');
  assert.ok(event.ancestors.includes(process.pid));
  assert.equal((await fs.stat(hooks.eventsFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(hooks.loggerFile)).mode & 0o777, 0o600);
  assert.equal(execFileSync('/bin/sh', [hooks.scriptFile, 'Stop'], { input: '{bad JSON', encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }), '');
  assert.equal(await fs.readFile(hooks.eventsFile, 'utf8'), text);
});

test('a pending main-agent approval survives unrelated and subagent tool completions', () => {
  const hooks = reader();
  apply(hooks, 'PreToolUse', { tool: 'Bash', toolUse: 'bash-1' });
  // PermissionRequest has no tool_use_id in the official protocol.
  apply(hooks, 'PermissionRequest', { tool: 'Bash' });
  apply(hooks, 'PostToolUse', { agent: 'background-agent', tool: 'Read', toolUse: 'read-1', at: baseTime + 1000 });
  apply(hooks, 'PreToolUse', { tool: 'Read', toolUse: 'read-2', at: baseTime + 2000 });
  apply(hooks, 'PostToolUse', { tool: 'Read', toolUse: 'read-2', at: baseTime + 3000 });
  assert.deepEqual(hooks.live(baseTime + 4000)[0], { session: 'session-1', phase: 'waiting', reason: 'approval',
    at: baseTime, surface: 'terminal', ancestors: [22, 33], ownerPid: 33, ownerStart });
  apply(hooks, 'PostToolUse', { tool: 'Bash', toolUse: 'bash-1', at: baseTime + 5000 });
  assert.equal(hooks.live(baseTime + 6000)[0].phase, 'running');
});

test('same-tool calls use call ids and one completion cannot clear another agent or call', () => {
  const hooks = reader();
  apply(hooks, 'PreToolUse', { agent: 'worker-a', tool: 'AskUserQuestion', toolUse: 'ask-a' });
  apply(hooks, 'PreToolUse', { agent: 'worker-b', tool: 'AskUserQuestion', toolUse: 'ask-b' });
  apply(hooks, 'PostToolUse', { agent: 'worker-b', tool: 'AskUserQuestion', toolUse: 'ask-b' });
  apply(hooks, 'PostToolUse', { agent: 'worker-a', tool: 'AskUserQuestion', toolUse: 'different-ask' });
  assert.equal(hooks.live(baseTime)[0].reason, 'input');
  apply(hooks, 'PostToolUse', { agent: 'worker-a', tool: 'AskUserQuestion', toolUse: 'ask-a' });
  assert.equal(hooks.live(baseTime)[0].phase, 'running');
});

test('elicitation responses resolve only the corresponding agent/request, not tool questions', () => {
  const hooks = reader();
  apply(hooks, 'PreToolUse', { tool: 'AskUserQuestion', toolUse: 'ask-1' });
  apply(hooks, 'Elicitation', { agent: 'worker', elicitation: 'request-1' });
  apply(hooks, 'ElicitationResult', { agent: 'worker', elicitation: 'other-request' });
  apply(hooks, 'ElicitationResult', { agent: 'worker', elicitation: 'request-1' });
  assert.equal(hooks.live(baseTime)[0].phase, 'waiting');
  apply(hooks, 'PostToolUseFailure', { tool: 'AskUserQuestion', toolUse: 'ask-1' });
  assert.equal(hooks.live(baseTime)[0].phase, 'running');
  apply(hooks, 'Elicitation', { agent: 'worker' });
  apply(hooks, 'ElicitationResult', { agent: 'worker' });
  assert.equal(hooks.live(baseTime)[0].phase, 'running');
});

test('ordinary and duplicate notifications preserve waiting reason and do not extend its expiry', () => {
  const hooks = reader();
  apply(hooks, 'PermissionRequest', { tool: 'Bash' });
  const before = hooks.live(baseTime)[0];
  apply(hooks, 'Notification', { kind: 'auth_success', at: baseTime + 5 * 3600000, ancestors: [44], ownerPid: 44 });
  assert.deepEqual(hooks.live(baseTime + 5 * 3600000)[0], before);
  apply(hooks, 'Notification', { kind: 'permission_prompt', at: baseTime + 5 * 3600000 });
  assert.equal(hooks.live(baseTime + 5 * 3600000)[0].at, baseTime);
  assert.deepEqual(hooks.live(baseTime + 6 * 3600000 + 1), []);
});

test('turn boundaries clear their own pending state while other agents remain pending', () => {
  const hooks = reader();
  apply(hooks, 'PermissionRequest', { tool: 'Bash' });
  apply(hooks, 'Elicitation', { agent: 'worker', elicitation: 'request' });
  assert.equal(hooks.live(baseTime)[0].reason, 'both');
  apply(hooks, 'Stop');
  assert.equal(hooks.live(baseTime)[0].reason, 'input');
  apply(hooks, 'SubagentStop', { agent: 'worker' });
  assert.equal(hooks.live(baseTime)[0].phase, 'idle');
  apply(hooks, 'SessionEnd');
  assert.deepEqual(hooks.live(baseTime), []);
});

test('legacy lines and malformed process metadata cannot become trusted hook state', () => {
  const hooks = reader();
  hooks.apply(`${baseTime / 1000}\tPermissionRequest\told-session\t\tBash\tcli`);
  hooks.apply(JSON.stringify(row('PermissionRequest', { ownerPid: 99999 })));
  hooks.apply(JSON.stringify(row('PermissionRequest', { ancestors: ['33'] })));
  assert.deepEqual(hooks.live(baseTime), []);
  apply(hooks, 'PermissionRequest', { tool: 'Bash' });
  assert.equal(hooks.live(baseTime)[0].ownerPid, 33);
});

test('only exact owned commands in the scoped script location are replaced or removed', () => {
  const script = '/data/ai-watch-claude-hook.sh';
  const otherScript = '/somewhere-else/ai-watch-claude-hook.sh';
  const userHooks = [
    { type: 'command', command: 'echo audit-ai-watch-claude-hook.sh' },
    { type: 'command', command: hookCommand(otherScript, 'Stop') },
    { type: 'command', command: `${hookCommand(script, 'Stop')} && echo keep-user-wrapper` },
  ];
  const settings = { model: 'keep', hooks: { Stop: [{ hooks: userHooks }] } };
  const installed = withOurHooks(settings, script);
  assert.equal(countOurHooks(installed, script), EVENTS.length);
  assert.deepEqual(withoutOurHooks(installed, script), settings);
  assert.deepEqual(withoutOurHooks(settings, script), settings);
  const legacy = { hooks: { Stop: [{ hooks: [{ type: 'command', command: hookCommand(script, 'Stop').split(' # ')[0] }] }] } };
  assert.deepEqual(withoutOurHooks(legacy, script), {});
});

test('install refuses a concurrent user settings update rather than overwriting it', { skip: process.platform === 'win32' }, async t => {
  const { settingsFile, hooks } = await fixture(t);
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(settingsFile, JSON.stringify({ model: 'old', permissions: { allow: ['Read'] } }));
  const next = JSON.stringify({ model: 'user-new', permissions: { allow: ['Read', 'Bash'] }, newUserSetting: true });
  const rename = fsSync.renameSync;
  fsSync.renameSync = (source, target) => {
    rename(source, target);
    if (target === hooks.scriptFile) fsSync.writeFileSync(settingsFile, next);
  };
  try { await assert.rejects(hooks.install(), /settings-changed/); }
  finally { fsSync.renameSync = rename; }
  assert.equal(await fs.readFile(settingsFile, 'utf8'), next);
  assert.equal(hooks.enabled, false);
  assert.deepEqual((await fs.readdir(path.dirname(settingsFile))).filter(name => name.endsWith('.tmp')), []);
});

test('uninstall refuses a settings update during staging and leaves user changes intact', { skip: process.platform === 'win32' }, async t => {
  const { settingsFile, hooks } = await fixture(t); await hooks.install();
  const next = `${JSON.stringify({ ...JSON.parse(await fs.readFile(settingsFile, 'utf8')), newUserSetting: true })}\n`;
  const writeFile = fs.writeFile;
  fs.writeFile = async (target, ...args) => {
    const result = await writeFile(target, ...args);
    if (path.dirname(target) === path.dirname(settingsFile) && path.basename(target).endsWith('.tmp')) await writeFile(settingsFile, next);
    return result;
  };
  try { await assert.rejects(hooks.uninstall(), /settings-changed/); }
  finally { fs.writeFile = writeFile; }
  assert.equal(await fs.readFile(settingsFile, 'utf8'), next);
  assert.equal(hooks.enabled, false);
  await assert.rejects(fs.stat(hooks.scriptFile), { code: 'ENOENT' });
});

test('malformed hooks schema and symlinked user settings are not rewritten', { skip: process.platform === 'win32' }, async t => {
  const { root, settingsFile, hooks } = await fixture(t);
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  const malformed = '{"hooks":{"Stop":{"hooks":[]}},"model":"keep"}';
  await fs.writeFile(settingsFile, malformed);
  await assert.rejects(hooks.install(), /settings-invalid/);
  assert.equal(await fs.readFile(settingsFile, 'utf8'), malformed);
  await fs.unlink(settingsFile);
  const actual = path.join(root, 'managed-settings.json'); await fs.writeFile(actual, '{"model":"keep"}');
  await fs.symlink(actual, settingsFile);
  await assert.rejects(hooks.install(), /settings-unreadable/);
  assert.equal((await fs.lstat(settingsFile)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(actual, 'utf8'), '{"model":"keep"}');
});

test('a child-agent event cannot replace the live main-session owner of an approval', () => {
  const hooks = reader();
  apply(hooks, 'PermissionRequest', { tool: 'Bash', ancestors: [11], ownerPid: 11, entry: 'claude-desktop' });
  apply(hooks, 'PostToolUse', { agent: 'child', tool: 'Read', toolUse: 'read-1', ancestors: [22, 11], ownerPid: 22, at: baseTime + 1000 });
  const state = hooks.live(baseTime + 1000)[0];
  assert.equal(state.phase, 'waiting'); assert.equal(state.surface, 'desktop'); assert.equal(state.ownerPid, 11); assert.equal(state.ownerStart, ownerStart);
  assert.deepEqual(state.ancestors, [11]);
});

test('real macOS process ancestry binds the shell and Electron logger to a controlled Claude-named owner', { skip: process.platform !== 'darwin' }, async t => {
  const { root, settingsFile } = await fixture(t);
  const ownerExecutable = path.join(root, 'bin', 'claude');
  await fs.mkdir(path.dirname(ownerExecutable));
  // Use an independent copy: chmod on a hard link would change the host runtime.
  await fs.copyFile(process.execPath, ownerExecutable, fsSync.constants.COPYFILE_FICLONE);
  await fs.chmod(ownerExecutable, 0o700);
  const hooks = new ClaudeHooks({ settingsFile, dataDir: root, runtime: require('electron') });
  await hooks.install();
  const runner = path.join(root, 'controlled-owner.cjs');
  await fs.writeFile(runner, `const { execFileSync } = require('node:child_process');\nexecFileSync('/bin/sh', [process.argv[2], 'PermissionRequest'], { input: JSON.stringify({ session_id: 'controlled-session', tool_name: 'Bash', ownerPid: 99999, pid: 99999 }), env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CLAUDE_CODE_ENTRYPOINT: 'cli' } });\nprocess.stdout.write(JSON.stringify({ pid: process.pid }));\n`);
  const child = JSON.parse(execFileSync(ownerExecutable, [runner, hooks.scriptFile], { encoding: 'utf8', timeout: 5000 }));
  const event = JSON.parse((await fs.readFile(hooks.eventsFile, 'utf8')).trim());
  assert.equal(event.ownerPid, child.pid);
  assert.ok(event.ancestors.includes(child.pid));
  assert.match(event.ownerStart, /^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
  assert.equal(event.session, 'controlled-session');
  assert.doesNotMatch(JSON.stringify(event), /99999|controlled-owner|private|tool_input/);
});

test('an untargeted background completion notification cannot clear root approval or refresh it', () => {
  const hooks = reader();
  apply(hooks, 'PermissionRequest', { tool: 'Bash' });
  const before = hooks.live(baseTime)[0];
  apply(hooks, 'Notification', { kind: 'agent_completed', at: baseTime + 1000, ancestors: [44], ownerPid: 44 });
  assert.deepEqual(hooks.live(baseTime + 1000)[0], before);
  apply(hooks, 'PermissionRequest', { agent: 'worker', tool: 'Edit' });
  apply(hooks, 'Notification', { kind: 'agent_completed', agent: 'worker', at: baseTime + 2000 });
  assert.equal(hooks.live(baseTime + 2000)[0].phase, 'waiting');
  assert.equal(hooks.live(baseTime + 2000)[0].reason, 'approval');
});

test('an unassigned background input notification is independent of the root tool and root stop', () => {
  const hooks = reader();
  apply(hooks, 'PreToolUse', { tool: 'Read', toolUse: 'read-1' });
  apply(hooks, 'Notification', { kind: 'agent_needs_input' });
  apply(hooks, 'PostToolUse', { tool: 'Read', toolUse: 'read-1', at: baseTime + 1000 });
  assert.equal(hooks.live(baseTime + 1000)[0].reason, 'input');
  apply(hooks, 'Stop', { at: baseTime + 2000 });
  assert.equal(hooks.live(baseTime + 2000)[0].reason, 'input');
  apply(hooks, 'SessionEnd', { at: baseTime + 3000 });
  assert.deepEqual(hooks.live(baseTime + 3000), []);
});

test('an ambiguous no-id permission waits until all possible same-tool calls complete', () => {
  const hooks = reader();
  apply(hooks, 'PreToolUse', { tool: 'Bash', toolUse: 'bash-1' });
  apply(hooks, 'PreToolUse', { tool: 'Bash', toolUse: 'bash-2' });
  apply(hooks, 'PermissionRequest', { tool: 'Bash' });
  apply(hooks, 'PostToolUse', { tool: 'Bash', toolUse: 'bash-2', at: baseTime + 1000 });
  assert.equal(hooks.live(baseTime + 1000)[0].reason, 'approval');
  apply(hooks, 'PostToolUse', { tool: 'Bash', toolUse: 'bash-1', at: baseTime + 2000 });
  assert.equal(hooks.live(baseTime + 2000)[0].phase, 'running');
});
