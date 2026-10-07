const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { CodexQuotaReader, queryCodexRates, findCodexExecutable } = require('../electron/codex-quota.cjs');
const { normalizeAntigravityQuotas, normalizeCodexRates, QUOTA_FRESH_MS } = require('../electron/status-normalizers.cjs');
const { LocalStatusReader } = require('../electron/local-status.cjs');

const base = Date.parse('2026-10-03T00:00:00Z');
const account = { type: 'chatgpt', email: 'PRIVATE_ACCOUNT', planType: 'pro' };
const payload = { rateLimitsByLimitId: { codex: { planType: 'pro',
  primary: { usedPercent: 27.5, windowDurationMins: 10080, resetsAt: (base + 86400000) / 1000 } } }, token: 'PRIVATE_TOKEN' };
function fakeServer(reply) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const calls = []; const kills = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(chunk.toString()); calls.push(request);
    queueMicrotask(() => reply(request, child)); done();
  } });
  child.kill = signal => { kills.push(signal); child.emit('exit', 0); return true; };
  return { child, calls, kills, spawn: () => child };
}
const respond = (child, request, result) => child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
function standardReply(request, child) {
  if (request.method === 'initialize') respond(child, request, { userAgent: 'PRIVATE_MACHINE' });
  if (request.method === 'account/read') respond(child, request, { account });
  if (request.method === 'account/rateLimits/read') respond(child, request, payload);
}
const ready = at => ({ status: 'ready', at, quotas: normalizeCodexRates(payload, at, at, { includeMissing: false }),
  plan: { name: 'Pro', status: '官方查询', stale: false } });

test('official stdio query uses only metadata methods, preserves returned windows and strips private fields', async () => {
  const server = fakeServer(standardReply); let options; const accounts = [];
  const result = await queryCodexRates('/fixture/codex', { codexHome: '/fixture/home', now: () => base,
    onAccount: id => accounts.push(id), spawnImpl: (binary, args, settings) => {
      assert.equal(binary, '/fixture/codex'); assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
      options = settings; return server.child;
    } });
  assert.equal(options.shell, false); assert.equal(options.env.CODEX_HOME, '/fixture/home');
  assert.equal(result.status, 'ready'); assert.equal(result.plan.name, 'Pro');
  assert.deepEqual(result.quotas.map(q => [q.period, q.remaining]), [['1 周', 72.5]]);
  assert.deepEqual(server.calls.filter(c => c.method).map(c => c.method),
    ['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read']);
  assert.ok(server.calls.filter(c => c.method === 'account/read').every(c => c.params.refreshToken === false));
  assert.equal(accounts.length, 2); assert.equal(accounts[0], accounts[1]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.ok(!JSON.stringify(result).includes('identity'));
  assert.equal(server.kills[0], 'SIGTERM');
});

test('logged out and API-key accounts never query subscription rates', async () => {
  for (const value of [null, { type: 'apiKey' }, { type: 'chatgpt' }]) {
    const server = fakeServer((request, child) => {
      if (request.method === 'initialize') respond(child, request, {});
      if (request.method === 'account/read') respond(child, request, { account: value });
    });
    const result = await queryCodexRates('/fixture/codex', { spawnImpl: server.spawn });
    assert.equal(result.status, 'auth-required');
    assert.equal(server.calls.some(c => c.method === 'account/rateLimits/read'), false);
  }
});

test('an account switch during the official query discards the entire allowance response', async () => {
  let reads = 0;
  const server = fakeServer((request, child) => {
    if (request.method !== 'account/read') return standardReply(request, child);
    respond(child, request, { account: ++reads === 1 ? account : { ...account, email: 'PRIVATE_OTHER' } });
  });
  const result = await queryCodexRates('/fixture/codex', { spawnImpl: server.spawn });
  assert.deepEqual(result, { status: 'account-changed' });
});

test('server tool/approval requests are declined, never invoked', async () => {
  const server = fakeServer((request, child) => {
    if (request.method === 'initialize') child.stdout.write(JSON.stringify({ id: 999, method: 'item/commandExecution/requestApproval', params: { command: 'PRIVATE' } }) + '\n');
    standardReply(request, child);
  });
  assert.equal((await queryCodexRates('/fixture/codex', { spawnImpl: server.spawn })).status, 'ready');
  assert.deepEqual(server.calls.find(c => c.id === 999), { id: 999, error: { code: -32601, message: 'Unsupported method' } });
});

test('stdio failures, malformed/oversized responses and deadlines return generic errors and stop the child', async () => {
  for (const action of [
    (_request, child) => child.stdout.write('invalid PRIVATE json\n'),
    (_request, child) => child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1)),
    (request, child) => child.stdout.write(JSON.stringify({ id: request.id, error: { code: -32000, message: 'PRIVATE_TOKEN' } }) + '\n'),
    () => {},
  ]) {
    const server = fakeServer(action);
    assert.deepEqual(await queryCodexRates('/fixture/codex', { spawnImpl: server.spawn, timeoutMs: 25 }), { status: 'error' });
    assert.equal(server.kills[0], 'SIGTERM');
  }
});

