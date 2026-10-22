import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// This acceptance command covers scrolling, mascot chatter and panel sorting. It uses an
// isolated profile, synthetic account/status fixtures and an in-memory journal.
// All screenshots/results stay ignored under .local; no provider app is opened.
const output = path.resolve(process.env.AI_WATCH_INSIGHTS_OUTPUT || '.local/qa/insights');
const relativeOutput = path.relative(path.resolve('.local'), output);
assert.ok(relativeOutput && !relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput), 'acceptance output must be inside .local');
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-insights-'));
const ids = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];
const allOn = { timeline: true, resets: true, trend: true, mascot: true };
const defaultOrder = ['resets', 'trend', 'timeline', 'mascot'];
const quips = JSON.parse(await readFile(new URL('../src/view/quips.json', import.meta.url), 'utf8'));
const errors = [], checks = [];
let app, page, stage = 'startup', passed = false;
const settings = () => page.getByRole('button', { name: '打开配置', exact: true }).click();
const closeSettings = () => page.getByRole('button', { name: '关闭配置', exact: true }).click();
const shown = () => page.locator('.insight').evaluateAll(items => items.map(item => item.dataset.insight));
const scrollTop = () => page.locator('.insights').evaluate(area => area.scrollTop);
const maxScroll = () => page.locator('.insights').evaluate(area => area.scrollHeight - area.clientHeight);
async function setCheckbox(name, checked) {
  const box = page.getByRole('checkbox', { name, exact: true });
  await box.scrollIntoViewIfNeeded();
  await expect(box).toBeEnabled();
  // The preference update returns through IPC before React applies checked.
  // click + an async assertion observes that complete user-visible operation.
  if ((await box.isChecked()) !== checked) await box.click();
  if (checked) await expect(box).toBeChecked(); else await expect(box).not.toBeChecked();
  await expect(box).toBeEnabled();
}

async function launch({ reset = true } = {}) {
  if (reset) await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ locked: false, animate: false,
    language: 'zh-CN', theme: 'dark', skin: 'watch', animeMode: false, insights: allOn, enabledProviders: ids,
    // Chatter assertions click the button; the timer has its own section below.
    mascotInterval: 0 }));
  app = await electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true);
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.dataset.sampledAt));
  assert.equal((await page.evaluate(() => window.panel.getStatus())).isTestData, true);
  await page.setViewportSize({ width: 420, height: 1000 });
  await settings();
  await page.locator('.settings-nav').getByRole('button', { name: '模块', exact: true }).click();
  await setCheckbox('测试模式', true);
  await closeSettings();
  await expect(page.locator('main')).toHaveAttribute('data-test-mode', 'true');
}

