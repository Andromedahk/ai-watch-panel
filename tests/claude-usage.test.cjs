const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCipheriv, createHash, pbkdf2Sync } = require('node:crypto');
const { ClaudeUsageReader, ClaudeUsageError, desktopCredential, decryptStorage, readCodeSnapshot,
  readDesktopSnapshot, requestJson, normalizeProfile, normalizeUsage, CLIENT, ORIGIN, ENDPOINTS } = require('../electron/claude-usage.cjs');

// Entirely synthetic: these tests never access a user's profile, Keychain or network.
const NOW = Date.parse('2026-10-08T00:00:00Z');
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const PASSWORD = 'synthetic-safe-storage-password';
const TOKEN = 'synthetic-access-token';
const SCOPE = 'user:inference user:file_upload user:profile';
const profile = (account = ACCOUNT, org = ORG, type = 'claude_pro') => ({ account: { uuid: account },
  organization: { uuid: org, organization_type: type }, private: 'DO_NOT_EXPOSE' });
const usage = () => ({ five_hour: { utilization: 25, resets_at: new Date(NOW + 3600000).toISOString() },
  seven_day: { utilization: 0, resets_at: (NOW + 86400000) / 1000 }, private: 'DO_NOT_EXPOSE' });
function encrypt(text, password = PASSWORD, host) {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
  const clear = Buffer.concat([host ? createHash('sha256').update(host).digest() : Buffer.alloc(0), Buffer.from(text)]);
  return Buffer.concat([Buffer.from('v10'), cipher.update(clear), cipher.final()]);
}
function desktop({ key, entry, account = ACCOUNT, org = ORG, password = PASSWORD, version = 24, host = '.claude.ai' } = {}) {
  const cache = { [key ?? `acct:${account}|${CLIENT}:${org}:${ORIGIN}:${SCOPE}`]: entry ?? { token: TOKEN, expiresAt: NOW + 3600000 } };
  const encryptedCache = encrypt(JSON.stringify(cache), password).toString('base64');
  return { account, org: { encrypted_value: encrypt(org, password, version >= 24 ? host : null), value: '' },
    encryptedCache, version, identity: createHash('sha256').update(encryptedCache).digest('hex') };
}
const code = (identity = 'identity-a', token = TOKEN) => ({ identity, credential: { token, account: ACCOUNT, org: ORG } });
const errorIs = code => error => error instanceof ClaudeUsageError && error.code === code && error.message === code;
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  const calls = []; let snapshot = code(), desktopSnapshot = desktop();
  const reader = new ClaudeUsageReader({ paths: { desktop: 'synthetic-desktop', config: 'synthetic-code' }, allowed: true,
    platform: 'darwin', getPassword: async () => PASSWORD, readDesktop: async () => desktopSnapshot,
    readCode: async () => snapshot, request: async (kind, token, options) => { calls.push({ kind, token, signal: options.signal });
      return kind === 'profile' ? profile() : usage(); }, ...options });
  return { reader, calls, setCode: value => { snapshot = value; }, setDesktop: value => { desktopSnapshot = value; } };
}
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-claude-usage-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory;
}
function response(kind, body, options = {}) {
  const r = new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: options.status ?? 200, headers: options.headers });
  Object.defineProperty(r, 'url', { value: options.url ?? ORIGIN + ENDPOINTS[kind] }); return r;
}

