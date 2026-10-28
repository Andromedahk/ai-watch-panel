'use strict';
const crypto = require('node:crypto');

// These URLs and wire formats come from the vendors' public documentation.
// Configuration names are local; a configured scene is not proof of approval.
const MI_URL = 'https://api.xmpush.xiaomi.com/v3/message/regid';
const VIVO_ORIGIN = 'https://api-push.vivo.com.cn';
const ID = /^[A-Za-z0-9_.-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_:+/=.-]{10,4096}$/;
const PROVIDERS = new Set([...require('./validation.cjs').PROVIDERS, 'none', 'multiple']);
const fail = error => ({ retry: false, error });
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const notificationId = value => Math.max(1, parseInt(hash(value).slice(0, 8), 16) & 0x7fffffff);
const validId = value => typeof value === 'string' && ID.test(value);
const isAttention = event => event?.category === 'attention';

function safeState(event, now) {
  const s = event?.contentState;
  if (!['update', 'end'].includes(event?.phase) || !s ||
      ![s.inputCount, s.approvalCount].every(n => Number.isInteger(n) && n >= 0 && n <= 64) ||
      !PROVIDERS.has(s.provider) || !Number.isSafeInteger(s.updatedAt) || !Number.isSafeInteger(s.expiresAt) ||
      s.updatedAt < 1 || s.updatedAt > Math.floor(now / 1000) + 60 ||
      (event.phase !== 'end' && (s.expiresAt <= Math.floor(now / 1000) || s.expiresAt - s.updatedAt > 120))) return null;
  return event.phase === 'end' ? { ...s, inputCount: 0, approvalCount: 0, provider: 'none' } : s;
}
function words(event, locale, state) {
  const zh = locale === 'zh';
  if (state) {
    const total = state.inputCount + state.approvalCount;
    return { title: total ? (zh ? 'AI 等待处理' : 'AI needs attention') : (zh ? '等待已结束' : 'Waiting ended'),
      body: zh ? `待回答 ${state.inputCount} · 待授权 ${state.approvalCount}` : `${state.inputCount} replies · ${state.approvalCount} approvals`,
      compact: zh ? '待处理' : 'Pending', inputCount: String(state.inputCount), approvalCount: String(state.approvalCount), pendingCount: String(total) };
  }
  const title = zh ? { input: 'AI 等待回答', approval: 'AI 等待授权', 'low-quota': 'AI 额度偏低' } :
    { input: 'AI waiting for a reply', approval: 'AI waiting for approval', 'low-quota': 'AI quota is low' };
  return { title: title[event?.category], body: zh ? '打开 AI Watch 查看最新状态。' : 'Open AI Watch for the latest status.', inputCount: '0', approvalCount: '0', pendingCount: '0' };
}
function metadata(event) {
  const result = { eventId: validId(event.eventId) ? event.eventId : hash(JSON.stringify([event.category, event.createdAt])).slice(0, 32), category: event.category };
  if (PROVIDERS.has(event.provider)) result.provider = event.provider;
  if (validId(event.requestId)) result.requestId = event.requestId;
  return result;
}
async function request(url, body, headers, fetchImpl) {
  const response = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10000) });
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 65536) throw new Error('response-too-large');
  let data; try { data = JSON.parse(raw); } catch { return { status: response.status, data: null }; }
  return { status: response.status, data };
}
function httpRetry(status) { return status === 408 || status === 429 || status >= 500; }
function templateParameters(fields, text) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > 9) return null;
  const result = {};
  for (const [name, source] of Object.entries(fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || !['title', 'body', 'inputCount', 'approvalCount', 'pendingCount'].includes(source)) return null;
    result[name] = text[source];
  }
  return result;
}
function miIsland(state, text, business, scope, phase, now, sequence = state.updatedAt) {
  return { param_v2: { business, updatable: true, reopen: 'reopen', timeout: 2,
    orderId: hash(scope).slice(0, 32), sequence,
    islandFirstFloat: false, enableFloat: false, ...(phase === 'end' ? { cancel: true } : {}),
    aodTitle: text.body, ticker: text.body, baseInfo: { type: 2, title: text.body, content: 'AI Watch' },
    param_island: { islandProperty: 1, islandTimeout: Math.max(1, Math.min(90, state.expiresAt - Math.floor(now / 1000))),
      ...(phase === 'end' ? { dismissIsland: true } : {}),
      bigIslandArea: { imageTextInfoLeft: { type: 1, textInfo: { title: text.pendingCount, content: text.compact } } }, smallIslandArea: {} } } };
}

