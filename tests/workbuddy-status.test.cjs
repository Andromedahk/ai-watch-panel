const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { WorkBuddyStatusReader, WorkBuddyError, resolveWorkBuddyPaths, isWorkBuddyProcess, readIdentity, readDiscovery,
  readBrokerUsage, proof, normalizeWorkBuddyUsage, readActivityRows, CODES, SUMMARY_PATH, ENTERPRISE_PATH } = require('../electron/workbuddy-status.cjs');
const NOW = 1801492000000;
const processList = [{ pid: 12, command: '/Applications/WorkBuddy.app/Contents/MacOS/Electron' }];
const account = { uid: 'fixture-private-user', enterprise: false, identity: 'fixture-account-a' };
function summary(overrides = {}) { return { code: 0, data: { SubscriptionPackageCode: CODES.proMon, IsPaidUser: true,
  Packages: [{ PackageCode: CODES.proMon, CycleTotalCapacity: '2000', CycleRemainCapacity: '1234.25', CycleUsedCapacity: '765.75' }], ...overrides } }; }
function reader(options = {}) { return new WorkBuddyStatusReader({ now: () => NOW, readIdentity: async () => account,
  readDiscovery: async () => ({ endpoint: 'fixture', ticket: 'secret' }), request: async () => summary(), readActivityRows: async () => [], ...options }); }
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-workbuddy-')); t.after(() => fs.rm(home, { force: true, recursive: true }));
  const paths = resolveWorkBuddyPaths({ home, env: {}, platform: 'darwin' }); await fs.mkdir(paths.authRoot, { recursive: true });
  await fs.writeFile(paths.auth, JSON.stringify({ account: { uid: 'fixture-user', nickname: 'private-name' }, auth: { domain: 'www.workbuddy.cn', accessToken: { encrypted: 'fixture-secret' } } }), { mode: 0o600 });
  return { home, paths };
}
function broker({ mutate, status = 200, payload = summary(), timeout = false, headers = {}, enterprise = false } = {}) {
  const ticket = randomBytes(32).toString('base64url'); const endpoint = '/fixture/wbipc/b-0123456789abcdef.sock'; const outgoing = []; let destroyed = false;
  let clientNonce; const serverNonce = randomBytes(16).toString('base64url');
  const connect = () => {
    const socket = new EventEmitter(); socket.destroy = () => { destroyed = true; };
    const emit = data => queueMicrotask(() => { if (!destroyed) socket.emit('data', Buffer.from(typeof data === 'string' ? data : JSON.stringify(data) + '\n')); });
    socket.write = text => {
      const sent = JSON.parse(text); outgoing.push(sent); if (timeout) return;
      let reply;
      if (sent.type === 'session_hello') { clientNonce = sent.client_nonce; reply = { type: 'session_challenge', protocol: 1, server_nonce: serverNonce,
        server_proof: proof(ticket, 'server', endpoint, clientNonce, serverNonce) }; }
      else if (sent.type === 'session_prove') {
        assert.equal(sent.client_proof, proof(ticket, 'client', endpoint, clientNonce, serverNonce)); reply = { type: 'session_hello_ack', protocol: 1 };
      } else if (sent.method === 'broker/GetPipe') reply = { jsonrpc: '2.0', id: 1, result: { channel: 'c:wb.request', methods: ['http.fetch'] } };
      else reply = { jsonrpc: '2.0', id: 2, result: { status, headers, body_b64: Buffer.from(JSON.stringify(payload)).toString('base64') } };
      emit(mutate ? mutate(reply, sent) : reply);
    };
    queueMicrotask(() => socket.emit('connect')); return socket;
  };
  return { run: () => readBrokerUsage({ endpoint, ticket, enterprise }, { connect, timeoutMs: 30 }), outgoing, ticket, destroyed: () => destroyed };
}
test('official platform defaults and config override do not embed a device path', () => {
  assert.equal(resolveWorkBuddyPaths({ home: '/fixture', env: {}, platform: 'linux' }).auth, '/fixture/.local/share/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info');
  assert.equal(resolveWorkBuddyPaths({ home: 'C:\\Fixture', env: {}, platform: 'win32' }).auth, 'C:\\Fixture\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info');
  assert.equal(resolveWorkBuddyPaths({ home: '/fixture', env: { WORKBUDDY_CONFIG_DIR: '/custom' }, platform: 'darwin' }).root, '/custom');
  assert.equal(isWorkBuddyProcess(processList[0].command), true); assert.equal(isWorkBuddyProcess('/other/Electron'), false);
});
test('official summary preserves decimals and excludes account/raw product metadata', () => {
  const result = normalizeWorkBuddyUsage(summary({ account: 'private', Packages: [{ PackageCode: CODES.proMon, PackageName: 'private', CycleTotalCapacity: '2000.10', CycleRemainCapacity: '0.1' },
    { PackageCode: CODES.bonus28, CycleTotalCapacity: '10', CycleRemainCapacity: '0.2' }] }));
  assert.equal(result.plan.name, '标准版'); assert.equal(result.credits.items[0].remaining, '0.3'); assert.equal(result.credits.items[0].total, '2010.1');
  assert.equal(JSON.stringify(result).includes('private'), false); assert.equal(result.credits.items.length, 3);
});
test('verified free pools can identify a free plan, unknown subscription does not guess', () => {
  const free = summary({ SubscriptionPackageCode: '', IsPaidUser: false, Packages: [{ PackageCode: CODES.freeMon, CycleTotalCapacity: 500, CycleRemainCapacity: 500 }] });
  assert.equal(normalizeWorkBuddyUsage(free).plan.name, '体验版');
  free.data.SubscriptionPackageCode = 'unknown-secret-code'; assert.equal(normalizeWorkBuddyUsage(free).plan.name, null);
  assert.equal(JSON.stringify(normalizeWorkBuddyUsage(free)).includes('unknown-secret-code'), false);
});
test('malformed, missing, negative and duplicate totals are rejected instead of fabricated', () => {
  for (const value of [undefined, null, '-1', '1e3', Infinity, '9999999999999999', '0.123456789', {}]) {
    const input = summary(); input.data.Packages[0].CycleRemainCapacity = value;
    assert.throws(() => normalizeWorkBuddyUsage(input), { code: 'format' });
  }
  const duplicate = summary(); duplicate.data.Packages.push({ ...duplicate.data.Packages[0] });
  assert.throws(() => normalizeWorkBuddyUsage(duplicate), { code: 'format' });
  assert.throws(() => normalizeWorkBuddyUsage(summary({ Packages: [{}] })), { code: 'format' });
  assert.equal(normalizeWorkBuddyUsage(summary({ Packages: [] })).credits.items[0].remaining, '0');
});
test('enterprise data handles finite and unlimited credits without negative numbers', () => {
  const finite = normalizeWorkBuddyUsage({ code: 0, data: { limitNum: 200, credit: 12.25 } }, true);
  assert.equal(finite.plan.name, '企业版'); assert.equal(finite.credits.items[0].remaining, '187.75');
  const unlimited = normalizeWorkBuddyUsage({ data: { limitNum: -1 } }, true);
  assert.equal(unlimited.credits.items[0].remaining, null); assert.equal(unlimited.credits.items[0].total, undefined);
  assert.throws(() => normalizeWorkBuddyUsage({ data: { limitNum: 10, credit: 11 } }, true), { code: 'format' });
});
test('broker proves server first, never sends ticket/token, and only issues a fixed read query', async () => {
  const b = broker(); assert.deepEqual(await b.run(), summary()); assert.equal(b.destroyed(), true);
  assert.equal(b.outgoing.length, 4); assert.equal(JSON.stringify(b.outgoing).includes(b.ticket), false);
  const sent = b.outgoing.at(-1); assert.equal(sent.method, 'c:wb.request/http.fetch'); assert.equal(sent.params.path, SUMMARY_PATH);
  assert.deepEqual(sent.params.headers, { 'content-type': 'application/json', accept: 'application/json' });
  assert.equal(Buffer.from(sent.params.body_b64, 'base64').toString(), '{}');
  const enterprise = broker({ enterprise: true }); await enterprise.run(); assert.equal(enterprise.outgoing.at(-1).params.path, ENTERPRISE_PATH);
});
test('broker rejects invalid server proof before any client proof or account query', async () => {
  const b = broker({ mutate: reply => ({ ...reply, server_proof: 'A'.repeat(43) }) });
  await assert.rejects(b.run(), { code: 'endpoint' }); assert.equal(b.outgoing.length, 1); assert.equal(b.destroyed(), true);
});
test('broker rejects protocol mismatch, malformed payload, oversized frames and stalls', async () => {
  for (const mutate of [reply => ({ ...reply, protocol: 2 }), () => '{broken}\n', () => 'a'.repeat(1024 * 1024 + 1)]) {
    const b = broker({ mutate }); await assert.rejects(b.run(), WorkBuddyError); assert.equal(b.destroyed(), true);
  }
  const b = broker({ timeout: true }); await assert.rejects(b.run(), { code: 'network' }); assert.equal(b.destroyed(), true);
});
test('broker rejects revocation, redirects and expired auth; respects rate limiting', async () => {
  for (const [status, code] of [[302, 'network'], [401, 'login'], [403, 'login'], [500, 'network']]) await assert.rejects(broker({ status }).run(), { code });
  await assert.rejects(broker({ mutate: () => ({ type: 'pipe_revoked' }) }).run(), { code: 'login' });
  await assert.rejects(broker({ status: 429, headers: { 'retry-after': '120' } }).run(), { code: 'rate', retryMs: 120000 });
});
test('identity uses existing session metadata only and honors logout tombstone', async t => {
  const { paths } = await fixture(t); const identity = await readIdentity(paths, 'darwin');
  assert.equal(identity.uid, 'fixture-user'); assert.equal(identity.enterprise, false); assert.equal(Object.keys(identity).length, 3);
  assert.equal(JSON.stringify(identity).includes('fixture-secret'), false);
  await fs.writeFile(paths.auth + '.logged-out', ''); await assert.rejects(readIdentity(paths, 'darwin'), { code: 'login' });
});
test('identity rejects symlink auth and nonofficial login domains', async t => {
  const { paths } = await fixture(t); const raw = JSON.parse(await fs.readFile(paths.auth)); raw.auth.domain = 'https://attacker.invalid';
  await fs.writeFile(paths.auth, JSON.stringify(raw)); await assert.rejects(readIdentity(paths, 'darwin'), { code: 'unsupported' });
  await fs.rename(paths.auth, paths.auth + '.actual'); await fs.symlink(paths.auth + '.actual', paths.auth);
  await assert.rejects(readIdentity(paths, 'darwin'), { code: 'permissions' });
});
test('discovery rejects unsupported Windows transport and non-socket endpoints', async t => {
  const { paths } = await fixture(t); await assert.rejects(readDiscovery(paths, processList, 'win32', async () => true), { code: 'platform' });
  await fs.mkdir(path.dirname(paths.discovery), { recursive: true, mode: 0o700 });
  const endpoint = path.join(path.dirname(paths.discovery), 'b-0123456789abcdef.sock'); await fs.writeFile(endpoint, '', { mode: 0o600 });
  await fs.writeFile(paths.discovery, JSON.stringify({ endpoint, ticket: randomBytes(32).toString('base64url') }), { mode: 0o600 });
  await assert.rejects(readDiscovery(paths, processList, 'darwin', async () => true), { code: 'endpoint' });
});
test('cached quota refreshes once a minute and error marks stale without leaking failure text', async () => {
  let clock = NOW; let calls = 0; let fail = false;
  const r = reader({ now: () => clock, request: async () => { calls++; if (fail) throw new Error('secret upstream body'); return summary(); } });
  assert.equal((await r.poll(processList)).connection, 'ready'); await r.poll(processList); assert.equal(calls, 1);
  fail = true; clock += 61000; const result = await r.poll(processList);
  assert.equal(result.source, 'cache'); assert.equal(result.credits.stale, true); assert.equal(result.plan.stale, true); assert.deepEqual(result.quotas, []);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('logout and account changes clear cached plan and credits including in-flight results', async () => {
  let identity = account; let fail = false;
  const r = reader({ readIdentity: async () => { if (!identity) throw new WorkBuddyError('login'); return identity; }, request: async () => { if (fail) throw new WorkBuddyError('network'); return summary(); } });
  await r.poll(processList); identity = { ...account, identity: 'new-account' }; fail = true;
  let result = await r.poll(processList); assert.equal(result.credits, undefined); assert.equal(result.plan.name, null);
  identity = null; result = await r.poll(processList); assert.equal(result.connection, 'auth-required');
  let reads = 0;
  const inflight = reader({ readIdentity: async () => ++reads === 1 ? account : { ...account, identity: 'changed' } });
  result = await inflight.poll(processList); assert.equal(result.credits, undefined); assert.equal(result.connection, 'auth-required');
});
test('force refresh is supported but does not override server rate backoff', async () => {
  let calls = 0; const r = reader({ request: async () => { calls++; throw new WorkBuddyError('rate', 120000); } });
  await r.poll(processList); await r.poll(processList, true); assert.equal(calls, 1);
  let succeeds = 0; const success = reader({ request: async () => { succeeds++; return summary(); } });
  await success.poll(processList); await success.poll(processList, true); assert.equal(succeeds, 2);
});
test('history and open process alone never show running; fresh observed progress expires', async () => {
  let clock = NOW; let row = { id: 'opaque-id', status: 'working', last_activity_at: NOW, usage_at: NOW, used: 1 };
  const r = reader({ now: () => clock, readActivityRows: async () => [{ ...row }] });
  assert.equal((await r.poll(processList)).activity, 'unknown');
  row.used++; clock += 1000; assert.equal((await r.poll(processList)).activity, 'running');
  clock += 121000; assert.equal((await r.poll(processList)).activity, 'unknown');
  row = { ...row, last_activity_at: clock, status: 'pending' }; assert.equal((await r.poll(processList)).activity, 'unknown');
  row.status = 'active'; assert.equal((await r.poll(processList)).activity, 'unknown');
  assert.equal((await r.poll([])).activity, 'offline'); assert.equal((await r.poll(null)).activity, 'unknown');
});
test('process restarts reset progress confidence and row limits fail closed', async () => {
  let used = 1; const r = reader({ readActivityRows: async () => [{ id: 'x', status: 'streaming', last_activity_at: NOW, used: used++ }] });
  await r.poll(processList); assert.equal((await r.poll(processList)).activity, 'running');
  assert.equal((await r.poll([{ ...processList[0], pid: 13 }])).activity, 'unknown');
  assert.equal((await reader({ readActivityRows: async () => Array(129).fill({}) }).poll(processList)).activity, 'unknown');
});
test('read-only SQLite selects only current-account nondeleted local metadata', async t => {
  const { paths } = await fixture(t); await fs.mkdir(paths.root, { recursive: true }); const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(paths.database); db.exec(`CREATE TABLE sessions(id TEXT,status TEXT,user_id TEXT,deleted_at INTEGER,transport TEXT,updated_at INTEGER,last_activity_at INTEGER,body TEXT);
    CREATE TABLE session_usage(session_id TEXT,updated_at INTEGER,used REAL);`);
  const insert = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)');
  for (const [id, user, deleted, transport] of [['ok', 'fixture-user', -1, 'local'], ['other', 'other-user', -1, 'local'], ['deleted', 'fixture-user', 1, 'local'], ['cloud', 'fixture-user', -1, 'cloud']]) insert.run(id, 'working', user, deleted, transport, NOW, NOW, 'private message');
  db.close(); const rows = await readActivityRows(paths, 'fixture-user'); assert.equal(rows.length, 1); assert.equal(rows[0].id, 'ok'); assert.equal(JSON.stringify(rows).includes('private message'), false);
});
