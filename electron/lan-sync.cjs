// LAN sync: a host panel shares its status snapshot and journal with paired
// client panels on the same private network. Off unless the user picks a role.
const http = require('node:http');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL = 1;
const DEFAULT_PORT = 47321;
const DISCOVERY_PORT = 47322;
const DISCOVERY_QUERY = 'ai-watch-discover/1';
const BASE = '/ai-watch/v1';
const MAX_BODY = 1024;
const MAX_SNAPSHOT = 4 * 1024 * 1024;
const PAIR_WINDOW_MS = 10 * 60000;
const PAIR_ATTEMPTS_PER_ADDRESS = 5;
const PAIR_ATTEMPTS_TOTAL = 20;
const HEARTBEAT_MS = 15000;

// Loopback, RFC 1918, link-local and IPv6 unique/link-local only. Anything
// routed from outside the local network is refused before any parsing.
function isPrivateAddress(address) {
  if (typeof address !== 'string') return false;
  const value = address.toLowerCase().replace(/^::ffff:/, '').replace(/%.*$/, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (v4.slice(1).some(part => Number(part) > 255)) return false;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return value === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(value) || /^fe[89ab][0-9a-f]?:/.test(value);
}
const isPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
const hash = value => crypto.createHash('sha256').update(String(value)).digest();
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const cleanName = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) : '';

// Share what the panel displays, never what it uses to read it. Keys that name
// credentials or locations are dropped wherever they appear, and string values
// that are absolute local paths are removed.
const SECRET_KEY = /token|secret|password|cookie|credential|api.?key|auth.?header|path|socket|cwd|file|dir$/i;
const LOCAL_PATH = /^(?:\/(?:Users|home|private|var|tmp|Volumes|opt)\/|[A-Za-z]:\\|\\\\)/;
function sanitize(value, depth = 0) {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1)).filter(item => item !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      const clean = sanitize(item, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  if (typeof value === 'string') return LOCAL_PATH.test(value) ? undefined : value;
  return ['number', 'boolean'].includes(typeof value) || value === null ? value : undefined;
}

class SyncStore {
  constructor(file) { this.file = file; this.data = this.read(); }
  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const host = data?.host && typeof data.host === 'object' ? data.host : {};
      const client = data?.client && typeof data.client === 'object' ? data.client : null;
      return {
        host: { code: /^\d{6}$/.test(host.code) ? host.code : newCode(),
          tokens: Array.isArray(host.tokens) ? host.tokens.filter(item => /^[0-9a-f]{64}$/.test(item?.hash)).slice(0, 32)
            .map(item => ({ hash: item.hash, name: cleanName(item.name), pairedAt: Number.isFinite(item.pairedAt) ? item.pairedAt : 0 })) : [] },
        client: client && typeof client.address === 'string' && isPort(client.port) && typeof client.token === 'string' && client.token.length >= 32
          ? { address: client.address, port: client.port, token: client.token, hostName: cleanName(client.hostName) } : null,
      };
    } catch { return { host: { code: newCode(), tokens: [] }, client: null }; }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    fs.chmodSync(this.file, 0o600);
  }
}

