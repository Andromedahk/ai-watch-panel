'use strict';
const { randomUUID } = require('node:crypto');
const { ensure, digest } = require('./validation.cjs');
const REFRESH_MS = 60000;
const MIN_UPDATE_MS = 10000;
const LEASE_SECONDS = 90;
const MAX_TARGETS = 64;

function androidIdentity(device) {
  return JSON.stringify([device?.token, device?.transport || 'fcm', device?.liveActivity?.notificationId ?? null,
    device?.liveActivity?.locallyCreated === true]);
}

// Only counts and a fixed provider identifier may reach a system surface.
function attention(service) {
  const now = Math.floor(service.now() / 1000);
  const alerts = service.online() ? service.currentAlerts().filter(a => a.category === 'input' || a.category === 'approval') : [];
  const providers = [...new Set(alerts.map(a => a.provider))];
  const deadlines = alerts.map(a => service.data.snapshot?.requests.find(r => r.id === a.requestId)?.expiresAt).filter(Number.isFinite);
  return { contentState: { inputCount: alerts.filter(a => a.category === 'input').length,
    approvalCount: alerts.filter(a => a.category === 'approval').length,
    provider: providers.length === 1 ? providers[0] : providers.length ? 'multiple' : 'none',
    updatedAt: now, expiresAt: Math.max(now, Math.min(now + LEASE_SECONDS, ...deadlines.map(t => Math.floor(t / 1000)))) },
  fingerprint: digest(alerts.map(a => a.key).sort()), active: alerts.length > 0 };
}

