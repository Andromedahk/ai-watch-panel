const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AgentDispatcher, parseResultEnvelope } = require('../electron/relay/dispatcher.cjs');
const { ManagedCliRuntime, buildInvocation, createOutputParser, providerEnvironment,
  executable, boundedClaudeCandidates, writePrivateJson, RELAY_TOOLS, taskPrompt } = require('../electron/relay/provider-runtime.cjs');
const { classifyRuntimeError } = require('../electron/relay/provider-runtime.cjs');

async function temporary(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-relay-dispatch-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }
function task(to = 'codex', extra = {}) {
  return { id: crypto.randomUUID(), from: to === 'codex' ? 'claude' : 'codex', to,
    subject: 'Compatibility check', purpose: 'Verify one bounded relay exchange.', instructions: 'Reply with the test marker.',
    acceptanceCriteria: ['Return the marker as a readable final answer.'], sessionId: null,
    status: 'queued', createdAt: new Date().toISOString(), ...extra };
}
function relayStub(tasks) {
  const commands = [];
  return { commands, tasks, async ownerListTasks() { return tasks.map(item => ({ ...item })); },
    async clientCredentials(agentId) { return { agentId, endpoint: 'http://127.0.0.1:12345/mcp', token: 'not-a-provider-token' }; },
    async ownerCommand(actor, tool, args) {
      commands.push({ actor, tool, args });
      const item = tasks.find(candidate => candidate.id === args.taskId);
      if (!item || item.to !== actor) return { ok: false, error: 'forbidden' };
      if (tool === 'relay_claim_task') { if (item.status !== 'queued') return { ok: false, error: 'not-queued' }; item.status = 'running'; return { ok: true, task: { ...item } }; }
      if (tool === 'relay_message') return { ok: true, task: { ...item } };
      if (tool === 'relay_report_result') { if (item.status !== 'running') return { ok: false, error: 'not-running' }; item.status = args.status; item.result = { summary: args.summary, details: args.details }; return { ok: true, task: { ...item } }; }
      return { ok: false, error: 'unsupported' };
    } };
}
function answer(details = 'RELAY_OK', status = 'completed') { return JSON.stringify({ status, summary: 'Relay task result', details }); }
function runtimeStub(run = async () => ({ text: answer() })) {
  return { calls: [], cancellations: [], stopped: false,
    async discover() { return ['claude', 'codex'].map(id => ({ id, available: true, path: '/private/binary-must-not-leak' })); },
    async run(options) { this.calls.push(options); return run(options); },
    cancel(id) { this.cancellations.push(id); }, stop() { this.stopped = true; } };
}
async function settle(dispatcher) { await Promise.all([...dispatcher.active.values()].map(item => item.promise)); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('managed dispatcher starts disabled and exposes only safe provider metadata', async t => {
  const directory = await temporary(t), relay = relayStub([task()]), runtime = runtimeStub();
  const dispatcher = new AgentDispatcher({ relay, directory, runtime });
  await dispatcher.tick();
  assert.equal(runtime.calls.length, 0);
  assert.deepEqual(dispatcher.getState(), { agents: [{ id: 'claude', available: true, enabled: false, busy: false }, { id: 'codex', available: true, enabled: false, busy: false }] });
  assert.throws(() => dispatcher.setEnabledAgents(['other']), /invalid-agent/);
});

test('dispatcher considers up to 500 retained tasks so an older queued task is not starved', async t => {
  const directory = await temporary(t), oldTask = task('codex', { createdAt: '2026-01-01T00:00:00Z' });
  const tasks = [...Array.from({ length: 120 }, () => task('codex', { status: 'completed' })), oldTask];
  const relay = relayStub(tasks), original = relay.ownerListTasks.bind(relay), limits = [];
  relay.ownerListTasks = async options => { limits.push(options.limit); return (await original()).slice(0, options.limit); };
  const dispatcher = new AgentDispatcher({ relay, directory, runtime: runtimeStub() });
  dispatcher.setEnabledAgents(['codex']); await dispatcher.tick(); await settle(dispatcher);
  assert.equal(oldTask.status, 'completed'); assert.ok(limits.every(limit => limit === 500));
});

test('managed execution claims before launch and records the final answer with credential redaction', async t => {
  const directory = await temporary(t), item = task(), relay = relayStub([item]);
  const sessionId = crypto.randomUUID();
  const runtime = runtimeStub(async options => {
    assert.equal(item.status, 'running');
    await options.onSession(sessionId);
    return { text: answer('RELAY_OK not-a-provider-token'), sessionId };
  });
  const dispatcher = new AgentDispatcher({ relay, directory, runtime });
  dispatcher.setEnabledAgents(['codex']); await dispatcher.tick(); await settle(dispatcher);
  assert.equal(item.status, 'completed');
  assert.match(item.result.summary, /managed codex CLI/i);
  assert.match(item.result.details, /RELAY_OK \[relay credential removed\]/);
  assert.match(item.result.details, new RegExp(sessionId));
  assert.deepEqual(relay.commands.map(call => call.tool), ['relay_claim_task', 'relay_message', 'relay_report_result']);
  const filename = path.join(directory, 'managed-sessions.json');
  const binding = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(binding.sessions.codex.sessionId, sessionId);
  if (process.platform !== 'win32') assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  assert.equal(dispatcher.getState().agents[1].busy, false);
});

test('each enabled provider has at most one active task and tick does not block on the model', async t => {
  const directory = await temporary(t), a = task(), b = task(), c = task('claude');
  const pending = deferred(), relay = relayStub([a, b, c]), runtime = runtimeStub(() => pending.promise);
  const dispatcher = new AgentDispatcher({ relay, directory, runtime });
  dispatcher.setEnabledAgents(['codex', 'claude']); await dispatcher.tick(); await dispatcher.tick();
  assert.equal(runtime.calls.length, 2); assert.equal(b.status, 'queued');
  assert.deepEqual(dispatcher.getState().agents.map(agent => agent.busy), [true, true]);
  pending.resolve({ text: answer('done') }); await settle(dispatcher);
  await dispatcher.tick(); await settle(dispatcher); assert.equal(b.status, 'completed');
});

test('foreign session IDs are rejected and cannot resume user-owned conversations', async t => {
  const directory = await temporary(t), item = task('codex', { sessionId: crypto.randomUUID() });
  const runtime = runtimeStub(), dispatcher = new AgentDispatcher({ relay: relayStub([item]), directory, runtime });
  dispatcher.setEnabledAgents(['codex']); await dispatcher.tick();
  assert.equal(runtime.calls.length, 0); assert.equal(item.status, 'failed');
  assert.match(item.result.details, /never taken over/);
  assert.equal(dispatcher.getState().agents[1].lastError, 'unmanaged-session');
});

test('a persisted dedicated session can be resumed and no other session is accepted', async t => {
  const directory = await temporary(t), sessionId = crypto.randomUUID();
  await writePrivateJson(path.join(directory, 'managed-sessions.json'), { version: 1, owner: 'ai-watch-managed-relay', sessions: { claude: { sessionId, createdAt: new Date().toISOString() } } });
  const item = task('claude', { sessionId }), runtime = runtimeStub(options => { assert.equal(options.sessionId, sessionId); return { text: answer('resumed') }; });
  const dispatcher = new AgentDispatcher({ relay: relayStub([item]), directory, runtime });
  dispatcher.setEnabledAgents(['claude']); await dispatcher.tick(); await settle(dispatcher);
  assert.equal(item.status, 'completed');
});

test('malformed or broadly readable session bindings fail closed', async t => {
  const directory = await temporary(t), filename = path.join(directory, 'managed-sessions.json');
  await fs.writeFile(filename, '{"version":1,"sessions":{}}', { mode: 0o600 });
  const item = task(), runtime = runtimeStub(), dispatcher = new AgentDispatcher({ relay: relayStub([item]), directory, runtime });
  dispatcher.setEnabledAgents(['codex']); await dispatcher.tick();
  assert.equal(runtime.calls.length, 0); assert.equal(item.status, 'queued');
  assert.equal(dispatcher.getState().agents[1].lastError, 'session-binding-invalid');
});

test('sender cancellation terminates the managed process and cannot be overwritten by its answer', async t => {
  const directory = await temporary(t), item = task(), pending = deferred(), relay = relayStub([item]);
  const runtime = runtimeStub(() => pending.promise);
  const dispatcher = new AgentDispatcher({ relay, directory, runtime });
  dispatcher.setEnabledAgents(['codex']); await dispatcher.tick();
  item.status = 'cancelled'; await dispatcher.tick();
  assert.deepEqual(runtime.cancellations, ['codex']);
  pending.resolve({ text: 'too late' }); await settle(dispatcher);
  assert.equal(item.status, 'cancelled');
  assert.equal(relay.commands.filter(call => call.tool === 'relay_report_result').length, 0);
});

test('a result already submitted by the model through MCP is never reported twice', async t => {
  const directory = await temporary(t), item = task(), relay = relayStub([item]);
  const runtime = runtimeStub(async () => { await relay.ownerCommand('codex', 'relay_report_result', { taskId: item.id, status: 'completed', purpose: 'Report the actual test result.', summary: 'MCP report', details: 'RELAY_OK' }); return { text: 'final duplicate', errorCode: 'runtime-failed' }; });
  const dispatcher = new AgentDispatcher({ relay, directory, runtime });
  dispatcher.setEnabledAgents(['codex']); await dispatcher.tick(); await settle(dispatcher);
  assert.equal(item.result.summary, 'MCP report');
  assert.equal(relay.commands.filter(call => call.tool === 'relay_report_result').length, 1);
});

test('a failed claim never launches a process', async t => {
  const directory = await temporary(t), runtime = runtimeStub(), relay = relayStub([task()]);
  relay.ownerCommand = async () => ({ ok: false, error: 'not-queued' });
  const dispatcher = new AgentDispatcher({ relay, directory, runtime });
  dispatcher.setEnabledAgents(['codex']); await dispatcher.tick();
  assert.equal(runtime.calls.length, 0); assert.equal(dispatcher.getState().agents[1].lastError, 'task-claim-failed');
});

test('empty final answers and runtime failures are truthful failed outcomes', async t => {
  for (const outcome of [{}, { errorCode: 'runtime-timeout' }, { errorCode: '/private/secret/error' }]) {
    const directory = await temporary(t), item = task(), runtime = runtimeStub(async () => outcome);
    const dispatcher = new AgentDispatcher({ relay: relayStub([item]), directory, runtime });
    dispatcher.setEnabledAgents(['codex']); await dispatcher.tick(); await settle(dispatcher);
    assert.equal(item.status, 'failed'); assert.doesNotMatch(JSON.stringify(dispatcher.getState()), /private/);
  }
});

test('only a strict result envelope can serve as a verified fallback result', async t => {
  for (const plainText of ['All done.', 'Failed because relay MCP tools are unavailable.', '{"status":"completed","summary":"okay","details":"done","extra":true}']) {
    const directory = await temporary(t), item = task(), runtime = runtimeStub(async () => ({ text: plainText }));
    const dispatcher = new AgentDispatcher({ relay: relayStub([item]), directory, runtime });
    dispatcher.setEnabledAgents(['codex']); await dispatcher.tick(); await settle(dispatcher);
    assert.equal(item.status, 'failed'); assert.equal(dispatcher.getState().agents[1].lastError, 'unverified-result');
    assert.ok(item.result.details.includes(plainText));
  }
  const directory = await temporary(t), item = task(), runtime = runtimeStub(async () => ({ text: answer('MCP tools were not available.', 'failed') }));
  const dispatcher = new AgentDispatcher({ relay: relayStub([item]), directory, runtime });
  dispatcher.setEnabledAgents(['codex']); await dispatcher.tick(); await settle(dispatcher);
  assert.equal(item.status, 'failed'); assert.equal(item.result.details, 'MCP tools were not available.');
  assert.equal(parseResultEnvelope('```json\n' + answer() + '\n```'), null);
  assert.equal(parseResultEnvelope('{"status":"unknown","summary":"x","details":"x"}'), null);
});

test('stop cancels only managed runtime work and records failure before the relay closes', async t => {
  const directory = await temporary(t), item = task(), pending = deferred(), runtime = runtimeStub(() => pending.promise);
  runtime.cancel = function (id) { this.cancellations.push(id); pending.resolve({ errorCode: 'runtime-cancelled' }); };
  const dispatcher = new AgentDispatcher({ relay: relayStub([item]), directory, runtime });
  dispatcher.setEnabledAgents(['codex']); await dispatcher.tick(); await dispatcher.stop();
  assert.equal(item.status, 'failed'); assert.equal(runtime.stopped, true); assert.deepEqual(runtime.cancellations, ['codex']);
});

test('shutdown waits for an in-flight claim and cannot leave a late unmanaged execution', async t => {
  const directory = await temporary(t), item = task(), relay = relayStub([item]), claim = deferred();
  const originalCommand = relay.ownerCommand.bind(relay);
  let claimStarted = false;
  relay.ownerCommand = async (actor, tool, args) => {
    if (tool === 'relay_claim_task') { claimStarted = true; await claim.promise; }
    return originalCommand(actor, tool, args);
  };
  const runtime = runtimeStub(), dispatcher = new AgentDispatcher({ relay, directory, runtime });
  dispatcher.setEnabledAgents(['codex']);
  const ticking = dispatcher.tick();
  while (!claimStarted) await new Promise(resolve => setImmediate(resolve));
  const stopped = dispatcher.stop(); claim.resolve();
  await ticking; await stopped;
  assert.equal(runtime.calls.length, 0); assert.equal(item.status, 'failed');
});

test('fixture mode never discovers or launches real clients', async t => {
  const directory = await temporary(t), item = task();
  const dispatcher = new AgentDispatcher({ relay: relayStub([item]), directory, fixtureMode: true });
  dispatcher.setEnabledAgents(['claude', 'codex']); await dispatcher.tick();
  assert.equal(item.status, 'queued'); assert.deepEqual(dispatcher.getState().agents.map(agent => agent.available), [false, false]);
});

test('runtime invocation disables external configuration and never places credentials in argv', () => {
  const options = { binary: '/official/cli', taskId: crypto.randomUUID(), sessionId: crypto.randomUUID(), credentialFile: '/private/runtime/credential.json', mcpFile: '/private/runtime/mcp.json', workDirectory: '/private/work', nodePath: '/official/node', stdioPath: '/app/stdio.cjs' };
  const claude = buildInvocation({ agentId: 'claude', ...options });
  assert.ok(claude.args.includes('--strict-mcp-config')); assert.ok(claude.args.includes('--restricted'));
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '');
  assert.ok(claude.args.includes('--resume')); assert.ok(!claude.args.join(' ').includes('bypass'));
  assert.equal(Object.keys(claude.mcpConfig.mcpServers).join(','), 'ai_watch_relay');
  assert.deepEqual(claude.mcpConfig.mcpServers.ai_watch_relay.args.slice(-2), ['--task', options.taskId]);
  const codex = buildInvocation({ agentId: 'codex', ...options });
  assert.ok(codex.args.includes('--ignore-user-config')); assert.ok(codex.args.includes('--ignore-rules'));
  assert.ok(codex.args.includes('read-only')); assert.ok(codex.args.includes('features.shell_tool=false'));
  assert.ok(codex.args.includes('features.apps=false')); assert.ok(codex.args.includes('features.plugins=false'));
  assert.ok(codex.args.includes('features.view_image=false'));
  assert.ok(codex.args.includes('features.code_mode=false'));
  assert.ok(!codex.args.some(value => value.startsWith('features.code_mode_host=')));
  assert.ok(!codex.args.some(value => value.startsWith('tools.view_image=')));
  assert.ok(codex.args.includes('web_search="disabled"'));
  assert.ok(codex.args.some(value => value.startsWith('mcp_servers=') && value.includes('ai_watch_relay')));
  assert.ok(codex.args.some(value => value.startsWith('mcp_servers=') && value.includes(`"--task","${options.taskId}"`)));
  assert.ok(codex.args.includes('resume')); assert.ok(!codex.args.join(' ').includes('dangerously'));
  assert.throws(() => buildInvocation({ agentId: 'codex', ...options, taskId: null }), /invalid-task/);
  const env = providerEnvironment({ PATH: '/bin', HOME: '/private/home', ANTHROPIC_AUTH_TOKEN: 'secret', OPENAI_API_KEY: 'secret', CODEX_THREAD_ID: 'foreign', NODE_OPTIONS: '--require untrusted' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/private/home' });
});

test('task prompt permits scoped native MCP transport without authorizing shell or local I/O', () => {
  const item = task(), prompt = taskPrompt(item);
  assert.ok(prompt.includes('First verify the connection by actually calling relay_get_task'));
  assert.ok(prompt.includes(JSON.stringify({ taskId: item.id })));
  assert.ok(prompt.includes('client-provided native tool-discovery mechanism and tool-call transport wrapper'));
  assert.ok(prompt.includes('solely to discover and invoke the current task-scoped ai_watch_relay tools'));
  assert.ok(prompt.includes('Do not run shell commands or arbitrary code, perform local filesystem or environment I/O'));
  assert.ok(prompt.includes('Absence from the initial visible tool list alone does not prove unavailability'));
  assert.ok(prompt.includes('strict JSON object'));
});

test('output parsing retains final assistant text only, never raw tools, reasoning or credentials', () => {
  const sessionId = crypto.randomUUID(), parser = createOutputParser('codex');
  parser.line(JSON.stringify({ type: 'thread.started', thread_id: sessionId }));
  parser.line(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } }));
  parser.line(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'ai_watch_relay', tool: 'relay_get_task', result: { raw: 'private tool output' } } }));
  parser.line(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'RELAY_OK' } }));
  parser.line(JSON.stringify({ type: 'turn.completed' }));
  assert.deepEqual(parser.result(), { text: 'RELAY_OK', sessionId });
  const claude = createOutputParser('claude', { expectedSessionId: sessionId });
  claude.line(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, tools: RELAY_TOOLS.map(name => `mcp__ai_watch_relay__${name}`) }));
  claude.line(JSON.stringify({ type: 'result', session_id: sessionId, is_error: false, result: 'CLAUDE_OK' }));
  assert.deepEqual(claude.result(), { text: 'CLAUDE_OK', sessionId });
});