async function settledLayout() {
  // Viewport/mode changes dispatch ResizeObserver after the first React paint.
  // Wait for six identical animation frames before comparing fixed geometry;
  // the scrolling assertions themselves retain exact geometry equality.
  await page.evaluate(() => new Promise((resolve, reject) => {
    let previous = '', stable = 0;
    const timer = setTimeout(() => reject(new Error('Lower-half layout did not settle')), 3000);
    const tick = () => {
      const value = ['.control-region', '.overview', '.provider-viewport', '.insights'].map(selector => {
        const el = document.querySelector(selector), r = el?.getBoundingClientRect();
        return r ? [r.x, r.y, r.width, r.height, el.scrollHeight] : null;
      });
      const next = JSON.stringify(value);
      stable = previous === next ? stable + 1 : 0; previous = next;
      if (stable >= 6) { clearTimeout(timer); resolve(); } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

async function geometry(label, { wide = false, reserved = false } = {}) {
  stage = label;
  await settledLayout();
  const row = await page.evaluate(() => {
    const list = document.querySelector('.provider-viewport'), area = document.querySelector('.insights');
    const shell = document.querySelector('main'), root = document.documentElement, stage = document.querySelector('.provider-stage');
    const a = area.getBoundingClientRect(), v = list.getBoundingClientRect();
    const panels = [...area.children].map(panel => {
      const box = panel.getBoundingClientRect();
      return { id: panel.dataset.insight, x: box.x, y: box.y, width: box.width, height: box.height,
        insideX: box.left >= a.left - 1 && box.right <= a.right + 1,
        // Natural panel/list heights retain every row even when it is below
        // the viewport; the enclosing .insights is the only scrolling owner.
        lists: [...panel.querySelectorAll('ol,ul')].map(list => {
          const r = list.getBoundingClientRect(), css = getComputedStyle(list);
          return { rows: list.children.length, uncut: list.scrollHeight <= list.clientHeight + 1,
            unmasked: css.maskImage === 'none', rowsInside: [...list.children].every(item => {
              const b = item.getBoundingClientRect(); return b.height >= 17 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1 && b.bottom <= box.bottom + 1;
            }) };
        }) };
    });
    return { area: { height: a.height, clientHeight: area.clientHeight, scrollHeight: area.scrollHeight, scrollTop: area.scrollTop,
        overflowY: getComputedStyle(area).overflowY, role: area.getAttribute('role'), tabIndex: area.tabIndex },
      reservedMinimum: Math.min(180, stage.clientHeight * .4),
      belowCards: a.top >= v.bottom - 1, inWindow: a.bottom <= innerHeight + 1 && a.top >= 0,
      shellScrolls: [shell, document.body, root].map(el => ({ x: el.scrollLeft, y: el.scrollTop })),
      horizontalFit: [area, list, shell, document.body, root].every(el => el.scrollWidth <= el.clientWidth + 1),
      cardsClip: ['auto', 'scroll'].includes(getComputedStyle(list).overflowY), panels };
  });
  assert.ok(row.belowCards && row.inWindow, `${label}: lower panels overlap cards/window: ${JSON.stringify(row)}`);
  assert.ok(row.horizontalFit, `${label}: horizontal overflow`);
  assert.deepEqual(row.shellScrolls, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], `${label}: shell/document scrolled`);
  assert.ok(row.cardsClip, `${label}: provider viewport must retain independent scrolling`);
  assert.ok(['auto', 'scroll'].includes(row.area.overflowY), `${label}: insights must own vertical scrolling`);
  assert.equal(row.area.role, 'region', `${label}: accessible scroll region`);
  assert.equal(row.area.tabIndex, 0, `${label}: keyboard focusable scroll region`);
  if (reserved) assert.ok(row.area.height >= row.reservedMinimum - 2, `${label}: crowded cards removed lower-half space`);
  for (const panel of row.panels) {
    assert.ok(panel.insideX && panel.height > 40, `${label}/${panel.id}: horizontal clipping or collapsed panel`);
    for (const list of panel.lists) assert.ok(list.uncut && list.unmasked && list.rowsInside, `${label}/${panel.id}: clipped/faded list: ${JSON.stringify(list)}`);
  }
  if (wide) {
    const xs = new Set(row.panels.map(panel => Math.round(panel.x))), ys = new Set(row.panels.map(panel => Math.round(panel.y)));
    assert.ok(xs.size >= 2 && ys.size >= 2, `${label}: wide lower-half panels must wrap into multiple rows/columns`);
  }
  checks.push({ label, ...row });
}

async function fixedState() {
  return page.evaluate(() => {
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    return { toolbar: box('.control-region'), overview: box('.overview'), cards: box('.provider-viewport'),
      cardScroll: document.querySelector('.provider-viewport').scrollTop,
      shell: [document.querySelector('main').scrollTop, document.documentElement.scrollTop, document.body.scrollTop, scrollY] };
  });
}

async function tailVisible(label) {
  const tail = await page.locator('.insights').evaluate(area => {
    const box = area.getBoundingClientRect(), panel = area.lastElementChild;
    const end = panel.querySelector('li:last-child') || panel.querySelector('.mascot-bubble') || panel.lastElementChild;
    const r = end.getBoundingClientRect(), p = panel.getBoundingClientRect();
    return { id: panel.dataset.insight, contentVisible: r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
      panelFits: p.height <= area.clientHeight, panelVisible: p.top >= box.top - 1 && p.bottom <= box.bottom + 1,
      atBottom: Math.abs(area.scrollTop - (area.scrollHeight - area.clientHeight)) < 2 };
  });
  assert.ok(tail.atBottom && tail.contentVisible, `${label}: last component's final content is not fully reachable: ${JSON.stringify(tail)}`);
  if (tail.panelFits) assert.ok(tail.panelVisible, `${label}: final component not fully visible`);
}

async function wheelScroll(label) {
  stage = label;
  const area = page.locator('.insights');
  await area.evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(maxScroll, { message: `${label}: fixture must overflow` }).toBeGreaterThan(30);
  const before = await fixedState(), box = await area.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 220);
  await expect.poll(scrollTop, { message: `${label}: physical wheel down` }).toBeGreaterThan(1);
  const down = await scrollTop();
  await page.mouse.wheel(0, -220);
  await expect.poll(scrollTop, { message: `${label}: physical wheel up` }).toBeLessThan(down);
  await page.mouse.wheel(0, await maxScroll() + 1000);
  await expect.poll(async () => Math.abs(await scrollTop() - await maxScroll())).toBeLessThan(2);
  await tailVisible(label);
  assert.deepEqual(await fixedState(), before, `${label}: scrolling insights moved toolbar/overview/cards/shell`);
  await page.screenshot({ path: path.join(output, `${label.replaceAll('/', '-')}-bottom.png`), animations: 'disabled', scale: 'css' });
  await area.focus();
  await page.keyboard.press('Home');
  await expect.poll(scrollTop, { message: `${label}: keyboard Home` }).toBeLessThan(2);
  await page.keyboard.press('PageDown');
  await expect.poll(scrollTop, { message: `${label}: keyboard PageDown` }).toBeGreaterThan(1);
  await page.keyboard.press('End');
  await expect.poll(async () => Math.abs(await scrollTop() - await maxScroll()), { message: `${label}: keyboard End` }).toBeLessThan(2);
  await tailVisible(`${label}/keyboard`);
  await page.keyboard.press('Home');
  await expect.poll(scrollTop).toBeLessThan(2);
  assert.deepEqual(await fixedState(), before, `${label}: focus/keyboard moved shell or cards`);
}

async function mascotPortrait(label) {
  await expect.poll(() => page.locator('.insight-mascot img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  const row = await page.locator('.insight-mascot').evaluate(panel => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    const figure = panel.querySelector('.mascot-figure'), img = figure.querySelector('img'), bubble = panel.querySelector('.mascot-bubble');
    return { label: '', panel: rect(panel), figure: rect(figure), image: rect(img), bubble: rect(bubble),
      natural: [img.naturalWidth, img.naturalHeight], dir: document.documentElement.dir };
  });
  row.label = label;
  assert.ok(row.figure.width >= 100 && row.figure.height >= 120, `${label}: portrait container collapsed: ${JSON.stringify(row)}`);
  assert.ok(row.image.width > 100 && row.image.height > 100, `${label}: portrait image collapsed`);
  assert.ok(row.image.top >= row.panel.top - 1, `${label}: portrait top is cropped by the module: ${JSON.stringify(row)}`);
  assert.ok(Math.abs(row.figure.bottom - row.panel.bottom) <= 2, `${label}: portrait not anchored to panel bottom`);
  assert.ok(row.figure.left >= row.panel.left - 1 && row.figure.right <= row.panel.right + 1, `${label}: portrait outside panel`);
  assert.ok(row.dir === 'rtl' ? row.bubble.right <= row.figure.left + 1 : row.figure.right <= row.bubble.left + 1, `${label}: portrait overlaps bubble`);
  checks.push({ ...row, label: `${label}/portrait` });
  console.log(`Mascot portrait ${JSON.stringify(row)}`);
}

async function cardsScrollIndependently(label) {
  const list = page.locator('.provider-viewport'), area = page.locator('.insights');
  await area.evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }));
  await list.evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }));
  const before = await fixedState(), box = await list.boundingBox();
  assert.ok(await list.evaluate(el => el.scrollHeight > el.clientHeight + 1), `${label}: eight cards must overflow`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(1);
  assert.equal(await scrollTop(), 0, `${label}: provider wheel moved insights`);
  const after = await fixedState(); delete before.cardScroll; delete after.cardScroll;
  assert.deepEqual(after, before, `${label}: provider scroll moved fixed sections`);
  await list.evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }));
}

