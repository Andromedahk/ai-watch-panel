import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const { LocalStatusReader } = createRequire(import.meta.url)('../electron/local-status.cjs');
assert.notEqual(process.platform, 'win32', 'This acceptance suite requires the Unix Codex IPC transport');
const root = await mkdtemp(path.join(tmpdir(), 'aw-ca-'));
const codexHome = path.join(root, 'c');
const profile = path.join(root, 'profile');
const output = path.resolve('.local/qa/codex-attention');
const allProviders = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];
const waitingThread = 'synthetic-waiting';
const workingThread = 'synthetic-working';
const owner = 'synthetic-owner';
const privateMarker = 'SYNTHETIC_PRIVATE_PAYLOAD';
const padding = privateMarker + 'x'.repeat(20 * 1024 * 1024);
const inbound = [];
const sockets = new Set();
const subscriptions = new Set();
const backendChecks = [];
const uiChecks = [];
const rendererErrors = [];
let application;
let reader;
let peer;
let revision = 0;
let sequence = 0;
let quotaCalls = 0;
let page;
let baseline;
const server = net.createServer(socket => {
  sockets.add(socket); peer = socket;
  let pending = Buffer.alloc(0);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  socket.on('data', bytes => {
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= 4) {
      const length = pending.readUInt32LE(0);
      assert.ok(length > 0 && length < 65536, 'The observer must send only small subscription messages');
      if (pending.length < length + 4) break;
      const message = JSON.parse(pending.subarray(4, length + 4));
      pending = pending.subarray(length + 4);
      inbound.push(message.method);
      if (message.method === 'initialize') {
        const payload = Buffer.from(JSON.stringify({ type: 'response', method: 'initialize', resultType: 'success', result: { clientId: 'synthetic-monitor' } }));
        const prefix = Buffer.alloc(4); prefix.writeUInt32LE(payload.length);
        socket.write(Buffer.concat([prefix, payload]));
      }
      if (message.method === 'thread-stream-following-changed') {
        if (message.params.following) subscriptions.add(message.params.conversationId);
        else subscriptions.delete(message.params.conversationId);
      }
    }
  });
});

