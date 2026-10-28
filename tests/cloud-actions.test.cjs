const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { CloudActionAdapter, CodexActionReader, applyChange, presentRequest, selectActionField } = require('../electron/cloud-actions.cjs');
const { JsonProjectionFrameDecoder } = require('../electron/json-projection-frame-decoder.cjs');
const { projectStatus } = require('../electron/cloud-status.cjs');
const { validateSnapshot } = require('../cloud/validation.cjs');

const input = () => ({ id: 'request-1', method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'item',
  questions: [{ id: 'direction', header: 'Direction', question: 'Choose direction', options: [{ label: 'A', description: 'First option' }], isOther: true }] } });
const approval = () => ({ id: 'request-2', method: 'item/commandExecution/requestApproval', params: {
  threadId: 'thread', turnId: 'turn', itemId: 'item', command: 'npm test', reason: 'Run tests', cwd: 'project', availableDecisions: ['accept', 'decline'] } });
function harness(request = input()) {
  let now = 100000;
  const reader = { client: 'monitor', states: new Map([['thread', { requests: [request], revision: 1, owner: 'owner' }]]), listeners: new Set(),
    close() { this.client = null; this.states.clear(); for (const listener of this.listeners) listener(); }, calls: [],
    async request(method, params, owner) {
      this.calls.push({ method, params, owner });
      this.states.set('thread', { requests: [], revision: 2, owner: 'owner' });
      for (const listener of this.listeners) listener();
      return { resultType: 'success', result: { ok: true } };
    } };
  const adapter = new CloudActionAdapter({ reader, now: () => now, timeout: 35 });
  return { reader, adapter, time: value => { now = value; }, command: async (kind = 'answer') => ({
    id: 'command-1', requestId: (await adapter.pending())[0].id, kind, expiresAt: now + 60000,
    ...(kind === 'answer' ? { answers: { [(await adapter.pending())[0].questions[0].id]: { answers: ['option.1'] } } } : {}) }) };
}

test('cloud actions bind opaque identity to owner, thread and full request contents', () => {
  const request = input();
  const a = presentRequest(request, 'thread', 'owner');
  assert.equal(a.item.provider, 'codex');
  assert.equal(a.item.questions[0].question, 'review.questionOnDesktop');
  assert.equal(a.item.questions[0].options[0].label, 'option.1');
  assert.notEqual(a.item.questions[0].id, 'direction');
  assert.match(a.item.id, /^codex-[a-f0-9]{64}$/);
  assert.notEqual(a.item.id, presentRequest(request, 'thread', 'new-owner').item.id);
  const changed = input(); changed.params.questions[0].question = 'A different question';
  assert.notEqual(a.item.id, presentRequest(changed, 'thread', 'owner').item.id);
  assert.equal(presentRequest(request, 'another-thread', 'owner'), null);
});

test('cloud request metadata excludes private paths, command arguments, reasons, question and option text', () => {
  const request = approval();
  request.params.command = 'git -C /Users/private-account/secret-project status';
  request.params.reason = 'PRIVATE_TASK_CONTEXT'; request.params.cwd = '/Users/private-account/secret-project';
  const command = presentRequest(request, 'thread', 'owner').item;
  assert.equal(command.detail, 'git');
  assert.doesNotMatch(JSON.stringify(command), /Users|private-account|secret-project|PRIVATE_TASK_CONTEXT|status/);
  const question = input(); question.params.questions[0].question = 'PRIVATE_QUESTION';
  question.params.questions[0].id = 'PRIVATE_ID'; question.params.questions[0].options[0] = { label: 'PRIVATE_OPTION', description: 'PRIVATE_DESCRIPTION' };
  assert.doesNotMatch(JSON.stringify(presentRequest(question, 'thread', 'owner').item), /PRIVATE/);
  const file = { ...approval(), method: 'item/fileChange/requestApproval' }; file.params.grantRoot = '/Users/private-account/private-project';
  assert.equal(presentRequest(file, 'thread', 'owner').item.detail, 'fileChange');
});
test('full-content opt-in preserves original display text and keeps numbered answer identities stable', async () => {
  const h = harness();
  const redacted = (await h.adapter.pending())[0], full = (await h.adapter.pending({ uploadFullContent: true }))[0];
  assert.equal(redacted.fullContent, undefined); assert.equal(full.id, redacted.id);
  assert.deepEqual(full.questions, redacted.questions);
  assert.deepEqual(full.fullContent.questions[0], { id: redacted.questions[0].id, header: 'Direction', question: 'Choose direction', options: [{ label: 'A', description: 'First option' }] });
  assert.equal((await h.adapter.pending())[0].fullContent, undefined);
  const cmd = harness(approval()); const request = (await cmd.adapter.pending({ uploadFullContent: true }))[0];
  assert.deepEqual(request.fullContent, { command: 'npm test', cwd: 'project', reason: 'Run tests' });
  assert.equal((await h.adapter.execute(await h.command())).status, 'succeeded');
  assert.equal(h.reader.calls[0].params.response.answers.direction.answers[0], 'A');
});
test('invalid full text is omitted as a complete request with a visible limited flag', async () => {
  for (const reason of ['Invalid\u001bcontrol', 'x'.repeat(4097)]) {
    const request = approval(); request.params.reason = reason; const h = harness(request);
    assert.equal((await h.adapter.pending())[0].fullContent, undefined);
    const projected = projectStatus({ sampledAt: new Date(100000).toISOString() }, { now: 100000, requests: await h.adapter.pending({ uploadFullContent: true }) });
    assert.equal(projected.limited, true); assert.deepEqual(projected.requests, []);
  }
});