class AttentionDelivery {
  constructor(service) { this.service = service; this.pushing = false; }
  get data() { return this.service.data; }
  get now() { return this.service.now(); }
  target(id) { return this.data.liveTargets.find(t => t.deviceId === id && !t.retired); }
  pruneRetired() {
    this.data.liveTargets = this.data.liveTargets.filter(t => !t.retired || (t.pending && t.retireUntil > this.now && t.pending.expiresAt > this.now));
  }
  requireCapacity() {
    this.pruneRetired();
    ensure(this.data.liveTargets.length < MAX_TARGETS, 'activity-capacity', 429);
  }
  timestamp(owner) {
    const installation = this.data.installations.find(d => d.id === owner);
    const previous = Math.max(installation?.attentionTimestamp || 0, ...this.data.liveTargets.filter(t => t.deviceId === owner)
      .map(t => Math.max(t.lastTimestamp || 0, t.pending?.timestamp || 0)));
    const next = Math.max(Math.floor(this.now / 1000), previous + 1);
    if (installation) installation.attentionTimestamp = next;
    return next;
  }
  needsEnd(target) {
    return !!(target.updateToken || target.lastActive || target.mayBeActive ||
      (target.pending?.phase !== 'end' && target.pending?.attempts > 0) ||
      (target.device?.liveActivity?.locallyCreated === true && !target.localEnded));
  }
  retire(target, info) {
    if (target.retired) return;
    target.retired = true; target.enabled = false; target.retireUntil = this.now + LEASE_SECONDS * 1000;
    delete target.startToken; delete target.startAttempted;
    if (this.needsEnd(target)) this.queue(target, 'end', info);
    else delete target.pending;
  }
  register(body, owner) {
    this.service.requireInstallation(owner);
    ensure(this.data.installations.find(d => d.id === owner).platform === 'ios', 'ios-required');
    ensure(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(k => ['type', 'token', 'environment', 'activityId'].includes(k)));
    ensure(['start', 'update'].includes(body.type) && /^[a-f0-9]{32,512}$/i.test(body.token) && ['sandbox', 'production'].includes(body.environment));
    ensure(body.type === 'update' ? typeof body.activityId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(body.activityId) : body.activityId === undefined);
    ensure(!this.data.liveTargets.some(t => t.deviceId !== owner && (t.startToken === body.token || t.updateToken === body.token)), 'activity-token-in-use', 409);
    let target = this.target(owner);
    if (!target) { this.requireCapacity(); target = { deviceId: owner, platform: 'ios' }; this.data.liveTargets.push(target); }
    if (!target.enabled) { delete target.dismissedCycle; delete target.dismissedFingerprint; }
    target.enabled = true; target.environment = body.environment;
    if (body.type === 'start') {
      if (target.startToken !== body.token) { target.startToken = body.token; delete target.startAttempted; }
    } else {
      if (target.updateToken !== body.token || target.activityId !== body.activityId) {
        target.updateToken = body.token; target.activityId = body.activityId; delete target.pending; delete target.lastFingerprint;
      }
      delete target.startAttempted;
    }
    this.reconcile(); this.service.changed(); return { ok: true };
  }
  disable(owner) {
    const target = this.target(owner); if (!target) return;
    target.enabled = false; delete target.startToken; delete target.startAttempted;
    delete target.dismissedCycle; delete target.dismissedFingerprint;
  }
  remove(body, owner) {
    this.service.requireInstallation(owner);
    ensure(this.data.installations.find(d => d.id === owner).platform === 'ios', 'ios-required');
    ensure(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(k => k === 'activityId'));
    if (body.activityId !== undefined) {
      ensure(typeof body.activityId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(body.activityId));
      const target = this.target(owner);
      if (target?.activityId === body.activityId) {
        target.dismissedCycle = true;
        delete target.dismissedFingerprint;
        delete target.updateToken; delete target.activityId; delete target.pending; delete target.startAttempted;
        target.lastActive = false; target.mayBeActive = false;
      }
    } else this.disable(owner);
    this.service.changed(); return { ok: true };
  }
  clear(owner) {
    // Pair rotation must not carry a live subscription into a new credential.
    this.data.liveTargets = this.data.liveTargets.filter(t => t.deviceId !== owner);
  }
  queue(target, phase, info, force = false) {
    const token = target.platform === 'ios' ? (phase === 'start' ? target.startToken : target.updateToken) : target.device?.token;
    if (!token) return;
    const previous = target.pending;
    // End is immutable, including its deadline and sequence. Changing snapshots
    // must not keep a retired instance alive or reset its retry budget.
    if (!force && previous?.phase === phase && previous.token === token &&
      (phase === 'end' || previous.fingerprint === info.fingerprint)) return;
    const contentState = phase === 'end' ? { ...info.contentState, inputCount: 0, approvalCount: 0, provider: 'none', expiresAt: Math.floor(this.now / 1000) } : info.contentState;
    target.pending = { id: randomUUID(), eventId: randomUUID(), category: 'attention', phase, contentState,
      timestamp: this.timestamp(target.deviceId),
      fingerprint: info.fingerprint, token, activityId: target.activityId, attempts: 0,
      nextAt: phase === 'end' ? this.now : Math.max(this.now, (target.lastSentAt || 0) + MIN_UPDATE_MS),
      expiresAt: Math.min(this.now + LEASE_SECONDS * 1000, target.retireUntil || Infinity) };
  }
  reconcile() {
    const before = JSON.stringify(this.data.liveTargets); const info = attention(this.service);
    this.pruneRetired();
    const snapshot = this.data.snapshot;
    // Losing connectivity is not evidence that the user-dismissed waiting cycle
    // has finished. Only a fresh, real snapshot may re-arm it.
    const cycleCleared = this.service.online() && snapshot && !snapshot.sample && !snapshot.stale && !info.active;
    for (const device of this.data.devices.filter(d => d.platform === 'android' && d.liveUpdates === true)) {
      let target = this.target(device.id);
      if (target?.device && androidIdentity(target.device) !== androidIdentity(device)) {
        if (this.needsEnd(target)) {
          // Reserve space first: a failed registration may not discard the only
          // copy of the old instance's token / notification ID.
          this.requireCapacity(); this.retire(target, info);
        } else this.data.liveTargets = this.data.liveTargets.filter(t => t !== target);
        target = undefined;
      }
      if (!target) { this.requireCapacity(); target = { deviceId: device.id, platform: 'android' }; this.data.liveTargets.push(target); }
      target.enabled = true; target.device = { ...device };
    }
    for (const target of this.data.liveTargets) {
      if (target.retired) continue;
      const ownerExists = this.data.installations.some(d => d.id === target.deviceId);
      if (!ownerExists || (target.platform === 'android' && !this.data.devices.some(d => d.id === target.deviceId && d.liveUpdates === true))) target.enabled = false;
      // Migrate the old fingerprint suppression conservatively to a full cycle.
      if (target.dismissedFingerprint) { target.dismissedCycle = true; delete target.dismissedFingerprint; }
      if (cycleCleared) { delete target.dismissedCycle; if (!target.updateToken) delete target.startAttempted; }
      if (!target.enabled) { this.retire(target, info); continue; }
      if (target.pending && target.pending.expiresAt <= this.now) delete target.pending;
      if (!info.active) {
        if (this.needsEnd(target)) this.queue(target, 'end', info);
        else delete target.pending;
        continue;
      }
      if (target.dismissedCycle) {
        if (target.updateToken) this.queue(target, 'end', info);
        else delete target.pending;
        continue;
      }
      // Once an end has left the server, don't overwrite it with an update to
      // the same activity. Its completion retires that activity token first.
      if (target.pending?.phase === 'end' && target.pending.attempts > 0) continue;
      const phase = target.platform === 'ios' && !target.updateToken ? 'start' : 'update';
      // A lost start response is ambiguous; wait for the app's update token instead
      // of repeatedly creating new activities within the pending cycle.
      if (phase === 'start' && target.startAttempted) continue;
      if (target.pending?.fingerprint !== info.fingerprint && target.lastFingerprint === info.fingerprint && this.now - (target.lastSentAt || 0) < REFRESH_MS) delete target.pending;
      if (target.lastFingerprint !== info.fingerprint || this.now - (target.lastSentAt || 0) >= REFRESH_MS) this.queue(target, phase, info);
    }
    this.data.liveTargets = this.data.liveTargets.filter(t => t.enabled || t.pending);
    this.pruneRetired();
    return before !== JSON.stringify(this.data.liveTargets);
  }
  async process() {
    if (this.pushing) return; this.pushing = true;
    try {
      if (this.reconcile()) this.service.store.save();
      for (const target of [...this.data.liveTargets].sort((a, b) => Number(!!b.retired) - Number(!!a.retired))) {
        const item = target.pending;
        if (!item || item.nextAt > this.now || item.expiresAt <= this.now) continue;
        if (this.reconcile()) this.service.store.save();
        if (target.pending !== item || !this.data.liveTargets.includes(target)) continue;
        item.attempts++; item.nextAt = this.now + Math.min(60000, 10000 * 2 ** (item.attempts - 1));
        target.lastTimestamp = item.timestamp;
        // Persist before starting the request: cancellation during the await
        // must assume this first delivery may already have reached the device.
        if (item.phase !== 'end') { target.mayBeActive = true; target.localEnded = false; }
        if (item.phase === 'start') target.startAttempted = item.fingerprint;
        this.service.store.save();
        const device = target.platform === 'ios' ? { id: target.deviceId, platform: 'ios', transport: 'apns', environment: target.environment, token: item.token, activityId: item.activityId } : { ...target.device, token: item.token };
        let result; try { result = await this.service.push(device, { ...item, scope: target.deviceId }); } catch { result = { retry: true, error: 'push-transport-failed' }; }
        // A registration, opt-out or newer snapshot may replace this work in flight.
        if (!this.data.liveTargets.includes(target) || target.pending !== item) continue;
        if (result?.ok) {
          target.lastSentAt = this.now; target.lastFingerprint = item.fingerprint; target.lastActive = item.phase !== 'end'; delete target.pending;
          if (item.phase === 'end') { delete target.updateToken; delete target.activityId; delete target.startAttempted; target.mayBeActive = false; target.localEnded = true; }
        } else if (result?.invalid || result?.retry === false || item.attempts >= 5 || item.phase === 'start') {
          delete target.pending;
          if (item.phase === 'start' && result?.error === 'apns-not-configured') delete target.startAttempted;
          if (item.phase === 'end') { delete target.updateToken; delete target.activityId; target.lastActive = false; target.mayBeActive = false; target.localEnded = true; }
          if (result?.invalid && target.platform === 'ios') { if (item.phase === 'start') delete target.startToken; else { delete target.updateToken; delete target.activityId; } }
          // Permanent configuration/eligibility failures should not spin every tick.
          target.lastSentAt = this.now; target.lastFingerprint = item.fingerprint;
        }
        this.pruneRetired(); this.service.store.save();
      }
    } finally { this.pushing = false; }
  }
}
module.exports = { attention, AttentionDelivery, MIN_UPDATE_MS, LEASE_SECONDS, MAX_TARGETS };
