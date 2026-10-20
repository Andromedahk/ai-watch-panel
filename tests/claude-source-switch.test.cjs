const test = require('node:test');
const assert = require('node:assert/strict');
const { isClaudeSource, validPreferences } = require('../electron/window-policy.cjs');
const { LocalStatusReader } = require('../electron/local-status.cjs');
const { traySummary } = require('../electron/tray-summary.cjs');

const status = (source, plan, remaining) => ({
  id: 'claude', claudeSource: source, source: 'cache', connection: 'ready',
  plan: { name: plan }, quotas: [{ model: '全部模型', period: '1 周', remaining, stale: false }],
  activity: 'running', activeTasks: 1, task: `${source} task`,
  taskDetails: [{ title: `${source} detail`, state: 'running' }],
});
const emptyReader = () => ({ poll: async () => ({}) });
function fixture(claudeReader, claudeSource = 'desktop') {
  const reader = new LocalStatusReader({ home: '/fixture/claude-source-switch', claudeReader, claudeSource,
    zcodeReader: emptyReader(), kimiReader: emptyReader(), kimiWorkReader: emptyReader(),
    qwenReader: emptyReader(), workbuddyReader: emptyReader() });
  reader.codex = reader.antigravity = reader.deepseek = async () => ({});
  reader.setTaskDetailsEnabled(true);
  return reader;
}
function delayedAdapter() {
  let release, signal;
  const started = new Promise(resolve => { signal = resolve; });
  const selections = [];
  const adapter = {
    source: null, calls: 0,
    setSource(source) { this.source = source; selections.push(source); },
    async poll() {
      const selected = this.source;
      this.calls++;
      if (this.calls === 1) {
        signal();
        return new Promise(resolve => { release = () => resolve(status(selected, 'Superseded plan', 99)); });
      }
      return status(selected, 'Current plan', 15);
    },
  };
  return { adapter, selections, started, release: () => release() };
}
const tray = (snapshot, source) => traySummary({ claude: snapshot }, {
  ...validPreferences({ claudeSource: source }), enabledProviders: ['claude'],
})[0].label;

test('Claude source accepts only Desktop or Code and old preferences migrate to Desktop', () => {
  for (const source of ['desktop', 'code']) {
    assert.equal(isClaudeSource(source), true);
    assert.equal(validPreferences({ claudeSource: source }).claudeSource, source);
  }
  for (const source of [undefined, null, '', 'auto', 'Desktop', 'terminal', false, ['desktop'], { source: 'code' }]) {
    assert.equal(isClaudeSource(source), false);
    assert.equal(validPreferences({ claudeSource: source }).claudeSource, 'desktop');
  }
  assert.equal(validPreferences({ kimiSource: 'work' }).claudeSource, 'desktop');
});

test('Claude switching immediately clears the previous account allowance and task metadata', async () => {
  const selections = [];
  const adapter = { source: null, setSource(source) { this.source = source; selections.push(source); },
    poll: async function () { return status(this.source, this.source === 'desktop' ? 'Free' : 'Pro', this.source === 'desktop' ? 25 : 80); } };
  const reader = fixture(adapter);
  try {
    assert.deepEqual(selections, ['desktop']);
    const first = (await reader.poll()).claude;
    assert.equal(first.claudeSource, 'desktop'); assert.equal(first.plan.name, 'Free');
    assert.equal(first.taskDetails[0].title, 'desktop detail');
    reader.setClaudeSource('desktop');
    assert.deepEqual(selections, ['desktop']);
    assert.equal(reader.current.claude.plan.name, 'Free');
    reader.setClaudeSource('code');
    assert.deepEqual(selections, ['desktop', 'code']);
    assert.equal(reader.current.claude.claudeSource, 'code');
    assert.equal(reader.current.claude.plan, undefined);
    assert.deepEqual(reader.current.claude.quotas, []);
    assert.equal(reader.current.claude.taskDetails, undefined);
    assert.equal(reader.current.claude.activity, 'unknown');
    const second = (await reader.poll()).claude;
    assert.equal(second.plan.name, 'Pro'); assert.equal(second.quotas[0].remaining, 80);
    assert.equal(second.taskDetails[0].title, 'code detail');
    assert.throws(() => reader.setClaudeSource('auto'), /Invalid Claude source/);
    assert.equal(reader.current.claude, second); assert.deepEqual(selections, ['desktop', 'code']);
  } finally { reader.codexAttention.close(); }
});