test('more than 32 pending actions reach the projection budget and flag the mobile list as incomplete', async () => {
  const h = harness();
  const requests = Array.from({ length: 33 }, (_, index) => ({ ...input(), id: `request-${index}` }));
  h.reader.states.get('thread').requests = requests;
  const pending = await h.adapter.pending();
  assert.equal(pending.length, 33);
  const status = { sampledAt: new Date(100000).toISOString() };
  const projected = projectStatus(status, { now: 100000, requests: pending, enabledProviders: ['codex'] });
  assert.equal(projected.limited, true);
  assert.equal(projected.requests.length, 32);
  assert.deepEqual(projected.requests, pending.slice(0, 32));
  assert.doesNotMatch(JSON.stringify(projected), /Choose direction|First option|request-32/);
  validateSnapshot(projected);

  h.reader.states.get('thread').requests = requests.slice(0, 32);
  const complete = projectStatus(status, { now: 100000, requests: await h.adapter.pending(), enabledProviders: ['codex'] });
  assert.equal(complete.requests.length, 32);
  assert.equal(complete.limited, undefined);
});

test('cloud action projection omits transcripts, credentials and unsupported payload fields', () => {
  const request = input(); request.params.credentials = 'PRIVATE_TOKEN';
  const message = { type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', params: {
    hostId: 'local', conversationId: 'thread', change: { type: 'snapshot', revision: 1,
      conversationState: { requests: [request], turns: [{ text: 'PRIVATE_TRANSCRIPT'.repeat(10000) }], title: 'PRIVATE_TITLE' } } } };
  const decoder = new JsonProjectionFrameDecoder({ select: selectActionField });
  const data = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(data.length);
  let value; decoder.feed(Buffer.concat([header, data]), decoded => { value = decoded; });
  assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  assert.equal(value.params.change.conversationState.requests[0].params.questions[0].question, 'Choose direction');
});

test('cloud action state rejects gaps, oversized request lists, unknown patch operators and prototype paths', () => {
  const initial = applyChange(null, { type: 'snapshot', revision: 4, conversationState: { requests: [input()] } });
  assert.equal(applyChange(initial, { type: 'patches', revision: 6, baseRevision: 3, patches: [] }), null);
  assert.equal(applyChange(null, { type: 'snapshot', revision: 1, conversationState: { requests: Array(257).fill(input()) } }), null);
  assert.equal(applyChange(initial, { type: 'patches', revision: 5, baseRevision: 4,
    patches: [{ op: 'replace', path: '/requests/0/__proto__/evil', value: true }] }), null);
  assert.equal(applyChange(initial, { type: 'patches', revision: 5, baseRevision: 4,
    patches: [{ op: 'move', path: '/requests/0' }] }), null);
  const next = applyChange(initial, { type: 'patches', revision: 5, baseRevision: 4,
    patches: [{ op: 'remove', path: '/requests/0' }] });
  assert.deepEqual(next.requests, []); assert.equal(initial.requests.length, 1);
});

