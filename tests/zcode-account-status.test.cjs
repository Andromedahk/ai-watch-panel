const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, createCipheriv } = require('node:crypto');
const { ZcodeAccountError } = require('../electron/zcode-account-api.cjs');
const { ZcodeAccountStatusReader, ZcodeAccountStatusError, resolveZcodeAccountPaths, isZcodeMainProcess,
  credentialKey, decryptCredential, readZcodeAccountIdentity, MAX_COOLDOWNS } = require('../electron/zcode-account-status.cjs');

const NOW = Date.parse('2026-10-03T00:00:00Z');
const COMMAND = '/Applications/ZCode.app/Contents/MacOS/ZCode';
const PROCESS = [{ pid: 2468, command: COMMAND }];
const hash = value => createHash('sha256').update(value).digest('hex');
const defaultRuntimeContext = async () => ({ fingerprint: hash('default-process-context') });
const success = data => ({ success: true, code: 0, data });
const subscription = (name = 'GLM Coding Pro') => success([{ status: 'VALID', inCurrentPeriod: true, productName: name }]);
const quota = (percentage = 25, reset = Date.parse('2026-11-01T00:00:00Z')) => success({ limits: [
  { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage, nextResetTime: reset },
] });

function encrypt(value, key, nonce = 1) {
  const iv = Buffer.alloc(12, nonce); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

function processCommand() {
  return async (command, args) => {
    assert.equal(command, 'ps'); assert.equal(args[2], '2468');
    return { stdout: `${process.getuid()} Fri Oct  3 08:00:00 2026 ZCode\n` };
  };
}

async function fixture(t, changes = {}) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-zcode-account-'));
  const home = await fs.realpath(created); const env = {}; const username = 'fixture-user';
  const paths = resolveZcodeAccountPaths({ home, env, platform: 'darwin' });
  await fs.mkdir(paths.root, { recursive: true });
  const key = credentialKey({ env, platform: 'darwin', home, username });
  const uid = changes.uid || 'account-a'; const family = changes.family || 'bigmodel';
  const provider = `account:${family}-individual-coding-plan`;
  const exact = `account-provider:coding-plan:${provider}:account:${encodeURIComponent(uid)}:api-key`;
  const setting = { providerFamilyDomain: family,
    providerFamilyConnectionSelections: { [family]: { kind: changes.kind || 'individual-coding-plan' } },
    dataBaseDir: changes.dataBaseDir === undefined ? home : changes.dataBaseDir };
  const credentials = {
    'oauth:active_provider': encrypt(changes.active || family, key, 1),
    [`oauth:${family}:user_info`]: encrypt(JSON.stringify({ id: uid, username: 'PRIVATE_NAME', displayName: 'PRIVATE_DISPLAY' }), key, 2),
    [`oauth:${family}:access_token`]: encrypt('PRIVATE_OAUTH', key, 3),
    [exact]: encrypt('Bearer PRIVATE_API_KEY', key, 4),
    [`account-provider:coding-plan:${provider}:account:other:api-key`]: encrypt('PRIVATE_OTHER_KEY', key, 5),
    [`oauth:${family}:refresh_token`]: encrypt('PRIVATE_REFRESH', key, 6),
    ...changes.credentials,
  };
  await fs.writeFile(paths.setting, JSON.stringify(setting), { mode: 0o644 }); await fs.chmod(paths.setting, 0o644);
  await fs.writeFile(paths.credentials, JSON.stringify(credentials), { mode: 0o600 }); await fs.chmod(paths.credentials, 0o600);
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, env, username, paths, key, uid, setting, credentials, exact };
}

function localIdentity(uid = 'account-a', tokenVersion = 'one', runtime = 'runtime-one', snapshot = 'snapshot-one') {
  return { family: 'bigmodel', kind: 'individual-coding-plan', uid, oauthToken: `oauth-${tokenVersion}`,
    apiKey: `api-${tokenVersion}`, accountKey: hash(`account:${uid}`), signature: hash(`signature:${uid}:${tokenVersion}`),
    runtime: hash(runtime), snapshot: hash(snapshot) };
}

