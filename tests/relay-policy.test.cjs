const test = require('node:test');
const assert = require('node:assert/strict');
const { validPreferences } = require('../electron/window-policy.cjs');
const { isRelayAgent, isRelayAgents, isRelayTaskId, relayEnvironmentAllowed, publicRelayState, publicRelayTasks } = require('../electron/relay-policy.cjs');
const id = '12345678-1234-4234-8234-123456789abc';
test('relay fixture requires all three explicit test controls; partial flags cannot use the real profile', () => {
  assert.equal(relayEnvironmentAllowed({}), true);
  const complete = { AI_WATCH_TEST_PROFILE: require('node:path').resolve('fixture-profile'), AI_WATCH_TEST_STATUS: 'fixture', AI_WATCH_TEST_RELAY: '1' };
  assert.equal(relayEnvironmentAllowed(complete), true);
  for (const key of Object.keys(complete)) {
    assert.equal(relayEnvironmentAllowed({ [key]: complete[key] }), false);
    const partial = { ...complete }; delete partial[key]; assert.equal(relayEnvironmentAllowed(partial), false);
  }
  for (const override of [{ AI_WATCH_TEST_PROFILE: '' }, { AI_WATCH_TEST_PROFILE: 'relative' }, { AI_WATCH_TEST_STATUS: 'live' }, { AI_WATCH_TEST_RELAY: '0' }]) assert.equal(relayEnvironmentAllowed({ ...complete, ...override }), false);
});
test('relay preferences are opt-in with strict booleans and unique supported agent IDs', () => {
  for (const value of [undefined, null, false, 1, 'true', {}, [true]]) assert.equal(validPreferences({ relayEnabled: value }).relayEnabled, false);
  assert.equal(validPreferences({ relayEnabled: true }).relayEnabled, true);
  for (const value of [undefined, null, 'claude', ['claude', 'claude'], ['codex', 'unknown'], [true], {}]) {
    assert.equal(isRelayAgents(value), false); assert.deepEqual(validPreferences({ relayAutoAgents: value }).relayAutoAgents, []);
  }
  for (const value of [[], ['claude'], ['codex'], ['codex', 'claude']]) {
    assert.equal(isRelayAgents(value), true); assert.deepEqual(validPreferences({ relayAutoAgents: value }).relayAutoAgents, value);
  }
  const original = ['claude']; const result = validPreferences({ relayAutoAgents: original }); original.push('codex');
  assert.deepEqual(result.relayAutoAgents, ['claude']);
});
test('relay agents and task IDs reject paths, arrays, prototype names and untrusted URL inputs', () => {
  assert.equal(isRelayTaskId(id), true);
  for (const value of [undefined, null, [id], {}, '../record', 'https://example.invalid', 'constructor', '__proto__', 'claude', `${id}\0`, id.toUpperCase()]) assert.equal(isRelayTaskId(value), false);
  for (const value of [undefined, null, {}, ['claude'], '__proto__', 'constructor', 'Claude', '../claude']) assert.equal(isRelayAgent(value), false);
});
test('renderer state projection never includes credentials or executable paths from adapters', () => {
  const state = publicRelayState({ running: true, endpoint: 'http://127.0.0.1:27841/mcp', agentCount: 2, queuedTasks: 4,
    lastEventAt: '2026-10-20T12:00:00Z', token: 'PRIVATE_TOKEN', directory: '/private/profile', error: '/private/error' },
  { agents: [{ id: 'claude', available: true, enabled: true, busy: false, sessionId: id, binaryPath: '/private/claude', lastError: '/private/worker' }] }, true);
  assert.equal(state.endpoint, 'http://127.0.0.1:27841/mcp'); assert.equal(state.agents[0].sessionId, id);
  assert.equal(state.error, 'relay-unavailable'); assert.equal(state.agents[0].lastError, 'worker-unavailable');
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE|private|binaryPath|token|directory/);
  for (const endpoint of ['http://localhost:27841/mcp', 'http://127.0.0.1:27841/mcp?token=private', 'http://user@127.0.0.1:27841/mcp', 'https://remote.invalid/mcp']) assert.equal(publicRelayState({ endpoint }).endpoint, null);
});
test('task list projection is capped and contains only display fields', () => {
  const input = { id, from: 'claude', to: 'codex', subject: '<script>alert(1)</script>', status: 'queued', updatedAt: '2026-10-20T12:00:00Z', instructions: 'PRIVATE', token: 'PRIVATE' };
  const tasks = publicRelayTasks(Array.from({ length: 60 }, () => input));
  assert.equal(tasks.length, 50); assert.deepEqual(Object.keys(tasks[0]), ['id', 'from', 'to', 'subject', 'status', 'updatedAt']);
  assert.equal(tasks[0].subject, input.subject); assert.doesNotMatch(JSON.stringify(tasks), /PRIVATE/);
  assert.deepEqual(publicRelayTasks([{ ...input, id: '../private' }]), []);
});
