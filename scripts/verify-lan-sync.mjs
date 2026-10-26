import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Two isolated fixture profiles on this machine: one host, one client, paired
// through the real settings UI over loopback. No real accounts are read.
const output = '.local/qa/lan-sync';
const port = 47400 + Math.floor(Math.random() * 400);
const profiles = { host: await mkdtemp(path.join(tmpdir(), 'ai-watch-sync-host-')), client: await mkdtemp(path.join(tmpdir(), 'ai-watch-sync-client-')) };
const base = { locked: false, animate: false, language: 'zh-CN', theme: 'dark', skin: 'watch', animeMode: false, mascotInterval: 0 };
await writeFile(path.join(profiles.host, 'preferences.json'), JSON.stringify({ ...base, syncRole: 'host', syncPort: port }));
await writeFile(path.join(profiles.client, 'preferences.json'), JSON.stringify({ ...base, syncRole: 'off', layout: 'single' }));
const launch = (profile, status) => electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: status } });
const errors = [], apps = [];
async function open(profile, status) {
  const app = await launch(profile, status); apps.push(app);
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.provider-card')).toHaveCount(8);
  return { app, page };
}
const settings = page => page.getByRole('button', { name: '打开配置', exact: true }).click();
const close = page => page.getByRole('button', { name: '关闭配置', exact: true }).click();
const section = (page, name) => page.locator('.settings-nav').getByRole('button', { name, exact: true }).click();

try {
  await mkdir(output, { recursive: true });
  let host = await open(profiles.host, 'glow-attention');
  // The host lists its code and port; the client never sees this machine's files.
  await settings(host.page); await section(host.page, '多端同步');
  await expect(host.page.locator('[data-section="sync"] .sync-status')).toContainText('正在共享');
  const code = (await host.page.locator('.sync-code').textContent()).trim();
  assert.match(code, /^\d{6}$/);
  await host.page.locator('[data-section="sync"]').screenshot({ path: path.join(output, 'host-settings.png') });
  await close(host.page);

  const client = await open(profiles.client, 'fixture');
  await settings(client.page); await section(client.page, '多端同步');
  await client.page.locator('[data-section="sync"] .segmented').getByRole('button', { name: '子客户端', exact: true }).click();
  await expect(client.page.locator('[data-section="sync"] .sync-status')).toContainText('尚未配对');
  // While unpaired the client shows placeholders, never its own readings.
  await expect(client.page.locator('.provider-card[data-provider="claude"] .task-line')).toContainText('等待主客户端数据');
  await client.page.getByLabel('主客户端地址').fill(`127.0.0.1:${port}`);
  await client.page.getByLabel('配对码').fill(code === '000000' ? '000001' : '000000');
  await client.page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(client.page.locator('.toast')).toContainText('配对码不正确');
  await client.page.getByLabel('配对码').fill(code);
  await client.page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(client.page.locator('[data-section="sync"] .sync-status')).toContainText('已连接到');
  await client.page.locator('[data-section="sync"]').screenshot({ path: path.join(output, 'client-settings.png') });
  await close(client.page);

  // The client now shows the host's fixture snapshot.
  const hostTask = await host.page.locator('.provider-card[data-provider="codex"] .task-line').textContent();
  await expect(client.page.locator('.provider-card[data-provider="codex"] .task-line')).toHaveText(hostTask);
  await expect(client.page.locator('.demo-tag.sync-tag')).toHaveText('同步');
  const clientStatus = await client.page.evaluate(() => window.panel.getStatus());
  assert.ok(clientStatus.remote?.host, 'client snapshot is marked as remote');
  assert.equal(JSON.stringify(clientStatus).includes(profiles.host), false, 'no host profile path in the synced snapshot');
  const hostStatus = await host.page.evaluate(() => window.panel.getStatus());
  assert.equal(clientStatus.codex.quotas.length, hostStatus.codex.quotas.length);

  // Read-only: opening an app is refused locally with a notice.
  await client.page.locator('.provider-card[data-provider="claude"] .avatar-launch').first().click();
  await expect(client.page.locator('.toast')).toContainText('子客户端不能打开主客户端上的应用');
  // The host's journal reaches the client (status-independent check of the IPC path).
  const shared = await host.page.evaluate(() => window.panel.shareJournal({ events: [{ at: Date.now(), id: 'codex', from: 'running', to: 'waiting', reason: 'input' }], samples: {}, last: {} }));
  assert.equal(shared, true);
  await expect.poll(async () => (await client.page.evaluate(() => window.panel.getRemoteJournal()))?.events?.length).toBeGreaterThan(0);
  await client.page.screenshot({ path: path.join(output, 'client-synced.png') });

  // Host goes away: the client keeps its pairing and reconnects when it returns.
  await host.app.close(); apps.splice(apps.indexOf(host.app), 1);
  await expect(client.page.locator('.demo-tag.sync-tag')).toHaveText('未同步', { timeout: 15000 });
  host = await open(profiles.host, 'glow-attention');
  await expect(client.page.locator('.demo-tag.sync-tag')).toHaveText('同步', { timeout: 40000 });

  // Resetting the code revokes the client.
  await settings(host.page); await section(host.page, '多端同步');
  await host.page.getByRole('button', { name: '重置配对码并断开所有设备', exact: true }).click();
  await expect(client.page.locator('.demo-tag.sync-tag')).toHaveText('未同步', { timeout: 15000 });
  await settings(client.page); await section(client.page, '多端同步');
  await expect(client.page.locator('[data-section="sync"] .sync-status')).toContainText('配对已失效');
  const stored = JSON.parse(await readFile(path.join(profiles.host, 'lan-sync.json'), 'utf8'));
  assert.deepEqual(stored.host.tokens, []);

  // Back to standalone: local readings return and no remote marker remains.
  await client.page.locator('[data-section="sync"] .segmented').getByRole('button', { name: '独立', exact: true }).click();
  await expect.poll(async () => Boolean((await client.page.evaluate(() => window.panel.getStatus())).remote)).toBe(false);
  assert.deepEqual(errors, [], 'renderer errors');
  console.log(`LAN sync checks passed on port ${port}: host code shown, wrong code refused, pairing via UI, client shows host data and journal, read-only open, reconnect after host restart, code reset revokes, back to standalone. Synthetic data only.`);
} finally {
  for (const app of apps) await app.close().catch(() => {});
  for (const dir of Object.values(profiles)) await rm(dir, { recursive: true, force: true });
}
