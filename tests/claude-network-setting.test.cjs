const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalStatusReader } = require('../electron/local-status.cjs');

const emptyReader = () => ({ poll: async () => ({}) });
const snapshot = (name = 'Network plan') => ({ id: 'claude', source: 'account', connection: 'ready',
  plan: { name }, quotas: [{ model: '全部模型', period: '1 周', remaining: 80 }],
  activity: 'idle', activeTasks: 0, task: 'idle', taskDetails: [{ title: 'Old task' }],
});
function fixture(adapter, options = {}) {
  const reader = new LocalStatusReader({ home: '/fixture/claude-network-setting', claudeReader: adapter,
    zcodeReader: emptyReader(), kimiReader: emptyReader(), kimiWorkReader: emptyReader(),
    qwenReader: emptyReader(), workbuddyReader: emptyReader(), ...options });
  reader.codex = reader.antigravity = reader.deepseek = async () => ({});
  reader.setTaskDetailsEnabled(true);
  return reader;
}

test('Claude network defaults off and initializes adapters only with a strict boolean', () => {
  for (const value of [undefined, false, null, 1, 'true', {}, [true], true]) {
    const calls = [];
    const reader = fixture({ setNetworkAllowed: value => calls.push(value), poll: async () => snapshot() },
      { claudeNetworkAllowed: value });
    try {
      assert.equal(reader.claudeNetworkAllowed, value === true);
      assert.deepEqual(calls, [value === true]);
    } finally { reader.codexAttention.close(); }
  }
});

test('Claude network toggles clear all prior data immediately and reject invalid values without mutation', async () => {
  const calls = [];
  const reader = fixture({ setNetworkAllowed: value => calls.push(value), poll: async () => snapshot() });
  try {
    await reader.poll();
    const original = reader.current.claude;
    for (const value of [undefined, null, 0, 1, 'true', {}, [true]]) {
      assert.throws(() => reader.setClaudeNetworkAllowed(value), /Invalid Claude network setting/);
      assert.equal(reader.current.claude, original); assert.equal(reader.claudeGeneration, 0);
    }
    reader.setClaudeNetworkAllowed(false);
    assert.equal(reader.current.claude, original); assert.deepEqual(calls, [false]);
    reader.setClaudeNetworkAllowed(true);
    assert.equal(reader.claudeGeneration, 1); assert.deepEqual(calls, [false, true]);
    assert.equal(reader.current.claude.claudeSource, 'desktop');
    assert.equal(reader.current.claude.plan, undefined); assert.deepEqual(reader.current.claude.quotas, []);
    assert.equal(reader.current.claude.taskDetails, undefined);
    await reader.poll(); reader.setClaudeNetworkAllowed(false);
    assert.equal(reader.claudeGeneration, 2); assert.deepEqual(calls, [false, true, false]);
    assert.equal(reader.current.claude.plan, undefined); assert.deepEqual(reader.current.claude.quotas, []);
    assert.equal(reader.current.claude.taskDetails, undefined);
  } finally { reader.codexAttention.close(); }
});

test('a pending network response cannot restore data after opt-out or away-and-back toggles', async () => {
  for (const reenable of [false, true]) {
    let release, started;
    const began = new Promise(resolve => { started = resolve; });
    const reader = fixture({ setNetworkAllowed() {}, poll() {
      started(); return new Promise(resolve => { release = () => resolve(snapshot('Superseded plan')); });
    } }, { claudeNetworkAllowed: true });
    try {
      const pending = reader.poll(); await began;
      reader.setClaudeNetworkAllowed(false);
      if (reenable) reader.setClaudeNetworkAllowed(true);
      release();
      const result = (await pending).claude;
      assert.equal(result.plan, undefined); assert.deepEqual(result.quotas, []);
      assert.equal(result.taskDetails, undefined); assert.equal(result.activity, 'unknown');
      assert.doesNotMatch(JSON.stringify(result), /Superseded|Old task/);
    } finally { reader.codexAttention.close(); }
  }
});

test('manual refresh forwards the current timestamp and force flag to the Claude adapter', async () => {
  const calls = [];
  const reader = fixture({ poll: async (...args) => { calls.push(args); return snapshot(); } });
  try {
    const before = Date.now(); await reader.poll(); await reader.poll(true); const after = Date.now();
    assert.equal(calls.length, 2);
    for (const [list, now] of calls) { assert.ok(list === null || Array.isArray(list)); assert.ok(now >= before && now <= after); }
    assert.equal(calls[0][2], false); assert.equal(calls[1][2], true);
  } finally { reader.codexAttention.close(); }
});
