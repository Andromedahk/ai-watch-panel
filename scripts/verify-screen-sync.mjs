import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Two isolated synthetic profiles, real loopback pairing and the actual hidden
// renderer. Preview suppresses all USB access; no real accounts are consulted.
const output = path.resolve('.local/qa/screen-sync');
const port = 47800 + Math.floor(Math.random() * 400);
const profiles = {
  host: await mkdtemp(path.join(tmpdir(), 'ai-watch-screen-sync-host-')),
  client: await mkdtemp(path.join(tmpdir(), 'ai-watch-screen-sync-client-')),
};
const base = { locked: false, animate: false, theme: 'dark', language: 'zh-CN', skin: 'watch', animeMode: true, mascotInterval: 0 };
await writeFile(path.join(profiles.host, 'preferences.json'), JSON.stringify({ ...base,
  syncRole: 'host', syncPort: port, kimiSource: 'work', claudeSource: 'desktop' }));
await writeFile(path.join(profiles.client, 'preferences.json'), JSON.stringify({ ...base,
  syncRole: 'off', kimiSource: 'code', claudeSource: 'code' }));
const apps = [], errors = [];
async function open(profile, status) {
  const app = await electron.launch({ args: ['.'], env: { ...process.env,
    AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: status, AI_WATCH_STREAM_PREVIEW: '1' } });
  apps.push(app);
  app.on('window', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.provider-card')).toHaveCount(8);
  return { app, page };
}
const settings = page => page.getByRole('button', { name: '打开配置', exact: true }).click();
const section = (page, name) => page.locator('.settings-nav').getByRole('button', { name, exact: true }).click();
async function outputWindow(app) {
  await expect.poll(() => app.windows().some(page => page.url().includes('surface=screen'))).toBe(true);
  const screen = app.windows().find(page => page.url().includes('surface=screen'));
  await expect(screen.locator('[data-surface="screen"]')).toBeAttached();
  return screen;
}
async function capture(app, name) {
  const encoded = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=screen'));
    return (await window.webContents.capturePage()).toPNG().toString('base64');
  });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(encoded, 'base64'));
}
async function assertClient(client, screen) {
  const state = await client.page.evaluate(() => window.panel.getState());
  assert.equal(state.syncRole, 'client');
  assert.equal(state.lanSync.state, 'connected');
  assert.equal(state.stream.enabled, true);
  assert.equal(state.stream.status, 'running');
  assert.equal(state.stream.preview, true);
  // Following remote source selections must not rewrite the client's own choices.
  assert.equal(state.kimiSource, 'code');
  assert.equal(state.claudeSource, 'code');
  const snapshot = await screen.evaluate(() => window.panel.getStatus());
  assert.ok(snapshot.remote?.host, 'the output uses a remote host snapshot');
  assert.equal(snapshot.kimi.kimiSource, 'work');
  assert.equal(snapshot.claude.claudeSource, 'desktop');
  assert.equal(JSON.stringify(snapshot).includes(profiles.host), false, 'host profile path is not shared');
  await expect(screen.locator('.provider-card[data-provider="kimi"]')).toContainText('Kimi Work');
  await expect(screen.locator('.provider-card[data-provider="kimi"]')).toContainText('共享积分');
  await expect(screen.locator('.provider-card[data-provider="claude"]')).toHaveAttribute('aria-label', 'Claude 面板');
}

