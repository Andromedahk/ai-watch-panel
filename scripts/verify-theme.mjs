import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-theme-'));
const launch = () => electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
let app = await launch();
try {
  let page = await app.firstWindow();
  const ready = () => page.waitForFunction(() => Boolean(document.querySelector('main')?.getAttribute('data-sampled-at')));
  const theme = value => expect(page.locator('html')).toHaveAttribute('data-theme', value);
  const settings = () => page.getByRole('button', { name: '打开配置', exact: true }).click();
  const close = () => page.getByRole('button', { name: '关闭配置', exact: true }).click();
  const follow = () => page.getByRole('checkbox', { name: '跟随系统', exact: true });
  const dark = () => page.getByRole('checkbox', { name: '暗夜模式', exact: true });
  await ready();
  const initial = await app.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }));
  assert.equal(initial.source, 'system');
  await theme(initial.dark ? 'dark' : 'light');
  await settings(); await expect(follow()).toBeChecked();

  // Exercise native theme notifications without changing the user's OS appearance.
  for (const appearance of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value; }, appearance);
    await theme(appearance);
    await expect(dark()).toBeChecked({ checked: appearance === 'dark' });
    assert.equal((await page.evaluate(() => window.panel.getState())).theme, 'system');
  }
  // A manual change exits automatic mode immediately, even if the dialog is closed without Save.
  await dark().click(); await theme('light'); await expect(follow()).not.toBeChecked();
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'light');
  await close(); await settings(); await expect(dark()).not.toBeChecked();
  await dark().click(); await theme('dark');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  assert.equal((await page.evaluate(() => window.panel.getState())).theme, 'dark');
  await app.evaluate(({ nativeTheme }) => nativeTheme.emit('updated'));
  await theme('dark');
  assert.equal(await page.evaluate(async () => { try { await window.panel.setTheme('invalid'); return false; } catch { return true; } }), true);

  await app.close(); app = await launch(); page = await app.firstWindow(); await ready();
  await theme('dark');
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark');
  await settings(); await follow().click(); await expect(follow()).toBeChecked();
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'system');
  await theme(await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
  // Synthetic tasks exercise quotas, balances, all logos and the Codex attention color in both palettes.
  await page.getByRole('checkbox', { name: '测试模式', exact: true }).check();
  await page.getByRole('button', { name: 'Codex 待回答', exact: true }).click();
  await close();
  for (const appearance of ['light', 'dark']) {
    await page.evaluate(value => window.panel.setTheme(value), appearance); await theme(appearance);
    const metrics = await page.evaluate(() => {
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      const luminance = color => {
        ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
        const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      return [...document.querySelectorAll('.provider-card')].map(card => {
        const bg = luminance(getComputedStyle(card).backgroundColor);
        const contrasts = [...card.querySelectorAll('h2, .quota-label strong, .balance-total strong, .credit-value, .plan-name, .task-status')].map(el => {
          const fg = luminance(getComputedStyle(el).color); return (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05);
        });
        return { overflow: card.scrollWidth > card.clientWidth || card.scrollHeight > card.clientHeight, contrasts };
      });
    });
    assert.equal(metrics.length, 8);
    assert.equal(await page.locator('.provider-viewport img').evaluateAll(images => images.length === 8 && images.every(image => image.complete && image.naturalWidth > 0)), true);
    assert.ok(metrics.every(item => !item.overflow), 'Theme must preserve card layout');
    assert.ok(metrics.every(item => item.contrasts.every(value => value >= 4.5)), JSON.stringify({ appearance, metrics }));
    await expect(page.locator('.provider-card[data-provider="codex"] .avatar')).toHaveAttribute('data-glow', 'attention');
    await expect(page.locator('.toast')).toBeHidden();
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.card-heading .avatar'), '::before').opacity) > .95);
    await page.screenshot({ path: `docs/screenshots/theme-${appearance}.png` });
    await page.getByRole('button', { name: '收起面板' }).click(); await theme(appearance);
    assert.equal(await page.locator('.collapsed-rail').evaluate(el => getComputedStyle(el).colorScheme), appearance);
    await page.getByRole('button', { name: '展开面板' }).click();
  }
  await settings(); await page.getByRole('checkbox', { name: '测试模式', exact: true }).uncheck();
  await dark().click(); await theme('light');
  await expect(page.locator('.toast')).toBeHidden();
  await page.getByRole('group', { name: '外观', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/theme-settings-light.png' });
  await follow().click(); await expect(follow()).toBeChecked();
  await page.getByRole('group', { name: '外观', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/theme-settings.png' });
  assert.equal(await follow().evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region')), 'no-drag');
  const saved = JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8'));
  assert.equal(saved.theme, 'system');

  // Check the standalone browser preview using a window without the desktop bridge.
  const previewPromise = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, file) => {
    const preview = new BrowserWindow({ show: false, width: 320, height: 1440, webPreferences: { sandbox: true, contextIsolation: true } });
    await preview.loadFile(file);
  }, path.resolve('dist/index.html'));
  const preview = await previewPromise;
  await preview.emulateMedia({ colorScheme: 'light' });
  await expect(preview.locator('html')).toHaveAttribute('data-theme', 'light');
  await preview.emulateMedia({ colorScheme: 'dark' });
  await expect(preview.locator('html')).toHaveAttribute('data-theme', 'dark');
  await preview.getByRole('button', { name: '打开配置', exact: true }).click();
  await preview.getByRole('checkbox', { name: '暗夜模式', exact: true }).uncheck();
  await preview.emulateMedia({ colorScheme: 'light' }); await preview.emulateMedia({ colorScheme: 'dark' });
  await expect(preview.locator('html')).toHaveAttribute('data-theme', 'light');
  await preview.reload(); await expect(preview.locator('html')).toHaveAttribute('data-theme', 'light');
  await preview.close();
  await app.close(); app = await launch(); page = await app.firstWindow(); await ready();
  assert.equal((await page.evaluate(() => window.panel.getState())).theme, 'system');
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'system');
  await theme(await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
  console.log('Theme checks passed: default/system events, manual override, invalid IPC, persistence, cold restart, settings/rail, contrast, attention glow, browser media changes.');
} finally {
  await app.close(); await rm(profile, { recursive: true, force: true });
}
