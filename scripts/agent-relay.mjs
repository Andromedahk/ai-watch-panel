import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { AgentRelay } = require('../electron/relay/server.cjs');
const { AgentDispatcher } = require('../electron/relay/dispatcher.cjs');
const { exportClientConfiguration } = require('../electron/relay/client-config.cjs');

let directory = path.resolve('.local/agent-relay'), port = 27841;
const automatic = [], exports = [];
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index], value = process.argv[++index];
  if (key === '--data-dir' && value) directory = path.resolve(value);
  else if (key === '--port' && /^\d{1,5}$/.test(value || '')) port = Number(value);
  else if (key === '--auto-agent' && ['claude', 'codex'].includes(value)) automatic.push(value);
  else if (key === '--export-client' && ['claude', 'codex'].includes(value)) exports.push(value);
  else throw new Error('Use --data-dir, --port, --auto-agent claude|codex, or --export-client claude|codex.');
}
if (port < 1 || port > 65535) throw new Error('The relay port must be between 1 and 65535.');
const relay = new AgentRelay({ directory, port });
let dispatcher, timer, closing = false, ticking = false;
async function close() {
  if (closing) return; closing = true; clearInterval(timer);
  await dispatcher?.stop().catch(() => {});
  await relay.stop().catch(() => {});
}
try {
  await relay.start();
  dispatcher = new AgentDispatcher({ relay, directory: path.join(directory, 'managed') });
  await dispatcher.setEnabledAgents([...new Set(automatic)]);
  timer = setInterval(() => {
    if (closing || ticking) return;
    ticking = true; Promise.resolve(dispatcher.tick()).catch(() => {}).finally(() => { ticking = false; });
  }, 2000);
  for (const agentId of [...new Set(exports)]) {
    const files = await exportClientConfiguration({ relay, agentId, directory: path.join(directory, 'connections') });
    process.stdout.write(`Connection configuration ready for ${agentId}: ${files.directory}\n`);
  }
  process.stdout.write(`AI Watch MCP relay listening at ${relay.getState().endpoint}\n`);
  process.stdout.write('Task messages are recorded locally. Automatic managed sessions: ' + (automatic.join(', ') || 'off') + '.\n');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void close(); });
} catch {
  await close(); process.stderr.write('AI Watch relay could not start. Check the private data directory and local port.\n'); process.exitCode = 1;
}
