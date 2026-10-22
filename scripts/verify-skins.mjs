import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Isolated fixture mode is mandatory: no account requests, login changes or real application launches.
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-skins-'));
const output = '.local/qa/skins';
const ids = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ locked: false, animate: true,
  language: 'zh-CN', theme: 'dark', skin: 'watch', enabledProviders: ids }));
const launch = () => electron.launch({ args: ['.'], env: { ...process.env,
  AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
let app, page;
const errors = [], checked = [];
const card = id => page.locator(`.provider-card[data-provider="${id}"]`);
const settings = () => page.getByRole('button', { name: '打开配置', exact: true }).click();
const close = () => page.getByRole('button', { name: '关闭配置', exact: true }).click();
async function ready() {
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.dataset.sampledAt));
  await expect(page.locator('.provider-card')).toHaveCount(8);
}
async function selectSkin(skin) {
  await settings();
  await page.locator('.settings-nav button').filter({ hasText: /^外观$/ }).click();
  await page.locator(`[data-skin-option="${skin}"]`).click();
  await expect(page.locator(`[data-skin-option="${skin}"]`)).toHaveAttribute('aria-pressed', 'true');
  await close();
  await expect(page.locator('main')).toHaveAttribute('data-skin', skin);
  assert.equal(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).skin, skin);
}
async function checkLayout(context) {
  const rows = await page.locator('.provider-card').evaluateAll(cards => cards.map(card => {
    const box = card.getBoundingClientRect();
    const parts = [...card.querySelectorAll('.avatar-launch,.identity,.quota-area,.task-line,.state-pill,.party-stage,.dial-hero,.dial-frame,.card-foot')]
      .filter(el => getComputedStyle(el).display !== 'none')
      .map(el => ({ name: el.className, bounds: el.getBoundingClientRect() }));
    return { id: card.dataset.provider, width: box.width, height: box.height,
      overflowX: card.scrollWidth > card.clientWidth + 1,
      overflowY: card.scrollHeight > card.clientHeight + 1,
      escaped: parts.filter(({ bounds: r }) => r.width <= 0 || r.height <= 0 || r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1)
        .map(({ name, bounds: r }) => ({ name, left: r.left - box.left, right: r.right - box.right,
          top: r.top - box.top, bottom: r.bottom - box.bottom, width: r.width, height: r.height })),
      images: [...card.querySelectorAll('img')].every(image => image.complete && image.naturalWidth > 0),
      identity: card.querySelector('h2')?.textContent,
    };
  }));
  assert.deepEqual(rows.map(row => row.id), ids);
  for (const row of rows) {
    const detail = JSON.stringify({ ...context, ...row });
    assert.ok(row.width > 0 && row.height > 0 && row.identity, detail);
    assert.equal(row.overflowX, false, detail);
    assert.equal(row.overflowY, false, detail);
    assert.deepEqual(row.escaped, [], detail);
    assert.equal(row.images, true, detail);
  }
  // The skins intentionally arrange status, metrics and identity differently.
  if (context.skin === 'watch') await expect(page.locator('.overview-watch .stat')).toHaveCount(3);
  if (context.skin === 'dial') {
    await expect(page.locator('.overview-dial .overview-headline')).toBeVisible();
    await expect(page.locator(context.anime ? '.dial-frame' : '.quota-ring').first()).toBeVisible();
  }
  if (context.skin === 'party') {
    await expect(page.locator('.overview-party .party-chips > span')).toHaveCount(3);
    await expect(page.locator('.party-stage')).toHaveCount(8);
  }
  await expect(page.locator('.overview .test-badge')).toHaveText('测试模式');
  // Each waiting assistant is its own banner row; the banners, the card list and the card halos never overlap or clip.
  await page.locator('.provider-viewport').evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.locator('.attention-list .attention')).toHaveCount(3);
  const stack = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.attention-list .attention')].map(el => el.getBoundingClientRect());
    const view = document.querySelector('.provider-viewport').getBoundingClientRect();
    const first = document.querySelector('.provider-card').getBoundingClientRect();
    const dots = [...document.querySelectorAll('.provider-card .avatar-launch')].filter(button =>
      ['running', 'attention'].includes(button.querySelector('.avatar')?.dataset.glow)
      && [...button.querySelectorAll('.avatar-dot')].some(dot => getComputedStyle(dot).display !== 'none')).length;
    return { separate: rows.every((row, i) => i === 0 || row.top >= rows[i - 1].bottom - .5), aboveList: rows.at(-1).bottom <= view.top + .5,
      firstInside: first.top >= view.top + 1 - .01, dots };
  });
  assert.deepEqual(stack, { separate: true, aboveList: true, firstInside: true, dots: 0 }, JSON.stringify(context));
  for (const id of ['claude', 'codex']) {
    await expect(card(id)).toHaveAttribute('data-state', 'waiting');
    await expect(card(id)).toHaveAttribute('data-attention', 'true');
    await expect(card(id).locator('.avatar')).toHaveAttribute('data-glow', 'attention');
    assert.equal(await card(id).locator('.avatar').evaluate(el => getComputedStyle(el).getPropertyValue('--halo-color').trim()), '#ff555f');
  }
  await expect(card('codex').locator('.state-pill')).toHaveText('待回答');
  await expect(card('antigravity').locator('.avatar')).toHaveAttribute('data-glow', 'running');
  if (context.skin === 'party') {
    // The party skin uses the card frame for activity; the large portrait's spectrum ring is intentionally hidden.
    await expect(card('antigravity').locator('.avatar-halo')).toBeHidden();
    await card('deepseek').scrollIntoViewIfNeeded();
    const effect = await card('deepseek').evaluate(el => {
      const style = getComputedStyle(el);
      return { animation: style.animationName, duration: style.animationDuration, shadow: style.boxShadow };
    });
    // The one-off entrance runs alongside the continuous 5 s frame glow.
    const names = effect.animation.split(', '), durations = effect.duration.split(', ');
    assert.ok(names.includes('party-glow'), effect.animation);
    assert.equal(durations[names.indexOf('party-glow')], '5s');
    assert.notEqual(effect.shadow, 'none');
    for (const id of ['claude', 'codex']) {
      const effect = await card(id).evaluate(el => ({ animation: getComputedStyle(el).animationName, shadow: getComputedStyle(el).boxShadow }));
      // A waiting card holds a steady red frame: no continuous frame glow (only the one-off entrance).
      assert.ok(!effect.animation.split(', ').includes('party-glow'), effect.animation);
      assert.notEqual(effect.shadow, 'none');
    }
  } else {
    await expect(card('antigravity').locator('.avatar-halo')).toBeVisible();
    const spectrum = await card('antigravity').locator('.avatar-halo > span').evaluate(el => getComputedStyle(el, '::before').backgroundImage);
    assert.match(spectrum, /^conic-gradient\(/);
  }
  assert.ok(await page.locator('.provider-card .more-quotas').count() >= 2);
}
try {
  await mkdir(output, { recursive: true });
  app = await launch(); await ready();
  for (const skin of ['watch', 'dial', 'party']) {
    await selectSkin(skin);
    await settings();
    // Navigation must bring all six headings into the scrollable settings area.
    for (const [id, label] of [['look', '外观'], ['modules', '模块'], ['data', '数据来源'],
      ['window', '窗口'], ['images', '图片与应用'], ['about', '关于']]) {
      await page.locator('.settings-nav').getByRole('button', { name: label, exact: true }).click();
      await expect.poll(() => page.locator(`[data-section="${id}"] > h3`).evaluate(el => {
        const r = el.getBoundingClientRect(), box = document.querySelector('.settings-content').getBoundingClientRect();
        return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
      })).toBe(true);
    }
    await page.locator('.settings-nav').getByRole('button', { name: '模块', exact: true }).click();
    await page.getByRole('checkbox', { name: '测试模式', exact: true }).check();
    await page.getByRole('button', { name: '全部运行', exact: true }).click();
    await page.getByRole('combobox', { name: 'Claude Code 测试任务状态', exact: true }).selectOption('approval');
    await page.getByRole('combobox', { name: 'Codex 测试任务状态', exact: true }).selectOption('input');
    await page.getByRole('combobox', { name: 'Antigravity 测试任务状态', exact: true }).selectOption('waiting');
    await close();
    for (const anime of [false, true]) for (const theme of ['light', 'dark']) {
      await page.evaluate(async ({ anime, theme }) => { await window.panel.setAnimeMode(anime); await window.panel.setTheme(theme); }, { anime, theme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('main')).toHaveClass(anime ? /anime-mode/ : /^(?!.*anime-mode)/);
      for (const width of [300, 420]) {
        await page.setViewportSize({ width, height: 960 });
        const context = { skin, anime, theme, width };
        await checkLayout(context); checked.push(context);
      }
      await page.locator('.provider-viewport').evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: `${output}/${skin}-${anime ? 'anime' : 'logo'}-${theme}.png`, animations: 'disabled' });
      await page.getByRole('button', { name: '收起面板', exact: true }).click();
      await expect(page.locator('.rail-providers .rail-item')).toHaveCount(8);
      await expect(page.locator('.rail-providers .avatar[data-glow="attention"]')).toHaveCount(2);
      assert.equal(await page.locator('.rail-providers img').evaluateAll(images => images.length === 8 && images.every(img => img.complete && img.naturalWidth > 0)), true);
      await page.getByRole('button', { name: '展开面板', exact: true }).click();
      await expect(page.locator('main')).toHaveAttribute('data-skin', skin);
      await expect(page.locator('.provider-card')).toHaveCount(8);
    }
    // Choices survive process restart, while renderer-only test mode resets.
    await app.close(); app = await launch(); await ready();
    await expect(page.locator('main')).toHaveAttribute('data-skin', skin);
    await expect(page.locator('main')).toHaveClass(/anime-mode/);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('main')).toHaveAttribute('data-test-mode', 'false');
    const state = await page.evaluate(() => window.panel.getState());
    assert.equal(state.skin, skin); assert.equal(state.animeMode, true); assert.equal(state.theme, 'dark');
    assert.equal(state.qwenKeychainAllowed, false); assert.equal(state.claudeNetworkAllowed, false);
    for (const invalid of ['unknown', null, {}, ['watch']]) await assert.rejects(page.evaluate(value => window.panel.setSkin(value), invalid));
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify({ result: 'passed', layouts: checked, errors }, null, 2));
  console.log(`Skin acceptance passed: ${checked.length} layouts across watch/dial/party, light/dark, logo/anime and 300/420px; eight providers, images, test labels, Claude/Codex attention, watch/dial spectrum rings and party card effects, settings navigation, collapse/expand, restart and invalid bridge input. Synthetic data only.`);
} finally {
  await app?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