function requestFixture(options = {}) {
  const calls = [];
  const request = async (family, kind, token) => {
    calls.push({ family, kind, token });
    if (options.fail?.[kind]) throw options.fail[kind];
    if (kind === 'identity') return success({ customerNumber: options.remoteUid || 'account-a', privateName: 'PRIVATE_REMOTE' });
    if (kind === 'subscription') return subscription(options.plan);
    return quota(options.percentage, options.reset);
  };
  return { calls, request };
}

test('ZCode account uses only the default v2 root and rejects conflicting roots or custom hosts', () => {
  const paths = resolveZcodeAccountPaths({ home: '/fixture', env: {}, platform: 'darwin' });
  assert.equal(paths.setting, '/fixture/.zcode/v2/setting.json'); assert.equal(paths.credentials, '/fixture/.zcode/v2/credentials.json');
  for (const env of [{ HOME: '/other' }, { ZCODE_DATA_BASE_DIR: 'relative' }, { ZCODE_DESKTOP_HOME_DIR: '/other' },
    { BIGMODEL_API_BASE_URL: 'https://other.invalid' }, { BIGMODEL_TEST_API_BASE_URL: 'https://other.invalid' },
    { ZAI_PRODUCTION_BUSINESS_BASE_URL: 'https://other.invalid' }, { BIGMODEL_OAUTH_USERINFO_URL: 'https://other.invalid' },
    { ZCODE_ENV: 'test' }, { ZCODE_ENV: ' TEST ' }, { ZCODE_ENV: 'unknown' }]) {
    assert.throws(() => resolveZcodeAccountPaths({ home: '/fixture', env, platform: 'darwin' }), { code: 'unsupported' });
  }
  for (const value of [undefined, '', '  ', ' PRODUCTION ']) {
    assert.equal(resolveZcodeAccountPaths({ home: '/fixture', env: value === undefined ? {} : { ZCODE_ENV: value }, platform: 'darwin' }).root,
      '/fixture/.zcode/v2');
  }
  assert.throws(() => resolveZcodeAccountPaths({ home: '/fixture', env: {}, platform: 'linux' }), { code: 'unsupported' });
});

test('ZCode main-process predicate excludes helpers, CLI and command arguments', () => {
  for (const command of [COMMAND, 'ZCode']) assert.equal(isZcodeMainProcess(command), true);
  for (const command of ['/bin/zcode', '/Applications/ZCode.app/Contents/Frameworks/ZCode Helper', `${COMMAND} --flag`, 'ZCode Helper']) {
    assert.equal(isZcodeMainProcess(command), false);
  }
});

test('ZCode non-production environment stops before process, credential, or account access', async () => {
  for (const environment of ['test', ' TEST ', 'unknown']) {
    let commands = 0; let requests = 0;
    const reader = new ZcodeAccountStatusReader({ home: '/fixture', env: { ZCODE_ENV: environment }, platform: 'darwin',
      runCommand: async () => { commands++; }, request: async () => { requests++; } });
    const result = await reader.poll(PROCESS, NOW);
    assert.equal(commands, 0); assert.equal(requests, 0); assert.equal(result.connection, 'unavailable'); assert.deepEqual(result.quotas, []);
  }
});

