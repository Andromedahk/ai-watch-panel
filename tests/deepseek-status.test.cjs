const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { resolveHarnessHome, parseGrant, readGrant, normalizeWallets, requestBalance,
  retryDelay, BalanceError, DeepSeekBalanceReader } = require('../electron/deepseek-status.cjs');

const grant = (token = 'fixture-device-a', issuer = 'https://platform.deepseek.com') => JSON.stringify({ version: 1, records: {
  'deepseek-account-platform/default': { kind: 'grant', payload: { version: 1, token, issuer } },
  'client-connection/browser-session': { kind: 'secret', payload: { secret: 'DO_NOT_USE' } },
} });
const reply = (paid = '0.1', bonus = '0.2') => ({ code: 0, data: { biz_code: 0, biz_data: {
  normal_wallets: [{ currency: 'CNY', balance: paid }], bonus_wallets: [{ currency: 'CNY', balance: bonus }],
  email: 'PRIVATE_ACCOUNT', total_costs: 'PRIVATE_HISTORY',
} } });
async function device(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-dsh-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, '.dsh');
  const file = path.join(directory, '.credentials.yaml');
  return { home, file, write: async (text) => { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(file, text, { mode: 0o600 }); } };
}

test('Harness home discovery is portable across macOS, Linux and Windows', () => {
  for (const [platform, home, expected] of [['darwin', '/example/home', '/example/home/.dsh'],
    ['linux', '/example/home', '/example/home/.dsh'], ['win32', 'C:\\Example\\Home', 'C:\\Example\\Home\\.dsh']]) {
    assert.equal(resolveHarnessHome({ platform, home, env: {} }), expected);
    assert.equal(resolveHarnessHome({ platform, home, env: { DSH_HOME: '  ' } }), expected);
    assert.equal(resolveHarnessHome({ platform, home, env: { DSH_HOME: platform === 'win32' ? '~\\.dsh' : '~/.dsh' } }), expected);
  }
  assert.equal(resolveHarnessHome({ platform: 'win32', home: 'C:\\Example', env: { DSH_HOME: 'D:\\HarnessData' } }), 'D:\\HarnessData');
  assert.equal(resolveHarnessHome({ platform: 'linux', home: '/example/home', env: { DSH_HOME: '/example/custom' } }), '/example/custom');
});

test('strict credential parser selects only official account grants and suppresses sensitive errors', () => {
  assert.equal(parseGrant(grant()).token, 'fixture-device-a');
  for (const text of [grant('SENSITIVE\nHEADER'), grant('SENSITIVE', 'https://example.invalid'),
    'version: 1\nversion: 1\nrecords: {}', 'version: 1\nrecords: &a {foo: *a}',
    grant().replace('"kind":"grant"', '"kind":"api-key"'), 'version: 2\nrecords: {}']) {
    assert.throws(() => parseGrant(text), (error) => error instanceof BalanceError && !error.message.includes('SENSITIVE'));
  }
  assert.throws(() => parseGrant('{"version":1,"records":{}}'), { code: 'login' });
});

test('decimal balances preserve exact sums, separate currencies, zeros and absent wallets', () => {
  const data = reply();
  data.data.biz_data.normal_wallets.push({ currency: 'USD', balance: '1.2e1' });
  assert.deepEqual(normalizeWallets(data), [
    { currency: 'CNY', paid: '0.1', bonus: '0.2', total: '0.3' },
    { currency: 'USD', paid: '12', bonus: '0', total: '12' },
  ]);
  assert.equal(normalizeWallets(reply('0E-16', '-.001'))[0].total, '-0.001');
  data.data.biz_data.normal_wallets = []; data.data.biz_data.bonus_wallets = [];
  assert.deepEqual(normalizeWallets(data), []);
  for (const value of ['NaN', 'Infinity', '1e999', '1e-999', 'word', '', 0, null]) {
    assert.throws(() => normalizeWallets(reply(value)), { code: 'format' });
  }
  assert.throws(() => normalizeWallets({ code: 1, data: reply().data }), { code: 'format' });
  assert.throws(() => normalizeWallets({ code: 40003 }), { code: 'login' });
  data.data.biz_data.normal_wallets = [{ currency: 'EUR', balance: '10' }];
  assert.throws(() => normalizeWallets(data), { code: 'format' });
  assert.throws(() => normalizeWallets({ code: 0, data: { biz_code: 0, biz_data: {} } }), { code: 'format' });
});

test('fresh installations auto-connect using each device login with no copied panel key', async (t) => {
  const a = await device(t); const b = await device(t);
  await a.write(grant('fixture-device-a')); await b.write(grant('fixture-device-b'));
  const before = await fs.readFile(a.file, 'utf8');
  const request = async (token) => reply(token === 'fixture-device-a' ? '10' : '20', '1');
  const first = await new DeepSeekBalanceReader({ home: a.home, env: {}, request }).poll();
  const second = await new DeepSeekBalanceReader({ home: b.home, env: {}, request }).poll();
  assert.equal(first.balance.wallets[0].total, '11');
  assert.equal(second.balance.wallets[0].total, '21');
  assert.equal(first.connection, 'ready'); assert.equal(first.activity, 'unknown');
  const serialized = JSON.stringify(first);
  for (const secret of [a.home, 'fixture-device-a', 'PRIVATE', 'DO_NOT_USE', parseGrant(before).identity]) assert.ok(!serialized.includes(secret));
  assert.equal(await fs.readFile(a.file, 'utf8'), before);
});

