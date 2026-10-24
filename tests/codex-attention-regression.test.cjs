const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonProjectionFrameDecoder } = require('../electron/json-projection-frame-decoder.cjs');
const { applyAttentionChange, summarizeAttention, selectAttentionField } = require('../electron/codex-attention-state.cjs');
const { CodexAttentionReader } = require('../electron/codex-attention.cjs');
const { LocalStatusReader } = require('../electron/local-status.cjs');

const questionItem = (id = 'question-item', count = 1) => ({ type: 'agentMessage', id,
  content: [{ type: 'text', text: 'PRIVATE_ASSISTANT_BODY' }],
  questions: Array.from({ length: count }, (_, index) => ({ id: `PRIVATE_QUESTION_${index}`,
    question: 'PRIVATE_QUESTION_WORDING', options: [{ label: 'PRIVATE_OPTION', description: 'PRIVATE_DESCRIPTION' }] })) });
const replyText = (id = 'question-item', indices = [0]) => '<send_user_message_question_reply>\n' +
  JSON.stringify(indices.map(index => ({ questionItemId: JSON.stringify(['request_user_input_async', id, index]),
    answer: 'PRIVATE_ANSWER', selectedOptions: ['PRIVATE_SELECTED_OPTION'] }))) + '\n</send_user_message_question_reply>';
const answerItem = (id = 'question-item', indices = [0], type = 'userMessage', status = undefined) => ({
  type, id: 'PRIVATE_REPLY_ITEM_ID', ...(status ? { status } : {}),
  [type === 'steeringUserMessage' ? 'input' : 'content']: [{ type: 'text', text: replyText(id, indices) }],
});
const turn = (items = [questionItem()], status = 'inProgress') => ({ turnId: 'PRIVATE_TURN_ID', status, items });
const conversation = (items, canonical = false, status = 'inProgress') => ({ requests: [], title: 'PRIVATE_TITLE',
  ...(canonical ? { turns: [], turnHistory: { kind: 'canonical', history: { entitiesByKey: { 'turn:PRIVATE_ENTITY_ID': turn(items, status) } } } }
    : { turns: [turn(items, status)] }) });
const snapshot = (state, revision = 10) => ({ type: 'snapshot', revision, conversationState: state });
const patches = (list, revision = 11, baseRevision = revision - 1) => ({ type: 'patches', revision, baseRevision, patches: list });
const envelope = (change, overrides = {}) => ({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
  sourceClientId: 'synthetic-owner', params: { hostId: 'local', conversationId: 'thread', change }, ...overrides });
function project(message) {
  const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  const decoder = new JsonProjectionFrameDecoder({ select: selectAttentionField });
  const values = [];
  decoder.feed(header.subarray(0, 1), value => values.push(value));
  decoder.feed(Buffer.concat([header.subarray(1), body]), value => values.push(value));
  assert.equal(values.length, 1);
  assert.equal(decoder.pendingBytes, 0);
  return values[0];
}
const apply = (previous, change) => applyAttentionChange(previous, project(envelope(change)).params.change);
function waiting(state) {
  assert.ok(state, 'accepted metadata should produce a state');
  return summarizeAttention(new Map([['thread', state]]));
}
function harness(t, options = {}) {
  let now = 10000;
  const sent = [];
  const reader = new CodexAttentionReader({ codexHome: path.join(os.tmpdir(), 'synthetic-codex-no-socket'),
    connect: () => { throw new Error('Tests must not connect to a real IPC endpoint'); }, now: () => now, ...options });
  reader.socket = { destroy() {} };
  reader.client = 'synthetic-monitor';
  reader.send = message => sent.push(message);
  t.after(() => { reader.onChange = () => {}; reader.close(); clearTimeout(reader.changeTimer); });
  return { reader, sent, now: value => { now = value; },
    deliver: (change, overrides) => reader.handle(project(envelope(change, overrides))),
    poll: ids => reader.poll(ids || ['thread'], true, now) };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function within(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 2000);
  })]); } finally { clearTimeout(timer); }
}

