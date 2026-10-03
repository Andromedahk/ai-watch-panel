import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-work-ui-'));
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ enabledProviders: ['kimi'] }));
const launch = () => electron.launch({ args: ['.'], env: { ...process.env,
  AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
let app;
try {
  app = await launch();
  let page = await app.firstWindow();
  const ready = () => page.waitForFunction(() => Boolean(document.querySelector('main')?.getAttribute('data-sampled-at')));
  const card = () => page.locator('.provider-card[data-provider="kimi"]');
  const open = () => page.getByRole('button', { name: '打开配置', exact: true }).click();
  const close = () => page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await ready();
  await expect(card().getByRole('heading', { name: 'Kimi Code', exact: true })).toBeVisible();
  await open();
  await page.getByRole('button', { name: '选择 Kimi Work 来源', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择 Kimi Work 来源', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await close();
  await expect(card().getByRole('heading', { name: 'Kimi Work', exact: true })).toBeVisible();
  await expect(card()).toContainText('订阅额度');
  await expect(card()).toContainText('赠送额度');
  assert.match(await card().locator('.quota').first().getAttribute('title'), /到期时间/);
  assert.doesNotMatch(await card().innerText(), /5 小时|1 周/);
  await page.getByRole('button', { name: '打开 Kimi Work', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('已模拟打开 Kimi Work');
  await page.evaluate(() => window.panel.configure({ side: 'left', locked: false, animate: false }));
  let state = await page.evaluate(() => window.panel.getState());
  assert.equal(state.kimiSource, 'work'); assert.equal(state.kimiWorkApp, undefined); assert.equal(state.providerApps, undefined);
  const status = await page.evaluate(() => window.panel.getStatus());
  assert.equal(status.kimi.kimiSource, 'work'); assert.equal(status.kimi.activity, 'unknown'); assert.equal(status.kimi.activeTasks, 0);
  const prefs = JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8'));
  assert.equal(prefs.kimiSource, 'work');
  await app.close(); app = await launch(); page = await app.firstWindow();
  await ready();
  await expect(card().getByRole('heading', { name: 'Kimi Work', exact: true })).toBeVisible();
  await open(); await page.getByRole('button', { name: '选择 Kimi Code 来源', exact: true }).click(); await close();
  await expect(card().getByRole('heading', { name: 'Kimi Code', exact: true })).toBeVisible();
  state = await page.evaluate(() => window.panel.getState()); assert.equal(state.kimiSource, 'code');
  assert.equal(await page.evaluate(() => window.panel.setKimiSource('auto').then(() => false, () => true)), true);
  console.log('Kimi source switch, quota labels, simulated launch, settings preservation and restart passed with synthetic data.');
} finally {
  await app?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
