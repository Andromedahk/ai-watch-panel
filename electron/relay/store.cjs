const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');

const AGENTS = Object.freeze([{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }]);
const LIMITS = Object.freeze({ logBytes: 8 * 1024 * 1024, tasks: 500, events: 8500, exchanges: 16, parentDepth: 3 });
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired']);
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SECRET = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|\b(?:Bearer|Basic)\s+[A-Za-z0-9_./+~=-]{16,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b|(?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|(?:aws[_-]?)?secret[_-]?access[_-]?key|password|authorization|密钥|密码)["']?\s*[:=]\s*["']?)[A-Za-z0-9_./+~=-]{12,}/i;

class RelayError extends Error {
  constructor(code) { super(code); this.name = 'RelayError'; this.code = code; }
}
const fail = code => { throw new RelayError(code); };
const clone = value => JSON.parse(JSON.stringify(value));
const knownAgent = value => AGENTS.some(agent => agent.id === value);
function text(value, max, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail('invalid-input');
  return value.trim();
}
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('invalid-input');
}
function taskId(value) { if (typeof value !== 'string' || !ID.test(value)) fail('invalid-input'); return value; }
function limit(value, fallback = 30) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 100) fail('invalid-input'); return value;
}
function privateStat(stat, directory = false) {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (!directory && stat.nlink !== 1)) fail('unsafe-storage');
  if (process.platform !== 'win32' && ((stat.mode & 0o777) !== (directory ? 0o700 : 0o600) || (process.getuid && stat.uid !== process.getuid()))) fail('unsafe-storage');
}
async function privateOpen(file, flags) {
  try {
    const handle = await fs.open(file, flags | (constants.O_NOFOLLOW || 0), 0o600);
    try { privateStat(await handle.stat()); } catch (error) { await handle.close(); throw error; }
    return handle;
  } catch (error) { if (error instanceof RelayError) throw error; fail('storage-unavailable'); }
}
async function existing(file, maxBytes) {
  try {
    const stat = await fs.lstat(file); privateStat(stat);
    if (stat.size > maxBytes) fail('storage-limit');
    const handle = await privateOpen(file, constants.O_RDONLY);
    try { return await handle.readFile({ encoding: 'utf8' }); } finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof RelayError) throw error; fail('storage-unavailable'); }
}
async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomic(file, value) {
  const temp = `${file}.${randomBytes(10).toString('hex')}.tmp`;
  let handle;
  try {
    try { privateStat(await fs.lstat(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    handle = await privateOpen(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    await handle.writeFile(value, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temp, file); await syncDirectory(path.dirname(file));
  } catch (error) { if (handle) await handle.close().catch(() => {}); await fs.unlink(temp).catch(() => {}); if (error instanceof RelayError) throw error; fail('storage-unavailable'); }
}
async function writeAt(handle, text, position) {
  const bytes = Buffer.from(text, 'utf8'); let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (result.bytesWritten < 1) fail('storage-unavailable'); offset += result.bytesWritten;
  }
}
const quote = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').split('\n').map(line => `> ${line}`).join('\n');
function markdown(event) {
  const label = ({ sent: 'Task assigned', claimed: 'Task claimed', message: 'Task conversation', result: 'Task result', cancelled: 'Task cancelled', blocked: 'Content blocked' })[event.type];
  let result = `\n## ${event.at} · ${label}\n\n- Record: ${event.seq}\n- Agent: ${event.actor}\n`;
  if (event.taskId) result += `- Task: ${event.taskId}\n`;
  const data = event.data;
  if (event.type === 'sent') {
    result += `- Recipient: ${data.to}\n- Expires: ${data.expiresAt}\n`;
    if (data.sessionId) result += `- Requested session: ${data.sessionId}\n`;
    if (data.parentTaskId) result += `- Parent task: ${data.parentTaskId}\n`;
    result += `\n**Subject**\n\n${quote(data.subject)}\n\n**Necessary purpose**\n\n${quote(data.purpose)}\n\n**Instructions**\n\n${quote(data.instructions)}\n\n**Acceptance criteria**\n\n${data.acceptanceCriteria.map(item => quote(item)).join('\n\n')}\n`;
  } else if (event.type === 'blocked') result += `- Operation: ${data.operation}\n- Reason: sensitive-content (original text omitted)\n`;
  else {
    result += `\n**Necessary purpose**\n\n${quote(data.purpose)}\n`;
    if (event.type === 'message') result += `\n**${data.kind}**\n\n${quote(data.text)}\n`;
    if (event.type === 'result') result += `\n- Outcome: ${data.status}\n\n**Summary**\n\n${quote(data.summary)}\n\n**Details**\n\n${quote(data.details)}\n`;
  }
  return result;
}
const HEADER = '# AI Watch agent task transcript\n\nThis local record contains necessary, task-scoped agent communication. Authentication credentials are excluded. Connection presence does not indicate that a task is running.\n';

class RelayStore {
  constructor({ directory, now = Date.now, onChange = () => {} }) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof now !== 'function') fail('invalid-configuration');
    this.directory = directory; this.now = now; this.onChange = onChange;
    this.logPath = path.join(directory, 'events.jsonl'); this.markdownPath = path.join(directory, 'transcript.md');
    this.credentialsPath = path.join(directory, 'credentials.json');
    this.lockPath = path.join(directory, 'writer.lock'); this.lockOwner = null;
    this.tasks = new Map(); this.events = []; this.keys = new Map(); this.queue = Promise.resolve(); this.bytes = 0;
    this.open = false; this.fault = false;
  }
  async init() {
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      privateStat(await fs.lstat(this.directory), true);
      await this.acquireLock();
      const credentials = await existing(this.credentialsPath, 4096);
      if (credentials === null) {
        this.credentials = Object.fromEntries(AGENTS.map(agent => [agent.id, randomBytes(32).toString('base64url')]));
        await atomic(this.credentialsPath, JSON.stringify({ version: 1, agents: this.credentials }) + '\n');
      } else {
        let record; try { record = JSON.parse(credentials); } catch { fail('corrupt-storage'); }
        if (!record || record.version !== 1 || !record.agents || Object.keys(record.agents).sort().join(',') !== 'claude,codex' || Object.values(record.agents).some(token => typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) || record.agents.claude === record.agents.codex) fail('corrupt-storage');
        this.credentials = record.agents;
      }
      const contents = await existing(this.logPath, LIMITS.logBytes);
      if (contents !== null) {
        // A write interrupted before its newline was never acknowledged. Preserve all complete records.
        const lastNewline = contents.lastIndexOf('\n');
        const complete = contents.slice(0, lastNewline + 1);
        for (const line of complete.split('\n').filter(Boolean)) {
          let event; try { event = JSON.parse(line); this.validateEvent(event); this.apply(event); } catch { fail('corrupt-storage'); }
          this.events.push(event);
          if (this.events.length > LIMITS.events || this.tasks.size > LIMITS.tasks) fail('storage-limit');
        }
        this.bytes = Buffer.byteLength(complete);
        if (complete !== contents) await atomic(this.logPath, complete);
      } else await atomic(this.logPath, '');
      // The JSONL is authoritative. Rebuild the readable view after an interrupted previous write.
      await existing(this.markdownPath, LIMITS.logBytes * 2);
      await atomic(this.markdownPath, HEADER + this.events.map(markdown).join(''));
      this.open = true;
    } catch (error) { await this.releaseLock().catch(() => {}); if (error instanceof RelayError) throw error; fail('storage-unavailable'); }
  }
  async acquireLock() {
    const nonce = randomBytes(16).toString('hex');
    const owner = `owner-${process.pid}-${nonce}.json`;
    const temporary = path.join(this.directory, `.writer-${process.pid}-${nonce}.tmp`);
    await fs.mkdir(temporary, { mode: 0o700 });
    try {
      await atomic(path.join(temporary, owner), JSON.stringify({ version: 1, pid: process.pid, nonce }) + '\n');
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // A populated directory cannot be replaced by rename. The owner record is complete
          // before publishing the lease, so an interrupted acquisition has a recoverable PID.
          await fs.rename(temporary, this.lockPath); this.lockOwner = owner;
          await syncDirectory(this.directory); return;
        } catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error; }
        privateStat(await fs.lstat(this.lockPath), true);
        const entries = await fs.readdir(this.lockPath);
        if (entries.length !== 1 || !/^owner-[1-9][0-9]*-[a-f0-9]{32}\.json$/.test(entries[0])) fail('unsafe-storage');
        const contents = await existing(path.join(this.lockPath, entries[0]), 1024);
        let lease; try { lease = JSON.parse(contents); } catch { fail('unsafe-storage'); }
        if (!lease || lease.version !== 1 || !Number.isSafeInteger(lease.pid) || lease.pid < 1 || lease.pid > 2147483647 || !/^[a-f0-9]{32}$/.test(lease.nonce) || entries[0] !== `owner-${lease.pid}-${lease.nonce}.json`) fail('unsafe-storage');
        let dead = false;
        try { process.kill(lease.pid, 0); } catch (error) { if (error.code === 'ESRCH') dead = true; }
        if (!dead) fail('storage-busy');
        // Only one contender can remove this unique old nonce. A newly published lease
        // has a different filename and keeps rmdir from removing its nonempty directory.
        try { await fs.unlink(path.join(this.lockPath, entries[0])); await fs.rmdir(this.lockPath); }
        catch { fail('storage-busy'); }
      }
      fail('storage-busy');
    } finally { await fs.rm(temporary, { recursive: true, force: true }).catch(() => {}); }
  }
  async releaseLock() {
    if (!this.lockOwner) return;
    const owner = this.lockOwner; this.lockOwner = null;
    try {
      privateStat(await fs.lstat(this.lockPath), true);
      const entries = await fs.readdir(this.lockPath);
      if (entries.length !== 1 || entries[0] !== owner) fail('storage-changed');
      const contents = await existing(path.join(this.lockPath, owner), 1024);
      const record = JSON.parse(contents);
      if (record.pid !== process.pid || owner !== `owner-${record.pid}-${record.nonce}.json`) fail('storage-changed');
      await fs.unlink(path.join(this.lockPath, owner)); await fs.rmdir(this.lockPath); await syncDirectory(this.directory);
    } catch (error) { if (error instanceof RelayError) throw error; fail('storage-unavailable'); }
  }
  validateEvent(event) {
    if (!event || Object.keys(event).some(key => !['version', 'seq', 'at', 'type', 'actor', 'taskId', 'data'].includes(key)) || event.version !== 1 || event.seq !== this.events.length + 1 || !knownAgent(event.actor) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) || !['sent', 'claimed', 'message', 'result', 'cancelled', 'blocked'].includes(event.type) || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) fail('corrupt-storage');
    if (event.type !== 'blocked') taskId(event.taskId);
    if (event.type === 'sent') {
      const normalized = this.normalizeSend(event.actor, event.data, true);
      if (normalized.to !== event.data.to || event.data.digest !== createHash('sha256').update(JSON.stringify(normalized)).digest('hex') || typeof event.data.expiresAt !== 'string' || Date.parse(event.data.expiresAt) !== Date.parse(event.at) + normalized.ttlSeconds * 1000 || this.tasks.has(event.taskId) || this.hasSecrets(normalized)) fail('corrupt-storage');
      if (this.keys.has(`${event.actor}:${event.data.idempotencyKey}`)) fail('corrupt-storage');
    } else if (event.type === 'blocked') {
      if (event.data.reason !== 'sensitive-content' || !['send', 'claim', 'message', 'result', 'cancel'].includes(event.data.operation) || Object.keys(event.data).some(key => !['reason', 'operation'].includes(key))) fail('corrupt-storage');
    } else {
      const task = this.participant(event.actor, event.taskId, false);
      object(event.data, event.type === 'message' ? ['purpose', 'kind', 'text'] : event.type === 'result' ? ['purpose', 'status', 'summary', 'details'] : ['purpose']);
      text(event.data.purpose, 1000, 4);
      if (this.hasSecrets(event.data) || task.exchanges >= LIMITS.exchanges || (event.type === 'message' && task.exchanges >= LIMITS.exchanges - 1)) fail('corrupt-storage');
      if (event.type === 'claimed' && (task.to !== event.actor || task.status !== 'queued')) fail('corrupt-storage');
      if (event.type === 'message') {
        if (task.status !== 'running' || !['question', 'answer', 'progress'].includes(event.data.kind)) fail('corrupt-storage');
        text(event.data.text, 12000);
      }
      if (event.type === 'result') {
        if (task.to !== event.actor || task.status !== 'running' || !['completed', 'failed'].includes(event.data.status)) fail('corrupt-storage');
        text(event.data.summary, 2000); text(event.data.details, 16000);
      }
      if (event.type === 'cancelled' && (task.from !== event.actor || TERMINAL.has(task.status))) fail('corrupt-storage');
    }
  }
  normalizeSend(actor, input, replay = false) {
    object(input, ['to', 'subject', 'purpose', 'instructions', 'acceptanceCriteria', 'sessionId', 'idempotencyKey', 'parentTaskId', 'ttlSeconds', ...(replay ? ['expiresAt', 'digest'] : [])]);
    if (!knownAgent(input.to) || input.to === actor) fail('invalid-recipient');
    const normalized = { to: input.to, subject: text(input.subject, 160), purpose: text(input.purpose, 1000, 4), instructions: text(input.instructions, 12000), acceptanceCriteria: input.acceptanceCriteria };
    if (!Array.isArray(normalized.acceptanceCriteria) || normalized.acceptanceCriteria.length < 1 || normalized.acceptanceCriteria.length > 12) fail('invalid-input');
    normalized.acceptanceCriteria = normalized.acceptanceCriteria.map(value => text(value, 1000));
    normalized.idempotencyKey = text(input.idempotencyKey, 120, 8);
    if (!/^[A-Za-z0-9_.:-]+$/.test(normalized.idempotencyKey)) fail('invalid-input');
    normalized.sessionId = input.sessionId === undefined || input.sessionId === null ? null : text(input.sessionId, 160);
    if (normalized.sessionId && !/^[A-Za-z0-9_.:-]+$/.test(normalized.sessionId)) fail('invalid-input');
    normalized.parentTaskId = input.parentTaskId === undefined || input.parentTaskId === null ? null : taskId(input.parentTaskId);
    normalized.ttlSeconds = input.ttlSeconds ?? 3600;
    if (!Number.isInteger(normalized.ttlSeconds) || normalized.ttlSeconds < 60 || normalized.ttlSeconds > 86400) fail('invalid-input');
    if (normalized.parentTaskId) {
      let parent = this.participant(actor, normalized.parentTaskId, false), depth = 2;
      while (parent.parentTaskId) { parent = this.tasks.get(parent.parentTaskId); if (!parent || ++depth > LIMITS.parentDepth) fail('parent-depth'); }
    }
    return normalized;
  }
  apply(event) {
    const data = event.data;
    if (event.type === 'sent') {
      const task = { id: event.taskId, from: event.actor, to: data.to, subject: data.subject, purpose: data.purpose,
        instructions: data.instructions, acceptanceCriteria: data.acceptanceCriteria, sessionId: data.sessionId,
        parentTaskId: data.parentTaskId, createdAt: event.at, updatedAt: event.at, expiresAt: data.expiresAt,
        status: 'queued', exchanges: 1 };
      this.tasks.set(task.id, task); this.keys.set(`${event.actor}:${data.idempotencyKey}`, { taskId: task.id, digest: data.digest });
    } else if (event.type !== 'blocked') {
      const task = this.tasks.get(event.taskId); task.updatedAt = event.at; task.exchanges++;
      if (event.type === 'claimed') { task.status = 'running'; task.claimedAt = event.at; }
      if (event.type === 'result') { task.status = data.status; task.result = { summary: data.summary, details: data.details }; }
      if (event.type === 'cancelled') task.status = 'cancelled';
    }
  }
  authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !this.open || this.fault) return null;
    const value = Buffer.from(token);
    return AGENTS.find(agent => timingSafeEqual(value, Buffer.from(this.credentials[agent.id])))?.id ?? null;
  }
  credential(agent) { if (!knownAgent(agent) || !this.open || this.fault) fail('unavailable'); return this.credentials[agent]; }
  serialize(operation) {
    const result = this.queue.then(() => { if (!this.open || this.fault) fail('unavailable'); return operation(); });
    this.queue = result.catch(() => {}); return result;
  }
  async commit(type, actor, task, data) {
    if (this.events.length >= LIMITS.events) fail('storage-limit');
    const at = new Date(this.now()).toISOString();
    if (type === 'sent') data = { ...data, expiresAt: new Date(Date.parse(at) + data.ttlSeconds * 1000).toISOString() };
    const event = { version: 1, seq: this.events.length + 1, at, type, actor, ...(task ? { taskId: task } : {}), data };
    const line = JSON.stringify(event) + '\n', size = Buffer.byteLength(line);
    if (size + this.bytes > LIMITS.logBytes) fail('storage-limit');
    let log, readable, oldMarkdownSize, logTouched = false, readableTouched = false;
    try {
      privateStat(await fs.lstat(this.directory), true);
      log = await privateOpen(this.logPath, constants.O_RDWR);
      if ((await log.stat()).size !== this.bytes) fail('storage-changed');
      readable = await privateOpen(this.markdownPath, constants.O_RDWR); oldMarkdownSize = (await readable.stat()).size;
      if (oldMarkdownSize + Buffer.byteLength(markdown(event)) > LIMITS.logBytes * 2) fail('storage-limit');
      // Both files are synced before delivery. On failure roll back the unacknowledged record.
      logTouched = true; await writeAt(log, line, this.bytes); await log.sync();
      readableTouched = true; await writeAt(readable, markdown(event), oldMarkdownSize); await readable.sync();
    } catch (error) {
      let rollback = true;
      if (log && logTouched) { try { await log.truncate(this.bytes); await log.sync(); } catch { rollback = false; } }
      if (readable && readableTouched && oldMarkdownSize !== undefined) { try { await readable.truncate(oldMarkdownSize); await readable.sync(); } catch { rollback = false; } }
      if (!rollback) this.fault = true;
      if (error instanceof RelayError) throw error; fail('storage-unavailable');
    } finally { if (log) await log.close().catch(() => {}); if (readable) await readable.close().catch(() => {}); }
    this.apply(event); this.events.push(event); this.bytes += size;
    try { this.onChange(); } catch {} return event;
  }
  participant(actor, id, expire = true) {
    if (!knownAgent(actor)) fail('unauthorized'); taskId(id);
    const task = this.tasks.get(id);
    if (!task || (task.from !== actor && task.to !== actor)) fail('task-unavailable');
    return expire ? this.view(task) : task;
  }
  view(task) { const result = clone(task); if (result.status === 'queued' && Date.parse(result.expiresAt) <= this.now()) result.status = 'expired'; return result; }
  hasSecrets(value) {
    const serialized = JSON.stringify(value);
    return SECRET.test(serialized) || Object.values(this.credentials ?? {}).some(token => serialized.includes(token));
  }
  async rejectSecrets(actor, operation, value, id) {
    if (!this.hasSecrets(value)) return;
    await this.commit('blocked', actor, id, { operation, reason: 'sensitive-content' }); fail('sensitive-content');
  }
  send(actor, input) { return this.serialize(async () => {
    if (!knownAgent(actor)) fail('unauthorized');
    const normalized = this.normalizeSend(actor, input);
    await this.rejectSecrets(actor, 'send', normalized);
    const digest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const previous = this.keys.get(`${actor}:${normalized.idempotencyKey}`);
    if (previous) { if (previous.digest !== digest) fail('idempotency-conflict'); return { task: this.view(this.tasks.get(previous.taskId)), duplicate: true }; }
    if (this.tasks.size >= LIMITS.tasks) fail('storage-limit');
    const id = randomUUID(), expiresAt = new Date(this.now() + normalized.ttlSeconds * 1000).toISOString();
    await this.commit('sent', actor, id, { ...normalized, expiresAt, digest });
    return { task: this.view(this.tasks.get(id)), duplicate: false };
  }); }
  claim(actor, input) { return this.serialize(async () => {
    object(input, ['taskId', 'purpose']); const task = this.participant(actor, input.taskId);
    const purpose = text(input.purpose, 1000, 4);
    if (task.to !== actor) fail('recipient-required');
    if (task.status !== 'queued') fail(TERMINAL.has(task.status) ? 'task-closed' : 'task-already-claimed');
    if (task.exchanges >= LIMITS.exchanges - 1) fail('exchange-limit');
    await this.rejectSecrets(actor, 'claim', { purpose }, task.id);
    await this.commit('claimed', actor, task.id, { purpose }); return { task: this.view(this.tasks.get(task.id)) };
  }); }
  message(actor, input) { return this.serialize(async () => {
    object(input, ['taskId', 'kind', 'purpose', 'text']); const task = this.participant(actor, input.taskId);
    const data = { kind: input.kind, purpose: text(input.purpose, 1000, 4), text: text(input.text, 12000) };
    if (!['question', 'answer', 'progress'].includes(data.kind)) fail('invalid-input');
    if (task.status !== 'running') fail(TERMINAL.has(task.status) ? 'task-closed' : 'claim-required');
    if (task.exchanges >= LIMITS.exchanges - 1) fail('exchange-limit');
    await this.rejectSecrets(actor, 'message', data, task.id);
    await this.commit('message', actor, task.id, data); return { task: this.view(this.tasks.get(task.id)) };
  }); }
  result(actor, input) { return this.serialize(async () => {
    object(input, ['taskId', 'status', 'purpose', 'summary', 'details']); const task = this.participant(actor, input.taskId);
    const data = { status: input.status, purpose: text(input.purpose, 1000, 4), summary: text(input.summary, 2000), details: text(input.details, 16000) };
    if (!['completed', 'failed'].includes(data.status)) fail('invalid-input');
    if (task.to !== actor) fail('recipient-required');
    if (task.status !== 'running') fail(TERMINAL.has(task.status) ? 'task-closed' : 'claim-required');
    if (task.exchanges >= LIMITS.exchanges) fail('exchange-limit');
    await this.rejectSecrets(actor, 'result', data, task.id);
    await this.commit('result', actor, task.id, data); return { task: this.view(this.tasks.get(task.id)) };
  }); }
  cancel(actor, input) { return this.serialize(async () => {
    object(input, ['taskId', 'purpose']); const task = this.participant(actor, input.taskId);
    const data = { purpose: text(input.purpose, 1000, 4) };
    if (task.from !== actor) fail('sender-required');
    if (TERMINAL.has(task.status)) fail('task-closed');
    if (task.exchanges >= LIMITS.exchanges) fail('exchange-limit');
    await this.rejectSecrets(actor, 'cancel', data, task.id);
    await this.commit('cancelled', actor, task.id, data); return { task: this.view(this.tasks.get(task.id)) };
  }); }
  agents(actor) { if (!knownAgent(actor)) fail('unauthorized'); return { agents: AGENTS.map(agent => ({ ...agent, queuedTasks: [...this.tasks.values()].filter(task => task.to === agent.id && this.view(task).status === 'queued').length, runningTasks: [...this.tasks.values()].filter(task => task.to === agent.id && task.status === 'running').length })) }; }
  inbox(actor, input = {}) { object(input, ['limit']); if (!knownAgent(actor)) fail('unauthorized'); return { tasks: [...this.tasks.values()].filter(task => task.to === actor).map(task => this.view(task)).filter(task => ['queued', 'running'].includes(task.status)).slice(-limit(input.limit)).reverse() }; }
  get(actor, input) { object(input, ['taskId']); return { task: this.participant(actor, input.taskId) }; }
  transcript(actor, input) { object(input, ['taskId']); this.participant(actor, input.taskId); return { taskId: input.taskId, markdown: this.ownerReadTranscript(input.taskId) }; }
  async ownerCommand(actor, tool, input = {}) {
    const operations = { relay_list_agents: 'agents', relay_send_task: 'send', relay_inbox: 'inbox', relay_claim_task: 'claim', relay_message: 'message', relay_report_result: 'result', relay_get_task: 'get', relay_read_transcript: 'transcript', relay_cancel_task: 'cancel' };
    const operation = operations[tool]; if (!operation || !knownAgent(actor)) fail('invalid-input');
    if (!this.open || this.fault) fail('unavailable');
    if (operation === 'agents') { object(input, []); return { ok: true, ...this.agents(actor) }; }
    return { ok: true, ...await this[operation](actor, input) };
  }
  ownerListTasks(input = {}) {
    object(input, ['limit']); const maximum = input.limit ?? 100;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > LIMITS.tasks) fail('invalid-input');
    return [...this.tasks.values()].slice(-maximum).reverse().map(task => this.view(task));
  }
  ownerReadTranscript(id) { taskId(id); if (!this.tasks.has(id)) fail('task-unavailable'); return HEADER + this.events.filter(event => event.taskId === id).map(markdown).join(''); }
  getState() { return { agentCount: AGENTS.length, queuedTasks: [...this.tasks.values()].filter(task => this.view(task).status === 'queued').length, lastEventAt: this.events.at(-1)?.at ?? null, ...(this.fault ? { error: 'storage-unavailable' } : {}) }; }
  async close() { this.open = false; await this.queue; this.credentials = null; await this.releaseLock(); }
}

