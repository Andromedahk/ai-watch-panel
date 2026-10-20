const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { AgentRelay } = require('../electron/relay/server.cjs');
const { exportClientConfiguration } = require('../electron/relay/client-config.cjs');

test('Electron Node mode runs the exported MCP bridge without a separate Node install', { timeout: 20000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-relay-electron-'));
  const relay = new AgentRelay({ directory: path.join(directory, 'store'), port: 0 });
  const client = new Client({ name: 'electron-node-mode-acceptance', version: '1.0.0' });
  t.after(async () => { await client.close().catch(() => {}); await relay.stop().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
  await relay.start();
  const files = await exportClientConfiguration({ relay, agentId: 'codex', directory: path.join(directory, 'connections'), runtimePath: require('electron') });
  const config = JSON.parse(await fs.readFile(files.claudeConfigFile, 'utf8')).mcpServers['ai-watch-relay'];
  await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: 'pipe' }), { timeout: 10000 });
  assert.equal((await client.listTools()).tools.length, 9);
  const result = await client.callTool({ name: 'relay_list_agents', arguments: {} });
  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(result.structuredContent.agents.map(item => item.id).sort(), ['claude', 'codex']);
});
