const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { harnessEvents, boundedFile, zstdFrames } = require('../electron/session-files.cjs');
const { DeepSeekActivityReader, classifyHarness } = require('../electron/deepseek-activity.cjs');
const { LocalStatusReader } = require('../electron/local-status.cjs');
const now = Date.now();
const event = (type, seq, time = now) => ({ type, seq, time, data: { content: 'PRIVATE_CONTENT', reason: { kind: 'completed' } } });
const frame = value => zlib.zstdCompressSync(Buffer.from(JSON.stringify(value) + '\n'));

test('Harness concatenated Zstandard frames read final state, reject truncated data and discard content', async () => {
  const input = Buffer.concat([frame({ type: 'session', version: 4 }), frame(event('turn/start', 1)), frame(event('assistant/message', 2)), frame(event('turn/end', 3))]);
  assert.equal(zstdFrames(input).length, 4);
  const events = await harnessEvents(input, true);
  assert.equal(classifyHarness(events, true, now).phase, 'idle');
  assert.ok(!JSON.stringify(events).includes('PRIVATE'));
  assert.ok(events.length <= 3);
  await assert.rejects(harnessEvents(input.subarray(0, -2), true), /Incomplete/);
  await assert.rejects(harnessEvents(frame({ type: 'session', version: 5 }), true), /Unsupported/);
  const many = Buffer.concat([frame(event('turn/start', 1)), ...Array.from({ length: 130 }, (_, i) => frame(event('step/end', i + 2)))]);
  assert.equal(classifyHarness(await harnessEvents(many, true), true, now).phase, 'unknown');
});

test('Harness active and approval states require owner process and fresh activity', () => {
  const start = [event('turn/start', 1)];
  assert.equal(classifyHarness(start, true, now).phase, 'running');
  assert.equal(classifyHarness(start, false, now).phase, 'unknown');
  assert.equal(classifyHarness(start, true, now + 600001).phase, 'unknown');
  const waiting = [...start, event('approval/asked', 2)];
  assert.equal(classifyHarness(waiting, true, now).phase, 'waiting');
  assert.equal(classifyHarness([...waiting, event('approval/decided', 3)], true, now).phase, 'running');
  assert.equal(classifyHarness([...waiting, event('turn/end', 3)], false, now).phase, 'idle');
});

test('Harness session discovery updates on changes, checks locks and preserves input files', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-activity-'));
  try {
    const session = path.join(home, '.dsh', 'sessions', 'workspace', 'session');
    await fs.mkdir(session, { recursive: true });
    const file = path.join(session, 'session.v4.jsonl.zstd');
    const input = Buffer.concat([frame({ type: 'session', version: 4 }), frame(event('turn/start', 1))]);
    await fs.writeFile(file, input);
    const realSession = await fs.realpath(session);
    const reader = new DeepSeekActivityReader({ home, env: {}, locks: async () => new Set([path.join(realSession, 'session.lock')]) });
    const processes = [{ pid: 7, command: '/app/DeepSeek Harness' }];
    assert.equal((await reader.poll(processes, now)).activity, 'running');
    assert.deepEqual(await fs.readFile(file), input);
    await fs.appendFile(file, frame(event('approval/asked', 2)));
    assert.equal((await reader.poll(processes, now)).activity, 'waiting');
    reader.locks = async () => new Set();
    assert.equal((await reader.poll(processes, now)).activity, 'unknown');
    await fs.appendFile(file, frame(event('turn/end', 3)));
    const result = await reader.poll(processes, now);
    assert.equal(result.activity, 'idle'); assert.ok(!JSON.stringify(result).includes(home));
    assert.equal((await reader.poll([], now)).activity, 'offline');
    await fs.writeFile(file, 'invalid'); assert.equal((await reader.poll(processes, now)).activity, 'unknown');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('session files are bounded and reject symlinks outside provider data', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-bounds-'));
  try {
    const root = path.join(home, 'root'); await fs.mkdir(root);
    await fs.writeFile(path.join(home, 'outside'), 'PRIVATE'); await fs.symlink(path.join(home, 'outside'), path.join(root, 'link'));
    await assert.rejects(boundedFile(path.join(root, 'link'), root), /Outside/);
    const file = path.join(root, 'large'); await fs.writeFile(file, 'x'.repeat(20));
    await assert.rejects(boundedFile(file, root, 10), /size/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('balance and activity failures are independent', async () => {
  const activity = { activity: 'running', activeTasks: 1, task: 'activity' };
  const balance = { id: 'deepseek', connection: 'ready', balance: { wallets: [], stale: false } };
  const reader = new LocalStatusReader({ deepseekReader: { poll: async () => { throw new Error('network'); } }, deepseekActivityReader: { poll: async () => activity } });
  assert.equal((await reader.deepseek([], false)).activity, 'running');
  reader.deepseekReader.poll = async () => balance;
  reader.deepseekActivityReader.poll = async () => { throw new Error('record'); };
  const result = await reader.deepseek([], false);
  assert.equal(result.activity, 'unknown'); assert.deepEqual(result.balance, balance.balance);
});
