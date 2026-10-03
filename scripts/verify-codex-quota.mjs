import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-quota-'));
// All UI samples are synthetic; this suite never queries real accounts or changes their login.
const app = await electron.launch({ args: ['.'], env: { ...process.env,
  AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.getAttribute('data-sampled-at')));
  const baseline = await page.evaluate(() => window.panel.getStatus());
  const card = id => page.locator(`.provider-card[data-provider="${id}"]`);
  let sequence = 0;
  async function send(changes, testData = false) {
    const snapshot = structuredClone(baseline);
    snapshot.sampledAt = new Date(Date.now() + 3600000 + sequence++).toISOString();
    snapshot.isTestData = testData;
    for (const [id, change] of Object.entries(changes)) Object.assign(snapshot[id], change);
    await app.evaluate(({ BrowserWindow }, status) => BrowserWindow.getAllWindows()[0].webContents.send('panel:status-changed', status), snapshot);
    await expect(page.locator('main')).toHaveAttribute('data-sampled-at', snapshot.sampledAt);
  }
  const weekly = { model: 'Codex', period: '1 周', remaining: 72.5, reset: '2099-10-09T00:00:00Z', stale: false };
  const merged = ['Gemini Pro', 'Gemini Flash', 'Claude Sonnet', 'Claude Opus', 'GPT-OSS'].map(model => ({ model,
    period: '模型额度', remaining: 60, reset: '2099-10-09T00:00:00Z', stale: false,
    variants: [`${model} (High)`, `${model} (Low)`] }));
  for (const animeMode of [false, true]) {
    await page.evaluate(value => window.panel.setAnimeMode(value), animeMode);
    for (const appearance of ['light', 'dark']) {
      await page.evaluate(value => window.panel.setTheme(value), appearance);
      await send({ codex: { source: 'account', connection: 'ready', activity: 'offline', activeTasks: 0,
        plan: { name: 'Pro', status: '官方查询' }, quotas: [weekly] }, antigravity: { quotas: merged } });
      await expect(card('codex').locator('.quota')).toHaveCount(1);
      await expect(card('codex').locator('.quota-label')).toContainText('1 周');
      await expect(card('codex').locator('.quota-label')).toContainText('72.5');
      await expect(card('codex').locator('.source-tag')).toHaveText('账号额度');
      await expect(card('codex').locator('.task-status')).toHaveText('离线');
      await expect(card('codex').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '72.5');
      const labels = await card('antigravity').locator('.model-name').allTextContents();
      assert.equal(labels.some(label => /High|Low|Medium|Thinking/.test(label)), false);
      await expect(card('antigravity').locator('.quota').first()).toHaveAttribute('title', /合并.*High.*Low/);
      await card('antigravity').getByRole('button', { name: 'Antigravity 下一页额度', exact: true }).click();
      const next = await card('antigravity').locator('.model-name').allTextContents();
      assert.equal(new Set([...labels, ...next]).size, animeMode ? 4 : 5);
      await card('antigravity').getByRole('button', { name: 'Antigravity 上一页额度', exact: true }).click();
      const overflow = await card('codex').evaluate(element => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
      assert.equal(overflow, false);
      await send({ codex: { source: 'cache', connection: 'error', task: '合成测试 · 历史额度展示', plan: { name: 'Pro', status: '官方查询缓存', stale: true },
        quotas: [{ ...weekly, stale: true }] } });
      await expect(card('codex').locator('.source-tag')).toHaveText('查询缓存');
      await expect(card('codex').locator('.quota-label')).toContainText('历史72.5%');
      await expect(card('codex').locator('.quota-fill')).toHaveCount(0);
      await expect(card('codex').getByRole('progressbar')).toHaveAttribute('aria-valuetext', '历史剩余 72.5%，当前额度待更新');
      await expect(card('codex').getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
      if (animeMode && appearance === 'dark') {
        await send({ codex: { source: 'cache', connection: 'error', task: '合成测试 · 历史额度展示', plan: { name: 'Pro', status: '官方查询缓存', stale: true }, quotas: [{ ...weekly, stale: true }] } }, true);
        await mkdir('docs/screenshots', { recursive: true });
        await card('codex').screenshot({ path: 'docs/screenshots/codex-quota-history.png' });
      }
      await send({ codex: { source: 'unavailable', connection: 'auth-required', plan: { name: null },
        quotas: [{ ...weekly, remaining: null }] } });
      await expect(card('codex').locator('.quota-label')).not.toContainText('72.5');
      await expect(card('codex').locator('.source-tag')).toHaveText('待登录');
    }
  }
  // Capture synthetic live-query/merged models with the global test indicator visible.
  await send({ codex: { source: 'account', connection: 'ready', plan: { name: 'Pro', status: '官方查询' }, quotas: [weekly] },
    antigravity: { quotas: merged } }, true);
  await page.locator('.provider-viewport').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: 'docs/screenshots/quotas-online-merged.png' });
  assert.equal((await page.evaluate(() => window.panel.getState())).qwenKeychainAllowed, false);
  console.log('Quota UI checks passed: official weekly-only display, no invented five-hour window, allowances with app closed, historical numbers without current progress, cleared login, merged model names/hover/pagination, both themes and logo modes. All samples synthetic.');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
