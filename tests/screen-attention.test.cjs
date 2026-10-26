const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

const filename = require.resolve('../src/screen-attention.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
}, fileName: filename });
const loaded = { exports: {} };
new Function('module', 'exports', compiled.outputText)(loaded, loaded.exports);
const { screenAttentionQueue } = loaded.exports;

const task = (title, fields = {}) => ({ title, state: 'waiting', stale: false, operation: null,
  updatedAt: '2026-10-26T10:00:00Z', source: 'local-api', steps: null, toolCalls: null, progress: null, ...fields });
const provider = (id, local = {}) => ({ id, name: id, local: { activity: 'idle', waitingTasks: 0, ...local } });

test('only current structured waiting enters the queue, never old titles, login or permission hints', () => {
  const input = [
    { id: 'no-local', task: 'waiting for approval' },
    provider('claude', { task: '请授权', connection: 'auth-required', accessRequired: true }),
    provider('codex', { taskDetails: [task('过期授权', { stale: true }), task('已处理', { state: 'completed' })] }),
    provider('deepseek', { activityAccessRequired: true, activityAccessState: 'denied' }),
  ];
  assert.deepEqual(screenAttentionQueue(input), []);
  const live = provider('codex', { taskDetails: [task('当前问题')] });
  assert.equal(screenAttentionQueue([live])[0].title, '当前问题');
});

test('multiple Agents and multiple current tasks rotate independently without duplicating aggregate counts', () => {
  const input = [provider('claude', { activity: 'waiting', waitingReason: 'input' }),
    provider('codex', { activity: 'waiting', waitingTasks: 3, waitingReason: 'both', taskDetails: [
      task('修改文件', { operation: 'approval/asked' }), task('选择方案'),
      task('过期问题', { stale: true }), task('完成的请求', { state: 'completed' }),
    ] })];
  const result = screenAttentionQueue(input);
  assert.equal(result.length, 3, 'the three aggregate tasks must not be added again');
  assert.equal(result[0].provider, input[0]);
  assert.deepEqual(result.slice(1).map(item => [item.title, item.reason]).sort(), [['修改文件', 'approval'], ['选择方案', 'both']].sort());
  assert.equal(new Set(result.map(item => item.key)).size, 3);
});

test('poll timestamps and detail order do not change queue identity or order', () => {
  const first = provider('codex', { activity: 'waiting', waitingReason: 'input', taskDetails: [task('Beta'), task('Alpha')] });
  const next = structuredClone(first);
  next.local.sampledAt = '2026-10-26T10:01:00Z';
  next.local.taskDetails.reverse().forEach(item => { item.updatedAt = '2026-10-26T10:01:00Z'; item.steps = 9; });
  const keys = value => screenAttentionQueue([value]).map(item => item.key);
  assert.deepEqual(keys(first), keys(next));
  next.local.taskDetails[0].title = 'Renamed';
  assert.notDeepEqual(keys(first), keys(next), 'a safe title change is a new display identity without a stable source ID');
});

test('duplicate or absent safe titles retain distinct stable slots', () => {
  const input = provider('codex', { waitingTasks: 4, waitingReason: 'input', taskDetails: [task('Same'), task('Same'), task(null), task('   ')] });
  const result = screenAttentionQueue([input]);
  assert.equal(result.length, 4);
  assert.equal(new Set(result.map(item => item.key)).size, 4);
  input.local.taskDetails.reverse();
  assert.deepEqual(screenAttentionQueue([input]).map(item => item.key), result.map(item => item.key));
});

test('aggregate-only waits keep both reasons while unknown operations are not mistaken for input', () => {
  const aggregate = screenAttentionQueue([provider('claude', { waitingTasks: 2, waitingReason: 'both' })]);
  assert.equal(aggregate.length, 1);
  assert.equal(aggregate[0].reason, 'both');
  assert.equal(aggregate[0].title, null);
  for (const reason of ['input', 'approval', 'both', undefined]) {
    const result = screenAttentionQueue([provider('codex', { taskDetails: [task('授权或回答这只是标题', { operation: 'toolCall' })], waitingReason: reason })]);
    assert.equal(result[0].reason, reason || 'waiting');
  }
  const inferred = screenAttentionQueue([provider('deepseek', { taskDetails: [task(null, { operation: 'approval/asked' })] })]);
  assert.equal(inferred[0].reason, 'approval');
});

test('resolving and clearing tasks removes their reminders without mutating source snapshots', () => {
  const input = provider('codex', { taskDetails: [task('First'), task('Second')] });
  const original = structuredClone(input);
  const result = screenAttentionQueue([input]);
  assert.deepEqual(input, original);
  input.local.taskDetails[0].state = 'completed';
  const remaining = screenAttentionQueue([input]);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].key, result.find(item => item.title === 'Second').key);
  input.local.taskDetails[1].state = 'completed';
  assert.deepEqual(screenAttentionQueue([input]), []);
});