class MiPush {
  constructor({ appSecret, packageName, channelId, templateId, templateFields = {}, business, locale = 'en', fetchImpl = fetch, now = Date.now } = {}) {
    Object.assign(this, { appSecret, packageName, channelId, templateId, templateFields, business, locale, fetch: fetchImpl, now });
  }
  async send(device, event) {
    if (!this.appSecret || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(this.packageName || '') || !validId(this.channelId) || !validId(this.templateId)) return fail('mipush-not-configured');
    if (device?.platform !== 'android' || !TOKEN.test(device.token || '')) return fail('mipush-invalid-registration');
    const live = isAttention(event), state = live ? safeState(event, this.now()) : null;
    if (live && (!state || !validId(this.business))) return fail('mipush-attention-unavailable');
    const text = words(event, this.locale, state);
    if (!text.title) return fail('mipush-unsupported-event');
    const params = templateParameters(this.templateFields, text);
    if (!params) return fail('mipush-invalid-template-fields');
    const meta = metadata(event);
    const ttl = live ? (event.phase === 'end' ? 90000 : Math.min(90000, Math.max(1, state.expiresAt * 1000 - this.now()))) : Math.min(900000, Math.max(0, (event.expiresAt || 0) - this.now()));
    if (!live && ttl <= 0) return fail('mipush-event-expired');
    const localId = device.liveActivity?.notificationId;
    const attentionId = Number.isInteger(localId) && localId >= 0 && localId <= 2147483647 ? localId : notificationId(device.id + ':attention');
    const form = new URLSearchParams({ registration_id: device.token, restricted_package_name: this.packageName,
      payload: JSON.stringify(meta), time_to_live: String(ttl), notify_id: String(live ? attentionId : notificationId(meta.eventId)),
      'extra.channel_id': this.channelId, 'extra.template_id': this.templateId, 'extra.template_param': JSON.stringify(params),
      'extra.notify_effect': '1', 'extra.notify_foreground': '0' });
    if (live) form.set('extra.miui.focus.param', JSON.stringify(miIsland(state, text, this.business, device.id, event.phase, this.now(),
      Number.isSafeInteger(event.timestamp) && event.timestamp > 0 ? event.timestamp : state.updatedAt)));
    try {
      const res = await request(MI_URL, form.toString(), { authorization: `key=${this.appSecret}`, 'content-type': 'application/x-www-form-urlencoded' }, this.fetch);
      if (res.status === 200 && res.data?.code === 0 && res.data.result === 'ok') return { ok: true };
      return { retry: httpRetry(res.status), error: res.status === 200 ? `mipush-code-${Number.isInteger(res.data?.code) ? res.data.code : 'invalid-response'}` : `mipush-http-${res.status}` };
    } catch { return { retry: true, error: 'mipush-transport-failed' }; }
  }
}

