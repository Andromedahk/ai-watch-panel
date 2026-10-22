const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ClaudeStatusReader, normalizeClaudeUsage, resolveClaudePaths } = require('../electron/claude-status.cjs');
const now = Date.now();

test('Claude newest empty or changed-account sample clears previous allowance; zero is valid', () => {
  const sample = { version: 2, samples: [{ t: now - 1000, org: 'PRIVATE_OLD', u: { fh: 80, sd: 0, so: 100 } }] };
  assert.deepEqual(normalizeClaudeUsage(sample, now).quotas.map(q => q.remaining), [20, 100, 0]);
  sample.samples.push({ t: now, org: 'PRIVATE_NEW', u: {} });
  assert.deepEqual(normalizeClaudeUsage(sample, now).quotas, []);
  assert.ok(!JSON.stringify(normalizeClaudeUsage(sample, now)).includes('PRIVATE'));
  assert.equal(normalizeClaudeUsage({ ...sample, version: 3 }, now), null);
  assert.deepEqual(normalizeClaudeUsage({ version: 2, samples: [{ t: now, u: { fh: null, sd: '20', so: 101, sn: -1 } }] }, now).quotas, []);
  const old = normalizeClaudeUsage({ version: 1, samples: [{ t: now - 1800001, fh: 24.6, sd: null }] }, now);
  assert.equal(old.quotas[0].remaining, 75.4);
  assert.equal(old.quotas[0].stale, true);
});

