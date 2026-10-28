'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const path = require('node:path');
const { isIP } = require('node:net');
const { CloudService } = require('./service.cjs');
const { createPush } = require('./push.cjs');
const { UUID, ensure, error } = require('./validation.cjs');
const MAX_BODY = 256 * 1024;
function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0; let chunks = []; let failed = false;
    const fail = e => { if (!failed) { failed = true; chunks = []; reject(e); } };
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] || '')) fail(error('json-required', 415));
    if (!['identity', 'gzip'].includes(request.headers['content-encoding'] || 'identity')) fail(error('unsupported-encoding', 415));
    if (Number(request.headers['content-length']) > MAX_BODY) fail(error('body-too-large', 413));
    request.on('error', () => fail(error('request-failed')));
    request.on('aborted', () => fail(error('request-aborted')));
    request.on('data', chunk => { if (failed) return; size += chunk.length; if (size > MAX_BODY) fail(error('body-too-large', 413)); else chunks.push(chunk); });
    request.on('end', () => {
      if (failed) return;
      try {
        let buffer = Buffer.concat(chunks);
        if (request.headers['content-encoding'] === 'gzip') {
          try { buffer = zlib.gunzipSync(buffer, { maxOutputLength: MAX_BODY }); }
          catch (e) { throw error(e.code === 'ERR_BUFFER_TOO_LARGE' ? 'body-too-large' : 'invalid-gzip', e.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400); }
        }
        let value; try { value = JSON.parse(buffer.toString('utf8')); } catch { throw error('invalid-json'); }
        resolve(value);
      } catch (e) { fail(e); }
    });
  });
}
function secretHash(value) { return crypto.createHash('sha256').update(value).digest(); }
function createServer({ desktopToken, mobileToken, file, push, now = Date.now, threshold = 20, timers = true, trustProxy = false } = {}) {
  ensure(typeof desktopToken === 'string' && desktopToken.length >= 32 && desktopToken.length <= 512 && !/\s/.test(desktopToken), 'desktop-token-required');
  ensure(typeof mobileToken === 'string' && mobileToken.length >= 32 && mobileToken.length <= 512 && !/\s/.test(mobileToken) && desktopToken !== mobileToken, 'separate-mobile-token-required');
  ensure(Number.isFinite(threshold) && threshold >= 0 && threshold <= 100, 'invalid-threshold');
  const hashes = { desktop: secretHash(desktopToken), admin: secretHash(mobileToken) };
  const clients = new Map(); const buckets = new Map();
  const writeEvent = (response, state) => {
    if (response.destroyed || response.writableLength > MAX_BODY * 2) { response.destroy(); clients.delete(response); return; }
    response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  };
  const service = new CloudService({ file, push, now, threshold, onChange: state => { for (const response of clients.keys()) writeEvent(response, state); },
    onRevoke: id => { for (const [response, owner] of clients) if (owner === id) { response.end(); clients.delete(response); } } });
  function rate(key, limit) {
    const minute = Math.floor(now() / 60000); let bucket = buckets.get(key);
    if (!bucket || bucket.minute !== minute) { bucket = { minute, count: 0 }; buckets.set(key, bucket); }
    if (buckets.size > 1024) for (const [k, b] of buckets) { if (b.minute !== minute) buckets.delete(k); }
    ensure(buckets.size <= 2048 && ++bucket.count <= limit, 'rate-limited', 429);
  }
  function clientAddress(request) {
    const forwarded = trustProxy && request.headers['x-forwarded-for'];
    const candidate = typeof forwarded === 'string' && forwarded.length <= 128 ? forwarded.split(',')[0].trim() : '';
    return isIP(candidate) ? candidate : request.socket.remoteAddress || 'unknown';
  }
  function auth(request, scope) {
    const header = request.headers.authorization || '';
    const token = typeof header === 'string' && /^Bearer [^\s]{32,512}$/.test(header) ? header.slice(7) : '';
    const owner = scope === 'mobile' ? service.authenticate(token) : null;
    const valid = scope === 'mobile' ? owner !== null : token && crypto.timingSafeEqual(secretHash(token), hashes[scope]);
    if (!valid) { rate(`unauthorized:${clientAddress(request)}`, 30); throw error('unauthorized', 401); }
    return owner;
  }
  function json(response, status, value) {
    if (response.destroyed || response.headersSent) return;
    const body = JSON.stringify(value);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(body);
  }
  const server = http.createServer(async (request, response) => {
    try {
      ensure((request.url || '').length <= 1024, 'uri-too-long', 414);
      const url = new URL(request.url, 'http://localhost');
      ensure(!url.search, 'query-not-supported');
      if (url.pathname === '/healthz' && request.method === 'GET') { json(response, 200, { ok: true }); return; }
      if (url.pathname === '/v1/sync' && request.method === 'POST') {
        auth(request, 'desktop'); rate('sync', 120);
        const generation = service.data.resetGeneration || 0; const body = await readBody(request);
        ensure(generation === (service.data.resetGeneration || 0), 'desktop-reset', 409);
        json(response, 200, service.sync(body)); return;
      }
      if (url.pathname === '/v1/pair' && request.method === 'POST') {
        rate(`pair:${clientAddress(request)}`, 10); auth(request, 'admin');
        json(response, 201, service.pair(await readBody(request))); return;
      }
      if (url.pathname.startsWith('/v1/admin/')) {
        rate(`admin:${clientAddress(request)}`, 60); auth(request, 'admin');
        if (url.pathname === '/v1/admin/devices' && request.method === 'GET') { json(response, 200, service.installations()); return; }
        const revoke = url.pathname.match(/^\/v1\/admin\/devices\/([^/]+)$/);
        if (revoke && request.method === 'DELETE') { json(response, 200, service.revoke(revoke[1])); return; }
        if (url.pathname === '/v1/admin/reset-desktop' && request.method === 'POST') {
          const body = await readBody(request); ensure(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0);
          json(response, 200, service.resetDesktop()); return;
        }
        throw error('not-found', 404);
      }
      const owner = auth(request, 'mobile'); rate(`mobile:${owner}`, 600); service.prune();
      if (url.pathname === '/v1/pair' && request.method === 'DELETE') { json(response, 200, service.revoke(owner)); return; }
      if (url.pathname === '/v1/state' && request.method === 'GET') { json(response, 200, service.state()); return; }
      if (url.pathname === '/v1/events' && request.method === 'GET') {
        ensure(clients.size < 64 && [...clients.values()].filter(id => id === owner).length < 2, 'stream-capacity', 429);
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        response.flushHeaders(); clients.set(response, owner); writeEvent(response, service.state());
        request.on('close', () => clients.delete(response)); return;
      }
      if (url.pathname === '/v1/commands' && request.method === 'POST') {
        rate(`commands:${owner}`, 30); const body = await readBody(request); ensure(auth(request, 'mobile') === owner, 'unauthorized', 401);
        json(response, 202, service.command(body, owner)); return;
      }
      if (url.pathname === '/v1/devices' && request.method === 'POST') {
        rate(`devices:${owner}`, 30); const body = await readBody(request); ensure(auth(request, 'mobile') === owner, 'unauthorized', 401);
        json(response, 200, service.register(body, owner)); return;
      }
      if (url.pathname === '/v1/live-activity' && ['POST', 'DELETE'].includes(request.method)) {
        rate(`activities:${owner}`, 60);
        const emptyDelete = request.method === 'DELETE' && (!request.headers['content-length'] || Number(request.headers['content-length']) === 0) && !request.headers['transfer-encoding'];
        const body = emptyDelete ? {} : await readBody(request);
        ensure(auth(request, 'mobile') === owner, 'unauthorized', 401);
        json(response, 200, request.method === 'POST' ? service.registerActivity(body, owner) : service.removeActivity(body, owner)); return;
      }
      const device = url.pathname.match(/^\/v1\/devices\/([^/]+)$/);
      if (device && request.method === 'DELETE') { ensure(UUID.test(device[1]), 'invalid-device'); json(response, 200, service.unregister(device[1], owner)); return; }
      throw error('not-found', 404);
    } catch (e) { json(response, e.status || 500, { error: e.status ? e.message : 'internal-error' }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 40; server.keepAliveTimeout = 65000;
  const timer = timers ? setInterval(() => { try { service.tick(); } catch { /* A failed durable write is retried on the next tick. */ } }, 1000) : null;
  const heartbeat = timers ? setInterval(() => { for (const response of clients.keys()) { if (!response.destroyed) response.write(': heartbeat\n\n'); } }, 15000) : null;
  timer?.unref(); heartbeat?.unref();
  return { server, service, async close() { clearInterval(timer); clearInterval(heartbeat); for (const c of clients.keys()) c.end(); clients.clear();
    if (!server.listening) return; await new Promise(resolve => server.close(resolve)); server.closeAllConnections(); } };
}
if (require.main === module) {
  try {
    const runtime = createServer({ desktopToken: process.env.AI_WATCH_DESKTOP_TOKEN, mobileToken: process.env.AI_WATCH_MOBILE_TOKEN,
      file: process.env.AI_WATCH_STATE_FILE ? path.resolve(__dirname, process.env.AI_WATCH_STATE_FILE) : path.join(__dirname, 'data', 'state.json'), push: createPush(), trustProxy: process.env.AI_WATCH_TRUST_PROXY === 'true', threshold: Number(process.env.AI_WATCH_LOW_QUOTA_PERCENT || 20) });
    const port = Number(process.env.PORT || 8787); ensure(Number.isInteger(port) && port > 0 && port < 65536, 'invalid-port');
    runtime.server.listen(port, process.env.HOST || '127.0.0.1', () => process.stdout.write('AI Watch cloud service ready\n'));
    runtime.server.on('error', () => { process.stderr.write('Cloud listener failed\n'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void runtime.close().then(() => process.exit(0)); });
  } catch { process.stderr.write('Cloud startup failed: check configuration and state permissions\n'); process.exitCode = 1; }
}
module.exports = { createServer, readBody, MAX_BODY };
