const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ClaudeStatusReader, readOwnerStarts } = require('../electron/claude-status.cjs');

const codeProcesses = (...pids) => pids.map(pid => ({ pid, command: '/fixture/claude' }));
async function fixture(t, registrations = [], source = 'code', desktopActivity = { activity: 'idle', trusted: true, supported: true }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-hook-status-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'sessions'); await fs.mkdir(dir, { recursive: true });
  const at = Date.now();
  for (const row of registrations) {
    await fs.writeFile(path.join(dir, `${row.pid}.json`), JSON.stringify({ status: 'idle', entrypoint: 'cli', ...row }));
  }
  const hooks = { enabled: true, rows: [], async read() { return this.rows; } };
  const ownerStart = 'Thu Oct 22 00:00:00 2026';
  const identities = { start: ownerStart, requests: [], fail: false };
  const ownerStartsReader = async pids => {
    identities.requests.push(pids);
    if (identities.fail) throw new Error('synthetic ps failure');
    return new Map(pids.map(pid => [pid, identities.start]));
  };
  const reader = new ClaudeStatusReader({ home, env: {}, platform: 'linux', source, hooks, ownerStartsReader,
    desktopActivityReader: async () => desktopActivity,
    usageReader: { poll: async () => ({ state: 'disabled' }), clearSource() {} } });
  const hook = (session, pid, phase, reason, surface = 'terminal', extra = {}) => ({ session, ancestors: [pid], ownerPid: pid, ownerStart, phase, reason, surface, at, ...extra });
  return { reader, hooks, hook, at, identities };
}

test('a dead hook session cannot become waiting because another Claude Code session is alive', async t => {
  const { reader, hooks, hook, at } = await fixture(t, [{ pid: 22, sessionId: 'live' }]);
  hooks.rows = [hook('dead', 11, 'waiting', 'approval')];
  const result = await reader.poll(codeProcesses(22), at);
  assert.equal(result.activity, 'idle'); assert.equal(result.waitingTasks, 0); assert.equal(result.activeTasks, 0);
  // A legacy or otherwise unbound hook cannot use an unrelated live CLI as evidence.
  hooks.rows = [hook('live', 22, 'waiting', 'input', 'terminal', { ancestors: [] })];
  assert.equal((await reader.poll(codeProcesses(22), at)).waitingTasks, 0);
});

test('a reused live PID must match the hook session ID from its current registration', async t => {
  const { reader, hooks, hook, at } = await fixture(t, [{ pid: 22, sessionId: 'new' }]);
  hooks.rows = [hook('old', 22, 'waiting', 'approval')];
  assert.equal((await reader.poll(codeProcesses(22), at)).waitingTasks, 0);
  hooks.rows = [hook('new', 22, 'waiting', 'approval')];
  const accepted = await reader.poll(codeProcesses(22), at);
  assert.equal(accepted.waitingTasks, 1); assert.equal(accepted.waitingReason, 'approval');
});

test('the captured Claude Code owner must match its registration, never a more distant parent session', async t => {
  const { reader, hooks, hook, at } = await fixture(t, [{ pid: 22, sessionId: 'parent' }, { pid: 33, sessionId: 'child' }]);
  hooks.rows = [hook('parent', 33, 'waiting', 'approval', 'terminal', { ancestors: [900, 33, 22] })];
  assert.equal((await reader.poll(codeProcesses(22, 33), at)).waitingTasks, 0);
  hooks.rows = [hook('child', 33, 'waiting', 'input', 'terminal', { ancestors: [900, 33, 22] })];
  assert.equal((await reader.poll(codeProcesses(22, 33), at)).waitingTasks, 1);
});

