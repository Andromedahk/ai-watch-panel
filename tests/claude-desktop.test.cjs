const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { ClaudeStatusReader } = require('../electron/claude-status.cjs');
const { readAnalyticsLog, readAnalyticsTable, snappy, maskedCRC, maskedChecksum, normalizeDesktopPlanEvents,
  readDesktopIdentity, readDesktopPlan, readDesktopActivity } = require('../electron/claude-desktop.cjs');
const now = Date.now();
const account = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const analyticsKey = '_https://claude.ai\0\x01antalytics_queue_v1';
function event(tier = 'claude_pro', at = now) {
  return { eventName: 'claudeai.cedar_ember.settings_shown', eventTimestamp: new Date(at).toISOString(), accountUuid: account, organizationUuid: org,
    properties: { tier, token: 'PRIVATE_TOKEN', title: 'PRIVATE_TITLE', email: 'PRIVATE_EMAIL' } };
}
function varint(value) { const out = []; do { let byte = value & 127; value = Math.floor(value / 128); if (value) byte |= 128; out.push(byte); } while (value); return Buffer.from(out); }
function sized(buffer) { return Buffer.concat([varint(buffer.length), buffer]); }
function batch(events, key = analyticsKey) {
  const header = Buffer.alloc(12); header.writeUInt32LE(1, 8);
  const value = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(events))]);
  return Buffer.concat([header, Buffer.from([1]), sized(Buffer.from(key)), sized(value)]);
}
function wal(payload) {
  const out = []; let cursor = 0, position = 0;
  do {
    const available = 32768 - position % 32768;
    if (available < 7) { out.push(Buffer.alloc(available)); position += available; continue; }
    const size = Math.min(payload.length - cursor, available - 7);
    const first = cursor === 0, last = cursor + size === payload.length;
    const type = first && last ? 1 : first ? 2 : last ? 4 : 3;
    const part = payload.subarray(cursor, cursor + size), header = Buffer.alloc(7);
    header.writeUInt32LE(maskedCRC(type, part)); header.writeUInt16LE(size, 4); header[6] = type;
    out.push(header, part); cursor += size; position += 7 + size;
  } while (cursor < payload.length);
  return Buffer.concat(out);
}
function tableBlock(rows) {
  const entries = rows.map(({ key, value }) => Buffer.concat([varint(0), varint(key.length), varint(value.length), key, value]));
  const footer = Buffer.alloc(8); footer.writeUInt32LE(0, 0); footer.writeUInt32LE(1, 4);
  return Buffer.concat([...entries, footer]);
}
function trailer(data, type = 0) {
  const end = Buffer.alloc(5); end[0] = type; end.writeUInt32LE(maskedChecksum(Buffer.concat([data, Buffer.from([type])])), 1); return Buffer.concat([data, end]);
}
function table(events) {
  const suffix = Buffer.alloc(8); suffix[0] = 1;
  const key = Buffer.concat([Buffer.from(analyticsKey), suffix]), value = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(events))]);
  const data = tableBlock([{ key, value }]); const dataRecord = trailer(data);
  const index = tableBlock([{ key, value: Buffer.concat([varint(0), varint(data.length)]) }]);
  const footer = Buffer.alloc(48); Buffer.concat([varint(0), varint(0), varint(dataRecord.length), varint(index.length)]).copy(footer);
  Buffer.from('57fb808b247547db', 'hex').copy(footer, 40);
  return Buffer.concat([dataRecord, trailer(index), footer]);
}
async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-claude-desktop-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const reader = new ClaudeStatusReader({ home, env: {}, platform: 'darwin', source: 'desktop', desktopActivityReader: async () => ({ trusted: false, supported: true, activity: 'unknown', plan: null }), ...options });
  const root = reader.paths.desktop;
  await fs.mkdir(path.join(root, 'Local Storage', 'leveldb'), { recursive: true });
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ lastKnownAccountUuid: account, 'oauth:tokenCache': 'PRIVATE_ENCRYPTED_TOKEN' }));
  const usage = { version: 2, samples: [{ t: now, org, u: { fh: 100, sd: 21 } }] };
  await fs.writeFile(path.join(root, 'plan-usage-history.json'), JSON.stringify(usage));
  const database = new DatabaseSync(path.join(root, 'Cookies'));
  database.exec('CREATE TABLE cookies (host_key TEXT,name TEXT,path TEXT,value TEXT,encrypted_value BLOB,creation_utc INTEGER,expires_utc INTEGER,has_expires INTEGER)');
  const chrome = value => BigInt(value) * 1000n + 11644473600000000n;
  database.prepare('INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?)').run('.claude.ai', 'sessionKey', '/', '', Buffer.from('PRIVATE_ENCRYPTED_COOKIE'), chrome(now - 60000), chrome(now + 3600000), 1); database.close();
  const log = path.join(root, 'Local Storage', 'leveldb', '000001.log'); await fs.writeFile(log, wal(batch([event()])));
  return { home, reader, root, usage, log, process: [{ pid: 1, command: '/Applications/Claude.app/Contents/MacOS/Claude' }] };
}

