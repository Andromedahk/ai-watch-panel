import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import i18n from '../electron/i18n.cjs';

// Exercise the actual test controls and offscreen renderer with an isolated
// profile. The preview switch prevents the USB bridge from being spawned.
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-attention-'));
const output = path.resolve('.local/qa/screen-attention');
const providers = [['codex', 'Codex'], ['claude', 'Claude Code'],
  ['antigravity', 'Antigravity'], ['deepseek', 'DeepSeek Harness']];
const allIds = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];
const packagedIndex = process.argv.indexOf('--packaged');
const packaged = packagedIndex < 0 ? null : path.resolve(process.argv[packagedIndex + 1]);
const checks = [], errors = [];
let app, desktop, screen;
await mkdir(output, { recursive: true });
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
  locked: false, animate: false, language: 'zh-CN', theme: 'dark', skin: 'watch',
  animeMode: true, claudeSource: 'code', providerOrder: allIds, enabledProviders: allIds,
}));

async function outputWindow() {
  await expect.poll(() => app.windows().some(page => page.url().includes('surface=screen'))).toBe(true);
  screen = app.windows().find(page => page.url().includes('surface=screen'));
  await expect(screen.locator('[data-surface="screen"]')).toBeAttached();
  screen.on('pageerror', error => errors.push(error.message));
}

async function capture(name) {
  const encoded = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('surface=screen'));
    return (await window.webContents.capturePage()).toPNG().toString('base64');
  });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(encoded, 'base64'));
}

function activityControl(name) {
  return desktop.locator('.test-provider').filter({ has: desktop.locator('legend', { hasText: name }) }).locator('select').first();
}

async function checkAttention({ id, name, reason, language, testing, theme = 'dark' }) {
  const attention = screen.locator('.screen-attention');
  await expect(attention).toHaveAttribute('data-provider', id);
  await expect(attention).toHaveAttribute('data-reason', reason);
  await expect(screen.locator('main')).toHaveAttribute('data-test-mode', String(testing));
  await screen.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result = await attention.evaluate(element => {
    const rect = item => { const r = item.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const content = element.querySelector('.screen-attention-content');
    const title = content.querySelector('h1');
    const character = element.querySelector('.screen-attention-character');
    const titleRects = [];
    const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(walker.currentNode);
      titleRects.push(...Array.from(range.getClientRects(), r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom })));
    }
    return {
      width: innerWidth, height: innerHeight, bounds: rect(element), character: rect(character),
      content: rect(content), title: rect(title), titleRects, titleText: title.textContent,
      titlePx: parseFloat(getComputedStyle(title).fontSize), color: getComputedStyle(title).color,
      paddingLeft: parseFloat(getComputedStyle(content).paddingLeft), paddingRight: parseFloat(getComputedStyle(content).paddingRight),
      paddingTop: parseFloat(getComputedStyle(content).paddingTop), paddingBottom: parseFloat(getComputedStyle(content).paddingBottom),
      characterProvider: character.querySelector('.avatar')?.dataset.provider,
      loaded: [...character.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0),
      overflow: content.scrollWidth > content.clientWidth + 2 || content.scrollHeight > content.clientHeight + 2,
      children: [...content.children].map(rect),
      interactive: element.querySelectorAll('button,input,select,a,[tabindex="0"]').length,
    };
  });
  const detail = JSON.stringify({ id, reason, language, testing, theme, ...result });
  const expected = language === 'zh-CN'
    ? { input: `${name}有问题想问你`, approval: `${name}需要你的授权` }
    : language === 'en' ? { input: `${name} has a question for you`, approval: `${name} needs your approval` }
    : { input: i18n.createI18n(language).t('{p0}有问题想问你', { p0: name }),
      approval: i18n.createI18n(language).t('{p0}需要你的授权', { p0: name }) };
  const normalized = result.titleText.replace(/\s+/g, ' ').trim();
  for (const kind of reason === 'both' ? ['input', 'approval'] : [reason]) {
    assert.ok(normalized.includes(expected[kind]), detail);
  }
  assert.deepEqual([result.bounds.x, result.bounds.y, result.bounds.width, result.bounds.height], [0, 0, result.width, result.height], detail);
  assert.equal(result.characterProvider, id, detail);
  assert.equal(result.loaded, true, detail);
  assert.equal(result.interactive, 0, detail);
  assert.equal(result.overflow, false, detail);
  assert.ok(Math.abs(result.character.right - result.width / 2) <= 1, detail);
  assert.ok(Math.abs(result.content.x - result.width / 2) <= 1, detail);
  const originalPadding = .04 * Math.min(result.width, result.height) + Math.min(.074 * result.width, .16 * result.height);
  assert.ok(Math.abs(result.paddingLeft - originalPadding) <= 1, 'preserve the established text position: ' + detail);
  for (const box of [...result.children, ...result.titleRects]) {
    assert.ok(box.x >= result.content.x + result.paddingLeft - 2 && box.right <= result.content.right - result.paddingRight + 2,
      'request text must remain completely inside the existing right-hand text area: ' + detail);
    assert.ok(box.y >= result.content.y + result.paddingTop - 2 && box.bottom <= result.content.bottom - result.paddingBottom + 2,
      'all reminder text must retain the existing top/bottom breathing room: ' + detail);
  }
  const rgb = result.color.match(/[\d.]+/g).map(Number);
  assert.ok(rgb[0] >= 170 && rgb[0] > rgb[1] * 1.4 && rgb[0] > rgb[2] * 1.15, detail);
  checks.push({ id, reason, language, testing, theme, ...result });
}

