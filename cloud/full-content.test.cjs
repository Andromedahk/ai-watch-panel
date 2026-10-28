'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { validateSnapshot, digest } = require('./validation.cjs');
const { CloudService, REQUEST_TTL } = require('./service.cjs');
const { createServer, MAX_BODY } = require('./server.cjs');
const { FcmPush, ApnsPush } = require('./push.cjs');
const { MiPush, VivoPush } = require('./oem-push.cjs');

const NOW = 1900000000000;
const INPUT = 'codex-' + '1'.repeat(64), COMMAND = 'codex-' + '2'.repeat(64), FILE = 'codex-' + '3'.repeat(64);
const Q1 = '4'.repeat(64), Q2 = '5'.repeat(64);
const PRIVATE = 'FULL_CONTEXT_TEST_';
const metadataQuestion = (id, index) => ({ id, header: 'question.' + index, question: 'review.questionOnDesktop',
  options: [{ label: 'option.1', description: '' }, { label: 'option.2', description: '' }], isOther: true });
const fullQuestion = (id, index) => ({ id, header: PRIVATE + 'HEADER_' + index, question: PRIVATE + 'QUESTION_' + index + '\nSecond line',
  options: [{ label: PRIVATE + 'LABEL_A_' + index, description: PRIVATE + 'DESCRIPTION_A_' + index },
    { label: PRIVATE + 'LABEL_B_' + index, description: '' }] });
function snapshot() {
  return { sample: false, p: [{ i: 'codex', c: 'ready', a: 'waiting', n: 3, w: 'both',
    q: [{ m: 'Codex', p: 'week', r: 10 }] }], requests: [
    { id: INPUT, provider: 'codex', kind: 'input', title: 'codex.input', detail: 'input', expiresAt: NOW + REQUEST_TTL,
      questions: [metadataQuestion(Q1, 1), metadataQuestion(Q2, 2)],
      fullContent: { questions: [fullQuestion(Q1, 1), fullQuestion(Q2, 2)] } },
    { id: COMMAND, provider: 'codex', kind: 'approval', title: 'codex.commandApproval', detail: 'git', expiresAt: NOW + REQUEST_TTL,
      fullContent: { command: 'git diff -- ' + PRIVATE + 'FILE', cwd: PRIVATE + 'WORKSPACE', reason: PRIVATE + 'COMMAND_REASON' } },
    { id: FILE, provider: 'codex', kind: 'approval', title: 'codex.fileApproval', detail: 'fileChange', expiresAt: NOW + REQUEST_TTL,
      fullContent: { cwd: PRIVATE + 'FILE_WORKSPACE', grantRoot: PRIVATE + 'GRANT_ROOT', reason: PRIVATE + 'FILE_REASON' } }
  ] };
}
function fixture(t, options = {}) {
  let now = NOW, sequence = 0;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-watch-full-content-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json'), desktop = randomUUID(), session = randomUUID(), owner = randomUUID();
  const service = new CloudService({ file, now: () => now, ...options });
  const paired = service.pair({ id: owner, name: 'Synthetic phone', platform: 'android' });
  const packet = (value = snapshot(), extra = {}) => ({ v: 1, d: desktop, s: session, n: ++sequence, t: now,
    h: digest(value), snapshot: value, ...extra });
  return { service, file, owner, token: paired.token, packet, sync: (value, extra) => service.sync(packet(value, extra)),
    advance(ms) { now += ms; }, now: () => now };
}
function withoutFull(value) {
  const result = structuredClone(value);
  for (const request of result.requests) delete request.fullContent;
  return result;
}
function assertNoPrivate(value) { assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), /FULL_CONTEXT_TEST_/); }
function assertNoRetainedPrivate(service, file) {
  assertNoPrivate(service.state()); assertNoPrivate(service.data);
  if (file) assertNoPrivate(fs.readFileSync(file, 'utf8'));
}

