const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { KimiWorkError, HOSTNAME } = require('../electron/kimi-work-api.cjs');
const { KimiWorkStatusReader, KimiWorkStatusError, resolveKimiWorkPaths, isKimiWorkProcess, parseJwt,
  readWorkIdentity, queryContext, MAX_CONTEXT_BYTES, CLIENT_ID } = require('../electron/kimi-work-status.cjs');

const NOW = Date.parse('2026-10-03T00:00:00Z');
const COMMAND = '/Applications/Kimi.app/Contents/MacOS/Kimi';
const PROCESS = [{ pid: 4321, command: COMMAND }];
const signature = value => createHash('sha256').update(value).digest('hex');
const token = (uid = 'fixture-user', expires = NOW / 1000 + 3600) => [
  Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: uid, exp: expires })).toString('base64url'), 'fixture-signature',
].join('.');
const reply = (reset = '2026-11-01T00:00:00Z') => ({ subscription: { goods: { title: 'Moderato', membershipLevel: 3 } }, balances: [
  { feature: 'FEATURE_OMNI', unit: 'UNIT_CREDIT', type: 'SUBSCRIPTION', amountUsedRatio: 0.25, expireTime: reset },
] });
const identity = (name = 'one') => ({ token: token(name), uid: name, region: 'cn', signature: signature(name) });

async function fixture(t) {
  const createdHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-kimi-work-home-'));
  const home = await fs.realpath(createdHome);
  const paths = resolveKimiWorkPaths({ home, platform: 'darwin' });
  await fs.mkdir(path.dirname(paths.config), { recursive: true });
  const writeConfig = async (uid = 'fixture-user', accessToken = token(uid)) => {
    await fs.writeFile(paths.config, JSON.stringify({ credentials: { kimiWeb: { accessToken, userId: uid, refreshToken: 'PRIVATE_REFRESH' } } }), { mode: 0o600 });
    await fs.chmod(paths.config, 0o600);
  };
  await writeConfig();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, paths, writeConfig };
}

