import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real offscreen rendering with synthetic status and an isolated profile. The
// preview flag suppresses the bridge entirely: this check never opens USB.
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-curved-'));
const output = path.resolve('.local/qa/screen-curved');
const ids = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];
await mkdir(output, { recursive: true });
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
  locked: false, animate: false, language: 'zh-CN', theme: 'dark', skin: 'watch',
  animeMode: true, mascotInterval: 15, providerOrder: ids, enabledProviders: ids,
}));
const packagedIndex = process.argv.indexOf('--packaged');
const packaged = packagedIndex < 0 ? null : path.resolve(process.argv[packagedIndex + 1]);
const errors = [], checks = [];
let app, desktop, screen;
async function outputWindow() {
  await expect.poll(() => app.windows().some(page => page.url().includes('surface=screen'))).toBe(true);
  screen = app.windows().find(page => page.url().includes('surface=screen'));
  await expect(screen.locator('[data-surface="screen"]')).toBeAttached();
  await screen.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function capture(name) {
  const bytes = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=screen'));
    return (await window.webContents.capturePage()).toPNG().toString('base64');
  });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(bytes, 'base64'));
}
async function inject(snapshot) {
  await screen.evaluate(() => {
    if (!window.curvedQaObserveStatus) window.curvedQaObserveStatus = window.panel.onStatus(value => { window.curvedQaReceivedStatus = value; });
  });
  const sampledAt = await app.evaluate(({ BrowserWindow }, snapshot) => {
    // Stamp at the point of delivery. A fixture poll can run during the test
    // process' IPC round trip; its newer timestamp would correctly supersede
    // a snapshot stamped before this callback reaches the main process.
    const value = { ...snapshot, sampledAt: new Date().toISOString() };
    global.curvedQaSnapshot = value;
    if (!global.curvedQaRestore) {
      const restorers = BrowserWindow.getAllWindows().map(window => {
        const contents = window.webContents, original = contents.send;
        contents.send = function(channel, ...args) {
          return original.call(this, channel, ...(channel === 'panel:status-changed' ? [global.curvedQaSnapshot] : args));
        };
        return () => { if (!contents.isDestroyed()) contents.send = original; };
      });
      global.curvedQaRestore = () => { restorers.forEach(restore => restore()); global.curvedQaRestore = null; };
    }
    BrowserWindow.getAllWindows().forEach(window => window.webContents.send('panel:status-changed', value));
    return value.sampledAt;
  }, snapshot);
  await expect.poll(() => screen.evaluate(() => window.curvedQaReceivedStatus?.sampledAt)).toBe(sampledAt);
}
async function assertGeometry(context) {
  await expect(screen.locator('.provider-card:visible')).toHaveCount(4);
  await expect(screen.locator('.screen-mascot')).toHaveCount(1);
  await expect(screen.locator('.screen-trend')).toHaveCount(1);
  const result = await screen.evaluate(() => {
    const rect = element => {
      const r = element.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const box = selector => rect(document.querySelector(selector));
    return { width: innerWidth, height: innerHeight, agents: box('.screen-agent-module'),
      sidebar: box('.screen-sidebar'), mascot: box('.screen-mascot'), trend: box('.screen-trend'),
      interactive: document.querySelectorAll('button,input,select,a,[tabindex="0"]').length,
      bodyOverflow: document.body.scrollWidth > innerWidth || document.body.scrollHeight > innerHeight,
      cards: [...document.querySelectorAll('.provider-card')].filter(card => getComputedStyle(card).display !== 'none').map(card => {
        const bounds = rect(card), title = card.querySelector('h2'), label = card.querySelector('.model-name,.credit-label,.balance-parts');
        const cardBox = selector => { const element = card.querySelector(selector); return element ? rect(element) : null; };
        return { id: card.dataset.provider, ...bounds, overflowX: card.scrollWidth > card.clientWidth + 1,
          overflowY: card.scrollHeight > card.clientHeight + 1, titlePx: title ? parseFloat(getComputedStyle(title).fontSize) : null,
          labelPx: label ? parseFloat(getComputedStyle(label).fontSize) : null,
          upper: cardBox('.screen-card-top'), lower: cardBox('.screen-card-bottom'),
          portrait: cardBox('.screen-card-portrait .avatar-launch'), ring: cardBox('.screen-card-portrait .dial-frame'),
          ringBadge: cardBox('.screen-card-portrait .dial-figure'),
          ringBadgeLayer: card.querySelector('.screen-card-portrait .dial-figure') ? Number(getComputedStyle(card.querySelector('.screen-card-portrait .dial-figure')).zIndex) : null,
          portraitFaceLayer: Number(getComputedStyle(card.querySelector('.screen-card-portrait .avatar-face')).zIndex) || 0,
          identityParts: [...card.querySelectorAll('.screen-card-identity h2,.screen-card-identity .plan-summary,.screen-card-identity .state-pill')]
            .filter(element => element.getClientRects().length).map(rect),
          metricOverflow: [...card.querySelectorAll('.screen-metrics,.quota-area,.balance-content,.credits-list,.quota-list')]
            .filter(element => element.getClientRects().length && (element.scrollHeight > element.clientHeight + 2 || element.scrollWidth > element.clientWidth + 2))
            .map(element => ({ name: element.className, width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight })),
          escaped: [...card.querySelectorAll('.identity,.quota-area,.task-line,.card-foot')]
            .filter(element => element.getClientRects().length)
            .map(element => ({ name: element.className, ...rect(element) }))
            .filter(r => r.left < bounds.left - 2 || r.top < bounds.top - 2 || r.right > bounds.right + 2 || r.bottom > bounds.bottom + 2),
        };
      }),
      mascotText: document.querySelector('.mascot-bubble')?.textContent,
      imagesLoaded: [...document.querySelectorAll('.screen-content img')].every(img => img.complete && img.naturalWidth > 0),
    };
  });
  const detail = JSON.stringify({ ...context, ...result });
  assert.equal(result.bodyOverflow, false, detail);
  assert.equal(result.interactive, 0, detail);
  assert.ok(result.mascotText, detail);
  assert.equal(result.imagesLoaded, true, detail);
  assert.ok(result.agents.right <= result.width / 2 + 1, detail);
  assert.ok(result.sidebar.left >= result.width / 2 - 1, detail);
  assert.ok(Math.abs(result.agents.width - result.sidebar.width) <= 2, detail);
  assert.ok(result.mascot.right <= result.width && result.trend.right <= result.width, detail);
  assert.ok(result.mascot.top < result.trend.top && result.mascot.bottom <= result.trend.top, detail);
  assert.ok(Math.abs(result.mascot.height - result.trend.height) <= 2, detail);
  assert.ok(result.trend.bottom <= result.height, detail);
  assert.equal(new Set(result.cards.map(card => Math.round(card.left))).size, 2, detail);
  assert.equal(new Set(result.cards.map(card => Math.round(card.top))).size, 2, detail);
  for (const card of result.cards) {
    assert.ok(card.right <= result.width / 2 + 1 && card.bottom <= result.height, detail);
    assert.equal(card.overflowX, false, detail); assert.equal(card.overflowY, false, detail);
    assert.deepEqual(card.escaped, [], detail);
    assert.deepEqual(card.metricOverflow, [], detail);
    assert.ok(card.upper && card.lower && card.portrait, detail);
    assert.ok(card.upper.top < card.lower.top && card.upper.bottom <= card.lower.top + 1, detail);
    assert.ok(card.upper.height >= card.height * .38 && card.upper.height <= card.height * .55, detail);
    assert.ok(card.lower.width >= card.width * .85, detail);
    assert.ok(card.portrait.top >= card.upper.top - 1 && card.portrait.bottom <= card.upper.bottom + 1, detail);
    assert.ok(Math.min(card.portrait.width, card.portrait.height) >= Math.min(card.width, card.height) * .30, detail);
    for (const part of card.identityParts) {
      assert.ok(part.top >= card.upper.top - 1 && part.bottom <= card.upper.bottom + 1, detail);
      assert.ok(part.left >= card.portrait.right - 1 && part.right <= card.upper.right + 1, detail);
    }
    if (context.skin === 'dial') {
      assert.ok(card.ring && Math.min(card.ring.width, card.ring.height) >= Math.min(card.width, card.height) * .38, detail);
      assert.ok(Math.min(card.portrait.width, card.portrait.height) >= Math.min(card.ring.width, card.ring.height) * .75, detail);
      assert.ok(card.ringBadgeLayer > card.portraitFaceLayer, detail);
      assert.ok(card.ringBadge.bottom <= card.upper.bottom + 1, detail);
    }
    if (context.width === 2240) assert.ok(card.titlePx >= 32, detail);
  }
  checks.push({ ...context, ...result });
}
async function assertAttention(reason, theme) {
  await expect(screen.locator('.screen-attention')).toHaveCount(1);
  const result = await screen.locator('.screen-attention').evaluate(element => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const character = element.querySelector('.screen-attention-character'), content = element.querySelector('.screen-attention-content'), title = element.querySelector('h1');
    return { bounds: rect(element), width: innerWidth, height: innerHeight,
      character: rect(character), content: rect(content), title: rect(title), titleText: title.textContent,
      titlePx: parseFloat(getComputedStyle(title).fontSize), color: getComputedStyle(title).color, provider: element.dataset.provider,
      characterProvider: character.querySelector('.avatar')?.dataset.provider,
      loaded: [...character.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0),
      overflow: content.scrollWidth > content.clientWidth + 1 || content.scrollHeight > content.clientHeight + 1,
      escaped: [...content.children].map(rect).filter(r => r.x < innerWidth / 2 - 1 || r.right > innerWidth + 1 || r.y < -1 || r.bottom > innerHeight + 1),
    };
  });
  const detail = JSON.stringify({ reason, theme, ...result });
  assert.deepEqual([result.bounds.x, result.bounds.y, result.bounds.width, result.bounds.height], [0, 0, result.width, result.height], detail);
  assert.ok(result.character.right <= result.width / 2 + 1, detail);
  assert.ok(result.content.x >= result.width / 2 - 1 && result.content.right <= result.width, detail);
  assert.ok(result.title.x >= result.width / 2 - 1 && result.title.right <= result.width, detail);
  assert.ok(result.title.x - result.width / 2 >= result.titlePx, 'request text must move right by at least one large character: ' + detail);
  assert.equal(result.provider, result.characterProvider, detail);
  assert.equal(result.loaded, true, detail); assert.equal(result.overflow, false, detail);
  assert.deepEqual(result.escaped, [], detail);
  const rgb = result.color.match(/[\d.]+/g).map(Number);
  assert.ok(rgb[0] >= 170 && rgb[0] > rgb[1] * 1.4 && rgb[0] > rgb[2] * 1.15, detail);
  checks.push({ reason, theme, ...result });
}
async function setMotion(animate, reducedMotion = 'no-preference') {
  await desktop.evaluate(async animate => {
    const state = await window.panel.getState();
    await window.panel.configure({ side: state.side, locked: state.locked, animate });
  }, animate);
  await screen.emulateMedia({ reducedMotion });
  await expect.poll(() => screen.locator('main').evaluate(main => main.classList.contains('no-animation'))).toBe(!animate);
}
async function observeReminders() {
  await screen.evaluate(() => {
    window.curvedQaObserver?.disconnect();
    window.curvedQaReminders = [];
    const observe = () => {
      const element = document.querySelector('.screen-attention');
      if (!element || window.curvedQaReminders.at(-1)?.key === element.dataset.reminderKey) return;
      const styles = selector => getComputedStyle(element.querySelector(selector)).animationName;
      window.curvedQaReminders.push({ key: element.dataset.reminderKey, provider: element.dataset.provider,
        reason: element.dataset.reason, index: Number(element.dataset.attentionIndex),
        title: element.querySelector('.screen-attention-task')?.textContent,
        time: performance.now(), characterAnimation: styles('.screen-attention-character'),
        textAnimation: styles('.screen-attention-content'), progressAnimation: styles('.screen-attention-progress span') });
    };
    window.curvedQaObserver = new MutationObserver(observe);
    window.curvedQaObserver.observe(document.querySelector('main'), { childList: true, subtree: true });
    observe();
  });
}
async function assertTaskRotation(original) {
  const task = (title, operation, extra = {}) => ({ title, operation, state: 'waiting', stale: false,
    updatedAt: new Date().toISOString(), source: 'cache', steps: 1, toolCalls: 0, progress: null, ...extra });
  const multiple = structuredClone(original);
  Object.assign(multiple.claude, { activity: 'waiting', waitingTasks: 2, waitingReason: 'both', taskDetails: [
    task('合成授权 A：请确认使用计划中的命令', 'approval/asked'), task('合成授权 B：请确认执行后续步骤', 'approval/asked'),
    task('过期提醒应当排除', 'approval/asked', { stale: true }), task('已完成提醒应当排除', 'approval/asked', { state: 'completed' }),
  ] });
  Object.assign(multiple.codex, { activity: 'waiting', waitingTasks: 1, waitingReason: 'input', taskDetails: [
    task('合成提问 C：请补充项目要求', 'question'),
  ] });
  await setMotion(true);
  await observeReminders();
  await inject(multiple);
  await expect(screen.locator('main')).toHaveAttribute('data-attention-count', '3');
  await expect(screen.locator('.screen-attention-progress')).toHaveCount(1);
  await expect.poll(() => screen.locator('.screen-attention-progress span').evaluate(element => Number(element.getAnimations()[0]?.currentTime))).toBeGreaterThan(160);
  await screen.evaluate(() => {
    const section = document.querySelector('.screen-attention'), content = section.querySelector('.screen-attention-content');
    window.curvedQaStableReminder = { section, content, character: section.querySelector('.screen-attention-character'),
      transition: content.getAnimations()[0], progress: section.querySelector('.screen-attention-progress span') };
  });
  await inject(multiple);
  assert.deepEqual(await screen.evaluate(() => {
    const old = window.curvedQaStableReminder, current = document.querySelector('.screen-attention');
    return { section: old.section === current, progress: old.progress === current.querySelector('.screen-attention-progress span'),
      transition: old.transition === current.querySelector('.screen-attention-content').getAnimations()[0] };
  }), { section: true, progress: true, transition: true }, 'a timestamp refresh must not restart any reminder animation');
  const expanded = structuredClone(multiple);
  Object.assign(expanded.antigravity, { activity: 'waiting', waitingTasks: 1, waitingReason: 'input', taskDetails: [] });
  const membershipChanges = [];
  let timerResetAt;
  for (const [snapshot, count] of [[expanded, 4], [multiple, 3]]) {
    await inject(snapshot);
    await expect(screen.locator('main')).toHaveAttribute('data-attention-count', String(count));
    const change = await screen.evaluate(() => {
      const old = window.curvedQaStableReminder, section = document.querySelector('.screen-attention');
      const progress = section.querySelector('.screen-attention-progress span'), content = section.querySelector('.screen-attention-content');
      const result = { sectionSame: old.section === section, contentSame: old.content === content,
        characterSame: old.character === section.querySelector('.screen-attention-character'),
        transitionSame: old.transition === content.getAnimations()[0], progressReplaced: old.progress !== progress,
        progressTime: Number(progress.getAnimations()[0]?.currentTime), resetAt: performance.now() };
      old.progress = progress;
      return result;
    });
    assert.deepEqual([change.sectionSame, change.contentSame, change.characterSame, change.transitionSame, change.progressReplaced], [true, true, true, true, true], JSON.stringify(change));
    assert.ok(change.progressTime >= 0 && change.progressTime < 500, JSON.stringify(change));
    timerResetAt = change.resetAt;
    membershipChanges.push({ count, ...change });
  }
  const expectedTitles = multiple.claude.taskDetails.slice(0, 2).concat(multiple.codex.taskDetails).map(task => task.title).sort();
  // Real collectors refresh their timestamps without changing the waiting task.
  // Refresh faster than the six-second carousel to prove it cannot starve.
  let refreshedAt = Date.now();
  await expect.poll(async () => {
    if (Date.now() - refreshedAt >= 3000) {
      for (const provider of [multiple.claude, multiple.codex]) for (const item of provider.taskDetails) item.updatedAt = new Date().toISOString();
      await inject(multiple); refreshedAt = Date.now();
    }
    return screen.evaluate(() => new Set(window.curvedQaReminders.map(item => item.key)).size);
  }, { timeout: 17000, intervals: [200, 400, 500] }).toBe(3);
  const rotations = await screen.evaluate(() => window.curvedQaReminders);
  assert.deepEqual(rotations.map(item => item.title).sort(), expectedTitles, JSON.stringify(rotations));
  assert.deepEqual(rotations.map(item => item.index), [0, 1, 2], JSON.stringify(rotations));
  assert.ok(rotations[1].time - timerResetAt >= 5500 && rotations[1].time - timerResetAt <= 8000, JSON.stringify({ rotations, timerResetAt }));
  assert.equal(rotations.filter(item => item.provider === 'claude').length, 2);
  assert.equal(rotations.filter(item => item.provider === 'codex').length, 1);
  for (const item of rotations) {
    assert.equal(item.characterAnimation, 'screen-attention-character-enter', JSON.stringify(item));
    assert.equal(item.textAnimation, 'screen-attention-text-enter', JSON.stringify(item));
    assert.equal(item.progressAnimation, 'screen-attention-countdown', JSON.stringify(item));
    assert.equal(item.reason, item.title.includes('提问') ? 'input' : 'approval', JSON.stringify(item));
  }
  await expect.poll(() => screen.locator('.screen-attention-content').evaluate(element => {
    const animation = element.getAnimations().find(item => item.animationName === 'screen-attention-text-enter');
    return Boolean(animation && Number(animation.currentTime) > 0);
  })).toBe(true);
  await screen.locator('.screen-attention-content').evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  await assertAttention('task-queue-motion', 'light');
  await capture('attention-task-queue');
  checks.push({ reason: 'task-queue', rotations, membershipChanges, timestampRefreshPreservedRotation: true });

  for (const [animate, reducedMotion, label] of [[false, 'no-preference', 'disabled'], [true, 'reduce', 'reduced']]) {
    await setMotion(animate, reducedMotion);
    const first = await screen.locator('.screen-attention').getAttribute('data-reminder-key');
    await expect.poll(() => screen.locator('.screen-attention').getAttribute('data-reminder-key'), { timeout: 8000 }).not.toBe(first);
    const animations = await screen.locator('.screen-attention').evaluate(element => [...element.querySelectorAll('.screen-attention-character,.screen-attention-content,.screen-attention-progress span')].map(item => getComputedStyle(item).animationName));
    assert.deepEqual(animations, ['none', 'none', 'none'], label);
    await assertAttention(`task-queue-${label}`, 'light');
  }
  await screen.evaluate(() => window.curvedQaObserver.disconnect());
  await setMotion(false);
  await inject(original);
  await expect(screen.locator('.screen-attention')).toHaveCount(0);
}
try {
  app = await electron.launch({ ...(packaged ? { executablePath: packaged, args: [] } : { args: ['.'] }),
    env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'glow-running', AI_WATCH_STREAM_PREVIEW: '1' } });
  app.on('window', page => page.on('pageerror', error => errors.push(error.message)));
  desktop = await app.firstWindow();
  desktop.on('pageerror', error => errors.push(error.message));
  await expect(desktop.locator('.provider-card')).toHaveCount(8);
  await desktop.evaluate(() => window.panel.setStreamConfig({ pageSeconds: 120 }));
  await desktop.evaluate(() => window.panel.startStream());
  await expect.poll(() => desktop.evaluate(() => window.panel.getState()).then(state => state.stream.status)).toBe('running');
  await outputWindow();
  await expect(screen.locator('.screen-quota-trend')).toBeVisible();
  await expect(screen.locator('.screen-trend polyline')).toHaveCount(0);
  assert.equal(await screen.locator('.screen-trend polyline').count(), 0, 'a fresh live journal must not invent a curve');
  await desktop.locator('.settings-nav').getByRole('button', { name: '模块', exact: true }).click();
  await desktop.getByRole('checkbox', { name: '测试模式', exact: true }).check();
  await desktop.getByRole('button', { name: '全部运行', exact: true }).click();
  await expect.poll(() => screen.locator('.screen-trend polyline').count()).toBeGreaterThan(0);
  for (const [width, height] of [[2240, 1080], [1120, 540], [1080, 1080]]) {
    await desktop.evaluate(config => window.panel.setStreamConfig(config), { width, height });
    await outputWindow();
    for (const skin of ['watch', 'dial', 'party']) for (const theme of ['dark', 'light']) for (const anime of [true, false]) {
      await desktop.evaluate(async ({ skin, theme, anime }) => {
        await window.panel.setSkin(skin); await window.panel.setTheme(theme); await window.panel.setAnimeMode(anime);
      }, { skin, theme, anime });
      await expect(screen.locator('main')).toHaveClass(new RegExp(`skin-${skin}`));
      await expect(screen.locator('html')).toHaveAttribute('data-theme', theme);
      await screen.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await assertGeometry({ width, height, skin, theme, anime });
      if (anime && (width === 2240 || theme === 'dark')) await capture(`${skin}-${theme}-${width}x${height}`);
    }
  }
  await desktop.evaluate(() => window.panel.setStreamConfig({ width: 2240, height: 1080 }));
  await outputWindow();
  // Include the second four providers' credit/balance variants. Sorting is
  // intentionally blocked while streaming, so rearrange only the isolated
  // profile while its preview is stopped, then restore the original order.
  for (const order of [[...ids.slice(4), ...ids.slice(0, 4)], ids]) {
    await desktop.evaluate(async order => {
      await window.panel.stopStream(); await window.panel.setOrder(order); await window.panel.startStream();
    }, order);
    await outputWindow();
    await expect(screen.locator('.provider-card:visible')).toHaveCount(4);
    await expect.poll(() => screen.locator('.provider-card:visible').evaluateAll(cards => cards.map(card => card.dataset.provider))).toEqual(order.slice(0, 4));
    if (order[0] === 'zcode') {
      await desktop.evaluate(async () => { await window.panel.setAnimeMode(true); await window.panel.setTheme('dark'); });
      for (const skin of ['watch', 'dial', 'party']) {
        await desktop.evaluate(skin => window.panel.setSkin(skin), skin);
        await expect(screen.locator('main')).toHaveClass(new RegExp(`skin-${skin}`));
        await screen.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await assertGeometry({ width: 2240, height: 1080, skin, theme: 'dark', anime: true, page: 2 });
        await capture(`${skin}-second-page-2240x1080`);
      }
    }
  }
  await desktop.getByRole('checkbox', { name: '测试模式', exact: true }).uncheck();
  await expect(screen.locator('.screen-quota-trend')).toBeVisible();
  await expect(screen.locator('.screen-trend polyline')).toHaveCount(0);
  const original = await desktop.evaluate(() => window.panel.getStatus());
  for (const theme of ['dark', 'light']) {
    await desktop.evaluate(theme => window.panel.setTheme(theme), theme);
    for (const reason of ['input', 'approval', 'both']) {
      const next = structuredClone(original);
      Object.assign(next.codex, { activity: 'waiting', waitingTasks: 1, waitingReason: reason });
      await inject(next);
      await expect(screen.locator('.screen-attention')).toHaveAttribute('data-reason', reason);
      await assertAttention(reason, theme);
      await capture(`attention-${reason}-${theme}`);
    }
  }
  const multiple = structuredClone(original);
  Object.assign(multiple.claude, { activity: 'waiting', waitingTasks: 1, waitingReason: 'input' });
  Object.assign(multiple.codex, { activity: 'waiting', waitingTasks: 1, waitingReason: 'approval' });
  await inject(multiple);
  await expect(screen.locator('main')).toHaveAttribute('data-attention-count', '2');
  const first = await screen.locator('.screen-attention').getAttribute('data-provider');
  await expect.poll(() => screen.locator('.screen-attention').getAttribute('data-provider'), { timeout: 9000 }).not.toBe(first);
  await assertAttention('multiple', 'light');
  await inject(original);
  await expect(screen.locator('.screen-attention')).toHaveCount(0);
  await assertTaskRotation(original);
  await app.evaluate(() => global.curvedQaRestore?.());
  for (const [width, height] of [[1120, 540], [1080, 1080]]) {
    await desktop.evaluate(config => window.panel.setStreamConfig(config), { width, height });
    await outputWindow();
    const next = structuredClone(original);
    Object.assign(next.codex, { activity: 'waiting', waitingTasks: 1, waitingReason: 'both' });
    await inject(next);
    await expect(screen.locator('.screen-attention')).toHaveAttribute('data-reason', 'both');
    await assertAttention(`both-${width}x${height}`, 'light');
    await capture(`attention-both-${width}x${height}`);
    Object.assign(next.codex, { waitingReason: 'input', taskDetails: [{
      title: '合成的较长项目提问：请确认当前需求描述，以及下一步应该优先处理的实现范围和显示效果',
      operation: 'question', state: 'waiting', stale: false, updatedAt: new Date().toISOString(),
      source: 'cache', steps: 1, toolCalls: 0, progress: null,
    }] });
    await inject(next);
    await expect(screen.locator('.screen-attention-task')).toContainText('合成的较长项目提问');
    await assertAttention(`long-task-${width}x${height}`, 'light');
    await inject(original);
    await expect(screen.locator('.screen-attention')).toHaveCount(0);
    await app.evaluate(() => global.curvedQaRestore?.());
  }
  await desktop.evaluate(() => window.panel.setStreamConfig({ showMascot: false }));
  await outputWindow();
  await expect(screen.locator('.screen-mascot')).toHaveCount(0);
  await expect(screen.locator('.screen-trend')).toHaveCount(1);
  await expect(screen.locator('.provider-card:visible')).toHaveCount(4);
  assert.equal(await screen.locator('button,input,select,a,[tabindex="0"]').count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors, deviceAccess: false }, null, 2));
  console.log(`Curved display QA passed: ${checks.length} checks, equal left/right faces, 2×2 Agents with larger portraits above quotas, mascot above quota history, shifted red request text, per-task carousel and transitions, disabled/reduced motion, empty/test history, queue clearing and no interactive controls. USB was not opened.`);
} catch (error) {
  if (app && screen && !screen.isClosed()) await capture('failure').catch(() => {});
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(profile, { recursive: true, force: true });
}
