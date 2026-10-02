import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-manual-test-'));
const app = await electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
try {
  const page = await app.firstWindow();
  const main = page.locator('main');
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.getAttribute('data-sampled-at')));
  await page.evaluate(() => window.panel.setEnabled(['claude', 'codex', 'antigravity', 'deepseek']));
  await expect(page.locator('.provider-card')).toHaveCount(4);
  const original = await page.evaluate(() => window.panel.getStatus());
  const card = id => page.getByRole('region', { name: `${id} 面板`, exact: true });
  const configure = () => page.getByRole('button', { name: '打开配置', exact: true }).click();
  const view = () => page.getByRole('button', { name: '查看测试面板', exact: true }).click();
  const select = (name, value) => page.getByRole('combobox', { name, exact: true }).selectOption(value);
  await expect(main).toHaveAttribute('data-test-mode', 'false');
  assert.equal(await page.locator('.control-region').evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region')), 'drag');
  await configure();
  // DOM clicks bypass native window hit testing; also guard the modal's drag-region policy.
  for (const target of [page.locator('.control-region'), page.getByRole('dialog'), page.getByRole('checkbox', { name: '测试模式', exact: true })]) {
    assert.equal(await target.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region')), 'no-drag');
  }
  await page.getByRole('checkbox', { name: '测试模式', exact: true }).check();
  await expect(page.getByRole('combobox')).toHaveCount(12);
  await expect(page.getByRole('status')).toBeHidden();
  assert.equal(await page.locator('.settings-content').evaluate(el => el.scrollWidth > el.clientWidth), false);
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/test-settings.png' });
  await view();
  assert.equal(await page.locator('.control-region').evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region')), 'drag');
  await expect(page.locator('.panel-regions .avatar[data-glow="running"]')).toHaveCount(4);
  await expect(page.locator('.source-tag')).toHaveText(['测试数据', '测试数据', '测试数据', '测试数据']);

  for (const [preset, phase, glow] of [['全部待机', '待机', 'off'], ['Codex 待回答', '待回答', 'attention'], ['Codex 待授权', '待授权', 'attention']]) {
    await configure(); await page.getByRole('button', { name: preset, exact: true }).click(); await view();
    await expect(card('Codex').locator('.task-status')).toHaveText(phase);
    await expect(card('Codex').locator('.avatar')).toHaveAttribute('data-glow', glow);
  }
  await configure();
  await select('Codex 测试任务状态', 'mixed');
  await select('Claude Code 测试任务状态', 'offline');
  await select('Antigravity 测试任务状态', 'unknown');
  await select('DeepSeek Harness 测试任务状态', 'waiting');
  await view();
  await expect(page.locator('.overview')).toContainText('1 项运行');
  await expect(card('Codex').locator('.avatar')).toHaveAttribute('data-glow', 'attention');
  await expect(card('Claude Code').locator('.task-status')).toHaveText('离线');
  await expect(card('Antigravity').locator('.task-status')).toHaveText('未知');
  await expect(card('DeepSeek Harness').locator('.task-status')).toHaveText('待确认');

  // Bounds, missing data, and history must remain distinct at the rendered progress bars.
  for (const [value, text] of [['low', '12.5%'], ['zero', '0%'], ['full', '100%'], ['unknown', '未知'], ['stale', '记录已过时']]) {
    await configure(); await select('Codex 测试数据显示', value); await view();
    await expect(card('Codex').getByRole('progressbar').first()).toHaveAttribute('aria-valuetext', text);
    if (['unknown', 'stale'].includes(value)) await expect(card('Codex').locator('.quota-fill')).toHaveCount(0);
  }
  await configure(); await select('Claude Code 测试数据显示', 'free'); await view();
  await expect(card('Claude Code')).toContainText('Code 额度暂不可用');
  for (const [value, text] of [['zero', '0.00'], ['tiny', '<0.01'], ['stale', '历史余额'], ['signed-out', '等待 Harness 登录'], ['unknown', '余额暂不可用'], ['error', '余额读取失败']]) {
    await configure(); await select('DeepSeek Harness 测试数据显示', value); await view();
    await expect(card('DeepSeek Harness')).toContainText(text);
  }
  await configure(); await select('DeepSeek Harness 测试数据显示', 'normal'); await view();
  await page.getByRole('button', { name: '切换余额币种' }).click();
  await expect(page.locator('.balance-total strong')).toHaveText('2.10');
  const next = page.getByRole('button', { name: 'Antigravity 下一页额度' });
  await next.click(); await next.click();
  await expect(card('Antigravity').locator('.quota-pagination')).toHaveText('3/3');
  await expect(next).toBeDisabled();

  // A manual UI refresh must not call the provider refresh bridge.
  await app.evaluate(({ ipcMain }) => {
    globalThis.testRefreshCalls = 0;
    ipcMain.removeHandler('panel:refresh');
    ipcMain.handle('panel:refresh', () => { globalThis.testRefreshCalls++; throw new Error('Unexpected provider refresh'); });
  });
  await page.getByRole('button', { name: '刷新面板' }).click();
  await expect(page.getByRole('status')).toHaveText('测试画面已刷新');
  assert.equal(await app.evaluate(() => globalThis.testRefreshCalls), 0);
  await expect(card('Antigravity').locator('.quota-pagination')).toHaveText('3/3');
  await expect(page.locator('.balance-total strong')).toHaveText('2.10');
  // Let the ordinary background sample arrive while manual selections remain in force.
  await expect(page.getByRole('status')).toBeHidden();
  await expect(card('Codex').locator('.task-status')).toHaveText('待处理');
  assert.deepEqual(await page.evaluate(() => window.panel.getStatus()), original);

  await configure();
  await page.getByRole('button', { name: '全部运行', exact: true }).click();
  await page.getByRole('checkbox', { name: '状态灯动画' }).uncheck();
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect.poll(() => card('Codex').locator('.avatar').evaluate(el => getComputedStyle(el, '::before').animationName)).toBe('none');
  await page.getByRole('button', { name: '收起面板' }).click();
  await expect(page.locator('.rail-providers .avatar[data-glow="running"]')).toHaveCount(4);
  assert.equal((await page.evaluate(() => window.panel.getState())).bounds.width, 46);
  await page.getByRole('button', { name: '测试模式设置' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('checkbox', { name: '测试模式', exact: true }).uncheck();
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await expect(main).toHaveAttribute('data-test-mode', 'false');
  await expect(card('Codex').locator('.task-line > span:nth-child(2)')).toHaveText(original.codex.task);
  await expect(card('Antigravity').locator('.quota-pagination')).toHaveText('1/5');
  await expect(page.locator('.balance-total strong')).toHaveText('13.57');

  await configure(); await page.getByRole('checkbox', { name: '测试模式', exact: true }).check(); await view();
  await page.reload();
  await expect(main).toHaveAttribute('data-test-mode', 'false');
  await expect(card('Codex').locator('.task-line > span:nth-child(2)')).toHaveText(original.codex.task);
  console.log('Manual test mode passed: modal drag policy, scenarios, quota bounds, balance states, pagination, refresh isolation, collapse, disabled animation, live restore, reload reset.');
} finally {
  await app.close(); await rm(profile, { recursive: true, force: true });
}
