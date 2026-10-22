import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Only isolated profiles and synthetic fixtures are used. No real account or application is accessed.
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-motion-'));
const output = process.env.AI_WATCH_MOTION_OUTPUT || '.local/qa/motion';
const ids = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];
const checks = [], errors = [], visibility = [], themes = [];
let app, page, stage = 'startup';
const card = id => page.locator(`.provider-card[data-provider="${id}"]`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const settings = () => page.getByRole('button', { name: '打开配置', exact: true }).click();
const closeSettings = () => page.getByRole('button', { name: '关闭配置', exact: true }).click();
async function launch(skin) {
  await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ locked: false, animate: true,
    language: 'zh-CN', theme: 'dark', skin, animeMode: false, enabledProviders: ids }));
  app = await electron.launch({ args: ['.'], env: { ...process.env,
    AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'glow-running' } });
  await app.evaluate(({ app, BrowserWindow }) => {
    const observe = win => {
      global.motionWindowReadiness = { id: win.id, eventObserved: false, visibleAtAttach: win.isVisible() };
      win.once('ready-to-show', () => { global.motionWindowReadiness.eventObserved = true; });
    };
    const win = BrowserWindow.getAllWindows()[0];
    if (win) observe(win); else app.once('browser-window-created', (_event, win) => observe(win));
  });
  page = await app.firstWindow();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0], ready = global.motionWindowReadiness;
    return Boolean(win?.isVisible() && ready?.id === win.id && (ready.eventObserved || ready.visibleAtAttach));
  })).toBe(true);
  page.on('pageerror', error => errors.push(error.message));
  await page.bringToFront();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.dataset.sampledAt));
  await expect(page.locator('main')).toHaveAttribute('data-skin', skin);
  await page.setViewportSize({ width: 420, height: 900 });
  assert.equal((await page.evaluate(() => window.panel.getStatus())).isTestData, true);
}
async function finish() {
  await app?.close(); app = null;
}
async function independentVisibility() {
  return page.locator('.provider-viewport').evaluate(root => new Promise((resolve, reject) => {
    const cards = [...root.querySelectorAll('.provider-card')], rows = new Map();
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Independent visibility observation timed out')); }, 3000);
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => rows.set(entry.target.dataset.provider, entry.intersectionRatio));
      if (rows.size === cards.length) {
        observer.disconnect(); clearTimeout(timer);
        resolve(Object.fromEntries([...rows].map(([id, ratio]) => [id, { ratio, paused: ratio < .6 }])));
      }
    }, { root, threshold: [0, .6, 1] });
    cards.forEach(card => observer.observe(card));
  }));
}
async function checkVisibility(label) {
  const observed = await independentVisibility();
  const expected = Object.fromEntries(ids.map(id => [id, String(observed[id].paused)]));
  await expect.poll(() => page.locator('.provider-card').evaluateAll(cards => Object.fromEntries(
    cards.map(card => [card.dataset.provider, card.dataset.animationPaused]))), { message: label }).toEqual(expected);
  assert.ok(Object.values(observed).some(row => !row.paused), `${label}: no readable card in viewport`);
  visibility.push({ label, observed });
}
async function scroll(where) {
  await page.locator('.provider-viewport').evaluate((root, where) => root.scrollTo({ top: where === 'bottom' ? root.scrollHeight : 0, behavior: 'instant' }), where);
}
async function checkRebuild(label) {
  await scroll('top'); await checkVisibility(`${label}/top`);
  await scroll('bottom'); await checkVisibility(`${label}/bottom`);
  await scroll('top'); await checkVisibility(`${label}/return`);
}
async function animation(locator, name) {
  return locator.evaluate((el, name) => {
    const anim = el.getAnimations({ subtree: true }).find(item => item.animationName === name);
    return anim ? { state: anim.playState, pending: anim.pending, time: typeof anim.currentTime === 'number' ? anim.currentTime : null } : null;
  }, name);
}
async function settledAnimation(locator, name, state, label) {
  let snapshot;
  await expect.poll(async () => {
    snapshot = await locator.evaluate(async (el, name) => {
      const anim = el.getAnimations({ subtree: true }).find(item => item.animationName === name);
      if (!anim) return null;
      // playState can already say "paused" while its compositor pause task is
      // pending. Use the readiness promise, with a bound, before sampling time.
      let timer;
      const ready = await Promise.race([
        anim.ready.then(() => true, () => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 1500); }),
      ]);
      clearTimeout(timer);
      return { ready, state: anim.playState, pending: anim.pending,
        time: typeof anim.currentTime === 'number' ? anim.currentTime : null };
    }, name);
    return snapshot && { ready: snapshot.ready, state: snapshot.state, pending: snapshot.pending, numericTime: typeof snapshot.time === 'number' };
  }, { message: `${label}/ready` }).toEqual({ ready: true, state, pending: false, numericTime: true });
  return snapshot;
}
async function advances(locator, name, label) {
  const before = await settledAnimation(locator, name, 'running', label);
  await expect.poll(() => animation(locator, name).then(row => row?.state === 'running' && !row.pending && row.time > before.time + 20), { message: label }).toBe(true);
  checks.push(`${label}: animation currentTime advances`);
}
async function frozen(locator, name, label) {
  const before = await settledAnimation(locator, name, 'paused', label);
  await pause(160); // The measurement window proves a ready pause stays frozen.
  const after = await settledAnimation(locator, name, 'paused', label);
  assert.ok(Math.abs(after.time - before.time) < 1, `${label}: ${JSON.stringify({ before, after })}`);
  checks.push(`${label}: animation currentTime stays frozen`);
}
async function primaryEffect(skin, label) {
  const locator = skin === 'party' ? card('claude') : card('claude').locator('.avatar');
  const name = skin === 'party' ? 'party-glow' : 'logo-breathe';
  await scroll('top'); await advances(locator, name, `${label}/visible`);
  if (skin !== 'party') await advances(card('claude'), 'sweep', `${label}/running sweep ::after`);
  await scroll('bottom');
  await expect(card('claude')).toHaveAttribute('data-animation-paused', 'true');
  await frozen(locator, name, `${label}/offscreen`);
  if (skin !== 'party') await frozen(card('claude'), 'sweep', `${label}/offscreen sweep ::after`);
  await scroll('top');
  await expect(card('claude')).toHaveAttribute('data-animation-paused', 'false');
  await advances(locator, name, `${label}/return`);
}
const entranceName = { watch: 'card-in', dial: 'card-in-dial', party: 'card-in-party' };
async function entranceReplayed(skin, trigger, label) {
  const replays = () => page.locator('main').evaluate(main => Number(main.dataset.entranceReplays || 0));
  const before = await replays();
  await trigger();
  const row = await page.locator('main').evaluate((main, before) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Entrance was not replayed')), 5000);
    const check = () => {
      if (Number(main.dataset.entranceReplays || 0) <= before) { requestAnimationFrame(check); return; }
      clearTimeout(timer);
      const card = main.querySelector('.provider-card[data-provider="claude"]');
      const enter = card.getAnimations().find(item => item.animationName?.startsWith('card-in'));
      const curtain = card.getAnimations({ subtree: true }).find(item => item.animationName?.startsWith('curtain-'));
      const gauge = [...card.getAnimations({ subtree: true })].find(item => ['fill-in', 'ring-in'].includes(item.animationName));
      resolve({ name: enter?.animationName, time: enter?.currentTime, curtain: curtain?.currentTime, gauge: gauge ? gauge.currentTime : null });
    };
    check();
  }), before);
  assert.equal(row.name, entranceName[skin], `${label}: ${JSON.stringify(row)}`);
  assert.ok(row.time < 450 && row.curtain < 450 && (row.gauge === null || row.gauge < 600), `${label}: ${JSON.stringify(row)}`);
  checks.push(`${label}: agent cards replay their ${row.name} entrance`);
}
async function selectActivity(id, activity) {
  const names = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
  await page.getByRole('combobox', { name: `${names[id]} 测试任务状态`, exact: true }).selectOption(activity);
}
async function moduleSettings() {
  await settings();
  await page.locator('.settings-nav').getByRole('button', { name: '模块', exact: true }).click();
}
async function reminderRows(expected) {
  await expect(page.locator('.attention-list .attention')).toHaveCount(expected.length);
  assert.deepEqual(await page.locator('.attention-list .attention').evaluateAll(rows => rows.map(row => row.dataset.provider)), expected);
  if (expected.length) {
    assert.equal(await page.locator('.attention-list .attention').evaluateAll(rows => rows.every((row, i) => {
      const r = row.getBoundingClientRect();
      return r.height > 0 && r.width > 0 && (i === 0 || r.top >= rows[i - 1].getBoundingClientRect().bottom - 1);
    })), true);
    await expect(page.locator('.attention[data-provider="claude"] .attention-kicker')).toHaveText('待授权');
    if (expected.includes('codex')) await expect(page.locator('.attention[data-provider="codex"] .attention-kicker')).toHaveText('待回答');
  }
}
async function noMotion(label) {
  await expect.poll(() => page.locator('main').evaluate(main => {
    const bad = [];
    for (const el of [main, ...main.querySelectorAll('*')]) for (const pseudo of [null, '::before', '::after']) {
      const style = getComputedStyle(el, pseudo);
      if (style.animationName.split(',').some(name => name.trim() !== 'none')
        || style.transitionDuration.split(',').some(duration => parseFloat(duration) !== 0)) bad.push(`${el.className}/${pseudo}`);
    }
    return bad.slice(0, 10);
  }), { message: label }).toEqual([]);
  await reminderRows(['claude', 'codex', 'antigravity']);
  await expect(card('claude').locator('.state-pill')).toHaveText('待授权');
  await expect(card('codex').locator('.state-pill')).toHaveText('待回答');
  assert.ok(await page.locator('.provider-card [role="progressbar"][aria-valuenow]').count() > 0);
  checks.push(label);
}
async function themeFlip(theme, skin) {
  // Observe the palette at the mutation microtask and subsequent rendered frames, rather than wait for transitions to finish.
  await page.evaluate(() => {
    window.motionThemeFrames = [];
    window.motionThemeObserver?.disconnect();
    const capture = phase => {
      const root = document.documentElement, el = document.querySelector('.provider-card[data-provider="claude"] .state-pill');
      const style = getComputedStyle(el), probe = document.createElement('span');
      probe.style.cssText = 'position:fixed;visibility:hidden;background:var(--warn-bg);color:var(--warn-fg)';
      document.body.append(probe); const wanted = getComputedStyle(probe);
      window.motionThemeFrames.push({ phase, theme: root.dataset.theme, switching: root.classList.contains('theme-switching'),
        bg: style.backgroundColor, color: style.color, expectedBg: wanted.backgroundColor, expectedColor: wanted.color,
        duration: style.transitionDuration }); probe.remove();
    };
    window.motionThemeObserver = new MutationObserver(records => {
      if (!records.some(record => record.attributeName === 'data-theme')) return;
      capture('mutation'); requestAnimationFrame(() => { capture('frame-1'); requestAnimationFrame(() => capture('frame-2')); });
    });
    window.motionThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  });
  await page.evaluate(value => window.panel.setTheme(value), theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect.poll(() => page.evaluate(() => window.motionThemeFrames.length)).toBe(3);
  const frames = await page.evaluate(() => { window.motionThemeObserver.disconnect(); return window.motionThemeFrames; });
  for (const frame of frames) {
    assert.equal(frame.theme, theme, JSON.stringify(frame));
    assert.equal(frame.bg, frame.expectedBg, JSON.stringify(frame));
    assert.equal(frame.color, frame.expectedColor, JSON.stringify(frame));
  }
  assert.equal(frames[0].switching, true, 'Theme must suppress transitions when the palette changes');
  assert.ok(frames[0].duration.split(',').every(value => parseFloat(value) === 0), JSON.stringify(frames[0]));
  await expect(page.locator('html')).not.toHaveClass(/theme-switching/);
  await expect.poll(() => card('claude').locator('.state-pill').evaluate(el => getComputedStyle(el).transitionDuration))
    .not.toBe('0s');
  themes.push({ skin, theme, frames });
}
try {
  await mkdir(output, { recursive: true });
  for (const skin of ['dial', 'party']) {
    await launch(skin);
    await checkRebuild(`cold-${skin}`); await primaryEffect(skin, `cold-${skin}`);
    await finish();
  }
  await launch('watch');
  for (const skin of ['watch', 'dial', 'party']) {
    const switchSkin = () => page.evaluate(value => window.panel.setSkin(value), skin);
    // The fixture starts in watch, so only an actual switch is expected to replay.
    if (skin === 'watch') await switchSkin(); else await entranceReplayed(skin, switchSkin, `${skin}/skin entrance`);
    await expect(page.locator('main')).toHaveAttribute('data-skin', skin);
    await checkRebuild(`${skin}/skin`);
    await primaryEffect(skin, `${skin}/rebuilt`);
    for (const anime of [true, false]) {
      await entranceReplayed(skin, () => page.evaluate(value => window.panel.setAnimeMode(value), anime), `${skin}/anime-${anime} entrance`);
      await checkRebuild(`${skin}/anime-${anime}`);
    }
    for (const layout of ['double', 'fullscreen', 'single']) {
      stage = `${skin}/${layout}`;
      if (layout === 'fullscreen') {
        // macOS may ignore a background app's native Space transition. Activate
        // this isolated fixture window before requesting its real fullscreen mode.
        await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus(); });
      }
      await entranceReplayed(skin, () => page.evaluate(value => window.panel.setLayout(value), layout), `${skin}/${layout} entrance`);
      await expect(page.locator('main')).toHaveAttribute('data-layout', layout);
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(layout === 'fullscreen');
      await checkRebuild(`${skin}/${layout}`);
    }
    await page.getByRole('button', { name: '收起面板', exact: true }).click();
    await expect(page.locator('.rail-providers .rail-item')).toHaveCount(8);
    await page.getByRole('button', { name: '展开面板', exact: true }).click();
    await checkRebuild(`${skin}/expanded`);
    await moduleSettings();
    await page.getByRole('checkbox', { name: '测试模式', exact: true }).check();
    await page.getByRole('button', { name: '全部待机', exact: true }).click(); await closeSettings();
    await reminderRows([]); await checkRebuild(`${skin}/test-mode`);
    await moduleSettings(); await selectActivity('claude', 'approval'); await closeSettings();
    await reminderRows(['claude']);
    await moduleSettings(); await selectActivity('codex', 'input'); await selectActivity('antigravity', 'waiting'); await closeSettings();
    await reminderRows(['claude', 'codex', 'antigravity']);
    await advances(page.locator('.attention[data-provider="claude"] .attention-open'), 'open-pulse', `${skin}/waiting button`);
    await page.evaluate(() => window.panel.store());
    await expect(page.locator('main')).toHaveClass(/animations-paused/);
    await frozen(page.locator('.attention[data-provider="claude"] .attention-open'), 'open-pulse', `${skin}/stored waiting button`);
    await entranceReplayed(skin, () => app.evaluate(({ app }) => app.emit('activate')), `${skin}/reopen entrance`);
    await expect(page.locator('main')).not.toHaveClass(/animations-paused/);
    await advances(page.locator('.attention[data-provider="claude"] .attention-open'), 'open-pulse', `${skin}/restored waiting button`);
    await page.emulateMedia({ reducedMotion: 'reduce' }); await noMotion(`${skin}/reduced-motion`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await advances(page.locator('.attention[data-provider="claude"] .attention-open'), 'open-pulse', `${skin}/reduced-motion restored`);
    await page.evaluate(async () => { const s = await window.panel.getState(); await window.panel.configure({ side: s.side, locked: s.locked, animate: false }); });
    await expect(page.locator('main')).toHaveClass(/no-animation/); await noMotion(`${skin}/animations-off`);
    await page.evaluate(async () => { const s = await window.panel.getState(); await window.panel.configure({ side: s.side, locked: s.locked, animate: true }); });
    await advances(page.locator('.attention[data-provider="claude"] .attention-open'), 'open-pulse', `${skin}/animations restored`);
    for (const theme of ['light', 'dark']) await themeFlip(theme, skin);
    await page.evaluate(async () => { for (const theme of ['light', 'dark', 'light', 'dark']) await window.panel.setTheme(theme); });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).not.toHaveClass(/theme-switching/);
    await page.screenshot({ path: `${output}/${skin}-waiting.png`, animations: 'allow' });
    await moduleSettings(); await page.getByRole('button', { name: '全部待机', exact: true }).click(); await closeSettings();
    await reminderRows([]);
    await moduleSettings(); await page.getByRole('checkbox', { name: '测试模式', exact: true }).uncheck(); await closeSettings();
    await checkRebuild(`${skin}/live-fixture restored`);
    await scroll('top');
    await entranceReplayed(skin, () => page.getByRole('button', { name: '刷新面板', exact: true }).click(), `${skin}/refresh entrance`);
    await checkRebuild(`${skin}/refreshed`);
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify({ syntheticFixture: true, checks, visibility, themes, errors }, null, 2));
  console.log(`Motion acceptance passed: persisted dial/party startup; ${visibility.length} independent visibility observations; animation timeline advance/freeze/resume; skin/anime/layout/test/collapse rebuilds; entrance replay on refresh, skin/layout/mode switch and reopen; three skins with 0/1/3/0 reminders, reduced motion, animations off, stored restore and first-frame palette changes. Synthetic data only.`);
} catch (error) {
  const native = await app?.evaluate(({ app, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { readyToShow: global.motionWindowReadiness, visible: win?.isVisible(), minimized: win?.isMinimized(),
      focusable: win?.isFocusable(), focused: win?.isFocused(), fullscreen: win?.isFullScreen(),
      hidden: typeof app.isHidden === 'function' ? app.isHidden() : null, bounds: win?.getBounds() };
  }).catch(error => ({ error: error.message }));
  console.log('Motion failure context:', JSON.stringify({ stage, native }));
  await page?.screenshot({ path: `${output}/failure.png`, animations: 'allow' }).catch(() => {});
  throw error;
} finally {
  await finish(); await rm(profile, { recursive: true, force: true });
}