function vivoLiveMessage(state, text, scene, iconPath, phase, now, sequence = state.updatedAt) {
  const icon = { path: iconPath };
  if (phase === 'end') return { operation: 2, scene, keepDuration: 0, changeRecord: sequence };
  return { operation: 1, scene, keepDuration: 0, showNotify: true, changeRecord: sequence, templateType: 4,
    templateData: { baseInfo: { icon, mainText: [{ text: text.title }], subText: [{ text: text.body }] },
      shortInfo: { lockIcon: icon, icon, image: icon, mainText: text.title, subText: text.body, skipType: 1 },
      subInfo: { type: 4, imageSkipInfos: [{ icon, skipInfo: { skipType: 1 } }] } },
    capsuleData: { state: 1, icon, content: `${text.pendingCount} ${text.compact}` },
    islandData: { leftTemplate: 1, rightTemplate: 4, leftInfo: { icon, text: 'AI Watch' },
      rightInfo: { text: `${text.pendingCount} ${text.compact}` }, forceShowCard: false,
      showTime: Math.max(1, Math.min(90, state.expiresAt - Math.floor(now / 1000))) } };
}
class VivoPush {
  constructor({ appId, appKey, appSecret, category, scene, iconPath, pushMode = 0, locale = 'en', fetchImpl = fetch, now = Date.now } = {}) {
    Object.assign(this, { appId: Number(appId), appKey, appSecret, category, scene, iconPath, pushMode: Number(pushMode), locale, fetch: fetchImpl, now });
    this.access = null; this.authInFlight = null;
  }
  async accessToken() {
    if (this.access?.until > this.now()) return this.access.token;
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = (async () => {
      const timestamp = this.now();
      const sign = crypto.createHash('md5').update(`${this.appId}${this.appKey}${timestamp}${this.appSecret}`).digest('hex');
      const res = await request(`${VIVO_ORIGIN}/message/auth`, JSON.stringify({ appId: this.appId, appKey: this.appKey, timestamp, sign }), { 'content-type': 'application/json' }, this.fetch);
      if (res.status !== 200 || res.data?.result !== 0 || typeof res.data.authToken !== 'string' || !res.data.authToken || res.data.authToken.length > 4096) {
        const err = new Error('vpush-auth-failed'); err.retry = httpRetry(res.status) || res.data?.result === 10093; throw err;
      }
      this.access = { token: res.data.authToken, until: this.now() + 60 * 60000 }; return this.access.token;
    })();
    try { return await this.authInFlight; } finally { this.authInFlight = null; }
  }
  async send(device, event) {
    if (!Number.isSafeInteger(this.appId) || this.appId < 1 || !this.appKey || !this.appSecret || ![0, 1].includes(this.pushMode)) return fail('vpush-not-configured');
    if (device?.platform !== 'android' || !TOKEN.test(device.token || '')) return fail('vpush-invalid-registration');
    const live = isAttention(event), state = live ? safeState(event, this.now()) : null;
    if (live && (!state || !validId(this.scene) || !/^res\/drawable(?:-[a-z0-9-]+)?\/[a-z][a-z0-9_]*\.(?:png|webp|jpg)$/.test(this.iconPath || ''))) return fail('vpush-attention-unavailable');
    if (live && (device.liveActivity?.locallyCreated !== true || !Number.isInteger(device.liveActivity.notificationId) || device.liveActivity.notificationId < 1 || device.liveActivity.notificationId > 2147483647)) return fail('vpush-local-activity-required');
    if (!live && !/^[A-Z][A-Z0-9_]{0,63}$/.test(this.category || '')) return fail('vpush-category-required');
    const text = words(event, this.locale, state);
    if (!text.title) return fail('vpush-unsupported-event');
    const meta = metadata(event), remaining = live ? 60 : Math.floor(((event.expiresAt || 0) - this.now()) / 1000);
    if (!live && remaining < 60) return fail('vpush-event-expired');
    const body = { appId: this.appId, regId: device.token, notifyType: live ? 1 : 4, title: text.title, content: text.body,
      timeToLive: Math.min(900, remaining), skipType: 1, pushMode: this.pushMode, requestId: hash(`${meta.eventId}:${device.id}`).slice(0, 48) };
    if (live) { body.notifyId = device.liveActivity.notificationId; body.liveMessage = vivoLiveMessage(state, text, this.scene, this.iconPath, event.phase, this.now(),
      Number.isInteger(event.timestamp) && event.timestamp > 0 && event.timestamp <= 2147483647 ? event.timestamp : state.updatedAt); }
    else { body.category = this.category; body.clientCustomMap = meta; body.foregroundShow = false; body.notifyId = notificationId(meta.eventId); }
    try {
      const token = await this.accessToken();
      const res = await request(`${VIVO_ORIGIN}/${live ? 'livemessage' : 'message'}/send`, JSON.stringify(body), { authToken: token, 'content-type': 'application/json' }, this.fetch);
      if (res.status === 200 && res.data?.result === 0) return { ok: true };
      if (res.data?.result === 10302 && [1, 2].includes(res.data.invalidUser?.status)) return { invalid: true, error: 'vpush-invalid-token' };
      if (res.data?.result === 10000 || res.status === 401) this.access = null;
      return { retry: httpRetry(res.status) || res.status === 401 || [10000, 10072, 10093, 10703].includes(res.data?.result),
        error: res.status === 200 ? `vpush-code-${Number.isInteger(res.data?.result) ? res.data.result : 'invalid-response'}` : `vpush-http-${res.status}` };
    } catch (error) { return { retry: error.retry !== false, error: error.message === 'vpush-auth-failed' ? 'vpush-auth-failed' : 'vpush-transport-failed' }; }
  }
}

function createOemPush(env = process.env, options = {}) {
  let templateFields;
  try { templateFields = JSON.parse(env.MIPUSH_TEMPLATE_FIELDS || '{}'); } catch { templateFields = null; }
  const common = { ...options, locale: env.AI_WATCH_OEM_LOCALE === 'zh' ? 'zh' : 'en' };
  const mi = new MiPush({ ...common, appSecret: env.MIPUSH_APP_SECRET, packageName: env.MIPUSH_PACKAGE_NAME, channelId: env.MIPUSH_CHANNEL_ID,
    templateId: env.MIPUSH_TEMPLATE_ID, templateFields, business: env.MIPUSH_APPROVED_BUSINESS });
  const vivo = new VivoPush({ ...common, appId: env.VIVO_PUSH_APP_ID, appKey: env.VIVO_PUSH_APP_KEY, appSecret: env.VIVO_PUSH_APP_SECRET,
    category: env.VIVO_PUSH_CATEGORY, scene: env.VIVO_PUSH_APPROVED_SCENE, iconPath: env.VIVO_PUSH_ICON_PATH, pushMode: env.VIVO_PUSH_MODE || '0' });
  return (device, event) => {
    if (device?.transport === 'mipush') return mi.send(device, event);
    if (device?.transport === 'vpush') return vivo.send(device, event);
    // Fluid Cloud requires an approved service, signed UPK and vendor SDK setup.
    // No unverified HTTP endpoint or transport fallback may expose a token.
    return Promise.resolve(fail(device?.transport === 'opush' ? 'opush-fluid-cloud-not-integrated' : 'oem-transport-unsupported'));
  };
}
module.exports = { MiPush, VivoPush, createOemPush, miIsland, vivoLiveMessage, safeState, templateParameters };
