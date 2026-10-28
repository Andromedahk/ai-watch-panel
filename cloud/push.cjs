'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http2 = require('node:http2');
const { createOemPush } = require('./oem-push.cjs');
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
function jwt(header, claims, key, algorithm) {
  const unsigned = `${b64(header)}.${b64(claims)}`;
  const signature = crypto.sign(algorithm, Buffer.from(unsigned), { key, ...(header.alg === 'ES256' ? { dsaEncoding: 'ieee-p1363' } : {}) });
  return `${unsigned}.${signature.toString('base64url')}`;
}
function notification(event) {
  return { titleKey: ({ input: 'ai_watch_input_title', approval: 'ai_watch_approval_title', 'low-quota': 'ai_watch_low_quota_title' })[event.category] || 'ai_watch_status_title',
    bodyKey: 'ai_watch_notice_body' };
}
async function jsonRequest(url, options, fetchImpl) {
  const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  if (text.length > 65536) throw new Error('push-response-too-large');
  let data; try { data = JSON.parse(text); } catch { data = {}; }
  return { status: response.status, data };
}
class FcmPush {
  constructor({ credentials, fetchImpl = fetch, now = Date.now } = {}) { this.credentials = credentials; this.fetch = fetchImpl; this.now = now; this.access = null; }
  async accessToken() {
    if (this.access && this.access.until > this.now() + 60000) return this.access.token;
    const c = this.credentials; if (!c?.client_email || !c.private_key || !/^[a-z0-9-]{3,100}$/.test(c.project_id)) throw new Error('fcm-not-configured');
    const now = Math.floor(this.now() / 1000);
    const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, { iss: c.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }, c.private_key, 'RSA-SHA256');
    const response = await jsonRequest('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() }, this.fetch);
    if (response.status !== 200 || typeof response.data.access_token !== 'string') throw new Error('fcm-auth-failed');
    this.access = { token: response.data.access_token, until: this.now() + Math.min(3600, Number(response.data.expires_in) || 3600) * 1000 };
    return this.access.token;
  }
  async send(device, event) {
    if (!this.credentials) return { retry: true, error: 'fcm-not-configured' };
    try {
      const token = await this.accessToken();
      const live = event.category === 'attention';
      const data = live ? { eventId: event.eventId, category: 'attention', phase: event.phase, contentState: JSON.stringify(event.contentState) }
        : { eventId: event.eventId, category: event.category, provider: event.provider, ...(event.requestId ? { requestId: event.requestId } : {}) };
      const response = await jsonRequest(`https://fcm.googleapis.com/v1/projects/${this.credentials.project_id}/messages:send`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token: device.token, data,
          android: live ? { priority: 'high', ttl: '90s', collapse_key: 'aiwatch-attention' }
            : { priority: 'high', ttl: '900s', notification: { channel_id: 'ai_watch_alerts', tag: event.eventId, title_loc_key: notification(event).titleKey, body_loc_key: notification(event).bodyKey } } } }),
      }, this.fetch);
      if (response.status === 200) return { ok: true };
      const codes = (response.data.error?.details || []).map(d => d.errorCode);
      if (codes.includes('UNREGISTERED')) return { invalid: true, error: 'fcm-unregistered' };
      if (response.status === 401) this.access = null;
      return { retry: response.status === 401 || response.status === 429 || response.status >= 500, error: `fcm-http-${response.status}` };
    } catch { return { retry: true, error: 'fcm-transport-failed' }; }
  }
}
function apnsRequest(origin, headers, body, connect = http2.connect) {
  return new Promise((resolve, reject) => {
    const client = connect(origin); let settled = false; let request;
    const finish = (err, result) => { if (settled) return; settled = true; clearTimeout(timeout); request?.close(); client.close(); if (err) { client.destroy(); reject(err); } else resolve(result); };
    const timeout = setTimeout(() => finish(new Error('apns-timeout')), 10000);
    client.on('error', e => finish(e));
    client.on('connect', () => {
      request = client.request(headers); let status = 0; let response = '';
      request.on('response', h => { status = Number(h[':status']); });
      request.on('data', chunk => { response += chunk.toString(); if (response.length > 65536) finish(new Error('apns-response-too-large')); });
      request.on('error', e => finish(e));
      request.on('end', () => { let data; try { data = JSON.parse(response); } catch { data = {}; } finish(null, { status, data }); });
      request.end(body);
    });
  });
}
class ApnsPush {
  constructor({ key, keyId, teamId, topic, request = apnsRequest, now = Date.now } = {}) { Object.assign(this, { key, keyId, teamId, topic, request, now }); this.access = null; }
  token() {
    if (this.access && this.access.until > this.now()) return this.access.token;
    const now = Math.floor(this.now() / 1000);
    const token = jwt({ alg: 'ES256', kid: this.keyId }, { iss: this.teamId, iat: now }, this.key, 'sha256');
    this.access = { token, until: this.now() + 45 * 60000 }; return token;
  }
  async send(device, event) {
    if (!this.key || !this.keyId || !this.teamId || !this.topic) return { retry: true, error: 'apns-not-configured' };
    try {
      const live = event.category === 'attention';
      const liveAps = live ? { timestamp: event.timestamp || Math.floor(this.now() / 1000), event: event.phase,
        'content-state': event.contentState, 'stale-date': event.contentState.expiresAt,
        ...(event.phase === 'start' ? { 'attributes-type': 'AIWatchAttentionAttributes', attributes: { scope: event.scope },
          alert: { 'title-loc-key': event.contentState.approvalCount ? 'ai_watch_approval_title' : 'ai_watch_input_title', 'loc-key': 'ai_watch_notice_body' } } : {}),
        ...(event.phase === 'end' ? { 'dismissal-date': Math.floor(this.now() / 1000) } : {}) } : null;
      const response = await this.request(device.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com', {
        ':method': 'POST', ':path': `/3/device/${device.token}`, authorization: `bearer ${this.token()}`, 'apns-topic': this.topic,
        ...(live ? { 'apns-topic': `${this.topic}.push-type.liveactivity` } : {}),
        'apns-push-type': live ? 'liveactivity' : 'alert', 'apns-priority': live && event.phase === 'update' ? '5' : '10',
        'apns-expiration': String(Math.floor(event.expiresAt / 1000)), 'apns-collapse-id': live ? `attention-${event.scope}` : event.eventId,
      }, JSON.stringify(live ? { aps: liveAps } : { aps: { alert: { 'title-loc-key': notification(event).titleKey, 'loc-key': notification(event).bodyKey }, sound: 'default' }, eventId: event.eventId, category: event.category,
        provider: event.provider, ...(event.requestId ? { requestId: event.requestId } : {}) }));
      if (response.status === 200) return { ok: true };
      if (response.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(response.data.reason)) return { invalid: true, error: 'apns-invalid-token' };
      if (response.data.reason === 'ExpiredProviderToken') this.access = null;
      return { retry: response.status === 429 || response.status >= 500 || response.data.reason === 'ExpiredProviderToken', error: `apns-http-${response.status}` };
    } catch { return { retry: true, error: 'apns-transport-failed' }; }
  }
}
function createPush(env = process.env) {
  const credentials = env.GOOGLE_APPLICATION_CREDENTIALS ? JSON.parse(fs.readFileSync(path.resolve(__dirname, env.GOOGLE_APPLICATION_CREDENTIALS), 'utf8')) : undefined;
  const fcm = new FcmPush({ credentials });
  const apns = new ApnsPush({ key: env.APNS_KEY_FILE ? fs.readFileSync(path.resolve(__dirname, env.APNS_KEY_FILE), 'utf8') : undefined,
    keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC });
  const oem = createOemPush(env);
  return (device, event) => device.platform === 'ios' ? apns.send(device, event)
    : device.transport && device.transport !== 'fcm' ? oem(device, event) : fcm.send(device, event);
}
module.exports = { jwt, notification, FcmPush, ApnsPush, createPush, apnsRequest };