class LanHost {
  constructor({ store, port = DEFAULT_PORT, name = os.hostname(), now = Date.now, discoveryPort = DISCOVERY_PORT, bindAddress = '0.0.0.0' } = {}) {
    this.store = store; this.port = port; this.name = cleanName(name) || 'AI Watch'; this.now = now;
    this.discoveryPort = discoveryPort; this.bindAddress = bindAddress;
    this.streams = new Set(); this.attempts = new Map(); this.payload = null; this.pending = null;
    this.state = { status: null, journal: null };
  }
  get code() { return this.store.data.host.code; }
  get paired() { return this.store.data.host.tokens.length; }
  get connected() { return this.streams.size; }
  async start() {
    this.server = http.createServer((request, response) => this.route(request, response));
    this.server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, this.bindAddress, resolve); });
    this.port = this.server.address().port;
    if (this.discoveryPort !== null) await this.startDiscovery().catch(() => { this.discovery = null; });
    this.heartbeat = setInterval(() => { for (const stream of this.streams) stream.write(': keep-alive\n\n'); }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }
  startDiscovery() {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('error', reject);
      socket.on('message', (message, remote) => {
        if (!isPrivateAddress(remote.address) || message.toString('utf8') !== DISCOVERY_QUERY) return;
        const reply = Buffer.from(JSON.stringify({ type: 'ai-watch-host', protocol: PROTOCOL, name: this.name, port: this.port }));
        socket.send(reply, remote.port, remote.address);
      });
      socket.bind(this.discoveryPort, () => { this.discovery = socket; resolve(); });
    });
  }
  async close() {
    clearInterval(this.heartbeat); clearTimeout(this.pending);
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    try { this.discovery?.close(); } catch { /* Already closed. */ }
    if (this.server) await new Promise(resolve => { this.server.close(() => resolve()); this.server.closeAllConnections?.(); });
  }
  regenerate() {
    // A new code also revokes every paired client: the only way to unpair.
    this.store.data.host = { code: newCode(), tokens: [] }; this.store.save();
    for (const stream of this.streams) stream.end();
    this.streams.clear();
  }
  publish(update) {
    if (update.status !== undefined) this.state.status = sanitize(update.status);
    if (update.journal !== undefined) this.state.journal = sanitize(update.journal);
    // Coalesce bursts (status poll plus journal save) into one frame.
    if (!this.pending) this.pending = setTimeout(() => { this.pending = null; this.broadcast(); }, 200);
  }
  frame() {
    const data = JSON.stringify({ protocol: PROTOCOL, host: this.name, sentAt: new Date(this.now()).toISOString(), ...this.state });
    return data.length > MAX_SNAPSHOT ? null : `event: snapshot\ndata: ${data}\n\n`;
  }
  broadcast() {
    const frame = this.frame();
    if (frame) for (const stream of this.streams) stream.write(frame);
  }
  authorized(request) {
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token.length < 32 || token.length > 128) return false;
    const presented = hash(token);
    let match = false;
    for (const item of this.store.data.host.tokens) {
      if (crypto.timingSafeEqual(presented, Buffer.from(item.hash, 'hex'))) match = true;
    }
    return match;
  }
  allowPairing(address) {
    const now = this.now(), recent = time => now - time < PAIR_WINDOW_MS;
    const own = (this.attempts.get(address) || []).filter(recent);
    const total = [...this.attempts.values()].flat().filter(recent).length;
    if (own.length >= PAIR_ATTEMPTS_PER_ADDRESS || total >= PAIR_ATTEMPTS_TOTAL) return false;
    this.attempts.set(address, [...own, now]);
    return true;
  }
  route(request, response) {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify(body));
    };
    // Browsers send Origin; the panel's own client never does. This keeps web
    // pages on the network from driving pairing or reading the stream.
    if (!isPrivateAddress(request.socket.remoteAddress) || request.headers.origin !== undefined) return send(403, { error: 'forbidden' });
    const url = request.url || '';
    if (request.method === 'GET' && url === `${BASE}/hello`) return send(200, { protocol: PROTOCOL, name: this.name });
    if (request.method === 'POST' && url === `${BASE}/pair`) return this.pair(request, send);
    if (request.method === 'GET' && url === `${BASE}/events`) {
      if (!this.authorized(request)) return send(401, { error: 'unauthorized' });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
      request.socket.setKeepAlive(true);
      this.streams.add(response);
      response.on('close', () => this.streams.delete(response));
      const frame = this.frame();
      response.write(frame || ': waiting\n\n');
      return undefined;
    }
    return send(404, { error: 'not-found' });
  }
  pair(request, send) {
    if (!this.allowPairing(request.socket.remoteAddress)) return send(429, { error: 'rate-limited' });
    let body = '', size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { send(413, { error: 'too-large' }); request.destroy(); return; }
      body += chunk;
    });
    request.on('end', () => {
      if (size > MAX_BODY) return;
      let payload;
      try { payload = JSON.parse(body); } catch { return send(400, { error: 'bad-request' }); }
      const code = typeof payload?.code === 'string' ? payload.code : '';
      if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(hash(code), hash(this.code))) return send(403, { error: 'wrong-code' });
      const tokens = this.store.data.host.tokens;
      if (tokens.length >= 32) return send(409, { error: 'too-many-clients' });
      const token = crypto.randomBytes(32).toString('base64url');
      tokens.push({ hash: hash(token).toString('hex'), name: cleanName(payload.client), pairedAt: this.now() });
      this.store.save();
      return send(200, { protocol: PROTOCOL, token, host: this.name });
    });
  }
}

function postJson({ address, port, pathname, body, request = http.request, timeout = 5000 }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ host: address, port, path: pathname, method: 'POST', timeout,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (text.length < 4096) text += chunk; });
      response.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(text); } catch { /* Reported below. */ }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

function parseAddress(text, fallbackPort = DEFAULT_PORT) {
  const value = typeof text === 'string' ? text.trim() : '';
  const match = /^\[?([0-9A-Za-z.:-]+?)\]?(?::(\d{2,5}))?$/.exec(value);
  if (!match || !match[1]) return null;
  const port = match[2] ? Number(match[2]) : fallbackPort;
  return isPort(port) ? { address: match[1], port } : null;
}

