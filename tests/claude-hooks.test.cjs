const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { ClaudeHooks, EVENTS, withOurHooks, withoutOurHooks, countOurHooks, phaseOf } = require('../electron/claude-hooks.cjs');
const { ClaudeStatusReader } = require('../electron/claude-status.cjs');

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch hooks-'));
const userHook = { type: 'command', command: 'echo user-owned' };

test('hook registration merges with, and is removed without touching, the user\'s own hooks', () => {
  const settings = { model: 'opus', hooks: { Stop: [{ hooks: [userHook] }], PreToolUse: [{ matcher: 'Bash', hooks: [userHook] }] } };
  const added = withOurHooks(settings, '/data/ai-watch-claude-hook.sh');
  assert.equal(countOurHooks(added, '/data/ai-watch-claude-hook.sh'), EVENTS.length);
  assert.deepEqual(added.hooks.Stop[0], { hooks: [userHook] });
  assert.deepEqual(added.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [userHook] });
  assert.equal(added.model, 'opus');
  // Registering twice never duplicates entries.
  assert.equal(countOurHooks(withOurHooks(added, '/data/ai-watch-claude-hook.sh'), '/data/ai-watch-claude-hook.sh'), EVENTS.length);
  assert.deepEqual(withoutOurHooks(added, '/data/ai-watch-claude-hook.sh'), settings);
  assert.deepEqual(withoutOurHooks(withOurHooks({}, '/x/ai-watch-claude-hook.sh'), '/x/ai-watch-claude-hook.sh'), {});
});

test('lifecycle events map to running, approval, question and idle states', () => {
  assert.deepEqual(phaseOf('UserPromptSubmit'), { phase: 'running' });
  assert.deepEqual(phaseOf('PermissionRequest'), { phase: 'waiting', reason: 'approval' });
  assert.deepEqual(phaseOf('Notification', 'permission_prompt'), { phase: 'waiting', reason: 'approval' });
  assert.deepEqual(phaseOf('Notification', 'elicitation_dialog'), { phase: 'waiting', reason: 'input' });
  assert.deepEqual(phaseOf('PreToolUse', '', 'AskUserQuestion'), { phase: 'waiting', reason: 'input' });
  assert.deepEqual(phaseOf('PreToolUse', '', 'Bash'), { phase: 'running' });
  assert.deepEqual(phaseOf('Notification', 'idle_prompt'), { phase: 'idle' });
  assert.deepEqual(phaseOf('Notification', 'auth_success', '', 'running'), { phase: 'running' });
  assert.deepEqual(phaseOf('Stop'), { phase: 'idle' });
});

test('install and uninstall keep user settings, refuse malformed files and use private modes', async t => {
  if (process.platform === 'win32') return t.skip('POSIX shell hook');
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsFile = path.join(dir, 'claude', 'settings.json'), data = path.join(dir, 'data');
  await fs.mkdir(path.dirname(settingsFile)); await fs.mkdir(data);
  await fs.writeFile(settingsFile, JSON.stringify({ env: { KEEP: '1' }, hooks: { Stop: [{ hooks: [userHook] }] } }), { mode: 0o640 });
  const hooks = new ClaudeHooks({ settingsFile, dataDir: data, platform: 'darwin' });
  await hooks.install();
  assert.deepEqual(await hooks.status(), { supported: true, installed: true });
  const installed = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(installed.env.KEEP, '1');
  assert.equal((await fs.stat(settingsFile)).mode & 0o777, 0o640);
  assert.equal((await fs.stat(hooks.scriptFile)).mode & 0o777, 0o700);
  await hooks.uninstall();
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, 'utf8')), { env: { KEEP: '1' }, hooks: { Stop: [{ hooks: [userHook] }] } });
  await assert.rejects(fs.stat(hooks.scriptFile));
  await fs.writeFile(settingsFile, '{ broken');
  await assert.rejects(hooks.install(), /settings-invalid/);
  assert.equal(await fs.readFile(settingsFile, 'utf8'), '{ broken');
  // A missing settings file is created with private permissions.
  const fresh = new ClaudeHooks({ settingsFile: path.join(dir, 'new', 'settings.json'), dataDir: data, platform: 'darwin' });
  await fresh.install();
  assert.equal((await fs.stat(fresh.settingsFile)).mode & 0o777, 0o600);
  await assert.rejects(new ClaudeHooks({ settingsFile, dataDir: data, platform: 'win32' }).install(), /unsupported-platform/);
});