test('Claude resolves portable default and configured directories without fixed device paths', () => {
  assert.deepEqual(resolveClaudePaths({ home: '/fixture', platform: 'darwin', env: {} }), { config: '/fixture/.claude', desktop: '/fixture/Library/Application Support/Claude' });
  assert.equal(resolveClaudePaths({ home: '/fixture', platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' } }).desktop, '/xdg/Claude');
  assert.deepEqual(resolveClaudePaths({ home: 'C:\\fixture', platform: 'win32', env: {} }), { config: 'C:\\fixture\\.claude', desktop: 'C:\\fixture\\AppData\\Roaming\\Claude' });
  assert.equal(resolveClaudePaths({ home: '/fixture', env: { CLAUDE_CONFIG_DIR: '~/custom', CLAUDE_USER_DATA_DIR: '~/desktop' } }).config, '/fixture/custom');
});

test('Claude Code validates terminal PIDs and freshness while excluding desktop Code sessions', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-claude-'));
  try {
    const reader = new ClaudeStatusReader({ home, env: {} });
    const dir = path.join(home, '.claude', 'sessions'); await fs.mkdir(dir, { recursive: true });
    const put = async (pid, status, entrypoint) => {
      const file = path.join(dir, `${pid}.json`);
      await fs.writeFile(file, JSON.stringify({ pid, status, entrypoint, sessionId: 'PRIVATE_SESSION', cwd: 'PRIVATE_PATH', name: 'PRIVATE_TITLE', messagingSocketPath: 'PRIVATE_SOCKET' }));
      await fs.utimes(file, now / 1000, now / 1000);
    };
    await put(10, 'busy', 'claude-desktop'); await put(20, 'waiting', 'cli'); await put(30, 'busy', 'cli');
    const processes = [{ pid: 10, command: '/app/claude' }, { pid: 20, command: '/fixture/.local/share/claude/versions/2.1.287' }, { pid: 30, command: '/app/unrelated' }];
    let result = await reader.poll(processes, now);
    assert.equal(result.activeTasks, 0); assert.equal(result.activity, 'waiting');
    assert.match(result.surfaces.desktop, /独立接入/); assert.match(result.surfaces.terminal, /1 个/);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    await put(10, 'idle', 'claude-desktop');
    assert.equal((await reader.poll(processes, now)).activity, 'waiting');
    await fs.utimes(path.join(dir, '20.json'), (now - 600001) / 1000, (now - 600001) / 1000);
    result = await reader.poll(processes, now); assert.equal(result.activity, 'unknown'); assert.equal(result.activeTasks, 0);
    await put(20, 'idle', 'cli'); assert.equal((await reader.poll(processes, now)).activity, 'idle');
    await put(20, 'new-status', 'cli'); assert.equal((await reader.poll(processes, now)).activity, 'unknown');
    assert.equal((await reader.poll([], now)).activity, 'offline');
    assert.equal((await reader.poll(null, now)).activity, 'unknown');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('Claude Free-compatible missing records stay unknown, read-only and never use demo quota', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-claude-empty-'));
  try {
    const reader = new ClaudeStatusReader({ home, env: {}, source: 'desktop', desktopActivityReader: async () => ({ activity: 'unknown', trusted: false, supported: true, plan: null }) });
    const result = await reader.poll([{ pid: 1, command: '/app/Claude' }], now);
    assert.equal(result.activity, 'unknown'); assert.deepEqual(result.quotas, []); assert.equal(result.activeTasks, 0);
    assert.match(result.detail, /Free/); assert.deepEqual(await fs.readdir(home), []);
    const dir = reader.paths.desktop; await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'plan-usage-history.json');
    const content = JSON.stringify({ version: 2, samples: [{ t: now, u: { fh: 30 } }] }); await fs.writeFile(file, content);
    // A detached usage file cannot establish the current logged-in account.
    assert.deepEqual((await reader.poll([], now)).quotas, []);
    assert.equal(await fs.readFile(file, 'utf8'), content);
    await fs.unlink(file); assert.deepEqual((await reader.poll([], now)).quotas, []);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('Claude plan reads explicit login product fields only and never guesses from quota or account labels', () => {
  const { normalizeClaudePlan } = require('../electron/claude-status.cjs');
  const oauth = { accessToken: 'PRIVATE_TOKEN', expiresAt: now + 60000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' };
  assert.equal(normalizeClaudePlan({ claudeAiOauth: oauth }, now).name, 'Max 5×');
  assert.equal(normalizeClaudePlan({ claudeAiOauth: { ...oauth, rateLimitTier: 'default_claude_max_20x' } }, now).name, 'Max 20×');
  for (const [type, name] of [['free', 'Free'], ['pro', 'Pro'], ['team', 'Team'], ['enterprise', 'Enterprise']]) {
    assert.equal(normalizeClaudePlan({ claudeAiOauth: { ...oauth, subscriptionType: type } }, now).name, name);
  }
  for (const obj of [
    { claudeAiOauth: { ...oauth, subscriptionType: 'PRIVATE_NAME' } },
    { claudeAiOauth: { ...oauth, subscriptionType: '__proto__' } },
    { claudeAiOauth: { ...oauth, subscriptionType: null } },
    { claudeAiOauth: { ...oauth, expiresAt: now } },
    { claudeAiOauth: { ...oauth, accessToken: '' } },
    { oauthAccount: { displayName: 'Pro', hasExtraUsageEnabled: true } },
  ]) assert.deepEqual(normalizeClaudePlan(obj, now), { name: null });
  assert.doesNotMatch(JSON.stringify(normalizeClaudePlan({ claudeAiOauth: oauth }, now)), /PRIVATE/);
});
test('Claude file-backed plan is read-only, expires and clears immediately on logout or account switch', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-claude-plan-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const reader = new ClaudeStatusReader({ home, env: {}, platform: 'darwin' });
  const dir = reader.paths.config; await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, '.credentials.json');
  const put = async subscriptionType => {
    const text = JSON.stringify({ claudeAiOauth: { accessToken: 'PRIVATE', refreshToken: 'PRIVATE_REFRESH', expiresAt: now + 7200000, subscriptionType } });
    await fs.writeFile(file, text, { mode: 0o600 }); await fs.utimes(file, now / 1000, now / 1000); return text;
  };
  const before = await put('pro');
  assert.deepEqual((await reader.poll([], now)).plan, { name: 'Pro', status: '终端登录', stale: false });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual((await reader.poll([], now + 1800001)).plan, { name: 'Pro', status: '终端登录', stale: true });
  await put('team'); assert.equal((await reader.poll([], now)).plan.name, 'Team');
  await put('new-product'); assert.equal((await reader.poll([], now)).plan.name, null);
  await put('max'); assert.equal((await reader.poll([], now + 7200000)).plan.name, null);
  await fs.unlink(file); assert.equal((await reader.poll([], now)).plan.name, null);
});
test('Claude plan refuses permissive, symlinked, oversized or invalid login files', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-claude-plan-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const reader = new ClaudeStatusReader({ home, env: {}, platform: 'darwin' });
  await fs.mkdir(reader.paths.config, { recursive: true });
  const file = path.join(reader.paths.config, '.credentials.json');
  const text = JSON.stringify({ claudeAiOauth: { accessToken: 'PRIVATE', expiresAt: now + 100000, subscriptionType: 'pro' } });
  await fs.writeFile(file, text, { mode: 0o644 });
  assert.equal((await reader.poll([], now)).plan.name, null);
  await fs.chmod(file, 0o600); await fs.writeFile(file, 'x'.repeat(65537));
  assert.equal((await reader.poll([], now)).plan.name, null);
  await fs.writeFile(file, '{broken'); assert.equal((await reader.poll([], now)).plan.name, null);
  await fs.unlink(file);
  const outside = path.join(home, 'other.json'); await fs.writeFile(outside, text, { mode: 0o600 });
  await fs.symlink(outside, file); assert.equal((await reader.poll([], now)).plan.name, null);
});

test('Claude keeps a long busy desktop turn running only when procStart proves the live owner', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-claude-owner-'));
  try {
    const dir = path.join(home, '.claude', 'sessions'); await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, '40.json'); const old = now - 30 * 60000;
    const put = async extra => {
      await fs.writeFile(file, JSON.stringify({ pid: 40, status: 'busy', entrypoint: 'claude-desktop', sessionId: 'S', statusUpdatedAt: old, ...extra }));
      await fs.utimes(file, old / 1000, old / 1000);
    };
    const poll = ownerStartsReader => new ClaudeStatusReader({ home, env: {}, source: 'desktop', ownerStartsReader,
      usageReader: { poll: async () => ({ state: 'disabled' }), clearSource() {} },
      desktopActivityReader: async () => ({ activity: 'unknown', trusted: null, supported: true, plan: null }) })
      .poll([{ pid: 1, command: '/app/Claude', cpu: 0 }, { pid: 40, command: '/app/claude', cpu: 0 }], now);
    const starts = async () => new Map([[40, 'Thu Oct 22 17:25:40 2026']]);
    await put({ procStart: 'Thu Oct 22  17:25:40 2026 ' });
    let result = await poll(starts); assert.equal(result.activity, 'running'); assert.equal(result.activeTasks, 1);
    await put({ procStart: 'Thu Oct 22 09:00:00 2026' });
    result = await poll(starts); assert.equal(result.activity, 'unknown'); assert.equal(result.activeTasks, 0);
    await put({});
    let asked = false;
    result = await poll(async () => { asked = true; return starts(); });
    assert.equal(result.activity, 'unknown'); assert.equal(asked, false);
    await put({ procStart: 'Thu Oct 22 17:25:40 2026' });
    result = await poll(async () => { throw new Error('ps failed'); });
    assert.equal(result.activity, 'unknown'); assert.equal(result.activeTasks, 0);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

async function ownerFixture(t, { source = 'desktop', platform, ownerStartsReader } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-claude-owner-boundaries-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'sessions'); await fs.mkdir(dir, { recursive: true });
  // Whole seconds avoid filesystem sub-millisecond rounding at exact boundaries.
  const at = Math.floor(now / 1000) * 1000;
  const file = path.join(dir, '40.json'), old = at - 30 * 60000;
  const start = 'Thu Oct 22 17:25:40 2026';
  const reader = new ClaudeStatusReader({ home, env: {}, source, ...(platform ? { platform } : {}),
    ownerStartsReader: ownerStartsReader || (async pids => new Map(pids.map(pid => [pid, start]))),
    usageReader: { poll: async () => ({ state: 'disabled' }), clearSource() {} },
    desktopActivityReader: async () => ({ activity: 'unknown', trusted: null, supported: true, plan: null }) });
  // A simulated Windows reader still uses this host's temporary fixture files.
  reader.paths.config = path.join(home, '.claude');
  reader.taskDetailsEnabled = true;
  const put = async (extra = {}, mtime = old) => {
    await fs.writeFile(file, JSON.stringify({ pid: 40, sessionId: 'S', status: 'busy', procStart: start,
      entrypoint: source === 'desktop' ? 'claude-desktop' : 'cli', statusUpdatedAt: old, ...extra }));
    await fs.utimes(file, mtime / 1000, mtime / 1000);
  };
  const processes = [{ pid: 1, command: '/app/Claude', cpu: 0 }, { pid: 40, command: '/app/claude', cpu: 0 }];
  return { reader, put, old, start, at, poll: () => reader.poll(processes, at) };
}

test('verified owners keep long busy, waiting and idle task details current on both Code surfaces', async t => {
  for (const source of ['desktop', 'code']) {
    for (const [status, activity] of [['busy', 'running'], ['waiting', 'waiting'], ['idle', 'idle']]) {
      await t.test(`${source} ${status}`, async t => {
        const { put, poll, old } = await ownerFixture(t, { source });
        await put({ status, name: 'Long task /tmp/private/path token=PRIVATE' });
        const result = await poll();
        // An idle Code session cannot prove the separately open desktop chat idle.
        assert.equal(result.activity, source === 'desktop' && status === 'idle' ? 'unknown' : activity);
        assert.equal(result.activeTasks, status === 'busy' ? 1 : 0);
        assert.equal(result.waitingTasks, status === 'waiting' ? 1 : 0);
        assert.equal(result.taskDetails[0].state, activity);
        assert.equal(result.taskDetails[0].stale, false);
        assert.equal(result.taskDetails[0].updatedAt, new Date(old).toISOString());
        assert.match(result.taskDetails[0].title, /^Long task/);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private\/path|registrationVerified/);
      });
    }
  }
});

test('missing owner identity and ps failure retain the exact mtime fallback including future limits', async t => {
  const cases = [
    ['missing identity', { procStart: null }],
    ['empty identity', { procStart: '' }],
    ['ps returned no owner', {}, async () => new Map()],
    ['ps unavailable', {}, async () => { throw Object.assign(new Error('ps not found'), { code: 'ENOENT' }); }],
    ['malformed reader result', {}, async () => null],
  ];
  for (const [name, extra, ownerStartsReader] of cases) {
    await t.test(name, async t => {
      const { put, poll, at } = await ownerFixture(t, { ownerStartsReader });
      for (const [age, activity] of [[600000, 'running'], [600001, 'unknown'], [-120000, 'running'], [-120001, 'unknown']]) {
        await put(extra, at - age);
        const result = await poll();
        assert.equal(result.activity, activity, `mtime age ${age}`);
        assert.equal(result.taskDetails[0].state, activity);
      }
      // As before, an old idle registration is idle even without identity proof.
      await put({ ...extra, status: 'idle' });
      assert.equal((await poll()).taskDetails[0].state, 'idle');
    });
  }
});

test('proven PID reuse rejects fresh and old busy, waiting and idle registrations on both surfaces', async t => {
  for (const source of ['desktop', 'code']) {
    for (const status of ['busy', 'waiting', 'idle']) {
      for (const fresh of [true, false]) {
        await t.test(`${source} ${status} ${fresh ? 'fresh' : 'old'}`, async t => {
          const { put, poll, at, old } = await ownerFixture(t, { source });
          await put({ status, procStart: 'Thu Oct 22 09:00:00 2026' }, fresh ? at : old);
          const result = await poll();
          assert.equal(result.activity, 'unknown');
          assert.equal(result.activeTasks, 0); assert.equal(result.waitingTasks, 0);
          assert.deepEqual(result.taskDetails, []);
        });
      }
    }
  }
});

test('a reused PID old registration cannot block its verified new owner hook session', async t => {
  const { reader, put, poll, at, start } = await ownerFixture(t, { source: 'code' });
  reader.hooks = { enabled: true, read: async () => [{ session: 'new-session', ancestors: [40], ownerPid: 40,
    ownerStart: start, phase: 'waiting', reason: 'input', surface: 'terminal', at }] };
  for (const entrypoint of ['cli', 'claude-desktop']) {
    await put({ entrypoint, sessionId: 'old-session', name: 'Old task', procStart: 'Thu Oct 22 09:00:00 2026' }, at);
    const result = await poll();
    assert.equal(result.activity, 'waiting'); assert.equal(result.waitingTasks, 1);
    assert.equal(result.waitingReason, 'input');
    assert.equal(result.taskDetails[0].state, 'waiting');
    assert.equal(result.taskDetails[0].title, null);
  }
});

test('verified owner uses a valid status transition time without inventing a current timestamp', async t => {
  const { put, poll, old, at } = await ownerFixture(t);
  await put({ statusUpdatedAt: old + 1000 });
  let result = await poll();
  assert.equal(result.taskDetails[0].updatedAt, new Date(old + 1000).toISOString());
  await put({ statusUpdatedAt: at + 120001 });
  result = await poll();
  assert.equal(result.taskDetails[0].updatedAt, new Date(old).toISOString());
  assert.equal(result.taskDetails[0].state, 'running');
  await put({ status: 'future-status' });
  assert.equal((await poll()).activity, 'unknown');
});

test('hook detail freshness does not inherit a verified registration timestamp policy', async t => {
  const { reader, put, poll, old, start } = await ownerFixture(t);
  reader.hooks = { enabled: true, read: async () => [{ session: 'S', ancestors: [40], ownerPid: 40,
    ownerStart: start, phase: 'waiting', reason: 'approval', surface: 'desktop', at: old }] };
  for (const procStart of [start, null]) {
    await put({ procStart });
    const result = await poll();
    assert.equal(result.activity, 'waiting');
    assert.equal(result.taskDetails[0].state, 'unknown');
    assert.equal(result.taskDetails[0].stale, true);
    assert.equal(result.taskDetails[0].updatedAt, new Date(old).toISOString());
  }
});

test('Windows default owner lookup with no ps falls back to the original mtime rule', async t => {
  // Load the actual default reader with an unavailable native command, as on
  // Windows. No test override replaces the ownerStartsReader implementation.
  const { createRequire } = require('node:module');
  const { runInNewContext } = require('node:vm');
  const file = require.resolve('../electron/claude-status.cjs'), localRequire = createRequire(file);
  let requests = 0;
  const module = { exports: {} };
  runInNewContext(await fs.readFile(file, 'utf8'), { module, Map, Buffer, process,
    require: name => name === 'node:child_process' ? { execFile(command, args, options, callback) {
      requests++; assert.equal(command, '/bin/ps');
      callback(Object.assign(new Error('No ps on Windows'), { code: 'ENOENT' }));
    } } : localRequire(name) });
  const { reader, put, poll } = await ownerFixture(t, { platform: 'win32' });
  reader.ownerStartsReader = module.exports.readOwnerStarts;
  await put();
  assert.equal((await poll()).activity, 'unknown');
  await put({}, now);
  assert.equal((await poll()).activity, 'running');
  assert.equal(requests, 2);
});
