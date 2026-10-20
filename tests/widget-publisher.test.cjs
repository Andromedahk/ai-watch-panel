const test = require('node:test');
const assert = require('node:assert/strict');
const { WidgetPublisher, loadWidgetBridge } = require('../electron/widget-publisher.cjs');

const preferences = { widgetsEnabled: true, enabledProviders: ['codex'], theme: 'dark' };
function fixture() {
  let now = Date.parse('2026-10-09T12:00:00Z');
  const calls = [];
  const bridge = { available: () => true, publish: (json, reload) => { calls.push({ value: JSON.parse(json), reload }); return true; }, clear: () => { calls.push('clear'); return true; } };
  const publisher = new WidgetPublisher({ bridge, now: () => now });
  const snapshot = () => ({ sampledAt: new Date(now).toISOString(), codex: { connection: 'ready', activity: 'idle',
    sampledAt: new Date(now).toISOString(), quotas: [{ model: 'Codex', period: '1 周', remaining: 0 }] } });
  return { publisher, bridge, calls, snapshot, advance(ms) { now += ms; } };
}
test('native widgets are opt-in and unavailable builds cannot write', () => {
  const f = fixture();
  assert.equal(f.publisher.publish(f.snapshot(), { ...preferences, widgetsEnabled: false }), false);
  assert.equal(f.calls.length, 0);
  const unavailable = new WidgetPublisher();
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.publish({}, preferences), false);
  assert.equal(loadWidgetBridge({ app: {}, platform: 'linux' }), null);
  assert.equal(loadWidgetBridge({ app: { isPackaged: false }, platform: 'darwin' }), null);
});
test('coalesces polling, writes heartbeat and budgets timeline requests', () => {
  const f = fixture();
  assert.equal(f.publisher.publish(f.snapshot(), preferences), true);
  f.advance(5000); f.publisher.publish(f.snapshot(), preferences);
  assert.equal(f.calls.length, 1);
  f.advance(55000); f.publisher.publish(f.snapshot(), preferences);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].reload, false);
  f.advance(240000); f.publisher.publish(f.snapshot(), preferences);
  assert.equal(f.calls[2].reload, true);
  f.advance(1); f.publisher.publish(f.snapshot(), { ...preferences, enabledProviders: [] });
  assert.deepEqual(f.calls[3].value.rows, []); assert.equal(f.calls[3].reload, true);
});
test('account clearing writes immediately and failures can be retried', () => {
  const f = fixture();
  f.publisher.publish(f.snapshot(), preferences);
  const status = f.snapshot(); status.codex.connection = 'auth-required';
  f.publisher.publish(status, preferences);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].value.rows[0].remaining, null);
  assert.equal(f.calls[1].reload, true);
  f.bridge.publish = () => { throw new Error('failure'); };
  f.advance(60000);
  assert.equal(f.publisher.publish(status, preferences), false); assert.equal(f.publisher.error, true);
  f.bridge.publish = () => true;
  assert.equal(f.publisher.publish(status, preferences), true); assert.equal(f.publisher.error, false);
  assert.equal(f.publisher.clear(), true); assert.equal(f.publisher.lastPublishedAt, null);
  f.bridge.clear = () => false;
  assert.equal(f.publisher.clear(), false); assert.equal(f.publisher.error, true);
});
