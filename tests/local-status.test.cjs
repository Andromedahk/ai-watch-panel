const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { normalizeCodexRates, normalizeCodexActivity, normalizeAntigravityQuotas,
  normalizeCodexPlan, normalizeAntigravityPlan, normalizeAntigravityActivity,
  ACTIVITY_FRESH_MS, QUOTA_FRESH_MS } = require('../electron/status-normalizers.cjs');
const { LocalStatusReader, readTail, postLocal } = require('../electron/local-status.cjs');
const now = Date.parse('2026-10-02T00:00:00Z');
const reset = (now + 3600000) / 1000;

test('Codex plans use the main rate-limit bucket and whitelist exact product names', () => {
  assert.deepEqual(normalizeCodexPlan({ plan_type: 'pro', email: 'PRIVATE' }, now, now),
    { name: 'Pro', status: '本地快照', stale: false });
  assert.equal(normalizeCodexPlan({ rateLimits: { planType: 'business' } }, now, now).name, 'Business');
  assert.equal(normalizeCodexPlan({ rateLimitsByLimitId: { codex: { planType: 'plus' }, codex_reviews: { planType: 'pro' } } }, now, now).name, 'Plus');
  assert.equal(normalizeCodexPlan({ rateLimitsByLimitId: { codex_reviews: { planType: 'pro' } } }, now, now).name, null);
  for (const value of ['PRIVATE ACCOUNT', 'pro <script>', 'constructor', '__proto__', null, {}, 1]) {
    const plan = normalizeCodexPlan({ plan_type: value }, now, now);
    assert.equal(plan.name, null);
    assert.ok(!JSON.stringify(plan).includes('PRIVATE'));
  }
  assert.equal(normalizeCodexPlan({ plan_type: 'pro' }, now - QUOTA_FRESH_MS - 1, now).stale, true);
  assert.equal(normalizeCodexPlan({ plan_type: 'pro' }, now + 120001, now).stale, true);
});

test('Antigravity prefers explicit product tiers, never profile names or unknown fallback guesses', () => {
  const payload = { userStatus: { name: 'PRIVATE ACCOUNT', email: 'PRIVATE',
    userTier: { name: 'Google AI Ultra', description: 'PRIVATE' },
    planStatus: { planInfo: { planName: 'Pro', teamsTier: 'TEAMS_TIER_PRO' } } } };
  assert.deepEqual(normalizeAntigravityPlan(payload, now, now), { name: 'Google AI Ultra', stale: false });
  payload.userStatus.userTier.name = 'PRIVATE ACCOUNT';
  assert.equal(normalizeAntigravityPlan(payload, now, now).name, null);
  delete payload.userStatus.userTier;
  assert.equal(normalizeAntigravityPlan(payload, now, now).name, 'Pro');
  delete payload.userStatus.planStatus;
  assert.equal(normalizeAntigravityPlan(payload, now, now).name, null);
  assert.equal(normalizeAntigravityPlan({ userStatus: { userTier: { name: 'constructor' } } }, now, now).name, null);
  assert.equal(normalizeAntigravityPlan(payload, now - QUOTA_FRESH_MS - 1, now).stale, true);
});

test('Codex used percentages, snake/camel names, multi buckets, missing windows', () => {
  const quotas = normalizeCodexRates({ rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 24.6, windowDurationMins: 300, resetsAt: reset }, secondary: null },
    codex_reviews: { primary: { used_percent: 80, window_minutes: 10080, resets_at: reset } },
  } }, now, now);
  assert.deepEqual(quotas.map(q => [q.model, q.period, q.remaining]), [['Codex', '5 小时', 75.4], ['代码审查', '1 周', 20]]);
  const onlyWeekly = normalizeCodexRates({ primary: { used_percent: 25, window_minutes: 10080, resets_at: reset } }, now, now);
  assert.equal(onlyWeekly[0].remaining, null);
  assert.equal(onlyWeekly[1].remaining, 75);
});