try {
  await mkdir(output, { recursive: true });
  let host = await open(profiles.host, 'glow-attention');
  const client = await open(profiles.client, 'fixture');
  const clientLocal = await client.page.evaluate(() => window.panel.getStatus());
  assert.equal(clientLocal.codex.activity, 'running', 'local fixture differs from the waiting host');
  await settings(host.page); await section(host.page, '多端同步');
  await expect(host.page.locator('[data-section="sync"] .sync-status')).toContainText('正在共享');
  const code = (await host.page.locator('.sync-code').textContent()).trim();
  assert.match(code, /^\d{6}$/);
  await settings(client.page); await section(client.page, '多端同步');
  await client.page.locator('[data-section="sync"] .segmented').getByRole('button', { name: '子客户端', exact: true }).click();
  await client.page.getByLabel('主客户端地址').fill(`127.0.0.1:${port}`);
  await client.page.getByLabel('配对码').fill(code);
  await client.page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(client.page.locator('[data-section="sync"] .sync-status')).toContainText('已连接到');
  await section(client.page, '小屏幕串流');
  await client.page.getByRole('button', { name: '开启小屏幕串流', exact: true }).click();
  await expect(client.page.locator('main')).toHaveAttribute('data-surface', 'controller');
  await expect.poll(() => client.page.evaluate(() => window.panel.getState()).then(state => state.stream.status)).toBe('running');
  let screen = await outputWindow(client.app);
  // Distinct host history must reach the output without using this client's local samples.
  await host.page.evaluate(() => {
    const now = Date.now();
    return window.panel.shareJournal({ events: [], samples: { codex: [[now - 3600000, 43], [now - 1000, 13]] }, last: {} });
  });
  await expect(screen.locator('.screen-trend-legend li[data-provider="codex"]')).toHaveAttribute('data-current', '13');
  await expect(screen.locator('.screen-trend-series[data-provider="codex"] polyline')).toHaveCount(1);
  await assertClient(client, screen);
  await expect(screen.locator('.screen-attention')).toHaveAttribute('data-provider', 'codex');
  await expect(screen.locator('.screen-attention')).toHaveAttribute('data-reason', 'both');
  await expect(screen.locator('.screen-attention h1 span')).toHaveText(['待回答', '待授权']);
  assert.deepEqual(await screen.locator('.screen-attention').evaluate(element => {
    const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height, innerWidth, innerHeight];
  }), [0, 0, 2240, 1080, 2240, 1080]);
  await capture(client.app, 'host-waiting-fullscreen');
  console.log('Remote waiting state and host Claude/Kimi sources reached the screen.');

  // Applying real UI preferences restarts the hidden renderer but must retain pairing.
  await client.page.getByLabel('串流画面宽度').fill('1120');
  await client.page.getByLabel('串流画面高度').fill('540');
  await client.page.getByLabel('串流自动翻页秒数').fill('4');
  await client.page.getByRole('button', { name: '应用串流参数', exact: true }).click();
  await expect.poll(() => client.page.evaluate(() => window.panel.getState()).then(state => state.stream.status)).toBe('running');
  screen = await outputWindow(client.app);
  assert.deepEqual(await screen.evaluate(() => [innerWidth, innerHeight]), [1120, 540]);
  await assertClient(client, screen);
  await section(client.page, '外观');
  await client.page.getByRole('checkbox', { name: '暗夜模式', exact: true }).uncheck();
  await expect(screen.locator('html')).toHaveAttribute('data-theme', 'light');
  await client.page.getByRole('button', { name: '保存配置', exact: true }).click();
  await assertClient(client, screen);
  const saved = JSON.parse(await readFile(path.join(profiles.client, 'preferences.json'), 'utf8'));
  assert.equal(saved.syncRole, 'client');
  assert.equal(saved.theme, 'light');
  assert.equal(saved.stream.width, 1120);
  await capture(client.app, 'host-waiting-light-compact');
  await section(client.page, '多端同步');
  await expect(client.page.locator('[data-section="sync"] .sync-status')).toContainText('已连接到');
  await client.page.screenshot({ path: path.join(output, 'client-streaming-paired.png') });

  // UI-only test mode is shared with this client's output; the remote snapshot
  // itself stays untouched and is restored immediately when preview is disabled.
  await section(client.page, '模块');
  await client.page.getByRole('checkbox', { name: '测试模式', exact: true }).check();
  await client.page.getByRole('button', { name: '全部待机', exact: true }).click();
  await expect(screen.locator('.screen-attention')).toHaveCount(0);
  await expect(screen.locator('.provider-card[data-provider="codex"] .task-status')).toHaveText('待机');
  assert.equal((await screen.evaluate(() => window.panel.getStatus())).codex.waitingReason, 'both');
  await client.page.getByRole('button', { name: 'Codex 待授权', exact: true }).click();
  await expect(screen.locator('.screen-attention')).toHaveAttribute('data-reason', 'approval');
  await client.page.getByRole('checkbox', { name: '测试模式', exact: true }).uncheck();
  await expect(screen.locator('.screen-attention')).toHaveAttribute('data-reason', 'both');
  await expect(screen.locator('.screen-trend-legend li[data-provider="codex"]')).toHaveAttribute('data-current', '13');
  await assertClient(client, screen);
  console.log('Stream parameters, theme, configure save and cross-window test mode preserve LAN pairing.');

  // Restart only the synthetic host with a resolved task. The streaming client
  // reconnects using its original pairing and clears the fullscreen request.
  await host.app.close(); apps.splice(apps.indexOf(host.app), 1);
  await expect.poll(() => client.page.evaluate(() => window.panel.getState()).then(state => state.lanSync.state), { timeout: 15000 }).not.toBe('connected');
  host = await open(profiles.host, 'glow-running');
  await expect.poll(() => client.page.evaluate(() => window.panel.getState()).then(state => state.lanSync.state), { timeout: 40000 }).toBe('connected');
  await expect(screen.locator('.screen-attention')).toHaveCount(0);
  await assertClient(client, screen);
  await expect(screen.locator('.provider-card[data-provider="codex"] .task-status')).toHaveText('运行中');
  await capture(client.app, 'host-resolved-monitoring');
  const firstFrames = (await client.page.evaluate(() => window.panel.getState())).stream.frames;
  await expect.poll(() => client.page.evaluate(() => window.panel.getState()).then(state => state.stream.frames)).toBeGreaterThan(firstFrames + 8);
  assert.deepEqual(errors, [], 'renderer errors');
  console.log('Screen/LAN integration passed: paired host snapshots and source selections, fullscreen waiting, stream restart, theme and configure persistence, local test-mode sync, host reconnect and request resolution. Synthetic data only; USB was not opened.');
} finally {
  for (const app of apps) await app.close().catch(() => {});
  for (const directory of Object.values(profiles)) {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
}