for (const canonical of [false, true]) {
  const shape = canonical ? 'canonical' : 'legacy';
  test(`${shape} async questions clear only when every question receives an accepted answer`, () => {
    let state = apply(null, snapshot(conversation([questionItem('question-item', 2)], canonical)));
    assert.equal(waiting(state).inputThreads.size, 1);
    state = apply(state, snapshot(conversation([questionItem('question-item', 2), answerItem('question-item', [0])], canonical), 11));
    assert.equal(waiting(state).inputThreads.size, 1, 'one remaining question still needs attention');
    state = apply(state, snapshot(conversation([questionItem('question-item', 2), answerItem('question-item', [0]),
      answerItem('question-item', [1], 'steeringUserMessage', 'pending')], canonical), 12));
    assert.equal(waiting(state).inputThreads.size, 1, 'queued steering does not acknowledge a question');
    state = apply(state, snapshot(conversation([questionItem('question-item', 2), answerItem('question-item', [0]),
      answerItem('question-item', [1], 'steeringUserMessage', 'accepted')], canonical), 13));
    assert.equal(waiting(state).waitingThreads.size, 0);
    assert.ok(!JSON.stringify(state).includes('PRIVATE'), 'question wording, replies and original identifiers must not enter cached state');
    state = apply(state, snapshot(conversation([questionItem('question-item', 2), answerItem('question-item', [0, 1])], canonical), 14));
    assert.equal(waiting(state).waitingThreads.size, 0, 'retained question cards must not resurrect after an answer');
    assert.equal(waiting(apply(null, snapshot(conversation([questionItem()], canonical, 'completed')))).waitingThreads.size, 0);
  });

  test(`${shape} question add, answer and removal patches survive arbitrary property order`, () => {
    const itemPath = canonical ? ['turnHistory', 'history', 'entitiesByKey', 'turn:PRIVATE_ENTITY_ID', 'items'] : ['turns', 0, 'items'];
    let state = apply(null, snapshot(conversation([], canonical)));
    state = apply(state, patches([{ value: questionItem(), path: [...itemPath, 0], op: 'add' }]));
    assert.equal(waiting(state).inputThreads.size, 1);
    state = apply(state, patches([{ value: answerItem(), op: 'add', path: [...itemPath, 1] }], 12));
    assert.equal(waiting(state).waitingThreads.size, 0);
    state = apply(state, patches([{ path: [...itemPath, 0, 'questions', 1], value: { question: 'PRIVATE_NEW_QUESTION' }, op: 'add' }], 13));
    assert.equal(waiting(state).inputThreads.size, 1, 'adding another question requires another answer');
    state = apply(state, patches([{ op: 'remove', path: [...itemPath, 0, 'questions', 1] }], 14));
    assert.equal(waiting(state).waitingThreads.size, 0);
    state = apply(state, patches([{ value: [], path: [...itemPath, 0, 'questions'], op: 'replace' }], 15));
    assert.equal(waiting(state).waitingThreads.size, 0);
    assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  });

  test(`${shape} wording-only question patches do not invalidate a known pending question`, () => {
    const questionPath = canonical ? ['turnHistory', 'history', 'entitiesByKey', 'turn:PRIVATE_ENTITY_ID', 'items', 0, 'questions', 0]
      : ['turns', 0, 'items', 0, 'questions', 0];
    let state = apply(null, snapshot(conversation([questionItem()], canonical)));
    state = apply(state, patches([{ value: 'PRIVATE_REVISED_WORDING', path: [...questionPath, 'question'], op: 'replace' }]));
    assert.equal(waiting(state).inputThreads.size, 1);
    assert.equal(state.revision, 11);
    assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  });

  test(`${shape} scalar reply-text patches preserve bounded markers regardless of property order`, () => {
    const itemPath = canonical ? ['turnHistory', 'history', 'entitiesByKey', 'turn:PRIVATE_ENTITY_ID', 'items'] : ['turns', 0, 'items'];
    const text = replyText().replace('PRIVATE_ANSWER', 'PRIVATE_LONG_ANSWER'.repeat(100));
    assert.ok(text.length > 256 && text.length < 65536);
    for (const valueFirst of [true, false]) {
      let state = apply(null, snapshot(conversation([questionItem(), { type: 'userMessage', content: [{ type: 'text', text: '' }] }], canonical)));
      const patch = valueFirst ? { value: text, path: [...itemPath, 1, 'content', 0, 'text'], op: 'replace' }
        : { op: 'replace', path: [...itemPath, 1, 'content', 0, 'text'], value: text };
      state = apply(state, patches([patch]));
      assert.equal(waiting(state).waitingThreads.size, 0);
      assert.ok(!JSON.stringify(state).includes('PRIVATE'));
    }
  });
}