test('ZCode decrypts only the current BigModel individual account and exact cached key', async t => {
  const f = await fixture(t);
  const result = await readZcodeAccountIdentity(PROCESS, { home: f.home, env: f.env, platform: 'darwin', username: f.username,
    runCommand: processCommand(), readRuntimeContext: defaultRuntimeContext });
  assert.equal(result.family, 'bigmodel'); assert.equal(result.kind, 'individual-coding-plan'); assert.equal(result.uid, f.uid);
  assert.equal(result.oauthToken, 'PRIVATE_OAUTH'); assert.equal(result.apiKey, 'PRIVATE_API_KEY');
  for (const name of ['accountKey', 'signature', 'runtime', 'snapshot']) assert.match(result[name], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NAME|PRIVATE_OTHER_KEY|PRIVATE_REFRESH/);
  assert.equal(decryptCredential('legacy-token', f.key), 'legacy-token');
  const blankRoot = await fixture(t, { dataBaseDir: '   ' });
  assert.equal((await readZcodeAccountIdentity(PROCESS, { home: blankRoot.home, env: {}, platform: 'darwin', username: blankRoot.username,
    runCommand: processCommand(), readRuntimeContext: defaultRuntimeContext })).uid, blankRoot.uid);
});

test('ZCode returns unavailable before account reads for missing or multiple main processes', async t => {
  const f = await fixture(t); let commands = 0; const runCommand = async () => { commands++; return ''; };
  for (const processes of [[], null, [PROCESS[0], { pid: 2469, command: 'ZCode' }]]) {
    await assert.rejects(readZcodeAccountIdentity(processes, { home: f.home, env: {}, platform: 'darwin', username: f.username, runCommand }), { code: 'unavailable' });
  }
  assert.equal(commands, 0);
});

test('ZCode runtime root and environment failures prevent every account request', async () => {
  for (const code of ['unavailable', 'unsupported']) {
    let requests = 0;
    const reader = new ZcodeAccountStatusReader({ home: '/fixture', env: {}, platform: 'darwin',
      runCommand: processCommand(), readRuntimeContext: async () => { throw Object.assign(new Error('PRIVATE_RUNTIME'), { code }); },
      request: async () => { requests++; } });
    const result = await reader.poll(PROCESS, NOW);
    assert.equal(requests, 0); assert.deepEqual(result.quotas, []);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_RUNTIME|fixture/);
  }
});

test('ZCode honors the optional desktop session expiry without sending that JWT', async t => {
  const f = await fixture(t);
  const jwt = expiry => `header.${Buffer.from(JSON.stringify({ exp: expiry })).toString('base64url')}.signature`;
  const options = { home: f.home, env: {}, platform: 'darwin', username: f.username, now: NOW,
    runCommand: processCommand(), readRuntimeContext: defaultRuntimeContext };
  f.credentials.zcodejwttoken = encrypt(jwt((NOW + 60000) / 1000), f.key, 7);
  await fs.writeFile(f.paths.credentials, JSON.stringify(f.credentials));
  const valid = await readZcodeAccountIdentity(PROCESS, options);
  assert.equal(valid.uid, f.uid); assert.doesNotMatch(JSON.stringify(valid), /header\.|zcodejwttoken/);
  f.credentials.zcodejwttoken = encrypt(jwt((NOW - 1000) / 1000), f.key, 8);
  await fs.writeFile(f.paths.credentials, JSON.stringify(f.credentials));
  await assert.rejects(readZcodeAccountIdentity(PROCESS, options), { code: 'login' });
  f.credentials.zcodejwttoken = encrypt(jwt((NOW + 29000) / 1000), f.key, 9);
  await fs.writeFile(f.paths.credentials, JSON.stringify(f.credentials));
  await assert.rejects(readZcodeAccountIdentity(PROCESS, options), { code: 'login' });
  for (const session of ['opaque-desktop-session', 'header.e30.signature', jwt('unknown')]) {
    f.credentials.zcodejwttoken = encrypt(session, f.key, 10);
    await fs.writeFile(f.paths.credentials, JSON.stringify(f.credentials));
    const unknownExpiry = await readZcodeAccountIdentity(PROCESS, options);
    assert.equal(unknownExpiry.uid, f.uid);
    assert.equal(Object.hasOwn(unknownExpiry, 'session'), false);
  }
});

