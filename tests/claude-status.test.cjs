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

test('Claude validates live PIDs, activity freshness, desktop/terminal surfaces and strips private fields', async () => {
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
    assert.equal(result.activeTasks, 1); assert.equal(result.activity, 'running');
    assert.match(result.surfaces.desktop, /1 个/); assert.match(result.surfaces.terminal, /1 个/);
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
    const reader = new ClaudeStatusReader({ home, env: {} });
    const result = await reader.poll([{ pid: 1, command: '/app/Claude' }], now);
    assert.equal(result.activity, 'unknown'); assert.deepEqual(result.quotas, []); assert.equal(result.activeTasks, 0);
    assert.match(result.detail, /Free/); assert.deepEqual(await fs.readdir(home), []);
    const dir = reader.paths.desktop; await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'plan-usage-history.json');
    const content = JSON.stringify({ version: 2, samples: [{ t: now, u: { fh: 30 } }] }); await fs.writeFile(file, content);
    assert.equal((await reader.poll([], now)).quotas[0].remaining, 70);
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