test('nonrelay tool attempts and session mismatches fail closed', () => {
  const codex = createOutputParser('codex');
  codex.line(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'private command text' } }));
  assert.equal(codex.errorCode, 'forbidden-tool');
  const claude = createOutputParser('claude');
  claude.line(JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash'] }));
  assert.equal(claude.errorCode, 'forbidden-tool');
  const mismatch = createOutputParser('codex', { expectedSessionId: crypto.randomUUID() });
  mismatch.line(JSON.stringify({ type: 'thread.started', thread_id: crypto.randomUUID() }));
  assert.equal(mismatch.errorCode, 'session-mismatch');
  const malformed = createOutputParser('codex'); malformed.line('not json');
  assert.equal(malformed.errorCode, 'invalid-output');
});

test('provider diagnostics collapse into safe enums and never export raw errors', () => {
  assert.equal(classifyRuntimeError("error: unexpected argument '--old-flag'"), 'unsupported-cli');
  assert.equal(classifyRuntimeError('unknown field `private_setting` in configuration'), 'config-invalid');
  assert.equal(classifyRuntimeError('Not logged in. Please run /login. /private/user/token=secret'), 'auth-required');
  assert.equal(classifyRuntimeError({ code: 'rate_limit_exceeded', message: 'private detail' }), 'rate-limited');
  assert.equal(classifyRuntimeError({ error: { code: 'model_not_found' } }), 'model-unavailable');
  assert.equal(classifyRuntimeError('ECONNREFUSED 127.0.0.1 private path'), 'network-unavailable');
  assert.equal(classifyRuntimeError('Permission denied'), 'permission-denied');
  assert.equal(classifyRuntimeError('Session UUID not found'), 'session-unavailable');
  assert.equal(classifyRuntimeError('unknown private error'), 'runtime-failed');
  const claude = createOutputParser('claude');
  claude.line(JSON.stringify({ type: 'result', is_error: true, errors: ['Not logged in'], result: 'private diagnostic' }));
  assert.equal(claude.result().errorCode, 'auth-required');
  assert.equal(claude.result().text, '');
});

