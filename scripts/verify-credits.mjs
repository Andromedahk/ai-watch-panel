import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const names = { qwen: 'Qwen（千问）', workbuddy: 'WorkBuddy' };
const colors = { qwen: '#536fff', workbuddy: '#14c9a5' };
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-credits-'));
const launch = () => electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
let app = await launch();
try {
  let page = await app.firstWindow();
  const ready = () => page.waitForFunction(() => Boolean(document.querySelector('main')?.getAttribute('data-sampled-at')));
  await ready();
  const card = id => page.locator(`.provider-card[data-provider="${id}"]`);
  const light = id => page.locator(`.hidden-activity-light[data-provider="${id}"]`);
  const settings = () => page.getByRole('button', { name: '打开配置', exact: true }).click();
  const qwenAccess = () => page.getByRole('checkbox', { name: '读取千问登录状态', exact: true });
  const close = async () => {
    await page.getByRole('button', { name: '关闭配置', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  };
  const select = (id, value) => page.getByRole('combobox', { name: `${names[id]} 测试数据显示`, exact: true }).selectOption(value);
  const scrollBottom = () => page.locator('.provider-viewport').evaluate(el => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
  const setData = async value => {
    await settings();
    for (const id of Object.keys(names)) await select(id, value);
    await close(); await scrollBottom();
  };
  const firstNumber = text => Number(text.match(/\d+(?:\.\d+)?/)?.[0] ?? NaN);
  const cardMetrics = id => card(id).evaluate(el => {
    const heading = el.querySelector('.card-heading').getBoundingClientRect();
    const content = el.querySelector('.quota-area').getBoundingClientRect();
    const footer = el.querySelector('.task-line').getBoundingClientRect();
    const image = el.querySelector('.avatar img');
    return { overflow: el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight,
      overlap: heading.bottom > content.top || content.bottom > footer.top,
      titleFits: el.querySelector('h2').scrollWidth <= el.querySelector('h2').clientWidth,
      imageLoaded: Boolean(image?.complete && image.naturalWidth > 0),
      color: getComputedStyle(el.querySelector('.avatar')).getPropertyValue('--halo-color').trim() };
  });
  await expect(page.locator('.provider-card')).toHaveCount(8);
  assert.equal((await page.evaluate(() => window.panel.getState())).qwenKeychainAllowed, false);
  await settings();
  // This suite always launches fixture mode, so exercising this preference never reads real credentials.
  await expect(qwenAccess()).not.toBeChecked();
  await qwenAccess().click(); await expect(qwenAccess()).toBeChecked();
  assert.equal((await page.evaluate(() => window.panel.getState())).qwenKeychainAllowed, true);
  await page.evaluate(async () => {
    const state = await window.panel.getState();
    await window.panel.configure({ side: state.side, locked: state.locked, animate: state.animate });
  });
  assert.equal((await page.evaluate(() => window.panel.getState())).qwenKeychainAllowed, true);
  for (const value of [null, 1, 'true', {}, [true]]) {
    assert.equal(await page.evaluate(async allowed => {
      try { await window.panel.setQwenAccess(allowed); return false; } catch { return true; }
    }, value), true);
  }
  await page.getByRole('checkbox', { name: '测试模式', exact: true }).check();
  await expect(page.getByRole('combobox')).toHaveCount(16);
  await page.getByRole('button', { name: '全部待机', exact: true }).click();
  for (const id of Object.keys(names)) {
    await page.getByRole('combobox', { name: `${names[id]} 测试任务状态`, exact: true }).selectOption('running');
    await select(id, 'normal');
  }
  await close();
  await page.locator('.provider-viewport').evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => page.locator('.hidden-activity-light').evaluateAll(elements => elements.map(el => el.dataset.provider))).toEqual(['qwen', 'workbuddy']);
  for (const id of Object.keys(names)) {
    await expect(light(id)).toHaveAttribute('data-glow', 'running');
    assert.equal(await light(id).evaluate(el => getComputedStyle(el).getPropertyValue('--halo-color').trim()), colors[id]);
    assert.equal(await light(id).evaluate(el => getComputedStyle(el, '::before').animationDuration), '5s');
  }
  await light('workbuddy').click();
  await expect(light('workbuddy')).toHaveCount(0); await expect(light('qwen')).toHaveCount(0);
  await scrollBottom();
  for (const id of Object.keys(names)) {
    const region = card(id);
    await expect(region.locator('.plan-summary')).toBeVisible();
    await expect(region.locator('.plan-name')).not.toHaveText('套餐未知');
    await expect(region.locator('.credits-list')).toHaveAttribute('aria-label', `${names[id]} 剩余积分`);
    await expect(region.locator('.credit-item')).toHaveCount(2);
    await expect(region.locator('.quota-pagination')).toHaveText('1/2');
    const labels = await region.locator('.credit-label').allTextContents();
    const firstValues = await region.locator('.credit-value').allTextContents();
    assert.ok(firstValues.every(value => Number.isFinite(firstNumber(value)) && firstNumber(value) > 0));
    assert.equal(firstNumber(firstValues[0]), 1234.5);
    const units = [await region.locator('.credits-list').innerText()];
    await region.getByRole('button', { name: `${names[id]} 下一页额度`, exact: true }).click();
    await expect(region.locator('.quota-pagination')).toHaveText('2/2');
    await expect(region.getByRole('button', { name: `${names[id]} 下一页额度`, exact: true })).toBeDisabled();
    labels.push(...await region.locator('.credit-label').allTextContents());
    units.push(await region.locator('.credits-list').innerText());
    assert.equal(new Set(labels).size, 4, 'All four separate credit pools must be reachable');
    assert.match(units.join(' '), /积分/); assert.match(units.join(' '), /次/);
    await region.getByRole('button', { name: `${names[id]} 上一页额度`, exact: true }).click();
    assert.deepEqual(await region.locator('.credit-value').allTextContents(), firstValues);
    const metrics = await cardMetrics(id);
    assert.equal(metrics.overflow, false); assert.equal(metrics.overlap, false);
    assert.equal(metrics.titleFits, true); assert.equal(metrics.imageLoaded, true); assert.equal(metrics.color, colors[id]);
  }
  await mkdir('docs/screenshots', { recursive: true });
  await expect(page.locator('.toast')).toBeHidden();
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.provider-card[data-provider="workbuddy"] .avatar'), '::before').opacity) > .9);
  await page.screenshot({ path: 'docs/screenshots/qwen-workbuddy.png' });

  // Credits are absolute values, not percentage quotas. Unknown and historical values stay distinct from zero.
  for (const [mode, amount] of [['low', 12.5], ['zero', 0], ['full', 100]]) {
    await setData(mode);
    for (const id of Object.keys(names)) {
      await expect(card(id).locator('.credit-item')).toHaveCount(2);
      assert.equal(firstNumber(await card(id).locator('.credit-value').first().innerText()), amount);
      await expect(card(id).locator('.credit-value').first()).not.toContainText('未知');
    }
  }
  await setData('stale');
  for (const id of Object.keys(names)) {
    await expect(card(id).locator('.credits-list')).toContainText('历史');
    assert.equal(firstNumber(await card(id).locator('.credit-value').first().innerText()), 1234.5);
    await expect(card(id)).toContainText('历史');
  }
  for (const mode of ['unknown', 'signed-out', 'error']) {
    await setData(mode);
    for (const id of Object.keys(names)) {
      await expect(card(id).locator('.plan-name')).toHaveText('套餐未知');
      await expect(card(id).locator('.credit-value')).toHaveCount(0);
      await expect(card(id).getByRole('progressbar')).toHaveCount(0);
      await expect(card(id).locator('.quota-area')).not.toContainText(/(?:剩余|余额)\s*0(?:\D|$)/);
      if (mode === 'signed-out') await expect(card(id)).toContainText(/登录/);
      if (mode === 'error') await expect(card(id)).toContainText(/失败/);
    }
  }
  // A known pool with an unknown remaining balance must render unknown, even if its total is known.
  // Deliver an in-memory synthetic adapter event to exercise the nullable field independently of presets.
  await settings(); await page.getByRole('checkbox', { name: '测试模式', exact: true }).uncheck(); await close();
  const unknownSnapshot = await page.evaluate(() => window.panel.getStatus());
  unknownSnapshot.sampledAt = new Date(Date.now() + 3600000).toISOString();
  unknownSnapshot.isTestData = true;
  for (const id of Object.keys(names)) {
    unknownSnapshot[id] = { ...unknownSnapshot[id], sampledAt: unknownSnapshot.sampledAt,
      plan: { name: null }, credits: { stale: false, items: [{ label: '测试未知积分', remaining: null, total: '1000', unit: '积分' }] } };
  }
  await app.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send('panel:status-changed', snapshot), unknownSnapshot);
  await scrollBottom();
  for (const id of Object.keys(names)) {
    await expect(card(id).locator('.credit-value')).toHaveText('—');
    await expect(card(id).locator('.credit-amount')).toContainText('未知');
    await expect(card(id).locator('.plan-name')).toHaveText('套餐未知');
  }
  // Exercise the production source label using a synthetic event only; no credential read or authorization is requested.
  const accessSnapshot = { ...unknownSnapshot, isTestData: false,
    sampledAt: new Date(Date.parse(unknownSnapshot.sampledAt) + 1).toISOString(),
    qwen: { ...unknownSnapshot.qwen, source: 'unavailable', connection: 'auth-required', accessRequired: true,
      credits: { items: [], stale: false }, detail: '测试 · 尚未授予本设备登录读取权限' } };
  await app.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send('panel:status-changed', snapshot), accessSnapshot);
  await expect(card('qwen').locator('.source-tag')).toHaveText('待授权');
  await expect(card('qwen').locator('.credits-empty strong')).toHaveText('等待登录读取授权');
  await settings(); await page.getByRole('checkbox', { name: '测试模式', exact: true }).check(); await close();
  await setData('normal');
  for (const id of Object.keys(names)) {
    await expect(card(id).locator('.quota-pagination')).toHaveText('1/2');
    assert.equal((await cardMetrics(id)).overflow, false);
  }
  assert.equal(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).qwenKeychainAllowed, true);
  await app.close(); app = await launch(); page = await app.firstWindow(); await ready();
  assert.equal((await page.evaluate(() => window.panel.getState())).qwenKeychainAllowed, true);
  await settings(); await expect(qwenAccess()).toBeChecked();
  await qwenAccess().click(); await expect(qwenAccess()).not.toBeChecked();
  assert.equal((await page.evaluate(() => window.panel.getState())).qwenKeychainAllowed, false);
  await close(); await app.close(); app = await launch(); page = await app.firstWindow(); await ready();
  assert.equal((await page.evaluate(() => window.panel.getState())).qwenKeychainAllowed, false);
  console.log('Credits checks passed: eight cards, sixteen test controls, Qwen and WorkBuddy logos/colors, hidden indicators, plan labels, two-page credit pools and units, low/zero/full, historical values, unknown/signed-out/error without fake zero, recovered normal layout, explicit login-access preference validation and cold restart in fixture mode.');
} finally {
  await app.close(); await rm(profile, { recursive: true, force: true });
}
