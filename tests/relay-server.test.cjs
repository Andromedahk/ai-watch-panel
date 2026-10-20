const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { AgentRelay, MAX_BODY } = require('../electron/relay/server.cjs');

// These real SDK clients are protocol simulators named Claude and Codex.
// They do not invoke Claude/Codex products and are not evidence of model or desktop-app compatibility.
const request = (to = 'codex', overrides = {}) => ({ to, subject: 'Synthetic compatibility check', purpose: 'Verify bounded task forwarding', instructions: 'Return a readable protocol acknowledgement. Do not access files or invoke services.', acceptanceCriteria: ['State protocol test only'], idempotencyKey: 'synthetic-protocol-0001', ...overrides });
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-relay-server-'));
  const relay = new AgentRelay({ directory, port: 0, ...options }); await relay.start();
  t.after(async () => { await relay.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { relay, directory };
}
async function client(t, relay, agent) {
  const config = relay.clientCredentials(agent);
  const instance = new Client({ name: agent === 'claude' ? 'Claude protocol simulator' : 'Codex protocol simulator', version: '1.0.0' });
  await instance.connect(new StreamableHTTPClientTransport(new URL(config.endpoint), { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } }));
  t.after(() => instance.close()); return instance;
}
async function call(instance, name, args = {}) {
  const result = await instance.callTool({ name, arguments: args });
  if (!result.structuredContent) return { ok: false, error: 'schema-rejected', raw: result };
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent); return result.structuredContent;
}
function raw(relay, { method = 'POST', headers = {}, payload = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', auth = 'claude', pathname = '/mcp' } = {}) {
  const endpoint = new URL(relay.getState().endpoint); const config = auth ? relay.clientCredentials(auth) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: endpoint.port, path: pathname, method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(config ? { Authorization: `Bearer ${config.token}` } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }); req.on('error', reject); req.end(payload);
  });
}

test('Claude and Codex SDK simulators exchange tasks, claim, question, answer and results in both directions', async t => {
  const { relay, directory } = await fixture(t);
  const claude = await client(t, relay, 'claude'), codex = await client(t, relay, 'codex');
  const tools = (await claude.listTools()).tools;
  assert.equal(tools.length, 9); assert.equal(tools.find(tool => tool.name === 'relay_inbox').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'relay_send_task').annotations.readOnlyHint, false);
  assert.equal(relay.getState().queuedTasks, 0);
  const sent = await call(claude, 'relay_send_task', request()); assert.equal(sent.task.from, 'claude');
  assert.equal((await call(codex, 'relay_inbox')).tasks[0].id, sent.task.id);
  assert.equal((await call(claude, 'relay_claim_task', { taskId: sent.task.id, purpose: 'Attempt wrong identity' })).error, 'recipient-required');
  assert.equal((await call(codex, 'relay_claim_task', { taskId: sent.task.id, purpose: 'Run bounded protocol check' })).task.status, 'running');
  await call(codex, 'relay_message', { taskId: sent.task.id, kind: 'question', purpose: 'Clarify protocol acceptance', text: 'Should I include the protocol limitation?' });
  await call(claude, 'relay_message', { taskId: sent.task.id, kind: 'answer', purpose: 'Answer acceptance question', text: 'Yes, state that no real model was called.' });
  const done = await call(codex, 'relay_report_result', { taskId: sent.task.id, status: 'completed', purpose: 'Report bounded protocol evidence', summary: 'Protocol exchange passed', details: 'Real MCP SDK transport used; no real Claude or Codex model called.' });
  assert.equal(done.task.status, 'completed');
  const back = await call(codex, 'relay_send_task', request('claude', { idempotencyKey: 'synthetic-protocol-reverse' }));
  await call(claude, 'relay_claim_task', { taskId: back.task.id, purpose: 'Verify reverse delivery' });
  assert.equal((await call(claude, 'relay_report_result', { taskId: back.task.id, status: 'completed', purpose: 'Report reverse delivery evidence', summary: 'Reverse protocol passed', details: 'Task routed from Codex simulator to Claude simulator.' })).task.status, 'completed');
  const transcript = await call(claude, 'relay_read_transcript', { taskId: sent.task.id });
  assert.match(transcript.markdown, /Clarify protocol acceptance/);
  assert.equal(relay.ownerListTasks().length, 2); assert.equal(relay.getState().queuedTasks, 0);
  const disk = await fs.readFile(path.join(directory, 'transcript.md'), 'utf8'); assert.match(disk, /Task routed from Codex simulator/);
  for (const id of ['claude', 'codex']) assert.ok(!disk.includes(relay.clientCredentials(id).token));
});

