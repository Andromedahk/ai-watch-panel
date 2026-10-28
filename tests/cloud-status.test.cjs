const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { randomUUID } = require('node:crypto');
const { CloudStatusController, projectStatus, normalizeEndpoint, INTERVAL } = require('../electron/cloud-status.cjs');

const secure = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`wrapped:${value}`), decryptString: value => value.toString().slice(8) };
const snapshot = () => projectStatus({ sampledAt: new Date().toISOString(), codex: { connection: 'ready', activity: 'waiting', waitingReason: 'approval', waitingTasks: 1,
  activeTasks: 2, task: 'PRIVATE TASK', detail: 'PRIVATE DETAIL', token: 'PRIVATE TOKEN',
  quotas: [{ model: 'Codex', period: '5 小时', remaining: 12.345, reset: '2099-01-01T00:00:00Z' }] } });
function fixture(t, extra = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-watch-cloud-test-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const calls = [];
  const instance = new CloudStatusController({ userData, safeStorage: secure, getSnapshot: async () => snapshot(),
    fetch: async (url, options) => {
      const body = JSON.parse((options.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(options.body) : options.body).toString());
      calls.push({ url, options, body }); return new Response(JSON.stringify({ ok: true, needSnapshot: false, commands: [] }));
    }, ...extra });
  t.after(() => instance.stop());
  instance.config = { enabled: true, endpoint: 'https://sync.example.test', allowActions: false };
  instance.token = 'test-only-credential-with-at-least-32-characters';
  return { instance, calls, userData };
}
test('cloud projection excludes raw provider data and marks unknown/stale/sample data', () => {
  const projected = snapshot();
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);
  assert.equal(projected.p.find(p => p.i === 'codex').q[0].r, 12.3);
  assert.equal(projected.p.find(p => p.i === 'codex').w, 'approval');
  const offline = projectStatus({ codex: { connection: 'offline', quotas: [{ remaining: 0 }] }, isTestData: true }, { enabledProviders: ['codex'], requests: [{ id: 'private' }] });
  assert.equal(offline.p.length, 1); assert.equal(offline.p[0].q[0].s, true); assert.equal(offline.sample, true); assert.deepEqual(offline.requests, []);
  const stale = projectStatus({ sampledAt: new Date(1000).toISOString(), codex: { connection: 'ready', quotas: [{ remaining: 1 }] } }, { now: 32000, requests: [{ id: 'expired-source' }] });
  assert.equal(stale.stale, true); assert.equal(stale.p.find(p => p.i === 'codex').q[0].s, true); assert.deepEqual(stale.requests, []);
  const requests = [{ id: 'large', detail: 'x'.repeat(66000) }, { id: 'small', detail: 'Complete prompt' }];
  const bounded = projectStatus({ sampledAt: new Date().toISOString() }, { requests });
  assert.equal(bounded.limited, true); assert.deepEqual(bounded.requests, [requests[1]]);
  assert.equal(projectStatus({}).stale, true);
});
test('endpoint rejects plaintext, credentials, paths and redirects cannot be followed', async t => {
  for (const value of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test/?token=x', 'file:///tmp/test', 'https://example.test/#x']) assert.throws(() => normalizeEndpoint(value));
  assert.equal(normalizeEndpoint('https://example.test/'), 'https://example.test');
  assert.equal(normalizeEndpoint('http://127.0.0.1:4000', true), 'http://127.0.0.1:4000');
  assert.throws(() => normalizeEndpoint('http://192.168.1.1', true));
  const { instance, calls } = fixture(t); await instance.tick(); assert.equal(calls[0].options.redirect, 'error');
});
test('unchanged state uses small 5s heartbeat, server resync restores snapshot', async t => {
  const { instance, calls } = fixture(t);
  await instance.tick(); await instance.tick();
  assert.ok(calls[0].body.snapshot); assert.equal(calls[1].body.snapshot, undefined);
  assert.equal(calls[0].body.h, calls[1].body.h); assert.equal(calls[1].body.n, 2);
  assert.ok(calls[1].options.body.length < 250); assert.equal(INTERVAL, 5000);
  instance.fetch = async () => new Response(JSON.stringify({ ok: true, needSnapshot: true, commands: [] }));
  await instance.tick(); assert.equal(instance.lastHash, '');
});
test('tokens stay out of summary and are encrypted in separate config; insecure fallback rejected', async t => {
  const { instance, userData } = fixture(t);
  instance.save();
  assert.equal(JSON.stringify(instance.summary()).includes(instance.token), false);
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'cloud-sync.json'), 'utf8'));
  assert.equal(saved.token, undefined); assert.ok(saved.encryptedToken);
  assert.equal(fs.statSync(path.join(userData, 'cloud-sync.json')).mode & 0o777, 0o600);
  instance.safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' };
  assert.throws(() => instance.configure({ enabled: true, endpoint: 'https://sync.example.test', allowActions: false }), /secure-storage/);
});
test('full-content sharing is default-off, explicitly persisted and reset when actions are disabled or forgotten', async t => {
  const { instance, userData } = fixture(t); const seen = [];
  instance.getSnapshot = async (...flags) => { seen.push(flags); return snapshot(); };
  const fresh = new CloudStatusController({ userData, safeStorage: secure });
  assert.equal(fresh.summary().uploadFullContent, false);
  instance.configure({ enabled: false, endpoint: 'https://sync.example.test', allowActions: true, uploadFullContent: true });
  const restored = new CloudStatusController({ userData, safeStorage: secure });
  assert.equal(restored.summary().uploadFullContent, true);
  instance.config.enabled = true; await instance.tick(); assert.deepEqual(seen[0], [true, true]);
  instance.configure({ enabled: false, endpoint: 'https://sync.example.test', allowActions: false, uploadFullContent: true });
  assert.equal(instance.summary().uploadFullContent, false);
  assert.throws(() => instance.configure({ enabled: false, endpoint: '', allowActions: true, uploadFullContent: 'true' }), /invalid-config/);
  instance.forget(); assert.equal(instance.summary().uploadFullContent, false);
});
test('stopping in-flight HTTP drops late commands and late successful status', async t => {
  let resolve;
  const { instance } = fixture(t, { fetch: () => new Promise(done => { resolve = done; }) });
  const pending = instance.tick(); await new Promise(done => setImmediate(done)); instance.stop();
  resolve(new Response(JSON.stringify({ ok: true, needSnapshot: false, commands: [{ id: randomUUID() }] })));
  await pending; assert.equal(instance.state, 'off'); assert.equal(instance.lastSyncedAt, null);
});
test('failed transport retries without leaking network response or credentials', async t => {
  const { instance } = fixture(t, { fetch: async () => { throw new Error('PRIVATE secret'); } });
  await instance.tick(); assert.equal(instance.state, 'error'); assert.equal(instance.error, 'connection-failed');
});
test('command replay is deduplicated durably, expiry and disabled actions fail closed', async t => {
  let executed = 0;
  const { instance, userData } = fixture(t, { actions: { execute: async command => { executed++; return { id: command.id, status: 'succeeded' }; } } });
  const command = { id: randomUUID(), requestId: 'r', kind: 'approve', expiresAt: Date.now() + 30000 };
  await instance.execute(command, instance.generation); assert.equal(executed, 0); assert.equal(instance.ledger[command.id].error, 'remote-actions-disabled');
  instance.config.allowActions = true; await instance.execute(command, instance.generation); assert.equal(executed, 0);
  const live = { ...command, id: randomUUID() }; await instance.execute(live, instance.generation); await instance.execute(live, instance.generation); assert.equal(executed, 1);
  const restored = new CloudStatusController({ userData, safeStorage: secure, actions: instance.actions });
  restored.config.allowActions = true; await restored.execute(live, restored.generation); assert.equal(executed, 1);
  await instance.execute({ ...command, id: randomUUID(), expiresAt: Date.now() - 1 }, instance.generation); assert.equal(executed, 1);
});
test('pending action does not delay state sync or publish an interrupted result', async t => {
  let resolve;
  const { instance, calls } = fixture(t, { actions: { execute: () => new Promise(done => { resolve = done; }) } });
  instance.config.allowActions = true;
  const id = randomUUID(); const action = instance.execute({ id, requestId: 'r', kind: 'approve', expiresAt: Date.now() + 30000 }, instance.generation);
  await instance.tick(); assert.equal(calls[0].body.results, undefined);
  resolve({ id, status: 'succeeded' }); await action; await instance.tick();
  assert.deepEqual(calls[1].body.results, [{ id, status: 'succeeded' }]);
  await instance.tick(); assert.equal(calls[2].body.results, undefined);
});
test('result batches obey server cap and snapshot-resync does not acknowledge unprocessed receipts', async t => {
  const { instance, calls } = fixture(t);
  for (let i = 0; i < 70; i++) { const id = randomUUID(); instance.ledger[id] = { id, status: 'succeeded', at: Date.now() }; }
  await instance.tick(); await instance.tick(); await instance.tick();
  assert.equal(calls[0].body.results.length, 64); assert.equal(calls[1].body.results.length, 6); assert.equal(calls[2].body.results, undefined);
  const id = randomUUID(); instance.ledger[id] = { id, status: 'succeeded', at: Date.now() };
  instance.fetch = async () => new Response(JSON.stringify({ ok: true, needSnapshot: true, commands: [] }));
  await instance.tick(); assert.equal(instance.acknowledged.has(`${id}:succeeded:`), false);
});
