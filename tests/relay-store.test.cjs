const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { RelayStore, RelayError, LIMITS, readRelayArchive } = require('../electron/relay/store.cjs');

// Entirely synthetic task content; never reads provider profiles or invokes models.
const NOW = Date.parse('2026-10-20T04:00:00Z');
const request = (overrides = {}) => ({ to: 'codex', subject: 'Review synthetic arithmetic', purpose: 'Verify a bounded protocol exchange', instructions: 'Confirm that two plus two equals four. Do not access files or external services.', acceptanceCriteria: ['Return the number four', 'State that this is a protocol test'], idempotencyKey: 'synthetic-request-0001', ...overrides });
const code = expected => error => error instanceof RelayError && error.code === expected && error.message === expected;
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-relay-store-'));
  const store = new RelayStore({ directory, now: () => NOW, ...options });
  await store.init();
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { store, directory };
}

test('relay stores two distinct private identities and exposes no auth in transcripts or task state', async t => {
  const { store, directory } = await fixture(t);
  const claude = store.credential('claude'), codex = store.credential('codex');
  assert.match(claude, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(claude, codex);
  assert.equal(store.authenticate(claude), 'claude'); assert.equal(store.authenticate(codex), 'codex');
  for (const invalid of [null, '', 'x'.repeat(43), '千'.repeat(43), 'Bearer ' + claude]) assert.equal(store.authenticate(invalid), null);
  await store.send('claude', request());
  const docs = await fs.readFile(path.join(directory, 'transcript.md'), 'utf8');
  assert.ok(!docs.includes(claude)); assert.ok(!docs.includes(codex));
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  for (const name of ['events.jsonl', 'credentials.json', 'transcript.md']) assert.equal((await fs.stat(path.join(directory, name))).mode & 0o777, 0o600);
  assert.equal(store.getState().queuedTasks, 1); assert.equal(store.agents('codex').agents[1].runningTasks, 0);
});

test('relay requires explicit claim, enforces recipient ownership and finishes with readable evidence', async t => {
  const { store } = await fixture(t);
  const { task } = await store.send('claude', request());
  await assert.rejects(store.result('codex', { taskId: task.id, status: 'completed', purpose: 'Report test result', summary: 'Four', details: 'Protocol test only' }), code('claim-required'));
  await assert.rejects(store.claim('claude', { taskId: task.id, purpose: 'Claim test task' }), code('recipient-required'));
  const claimed = await store.claim('codex', { taskId: task.id, purpose: 'Perform bounded verification' });
  assert.equal(claimed.task.status, 'running'); assert.equal(store.agents('claude').agents[1].runningTasks, 1);
  await store.message('codex', { taskId: task.id, kind: 'question', purpose: 'Clarify required output', text: 'Should the test say four?' });
  await store.message('claude', { taskId: task.id, kind: 'answer', purpose: 'Resolve the output question', text: 'Yes, state four and protocol test only.' });
  await assert.rejects(store.result('claude', { taskId: task.id, status: 'completed', purpose: 'Report test result', summary: 'Four', details: 'Protocol test only' }), code('recipient-required'));
  const done = await store.result('codex', { taskId: task.id, status: 'completed', purpose: 'Report verified conclusion', summary: 'Four', details: 'Two plus two equals four. This is a synthetic protocol test, not model compatibility evidence.' });
  assert.equal(done.task.status, 'completed');
  const transcript = store.transcript('claude', { taskId: task.id }).markdown;
  for (const phrase of ['Task assigned', 'Task claimed', 'question', 'answer', 'Task result', 'synthetic protocol test']) assert.ok(transcript.includes(phrase));
  await assert.rejects(store.message('claude', { taskId: task.id, kind: 'progress', purpose: 'Attempt a late message', text: 'Extra' }), code('task-closed'));
  assert.throws(() => store.get('stranger', { taskId: task.id }), code('unauthorized'));
  assert.throws(() => store.get('claude', { taskId: randomUUID() }), code('task-unavailable'));
});

test('relay replay preserves task results, credentials, ordering and idempotency', async t => {
  const { store, directory } = await fixture(t);
  const credentials = store.credential('claude');
  const sent = await store.send('claude', request());
  assert.equal((await store.send('claude', request())).duplicate, true);
  await assert.rejects(store.send('claude', request({ instructions: 'A different task' })), code('idempotency-conflict'));
  await store.claim('codex', { taskId: sent.task.id, purpose: 'Run synthetic check' });
  await store.result('codex', { taskId: sent.task.id, status: 'failed', purpose: 'Record deliberate test failure', summary: 'Synthetic failure', details: 'No actual model was called.' });
  await store.close();
  await fs.appendFile(path.join(directory, 'events.jsonl'), '{"interrupted":');
  await fs.appendFile(path.join(directory, 'transcript.md'), 'UNCOMMITTED_VIEW');
  const restored = new RelayStore({ directory, now: () => NOW }); await restored.init(); t.after(() => restored.close());
  assert.equal(restored.credential('claude'), credentials);
  assert.equal(restored.ownerListTasks()[0].status, 'failed');
  assert.equal((await restored.send('claude', request())).duplicate, true);
  assert.equal(restored.events.length, 3);
  assert.doesNotMatch(await fs.readFile(path.join(directory, 'transcript.md'), 'utf8'), /UNCOMMITTED_VIEW/);
  await restored.close();
});

test('relay rejects secrets without retaining original text and keeps the operation unaccepted', async t => {
  const { store, directory } = await fixture(t);
  const secrets = ['-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE\n-----END PRIVATE KEY-----', '-----BEGIN ENCRYPTED PRIVATE KEY-----', 'Bearer syntheticAuthenticationTokenLongEnoughForDetection', 'Basic c3ludGhldGljOm5vdC1hLXJlYWwtcGFzc3dvcmQ=', 'api_key=syntheticPrivateCredential123456', store.credential('claude')];
  for (let index = 0; index < secrets.length; index++) await assert.rejects(store.send('claude', request({ instructions: secrets[index], idempotencyKey: `secret-test-${index}` })), code('sensitive-content'));
  assert.equal(store.ownerListTasks().length, 0);
  const log = await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8');
  const md = await fs.readFile(path.join(directory, 'transcript.md'), 'utf8');
  assert.match(md, /original text omitted/); assert.equal(log.trim().split('\n').length, secrets.length);
  for (const secret of secrets) { assert.ok(!log.includes(secret)); assert.ok(!md.includes(secret)); }
});

test('relay reserves a result record and prevents infinite chains, self-delegation and empty purposes', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.send('claude', request({ to: 'claude' })), code('invalid-recipient'));
  await assert.rejects(store.send('claude', request({ purpose: '  ' })), code('invalid-input'));
  const sent = await store.send('claude', request());
  await store.claim('codex', { taskId: sent.task.id, purpose: 'Start bounded test' });
  for (let index = 0; index < LIMITS.exchanges - 3; index++) await store.message('codex', { taskId: sent.task.id, kind: 'progress', purpose: 'Verify bounded message count', text: `Synthetic progress ${index}` });
  await assert.rejects(store.message('claude', { taskId: sent.task.id, kind: 'answer', purpose: 'Attempt one extra exchange', text: 'Extra' }), code('exchange-limit'));
  const done = await store.result('codex', { taskId: sent.task.id, status: 'completed', purpose: 'Complete within reserved slot', summary: 'Verified', details: 'The completion slot remained available.' });
  assert.equal(done.task.exchanges, 16);
  const second = await store.send('codex', request({ to: 'claude', parentTaskId: sent.task.id, idempotencyKey: 'synthetic-child-0002' }));
  const third = await store.send('claude', request({ parentTaskId: second.task.id, idempotencyKey: 'synthetic-child-0003' }));
  await assert.rejects(store.send('codex', request({ to: 'claude', parentTaskId: third.task.id, idempotencyKey: 'synthetic-child-0004' })), code('parent-depth'));
});

