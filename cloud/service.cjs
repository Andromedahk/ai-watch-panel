'use strict';
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { Store } = require('./store.cjs');
const { attention, AttentionDelivery } = require('./attention.cjs');
const { digest, commandDigest, ensure, validateSync, validateCommand, validateDevice, validatePair, UUID } = require('./validation.cjs');
const PENDING = new Set(['queued', 'delivered']);
const REQUEST_TTL = 10 * 60000;
const AUDIT_TTL = 86400000;
const tokenHash = value => createHash('sha256').update(value).digest('hex');
class CloudService {
  constructor({ file, now = Date.now, push = async () => ({ retry: true, error: 'push-not-configured' }), threshold = 20,
    onChange = () => {}, onRevoke = () => {} } = {}) {
    this.store = new Store(file); this.now = now; this.push = push; this.threshold = threshold;
    this.onChange = onChange; this.onRevoke = onRevoke; this.pushing = false; this.wasOnline = this.online();
    this.live = new AttentionDelivery(this);
    for (const name of ['sync', 'command', 'register', 'unregister', 'tick', 'pair', 'revoke', 'resetDesktop', 'prune', 'registerActivity', 'removeActivity']) {
      const operation = this[name].bind(this);
      this[name] = (...args) => {
        const before = structuredClone(this.store.data); const wasOnline = this.wasOnline;
        try { return operation(...args); } catch (error) { this.store.data = before; this.wasOnline = wasOnline; throw error; }
      };
    }
    // Expired payloads must not survive a server restart until the first new upload.
    if (this.expire()) this.store.save();
  }
  get data() { return this.store.data; }
  online() { return this.data.receivedAt !== null && this.now() - this.data.receivedAt <= 20000 && this.now() >= this.data.receivedAt; }
  state() {
    return { online: this.online(), receivedAt: this.data.receivedAt, deviceId: this.data.deviceId, snapshot: this.data.snapshot, attention: attention(this).contentState,
      alerts: this.data.inbox.slice(-50).map(({ key, ...alert }) => alert),
      commands: this.data.commands.slice(-128).map(({ id, requestId, actorDeviceId, kind, status, error, expiresAt, createdAt, completedAt }) => ({ id, requestId, actorDeviceId, kind, createdAt,
        ...(completedAt ? { completedAt } : {}), status: PENDING.has(status) && expiresAt <= this.now() ? 'expired' : status,
        ...(PENDING.has(status) && expiresAt <= this.now() ? { error: 'command-expired' } : error ? { error } : {}) })) };
  }
  changed() { this.refreshInbox(); this.live.reconcile(); this.store.save(); try { this.onChange(this.state()); } catch { /* Listener failure must not undo a durable write. */ } }
  registerActivity(body, owner) { return this.live.register(body, owner); }
  removeActivity(body, owner) { return this.live.remove(body, owner); }
  closeRequest(id) {
    const tracked = this.data.requestsSeen.find(r => r.id === id);
    if (tracked && !tracked.closedAt) tracked.closedAt = this.now();
    // Remove the complete request, including any explicitly shared full context.
    // requestsSeen retains only IDs and timestamps, never a copy of that content.
    if (this.data.snapshot) this.data.snapshot.requests = this.data.snapshot.requests.filter(r => r.id !== id);
    this.data.outbox = this.data.outbox.filter(o => o.requestId !== id);
  }
  finish(command, status, error) {
    command.status = status; command.completedAt = this.now();
    if (error) command.error = error; else delete command.error;
    this.clearAnswer(command); this.closeRequest(command.requestId);
  }
  expire() {
    let changed = false; const now = this.now();
    for (const c of this.data.commands) if (PENDING.has(c.status) && c.expiresAt <= now) { this.finish(c, 'expired', 'command-expired'); changed = true; }
    for (const r of [...(this.data.snapshot?.requests || [])]) if (r.expiresAt <= now) { this.closeRequest(r.id); changed = true; }
    const commands = this.data.commands.filter(c => PENDING.has(c.status) || now - c.createdAt < AUDIT_TTL).slice(-1000);
    if (commands.length !== this.data.commands.length) { this.data.commands = commands; changed = true; }
    const tracked = this.data.requestsSeen.filter(r => now - r.lastSeenAt < AUDIT_TTL).slice(-4096);
    if (tracked.length !== this.data.requestsSeen.length) { this.data.requestsSeen = tracked; changed = true; }
    return this.refreshInbox() || changed;
  }
  refreshInbox() {
    const active = new Set(this.currentAlerts().map(a => a.key)); let changed = false;
    const kept = this.data.inbox.filter(a => this.now() - a.createdAt < AUDIT_TTL).slice(-200);
    if (kept.length !== this.data.inbox.length) { this.data.inbox = kept; changed = true; }
    for (const alert of this.data.inbox) {
      const next = this.online() && active.has(alert.key);
      if (alert.active !== next) { alert.active = next; changed = true; }
    }
    return changed;
  }
  prune() { if (this.expire()) this.changed(); }
  tick() {
    const changed = this.expire(); const online = this.online();
    if (changed || this.wasOnline !== online) { this.wasOnline = online; this.changed(); }
    void this.processPush().catch(() => {});
    void this.live.process().catch(() => {});
  }
  // Store the uploaded hash separately. Filtering retained payloads must not break valid hash-only heartbeats.
  publicSnapshot(snapshot) {
    const now = this.now(); const copy = structuredClone(snapshot); const requests = [];
    for (const request of copy.requests) {
      let tracked = this.data.requestsSeen.find(r => r.id === request.id);
      if (!tracked) {
        if (this.data.requestsSeen.length >= 4096) { copy.limited = true; continue; }
        tracked = { id: request.id, firstSeenAt: now, lastSeenAt: now }; this.data.requestsSeen.push(tracked);
      }
      tracked.lastSeenAt = now;
      if (tracked.closedAt || this.data.commands.some(c => c.requestId === request.id && !PENDING.has(c.status))) continue;
      const expiresAt = Math.min(request.expiresAt, tracked.firstSeenAt + REQUEST_TTL);
      if (expiresAt <= now) { tracked.closedAt = now; continue; }
      requests.push({ ...request, expiresAt });
    }
    copy.requests = copy.sample || copy.stale ? [] : requests;
    return copy;
  }
  sync(body) {
    validateSync(body); const now = this.now(); const data = this.data;
    ensure(Math.abs(body.t - now) <= 300000, 'clock-skew', 409);
    ensure(!data.deviceId || data.deviceId === body.d, 'desktop-already-bound', 409);
    const newSession = data.session !== body.s;
    if (newSession) ensure(!data.retiredSessions.includes(body.s), 'retired-session', 409);
    else ensure(body.n >= data.seq, 'stale-sequence', 409);
    const packetHash = digest(body);
    if (!newSession && body.n === data.seq) {
      ensure(packetHash === data.packetHash, 'sequence-conflict', 409);
      const commands = this.deliver(); this.changed(); return { ok: true, needSnapshot: false, commands };
    }
    if (!body.snapshot && (newSession || body.h !== data.hash || !data.snapshot)) return { ok: true, needSnapshot: true, commands: [] };
    if (newSession) {
      if (data.session) data.retiredSessions.push(data.session);
      data.retiredSessions = data.retiredSessions.slice(-256);
      for (const c of data.commands) if (PENDING.has(c.status)) this.finish(c, 'failed', 'desktop-session-changed');
      data.session = body.s;
    }
    data.deviceId = body.d; data.seq = body.n; data.packetHash = packetHash; data.receivedAt = now;
    this.expire();
    for (const result of body.results || []) {
      const command = data.commands.find(c => c.id === result.id);
      if (!command || command.session !== body.s || command.status !== 'delivered') continue;
      this.finish(command, result.status, result.status === 'failed' ? result.error || 'action-failed' : undefined);
    }
    if (body.snapshot) {
      // Replace, never merge: a metadata-only upload immediately clears full
      // context from the previous opt-in snapshot and the durable state file.
      data.snapshot = this.publicSnapshot(body.snapshot); data.hash = body.h;
      const pending = new Set(data.snapshot.requests.map(r => r.id));
      for (const c of data.commands) if (c.status === 'queued' && !pending.has(c.requestId)) {
        this.finish(c, 'failed', body.snapshot.stale ? 'snapshot-stale' : body.snapshot.sample ? 'sample-actions-disabled' : 'request-no-longer-pending');
      }
      this.detectAlerts(data.snapshot);
    }
    const commands = this.deliver(); this.wasOnline = true; this.changed();
    return { ok: true, needSnapshot: false, commands };
  }
  clearAnswer(command) { delete command.answer; delete command.answers; delete command.choice; }
  deliver() {
    this.expire(); const commands = []; let bytes = 0;
    for (const c of this.data.commands) if (PENDING.has(c.status) && !c.revoked) {
      if (commands.length >= 32) break;
      const { id, requestId, kind, answer, answers, choice, expiresAt } = c;
      const command = { id, requestId, kind, ...(answer !== undefined ? { answer } : {}), ...(answers !== undefined ? { answers } : {}), ...(choice !== undefined ? { choice } : {}), expiresAt };
      const size = Buffer.byteLength(JSON.stringify(command));
      if (bytes + size > 240 * 1024) break;
      bytes += size; c.status = 'delivered'; commands.push(command);
    }
    return commands;
  }
  command(body, actorDeviceId) {
    validateCommand(body); this.requireInstallation(actorDeviceId); const fingerprint = commandDigest(body);
    if (this.expire()) this.store.save();
    const existing = this.data.commands.find(c => c.id === body.id);
    if (existing) {
      ensure(existing.actorDeviceId === actorDeviceId, 'command-owner-conflict', 409);
      ensure(existing.fingerprint === fingerprint, 'command-id-conflict', 409);
      return { id: existing.id, status: existing.status, actorDeviceId };
    }
    ensure(this.online(), 'desktop-offline', 409);
    ensure(!this.data.snapshot?.sample, 'sample-actions-disabled', 409);
    ensure(!this.data.snapshot?.stale, 'snapshot-stale', 409);
    const request = this.data.snapshot?.requests.find(r => r.id === body.requestId);
    ensure(request && request.expiresAt > this.now(), 'request-expired', 409);
    ensure(request.kind === 'input' ? body.kind === 'answer' : ['approve', 'deny'].includes(body.kind), 'wrong-command-kind');
    if (body.choice !== undefined) ensure(request.choices?.some(c => c.id === body.choice), 'invalid-choice');
    if (body.answers !== undefined) {
      ensure(Array.isArray(request.questions), 'unexpected-answers');
      const allowed = new Set(request.questions.map(q => q.id));
      ensure(Object.keys(body.answers).every(id => allowed.has(id)), 'unknown-question');
      ensure(request.questions.every(q => Object.hasOwn(body.answers, q.id)), 'missing-answer');
    }
    ensure(!this.data.commands.some(c => c.requestId === body.requestId), 'request-already-submitted', 409);
    ensure(this.data.commands.filter(c => PENDING.has(c.status)).length < 64 && this.data.commands.length < 1000, 'command-capacity', 429);
    const command = { ...body, actorDeviceId, fingerprint, status: 'queued', session: this.data.session, createdAt: this.now(), expiresAt: Math.min(request.expiresAt, this.now() + 120000) };
    this.data.commands.push(command); this.changed(); return { id: command.id, status: command.status, actorDeviceId };
  }
  requireInstallation(id) { ensure(UUID.test(id) && this.data.installations.some(d => d.id === id), 'installation-revoked', 401); }
  authenticate(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 512) return null;
    const hash = Buffer.from(tokenHash(token), 'hex');
    return this.data.installations.find(d => /^[a-f0-9]{64}$/.test(d.tokenHash) && timingSafeEqual(hash, Buffer.from(d.tokenHash, 'hex')))?.id || null;
  }
  pair(body) {
    validatePair(body); const existing = this.data.installations.find(d => d.id === body.id);
    ensure(existing || this.data.installations.length < 32, 'installation-capacity', 429);
    const token = randomBytes(32).toString('base64url');
    this.data.installations = this.data.installations.filter(d => d.id !== body.id);
    this.data.installations.push({ id: body.id, name: body.name, platform: body.platform, createdAt: existing?.createdAt || this.now(), tokenHash: tokenHash(token) });
    // Rotation also removes old push bindings; the freshly paired app registers again.
    this.data.devices = this.data.devices.filter(d => d.id !== body.id); this.data.outbox = this.data.outbox.filter(o => o.deviceId !== body.id);
    this.live.clear(body.id);
    this.changed(); if (existing) { try { this.onRevoke(body.id); } catch {} }
    return { token, deviceId: body.id };
  }
  installations() {
    return { devices: this.data.installations.map(({ id, name, platform, createdAt }) => ({ id, name, platform, createdAt,
      pushRegistered: this.data.devices.some(d => d.id === id) })) };
  }
  revoke(id) {
    ensure(UUID.test(id), 'invalid-device');
    this.live.disable(id);
    this.data.installations = this.data.installations.filter(d => d.id !== id);
    this.data.devices = this.data.devices.filter(d => d.id !== id); this.data.outbox = this.data.outbox.filter(o => o.deviceId !== id);
    for (const c of this.data.commands) if (c.actorDeviceId === id && PENDING.has(c.status)) {
      if (c.status === 'queued') this.finish(c, 'failed', 'device-revoked');
      else { c.revoked = true; this.clearAnswer(c); }
    }
    this.changed(); try { this.onRevoke(id); } catch {} return { ok: true };
  }
  resetDesktop() {
    const data = this.data; data.resetGeneration = (data.resetGeneration || 0) + 1;
    for (const c of data.commands) if (PENDING.has(c.status)) this.finish(c, 'failed', 'desktop-reset');
    if (data.session) data.retiredSessions.push(data.session);
    data.retiredSessions = data.retiredSessions.slice(-256);
    data.deviceId = null; data.session = null; data.seq = 0; data.packetHash = null; data.hash = null; data.receivedAt = null;
    data.snapshot = null; data.requestsSeen = []; data.outbox = []; data.alerts = { waiting: [], low: [] }; this.wasOnline = false;
    this.changed(); return { ok: true };
  }
  register(body, actorDeviceId) {
    validateDevice(body); this.requireInstallation(actorDeviceId);
    ensure(body.transport !== 'opush', 'opush-transport-not-integrated', 501);
    ensure(body.id === actorDeviceId && body.platform === this.data.installations.find(d => d.id === actorDeviceId).platform, 'device-scope-mismatch', 403);
    const existing = this.data.devices.find(d => d.id === body.id);
    ensure(existing || this.data.devices.length < 32, 'device-capacity', 429);
    const removedIds = new Set(this.data.devices.filter(d => d.id === body.id || d.token === body.token).map(d => d.id));
    this.data.devices = this.data.devices.filter(d => !removedIds.has(d.id));
    this.data.devices.push({ ...body, environment: body.environment || 'production', registeredAt: this.now() });
    this.data.outbox = this.data.outbox.filter(o => o.deviceId === body.id || !removedIds.has(o.deviceId));
    if (!existing && this.online()) for (const alert of this.currentAlerts()) this.enqueue(alert, [body.id], false);
    this.changed(); return { ok: true };
  }
  unregister(id, actorDeviceId) {
    this.requireInstallation(actorDeviceId); ensure(id === actorDeviceId, 'device-scope-mismatch', 403);
    this.data.devices = this.data.devices.filter(d => d.id !== id); this.data.outbox = this.data.outbox.filter(o => o.deviceId !== id);
    this.changed(); return { ok: true };
  }
  currentAlerts() {
    const snapshot = this.data.snapshot; if (!snapshot || snapshot.sample || snapshot.stale) return [];
    const alerts = [];
    for (const r of snapshot.requests) if (r.expiresAt > this.now()) alerts.push({ key: `request:${r.id}`, category: r.kind, provider: r.provider, requestId: r.id });
    for (const p of snapshot.p) {
      if (p.c !== 'ready') continue;
      for (const kind of p.w === 'both' ? ['input', 'approval'] : p.w ? [p.w] : []) {
        if (!alerts.some(a => a.provider === p.i && a.category === kind)) alerts.push({ key: `waiting:${p.i}:${kind}`, category: kind, provider: p.i });
      }
      p.q.forEach((q, index) => { if (q.r !== null && !q.s && q.r <= this.threshold) alerts.push({ key: `quota:${p.i}:${q.m}:${q.p}:${index}`, category: 'low-quota', provider: p.i }); });
    }
    return alerts;
  }
  detectAlerts(snapshot) {
    if (snapshot.sample || snapshot.stale) return;
    const current = this.currentAlerts(); const waiting = new Set(this.data.alerts.waiting); const low = new Set(this.data.alerts.low);
    for (const alert of current) if (!(alert.category === 'low-quota' ? low : waiting).has(alert.key)) this.enqueue(alert);
    this.data.alerts.waiting = [...new Set(current.filter(a => a.category !== 'low-quota').flatMap(a => [a.key, `waiting:${a.provider}:${a.category}`]))];
    const nextLow = new Set(current.filter(a => a.category === 'low-quota').map(a => a.key));
    for (const p of snapshot.p) p.q.forEach((q, index) => {
      const key = `quota:${p.i}:${q.m}:${q.p}:${index}`;
      if (low.has(key) && (p.c !== 'ready' || q.s || q.r === null || q.r <= this.threshold + 5)) nextLow.add(key);
    });
    this.data.alerts.low = [...nextLow];
  }
  enqueue(alert, deviceIds = this.data.devices.map(d => d.id), record = true) {
    const now = this.now();
    const eventId = record ? randomUUID() : this.data.inbox.findLast(a => a.key === alert.key)?.id || randomUUID();
    if (record) {
      this.data.inbox.push({ id: eventId, key: alert.key, type: alert.category, provider: alert.provider, ...(alert.requestId ? { requestId: alert.requestId } : {}), createdAt: now, active: true });
      this.data.inbox = this.data.inbox.slice(-200);
    }
    for (const deviceId of deviceIds) this.data.outbox.push({ id: randomUUID(), eventId, deviceId, ...alert, attempts: 0, nextAt: now, expiresAt: now + 900000 });
    this.data.outbox = this.data.outbox.slice(-2048);
  }
  async processPush() {
    if (this.pushing) return; this.pushing = true;
    try {
      let touched = false; const now = this.now();
      const active = new Set(this.currentAlerts().map(a => a.key));
      const keep = this.data.outbox.filter(o => o.expiresAt > now && o.attempts < 6 && active.has(o.key) && this.data.devices.some(d => d.id === o.deviceId));
      if (keep.length !== this.data.outbox.length) { this.data.outbox = keep; touched = true; }
      for (const item of (this.online() ? this.data.outbox.filter(o => o.nextAt <= now).slice(0, 8) : [])) {
        if (!this.online() || !this.data.outbox.some(o => o.id === item.id) || !this.currentAlerts().some(a => a.key === item.key)) continue;
        const device = this.data.devices.find(d => d.id === item.deviceId); if (!device) continue;
        item.attempts++; item.nextAt = this.now() + Math.min(300000, 10000 * 2 ** (item.attempts - 1)); this.store.save();
        let result; try { result = await this.push(device, item); } catch { result = { retry: true, error: 'push-transport-failed' }; }
        const latest = this.data.devices.find(d => d.id === device.id);
        if (latest && latest.token !== device.token) { item.attempts = 0; item.nextAt = this.now(); touched = true; continue; }
        if (result?.invalid) this.data.devices = this.data.devices.filter(d => d.id !== device.id || d.token !== device.token);
        if (result?.ok || result?.invalid || result?.retry === false) this.data.outbox = this.data.outbox.filter(o => o.id !== item.id);
        else item.lastError = /^[a-z0-9-]{1,100}$/.test(result?.error || '') ? result.error : 'push-failed';
        touched = true;
      }
      if (touched) this.store.save();
    } finally { this.pushing = false; }
  }
}
module.exports = { CloudService, REQUEST_TTL, tokenHash };
