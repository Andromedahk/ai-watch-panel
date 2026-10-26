const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { SyncStore, LanHost, LanClient, pairWithHost, discoverHosts, parseAddress, isPrivateAddress, sanitize, BASE, PROTOCOL } = require('../electron/lan-sync.cjs');

const tempStore = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-watch-lan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new SyncStore(path.join(dir, 'lan-sync.json'));
};
async function startHost(t, options = {}) {
  const host = new LanHost({ store: tempStore(t), port: 0, name: 'Test Host', discoveryPort: null, bindAddress: '127.0.0.1', ...options });
  await host.start();
  t.after(() => host.close());
  return host;
}
const request = (port, { method = 'GET', pathname, headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, response => {
    let text = ''; response.setEncoding('utf8');
    response.on('data', chunk => { text += chunk; if (response.headers['content-type'] === 'text/event-stream') { req.destroy(); resolve({ status: response.statusCode, text }); } });
    response.on('end', () => resolve({ status: response.statusCode, text }));
  });
  req.on('error', reject);
  req.end(body);
});
const waitFor = async (check, timeout = 3000) => {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); }
};

test('only loopback, private, link-local and unique-local sources count as LAN', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.3.4', '::1', '::ffff:192.168.0.8', 'fd12:3456::1', 'fe80::1%en0']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '172.15.255.255', '192.169.0.1', '100.64.0.1', '2001:db8::1', '999.1.1.1', '', null, 'example.com']) {
    assert.equal(isPrivateAddress(address), false, String(address));
  }
});

test('sanitizing drops credential and location fields and absolute local paths but keeps display data', () => {
  const clean = sanitize({ claude: { activity: 'waiting', task: 'Claude 在等你授权工具', quotas: [{ model: 'Opus', remaining: 40 }], accessToken: 'x', apiKey: 'k',
    cwd: '/repo', logPath: 'p', messagingSocket: 's', detail: 'ok', note: '/Users/someone/project', win: 'C:\\Users\\x', fn: () => 1, nested: { cookie: 'c', keep: 1 } } });
  assert.deepEqual(clean, { claude: { activity: 'waiting', task: 'Claude 在等你授权工具', quotas: [{ model: 'Opus', remaining: 40 }], detail: 'ok', nested: { keep: 1 } } });
});

test('addresses parse with and without ports and reject out-of-range ports', () => {
  assert.deepEqual(parseAddress('192.168.1.5'), { address: '192.168.1.5', port: 47321 });
  assert.deepEqual(parseAddress(' 192.168.1.5:50000 '), { address: '192.168.1.5', port: 50000 });
  assert.deepEqual(parseAddress('[fe80::1]:48000'), { address: 'fe80::1', port: 48000 });
  for (const bad of ['', '192.168.1.5:80', '192.168.1.5:70000', 'a b', null]) assert.equal(parseAddress(bad), null, String(bad));
});

test('the store keeps a 6-digit code, only token hashes, and a private file mode', t => {
  const store = tempStore(t);
  assert.match(store.data.host.code, /^\d{6}$/);
  store.data.host.tokens.push({ hash: 'a'.repeat(64), name: 'Laptop\u0000', pairedAt: 1 });
  store.data.client = { address: '192.168.1.2', port: 47321, token: 't'.repeat(43), hostName: 'Desk' };
  store.save();
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  const again = new SyncStore(store.file);
  assert.equal(again.data.host.code, store.data.host.code);
  assert.deepEqual(again.data.host.tokens, [{ hash: 'a'.repeat(64), name: 'Laptop', pairedAt: 1 }]);
  assert.equal(again.data.client.hostName, 'Desk');
  fs.writeFileSync(store.file, '{bad');
  assert.match(new SyncStore(store.file).data.host.code, /^\d{6}$/);
});

test('pairing needs the current code, issues a random token and stores only its hash', async t => {
  const host = await startHost(t);
  await assert.rejects(pairWithHost({ address: '127.0.0.1', port: host.port, code: host.code === '000000' ? '000001' : '000000' }), /wrong-code/);
  const paired = await pairWithHost({ address: '127.0.0.1', port: host.port, code: host.code, client: 'Laptop' });
  assert.equal(paired.hostName, 'Test Host');
  assert.ok(paired.token.length >= 40);
  const saved = fs.readFileSync(host.store.file, 'utf8');
  assert.doesNotMatch(saved, new RegExp(paired.token));
  assert.equal(host.paired, 1);
});

test('pairing attempts are rate limited per address', async t => {
  const host = await startHost(t);
  const wrong = host.code === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) await assert.rejects(pairWithHost({ address: '127.0.0.1', port: host.port, code: wrong }), /wrong-code/);
  await assert.rejects(pairWithHost({ address: '127.0.0.1', port: host.port, code: host.code }), /rate-limited/);
});

