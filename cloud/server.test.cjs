'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { CloudService: BaseService, REQUEST_TTL } = require('./service.cjs');
const { createServer, MAX_BODY } = require('./server.cjs');
const { digest, validateSnapshot } = require('./validation.cjs');
const { FcmPush, ApnsPush } = require('./push.cjs');
const desktopToken = 'd'.repeat(40), mobileToken = 'm'.repeat(40);
const NOW = 1900000000000;
const deviceId = randomUUID(), session = randomUUID();
const REQUEST = 'codex-' + 'a'.repeat(64), Q = 'b'.repeat(64), Q2 = 'c'.repeat(64), TEST_PHONE = randomUUID();
class CloudService extends BaseService {
  constructor(options) { super(options); this.testPhone = TEST_PHONE; if (!this.data.installations.some(d => d.id === TEST_PHONE)) this.pair({ id: TEST_PHONE, name: 'Test phone', platform: 'android' }); }
  command(body, actor = this.testPhone) { return super.command(body, actor); }
  register(body, actor = body.id) { if (!this.data.installations.some(d => d.id === actor)) this.pair({ id: actor, name: 'Test device', platform: body.platform }); return super.register(body, actor); }
}
const question = (id = Q, number = 1) => ({ id, header: `question.${number}`, question: 'review.questionOnDesktop', options: [{ label: 'option.1', description: '' }], isOther: true });
function snapshot(overrides = {}) { return { p: [{ i: 'codex', c: 'ready', a: 'waiting', n: 1, w: 'input', q: [{ m: 'Codex', p: 'week', r: 80 }] }],
  requests: [{ id: REQUEST, provider: 'codex', kind: 'input', title: 'codex.input', detail: 'input', questions: [question()], expiresAt: NOW + 600000 }], sample: false, ...overrides }; }