test('Codex startup error diagnostics do not cancel a subsequently completed turn', () => {
  const parser = createOutputParser('codex'), sessionId = crypto.randomUUID();
  parser.line(JSON.stringify({ type: 'error', message: 'Under-development features enabled: skip_host_skill_discovery.' }));
  parser.line(JSON.stringify({ type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled.' }));
  assert.equal(parser.errorCode, null);
  parser.line(JSON.stringify({ type: 'thread.started', thread_id: sessionId }));
  parser.line(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'RELAY_OK' } }));
  parser.line(JSON.stringify({ type: 'turn.completed' }));
  assert.deepEqual(parser.result(), { text: 'RELAY_OK', sessionId });
  parser.line(JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }));
  assert.equal(parser.errorCode, 'forbidden-tool');
});

test('Codex turn.failed remains fatal and preserves safe preceding diagnostics', () => {
  const parser = createOutputParser('codex');
  parser.line(JSON.stringify({ type: 'error', message: 'Not logged in; please run /login' }));
  assert.equal(parser.errorCode, null);
  parser.line(JSON.stringify({ type: 'turn.failed', error: {} }));
  assert.equal(parser.errorCode, 'auth-required');
});

function fakeProcess() {
  const child = new EventEmitter();
  child.pid = 99999999; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { child.signals.push(signal); queueMicrotask(() => child.emit('close', 1)); return true; };
  child.signals = [];
  return child;
}
async function runtimeForTest(t, spawnImpl, overrides = {}) {
  const runtime = new ManagedCliRuntime({ spawnImpl, platform: 'win32',
    discoverImpl: async () => [{ id: 'codex', available: true, path: '/official/codex' }],
    execFileImpl: async () => ({ stdout: '--ignore-user-config --ignore-rules --strict-config --sandbox --json' }), ...overrides });
  await runtime.discover();
  const workDirectory = await temporary(t);
  return { runtime, options: { agentId: 'codex', task: task(), credentials: { agentId: 'codex', endpoint: 'http://127.0.0.1:12345/mcp', token: 'test-token' }, workDirectory } };
}