test('expired tasks cannot be claimed, sender can cancel and no connection changes task activity', async t => {
  let now = NOW;
  const { store } = await fixture(t, { now: () => now });
  const sent = await store.send('claude', request({ ttlSeconds: 60 }));
  now += 60_000;
  assert.equal(store.get('codex', { taskId: sent.task.id }).task.status, 'expired');
  assert.equal(store.inbox('codex').tasks.length, 0);
  await assert.rejects(store.claim('codex', { taskId: sent.task.id, purpose: 'Attempt expired claim' }), code('task-closed'));
  const next = await store.send('codex', request({ to: 'claude', idempotencyKey: 'synthetic-cancel-0002' }));
  await assert.rejects(store.cancel('claude', { taskId: next.task.id, purpose: 'Attempt recipient cancellation' }), code('sender-required'));
  assert.equal((await store.cancel('codex', { taskId: next.task.id, purpose: 'Withdraw synthetic request' })).task.status, 'cancelled');
});

test('store owner command uses identical ACL and argument validation', async t => {
  const { store } = await fixture(t);
  const sent = await store.ownerCommand('claude', 'relay_send_task', request());
  assert.equal(sent.ok, true); assert.equal(sent.task.from, 'claude');
  await assert.rejects(store.ownerCommand('claude', 'relay_send_task', request({ from: 'codex' })), code('invalid-input'));
  await assert.rejects(store.ownerCommand('stranger', 'relay_list_agents', {}), code('invalid-input'));
});

