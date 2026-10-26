const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const previous = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { parseScreenHistory, matchingScreenHistory } = require('../src/screen-history.ts');
if (previous) require.extensions['.ts'] = previous;
else delete require.extensions['.ts'];

test('screen history never substitutes local quota readings for a remote host', () => {
  const now = Date.now();
  const local = parseScreenHistory({ kind: 'history', remote: false, host: null, journal: { samples: { codex: [[now, 75]] } } });
  const remote = parseScreenHistory({ kind: 'history', remote: true, host: 'host-a', journal: { samples: { codex: [[now, 12]] } } });
  assert.equal(matchingScreenHistory(local, true, 'host-a'), null);
  assert.equal(matchingScreenHistory(remote, false, null), null);
  assert.equal(matchingScreenHistory(remote, true, 'host-b'), null);
  assert.equal(matchingScreenHistory(remote, true, null), null);
  assert.deepEqual(matchingScreenHistory(remote, true, 'host-a').samples.codex, [[now, 12]]);
});

test('screen history carries bounded quota samples without task events or arbitrary fields', () => {
  const now = Date.now();
  const history = parseScreenHistory({ kind: 'history', remote: false, host: null, journal: {
    samples: { codex: Array.from({ length: 350 }, (_, i) => [now - (350 - i) * 1000, 88]), alien: [[now, 90]] },
    events: [{ at: now, id: 'codex', from: 'running', to: 'waiting', reason: 'approval' }],
    last: { codex: 'waiting' }, task: 'not part of history',
  } });
  assert.equal(history.journal.samples.codex.length, 300);
  assert.deepEqual(Object.keys(history.journal.samples), ['codex']);
  assert.deepEqual(history.journal.events, []);
  assert.deepEqual(history.journal.last, {});
  assert.equal(JSON.stringify(history).includes('not part of history'), false);
});

test('invalid or unrelated cross-window messages cannot replace the chart history', () => {
  for (const value of [null, [], { kind: 'request' }, { kind: 'history', remote: 'false', host: null, journal: {} },
    { kind: 'history', remote: false, host: {}, journal: {} }]) assert.equal(parseScreenHistory(value), null);
});
