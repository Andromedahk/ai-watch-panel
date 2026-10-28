'use strict';
const { UUID } = require('./validation.cjs');
function endpoint(value) {
  let url; try { url = new URL(value); } catch { throw new Error('invalid-server'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('https-server-required');
  return url.origin;
}
async function run({ args = process.argv.slice(2), token = process.env.AI_WATCH_MOBILE_TOKEN, fetchImpl = fetch } = {}) {
  const [action, server, id] = args;
  if (!['list', 'revoke', 'reset-desktop'].includes(action) || args.length !== (action === 'revoke' ? 3 : 2)) throw new Error('usage');
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(token)) throw new Error('admin-credential-required');
  if (action === 'revoke' && !UUID.test(id)) throw new Error('invalid-device');
  const url = endpoint(server) + (action === 'list' ? '/v1/admin/devices' : action === 'revoke' ? '/v1/admin/devices/' + id : '/v1/admin/reset-desktop');
  const response = await fetchImpl(url, { method: action === 'list' ? 'GET' : action === 'revoke' ? 'DELETE' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${token}`, ...(action === 'reset-desktop' ? { 'content-type': 'application/json' } : {}) }, ...(action === 'reset-desktop' ? { body: '{}' } : {}) });
  if (!response.ok) throw new Error(`server-${response.status}`);
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 65536) throw new Error('response-too-large'); chunks.push(Buffer.from(chunk)); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (action === 'list') {
    if (!Array.isArray(data.devices) || data.devices.length > 32) throw new Error('invalid-response');
    return { devices: data.devices.map(({ id, name, platform, createdAt, pushRegistered }) => ({ id, name, platform, createdAt, pushRegistered })) };
  }
  if (data.ok !== true) throw new Error('invalid-response'); return { ok: true };
}
if (require.main === module) {
  run().then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
    process.stderr.write(error.message === 'usage' ? 'Usage: node cloud/admin.cjs list|reset-desktop HTTPS_SERVER; or revoke HTTPS_SERVER DEVICE_UUID\n'
      : /^[a-z-]+(?:-\d{3})?$/.test(error.message) ? `Admin action failed: ${error.message}\n` : 'Admin action failed\n'); process.exitCode = 1;
  });
}
module.exports = { endpoint, run };
