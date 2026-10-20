const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeText, timestamp, taskDetail, codexDetails, antigravityDetails } = require('../electron/task-details.cjs');
const { LocalStatusReader } = require('../electron/local-status.cjs');
const { harnessEvents } = require('../electron/session-files.cjs');
const now = Date.now();
test('details allowlist drops IDs, credentials, paths, tool arguments and impossible progress', () => {
  const detail = taskDetail({ title: 'Review /Users/private/project a@example.test token=PRIVATE sk-PRIVATE\u202e',
    id: 'PRIVATE-ID', arguments: 'PRIVATE-COMMAND', state: 'running', updatedAt: now, operation: 'PRIVATE-COMMAND', progress: 120, steps: -1 }, { now, live: true });
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE|@|\/Users|\u202e/); assert.equal(detail.progress, null); assert.equal(detail.operation, null);
  assert.ok([...safeText('字'.repeat(500))].length <= 120);
});
test('old cached running flags become unknown; explicit percentages and protobuf timestamps stay precise', () => {
  assert.equal(taskDetail({ state: 'running', updatedAt: now - 700000 }, { now, live: true }).state, 'unknown');
  assert.equal(taskDetail({ state: 'running', updatedAt: now }, { now, live: false }).state, 'unknown');
  assert.equal(taskDetail({ state: 'running', updatedAt: now, progress: 22.4 }, { now, live: true }).progress, 22.4);
  assert.equal(timestamp({ seconds: String(Math.floor(now / 1000)), nanos: 0 }, now), new Date(Math.floor(now / 1000) * 1000).toISOString());
  assert.equal(timestamp(now + 200000, now), null);
});
test('Antigravity summaries are bounded, active first, missing progress never inferred from step count', () => {
  const rows = Array.from({ length: 205 }, (_, i) => ({ title: `Task ${i}`, stepCount: i, status: i === 50 ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: new Date(now).toISOString(), secret: 'PRIVATE' }));
  const result = antigravityDetails(rows, true, now); assert.equal(result.length, 8); assert.equal(result[0].title, 'Task 50');
  assert.equal(result[0].steps, 50); assert.equal(result[0].progress, null); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
test('Codex task titles and item types are read without selecting item bodies or unrelated archived threads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-watch-details-')); const { DatabaseSync } = require('node:sqlite');
  try {
    const state = new DatabaseSync(path.join(root, 'state_5.sqlite'));
    state.exec('CREATE TABLE threads(id TEXT,title TEXT,updated_at INTEGER,archived INTEGER,name TEXT)');
    state.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('private-id', 'Long initial message', Math.floor(now / 1000), 0, 'Review layout');
    state.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('archived', 'PRIVATE-ARCHIVED', Math.floor(now / 1000), 1, null); state.close();
    const history = new DatabaseSync(path.join(root, 'thread_history_1.sqlite'));
    history.exec('CREATE TABLE thread_items(thread_id TEXT,item_type TEXT,created_at_ms INTEGER,item_json TEXT,turn_id TEXT)');
    history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?)').run('private-id', 'fileChange', now-1000, 'PRIVATE-BODY', 'current-turn'); history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?)').run('private-id','userMessage',now,'PRIVATE-BODY','current-turn');
    history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?)').run('private-id','webSearch',now+1,'PRIVATE-BODY','old-turn'); history.close();
    const result = codexDetails(root, [{ thread_id: 'private-id', turn_id: 'current-turn', last_item_at: now }], { waitingThreads: new Set(), connected: true }, true, now);
    assert.equal(result[0].title, 'Review layout'); assert.equal(result[0].state, 'running'); assert.equal(result[0].operation, 'fileChange');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private-id|item_json/);
    assert.equal(codexDetails(root, [], { waitingThreads: new Set() }, false, now)[0].state, 'unknown');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('Codex reads bounded metadata from large histories and summarizes MCP calls without tool bodies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-watch-large-history-')); const { DatabaseSync } = require('node:sqlite');
  try {
    const state = new DatabaseSync(path.join(root, 'state_5.sqlite'));
    state.exec('CREATE TABLE threads(id TEXT,title TEXT,updated_at INTEGER,archived INTEGER)');
    state.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('private-id', 'Review dashboard', Math.floor(now / 1000), 0); state.close();
    const file = path.join(root, 'thread_history_1.sqlite'), history = new DatabaseSync(file);
    history.exec('CREATE TABLE thread_items(thread_id TEXT,item_type TEXT,created_at_ms INTEGER,item_json TEXT,turn_id TEXT)');
    history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?)').run('private-id', 'mcpToolCall', now, 'PRIVATE-TOOL-BODY', 'current-turn'); history.close();
    // Sparse trailing pages reproduce a large valid history without allocating a large fixture.
    fs.truncateSync(file, 1024 * 1024 * 1024 + 4096);
    const [result] = codexDetails(root, [{ thread_id: 'private-id', turn_id: 'current-turn', last_item_at: now }], { waitingThreads: new Set(), connected: true }, true, now);
    assert.equal(result.title, 'Review dashboard'); assert.equal(result.operation, 'toolCall'); assert.equal(result.state, 'running');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private-id/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('Harness metadata is opt-in and never returns tool bodies or commands', async () => {
  const data = Buffer.from([{ type: 'session', version: 4, title: 'Review layout', seq: 0, time: now },
    { type: 'turn/start', seq: 1, time: now }, { type: 'tool/start', seq: 2, time: now, data: { command: 'PRIVATE' } }].map(JSON.stringify).join('\n'));
  assert.doesNotMatch(JSON.stringify(await harnessEvents(data, false)), /Review layout/);
  const details = await harnessEvents(data, false, true); assert.match(JSON.stringify(details), /Review layout/); assert.doesNotMatch(JSON.stringify(details), /PRIVATE/);
});
test('leaving fullscreen clears task snapshots and invalidates an in-flight details collection', async () => {
  const reader = new LocalStatusReader(); reader.setTaskDetailsEnabled(true);
  for (const id of ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy']) reader.current[id].taskDetails = [{ title: 'PRIVATE' }];
  let release, started; const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const sample = id => ({ ...reader.current[id], taskDetails: [{ title: 'PRIVATE' }] });
  reader.codex = async () => { started(); await gate; return sample('codex'); };
  reader.antigravity = async () => sample('antigravity'); reader.deepseek = async () => sample('deepseek');
  for (const [id, adapter] of [['claude', reader.claudeReader], ['zcode', reader.zcodeReader], ['kimi', reader.kimiReader], ['qwen', reader.qwenReader], ['workbuddy', reader.workbuddyReader]]) adapter.poll = async () => sample(id);
  const pending = reader.collect(false); await began;
  reader.setTaskDetailsEnabled(false); release(); assert.doesNotMatch(JSON.stringify(reader.current), /PRIVATE|taskDetails/);
  assert.doesNotMatch(JSON.stringify(await pending), /PRIVATE|taskDetails/);
  assert.equal(reader.claudeReader.taskDetailsEnabled, false); assert.equal(reader.deepseekActivityReader.taskDetailsEnabled, false);
});
