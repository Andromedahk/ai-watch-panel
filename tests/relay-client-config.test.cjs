const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readCredentials, validateCredentials, exportClientConfiguration } = require('../electron/relay/client-config.cjs');
const token = 'a'.repeat(43);
const credentials = { agentId: 'claude', endpoint: 'http://127.0.0.1:27841/mcp', token };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-relay-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('relay credentials accept only fixed local MCP endpoints and known agent identities', () => {
  assert.deepEqual(validateCredentials(credentials), credentials);
  for (const endpoint of ['https://127.0.0.1:27841/mcp', 'http://localhost:27841/mcp', 'http://127.0.0.2:27841/mcp',
    'http://127.0.0.1:27841/mcp?token=private', 'http://127.0.0.1:27841/other', 'http://user:pass@127.0.0.1:27841/mcp']) {
    assert.throws(() => validateCredentials({ ...credentials, endpoint }), /invalid/);
  }
  assert.throws(() => validateCredentials({ ...credentials, agentId: 'other' }), /invalid/);
  assert.throws(() => validateCredentials({ ...credentials, token: 'private\r\nheader' }), /invalid/);
  assert.throws(() => validateCredentials({ ...credentials, providerToken: 'private' }), /invalid/);
});
test('client exports keep relay keys out of Claude and Codex configuration and use private files', async t => {
  const root = await fixture(t);
  const files = await exportClientConfiguration({ relay: { clientCredentials: async () => credentials }, agentId: 'claude',
    directory: root, runtimePath: process.execPath, bridgePath: path.resolve('electron/relay/stdio.cjs') });
  assert.deepEqual(await readCredentials(files.credentialFile), credentials);
  for (const file of [files.claudeConfigFile, files.codexConfigFile]) {
    const body = await fs.readFile(file, 'utf8');
    assert.ok(!body.includes(token)); assert.ok(body.includes('credentials.json'));
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
  const config = JSON.parse(await fs.readFile(files.claudeConfigFile, 'utf8'));
  assert.deepEqual(config.mcpServers['ai-watch-relay'].args.slice(-2), ['--credentials', files.credentialFile]);
  assert.equal(config.mcpServers['ai-watch-relay'].env.ELECTRON_RUN_AS_NODE, '1');
});
test('credential reads reject symlinks, broad permissions, unsafe output directories and crossed identities', async t => {
  const root = await fixture(t), file = path.join(root, 'credentials.json');
  await fs.writeFile(file, JSON.stringify(credentials), { mode: 0o600 });
  if (process.platform !== 'win32') {
    await fs.chmod(file, 0o644); await assert.rejects(readCredentials(file), /unavailable/); await fs.chmod(file, 0o600);
  }
  const link = path.join(root, 'linked.json'); await fs.symlink(file, link); await assert.rejects(readCredentials(link), /unavailable/);
  const output = path.join(root, 'output'); await fs.symlink(root, output, 'dir');
  await assert.rejects(exportClientConfiguration({ relay: { clientCredentials: async () => credentials }, agentId: 'claude', directory: output }), /unsafe/);
  await assert.rejects(exportClientConfiguration({ relay: { clientCredentials: async () => credentials }, agentId: 'codex', directory: root }), /invalid/);
});