test('the event stream refuses missing or wrong tokens and any browser origin', async t => {
  const host = await startHost(t);
  const { token } = await pairWithHost({ address: '127.0.0.1', port: host.port, code: host.code });
  assert.equal((await request(host.port, { pathname: `${BASE}/events` })).status, 401);
  assert.equal((await request(host.port, { pathname: `${BASE}/events`, headers: { authorization: `Bearer ${'x'.repeat(43)}` } })).status, 401);
  assert.equal((await request(host.port, { pathname: `${BASE}/events`, headers: { authorization: `Bearer ${token}`, origin: 'http://192.168.1.9' } })).status, 403);
  assert.equal((await request(host.port, { method: 'POST', pathname: `${BASE}/pair`, headers: { origin: 'http://evil' }, body: '{}' })).status, 403);
  const ok = await request(host.port, { pathname: `${BASE}/events`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
  const hello = await request(host.port, { pathname: `${BASE}/hello` });
  assert.deepEqual(JSON.parse(hello.text), { protocol: PROTOCOL, name: 'Test Host' });
  assert.equal((await request(host.port, { method: 'POST', pathname: `${BASE}/pair`, body: 'x'.repeat(2048) })).status, 413);
});

test('a paired client receives the current snapshot, later updates, and sanitized data only', async t => {
  const host = await startHost(t);
  host.publish({ status: { claude: { activity: 'running', accessToken: 'secret' } }, journal: { events: [], samples: {}, last: { claude: 'running' } } });
  await new Promise(r => setTimeout(r, 250));
  const paired = await pairWithHost({ address: '127.0.0.1', port: host.port, code: host.code });
  const snapshots = [], states = [];
  const client = new LanClient({ ...paired, onSnapshot: s => snapshots.push(s), onState: s => states.push(s) });
  t.after(() => client.close());
  client.connect();
  await waitFor(() => snapshots.length === 1);
  assert.equal(states.includes('connected'), true);
  assert.deepEqual(snapshots[0].status, { claude: { activity: 'running' } });
  assert.equal(snapshots[0].host, 'Test Host');
  assert.deepEqual(snapshots[0].journal.last, { claude: 'running' });
  host.publish({ status: { claude: { activity: 'waiting', waitingReason: 'input' } } });
  await waitFor(() => snapshots.length === 2);
  assert.equal(snapshots[1].status.claude.waitingReason, 'input');
  assert.deepEqual(snapshots[1].journal.last, { claude: 'running' }, 'journal persists across status-only updates');
  assert.equal(host.connected, 1);
});

test('regenerating the code revokes paired clients, which stop as unauthorized', async t => {
  const host = await startHost(t);
  const paired = await pairWithHost({ address: '127.0.0.1', port: host.port, code: host.code });
  const states = [];
  const client = new LanClient({ ...paired, minDelay: 20, onState: s => states.push(s) });
  t.after(() => client.close());
  client.connect();
  await waitFor(() => states.includes('connected'));
  const before = host.code;
  host.regenerate();
  assert.notEqual(host.code.length, 0);
  assert.equal(host.paired, 0);
  await waitFor(() => states.at(-1) === 'unauthorized');
  assert.equal(before.length, 6);
});

test('a client reconnects with backoff after the host restarts on the same port', async t => {
  const store = tempStore(t);
  let host = new LanHost({ store, port: 0, discoveryPort: null, bindAddress: '127.0.0.1' });
  await host.start();
  const port = host.port;
  const paired = await pairWithHost({ address: '127.0.0.1', port, code: host.code });
  const states = [], snapshots = [];
  const client = new LanClient({ ...paired, minDelay: 30, maxDelay: 120, onState: s => states.push(s), onSnapshot: s => snapshots.push(s) });
  t.after(() => client.close());
  client.connect();
  await waitFor(() => states.includes('connected'));
  await host.close();
  await waitFor(() => states.at(-1) === 'reconnecting');
  host = new LanHost({ store, port, discoveryPort: null, bindAddress: '127.0.0.1' });
  await host.start();
  t.after(() => host.close());
  host.publish({ status: { codex: { activity: 'idle' } } });
  await waitFor(() => snapshots.some(s => s.status?.codex?.activity === 'idle'), 5000);
  assert.equal(states.at(-1), 'connected');
});

test('UDP discovery finds a host that answers on the discovery port', async t => {
  const host = await startHost(t, { discoveryPort: 0 });
  const port = host.discovery.address().port;
  const found = await discoverHosts({ port, targets: ['127.0.0.1'], timeout: 400 });
  assert.deepEqual(found, [{ address: '127.0.0.1', port: host.port, name: 'Test Host' }]);
});