test('ZCode rejects team, Z.ai, relative data root, missing exact key and bad ciphertext', async t => {
  for (const changes of [{ kind: 'team-coding-plan' }, { family: 'zai' }, { dataBaseDir: 'relative' }]) {
    const f = await fixture(t, changes);
    await assert.rejects(readZcodeAccountIdentity(PROCESS, { home: f.home, env: {}, platform: 'darwin', username: f.username,
      runCommand: processCommand(), readRuntimeContext: defaultRuntimeContext }), { code: 'unsupported' });
  }
  const missing = await fixture(t); delete missing.credentials[missing.exact];
  await fs.writeFile(missing.paths.credentials, JSON.stringify(missing.credentials)); await fs.chmod(missing.paths.credentials, 0o600);
  await assert.rejects(readZcodeAccountIdentity(PROCESS, { home: missing.home, env: {}, platform: 'darwin', username: missing.username,
    runCommand: processCommand(), readRuntimeContext: defaultRuntimeContext }), { code: 'login' });
  const bad = await fixture(t); bad.credentials['oauth:active_provider'] = 'enc:v1:bad.bad.bad';
  await fs.writeFile(bad.paths.credentials, JSON.stringify(bad.credentials)); await fs.chmod(bad.paths.credentials, 0o600);
  await assert.rejects(readZcodeAccountIdentity(PROCESS, { home: bad.home, env: {}, platform: 'darwin', username: bad.username,
    runCommand: processCommand(), readRuntimeContext: defaultRuntimeContext }), { code: 'login' });
  const wrongSecret = await fixture(t);
  await assert.rejects(readZcodeAccountIdentity(PROCESS, { home: wrongSecret.home, env: {}, platform: 'darwin', username: 'different-user',
    runCommand: processCommand(), readRuntimeContext: defaultRuntimeContext }), { code: 'login' });
});

test('ZCode enforces owner-safe file modes and rejects symlinked account files', async t => {
  const permissive = await fixture(t); await fs.chmod(permissive.paths.credentials, 0o644);
  await assert.rejects(readZcodeAccountIdentity(PROCESS, { home: permissive.home, env: {}, platform: 'darwin', username: permissive.username,
    runCommand: processCommand(), readRuntimeContext: defaultRuntimeContext }), { code: 'permissions' });
  const linked = await fixture(t); const outside = path.join(linked.home, 'outside.json');
  await fs.rename(linked.paths.credentials, outside); await fs.symlink(outside, linked.paths.credentials);
  await assert.rejects(readZcodeAccountIdentity(PROCESS, { home: linked.home, env: {}, platform: 'darwin', username: linked.username,
    runCommand: processCommand(), readRuntimeContext: defaultRuntimeContext }), { code: 'permissions' });
});

test('ZCode keeps account and process generations stable across unrelated setting rewrites while snapshot changes', async t => {
  const f = await fixture(t); const options = { home: f.home, env: {}, platform: 'darwin', username: f.username, runCommand: processCommand(), readRuntimeContext: defaultRuntimeContext };
  const before = await readZcodeAccountIdentity(PROCESS, options);
  await fs.writeFile(f.paths.setting, JSON.stringify({ ...f.setting, unrelatedPreference: 'changed-and-longer' }));
  await fs.chmod(f.paths.setting, 0o644);
  const after = await readZcodeAccountIdentity(PROCESS, options);
  assert.equal(after.signature, before.signature); assert.equal(after.runtime, before.runtime); assert.notEqual(after.snapshot, before.snapshot);
});

test('ZCode account reader confirms remote identity before querying plan and quota', async () => {
  const api = requestFixture(); const reader = new ZcodeAccountStatusReader({ readIdentity: async () => localIdentity(), request: api.request });
  const result = await reader.poll(PROCESS, NOW);
  assert.deepEqual(api.calls.map(call => call.kind), ['identity', 'subscription', 'quota']);
  assert.equal(api.calls[0].token, 'oauth-one'); assert.equal(api.calls[1].token, 'api-one');
  assert.equal(result.source, 'account'); assert.equal(result.connection, 'ready');
  assert.deepEqual(result.plan, { name: 'Pro', stale: false });
  assert.deepEqual(result.quotas, [{ model: '共享额度', period: '5 小时', remaining: 75,
    reset: '2026-11-01T00:00:00.000Z', stale: false }]);
  assert.doesNotMatch(JSON.stringify(result), /account-a|oauth-one|api-one|PRIVATE|[a-f0-9]{64}/);
});

