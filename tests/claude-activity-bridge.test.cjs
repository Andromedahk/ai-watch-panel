const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaudeActivityBridge } = require('../electron/claude-activity-bridge.cjs');
const healthy = { trusted: true, supported: true, activity: 'running', plan: 'Pro', complete: true };
const base = { trusted: true, supported: true, activity: 'unknown', plan: null, complete: false };

function fixture({ permission = true, result = healthy, permissionError, helperError, platform = 'darwin' } = {}) {
  const permissions = [], probes = [];
  const reader = createClaudeActivityBridge({ platform,
    permissionReader: async prompt => { permissions.push(prompt); if (permissionError) throw permissionError; return permission; },
    readActivity: async (pid, options) => { probes.push({ pid, options }); if (helperError) throw helperError; return result; },
  });
  return { reader, permissions, probes };
}

test('activity bridge requires explicit main permission and activity dependencies', () => {
  assert.throws(() => createClaudeActivityBridge(), /Invalid Claude activity bridge/);
  assert.throws(() => createClaudeActivityBridge({ permissionReader: () => true, readActivity: null }), /Invalid Claude activity bridge/);
});
test('non-macOS requests never read real permission or execute a helper', async () => {
  for (const platform of ['win32', 'linux']) {
    const f = fixture({ platform });
    assert.deepEqual(await f.reader(10, { requestAccess: true }), { ...base, trusted: null, supported: false, probeError: 'unsupported-platform' });
    assert.deepEqual(await f.reader(10, { platform: 'darwin', requestAccess: true }), { ...base, trusted: null, supported: false, probeError: 'unsupported-platform' });
    assert.deepEqual(f.permissions, []); assert.deepEqual(f.probes, []);
  }
  const f = fixture();
  await f.reader(10, { platform: 'linux', requestAccess: true });
  assert.deepEqual(f.permissions, []); assert.deepEqual(f.probes, []);
});
test('only an explicit boolean request prompts main; consent requests do not execute the helper', async () => {
  const f = fixture();
  assert.deepEqual(await f.reader(null, { requestAccess: true }), base);
  assert.deepEqual(f.permissions, [true]); assert.deepEqual(f.probes, []);
  for (const requestAccess of [undefined, false, 1, 'true', {}]) {
    assert.deepEqual(await f.reader(10, { requestAccess }), healthy);
  }
  assert.deepEqual(f.permissions, [true, false, false, false, false, false]);
  assert.ok(f.probes.every(probe => probe.pid === 10 && probe.options.platform === 'darwin' && probe.options.requestAccess === false));
});
test('a denied main permission stops before executing the helper', async () => {
  for (const requestAccess of [false, true]) {
    const f = fixture({ permission: false });
    assert.deepEqual(await f.reader(10, { requestAccess }), { ...base, trusted: false });
    assert.deepEqual(f.permissions, [requestAccess]); assert.deepEqual(f.probes, []);
  }
});
test('main permission failures remain indeterminate without exposing error details or invoking helper', async () => {
  for (const options of [{ permissionError: new Error('PRIVATE PATH /private/example') }, { permission: null }, { permission: 'true' }]) {
    const f = fixture(options);
    const result = await f.reader(10);
    assert.deepEqual(result, { ...base, trusted: null, probeError: 'permission-check-failed' });
    assert.deepEqual(f.probes, []); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private\/example/);
  }
});
test('main approval remains true when the helper cannot inherit access, even if failure carries unsafe state', async () => {
  const f = fixture({ result: { ...healthy, trusted: false, secret: 'PRIVATE' } });
  const result = await f.reader(10);
  assert.deepEqual(result, { ...base, probeError: 'helper-access-denied' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|running|Pro/);
});
test('helper execution errors retain main approval and never accept accompanying activity or plan', async () => {
  for (const probeError of ['helper-missing', 'helper-blocked', 'timeout', 'helper-failed', 'invalid-output']) {
    const f = fixture({ result: { ...healthy, trusted: null, probeError } });
    assert.deepEqual(await f.reader(10), { ...base, probeError });
  }
  for (const [code, probeError] of [['ENOENT', 'helper-missing'], ['EACCES', 'helper-blocked'],
    ['ETIMEDOUT', 'timeout'], ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'invalid-output'], ['OTHER', 'helper-failed']]) {
    const f = fixture({ helperError: Object.assign(new Error('PRIVATE PATH /private/example'), { code }) });
    assert.deepEqual(await f.reader(10), { ...base, probeError });
  }
});
test('healthy results are strictly validated and private helper fields never leave the bridge', async () => {
  const f = fixture({ result: { ...healthy, secret: 'PRIVATE', path: '/private/example' } });
  assert.deepEqual(await f.reader(10), healthy);
  for (const result of [null, [], { ...healthy, trusted: null }, { ...healthy, supported: false },
    { ...healthy, activity: 'fake' }, { ...healthy, plan: 'PRIVATE' }, { ...healthy, complete: undefined },
    { ...healthy, probeError: 'PRIVATE /private/example' }]) {
    assert.deepEqual(await fixture({ result }).reader(10), { ...base, probeError: 'invalid-output' });
  }
});
test('invalid process IDs cannot reach the helper even after main consent', async () => {
  const f = fixture();
  for (const pid of [null, '10', 0, -1, 1.5, 2147483648]) {
    assert.deepEqual(await f.reader(pid), { ...base, probeError: 'invalid-pid' });
  }
  assert.deepEqual(f.probes, []);
});