test('store refuses unsafe permissions, symlinks and changed logs without successful delivery', async t => {
  const { store, directory } = await fixture(t);
  const sent = await store.send('claude', request());
  const log = path.join(directory, 'events.jsonl');
  await fs.chmod(log, 0o644);
  await assert.rejects(store.claim('codex', { taskId: sent.task.id, purpose: 'Verify durable acceptance' }), code('unsafe-storage'));
  assert.equal(store.get('claude', { taskId: sent.task.id }).task.status, 'queued');
  await fs.chmod(log, 0o600);
  await fs.appendFile(log, 'external-change');
  await assert.rejects(store.claim('codex', { taskId: sent.task.id, purpose: 'Verify external mutation detection' }), code('storage-changed'));
  assert.equal(store.get('claude', { taskId: sent.task.id }).task.status, 'queued');
  await store.close();
  const real = directory + '-real'; await fs.mkdir(real, { mode: 0o700 }); t.after(() => fs.rm(real, { recursive: true, force: true }));
  const linked = directory + '-linked'; await fs.symlink(real, linked); t.after(() => fs.unlink(linked));
  await assert.rejects(new RelayStore({ directory: linked }).init(), code('unsafe-storage'));
});

test('store rejects a credential symlink and a syntactically corrupt complete log', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-relay-unsafe-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outside = path.join(directory, 'outside.json'); await fs.writeFile(outside, '{}', { mode: 0o600 });
  const credentials = path.join(directory, 'credentials.json'); await fs.symlink(outside, credentials);
  await assert.rejects(new RelayStore({ directory }).init(), code('unsafe-storage'));
  await fs.unlink(credentials);
  await fs.writeFile(path.join(directory, 'events.jsonl'), '{"invalid":true}\n', { mode: 0o600 });
  await assert.rejects(new RelayStore({ directory }).init(), code('corrupt-storage'));
});

test('writer lease blocks a live second instance and safely recovers only a dead PID', async t => {
  const { store, directory } = await fixture(t);
  await assert.rejects(new RelayStore({ directory }).init(), code('storage-busy'));
  await store.close();
  const script = `const {RelayStore}=require(${JSON.stringify(require.resolve('../electron/relay/store.cjs'))});(async()=>{await new RelayStore({directory:process.argv[1]}).init();process.exit(0)})().catch(()=>process.exit(1));`;
  await promisify(execFile)(process.execPath, ['-e', script, directory]);
  const stale = await fs.readdir(path.join(directory, 'writer.lock')); assert.equal(stale.length, 1);
  const recovered = new RelayStore({ directory }); await recovered.init();
  assert.notDeepEqual(await fs.readdir(path.join(directory, 'writer.lock')), stale);
  await recovered.close();
  await assert.rejects(fs.stat(path.join(directory, 'writer.lock')), error => error.code === 'ENOENT');
});