test('unknown, expired and stale quotas never become a full current balance', () => {
  const invalid = normalizeCodexRates({ primary: { used_percent: null, resets_at: null, window_minutes: 300 } }, now, now);
  assert.equal(invalid[0].remaining, null);
  for (const used of [NaN, Infinity, -1, 101, '20']) {
    assert.equal(normalizeCodexRates({ primary: { used_percent: used, window_minutes: 300 } }, now, now)[0].remaining, null);
  }
  assert.equal(normalizeCodexRates({ primary: { used_percent: 20, resets_at: now / 1000, window_minutes: 300 } }, now, now)[0].stale, true);
  assert.equal(normalizeCodexRates({ primary: { used_percent: 20, window_minutes: 300 } }, now - QUOTA_FRESH_MS - 1, now)[0].stale, true);
});

test('Codex running requires both a process and recent activity; abandoned rows stay unknown', () => {
  const old = { started_at: (now - ACTIVITY_FRESH_MS - 10000) / 1000, last_item_at: now - ACTIVITY_FRESH_MS - 1 };
  const recent = { started_at: (now - 5000) / 1000, last_item_at: now - 1000 };
  assert.equal(normalizeCodexActivity([old], { started_at: old.started_at }, true, now).activity, 'unknown');
  assert.deepEqual(normalizeCodexActivity([old, recent], {}, true, now).activeTasks, 1);
  assert.equal(normalizeCodexActivity([recent], {}, false, now).activity, 'offline');
  assert.equal(normalizeCodexActivity([old], { completed_at: (now - 1000) / 1000 }, true, now).activity, 'idle');
  assert.equal(normalizeCodexActivity(null, null, true, now).activity, 'unknown');
});

test('Antigravity fractions preserve tenths and discard identity, payload and model metadata', () => {
  const payload = { userStatus: { email: 'private@example.invalid', name: 'PRIVATE_NAME', profilePictureUrl: 'PRIVATE_URL',
    cascadeModelConfigData: { clientModelConfigs: [
      { label: 'Model A', quotaInfo: { remainingFraction: .9966808, resetTime: new Date(now + 60000).toISOString() }, apiKey: 'PRIVATE_KEY' },
      { label: 'Model B', quotaInfo: {} }, { label: 'Model C', quotaInfo: { remainingFraction: 0 } },
      { label: 'Model D', quotaInfo: { remainingFraction: 1.1 } },
    ] } } };
  const quotas = normalizeAntigravityQuotas(payload, now, now);
  assert.deepEqual(quotas.map(q => q.remaining), [99.7, null, 0, null]);
  assert.ok(quotas.every(q => q.period === '模型额度'));
  assert.ok(!JSON.stringify(quotas).includes('PRIVATE'));
  assert.ok(!JSON.stringify(quotas).includes('email'));
  assert.equal(normalizeAntigravityQuotas(payload, now, now + QUOTA_FRESH_MS + 1)[0].stale, true);
});

test('Antigravity ProtoJSON omitted zero requires a valid quota reset, while missing or malformed data stays unknown', () => {
  const resetTime = new Date(now + 60000).toISOString();
  const configs = [
    { label: 'A depleted', quotaInfo: { resetTime } },
    { label: 'B explicit zero', quotaInfo: { remainingFraction: 0 } },
    { label: 'C missing message' },
    { label: 'D empty message', quotaInfo: {} },
    { label: 'E invalid reset', quotaInfo: { resetTime: 'not-a-time' } },
    { label: 'F explicit null', quotaInfo: { remainingFraction: null, resetTime } },
    { label: 'G invalid fraction', quotaInfo: { remainingFraction: -1, resetTime } },
    { label: 'H explicit string', quotaInfo: { remainingFraction: '0', resetTime } },
    { label: 'I stale depleted', quotaInfo: { resetTime: new Date(now - 1000).toISOString() } },
  ];
  const payload = { userStatus: { cascadeModelConfigData: { clientModelConfigs: configs } } };
  const rows = normalizeAntigravityQuotas(payload, now, now);
  assert.deepEqual(rows.map(row => row.remaining), [0, 0, null, null, null, null, null, null, 0]);
  assert.equal(rows[0].reset, resetTime);
  assert.equal(rows[0].stale, false);
  assert.equal(rows.at(-1).stale, true);
  assert.equal(normalizeAntigravityQuotas(payload, now - QUOTA_FRESH_MS - 1, now)[0].stale, true);
});