test('HTTP surface rejects unauthenticated, browser, hostile Host, method, path and oversized requests', async t => {
  const { relay } = await fixture(t);
  assert.equal((await raw(relay, { auth: null })).status, 401);
  assert.equal((await raw(relay, { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } })).status, 401);
  assert.equal((await raw(relay, { headers: { Host: 'attacker.invalid' } })).status, 403);
  assert.equal((await raw(relay, { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await raw(relay, { headers: { Origin: '' } })).status, 403);
  assert.equal((await raw(relay, { method: 'GET', payload: '' })).status, 405);
  assert.equal((await raw(relay, { method: 'DELETE', payload: '' })).status, 405);
  assert.equal((await raw(relay, { pathname: '/private' })).status, 404);
  assert.equal((await raw(relay, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await raw(relay, { payload: '{broken' })).status, 400);
  assert.equal((await raw(relay, { payload: '[]' })).status, 400);
  const large = await raw(relay, { payload: 'x'.repeat(MAX_BODY + 1) }); assert.equal(large.status, 413);
  assert.equal(large.headers['access-control-allow-origin'], undefined); assert.equal(large.headers['cache-control'], 'no-store');
  assert.equal(relay.getState().queuedTasks, 0);
});

test('MCP cannot forge sender, send secrets, read unknown tasks or continue terminal tasks', async t => {
  const { relay } = await fixture(t);
  const claude = await client(t, relay, 'claude'), codex = await client(t, relay, 'codex');
  const forged = await call(claude, 'relay_send_task', request('codex', { from: 'codex' })); assert.equal(forged.ok, false);
  const secret = await call(claude, 'relay_send_task', request('codex', { instructions: 'Bearer syntheticSensitiveTokenThatMustNotBeRecorded' }));
  assert.equal(secret.error, 'sensitive-content'); assert.equal(relay.getState().queuedTasks, 0);
  const sent = await call(claude, 'relay_send_task', request());
  assert.equal((await call(codex, 'relay_cancel_task', { taskId: sent.task.id, purpose: 'Attempt wrong cancellation identity' })).error, 'sender-required');
  await call(claude, 'relay_cancel_task', { taskId: sent.task.id, purpose: 'Withdraw synthetic task' });
  assert.equal((await call(codex, 'relay_claim_task', { taskId: sent.task.id, purpose: 'Attempt terminal task claim' })).error, 'task-closed');
  assert.equal((await call(claude, 'relay_get_task', { taskId: '00000000-0000-4000-8000-000000000000' })).error, 'task-unavailable');
});

test('server stop closes idle sockets and preserves task records and credentials across restart', async t => {
  const { relay, directory } = await fixture(t);
  const config = relay.clientCredentials('claude');
  const claude = await client(t, relay, 'claude');
  const sent = await call(claude, 'relay_send_task', request());
  const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(config.endpoint).port) });
  socket.on('error', error => { assert.equal(error.code, 'ECONNRESET'); });
  await new Promise(resolve => socket.once('connect', resolve));
  const socketClosed = new Promise(resolve => socket.once('close', resolve));
  await relay.stop(); await socketClosed; assert.equal(relay.getState().running, false);
  assert.throws(() => relay.clientCredentials('claude'), /unavailable/);
  assert.match(await fs.readFile(path.join(directory, 'transcript.md'), 'utf8'), /Synthetic compatibility check/);
  await relay.start(); assert.equal(relay.clientCredentials('claude').token, config.token);
  assert.equal(relay.ownerListTasks()[0].id, sent.task.id); assert.equal(relay.getState().queuedTasks, 1);
  const endpoint = new URL(relay.getState().endpoint); assert.equal(endpoint.hostname, '127.0.0.1');
});

test('concurrent lifecycle calls serialize and a busy port returns only a safe error code', async t => {
  const { relay, directory } = await fixture(t);
  await Promise.all([relay.stop(), relay.start(), relay.stop(), relay.start()]);
  assert.equal(relay.getState().running, true);
  const secondDirectory = path.join(directory, 'second-storage');
  const occupied = new AgentRelay({ directory: secondDirectory, port: Number(new URL(relay.getState().endpoint).port) });
  await assert.rejects(occupied.start(), error => error.code === 'port-in-use' && error.message === 'port-in-use');
  assert.equal(occupied.getState().running, false);
  assert.equal(occupied.getState().error, 'port-in-use');
});