test('quitting aborts an in-flight transport', async () => {
  const server = fakeServer(() => {}); const controller = new AbortController();
  const result = queryCodexRates('/fixture/codex', { spawnImpl: server.spawn, signal: controller.signal });
  controller.abort();
  assert.deepEqual(await result, { status: 'error' }); assert.equal(server.kills[0], 'SIGTERM');
});

test('automatic query interval, manual minimum and duplicate refreshes avoid repeated network calls', async () => {
  let time = base; let calls = 0; let release;
  const reader = new CodexQuotaReader({ find: async () => '/fixture/codex', now: () => time,
    query: async (_binary, options) => { calls++; options.onAccount('first'); if (calls === 1) await new Promise(resolve => { release = resolve; }); return ready(time); } });
  const first = reader.poll(); const duplicate = reader.poll(true);
  await new Promise(resolve => setImmediate(resolve)); release();
  assert.deepEqual(await first, await duplicate); assert.equal(calls, 1);
  time += 14999; await reader.poll(true); assert.equal(calls, 1);
  time++; await reader.poll(true); assert.equal(calls, 2);
  time += 59999; await reader.poll(); assert.equal(calls, 2);
  time++; await reader.poll(); assert.equal(calls, 3); reader.close();
});

test('network failure retains clearly historical values; retry backoff cannot be bypassed manually', async () => {
  let time = base; let calls = 0; let fail = false;
  const reader = new CodexQuotaReader({ find: async () => '/fixture/codex', now: () => time,
    query: async (_binary, options) => { calls++; options.onAccount('first'); return fail ? { status: 'error' } : ready(time); } });
  assert.equal((await reader.poll()).source, 'account'); fail = true; time += 60000;
  const cached = await reader.poll(); assert.equal(cached.source, 'cache'); assert.equal(cached.quotas[0].remaining, 72.5);
  assert.equal(cached.quotas[0].stale, true); assert.equal(cached.plan.stale, true);
  assert.equal(cached.observedAt, new Date(base).toISOString());
  time += 29999; await reader.poll(true); assert.equal(calls, 2);
  time++; await reader.poll(true); assert.equal(calls, 3);
  time += 60000; fail = false; assert.equal((await reader.poll()).source, 'account'); reader.close();
});

test('logout, API-key mode or changed account clear the previous cache and suppress unbound rollouts', async () => {
  for (const status of ['auth-required', 'account-changed']) {
    let time = base; let calls = 0;
    const reader = new CodexQuotaReader({ find: async () => '/fixture/codex', now: () => time,
      query: async (_binary, options) => { options.onAccount(calls++ === 0 ? 'first' : null); return calls === 1 ? ready(time) : { status }; } });
    await reader.poll(); time += 60000;
    const result = await reader.poll(); assert.equal(result.useLocal, false); assert.equal(result.plan.name, null);
    assert.ok(result.quotas.every(q => q.remaining === null)); reader.close();
  }
  let time = base; let identity = 'first';
  const reader = new CodexQuotaReader({ find: async () => '/fixture/codex', now: () => time,
    query: async (_binary, options) => { options.onAccount(identity); return identity === 'first' ? ready(time) : { status: 'error' }; } });
  await reader.poll(); identity = 'second'; time += 60000;
  const result = await reader.poll(); assert.equal(result.useLocal, false); assert.ok(result.quotas.every(q => q.remaining === null)); reader.close();
});

