const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { validPreferences, isMascotInterval, MASCOT_INTERVAL } = require('../electron/window-policy.cjs');

// The renderer helper is TypeScript; transpile it in memory to test the same source.
function loadCadence() {
  const file = path.join(__dirname, '../src/view/mascot-cadence.ts');
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  new Function('module', 'exports', outputText)(module, module.exports);
  return module.exports;
}
const cadence = loadCadence();

test('mascot interval preference accepts 0 (off) or whole seconds 5–300, defaulting to 15', () => {
  assert.equal(MASCOT_INTERVAL, 15);
  assert.equal(validPreferences({}).mascotInterval, 15);
  for (const value of [0, 5, 15, 120, 300]) {
    assert.equal(isMascotInterval(value), true, String(value));
    assert.equal(validPreferences({ mascotInterval: value }).mascotInterval, value);
  }
  for (const value of [4, 301, 15.5, -1, '15', null, NaN, Infinity, true, [15], {}]) {
    assert.equal(isMascotInterval(value), false, String(value));
    assert.equal(validPreferences({ mascotInterval: value }).mascotInterval, 15);
  }
});

test('renderer and main process agree on interval bounds; sliders never produce "off"', () => {
  for (const value of [0, 4, 5, 15, 300, 301, 7.5, '5', null]) assert.equal(cadence.isMascotInterval(value), isMascotInterval(value), String(value));
  assert.equal(cadence.MASCOT_INTERVAL_DEFAULT, MASCOT_INTERVAL);
  assert.equal(cadence.clampMascotInterval(0), 5);
  assert.equal(cadence.clampMascotInterval(999), 300);
  assert.equal(cadence.clampMascotInterval(12.4), 12);
  assert.equal(cadence.clampMascotInterval(NaN), 15);
});

test('while an agent works, auto refresh shows three quips then one status line', () => {
  const slots = Array.from({ length: 12 }, (_, index) => cadence.autoSlot(index + 1, true));
  assert.deepEqual(slots, ['quip', 'quip', 'quip', 'status', 'quip', 'quip', 'quip', 'status', 'quip', 'quip', 'quip', 'status']);
  assert.ok(Array.from({ length: 12 }, (_, index) => cadence.autoSlot(index + 1, false)).every(slot => slot === 'quip'));
  assert.equal(cadence.autoSlot(0, true), 'quip');
});

test('status slots rotate through every running agent', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(turn => cadence.featured(['a', 'b', 'c'], turn)), ['a', 'b', 'c', 'a', 'b']);
  assert.equal(cadence.featured([], 2), undefined);
  assert.equal(cadence.featured(['a', 'b'], -1), 'b');
});