test('offline archive reads history without credentials, listener, lease or disk changes', async t => {
  const { store, directory } = await fixture(t);
  const sent = await store.send('claude', request());
  await store.claim('codex', { taskId: sent.task.id, purpose: 'Verify offline task history' });
  await store.result('codex', { taskId: sent.task.id, status: 'completed', purpose: 'Retain the offline outcome', summary: 'Archive ready', details: 'Readable evidence remains available while the relay is off.' });
  await store.close();
  await fs.unlink(path.join(directory, 'credentials.json'));
  // A credential symlink must not even be opened for archive-only inspection.
  await fs.symlink(path.join(directory, 'auth-must-not-be-created'), path.join(directory, 'credentials.json'));
  const beforeFiles = await fs.readdir(directory), beforeLog = await fs.readFile(path.join(directory, 'events.jsonl'));
  const beforeMarkdown = await fs.readFile(path.join(directory, 'transcript.md'));
  const beforeStat = await fs.stat(path.join(directory, 'events.jsonl'));
  const archive = await readRelayArchive({ directory, now: () => NOW });
  assert.equal(archive.tasks[0].id, sent.task.id); assert.equal(archive.tasks[0].status, 'completed');
  assert.match(archive.readTranscript(sent.task.id), /Readable evidence remains available/);
  assert.deepEqual(await fs.readdir(directory), beforeFiles);
  assert.deepEqual(await fs.readFile(path.join(directory, 'events.jsonl')), beforeLog);
  assert.deepEqual(await fs.readFile(path.join(directory, 'transcript.md')), beforeMarkdown);
  const afterStat = await fs.stat(path.join(directory, 'events.jsonl'));
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs); assert.equal(afterStat.ctimeMs, beforeStat.ctimeMs);
  await assert.rejects(fs.stat(path.join(directory, 'writer.lock')), error => error.code === 'ENOENT');
  await assert.rejects(fs.stat(path.join(directory, 'auth-must-not-be-created')), error => error.code === 'ENOENT');
});

test('offline archive is a stable complete-record snapshot and does not repair trailing partial writes', async t => {
  const { store, directory } = await fixture(t);
  const sent = await store.send('claude', request());
  // Reading while a writer owns the lease is supported; archive inspection never claims it.
  const snapshot = await readRelayArchive({ directory, now: () => NOW });
  await store.claim('codex', { taskId: sent.task.id, purpose: 'Advance after snapshot creation' });
  assert.equal(snapshot.tasks[0].status, 'queued');
  assert.doesNotMatch(snapshot.readTranscript(sent.task.id), /Task claimed/);
  await store.close();
  const log = path.join(directory, 'events.jsonl'); await fs.appendFile(log, '{"partial":');
  const before = await fs.readFile(log);
  const later = await readRelayArchive({ directory, now: () => NOW });
  assert.equal(later.tasks[0].status, 'running');
  assert.deepEqual(await fs.readFile(log), before);
  assert.throws(() => later.readTranscript(randomUUID()), code('task-unavailable'));
});

test('offline archive missing data is empty and unsafe, oversized or corrupt logs fail closed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-relay-archive-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const missing = path.join(directory, 'missing');
  assert.deepEqual((await readRelayArchive({ directory: missing })).tasks, []);
  await assert.rejects(fs.stat(missing), error => error.code === 'ENOENT');
  const file = path.join(directory, 'events.jsonl');
  await fs.writeFile(file, '{"invalid":true}\n', { mode: 0o600 });
  await assert.rejects(readRelayArchive({ directory }), code('corrupt-storage'));
  await fs.chmod(file, 0o644); await assert.rejects(readRelayArchive({ directory }), code('unsafe-storage'));
  await fs.chmod(file, 0o600); await fs.truncate(file, LIMITS.logBytes + 1);
  await assert.rejects(readRelayArchive({ directory }), code('storage-limit'));
  await fs.unlink(file); await fs.symlink(path.join(directory, 'unreadable-target'), file);
  await assert.rejects(readRelayArchive({ directory }), code('unsafe-storage'));
  await assert.rejects(readRelayArchive({ directory, limit: 501 }), code('invalid-input'));
});
