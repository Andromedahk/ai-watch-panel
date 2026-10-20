import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, rename, readdir, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-relay-ui-'));
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ language: 'zh-CN', theme: 'dark' }));
const launch = enabled => electron.launch({ args: ['.'], env: { ...process.env,
  AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture', AI_WATCH_TEST_RELAY: enabled ? '1' : '0' } });
let app;
const errors = [];
const archiveMetadata = async directory => {
  const rows = [];
  const walk = async root => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name); const info = await stat(file);
      rows.push({ file: path.relative(directory, file), size: info.size, mtime: info.mtimeMs });
      if (entry.isDirectory()) await walk(file);
    }
  };
  await walk(directory); return rows.sort((a, b) => a.file.localeCompare(b.file));
};
try {
  // The ordinary fixture cannot open even a local test server without the third opt-in.
  app = await launch(false);
  let page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.panel));
  await assert.rejects(page.evaluate(() => window.panel.setRelayEnabled(true)));
  assert.equal((await page.evaluate(() => window.panel.getRelayState())).running, false);
  await app.close(); app = null;

  app = await launch(true); page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.getAttribute('data-sampled-at')));
  await app.evaluate(({ app }) => {
    const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/electron/main.cjs');
    const { AgentRelay } = require('./relay/server.cjs');
    const start = AgentRelay.prototype.start;
    AgentRelay.prototype.start = function (...args) { global.aiWatchRelayUi = this; return start.apply(this, args); };
    const { ManagedCliRuntime } = require('./relay/provider-runtime.cjs');
    global.aiWatchRelayCliCalls = 0;
    for (const method of ['discover', 'run']) ManagedCliRuntime.prototype[method] = async function () {
      global.aiWatchRelayCliCalls++; throw new Error('Real CLI must never run in a fixture');
    };
  });
  await page.getByRole('button', { name: '打开配置', exact: true }).click();
  const section = page.getByTestId('relay-settings');
  const toggle = section.getByRole('checkbox', { name: '开启本机 MCP 服务器', exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(section.getByText('暂无任务记录', { exact: true })).toBeVisible();
  await assert.rejects(access(path.join(profile, 'agent-relay')));
  await toggle.click(); await expect(toggle).toBeChecked();
  await expect(section.getByText('MCP 服务运行中', { exact: true })).toBeVisible();
  let state = await page.evaluate(() => window.panel.getRelayState());
  assert.match(state.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.notEqual(new URL(state.endpoint).port, '27841');
  assert.equal((await fetch(state.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.doesNotMatch(JSON.stringify(state), /token|credentials|binaryPath|userData/);
  for (const value of [undefined, null, 0, 1, 'true', {}, [true]]) await assert.rejects(page.evaluate(value => window.panel.setRelayEnabled(value), value));
  for (const value of [undefined, null, 'claude', ['claude', 'claude'], ['other'], {}, [true]]) await assert.rejects(page.evaluate(value => window.panel.setRelayAutoAgents(value), value));
  for (const value of [null, {}, ['claude'], 'other', '../credentials']) await assert.rejects(page.evaluate(value => window.panel.exportRelayConfig(value), value));
  for (const value of [null, {}, '../credentials', '12345678-1234-4234-8234-123456789abc/../../credentials']) await assert.rejects(page.evaluate(value => window.panel.readRelayTranscript(value), value));
  // Generic settings cannot opt agents in or stop the separate service.
  await page.evaluate(() => window.panel.configure({ side: 'right', locked: false, animate: true, relayEnabled: false, relayAutoAgents: ['codex'] }));
  assert.equal((await page.evaluate(() => window.panel.getState())).relayEnabled, true);
  assert.deepEqual((await page.evaluate(() => window.panel.getState())).relayAutoAgents, []);
  await page.evaluate(() => window.panel.setRelayAutoAgents(['claude', 'codex']));
  await expect.poll(() => page.evaluate(() => window.panel.getRelayState().then(value => value.agents.every(agent => agent.enabled)))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.panel.getRelayState().then(value => value.agents.every(agent => !agent.available && !agent.busy)))).toBe(true);
  // Export only to the disposable profile and suppress Finder in fixture mode.
  await section.getByRole('button', { name: '导出 Claude 连接配置', exact: true }).click();
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(path.join(profile, 'agent-relay/client-config/claude/claude-mcp.json'), 'utf8')).mcpServers['ai-watch-relay'].command.length > 0; }
    catch { return false; }
  }).toBe(true);
  assert.deepEqual(await page.evaluate(() => window.panel.exportRelayConfig('codex')), { exported: true });

  const task = await app.evaluate(async () => {
    const result = await global.aiWatchRelayUi.ownerCommand('claude', 'relay_send_task', { to: 'codex',
      subject: '<b>Relay UI QA</b>', purpose: 'Verify readable isolated task records.',
      instructions: 'Only a synthetic task; do not execute an actual CLI.', acceptanceCriteria: ['The renderer displays plain text.'],
      idempotencyKey: 'relay-ui-qa-001' });
    return result.task;
  });
  await expect(section.locator('.relay-task')).toHaveCount(1);
  await expect(section.locator('.relay-task strong')).toHaveText('<b>Relay UI QA</b>');
  await expect(section.locator('.relay-task strong b')).toHaveCount(0);
  await section.locator('.relay-task').click();
  await expect(section.locator('.relay-transcript pre')).toContainText('Verify readable isolated task records.');
  await expect(section.locator('.relay-transcript pre')).toContainText('Acceptance criteria');
  assert.equal(await app.evaluate(() => global.aiWatchRelayCliCalls), 0);
  assert.equal((await page.evaluate(() => window.panel.getRelayTasks()))[0].status, 'queued');
  // Readable archives remain after stopping, and stored preferences survive a restart.
  const endpoint = (await page.evaluate(() => window.panel.getRelayState())).endpoint;
  await toggle.click(); await expect(toggle).not.toBeChecked();
  await assert.rejects(fetch(endpoint, { method: 'POST', body: '{}' }));
  assert.ok((await page.evaluate(id => window.panel.readRelayTranscript(id), task.id)).includes('Relay UI QA'));
  assert.deepEqual((await page.evaluate(() => window.panel.getState())).relayAutoAgents, ['claude', 'codex']);
  await page.evaluate(() => window.panel.configure({ side: 'left', locked: false, animate: true, relayEnabled: true, relayAutoAgents: [] }));
  assert.equal((await page.evaluate(() => window.panel.getState())).relayEnabled, false);
  assert.deepEqual((await page.evaluate(() => window.panel.getState())).relayAutoAgents, ['claude', 'codex']);
  await toggle.click(); await expect(toggle).toBeChecked();
  await expect(section.locator('.relay-task')).toHaveCount(1);
  assert.equal((await page.evaluate(() => window.panel.getRelayTasks()))[0].status, 'queued');
  assert.equal(await app.evaluate(() => global.aiWatchRelayCliCalls), 0);
  await mkdir('.local', { recursive: true });
  await section.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.local/relay-settings-zh.png' });
  // Logical CSS and bidi isolation keep the new settings usable in RTL languages.
  for (const language of ['he', 'ar', 'en']) {
    await page.evaluate(language => window.panel.setLanguage(language), language);
    await expect(page.locator('main')).toHaveAttribute('dir', language === 'en' ? 'ltr' : 'rtl');
    assert.equal(await section.evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
  }
  await page.screenshot({ path: '.local/relay-settings-en.png' });
  const finalEndpoint = (await page.evaluate(() => window.panel.getRelayState())).endpoint;
  const childProcess = app.process();
  const shutdownStarted = Date.now();
  await app.evaluate(({ app }) => {
    const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/electron/main.cjs');
    const { AgentRelay } = require('./relay/server.cjs'); const stop = AgentRelay.prototype.stop;
    AgentRelay.prototype.stop = async function (...args) {
      await new Promise(resolve => setTimeout(resolve, 150)); return stop.apply(this, args);
    };
    app.quit(); app.quit();
  });
  await expect.poll(() => childProcess.exitCode, { timeout: 10000 }).toBe(0); app = null;
  assert.ok(Date.now() - shutdownStarted >= 150, 'Repeated quit must wait for relay cleanup');
  await assert.rejects(access(path.join(profile, 'agent-relay/writer.lock')));
  await assert.rejects(fetch(finalEndpoint, { method: 'POST', body: '{}' }));
  // Open history after restart with the server disabled and its token file absent.
  const saved = JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8'));
  await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ ...saved, relayEnabled: false, language: 'zh-CN' }));
  const archiveRoot = path.join(profile, 'agent-relay');
  const credentialsFile = path.join(archiveRoot, 'credentials.json');
  await rename(credentialsFile, path.join(archiveRoot, 'credentials.offline-test'));
  const beforeOffline = await archiveMetadata(archiveRoot);
  app = await launch(true); page = await app.firstWindow();
  assert.equal((await page.evaluate(() => window.panel.getRelayState())).running, false);
  await page.getByRole('button', { name: '打开配置', exact: true }).click();
  const offline = page.getByTestId('relay-settings');
  await expect(offline.locator('.relay-task')).toHaveCount(1);
  await offline.locator('.relay-task').click();
  await expect(offline.locator('.relay-transcript pre')).toContainText('Verify readable isolated task records.');
  await expect(offline.getByRole('button', { name: '打开留档文件夹', exact: true })).toBeEnabled();
  assert.deepEqual(await page.evaluate(() => window.panel.openRelayArchive()), { opened: true });
  await assert.rejects(page.evaluate(() => window.panel.exportRelayConfig('claude')));
  await offline.getByRole('checkbox', { name: '托管 Codex 会话', exact: true }).click();
  await expect(offline.getByRole('checkbox', { name: '托管 Codex 会话', exact: true })).not.toBeChecked();
  assert.deepEqual((await page.evaluate(() => window.panel.getState())).relayAutoAgents, ['claude']);
  assert.equal((await page.evaluate(() => window.panel.getRelayState())).running, false);
  await assert.rejects(access(credentialsFile));
  assert.deepEqual(await archiveMetadata(archiveRoot), beforeOffline);
  await app.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('panel:relay-changed', { enabled: false, running: false,
      endpoint: null, agentCount: 2, queuedTasks: 1, lastEventAt: null, agents: [
        { id: 'claude', available: false, enabled: false, busy: false, lastError: 'auth-required' },
        { id: 'codex', available: false, enabled: false, busy: false, lastError: 'config-invalid' },
      ] });
  });
  await expect(offline.getByText('CLI 未登录，请在对应 CLI 完成登录。', { exact: true })).toBeVisible();
  await expect(offline.getByText('CLI 版本或配置不兼容，请更新 CLI 并检查配置。', { exact: true })).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('panel:relay-changed', {
    enabled: false, running: false, endpoint: null, agentCount: 2, queuedTasks: 1, lastEventAt: null,
    agents: [{ id: 'claude', available: false, enabled: false, busy: false, lastError: 'constructor' },
      { id: 'codex', available: false, enabled: false, busy: false }],
  }));
  await expect(offline.getByText('托管会话暂不可用', { exact: true })).toBeVisible();
  await app.close(); app = null;
  assert.deepEqual(await archiveMetadata(archiveRoot), beforeOffline);
  // A persisted opt-in still cannot bypass the absent explicit fixture flag.
  await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ ...saved, relayEnabled: true }));
  app = await launch(false); page = await app.firstWindow();
  assert.equal((await page.evaluate(() => window.panel.getState())).relayEnabled, true);
  assert.equal((await page.evaluate(() => window.panel.getRelayState())).running, false);
  await app.close(); app = null;
  assert.deepEqual(errors, []);
  console.log('Relay UI: isolated opt-in, ephemeral server, strict IPC, settings isolation, config export, plain-text task records, fixture CLI blocking, RTL, shutdown and read-only offline history after restart without credentials passed. No real agent session or login was used.');
} finally {
  await app?.close(); await rm(profile, { recursive: true, force: true });
}