test('cloud actions exclude secrets, unknown request kinds, unsupported decisions and incomplete contexts', () => {
  const request = input(); request.params.questions[0].isSecret = true;
  assert.equal(presentRequest(request, 'thread', 'owner'), null);
  assert.equal(presentRequest({ ...input(), method: 'mcpServer/elicitation/request' }, 'thread', 'owner'), null);
  const command = approval(); command.params.availableDecisions = ['acceptForSession', 'cancel'];
  assert.equal(presentRequest(command, 'thread', 'owner'), null);
  command.params.availableDecisions = ['accept', 'decline']; command.params.command = 'x'.repeat(4097);
  assert.equal(presentRequest(command, 'thread', 'owner'), null);
  const duplicate = input(); duplicate.params.questions.push(duplicate.params.questions[0]);
  assert.equal(presentRequest(duplicate, 'thread', 'owner'), null);
});

test('cloud input response goes only to owning client and succeeds after acknowledged removal', async () => {
  const h = harness(), command = await h.command();
  assert.deepEqual(await h.adapter.execute(command), { id: 'command-1', status: 'succeeded' });
  assert.equal(h.reader.calls[0].method, 'thread-follower-submit-user-input');
  assert.equal(h.reader.calls[0].owner, 'owner');
  assert.deepEqual(JSON.parse(JSON.stringify(h.reader.calls[0].params)), { conversationId: 'thread', requestId: 'request-1', response: { answers: { direction: { answers: ['A'] } } } });
  assert.equal((await h.adapter.execute(command)).status, 'failed');
  assert.equal(h.reader.calls.length, 1);
});

test('cloud approval permits only single-request accept/decline, never persistent grants', async () => {
  for (const [kind, decision] of [['approve', 'accept'], ['deny', 'decline']]) {
    const h = harness(approval());
    assert.equal((await h.adapter.execute(await h.command(kind))).status, 'succeeded');
    assert.equal(h.reader.calls[0].method, 'thread-follower-command-approval-decision');
    assert.equal(h.reader.calls[0].params.decision, decision);
  }
});

test('cloud commands reject wrong kinds, unknown answer keys, expiration and ownership changes before dispatch', async () => {
  const h = harness(), command = await h.command();
  assert.equal((await h.adapter.execute({ ...command, kind: 'approve' })).error, 'wrong-action');
  assert.equal((await h.adapter.execute({ ...command, answers: { bad: { answers: ['A'] } } })).error, 'invalid-answers');
  assert.equal((await h.adapter.execute({ ...command, expiresAt: 99999 })).error, 'command-expired');
  h.reader.states.get('thread').owner = 'new-owner';
  assert.equal((await h.adapter.execute(command)).error, 'request-expired');
  assert.equal(h.reader.calls.length, 0);
});

test('cloud actions reject stale displayed content and age out long-lived requests', async () => {
  const h = harness(), command = await h.command();
  h.reader.states.get('thread').requests[0].params.questions[0].question = 'Changed';
  assert.equal((await h.adapter.execute(command)).error, 'request-expired');
  await h.adapter.pending(); h.time(100000 + 600001);
  assert.deepEqual(await h.adapter.pending(), []);
  assert.equal(h.reader.calls.length, 0);
});

test('a transport acknowledgement without observed resolution is never reported successful or replayed', async () => {
  const h = harness(), command = await h.command();
  h.reader.request = async () => { h.reader.calls.push({}); return { resultType: 'success', result: { ok: true } }; };
  assert.deepEqual(await h.adapter.execute(command), { id: 'command-1', status: 'failed', error: 'outcome-unknown' });
  assert.equal((await h.adapter.execute({ ...command, id: 'retry' })).error, 'request-already-handled');
  assert.equal(h.reader.calls.length, 1);
  h.adapter.dispose();
});

test('a rejected local request, disconnect or ownership change cannot look successful', async () => {
  for (const mutation of ['reject', 'disconnect', 'owner']) {
    const h = harness(), command = await h.command();
    h.reader.request = async () => {
      if (mutation === 'reject') return { resultType: 'error' };
      if (mutation === 'disconnect') h.reader.close();
      else h.reader.states.set('thread', { requests: [], revision: 2, owner: 'other-owner' });
      for (const listener of h.reader.listeners) listener();
      return { resultType: 'success', result: { ok: true } };
    };
    assert.equal((await h.adapter.execute(command)).status, 'failed');
    h.adapter.dispose();
  }
});

test('concurrent delivery of the same command dispatches once', async () => {
  const h = harness(), command = await h.command();
  const results = await Promise.all([h.adapter.execute(command), h.adapter.execute(command)]);
  assert.ok(results.every(value => value.status === 'succeeded'));
  assert.equal(h.reader.calls.length, 1);
});