test('the shell hook records only event metadata, prints nothing and never fails', async t => {
  if (process.platform === 'win32') return t.skip('POSIX shell hook');
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const hooks = new ClaudeHooks({ settingsFile: path.join(dir, 'settings.json'), dataDir: dir, platform: 'darwin' });
  await hooks.install();
  const settings = JSON.parse(await fs.readFile(hooks.settingsFile, 'utf8'));
  const run = (event, payload, env = {}) => execFileSync('/bin/sh', ['-c', settings.hooks[event].at(-1).hooks[0].command],
    { input: JSON.stringify(payload, null, 1), env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...env } }).toString();
  assert.equal(run('UserPromptSubmit', { session_id: 'abc-1', prompt: 'PRIVATE_PROMPT "session_id": "evil"', cwd: '/PRIVATE_PATH' }, { CLAUDE_CODE_ENTRYPOINT: 'cli' }), '');
  run('PreToolUse', { session_id: 'abc-1', tool_name: 'Bash', tool_input: { command: 'PRIVATE_COMMAND', session_id: 'nested-id', tool_name: 'nested' } });
  run('Notification', { session_id: 'abc-1', notification_type: 'permission_prompt', message: 'PRIVATE_MESSAGE' });
  run('PermissionRequest', { session_id: 'desk-2', tool_name: 'Edit' }, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' });
  run('Stop', { session_id: 'old-3', last_assistant_message: 'PRIVATE_REPLY' });
  const log = await fs.readFile(hooks.eventsFile, 'utf8');
  assert.doesNotMatch(log, /PRIVATE|evil/);
  const records = log.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(records.every(row => row.v === 1 && Array.isArray(row.ancestors)
    && row.ancestors.length <= 24 && row.ancestors.every(pid => Number.isInteger(pid) && pid > 0)));
  assert.ok(records.every(row => row.ancestors.includes(process.pid)), 'The native ps ancestor chain must include this real test process');
  assert.equal((await fs.stat(hooks.eventsFile)).mode & 0o777, 0o600);
  const states = await hooks.read(Date.now());
  assert.deepEqual(states.map(({ session, phase, reason, surface }) => ({ session, phase, reason, surface })).sort((a, b) => a.session.localeCompare(b.session)), [
    { session: 'abc-1', phase: 'waiting', reason: 'approval', surface: 'terminal' },
    { session: 'desk-2', phase: 'waiting', reason: 'approval', surface: 'desktop' },
    { session: 'old-3', phase: 'idle', reason: undefined, surface: 'terminal' },
  ]);
  run('PostToolUse', { session_id: 'abc-1', tool_name: 'Bash' }); run('SessionEnd', { session_id: 'old-3' });
  assert.deepEqual((await hooks.read(Date.now())).map(s => `${s.session}:${s.phase}`).sort(), ['abc-1:running', 'desk-2:waiting']);
  // Removing the script leaves registered commands harmless.
  await fs.unlink(hooks.scriptFile);
  assert.equal(run('Stop', { session_id: 'abc-1' }), '');
  // Stale running turns expire; unanswered prompts stay visible longer.
  assert.deepEqual((await hooks.read(Date.now() + 11 * 60000)).map(s => `${s.session}:${s.phase}`), ['desk-2:waiting']);
});

test('Claude status uses hook states only while a Claude Code process is alive', async t => {
  const home = await temp(); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const at = Date.now();
  const sessions = path.join(home, '.claude', 'sessions'); await fs.mkdir(sessions, { recursive: true });
  for (const [pid, sessionId, entrypoint] of [[40, 's1', 'cli'], [41, 's2', 'cli'], [42, 's3', 'claude-desktop']]) {
    await fs.writeFile(path.join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId, entrypoint, status: 'idle' }));
  }
  const fake = { enabled: true, read: async () => [
    { session: 's1', phase: 'waiting', reason: 'approval', surface: 'terminal', ancestors: [40], ownerPid: 40, ownerStart: 'Thu Oct 22 00:00:00 2026', at },
    { session: 's2', phase: 'running', surface: 'terminal', ancestors: [41], ownerPid: 41, ownerStart: 'Thu Oct 22 00:00:00 2026', at },
    { session: 's3', phase: 'waiting', reason: 'input', surface: 'desktop', ancestors: [42], ownerPid: 42, ownerStart: 'Thu Oct 22 00:00:00 2026', at }] };
  const reader = new ClaudeStatusReader({ home, env: {}, platform: 'linux', source: 'code', hooks: fake,
    ownerStartsReader: async pids => new Map(pids.map(pid => [pid, 'Thu Oct 22 00:00:00 2026'])),
    usageReader: { poll: async () => ({ state: 'disabled' }), clearSource() {} } });
  const alive = await reader.poll([40, 41, 42].map(pid => ({ pid, command: '/fixture/claude' })), at);
  assert.equal(alive.activity, 'waiting');
  assert.equal(alive.waitingReason, 'approval');
  assert.equal(alive.activeTasks, 1);
  assert.equal(alive.task, 'Claude 在等你授权工具');
  assert.equal(alive.activityHooks, true);
  const gone = await reader.poll([], at);
  assert.equal(gone.activity, 'offline');
  assert.equal(gone.waitingTasks, 0);
});