const mascot = () => page.locator('.insight-mascot');
const refresh = () => page.locator('.mascot-refresh');
async function mascotState() {
  return mascot().evaluate(panel => ({ mood: panel.dataset.mood,
    speaker: panel.querySelector('.mascot-figure .avatar')?.dataset.provider,
    text: panel.querySelector('.mascot-bubble span')?.textContent,
    lang: panel.querySelector('.mascot-bubble span')?.getAttribute('lang'),
    dir: panel.querySelector('.mascot-bubble span')?.getAttribute('dir') }));
}
function quipKey(row) {
  const index = quips[row.speaker]?.findIndex(pair => pair.includes(row.text));
  assert.ok(index >= 0, `bubble is not one of ${row.speaker}'s bilingual lines: ${JSON.stringify(row)}`);
  return `${row.speaker}:${index}`;
}
async function clickQuip() {
  const before = await mascotState();
  await refresh().click();
  await expect(mascot()).toHaveAttribute('data-mood', 'chat');
  await expect.poll(async () => (await mascotState()).text).not.toBe(before.text);
  return mascotState();
}
async function mascotGeometry(label) {
  stage = label;
  await refresh().scrollIntoViewIfNeeded();
  const row = await mascot().evaluate(panel => {
    const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const span = panel.querySelector('.mascot-bubble span'), range = document.createRange();
    range.selectNodeContents(span);
    const r = range.getBoundingClientRect();
    return { panel: box(panel), button: box(panel.querySelector('.mascot-refresh')), bubble: box(panel.querySelector('.mascot-bubble')),
      text: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, width: innerWidth, dir: document.documentElement.dir };
  });
  const inside = (a, b) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  assert.ok(inside(row.button, row.panel), `${label}: refresh outside panel: ${JSON.stringify(row)}`);
  assert.ok(!overlaps(row.button, row.bubble), `${label}: refresh overlaps bubble: ${JSON.stringify(row)}`);
  assert.ok(inside(row.bubble, row.panel) && inside(row.text, row.bubble), `${label}: speech is clipped: ${JSON.stringify(row)}`);
  checks.push({ label: `${label}/refresh`, ...row });
}
async function testPreset(preset, patches = []) {
  await page.evaluate(() => window.panel.setLanguage('zh-CN'));
  await settings();
  await page.locator('.settings-nav').getByRole('button', { name: '模块', exact: true }).click();
  if (preset) await page.locator('.test-presets').getByRole('button', { name: preset, exact: true }).click();
  for (const [label, value] of patches) await page.getByRole('combobox', { name: label, exact: true }).selectOption(value);
  await closeSettings();
}
async function deterministicQuip(randomValues) {
  await page.evaluate(values => {
    window.__insightsOriginalRandom = Math.random;
    Math.random = () => values.length ? values.shift() : window.__insightsOriginalRandom();
  }, randomValues);
  try { return await clickQuip(); }
  finally { await page.evaluate(() => { Math.random = window.__insightsOriginalRandom; delete window.__insightsOriginalRandom; }); }
}
async function resetMascot() {
  // IPC may resolve before React paints. Observe the unmount explicitly so two
  // preference writes cannot collapse into one render and retain line history.
  await page.evaluate(() => window.panel.setAnimeMode(false));
  await expect(mascot()).toHaveCount(0);
  await page.evaluate(() => window.panel.setAnimeMode(true));
  await expect(mascot()).toHaveCount(1);
}
const cycle = () => page.locator('.mascot-figure').evaluate(figure => Number(figure.dataset.cycle));
const savedInterval = async () => JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).mascotInterval;
async function timerProgress() {
  return page.locator('.mascot-timer').evaluate(bar => {
    const [animation] = bar.getAnimations(), style = getComputedStyle(bar);
    return { name: animation?.animationName, state: animation?.playState, time: Number(animation?.currentTime || 0), duration: style.animationDuration, scale: style.scale };
  });
}
async function mascotAutoRefreshAcceptance() {
  stage = 'auto-refresh/setup';
  await page.evaluate(() => window.panel.setLayout('single'));
  await page.evaluate(value => window.panel.setEnabled(value), ids);
  await page.evaluate(() => window.panel.setLanguage('zh-CN'));
  await page.evaluate(() => window.panel.setSkin('watch'));
  await page.setViewportSize({ width: 420, height: 1000 });
  await resetMascot();
  await testPreset('全部待机');
  await expect(mascot()).toHaveAttribute('data-mood', 'rest');
  assert.equal(await savedInterval(), 0);
  await expect(page.locator('.mascot-timer')).toHaveCount(0);
  for (const bad of [3, 301, 15.5, '15', null]) {
    const rejected = await page.evaluate(async value => { try { await window.panel.setMascotInterval(value); return false; } catch { return true; } }, bad);
    assert.ok(rejected, `invalid interval ${JSON.stringify(bad)} was accepted`);
  }
  assert.equal(await savedInterval(), 0);

  // Real settings controls: the switch restores the default, the slider saves once it settles.
  stage = 'auto-refresh/settings';
  await settings();
  await page.locator('.settings-nav').getByRole('button', { name: '外观', exact: true }).click();
  const slider = page.getByRole('slider', { name: '刷新间隔', exact: true });
  await expect(slider).toBeDisabled();
  await setCheckbox('看板娘自动刷新', true);
  await expect.poll(savedInterval).toBe(15);
  await expect(slider).toBeEnabled(); await expect(slider).toHaveValue('15');
  await slider.fill('5');
  await expect(page.locator('.interval-row output')).toHaveText('5 秒');
  await expect.poll(savedInterval).toBe(5);
  await page.screenshot({ path: path.join(output, 'auto-refresh-settings.png'), animations: 'disabled', scale: 'css' });
  // Settings pause the countdown: no refresh while the sheet is open.
  const settingsCycle = await cycle();
  await page.waitForTimeout(6500);
  assert.equal(await cycle(), settingsCycle, 'auto refresh ran behind the settings sheet');
  await closeSettings();

  // The countdown bar animates even with the status-light animation preference off.
  stage = 'auto-refresh/progress';
  await expect(page.locator('main')).toHaveClass(/no-animation/);
  await expect(page.locator('.mascot-timer')).toHaveCount(1);
  const first = await timerProgress();
  assert.equal(first.name, 'mascot-timer'); assert.equal(first.duration, '5s'); assert.equal(first.state, 'running');
  await page.waitForTimeout(1200);
  const later = await timerProgress();
  assert.ok(later.time > first.time + 800 && parseFloat(later.scale.split(' ')[0]) < 1, `progress bar is not moving: ${JSON.stringify({ first, later })}`);
  const bar = await mascot().evaluate(panel => {
    const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    const style = getComputedStyle(panel);
    return { panel: box(panel), bar: box(panel.querySelector('.mascot-timer')), overflow: style.overflowY, radius: parseFloat(style.borderBottomLeftRadius), hidden: panel.querySelector('.mascot-timer').getAttribute('aria-hidden') };
  });
  assert.ok(bar.bar.left >= bar.panel.left - 1 && bar.bar.right <= bar.panel.right + 1 && Math.abs(bar.bar.bottom - bar.panel.bottom) < 1.5, `progress bar outside panel: ${JSON.stringify(bar)}`);
  assert.equal(bar.overflow, 'clip'); assert.ok(bar.radius > 0); assert.equal(bar.hidden, 'true');
  checks.push({ label: 'refresh/auto-progress', ...bar, first, later });
  await page.locator('.insights').evaluate(area => area.scrollTo({ top: area.scrollHeight, behavior: 'instant' }));
  await page.screenshot({ path: path.join(output, 'auto-refresh-progress.png'), scale: 'css' });

  // Idle room: the timer hands the bubble to another speaker without a click.
  stage = 'auto-refresh/idle';
  let before = await cycle(), text = (await mascotState()).text;
  await expect.poll(cycle, { timeout: 8000 }).toBeGreaterThan(before);
  await expect(mascot()).toHaveAttribute('data-mood', 'chat');
  assert.notEqual((await mascotState()).text, text);

  // A manual refresh replays the entrance and restarts the full countdown.
  stage = 'auto-refresh/manual-entrance';
  await page.evaluate(() => window.panel.configure({ side: 'right', locked: false, animate: true }));
  await expect(page.locator('main')).not.toHaveClass(/no-animation/);
  before = await cycle();
  const oldEntrance = await page.locator('.mascot-entrance').elementHandle();
  await refresh().click();
  await expect.poll(cycle).toBe(before + 1);
  const motion = await mascot().evaluate(panel => ({
    figure: panel.querySelector('.mascot-entrance').getAnimations().map(a => a.animationName),
    bubble: panel.querySelector('.mascot-bubble').getAnimations().map(a => a.animationName),
    timer: Number(panel.querySelector('.mascot-timer').getAnimations()[0]?.currentTime || 0) }));
  assert.ok(await oldEntrance.evaluate(el => !el.isConnected), 'portrait entrance was not replayed');
  assert.ok(motion.figure.includes('mascot-enter'), `no portrait entrance: ${JSON.stringify(motion)}`);
  assert.ok(motion.bubble.some(name => /^bubble-pop-[ab]$/.test(name)), `no bubble pop: ${JSON.stringify(motion)}`);
  assert.ok(motion.timer < 1000, `countdown did not restart after a manual refresh: ${JSON.stringify(motion)}`);
  checks.push({ label: 'refresh/auto-entrance', ...motion });
  await page.evaluate(() => window.panel.configure({ side: 'right', locked: false, animate: false }));

  // Working room: three quips, then the working status, rotating the featured agent.
  stage = 'auto-refresh/working-cadence';
  await testPreset('全部运行');
  await expect(mascot()).toHaveAttribute('data-mood', 'busy');
  await expect(page.locator('.mascot-bubble')).toContainText('位助手正在努力干活');
  const moods = [], featured = [];
  for (let i = 0; i < 8; i++) {
    before = await cycle();
    await expect.poll(cycle, { timeout: 8000 }).toBeGreaterThan(before);
    const row = await mascotState(); moods.push(row.mood);
    if (row.mood === 'busy') { assert.match(row.text, /正在努力干活/); assert.doesNotMatch(row.text, /位助手/); featured.push(row.speaker); }
  }
  assert.deepEqual(moods, ['chat', 'chat', 'chat', 'busy', 'chat', 'chat', 'chat', 'busy'], `working cadence: ${moods}`);
  assert.notEqual(featured[0], featured[1], `status slots did not rotate: ${featured}`);
  checks.push({ label: 'refresh/auto-cadence', moods, featured });

  // Turning it off removes the bar and stops changes; turning it on restores the last interval.
  stage = 'auto-refresh/disable';
  await testPreset('全部待机');
  await settings();
  await page.locator('.settings-nav').getByRole('button', { name: '外观', exact: true }).click();
  await setCheckbox('看板娘自动刷新', false);
  await expect.poll(savedInterval).toBe(0);
  await closeSettings();
  await expect(page.locator('.mascot-timer')).toHaveCount(0);
  before = await cycle(); text = (await mascotState()).text;
  await page.waitForTimeout(6500);
  assert.equal(await cycle(), before); assert.equal((await mascotState()).text, text);
  await settings();
  await page.locator('.settings-nav').getByRole('button', { name: '外观', exact: true }).click();
  await setCheckbox('看板娘自动刷新', true);
  await expect.poll(savedInterval).toBe(5);
  await setCheckbox('看板娘自动刷新', false);
  await expect.poll(savedInterval).toBe(0);
  await closeSettings();
  checks.push({ label: 'refresh/auto-disable', bar: false, unchangedMs: 6500, restored: 5 });
  console.log('Mascot auto refresh passed: settings switch/slider persistence, invalid values rejected, paused behind settings, progress bar running with animations off, idle auto refresh, manual entrance + countdown restart, 3:1 working cadence with rotation, disable/restore.');
}
async function mascotRefreshAcceptance() {
  await page.evaluate(() => window.panel.setLayout('single'));
  await page.evaluate(value => window.panel.setEnabled(value), ids);
  await page.evaluate(() => window.panel.setLanguage('zh-CN'));
  await page.setViewportSize({ width: 420, height: 1000 });
  let total = 0;
  for (const skin of ['watch', 'dial', 'party']) {
    stage = `refresh/${skin}`;
    await page.evaluate(value => window.panel.setSkin(value), skin);
    await page.evaluate(() => window.panel.setAnimeMode(false));
    await expect(mascot()).toHaveCount(0); await expect(refresh()).toHaveCount(0);
    await page.evaluate(() => window.panel.setAnimeMode(true));
    await expect(refresh()).toHaveAccessibleName('换一句');
    const recent = []; let previous = (await mascotState()).speaker;
    const count = skin === 'watch' ? 65 : 6;
    for (let i = 0; i < count; i++) {
      const row = await clickQuip(), key = quipKey(row);
      assert.notEqual(row.speaker, previous, `${skin}: consecutive speaker ${row.speaker}`);
      assert.ok(!recent.includes(key), `${skin}: line repeated within the preceding 60 clicks: ${key}`);
      assert.match(row.text, /\p{Script=Han}/u);
      assert.equal(row.lang, null); assert.equal(row.dir, null);
      recent.push(key); if (recent.length > 60) recent.shift(); previous = row.speaker; total++;
    }
    await mascotGeometry(`refresh/${skin}/zh`);
    await page.screenshot({ path: path.join(output, `refresh-${skin}-zh.png`), animations: 'disabled', scale: 'css' });

    // Remount only the mascot to get a known fresh line history. Force the
    // longest Claude English line, but activate it through the real button.
    await page.evaluate(() => window.panel.setEnabled(['claude', 'codex']));
    await resetMascot();
    await deterministicQuip([0, 0]); // current Claude -> Codex #0
    const chinese = await deterministicQuip([0, 1.1 / quips.claude.length]);
    assert.equal(chinese.speaker, 'claude'); assert.equal(chinese.text, quips.claude[1][0]);
    for (const language of ['en', 'ar']) {
      stage = `refresh/${skin}/${language}/300`;
      await page.evaluate(value => window.panel.setLanguage(value), language);
      await page.setViewportSize({ width: 300, height: 1000 });
      await expect(mascot()).toHaveAttribute('data-mood', 'chat');
      await expect(page.locator('.mascot-bubble span')).toHaveText(quips.claude[1][1]);
      const row = await mascotState();
      assert.equal(row.speaker, 'claude'); assert.equal(row.text, quips.claude[1][1], `${skin}/${language}: translation changed selected quip`);
      assert.equal(row.lang, 'en'); assert.equal(row.dir, 'ltr');
      await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
      await mascotGeometry(`refresh/${skin}/${language}/300`);
      // The mascot is the last panel. Align its bottom for evidence screenshots
      // instead of stopping as soon as the top-right button is reachable.
      await page.locator('.insights').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.screenshot({ path: path.join(output, `refresh-${skin}-${language}-300.png`), animations: 'disabled', scale: 'css' });
      const next = await clickQuip(); assert.notEqual(next.speaker, 'claude'); assert.equal(next.lang, 'en'); assert.equal(next.dir, 'ltr');
      // Return to the known longest line before checking the other locale.
      await resetMascot();
      await deterministicQuip([0, 0]); await deterministicQuip([0, 1.1 / quips.claude.length]);
    }
    await page.evaluate(() => window.panel.setLanguage('zh-CN'));
    await expect(page.locator('.mascot-bubble span')).toHaveText(quips.claude[1][0]);
    assert.equal((await mascotState()).text, quips.claude[1][0], `${skin}: returning to Chinese lost quip`);
    await page.evaluate(value => window.panel.setEnabled(value), ids);
    await page.setViewportSize({ width: 420, height: 1000 });
    console.log(`Mascot refresh ${skin}: normal/anime, ${count} real clicks, Chinese and narrow English/RTL passed.`);
  }

  stage = 'refresh/status-changes';
  await clickQuip(); await testPreset('Codex 待回答');
  await expect(mascot()).toHaveAttribute('data-mood', 'alert');
  await expect(page.locator('.mascot-bubble')).toContainText('有问题想问你');
  await clickQuip(); await testPreset('Codex 待授权');
  await expect(mascot()).toHaveAttribute('data-mood', 'alert');
  await expect(page.locator('.mascot-bubble')).toContainText('在等你授权');
  await testPreset('全部运行');
  await expect(mascot()).toHaveAttribute('data-mood', 'busy');
  await clickQuip(); await testPreset('全部待机');
  await expect(mascot()).toHaveAttribute('data-mood', 'rest');
  await clickQuip(); await testPreset(null, [['Claude Code 测试数据显示', 'low']]);
  await expect(mascot()).toHaveAttribute('data-mood', 'worried');
  await clickQuip(); await testPreset(null, [['Claude Code 测试数据显示', 'normal']]);
  await expect(mascot()).toHaveAttribute('data-mood', 'rest');
  await testPreset('全部运行');
  await expect(mascot()).toHaveAttribute('data-mood', 'busy'); // old chatter cannot revive
  checks.push({ label: 'refresh/status-changes', waiting: true, running: true, lowQuota: true, noRevival: true });

  stage = 'refresh/single-and-zero-speakers';
  await page.evaluate(() => window.panel.setEnabled(['claude']));
  await resetMascot();
  const firstCycle = new Set(); let previous;
  for (let i = 0; i < 35; i++) {
    const row = await deterministicQuip([0, 0]), key = quipKey(row);
    assert.equal(row.speaker, 'claude'); assert.notEqual(key, previous, 'single speaker repeated the immediately preceding line');
    if (i < quips.claude.length) { assert.ok(!firstCycle.has(key), 'single speaker repeated while unheard lines remain'); firstCycle.add(key); }
    previous = key;
  }
  await page.evaluate(() => window.panel.setEnabled(['codex']));
  await expect(mascot()).toHaveAttribute('data-mood', 'busy');
  assert.equal((await clickQuip()).speaker, 'codex', 'disabled speaker remained selectable');
  await page.evaluate(() => window.panel.setEnabled([]));
  await expect(mascot()).toHaveAttribute('data-mood', 'empty'); await expect(refresh()).toHaveCount(0);
  await expect(page.locator('.mascot-bubble')).toHaveText('还没有助手上线');
  checks.push({ label: 'refresh/speakers', multiSpeakerClicks: total, singleSpeakerClicks: 35, disabledSpeaker: true, zeroSpeakers: true });
  await page.evaluate(value => window.panel.setEnabled(value), ids);
}

