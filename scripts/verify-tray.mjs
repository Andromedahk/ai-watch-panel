import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-tray-'));
const originalPreferences = JSON.stringify({ locked: true, theme: 'dark' });
await writeFile(path.join(profile, 'preferences.json'), originalPreferences);
let app;
try {
  app = await electron.launch({ args: ['.'], env: { ...process.env,
    AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.getAttribute('data-sampled-at')));
  const state = () => page.evaluate(() => window.panel.getState());
  const native = () => app.evaluate(({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { visible: window.isVisible(), bounds: window.getBounds(), locked: window.isAlwaysOnTop(),
      dockVisible: process.platform === 'darwin' ? app.dock.isVisible() : null,
      windowCount: BrowserWindow.getAllWindows().length,
      sandbox: window.webContents.getLastWebPreferences().sandbox };
  });
  const restore = async () => {
    await app.evaluate(({ app }) => app.emit('activate'));
    await expect.poll(async () => (await native()).visible).toBe(true);
    await expect.poll(async () => (await state()).stored).toBe(false);
  };
  const storeLabel = process.platform === 'darwin' ? '收纳到菜单栏' : '收纳到托盘';
  assert.equal((await state()).trayAvailable, true);
  // Move away from the work-area boundary: macOS Dock animations can change that
  // boundary by a few pixels. Verify an intentional user position is not redocked.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 50, width: 200, height: 900 }));
  await page.waitForFunction(() => innerWidth === 200 && innerHeight === 900);
  const original = await native();
  assert.equal(original.sandbox, true);
  await page.getByRole('button', { name: 'Antigravity 下一页额度', exact: true }).click();
  const scroll = await page.locator('.provider-viewport').evaluate(element => element.scrollTop);
  const before = await page.evaluate(() => window.panel.getStatus());
  await page.getByRole('button', { name: storeLabel, exact: true }).click();
  await expect.poll(async () => (await native()).visible).toBe(false);
  assert.equal((await state()).stored, true);
  assert.equal((await native()).windowCount, 1);
  if (process.platform === 'darwin') assert.equal((await native()).dockVisible, false);
  // Main-process polling continues even with the renderer window hidden.
  await expect.poll(async () => (await page.evaluate(() => window.panel.getStatus())).sampledAt,
    { timeout: 12000 }).not.toBe(before.sampledAt);
  await restore();
  let restored = await native();
  assert.deepEqual(restored.bounds, original.bounds);
  assert.equal(restored.locked, true);
  assert.equal(await page.locator('.provider-viewport').evaluate(element => element.scrollTop), scroll);
  assert.equal(await page.locator('[data-provider="antigravity"] .quota-pagination > span').innerText(), '2/5');
  assert.equal(await readFile(path.join(profile, 'preferences.json'), 'utf8'), originalPreferences);

  await page.getByRole('button', { name: '收起面板', exact: true }).click();
  await expect(page.locator('main')).toHaveClass(/collapsed/);
  const railBounds = (await native()).bounds;
  assert.equal(railBounds.width, 46);
  await page.getByRole('button', { name: storeLabel, exact: true }).click();
  await expect.poll(async () => (await native()).visible).toBe(false);
  await restore();
  assert.equal((await state()).collapsed, true);
  assert.deepEqual((await native()).bounds, railBounds);
  await page.getByRole('button', { name: '展开面板', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(async () => (await native()).visible).toBe(false);
  assert.equal((await state()).stored, true);
  await restore();

  // Tight toolbar layouts in ordinary/anime modes must remain usable.
  await mkdir('.local/qa/tray', { recursive: true });
  for (const anime of [false, true]) for (const theme of ['light', 'dark']) {
    await page.evaluate(async ({ anime, theme }) => {
      await window.panel.setAnimeMode(anime); await window.panel.setTheme(theme);
    }, { anime, theme });
    for (const width of [200, 320]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0].setBounds({ width, height: width * 4.5 });
      }, width);
      await page.waitForFunction(width => innerWidth === width, width);
      const controls = await page.locator('.toolbar').evaluate(element => {
        const parent = element.getBoundingClientRect();
        return [...element.querySelectorAll('button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { width: rect.width, height: rect.height, fits: rect.left >= parent.left && rect.right <= parent.right + .1 };
        });
      });
      assert.equal(controls.length, 5);
      assert.ok(controls.every(control => control.fits && control.width >= 24 && control.height >= 22));
      if (width === 200) await page.screenshot({ path: `.local/qa/tray/${anime ? 'anime' : 'standard'}-${theme}.png`, animations: 'disabled' });
    }
  }
  // Exiting while hidden must release the tray rather than prevent app shutdown.
  await page.evaluate(() => window.panel.store());
  const closed = app.waitForEvent('close');
  await page.evaluate(() => window.panel.quit()).catch(() => {});
  await closed;
  app = null;
  console.log('Tray checks passed: hidden background polling, restore, position/lock/scroll/pagination preservation, collapsed rail, close-to-tray, eight toolbar layouts, sandbox and exit while hidden.');
} finally {
  await app?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