test('missing official executable permits local fallback; expired cached window stays historical', async () => {
  const missing = new CodexQuotaReader({ find: async () => null });
  assert.equal((await missing.poll()).useLocal, true); missing.close();
  let time = base;
  const reader = new CodexQuotaReader({ find: async () => '/fixture/codex', now: () => time, query: async () => ready(time) });
  await reader.poll(); time += QUOTA_FRESH_MS + 1;
  assert.equal(reader.view().quotas[0].stale, true);
  time = base + 86400000;
  assert.equal(reader.view().quotas[0].stale, true); reader.close();
});

test('native discovery uses installed app identity and a bounded PATH fallback, never a shell', async () => {
  const seen = [];
  const io = { realpath: async file => { seen.push(file); return file; }, stat: async () => ({ isFile: () => true, mode: 0o755 }) };
  const result = await findCodexExecutable({ platform: 'darwin', home: '/fixture', env: { PATH: '/bin' },
    discover: async (id, options) => { assert.equal(id, 'codex'); assert.deepEqual(options.roots, ['/Applications', '/fixture/Applications']); return '/fixture/Official.app'; }, io });
  assert.ok(result.endsWith('CodexCLI.app/Contents/MacOS/codex')); assert.equal(seen.length, 1);
  const linux = await findCodexExecutable({ platform: 'linux', env: { PATH: '.:/fixture/bin' }, io });
  assert.equal(linux, '/fixture/bin/codex');
});

test('account allowances remain readable with Codex closed, while task status stays offline', async () => {
  const reader = new LocalStatusReader({ home: '/fixture/missing', codexQuotaReader: { poll: async () => ({ useLocal: false,
    source: 'account', connection: 'ready', quotas: ready(base).quotas, plan: ready(base).plan,
    observedAt: new Date(base).toISOString(), detail: '官方查询' }) } });
  const result = await reader.codex([], true);
  assert.equal(result.source, 'account'); assert.equal(result.connection, 'ready'); assert.equal(result.activity, 'offline');
  assert.equal(result.quotas.length, 1); assert.equal(result.quotas[0].remaining, 72.5);
  reader.codexAttention.close();
});

test('Antigravity thinking levels merge without mixing model versions, choosing conservative data', () => {
  const model = (label, fraction, reset = base + 60000) => ({ label, quotaInfo: { remainingFraction: fraction, resetTime: new Date(reset).toISOString() } });
  const rows = normalizeAntigravityQuotas({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [
    model('Gemini 3.1 Pro (High)', .8), model('Gemini 3.1 Pro (Low)', .6), model('Gemini 3.1 Pro (Medium)', .7),
    model('Gemini 3 Pro (High)', .9), model('Claude Sonnet 4.5', .5), model('Claude Sonnet 4.5 (Thinking)', .5),
  ] } } }, base, base);
  assert.equal(rows.length, 3);
  assert.equal(rows.find(q => q.model === 'Gemini 3.1 Pro').remaining, 60);
  assert.equal(rows.find(q => q.model === 'Gemini 3 Pro').remaining, 90);
  assert.equal(rows.find(q => q.model === 'Claude Sonnet 4.5').variants.length, 2);
  const uncertain = normalizeAntigravityQuotas({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [
    model('Gemini Pro (High)', .8), model('Gemini Pro (Low)', null, base),
  ] } } }, base, base);
  assert.equal(uncertain[0].remaining, null); assert.equal(uncertain[0].reset, ''); assert.equal(uncertain[0].stale, true);
});

test('Antigravity merged thinking variants preserve ProtoJSON exhausted quotas as zero', () => {
  const resetTime = new Date(base + 60000).toISOString();
  const payload = { userStatus: { cascadeModelConfigData: { clientModelConfigs: [
    { label: 'Claude Sonnet (High)', quotaInfo: { resetTime } },
    { label: 'Claude Sonnet (Low)', quotaInfo: { remainingFraction: .4, resetTime } },
    { label: 'Claude Opus (High)', quotaInfo: { resetTime } },
    { label: 'Claude Opus (Low)', quotaInfo: {} },
  ] } } };
  const rows = normalizeAntigravityQuotas(payload, base, base);
  assert.equal(rows.find(row => row.model === 'Claude Sonnet').remaining, 0);
  assert.equal(rows.find(row => row.model === 'Claude Sonnet').reset, resetTime);
  assert.equal(rows.find(row => row.model === 'Claude Opus').remaining, null);
});