async function send(message) {
  assert.ok(peer && !peer.destroyed, 'The synthetic IPC peer must remain connected');
  const payload = Buffer.from(JSON.stringify(message));
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(payload.length);
  const write = bytes => new Promise((resolve, reject) => peer.write(bytes, error => error ? reject(error) : resolve()));
  // Deliberately split both the length prefix and the large JSON body.
  await write(prefix.subarray(0, 2));
  await write(prefix.subarray(2));
  for (let offset = 0; offset < payload.length; offset += 65536) await write(payload.subarray(offset, offset + 65536));
  return payload.length;
}
const broadcast = (conversationId, change) => ({
  type: 'broadcast', sourceClientId: owner, method: 'thread-stream-state-changed', version: 11,
  params: { hostId: 'local', conversationId, change },
});
async function snapshot(requests, items = [], large = true, canonical = false) {
  const turn = { turnId: 'synthetic-turn', status: 'inProgress', items };
  const bytes = await send(broadcast(waitingThread, {
    type: 'snapshot', revision: ++revision,
    conversationState: { title: large ? padding : 'Synthetic acceptance', requests,
      turns: canonical ? [] : [turn],
      ...(canonical ? { turnHistory: { kind: 'canonical', history: { entitiesByKey: { 'turn:synthetic-turn': turn } } } } : {}),
    },
  }));
  if (large) assert.ok(bytes > 16 * 1024 * 1024, 'Regression input must exceed the old 16 MiB limit');
  await expect.poll(() => reader.codexAttention.states.get(waitingThread)?.revision, { timeout: 15000 }).toBe(revision);
  const retained = JSON.stringify([...reader.codexAttention.states.values()]);
  assert.ok(retained.length < 32768 && !retained.includes(privateMarker), 'Attention state must retain metadata only');
  return bytes;
}
async function readStatus(label, waitingReason = null) {
  let status;
  await expect.poll(async () => {
    status = await reader.codex([{ command: '/synthetic/codex' }], true);
    return { activity: status.activity, activeTasks: status.activeTasks,
      waitingTasks: status.waitingTasks || 0, waitingReason: status.waitingReason || null };
  }, { timeout: 15000, message: label }).toEqual({
    activity: waitingReason ? 'waiting' : 'running', activeTasks: waitingReason ? 1 : 2,
    waitingTasks: waitingReason ? 1 : 0, waitingReason,
  });
  assert.ok(!JSON.stringify(status).includes(privateMarker), 'Raw IPC payload must not enter renderer status');
  backendChecks.push({ label, activity: status.activity, activeTasks: status.activeTasks,
    waitingTasks: status.waitingTasks || 0, waitingReason: status.waitingReason || null });
  return status;
}
async function render(status) {
  const value = structuredClone(baseline);
  value.codex = status;
  value.isTestData = true;
  // Keep the fixture timer from replacing the deliberate scenario mid-assertion.
  value.sampledAt = new Date(Date.now() + 3600000 + sequence++).toISOString();
  await application.evaluate(({ BrowserWindow }, snapshot) => {
    BrowserWindow.getAllWindows()[0].webContents.send('panel:status-changed', snapshot);
  }, value);
  await expect(page.locator('main')).toHaveAttribute('data-sampled-at', value.sampledAt);
  await expect(page.locator('.demo-tag')).toHaveText('测试');
}
async function verifyUI(status, label, matrix = false, screenshots = false) {
  await render(status);
  const combinations = matrix ? ['watch', 'dial', 'party'].flatMap(skin => [false, true].map(anime => ({ skin, anime })))
    : [{ skin: 'watch', anime: false }];
  for (const { skin, anime } of combinations) {
    await page.evaluate(async ({ skin, anime }) => { await window.panel.setSkin(skin); await window.panel.setAnimeMode(anime); }, { skin, anime });
    await expect(page.locator('main')).toHaveAttribute('data-skin', skin);
    await expect.poll(() => page.locator('main').evaluate(main => main.classList.contains('anime-mode'))).toBe(anime);
    const card = page.locator('.provider-card[data-provider="codex"]');
    const pill = card.locator('.state-pill');
    const attention = page.locator('.overview .attention[data-provider="codex"]');
    const waiting = status.activity === 'waiting';
    await expect(card).toHaveAttribute('data-attention', String(waiting));
    await expect(pill).toHaveAttribute('data-state', waiting ? 'waiting' : 'running');
    await expect(pill).toHaveText(waiting ? { input: '待回答', approval: '待授权', both: '待处理' }[status.waitingReason] : '运行中');
    await expect(pill).toBeVisible();
    await expect(attention).toHaveCount(waiting ? 1 : 0);
    if (waiting) {
      await expect(attention).toBeVisible();
      await expect(attention.locator('.attention-kicker')).toHaveText(await pill.innerText());
      const colors = await page.evaluate(() => {
        const pill = document.querySelector('.provider-card[data-provider="codex"] .state-pill');
        const kicker = document.querySelector('.overview .attention[data-provider="codex"] .attention-kicker');
        return { pill: getComputedStyle(pill).color, background: getComputedStyle(pill).backgroundColor,
          attention: getComputedStyle(kicker).color };
      });
      const red = color => { const rgb = color.match(/[\d.]+/g)?.map(Number); return rgb?.length >= 3 && rgb[0] > rgb[1] + 20 && rgb[0] > rgb[2] + 20; };
      assert.ok(red(colors.pill) || red(colors.background), `Waiting pill must be red: ${JSON.stringify(colors)}`);
      assert.ok(red(colors.attention), `Overview attention must be red: ${JSON.stringify(colors)}`);
    }
    if (screenshots) {
      await page.locator('.provider-viewport').evaluate(viewport => { viewport.scrollTop = 0; });
      await expect(page.locator('.demo-tag')).toBeVisible();
      await page.screenshot({ path: path.join(output, `${label}-${skin}-${anime ? 'anime' : 'logo'}.png`), animations: 'disabled' });
    }
    uiChecks.push({ label, skin, anime, state: status.activity });
  }
}