test('optional full context accepts supported request types without changing numbered answer metadata', t => {
  const f = fixture(t), value = snapshot(); validateSnapshot(value); f.sync(value);
  assert.deepEqual(f.service.state().snapshot.requests, value.requests);
  const input = f.service.state().snapshot.requests[0];
  assert.equal(input.questions[0].header, 'question.1');
  assert.equal(input.questions[0].question, 'review.questionOnDesktop');
  assert.equal(input.questions[0].options[0].label, 'option.1');
  const action = { id: randomUUID(), requestId: INPUT, kind: 'answer',
    answers: { [Q1]: { answers: ['option.2'] }, [Q2]: { answers: ['option.1'] } } };
  f.service.command(action, f.owner);
  const delivery = f.sync(value).commands[0];
  assert.deepEqual(delivery.answers, action.answers); assertNoPrivate(delivery);
  assert.deepEqual(f.service.state().snapshot.requests[0].fullContent.questions[0].options[1], value.requests[0].fullContent.questions[0].options[1]);
  validateSnapshot(withoutFull(value));
});

test('full context rejects unknown fields, wrong types and fields belonging to another request kind', () => {
  const changes = [
    s => { s.requests[0].fullContent = null; },
    s => { s.requests[0].fullContent = []; },
    s => { s.requests[0].fullContent.unknown = 'value'; },
    s => { s.requests[0].fullContent.command = 'git status'; },
    s => { s.requests[1].fullContent.questions = []; },
    s => { s.requests[1].fullContent.grantRoot = 'root'; },
    s => { s.requests[2].fullContent.command = 'git status'; },
    s => { s.requests[1].fullContent.command = 1; },
    s => { s.requests[1].fullContent.cwd = false; },
    s => { s.requests[1].fullContent.reason = {}; },
    s => { s.requests[2].fullContent.grantRoot = null; },
    s => { s.requests[0].fullContent.questions = 'question'; },
    s => { s.requests[0].fullContent.questions[0].header = false; },
    s => { s.requests[0].fullContent.questions[0].question = {}; },
    s => { s.requests[0].fullContent.questions[0].extra = 'value'; },
    s => { s.requests[0].fullContent.questions[0].options[0].id = 'option.1'; },
    s => { s.requests[0].fullContent.questions[0].options[0].label = []; },
    s => { delete s.requests[0].fullContent.questions[0].options[0].description; }
  ];
  for (const change of changes) {
    const value = snapshot(); change(value);
    assert.throws(() => validateSnapshot(value), /invalid-full-content/);
  }
});

test('full question IDs, order and option cardinality must match the existing answer protocol', () => {
  const changes = [
    q => { q[0].id = '6'.repeat(64); },
    q => { q[0].id = Q2; },
    q => { q.reverse(); },
    q => { q.pop(); },
    q => { q.push(fullQuestion('6'.repeat(64), 3)); },
    q => { q[0].options.pop(); },
    q => { q[0].options.push({ label: 'Extra', description: '' }); },
    q => { q[0].options = null; }
  ];
  for (const change of changes) {
    const value = snapshot(); change(value.requests[0].fullContent.questions);
    assert.throws(() => validateSnapshot(value), /invalid-full-content/);
  }
  const value = snapshot(); value.requests[0].questions[0].options[0].label = value.requests[0].fullContent.questions[0].options[0].label;
  assert.throws(() => validateSnapshot(value), /private-request-rejected/);
});

