const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { KimiStatusReader, KimiError, resolveKimiPaths, normalizeKimiUsage, normalizeKimiPlan, requestJson,
  readOAuth, validInstance, SESSION_PATHS, GLOBAL_SLOT } = require('../electron/kimi-status.cjs');
const now = Date.parse('2026-10-02T12:00:00Z');
const usage = { usages: { limit_5h: { used_ratio: 0.3, reset_time: '2026-10-02T17:00:00Z' }, limit_7d: { used_ratio: '0.6' } } };
const profile = { user_id: 'PRIVATE_USER', user_level_name: 'Moderato' };
const createReader = options => new KimiStatusReader({ requestPlan: async () => profile, ...options });
const processes = [{ pid: 123, command: '/fixture/kimi' }];
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-kimi-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const write = async (name, value) => {
    const file = path.join(home, name); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); return file;
  };
  const login = (token = 'PRIVATE_TOKEN', expires = now / 1000 + 7200, slot = 'kimi-code', root = '.kimi-code') => write(`${root}/credentials/${slot}.json`, { access_token: token, refresh_token: 'PRIVATE_REFRESH', token_type: 'Bearer', expires_at: expires });
  const server = async (id = 'SERVER', changes = {}) => {
    await write('.kimi-code/server.token', 'PRIVATE_LOCAL_TOKEN');
    await write(`.kimi-code/server/instances/${id}.json`, { server_id: id, pid: 123, host: '127.0.0.1', port: 34567, heartbeat_at: now, started_at: now - 60000, ...changes });
  };
  return { home, write, login, server };
}
function page(ids) { return { code: 0, data: { items: ids.map(id => ({ id, archived: false })), total: ids.length, has_more: false, next_page_token: null } }; }
test('Kimi finds portable current/legacy data directories', () => {
  assert.deepEqual(resolveKimiPaths({ home: '/fixture', env: {}, platform: 'darwin' }), { current: '/fixture/.kimi-code', legacy: '/fixture/.kimi' });
  assert.deepEqual(resolveKimiPaths({ home: 'C:\\fixture', env: {}, platform: 'win32' }), { current: 'C:\\fixture\\.kimi-code', legacy: 'C:\\fixture\\.kimi' });
  assert.deepEqual(resolveKimiPaths({ home: '/fixture', env: { KIMI_CODE_HOME: '~/new', KIMI_SHARE_DIR: '~/old' } }), { current: '/fixture/new', legacy: '/fixture/old' });
});
test('Kimi normalizes only evidenced official usage windows and strips unrelated account fields', () => {
  const quotas = normalizeKimiUsage({ ...usage, email: 'PRIVATE_ACCOUNT', usages: { ...usage.usages, limit_month_total: { used_ratio: 0 }, limit_month_code: { used_ratio: 1 } } });
  assert.deepEqual(quotas.map(q => q.remaining), [70, 40, 100, 0]);
  assert.deepEqual(quotas.map(q => q.period), ['5 小时', '1 周', '月额度', '月额度']);
  assert.equal(quotas[0].reset, '2026-10-02T17:00:00.000Z');
  assert.deepEqual(normalizeKimiUsage({ usages: { limit_5h: { used_ratio: -1 }, limit_7d: { used_ratio: null }, limit_month_total: { used_ratio: 5 } } }), []);
  assert.throws(() => normalizeKimiUsage({ arbitrary: 0 }), /format/);
  assert.ok(!JSON.stringify(quotas).includes('PRIVATE'));
});
test('Kimi accepts legacy official quota shape without converting missing values to zero', () => {
  const quotas = normalizeKimiUsage({ usage: { limit: '100', remaining: '75' }, limits: [
    { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 80, used: 20 } },
    { detail: { limit: 20 } }, { detail: { limit: 0, used: 0 } },
  ] });
  assert.deepEqual(quotas.map(q => [q.period, q.remaining]), [['1 周', 75], ['5 小时', 75]]);
});
test('Kimi missing installation is read-only, process alone is unknown, not running', async t => {
  const f = await fixture(t); const reader = createReader({ home: f.home, env: {}, request: () => assert.fail('network must not be called') });
  assert.equal((await reader.poll([], now)).activity, 'offline');
  const result = await reader.poll(processes, now);
  assert.equal(result.activity, 'unknown'); assert.equal(result.activeTasks, 0); assert.deepEqual(result.quotas, []);
  assert.equal((await reader.poll(null, now)).activity, 'unknown');
  assert.deepEqual(await fs.readdir(f.home), []);
});
test('Kimi uses this device OAuth, throttles usage, reports cache stale and clears logout data', async t => {
  const f = await fixture(t); const file = await f.login(); let calls = 0;
  const reader = createReader({ home: f.home, env: {}, request: async args => {
    calls++; assert.equal(args.hostname, 'api.kimi.com'); assert.equal(args.endpoint, '/coding/v1/usages');
    assert.equal(args.token, 'PRIVATE_TOKEN'); if (calls > 1) throw new KimiError('network'); return usage;
  } });
  const before = await fs.readFile(file, 'utf8'); const result = await reader.poll([], now);
  assert.equal(result.source, 'account'); assert.equal(result.quotas[0].remaining, 70); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  await reader.poll([], now + 1000); assert.equal(calls, 1);
  const stale = await reader.poll([], now + 60000); assert.equal(stale.source, 'cache'); assert.equal(stale.quotas[0].stale, true);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await fs.unlink(file); assert.deepEqual((await reader.poll([], now + 60001)).quotas, []);
});
test('Kimi account switch during request discards old quota', async t => {
  const f = await fixture(t); await f.login();
  const reader = createReader({ home: f.home, env: {}, request: async () => { await f.login('PRIVATE_NEW'); return usage; } });
  assert.deepEqual((await reader.poll([], now)).quotas, []);
});
test('Kimi marks individual quota windows stale at reset while the usage cache remains fresh', async t => {
  const f = await fixture(t); await f.login(); let calls = 0;
  const reader = createReader({ home: f.home, env: {}, request: async () => {
    calls++; return { usages: {
      limit_5h: { used_ratio: 0.2, reset_time: new Date(now + 1000).toISOString() },
      limit_7d: { used_ratio: 0.4, reset_time: new Date(now - 1).toISOString() },
      limit_month_total: { used_ratio: 0.6 }, limit_month_code: { used_ratio: 0.8, reset_time: 'not-a-date' },
    } };
  } });
  const fresh = await reader.poll([], now);
  assert.equal(fresh.source, 'account'); assert.deepEqual(fresh.quotas.map(q => q.stale), [false, true, false, false]);
  const reset = await reader.poll([], now + 1000);
  assert.equal(calls, 1); assert.deepEqual(reset.quotas.map(q => q.stale), [true, true, false, false]);
  assert.equal(reset.quotas[0].remaining, 80);
});
test('Kimi rate limit cooldown survives repeated refreshes and never starts account renewal', async t => {
  const f = await fixture(t); const file = await f.login(); const before = await fs.readFile(file, 'utf8'); let calls = 0;
  const reader = createReader({ home: f.home, env: {}, request: async () => { calls++; throw new KimiError('rate', 120000); } });
  await reader.poll([], now); await reader.poll([], now + 60000); await reader.poll([], now + 119999);
  assert.equal(calls, 1); await reader.poll([], now + 120000); assert.equal(calls, 2);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});
