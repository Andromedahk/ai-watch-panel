'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { CloudService } = require('./service.cjs');
const { attention } = require('./attention.cjs');
const { digest, validateDevice } = require('./validation.cjs');
const { FcmPush, ApnsPush } = require('./push.cjs');
const { createServer } = require('./server.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('./store.cjs');
const NOW = 1900000000000;
const START = 'a'.repeat(64), UPDATE = 'b'.repeat(64);
const snapshot = (kind = 'input') => ({ sample: false, p: [{ i: 'codex', c: 'ready', a: 'waiting', n: 1, w: kind, q: [{ m: 'Codex', p: 'week', r: 10 }] }],
  requests: [{ id: 'codex-' + (kind === 'input' ? '1' : '2').repeat(64), provider: 'codex', kind, title: kind === 'input' ? 'codex.input' : 'codex.fileApproval',
    detail: kind === 'input' ? 'input' : 'fileChange', expiresAt: NOW + 600000,
    ...(kind === 'input' ? { questions: [{ id: '3'.repeat(64), header: 'question.1', question: 'review.questionOnDesktop', options: [], isOther: true }] } : {}) }] });
function fixture(platform = 'ios', push) {
  let now = NOW, seq = 0; const sent = [], owner = randomUUID(), desktop = randomUUID(), session = randomUUID();
  const service = new CloudService({ now: () => now, push: push || (async (device, event) => { sent.push(structuredClone({ device, event })); return { ok: true }; }) });
  service.pair({ id: owner, name: 'Test', platform });
  const sync = (s = snapshot()) => service.sync({ v: 1, d: desktop, s: session, n: ++seq, t: now, h: digest(s), snapshot: s });
  sync();
  return { service, owner, sent, sync, advance(ms) { now += ms; }, start() { service.registerActivity({ type: 'start', token: START, environment: 'sandbox' }, owner); },
    update(token = UPDATE, activityId = 'activity-1') { service.registerActivity({ type: 'update', token, activityId, environment: 'sandbox' }, owner); } };
}
test('attention contains only bounded counts, fixed provider and short lease; excludes quota events and stale/sample/offline sources', () => {
  const f = fixture(); const state = attention(f.service).contentState;
  assert.deepEqual(state, { inputCount: 1, approvalCount: 0, provider: 'codex', updatedAt: NOW / 1000, expiresAt: NOW / 1000 + 90 });
  for (const extra of [{ sample: true }, { stale: true }]) { f.sync({ ...snapshot(), ...extra }); assert.equal(attention(f.service).active, false); }
  f.sync(); f.advance(20001); assert.equal(f.service.state().attention.inputCount, 0);
});
test('activity registration requires iOS owner, strict token/type fields and isolates token ownership', () => {
  const f = fixture('android'); assert.throws(f.start, /ios-required/);
  const i = fixture(); assert.throws(() => i.service.registerActivity({ type: 'start', token: START, environment: 'sandbox', content: 'private' }, i.owner), /invalid-body/);
  assert.throws(() => i.service.registerActivity({ type: 'update', token: UPDATE, environment: 'sandbox' }, i.owner), /invalid-body/);
  i.start(); const other = randomUUID(); i.service.pair({ id: other, platform: 'ios', name: 'Other' });
  assert.throws(() => i.service.registerActivity({ type: 'start', token: START, environment: 'sandbox' }, other), /activity-token-in-use/);
});
test('push-to-start is sent once until update token arrives, including unknown transport results', async () => {
  for (const ok of [true, false]) {
    let calls = 0; const f = fixture('ios', async () => { calls++; return ok ? { ok: true } : { retry: true }; }); f.start();
    await f.service.live.process(); f.advance(11000); f.sync(snapshot('approval')); await f.service.live.process();
    assert.equal(calls, 1);
  }
});
test('update registration replaces start and publishes through the activity token', async () => {
  const f = fixture(); f.start(); f.update(); await f.service.live.process();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].device.token, UPDATE); assert.equal(f.sent[0].event.phase, 'update');
  f.advance(1000); f.sync(snapshot('approval')); await f.service.live.process(); assert.equal(f.sent.length, 1);
  f.advance(9000); await f.service.live.process(); assert.equal(f.sent[1].event.contentState.approvalCount, 1);
});
test('missing APNs configuration does not permanently consume the start cycle', async () => {
  let calls = 0; const f = fixture('ios', async () => ++calls === 1 ? { retry: true, error: 'apns-not-configured' } : { ok: true });
  f.start(); await f.service.live.process(); f.advance(10000); f.sync(); await f.service.live.process(); assert.equal(calls, 1);
  f.advance(50000); f.sync(); await f.service.live.process(); assert.equal(calls, 2);
});
test('attention updates coalesce to the newest counts and enforce ten-second spacing', async () => {
  const f = fixture('android'); f.service.register({ id: f.owner, platform: 'android', token: 'f'.repeat(40), liveUpdates: true }, f.owner);
  await f.service.live.process(); f.advance(1000); f.sync(snapshot('approval')); f.advance(1000); f.sync();
  await f.service.live.process(); assert.equal(f.sent.length, 1);
  f.advance(8000); await f.service.live.process(); assert.equal(f.sent.length, 1, 'returning to already delivered state must cancel the obsolete queued approval');
  const both = snapshot(); both.requests.push(snapshot('approval').requests[0]); both.p[0].w = 'both'; f.sync(both);
  await f.service.live.process(); assert.equal(f.sent[1].event.contentState.inputCount, 1); assert.equal(f.sent[1].event.contentState.approvalCount, 1);
});
test('cleared and offline activities end immediately without waiting for the update interval', async () => {
  for (const offline of [false, true]) {
    const f = fixture(); f.start(); f.update(); await f.service.live.process();
    if (offline) f.advance(20001); else { f.advance(1000); f.sync({ sample: false, p: [], requests: [] }); }
    await f.service.live.process(); assert.equal(f.sent.at(-1).event.phase, 'end'); assert.equal(f.service.live.target(f.owner).updateToken, undefined);
    assert.equal(f.sent.at(-1).event.contentState.inputCount, 0);
  }
});
test('dismissed activity preserves start token without recreating the same pending cycle', async () => {
  const f = fixture(); f.start(); f.update(); await f.service.live.process();
  f.service.removeActivity({ activityId: 'activity-1' }, f.owner); f.advance(10000); f.sync(); await f.service.live.process();
  assert.equal(f.sent.length, 1); assert.equal(f.service.live.target(f.owner).startToken, START);
  f.sync({ sample: false, p: [], requests: [] }); f.sync(snapshot('approval')); await f.service.live.process();
  assert.equal(f.sent.at(-1).event.phase, 'start');
});
test('deleting an old activity cannot retire its replacement', async () => {
  const f = fixture(); f.update(UPDATE, 'new'); f.service.removeActivity({ activityId: 'old' }, f.owner);
  assert.equal(f.service.live.target(f.owner).activityId, 'new');
});
test('opt-out and revoked installations send only final clear state and cannot keep sending attention', async () => {
  for (const revoke of [false, true]) {
    const f = fixture(); f.start(); f.update(); await f.service.live.process();
    if (revoke) f.service.revoke(f.owner); else f.service.removeActivity({}, f.owner);
    await f.service.live.process(); f.advance(10000); await f.service.live.process();
    assert.equal(f.sent.length, 2); assert.equal(f.sent.at(-1).event.phase, 'end'); assert.equal(f.service.live.target(f.owner), undefined);
  }
});
test('Android devices receive attention only with explicit liveUpdates opt-in and end on opt-out', async () => {
  const f = fixture('android'); const d = { id: f.owner, platform: 'android', token: 'x'.repeat(40) };
  f.service.register(d, f.owner); await f.service.live.process(); assert.equal(f.sent.length, 0);
  f.service.register({ ...d, liveUpdates: true }, f.owner); await f.service.live.process(); assert.equal(f.sent.length, 1);
  f.service.register({ ...d, liveUpdates: false }, f.owner); await f.service.live.process(); assert.equal(f.sent[1].event.phase, 'end');
});
test('late response from replaced token cannot acknowledge new pending work', async () => {
  let finish; const f = fixture('ios', () => new Promise(resolve => { finish = resolve; })); f.update(); const work = f.service.live.process();
  f.update('c'.repeat(64), 'new'); finish({ ok: true }); await work;
  assert.equal(f.service.live.target(f.owner).pending.token, 'c'.repeat(64));
});
test('device registration accepts only known transports and validates local OEM activity ids', () => {
  const d = { id: randomUUID(), platform: 'android', token: 'x'.repeat(40) };
  validateDevice({ ...d, transport: 'vpush', liveActivity: { notificationId: 3001, locallyCreated: true } });
  assert.throws(() => validateDevice({ ...d, transport: 'invented' }), /invalid-body/);
  assert.throws(() => validateDevice({ ...d, liveActivity: { notificationId: -1, locallyCreated: true } }), /invalid-body/);
  const f = fixture('android'); assert.throws(() => f.service.register({ ...d, id: f.owner, transport: 'opush' }, f.owner), /opush-transport-not-integrated/);
});
test('first Android update in flight is ended on opt-out or revoke using the old device snapshot', async () => {
  for (const revoke of [false, true]) {
    let finish; const sent = [];
    const f = fixture('android', async (device, event) => {
      sent.push(structuredClone({ device, event }));
      if (sent.length === 1) return new Promise(resolve => { finish = resolve; });
      return { ok: true };
    });
    const d = { id: f.owner, platform: 'android', transport: 'mipush', token: 'm'.repeat(40), liveUpdates: true,
      liveActivity: { notificationId: 101, locallyCreated: false } };
    f.service.register(d, f.owner); const initial = f.service.live.process();
    if (revoke) f.service.revoke(f.owner); else f.service.register({ ...d, liveUpdates: false }, f.owner);
    assert.equal(f.service.live.target(f.owner), undefined);
    assert.equal(f.service.data.liveTargets[0].pending.phase, 'end');
    finish({ ok: true }); await initial; await f.service.live.process();
    assert.equal(sent.length, 2); assert.equal(sent[1].event.phase, 'end');
    assert.equal(sent[1].device.token, d.token); assert.equal(sent[1].device.liveActivity.notificationId, 101);
    assert.ok(sent[1].event.timestamp > sent[0].event.timestamp);
    assert.equal(f.service.data.liveTargets.length, 0);
  }
});
test('Android identity replacement retires the old ID and updates the new ID immediately with increasing sequence', async () => {
  let finish; const sent = [];
  const f = fixture('android', async (device, event) => {
    sent.push(structuredClone({ device, event }));
    if (sent.length === 1) return new Promise(resolve => { finish = resolve; });
    return { ok: true };
  });
  const d = { id: f.owner, platform: 'android', transport: 'vpush', token: 'v'.repeat(40), liveUpdates: true,
    liveActivity: { notificationId: 101, locallyCreated: true } };
  f.service.register(d, f.owner); const first = f.service.live.process();
  f.service.register({ ...d, liveActivity: { notificationId: 202, locallyCreated: true } }, f.owner);
  assert.equal(f.service.data.liveTargets.length, 2);
  assert.equal(f.service.live.target(f.owner).device.liveActivity.notificationId, 202);
  finish({ ok: true }); await first; await f.service.live.process();
  assert.deepEqual(sent.map(x => [x.device.liveActivity.notificationId, x.event.phase]), [[101, 'update'], [101, 'end'], [202, 'update']]);
  assert.ok(sent[0].event.timestamp < sent[1].event.timestamp && sent[1].event.timestamp < sent[2].event.timestamp);
  assert.equal(f.service.data.liveTargets.length, 1);
  f.service.register({ ...d, liveActivity: { notificationId: 202, locallyCreated: false } }, f.owner);
  await f.service.live.process();
  assert.deepEqual(sent.slice(-2).map(x => x.event.phase), ['end', 'update']);
  assert.ok(sent.at(-1).event.timestamp > sent.at(-2).event.timestamp);
});
test('Android token replacement keeps the retiring token and never acknowledges the new target from a late response', async () => {
  let finish; const f = fixture('android', () => new Promise(resolve => { finish = resolve; }));
  const d = { id: f.owner, platform: 'android', token: 'a'.repeat(40), liveUpdates: true };
  f.service.register(d, f.owner); const first = f.service.live.process();
  f.service.register({ ...d, token: 'b'.repeat(40) }, f.owner);
  finish({ ok: true }); await first;
  assert.equal(f.service.data.liveTargets.find(t => t.retired).pending.token, d.token);
  assert.equal(f.service.live.target(f.owner).pending.token, 'b'.repeat(40));
  assert.equal(f.service.live.target(f.owner).lastActive, undefined);
});
test('iOS dismissal suppresses the entire continuous waiting cycle including changed requests and offline intervals', async () => {
  const f = fixture(); f.start(); f.update(); await f.service.live.process();
  f.service.removeActivity({ activityId: 'activity-1' }, f.owner);
  f.advance(10000); f.sync(snapshot('approval')); await f.service.live.process();
  assert.equal(f.sent.length, 1);
  f.advance(20001); await f.service.live.process(); f.sync(); await f.service.live.process();
  assert.equal(f.sent.length, 1, 'offline must not re-arm dismissed activities');
  f.sync({ sample: false, p: [], requests: [] }); f.sync(snapshot('approval')); await f.service.live.process();
  assert.equal(f.sent.at(-1).event.phase, 'start'); assert.equal(f.sent.length, 2);
});
test('explicit iOS disable and re-enable clears dismissal even while requests remain', async () => {
  const f = fixture(); f.start(); f.update(); await f.service.live.process();
  f.service.removeActivity({ activityId: 'activity-1' }, f.owner);
  f.service.removeActivity({}, f.owner); f.start(); await f.service.live.process();
  assert.equal(f.sent.at(-1).event.phase, 'start'); assert.equal(f.sent.length, 2);
});
test('retiring targets are bounded, survive storage reload and expire without reset retry budgets', async t => {
  const f = fixture('android', async () => ({ retry: true }));
  const d = { id: f.owner, platform: 'android', transport: 'vpush', token: 'v'.repeat(40), liveUpdates: true,
    liveActivity: { notificationId: 1, locallyCreated: true } };
  for (let id = 1; id <= 64; id++) f.service.register({ ...d, liveActivity: { notificationId: id, locallyCreated: true } }, f.owner);
  assert.equal(f.service.data.liveTargets.length, 64);
  assert.throws(() => f.service.register({ ...d, liveActivity: { notificationId: 65, locallyCreated: true } }, f.owner), /activity-capacity/);
  assert.equal(f.service.live.target(f.owner).device.liveActivity.notificationId, 64);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-watch-retired-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json'); f.service.store.file = file; f.service.store.save();
  assert.equal(new Store(file).data.liveTargets.length, 64);
  await f.service.live.process();
  const retired = f.service.data.liveTargets.find(x => x.retired), deadline = retired.retireUntil, eventId = retired.pending.id;
  f.advance(10000); f.sync(snapshot('approval')); await f.service.live.process();
  assert.equal(retired.retireUntil, deadline); assert.equal(retired.pending.id, eventId); assert.equal(retired.pending.attempts, 2);
  f.advance(80001); f.sync(); await f.service.live.process();
  assert.equal(f.service.data.liveTargets.some(x => x.retired), false);
  assert.equal(new Store(file).data.liveTargets.length, 1);
  f.service.register({ ...d, liveActivity: { notificationId: 65, locallyCreated: true } }, f.owner);
  assert.equal(f.service.live.target(f.owner).device.liveActivity.notificationId, 65);
});
test('completed Android local notification end does not restart an endless end loop', async () => {
  const f = fixture('android');
  f.service.register({ id: f.owner, platform: 'android', token: 'a'.repeat(40), liveUpdates: true,
    liveActivity: { notificationId: 44, locallyCreated: true } }, f.owner);
  await f.service.live.process(); f.sync({ sample: false, p: [], requests: [] });
  await f.service.live.process(); f.advance(10000); await f.service.live.process();
  assert.deepEqual(f.sent.map(x => x.event.phase), ['update', 'end']);
});
test('FCM attention is data-only, short-lived and collapsible; ordinary alerts remain notifications', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }); let message;
  const fcm = new FcmPush({ now: () => NOW, credentials: { client_email: 'test-service', project_id: 'sample-project', private_key: pair.privateKey },
    fetchImpl: async (url, options) => { if (url.includes('oauth2')) return { status: 200, text: async () => JSON.stringify({ access_token: 'access', expires_in: 3600 }) };
      message = JSON.parse(options.body).message; return { status: 200, text: async () => '{}' }; } });
  const state = attention(fixture().service).contentState;
  await fcm.send({ token: 'device' }, { category: 'attention', eventId: randomUUID(), phase: 'update', contentState: state });
  assert.equal(message.android.notification, undefined); assert.equal(message.android.ttl, '90s'); assert.equal(message.android.collapse_key, 'aiwatch-attention');
  assert.deepEqual(JSON.parse(message.data.contentState), state);
});
test('APNs ActivityKit uses correct topic, payloads, priority and immediate end dismissal', async () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey; const calls = [];
  const push = new ApnsPush({ key, keyId: 'KEY', teamId: 'TEAM', topic: 'app.aiwatch.mobile', now: () => NOW,
    request: async (origin, headers, body) => { calls.push({ origin, headers, body: JSON.parse(body) }); return { status: 200, data: {} }; } });
  const state = attention(fixture().service).contentState;
  for (const phase of ['start', 'update', 'end']) await push.send({ token: UPDATE, environment: 'sandbox' }, { category: 'attention', phase, scope: 'install', timestamp: NOW / 1000, contentState: state, expiresAt: NOW + 90000 });
  for (const c of calls) { assert.equal(c.headers['apns-push-type'], 'liveactivity'); assert.equal(c.headers['apns-topic'], 'app.aiwatch.mobile.push-type.liveactivity'); assert.deepEqual(c.body.aps['content-state'], state); }
  assert.equal(calls[0].body.aps['attributes-type'], 'AIWatchAttentionAttributes'); assert.deepEqual(calls[0].body.aps.attributes, { scope: 'install' });
  assert.equal(calls[1].headers['apns-priority'], '5'); assert.equal(calls[1].body.aps.alert, undefined); assert.equal(calls[2].body.aps['dismissal-date'], NOW / 1000);
});
test('ActivityKit HTTP endpoints require paired owner and support bodyless disable', async t => {
  const runtime = createServer({ desktopToken: 'd'.repeat(40), mobileToken: 'm'.repeat(40), timers: false, now: () => NOW });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve)); t.after(() => runtime.close());
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const pair = await fetch(base + '/v1/pair', { method: 'POST', headers: { authorization: 'Bearer ' + 'm'.repeat(40), 'content-type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), name: 'Test', platform: 'ios' }) });
  const { token } = await pair.json(); const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(base + '/v1/live-activity', { method: 'POST', headers, body: JSON.stringify({ type: 'start', token: START, environment: 'sandbox' }) })).status, 200);
  assert.equal((await fetch(base + '/v1/live-activity', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(base + '/v1/live-activity', { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'content-length': '0' } })).status, 200);
  assert.equal((await fetch(base + '/v1/live-activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
});
