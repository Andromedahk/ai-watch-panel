const test = require('node:test');
const assert = require('node:assert/strict');
const { traySummary } = require('../electron/tray-summary.cjs');
const quota = (model, period, remaining, stale = false) => ({ model, period, remaining, stale });
const label = (id, data) => traySummary({ [id]: { connection: 'ready', ...data } }, { enabledProviders: [id] })[0].label;

test('seven-day primary quota takes priority over short windows and Codex review quota', () => {
  assert.equal(label('codex', { quotas: [quota('代码审查', '1 周', 12), quota('Codex', '5 小时', 90), quota('Codex', '1 周', 0)] }), 'Codex    7 天 · 剩余 0%');
  for (const period of ['7 天', '7 days', '每周', '1 week']) assert.match(label('zcode', { quotas: [quota('短时', '5 小时', 90), quota('全部', period, 30)] }), /7 天 · 剩余 30%$/);
  assert.match(label('codex', { quotas: [quota('Codex', '5 小时', 90)] }), /5 小时 · 剩余 90%$/);
});

test('Antigravity displays exactly one existing base model, preferring Gemini Pro', () => {
  const quotas = [quota('Claude Opus', '模型额度', 22.4), quota('Gemini Flash', '模型额度', 99), quota('Gemini Pro', '模型额度', 60)];
  assert.equal(label('antigravity', { quotas }), 'Antigravity    Gemini Pro · 剩余 60%');
  assert.match(label('antigravity', { quotas: quotas.slice(0, 2) }), /Gemini Flash/);
  assert.match(label('antigravity', { quotas: quotas.slice(0, 1) }), /Claude Opus/);
});

test('credits select existing total or subscription without adding bonus points again', () => {
  const credits = { items: [{ label: '奖励积分', remaining: '100', unit: '积分' }, { label: '总积分', remaining: '2100', unit: '积分' }] };
  assert.equal(label('workbuddy', { credits }), 'WorkBuddy    总积分 · 剩余 2,100 积分');
  assert.match(label('qwen', { credits, quotas: [quota('全部', '1 周', 40)] }), /7 天 · 剩余 40%$/);
  assert.match(label('qwen', { credits: { items: [{ label: '套餐积分', remaining: '0', unit: '积分' }] } }), /剩余 0 积分$/);
});

test('DeepSeek shows one currency, preserving small balances and decimal precision', () => {
  const balance = { wallets: [{ currency: 'USD', total: '50' }, { currency: 'CNY', total: '39.08698216' }] };
  assert.equal(label('deepseek', { balance }), 'DeepSeek Harness    余额 ¥39.09 CNY');
  assert.match(label('deepseek', { balance: { wallets: [{ currency: 'USD', total: '0.001' }] } }), /余额 <\$0.01 USD$/);
  assert.match(label('deepseek', { balance: { wallets: [{ currency: 'CNY', total: '0' }] } }), /¥0.00/);
});

test('historical, unavailable and cleared login values cannot masquerade as current', () => {
  assert.match(label('codex', { quotas: [quota('Codex', '1 周', 83, true)] }), /历史剩余 83%（非实时）/);
  assert.match(label('codex', { quotas: [quota('Codex', '1 周', null), quota('Codex', '5 小时', 90)] }), /7 天 · 未知$/);
  assert.match(label('qwen', { connection: 'auth-required', credits: { items: [{ label: '总积分', remaining: '999', unit: '积分' }] } }), /额度未知 · 待登录$/);
  assert.match(label('deepseek', { balance: { wallets: [{ currency: 'CNY', total: '10' }], stale: true } }), /历史余额/);
  assert.match(label('workbuddy', { connection: 'error', credits: { items: [{ label: '总积分', remaining: '10', unit: '积分' }] } }), /历史剩余/);
  assert.match(label('codex', { quotas: [quota('Codex', '1 周', NaN)] }), /未知$/);
});

test('summary respects enabled modules, order, zero selection and Kimi source isolation', () => {
  const preferences = { providerOrder: ['kimi', 'codex', 'workbuddy'], enabledProviders: ['kimi', 'codex'], kimiSource: 'work' };
  const old = { kimi: { kimiSource: 'code', connection: 'ready', quotas: [quota('全部', '1 周', 99)] } };
  const rows = traySummary(old, preferences);
  assert.deepEqual(rows.map(row => row.id), ['kimi', 'codex']);
  assert.equal(rows[0].label, 'Kimi Work    额度未知 · 尚未读取');
  assert.deepEqual(traySummary(old, { ...preferences, enabledProviders: [] }), []);
  old.kimi = { kimiSource: 'work', connection: 'ready', quotas: [quota('共享积分', '赠送额度', 50), quota('共享积分', '订阅额度', 75)] };
  assert.equal(traySummary(old, preferences)[0].label, 'Kimi Work    订阅积分 · 剩余 75%');
});

test('summary does not include task content, account details or untrusted control characters', () => {
  const result = label('antigravity', { task: 'PRIVATE TASK', detail: 'PRIVATE DETAILS', quotas: [quota('Gemini Pro\n&\tSample', '模型额度', 50)] });
  assert.doesNotMatch(result, /PRIVATE|[\n\t&]/);
});
