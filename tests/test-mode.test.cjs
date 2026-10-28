const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }, fileName: filename });
  module._compile(result.outputText, filename);
};
const { activityOptions, defaultTestConfig, makeTestStatus, applyTestPreset } = require('../src/test-mode.ts');
const { providers } = require('../src/data.ts');
const { screenAttentionQueue } = require('../src/screen-attention.ts');
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const requestProviders = ['codex', 'claude', 'antigravity', 'deepseek'];
const sampledAt = '2026-10-27T04:00:00Z';
const queueFor = status => screenAttentionQueue(providers.map(provider => ({ ...provider, local: status[provider.id] })));

for (const id of requestProviders) {
  test(`${id} test controls produce full-screen input, approval and combined requests`, () => {
    const options = new Set(activityOptions(id).map(([value]) => value));
    for (const activity of ['input', 'approval', 'mixed']) {
      assert.ok(options.has(activity), `${id} exposes ${activity} in its existing selector`);
      const config = applyTestPreset(defaultTestConfig(), 'idle');
      config[id].activity = activity;
      const original = structuredClone(config);
      const status = makeTestStatus(config, sampledAt);
      assert.deepEqual(config, original, 'test rendering must not mutate preferences or its input');
      assert.equal(status.isTestData, true);
      assert.equal(status[id].activity, 'waiting');
      assert.equal(status[id].waitingReason, activity === 'mixed' ? 'both' : activity);
      assert.equal(status[id].waitingTasks, activity === 'mixed' ? 2 : 1);
      assert.equal(status[id].attentionAvailable, true);
      const queue = queueFor(status);
      assert.equal(queue.length, 1);
      assert.equal(queue[0].provider.id, id);
      assert.equal(queue[0].reason, activity === 'mixed' ? 'both' : activity);
    }
  });
}

test('all four request modules coexist in the screen queue and clear independently', () => {
  const config = applyTestPreset(defaultTestConfig(), 'idle');
  requestProviders.forEach((id, index) => { config[id].activity = index % 2 ? 'approval' : 'input'; });
  const current = makeTestStatus(config, sampledAt);
  const queue = queueFor(current);
  assert.equal(queue.length, 4);
  assert.equal(new Set(queue.map(item => item.key)).size, 4);
  assert.deepEqual(new Set(queue.map(item => item.provider.id)), new Set(requestProviders));
  const keys = new Map(queue.map(item => [item.provider.id, item.key]));
  config.antigravity.activity = 'idle';
  const next = queueFor(makeTestStatus(config, '2026-10-27T04:00:01Z'));
  assert.equal(next.length, 3);
  assert.ok(next.every(item => item.provider.id !== 'antigravity' && item.key === keys.get(item.provider.id)));
  assert.equal(queueFor(makeTestStatus(applyTestPreset(config, 'idle'), sampledAt)).length, 0);
});

test('existing Codex quick presets remain scoped and generic waits are not relabelled as questions', () => {
  const config = defaultTestConfig();
  const preset = applyTestPreset(config, 'approval');
  assert.equal(config.codex.activity, 'running');
  assert.equal(preset.codex.activity, 'approval');
  assert.equal(preset.antigravity.activity, 'running');
  assert.equal(preset.deepseek.activity, 'running');
  const waiting = applyTestPreset(defaultTestConfig(), 'idle');
  waiting.antigravity.activity = 'waiting';
  const status = makeTestStatus(waiting, sampledAt);
  assert.equal(status.antigravity.waitingReason, undefined);
  assert.equal(queueFor(status)[0].reason, 'waiting');
});
