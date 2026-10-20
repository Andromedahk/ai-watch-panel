const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeStatusReader } = require('../electron/claude-status.cjs');
const now = Date.parse('2026-10-08T12:00:00Z');
const processList = [{ pid: 123, command: '/fixture/Claude' }];
const observedAt = new Date(now).toISOString();
function reader(result, activity = 'idle') {
  const usageReader = { allowed: true, poll: async () => result, clearSource() {}, setAllowed(value) { this.allowed = value; } };
  return new ClaudeStatusReader({ home: '/nonexistent-fixture/claude-online', platform: 'darwin', source: 'desktop', usageReader,
    desktopActivityReader: async () => ({ supported: true, trusted: true, activity, plan: 'Pro' }) });
}
test('Claude online subscription works without passive history and remains independent of activity', async () => {
  const adapter = reader({ state: 'ready', detail: 'SAFE_DETAIL', plan: { name: 'Pro', stale: false, observedAt },
    usage: { observedAt, quotas: [{ model: '全部模型', period: '1 周', remaining: 0, reset: '' }] } }, 'running');
  const result = await adapter.poll(processList, now, true);
  assert.equal(result.source, 'account'); assert.equal(result.plan.name, 'Pro');
  assert.equal(result.quotas[0].remaining, 0); assert.equal(result.activity, 'running');
  assert.equal(result.activeTasks, 1); assert.equal(result.activityAccessRequired, false);
});
test('Claude successful empty server windows preserve unknown instead of manufacturing allowance', async () => {
  const result = await reader({ state: 'ready', detail: 'SAFE_DETAIL', plan: { name: 'Free', stale: false },
    usage: { observedAt, quotas: [] } }).poll(processList, now);
  assert.equal(result.source, 'account'); assert.equal(result.plan.name, 'Free');
  assert.deepEqual(result.quotas, []); assert.equal(result.activity, 'idle');
});
test('Claude rejected authorization clears allowances and independent UI plan evidence', async () => {
  const result = await reader({ state: 'auth', detail: 'SAFE_AUTH_ERROR' }).poll(processList, now);
  assert.equal(result.plan.name, null); assert.deepEqual(result.quotas, []);
  assert.equal(result.detail, 'SAFE_AUTH_ERROR'); assert.equal(result.activity, 'idle');
});
test('Claude revoking network access discards an already pending server result', async () => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const adapter = reader(null);
  adapter.usageReader.poll = async () => { started(); return new Promise(resolve => { release = resolve; }); };
  const pending = adapter.poll(processList, now);
  await began; adapter.setNetworkAllowed(false);
  release({ state: 'ready', plan: { name: 'Max' }, usage: { quotas: [{ remaining: 99 }], observedAt } });
  const result = await pending;
  assert.equal(result.plan.name, null); assert.deepEqual(result.quotas, []); assert.equal(result.activity, 'unknown');
});
