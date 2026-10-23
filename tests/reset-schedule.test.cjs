const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadResetSchedule() {
  const file = path.join(__dirname, '../src/view/reset-schedule.ts');
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  new Function('module', 'exports', outputText)(module, module.exports);
  return module.exports;
}
const { selectResetRows } = loadResetSchedule();
const row = (id, model, at) => ({ view: { id }, quota: { model }, at });

test('collapsed Antigravity prefers normalized Gemini 4 Argon and retains chronological order', () => {
  const rows = [
    row('antigravity', 'Gemini 3.8 Flash', 1),
    row('claude', 'Claude Opus', 2),
    row('antigravity', '  gEmInI\t4  ARGON  ', 3),
    row('codex', 'GPT', 4),
    row('antigravity', 'Claude Sonnet', 5),
  ];
  const original = structuredClone(rows);
  const result = selectResetRows(rows, false);
  assert.deepEqual(result.rows, [rows[1], rows[2], rows[3]]);
  assert.equal(result.hiddenCount, 2);
  assert.equal(result.rows[1], rows[2], 'preserve the original row object');
  assert.deepEqual(rows, original, 'do not mutate caller data');
});

test('expanded Antigravity includes every model beyond eight rows while retaining seven other rows', () => {
  const rows = Array.from({ length: 20 }, (_, index) => row(index % 2 ? 'antigravity' : 'codex', index === 19 ? 'Gemini 4 Argon' : `Model ${index}`, index));
  const collapsed = selectResetRows(rows, false);
  assert.deepEqual(collapsed.rows.map(item => item.at), [0, 2, 4, 6, 8, 10, 12, 19]);
  assert.equal(collapsed.hiddenCount, 9);
  const expanded = selectResetRows(rows, true);
  assert.deepEqual(expanded.rows.map(item => item.at), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17, 19]);
  assert.equal(expanded.hiddenCount, 9, 'retain the extra-model count for the collapse control');
});

test('without the preferred exact model, collapsed Antigravity falls back to its earliest reset', () => {
  const rows = [row('codex', 'GPT', 1), row('antigravity', 'Gemini 4 Argon Preview', 2), row('antigravity', 'Claude Opus', 3)];
  assert.deepEqual(selectResetRows(rows, false), { rows: rows.slice(0, 2), hiddenCount: 1 });
  assert.deepEqual(selectResetRows(rows, true), { rows, hiddenCount: 1 });
});

test('without Antigravity, retain the original eight-row limit in either state', () => {
  const rows = Array.from({ length: 10 }, (_, index) => row('claude', `Model ${index}`, index));
  for (const expanded of [false, true]) {
    assert.deepEqual(selectResetRows(rows, expanded), { rows: rows.slice(0, 8), hiddenCount: 0 });
    assert.deepEqual(selectResetRows([], expanded), { rows: [], hiddenCount: 0 });
  }
});

test('a single Antigravity row needs no expand control; duplicate preferred models select the earliest', () => {
  const single = [row('antigravity', 'Claude Sonnet', 1)];
  for (const expanded of [false, true]) assert.deepEqual(selectResetRows(single, expanded), { rows: single, hiddenCount: 0 });
  const duplicates = [row('antigravity', 'Gemini 4 Argon', 1), row('antigravity', 'gemini 4 argon', 2)];
  assert.deepEqual(selectResetRows(duplicates, false), { rows: [duplicates[0]], hiddenCount: 1 });
});
