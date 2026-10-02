const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pbkdf2Sync, createCipheriv, createHash } = require('node:crypto');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { QwenStatusReader, QwenError, normalizeCredits, normalizePlan, readCookieSnapshot,
  decryptCookie, authHeaders, requestJson, ENDPOINTS } = require('../electron/qwen-status.cjs');
const now = Date.parse('2026-10-02T12:00:00Z');
const processes = [{ pid: 123, command: '/fixture/Qianwen.app/Contents/MacOS/Qianwen' }];
const password = 'SYNTHETIC_STORAGE_PASSWORD';
const credits = { success: true, httpCode: 200, data: { creditsRemain: true, totalBalance: 321,
  creditsDetail: [{ balance: 123, total: 200, entitlementCode: 'PRIVATE_CODE', expireAt: now + 600000 },
    { balance: 198, total: 300, entitlementCode: 'PRIVATE_OTHER' }],
  scopes: [{ scope: '5H', usedPercent: 25, refreshAt: now + 3600000 }, { scope: 'WEEKLY', usedPercent: 80, refreshAt: now + 86400000 }] } };
const plan = { success: true, httpCode: 200, data: { memberName: 'PRIVATE_ACCOUNT', memberType: 'plus', expireTime: now + 86400000 } };
function encrypted(value, host = '.qianwen.com', version = 24) {
  const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1'), Buffer.alloc(16, 32));
  const input = Buffer.concat([version >= 24 ? createHash('sha256').update(host).digest() : Buffer.alloc(0), Buffer.from(value)]);
  return Buffer.concat([Buffer.from('v10'), cipher.update(input), cipher.final()]);
}
function snapshot(identity = 'fixture-account') {
  return { identity, version: 24, rows: [
    { host_key: '.qianwen.com', name: 'tongyi_sso_ticket', encrypted_value: encrypted('PRIVATE_LOGIN'), value: '' },
    { host_key: 'www.qianwen.com', name: 'XSRF-TOKEN', encrypted_value: encrypted('PRIVATE_CSRF', 'www.qianwen.com'), value: '' },
  ] };
}
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-qwen-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'Library', 'Application Support', 'Qianwen');
  const file = path.join(root, 'qwen-agent', 'fixture-account', 'projects', 'fixture-project', 'sessions', 'fixture-session', 'thread-events.jsonl');
  const events = async (rows, append = false) => { await fs.mkdir(path.dirname(file), { recursive: true });
    await fs[append ? 'appendFile' : 'writeFile'](file, rows.map(row => JSON.stringify({ schemaVersion: 2, timestamp: new Date(now).toISOString(), ...row })).join('\n') + '\n'); };
  return { home, root, file, events };
}
function reader(options = {}) {
  return new QwenStatusReader({ home: '/synthetic-fixture', platform: 'darwin', allowKeychain: true,
    getPassword: async () => password, readCookies: async () => snapshot(), now: () => now,
    request: async kind => kind === 'credits' ? credits : plan, ...options });
}
test('Qwen official numeric parsing preserves separate pools and never leaks account fields', () => {
  const value = normalizeCredits(credits);
  assert.deepEqual(value.credits.items.map(row => [row.label, row.remaining, row.unit]), [
    ['总剩余积分', '321', '积分'], ['积分池 1', '123', '积分'], ['积分池 2', '198', '积分'], ['5小时额度', '75', '%'], ['每周额度', '20', '%']]);
  assert.equal(value.credits.items[1].total, '200');
  assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  assert.deepEqual(normalizePlan(plan), { name: 'Plus', status: 'member', expiresAt: '2026-10-03T12:00:00.000Z', stale: false });
  for (const [type, name] of [['free', '免费版'], ['lite', 'Lite'], ['pro', 'Pro'], ['ultra', 'Ultra'], ['max', 'Max'], ['PRIVATE_TYPE', null], ['constructor', null]]) {
    assert.equal(normalizePlan({ ...plan, data: { ...plan.data, memberType: type } }).name, name);
  }
});
test('Qwen missing, invalid, negative and unsafe balances are unknown, not zero', () => {
  assert.throws(() => normalizeCredits({ success: true, httpCode: 200, data: { creditsRemain: true, totalBalance: null,
    creditsDetail: [{ balance: -1, total: 8 }, { balance: 9, total: 8 }, { balance: Number.MAX_SAFE_INTEGER + 1, total: 999 }],
    scopes: [{ scope: '5H', usedPercent: null }, { scope: 'WEEKLY', usedPercent: 101 }] } }), /format/);
  const value = normalizeCredits({ ...credits, data: { creditsRemain: false, totalBalance: 0 } });
  assert.equal(value.credits.items[0].remaining, '0');
  assert.throws(() => normalizeCredits({ ...credits, success: false }), /format/);
  assert.throws(() => normalizePlan({ success: false, httpCode: 401 }), /login/);
});
test('Qwen cookie cryptography supports verified v10 host binding and rejects wrong domains and formats', () => {
  const row = snapshot().rows[0];
  assert.equal(decryptCookie(row, 24, password), 'PRIVATE_LOGIN');
  assert.equal(decryptCookie({ ...row, encrypted_value: encrypted('LEGACY', '.qianwen.com', 23) }, 23, password), 'LEGACY');
  assert.throws(() => decryptCookie({ ...row, host_key: '.other.test' }, 24, password), /format/);
  assert.throws(() => decryptCookie(row, 24, 'WRONG'), /format/);
  assert.throws(() => decryptCookie({ ...row, encrypted_value: Buffer.from('v20UNSUPPORTED') }, 24, password), /format/);
  assert.throws(() => decryptCookie({ ...row, encrypted_value: Buffer.alloc(0), value: 'unsafe; cookie' }, 24, password), /format/);
  assert.deepEqual(authHeaders(snapshot(), password), { Cookie: 'tongyi_sso_ticket=PRIVATE_LOGIN', 'X-XSRF-TOKEN': 'PRIVATE_CSRF' });
});
test('Qwen fixed cookie database is read-only, expiry-aware, bounded and restricted to allowed names', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'Default'), { recursive: true });
  const file = path.join(f.root, 'Default', 'Cookies'); const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES (\'version\', \'24\'); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc TEXT, has_expires INTEGER, path TEXT)');
  const insert = database.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?)');
  const expires = String(BigInt(now + 3600000) * 1000n + 11644473600000000n);
  insert.run('.qianwen.com', 'tongyi_sso_ticket', '', encrypted('PRIVATE_LOGIN'), expires, 1, '/');
  insert.run('.qianwen.com', 'UNRELATED_SECRET', 'PRIVATE_OTHER', Buffer.alloc(0), expires, 1, '/');
  insert.run('.other.test', 'tongyi_sso_ticket', 'PRIVATE_OTHER', Buffer.alloc(0), expires, 1, '/');
  database.close(); const before = await fs.readFile(file);
  const value = await readCookieSnapshot(f.root, now);
  assert.equal(value.rows.length, 1); assert.equal(value.rows[0].name, 'tongyi_sso_ticket');
  assert.deepEqual(await fs.readFile(file), before);
  await assert.rejects(readCookieSnapshot(f.root, now + 3600001), /login/);
  await fs.rename(file, path.join(f.home, 'outside')); await fs.symlink(path.join(f.home, 'outside'), file);
  await assert.rejects(readCookieSnapshot(f.root, now), /format/);
});
test('Qwen default denies keychain access and process-only activity stays unknown', async t => {
  const f = await fixture(t); let keyCalls = 0;
  const value = new QwenStatusReader({ home: f.home, platform: 'darwin', now: () => now,
    readCookies: async () => snapshot(), getPassword: async () => { keyCalls++; return password; },
    request: () => assert.fail('No network before consent') });
  const result = await value.poll(processes, true);
  assert.equal(keyCalls, 0); assert.equal(result.activity, 'unknown'); assert.equal(result.connection, 'auth-required');
  assert.equal(result.accessRequired, true);
  assert.deepEqual(result.credits.items, []); assert.equal(result.plan.name, null);
  assert.equal((await value.poll([])).activity, 'offline');
  assert.equal((await value.poll(null)).activity, 'unknown');
});
test('Qwen keychain denial does not repeat without manual refresh, settings clear cached auth immediately', async () => {
  let keyCalls = 0;
  const value = reader({ getPassword: async () => { if (++keyCalls === 1) throw new Error('PRIVATE_KEYCHAIN_FAILURE'); return password; } });
  let result = await value.poll([]); assert.equal(result.connection, 'auth-required');
  assert.equal(result.accessRequired, true);
  await value.poll([]); await value.poll([]); assert.equal(keyCalls, 1);
  result = await value.poll([], true); assert.equal(keyCalls, 2); assert.equal(result.plan.name, 'Plus');
  assert.equal(result.accessRequired, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  value.setKeychainAllowed(false); assert.equal(value.password, null); assert.equal(value.cache, null);
  result = await value.poll([], true); assert.deepEqual(result.credits.items, []); assert.equal(keyCalls, 2);
  assert.equal(result.accessRequired, true);
});
test('Qwen consent revocation while keychain is pending prevents any network request', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; }); let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const value = reader({ getPassword: async () => { started(); return pending; }, request: () => assert.fail('Revoked') });
  const output = value.poll([]); await startedPromise; value.setKeychainAllowed(false); release(password);
  const result = await output; assert.equal(result.plan.name, null); assert.equal(value.password, null);
});
test('Qwen account switch and logout clear identity data, including requests in flight', async () => {
  let identity = 'first'; let calls = 0;
  const value = reader({ readCookies: async () => { if (!identity) throw new QwenError('login'); return snapshot(identity); },
    request: async kind => { calls++; return kind === 'credits' ? credits : plan; } });
  assert.equal((await value.poll([])).plan.name, 'Plus');
  identity = 'second'; await value.poll([]); assert.equal(calls, 4);
  identity = null; assert.deepEqual((await value.poll([])).credits.items, []);
  identity = 'third'; value.request = async kind => { identity = 'fourth'; return kind === 'credits' ? credits : plan; };
  assert.equal((await value.poll([])).plan.name, null);
});
test('Qwen switching account during keychain lookup does not send old credentials', async () => {
  let identity = 'first';
  const value = reader({ readCookies: async () => snapshot(identity),
    getPassword: async () => { identity = 'second'; return password; }, request: () => assert.fail('Old identity') });
  assert.equal((await value.poll([])).plan.name, null);
});
test('Qwen failed or expired query is marked historical and individual reset is honored', async () => {
  let time = now; let fail = false; let calls = 0;
  const value = reader({ now: () => time, request: async kind => { calls++; if (fail) throw new QwenError('network'); return kind === 'credits' ? credits : plan; } });
  let result = await value.poll([]); assert.equal(result.source, 'account'); assert.equal(result.credits.stale, false);
  time += 1000; await value.poll([]); assert.equal(calls, 2);
  fail = true; time = now + 600000; result = await value.poll([]);
  assert.equal(result.source, 'cache'); assert.equal(result.credits.stale, true); assert.equal(result.plan.stale, true);
  fail = false; time = now; value.nextAt = 0; await value.poll([]);
  time = now + 600000; value.nextAt = time + 1000; result = await value.poll([]);
  assert.equal(result.credits.stale, true);
});
test('Qwen HTTP auth failures discard old results and rate limits survive force refresh', async () => {
  let time = now; const value = reader({ now: () => time });
  await value.poll([]); value.request = async () => { throw new QwenError('login'); };
  assert.deepEqual((await value.poll([], true)).credits.items, []);
  let calls = 0; value.request = async () => { calls++; throw new QwenError('rate', 120000); };
  await value.poll([], true); await value.poll([], true); assert.equal(calls, 2);
  time += 120001; await value.poll([], true); assert.equal(calls, 4);
});
test('Qwen first unfinished record is unknown; live growth runs, completion stops, restarts reset confidence', async t => {
  const f = await fixture(t); let time = now; const value = reader({ home: f.home, now: () => time });
  await f.events([{ type: 'turn_started', seq: 1, payload: { secret: 'PRIVATE_PROMPT' } }]);
  assert.equal((await value.poll(processes)).activity, 'unknown');
  time += 1000; await f.events([{ type: 'ui_update', seq: 2, timestamp: new Date(time).toISOString(), payload: { text: 'PRIVATE_RESPONSE' } }], true);
  let result = await value.poll(processes); assert.equal(result.activity, 'running'); assert.equal(result.activeTasks, 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal((await value.poll([{ ...processes[0], pid: 124 }])).activity, 'unknown');
  time += 1000; await f.events([{ type: 'turn_completed', seq: 3, timestamp: new Date(time).toISOString() }], true);
  assert.equal((await value.poll(processes)).activity, 'idle');
  time += 91000; assert.equal((await value.poll(processes)).activity, 'unknown');
});
test('Qwen stale event growth, invalid schema and symlinks cannot trigger running', async t => {
  const f = await fixture(t); const value = reader({ home: f.home });
  await f.events([{ type: 'turn_started', seq: 1, timestamp: new Date(now - 600000).toISOString() }]);
  await value.poll(processes);
  await f.events([{ type: 'ui_update', seq: 2, timestamp: new Date(now - 600000).toISOString() }, { schemaVersion: 1, type: 'turn_started', seq: 3 }], true);
  assert.equal((await value.poll(processes)).activity, 'unknown');
  await fs.rename(f.file, path.join(f.home, 'outside-events')); await fs.symlink(path.join(f.home, 'outside-events'), f.file);
  assert.equal((await value.poll(processes)).activity, 'unknown');
});
test('Qwen official error and cancellation statuses all stop at the common turn_completed boundary', async t => {
  const f = await fixture(t); let time = now; const value = reader({ home: f.home, now: () => time });
  let seq = 0;
  for (const status of ['error', 'aborted_streaming', 'aborted_tools']) {
    await f.events([{ type: 'turn_started', seq: ++seq, timestamp: new Date(time).toISOString() }]);
    await value.poll(processes);
    time += 1000;
    await f.events([{ type: 'ui_update', seq: ++seq, timestamp: new Date(time).toISOString() }], true);
    assert.equal((await value.poll(processes)).activity, 'running');
    time += 1000;
    await f.events([{ type: 'turn_completed', seq: ++seq, timestamp: new Date(time).toISOString(), payload: { status } }], true);
    assert.equal((await value.poll(processes)).activity, 'idle');
  }
});
function transportFixture(response, status = 200, headers = {}) {
  const seen = [];
  return { seen, request(options, callback) {
    const request = new EventEmitter(); request.destroy = () => { request.emit('error', new Error('private')); request.emit('close'); };
    request.end = body => { seen.push({ options, body }); process.nextTick(() => {
      const stream = new PassThrough(); stream.statusCode = status; stream.headers = headers; callback(stream);
      stream.end(typeof response === 'string' ? response : JSON.stringify(response)); stream.on('end', () => request.emit('close'));
    }); }; return request;
  } };
}
test('Qwen network allows only the two fixed readonly query routes, without redirects', async () => {
  const transport = transportFixture(plan); const auth = { Cookie: 'tongyi_sso_ticket=FIXTURE' };
  await requestJson('plan', auth, { transport }); await requestJson('credits', auth, { transport });
  assert.deepEqual(transport.seen.map(row => [row.options.hostname, row.options.path, row.options.method, row.body]), [
    ['member.qianwen.com', ENDPOINTS.plan, 'POST', '{}'], ['member.qianwen.com', ENDPOINTS.credits, 'GET', '']]);
  await assert.rejects(requestJson('consume', auth, { transport }), /endpoint/);
  await assert.rejects(requestJson('plan', { Cookie: 'bad\nheader' }, { transport }), /endpoint/);
  await assert.rejects(requestJson('credits', auth, { transport: transportFixture('', 302, { location: 'https://other.test' }) }), /network/);
  await assert.rejects(requestJson('credits', auth, { transport: transportFixture('', 401) }), /login/);
  await assert.rejects(requestJson('credits', auth, { transport: transportFixture('x'.repeat(262145)) }), /format/);
});
test('Qwen unsupported operating systems never read login or keychain', async () => {
  const value = reader({ platform: 'linux', readCookies: () => assert.fail('No unverified platform auth'), getPassword: () => assert.fail('No keychain') });
  assert.equal((await value.poll([])).connection, 'unavailable');
});
