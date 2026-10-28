'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MiPush, VivoPush, createOemPush, safeState, templateParameters } = require('./oem-push.cjs');
const now = 1793174400000;
const device = { id: 'f2b93675-9571-436d-82f8-5e5ded3463e5', platform: 'android', token: 'synthetic_registration_token', liveUpdates: true,
  liveActivity: { notificationId: 8401, locallyCreated: true } };
const event = { eventId: '88cd6032-3a91-4306-8461-a27a5931f903', category: 'attention', phase: 'update',
  contentState: { inputCount: 2, approvalCount: 1, provider: 'codex', updatedAt: now / 1000, expiresAt: now / 1000 + 90 } };
const normal = { eventId: event.eventId, category: 'input', provider: 'codex', requestId: `codex-${'a'.repeat(64)}`, expiresAt: now + 900000 };
const miConfig = { appSecret: 'synthetic-secret', packageName: 'app.example.aiwatch', channelId: '12345', templateId: '54321', business: 'APPROVED_TEST_SCENE', now: () => now };
const vivoConfig = { appId: 12345, appKey: 'synthetic-app-key', appSecret: 'synthetic-secret', scene: 'APPROVED_TEST_SCENE',
  category: 'APPROVED_TEST_CATEGORY', iconPath: 'res/drawable-nodpi/ai_watch_live_icon.png', now: () => now };
function capture(replies) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('unexpected-network-call');
    return { status: next.status ?? 200, text: async () => next.raw ?? JSON.stringify(next.data) };
  };
  return { calls, fetchImpl };
}
const miSuccess = () => ({ data: { result: 'ok', code: 0 } });
const authSuccess = () => ({ data: { result: 0, authToken: 'synthetic-auth-token' } });
const vivoSuccess = () => ({ data: { result: 0, taskId: 'synthetic-task-id' } });