test('profile normalization verifies both identities and only exposes recognized plans', () => {
  assert.deepEqual(normalizeProfile(profile(), { account: ACCOUNT, org: ORG }), { name: 'Pro', stale: false });
  const max = profile(ACCOUNT, ORG, 'claude_max'); max.organization.rate_limit_tier = 'default_claude_max_20x';
  assert.equal(normalizeProfile(max, {}).name, 'Max 20×');
  assert.equal(normalizeProfile(profile(ACCOUNT, ORG, 'DO_NOT_EXPOSE'), {}).name, null);
  for (const p of [profile(OTHER), profile(ACCOUNT, OTHER), {}, null]) {
    assert.throws(() => normalizeProfile(p, { account: ACCOUNT, org: ORG }), errorIs('auth'));
  }
});
test('official quota formats preserve exact zero, null and numeric reset times', () => {
  const result = normalizeUsage({ five_hour: { utilization: 100, resets_at: (NOW + 1000) / 1000 },
    seven_day: { utilization: 0, resets_at: new Date(NOW + 2000).toISOString() }, seven_day_opus: null,
    seven_day_sonnet: { utilization: null }, limits: [{ kind: 'weekly_scoped', percent: 12.5,
      resets_at: (NOW - 1000) / 1000, scope: { model: { display_name: 'Claude Sonnet 4.6' } } }],
    extra_usage: { private: 'DO_NOT_EXPOSE' } }, NOW);
  assert.deepEqual(result.quotas.map(row => row.remaining), [0, 100, 87.5]);
  assert.equal(result.quotas[0].reset, new Date(NOW + 1000).toISOString());
  assert.equal(result.quotas[2].stale, true);
  assert.equal(normalizeUsage({ five_hour: null, seven_day: null, extra_usage: null }, NOW).quotas.length, 0);
  assert.deepEqual(normalizeUsage({ seven_day: { utilization: -1 }, five_hour: { utilization: '0' } }, NOW).quotas, []);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE|extra_usage/);
  for (const payload of [null, [], {}, { seven_day_fake: 2 }, { limits: Array(33).fill({}) }, { limits: {} }]) {
    assert.throws(() => normalizeUsage(payload, NOW), errorIs('format'));
  }
});
test('desktop crypto binds Cookie v24 plaintext to the exact host and leaves caller bytes intact', () => {
  const bytes = encrypt(ORG, PASSWORD, '.claude.ai'), original = Buffer.from(bytes);
  assert.equal(decryptStorage(bytes, PASSWORD, '.claude.ai'), ORG); assert.deepEqual(bytes, original);
  assert.throws(() => decryptStorage(bytes, PASSWORD, 'claude.ai'), errorIs('format'));
  assert.throws(() => decryptStorage(bytes, 'wrong-password', '.claude.ai'), errorIs('format'));
  for (const input of [Buffer.from('v11bad'), Buffer.alloc(19), 'not-buffer', null]) {
    assert.throws(() => decryptStorage(input, PASSWORD), errorIs('format'));
  }
  assert.deepEqual(desktopCredential(desktop(), PASSWORD, NOW), { token: TOKEN, account: ACCOUNT, org: ORG });
  assert.equal(desktopCredential(desktop({ version: 23 }), PASSWORD, NOW).token, TOKEN);
});
test('desktop selects only an unexpired token with exact account, org, host, client and supported scope', () => {
  const prefix = `acct:${ACCOUNT}|${CLIENT}:${ORG}:${ORIGIN}:`;
  for (const suffix of [SCOPE, SCOPE + ' user:plugins', SCOPE + ' user:sessions:claude_code',
    SCOPE + ' user:sessions:claude_code user:plugins']) {
    assert.equal(desktopCredential(desktop({ key: prefix + suffix }), PASSWORD, NOW).token, TOKEN);
  }
  for (const key of [prefix.replace(ACCOUNT, OTHER) + SCOPE, prefix.replace(ORG, OTHER) + SCOPE,
    prefix.replace(CLIENT, OTHER) + SCOPE, prefix.replace(ORIGIN, ORIGIN + '.example') + SCOPE,
    prefix.slice(5) + SCOPE, prefix + 'user:profile', prefix + SCOPE + ' user:profile', prefix + SCOPE + ' user:unknown',
    prefix + SCOPE.replace(' ', '  '), prefix + SCOPE + ':private', prefix + SCOPE + '\n']) {
    assert.throws(() => desktopCredential(desktop({ key }), PASSWORD, NOW), errorIs('login'));
  }
  for (const entry of [{ token: TOKEN, expiresAt: NOW + 30000 }, { token: TOKEN, expiresAt: String(NOW + 3600000) },
    { token: 'invalid\nheader', expiresAt: NOW + 3600000 }]) {
    assert.throws(() => desktopCredential(desktop({ entry }), PASSWORD, NOW), errorIs('login'));
  }
});
test('CLI credentials require private permissions, a regular contained file and an unexpired profile scope', async t => {
  const directory = await temporary(t), file = path.join(directory, '.credentials.json');
  const write = async oauth => { await fs.writeFile(file, JSON.stringify({ claudeAiOauth: oauth }), { mode: 0o600 }); await fs.chmod(file, 0o600); };
  const oauth = { accessToken: TOKEN, expiresAt: NOW + 3600000, scopes: ['user:profile'] };
  await write(oauth); assert.equal((await readCodeSnapshot(directory, 'darwin', NOW)).credential.token, TOKEN);
  await fs.chmod(file, 0o644); await assert.rejects(readCodeSnapshot(directory, 'darwin', NOW), errorIs('login'));
  await write({ ...oauth, scopes: ['user:inference'] }); await assert.rejects(readCodeSnapshot(directory, 'darwin', NOW), errorIs('login'));
  await write({ ...oauth, expiresAt: NOW - 1 }); await assert.rejects(readCodeSnapshot(directory, 'darwin', NOW), errorIs('login'));
  await write(oauth); const outside = path.join(directory, 'other.json'); await fs.rename(file, outside); await fs.symlink(outside, file);
  await assert.rejects(readCodeSnapshot(directory, 'darwin', NOW), errorIs('login'));
  await fs.unlink(file); await fs.writeFile(file, Buffer.alloc(65537), { mode: 0o600 });
  await assert.rejects(readCodeSnapshot(directory, 'darwin', NOW), errorIs('login'));
});
test('desktop snapshot validates current cookie presence, expiry and symlink boundaries without decrypting sessions', async t => {
  const root = await temporary(t); const snapshot = desktop();
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ACCOUNT, 'oauth:tokenCacheV2': snapshot.encryptedCache }));
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(root, 'Cookies'));
  t.after(() => db.close());
  db.exec('CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES(\'version\',\'24\'); CREATE TABLE cookies(name TEXT,host_key TEXT,path TEXT,value TEXT,encrypted_value BLOB,expires_utc,creation_utc,has_expires INTEGER)');
  const expires = String(BigInt(NOW + 3600000) * 1000n + 11644473600000000n);
  const insert = db.prepare('INSERT INTO cookies VALUES(?,\'.claude.ai\',\'/\',\'\',?,?,\'1\',1)');
  insert.run('sessionKey', encrypt('synthetic-session-never-sent', PASSWORD, '.claude.ai'), expires);
  insert.run('lastActiveOrg', snapshot.org.encrypted_value, expires);
  const result = await readDesktopSnapshot(root, NOW);
  assert.equal(result.account, ACCOUNT); assert.equal(desktopCredential(result, PASSWORD, NOW).token, TOKEN);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-session-never-sent/);
  db.exec("UPDATE cookies SET expires_utc='invalid' WHERE name='sessionKey'");
  await assert.rejects(readDesktopSnapshot(root, NOW), errorIs('login'));
  db.prepare("UPDATE cookies SET expires_utc=? WHERE name='sessionKey'").run(expires);
  const config = path.join(root, 'config.json'), other = path.join(root, 'other.json');
  await fs.rename(config, other); await fs.symlink(other, config);
  await assert.rejects(readDesktopSnapshot(root, NOW), errorIs('format'));
});
test('network uses only fixed read-only endpoints, omits cookies and rejects redirects', async () => {
  const calls = [];
  for (const kind of ['profile', 'usage']) {
    const result = await requestJson(kind, TOKEN, { fetcher: async (url, options) => { calls.push({ url, options }); return response(kind, { okay: true }); } });
    assert.deepEqual(result, { okay: true });
  }
  for (const { url, options } of calls) {
    assert.ok(Object.values(ENDPOINTS).some(endpoint => url === ORIGIN + endpoint));
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN); assert.equal(options.body, undefined);
  }
  await assert.rejects(requestJson('usage', TOKEN, { fetcher: async () => response('usage', {}, { url: 'https://example.invalid' }) }), errorIs('format'));
  let invoked = false; const fetcher = async () => { invoked = true; return response('usage', {}); };
  for (const [kind, token, timeoutMs] of [['../usage', TOKEN, 8000], ['usage', 'bad\nheader', 8000],
    ['usage', TOKEN, 0], ['usage', TOKEN, Infinity], ['usage', TOKEN, 15001]]) {
    await assert.rejects(requestJson(kind, token, { fetcher, timeoutMs }), errorIs('format'));
  }
  assert.equal(invoked, false);
});
test('network bounds response bytes and deadline, sanitizes failures and honors abort before sending', async () => {
  await assert.rejects(requestJson('usage', TOKEN, { fetcher: async () => response('usage', 'x'.repeat(256 * 1024 + 1)) }), errorIs('format'));
  await assert.rejects(requestJson('usage', TOKEN, { fetcher: async () => response('usage', '{broken') }), errorIs('format'));
  await assert.rejects(requestJson('usage', TOKEN, { timeoutMs: 100, fetcher: async () => new Promise(() => {}) }), errorIs('network'));
  await assert.rejects(requestJson('usage', TOKEN, { fetcher: async () => { throw new Error('PRIVATE_AUTH_PATH'); } }), errorIs('network'));
  const controller = new AbortController(); controller.abort(); let invoked = false;
  await assert.rejects(requestJson('usage', TOKEN, { signal: controller.signal, fetcher: async () => { invoked = true; } }), errorIs('network'));
  assert.equal(invoked, false);
  for (const status of [401, 403]) await assert.rejects(requestJson('profile', TOKEN,
    { fetcher: async () => response('profile', 'PRIVATE_AUTH_BODY', { status }) }), errorIs('auth'));
  for (const [value, expected] of [[undefined, 300000], ['0', 60000], ['120', 120000], ['99999999', 86400000]]) {
    await assert.rejects(requestJson('usage', TOKEN, { fetcher: async () => response('usage', {},
      { status: 429, headers: value === undefined ? {} : { 'retry-after': value } }) }), error => errorIs('rate')(error) && error.retryMs === expected);
  }
});
test('successful desktop/CLI polls expose only normalized data and cache/force requests are bounded', async () => {
  for (const source of ['desktop', 'code']) {
    const f = fixture(); const first = await f.reader.poll(source, NOW);
    assert.equal(first.state, 'ready'); assert.equal(first.plan.name, 'Pro'); assert.deepEqual(first.usage.quotas.map(row => row.remaining), [75, 100]);
    assert.doesNotMatch(JSON.stringify(first), /synthetic-|DO_NOT_EXPOSE|account|token|uuid/);
    await f.reader.poll(source, NOW + 14999, true); assert.equal(f.calls.length, 2);
    await f.reader.poll(source, NOW + 15000, true); assert.equal(f.calls.length, 4);
    await f.reader.poll(source, NOW + 30000); assert.equal(f.calls.length, 4);
    await f.reader.poll(source, NOW + 315000); assert.equal(f.calls.length, 6);
  }
});
test('a single reader coalesces concurrent refreshes and verifies profile before requesting usage', async () => {
  const gate = deferred(), began = deferred(); const calls = [];
  const f = fixture({ request: async kind => { calls.push(kind); if (kind === 'profile') { began.resolve(); await gate.promise; return profile(); } return usage(); } });
  const first = f.reader.poll('code', NOW); await began.promise;
  const duplicate = f.reader.poll('code', NOW, true); gate.resolve();
  assert.deepEqual(await first, await duplicate); assert.deepEqual(calls, ['profile', 'usage']);
  const mismatch = fixture({ request: async kind => { calls.push(kind); return profile(OTHER); } });
  assert.equal((await mismatch.reader.poll('code', NOW)).state, 'auth');
  assert.deepEqual(calls, ['profile', 'usage', 'profile']);
});
test('expired/login failures and account switches immediately discard previous quotas', async () => {
  let fail = false; const f = fixture({ readCode: async () => { if (fail) throw new ClaudeUsageError('login'); return code(); } });
  assert.equal((await f.reader.poll('code', NOW)).plan.name, 'Pro'); fail = true;
  const loggedOut = await f.reader.poll('code', NOW + 1); assert.equal(loggedOut.state, 'login'); assert.equal(loggedOut.usage, undefined);
  const g = fixture(); await g.reader.poll('code', NOW); g.setCode(code('identity-b', 'different-synthetic-token'));
  g.reader.request = async () => { throw new ClaudeUsageError('network'); };
  const changed = await g.reader.poll('code', NOW + 1); assert.equal(changed.state, 'network'); assert.equal(changed.plan, undefined);
});
test('identity changes while profile or usage is in flight cannot cache the old account', async () => {
  for (const phase of ['profile', 'usage']) {
    const gate = deferred(), began = deferred(); const calls = [];
    const f = fixture({ request: async kind => { calls.push(kind); if (kind === phase) { began.resolve(); await gate.promise; }
      return kind === 'profile' ? profile() : usage(); } });
    const pending = f.reader.poll('code', NOW); await began.promise; f.setCode(code('new-identity')); gate.resolve();
    const result = await pending; assert.equal(result.state, 'auth'); assert.equal(result.usage, undefined);
    assert.equal(f.reader.cache, null); if (phase === 'profile') assert.deepEqual(calls, ['profile']);
  }
});
test('401 invalidates and latches the credential until a new local identity appears', async () => {
  let calls = 0; const f = fixture({ request: async () => { calls++; throw new ClaudeUsageError('auth'); } });
  assert.equal((await f.reader.poll('code', NOW)).state, 'auth');
  await f.reader.poll('code', NOW + 300000, true); assert.equal(calls, 1);
  f.setCode(code('rotated-identity')); await f.reader.poll('code', NOW + 300001); assert.equal(calls, 2);
});
test('429 backoff cannot be bypassed by force, token rotation, source changes or consent toggles', async () => {
  let calls = 0; const f = fixture({ request: async () => { calls++; throw new ClaudeUsageError('rate', 120000); } });
  await f.reader.poll('code', NOW); await f.reader.poll('code', NOW + 1000, true);
  f.setCode(code('rotated')); await f.reader.poll('code', NOW + 2000, true);
  await f.reader.poll('desktop', NOW + 3000, true); f.reader.setAllowed(false); f.reader.setAllowed(true);
  await f.reader.poll('code', NOW + 4000, true); assert.equal(calls, 1);
  await f.reader.poll('code', NOW + 120000, true); assert.equal(calls, 2);
});
test('network failures preserve only stale history while missing and null quotas remain unknown', async () => {
  const f = fixture(); await f.reader.poll('code', NOW);
  f.reader.request = async () => { throw new Error('PRIVATE_AUTH_PATH'); };
  const failed = await f.reader.poll('code', NOW + 300000); assert.equal(failed.state, 'network');
  assert.equal(failed.plan.stale, true); assert.ok(failed.usage.quotas.every(row => row.stale));
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_AUTH_PATH|synthetic-/);
  const g = fixture({ request: async kind => kind === 'profile' ? profile(ACCOUNT, ORG, 'claude_free') : { five_hour: null, seven_day: null } });
  const free = await g.reader.poll('code', NOW); assert.equal(free.plan.name, 'Free'); assert.deepEqual(free.usage.quotas, []);
});
test('disabled, unsupported or invalid requests never touch local auth, Keychain or network', async () => {
  let calls = 0; const touch = async () => { calls++; throw new Error('must not be reached'); };
  const f = fixture({ allowed: false, getPassword: touch, readDesktop: touch, readCode: touch, request: touch });
  assert.equal((await f.reader.poll('desktop', NOW)).state, 'disabled'); f.reader.setAllowed(true); f.reader.platform = 'linux';
  assert.equal((await f.reader.poll('desktop', NOW)).state, 'platform');
  assert.equal((await f.reader.poll('invalid-source', NOW)).state, 'format');
  assert.equal((await f.reader.poll('code', Infinity)).state, 'format'); assert.equal(calls, 0);
});
test('revoking consent and switching source abort in-flight work and ignore its eventual result', async () => {
  for (const action of ['disable', 'source']) {
    const gate = deferred(), began = deferred(); let oldSignal; const calls = [];
    const f = fixture({ request: async (kind, token, options) => { calls.push(kind); if (!oldSignal) { oldSignal = options.signal; began.resolve(); await gate.promise; }
      return kind === 'profile' ? profile() : usage(); } });
    const pending = f.reader.poll('code', NOW); await began.promise;
    if (action === 'disable') f.reader.setAllowed(false); else { f.reader.clearSource(); await f.reader.poll('desktop', NOW + 1); }
    assert.equal(oldSignal.aborted, true); gate.resolve(); assert.equal((await pending).state, 'disabled');
    if (action === 'disable') { assert.deepEqual(calls, ['profile']); assert.equal(f.reader.cache, null); }
    else assert.equal(f.reader.source, 'desktop');
  }
});
test('Keychain refusal is not retried automatically, but explicit manual retry can recover', async () => {
  let keychain = 0; const f = fixture({ getPassword: async () => { keychain++; if (keychain === 1) throw new Error('PRIVATE_AUTH_PATH'); return PASSWORD; } });
  assert.equal((await f.reader.poll('desktop', NOW)).state, 'keychain');
  await f.reader.poll('desktop', NOW + 60000); await f.reader.poll('desktop', NOW + 120000); assert.equal(keychain, 1);
  assert.equal((await f.reader.poll('desktop', NOW + 120001, true)).state, 'ready'); assert.equal(keychain, 2);
});
test('obsolete Keychain success/refusal cannot change the password or failure state of a new generation', async () => {
  for (const reject of [false, true]) {
    const gate = deferred(), began = deferred(); let keychain = 0;
    const f = fixture({ getPassword: async () => { if (++keychain === 1) { began.resolve(); return gate.promise; } return PASSWORD; } });
    const pending = f.reader.poll('desktop', NOW); await began.promise;
    f.reader.setAllowed(false); f.reader.setAllowed(true);
    assert.equal((await f.reader.poll('desktop', NOW + 1)).state, 'ready');
    if (reject) gate.reject(new Error('obsolete-refusal')); else gate.resolve('obsolete-password');
    assert.equal((await pending).state, 'disabled'); assert.equal(f.reader.password, PASSWORD); assert.equal(f.reader.keychainFailed, false);
  }
});
