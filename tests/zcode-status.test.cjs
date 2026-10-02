const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ZcodeStatusReader, resolveZcodePaths, isZcodeProcess, readZcodeTurns, FRESH_MS } = require('../electron/zcode-status.cjs');
const NOW = 1800000000000;
const PROCESS = [{ pid: 100, command: '/Applications/ZCode.app/Contents/MacOS/ZCode' }];
const turn = (overrides = {}) => ({ session_id: 'session-test', turn_id: 'turn-test', status: 'running',
  started_at: NOW - 2000, first_model_start_at: NOW - 1000, first_token_at: null, completed_at: null,
  model_request_count: 1, tool_call_count: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, ...overrides });
function mock(rows) { return new ZcodeStatusReader({ home: '/fixture', env: {}, readTurns: async () => rows }); }

test('ZCode discovers portable defaults and explicit official environment paths', () => {
  assert.equal(resolveZcodePaths({ home: '/fixture', env: {} })[0].file, '/fixture/.zcode/cli/db/db.sqlite');
  assert.deepEqual(resolveZcodePaths({ home: '/fixture', env: { ZCODE_DATA_BASE_DIR: '/fixture/custom' } }).map(p => p.file),
    ['/fixture/custom/.zcode/cli/db/db.sqlite', '/fixture/.zcode/cli/db/db.sqlite']);
  assert.equal(resolveZcodePaths({ home: '/fixture', env: { ZCODE_SESSION_DB: '~/other/db.sqlite' } })[0].file, '/fixture/other/db.sqlite');
  assert.equal(resolveZcodePaths({ home: 'C:\\Fixture', env: {}, platform: 'win32' })[0].file, 'C:\\Fixture\\.zcode\\cli\\db\\db.sqlite');
});
test('ZCode process detection excludes unrelated terminals, arguments and lookalikes', () => {
  for (const command of ['/bin/zcode', '/bin/zcode-agent', 'ZCode.exe', PROCESS[0].command]) assert.equal(isZcodeProcess(command), true);
  for (const command of ['/bin/node', 'echo zcode', '/bin/not-zcode', '/ZCode.app-fake/Contents/MacOS/node']) assert.equal(isZcodeProcess(command), false);
});
test('ZCode never lights a historical unfinished record on first or unchanged sampling', async () => {
  const reader = mock([turn()]);
  assert.equal((await reader.poll(PROCESS, NOW)).activity, 'unknown');
  assert.equal((await reader.poll(PROCESS, NOW + 1000)).activity, 'unknown');
});
test('ZCode requires fresh observed telemetry progression, stops on completion and expires confidence', async () => {
  const rows = [turn()]; const reader = mock(rows);
  await reader.poll(PROCESS, NOW);
  rows[0].first_token_at = NOW + 1000;
  const running = await reader.poll(PROCESS, NOW + 2000);
  assert.equal(running.activity, 'running'); assert.equal(running.activeTasks, 1);
  assert.equal((await reader.poll(PROCESS, NOW + FRESH_MS + 2001)).activity, 'unknown');
  rows[0].status = 'completed'; rows[0].completed_at = NOW + FRESH_MS + 3000;
  assert.equal((await reader.poll(PROCESS, NOW + FRESH_MS + 3000)).activity, 'idle');
});
test('ZCode newly started turns are detected after the baseline sample', async () => {
  const rows = []; const reader = mock(rows);
  assert.equal((await reader.poll(PROCESS, NOW)).activity, 'idle');
  rows.push(turn({ started_at: NOW + 1000, first_model_start_at: NOW + 1000 }));
  assert.equal((await reader.poll(PROCESS, NOW + 1000)).activity, 'running');
});
test('ZCode telemetry advancing on a long running turn restores current confidence', async () => {
  const rows = [turn({ started_at: NOW - FRESH_MS * 2, first_model_start_at: NOW - FRESH_MS * 2 })];
  const reader = mock(rows); await reader.poll(PROCESS, NOW);
  rows[0].tool_call_count++;
  assert.equal((await reader.poll(PROCESS, NOW + 1000)).activity, 'running');
});
test('ZCode stale or future imported unfinished turns do not become running', async () => {
  for (const started_at of [NOW - FRESH_MS - 1000, NOW + 100000]) {
    const rows = []; const reader = mock(rows); await reader.poll(PROCESS, NOW);
    rows.push(turn({ started_at, first_model_start_at: started_at }));
    assert.equal((await reader.poll(PROCESS, NOW + 1000)).activity, 'unknown');
  }
});
test('ZCode process exit/restart and unavailable process enumeration clear confidence', async () => {
  const rows = []; const reader = mock(rows); await reader.poll(PROCESS, NOW);
  rows.push(turn()); assert.equal((await reader.poll(PROCESS, NOW + 1000)).activity, 'running');
  assert.equal((await reader.poll([], NOW + 2000)).activity, 'offline');
  assert.equal((await reader.poll(PROCESS, NOW + 3000)).activity, 'unknown');
  rows[0].output_tokens++;
  assert.equal((await reader.poll(PROCESS, NOW + 4000)).activity, 'running');
  assert.equal((await reader.poll(null, NOW + 5000)).activity, 'unknown');
  assert.equal((await reader.poll(PROCESS, NOW + 6000)).activity, 'unknown');
});
test('ZCode deduplicates sessions and ignores superseded unfinished turns', async () => {
  const reader = mock([turn(), turn({ turn_id: 'new', status: 'completed', started_at: NOW, completed_at: NOW })]);
  assert.equal((await reader.poll(PROCESS, NOW)).activity, 'idle');
});
test('ZCode missing, incompatible, or oversized records are safe and never disclose exception text', async () => {
  for (const failure of [Object.assign(new Error('secret fixture path'), { code: 'ENOENT' }), new Error('secret fixture token')]) {
    const reader = new ZcodeStatusReader({ home: '/fixture', env: {}, readTurns: async () => { throw failure; } });
    const result = await reader.poll(PROCESS, NOW);
    assert.equal(result.activity, 'unknown'); assert.equal(result.source, 'unavailable');
    assert.doesNotMatch(JSON.stringify(result), /secret|fixture/);
  }
  assert.equal((await mock(Array.from({ length: 129 }, () => turn())).poll(PROCESS, NOW)).activity, 'unknown');
});
test('ZCode metadata reader uses official SQLite schema and excludes content and child sessions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-zcode-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'db.sqlite');
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, time_archived INTEGER, title TEXT);
    CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER,
      first_model_start_at INTEGER, first_token_at INTEGER, completed_at INTEGER, model_request_count INTEGER,
      tool_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER);
    CREATE INDEX turn_usage_started_idx ON turn_usage(started_at);`);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('top', null, null, 'private prompt');
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('child', 'top', null, 'private subtask');
  for (const id of ['top', 'child']) db.prepare('INSERT INTO turn_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'test', 'completed', NOW - 1000, NOW - 900, NOW - 800, NOW, 1, 0, 10, 20, 5);
  db.close();
  const before = await fs.readFile(file);
  const rows = await readZcodeTurns({ file, root });
  assert.equal(rows.length, 1); assert.equal(rows[0].session_id, 'top');
  assert.doesNotMatch(JSON.stringify(rows), /private/);
  assert.deepEqual(await fs.readFile(file), before);
  const link = path.join(root, 'linked.sqlite'); await fs.symlink(file, link);
  await assert.rejects(readZcodeTurns({ file: link, root }));
});