test('full text enforces each limit and rejects controls while preserving ordinary multiline whitespace', () => {
  const cases = [
    [s => s.requests[1].fullContent, 'command', 4096],
    [s => s.requests[1].fullContent, 'cwd', 1024],
    [s => s.requests[1].fullContent, 'reason', 4096],
    [s => s.requests[2].fullContent, 'grantRoot', 1024],
    [s => s.requests[0].fullContent.questions[0], 'header', 256],
    [s => s.requests[0].fullContent.questions[0], 'question', 4096],
    [s => s.requests[0].fullContent.questions[0].options[0], 'label', 256],
    [s => s.requests[0].fullContent.questions[0].options[0], 'description', 1024]
  ];
  for (const [pick, field, limit] of cases) {
    const value = snapshot(); pick(value)[field] = 'x'.repeat(limit); validateSnapshot(value);
    pick(value)[field] += 'x'; assert.throws(() => validateSnapshot(value), /invalid-full-content/);
    for (const code of [0, 8, 11, 12, 14, 27, 31, 127, 128, 159]) {
      pick(value)[field] = 'before' + String.fromCharCode(code) + 'after';
      assert.throws(() => validateSnapshot(value), /invalid-full-content/);
    }
    pick(value)[field] = 'before\tmiddle\r\n结束'; validateSnapshot(value);
  }
});

test('terminal success and failure remove full request context from state, storage and later reuploads', t => {
  for (const status of ['succeeded', 'failed']) {
    const f = fixture(t), value = snapshot(); value.requests = [value.requests[1]];
    f.sync(value);
    const action = { id: randomUUID(), requestId: COMMAND, kind: 'approve' };
    f.service.command(action, f.owner); f.sync(value);
    const upload = f.packet(value, { results: [{ id: action.id, status, ...(status === 'failed' ? { error: 'local-rejected' } : {}) }] });
    delete upload.snapshot; f.service.sync(upload);
    assert.deepEqual(f.service.state().snapshot.requests, []);
    assert.equal(f.service.state().commands[0].status, status);
    assertNoRetainedPrivate(f.service, f.file);
    f.sync(value); assertNoRetainedPrivate(f.service, f.file);
    assert.equal(f.service.data.requestsSeen[0].closedAt, NOW);
    assert.deepEqual(Object.keys(f.service.data.requestsSeen[0]).sort(), ['closedAt', 'firstSeenAt', 'id', 'lastSeenAt']);
  }
});

test('request and command expiry delete complete context including when startup is the first cleanup', t => {
  for (const mode of ['request-tick', 'request-restart', 'command-restart']) {
    const f = fixture(t), value = snapshot();
    value.requests = [value.requests[0]];
    value.requests[0].expiresAt = NOW + REQUEST_TTL * 2;
    f.sync(value);
    assert.equal(f.service.state().snapshot.requests[0].expiresAt, NOW + REQUEST_TTL);
    if (mode === 'command-restart') {
      f.service.command({ id: randomUUID(), requestId: INPUT, kind: 'answer', answer: PRIVATE + 'ANSWER' }, f.owner);
      f.advance(120001);
    } else f.advance(REQUEST_TTL + 1);
    assert.match(fs.readFileSync(f.file, 'utf8'), /FULL_CONTEXT_TEST_/);
    const cleaned = mode === 'request-tick' ? (f.service.prune(), f.service) : new CloudService({ file: f.file, now: f.now });
    assert.deepEqual(cleaned.state().snapshot.requests, []);
    assertNoRetainedPrivate(cleaned, f.file);
    if (mode === 'command-restart') assert.equal(cleaned.state().commands[0].status, 'expired');
    cleaned.sync(f.packet(value));
    assertNoRetainedPrivate(cleaned, f.file);
  }
});

test('a replacement metadata-only snapshot immediately persists opt-out without extending request lifetime', t => {
  const f = fixture(t), value = snapshot(); f.sync(value);
  assert.match(fs.readFileSync(f.file, 'utf8'), /FULL_CONTEXT_TEST_/);
  f.advance(5000); const metadata = withoutFull(value); f.sync(metadata);
  assert.deepEqual(f.service.state().snapshot.requests, metadata.requests);
  assertNoRetainedPrivate(f.service, f.file);
  const restored = new CloudService({ file: f.file, now: f.now }); assertNoRetainedPrivate(restored, f.file);
  f.advance(5000); value.requests.forEach(r => { r.expiresAt += 10000; }); f.sync(value);
  assert.match(JSON.stringify(f.service.state().snapshot), /FULL_CONTEXT_TEST_/);
  assert.equal(f.service.state().snapshot.requests[0].expiresAt, NOW + REQUEST_TTL);
});