test('Claude Desktop parser validates WAL CRC, fragments and specific key boundaries', () => {
  const rows = [event(), { ...event(), properties: { tier: 'free', unrelated: 'x'.repeat(50000) } }];
  assert.equal(readAnalyticsLog(wal(batch(rows))).length, 2);
  assert.deepEqual(readAnalyticsLog(wal(batch(rows, '_https://other.example\0\x01antalytics_queue_v1'))), []);
  const corrupted = wal(batch(rows)); corrupted[20] ^= 1; assert.deepEqual(readAnalyticsLog(corrupted), []);
  assert.deepEqual(readAnalyticsLog(wal(batch(rows)).subarray(0, 20)), []);
  assert.deepEqual(readAnalyticsLog(Buffer.from('"tier":"claude_pro"')), []);
});

test('Claude Desktop table parser and bounded Snappy decoding validate checksums and copy bounds', () => {
  assert.equal(readAnalyticsTable(table([event()])).length, 1);
  const corrupted = table([event()]); corrupted[20] ^= 1; assert.throws(() => readAnalyticsTable(corrupted), /checksum/);
  // Six raw bytes then an overlapping copy produce abcabcabcabc.
  assert.equal(snappy(Buffer.from([12, 20, 97, 98, 99, 97, 98, 99, 22, 3, 0])).toString(), 'abcabcabcabc');
  for (const invalid of [[4, 1, 0], [2, 0, 65], [255, 255, 255, 255, 15], [3, 8, 65]]) assert.throws(() => snappy(Buffer.from(invalid)));
});

test('Desktop plan uses current account/org, explicit usage event and post-login timestamp; new unknown clears paid plan', () => {
  const identity = { account, org, loginAt: now - 60000 };
  assert.deepEqual(normalizeDesktopPlanEvents([event()], identity, now), { at: now, name: 'Pro' });
  assert.equal(normalizeDesktopPlanEvents([event()], { ...identity, account: other }, now), null);
  assert.equal(normalizeDesktopPlanEvents([event()], { ...identity, org: other }, now), null);
  assert.equal(normalizeDesktopPlanEvents([{ ...event(), eventName: 'claudeai.chat.sent' }], identity, now), null);
  assert.equal(normalizeDesktopPlanEvents([event('pro', now - 61000)], identity, now), null);
  assert.equal(normalizeDesktopPlanEvents([event('pro', now + 120001)], identity, now), null);
  assert.deepEqual(normalizeDesktopPlanEvents([event(), event('unrecognized', now + 1)], identity, now), { at: now + 1, name: null });
  assert.equal(normalizeDesktopPlanEvents([event('free')], identity, now).name, 'Free');
});

test('Desktop reads historical plan and zero quotas without authentication decryption or provider writes', async t => {
  const { reader, root, usage, log, process } = await fixture(t);
  const before = await fs.readFile(log);
  const identity = await readDesktopIdentity(root, usage, now);
  assert.ok(identity); assert.equal((await readDesktopPlan(root, identity, now)).name, 'Pro');
  const result = await reader.poll(process, now);
  assert.equal(result.claudeSource, 'desktop'); assert.equal(result.plan.name, 'Pro'); assert.equal(result.plan.stale, true);
  assert.equal(result.activity, 'unknown'); assert.equal(result.activityAccessRequired, true);
  assert.deepEqual(result.quotas.map(row => row.remaining), [0, 79]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|11111111|22222222|sessionKey|lastKnownAccountUuid/);
  assert.deepEqual(await fs.readFile(log), before);
  await fs.unlink(path.join(root, 'Cookies'));
  const loggedOut = await reader.poll(process, now); assert.equal(loggedOut.plan.name, null); assert.deepEqual(loggedOut.quotas, []);
});

test('Desktop safe plan cache survives metadata compaction but immediately clears on identity/login/source changes', async t => {
  const { reader, home, root, log, process } = await fixture(t);
  const cache = path.join(home, 'claude-desktop-plan.json'); reader.setDesktopPlanCacheFile(cache);
  assert.equal((await reader.poll(process, now)).plan.name, 'Pro');
  const saved = await fs.readFile(cache, 'utf8'); assert.doesNotMatch(saved, /PRIVATE|11111111|22222222/); assert.match(saved, /"identity":"[a-f0-9]{64}"/);
  await fs.unlink(log); assert.equal((await reader.poll(process, now)).plan.name, 'Pro');
  const restarted = new ClaudeStatusReader({ home, env: {}, platform: 'darwin', source: 'desktop', desktopPlanCacheFile: cache, desktopActivityReader: reader.desktopActivityReader });
  assert.equal((await restarted.poll(process, now)).plan.name, 'Pro');
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ lastKnownAccountUuid: other }));
  assert.equal((await reader.poll(process, now)).plan.name, null);
  reader.setSource('code'); assert.equal((await reader.poll(process, now)).plan.name, null); assert.deepEqual((await reader.poll(process, now)).quotas, []);
  assert.throws(() => reader.setDesktopPlanCacheFile(path.join(home, 'arbitrary.json')));
});

