import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const all = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi'];
const names = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', deepseek: 'DeepSeek Harness', zcode: 'ZCode', kimi: 'Kimi Code' };
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-modules-'));
const launch = () => electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
let app = await launch();
try {
  let page = await app.firstWindow();
  const ready = () => page.waitForFunction(() => Boolean(document.querySelector('main')?.getAttribute('data-sampled-at')));
  const card = id => page.locator(`.provider-card[data-provider="${id}"]`);
  const viewport = () => page.locator('.provider-viewport');
  const light = id => page.locator(`.hidden-activity-light[data-provider="${id}"]`);
  const order = () => page.locator('.provider-card').evaluateAll(cards => cards.map(el => el.dataset.provider));
  const hiddenIds = () => page.locator('.hidden-activity-light').evaluateAll(lights => lights.map(el => el.dataset.provider));
  const state = () => page.evaluate(() => window.panel.getState());
  const open = () => page.getByRole('button', { name: '打开配置', exact: true }).click();
  const close = async () => {
    await page.getByRole('button', { name: '关闭配置', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const enabled = id => page.getByRole('checkbox', { name: `启用 ${names[id]}`, exact: true });
  const toggleEnabled = async (id, checked) => {
    // Controlled checkboxes update only after the validated persistence bridge acknowledges.
    if (await enabled(id).isChecked() !== checked) await enabled(id).click();
    await expect(enabled(id)).toBeChecked({ checked });
    await expect.poll(async () => (await state()).enabledProviders.includes(id)).toBe(checked);
  };
  const selectEnabled = async ids => {
    // The UI persists each click immediately; wait for its acknowledged state before the next click.
    for (const id of all) {
      await toggleEnabled(id, ids.includes(id));
    }
  };
  const activity = (id, value) => page.getByRole('combobox', { name: `${names[id]} 测试任务状态`, exact: true }).selectOption(value);
  const scroll = async value => {
    await viewport().evaluate((el, target) => { el.scrollTo({ top: target === 'bottom' ? el.scrollHeight : 0, behavior: 'instant' }); }, value);
    // scrollHeight/clientHeight are rounded integers, while macOS HiDPI scrollTop may differ by a pixel.
    try { await expect.poll(() => viewport().evaluate((el, target) => Math.abs(el.scrollTop - (target === 'bottom' ? el.scrollHeight - el.clientHeight : 0)) <= 2, value)).toBe(true); }
    catch (error) {
      console.log(await viewport().evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, cards: el.children.length, focused: document.activeElement?.getAttribute('data-provider') })));
      throw error;
    }
  };
  await ready(); await page.bringToFront();
  // Allow the native work area to settle before testing long-press gestures.
  await page.waitForTimeout(1000);
  await expect.poll(order).toEqual(all);
  assert.deepEqual((await state()).enabledProviders, all);
  const bounds = (await state()).bounds;
  const header = await page.locator('.control-region').boundingBox();
  const firstHeight = (await card('claude').boundingBox()).height;
  assert.ok(Math.abs(header.height * 2 - firstHeight) < 1);
  const layout = await viewport().evaluate(el => ({ overflowX: el.scrollWidth > el.clientWidth, overflowY: el.scrollHeight > el.clientHeight, childCount: el.children.length }));
  assert.deepEqual(layout, { overflowX: false, overflowY: true, childCount: 6 });
  assert.equal(await page.locator('.provider-viewport .avatar img').evaluateAll(images => images.length === 6 && images.every(image => image.complete && image.naturalWidth > 0)), true);
  const spaces = await page.locator('.provider-card').evaluateAll(cards => cards.map(el => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: innerWidth - rect.right, top: rect.top, bottom: rect.bottom, radius: getComputedStyle(el).borderRadius };
  }));
  for (const item of spaces) { assert.equal(item.left, 8); assert.equal(item.right, 8); assert.equal(item.radius, '14px'); }
  for (let i = 1; i < spaces.length; i++) assert.ok(Math.abs(spaces[i].top - spaces[i - 1].bottom - 8) < 1);
  console.log('Module geometry and six image assets passed.');

  // Zero, one, four, and six modules are all selectable without changing native geometry.
  await open();
  for (const ids of [[], ['kimi'], all.slice(0, 4), all]) {
    await selectEnabled(ids); await close();
    await expect.poll(order).toEqual(ids);
    assert.deepEqual((await state()).bounds, bounds);
    assert.deepEqual(await page.locator('.control-region').boundingBox(), header);
    if (!ids.length) {
      await expect(page.locator('.empty-providers')).toBeVisible();
      await expect(page.locator('.hidden-activity-light')).toHaveCount(0);
      await page.locator('.empty-providers').getByRole('button').click();
      await expect(page.getByRole('dialog')).toBeVisible();
    } else {
      assert.ok(Math.abs((await card(ids[0]).boundingBox()).height - firstHeight) < 1, 'Card height must not stretch when fewer modules are enabled');
      assert.equal(await viewport().evaluate(el => el.scrollHeight > el.clientHeight), ids.length > 4);
      await open();
    }
  }
  console.log('Module selection passed for 0, 1, 4 and 6 cards.');
  await page.getByRole('checkbox', { name: '测试模式', exact: true }).check();
  await expect(page.getByRole('combobox')).toHaveCount(12);
  await page.getByRole('button', { name: '全部待机', exact: true }).click();
  await activity('zcode', 'running'); await activity('kimi', 'running');
  await close(); await scroll('top');
  await expect.poll(hiddenIds).toEqual(['zcode', 'kimi']);
  const lightStyle = id => light(id).evaluate(el => ({
    color: getComputedStyle(el).getPropertyValue('--halo-color').trim(),
    animations: [getComputedStyle(el), getComputedStyle(el, '::before'), getComputedStyle(el, '::after')].map(style => ({ name: style.animationName, duration: style.animationDuration })),
  }));
  for (const [id, color] of [['zcode', '#6f35b5'], ['kimi', '#8de8ee']]) {
    await expect(light(id)).toHaveAttribute('data-glow', 'running');
    const style = await lightStyle(id);
    assert.equal(style.color, color);
    assert.ok(style.animations.some(value => value.name !== 'none' && value.duration.split(', ').includes('5s')));
  }
  await expect(page.locator('.toast')).toBeHidden();
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/module-overflow.png' });
  // Indicators are buttons: clicking reveals the right provider and clears its hidden alert.
  await light('kimi').click();
  await expect.poll(() => card('kimi').evaluate(el => {
    const card = el.getBoundingClientRect(), view = el.parentElement.getBoundingClientRect();
    return card.top >= view.top - 1 && card.bottom <= view.bottom + 1;
  })).toBe(true);
  await expect(light('kimi')).toHaveCount(0);
  await expect(light('zcode')).toHaveCount(0);
  for (const id of ['zcode', 'kimi']) {
    const metrics = await card(id).evaluate(el => {
      const heading = el.querySelector('.card-heading').getBoundingClientRect();
      const quota = el.querySelector('.quota-area').getBoundingClientRect();
      const footer = el.querySelector('.task-line').getBoundingClientRect();
      const image = el.querySelector('.avatar img');
      return { overflow: el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight,
        overlap: heading.bottom > quota.top || quota.bottom > footer.top,
        imageLoaded: image.complete && image.naturalWidth > 0,
        titleFits: el.querySelector('h2').scrollWidth <= el.querySelector('h2').clientWidth,
        color: getComputedStyle(el.querySelector('.avatar')).getPropertyValue('--halo-color').trim() };
    });
    assert.equal(metrics.overflow, false); assert.equal(metrics.overlap, false);
    assert.equal(metrics.imageLoaded, true); assert.equal(metrics.titleFits, true);
    assert.equal(metrics.color, id === 'zcode' ? '#6f35b5' : '#8de8ee');
  }
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.provider-card[data-provider="kimi"] .avatar'), '::before').opacity) > .9);
  await page.screenshot({ path: 'docs/screenshots/modules-new.png' });
  assert.deepEqual(await page.locator('.control-region').boundingBox(), header);
  assert.deepEqual((await state()).bounds, bounds);

  // Waiting uses the provider color, except Codex waiting takes red precedence over running.
  await open(); await activity('zcode', 'waiting'); await activity('codex', 'mixed'); await close();
  await scroll('bottom'); await expect(light('codex')).toHaveAttribute('data-glow', 'attention');
  assert.equal((await lightStyle('codex')).color, '#ff555f');
  await light('codex').click(); await expect(light('codex')).toHaveCount(0);
  await scroll('top'); await expect(light('zcode')).toHaveAttribute('data-glow', 'running');
  assert.equal((await lightStyle('zcode')).color, '#6f35b5');
  // Disable an active provider: no card or hidden-activity light remains for it.
  await open(); await toggleEnabled('zcode', false);
  await close(); await expect(card('zcode')).toHaveCount(0); await expect(light('zcode')).toHaveCount(0);
  await expect(light('kimi')).toHaveCount(1);
  await open(); await toggleEnabled('zcode', true);
  await activity('kimi', 'idle'); await activity('zcode', 'idle'); await close();
  await expect(page.locator('.hidden-activity-light')).toHaveCount(0);
  console.log('Hidden-activity colors, waiting precedence, reveal and clearing passed.');

  // The animation preference covers both card halos and bottom-edge reminders.
  await open(); await activity('kimi', 'running');
  await page.getByRole('checkbox', { name: '状态灯动画' }).uncheck();
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await scroll('top'); await expect(light('kimi')).toHaveCount(1);
  assert.ok((await lightStyle('kimi')).animations.every(value => value.name === 'none'));
  assert.equal(await card('kimi').locator('.avatar').evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => window.panel.setTheme(value), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(light('kimi')).toHaveCount(1);
    assert.equal(await viewport().evaluate(el => el.scrollWidth > el.clientWidth), false);
  }
  console.log('Hidden-activity animation preference and both themes passed.');

  // Keyboard moves cross the viewport boundary, while the fixed toolbar stays put.
  for (let position = 5; position > 0; position--) {
    await card('kimi').focus(); await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(async () => (await order()).indexOf('kimi')).toBe(position - 1);
    await expect.poll(async () => (await state()).providerOrder.indexOf('kimi')).toBe(position - 1);
    await expect(viewport()).toHaveAttribute('aria-busy', 'false');
  }
  await expect.poll(order).toEqual(['kimi', ...all.slice(0, 5)]);
  assert.deepEqual(await page.locator('.control-region').boundingBox(), header);
  await scroll('top');
  // A held card at the bottom edge auto-scrolls far enough to reach the sixth slot.
  const box = await card('kimi').boundingBox(), view = await viewport().boundingBox();
  await page.mouse.move(box.x + 30, box.y + 35); await page.mouse.down();
  await expect(card('kimi')).toHaveClass(/is-dragging/);
  await page.mouse.move(box.x + 30, view.y + view.height - 12, { steps: 12 });
  await expect.poll(() => viewport().evaluate(el => el.scrollTop), { timeout: 10000 }).toBeGreaterThan(firstHeight);
  await expect(page.locator('.sort-hint')).toContainText('第 6 位', { timeout: 10000 });
  await page.mouse.up(); await expect.poll(order).toEqual(all);
  await expect.poll(async () => (await state()).providerOrder).toEqual(all);
  assert.deepEqual((await state()).bounds, bounds);
  console.log('Six-card keyboard sorting and edge auto-scroll dragging passed.');
  // Hidden module positions survive rearranging just the enabled subset.
  await open(); await selectEnabled(['claude', 'kimi']); await close();
  await card('kimi').focus(); await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(order).toEqual(['kimi', 'claude']);
  await expect.poll(async () => (await state()).providerOrder.filter(id => ['claude', 'kimi'].includes(id))).toEqual(['kimi', 'claude']);
  const savedOrder = (await state()).providerOrder;
  assert.equal(savedOrder.length, 6); assert.equal(new Set(savedOrder).size, 6);
  assert.deepEqual(savedOrder.filter(id => !['claude', 'kimi'].includes(id)), all.filter(id => !['claude', 'kimi'].includes(id)));

  for (const invalid of [['kimi', 'kimi'], ['invalid'], null, all.concat('claude')]) {
    assert.equal(await page.evaluate(async ids => { try { await window.panel.setEnabled(ids); return false; } catch { return true; } }, invalid), true);
  }
  await open();
  await enabled('claude').scrollIntoViewIfNeeded();
  await expect(page.locator('.toast')).toBeHidden();
  await page.screenshot({ path: 'docs/screenshots/module-selection.png' });
  const savedEnabled = (await state()).enabledProviders;
  await page.evaluate(async () => { const state = await window.panel.getState(); await window.panel.configure({ side: state.side, locked: state.locked, animate: state.animate }); });
  assert.deepEqual((await state()).enabledProviders, savedEnabled);
  const saved = JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8'));
  assert.deepEqual(saved.enabledProviders, savedEnabled); assert.deepEqual(saved.providerOrder, savedOrder);
  await app.close(); app = await launch(); page = await app.firstWindow(); await ready();
  await expect.poll(order).toEqual(['kimi', 'claude']);
  assert.deepEqual((await state()).enabledProviders, savedEnabled); assert.deepEqual((await state()).providerOrder, savedOrder);
  await expect(page.locator('main')).toHaveAttribute('data-test-mode', 'false');
  console.log('Module checks passed: six logos, 8px geometry, 0/1/4/6 UI selection, fixed header, scroll, colored hidden activity, Codex red precedence, waiting/idle/disabled clearing, reveal button, animation/theme compatibility, cross-screen keyboard and auto-scroll drag, subset sorting, validated IPC, saved selection and cold restart.');
} finally {
  await app.close(); await rm(profile, { recursive: true, force: true });
}
