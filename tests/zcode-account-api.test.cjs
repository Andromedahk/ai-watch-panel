const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ZcodeAccountError, normalizeIdentity, normalizeSubscription,
  normalizeQuota, normalizeDisplayQuotas, requestZcodeJson } = require('../electron/zcode-account-api.cjs');

const success = data => ({ success: true, code: 0, data });

test('ZCode identity accepts only a successful bounded customer number', () => {
  assert.deepEqual(normalizeIdentity(success({ customerNumber: 'account-123', ignored: 'PRIVATE' })), { customerNumber: 'account-123' });
  assert.throws(() => normalizeIdentity({ success: false, code: 401, data: { customerNumber: 'x' } }), { code: 'login' });
  assert.throws(() => normalizeIdentity({ success: false, code: 403, data: { customerNumber: 'x' } }), { code: 'login' });
  for (const value of [null, {}, { success: false, data: { customerNumber: 'x' } }, success({ customerNumber: '' }), success({ customerNumber: 0 })]) {
    assert.throws(() => normalizeIdentity(value), { code: 'format' });
  }
});

test('ZCode subscription exposes only a unique allowlisted active Coding Plan', () => {
  const make = (name, changes = {}) => ({ status: 'VALID', inCurrentPeriod: true, productName: name, privateOrder: 'SECRET', ...changes });
  for (const [name, expected] of [['GLM Coding Lite', 'Lite'], ['GLM Coding Pro', 'Pro'], ['GLM Coding Max', 'Max'],
    ['GLM Coding Plan Lite', 'Lite'], ['GLM Coding Plan Pro', 'Pro'], ['GLM Coding Plan Max', 'Max'],
    ['Coding Plan Lite', 'Lite'], ['Coding Plan Pro', 'Pro'], ['Coding Plan Max', 'Max']]) {
    assert.deepEqual(normalizeSubscription(success([make(name)])), { plan: { name: expected } });
  }
  assert.deepEqual(normalizeSubscription(success([make('GLM Coding Pro', { productId: 'product-opaque-id' })])), { plan: { name: 'Pro' } });
  assert.deepEqual(normalizeSubscription(success([make('Coding Plan Enterprise')])), { plan: { name: null } });
  assert.deepEqual(normalizeSubscription(success([make('Coding Plan Lite'), make('Coding Plan Pro')])), { plan: { name: null } });
  assert.deepEqual(normalizeSubscription(success([make('Coding Plan Lite', { inCurrentPeriod: false })])), { plan: { name: null } });
  assert.throws(() => normalizeSubscription(success(Array(33).fill({}))), { code: 'format' });
});

test('ZCode quota keeps zero numeric values and drops untrusted fields and rows', () => {
  const result = normalizeQuota(success({ limits: [
    { type: 'TIME_LIMIT', unit: 0, number: 100, usage: 0, currentValue: 1, remaining: 0, percentage: 0, nextResetTime: 123, account: 'PRIVATE' },
    { type: 'x'.repeat(65), remaining: 1 }, { type: 'PLAN', remaining: NaN }, null,
  ] }));
  assert.deepEqual(result, [{ type: 'TIME_LIMIT', unit: 0, number: 100, usage: 0, currentValue: 1, remaining: 0, percentage: 0, nextResetTime: 123 }, { type: 'PLAN' }]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.throws(() => normalizeQuota(success({ limits: Array(33).fill({}) })), { code: 'format' });
  assert.throws(() => normalizeQuota(success({ limits: null })), { code: 'format' });
});

test('ZCode maps only renderer-verified quota buckets without inferring counts or reset periods', () => {
  const reset = Date.parse('2026-11-01T00:00:00Z');
  assert.deepEqual(normalizeDisplayQuotas([
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0, nextResetTime: reset },
    { type: 'CREDIT_LIMIT', unit: 6, number: 999, percentage: 100, nextResetTime: reset },
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 33.333, nextResetTime: reset },
  ]), [
    { model: '共享额度', period: '5 小时', remaining: 100, reset: '2026-11-01T00:00:00.000Z' },
    { model: '共享额度', period: '1 周', remaining: 0, reset: '2026-11-01T00:00:00.000Z' },
    { model: '工具调用', period: '1 月', remaining: 66.7, reset: '2026-11-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(normalizeDisplayQuotas([
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: null, nextResetTime: -1 },
  ]), [{ model: '共享额度', period: '5 小时', remaining: null, reset: '' }]);
  assert.deepEqual(normalizeDisplayQuotas([
    { type: 'CREDIT_LIMIT', unit: 6, number: 0, percentage: 101, nextResetTime: Number.NaN },
  ]), [{ model: '共享额度', period: '1 周', remaining: null, reset: '' }]);
  assert.deepEqual(normalizeDisplayQuotas([
    { type: 'TOKENS_LIMIT', unit: 4, number: 5, percentage: 0 },
    { type: 'TIME_LIMIT', unit: 5, number: 2, percentage: 0 },
  ]), []);
  assert.deepEqual(normalizeDisplayQuotas([
    { type: 'TOKENS_LIMIT', unit: 3, number: 4, percentage: 10 },
    { type: 'TOKENS_LIMIT', unit: 4, number: 5, percentage: 10 },
    { type: 'TIME_LIMIT', unit: 5, number: 2, percentage: 10 },
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 },
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 20 },
  ]), []);
});