function packet(snap = snapshot(), overrides = {}) { return { v: 1, d: deviceId, s: session, n: 1, t: NOW, h: digest(snap), snapshot: snap, ...overrides }; }
function command(overrides = {}) { return { id: randomUUID(), requestId: REQUEST, kind: 'answer', answer: 'Private answer', ...overrides }; }
async function runtime(t, options = {}) {
  const runtime = createServer({ desktopToken, mobileToken, now: () => NOW, timers: false, ...options });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  t.after(() => runtime.close());
  const paired = await fetch(base + '/v1/pair', { method: 'POST', headers: { authorization: `Bearer ${mobileToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), name: 'Test phone', platform: 'android' }) });
  const pairing = await paired.json(); const pairedToken = pairing.token;
  assert.equal(paired.status, 201);
  const call = async (route, body, token = pairedToken, extra = {}) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra.headers },
      body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'headers')) });
    return { status: response.status, body: await response.json() };
  };
  return { ...runtime, base, call, pairedToken, installationId: pairing.deviceId };
}
test('bearer scopes isolate desktop publication from mobile commands and viewing', async t => {
  const { call } = await runtime(t);
  assert.equal((await call('/v1/state', undefined, desktopToken)).status, 401);
  assert.equal((await call('/v1/sync', packet(), mobileToken)).status, 401);
  assert.equal((await call('/v1/state', undefined, 'bad')).status, 401);
  assert.equal((await call('/v1/sync', packet(), desktopToken)).status, 200);
  const view = await call('/v1/state'); assert.equal(view.body.online, true); assert.equal(view.body.snapshot.requests.length, 1);
  assert.equal((await call('/v1/commands', command(), desktopToken)).status, 401);
});
test('heartbeat needs full snapshot on fresh session; hash, sequence, device and retired sessions fail closed', () => {
  const s = new CloudService({ now: () => NOW }); const full = packet(); const { snapshot: _, ...heartbeat } = full;
  assert.equal(s.sync(heartbeat).needSnapshot, true); assert.equal(s.state().online, false);
  assert.equal(s.sync(full).needSnapshot, false); assert.equal(s.sync(full).needSnapshot, false);
  assert.throws(() => s.sync({ ...full, t: NOW + 1 }), /sequence-conflict/);
  assert.throws(() => s.sync({ ...full, d: randomUUID(), n: 2 }), /desktop-already-bound/);
  assert.throws(() => s.sync({ ...full, n: 2, h: '0'.repeat(64) }), /snapshot-hash-mismatch/);
  const next = packet(snapshot(), { n: 2 }); s.sync(next);
  assert.throws(() => s.sync(full), /stale-sequence/);
  s.sync(packet(snapshot(), { s: randomUUID() }));
  assert.throws(() => s.sync(packet(snapshot(), { n: 3 })), /retired-session/);
});
test('mobile answers are queued, repeatedly delivered, acknowledged and scrubbed without inventing success', () => {
  const s = new CloudService({ now: () => NOW }); s.sync(packet()); const c = command();
  assert.deepEqual(s.command(c), { id: c.id, status: 'queued', actorDeviceId: s.testPhone });
  assert.equal(s.command(c).status, 'queued');
  assert.throws(() => s.command({ ...c, answer: 'changed' }), /command-id-conflict/);
  assert.throws(() => s.command(command()), /request-already-submitted/);
  assert.equal(s.state().commands[0].status, 'queued');
  assert.equal(JSON.stringify(s.state().commands).includes('Private answer'), false);
  const heartbeat = { ...packet(), n: 2 }; delete heartbeat.snapshot;
  assert.equal(s.sync(heartbeat).commands[0].answer, 'Private answer');
  assert.equal(s.sync({ ...heartbeat, n: 3 }).commands[0].id, c.id);
  const response = s.sync({ ...heartbeat, n: 4, results: [{ id: c.id, status: 'succeeded' }] });
  assert.deepEqual(response.commands, []); assert.equal(s.state().commands[0].status, 'succeeded'); assert.equal(s.data.commands[0].answer, undefined);
});
test('offline, expiration, sample data, wrong kinds and request disappearance prevent actions', () => {
  let now = NOW; const s = new CloudService({ now: () => now });
  assert.throws(() => s.command(command()), /desktop-offline/); s.sync(packet());
  assert.throws(() => s.command(command({ kind: 'approve', answer: undefined })), /wrong-command-kind/);
  now += 20001; assert.throws(() => s.command(command()), /desktop-offline/); now = NOW;
  const c = command(); s.command(c); now += 120001; s.tick(); assert.equal(s.state().commands[0].status, 'expired');
  s.sync(packet(snapshot({ requests: [] }), { n: 2, t: now }));
  assert.throws(() => s.command(command()), /request-expired/);
  s.sync(packet(snapshot({ sample: true }), { n: 3, t: now }));
  assert.throws(() => s.command(command()), /sample-actions-disabled/);
});
test('new desktop sessions fail previous commands and do not redeliver approvals', () => {
  const s = new CloudService({ now: () => NOW }); const snap = snapshot(); snap.requests[0].kind = 'approval'; snap.requests[0].title = 'codex.commandApproval'; snap.requests[0].detail = 'git'; delete snap.requests[0].questions; s.sync(packet(snap));
  const c = command({ kind: 'approve', answer: undefined }); s.command(c);
  const response = s.sync(packet(snap, { s: randomUUID() }));
  assert.deepEqual(response.commands, []); assert.equal(s.state().commands[0].error, 'desktop-session-changed');
});
test('state and command dedup survive process restart using atomic persistence', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-watch-cloud-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json'); const s = new CloudService({ file, now: () => NOW }); s.sync(packet()); const c = command(); s.command(c);
  const restored = new CloudService({ file, now: () => NOW }); assert.equal(restored.command(c).status, 'queued');
  assert.equal(restored.sync(packet(snapshot(), { n: 2 })).commands.length, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
test('notifications are transition-based, private fields excluded and low quota has hysteresis', async () => {
  const deliveries = []; let now = NOW;
  const s = new CloudService({ now: () => now, push: async (device, event) => { deliveries.push({ device, event }); return { ok: true }; } });
  s.register({ id: randomUUID(), platform: 'android', token: 'a'.repeat(100) });
  let snap = snapshot(); s.sync(packet(snap)); await s.processPush();
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].event.category, 'input');
  assert.doesNotMatch(JSON.stringify(deliveries), /Private question/);
  s.sync(packet(snap, { n: 2 })); await s.processPush(); assert.equal(deliveries.length, 1);
  snap.p[0].q[0].r = 20; s.sync(packet(snap, { n: 3 })); await s.processPush(); assert.equal(deliveries.length, 2);
  snap.p[0].q[0].r = 23; s.sync(packet(snap, { n: 4 })); snap.p[0].q[0].r = 19; s.sync(packet(snap, { n: 5 })); await s.processPush(); assert.equal(deliveries.length, 2);
  snap.p[0].q[0].r = 26; s.sync(packet(snap, { n: 6 })); snap.p[0].q[0].r = 19; s.sync(packet(snap, { n: 7 })); await s.processPush(); assert.equal(deliveries.length, 3);
  now += 30000; s.tick(); assert.equal(s.state().online, false);
});
test('unknown, stale and sample quotas do not notify; invalid tokens are removed, retry bounded', async () => {
  let now = NOW; let sends = 0;
  const s = new CloudService({ now: () => now, push: async () => { sends++; return { invalid: true }; } });
  s.register({ id: randomUUID(), platform: 'ios', token: 'b'.repeat(64) });
  const snap = snapshot({ requests: [], sample: true }); snap.p[0].w = undefined; snap.p[0].q[0].r = 0;
  s.sync(packet(snap)); await s.processPush(); assert.equal(sends, 0);
  snap.sample = false; snap.p[0].q[0].s = true; s.sync(packet(snap, { n: 2 })); await s.processPush(); assert.equal(sends, 0);
  delete snap.p[0].q[0].s; snap.p[0].q[0].r = null; s.sync(packet(snap, { n: 3 })); await s.processPush(); assert.equal(sends, 0);
  snap.p[0].q[0].r = 0; s.sync(packet(snap, { n: 4 })); await s.processPush(); assert.equal(sends, 1); assert.equal(s.data.devices.length, 0);
  const retry = new CloudService({ now: () => now, push: async () => ({ retry: true }) });
  retry.register({ id: randomUUID(), platform: 'ios', token: 'b'.repeat(64) }); retry.sync(packet());
  for (let i = 0; i < 8; i++) { await retry.processPush(); now += 300000; }
  assert.equal(retry.data.outbox.length, 0);
});
test('HTTP accepts gzip, caps decompressed bodies and rejects malformed/extra fields', async t => {
  const { call } = await runtime(t);
  assert.equal((await call('/v1/sync', gzipSync(JSON.stringify(packet())), desktopToken, { headers: { 'content-encoding': 'gzip' } })).status, 200);
  assert.equal((await call('/v1/sync', gzipSync('x'.repeat(MAX_BODY + 1)), desktopToken, { headers: { 'content-encoding': 'gzip' } })).status, 413);
  assert.equal((await call('/v1/sync', '{}', desktopToken)).status, 400);
  assert.equal((await call('/v1/sync', { ...packet(), secrets: true }, desktopToken)).status, 400);
  assert.throws(() => validateSnapshot(snapshot({ p: [null] })), /invalid-body/);
  const bad = snapshot(); bad.requests[0].questions = [{ id: '__proto__', header: '', question: 'x', options: [] }];
  assert.equal((await call('/v1/sync', packet(bad, { n: 2 }), desktopToken)).status, 400);
  assert.equal((await call('/v1/commands', JSON.parse('{"id":"' + randomUUID() + '","requestId":"request-1","kind":"answer","answers":{"__proto__":"x"}}'))).status, 400);
});
test('SSE sends an authenticated initial state and subsequent desktop updates', async t => {
  const { base, call, pairedToken } = await runtime(t); const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(base + '/v1/events', { headers: { authorization: `Bearer ${pairedToken}` }, signal: controller.signal });
  assert.equal(response.status, 200); const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"online":false/);
  await call('/v1/sync', packet(), desktopToken);
  assert.match(new TextDecoder().decode((await reader.read()).value), /"online":true/);
  controller.abort();
});
test('FCM exchanges OAuth JWT and sends privacy-safe notification payload; handles invalid tokens', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }); const calls = [];
  const fcm = new FcmPush({ now: () => NOW, credentials: { client_email: 'service-account', project_id: 'demo-project', private_key: pair.privateKey }, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return { status: calls.length === 1 ? 200 : 404, text: async () => JSON.stringify(calls.length === 1 ? { access_token: 'oauth-result', expires_in: 3600 } : { error: { details: [{ errorCode: 'UNREGISTERED' }] } }) };
  } });
  const result = await fcm.send({ token: 'device-token' }, { eventId: randomUUID(), category: 'approval', provider: 'codex', requestId: 'opaque' });
  assert.equal(result.invalid, true); assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/oauth2.googleapis.com/); const body = JSON.parse(calls[1].options.body);
  assert.equal(body.message.android.notification.channel_id, 'ai_watch_alerts'); assert.equal(body.message.android.notification.title_loc_key, 'ai_watch_approval_title'); assert.equal(body.message.notification, undefined); assert.equal(body.message.data.requestId, 'opaque');
});
test('APNs uses ES256 P1363 signatures, topic and environment with generic alert', async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' }); let sent;
  const apns = new ApnsPush({ key: pair.privateKey, keyId: 'KEY', teamId: 'TEAM', topic: 'app.aiwatch.mobile', now: () => NOW,
    request: async (origin, headers, body) => { sent = { origin, headers, body: JSON.parse(body) }; return { status: 200, data: {} }; } });
  assert.equal((await apns.send({ token: 'a'.repeat(64), environment: 'sandbox' }, { eventId: randomUUID(), category: 'input', provider: 'codex', expiresAt: NOW + 10000 })).ok, true);
  assert.equal(sent.origin, 'https://api.sandbox.push.apple.com'); assert.equal(sent.headers['apns-push-type'], 'alert');
  assert.equal(Buffer.from(sent.headers.authorization.split('.')[2], 'base64url').length, 64); assert.equal(sent.body.aps.alert['title-loc-key'], 'ai_watch_input_title'); assert.equal(sent.body.aps.alert['loc-key'], 'ai_watch_notice_body'); assert.equal(sent.body.aps.alert.title, undefined);
});
test('delivered commands await explicit result after local request disappears', () => {
  const s = new CloudService({ now: () => NOW }); s.sync(packet()); const c = command(); s.command(c);
  s.sync(packet(snapshot(), { n: 2 }));
  const next = packet(snapshot({ requests: [] }), { n: 3 }); s.sync(next);
  assert.equal(s.state().commands[0].status, 'delivered');
  s.sync({ ...next, n: 4, results: [{ id: c.id, status: 'succeeded' }] });
  assert.equal(s.state().commands[0].status, 'succeeded');
});
test('structured answers require known questions and bounded answer arrays', () => {
  const s = new CloudService({ now: () => NOW }); const snap = snapshot();
  snap.requests[0].questions = [question()];
  s.sync(packet(snap));
  assert.throws(() => s.command(command({ answer: undefined, answers: { [Q]: 'A' } })), /invalid-body/);
  assert.throws(() => s.command(command({ answer: undefined, answers: { missing: { answers: ['A'] } } })), /unknown-question/);
  assert.equal(s.command(command({ answer: undefined, answers: { [Q]: { answers: ['A'] } } })).status, 'queued');
});
test('delivery and visible receipt history stay within mobile and desktop limits', () => {
  const s = new CloudService({ now: () => NOW }); s.sync(packet());
  s.data.commands = Array.from({ length: 64 }, (_, i) => ({ ...command({ requestId: 'request-' + i }), status: 'queued', session,
    createdAt: NOW, expiresAt: NOW + 10000 }));
  assert.equal(s.deliver().length, 32);
  assert.equal(s.data.commands.filter(c => c.status === 'queued').length, 32);
  s.data.commands = Array.from({ length: 500 }, () => ({ ...command(), status: 'failed', createdAt: NOW, expiresAt: NOW + 10000 }));
  assert.equal(s.state().commands.length, 128);
});
test('a failed durable write cannot leave an accepted command or deliverable in memory', () => {
  const s = new CloudService({ now: () => NOW }); s.sync(packet());
  s.store.save = () => { throw new Error('disk-full'); };
  assert.throws(() => s.command(command()), /disk-full/);
  assert.equal(s.data.commands.length, 0);
  assert.throws(() => s.sync(packet(snapshot({ requests: [] }), { n: 2 })), /disk-full/);
  assert.equal(s.data.seq, 1); assert.equal(s.data.snapshot.requests.length, 1);
});
test('stale source snapshots suppress notifications and reject commands even with fresh transport', async () => {
  let count = 0; const s = new CloudService({ now: () => NOW, push: async () => { count++; return { ok: true }; } });
  s.register({ id: randomUUID(), platform: 'android', token: 'a'.repeat(100) });
  s.sync(packet(snapshot({ stale: true }))); await s.processPush(); assert.equal(count, 0);
  assert.equal(s.state().online, true); assert.throws(() => s.command(command()), /snapshot-stale/);
  assert.throws(() => validateSnapshot(snapshot({ stale: false })), /invalid-body/);
  s.sync(packet(snapshot(), { n: 2 })); const c = command(); s.command(c);
  const reply = s.sync(packet(snapshot({ stale: true }), { n: 3 }));
  assert.deepEqual(reply.commands, []); assert.equal(s.state().commands[0].error, 'snapshot-stale');
});
test('resolved requests and recovered quotas cancel queued notifications before retry', async () => {
  let now = NOW; let sends = 0;
  const s = new CloudService({ now: () => now, push: async () => { sends++; return { retry: true }; } });
  s.register({ id: randomUUID(), platform: 'android', token: 'a'.repeat(100) });
  const snap = snapshot(); snap.p[0].q[0].r = 10; s.sync(packet(snap)); await s.processPush(); assert.equal(sends, 2);
  const clear = snapshot({ requests: [] }); clear.p[0].a = 'idle'; delete clear.p[0].w;
  s.sync(packet(clear, { n: 2 })); now += 15000; await s.processPush(); assert.equal(sends, 2); assert.equal(s.data.outbox.length, 0);
});
test('generic waiting summary lag does not duplicate an already notified actionable request', async () => {
  let sends = 0; const s = new CloudService({ now: () => NOW, push: async () => { sends++; return { ok: true }; } });
  s.register({ id: randomUUID(), platform: 'android', token: 'a'.repeat(100) });
  s.sync(packet()); await s.processPush(); assert.equal(sends, 1);
  s.sync(packet(snapshot({ requests: [] }), { n: 2 })); await s.processPush(); assert.equal(sends, 1);
});
test('register refresh preserves retries and token rotation cannot invalidate the new token', async () => {
  let finish; const s = new CloudService({ now: () => NOW, push: () => new Promise(resolve => { finish = resolve; }) });
  const device = { id: randomUUID(), platform: 'android', token: 'a'.repeat(100) };
  s.register(device); s.sync(packet()); s.register(device); assert.equal(s.data.outbox.length, 1);
  const pending = s.processPush();
  s.register({ ...device, token: 'b'.repeat(100) }); finish({ invalid: true }); await pending;
  assert.equal(s.data.devices[0].token, 'b'.repeat(100)); assert.equal(s.data.outbox.length, 1); assert.equal(s.data.outbox[0].attempts, 0);
});
test('large command batches respect the desktop response byte budget', () => {
  const s = new CloudService({ now: () => NOW }); s.sync(packet());
  s.data.commands = Array.from({ length: 32 }, (_, i) => ({ ...command({ requestId: 'request-' + i, answer: 'x'.repeat(16000) }), status: 'queued', session,
    createdAt: NOW, expiresAt: NOW + 10000 }));
  const response = { ok: true, needSnapshot: false, commands: s.deliver() };
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 256 * 1024);
  assert.ok(response.commands.length < 32); assert.ok(response.commands.length > 0);
});
test('outbox checks the latest state between slow push deliveries', async () => {
  let finish; let sends = 0;
  const s = new CloudService({ now: () => NOW, push: () => { sends++; return new Promise(resolve => { finish = resolve; }); } });
  s.register({ id: randomUUID(), platform: 'android', token: 'a'.repeat(100) });
  s.register({ id: randomUUID(), platform: 'android', token: 'b'.repeat(100) });
  s.sync(packet()); const pending = s.processPush();
  const clear = snapshot({ requests: [] }); delete clear.p[0].w; clear.p[0].a = 'idle'; s.sync(packet(clear, { n: 2 }));
  finish({ ok: true }); await pending; assert.equal(sends, 1);
  await s.processPush(); assert.equal(s.data.outbox.length, 0);
});
test('idempotent command retries tolerate native JSON key reordering', () => {
  const s = new CloudService({ now: () => NOW }); const snap = snapshot();
  snap.requests[0].questions = [question(Q, 1), question(Q2, 2)];
  s.sync(packet(snap));
  const original = command({ answer: undefined, answers: { [Q]: { answers: ['A'] }, [Q2]: { answers: ['B'] } } });
  s.command(original);
  const reordered = { answers: { [Q2]: { answers: ['B'] }, [Q]: { answers: ['A'] } }, kind: 'answer', requestId: original.requestId, id: original.id };
  assert.equal(s.command(reordered).status, 'queued');
  assert.throws(() => s.command({ ...reordered, answers: { ...reordered.answers, [Q]: { answers: ['changed'] } } }), /command-id-conflict/);
});
test('limited snapshots preserve complete included requests and reject invalid flag values', () => {
  const s = new CloudService({ now: () => NOW }); s.sync(packet(snapshot({ limited: true })));
  assert.equal(s.state().snapshot.limited, true);
  assert.equal(s.command(command()).status, 'queued');
  assert.throws(() => validateSnapshot(snapshot({ limited: false })), /invalid-body/);
});
test('bootstrap is pairing/admin only and paired credentials are installation-scoped', async t => {
  const { call, pairedToken, installationId, service } = await runtime(t);
  assert.equal((await call('/v1/state', undefined, mobileToken)).status, 401);
  assert.equal((await call('/v1/admin/devices', undefined, pairedToken)).status, 401);
  assert.equal((await call('/v1/pair', { id: randomUUID(), name: 'Another phone', platform: 'android' }, pairedToken)).status, 401);
  assert.equal((await call('/v1/devices', { id: randomUUID(), platform: 'android', token: 'x'.repeat(100) })).status, 403);
  assert.equal((await call('/v1/devices', { id: installationId, platform: 'ios', token: 'a'.repeat(64) })).status, 403);
  assert.equal((await call('/v1/devices', { id: installationId, platform: 'android', token: 'x'.repeat(100) })).status, 200);
  const list = await call('/v1/admin/devices', undefined, mobileToken);
  assert.equal(list.status, 200); assert.equal(list.body.devices[0].pushRegistered, true);
  assert.doesNotMatch(JSON.stringify(list.body), /tokenHash|token|Bearer/);
  assert.equal(service.data.installations[0].tokenHash.length, 64);
  assert.equal(JSON.stringify(service.data).includes(pairedToken), false);
  assert.equal((await call('/v1/devices/' + randomUUID(), undefined, pairedToken, { method: 'DELETE' })).status, 403);
});
test('per-device commands record actor audit and reject another device replaying an operation ID', async t => {
  const { call, installationId } = await runtime(t);
  const second = await call('/v1/pair', { id: randomUUID(), name: 'Second phone', platform: 'ios' }, mobileToken);
  await call('/v1/sync', packet(), desktopToken);
  const c = command(); const accepted = await call('/v1/commands', c);
  assert.equal(accepted.body.actorDeviceId, installationId);
  const replay = await call('/v1/commands', c, second.body.token);
  assert.equal(replay.status, 409); assert.equal(replay.body.error, 'command-owner-conflict');
  const state = (await call('/v1/state')).body;
  assert.equal(state.commands[0].actorDeviceId, installationId); assert.equal(state.commands[0].kind, 'answer'); assert.equal(state.commands[0].createdAt, NOW);
  assert.equal(JSON.stringify(state).includes('Private answer'), false);
});
test('self revocation closes its SSE, removes subscriptions and denies the previous credential', async t => {
  const { call, base, pairedToken, installationId, service } = await runtime(t);
  await call('/v1/devices', { id: installationId, platform: 'android', token: 'a'.repeat(100) });
  await call('/v1/sync', packet(), desktopToken);
  const response = await fetch(base + '/v1/events', { headers: { authorization: `Bearer ${pairedToken}` } });
  const reader = response.body.getReader(); await reader.read();
  assert.equal((await call('/v1/pair', undefined, pairedToken, { method: 'DELETE' })).status, 200);
  let closed = false;
  for (let i = 0; i < 3; i++) { const next = await reader.read(); if (next.done) { closed = true; break; } }
  assert.equal(closed, true); assert.equal(service.data.devices.length, 0); assert.equal(service.data.outbox.length, 0);
  assert.equal((await call('/v1/state')).status, 401);
});
test('admin revokes one phone while other paired phone remains authorized; pairing rotates credentials', async t => {
  const { call, pairedToken, installationId } = await runtime(t);
  const secondId = randomUUID(); const second = await call('/v1/pair', { id: secondId, name: 'Second', platform: 'android' }, mobileToken);
  assert.equal((await call('/v1/admin/devices/' + installationId, undefined, mobileToken, { method: 'DELETE' })).status, 200);
  assert.equal((await call('/v1/state', undefined, pairedToken)).status, 401);
  assert.equal((await call('/v1/state', undefined, second.body.token)).status, 200);
  const rotated = await call('/v1/pair', { id: secondId, name: 'Second', platform: 'android' }, mobileToken);
  assert.notEqual(rotated.body.token, second.body.token);
  assert.equal((await call('/v1/state', undefined, second.body.token)).status, 401);
  assert.equal((await call('/v1/state', undefined, rotated.body.token)).status, 200);
});
test('per-installation command rate limits do not block another phone', async t => {
  const { call } = await runtime(t);
  const second = await call('/v1/pair', { id: randomUUID(), name: 'Second', platform: 'android' }, mobileToken);
  for (let i = 0; i < 30; i++) assert.equal((await call('/v1/commands', command())).status, 409);
  assert.equal((await call('/v1/commands', command())).status, 429);
  assert.equal((await call('/v1/commands', command(), second.body.token)).status, 409);
});
test('admin desktop reset clears binding and pending private payloads while retaining phone access and audit', async t => {
  const { call, service } = await runtime(t); await call('/v1/sync', packet(), desktopToken); const c = command(); await call('/v1/commands', c);
  assert.equal((await call('/v1/admin/reset-desktop', {})).status, 401);
  assert.equal((await call('/v1/admin/reset-desktop', {}, mobileToken)).status, 200);
  const state = (await call('/v1/state')).body;
  assert.equal(state.deviceId, null); assert.equal(state.snapshot, null); assert.equal(state.online, false);
  assert.equal(state.commands[0].status, 'failed'); assert.equal(state.commands[0].error, 'desktop-reset');
  assert.equal(service.data.commands[0].answer, undefined);
  assert.equal((await call('/v1/sync', packet(snapshot(), { n: 2 }), desktopToken)).status, 409);
  assert.equal((await call('/v1/sync', packet(snapshot(), { d: randomUUID(), s: randomUUID() }), desktopToken)).status, 200);
});
test('terminal results remove request metadata immediately without invalidating the uploaded hash', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-watch-cloud-ttl-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json'); const s = new CloudService({ file, now: () => NOW }); const upload = packet(); s.sync(upload); const c = command(); s.command(c);
  s.sync({ ...upload, n: 2 });
  const { snapshot: unused, ...heartbeat } = upload;
  assert.equal(s.sync({ ...heartbeat, n: 3, results: [{ id: c.id, status: 'succeeded' }] }).needSnapshot, false);
  assert.deepEqual(s.state().snapshot.requests, []); assert.equal(s.data.commands[0].answer, undefined);
  assert.equal(s.data.hash, upload.h); assert.equal(s.sync({ ...heartbeat, n: 4 }).needSnapshot, false);
  s.sync({ ...upload, n: 5 }); assert.deepEqual(s.state().snapshot.requests, []);
  const saved = JSON.parse(fs.readFileSync(file)); assert.deepEqual(saved.snapshot.requests, []);
  assert.equal(saved.commands[0].completedAt, NOW); assert.equal(JSON.stringify(saved).includes('Private answer'), false);
});
test('request metadata expires at ten minutes even if desktop goes offline or resubmits a longer lease', t => {
  let now = NOW; const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-watch-cloud-expiry-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json'); const s = new CloudService({ file, now: () => now }); const snap = snapshot(); snap.requests[0].expiresAt = NOW + 86400000;
  s.sync(packet(snap)); assert.equal(s.state().snapshot.requests[0].expiresAt, NOW + REQUEST_TTL);
  now += REQUEST_TTL + 1; s.prune(); assert.deepEqual(s.state().snapshot.requests, []);
  s.sync(packet(snap, { n: 2, t: now })); assert.deepEqual(s.state().snapshot.requests, []);
  const restarted = new CloudService({ file, now: () => now }); assert.deepEqual(restarted.state().snapshot.requests, []);
});
test('free text answers are scrubbed on expiry and failed results while audit remains', () => {
  let now = NOW; const s = new CloudService({ now: () => now }); s.sync(packet()); const c = command(); s.command(c); now += 120001; s.prune();
  assert.equal(s.data.commands[0].answer, undefined); assert.deepEqual(s.state().snapshot.requests, []);
  assert.equal(s.state().commands[0].status, 'expired'); assert.equal(s.state().commands[0].actorDeviceId, TEST_PHONE);
  const failure = new CloudService({ now: () => NOW }); failure.sync(packet()); const failed = command(); failure.command(failed); failure.sync(packet(snapshot(), { n: 2 }));
  failure.sync(packet(snapshot(), { n: 3, results: [{ id: failed.id, status: 'failed', error: 'local-rejected' }] }));
  assert.equal(failure.data.commands[0].answer, undefined); assert.deepEqual(failure.state().snapshot.requests, []);
});
test('server rejects original question text, command arguments, local paths and labels', () => {
  for (const mutate of [r => { r.title = 'Private task'; }, r => { r.detail = 'local/file'; }, r => { r.questions[0].id = 'private-question'; },
    r => { r.questions[0].question = 'Private prompt'; }, r => { r.questions[0].options[0].label = 'Secret choice'; }, r => { r.questions[0].options[0].description = 'Private context'; }]) {
    const snap = snapshot(); mutate(snap.requests[0]); assert.throws(() => validateSnapshot(snap), /private-request-rejected/);
  }
  const approval = snapshot(); approval.requests[0] = { id: REQUEST, provider: 'codex', kind: 'approval', title: 'codex.commandApproval', detail: 'git', expiresAt: NOW + 10000 };
  validateSnapshot(approval); approval.requests[0].detail = 'git status'; assert.throws(() => validateSnapshot(approval), /private-request-rejected/);
});
test('rotating a phone credential rejects a previously authenticated slow request body', async t => {
  const http = require('node:http');
  const { call, base, pairedToken, installationId, server, service } = await runtime(t);
  await call('/v1/sync', packet(), desktopToken);
  let token = pairedToken;
  for (const route of ['/v1/commands', '/v1/devices']) {
    const body = JSON.stringify(route.endsWith('commands') ? command() : { id: installationId, platform: 'android', token: 'a'.repeat(100) });
    let sawRequest; const seen = new Promise(resolve => { sawRequest = resolve; });
    const observe = request => { if (request.url === route) sawRequest(); }; server.on('request', observe);
    let request;
    const result = new Promise((resolve, reject) => {
      request = http.request(base + route, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        let chunks = ''; response.on('data', value => { chunks += value; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(chunks) }));
      });
      request.on('error', reject); request.write(body.slice(0, 1));
    });
    await seen; server.removeListener('request', observe);
    const rotation = await call('/v1/pair', { id: installationId, name: 'Rotated phone', platform: 'android' }, mobileToken); token = rotation.body.token;
    request.end(body.slice(1)); assert.equal((await result).status, 401);
  }
  assert.equal(service.data.commands.length, 0); assert.equal(service.data.devices.length, 0);
});
test('admin CLI requires HTTPS and emits only allowed device-list fields', async () => {
  const { run, endpoint } = require('./admin.cjs'); let sent;
  assert.throws(() => endpoint('http://example.invalid'), /https-server-required/);
  assert.throws(() => endpoint('https://name@example.invalid'), /https-server-required/);
  const result = await run({ args: ['list', 'https://example.invalid'], token: mobileToken, fetchImpl: async (url, options) => {
    sent = { url, options }; return new Response(JSON.stringify({ devices: [{ id: TEST_PHONE, name: 'Phone', platform: 'android', createdAt: NOW, pushRegistered: true, tokenHash: 'should-not-display' }] }));
  } });
  assert.equal(sent.url, 'https://example.invalid/v1/admin/devices'); assert.equal(sent.options.redirect, 'error');
  assert.equal(result.devices[0].tokenHash, undefined);
  await run({ args: ['reset-desktop', 'https://example.invalid'], token: mobileToken, fetchImpl: async (_, options) => { assert.equal(options.method, 'POST'); assert.equal(options.body, '{}'); return new Response('{"ok":true}'); } });
});
test('desktop reset invalidates an authenticated upload still waiting for its request body', async t => {
  const http = require('node:http'); const { call, base, server, service } = await runtime(t); const body = JSON.stringify(packet());
  let observed; const seen = new Promise(resolve => { observed = resolve; });
  const listener = req => { if (req.url === '/v1/sync') observed(); }; server.on('request', listener);
  let request; const result = new Promise((resolve, reject) => {
    request = http.request(base + '/v1/sync', { method: 'POST', headers: { authorization: `Bearer ${desktopToken}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }); request.on('error', reject); request.write(body.slice(0, 1));
  });
  await seen; server.removeListener('request', listener);
  assert.equal((await call('/v1/admin/reset-desktop', {}, mobileToken)).status, 200);
  request.end(body.slice(1)); assert.equal(await result, 409); assert.equal(service.data.deviceId, null);
});
test('generic notification inbox works without push registration or credentials and persists resolved history', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-watch-inbox-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json'); let now = NOW;
  const s = new CloudService({ file, now: () => now }); const snap = snapshot(); snap.p[0].q[0].r = 15;
  s.sync(packet(snap)); assert.equal(s.data.devices.length, 0); assert.equal(s.data.outbox.length, 0);
  const inbox = s.state().alerts; assert.equal(inbox.length, 2); assert.deepEqual(inbox.map(a => a.type), ['input', 'low-quota']);
  assert.ok(inbox.every(a => a.active)); assert.ok(inbox.every(a => a.key === undefined));
  s.sync(packet(snap, { n: 2 })); assert.equal(s.state().alerts.length, 2);
  const clear = snapshot({ requests: [] }); delete clear.p[0].w; clear.p[0].a = 'idle'; s.sync(packet(clear, { n: 3 }));
  assert.ok(s.state().alerts.every(a => !a.active));
  const restored = new CloudService({ file, now: () => now }); assert.equal(restored.state().alerts.length, 2);
  assert.deepEqual(restored.state().alerts.map(a => a.id), inbox.map(a => a.id));
  now += 86400001; restored.prune(); assert.deepEqual(restored.state().alerts, []);
});
test('inbox is bounded and device push registration does not create duplicate inbox events', () => {
  const s = new CloudService({ now: () => NOW }); s.sync(packet()); assert.equal(s.state().alerts.length, 1);
  s.register({ id: randomUUID(), platform: 'android', token: 'a'.repeat(100) }); assert.equal(s.state().alerts.length, 1);
  for (let i = 0; i < 205; i++) s.enqueue({ key: 'synthetic-' + i, category: 'input', provider: 'codex' });
  assert.equal(s.data.inbox.length, 200); assert.equal(s.state().alerts.length, 50);
});