const sortHandle = id => page.locator(`.insight-sort-handle[data-sort-insight="${id}"]`);
async function readySortHandle(id) {
  const handle = sortHandle(id);
  // Sort commits expose aria-disabled until the IPC write and React update
  // finish; do not send the next gesture while that explicit guard is active.
  await expect(handle).toBeEnabled();
  await expect(handle).not.toHaveAttribute('aria-disabled', 'true');
  return handle;
}
async function sortKey(id, key) {
  await (await readySortHandle(id)).focus(); await page.keyboard.press(key);
}
async function dragInsight(id, target, { cancel = false } = {}) {
  await (await readySortHandle(id)).scrollIntoViewIfNeeded();
  const start = await sortHandle(id).boundingBox();
  const end = await page.locator(`.insight[data-insight="${target}"]`).boundingBox();
  const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  try {
    await page.mouse.move(from.x + 6, from.y + 6, { steps: 2 });
    await expect(page.locator('.insights')).toHaveAttribute('data-sorting', 'true');
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
    await expect(page.locator(`.insight[data-insight="${target}"]`)).toHaveAttribute('data-sort-target', 'true');
    if (cancel) await page.keyboard.press('Escape');
  } finally { await page.mouse.up(); }
  await expect(page.locator('.insights')).not.toHaveAttribute('data-sorting', 'true');
}
async function insightSortAcceptance() {
  stage = 'sort/setup';
  await page.evaluate(() => window.panel.setLanguage('zh-CN'));
  await page.evaluate(() => window.panel.setLayout('single'));
  await page.evaluate(() => window.panel.setEnabled(['claude', 'codex']));
  await page.evaluate(value => window.panel.setInsights(value), allOn);
  await page.setViewportSize({ width: 420, height: 1000 });
  const providerOrder = (await page.evaluate(() => window.panel.getState())).providerOrder;
  for (const skin of ['watch', 'dial', 'party']) {
    stage = `sort/${skin}`;
    await page.evaluate(value => window.panel.setSkin(value), skin);
    await page.evaluate(() => window.panel.setAnimeMode(true));
    await page.evaluate(value => window.panel.setInsightOrder(value), defaultOrder);
    await expect.poll(shown).toEqual(defaultOrder);
    await expect(sortHandle('timeline')).toHaveAccessibleName('排序 · 动态时间线');
    await settledLayout();
    const before = await fixedState();
    await dragInsight('resets', 'trend');
    await expect.poll(shown).toEqual(['trend', 'resets', 'timeline', 'mascot']);
    assert.deepEqual((await page.evaluate(() => window.panel.getState())).insightOrder, ['trend', 'resets', 'timeline', 'mascot']);
    await sortKey('resets', 'Alt+ArrowUp');
    await expect.poll(shown).toEqual(defaultOrder);
    await dragInsight('resets', 'trend', { cancel: true });
    await expect.poll(shown).toEqual(defaultOrder);
    assert.deepEqual((await page.evaluate(() => window.panel.getState())).insightOrder, defaultOrder, `${skin}: cancelled drag was saved`);
    assert.deepEqual(await fixedState(), before, `${skin}: sorting moved header/window/provider viewport`);
    checks.push({ label: `sort/${skin}`, pointer: true, keyboard: true, escape: true, fixedShell: true });
    console.log(`Insight sort ${skin}: real pointer, keyboard and Escape passed.`);
  }

  stage = 'sort/auto-scroll';
  await page.setViewportSize({ width: 420, height: 560 });
  await page.locator('.insights').evaluate(el => { el.scrollTop = 0; });
  await (await readySortHandle('resets')).scrollIntoViewIfNeeded();
  const grip = await sortHandle('resets').boundingBox(), area = await page.locator('.insights').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
  try {
    await page.mouse.move(area.x + area.width / 2, area.y + area.height - 5, { steps: 8 });
    await expect(page.locator('.insights')).toHaveAttribute('data-sorting', 'true');
    await expect.poll(scrollTop, { message: 'dragging near lower edge must reveal hidden components' }).toBeGreaterThan(20);
    await page.keyboard.press('Escape');
  } finally { await page.mouse.up(); }
  await expect.poll(shown).toEqual(defaultOrder);
  // A transformed final panel must not enlarge scrollHeight and keep feeding
  // edge auto-scroll. Use a tall viewport so its grip and lower edge both fit.
  await page.setViewportSize({ width: 420, height: 1000 });
  await settledLayout();
  await page.locator('.insights').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect.poll(async () => Math.abs(await scrollTop() - await maxScroll())).toBeLessThan(2);
  const overflowBefore = await page.locator('.insights').evaluate(el => ({ height: el.scrollHeight, max: el.scrollHeight - el.clientHeight }));
  const lastGrip = await (await readySortHandle('mascot')).boundingBox(), edge = await page.locator('.insights').boundingBox();
  assert.ok(lastGrip.y >= edge.y && lastGrip.y + lastGrip.height <= edge.y + edge.height, 'last-panel grip must be visible at scroll end');
  await page.mouse.move(lastGrip.x + lastGrip.width / 2, lastGrip.y + lastGrip.height / 2); await page.mouse.down();
  let overflowDuring;
  try {
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height - 5, { steps: 8 });
    await expect(page.locator('.insights')).toHaveAttribute('data-sorting', 'true');
    await page.waitForTimeout(200);
    await expect(page.locator('.insights')).toHaveAttribute('data-sorting', 'true');
    overflowDuring = await page.locator('.insights').evaluate(el => ({ height: el.scrollHeight, max: el.scrollHeight - el.clientHeight }));
    assert.ok(overflowDuring.height <= overflowBefore.height + 1 && overflowDuring.max <= overflowBefore.max + 1,
      `dragging the final panel expanded the scroll range: ${JSON.stringify({ before: overflowBefore, during: overflowDuring })}`);
    await page.keyboard.press('Escape');
  } finally { await page.mouse.up(); }
  await expect(page.locator('.insights')).not.toHaveAttribute('data-sorting', 'true');
  await expect.poll(shown).toEqual(defaultOrder);
  assert.deepEqual((await page.evaluate(() => window.panel.getState())).insightOrder, defaultOrder, 'cancelled final-panel drag was saved');
  checks.push({ label: 'sort/auto-scroll', realPointer: true, edgeScroll: true, cancelled: true,
    lastPanelBounded: { before: overflowBefore, during: overflowDuring, holdMs: 200 } });

  stage = 'sort/hidden-items';
  await page.setViewportSize({ width: 420, height: 1000 });
  await page.evaluate(value => window.panel.setInsightOrder(value), ['mascot', 'timeline', 'resets', 'trend']);
  await page.evaluate(() => window.panel.setAnimeMode(false));
  await expect.poll(shown).toEqual(['timeline', 'resets', 'trend']);
  await expect(refresh()).toHaveCount(0);
  await sortKey('trend', 'Alt+ArrowUp');
  await expect.poll(shown).toEqual(['timeline', 'trend', 'resets']);
  assert.deepEqual((await page.evaluate(() => window.panel.getState())).insightOrder, ['mascot', 'timeline', 'trend', 'resets']);
  await page.evaluate(value => window.panel.setInsights(value), { ...allOn, trend: false });
  await sortKey('resets', 'Alt+ArrowUp');
  await expect.poll(shown).toEqual(['resets', 'timeline']);
  const hiddenOrder = ['mascot', 'resets', 'trend', 'timeline'];
  assert.deepEqual((await page.evaluate(() => window.panel.getState())).insightOrder, hiddenOrder, 'hidden mascot/trend lost their saved slots');
  await page.evaluate(value => window.panel.setInsights(value), allOn);
  await page.evaluate(() => window.panel.setAnimeMode(true));
  await expect.poll(shown).toEqual(hiddenOrder);
  const invalidRejected = await page.evaluate(async () => {
    try { await window.panel.setInsightOrder(['resets', 'resets', 'mascot', 'timeline']); return false; }
    catch { return true; }
  });
  assert.equal(invalidRejected, true, 'malformed sort IPC accepted');
  assert.deepEqual((await page.evaluate(() => window.panel.getState())).insightOrder, hiddenOrder);
  checks.push({ label: 'sort/hidden-items', ordinaryMode: true, disabledPanel: true, restoredSlots: true, validatedIPC: true });

  stage = 'sort/wide-rtl';
  await page.evaluate(() => window.panel.setLayout('double'));
  await page.evaluate(() => window.panel.setLanguage('ar'));
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.evaluate(value => window.panel.setInsightOrder(value), defaultOrder);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('.insights')).toHaveClass(/is-wide/);
  await settledLayout();
  const columns = await page.locator('.insights').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  assert.equal(columns, 2, 'wide fixture must have exactly two columns');
  await sortKey('trend', 'Alt+ArrowRight');
  await expect.poll(shown).toEqual(['trend', 'resets', 'timeline', 'mascot']);
  await sortKey('resets', 'Alt+ArrowDown');
  const finalOrder = ['trend', 'timeline', 'mascot', 'resets'];
  await expect.poll(shown).toEqual(finalOrder);
  await page.locator('.insights').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'sort-wide-rtl.png'), animations: 'disabled', scale: 'css' });
  checks.push({ label: 'sort/wide-rtl', horizontalDirection: true, rowStride: columns });

  stage = 'sort/cold-restart';
  await page.evaluate(() => window.panel.setLanguage('zh-CN'));
  await page.evaluate(() => window.panel.setSkin('watch'));
  const saved = JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8'));
  assert.deepEqual(saved.insightOrder, finalOrder);
  assert.deepEqual((await page.evaluate(() => window.panel.getState())).providerOrder, providerOrder, 'lower-panel sorting modified provider-card order');
  await app.close(); app = null;
  await launch({ reset: false });
  await expect.poll(shown).toEqual(finalOrder);
  const restored = await page.evaluate(() => window.panel.getState());
  assert.deepEqual(restored.insightOrder, finalOrder); assert.deepEqual(restored.providerOrder, providerOrder);
  await page.evaluate(async () => { const state = await window.panel.getState(); await window.panel.configure({ side: state.side, locked: state.locked, animate: state.animate }); });
  assert.deepEqual((await page.evaluate(() => window.panel.getState())).insightOrder, finalOrder, 'unrelated preference update reset sort order');
  checks.push({ label: 'sort/cold-restart', persisted: true, providerOrderPreserved: true, unrelatedPreferencesPreserved: true });
}