function sameSnapshot(before, after) {
  return before.ino === after.ino && before.dev === after.dev && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
async function readArchiveLog(directory) {
  let directoryBefore;
  try { directoryBefore = await fs.lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('storage-unavailable'); }
  privateStat(directoryBefore, true);
  const file = path.join(directory, 'events.jsonl'); let before;
  try { before = await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('storage-unavailable'); }
  privateStat(before); if (before.size > LIMITS.logBytes) fail('storage-limit');
  let handle, bytes;
  try {
    handle = await privateOpen(file, constants.O_RDONLY);
    const start = await handle.stat();
    if (!sameSnapshot(before, start)) fail('archive-changed');
    // Bound allocation and reads to the initial size; a concurrent growing writer
    // cannot make archive inspection allocate beyond the configured log limit.
    bytes = Buffer.alloc(start.size); let offset = 0;
    while (offset < bytes.length) {
      const chunk = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!chunk.bytesRead) fail('archive-changed'); offset += chunk.bytesRead;
    }
    const end = await handle.stat(); const after = await fs.lstat(file);
    const directoryAfter = await fs.lstat(directory);
    privateStat(end); privateStat(after); privateStat(directoryAfter, true);
    if (!sameSnapshot(start, end) || !sameSnapshot(start, after) || directoryBefore.ino !== directoryAfter.ino || directoryBefore.dev !== directoryAfter.dev) fail('archive-changed');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('corrupt-storage'); }
  } catch (error) { if (error instanceof RelayError) throw error; fail('storage-unavailable'); }
  finally { bytes?.fill(0); if (handle) await handle.close().catch(() => {}); }
}

// Offline human inspection deliberately does not call init(): no listener, writer
// lease, credentials, directory creation, Markdown rebuilding or log repair.
async function readRelayArchive({ directory, limit: maximum = 100, now = Date.now }) {
  const archive = new RelayStore({ directory, now });
  archive.ownerListTasks({ limit: maximum });
  const contents = await readArchiveLog(directory);
  if (contents !== null) {
    const complete = contents.slice(0, contents.lastIndexOf('\n') + 1);
    for (const line of complete.split('\n').filter(Boolean)) {
      let event;
      try { event = JSON.parse(line); archive.validateEvent(event); archive.apply(event); }
      catch { fail('corrupt-storage'); }
      archive.events.push(event);
      if (archive.events.length > LIMITS.events || archive.tasks.size > LIMITS.tasks) fail('storage-limit');
    }
  }
  return { tasks: archive.ownerListTasks({ limit: maximum }), readTranscript: id => archive.ownerReadTranscript(id) };
}

module.exports = { RelayStore, RelayError, AGENTS, LIMITS, SECRET, readRelayArchive };