test('Desktop newer unknown tier overrides its previously remembered paid snapshot', async t => {
  const { reader, home, log, process } = await fixture(t);
  reader.setDesktopPlanCacheFile(path.join(home, 'claude-desktop-plan.json'));
  assert.equal((await reader.poll(process, now)).plan.name, 'Pro');
  await fs.writeFile(log, wal(batch([event('future-product', now + 1)])));
  assert.equal((await reader.poll(process, now + 1)).plan.name, null);
  await fs.unlink(log); assert.equal((await reader.poll(process, now + 2)).plan.name, null);
});

test('Desktop and terminal separate tasks and only explicitly matched valid CLI login shares quotas', async t => {
  const { reader, home, root, process } = await fixture(t, { desktopActivityReader: async () => ({ trusted: true, supported: true, activity: 'idle', plan: null }) });
  const sessions = path.join(home, '.claude', 'sessions'); await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, '2.json'), JSON.stringify({ pid: 2, status: 'busy', entrypoint: 'cli' }));
  await fs.writeFile(path.join(sessions, '3.json'), JSON.stringify({ pid: 3, status: 'waiting', entrypoint: 'claude-desktop' }));
  const processes = [...process, { pid: 2, command: '/app/claude' }, { pid: 3, command: '/app/claude' }];
  assert.equal((await reader.poll(processes, now)).activity, 'waiting');
  reader.setSource('code'); let result = await reader.poll(processes, now); assert.equal(result.activity, 'running'); assert.equal(result.activeTasks, 1); assert.deepEqual(result.quotas, []);
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: account, organizationUuid: org } }));
  await fs.writeFile(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'PRIVATE', expiresAt: now + 3600000, subscriptionType: 'max' } }), { mode: 0o600 });
  result = await reader.poll(processes, now); assert.equal(result.plan.name, 'Max'); assert.equal(result.quotas.length, 2);
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: other, organizationUuid: org } }));
  assert.deepEqual((await reader.poll(processes, now)).quotas, []);
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ lastKnownAccountUuid: other }));
  assert.equal((await reader.poll(processes, now)).plan.name, 'Max');
});

test('Desktop runtime signal is allowlisted; permission prompts happen only in an explicit request', async t => {
  const calls = [];
  const run = async (_file, args) => { calls.push(args); return { stdout: JSON.stringify({ trusted: true, activity: 'running', plan: null, complete: true, secret: 'PRIVATE' }) }; };
  assert.deepEqual(await readDesktopActivity(10, { platform: 'darwin', run }), { trusted: true, supported: true, activity: 'running', plan: null, complete: true });
  assert.deepEqual(calls, [['10']]);
  await readDesktopActivity(null, { platform: 'darwin', requestAccess: true, run }); assert.deepEqual(calls[1], ['--request-access']);
  assert.equal((await readDesktopActivity('malicious', { platform: 'darwin', run })).activity, 'unknown'); assert.equal(calls.length, 2);
  assert.equal((await readDesktopActivity(10, { platform: 'darwin', run: async () => ({ stdout: '{"trusted":true,"activity":"fake","plan":"PRIVATE"}' }) })).activity, 'unknown');
  assert.equal((await readDesktopActivity(10, { platform: 'win32', run })).supported, false);
  const { reader, process } = await fixture(t, { desktopActivityReader: async (_pid, options) => ({ trusted: true, supported: true, activity: options.requestAccess ? 'unknown' : 'running', plan: null }) });
  const result = await reader.poll(process, now); assert.equal(result.activity, 'running'); assert.equal(result.activeTasks, 1); assert.equal(result.activityAccessRequired, false);
  assert.deepEqual(await reader.requestActivityAccess(), { trusted: true, supported: true });
});

test('A source change rejects a pending Desktop response without leaking a previous plan', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const { reader, process } = await fixture(t, { desktopActivityReader: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const pending = reader.poll(process, now); await waiting; reader.setSource('code'); release({ trusted: true, supported: true, activity: 'running', plan: 'Pro' });
  const result = await pending; assert.equal(result.claudeSource, 'code'); assert.equal(result.plan.name, null); assert.deepEqual(result.quotas, []); assert.equal(result.activity, 'unknown');
});

test('Desktop cache expires in memory and refuses reuse after a new login, even for the same account', async t => {
  const { reader, home, root, log, process } = await fixture(t);
  reader.setDesktopPlanCacheFile(path.join(home, 'claude-desktop-plan.json'));
  assert.equal((await reader.poll(process, now)).plan.name, 'Pro');
  await fs.unlink(log);
  const database = new DatabaseSync(path.join(root, 'Cookies'));
  database.prepare('UPDATE cookies SET creation_utc=?').run(BigInt(now) * 1000n + 11644473600000000n); database.close();
  assert.equal((await reader.poll(process, now)).plan.name, null);
  // Verify memory cache expiry independently from provider identity availability.
  const key = 'a'.repeat(64);
  reader.persistedDesktopPlan = { identity: key, name: 'Pro', observedAt: new Date(now - 30 * 86400000 - 1).toISOString() };
  assert.equal(await reader.restoreDesktopPlan(key, now), null);
});
