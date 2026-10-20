// Passive metadata from Claude's own local records. No OAuth/cookie decryption,
// profile requests, prompts or conversation bodies are used by this adapter.
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { boundedFile } = require('./session-files.cjs');
const execute = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ANALYTICS_KEY = Buffer.from('_https://claude.ai\0\x01antalytics_queue_v1');
const MAX_FILE = 4 * 1024 * 1024;
const PLAN_NAMES = Object.freeze({ free: 'Free', claude_free: 'Free', pro: 'Pro', claude_pro: 'Pro', max: 'Max',
  claude_max: 'Max', claude_max_5x: 'Max 5×', claude_max_20x: 'Max 20×', team: 'Team', claude_team: 'Team',
  enterprise: 'Enterprise', claude_enterprise: 'Enterprise' });
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0); return crc >>> 0;
});
function maskedChecksum(data) {
  let crc = 0xffffffff;
  for (const value of data) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}
function maskedCRC(type, data) { return maskedChecksum(Buffer.concat([Buffer.from([type]), data])); }
function varint(buffer, cursor) {
  let value = 0, scale = 1;
  for (let count = 0; count < 5; count++) {
    if (cursor.offset >= buffer.length) throw new Error('Truncated record');
    const byte = buffer[cursor.offset++]; value += (byte & 127) * scale;
    if (!(byte & 128)) { if (!Number.isSafeInteger(value) || value > MAX_FILE) throw new Error('Invalid record'); return value; }
    scale *= 128;
  }
  throw new Error('Invalid length');
}
function readSized(buffer, cursor) {
  const length = varint(buffer, cursor);
  if (length > buffer.length - cursor.offset) throw new Error('Truncated value');
  const value = buffer.subarray(cursor.offset, cursor.offset + length); cursor.offset += length; return value;
}
function analyticsOfBatch(buffer) {
  if (buffer.length < 12) throw new Error('Truncated batch');
  const count = buffer.readUInt32LE(8);
  if (count > 10000) throw new Error('Too many records');
  const cursor = { offset: 12 }; const result = [];
  for (let index = 0; index < count; index++) {
    const kind = buffer[cursor.offset++]; if (![0, 1].includes(kind)) throw new Error('Unknown record');
    const key = readSized(buffer, cursor); const value = kind === 1 ? readSized(buffer, cursor) : null;
    if (!key.equals(ANALYTICS_KEY) || !value?.length || value.length > 1024 * 1024) continue;
    // Chromium Local Storage prefixes Latin-1/UTF-16 strings with an encoding byte.
    if (![0, 1].includes(value[0]) || (value[0] === 0 && (value.length - 1) % 2)) continue;
    try {
      const events = JSON.parse(value.subarray(1).toString(value[0] === 0 ? 'utf16le' : 'utf8'));
      if (Array.isArray(events) && events.length <= 2000) result.push(...events);
    } catch { /* Incomplete queue or a changed client schema is not plan evidence. */ }
  }
  if (cursor.offset !== buffer.length) throw new Error('Trailing batch bytes');
  return result;
}
function readAnalyticsLog(buffer) {
  const events = []; let parts = [], assembled = 0;
  for (let offset = 0; offset + 7 <= buffer.length;) {
    const available = 32768 - offset % 32768;
    if (available < 7) { offset += available; continue; }
    const crc = buffer.readUInt32LE(offset), length = buffer.readUInt16LE(offset + 4), type = buffer[offset + 6];
    if (!length && !type && !crc) { offset += available; parts = []; assembled = 0; continue; }
    if (length > available - 7 || offset + 7 + length > buffer.length) break;
    const data = buffer.subarray(offset + 7, offset + 7 + length); offset += length + 7;
    if (type < 1 || type > 4 || maskedCRC(type, data) !== crc) { parts = []; assembled = 0; continue; }
    if (type === 1 || type === 2) { parts = [data]; assembled = data.length; }
    else if (parts.length) { parts.push(data); assembled += data.length; }
    else continue;
    if (assembled > 1024 * 1024 || parts.length > 64) { parts = []; assembled = 0; continue; }
    if (type === 1 || type === 4) {
      try { events.push(...analyticsOfBatch(parts.length === 1 ? parts[0] : Buffer.concat(parts))); } catch { /* Ignore damaged batches. */ }
      parts = []; assembled = 0;
      if (events.length > 20000) throw new Error('Too many events');
    }
  }
  return events;
}
function snappy(input) {
  const cursor = { offset: 0 }, length = varint(input, cursor);
  if (length > 1024 * 1024) throw new Error('Expanded block too large');
  const output = Buffer.alloc(length); let written = 0;
  while (cursor.offset < input.length) {
    const tag = input[cursor.offset++], kind = tag & 3; let count, offset;
    if (kind === 0) {
      count = tag >>> 2;
      if (count < 60) count++;
      else {
        const bytes = count - 59;
        if (bytes > 4 || cursor.offset + bytes > input.length) throw new Error('Invalid literal');
        count = input.readUIntLE(cursor.offset, bytes) + 1; cursor.offset += bytes;
      }
      if (count > length - written || cursor.offset + count > input.length) throw new Error('Invalid literal');
      input.copy(output, written, cursor.offset, cursor.offset + count); written += count; cursor.offset += count;
    } else {
      const bytes = kind === 1 ? 1 : kind === 2 ? 2 : 4;
      if (cursor.offset + bytes > input.length) throw new Error('Invalid copy');
      count = kind === 1 ? ((tag >>> 2) & 7) + 4 : (tag >>> 2) + 1;
      offset = input.readUIntLE(cursor.offset, bytes) + (kind === 1 ? (tag & 0xe0) << 3 : 0); cursor.offset += bytes;
      if (offset < 1 || offset > written || count > length - written) throw new Error('Invalid copy offset');
      for (let index = 0; index < count; index++) output[written + index] = output[written + index - offset];
      written += count;
    }
  }
  if (written !== length) throw new Error('Incomplete compressed block');
  return output;
}
function tableEntries(block) {
  if (block.length < 8) throw new Error('Invalid block');
  const restarts = block.readUInt32LE(block.length - 4);
  if (!restarts || restarts > 65536 || restarts * 4 + 4 > block.length) throw new Error('Invalid restarts');
  const limit = block.length - 4 - restarts * 4; let last = -1;
  for (let index = 0; index < restarts; index++) {
    const offset = block.readUInt32LE(limit + index * 4);
    if (offset >= limit || offset <= last) throw new Error('Invalid restart offset'); last = offset;
  }
  const cursor = { offset: 0 }; const result = []; let prior = Buffer.alloc(0);
  while (cursor.offset < limit) {
    const shared = varint(block, cursor), extra = varint(block, cursor), valueLength = varint(block, cursor);
    if (shared > prior.length || cursor.offset + extra + valueLength > limit || shared + extra > 4096) throw new Error('Invalid entry');
    const key = Buffer.concat([prior.subarray(0, shared), block.subarray(cursor.offset, cursor.offset + extra)]); cursor.offset += extra;
    const value = block.subarray(cursor.offset, cursor.offset + valueLength); cursor.offset += valueLength;
    result.push({ key, value }); prior = key;
    if (result.length > 10000) throw new Error('Too many block entries');
  }
  if (cursor.offset !== limit) throw new Error('Invalid entry boundary');
  return result;
}
function readAnalyticsTable(buffer) {
  if (buffer.length < 48 || !buffer.subarray(-8).equals(Buffer.from('57fb808b247547db', 'hex'))) return [];
  const handle = cursor => ({ offset: varint(buffer, cursor), size: varint(buffer, cursor) });
  const footer = { offset: buffer.length - 48 }; handle(footer); const index = handle(footer);
  function block(entry) {
    if (entry.offset + entry.size + 5 > buffer.length - 48) throw new Error('Invalid table handle');
    const input = buffer.subarray(entry.offset, entry.offset + entry.size), type = buffer[entry.offset + entry.size];
    if (![0, 1].includes(type) || maskedChecksum(buffer.subarray(entry.offset, entry.offset + entry.size + 1)) !== buffer.readUInt32LE(entry.offset + entry.size + 1)) throw new Error('Invalid block checksum');
    return type === 1 ? snappy(input) : input;
  }
  const events = [];
  for (const entry of tableEntries(block(index))) {
    const cursor = { offset: 0 }; const source = entry.value;
    const data = { offset: varint(source, cursor), size: varint(source, cursor) };
    if (cursor.offset !== source.length) throw new Error('Invalid index handle');
    for (const row of tableEntries(block(data))) {
      if (row.key.length < 8 || !row.key.subarray(0, -8).equals(ANALYTICS_KEY) || row.key[row.key.length - 8] !== 1) continue;
      const value = row.value;
      if (!value.length || value.length > 1024 * 1024 || ![0, 1].includes(value[0]) || (value[0] === 0 && (value.length - 1) % 2)) continue;
      try { const parsed = JSON.parse(value.subarray(1).toString(value[0] === 0 ? 'utf16le' : 'utf8')); if (Array.isArray(parsed) && parsed.length <= 2000) events.push(...parsed); } catch { /* Unsupported value. */ }
      if (events.length > 20000) throw new Error('Too many events');
    }
  }
  return events;
}
function normalizeDesktopPlanEvents(events, identity, now) {
  if (!UUID.test(identity?.account || '') || !UUID.test(identity?.org || '')) return null;
  let latest = null;
  for (const event of events) {
    if (event?.accountUuid?.toLowerCase() !== identity.account.toLowerCase()
      || event?.organizationUuid?.toLowerCase() !== identity.org.toLowerCase()) continue;
    // Only the usage/settings entitlement snapshot carries a product tier. Other
    // experiments and arbitrary analytics properties are not billing evidence.
    if (!['claudeai.cedar_ember.settings_shown', 'claudeai.settings.usage.viewed', 'claudeai.settings.usage.pace_shown'].includes(event.eventName)) continue;
    const at = Date.parse(event.eventTimestamp); const tier = event.properties?.tier;
    if (!Number.isFinite(at) || at > now + 120000 || at < (identity.loginAt || 0)
      || now - at > 30 * 86400000 || typeof tier !== 'string') continue;
    if (latest && latest.at >= at) continue;
    // A newer explicit unknown/free tier clears a previous paid tier.
    latest = { at, name: Object.hasOwn(PLAN_NAMES, tier) ? PLAN_NAMES[tier] : null };
  }
  return latest;
}
async function readDesktopIdentity(root, usagePayload, now) {
  try {
    const configBuffer = await boundedFile(path.join(root, 'config.json'), root, 1024 * 1024);
    let account;
    try { account = JSON.parse(configBuffer.toString('utf8')).lastKnownAccountUuid; } finally { configBuffer.fill(0); }
    const samples = usagePayload?.version === 2 && Array.isArray(usagePayload.samples) ? usagePayload.samples : [];
    const latest = samples.filter(s => Number.isFinite(s?.t) && s.t > 0 && s.t <= now + 120000).sort((a, b) => b.t - a.t)[0];
    if (!UUID.test(account || '') || !UUID.test(latest?.org || '') || now - latest.t > 30 * 86400000) return null;
    // Login presence is checked using cookie metadata only; ciphertext and cookie
    // values are never selected, decrypted, retained or sent outside the process.
    const file = path.join(root, 'Cookies');
    const [real, base] = await Promise.all([fs.realpath(file), fs.realpath(root)]);
    const info = await fs.stat(real);
    if (!real.startsWith(base + path.sep) || !info.isFile() || info.size > 64 * 1024 * 1024) return null;
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(real, { readOnly: true, timeout: 200 });
    try {
      database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
      const rows = database.prepare(`SELECT CAST(creation_utc AS TEXT) AS created, CAST(expires_utc AS TEXT) AS expires, has_expires
        FROM cookies WHERE host_key = '.claude.ai' AND name = 'sessionKey' AND path = '/'
        AND (length(value) > 0 OR length(encrypted_value) > 0) LIMIT 2`).all();
      const utc = value => Number((BigInt(value) - 11644473600000000n) / 1000n);
      if (rows.length !== 1 || (rows[0].has_expires && utc(rows[0].expires) <= now)) return null;
      const loginAt = utc(rows[0].created);
      if (!Number.isFinite(loginAt) || loginAt <= 0 || loginAt > now + 120000 || latest.t < loginAt) return null;
      return { account, org: latest.org, loginAt };
    } finally { database.close(); }
  } catch { return null; }
}
async function readDesktopPlan(root, identity, now) {
  if (!identity) return { name: null };
  const directory = path.join(root, 'Local Storage', 'leveldb'); let latest = null;
  try {
    // Read only the local-storage analytics key, with WAL/table checksums and
    // bounded Snappy blocks. Never open IndexedDB or conversation stores.
    const names = (await fs.readdir(directory)).filter(n => /^\d{6,}\.(log|ldb|sst)$/.test(n)).sort().slice(-16);
    let bytes = 0;
    for (const name of names) {
      let buffer;
      try {
        buffer = await boundedFile(path.join(directory, name), root, MAX_FILE); bytes += buffer.length;
        if (bytes > 8 * 1024 * 1024) break;
        const plan = normalizeDesktopPlanEvents(name.endsWith('.log') ? readAnalyticsLog(buffer) : readAnalyticsTable(buffer), identity, now);
        if (plan && (!latest || plan.at > latest.at)) latest = plan;
      } finally { buffer?.fill(0); }
    }
  } catch { return { name: null }; }
  return latest ? { name: latest.name, ...(latest.name ? { status: '桌面套餐快照', stale: true } : {}), observedAt: new Date(latest.at).toISOString() } : { name: null };
}
function nativeHelperPath() {
  return path.join(__dirname.replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked'), 'native', 'bin', 'claude-desktop-status');
}
const ACTIVITY_PROBE_ERRORS = Object.freeze(['invalid-pid', 'unsupported-platform', 'helper-missing', 'helper-blocked', 'timeout', 'helper-failed', 'invalid-output', 'permission-check-failed', 'helper-access-denied']);
function unknownActivity(probeError, supported = true) {
  return { trusted: null, supported, activity: 'unknown', plan: null, probeError };
}
function executionProbeError(error) {
  if (error?.code === 'ENOENT') return 'helper-missing';
  if (['EACCES', 'EPERM', 'ENOEXEC'].includes(error?.code)) return 'helper-blocked';
  if (['ETIMEDOUT', 'ERR_CHILD_PROCESS_TIMEOUT'].includes(error?.code)
    || (error?.killed === true && error?.signal === 'SIGTERM')) return 'timeout';
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'invalid-output';
  return 'helper-failed';
}
async function readDesktopActivity(pid, { platform = process.platform, requestAccess = false, run = execute } = {}) {
  if (platform !== 'darwin') return unknownActivity('unsupported-platform', false);
  if (!requestAccess && (!Number.isInteger(pid) || pid < 1 || pid > 2147483647)) return unknownActivity('invalid-pid');
  let stdout;
  try {
    ({ stdout } = await run(nativeHelperPath(), requestAccess ? ['--request-access'] : [String(pid)],
      { timeout: 1800, maxBuffer: 2048, encoding: 'utf8' }));
  } catch (error) {
    // Execution failure cannot establish the application's accessibility grant.
    // Never propagate child-process messages, argv, paths or stderr to the UI.
    return unknownActivity(executionProbeError(error));
  }
  try {
    if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 2048) return unknownActivity('invalid-output');
    const result = JSON.parse(stdout);
    if (!result || Array.isArray(result) || typeof result.trusted !== 'boolean' || typeof result.complete !== 'boolean'
      || !['running', 'idle', 'unknown'].includes(result.activity)
      || (result.plan !== null && !['Free', 'Pro', 'Max', 'Max 5×', 'Max 20×', 'Team', 'Enterprise'].includes(result.plan))
      || (result.trusted === false && (result.activity !== 'unknown' || result.plan !== null || result.complete !== false))) return unknownActivity('invalid-output');
    return { trusted: result.trusted, supported: true, activity: result.activity, plan: result.plan, complete: result.complete };
  } catch { return unknownActivity('invalid-output'); }
}
module.exports = { ACTIVITY_PROBE_ERRORS, readAnalyticsLog, readAnalyticsTable, snappy, maskedChecksum, normalizeDesktopPlanEvents, readDesktopIdentity, readDesktopPlan, readDesktopActivity, maskedCRC };