test('an exited nested owner cannot fall back to its unregistered live Claude parent', async t => {
  const { reader, hooks, hook, at } = await fixture(t);
  hooks.rows = [hook('exited-child', 33, 'waiting', 'approval', 'terminal', { ancestors: [900, 33, 22] })];
  const result = await reader.poll(codeProcesses(22), at);
  assert.equal(result.waitingTasks, 0); assert.equal(result.activeTasks, 0);
  assert.notEqual(result.activity, 'waiting');
  // An ancestor list alone is not an owner binding, even if the listed CLI lives.
  hooks.rows = [hook('unbound', 22, 'waiting', 'input', 'terminal', { ownerPid: undefined })];
  assert.equal((await reader.poll(codeProcesses(22), at)).waitingTasks, 0);
});

test('registered live-session entrypoints override hook guesses without mixing Desktop and terminal', async t => {
  const { reader, hooks, hook, at } = await fixture(t, [
    { pid: 22, sessionId: 'desk', entrypoint: 'claude-desktop' },
    { pid: 33, sessionId: 'terminal', entrypoint: 'cli' },
  ]);
  hooks.rows = [hook('desk', 22, 'waiting', 'input', 'terminal'), hook('terminal', 33, 'waiting', 'approval', 'desktop')];
  const terminal = await reader.poll(codeProcesses(22, 33), at);
  assert.equal(terminal.waitingTasks, 1); assert.equal(terminal.waitingReason, 'approval');
  reader.setSource('desktop');
  const desktop = await reader.poll(codeProcesses(22, 33), at);
  assert.equal(desktop.waitingTasks, 1); assert.equal(desktop.waitingReason, 'input');
});

test('an unregistered live CLI uses its own hook ancestry and latest session only', async t => {
  const { reader, hooks, hook, at } = await fixture(t);
  hooks.rows = [hook('previous', 22, 'waiting', 'approval', 'terminal', { at: at - 1000 }), hook('current', 22, 'running')];
  const running = await reader.poll(codeProcesses(22), at);
  assert.equal(running.activity, 'running'); assert.equal(running.activeTasks, 1); assert.equal(running.waitingTasks, 0);
  hooks.rows = [hook('current', 22, 'idle')];
  assert.equal((await reader.poll(codeProcesses(22), at)).activity, 'idle');
  assert.equal((await reader.poll(codeProcesses(99), at)).waitingTasks, 0);
  assert.equal((await reader.poll([], at)).activity, 'offline');
});

test('hook Stop and tool recovery override the same session registration instead of preserving old waiting', async t => {
  const { reader, hooks, hook, at } = await fixture(t, [{ pid: 22, sessionId: 'session', status: 'waiting' }]);
  hooks.rows = [hook('session', 22, 'waiting', 'input')];
  assert.equal((await reader.poll(codeProcesses(22), at)).waitingReason, 'input');
  hooks.rows = [hook('session', 22, 'running')];
  const recovered = await reader.poll(codeProcesses(22), at);
  assert.equal(recovered.activity, 'running'); assert.equal(recovered.waitingTasks, 0); assert.equal(recovered.activeTasks, 1);
  hooks.rows = [hook('session', 22, 'idle')];
  const stopped = await reader.poll(codeProcesses(22), at);
  assert.equal(stopped.activity, 'idle'); assert.equal(stopped.waitingTasks, 0); assert.equal(stopped.activeTasks, 0);
});

test('a stopped hook overrides stale busy registration and duplicate PIDs count as one session', async t => {
  const { reader, hooks, hook, at } = await fixture(t, [
    { pid: 22, sessionId: 'shared', status: 'busy' }, { pid: 33, sessionId: 'shared', status: 'busy' },
  ]);
  hooks.rows = [hook('shared', 22, 'idle')];
  const result = await reader.poll(codeProcesses(22, 33), at);
  assert.equal(result.activity, 'idle'); assert.equal(result.activeTasks, 0);
});