test('Antigravity recognizes only explicit running states; unknown and cached flags are not green', () => {
  assert.equal(normalizeAntigravityActivity([{ status: 'CASCADE_RUN_STATUS_IDLE' }], true).activity, 'idle');
  assert.equal(normalizeAntigravityActivity([{ status: 'CASCADE_RUN_STATUS_RUNNING' }, { status: 'CASCADE_RUN_STATUS_RUNNING', killed: 1 }], true).activeTasks, 1);
  assert.equal(normalizeAntigravityActivity([{ status: 'NEW_UNKNOWN_ENUM' }], true).activity, 'unknown');
  assert.equal(normalizeAntigravityActivity([{ status: 'CASCADE_RUN_STATUS_IDLE', not_fully_idle: 1 }], true).activity, 'unknown');
  assert.equal(normalizeAntigravityActivity([{ status: 'CASCADE_RUN_STATUS_RUNNING' }], false).activity, 'offline');
});

test('local cache adapter handles live WAL data read-only and rejects rollout paths outside its root', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-reader-'));
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome);
  const stateDb = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  const historyDb = new DatabaseSync(path.join(codexHome, 'thread_history_1.sqlite'));
  try {
    stateDb.exec('PRAGMA journal_mode=WAL; CREATE TABLE threads (rollout_path TEXT, updated_at INTEGER)');
    historyDb.exec('PRAGMA journal_mode=WAL; CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER); CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, created_at_ms INTEGER)');
    const sampled = Date.now();
    historyDb.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?)').run('private-thread', 'private-turn', 'inProgress', Math.floor(sampled / 1000), null);
    historyDb.prepare('INSERT INTO thread_items VALUES (?,?,?)').run('private-thread', 'private-turn', sampled);
    const inside = path.join(codexHome, 'record.jsonl');
    const outside = path.join(home, 'outside.jsonl');
    const event = (used) => JSON.stringify({ timestamp: new Date(sampled).toISOString(), type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: used, window_minutes: 10080, resets_at: (sampled + 3600000) / 1000 }, privateData: 'PRIVATE' } } }) + '\n';
    await fs.writeFile(inside, event(25));
    await fs.writeFile(outside, event(99));
    stateDb.prepare('INSERT INTO threads VALUES (?,?)').run(inside, 1);
    stateDb.prepare('INSERT INTO threads VALUES (?,?)').run(outside, 2);
    const reader = new LocalStatusReader({ codexQuotaReader: { poll: async () => ({ useLocal: true, detail: '合成本地记录' }) }, home, codexHome });
    const result = await reader.codex([{ command: '/app/codex' }], true);
    assert.equal(result.activity, 'running');
    assert.equal(result.quotas[1].remaining, 75);
    assert.ok(!JSON.stringify(result).includes(home));
    assert.ok(!JSON.stringify(result).includes('private-thread'));
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.equal(stateDb.prepare('SELECT count(*) n FROM threads').get().n, 2);
  } finally { stateDb.close(); historyDb.close(); await fs.rm(home, { recursive: true, force: true }); }
});

