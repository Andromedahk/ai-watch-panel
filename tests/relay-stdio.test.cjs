const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { AgentRelay } = require('../electron/relay/server.cjs');
const { exportClientConfiguration } = require('../electron/relay/client-config.cjs');

test('Claude-compatible stdio and Codex-compatible HTTP share one durable task mailbox', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-relay-stdio-'));
  const relay = new AgentRelay({ directory: path.join(root, 'store'), port: 0 });
  const client = new Client({ name: 'claude-stdio-protocol-test', version: '1.0.0' });
  t.after(async () => { await client.close().catch(() => {}); await relay.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  await relay.start();
  const files = await exportClientConfiguration({ relay, agentId: 'claude', directory: path.join(root, 'connections') });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve('electron/relay/stdio.cjs'), '--credentials', files.credentialFile], stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', value => { stderr = (stderr + value).slice(-4096); });
  await client.connect(transport, { timeout: 10000 });
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 9);
  const sent = await client.callTool({ name: 'relay_send_task', arguments: { to: 'codex', subject: 'Protocol interoperability check',
    purpose: 'Verify that standard local MCP transports can exchange one necessary task.', instructions: 'Return the number five.',
    acceptanceCriteria: ['The readable result contains five.'], idempotencyKey: 'stdio-protocol-one' } });
  assert.equal(sent.structuredContent.ok, true);
  const taskId = sent.structuredContent.task.id;
  await relay.ownerCommand('codex', 'relay_claim_task', { taskId, purpose: 'Execute the protocol interoperability task.' });
  await relay.ownerCommand('codex', 'relay_report_result', { taskId, status: 'completed',
    purpose: 'Return the requested fixed outcome to the requesting agent.', summary: 'Completed the protocol check.', details: 'five' });
  const result = await client.callTool({ name: 'relay_get_task', arguments: { taskId } });
  assert.equal(result.structuredContent.task.status, 'completed');
  assert.equal(result.structuredContent.task.result.details, 'five');
  const transcript = await relay.ownerReadTranscript(taskId);
  assert.match(transcript, /Protocol interoperability check/); assert.match(transcript, /five/);
  for (const actor of ['claude', 'codex']) assert.ok(!transcript.includes((await relay.clientCredentials(actor)).token));
  const denied = await client.callTool({ name: 'relay_report_result', arguments: { taskId, status: 'completed',
    purpose: 'A sender cannot impersonate the task recipient.', summary: 'not accepted', details: 'not accepted' } });
  assert.equal(denied.structuredContent.ok, false);
  assert.ok(!stderr.includes(files.credentialFile));
});