async function pairWithHost({ address, port, code, client = os.hostname(), request }) {
  if (!isPrivateAddress(address) && !/^[A-Za-z0-9-]+(\.local)?$/.test(address)) throw new Error('not-private');
  if (!/^\d{6}$/.test(String(code))) throw new Error('wrong-code');
  const result = await postJson({ address, port, pathname: `${BASE}/pair`, body: { code: String(code), client: cleanName(client) }, request });
  if (result.status === 200 && typeof result.body?.token === 'string' && result.body.protocol === PROTOCOL) {
    return { address, port, token: result.body.token, hostName: cleanName(result.body.host) };
  }
  throw new Error(result.body?.error || `http-${result.status}`);
}

class LanClient {
  constructor({ address, port, token, onSnapshot = () => {}, onState = () => {}, request = http.request, minDelay = 1000, maxDelay = 30000 }) {
    Object.assign(this, { address, port, token, onSnapshot, onState, request, minDelay, maxDelay });
    this.attempt = 0; this.closed = false; this.state = 'connecting';
  }
  setState(state, detail) { this.state = state; this.onState(state, detail); }
  connect() {
    if (this.closed) return;
    this.setState(this.attempt ? 'reconnecting' : 'connecting');
    let buffer = '';
    const req = this.request({ host: this.address, port: this.port, path: `${BASE}/events`, method: 'GET',
      headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' } }, response => {
      if (response.statusCode === 401) { response.resume(); this.closed = true; this.setState('unauthorized'); return; }
      if (response.statusCode !== 200) { response.resume(); this.retry(); return; }
      this.attempt = 0; this.setState('connected');
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > MAX_SNAPSHOT * 2) { req.destroy(); return; }
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const lines = block.split('\n');
          if (!lines.includes('event: snapshot')) continue;
          const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
          try {
            const snapshot = JSON.parse(data);
            if (snapshot?.protocol === PROTOCOL) this.onSnapshot(sanitize(snapshot));
          } catch { /* Ignore one malformed frame; the next snapshot replaces it. */ }
        }
      });
      response.on('end', () => this.retry());
      response.on('error', () => this.retry());
    });
    req.on('error', () => this.retry());
    // No heartbeat for twice the host interval means the link is gone.
    req.setTimeout(HEARTBEAT_MS * 2 + 5000, () => req.destroy());
    this.req = req;
    req.end();
  }
  retry() {
    if (this.closed || this.timer) return;
    const delay = Math.min(this.maxDelay, this.minDelay * 2 ** Math.min(this.attempt, 8));
    this.attempt += 1;
    this.setState('reconnecting', { delay });
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delay);
    this.timer.unref?.();
  }
  close() {
    this.closed = true; clearTimeout(this.timer); this.timer = null;
    this.req?.destroy();
  }
}

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const items of Object.values(os.networkInterfaces())) for (const item of items || []) {
    if (item.family !== 'IPv4' || item.internal || !item.netmask) continue;
    const ip = item.address.split('.').map(Number), mask = item.netmask.split('.').map(Number);
    out.add(ip.map((part, index) => (part | (~mask[index] & 255)) >>> 0).join('.'));
  }
  return [...out];
}
function localAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal && isPrivateAddress(item.address)).map(item => item.address);
}

function discoverHosts({ timeout = 1500, port = DISCOVERY_PORT, targets = broadcastAddresses() } = {}) {
  return new Promise(resolve => {
    const found = new Map();
    const socket = dgram.createSocket('udp4');
    const finish = () => { try { socket.close(); } catch { /* Closed. */ } resolve([...found.values()]); };
    socket.on('error', finish);
    socket.on('message', (message, remote) => {
      if (!isPrivateAddress(remote.address)) return;
      try {
        const reply = JSON.parse(message.toString('utf8'));
        if (reply?.type === 'ai-watch-host' && reply.protocol === PROTOCOL && isPort(reply.port)) {
          found.set(`${remote.address}:${reply.port}`, { address: remote.address, port: reply.port, name: cleanName(reply.name) });
        }
      } catch { /* Not ours. */ }
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      for (const target of targets) socket.send(DISCOVERY_QUERY, port, target, () => {});
      setTimeout(finish, timeout);
    });
  });
}

module.exports = { PROTOCOL, DEFAULT_PORT, DISCOVERY_PORT, BASE, SyncStore, LanHost, LanClient, pairWithHost, discoverHosts, parseAddress,
  isPrivateAddress, isPort, sanitize, localAddresses, newCode };
