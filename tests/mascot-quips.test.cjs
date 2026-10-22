const test = require('node:test');
const assert = require('node:assert/strict');
const quips = require('../src/view/quips.json');

const providers = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];

test('every agent has its own mascot lines, at least 200 in total', () => {
  assert.deepEqual(Object.keys(quips).sort(), [...providers].sort());
  const total = providers.reduce((sum, id) => sum + quips[id].length, 0);
  assert.ok(total >= 200, `only ${total} lines`);
  for (const id of providers) assert.ok(quips[id].length >= 20, `${id} has too few lines`);
});

test('each line has a Chinese and an English version that fit the bubble', () => {
  const seen = new Set();
  for (const id of providers) for (const [zh, en] of quips[id]) {
    assert.match(zh, /\p{Script=Han}/u, `${id}: ${zh}`);
    assert.doesNotMatch(en, /\p{Script=Han}/u, `${id}: ${en}`);
    assert.ok(zh.length <= 30 && en.length <= 80, `${id}: line too long`);
    assert.ok(!seen.has(zh) && !seen.has(en), `${id}: duplicate line`);
    seen.add(zh); seen.add(en);
  }
});