test('canonical entity add/remove and complete history replacement use stable projected keys', () => {
  let state = apply(null, snapshot({ requests: [], turns: [], turnHistory: { kind: 'canonical', history: { entitiesByKey: {} } } }));
  state = apply(state, patches([{ value: turn(), path: '/turnHistory/history/entitiesByKey/turn:PRIVATE_ENTITY_ID', op: 'add' }]));
  assert.equal(waiting(state).inputThreads.size, 1);
  state = apply(state, patches([{ op: 'remove', path: '/turnHistory/history/entitiesByKey/turn:PRIVATE_ENTITY_ID' }], 12));
  assert.equal(waiting(state).waitingThreads.size, 0);
  state = apply(state, patches([{ value: { kind: 'canonical', history: { entitiesByKey: { 'turn:PRIVATE_SECOND_ID': turn() } } },
    op: 'replace', path: ['turnHistory'] }], 13));
  assert.equal(waiting(state).inputThreads.size, 1);
  state = apply(state, patches([{ path: ['turnHistory', 'history', 'entitiesByKey', 'turn:PRIVATE_SECOND_ID', 'status'],
    value: 'completed', op: 'replace' }], 14));
  assert.equal(waiting(state).waitingThreads.size, 0);
  assert.ok(!JSON.stringify(state).includes('PRIVATE'));
});

test('ordinary text and malformed or unrelated answer markers cannot acknowledge questions', () => {
  for (const text of ['PRIVATE_ORDINARY_TEXT', '<send_user_message_question_reply>{}</send_user_message_question_reply>',
    replyText('another-question-item'), replyText() + ' trailing ordinary text',
    '<send_user_message_question_reply>[invalid]</send_user_message_question_reply>']) {
    const state = apply(null, snapshot(conversation([questionItem(), { type: 'userMessage', content: [{ type: 'text', text }] }])));
    assert.equal(waiting(state).inputThreads.size, 1);
  }
});

test('supported tool calls and MCP elicitation are attention requests only while incomplete', () => {
  const requests = [
    { method: 'item/tool/requestUserInput' }, { method: 'item/tool/requestOptionPicker' },
    ...['request_onboarding_input', 'request_option_picker', 'request_environment_input'].map(tool => ({ method: 'item/tool/call', params: { tool } })),
    ...['role', 'task'].map(step => ({ method: 'item/tool/call', params: { tool: 'setup_codex_step', arguments: { step } } })),
    { method: 'mcpServer/elicitation/request', params: { elicitationKind: 'form', message: 'PRIVATE_ELICITATION', requestedSchema: { description: 'PRIVATE_SCHEMA' } } },
  ];
  for (const request of requests) {
    assert.equal(waiting(apply(null, snapshot({ requests: [request] }))).inputThreads.size, 1, JSON.stringify(request));
    assert.equal(waiting(apply(null, snapshot({ requests: [{ ...request, completed: true }] }))).waitingThreads.size, 0);
  }
  for (const params of [{ tool: 'ordinary_tool' }, { tool: 'setup_codex_step', arguments: { step: 'finish' } },
    { tool: 'setup_codex_step' }, { tool: 'exec_command', arguments: { command: 'PRIVATE_COMMAND' } }]) {
    assert.equal(waiting(apply(null, snapshot({ requests: [{ method: 'item/tool/call', params }] }))).waitingThreads.size, 0);
  }
});

