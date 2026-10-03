const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { electronTransport } = require('../electron/kimi-work-transport.cjs');
const { requestKimiWorkSubscription } = require('../electron/kimi-work-api.cjs');

function fakeNet(status, body = '{}', headers = {}) {
  return { request(options) {
    assert.equal(options.url, 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscription');
    assert.equal(options.redirect, 'error'); assert.equal(options.useSessionCookies, false);
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    const request = new EventEmitter(), incoming = new EventEmitter();
    incoming.statusCode = status; incoming.headers = headers;
    request.setHeader = name => { assert.notEqual(name.toLowerCase(), 'content-length'); };
    request.abort = () => { incoming.emit('aborted'); request.emit('close'); };
    request.end = value => { assert.equal(value, '{}'); queueMicrotask(() => {
      request.emit('close'); request.emit('response', incoming); incoming.emit('data', Buffer.from(body)); incoming.emit('end');
    }); };
    return request;
  } };
}

test('Electron abort cannot turn authentication, rate or size errors into a network error', async () => {
  for (const status of [401, 403]) await assert.rejects(requestKimiWorkSubscription('fixture-token', {
    transport: electronTransport(fakeNet(status)),
  }), { code: 'login' });
  await assert.rejects(requestKimiWorkSubscription('fixture-token', {
    transport: electronTransport(fakeNet(429, '{}', { 'retry-after': ['120'] })),
  }), { code: 'rate', retryMs: 120000 });
  await assert.rejects(requestKimiWorkSubscription('fixture-token', {
    transport: electronTransport(fakeNet(200, 'x'.repeat(128 * 1024 + 1))),
  }), { code: 'format' });
  assert.deepEqual(await requestKimiWorkSubscription('fixture-token', {
    transport: electronTransport(fakeNet(200)),
  }), {});
});
