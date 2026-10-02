import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-sort-'));
const launch = () => electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
let app = await launch();
try {
  let page = await app.firstWindow();
  const ready = () => page.waitForFunction(() => Boolean(document.querySelector('main')?.getAttribute('data-sampled-at')));
  const card = id => page.locator(`.provider-card[data-provider="${id}"]`);
  const order = () => page.locator('.provider-card').evaluateAll(cards => cards.map(el => el.dataset.provider));
  const original = ['claude', 'codex', 'antigravity', 'deepseek'];
  await ready();
  await page.evaluate(ids => window.panel.setEnabled(ids), original);
  await expect.poll(order).toEqual(original);
  await page.bringToFront();
  // macOS can adjust the work area just after the app becomes foreground.
  await page.waitForTimeout(1000);
  assert.deepEqual(await order(), original);
  await page.evaluate(() => {
    window.sortEvents = [];
    for (const name of ['pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture', 'blur', 'resize']) {
      window.addEventListener(name, event => {
        window.sortEvents.push({ name, target: event.target?.className, primary: event.isPrimary, buttons: event.buttons, size: [innerWidth, innerHeight] });
        window.sortEvents = window.sortEvents.slice(-24);
      });
    }
  });
  const bounds = (await page.evaluate(() => window.panel.getState())).bounds;
  const header = await page.locator('.control-region').boundingBox();
  const layout = await page.locator('.provider-card').evaluateAll(cards => cards.map(el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: innerWidth - r.right, radius: getComputedStyle(el).borderRadius, top: r.top, bottom: r.bottom };
  }));
  for (const card of layout) { assert.equal(card.left, 8); assert.equal(card.right, 8); assert.equal(card.radius, '14px'); }
  for (let i = 1; i < layout.length; i++) assert.ok(Math.abs(layout[i].top - layout[i - 1].bottom - 8) < .1);
  assert.ok(Math.abs(layout[0].top - header.y - header.height - 8) < .1);
  assert.ok(Math.abs(bounds.height - layout[3].bottom - 8) < .1);
  const grab = async (id, hold = true) => {
    // The avatar is an application-launch button; drag from the explicit index grip.
    const box = await card(id).locator('.card-index').boundingBox(); const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    if (hold) try { await expect(card(id)).toHaveClass(/is-dragging/); }
    catch (error) { console.log(await page.evaluate(() => window.sortEvents)); throw error; }
    return point;
  };
  // Brief clicks and movement before the hold delay must not reorder.
  let point = await grab('claude', false);
  await page.mouse.move(point.x, point.y + 200); await page.mouse.up();
  assert.deepEqual(await order(), original);
  await expect(page.locator('.is-dragging')).toHaveCount(0);
  await page.getByRole('button', { name: 'Antigravity 下一页额度' }).click();
  await page.getByRole('button', { name: '切换余额币种' }).click();

  point = await grab('claude');
  await page.mouse.move(point.x, point.y + layout[3].top - layout[0].top, { steps: 10 });
  await expect(page.getByRole('status')).toContainText('第 4 位');
  await page.screenshot({ path: 'docs/screenshots/card-sorting.png', animations: 'disabled' });
  await page.mouse.up();
  const reordered = ['codex', 'antigravity', 'deepseek', 'claude'];
  await expect.poll(order).toEqual(reordered);
  await expect(page.getByRole('status')).toHaveText('模块顺序已保存');
  assert.deepEqual((await page.evaluate(() => window.panel.getState())).bounds, bounds);
  assert.deepEqual(await page.locator('.control-region').boundingBox(), header);
  await expect(card('antigravity').locator('.quota-pagination')).toHaveText('2/5');
  await expect(card('deepseek').locator('.balance-total strong')).toHaveText('2.10');

  point = await grab('claude');
  await page.mouse.move(point.x, point.y - 600); await page.keyboard.press('Escape'); await page.mouse.up();
  assert.deepEqual(await order(), reordered);
  await expect(page.locator('.is-dragging')).toHaveCount(0);
  await card('deepseek').focus(); await page.keyboard.press('Alt+ArrowUp');
  const finalOrder = ['codex', 'deepseek', 'antigravity', 'claude'];
  await expect.poll(order).toEqual(finalOrder);
  // Saving unrelated preferences cannot reset the order; malformed IPC cannot remove a card.
  await page.evaluate(async () => {
    const state = await window.panel.getState();
    await window.panel.configure({ side: state.side, locked: state.locked, animate: state.animate });
  });
  const invalidRejected = await page.evaluate(async () => {
    try { await window.panel.setOrder(['claude', 'claude', 'codex', 'deepseek']); return false; } catch { return true; }
  });
  assert.equal(invalidRejected, true); assert.deepEqual((await page.evaluate(() => window.panel.getState())).providerOrder, [...finalOrder, 'zcode', 'kimi', 'qwen', 'workbuddy']);
  await page.getByRole('button', { name: '收起面板' }).click();
  await expect.poll(() => page.locator('.rail-providers .avatar').evaluateAll(els => els.map(el => el.dataset.provider))).toEqual(finalOrder);
  await page.getByRole('button', { name: '展开面板' }).click();
  await page.getByRole('button', { name: '打开配置' }).click();
  await page.getByRole('checkbox', { name: '测试模式', exact: true }).check();
  await page.getByRole('button', { name: '查看测试面板' }).click();
  await expect.poll(order).toEqual(finalOrder);
  await app.close(); app = await launch(); page = await app.firstWindow(); await ready();
  await expect.poll(order).toEqual(finalOrder);
  assert.deepEqual((await page.evaluate(() => window.panel.getState())).providerOrder, [...finalOrder, 'zcode', 'kimi', 'qwen', 'workbuddy']);
  console.log('Card sorting passed: 8px spacing, rounded cards, hold gesture, quick-move cancellation, Escape, keyboard, control clicks, state preservation, fixed header/window, collapsed order, IPC validation, cold restart.');
} finally { await app.close(); await rm(profile, { recursive: true, force: true }); }