try {
  await mkdir(output, { recursive: true });
  await launch();
  // Three skins, both display modes, tall and short windows, eight modules:
  // none of the enabled lower panels may disappear when the cards are full.
  for (const skin of ['watch', 'dial', 'party']) {
    await page.evaluate(value => window.panel.setSkin(value), skin);
    for (const anime of [false, true]) {
      await page.evaluate(value => window.panel.setAnimeMode(value), anime);
      for (const height of [1000, 560]) {
        const label = `${skin}/${anime ? 'anime' : 'normal'}/${height}`;
        await page.setViewportSize({ width: 420, height });
        await expect.poll(shown).toEqual(anime ? ['resets', 'trend', 'timeline', 'mascot'] : ['resets', 'trend', 'timeline']);
        await expect(page.locator('.provider-card')).toHaveCount(8);
        await expect.poll(() => page.locator('.insight-timeline li').count()).toBeGreaterThanOrEqual(13);
        await expect(page.locator('.insight-resets li')).toHaveCount(8);
        await expect(page.locator('.insight-trend li')).toHaveCount(5);
        await geometry(label, { reserved: true });
        // Every skin/mode gets real wheel and keyboard checks at the crowded
        // short size; tall geometry is checked without redundant full suites.
        if (height === 560) await wheelScroll(label);
      }
    }
    await cardsScrollIndependently(`${skin}/eight-cards`);
  }

  stage = 'two-modules';
  await page.evaluate(() => window.panel.setEnabled(['claude', 'codex']));
  for (const height of [1000, 560]) {
    await page.setViewportSize({ width: 420, height });
    await expect.poll(shown).toEqual(['resets', 'trend', 'timeline', 'mascot']);
    await geometry(`two-modules/${height}`);
  }
  await page.evaluate(value => window.panel.setEnabled(value), ids);

  // UI switches still hide only the selected panel and persist their values.
  stage = 'settings-switches';
  await page.setViewportSize({ width: 420, height: 1000 });
  await settings();
  await page.locator('.settings-nav').getByRole('button', { name: '外观', exact: true }).click();
  await setCheckbox('额度趋势', false);
  await closeSettings();
  await expect.poll(shown).toEqual(['resets', 'timeline', 'mascot']);
  assert.equal(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).insights.trend, false);
  await settings();
  for (const name of ['动态时间线', '额度重置日程', '看板娘']) await setCheckbox(name, false);
  await closeSettings();
  await expect(page.locator('.insights')).toHaveCount(0);
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).insights, { timeline: false, resets: false, trend: false, mascot: false });
  await page.evaluate(value => window.panel.setInsights(value), allOn);
  await expect.poll(shown).toEqual(['resets', 'trend', 'timeline', 'mascot']);

  // Wide layout/RTL coverage is intentionally one representative combination.
  await page.evaluate(() => window.panel.setLayout('double'));
  await page.evaluate(() => window.panel.setLanguage('ar'));
  await page.setViewportSize({ width: 900, height: 720 });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('.insights')).toHaveClass(/is-wide/);
  await geometry('wide-rtl', { wide: true, reserved: true });
  await wheelScroll('wide-rtl');
  await mascotPortrait('wide-rtl');
  // Check the requested portrait alignment in the normal Chinese direction as
  // well, while retaining the RTL scroll regression above.
  await page.evaluate(() => window.panel.setLanguage('zh-CN'));
  await settledLayout();
  await page.locator('.insights').focus();
  await page.keyboard.press('End');
  await expect.poll(async () => Math.abs(await scrollTop() - await maxScroll())).toBeLessThan(2);
  await mascotPortrait('wide-ltr');
  await page.screenshot({ path: path.join(output, 'wide-ltr-bottom.png'), animations: 'disabled', scale: 'css' });

  stage = 'native-fullscreen';
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus(); });
  await page.evaluate(() => window.panel.setLayout('fullscreen'));
  await expect(page.locator('main')).toHaveAttribute('data-layout', 'fullscreen');
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await expect.poll(shown).toEqual(['resets', 'trend', 'timeline', 'mascot']);
  await geometry('native-fullscreen', { reserved: true });
  await page.locator('.insights').focus();
  await page.keyboard.press('End');
  await expect.poll(async () => Math.abs(await scrollTop() - await maxScroll())).toBeLessThan(2);
  await tailVisible('native-fullscreen');
  await mascotPortrait('native-fullscreen');
  await page.screenshot({ path: path.join(output, 'fullscreen-ltr-bottom.png'), animations: 'disabled', scale: 'css' });
  await page.keyboard.press('Escape');
  await expect(page.locator('main')).toHaveAttribute('data-layout', 'double');

  await mascotRefreshAcceptance();
  await mascotAutoRefreshAcceptance();
  await insightSortAcceptance();

  assert.deepEqual(errors, [], 'renderer errors');
  passed = true;
  console.log(`Insights acceptance passed: ${checks.filter(row => !row.label.startsWith('refresh/') && !row.label.startsWith('sort/') && !row.label.endsWith('/portrait')).length} layouts and ${checks.filter(row => row.label.endsWith('/portrait')).length} portrait checks; ${checks.filter(row => row.label.startsWith('refresh/')).length} mascot refresh checks and ${checks.filter(row => row.label.startsWith('sort/')).length} panel-sort checks. Three skins, normal/anime, real wheel/keys/button/pointer input, 60-line history, narrow English/RTL speech, status changes, hidden-item order, edge scrolling, fixed card/shell geometry and cold-restart persistence. Synthetic data only.`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled', scale: 'css' }).catch(() => {});
  console.error(`Insights acceptance failed at ${stage}: ${error.stack || error}`);
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ passed, stage, checks, errors }, null, 2));
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