test('pending-request summaries and explicit unanswered question identifiers preserve only attention metadata', () => {
  for (const kind of ['userInput', 'optionPicker', 'setupCodexStep', 'mcpServerElicitation', 'implementPlan']) {
    assert.equal(waiting(apply(null, snapshot({ requests: [], pendingRequest: { kind } }))).inputThreads.size, 1);
  }
  for (const kind of ['approval', 'permissionRequest']) {
    assert.equal(waiting(apply(null, snapshot({ requests: [], pendingRequest: { kind } }))).approvalThreads.size, 1);
  }
  let state = apply(null, snapshot({ requests: [], unansweredAsyncQuestions: { questionIds: ['PRIVATE_QUESTION_ID'] } }));
  assert.equal(waiting(state).inputThreads.size, 1);
  assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  state = apply(state, patches([{ value: [], op: 'replace', path: ['unansweredAsyncQuestions', 'questionIds'] }]));
  assert.equal(waiting(state).waitingThreads.size, 0);
});

test('projection drops large bodies and cached attention state does not retain request or reply payloads', () => {
  const source = conversation([questionItem(), answerItem()]);
  source.turns[0].items[0].content[0].text = 'PRIVATE_LARGE_BODY'.repeat(20000);
  source.requests.push({ method: 'mcpServer/elicitation/request', id: 'PRIVATE_REQUEST_ID', params: {
    message: 'PRIVATE_MCP_MESSAGE', requestedSchema: { properties: { secret: { description: 'PRIVATE_SCHEMA' } } },
    command: 'PRIVATE_COMMAND', attachments: [{ url: 'PRIVATE_ATTACHMENT_URL' }] } });
  source.attachments = ['PRIVATE_ATTACHMENT'];
  const state = apply(null, snapshot(source));
  assert.equal(waiting(state).inputThreads.size, 1);
  assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  assert.ok(JSON.stringify(state).length < 4096);
});

test('patches cannot bypass the payload allowlist or replace question placeholders with payload objects', () => {
  const source = conversation([questionItem()]);
  source.requests.push({ method: 'item/commandExecution/requestApproval', params: {} });
  let state = apply(null, snapshot(source));
  state = apply(state, patches([
    { value: 'PRIVATE_PATCH_COMMAND', path: ['requests', 0, 'params', 'command'], op: 'add' },
    { value: 'PRIVATE_PATCH_ATTACHMENT', path: ['turns', 0, 'items', 0, 'attachment'], op: 'add' },
    { value: { type: 'PRIVATE_QUESTION_TYPE', text: 'PRIVATE_QUESTION_TEXT' }, path: ['turns', 0, 'items', 0, 'questions', 1], op: 'add' },
  ]));
  assert.equal(waiting(state).inputThreads.size, 1);
  assert.equal(waiting(state).approvalThreads.size, 1);
  assert.equal(state.revision, 11);
  assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  assert.deepEqual(state.turns[0].items[0].questions, [null, null]);
});

test('turn item tool inputs and outputs never enter the cached attention state', () => {
  const source = conversation([questionItem(), { id: 'PRIVATE_TOOL_ITEM_ID', type: 'dynamicToolCall', tool: 'echo',
    arguments: 'PRIVATE_TOOL_ARGUMENT', input: 'PRIVATE_TOOL_INPUT', content: 'PRIVATE_TOOL_RESULT',
    params: { step: 'PRIVATE_TOOL_STEP', method: 'PRIVATE_TOOL_METHOD' } }]);
  let state = apply(null, snapshot(source));
  assert.equal(waiting(state).inputThreads.size, 1);
  assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  state = apply(state, patches([
    { value: 'PRIVATE_NEW_TOOL_RESULT', path: ['turns', 0, 'items', 1, 'content'], op: 'replace' },
    { value: 'PRIVATE_NEW_TOOL_ARGUMENT', op: 'replace', path: ['turns', 0, 'items', 1, 'arguments'] },
  ]));
  assert.equal(waiting(state).inputThreads.size, 1);
  assert.ok(!JSON.stringify(state).includes('PRIVATE'));
});

