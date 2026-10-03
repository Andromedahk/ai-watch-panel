const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { HOSTNAME, SUBSCRIPTION_PATH, KimiWorkError, normalizeKimiWorkSubscription,
  requestKimiWorkSubscription } = require('../electron/kimi-work-api.cjs');

const now = Date.parse('2026-10-03T00:00:00Z');
const reply = (changes = {}) => ({ subscription: { goods: { title: 'Moderato', membershipLevel: 3 } }, balances: [
  { feature: 'FEATURE_OMNI', unit: 'UNIT_CREDIT', type: 'SUBSCRIPTION', amountUsedRatio: 0.25, expireTime: '2026-11-01T00:00:00Z' },
  { feature: 'FEATURE_OMNI', unit: 'UNIT_CREDIT', type: 'GIFT', amountUsedRatio: 0.5, expireTime: '2026-10-10T00:00:00Z' },
], account: { userId: 'PRIVATE_USER', order: 'PRIVATE_ORDER' }, ...changes });

test('Kimi Work normalizes only documented credit balances and strips account fields', () => {
  const result = normalizeKimiWorkSubscription(reply(), now);
  assert.deepEqual(result, { plan: { name: 'Moderato' }, quotas: [
    { model: '共享积分', period: '订阅额度', remaining: 75, reset: '2026-11-01T00:00:00.000Z', resetKind: 'expiry' },
    { model: '共享积分', period: '赠送额度', remaining: 50, reset: '2026-10-10T00:00:00.000Z', resetKind: 'expiry' },
  ] });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_USER|PRIVATE_ORDER/);
});

test('Kimi Work preserves zero and full use without fabricating a quota for malformed ratios', () => {
  const zeroFull = reply({ balances: [
    { feature: 'FEATURE_OMNI', unit: 'UNIT_CREDIT', type: 'SUBSCRIPTION', amountUsedRatio: 0, expireTime: 'bad-date' },
    { feature: 'FEATURE_OMNI', unit: 'UNIT_CREDIT', type: 'GIFT', amountUsedRatio: 1 },
  ] });
  assert.deepEqual(normalizeKimiWorkSubscription(zeroFull).quotas, [
    { model: '共享积分', period: '订阅额度', remaining: 100, reset: '', resetKind: 'expiry' },
    { model: '共享积分', period: '赠送额度', remaining: 0, reset: '', resetKind: 'expiry' },
  ]);
  const invalid = reply({ balances: [{ feature: 'FEATURE_OMNI', unit: 'UNIT_CREDIT', type: 'SUBSCRIPTION', amountUsedRatio: '0' }] });
  assert.deepEqual(normalizeKimiWorkSubscription(invalid).quotas, []);
});

test('Kimi Work keeps subscription and gift separate; unknown and duplicate features never claim shared credit', () => {
  const result = normalizeKimiWorkSubscription(reply({ balances: [
    { feature: 'FEATURE_OTHER', unit: 'UNIT_CREDIT', type: 'SUBSCRIPTION', amountUsedRatio: 0.1 },
    { feature: 'FEATURE_OMNI', unit: 'UNIT_CREDIT', type: 'SUBSCRIPTION', amountUsedRatio: 0.2 },
    { feature: 'FEATURE_OMNI', unit: 'UNIT_CREDIT', type: 'SUBSCRIPTION', amountUsedRatio: 0.3 },
    { feature: 'FEATURE_OMNI', unit: 'UNIT_CREDIT', type: 'GIFT', amountUsedRatio: 0.4 },
  ] }));
  assert.deepEqual(result.quotas, [{ model: '共享积分', period: '赠送额度', remaining: 60, reset: '', resetKind: 'expiry' }]);
});

