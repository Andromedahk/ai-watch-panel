const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createServer } = require('../cloud/server.cjs');
const { CloudStatusController, projectStatus } = require('../electron/cloud-status.cjs');

test('desktop -> cloud -> mobile -> desktop receipt over real HTTP, with replay and offline protection', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-watch-cloud-flow-'));
  let now = Date.now();
  const desktopToken = randomUUID(), mobileToken = randomUUID();
  const runtime = createServer({ desktopToken, mobileToken, file: path.join(directory, 'server.json'), now: () => now, timers: false });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${runtime.server.address().port}`;
  t.after(async () => { controller.stop(); await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const questionId = '2'.repeat(64), installation = randomUUID(); let pairedToken;
  let requests = [{ id: `codex-${'1'.repeat(64)}`, provider: 'codex', kind: 'input', title: 'codex.input', detail: 'input', expiresAt: now + 600000,
    questions: [{ id: questionId, header: 'question.1', question: 'review.questionOnDesktop', options: [{ label: 'option.1', description: '' }], isOther: true }] }];
  let executed = 0;
  const controller = new CloudStatusController({ userData: path.join(directory, 'desktop'), allowHttp: true, now: () => now,
    getSnapshot: async () => projectStatus({ sampledAt: new Date(now).toISOString(), codex: { connection: 'ready', activity: 'waiting', activeTasks: 1, waitingTasks: 1, waitingReason: 'input', quotas: [] } }, { requests, now }),
    actions: { execute: async command => { assert.deepEqual(command.answers, { [questionId]: { answers: ['option.1'] } }); executed++; requests = []; return { id: command.id, status: 'succeeded' }; } } });
  controller.config = { enabled: true, endpoint, allowActions: true }; controller.token = desktopToken;
  const call = async (route, method = 'GET', body, token = pairedToken) => {
    const response = await fetch(endpoint + route, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const pairing = await call('/v1/pair', 'POST', { id: installation, name: 'Test phone', platform: 'android' }, mobileToken);
  assert.equal(pairing.status, 201); pairedToken = pairing.body.token;
  await controller.tick();
  assert.equal(controller.state, 'connected');
  const state = await call('/v1/state'); assert.equal(state.body.online, true); assert.equal(state.body.snapshot.requests.length, 1);
  assert.equal((await call('/v1/state', 'GET', undefined, desktopToken)).status, 401);
  assert.equal((await call('/v1/state', 'GET', undefined, mobileToken)).status, 401);
  const action = { id: randomUUID(), requestId: requests[0].id, kind: 'answer', answers: { [questionId]: { answers: ['option.1'] } } };
  assert.equal((await call('/v1/commands', 'POST', action)).body.status, 'queued');
  now += 5000; await controller.tick(); await controller.actionQueue;
  assert.equal(executed, 1);
  assert.equal((await call('/v1/state')).body.commands[0].status, 'delivered');
  now += 5000; await controller.tick();
  assert.equal((await call('/v1/state')).body.commands[0].status, 'succeeded');
  assert.equal((await call('/v1/state')).body.commands[0].actorDeviceId, installation);
  assert.equal((await call('/v1/commands', 'POST', action)).body.status, 'succeeded');
  now += 5000; await controller.tick(); assert.equal(executed, 1);
  now += 21000;
  assert.equal((await call('/v1/state')).body.online, false);
  assert.equal((await call('/v1/commands', 'POST', { ...action, id: randomUUID() })).status, 409);
  assert.equal((await call('/v1/pair', 'DELETE')).status, 200);
  assert.equal((await call('/v1/state')).status, 401);
});