test('full content never enters inbox, audit, request history, ordinary pushes or any live push transport', async t => {
  const wire = [], events = [];
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const fcm = new FcmPush({ now: () => NOW, credentials: { client_email: 'synthetic-account', project_id: 'synthetic-project', private_key: rsa.privateKey },
    fetchImpl: async (url, options) => {
      wire.push({ transport: 'fcm', url, body: options.body });
      return { status: 200, text: async () => JSON.stringify(url.includes('oauth2') ? { access_token: 'synthetic-access', expires_in: 3600 } : { name: 'synthetic-message' }) };
    } });
  const apns = new ApnsPush({ now: () => NOW, key: ec.privateKey, keyId: 'KEY', teamId: 'TEAM', topic: 'app.aiwatch.mobile',
    request: async (origin, headers, body) => { wire.push({ transport: 'apns', origin, body }); return { status: 200, data: {} }; } });
  const mi = new MiPush({ now: () => NOW, appSecret: 'synthetic-secret', packageName: 'app.aiwatch.mobile', channelId: 'synthetic-channel',
    templateId: 'synthetic-template', business: 'synthetic-scene',
    fetchImpl: async (url, options) => { wire.push({ transport: 'mipush', url, body: options.body }); return { status: 200, text: async () => '{"code":0,"result":"ok"}' }; } });
  const vivo = new VivoPush({ now: () => NOW, appId: 1234, appKey: 'synthetic-key', appSecret: 'synthetic-secret', category: 'SYSTEM',
    scene: 'synthetic-scene', iconPath: 'res/drawable/ai_watch_live_icon.png',
    fetchImpl: async (url, options) => { wire.push({ transport: 'vpush', url, body: options.body });
      return { status: 200, text: async () => JSON.stringify(url.endsWith('/auth') ? { result: 0, authToken: 'synthetic-auth' } : { result: 0 }) }; } });
  const senders = { fcm, apns, mipush: mi, vpush: vivo };
  const f = fixture(t, { push: async (device, event) => {
    const transport = device.platform === 'ios' ? 'apns' : device.transport || 'fcm';
    events.push(structuredClone({ transport, event }));
    return senders[transport].send(device, event);
  } });
  for (const [index, transport] of ['fcm', 'mipush', 'vpush', 'apns'].entries()) {
    const owner = randomUUID(), platform = transport === 'apns' ? 'ios' : 'android';
    f.service.pair({ id: owner, name: 'Synthetic phone', platform });
    f.service.register({ id: owner, platform, token: String(index + 1).repeat(64), ...(platform === 'android' ? { transport, liveUpdates: true } : {}),
      ...(transport === 'vpush' ? { liveActivity: { notificationId: 101, locallyCreated: true } } : {}) }, owner);
    if (platform === 'ios') f.service.registerActivity({ type: 'update', token: 'a'.repeat(64), activityId: 'synthetic-activity', environment: 'sandbox' }, owner);
  }
  f.sync(); f.service.command({ id: randomUUID(), requestId: COMMAND, kind: 'approve' }, f.owner);
  assert.match(JSON.stringify(f.service.state().snapshot), /FULL_CONTEXT_TEST_/);
  for (const value of [f.service.state().alerts, f.service.state().commands, f.service.data.inbox, f.service.data.commands,
    f.service.data.requestsSeen, f.service.data.outbox, f.service.data.liveTargets, f.service.state().attention]) assertNoPrivate(value);
  await f.service.processPush(); await f.service.processPush(); await f.service.live.process();
  assert.ok(events.some(x => x.event.category === 'attention'));
  assert.ok(events.some(x => x.event.category === 'input'));
  assert.ok(events.some(x => x.event.category === 'approval'));
  assert.ok(events.some(x => x.event.category === 'low-quota'));
  assert.deepEqual([...new Set(wire.map(x => x.transport))].sort(), ['apns', 'fcm', 'mipush', 'vpush']);
  assertNoPrivate(events); assertNoPrivate(wire);
  for (const transport of ['apns', 'fcm', 'mipush', 'vpush']) assert.ok(events.some(x => x.transport === transport && x.event.category === 'attention'));
});