async function contextServer(t, response = { uid: 'fixture-user', user_region: 'cn' }, options = {}) {
  const directory = await fs.mkdtemp('/tmp/kimi-work-');
  await fs.chmod(directory, 0o700);
  const endpoint = path.join(directory, 'context.sock');
  let requestText = '';
  const server = net.createServer(socket => {
    socket.on('data', chunk => {
      requestText += chunk.toString('utf8');
      if (!requestText.includes('\n') || options.stall) return;
      socket.end(options.raw ?? JSON.stringify(response) + '\n');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  await fs.chmod(endpoint, 0o600);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  return { endpoint, request: () => requestText };
}

function commands(endpoint, extra = '') {
  return async (command, args) => {
    if (command === 'ps') return { stdout: `${process.getuid()} Fri Oct  3 08:00:00 2026 ${COMMAND}\n` };
    assert.equal(command, 'lsof'); assert.deepEqual(args.slice(0, 4), ['-a', '-p', '4321', '-U']);
    return { stdout: `p4321\nn${endpoint}\n${extra}` };
  };
}

test('Kimi Work resolves only the desktop data root and exact main process', () => {
  const paths = resolveKimiWorkPaths({ home: '/fixture', platform: 'darwin' });
  assert.equal(paths.config, '/fixture/Library/Application Support/kimi-desktop/daimon-share/daimon/config.json');
  assert.equal(paths.pointer, '/fixture/Library/Application Support/kimi-desktop/daimon-storage.json');
  assert.equal(isKimiWorkProcess(COMMAND), true);
  assert.equal(isKimiWorkProcess('/Applications/KimiCU.app/Contents/MacOS/KimiCU'), false);
  assert.equal(isKimiWorkProcess('/usr/local/bin/kimi'), false);
  assert.throws(() => resolveKimiWorkPaths({ home: '/fixture', platform: 'win32' }), { code: 'unsupported' });
});

test('Kimi Work JWT parsing binds sub and expiry without treating the signature as verified', () => {
  assert.deepEqual(parseJwt(token('fixture-user'), NOW), { sub: 'fixture-user', exp: NOW / 1000 + 3600 });
  assert.throws(() => parseJwt(token('fixture-user', NOW / 1000 - 1), NOW), { code: 'expired' });
  assert.throws(() => parseJwt('not-a-jwt', NOW), { code: 'login' });
});

test('Kimi Work missing or unverifiable identity performs no account request', async () => {
  let requests = 0;
  for (const error of ['unavailable', 'login']) {
    const reader = new KimiWorkStatusReader({ readIdentity: async () => { throw new KimiWorkStatusError(error); }, request: async () => { requests++; } });
    const result = await reader.poll(PROCESS, NOW);
    assert.equal(result.kimiSource, 'work'); assert.equal(result.activity, 'unknown'); assert.equal(result.activeTasks, 0);
    assert.equal(result.connection, error === 'login' ? 'auth-required' : 'unavailable'); assert.deepEqual(result.quotas, []);
  }
  assert.equal(requests, 0);
});

test('Kimi Work caches quota for one minute but rechecks account identity every poll', async () => {
  let identityReads = 0; let requests = 0;
  const reader = new KimiWorkStatusReader({ readIdentity: async () => { identityReads++; return identity('one'); }, request: async value => {
    requests++; assert.equal(value, token('one')); return reply();
  } });
  const first = await reader.poll(PROCESS, NOW);
  assert.equal(first.source, 'account'); assert.equal(first.connection, 'ready'); assert.equal(first.plan.name, 'Moderato');
  assert.equal(first.quotas[0].remaining, 75); assert.equal(first.activity, 'unknown');
  await reader.poll(PROCESS, NOW + 1000);
  assert.equal(requests, 1); assert.equal(identityReads, 3);
  await reader.poll(PROCESS, NOW + 2000, true);
  assert.equal(requests, 2); assert.equal(identityReads, 5);
  assert.doesNotMatch(JSON.stringify(first), /fixture-user|PRIVATE|accessToken/);
  assert.equal(HOSTNAME, 'www.kimi.com');
});

test('Kimi Work clears prior account data on account switch, token switch, and logout', async () => {
  let current = identity('one'); let requests = 0;
  const reader = new KimiWorkStatusReader({ readIdentity: async () => current, request: async () => { requests++; return reply(); } });
  assert.equal((await reader.poll(PROCESS, NOW)).quotas.length, 1);
  current = identity('two');
  assert.equal((await reader.poll(PROCESS, NOW + 1)).observedAt, new Date(NOW + 1).toISOString());
  assert.equal(requests, 2);
  current = { ...identity('two'), token: token('two') + 'x', signature: signature('two-token') };
  await reader.poll(PROCESS, NOW + 2); assert.equal(requests, 3);
  const saved = reader.readIdentity; reader.readIdentity = async () => { throw new KimiWorkStatusError('login'); };
  const loggedOut = await reader.poll(PROCESS, NOW + 3);
  assert.deepEqual(loggedOut.quotas, []); assert.equal(loggedOut.plan.name, null); assert.equal(loggedOut.connection, 'auth-required');
  reader.readIdentity = saved;
});

test('Kimi Work discards an in-flight response when account identity changes', async () => {
  let current = identity('one');
  const reader = new KimiWorkStatusReader({ readIdentity: async () => current, request: async () => { current = identity('two'); return reply(); } });
  const result = await reader.poll(PROCESS, NOW);
  assert.deepEqual(result.quotas, []); assert.equal(result.connection, 'unavailable'); assert.equal(result.observedAt, null);
});

test('Kimi Work clears 401 data and respects 429 cooldown even for forced refresh', async () => {
  let calls = 0; let mode = 'ok';
  const reader = new KimiWorkStatusReader({ readIdentity: async () => identity('one'), request: async () => {
    calls++; if (mode === 'login') throw new KimiWorkError('login'); if (mode === 'rate') throw new KimiWorkError('rate', 120000); return reply();
  } });
  await reader.poll(PROCESS, NOW); mode = 'login';
  const denied = await reader.poll(PROCESS, NOW + 60000, true);
  assert.deepEqual(denied.quotas, []); assert.equal(denied.connection, 'auth-required');
  mode = 'rate'; await reader.poll(PROCESS, NOW + 120000, true);
  assert.equal(calls, 3);
  await reader.poll(PROCESS, NOW + 239999, true); assert.equal(calls, 3);
  await reader.poll(PROCESS, NOW + 240100, true); assert.equal(calls, 4);
});

test('Kimi Work preserves failed history as stale and marks an expired quota window stale', async () => {
  let fail = false; let calls = 0;
  const reader = new KimiWorkStatusReader({ readIdentity: async () => identity('one'), request: async () => {
    calls++; if (fail) throw new KimiWorkError('network'); return reply(new Date(NOW + 1000).toISOString());
  } });
  const fresh = await reader.poll(PROCESS, NOW); assert.equal(fresh.quotas[0].stale, false);
  const expired = await reader.poll(PROCESS, NOW + 1000); assert.equal(expired.quotas[0].stale, true); assert.equal(calls, 1);
  fail = true; const old = await reader.poll(PROCESS, NOW + 60000, true);
  assert.equal(old.source, 'cache'); assert.equal(old.connection, 'error'); assert.equal(old.quotas[0].stale, true);
  assert.equal(old.plan.stale, true); assert.equal(old.observedAt, new Date(NOW).toISOString());
});

test('Kimi Work validates private config, the owned main-process socket, user and cn region', async t => {
  const f = await fixture(t); const context = await contextServer(t); const runCommand = commands(context.endpoint);
  const result = await readWorkIdentity(PROCESS, { home: f.home, platform: 'darwin', now: NOW, runCommand });
  assert.equal(result.uid, 'fixture-user'); assert.equal(result.region, 'cn'); assert.equal(result.token, token());
  assert.match(result.signature, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(context.request()).op, 'get_user_info'); assert.equal(JSON.parse(context.request()).client_id, CLIENT_ID);
});

test('Kimi Work rejects custom storage, permissive or symlinked config without using the old default', async t => {
  const f = await fixture(t); const context = await contextServer(t); let calls = 0;
  const query = async () => { calls++; return { uid: 'fixture-user', user_region: 'cn' }; };
  await fs.writeFile(f.paths.pointer, JSON.stringify({ shareDir: '/private/custom' }), { mode: 0o600 });
  await assert.rejects(readWorkIdentity(PROCESS, { home: f.home, platform: 'darwin', now: NOW, runCommand: commands(context.endpoint), query }), { code: 'unsupported' });
  assert.equal(calls, 0);
  await fs.unlink(f.paths.pointer); await fs.chmod(f.paths.config, 0o644);
  await assert.rejects(readWorkIdentity(PROCESS, { home: f.home, platform: 'darwin', now: NOW, runCommand: commands(context.endpoint), query }), { code: 'permissions' });
  await fs.unlink(f.paths.config); const outside = path.join(f.home, 'outside.json');
  await fs.writeFile(outside, JSON.stringify({ credentials: { kimiWeb: { accessToken: token(), userId: 'fixture-user' } } }), { mode: 0o600 });
  await fs.symlink(outside, f.paths.config);
  await assert.rejects(readWorkIdentity(PROCESS, { home: f.home, platform: 'darwin', now: NOW, runCommand: commands(context.endpoint), query }), { code: 'permissions' });
  assert.equal(calls, 0);
});

test('Kimi Work refuses mismatched user, unverified global region, and multiple owned context sockets', async t => {
  const f = await fixture(t); const context = await contextServer(t);
  await assert.rejects(readWorkIdentity(PROCESS, { home: f.home, platform: 'darwin', now: NOW, runCommand: commands(context.endpoint),
    query: async () => ({ uid: 'other-user', user_region: 'cn' }) }), { code: 'login' });
  await assert.rejects(readWorkIdentity(PROCESS, { home: f.home, platform: 'darwin', now: NOW, runCommand: commands(context.endpoint),
    query: async () => ({ uid: 'fixture-user', user_region: 'oversea' }) }), { code: 'unsupported' });
  const second = await contextServer(t);
  await assert.rejects(readWorkIdentity(PROCESS, { home: f.home, platform: 'darwin', now: NOW,
    runCommand: commands(context.endpoint, `n${second.endpoint}\n`) }), { code: 'ambiguous' });
});

test('Kimi Work context channel has a two-second bounded single-line response', async t => {
  const stalled = await contextServer(t, {}, { stall: true });
  await assert.rejects(queryContext(stalled.endpoint, { timeoutMs: 5 }), { code: 'unavailable' });
  const oversized = await contextServer(t, {}, { raw: 'x'.repeat(MAX_CONTEXT_BYTES + 1) + '\n' });
  await assert.rejects(queryContext(oversized.endpoint), { code: 'format' });
});

test('Kimi Work never treats Code CLI activity or endpoints as Work state', async () => {
  let seenProcesses;
  const reader = new KimiWorkStatusReader({ readIdentity: async processes => { seenProcesses = processes; return identity('one'); },
    request: async () => reply() });
  const processes = [{ pid: 1, command: '/usr/local/bin/kimi' }];
  const result = await reader.poll(processes, NOW);
  assert.equal(seenProcesses, processes); assert.equal(result.activity, 'unknown'); assert.equal(result.activeTasks, 0);
  assert.equal(result.task, 'Kimi Work 任务状态未知');
});

test('Kimi Work cooldown survives a temporary identity outage, socket rebuild and token rotation for the same account', async () => {
  let grant = identity('one'), readable = true, calls = 0;
  const reader = new KimiWorkStatusReader({ readIdentity: async () => {
    if (!readable) throw new KimiWorkStatusError('unavailable'); return grant;
  }, request: async () => { calls++; throw new KimiWorkError('rate', 120000); } });
  await reader.poll(PROCESS, NOW, true); assert.equal(calls, 1);
  readable = false; await reader.poll(PROCESS, NOW + 1000, true);
  readable = true; grant = { ...grant, signature: signature('new-socket'), token: token('one') + 'x' };
  const blocked = await reader.poll(PROCESS, NOW + 2000, true);
  assert.equal(calls, 1); assert.match(blocked.detail, /稍后重试/);
  await reader.poll(PROCESS, NOW + 120100, true); assert.equal(calls, 2);
});

test('Kimi Work temporary context errors do not report a missing login or leak the message', async t => {
  const f = await fixture(t), context = await contextServer(t);
  const options = { home: f.home, platform: 'darwin', now: NOW, runCommand: commands(context.endpoint) };
  await assert.rejects(readWorkIdentity(PROCESS, { ...options, query: async () => ({ error: 'temporarily_unavailable', message: 'PRIVATE' }) }),
    error => error.code === 'unavailable' && !error.message.includes('PRIVATE'));
  await assert.rejects(readWorkIdentity(PROCESS, { ...options, query: async () => ({ error: 'not_authenticated', message: 'PRIVATE' }) }), { code: 'login' });
});

test('Kimi Work unrelated config rewrites keep the account identity but in-flight snapshot changes are rejected', async t => {
  const f = await fixture(t), context = await contextServer(t);
  const options = { home: f.home, platform: 'darwin', now: NOW, runCommand: commands(context.endpoint) };
  const first = await readWorkIdentity(PROCESS, options);
  await f.writeConfig(); await fs.utimes(f.paths.config, new Date(), new Date(NOW + 5000));
  const second = await readWorkIdentity(PROCESS, options); assert.equal(first.signature, second.signature);
  await assert.rejects(readWorkIdentity(PROCESS, { ...options, query: async () => {
    await fs.utimes(f.paths.config, new Date(), new Date(NOW + 10000)); return { uid: 'fixture-user', user_region: 'cn' };
  } }), { code: 'unavailable' });
});

test('Kimi Work rejects socket replacement and main-process generation changes during identity checks', async t => {
  const f = await fixture(t), first = await contextServer(t), replacement = await contextServer(t);
  let endpoint = first.endpoint;
  const base = { home: f.home, platform: 'darwin', now: NOW };
  await assert.rejects(readWorkIdentity(PROCESS, { ...base,
    runCommand: (...args) => commands(endpoint)(...args),
    query: async () => { endpoint = replacement.endpoint; return { uid: 'fixture-user', user_region: 'cn' }; },
  }), { code: 'unavailable' });
  let queries = 0;
  await assert.rejects(readWorkIdentity(PROCESS, { ...base,
    runCommand: async (command, args) => {
      if (command === 'ps') return { stdout: `${process.getuid()} Fri Oct  3 08:0${queries ? '1' : '0'}:00 2026 ${COMMAND}\n` };
      return commands(first.endpoint)(command, args);
    },
    query: async () => { queries++; return { uid: 'fixture-user', user_region: 'cn' }; },
  }), { code: 'unavailable' });
});