test('managed stdio scope forces every delegation into the current parent chain and limits task access', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-relay-scoped-'));
  const relay = new AgentRelay({ directory: path.join(root, 'store'), port: 0 });
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close().catch(() => {}); await relay.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  await relay.start();
  const payload = (to, idempotencyKey) => ({ to, subject: 'Synthetic managed delegation', purpose: 'Verify the bounded managed delegation scope.', instructions: 'Return protocol evidence only. No models are invoked.', acceptanceCriteria: ['Keep a real task parent link.'], idempotencyKey });
  const parent = await relay.ownerCommand('codex', 'relay_send_task', payload('claude', 'scoped-root-task'));
  const unrelated = await relay.ownerCommand('codex', 'relay_send_task', payload('claude', 'scoped-unrelated-task'));
  async function scoped(agent, taskId) {
    await relay.ownerCommand(agent, 'relay_claim_task', { taskId, purpose: 'Claim the synthetic managed test task.' });
    const files = await exportClientConfiguration({ relay, agentId: agent, directory: path.join(root, 'connections') });
    const client = new Client({ name: `managed-${agent}-protocol-test`, version: '1.0.0' }); clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.resolve('electron/relay/stdio.cjs'), '--credentials', files.credentialFile, '--task', taskId], stderr: 'pipe' });
    await client.connect(transport, { timeout: 10000 }); return client;
  }
  async function invoke(client, name, args = {}) { return (await client.callTool({ name, arguments: args })).structuredContent; }
  const claude = await scoped('claude', parent.task.id);
  assert.deepEqual((await claude.listTools()).tools.map(tool => tool.name).sort(), ['relay_list_agents', 'relay_send_task', 'relay_get_task', 'relay_read_transcript', 'relay_message', 'relay_report_result'].sort());
  for (const name of ['relay_claim_task', 'relay_inbox', 'relay_cancel_task']) assert.equal((await invoke(claude, name, { taskId: parent.task.id, purpose: 'Attempt a prohibited scoped tool.' })).error, 'task-scope-denied');
  for (const name of ['relay_get_task', 'relay_read_transcript']) assert.equal((await invoke(claude, name, { taskId: unrelated.task.id })).error, 'task-scope-denied');
  assert.equal((await invoke(claude, 'relay_get_task', { taskId: parent.task.id })).ok, true);
  const child = await invoke(claude, 'relay_send_task', payload('codex', 'scoped-child-task'));
  assert.equal(child.ok, true); assert.equal(child.task.parentTaskId, parent.task.id);
  assert.equal((await invoke(claude, 'relay_get_task', { taskId: child.task.id })).ok, true);
  assert.equal((await invoke(claude, 'relay_read_transcript', { taskId: child.task.id })).ok, true);
  assert.equal((await invoke(claude, 'relay_message', { taskId: child.task.id, kind: 'progress', purpose: 'Attempt to modify a delegated task.', text: 'Not allowed.' })).error, 'task-scope-denied');
  assert.equal((await invoke(claude, 'relay_report_result', { taskId: child.task.id, status: 'completed', purpose: 'Attempt a delegated task result.', summary: 'Not allowed', details: 'Not allowed' })).error, 'task-scope-denied');
  assert.equal((await invoke(claude, 'relay_send_task', { ...payload('codex', 'scoped-foreign-parent'), parentTaskId: unrelated.task.id })).error, 'task-scope-denied');
  const codex = await scoped('codex', child.task.id);
  const grandchild = await invoke(codex, 'relay_send_task', payload('claude', 'scoped-grandchild-task'));
  assert.equal(grandchild.task.parentTaskId, child.task.id);
  const claudeAtLimit = await scoped('claude', grandchild.task.id);
  const beyondLimit = await invoke(claudeAtLimit, 'relay_send_task', payload('codex', 'scoped-attempt-new-root'));
  assert.equal(beyondLimit.ok, false); assert.equal(beyondLimit.error, 'parent-depth');
  assert.equal(relay.ownerListTasks().length, 4);
  assert.match(relay.ownerReadTranscript(child.task.id), new RegExp(`Parent task: ${parent.task.id}`));
});

test('managed stdio startup rejects a scope that is not a claimed recipient task', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-relay-scope-denied-'));
  const relay = new AgentRelay({ directory: path.join(root, 'store'), port: 0 });
  const client = new Client({ name: 'invalid-managed-scope-test', version: '1.0.0' });
  t.after(async () => { await client.close().catch(() => {}); await relay.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  await relay.start();
  const sent = await relay.ownerCommand('codex', 'relay_send_task', { to: 'claude', subject: 'Unclaimed task scope', purpose: 'Verify the managed startup claim boundary.', instructions: 'No task execution.', acceptanceCriteria: ['Scope is denied until claimed.'], idempotencyKey: 'scope-startup-unclaimed' });
  const files = await exportClientConfiguration({ relay, agentId: 'claude', directory: path.join(root, 'connections') });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve('electron/relay/stdio.cjs'), '--credentials', files.credentialFile, '--task', sent.task.id], stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
  await assert.rejects(client.connect(transport, { timeout: 10000 }));
  assert.equal(relay.ownerListTasks()[0].status, 'queued'); assert.match(stderr, /relay connection unavailable/i);
  assert.ok(!stderr.includes(files.credentialFile));
});