test('suspension invalidates an in-flight action but permits reopening; disposal is final', async () => {
  const h = harness(), command = await h.command();
  let finish;
  h.reader.request = () => new Promise(resolve => { finish = resolve; });
  const action = h.adapter.execute(command);
  h.adapter.suspend();
  finish({ resultType: 'success', result: { ok: true } });
  assert.equal((await action).error, 'local-unavailable');
  h.reader.client = 'new-monitor';
  const request = input(); request.id = 'new-request';
  h.reader.states.set('thread', { requests: [request], revision: 1, owner: 'owner' });
  assert.equal((await h.adapter.pending()).length, 1);
  h.adapter.dispose();
  assert.deepEqual(await h.adapter.pending(), []);
});

test('Codex action responses must name the targeted owner and exact method', async () => {
  for (const patch of [{ handledByClientId: 'wrong-owner' }, { method: 'unrelated-method' }, { version: 2 }, { handledByClientId: undefined }]) {
    const reader = new CodexActionReader({ codexHome: 'unused' });
    reader.client = 'monitor'; reader.socket = { writable: true, destroy() {} };
    reader.send = message => queueMicrotask(() => reader.handle({ type: 'response', requestId: message.requestId, method: message.method,
      handledByClientId: 'owner', resultType: 'success', result: { ok: true }, ...patch }));
    await assert.rejects(reader.request('thread-follower-submit-user-input', {}, 'owner', 100), /invalid-local-response/);
    reader.close();
  }
});

test('cloud Codex reader rejects unsupported versions and stale owner patches', () => {
  const reader = new CodexActionReader({ codexHome: 'unused', now: () => 100000 });
  reader.wanted.add('thread'); reader.send = () => {};
  const snapshot = (owner, version = 11) => ({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: owner, version,
    params: { hostId: 'local', conversationId: 'thread', change: { type: 'snapshot', revision: 1, conversationState: { requests: [input()] } } } });
  reader.handle(snapshot('owner'));
  assert.equal(reader.states.size, 1);
  reader.handle({ ...snapshot('different-owner'), params: { hostId: 'local', conversationId: 'thread', change: { type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'remove', path: '/requests/0' }] } } });
  assert.equal(reader.states.get('thread').requests.length, 1);
  reader.handle(snapshot('owner', 999));
  assert.equal(reader.states.size, 0);
  reader.handle(snapshot('owner'));
  assert.equal(reader.states.size, 1, 'a complete supported snapshot can restore a discarded state at the same revision');
  reader.close();
});

test('synthetic local socket carries a targeted approval and observes resolution', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-cloud-action-'));
  const dir = path.join(home, 'ipc'); await fs.mkdir(dir, { mode: 0o700 });
  const server = net.createServer(); let peer; const sent = [];
  const send = message => { const bytes = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); peer.write(Buffer.concat([header, bytes])); };
  server.on('connection', socket => {
    peer = socket; let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4); sent.push(message);
        if (message.method === 'initialize') send({ type: 'response', method: 'initialize', resultType: 'success', result: { clientId: 'mobile-monitor' } });
        if (message.method === 'thread-stream-following-changed' && message.params.following) send({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', params: {
          hostId: 'local', conversationId: 'thread', change: { type: 'snapshot', revision: 1, conversationState: { requests: [approval()] } } } });
        if (message.method === 'thread-follower-command-approval-decision') {
          send({ type: 'response', requestId: message.requestId, method: message.method, handledByClientId: 'owner', resultType: 'success', result: { ok: true } });
          send({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', params: { hostId: 'local', conversationId: 'thread',
            change: { type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'remove', path: '/requests/0' }] } } });
        }
      }
    });
  });
  await new Promise(resolve => server.listen(path.join(dir, 'ipc.sock'), resolve));
  const adapter = new CloudActionAdapter({ statusReader: { codexHome: home, codexAttention: { client: 'existing-monitor', wanted: new Set(['thread']) } }, timeout: 300 });
  try {
    let pending = [];
    for (let i = 0; i < 50 && !pending.length; i++) { pending = await adapter.pending(); if (!pending.length) await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(pending.length, 1);
    const result = await adapter.execute({ id: 'command', requestId: pending[0].id, kind: 'approve', expiresAt: Date.now() + 1000 });
    assert.equal(result.status, 'succeeded');
    const action = sent.find(message => message.method === 'thread-follower-command-approval-decision');
    assert.equal(action.targetClientId, 'owner'); assert.equal(action.version, 1); assert.equal(action.params.decision, 'accept');
  } finally { adapter.dispose(); peer?.destroy(); await new Promise(resolve => server.close(resolve)); await fs.rm(home, { recursive: true, force: true }); }
});