test('authenticated HTTP state and SSE return optional full context then clear it on the next metadata snapshot', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-watch-full-http-'));
  const file = path.join(directory, 'state.json'), desktopToken = randomUUID(), bootstrap = randomUUID();
  const runtime = createServer({ file, desktopToken, mobileToken: bootstrap, now: () => NOW, timers: false });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + runtime.server.address().port, abort = new AbortController();
  t.after(async () => { abort.abort(); await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = async (route, token, body) => fetch(endpoint + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const pairing = await (await call('/v1/pair', bootstrap, { id: randomUUID(), name: 'Synthetic phone', platform: 'android' })).json();
  const value = snapshot(), upload = { v: 1, d: randomUUID(), s: randomUUID(), n: 1, t: NOW, h: digest(value), snapshot: value };
  const stream = await fetch(endpoint + '/v1/events', { headers: { authorization: 'Bearer ' + pairing.token }, signal: abort.signal });
  const reader = stream.body.getReader(); await reader.read();
  assert.equal((await call('/v1/sync', desktopToken, upload)).status, 200);
  const changed = new TextDecoder().decode((await reader.read()).value);
  assert.match(changed, /FULL_CONTEXT_TEST_QUESTION_1/);
  assert.equal((await call('/v1/state', bootstrap)).status, 401);
  const state = await (await call('/v1/state', pairing.token)).json();
  assert.deepEqual(state.snapshot.requests, value.requests);
  assertNoPrivate(state.alerts); assertNoPrivate(state.attention);
  const bad = snapshot(); bad.requests[0].fullContent.questions.reverse();
  assert.equal((await call('/v1/sync', desktopToken, { ...upload, n: 2, h: digest(bad), snapshot: bad })).status, 400);
  const metadata = withoutFull(value);
  assert.equal((await call('/v1/sync', desktopToken, { ...upload, n: 2, h: digest(metadata), snapshot: metadata })).status, 200);
  assertNoPrivate(new TextDecoder().decode((await reader.read()).value));
  assertNoPrivate(await (await call('/v1/state', pairing.token)).json());
  assertNoPrivate(fs.readFileSync(file, 'utf8'));
});

test('full context remains subject to the compressed and uncompressed HTTP body limit', async t => {
  const desktopToken = randomUUID(), runtime = createServer({ desktopToken, mobileToken: randomUUID(), timers: false, now: () => NOW });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve)); t.after(() => runtime.close());
  const value = snapshot(), input = value.requests[0]; value.requests = [input];
  input.questions = Array.from({ length: 16 }, (_, index) => ({ ...metadataQuestion((index + 10).toString(16).repeat(64).slice(0, 64), index + 1),
    options: Array.from({ length: 32 }, (_, n) => ({ label: 'option.' + (n + 1), description: '' })) }));
  input.fullContent.questions = input.questions.map(q => ({ id: q.id, header: '', question: 'q'.repeat(4096),
    options: q.options.map(() => ({ label: 'l'.repeat(256), description: 'd'.repeat(1024) })) }));
  validateSnapshot(value);
  const body = JSON.stringify({ v: 1, d: randomUUID(), s: randomUUID(), n: 1, t: NOW, h: digest(value), snapshot: value });
  assert.ok(Buffer.byteLength(body) > MAX_BODY);
  for (const compressed of [false, true]) {
    const response = await fetch('http://127.0.0.1:' + runtime.server.address().port + '/v1/sync', { method: 'POST',
      headers: { authorization: 'Bearer ' + desktopToken, 'content-type': 'application/json', ...(compressed ? { 'content-encoding': 'gzip' } : {}) },
      body: compressed ? gzipSync(body) : body });
    assert.equal(response.status, 413); assert.deepEqual(runtime.service.state().snapshot, null);
  }
});
