import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// This acceptance command is scoped to lower-half scrolling. It uses an
// isolated profile, synthetic account/status fixtures and an in-memory journal.
// All screenshots/results stay ignored under .local; no real app is opened.
const output = path.resolve(process.env.AI_WATCH_INSIGHTS_OUTPUT || '.local/qa/insights');
const relativeOutput = path.relative(path.resolve('.local'), output);
assert.ok(relativeOutput && !relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput), 'acceptance output must be inside .local');
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-insights-'));
const ids = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];
const allOn = { timeline: true, resets: true, trend: true, mascot: true };
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

async function launch() {
  await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ locked: false, animate: false,
    language: 'zh-CN', theme: 'dark', skin: 'watch', animeMode: false, insights: allOn, enabledProviders: ids }));
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

  assert.deepEqual(errors, [], 'renderer errors');
  passed = true;
  console.log(`Insights scrolling acceptance passed: ${checks.filter(row => !row.label.endsWith('/portrait')).length} layouts and ${checks.filter(row => row.label.endsWith('/portrait')).length} portrait checks, three skins, normal/anime, tall/short and 2/8 modules; real wheel up/down, keyboard Home/PageDown/End, final content reachability, unclipped lists, independent cards/fixed shell, UI switches/persistence, wrapped wide grid, RTL and native fullscreen. Synthetic data only.`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled', scale: 'css' }).catch(() => {});
  console.error(`Insights scrolling acceptance failed at ${stage}: ${error.stack || error}`);
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ passed, stage, checks, errors }, null, 2));
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
