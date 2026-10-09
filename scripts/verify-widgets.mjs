import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') throw new Error('Native widget acceptance requires macOS');
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-widgets-'));
const snapshotPath = path.join(profile, 'widget-snapshot.json');
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ theme: 'dark', kimiSource: 'work',
  enabledProviders: ['codex', 'deepseek', 'zcode', 'kimi'] }));
const launch = enabled => electron.launch({ args: ['.'], env: { ...process.env,
  AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture', AI_WATCH_TEST_WIDGETS: enabled ? '1' : '0' } });
let app;
try {
  app = await launch(false);
  let page = await app.firstWindow();
  await page.getByRole('button', { name: '打开配置', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '同步小组件', exact: true })).toBeDisabled();
  await assert.rejects(page.evaluate(() => window.panel.widgetBackground()));
  await app.close();

  app = await launch(true); page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.getAttribute('data-sampled-at')));
  await page.getByRole('button', { name: '打开配置', exact: true }).click();
  await page.getByRole('checkbox', { name: '同步小组件', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '同步小组件', exact: true })).toBeChecked();
  await expect.poll(async () => JSON.parse(await readFile(snapshotPath, 'utf8')).rows.length).toBe(4);
  const initial = JSON.parse(await readFile(snapshotPath, 'utf8'));
  assert.equal(initial.isTestData, true); assert.equal(initial.theme, 'dark');
  assert.equal(initial.rows.find(row => row.id === 'kimi').name, 'Kimi Work');
  assert.equal(initial.rows.find(row => row.id === 'kimi').activity, 'unknown');
  assert.equal(initial.rows.find(row => row.id === 'codex').remaining, 75);
  assert.doesNotMatch(JSON.stringify(initial), /task|detail|token|providerApps|kimiWorkApp/);
  // A publication failure during an ordinary refresh must reach the open settings.
  await app.evaluate(({ app }) => {
    const { WidgetPublisher } = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/electron/main.cjs')('./widget-publisher.cjs');
    global.restoreWidgetPublish = WidgetPublisher.prototype.publish;
    WidgetPublisher.prototype.publish = function () { this.error = true; this.signature = null; return false; };
  });
  await page.evaluate(() => window.panel.refreshStatus());
  await expect(page.getByText('小组件同步失败，请重试', { exact: true })).toBeVisible();
  await app.evaluate(({ app }) => {
    const { WidgetPublisher } = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/electron/main.cjs')('./widget-publisher.cjs');
    WidgetPublisher.prototype.publish = global.restoreWidgetPublish;
    delete global.restoreWidgetPublish;
  });
  await page.evaluate(() => window.panel.refreshStatus());
  await expect(page.getByText('小组件同步失败，请重试', { exact: true })).toHaveCount(0);
  for (const value of [null, 'true', 1, {}]) await assert.rejects(page.evaluate(value => window.panel.setWidgetsEnabled(value), value));
  await page.evaluate(() => window.panel.configure({ side: 'right', locked: false, animate: true }));
  assert.equal((await page.evaluate(() => window.panel.getState())).widgetsEnabled, true);
  await mkdir('.local', { recursive: true });
  await page.screenshot({ path: '.local/widget-settings.png' });
  await page.getByRole('button', { name: '仅保留桌面小组件', exact: true }).click();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  let state = await page.evaluate(() => window.panel.getState());
  assert.equal(state.widgetBackground, true); assert.equal(state.trayAvailable, false);
  await expect.poll(() => app.evaluate(({ app }) => app.dock.isVisible())).toBe(false);
  const before = (await page.evaluate(() => window.panel.getStatus())).sampledAt;
  await expect.poll(() => page.evaluate(() => window.panel.getStatus().then(status => status.sampledAt)), { timeout: 10000 }).not.toBe(before);
  // Untrusted URL data cannot trigger restoration or other actions.
  await app.evaluate(({ app }) => app.emit('open-url', { preventDefault() {} }, 'aiwatch://panel?command=other'));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await app.evaluate(({ app }) => app.emit('open-url', { preventDefault() {} }, 'aiwatch://panel'));
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  state = await page.evaluate(() => window.panel.getState());
  assert.equal(state.widgetBackground, false); assert.equal(state.trayAvailable, true);
  await page.evaluate(() => window.panel.setKimiSource('code'));
  assert.equal(JSON.parse(await readFile(snapshotPath, 'utf8')).rows.find(row => row.id === 'kimi').name, 'Kimi Code');
  await page.evaluate(() => window.panel.setEnabled(['codex']));
  assert.deepEqual(JSON.parse(await readFile(snapshotPath, 'utf8')).rows.map(row => row.id), ['codex']);
  await page.evaluate(() => window.panel.setTheme('light'));
  assert.equal(JSON.parse(await readFile(snapshotPath, 'utf8')).theme, 'light');
  await app.close(); app = await launch(true); page = await app.firstWindow();
  await page.waitForFunction(async () => (await window.panel.getState()).widgetsEnabled);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await page.evaluate(() => window.panel.setWidgetsEnabled(false));
  await assert.rejects(access(snapshotPath));
  assert.equal(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).widgetsEnabled, false);
  await assert.rejects(page.evaluate(() => window.panel.widgetBackground()));
  console.log('Widget settings, isolated snapshots, background polling, recovery, source, preferences and clearing passed. Native gallery/signing not exercised.');
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