test('unknown protocol versions, remote hosts and unwanted conversations cannot create attention', async t => {
  const h = harness(t); await h.poll();
  const change = snapshot(conversation([questionItem()]));
  for (const version of [0, 10, 12, '11', undefined]) h.deliver(change, { version });
  h.deliver(change, { params: { hostId: 'remote', conversationId: 'thread', change } });
  h.deliver(change, { params: { hostId: 'local', conversationId: 'unwanted', change } });
  assert.equal(h.reader.summary().waitingThreads.size, 0);
  assert.equal(h.reader.states.size, 0);
  h.deliver(change);
  assert.equal(h.reader.summary().inputThreads.size, 1);
});

test('same-owner old snapshots cannot resurrect answered questions, including after a revision gap', async t => {
  const h = harness(t); await h.poll();
  h.deliver(snapshot(conversation([questionItem()])));
  h.deliver(snapshot(conversation([questionItem(), answerItem()]), 11));
  h.deliver(snapshot(conversation([questionItem()]), 10));
  assert.equal(h.reader.summary().waitingThreads.size, 0);
  assert.equal(h.reader.states.get('thread').revision, 11);
  h.deliver(patches([], 13, 12));
  assert.equal(h.reader.states.size, 0);
  h.deliver(snapshot(conversation([questionItem()]), 10));
  assert.equal(h.reader.states.size, 0);
  h.deliver(snapshot(conversation([questionItem(), answerItem()]), 13));
  assert.equal(h.reader.states.get('thread').revision, 13);
  assert.equal(h.reader.summary().waitingThreads.size, 0);
});

test('recovery rejects snapshots older than the highest observed revision even when that patch had a gap', async t => {
  const h = harness(t); await h.poll();
  h.deliver(snapshot(conversation([questionItem()]), 10));
  h.deliver(patches([{ op: 'add', path: ['turns', 0, 'items', 1], value: answerItem() }], 12, 11));
  assert.equal(h.reader.states.size, 0);
  h.deliver(snapshot(conversation([questionItem()]), 11));
  assert.equal(h.reader.states.size, 0, 'a snapshot preceding an observed gap must not restore a stale red light');
  h.deliver(snapshot(conversation([questionItem(), answerItem()]), 12));
  assert.equal(h.reader.states.get('thread').revision, 12);
  assert.equal(h.reader.summary().waitingThreads.size, 0);
});

test('a late patch from another owner cannot erase the current owner snapshot', async t => {
  const h = harness(t); await h.poll();
  h.deliver(snapshot(conversation([questionItem()]), 100), { sourceClientId: 'new-owner' });
  h.deliver(patches([], 98, 97), { sourceClientId: 'old-owner' });
  assert.equal(h.reader.summary().inputThreads.size, 1);
  assert.equal(h.reader.states.get('thread').owner, 'new-owner');
  assert.equal(h.reader.states.get('thread').revision, 100);
  h.deliver(snapshot(conversation([questionItem(), answerItem()]), 1), { sourceClientId: 'replacement-owner' });
  assert.equal(h.reader.summary().waitingThreads.size, 0);
  assert.equal(h.reader.states.get('thread').owner, 'replacement-owner');
  assert.equal(h.reader.states.get('thread').revision, 1, 'a new owner may establish its own revision baseline with a snapshot');
});