try {
  await mkdir(path.join(codexHome, 'ipc'), { recursive: true, mode: 0o700 });
  await mkdir(profile); await mkdir(output, { recursive: true });
  const history = new DatabaseSync(path.join(codexHome, 'thread_history_1.sqlite'));
  const state = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  try {
    history.exec('CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER); CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, created_at_ms INTEGER)');
    state.exec('CREATE TABLE threads(id TEXT, updated_at INTEGER, archived INTEGER, rollout_path TEXT)');
    const now = Date.now();
    for (const id of [waitingThread, workingThread]) {
      history.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?)').run(id, 'synthetic-turn', 'inProgress', Math.floor(now / 1000), null);
      history.prepare('INSERT INTO thread_items VALUES (?,?,?)').run(id, 'synthetic-turn', now);
      state.prepare('INSERT INTO threads VALUES (?,?,?,?)').run(id, now, 0, null);
    }
  } finally { history.close(); state.close(); }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path.join(codexHome, 'ipc', 'ipc.sock'), resolve); });
  reader = new LocalStatusReader({ home: root, codexHome,
    codexQuotaReader: { poll: async () => { quotaCalls++; return {
      useLocal: false, source: 'account', connection: 'ready', quotas: [], plan: { name: 'Pro', stale: false },
      observedAt: new Date().toISOString(), detail: '合成验收：官方额度查询已替换为本地 stub',
    }; } },
    runCommand: async () => { throw new Error('No real OS process queries allowed'); },
    requestLocal: async () => { throw new Error('No real provider requests allowed'); },
  });
  await reader.codex([{ command: '/synthetic/codex' }], true);
  await expect.poll(() => subscriptions.has(waitingThread) && subscriptions.has(workingThread), { timeout: 10000 }).toBe(true);
  await send(broadcast(workingThread, { type: 'snapshot', revision: 1, conversationState: { requests: [], turns: [] } }));
  await snapshot([], [], false);
  await readStatus('initial-two-running');

  await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
    language: 'zh-CN', skin: 'watch', theme: 'dark', animate: false, layout: 'single',
    providerOrder: allProviders, enabledProviders: ['codex'], claudeHooksEnabled: false,
    claudeNetworkAllowed: false, qwenKeychainAllowed: false, widgetsEnabled: false,
  }));
  const env = { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' };
  delete env.AI_WATCH_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: ['.'], env });
  page = await application.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.dataset.sampledAt));
  baseline = await page.evaluate(() => window.panel.getStatus());
  assert.equal(baseline.isTestData, true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 50, width: 420, height: 1000 }));
  const request = method => ({ method, id: 'synthetic-request', params: { question: privateMarker } });
  for (const [reason, methods] of [
    ['input', ['item/tool/requestUserInput']],
    ['approval', ['item/fileChange/requestApproval']],
    ['both', ['item/tool/requestUserInput', 'item/fileChange/requestApproval']],
  ]) {
    const bytes = await snapshot(methods.map(request));
    const status = await readStatus(`large-${reason}`, reason);
    backendChecks.at(-1).frameBytes = bytes;
    await verifyUI(status, reason, true, true);
    await send(broadcast(waitingThread, { type: 'patches', baseRevision: revision, revision: ++revision,
      patches: [{ op: 'replace', path: ['requests'], value: [] }] }));
    await verifyUI(await readStatus(`resolved-${reason}`), `resolved-${reason}`, true);
  }

  const ask = { id: 'ask', type: 'agentMessage', questions: [{ question: 'Synthetic question', options: ['Synthetic answer'] }] };
  const reply = '<send_user_message_question_reply>' + JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'ask', 0]), question: 'Synthetic question', answer: 'Synthetic answer' }]) + '</send_user_message_question_reply>';
  for (const type of ['userMessage', 'steeringUserMessage']) {
    const canonical = type === 'steeringUserMessage';
    const label = `async-${canonical ? 'canonical' : 'legacy'}-${type}`;
    await snapshot([], [ask], true, canonical);
    await verifyUI(await readStatus(`${label}-waiting`, 'input'), `${label}-waiting`);
    await snapshot([], [ask, { id: 'reply', type, ...(type === 'steeringUserMessage' ? { status: 'accepted' } : {}), content: [{ type: 'text', text: reply }] }], false, canonical);
    await verifyUI(await readStatus(`${label}-answered`), `${label}-answered`);
  }
  await snapshot([request('item/tool/requestUserInput'), request('item/fileChange/requestApproval')]);
  await readStatus('before-owner-disconnect', 'both');
  await send({ type: 'broadcast', method: 'client-status-changed', version: 1, sourceClientId: 'synthetic-server',
    params: { clientId: owner, status: 'disconnected' } });
  await verifyUI(await readStatus('owner-disconnected'), 'owner-disconnected', true);
  assert.ok(inbound.every(method => ['initialize', 'thread-stream-following-changed'].includes(method)), 'The observer must not answer or approve requests');
  assert.ok(quotaCalls > 0, 'The real LocalStatusReader must use the injected quota stub');
  assert.deepEqual(rendererErrors, []);
  const report = { result: 'passed', data: 'synthetic sqlite + Unix IPC + isolated Electron fixture',
    backendChecks, uiChecks, rendererErrors, quotaCalls, realAccountsQueried: false };
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ result: report.result, backendChecks: backendChecks.length, uiChecks: uiChecks.length,
    largeFrameMiB: 20, rendererErrors: rendererErrors.length, realAccountsQueried: false, output: '.local/qa/codex-attention' }, null, 2));
} finally {
  reader?.codexAttention.close();
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  try { if (application) await application.close(); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