test('a pending Desktop result cannot overwrite the selected Code account after a switch', async () => {
  const delayed = delayedAdapter(); const reader = fixture(delayed.adapter);
  try {
    const pending = reader.poll(); await delayed.started;
    reader.setClaudeSource('code');
    delayed.release();
    const result = (await pending).claude;
    assert.equal(result.claudeSource, 'code'); assert.equal(result.plan, undefined);
    assert.deepEqual(result.quotas, []); assert.equal(result.taskDetails, undefined);
    assert.equal(result.activity, 'unknown'); assert.equal(result.activeTasks, 0);
    assert.doesNotMatch(JSON.stringify(result), /Superseded|desktop task|desktop detail/);
    const fresh = (await reader.poll()).claude;
    assert.equal(fresh.claudeSource, 'code'); assert.equal(fresh.plan.name, 'Current plan');
    assert.equal(fresh.quotas[0].remaining, 15);
    assert.deepEqual(delayed.selections, ['desktop', 'code']);
  } finally { reader.codexAttention.close(); }
});

test('switching away and back rejects the pending old generation even when the source name matches', async () => {
  const delayed = delayedAdapter(); const reader = fixture(delayed.adapter, 'code');
  try {
    const pending = reader.poll(); await delayed.started;
    reader.setClaudeSource('desktop'); reader.setClaudeSource('code');
    delayed.release();
    const result = (await pending).claude;
    assert.equal(result.claudeSource, 'code'); assert.equal(result.plan, undefined);
    assert.deepEqual(result.quotas, []); assert.equal(result.taskDetails, undefined);
    assert.equal((await reader.poll()).claude.plan.name, 'Current plan');
    assert.deepEqual(delayed.selections, ['code', 'desktop', 'code']);
  } finally { reader.codexAttention.close(); }
});

test('a Claude read failure retains the explicit source and cannot keep the former account data', async () => {
  const adapter = { source: null, setSource(source) { this.source = source; }, poll: async function () {
    if (this.source === 'desktop') return status('desktop', 'Free', 80);
    throw new Error('unavailable');
  } };
  const reader = fixture(adapter);
  try {
    await reader.poll(); reader.setClaudeSource('code');
    const result = (await reader.poll()).claude;
    assert.equal(result.claudeSource, 'code'); assert.equal(result.connection, 'error');
    assert.equal(result.plan, undefined); assert.deepEqual(result.quotas, []);
    assert.equal(result.taskDetails, undefined);
  } finally { reader.codexAttention.close(); }
});

test('tray names match the selected Claude client and wrong-source or legacy Desktop snapshots stay unknown', () => {
  const desktop = status('desktop', 'Free', 25), code = status('code', 'Pro', 80);
  assert.equal(tray(desktop, 'desktop'), 'Claude    7 天 · 剩余 25%');
  assert.equal(tray(code, 'code'), 'Claude Code    7 天 · 剩余 80%');
  assert.equal(tray(code, 'desktop'), 'Claude    额度未知 · 尚未读取');
  assert.equal(tray(desktop, 'code'), 'Claude Code    额度未知 · 尚未读取');
  const legacy = { ...code }; delete legacy.claudeSource;
  assert.equal(tray(legacy, 'desktop'), 'Claude    额度未知 · 尚未读取');
  assert.equal(tray(legacy, 'code'), 'Claude Code    7 天 · 剩余 80%');
  assert.equal(tray({ claudeSource: 'desktop', connection: 'ready', quotas: [] }, 'desktop'), 'Claude    额度未知');
  assert.equal(tray({ claudeSource: 'code', connection: 'ready', quotas: [] }, 'code'), 'Claude Code    Code 额度暂不可用');
  assert.equal(tray({ ...desktop, connection: 'auth-required' }, 'desktop'), 'Claude    额度未知 · 待登录');
});
