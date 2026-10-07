const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanupOrphanedHelpers } = require('../electron/orphan-helpers.cjs');
const renderer = '/Applications/AI Watch.app/Contents/Frameworks/AI Watch Helper (Renderer).app/Contents/MacOS/AI Watch Helper (Renderer)';
function fixture({ rows = `200 1 ${renderer}`, probes = [`200 1 ${renderer}`, ''], identifier = 'app.aiwatch.panel', killError = null } = {}) {
  const calls = [], signals = [], waits = [];
  const runCommand = async (binary, args) => {
    calls.push([binary, args]);
    if (binary === 'plutil') return identifier;
    if (args[0] === '-ax') return rows;
    const next = probes.shift();
    if (next instanceof Error) throw next;
    return next || '';
  };
  return { calls, signals, waits, options: { platform: 'darwin', packaged: true, selfPid: 999,
    runCommand, kill: (pid, signal) => { if (killError) throw killError; signals.push([pid, signal]); }, wait: async ms => waits.push(ms) } };
}
test('orphan recovery is disabled for development and other operating systems', async () => {
  for (const option of [{ packaged: false }, { platform: 'win32' }, { platform: 'linux' }]) {
    const f = fixture(); const r = await cleanupOrphanedHelpers({ ...f.options, ...option });
    assert.equal(r.checked, 0); assert.deepEqual(f.calls, []); assert.deepEqual(f.signals, []);
  }
});
test('only exact parentless renderer executable and product identifier qualify', async () => {
  const f = fixture({ rows: [`200 1 ${renderer}`, `201 999 ${renderer}`, `202 1 /Applications/Claude.app/Contents/MacOS/Claude`,
    `203 1 ${renderer.replace('(Renderer)', '(GPU)')}`, `204 1 ${renderer}.other`, `205 1 /Applications/../Applications${renderer}`].join('\n') });
  const r = await cleanupOrphanedHelpers(f.options);
  assert.equal(r.checked, 1); assert.equal(r.stopped, 1); assert.deepEqual(f.signals, [[200, 'SIGTERM']]);
  const plist = f.calls.find(call => call[0] === 'plutil');
  assert.equal(plist[1].at(-1), '/Applications/AI Watch.app/Contents/Info.plist');
});
test('a different or unreadable bundle identifier never receives a signal', async () => {
  for (const identifier of ['other.product', '']) {
    const f = fixture({ identifier }); const r = await cleanupOrphanedHelpers(f.options);
    assert.equal(r.skipped, 1); assert.deepEqual(f.signals, []);
  }
});
test('PID reuse or a new parent between enumeration and signal is skipped', async () => {
  for (const probe of [`200 44 ${renderer}`, '200 1 /Applications/Other.app/Contents/MacOS/Other', '']) {
    const f = fixture({ probes: [probe] }); const r = await cleanupOrphanedHelpers(f.options);
    assert.equal(r.skipped, 1); assert.deepEqual(f.signals, []);
  }
});
test('SIGKILL is sent only after grace and repeated unchanged identity checks', async () => {
  const same = `200 1 ${renderer}`;
  const f = fixture({ probes: [same, same, same, ''] }); const r = await cleanupOrphanedHelpers(f.options);
  assert.equal(r.stopped, 1); assert.equal(r.signalsSent, 2); assert.deepEqual(f.signals, [[200, 'SIGTERM'], [200, 'SIGKILL']]);
  assert.deepEqual(f.waits, [1000, 100]); assert.equal(f.calls.filter(call => call[1][0] === '-p').length, 4);
});
test('identity change before escalation stops without SIGKILL', async () => {
  const same = `200 1 ${renderer}`;
  const f = fixture({ probes: [same, same, `200 123 ${renderer}`] }); const r = await cleanupOrphanedHelpers(f.options);
  assert.equal(r.skipped, 1); assert.deepEqual(f.signals, [[200, 'SIGTERM']]);
});
test('unreadable status and denied signals are reported without unsafe escalation', async () => {
  const f = fixture({ probes: [new Error('Unavailable')] }); const r = await cleanupOrphanedHelpers(f.options);
  assert.equal(r.errors, 1); assert.deepEqual(r.remaining, [200]); assert.deepEqual(f.signals, []);
  const g = fixture({ killError: Object.assign(new Error('Denied'), { code: 'EPERM' }) }); const s = await cleanupOrphanedHelpers(g.options);
  assert.equal(s.errors, 1); assert.deepEqual(g.signals, []); assert.deepEqual(g.waits, []);
});
test('an already disappeared helper is treated as stopped after an ESRCH race', async () => {
  const f = fixture({ killError: Object.assign(new Error('Gone'), { code: 'ESRCH' }) });
  const r = await cleanupOrphanedHelpers(f.options); assert.equal(r.stopped, 1); assert.equal(r.errors, 0);
});
test('self PID, unbounded candidate lists and malformed process rows are excluded', async () => {
  const f = fixture({ rows: [`999 1 ${renderer}`, `200 1 ${renderer}`, `201 1 ${renderer}`, `not-a-process`].join('\n') });
  const r = await cleanupOrphanedHelpers({ ...f.options, maxCandidates: 1 }); assert.equal(r.checked, 1); assert.deepEqual(f.signals, [[200, 'SIGTERM']]);
});
test('a helper surviving both signals remains explicitly reported', async () => {
  const same = `200 1 ${renderer}`;
  const f = fixture({ probes: [same, same, same, same] }); const r = await cleanupOrphanedHelpers(f.options);
  assert.deepEqual(r.remaining, [200]); assert.equal(r.stopped, 0);
});