test('login, logout and token rotation invalidate cached balances without writing Harness data', async (t) => {
  const d = await device(t); let calls = 0; let clock = 100000;
  const reader = new DeepSeekBalanceReader({ home: d.home, env: {}, now: () => clock,
    request: async () => { calls++; return reply(); } });
  assert.equal((await reader.poll()).connection, 'auth-required');
  assert.deepEqual(await fs.readdir(d.home), []);
  await d.write(grant());
  await reader.poll(); await reader.poll(); assert.equal(calls, 1);
  await reader.poll(true); assert.equal(calls, 2);
  clock += 60001; await reader.poll(); assert.equal(calls, 3);
  await d.write(grant('fixture-rotated')); await reader.poll(); assert.equal(calls, 4);
  await fs.unlink(d.file);
  const cleared = await reader.poll();
  assert.equal(cleared.connection, 'auth-required'); assert.deepEqual(cleared.balance.wallets, []);
  assert.equal(cleared.observedAt, null);
});

test('an account change while a request is in flight discards the prior account result', async (t) => {
  const d = await device(t); await d.write(grant());
  let release; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const reader = new DeepSeekBalanceReader({ home: d.home, env: {}, request: async () => {
    started(); return new Promise(resolve => { release = resolve; });
  } });
  const pending = reader.poll(); await ready;
  await d.write(grant('fixture-new-account')); release(reply('99'));
  const result = await pending;
  assert.deepEqual(result.balance.wallets, []); assert.equal(result.observedAt, null);
  reader.request = async () => reply('2', '0');
  assert.equal((await reader.poll()).balance.wallets[0].total, '2');
});

test('failures are explicit, stale cache is marked, auth clears amounts, 429 honors backoff', async (t) => {
  const d = await device(t); await d.write(grant()); let clock = 100000; let calls = 0;
  const reader = new DeepSeekBalanceReader({ home: d.home, env: {}, now: () => clock, request: async () => reply() });
  await reader.poll();
  reader.request = async () => { calls++; throw new BalanceError('network'); };
  const stale = await reader.poll(true);
  assert.equal(stale.balance.stale, true); assert.equal(stale.source, 'cache');
  reader.request = async () => { calls++; throw new BalanceError('rate', 120000); };
  await reader.poll(true); await reader.poll(true); assert.equal(calls, 2);
  clock += 119999; await reader.poll(true); assert.equal(calls, 2);
  clock++; reader.request = async () => { throw new BalanceError('login'); };
  const expired = await reader.poll(true);
  assert.equal(expired.connection, 'auth-required'); assert.deepEqual(expired.balance.wallets, []);
});

test('oversized, insecure and unsupported credential files make no network requests', async (t) => {
  const d = await device(t); let calls = 0;
  const reader = new DeepSeekBalanceReader({ home: d.home, env: {}, request: async () => { calls++; return reply(); } });
  for (const text of ['x'.repeat(65537), grant('fixture', 'https://example.invalid'), 'invalid: [']) {
    await d.write(text); assert.equal((await reader.poll()).connection, 'error');
  }
  if (process.platform !== 'win32') {
    await d.write(grant()); await fs.chmod(d.file, 0o644);
    await assert.rejects(readGrant({ home: d.home, env: {} }), { code: 'permissions' });
  }
  assert.equal(calls, 0);
});

function transport(status, body, headers = {}, stall = false) {
  return { request(options, callback) {
    assert.equal(options.hostname, 'platform.deepseek.com'); assert.equal(options.protocol, 'https:');
    assert.equal(options.path, '/api/v0/users/get_user_summary'); assert.equal(options.method, 'GET');
    assert.equal(options.headers['x-dsh-auth-token'], 'fixture');
    const req = new EventEmitter();
    req.destroy = () => req.emit('close');
    req.end = () => queueMicrotask(() => {
      if (stall) return;
      const res = new PassThrough(); res.statusCode = status; res.headers = headers;
      res.on('close', () => req.emit('close'));
      callback(res); if (!res.destroyed) res.end(body);
    });
    return req;
  } };
}
test('HTTPS request rejects redirects, auth errors, large payloads and total timeouts', async () => {
  assert.deepEqual(await requestBalance('fixture', { transport: transport(200, JSON.stringify(reply())) }), reply());
  for (const status of [301, 302, 307, 500]) await assert.rejects(requestBalance('fixture', {
    transport: transport(status, '', { location: 'https://example.invalid' }),
  }), { code: 'network' });
  for (const status of [401, 403]) await assert.rejects(requestBalance('fixture', { transport: transport(status, '') }), { code: 'login' });
  await assert.rejects(requestBalance('fixture', { transport: transport(429, '', { 'retry-after': '120' }) }), { code: 'rate', retryMs: 120000 });
  await assert.rejects(requestBalance('fixture', { transport: transport(200, 'x'.repeat(65537)) }), { code: 'format' });
  await assert.rejects(requestBalance('fixture', { transport: transport(200, 'bad') }), { code: 'format' });
  await assert.rejects(requestBalance('fixture', { transport: transport(200, '', {}, true), timeoutMs: 20 }), { code: 'network' });
  assert.equal(retryDelay('Thu, 01 Jan 1970 00:02:00 GMT', 0), 120000);
});