test('ZCode remote identity failure makes no subscription or quota request', async () => {
  for (const options of [{ remoteUid: 'account-b' }, { fail: { identity: new ZcodeAccountError('network') } }]) {
    const api = requestFixture(options); const reader = new ZcodeAccountStatusReader({ readIdentity: async () => localIdentity(), request: api.request });
    const result = await reader.poll(PROCESS, NOW);
    assert.deepEqual(api.calls.map(call => call.kind), ['identity']); assert.deepEqual(result.quotas, []); assert.equal(result.plan.name, null);
    assert.equal(result.connection, 'error');
  }
});

test('ZCode rejects malformed injected identity before any network request', async () => {
  for (const change of [{ uid: 'unknown' }, { uid: 'x'.repeat(257) }, { oauthToken: 'bad\ntoken' }, { apiKey: 'Bearer value' }, { snapshot: 'bad' }]) {
    let calls = 0; const reader = new ZcodeAccountStatusReader({ readIdentity: async () => ({ ...localIdentity(), ...change }),
      request: async () => { calls++; } });
    const result = await reader.poll(PROCESS, NOW);
    assert.equal(calls, 0); assert.deepEqual(result.quotas, []); assert.equal(result.connection, 'unavailable');
  }
});

test('ZCode account A to B, logout, and in-flight runtime changes discard prior data', async () => {
  let current = localIdentity(); const api = requestFixture();
  const reader = new ZcodeAccountStatusReader({ readIdentity: async () => current, request: api.request });
  assert.equal((await reader.poll(PROCESS, NOW)).plan.name, 'Pro');
  current = localIdentity('account-b');
  const apiB = requestFixture({ remoteUid: 'account-b', plan: 'GLM Coding Max' }); reader.request = apiB.request;
  assert.equal((await reader.poll(PROCESS, NOW + 1)).plan.name, 'Max');
  reader.readIdentity = async () => { throw new ZcodeAccountStatusError('login'); };
  const logout = await reader.poll(PROCESS, NOW + 2); assert.equal(logout.connection, 'auth-required'); assert.deepEqual(logout.quotas, []);
  let calls = 0; current = localIdentity(); reader.readIdentity = async () => current;
  reader.request = async (family, kind) => { calls++; if (kind === 'identity') current = { ...current, runtime: hash('runtime-two') };
    return kind === 'identity' ? success({ customerNumber: 'account-a' }) : kind === 'subscription' ? subscription() : quota(); };
  const changed = await reader.poll(PROCESS, NOW + 3); assert.equal(calls, 1); assert.deepEqual(changed.quotas, []); assert.equal(changed.connection, 'unavailable');
});

test('ZCode switching from personal to team or Z.ai clears personal account history', async () => {
  for (const next of ['team', 'zai']) {
    let mode = 'personal'; const api = requestFixture();
    const reader = new ZcodeAccountStatusReader({ readIdentity: async () => {
      if (mode !== 'personal') throw new ZcodeAccountStatusError('unsupported');
      return localIdentity();
    }, request: api.request });
    assert.equal((await reader.poll(PROCESS, NOW)).quotas.length, 1);
    mode = next; const result = await reader.poll(PROCESS, NOW + 1);
    assert.deepEqual(result.quotas, []); assert.equal(result.plan.name, null); assert.equal(result.connection, 'unavailable');
  }
});

