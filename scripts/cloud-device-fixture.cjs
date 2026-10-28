'use strict';
// Explicit synthetic acceptance fixture only. Never reads actual provider data or sends FCM/APNs.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { createServer } = require('../cloud/server.cjs');
const { CloudStatusController, projectStatus } = require('../electron/cloud-status.cjs');
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const name = flag('--name', 'pixel'); const port = Number(flag('--port', name === 'ios' ? '19444' : '19445'));
if (!/^[a-z][a-z0-9-]{0,24}$/.test(name) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid-fixture-options');
const directory = path.resolve(__dirname, '../.local/qa/cloud-sync/device-fixture');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const caFile = path.join(directory, 'ca.pem'), caKey = path.join(directory, 'ca-key.pem');
const certFile = path.join(directory, 'localhost.pem'), keyFile = path.join(directory, 'localhost-key.pem');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
function openssl(args) {
  const result = spawnSync('openssl', args, { stdio: 'ignore' }); if (result.status !== 0) throw new Error('fixture-certificate-generation-failed');
}
function certificates() {
  const valid = file => fs.existsSync(file) && spawnSync('openssl', ['x509', '-checkend', '300', '-noout', '-in', file], { stdio: 'ignore' }).status === 0;
  if (valid(caFile) && valid(certFile) && fs.existsSync(caKey) && fs.existsSync(keyFile)) return;
  const lock = path.join(directory, 'certificate.lock'); const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    const config = path.join(directory, 'certificate.cnf');
    fs.writeFileSync(config, '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=AI Watch Synthetic QA\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\n', { mode: 0o600 });
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caFile, '-days', '2', '-sha256', '-config', config, '-extensions', 'v3_ca']);
    const csr = path.join(directory, 'localhost.csr');
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', csr, '-subj', '/CN=localhost']);
    openssl(['x509', '-req', '-in', csr, '-CA', caFile, '-CAkey', caKey, '-CAcreateserial', '-out', certFile, '-days', '2', '-sha256', '-extfile', config, '-extensions', 'server']);
    fs.chmodSync(caKey, 0o600); fs.chmodSync(keyFile, 0o600); fs.unlinkSync(csr);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
certificates();
const runId = randomUUID();
const runDirectory = path.join(directory, `${name}-${runId}`); fs.mkdirSync(runDirectory, { mode: 0o700 });
const configFile = path.join(directory, `${name}.json`), controlFile = path.join(directory, `${name}-control.json`), evidenceFile = path.join(directory, `${name}-evidence.json`);
const bootstrapToken = randomBytes(32).toString('base64url'), desktopToken = randomBytes(32).toString('base64url');
const evidence = { synthetic: true, name, runId, startedAt: new Date().toISOString(), events: [] };
const record = event => { evidence.events.push({ at: new Date().toISOString(), ...event }); evidence.events = evidence.events.slice(-500); write(evidenceFile, evidence); };
const digest = value => createHash('sha256').update(value).digest('hex');
let requests = [], quota = 80, scenario = 'resetScenario', scenarioSeq = 0, online = true, controller, stopping = false;
function setScenario(value, seq) {
  scenario = value; scenarioSeq = seq;
  if (value === 'offline') { online = false; controller?.stop(); record({ type: 'scenario', scenario, seq }); return; }
  if (value === 'online') { online = true; controller?.start(); record({ type: 'scenario', scenario, seq }); return; }
  if (value === 'revoke') {
    for (const device of runtime.service.installations().devices) if (device.id !== observerId) runtime.service.revoke(device.id);
    record({ type: 'scenario', scenario, seq }); return;
  }
  const kinds = value === 'resetScenario' ? ['input', 'approval', 'fileApproval'] : value === 'lowquota' ? [] : [value];
  quota = value === 'lowquota' ? 15 : 80;
  requests = kinds.map((kind, index) => {
    const id = `codex-${digest(`${runId}:${seq}:${kind}:${index}`)}`;
    const input = kind === 'input', file = kind === 'fileApproval';
    return { id, provider: 'codex', kind: input ? 'input' : 'approval', title: input ? 'codex.input' : file ? 'codex.fileApproval' : 'codex.commandApproval',
      detail: input ? 'input' : file ? 'fileChange' : 'git', expiresAt: Date.now() + 10 * 60000,
      ...(input ? { questions: [{ id: digest(id + ':question'), header: 'question.1', question: 'review.questionOnDesktop',
        options: [{ label: 'option.1', description: '' }, { label: 'option.2', description: '' }], isOther: true }] } : {}) };
  });
  online = true; controller?.start(); record({ type: 'scenario', scenario, seq, requestIds: requests.map(r => r.id), quota });
  void controller?.tick();
}
const runtime = createServer({ desktopToken, mobileToken: bootstrapToken, file: path.join(runDirectory, 'server.json'),
  push: async (_device, event) => { record({ type: 'mock-push', category: event.category, eventId: event.eventId, requestId: event.requestId }); return { ok: true }; } });