test('MiPush uses fixed V3 regid endpoint and approved template fields only', async () => {
  const mock = capture([miSuccess()]);
  const push = new MiPush({ ...miConfig, ...mock, locale: 'zh', templateFields: { summary: 'body', count: 'pendingCount' } });
  assert.deepEqual(await push.send(device, { ...event, answer: 'PRIVATE ANSWER', title: 'PRIVATE TITLE' }), { ok: true });
  const call = mock.calls[0], body = new URLSearchParams(call.body);
  assert.equal(call.url, 'https://api.xmpush.xiaomi.com/v3/message/regid');
  assert.equal(call.headers.authorization, 'key=synthetic-secret');
  assert.equal(call.redirect, 'error');
  assert.equal(body.get('registration_id'), device.token);
  assert.equal(body.get('notify_id'), String(device.liveActivity.notificationId));
  assert.equal(body.get('extra.channel_id'), '12345');
  assert.equal(body.get('extra.template_id'), '54321');
  assert.deepEqual(JSON.parse(body.get('extra.template_param')), { summary: '待回答 2 · 待授权 1', count: '3' });
  const island = JSON.parse(body.get('extra.miui.focus.param')).param_v2;
  assert.equal(island.business, miConfig.business);
  assert.equal(island.sequence, now / 1000);
  assert.equal(island.param_island.bigIslandArea.imageTextInfoLeft.textInfo.title, '3');
  assert.equal(island.param_island.islandTimeout, 90);
  assert.equal(body.get('time_to_live'), '90000');
  assert.doesNotMatch(call.body, /PRIVATE/);
});
test('MiPush end updates the same notification with cancel and no sensitive payload', async () => {
  const mock = capture([miSuccess(), miSuccess()]);
  const push = new MiPush({ ...miConfig, ...mock });
  await push.send(device, event);
  assert.deepEqual(await push.send(device, { ...event, phase: 'end', timestamp: now / 1000 + 1 }), { ok: true });
  const [first, end] = mock.calls.map(c => new URLSearchParams(c.body));
  assert.equal(first.get('notify_id'), end.get('notify_id'));
  const island = JSON.parse(end.get('extra.miui.focus.param')).param_v2;
  assert.equal(island.cancel, true); assert.equal(island.param_island.dismissIsland, true);
  assert.equal(island.sequence, now / 1000 + 1);
  assert.equal(island.param_island.bigIslandArea.imageTextInfoLeft.textInfo.title, '0');
});
test('MiPush ordinary notification uses template metadata without island fields', async () => {
  const mock = capture([miSuccess()]); const push = new MiPush({ ...miConfig, ...mock });
  assert.deepEqual(await push.send(device, normal), { ok: true });
  const body = new URLSearchParams(mock.calls[0].body);
  assert.equal(body.has('extra.miui.focus.param'), false);
  assert.deepEqual(JSON.parse(body.get('payload')), { eventId: normal.eventId, category: 'input', provider: 'codex', requestId: normal.requestId });
  assert.equal(body.get('extra.template_param'), '{}');
});
test('MiPush fails closed without template approval or on invalid multi-recipient tokens', async () => {
  const mock = capture([]);
  assert.equal((await new MiPush({ ...miConfig, ...mock, templateId: '' }).send(device, event)).error, 'mipush-not-configured');
  assert.equal((await new MiPush({ ...miConfig, ...mock, business: '' }).send(device, event)).error, 'mipush-attention-unavailable');
  assert.equal((await new MiPush({ ...miConfig, ...mock }).send({ ...device, token: 'valid_regid,other_regid' }, event)).error, 'mipush-invalid-registration');
  assert.equal(mock.calls.length, 0);
});
test('MiPush uses only generic errors and retries transient HTTP failures', async () => {
  const mock = capture([{ status: 429, data: { reason: 'PRIVATE SERVER RESPONSE' } }, { data: { result: 'error', code: 10041, reason: 'PRIVATE SERVER RESPONSE' } }, { raw: '<html>PRIVATE</html>' }]);
  const push = new MiPush({ ...miConfig, ...mock });
  assert.deepEqual(await push.send(device, event), { retry: true, error: 'mipush-http-429' });
  assert.deepEqual(await push.send(device, event), { retry: false, error: 'mipush-code-10041' });
  assert.deepEqual(await push.send(device, event), { retry: false, error: 'mipush-code-invalid-response' });
});
test('vivo auth uses documented MD5 signature and keeps secret out of payload', async () => {
  const mock = capture([authSuccess(), vivoSuccess()]); const push = new VivoPush({ ...vivoConfig, ...mock });
  assert.deepEqual(await push.send(device, normal), { ok: true });
  const call = mock.calls[0], body = JSON.parse(call.body);
  assert.equal(call.url, 'https://api-push.vivo.com.cn/message/auth');
  assert.equal(body.sign, crypto.createHash('md5').update(`${vivoConfig.appId}${vivoConfig.appKey}${now}${vivoConfig.appSecret}`).digest('hex'));
  assert.equal(body.timestamp, now); assert.equal(body.appSecret, undefined);
  assert.equal(mock.calls[1].headers.authToken, 'synthetic-auth-token');
  const message = JSON.parse(mock.calls[1].body);
  assert.equal(message.category, vivoConfig.category); assert.equal(message.skipType, 1);
  assert.equal(message.foregroundShow, false); assert.equal(message.timeToLive, 900);
  assert.deepEqual(message.clientCustomMap, { eventId: normal.eventId, category: 'input', provider: 'codex', requestId: normal.requestId });
});
test('vivo cloud only updates an existing local notification using approved scene and packaged image', async () => {
  const mock = capture([authSuccess(), vivoSuccess()]); const push = new VivoPush({ ...vivoConfig, ...mock, locale: 'zh' });
  assert.deepEqual(await push.send(device, event), { ok: true });
  const call = mock.calls[1], body = JSON.parse(call.body), live = body.liveMessage;
  assert.equal(call.url, 'https://api-push.vivo.com.cn/livemessage/send');
  assert.equal(body.notifyId, 8401); assert.equal(body.timeToLive, 60);
  assert.equal(live.operation, 1); assert.equal(live.scene, vivoConfig.scene); assert.equal(live.templateType, 4);
  assert.equal(live.templateData.subInfo.type, 4);
  assert.equal(live.templateData.subInfo.imageSkipInfos[0].icon.path, vivoConfig.iconPath);
  assert.equal(live.capsuleData.state, 1); assert.equal(live.islandData.showTime, 90);
  assert.equal(live.islandData.rightInfo.text, '3 待处理');
  assert.equal(live.changeRecord, now / 1000);
});
test('vivo remote end is minimal and reuses the existing local id', async () => {
  const mock = capture([authSuccess(), vivoSuccess()]); const push = new VivoPush({ ...vivoConfig, ...mock });
  assert.deepEqual(await push.send(device, { ...event, phase: 'end', timestamp: now / 1000 + 1 }), { ok: true });
  const body = JSON.parse(mock.calls[1].body);
  assert.equal(body.notifyId, 8401);
  assert.deepEqual(body.liveMessage, { operation: 2, scene: vivoConfig.scene, keepDuration: 0, changeRecord: now / 1000 + 1 });
});
test('vivo rejects cold cloud creation, unapproved scenes, invalid icons and expired data before network', async () => {
  const mock = capture([]); const push = new VivoPush({ ...vivoConfig, ...mock });
  assert.equal((await push.send({ ...device, liveActivity: undefined }, event)).error, 'vpush-local-activity-required');
  assert.equal((await push.send(device, { ...event, phase: 'start' })).error, 'vpush-attention-unavailable');
  assert.equal((await new VivoPush({ ...vivoConfig, ...mock, scene: '' }).send(device, event)).error, 'vpush-attention-unavailable');
  assert.equal((await new VivoPush({ ...vivoConfig, ...mock, iconPath: 'https://private.example/icon.png' }).send(device, event)).error, 'vpush-attention-unavailable');
  assert.equal((await push.send(device, { ...event, contentState: { ...event.contentState, expiresAt: now / 1000 - 1 } })).error, 'vpush-attention-unavailable');
  assert.equal(mock.calls.length, 0);
});
test('vivo caches authorization then invalidates an expired token for the next attempt', async () => {
  const mock = capture([authSuccess(), vivoSuccess(), { data: { result: 10000 } }, authSuccess(), vivoSuccess()]);
  const push = new VivoPush({ ...vivoConfig, ...mock });
  assert.deepEqual(await push.send(device, normal), { ok: true });
  assert.deepEqual(await push.send(device, normal), { retry: true, error: 'vpush-code-10000' });
  assert.deepEqual(await push.send(device, normal), { ok: true });
  assert.equal(mock.calls.filter(c => c.url.endsWith('/message/auth')).length, 2);
});
test('vivo marks only nonexistent or unsubscribed tokens invalid, not non-test users', async () => {
  const mock = capture([authSuccess(), { data: { result: 10302, invalidUser: { status: 1 } } }, { data: { result: 10302, invalidUser: { status: 2 } } }, { data: { result: 10302, invalidUser: { status: 4 } } }]);
  const push = new VivoPush({ ...vivoConfig, ...mock });
  assert.equal((await push.send(device, event)).invalid, true);
  assert.equal((await push.send(device, event)).invalid, true);
  assert.deepEqual(await push.send(device, event), { retry: false, error: 'vpush-code-10302' });
});
test('vivo retries rate limits but stops on daily quota or template configuration failures', async () => {
  const mock = capture([authSuccess(), { data: { result: 10072 } }, { data: { result: 10073 } }, { data: { result: 11050 } }]);
  const push = new VivoPush({ ...vivoConfig, ...mock });
  assert.equal((await push.send(device, normal)).retry, true);
  assert.equal((await push.send(device, normal)).retry, false);
  assert.equal((await push.send(device, normal)).retry, false);
});
test('invalid counts, excessive lease and template mappings cannot copy arbitrary request text', () => {
  assert.equal(safeState({ ...event, contentState: { ...event.contentState, inputCount: 65 } }, now), null);
  assert.equal(safeState({ ...event, contentState: { ...event.contentState, inputCount: 64 } }, now).inputCount, 64);
  assert.equal(safeState({ ...event, contentState: { ...event.contentState, expiresAt: now / 1000 + 3600 } }, now), null);
  assert.equal(templateParameters({ secret: 'answer' }, { answer: 'PRIVATE' }), null);
  assert.equal(templateParameters([], {}), null);
});
test('factory gates missing credentials and never routes unsupported OPPO to another vendor', async () => {
  const mock = capture([]); const send = createOemPush({}, mock);
  assert.equal((await send({ ...device, transport: 'mipush' }, event)).error, 'mipush-not-configured');
  assert.equal((await send({ ...device, transport: 'vpush' }, event)).error, 'vpush-not-configured');
  assert.equal((await send({ ...device, transport: 'opush' }, event)).error, 'opush-fluid-cloud-not-integrated');
  assert.equal((await send({ ...device, transport: 'huawei' }, event)).error, 'oem-transport-unsupported');
  assert.equal(mock.calls.length, 0);
});
test('all transport errors stay generic and oversized vendor responses are rejected', async () => {
  const mi = new MiPush({ ...miConfig, ...capture([{ raw: 'X'.repeat(65537) }]) });
  const vivo = new VivoPush({ ...vivoConfig, ...capture([new Error('SECRET KEY')]) });
  assert.deepEqual(await mi.send(device, event), { retry: true, error: 'mipush-transport-failed' });
  assert.deepEqual(await vivo.send(device, event), { retry: true, error: 'vpush-transport-failed' });
});
