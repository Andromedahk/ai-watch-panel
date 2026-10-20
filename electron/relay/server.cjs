const http = require('node:http');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { RelayStore, RelayError, AGENTS, readRelayArchive } = require('./store.cjs');
const { createRelayMcpServer } = require('./tools.cjs');

const MAX_BODY = 64 * 1024;
const MAX_CONNECTIONS = 32;
const TIMEOUT = 10_000;
const fail = code => { throw new RelayError(code); };
function reply(res, status, error) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Connection': 'close' });
  res.end(JSON.stringify({ error }));
}
async function body(req) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) fail('request-too-large');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BODY) fail('request-too-large'); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); } catch { fail('invalid-json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-json'); return value;
}

class AgentRelay {
  constructor({ directory, port = 27841, now = Date.now, onChange = () => {} }) {
    if (!Number.isInteger(port) || port < 0 || port > 65535 || typeof onChange !== 'function') fail('invalid-configuration');
    this.directory = directory; this.port = port; this.now = now; this.onChange = onChange;
    this.server = null; this.store = null; this.endpoint = null; this.running = false; this.error = null;
    this.sockets = new Set(); this.requests = new Set(); this.lifecycle = Promise.resolve();
  }
  signal() { try { this.onChange(); } catch {} }
  start() {
    const operation = this.lifecycle.then(async () => {
      if (this.running) return this.getState();
      this.error = null;
      const store = new RelayStore({ directory: this.directory, now: this.now, onChange: () => this.signal() });
      let server;
      try {
        await store.init(); this.store = store;
        server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => { this.handle(req, res).catch(() => reply(res, 500, 'relay-failed')); });
        server.requestTimeout = TIMEOUT; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 100; server.maxConnections = MAX_CONNECTIONS;
        server.on('connection', socket => {
          if (this.sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
          this.sockets.add(socket); socket.setTimeout(TIMEOUT, () => socket.destroy()); socket.on('error', () => {}); socket.on('close', () => this.sockets.delete(socket));
        });
        server.on('clientError', (_, socket) => socket.destroy());
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
        server.on('error', () => { this.error = 'server-failed'; this.signal(); });
        this.server = server; this.endpoint = `http://127.0.0.1:${server.address().port}/mcp`; this.running = true; this.signal();
        return this.getState();
      } catch (error) {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        await store.close().catch(() => {}); this.store = null; this.server = null; this.endpoint = null;
        this.error = error instanceof RelayError ? error.code : error.code === 'EADDRINUSE' ? 'port-in-use' : 'server-unavailable'; this.signal(); fail(this.error);
      }
    });
    this.lifecycle = operation.catch(() => {}); return operation;
  }
  async handle(req, res) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    // Browser requests, including null origins and requests from local web pages, are rejected.
    if (!this.running || !this.store || !this.endpoint) return reply(res, 503, 'unavailable');
    const expected = `127.0.0.1:${this.server.address().port}`;
    if (req.headers.host !== expected || Object.prototype.hasOwnProperty.call(req.headers, 'origin')) return reply(res, 403, 'forbidden');
    if (req.url !== '/mcp') return reply(res, 404, 'not-found');
    const authorization = req.headers.authorization;
    const match = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    const actor = match && this.store.authenticate(match[1]);
    if (!actor) return reply(res, 401, 'unauthorized');
    if (req.method !== 'POST') return reply(res, 405, 'method-not-allowed');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return reply(res, 415, 'unsupported-content-type');
    if (this.requests.size >= MAX_CONNECTIONS) return reply(res, 429, 'busy');
    const request = { server: null, transport: null }; this.requests.add(request);
    let timer, cleaned = false;
    const cleanup = async () => {
      if (cleaned) return; cleaned = true;
      clearTimeout(timer); this.requests.delete(request);
      await Promise.allSettled([request.transport?.close(), request.server?.close()]);
    };
    res.once('close', cleanup);
    timer = setTimeout(() => { reply(res, 408, 'request-timeout'); req.destroy(); cleanup(); }, TIMEOUT); timer.unref();
    try {
      const parsed = await body(req);
      if (res.destroyed || !this.running) return;
      request.server = createRelayMcpServer(this.store, actor);
      request.transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await request.server.connect(request.transport);
      await request.transport.handleRequest(req, res, parsed);
    } catch (error) {
      const code = error instanceof RelayError ? error.code : 'invalid-request';
      reply(res, code === 'request-too-large' ? 413 : 400, code);
    } finally { if (res.writableEnded || res.destroyed) await cleanup(); }
  }
  stop() {
    const operation = this.lifecycle.then(async () => {
      this.running = false; const server = this.server; this.server = null; this.endpoint = null;
      const closed = server ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
      for (const socket of this.sockets) socket.destroy();
      await Promise.allSettled([...this.requests].flatMap(request => [request.transport?.close(), request.server?.close()])); this.requests.clear();
      await closed; if (this.store) await this.store.close(); this.signal(); return this.getState();
    }); this.lifecycle = operation.catch(() => {}); return operation;
  }
  getState() { return { running: this.running, endpoint: this.running ? this.endpoint : null, ...(this.store?.getState() ?? { agentCount: AGENTS.length, queuedTasks: 0, lastEventAt: null }), ...(this.error ? { error: this.error } : {}) }; }
  clientCredentials(agentId) { if (!this.running || !this.store) fail('unavailable'); return { agentId, endpoint: this.endpoint, token: this.store.credential(agentId) }; }
  ownerListTasks(options) { return this.store ? this.store.ownerListTasks(options) : []; }
  ownerReadTranscript(taskId) { if (!this.store) fail('unavailable'); return this.store.ownerReadTranscript(taskId); }
  ownerCommand(agentId, tool, args) { if (!this.running || !this.store) return Promise.reject(new RelayError('unavailable')); return this.store.ownerCommand(agentId, tool, args); }
}

module.exports = { AgentRelay, MAX_BODY, MAX_CONNECTIONS, readRelayArchive };