async function inject(snapshot) {
  await app.evaluate(({ BrowserWindow }, snapshot) => {
    global.attentionQaSnapshot = { ...snapshot, sampledAt: new Date().toISOString() };
    if (!global.attentionQaRestore) {
      const restorers = BrowserWindow.getAllWindows().map(window => {
        const contents = window.webContents, original = contents.send;
        contents.send = function(channel, ...args) {
          return original.call(this, channel, ...(channel === 'panel:status-changed' ? [global.attentionQaSnapshot] : args));
        };
        return () => { if (!contents.isDestroyed()) contents.send = original; };
      });
      global.attentionQaRestore = () => { restorers.forEach(restore => restore()); global.attentionQaRestore = null; };
    }
    BrowserWindow.getAllWindows().forEach(window => window.webContents.send('panel:status-changed', global.attentionQaSnapshot));
  }, snapshot);
}

try {
  const env = { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'glow-running', AI_WATCH_STREAM_PREVIEW: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AI_WATCH_DEV_URL;
  app = await electron.launch({ ...(packaged ? { executablePath: packaged, args: [] } : { args: [path.resolve('tests/fixtures/tray-main.cjs')] }), env });
  desktop = await app.firstWindow();
  desktop.on('pageerror', error => errors.push(error.message));
  await expect(desktop.locator('.provider-card')).toHaveCount(8);
  await desktop.evaluate(async () => { await window.panel.setStreamConfig({ pageSeconds: 120 }); await window.panel.startStream(); });
  await outputWindow();
  await desktop.locator('.settings-nav').getByRole('button', { name: '模块', exact: true }).click();
  await desktop.locator('.test-toggle input').check();
  await desktop.locator('.test-presets button').nth(1).click();
  await expect(screen.locator('.screen-attention')).toHaveCount(0);

  for (const [width, height] of [[2240, 1080], [1120, 540], [1080, 1080], [640, 360]]) {
    await desktop.evaluate(config => window.panel.setStreamConfig(config), { width, height });
    await outputWindow();
    for (const language of ['zh-CN', 'en', 'de', 'fr', 'vi', 'ar']) {
      await desktop.evaluate(language => window.panel.setLanguage(language), language);
      for (const [id, name] of providers) {
        const control = activityControl(name);
        assert.ok((await control.locator('option').evaluateAll(options => options.map(option => option.value))).includes('input'), `${id}: input test option`);
        assert.ok((await control.locator('option').evaluateAll(options => options.map(option => option.value))).includes('approval'), `${id}: approval test option`);
        for (const reason of ['input', 'approval']) {
          await control.selectOption(reason);
          await checkAttention({ id, name, reason, language, testing: true });
          if (width === 2240 && (id === 'deepseek' || id === 'antigravity')) await capture(`${id}-${reason}-${language}-${width}x${height}`);
        }
        await control.selectOption('idle');
        await expect(screen.locator('.screen-attention')).toHaveCount(0);
      }
      await activityControl('DeepSeek Harness').selectOption('mixed');
      await checkAttention({ id: 'deepseek', name: 'DeepSeek Harness', reason: 'both', language, testing: true });
      await capture(`deepseek-both-${language}-${width}x${height}`);
      await activityControl('DeepSeek Harness').selectOption('idle');
      await expect(screen.locator('.screen-attention')).toHaveCount(0);
    }
  }

  for (const result of checks.filter(item => item.language === 'en')) {
    const chinese = checks.find(item => item.language === 'zh-CN' && item.width === result.width && item.height === result.height && item.id === result.id && item.reason === result.reason);
    assert.ok(result.titlePx < chinese.titlePx, 'Roman-letter text uses a smaller heading than its Chinese equivalent: ' + JSON.stringify({ english: result, chinese }));
  }

  // Every shipped locale gets the longest provider name and both requests at
  // the native and compact sizes, including CJK, Cyrillic, Hindi and both RTLs.
  const remainingLanguages = i18n.languages.map(item => item.id).filter(id => !['zh-CN', 'en', 'de', 'fr', 'vi', 'ar'].includes(id));
  for (const [width, height] of [[2240, 1080], [640, 360]]) {
    await desktop.evaluate(config => window.panel.setStreamConfig(config), { width, height });
    await outputWindow();
    for (const language of remainingLanguages) {
      await desktop.evaluate(language => window.panel.setLanguage(language), language);
      await activityControl('DeepSeek Harness').selectOption('mixed');
      await checkAttention({ id: 'deepseek', name: 'DeepSeek Harness', reason: 'both', language, testing: true });
      if (width === 2240) await capture(`deepseek-both-${language}-${width}x${height}`);
      await activityControl('DeepSeek Harness').selectOption('idle');
      await expect(screen.locator('.screen-attention')).toHaveCount(0);
    }
  }

  // Also exercise the ordinary structured-status path after disabling test mode.
  // These remain synthetic fixtures; no account reader or USB device is used.
  await desktop.locator('.test-toggle input').uncheck();
  await desktop.evaluate(async () => { await window.panel.setLanguage('en'); await window.panel.setTheme('light'); await window.panel.setStreamConfig({ width: 2240, height: 1080 }); });
  await outputWindow();
  const original = await desktop.evaluate(() => window.panel.getStatus());
  const baseline = structuredClone(original);
  baseline.isTestData = false;
  for (const id of allIds) Object.assign(baseline[id], { activity: 'idle', waitingTasks: 0, waitingReason: null, taskDetails: [] });
  for (const [id, name] of providers) for (const reason of ['input', 'approval']) {
    const next = structuredClone(baseline);
    Object.assign(next[id], { activity: 'waiting', waitingTasks: 1, waitingReason: reason, attentionAvailable: true });
    await inject(next);
    await checkAttention({ id, name, reason, language: 'en', testing: false, theme: 'light' });
  }
  await inject(baseline);
  await expect(screen.locator('.screen-attention')).toHaveCount(0);
  await app.evaluate(() => global.attentionQaRestore?.());
  await desktop.evaluate(() => window.panel.stopStream());
  await expect(desktop.locator('main')).toHaveAttribute('data-surface', 'desktop');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors, deviceAccess: false }, null, 2));
  console.log(`Screen attention QA passed: ${checks.length} checks for four Agents, input/approval/both, real test controls, normal structured statuses, six-language/four-resolution matrix plus all 17 locales for long-name mixed requests, unchanged positions and unclipped text. No USB was opened.`);
} catch (error) {
  if (app && screen && !screen.isClosed()) await capture('failure').catch(() => {});
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(profile, { recursive: true, force: true });
}