test('Kimi rejects expired, insecure, ambiguous and redirected credential environments', async t => {
  const f = await fixture(t); const file = await f.login('PRIVATE_TOKEN', now / 1000 - 1);
  const paths = resolveKimiPaths({ home: f.home, env: {} });
  await assert.rejects(readOAuth(paths, {}, 'darwin', now), /expired/);
  await f.login(); await fs.chmod(file, 0o644); await assert.rejects(readOAuth(paths, {}, 'darwin', now), /permissions/);
  await fs.chmod(file, 0o600);
  await assert.rejects(readOAuth(paths, { KIMI_CODE_BASE_URL: 'https://other.invalid' }, 'darwin', now), /unsupported/);
  await assert.rejects(readOAuth(paths, { KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.ai/' }, 'darwin', now), /unsupported/);
  await f.login('PRIVATE_GLOBAL', undefined, GLOBAL_SLOT); await assert.rejects(readOAuth(paths, {}, 'darwin', now), /ambiguous/);
  await fs.unlink(file); assert.equal((await readOAuth(paths, {}, 'darwin', now)).host, 'api.kimi.ai');
});
test('Kimi reads legacy OAuth only while new home is absent and prevents symlink escapes', async t => {
  const f = await fixture(t); await f.login('LEGACY_PRIVATE', undefined, 'kimi-code', '.kimi');
  const paths = resolveKimiPaths({ home: f.home, env: {} });
  assert.equal((await readOAuth(paths, {}, 'darwin', now)).token, 'LEGACY_PRIVATE');
  await fs.mkdir(paths.current); await assert.rejects(readOAuth(paths, {}, 'darwin', now), /login/);
  await fs.mkdir(path.join(paths.current, 'credentials'));
  const outside = await f.write('outside.json', { access_token: 'PRIVATE_OUTSIDE', token_type: 'Bearer', expires_at: now / 1000 + 1000 });
  await fs.symlink(outside, path.join(paths.current, 'credentials', 'kimi-code.json'));
  await assert.rejects(readOAuth(paths, {}, 'darwin', now), /format/);
});
test('Kimi uses live service activity with strict heartbeat/PID/port checks, no history guesses', async t => {
  const f = await fixture(t); await f.server(); let running = ['PRIVATE_SESSION']; let waiting = []; let calls = 0;
  const reader = createReader({ home: f.home, env: {}, checkPort: async (pid, port) => pid === 123 && port === 34567,
    request: async args => { calls++; assert.equal(args.token, 'PRIVATE_LOCAL_TOKEN'); assert.equal(args.hostname, '127.0.0.1'); return page(args.endpoint === SESSION_PATHS.running ? running : waiting); } });
  let result = await reader.poll(processes, now);
  assert.equal(result.activity, 'running'); assert.equal(result.activeTasks, 1); assert.equal(result.source, 'local-api');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  running = []; waiting = ['PRIVATE_WAIT']; assert.equal((await reader.poll(processes, now)).activity, 'waiting');
  waiting = []; assert.equal((await reader.poll(processes, now)).activity, 'idle');
  const before = calls;
  assert.equal((await reader.poll(processes, now + 60001)).activity, 'unknown'); assert.equal(calls, before);
  assert.equal((await reader.poll([], now)).activity, 'offline'); assert.equal(calls, before);
  await f.server('SERVER', { host: 'remote.invalid' }); await reader.poll(processes, now); assert.equal(calls, before);
});
test('Kimi deduplicates active sessions across instances and refuses incomplete or invalid API data', async t => {
  const f = await fixture(t); await f.server(); await f.server('SERVER_TWO'); let incomplete = false;
  const reader = createReader({ home: f.home, env: {}, checkPort: async () => true,
    request: async args => incomplete ? { code: 0, data: { items: [], total: 2, has_more: true } } : page(args.endpoint === SESSION_PATHS.running ? ['same'] : []) });
  assert.equal((await reader.poll(processes, now)).activeTasks, 1);
  incomplete = true; const result = await reader.poll(processes, now); assert.equal(result.activity, 'unknown'); assert.equal(result.activeTasks, 0);
  const wrongOwner = createReader({ home: f.home, env: {}, checkPort: async () => false, request: () => assert.fail('no request to unowned port') });
  assert.equal((await wrongOwner.poll(processes, now)).activity, 'unknown');
});
test('Kimi accepts official base64url server token with 0600 mode and rejects permissive or multiline tokens', async t => {
  const f = await fixture(t); await f.server(); const token = Buffer.alloc(32, 123).toString('base64url');
  const file = await f.write('.kimi-code/server.token', token); let calls = 0;
  const reader = createReader({ home: f.home, env: {}, platform: 'darwin', checkPort: async () => true,
    request: async args => { calls++; assert.equal(args.token, token); return page([]); } });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await reader.poll(processes, now)).activity, 'idle'); assert.equal(calls, 2);
  await fs.chmod(file, 0o644);
  assert.equal((await reader.poll(processes, now)).activity, 'unknown'); assert.equal(calls, 2);
  await fs.chmod(file, 0o600); await fs.writeFile(file, token + '\ninvalid');
  assert.equal((await reader.poll(processes, now)).activity, 'unknown'); assert.equal(calls, 2);
});
test('Kimi refuses invalid future heartbeats and bounds known local endpoints', async () => {
  const row = { server_id: 'S', pid: 123, host: 'localhost', port: 1, heartbeat_at: now };
  assert.equal(validInstance(row, 'S.json', processes, now), true);
  assert.equal(validInstance({ ...row, heartbeat_at: now + 5001 }, 'S.json', processes, now), false);
  assert.equal(validInstance(row, '../S.json', processes, now), false);
  await assert.rejects(requestJson({ hostname: 'other.invalid', endpoint: '/coding/v1/usages', token: 'private' }), /endpoint/);
  await assert.rejects(requestJson({ hostname: '127.0.0.1', port: 123, endpoint: '/api/v2/sessions::archive', token: 'private' }), /endpoint/);
});
function mockTransport(status, body, headers = {}) {
  return { request(options, callback) {
    assert.equal(options.method, 'GET'); assert.equal(options.agent, false);
    const req = new EventEmitter(); req.destroy = () => req.emit('close');
    req.end = () => setImmediate(() => {
      const res = new PassThrough(); res.statusCode = status; res.headers = headers;
      callback(res); if (!res.destroyed) res.end(body); setImmediate(() => req.emit('close'));
    }); return req;
  } };
}
test('Kimi HTTP transport rejects redirect, oversized response and respects rate limit', async () => {
  const args = { hostname: 'api.kimi.com', endpoint: '/coding/v1/usages', token: 'PRIVATE_TOKEN' };
  assert.deepEqual(await requestJson(args, { transport: mockTransport(200, JSON.stringify(usage)) }), usage);
  await assert.rejects(requestJson(args, { transport: mockTransport(302, '', { location: 'https://other.invalid' }) }), /network/);
  await assert.rejects(requestJson(args, { transport: mockTransport(200, 'x'.repeat(128 * 1024 + 1)) }), /format/);
  await assert.rejects(requestJson(args, { transport: mockTransport(429, '', { 'retry-after': '120' }) }), error => error.code === 'rate' && error.retryMs === 120000);
  await assert.rejects(requestJson(args, { transport: mockTransport(401, 'PRIVATE_ERROR') }), error => error.code === 'login' && !error.message.includes('PRIVATE'));
});
test('Kimi total deadline stops a nonresponsive local service', async () => {
  let destroyed = false;
  const transport = { request() { const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { destroyed = true; req.emit('close'); }; return req; } };
  await assert.rejects(requestJson({ hostname: '127.0.0.1', port: 123, endpoint: SESSION_PATHS.running, token: 'private' }, { transport, timeoutMs: 5 }), /network/);
  assert.equal(destroyed, true);
});

test('Kimi only displays allowlisted /me product names, never nickname or numeric levels', () => {
  for (const name of ['Andante', 'Moderato', 'Allegretto', 'Allegro', 'Vivace', 'Plus', 'Pro', 'Max', 'Ultra']) {
    assert.equal(normalizeKimiPlan({ ...profile, user_level_name: name }).name, name);
  }
  for (const payload of [
    { ...profile, user_level_name: 'PRIVATE_PLAN', nickname: 'Pro' },
    { user_id: 'PRIVATE', user_level: 30, nickname: 'Moderato' },
    { ...profile, user_level_name: '__proto__' },
  ]) assert.deepEqual(normalizeKimiPlan(payload), { name: null });
  assert.throws(() => normalizeKimiPlan({ user_level_name: 'Pro' }), /format/);
});
test('Kimi queries the official profile independently and preserves usage on profile errors', async t => {
  const f = await fixture(t); await f.login(); let profileCalls = 0; let quotaCalls = 0;
  const reader = new KimiStatusReader({ home: f.home, env: {}, request: async args => {
    assert.equal(args.hostname, 'api.kimi.com'); assert.equal(args.token, 'PRIVATE_TOKEN');
    if (args.endpoint === '/coding/v1/usages') { quotaCalls++; return usage; }
    assert.equal(args.endpoint, '/coding/v1/me');
    if (++profileCalls > 1) throw new KimiError('network');
    return { ...profile, nickname: 'PRIVATE_NICKNAME', email: 'PRIVATE_MAIL' };
  } });
  const result = await reader.poll([], now);
  assert.deepEqual(result.plan, { name: 'Moderato', stale: false });
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  const old = await reader.poll([], now + 60000);
  assert.deepEqual(old.plan, { name: 'Moderato', stale: true });
  assert.equal(old.quotas[0].remaining, 70); assert.equal(old.quotas[0].stale, false);
  assert.equal(old.connection, 'ready'); assert.equal(quotaCalls, 2); assert.equal(profileCalls, 2);
});
test('Kimi missing or unknown new product clears the old plan without hiding valid quota', async t => {
  const f = await fixture(t); await f.login(); let current = profile;
  const reader = createReader({ home: f.home, env: {}, request: async () => usage, requestPlan: async () => current });
  assert.equal((await reader.poll([], now)).plan.name, 'Moderato');
  current = { ...profile, user_level_name: 'PRIVATE_NEW_PLAN' };
  const changed = await reader.poll([], now + 60000);
  assert.equal(changed.plan.name, null); assert.equal(changed.plan.stale, false); assert.equal(changed.quotas[0].remaining, 70);
});
test('Kimi plan follows account changes, logout and authorization revocation', async t => {
  const f = await fixture(t); const file = await f.login(); let next = profile;
  const reader = createReader({ home: f.home, env: {}, request: async () => usage, requestPlan: async () => next });
  assert.equal((await reader.poll([], now)).plan.name, 'Moderato');
  await f.login('PRIVATE_NEW'); next = { ...profile, user_level_name: 'Pro' };
  assert.equal((await reader.poll([], now + 1)).plan.name, 'Pro');
  await fs.unlink(file); const out = await reader.poll([], now + 2);
  assert.equal(out.plan.name, null); assert.deepEqual(out.quotas, []);
  await f.login(); reader.requestPlan = async () => { throw new KimiError('login'); };
  const denied = await reader.poll([], now + 3);
  assert.equal(denied.plan.name, null); assert.deepEqual(denied.quotas, []); assert.equal(denied.connection, 'auth-required');
});
test('Kimi plan and quota are discarded together on an in-flight account change', async t => {
  const f = await fixture(t); await f.login();
  const reader = createReader({ home: f.home, env: {}, request: async () => usage,
    requestPlan: async () => { await f.login('PRIVATE_NEW'); return profile; } });
  const result = await reader.poll([], now);
  assert.deepEqual(result.plan, { name: null }); assert.deepEqual(result.quotas, []);
});
test('Kimi profile rate limits preserve fresh usage and apply the server cooldown', async t => {
  const f = await fixture(t); await f.login(); let calls = 0;
  const reader = createReader({ home: f.home, env: {}, request: async () => { calls++; return usage; },
    requestPlan: async () => { throw new KimiError('rate', 180000); } });
  const first = await reader.poll([], now);
  assert.equal(first.quotas[0].remaining, 70); assert.equal(first.plan.name, null);
  await reader.poll([], now + 179999); assert.equal(calls, 1);
  await reader.poll([], now + 180000); assert.equal(calls, 2);
});
test('Kimi profile transport accepts only the fixed official GET and rejects other profile endpoints', async () => {
  const args = { hostname: 'api.kimi.com', endpoint: '/coding/v1/me', token: 'PRIVATE_TOKEN' };
  assert.deepEqual(await requestJson(args, { transport: mockTransport(200, JSON.stringify(profile)) }), profile);
  await assert.rejects(requestJson({ ...args, endpoint: '/coding/v1/me/update' }), /endpoint/);
  await assert.rejects(requestJson({ ...args, hostname: 'api.other.invalid' }), /endpoint/);
  await assert.rejects(requestJson(args, { transport: mockTransport(302, '') }), /network/);
});

test('Kimi valid plan remains available when the independent quota endpoint fails', async t => {
  const f = await fixture(t); await f.login();
  const reader = createReader({ home: f.home, env: {}, request: async () => { throw new KimiError('network'); } });
  const result = await reader.poll([], now);
  assert.deepEqual(result.plan, { name: 'Moderato', stale: false });
  assert.deepEqual(result.quotas, []); assert.equal(result.source, 'account'); assert.equal(result.connection, 'ready');
});