test('Kimi Work only displays an allowlisted plan and accepts a missing title with valid quota', () => {
  for (const name of ['Free', 'Adagio', 'Andante', 'Moderato', 'Allegretto', 'Vivace', 'Allegro', 'Plus', 'Pro', 'Max', 'Ultra']) {
    assert.equal(normalizeKimiWorkSubscription(reply({ subscription: { goods: { title: name, membershipLevel: 2 } } })).plan.name, name);
  }
  assert.equal(normalizeKimiWorkSubscription(reply({ subscription: { goods: { title: 'PRIVATE_PLAN', membershipLevel: 2 } } })).plan.name, null);
  assert.deepEqual(normalizeKimiWorkSubscription(reply({ subscription: { goods: { membershipLevel: 2 } } })).plan, { name: null });
});

test('Kimi Work rejects missing schema and bounds balance rows', () => {
  for (const invalid of [null, {}, { subscription: { goods: { membershipLevel: 2 } } },
    reply({ balances: Array(33).fill({}) }), reply({ balances: [null] })]) {
    assert.throws(() => normalizeKimiWorkSubscription(invalid), { code: 'format' });
  }
});

function transport(status, body, headers = {}, stall = false) {
  return { request(options, callback) {
    assert.equal(options.protocol, 'https:'); assert.equal(options.hostname, HOSTNAME); assert.equal(options.path, SUBSCRIPTION_PATH);
    assert.equal(options.method, 'POST'); assert.equal(options.agent, false); assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    assert.equal(options.headers['Content-Type'], 'application/json'); assert.equal(options.headers['Content-Length'], '2');
    assert.equal(options.headers['Connect-Protocol-Version'], '1');
    const request = new EventEmitter(); let ended;
    request.destroy = () => request.emit('close');
    request.end = bodyText => { ended = bodyText; queueMicrotask(() => {
      if (stall) return;
      assert.equal(ended, '{}');
      const response = new PassThrough(); response.statusCode = status; response.headers = headers;
      response.on('close', () => request.emit('close'));
      callback(response); if (!response.destroyed) response.end(body);
    }); };
    return request;
  } };
}

test('Kimi Work request is a fixed POST with no redirect following', async () => {
  assert.deepEqual(await requestKimiWorkSubscription('fixture-token', { transport: transport(200, JSON.stringify(reply())) }), reply());
  for (const status of [301, 302, 307, 500]) await assert.rejects(requestKimiWorkSubscription('fixture-token', {
    transport: transport(status, '', { location: 'https://untrusted.invalid' }),
  }), { code: 'network' });
});

test('Kimi Work request bounds response, deadline, auth and rate failures without exposing payloads', async () => {
  await assert.rejects(requestKimiWorkSubscription('fixture-token', { transport: transport(200, 'x'.repeat(128 * 1024 + 1)) }), { code: 'format' });
  await assert.rejects(requestKimiWorkSubscription('fixture-token', { transport: transport(200, 'not json PRIVATE_BODY') }), error => error instanceof KimiWorkError && error.code === 'format' && !error.message.includes('PRIVATE_BODY'));
  for (const status of [401, 403]) await assert.rejects(requestKimiWorkSubscription('fixture-token', { transport: transport(status, 'PRIVATE_BODY') }), { code: 'login' });
  await assert.rejects(requestKimiWorkSubscription('fixture-token', { transport: transport(429, '', { 'retry-after': '120' }) }), { code: 'rate', retryMs: 120000 });
  await assert.rejects(requestKimiWorkSubscription('fixture-token', { transport: transport(200, '', {}, true), timeoutMs: 5 }), { code: 'network' });
  await assert.rejects(requestKimiWorkSubscription('bad\ntoken'), { code: 'endpoint' });
});


test('Kimi Work quota remains readable when the membership title is absent', () => {
  const data = reply(); delete data.subscription;
  const result = normalizeKimiWorkSubscription(data);
  assert.equal(result.plan.name, null); assert.equal(result.quotas.length, 2);
  data.balances.unshift({ ...data.balances[0], amountUsedRatio: null });
  assert.equal(normalizeKimiWorkSubscription(data).quotas.length, 1);
});