const observerId = randomUUID(); runtime.service.pair({ id: observerId, name: 'Synthetic notification observer', platform: 'android' });
runtime.service.register({ id: observerId, platform: 'android', token: randomBytes(48).toString('base64url') }, observerId);
const secureServer = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, runtime.server.listeners('request')[0]);
secureServer.requestTimeout = 15000; secureServer.headersTimeout = 10000;
function listen(server, port) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
let poll;
async function start() {
  await listen(runtime.server, 0); await listen(secureServer, port);
  controller = new CloudStatusController({ userData: path.join(runDirectory, 'desktop'), allowHttp: true,
    getSnapshot: async () => {
      const input = requests.some(r => r.kind === 'input'), approval = requests.some(r => r.kind === 'approval');
      return projectStatus({ sampledAt: new Date().toISOString(), codex: { connection: 'ready', activity: requests.length ? 'waiting' : 'idle', activeTasks: requests.length,
        waitingTasks: requests.length, ...(requests.length ? { waitingReason: input && approval ? 'both' : input ? 'input' : 'approval' } : {}),
        quotas: [{ model: 'Codex · SYNTHETIC QA', period: '5h', remaining: quota }] } }, { enabledProviders: ['codex'], requests, sample: false });
    }, actions: { execute: async command => {
      const request = requests.find(r => r.id === command.requestId);
      const valid = request && request.expiresAt > Date.now() && (request.kind === 'input' ? command.kind === 'answer' : ['approve', 'deny'].includes(command.kind));
      if (valid) requests = requests.filter(r => r.id !== request.id);
      record({ type: 'synthetic-action', commandId: command.id, requestId: command.requestId, kind: command.kind, status: valid ? 'succeeded' : 'failed' });
      return { id: command.id, status: valid ? 'succeeded' : 'failed', ...(valid ? {} : { error: 'fixture-request-expired' }) };
    }, dispose() {} } });
  controller.config = { enabled: true, endpoint: `http://127.0.0.1:${runtime.server.address().port}`, allowActions: true }; controller.token = desktopToken;
  write(controlFile, { seq: 0, scenario: 'resetScenario' });
  setScenario('resetScenario', 0); controller.start();
  write(configFile, { synthetic: true, name, url: `https://localhost:${port}`, bootstrapToken, desktopToken, caFile, controlFile, evidenceFile, runDirectory, observerId, pid: process.pid });
  poll = setInterval(() => {
    try {
      const next = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
      if (Number.isSafeInteger(next.seq) && next.seq > scenarioSeq && ['input', 'approval', 'deny', 'fileApproval', 'offline', 'online', 'lowquota', 'revoke', 'resetScenario'].includes(next.scenario)) setScenario(next.scenario, next.seq);
    } catch { /* Atomic replacement by a test runner may briefly be incomplete. */ }
  }, 1000);
  process.stdout.write(`Synthetic cloud fixture ready: ${name} port ${port}\n`);
}
async function stop() {
  if (stopping) return; stopping = true; clearInterval(poll); controller?.stop(); record({ type: 'stopped' });
  secureServer.closeAllConnections(); await new Promise(resolve => secureServer.close(resolve)); await runtime.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop().then(() => process.exit(0)); });
start().catch(() => { process.stderr.write('Synthetic cloud fixture failed to start\n'); void stop().finally(() => { process.exitCode = 1; }); });