test('independent file and hook sessions add up without globally taking the larger count', async t => {
  const { reader, hooks, hook, at } = await fixture(t, [{ pid: 22, sessionId: 'file', status: 'busy' }]);
  hooks.rows = [hook('hook', 33, 'running')];
  const result = await reader.poll(codeProcesses(22, 33), at);
  assert.equal(result.activeTasks, 2); assert.equal(result.activity, 'running');
});

test('Desktop AX and hook signals for a waiting Code session do not double its task count', async t => {
  const { reader, hooks, hook, at } = await fixture(t,
    [{ pid: 22, sessionId: 'desktop-code', entrypoint: 'claude-desktop', status: 'waiting' }], 'desktop',
    { activity: 'waiting', waiting: 'approval', trusted: true, supported: true });
  hooks.rows = [hook('desktop-code', 22, 'waiting', 'approval', 'desktop')];
  const result = await reader.poll([...codeProcesses(22), { pid: 90, command: '/fixture/Claude' }], at);
  assert.equal(result.waitingTasks, 1); assert.equal(result.waitingReason, 'approval'); assert.equal(result.activity, 'waiting');
});

test('a reused unregistered PID with a different native start time cannot revive an old session', async t => {
  const { reader, hooks, hook, at, identities } = await fixture(t);
  hooks.rows = [hook('previous-process', 22, 'waiting', 'approval')];
  identities.start = 'Thu Oct 22 00:01:00 2026';
  const reused = await reader.poll(codeProcesses(22), at);
  assert.equal(reused.waitingTasks, 0); assert.equal(reused.activeTasks, 0);
  hooks.rows = [hook('legacy-without-start', 22, 'waiting', 'input', 'terminal', { ownerStart: undefined })];
  assert.equal((await reader.poll(codeProcesses(22), at)).waitingTasks, 0);
});

test('owner verification uses one bounded batch and failed ps preserves existing file and AX evidence', async t => {
  const { reader, hooks, hook, at, identities } = await fixture(t, [{ pid: 22, sessionId: 'registered', status: 'busy' }]);
  hooks.rows = [hook('registered', 22, 'waiting', 'approval'), hook('other', 33, 'waiting', 'input')];
  const accepted = await reader.poll(codeProcesses(22, 33), at);
  assert.equal(accepted.waitingTasks, 2);
  assert.deepEqual(identities.requests, [[22, 33]]);
  identities.fail = true;
  const failed = await reader.poll(codeProcesses(22, 33), at);
  assert.equal(failed.activeTasks, 1); assert.equal(failed.waitingTasks, 0); assert.equal(failed.activity, 'running');
  const desktop = await fixture(t, [], 'desktop', { activity: 'waiting', waiting: 'input', supported: true, trusted: true });
  desktop.hooks.rows = [desktop.hook('desktop-session', 44, 'waiting', 'approval', 'desktop')];
  desktop.identities.fail = true;
  const ax = await desktop.reader.poll([...codeProcesses(44), { pid: 90, command: '/fixture/Claude' }], desktop.at);
  assert.equal(ax.waitingTasks, 1); assert.equal(ax.waitingReason, 'input');
});

test('owner identity batches are capped even if a hook reader returns excessive sessions', async t => {
  const { reader, hooks, hook, at, identities } = await fixture(t);
  const pids = Array.from({ length: 80 }, (_, index) => 100 + index);
  hooks.rows = pids.map(pid => hook(`session-${pid}`, pid, 'running'));
  const result = await reader.poll(codeProcesses(...pids), at);
  assert.equal(identities.requests.length, 1);
  assert.equal(identities.requests[0].length, 64);
  assert.equal(result.activeTasks, 64);
});

test('native owner start reader returns stable C-locale timestamps for actual processes', { skip: process.platform === 'win32' }, async () => {
  const first = await readOwnerStarts([process.pid]);
  assert.match(first.get(process.pid), /^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
  assert.deepEqual(await readOwnerStarts([process.pid, process.pid, -1, 'invalid']), first);
  assert.deepEqual(await readOwnerStarts([]), new Map());
});
