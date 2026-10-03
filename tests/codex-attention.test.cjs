const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { CodexAttentionReader, applyAttentionChange, summarizeAttention } = require('../electron/codex-attention.cjs');
const { LocalStatusReader } = require('../electron/local-status.cjs');
const snapshot = requests => ({ type: 'snapshot', revision: 10, conversationState: { requests, title: 'PRIVATE_TITLE', turns: ['PRIVATE_CONTENT'] } });
const request = method => ({ method, id: 'PRIVATE_ID', params: { questions: ['PRIVATE_QUESTION'], command: 'PRIVATE_COMMAND' } });

test('Codex attention detects questions and all supported approvals without retaining their payload', () => {
  const methods = ['item/tool/requestUserInput', 'item/tool/requestOptionPicker', 'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval'];
  for (const method of methods) {
    const state = applyAttentionChange(null, snapshot([request(method)]));
    const result = summarizeAttention(new Map([['thread', state]]));
    assert.equal(result.waitingThreads.size, 1);
    assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  }
  assert.equal(summarizeAttention(new Map([['thread', applyAttentionChange(null, snapshot([request('item/tool/call')]))]])).waitingThreads.size, 0);
});

test('Codex answers/removals clear red state; missed revisions discard stale requests', () => {
  const before = applyAttentionChange(null, snapshot([request('item/tool/requestUserInput'), request('item/fileChange/requestApproval')]));
  const after = applyAttentionChange(before, { type: 'patches', baseRevision: 10, revision: 11,
    patches: [{ op: 'remove', path: ['requests', 0] }, { op: 'replace', path: ['turns', 0, 'content'], value: 'PRIVATE' }] });
  let status = summarizeAttention(new Map([['thread', after]]));
  assert.equal(status.inputThreads.size, 0); assert.equal(status.approvalThreads.size, 1);
  const empty = applyAttentionChange(after, { type: 'patches', baseRevision: 11, revision: 12, patches: [{ op: 'replace', path: '/requests', value: [] }] });
  assert.equal(summarizeAttention(new Map([['thread', empty]])).waitingThreads.size, 0);
  assert.equal(applyAttentionChange(before, { type: 'patches', baseRevision: 9, revision: 11, patches: [] }), null);
  assert.equal(applyAttentionChange(null, snapshot(Array(257).fill({}))), null);
});

test('Codex local subscription accepts fragmented frames, only subscribes and clears on disconnect', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-ipc-'));
  const dir = path.join(home, 'ipc'); await fs.mkdir(dir, { mode: 0o700 });
  const server = net.createServer(); let peer; const writes = [];
  const send = (socket, message) => {
    const data = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(data.length);
    socket.write(header.subarray(0, 2)); socket.write(Buffer.concat([header.subarray(2), data]));
  };
  server.on('connection', socket => {
    peer = socket; let buffer = Buffer.alloc(0);
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0), m = JSON.parse(buffer.subarray(4, 4 + length)); buffer = buffer.subarray(4 + length); writes.push(m);
        if (m.method === 'initialize') send(socket, { type: 'response', method: 'initialize', resultType: 'success', result: { clientId: 'monitor' } });
        if (m.method === 'thread-stream-following-changed' && m.params.following) send(socket, { type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner',
          params: { hostId: 'local', conversationId: 'thread', change: snapshot([request('item/tool/requestUserInput')]) } });
      }
    });
  });
  await new Promise(resolve => server.listen(path.join(dir, 'ipc.sock'), resolve));
  const reader = new CodexAttentionReader({ codexHome: home });
  const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('IPC state timed out'); };
  try {
    await reader.poll(['thread'], true); await until(() => reader.states.size === 1);
    assert.equal((await reader.poll(['thread'], true)).inputThreads.size, 1);
    assert.ok(!JSON.stringify([...reader.states]).includes('PRIVATE'));
    send(peer, { type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner',
      params: { hostId: 'local', conversationId: 'thread', change: { type: 'patches', baseRevision: 10, revision: 11, patches: [{ op: 'remove', path: ['requests', 0] }] } } });
    await until(() => reader.states.get('thread')?.revision === 11);
    assert.equal((await reader.poll(['thread'], true)).waitingThreads.size, 0);
    assert.ok(writes.every(m => ['initialize', 'thread-stream-following-changed'].includes(m.method)));
    peer.destroy(); await until(() => reader.socket === null); assert.equal(reader.states.size, 0);
  } finally { reader.close(); peer?.destroy(); await new Promise(r => server.close(r)); await fs.rm(home, { recursive: true, force: true }); }
});

test('Codex red attention takes priority while unrelated running jobs remain counted', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-attention-count-')); const codexHome = path.join(home, '.codex'); await fs.mkdir(codexHome);
  const db = new DatabaseSync(path.join(codexHome, 'thread_history_1.sqlite'));
  try {
    db.exec('CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER); CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, created_at_ms INTEGER)');
    const time = Math.floor(Date.now() / 1000);
    for (const id of ['waiting', 'working']) db.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?)').run(id, 'turn', 'inProgress', time, null);
    const reader = new LocalStatusReader({ codexQuotaReader: { poll: async () => ({ useLocal: true, detail: '合成本地记录' }) }, home, codexHome });
    reader.codexAttention = { poll: async () => ({ inputThreads: new Set(['waiting']), approvalThreads: new Set(), waitingThreads: new Set(['waiting']), connected: true, observedThreads: 2 }) };
    const status = await reader.codex([{ command: '/app/codex' }], true);
    assert.equal(status.activity, 'waiting'); assert.equal(status.activeTasks, 1); assert.equal(status.waitingTasks, 1); assert.equal(status.waitingReason, 'input');
    assert.ok(!JSON.stringify(status).includes('working'));
  } finally { db.close(); await fs.rm(home, { recursive: true, force: true }); }
});