test('poll retries an absent initial snapshot and a gap without requiring another incoming event', async t => {
  const h = harness(t); await h.poll();
  assert.deepEqual(h.sent.map(message => message.params.following), [true]);
  h.now(14999); await h.poll();
  assert.equal(h.sent.length, 1);
  h.now(15000); await h.poll();
  assert.deepEqual(h.sent.map(message => message.params.following), [true, false, true]);
  h.deliver(snapshot(conversation([questionItem()])));
  h.now(16000); h.deliver(patches([], 12, 11));
  assert.equal(h.reader.states.size, 0);
  assert.equal(h.sent.length, 3, 'a gap within the retry interval must not cause a request loop');
  h.now(19999); await h.poll();
  assert.equal(h.sent.length, 3);
  h.now(20000); await h.poll();
  assert.deepEqual(h.sent.map(message => message.params.following), [true, false, true, false, true]);
  h.deliver(snapshot(conversation([questionItem(), answerItem()]), 13));
  h.now(30000); await h.poll();
  assert.equal(h.sent.length, 5, 'a recovered state must stop snapshot retries');
});

test('attention events update LocalStatusReader immediately without starting any quota poll', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-attention-event-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let quotaPolls = 0;
  let changed = deferred();
  const reader = new LocalStatusReader({ home, codexHome: path.join(home, '.codex'),
    codexQuotaReader: { poll: async () => { quotaPolls++; throw new Error('An attention event must not poll quota'); } },
    onCodexActivity: value => changed.resolve(value) });
  const h = harness(t, { onChange: () => reader.updateCodexAttention() });
  reader.codexAttention = h.reader;
  reader.codexActivityContext = { rows: ['thread', 'working'].map(thread_id => ({ thread_id, status: 'inProgress',
    started_at: Math.floor(Date.now() / 1000) })), latest: null, detected: true, readable: true };
  await h.poll(['thread', 'working']);
  h.deliver(snapshot(conversation([questionItem()])));
  const waitingStatus = await within(changed.promise, 'attention callback did not arrive');
  assert.equal(waitingStatus.codex.activity, 'waiting');
  assert.equal(waitingStatus.codex.waitingTasks, 1);
  assert.equal(waitingStatus.codex.activeTasks, 1);
  assert.equal(quotaPolls, 0);
  changed = deferred();
  h.deliver(snapshot(conversation([questionItem(), answerItem()]), 11));
  const resumed = await within(changed.promise, 'answer callback did not arrive');
  assert.equal(resumed.codex.waitingTasks, 0);
  assert.equal(resumed.codex.waitingReason, undefined);
  assert.equal(resumed.codex.activeTasks, 2);
  assert.equal(quotaPolls, 0);
  assert.ok(!JSON.stringify(resumed).includes('PRIVATE'));
});

test('a slow quota response publishes the latest attention event rather than an earlier empty sample', async t => {
  const { DatabaseSync } = require('node:sqlite');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-attention-slow-quota-'));
  const codexHome = path.join(home, '.codex'); await fs.mkdir(codexHome);
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(codexHome, 'thread_history_1.sqlite'));
  try {
    db.exec('CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER); CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, created_at_ms INTEGER)');
    db.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?)').run('thread', 'turn', 'inProgress', Math.floor(Date.now() / 1000), null);
  } finally { db.close(); }
  const quota = deferred(), sampled = deferred();
  let polls = 0;
  const reader = new LocalStatusReader({ home, codexHome, codexQuotaReader: { poll: () => { polls++; return quota.promise; } } });
  const h = harness(t);
  const originalPoll = h.reader.poll.bind(h.reader);
  h.reader.poll = async (...args) => { const value = await originalPoll(...args); sampled.resolve(); return value; };
  reader.codexAttention = h.reader;
  const pendingStatus = reader.codex([{ command: '/synthetic/codex' }], true);
  await within(sampled.promise, 'local activity was not sampled');
  assert.equal(h.reader.summary().waitingThreads.size, 0);
  h.deliver(snapshot(conversation([questionItem()])));
  quota.resolve({ useLocal: true, detail: 'Synthetic quota response' });
  const status = await within(pendingStatus, 'quota collection did not finish');
  assert.equal(status.activity, 'waiting');
  assert.equal(status.waitingTasks, 1);
  assert.equal(status.activeTasks, 0);
  assert.equal(status.waitingReason, 'input');
  assert.equal(polls, 1);
});