test('missing local files stay missing, without creating state or starting providers', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-missing-'));
  try {
    const reader = new LocalStatusReader({ codexQuotaReader: { poll: async () => ({ useLocal: true, detail: '合成本地记录' }) }, home, codexHome: path.join(home, '.codex') });
    assert.equal((await reader.codex([], true)).activity, 'offline');
    assert.equal((await reader.antigravity([], true)).activity, 'offline');
    assert.deepEqual(await fs.readdir(home), []);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('loopback RPC is bounded, authenticated in memory, and handles invalid responses', async () => {
  let received = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.socket.localAddress, '127.0.0.1');
    assert.equal(req.headers['x-codeium-csrf-token'], 'fixture-runtime-token');
    assert.equal(req.method, 'POST');
    received++;
    if (req.url.endsWith('GetUserStatus')) { res.writeHead(200); res.end('{"userStatus":{}}'); }
    else { res.writeHead(200); res.end('invalid json'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    assert.deepEqual(await postLocal(port, 'fixture-runtime-token', 'GetUserStatus'), { userStatus: {} });
    await assert.rejects(postLocal(port, 'fixture-runtime-token', 'GetAllCascadeTrajectories'), /Invalid local response/);
    await assert.rejects(postLocal(port, 'fixture-runtime-token', 'SendMessage'), /unavailable/);
    await assert.rejects(postLocal(70000, 'fixture-runtime-token', 'GetUserStatus'), /unavailable/);
    assert.equal(received, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('log tails skip a cut JSON line and remain bounded', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-tail-'));
  try {
    const file = path.join(home, 'events');
    await fs.writeFile(file, 'first-long-line\nsecond\nlast\n');
    assert.equal(await readTail(file, 15), 'second\nlast\n');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('loopback RPC rejects oversized and stalled responses', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('GetUserStatus')) res.end('x'.repeat(2 * 1024 * 1024 + 1));
    // The trajectory request deliberately stays open to exercise the total deadline.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    await assert.rejects(postLocal(port, 'fixture-runtime-token', 'GetUserStatus'), /too large/);
    await assert.rejects(postLocal(port, 'fixture-runtime-token', 'GetAllCascadeTrajectories'), /timeout/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Codex latest snapshot replaces plan on account changes and clears absent or null entitlement', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-codex-plan-'));
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome);
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  try {
    db.exec('CREATE TABLE threads (rollout_path TEXT, updated_at INTEGER)');
    const file = path.join(codexHome, 'record.jsonl');
    db.prepare('INSERT INTO threads VALUES (?,?)').run(file, 1);
    const base = Date.now() - 10000;
    let lines = '';
    const reader = new LocalStatusReader({ codexQuotaReader: { poll: async () => ({ useLocal: true, detail: '合成本地记录' }) }, home, codexHome });
    const sample = async (rates, index) => {
      lines += JSON.stringify({ timestamp: new Date(base + index * 1000).toISOString(), type: 'event_msg',
        payload: { type: 'token_count', rate_limits: rates } }) + '\n';
      await fs.writeFile(file, lines);
      return reader.codex([], true);
    };
    assert.equal((await sample({ plan_type: 'pro' }, 0)).plan.name, 'Pro');
    assert.equal((await sample({ plan_type: 'free' }, 1)).plan.name, 'Free');
    assert.equal((await sample({ primary: { used_percent: 60, window_minutes: 300 } }, 2)).plan.name, null);
    assert.equal((await sample({ plan_type: 'plus' }, 3)).plan.name, 'Plus');
    const result = await sample(null, 4);
    assert.equal(result.plan.name, null);
    assert.ok(result.quotas.every(q => q.remaining === null));
    await fs.unlink(file);
    assert.equal((await reader.codex([], true)).plan.name, null);
  } finally { db.close(); await fs.rm(home, { recursive: true, force: true }); }
});

function antigravityPlanFixture(home) {
  let payload = { userStatus: { userTier: { name: 'Google AI Pro' } } };
  let fail = false;
  const reader = new LocalStatusReader({ codexQuotaReader: { poll: async () => ({ useLocal: true, detail: '合成本地记录' }) }, home,
    runCommand: async (command) => ({ stdout: command === 'ps' ? 'server --csrf_token fixture-token' : 'n127.0.0.1:43210\n' }),
    requestLocal: async (_port, _token, method) => {
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: {} };
      if (fail) throw new Error('Unavailable fixture');
      return payload;
    },
  });
  return { reader, list: [{ pid: 123, command: '/app/Antigravity/language_server' }],
    setPayload: value => { payload = value; }, setFail: value => { fail = value; } };
}

test('Antigravity reads plan without quota models and clears old account data on empty responses', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-antigravity-plan-'));
  try {
    const f = antigravityPlanFixture(home);
    const initial = await f.reader.antigravity(f.list, true);
    assert.deepEqual(initial.plan, { name: 'Google AI Pro', stale: false });
    assert.deepEqual(initial.quotas, []);
    f.setPayload({ userStatus: { userTier: { name: 'Free' }, name: 'PRIVATE ACCOUNT' } });
    const switched = await f.reader.antigravity(f.list, true);
    assert.equal(switched.plan.name, 'Free');
    assert.ok(!JSON.stringify(switched).includes('PRIVATE'));
    f.setPayload({ userStatus: {} });
    assert.equal((await f.reader.antigravity(f.list, true)).plan.name, null);
    f.setPayload({ userStatus: { userTier: { name: 'Google AI Ultra' } } });
    assert.equal((await f.reader.antigravity(f.list, true)).plan.name, 'Google AI Ultra');
    f.setPayload({});
    assert.equal((await f.reader.antigravity(f.list, true)).plan.name, null);
    assert.equal(f.reader.antigravityRateCache, null);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('Antigravity plan is historical on service failure/offline and never crosses a restarted endpoint', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-antigravity-stale-'));
  try {
    const f = antigravityPlanFixture(home);
    await f.reader.antigravity(f.list, true);
    f.setFail(true);
    const failed = await f.reader.antigravity(f.list, true);
    assert.equal(failed.plan.name, 'Google AI Pro');
    assert.equal(failed.plan.stale, true);
    f.setFail(false);
    assert.equal((await f.reader.antigravity(f.list, true)).plan.stale, false);
    assert.equal((await f.reader.antigravity([], true)).plan.stale, true);
    f.setFail(true);
    assert.equal((await f.reader.antigravity([{ ...f.list[0], pid: 124 }], true)).plan.name, null);
    assert.equal(f.reader.antigravityRateCache, null);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('explicit Kimi Work selection never queries Code or publishes a superseded source', async () => {
  const status = label => ({ id: 'kimi', source: 'account', plan: { name: label }, quotas: [{ remaining: 75 }], activity: 'unknown', activeTasks: 0 });
  let release; let started; const inFlight = new Promise(resolve => { started = resolve; });
  let codeCalls = 0; let workCalls = 0;
  const code = { poll: async () => { codeCalls++; return status('Code'); } };
  const work = { poll: async () => { workCalls++; started(); return new Promise(resolve => { release = () => resolve(status('Work')); }); } };
  const reader = new LocalStatusReader({ kimiSource: 'work', kimiReader: code, kimiWorkReader: work });
  reader.codex = reader.antigravity = reader.deepseek = async () => ({});
  for (const key of ['claudeReader', 'zcodeReader', 'qwenReader', 'workbuddyReader']) reader[key] = { poll: async () => ({}) };
  const pending = reader.poll(); await inFlight;
  assert.equal(codeCalls, 0); assert.equal(workCalls, 1);
  reader.setKimiSource('code');
  assert.equal(reader.current.kimi.plan, undefined); assert.deepEqual(reader.current.kimi.quotas, []);
  release(); const superseded = await pending;
  assert.equal(superseded.kimi.kimiSource, 'code'); assert.equal(superseded.kimi.plan, undefined);
  assert.equal((await reader.poll()).kimi.plan.name, 'Code'); assert.equal(codeCalls, 1);
  assert.throws(() => reader.setKimiSource('automatic'), /Invalid Kimi source/);
});

test('switching Kimi sources away and back discards cache written by the superseded query', async () => {
  let release, start; const started = new Promise(resolve => { start = resolve; });
  let calls = 0;
  const code = { cache: null, nextAt: 0, poll: async function () {
    calls++;
    if (this.cache) return this.cache;
    if (calls === 1) { start(); await new Promise(resolve => { release = resolve; }); }
    this.cache = { id: 'kimi', source: 'account', plan: { name: calls === 1 ? 'Old' : 'New' }, quotas: [], activity: 'unknown', activeTasks: 0 };
    this.nextAt = Date.now() + 60000; return this.cache;
  } };
  const reader = new LocalStatusReader({ kimiReader: code, kimiWorkReader: { poll: async () => ({}) } });
  reader.codex = reader.antigravity = reader.deepseek = async () => ({});
  for (const key of ['claudeReader', 'zcodeReader', 'qwenReader', 'workbuddyReader']) reader[key] = { poll: async () => ({}) };
  const pending = reader.poll(); await started;
  reader.setKimiSource('work'); reader.setKimiSource('code'); release();
  await pending; assert.equal(code.cache, null); assert.equal(code.nextAt, 0);
  assert.equal((await reader.poll()).kimi.plan.name, 'New'); assert.equal(calls, 2);
});
