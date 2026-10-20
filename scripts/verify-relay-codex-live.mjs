// Explicit live Codex test with a protocol peer; this does not impersonate a Claude model.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { AgentRelay } = require('../electron/relay/server.cjs');
const { AgentDispatcher } = require('../electron/relay/dispatcher.cjs');
const { exportClientConfiguration } = require('../electron/relay/client-config.cjs');
if (process.env.AI_WATCH_LIVE_RELAY !== '1') throw new Error('Set AI_WATCH_LIVE_RELAY=1 to execute two bounded Codex model turns.');
const runId = randomUUID(), directory = path.resolve('.local/qa/relay-codex-live', runId);
const relay = new AgentRelay({ directory, port: 0 });
const dispatcher = new AgentDispatcher({ relay, directory: path.join(directory, 'managed') });
const peer = new Client({ name: 'human-initiated-claude-protocol-peer-not-a-model', version: '1.0.0' });
const results = [];
let report;
async function call(name, args) {
  const response = await peer.callTool({ name, arguments: args });
  if (!response.structuredContent?.ok) throw new Error('protocol-peer-operation-failed');
  return response.structuredContent;
}
async function wait(taskId) {
  const deadline = Date.now() + 140000;
  while (Date.now() < deadline) {
    await dispatcher.tick();
    if (!dispatcher.getState().agents.find(item => item.id === 'codex')?.available) throw new Error('codex-cli-unavailable');
    const task = (await relay.ownerListTasks({ limit: 100 })).find(item => item.id === taskId);
    if (task && ['completed', 'failed', 'cancelled', 'expired'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('codex-live-deadline');
}
try {
  await relay.start();
  const files = await exportClientConfiguration({ relay, agentId: 'claude', directory: path.join(directory, 'connections') });
  await peer.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('electron/relay/stdio.cjs'), '--credentials', files.credentialFile], stderr: 'pipe' }));
  dispatcher.setEnabledAgents(['codex']);
  for (const index of [1, 2]) {
    const sessionId = dispatcher.getState().agents.find(item => item.id === 'codex')?.sessionId;
    const marker = `CODEX_LIVE_MCP_${index}_OK`;
    const { task } = await call('relay_send_task', { to: 'codex', subject: `Human-requested Codex MCP ${index === 1 ? 'execution' : 'session resume'} acceptance`,
      purpose: 'Verify real Codex model tool use and result delivery through a Claude-compatible standard MCP protocol peer. The peer is operated by the test, not a Claude model.',
      instructions: `Call relay_list_agents once, then use relay_report_result for THIS task with status completed, summary "${marker}", details "${marker}". Use a necessary purpose for the result. Do not delegate, read files, run commands or use unrelated tools.`,
      acceptanceCriteria: [`A result reported through MCP contains ${marker}.`], idempotencyKey: `${runId}-${index}`,
      ...(sessionId ? { sessionId } : {}) });
    const finished = await wait(task.id);
    const transcript = await call('relay_read_transcript', { taskId: task.id });
    results.push({ taskId: task.id, status: finished.status, marker, passed: finished.status === 'completed' && finished.result?.summary === marker,
      ...(sessionId ? { requestedSessionId: sessionId } : {}), readableArchiveReturned: typeof transcript.markdown === 'string' && transcript.markdown.includes(task.id) });
    if (!results.at(-1).passed) break;
  }
  report = { runId, liveProvider: 'codex', peer: 'standard MCP test client using claude identity; not a Claude model', passed: results.length === 2 && results.every(item => item.passed),
    results, workers: dispatcher.getState(), desktopWake: 'Not tested: dedicated CLI sessions only.' };
} finally {
  await dispatcher.stop(); await peer.close().catch(() => {}); await relay.stop();
  report ||= { runId, passed: false, results, failure: 'Acceptance did not complete safely.' };
  report.workers = dispatcher.getState();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'compatibility.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (!report.passed) process.exitCode = 1;
