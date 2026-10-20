// Local MCP connection material. No provider credentials are read or exported.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const AGENTS = new Set(['claude', 'codex']);

function validateCredentials(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'agentId,endpoint,token'
    || !AGENTS.has(value.agentId) || typeof value.token !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error('relay-credentials-invalid');
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { throw new Error('relay-credentials-invalid'); }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
    || endpoint.pathname !== '/mcp' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.href !== value.endpoint) throw new Error('relay-credentials-invalid');
  return { agentId: value.agentId, endpoint: endpoint.href, token: value.token };
}
async function readCredentials(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 4096 || file.includes('\0')) throw new Error('relay-credentials-invalid');
  let handle, buffer;
  try {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 4096
      || (process.platform !== 'win32' && ((before.mode & 0o077) || before.uid !== process.getuid()))) throw new Error();
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (stat.ino !== before.ino || stat.size !== before.size || stat.size > 4096) throw new Error();
    buffer = await handle.readFile();
    const after = await fs.lstat(file);
    if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.isSymbolicLink()) throw new Error();
    return validateCredentials(JSON.parse(buffer.toString('utf8')));
  } catch { throw new Error('relay-credentials-unavailable'); }
  finally { buffer?.fill(0); await handle?.close(); }
}
async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw new Error('relay-config-directory-unsafe');
}
async function privateWrite(file, contents) {
  let temporary;
  try {
    try {
      const existing = await fs.lstat(file);
      if (!existing.isFile() || existing.isSymbolicLink() || (process.platform !== 'win32' && ((existing.mode & 0o077) || existing.uid !== process.getuid()))) throw new Error('relay-config-file-unsafe');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    temporary = path.join(path.dirname(file), `.connection-${randomBytes(12).toString('hex')}.tmp`);
    await fs.writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file); temporary = null;
  } finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
}
async function exportClientConfiguration({ relay, agentId, directory, runtimePath = process.execPath,
  bridgePath = path.join(__dirname, 'stdio.cjs') }) {
  if (!AGENTS.has(agentId) || !path.isAbsolute(directory) || !path.isAbsolute(runtimePath) || !path.isAbsolute(bridgePath)) throw new Error('relay-config-invalid');
  const credentials = validateCredentials(await relay.clientCredentials(agentId));
  if (credentials.agentId !== agentId) throw new Error('relay-config-invalid');
  await privateDirectory(directory);
  const target = path.join(directory, agentId); await privateDirectory(target);
  const credentialFile = path.join(target, 'credentials.json');
  const claudeConfigFile = path.join(target, 'claude-mcp.json');
  const codexConfigFile = path.join(target, 'codex-mcp.toml');
  const args = [bridgePath, '--credentials', credentialFile];
  const entry = { command: runtimePath, args, env: { ELECTRON_RUN_AS_NODE: '1' } };
  await privateWrite(credentialFile, JSON.stringify(credentials, null, 2) + '\n');
  await privateWrite(claudeConfigFile, JSON.stringify({ mcpServers: { 'ai-watch-relay': entry } }, null, 2) + '\n');
  await privateWrite(codexConfigFile, [
    '[mcp_servers.ai_watch_relay]', `command = ${JSON.stringify(runtimePath)}`,
    `args = ${JSON.stringify(args)}`, 'env = { ELECTRON_RUN_AS_NODE = "1" }', 'startup_timeout_sec = 15', 'tool_timeout_sec = 15', '',
  ].join('\n'));
  return { directory: target, credentialFile, claudeConfigFile, codexConfigFile };
}
module.exports = { readCredentials, validateCredentials, exportClientConfiguration };
