import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const planIds = ['claude', 'codex', 'antigravity', 'zcode', 'kimi', 'qwen', 'workbuddy'];
const names = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', zcode: 'ZCode', kimi: 'Kimi Code', qwen: 'Qwen（千问）', workbuddy: 'WorkBuddy' };
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-plans-'));
// Both a separate profile and fixture mode are mandatory. No real login, credential or account API is used.
const app = await electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
let preview;
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.getAttribute('data-sampled-at')));
  assert.equal((await page.evaluate(() => window.panel.getState())).qwenKeychainAllowed, false);
  const card = id => page.locator(`.provider-card[data-provider="${id}"]`);
  await expect(page.locator('.identity .plan-summary')).toHaveCount(7);
  await expect(card('deepseek').locator('.plan-summary')).toHaveCount(0);
  const baseline = await page.evaluate(() => window.panel.getStatus());
  let sequence = 0;
  async function send(changes) {
    const snapshot = structuredClone(baseline);
    snapshot.sampledAt = new Date(Date.now() + 3600000 + sequence++).toISOString();
    snapshot.isTestData = true;
    for (const [id, change] of Object.entries(changes)) Object.assign(snapshot[id], change);
    await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('panel:status-changed', value), snapshot);
    await expect(page.locator('main')).toHaveAttribute('data-sampled-at', snapshot.sampledAt);
  }
  // The five newly supported providers must render the upstream tier rather than derive one from usage.
  const samplePlans = { claude: 'Max 20x', codex: 'Pro', antigravity: 'Google AI Ultra', zcode: 'GLM Coding Pro', kimi: 'Moderato', qwen: 'Plus', workbuddy: '体验版' };
  await send(Object.fromEntries(planIds.map(id => [id, { plan: { name: samplePlans[id] } }])));
  for (const id of planIds) await expect(card(id).locator('.identity .plan-name')).toHaveText(samplePlans[id]);

  // Missing plan information is unknown even if quota rows are absent, empty or fully used.
  for (const id of planIds) {
    await send({ [id]: { plan: { name: null }, quotas: [] } });
    await expect(card(id).locator('.plan-name')).toHaveText('套餐未知');
    await expect(card(id).locator('.plan-summary')).not.toContainText(/Free|免费/i);
    if (id === 'claude') await expect(card(id).locator('.claude-empty')).not.toContainText(/Free|免费/i);
  }
  await send({ claude: { plan: { name: 'Pro' }, quotas: [] } });
  await expect(card('claude').locator('.plan-name')).toHaveText('Pro');
  await expect(card('claude').locator('.claude-empty')).not.toContainText(/Free|免费/i);
  await send({ claude: { plan: { name: 'Free' }, quotas: [] } });
  await expect(card('claude').locator('.plan-name')).toHaveText('Free');

  // Historical and expired tiers must be visually distinct, while retaining the recorded tier name.
  for (const id of planIds) {
    await send({ [id]: { plan: { name: samplePlans[id], stale: true } } });
    await expect(card(id).locator('.plan-summary')).toHaveClass(/is-stale/);
    await expect(card(id).locator('.plan-summary')).toContainText('历史');
    await expect(card(id).locator('.plan-name')).toHaveText(samplePlans[id]);
    await send({ [id]: { plan: { name: samplePlans[id], expiresAt: '2000-01-01T00:00:00Z' } } });
    await expect(card(id).locator('.plan-summary')).toContainText('到期');
  }

  // A separate sandboxed browser preview exercises logical screen sizes without moving the user's panel.
  const previewPromise = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, file) => {
    const window = new BrowserWindow({ show: false, frame: false, width: 320, height: 1440,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadFile(file);
  }, path.resolve('dist/index.html'));
  preview = await previewPromise;
  await preview.getByRole('button', { name: '打开配置', exact: true }).click();
  await preview.getByRole('checkbox', { name: '测试模式', exact: true }).check();
  await preview.getByRole('button', { name: '全部待机', exact: true }).click();
  await preview.getByRole('button', { name: '关闭配置', exact: true }).click();
  await expect(preview.locator('.identity .plan-summary')).toHaveCount(7);
  const previewCard = id => preview.locator(`.provider-card[data-provider="${id}"]`);
  const scroll = bottom => preview.locator('.provider-viewport').evaluate((el, value) => el.scrollTo({ top: value ? el.scrollHeight : 0, behavior: 'instant' }), bottom);
  const setTheme = async appearance => {
    await preview.getByRole('button', { name: '打开配置', exact: true }).click();
    await preview.getByRole('checkbox', { name: '暗夜模式', exact: true }).setChecked(appearance === 'dark');
    await preview.getByRole('button', { name: '关闭配置', exact: true }).click();
    await expect(preview.locator('html')).toHaveAttribute('data-theme', appearance);
  };
  async function checkGeometry(size, appearance) {
    const metrics = await preview.locator('.provider-card').evaluateAll(cards => {
      const box = element => {
        const { top, bottom, left, right, width, height } = element.getBoundingClientRect();
        return { top, bottom, left, right, width, height };
      };
      return cards.map(card => {
        const heading = box(card.querySelector('.card-heading'));
        const content = box(card.querySelector('.quota-area'));
        const footer = box(card.querySelector('.task-line'));
        const identity = box(card.querySelector('.identity'));
        const name = box(card.querySelector('h2'));
        const summary = card.querySelector('.plan-summary');
        const rows = [...card.querySelectorAll('.credit-item')].map(row => ({ box: box(row), label: box(row.querySelector('.credit-label')),
          amount: box(row.querySelector('.credit-amount')), value: box(row.querySelector('.credit-value')),
          separator: getComputedStyle(row).borderTopWidth, overflow: row.scrollWidth > row.clientWidth + 1 || row.scrollHeight > row.clientHeight + 1 }));
        return { id: card.dataset.provider, card: box(card), heading, content, footer, identity, name, plan: summary && box(summary), rows,
          overflow: card.scrollWidth > card.clientWidth + 1 || card.scrollHeight > card.clientHeight + 1,
          imageLoaded: [...card.querySelectorAll('img')].every(image => image.complete && image.naturalWidth > 0) };
      });
    });
    assert.equal(metrics.length, 8);
    for (const item of metrics) {
      const context = JSON.stringify({ size, appearance, ...item });
      assert.equal(item.overflow, false, context);
      assert.equal(item.imageLoaded, true, context);
      assert.ok(item.heading.bottom <= item.content.top + 1, context);
      assert.ok(item.content.bottom <= item.footer.top + 1, context);
      assert.ok(item.footer.bottom <= item.card.bottom, context);
      if (item.plan) {
        assert.ok(item.plan.top >= item.name.bottom - 1, context);
        assert.ok(item.plan.left >= item.identity.left - 1 && item.plan.right <= item.identity.right + 1, context);
        assert.ok(item.plan.bottom <= item.heading.bottom + 1, context);
      }
      for (const row of item.rows) {
        assert.equal(row.overflow, false, context);
        assert.ok(row.label.right + 3 <= row.amount.left, context);
        assert.ok(Math.min(row.label.bottom, row.amount.bottom) > Math.max(row.label.top, row.amount.top), context);
        assert.ok(row.value.width > 0 && row.value.right <= item.card.right, context);
        assert.ok(row.box.top >= item.content.top && row.box.bottom <= item.footer.top, context);
      }
      if (item.rows.length > 1) {
        assert.ok(item.rows[1].box.top >= item.rows[0].box.bottom, context);
        assert.ok(item.rows[1].label.top - item.rows[0].label.bottom >= 4, context);
        assert.ok(parseFloat(item.rows[1].separator) > 0, context);
      }
    }
  }
  await mkdir('docs/screenshots', { recursive: true });
  for (const size of [{ width: 320, height: 1440 }, { width: 200, height: 900 }]) {
    await preview.setViewportSize(size);
    assert.equal(await preview.evaluate(() => innerWidth), size.width);
    assert.equal(await preview.evaluate(() => innerHeight), size.height);
    for (const appearance of ['light', 'dark']) {
      await setTheme(appearance);
      await checkGeometry(size, appearance);
      await scroll(true);
      for (const id of ['qwen', 'workbuddy']) {
        const region = previewCard(id);
        await expect(region.locator('.quota-pagination')).toHaveText('1/2');
        for (const label of await region.locator('.credit-amount > span').all()) {
          await expect(label).toHaveText('剩余');
          await expect(label).toBeVisible();
          await expect(label).not.toHaveClass(/sr-only/);
        }
        const first = await region.locator('.credit-label').allTextContents();
        await region.getByRole('button', { name: `${names[id]} 下一页额度`, exact: true }).click();
        await expect(region.locator('.quota-pagination')).toHaveText('2/2');
        assert.equal(new Set([...first, ...await region.locator('.credit-label').allTextContents()]).size, 4);
        await checkGeometry(size, appearance);
        await region.getByRole('button', { name: `${names[id]} 上一页额度`, exact: true }).click();
      }
      await expect(preview.locator('.toast')).toBeHidden();
      if (size.height === 1440) {
        await previewCard('workbuddy').screenshot({ path: `docs/screenshots/workbuddy-layout-${appearance}.png`, animations: 'disabled' });
        await preview.screenshot({ path: `docs/screenshots/plans-more-${appearance}.png`, animations: 'disabled' });
        await scroll(false);
        await preview.screenshot({ path: `docs/screenshots/plans-first-${appearance}.png`, animations: 'disabled' });
      } else {
        await preview.screenshot({ path: `docs/screenshots/plans-compact-${appearance}.png`, animations: 'disabled' });
      }
    }
  }
  assert.equal((await page.evaluate(() => window.panel.getState())).qwenKeychainAllowed, false);
  console.log('Plan UI checks passed: seven header tiers, five newly supported plans, unknown without guessed Free, Claude quota absence independent of tier, historical and expired states, separate labels and values, row separators, pagination, eight loaded logos, no heading/content/footer overlap at 320×1440 and 200×900 in both themes. Fixture-only; Qwen access remains off.');
} finally {
  await preview?.close();
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