test('ZCode process restart clears account cache before attempting a new request', async () => {
  let current = localIdentity(); const api = requestFixture();
  const reader = new ZcodeAccountStatusReader({ readIdentity: async () => current, request: api.request });
  assert.equal((await reader.poll(PROCESS, NOW)).quotas.length, 1);
  current = localIdentity('account-a', 'one', 'runtime-two'); let calls = 0;
  reader.request = async () => { calls++; throw new ZcodeAccountError('network'); };
  const restarted = await reader.poll(PROCESS, NOW + 1);
  assert.equal(calls, 1); assert.deepEqual(restarted.quotas, []); assert.equal(restarted.plan.name, null); assert.equal(restarted.connection, 'error');
});

test('ZCode snapshot rewrite between identity and package requests discards history and sends no package request', async () => {
  let current = localIdentity(); const initial = requestFixture();
  const reader = new ZcodeAccountStatusReader({ readIdentity: async () => current, request: initial.request });
  await reader.poll(PROCESS, NOW);
  current = localIdentity('account-a', 'one', 'runtime-one', 'snapshot-two');
  const cached = await reader.poll(PROCESS, NOW + 1);
  assert.equal(initial.calls.length, 3); assert.equal(cached.quotas.length, 1);
  let calls = 0;
  reader.request = async (family, kind) => {
    calls++; assert.equal(kind, 'identity'); current = localIdentity('account-a', 'one', 'runtime-one', 'snapshot-three');
    return success({ customerNumber: 'account-a' });
  };
  const discarded = await reader.poll(PROCESS, NOW + 2, true);
  assert.equal(calls, 1); assert.deepEqual(discarded.quotas, []); assert.equal(discarded.connection, 'unavailable');
});

test('ZCode caches for sixty seconds, force refreshes, and network history becomes stale', async () => {
  const api = requestFixture(); const reader = new ZcodeAccountStatusReader({ readIdentity: async () => localIdentity(), request: api.request });
  await reader.poll(PROCESS, NOW); await reader.poll(PROCESS, NOW + 1000); assert.equal(api.calls.length, 3);
  await reader.poll(PROCESS, NOW + 2000, true); assert.equal(api.calls.length, 6);
  reader.request = requestFixture({ fail: { identity: new ZcodeAccountError('network') } }).request;
  const stale = await reader.poll(PROCESS, NOW + 3000, true);
  assert.equal(stale.source, 'cache'); assert.equal(stale.connection, 'error'); assert.equal(stale.plan.stale, true); assert.equal(stale.quotas[0].stale, true);
});

test('ZCode keeps plan and quota failures independent but any auth rejection clears both', async () => {
  const base = requestFixture(); const reader = new ZcodeAccountStatusReader({ readIdentity: async () => localIdentity(), request: base.request });
  await reader.poll(PROCESS, NOW);
  const partial = requestFixture({ fail: { subscription: new ZcodeAccountError('network') }, percentage: 40 }); reader.request = partial.request;
  const value = await reader.poll(PROCESS, NOW + 60000, true);
  assert.equal(value.connection, 'ready'); assert.equal(value.plan.stale, true); assert.equal(value.quotas[0].remaining, 60); assert.equal(value.quotas[0].stale, false);
  reader.request = requestFixture({ fail: { quota: new ZcodeAccountError('login') } }).request;
  const denied = await reader.poll(PROCESS, NOW + 120000, true);
  assert.equal(denied.connection, 'auth-required'); assert.equal(denied.plan.name, null); assert.deepEqual(denied.quotas, []);
});

