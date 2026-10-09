const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWidgetSnapshot } = require('../electron/widget-snapshot.cjs');

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const at = new Date(NOW - 1000).toISOString();
const preferences = { language: 'en', theme: 'dark', providerOrder: ['codex'], enabledProviders: ['codex'] };
const quota = (remaining, period = '1 week', extra = {}) => ({ model: 'Main', period, remaining, ...extra });
const status = (data = {}) => ({ connection: 'ready', activity: 'idle', observedAt: at, quotas: [quota(50)], ...data });
const snapshot = (data = {}) => ({ sampledAt: at, ...data });
const one = (data, prefs = preferences, options = {}) => makeWidgetSnapshot(snapshot({ codex: status(data) }), prefs, { now: NOW, ...options }).rows[0];

test('makes a deterministic, localized contract and preserves a zero percent quota', () => {
  const result = makeWidgetSnapshot(snapshot({ codex: status({ quotas: [quota(0)] }) }), preferences, { now: NOW, isTestData: true });
  assert.deepEqual(result, {
    schemaVersion: 1, generatedAt: '2026-10-09T12:00:00.000Z', sampledAt: at,
    theme: 'dark', language: 'en', isTestData: true,
    rows: [{ id: 'codex', name: 'Codex', summary: '7 days · Remaining 0%', remaining: 0, activity: 'idle', stale: false, observedAt: at }],
  });
});

test('marks stale and non-ready data while retaining only a selected percentage quota', () => {
  assert.deepEqual(one({ connection: 'error', quotas: [quota(12, '1 week', { stale: false })] }), {
    id: 'codex', name: 'Codex', summary: '7 days · Historical 12%', remaining: 12,
    activity: 'idle', stale: true, observedAt: at,
  });
  const credits = one({ quotas: [quota(77, '5 hours')], credits: { stale: true, items: [{ label: 'Total credits', remaining: '100.123456789', unit: 'USD' }] } });
  assert.equal(credits.remaining, null);
  assert.equal(credits.stale, true);
  assert.match(credits.summary, /100\.12/);
});

test('clears data on authentication loss and on a Kimi source switch', () => {
  const auth = one({ connection: 'auth-required', activity: 'running', quotas: [quota(90)] });
  assert.deepEqual(auth, { id: 'codex', name: 'Codex', summary: 'Quota unknown · Sign-in required', remaining: null, activity: 'unknown', stale: false, observedAt: null });
  const kimi = makeWidgetSnapshot(snapshot({ kimi: status({ kimiSource: 'code', quotas: [quota(99)] }) }),
    { language: 'en', kimiSource: 'work', providerOrder: ['kimi'], enabledProviders: ['kimi'] }, { now: NOW }).rows[0];
  assert.deepEqual(kimi, { id: 'kimi', name: 'Kimi Work', summary: 'Quota unknown · Not read yet', remaining: null, activity: 'unknown', stale: false, observedAt: null });
  const work = makeWidgetSnapshot(snapshot({ kimi: status({ kimiSource: 'work', activity: 'running', quotas: [quota(75, '订阅额度')] }) }),
    { language: 'en', kimiSource: 'work', providerOrder: ['kimi'], enabledProviders: ['kimi'] }, { now: NOW }).rows[0];
  assert.equal(work.activity, 'unknown');
});

test('migrates preferences, honors disabled providers, de-duplicates ordering and caps rows', () => {
  assert.deepEqual(makeWidgetSnapshot(snapshot(), { enabledProviders: [] }, { now: NOW }).rows, []);
  const rows = makeWidgetSnapshot(snapshot(), { providerOrder: ['codex', 'codex'], enabledProviders: ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'] }, { now: NOW }).rows;
  assert.deepEqual(rows.map(row => row.id), ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy']);
});

test('rejects private fields and invalid or future timestamps', () => {
  const row = one({ task: 'PRIVATE TASK', detail: 'PRIVATE DETAIL', email: 'private@example.test', token: 'PRIVATE_TOKEN',
    quotas: [quota(45, '1 week', { model: 'Main\n&\tPRIVATE_MODEL', path: '/private/path' })], observedAt: 'not-a-date' });
  assert.equal(row.observedAt, null);
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE|example\.test|\/private/);
  const result = makeWidgetSnapshot({ sampledAt: new Date(NOW + 1).toISOString(), codex: status({ observedAt: new Date(NOW + 1).toISOString() }) }, preferences, { now: NOW });
  assert.equal(result.sampledAt, null);
  assert.equal(result.rows[0].observedAt, null);
});

test('keeps currency precision in summary without claiming it is a percentage metric', () => {
  const row = makeWidgetSnapshot(snapshot({ deepseek: status({ balance: { stale: false, wallets: [{ currency: 'CNY', total: '12345678901234567890.987654321' }] }, quotas: [quota(99)] }) }),
    { language: 'en', providerOrder: ['deepseek'], enabledProviders: ['deepseek'] }, { now: NOW }).rows[0];
  assert.equal(row.remaining, null);
  assert.match(row.summary, /12,345,678,901,234,567,890\.99/);
});