function transport(status, body, { headers = {}, stall = false, earlyClose = false } = {}) {
  return { request(options, callback) {
    assert.equal(options.protocol, 'https:');
    assert.equal(options.method, 'GET');
    assert.equal(options.agent, false);
    assert.deepEqual(options.headers, { Accept: 'application/json', Authorization: 'fixture-token' });
    const request = new EventEmitter();
    request.destroy = () => request.emit('close');
    request.end = (...args) => { assert.equal(args.length, 0); queueMicrotask(() => {
      if (stall) return;
      const response = new PassThrough();
      response.statusCode = status; response.headers = headers;
      callback(response);
      if (earlyClose) response.destroy(); else if (!response.destroyed) response.end(body);
    }); };
    return request;
  } };
}

const FIXED_PATHS = Object.freeze({
  identity: '/api/biz/customer/getCustomerInfo',
  subscription: '/api/biz/subscription/list',
  quota: '/api/monitor/usage/quota/limit',
});

for (const [family, hostname] of Object.entries({ bigmodel: 'bigmodel.cn' })) {
  for (const [kind, path] of Object.entries(FIXED_PATHS)) {
    test(`ZCode ${family}/${kind} uses its fixed GET endpoint`, async () => {
      const observed = [];
      const fixed = { request(options, callback) {
        observed.push(options);
        const request = new EventEmitter(); request.destroy = () => {};
        request.end = (...args) => { assert.equal(args.length, 0); const response = new PassThrough(); response.statusCode = 200; response.headers = {}; callback(response); response.end('{"data":true}'); };
        return request;
      } };
      assert.deepEqual(await requestZcodeJson(family, kind, 'Bearer fixture-token', { transport: fixed }), { data: true });
      assert.equal(observed.length, 1); assert.equal(observed[0].hostname, hostname); assert.equal(observed[0].path, path);
    });
  }
}

for (const [kind, path] of Object.entries({ subscription: FIXED_PATHS.subscription, quota: FIXED_PATHS.quota })) {
  test(`ZCode zai/${kind} uses its fixed GET endpoint`, async () => {
    const observed = [];
    const fixed = { request(options, callback) {
      observed.push(options);
      const request = new EventEmitter(); request.destroy = () => {};
      request.end = (...args) => { assert.equal(args.length, 0); const response = new PassThrough(); response.statusCode = 200; response.headers = {}; callback(response); response.end('{"data":true}'); };
      return request;
    } };
    assert.deepEqual(await requestZcodeJson('zai', kind, 'Bearer fixture-token', { transport: fixed }), { data: true });
    assert.equal(observed.length, 1); assert.equal(observed[0].hostname, 'api.z.ai'); assert.equal(observed[0].path, path);
  });
}

test('ZCode request rejects redirects, invalid endpoints and avoids token leakage', async () => {
  for (const status of [301, 302, 307, 500]) await assert.rejects(requestZcodeJson('zai', 'quota', 'fixture-token', {
    transport: transport(status, 'PRIVATE_BODY', { headers: { location: 'https://untrusted.invalid' } }),
  }), error => error instanceof ZcodeAccountError && error.code === 'network' && !error.message.includes('PRIVATE_BODY'));
  let calls = 0;
  const forbidden = { request() { calls++; throw new Error('transport must not run'); } };
  for (const args of [['other', 'quota', 'fixture-token'], ['constructor', 'quota', 'fixture-token'], ['__proto__', 'quota', 'fixture-token'],
    ['toString', 'quota', 'fixture-token'], ['zai', 'constructor', 'fixture-token'], ['zai', '__proto__', 'fixture-token'],
    ['zai', 'toString', 'fixture-token'], ['zai', 'identity', 'fixture-token'], ['zai', 'quota', 'bad\ntoken'], ['zai', 'quota', 'x'.repeat(16385)]]) {
    await assert.rejects(requestZcodeJson(...args, { transport: forbidden }), { code: 'endpoint' });
  }
  assert.equal(calls, 0);
});

test('ZCode request handles auth, rate, size, parse, timeout and early-close safely', async () => {
  for (const status of [401, 403]) await assert.rejects(requestZcodeJson('zai', 'quota', 'fixture-token', { transport: transport(status, 'PRIVATE_BODY') }), { code: 'login' });
  await assert.rejects(requestZcodeJson('zai', 'quota', 'fixture-token', { transport: transport(429, '', { headers: { 'Retry-After': '120' } }) }), { code: 'rate', retryMs: 120000 });
  await assert.rejects(requestZcodeJson('zai', 'quota', 'fixture-token', { transport: transport(200, 'x'.repeat(128 * 1024 + 1)) }), { code: 'format' });
  await assert.rejects(requestZcodeJson('zai', 'quota', 'fixture-token', { transport: transport(200, 'PRIVATE_INVALID') }), error => error instanceof ZcodeAccountError && error.code === 'format' && !error.message.includes('PRIVATE_INVALID'));
  await assert.rejects(requestZcodeJson('zai', 'quota', 'fixture-token', { transport: transport(200, '', { earlyClose: true }) }), { code: 'network' });
  await assert.rejects(requestZcodeJson('zai', 'quota', 'fixture-token', { transport: transport(200, '', { stall: true }), timeoutMs: 5 }), { code: 'network' });
});