test('runtime launches with shell false, extracts UTF-8 final output and removes temporary credentials', async t => {
  const child = fakeProcess(); let launch;
  const { runtime, options } = await runtimeForTest(t, (command, args, spawnOptions) => {
    launch = { command, args, spawnOptions };
    child.stdin.on('finish', () => {
      const sessionId = crypto.randomUUID();
      const data = Buffer.from(`${JSON.stringify({ type: 'thread.started', thread_id: sessionId })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '测试通过' } })}\n${JSON.stringify({ type: 'turn.completed' })}\n`);
      const cut = data.indexOf(Buffer.from('测试')) + 1;
      child.stdout.write(data.subarray(0, cut)); child.stdout.write(data.subarray(cut));
      child.stderr.write('private diagnostic must not be recorded'); child.emit('close', 0);
    });
    return child;
  });
  const result = await runtime.run(options);
  assert.equal(result.text, '测试通过'); assert.equal(launch.spawnOptions.shell, false);
  assert.deepEqual(await fs.readdir(path.join(options.workDirectory, '.runtime')), []);
  assert.equal(runtime.active.size, 0);
});

test('runtime cancellation and output bounds terminate only its tracked child', async t => {
  const child = fakeProcess(), { runtime, options } = await runtimeForTest(t, () => child);
  const pending = runtime.run(options);
  while (!runtime.active.get('codex')?.child) await new Promise(resolve => setImmediate(resolve));
  runtime.cancel('unrelated'); assert.deepEqual(child.signals, []);
  runtime.cancel('codex');
  assert.equal((await pending).errorCode, 'runtime-cancelled'); assert.deepEqual(child.signals, ['SIGTERM']);
  const flood = fakeProcess(), second = await runtimeForTest(t, () => flood, { maxOutputBytes: 1024 });
  const flooding = second.runtime.run(second.options);
  while (!second.runtime.active.get('codex')?.child) await new Promise(resolve => setImmediate(resolve));
  flood.stdout.write(Buffer.alloc(2048, 65));
  assert.equal((await flooding).errorCode, 'output-limit');
});