test('ZCode 429 cooldown is account-bound, survives token switch, and ignores force', async () => {
  let current = localIdentity(); let calls = 0; let clock = 1000;
  const reader = new ZcodeAccountStatusReader({ clock: () => clock, readIdentity: async () => current,
    request: async () => { calls++; clock += 250; throw new ZcodeAccountError('rate', 120000); } });
  await reader.poll(PROCESS, NOW, true); assert.equal(calls, 1);
  current = localIdentity('account-a', 'rotated');
  await reader.poll(PROCESS, NOW + 60000, true); assert.equal(calls, 1);
  await reader.poll(PROCESS, NOW + 120000, true); assert.equal(calls, 1);
  await reader.poll(PROCESS, NOW + 120250, true); assert.equal(calls, 2);
  assert.ok(reader.cooldowns.size <= MAX_COOLDOWNS);
  current = localIdentity('account-b');
  await reader.poll(PROCESS, NOW + 120251, true); assert.equal(calls, 3);
  for (let index = 0; index < MAX_COOLDOWNS + 3; index++) reader.cooldown(hash(`bounded-${index}`), NOW + index);
  assert.equal(reader.cooldowns.size, MAX_COOLDOWNS);
});

test('ZCode records rate cooldown before a post-response identity outage and retains it across token rotation', async () => {
  let current = localIdentity(); let reads = 0; let calls = 0; let clock = 5000; let outage = true;
  const reader = new ZcodeAccountStatusReader({ clock: () => clock, readIdentity: async () => {
    if (outage && ++reads > 1) throw new ZcodeAccountStatusError('unavailable');
    return current;
  }, request: async () => { calls++; clock += 400; throw new ZcodeAccountError('rate', 120000); } });
  const failed = await reader.poll(PROCESS, NOW, true);
  assert.equal(calls, 1); assert.equal(failed.connection, 'unavailable');
  outage = false; current = localIdentity('account-a', 'rotated');
  await reader.poll(PROCESS, NOW + 60000, true); assert.equal(calls, 1);
  await reader.poll(PROCESS, NOW + 120399, true); assert.equal(calls, 1);
  await reader.poll(PROCESS, NOW + 120400, true); assert.equal(calls, 2);
});

test('ZCode preserves account A cooldown across A to B network failure and back to A', async () => {
  let current = localIdentity(); let calls = 0; let clock = 9000;
  const reader = new ZcodeAccountStatusReader({ clock: () => clock, readIdentity: async () => current, request: async () => {
    calls++;
    if (current.uid === 'account-a') { clock += 100; throw new ZcodeAccountError('rate', 120000); }
    throw new ZcodeAccountError('network');
  } });
  await reader.poll(PROCESS, NOW, true); assert.equal(calls, 1);
  current = localIdentity('account-b'); await reader.poll(PROCESS, NOW + 1000, true); assert.equal(calls, 2);
  current = localIdentity('account-a', 'rotated'); await reader.poll(PROCESS, NOW + 2000, true); assert.equal(calls, 2);
});

test('ZCode partial rate limit keeps the independently refreshed component current during cooldown', async () => {
  const initial = requestFixture(); const reader = new ZcodeAccountStatusReader({ clock: () => 0,
    readIdentity: async () => localIdentity(), request: initial.request });
  await reader.poll(PROCESS, NOW);
  const partial = requestFixture({ fail: { subscription: new ZcodeAccountError('rate', 120000) }, percentage: 40 });
  reader.request = partial.request;
  let value = await reader.poll(PROCESS, NOW + 60000, true);
  assert.equal(value.plan.stale, true); assert.equal(value.quotas[0].remaining, 60); assert.equal(value.quotas[0].stale, false);
  const before = partial.calls.length;
  value = await reader.poll(PROCESS, NOW + 60001, true);
  assert.equal(partial.calls.length, before); assert.equal(value.quotas[0].stale, false); assert.equal(value.connection, 'ready');
});

test('ZCode unknown subscription never becomes Free and expired quota is stale', async () => {
  const api = requestFixture({ plan: 'PRIVATE_NEW_PLAN', reset: NOW + 1000 });
  const reader = new ZcodeAccountStatusReader({ readIdentity: async () => localIdentity(), request: api.request });
  assert.deepEqual((await reader.poll(PROCESS, NOW)).plan, { name: null, stale: false });
  const expired = await reader.poll(PROCESS, NOW + 1000); assert.equal(expired.quotas[0].stale, true);
});