test('stderr authentication errors return a safe code without retaining private diagnostics', async t => {
  const child = fakeProcess();
  child.stdin.on('finish', () => { child.stderr.write('Not logged in. Please run /login. /private/user secret'); child.emit('close', 1); });
  const { runtime, options } = await runtimeForTest(t, () => child);
  assert.deepEqual(await runtime.run(options), { errorCode: 'auth-required' });
});

test('a cancellation during private-file preparation cannot start a late process', async t => {
  let spawned = false;
  const { runtime, options } = await runtimeForTest(t, () => { spawned = true; return fakeProcess(); });
  const pending = runtime.run(options);
  runtime.cancel('codex');
  assert.equal((await pending).errorCode, 'runtime-cancelled');
  assert.equal(spawned, false);
  assert.deepEqual(await fs.readdir(path.join(options.workDirectory, '.runtime')), []);
});

test('timeout escalates only the tracked child when graceful termination is ignored', async t => {
  const child = fakeProcess();
  child.kill = signal => { child.signals.push(signal); if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', 1)); return true; };
  const { runtime, options } = await runtimeForTest(t, () => child, { timeoutMs: 50 });
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    const result = await runtime.run(options);
    assert.equal(result.errorCode, 'runtime-timeout'); assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  } finally { clearTimeout(keepAlive); }
});

test('runtime validates required security flags before making a client available', async () => {
  const runtime = new ManagedCliRuntime({ discoverImpl: async () => [{ id: 'claude', available: true, path: '/official/claude' }], execFileImpl: async () => ({ stdout: '--print --tools' }) });
  const result = await runtime.discover();
  assert.equal(result[0].available, false); assert.equal(result[0].lastError, 'unsupported-cli');
  assert.doesNotMatch(JSON.stringify(result), /official/);
});

test('executable validation rejects a Linux VM CLI on macOS and bounded discovery ignores symlinks', async t => {
  const directory = await temporary(t), elf = path.join(directory, 'vm-claude'), native = path.join(directory, 'claude');
  await fs.writeFile(elf, Buffer.from('7f454c4600000000', 'hex'), { mode: 0o755 });
  await fs.writeFile(native, Buffer.from('cffaedfe00000000', 'hex'), { mode: 0o755 });
  assert.equal(await executable(elf, 'darwin'), null); assert.equal(await executable(native, 'darwin'), await fs.realpath(native));
  await fs.mkdir(path.join(directory, 'nested')); await fs.symlink(native, path.join(directory, 'nested', 'claude'));
  assert.deepEqual(await boundedClaudeCandidates(directory), [native]);
});
