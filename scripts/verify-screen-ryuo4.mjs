import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Synthetic provider data and an isolated test profile. Preview skips the bridge
// entirely, so screenshots never access ADB, USB, credentials or physical devices.
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-ryuo4-'));
const output = path.resolve('.local/qa/screen-ryuo4');
const remindersOnly = process.argv.includes('--reminders-only');
const counts = remindersOnly ? [] : process.argv.includes('--two-only') ? [2] : [2, 4, 6];
const ids = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];
await mkdir(output, { recursive: true });
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
  locked: false, animate: false, language: 'zh-CN', theme: 'dark', skin: 'watch',
  animeMode: true, mascotInterval: 120, providerOrder: ids, enabledProviders: ids,
  stream: { enabled: true, device: 'ryuo4', width: 2240, height: 1080, fps: 30,
    bitrateMbps: 6, pageSeconds: 120, showMascot: true, agentsPerPage: 4 },
}));
let app, desktop, screen;
const errors = [], checks = [];
async function outputWindow() {
  await expect.poll(() => app.windows().some(page => page.url().includes('surface=screen'))).toBe(true);
  screen = app.windows().find(page => page.url().includes('surface=screen'));
  screen.on('pageerror', error => errors.push(error.message));
  await expect(screen.locator('main')).toHaveAttribute('data-device', 'ryuo4');
  await screen.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
}
async function capture(name) {
  await screen.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const image = await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=screen')).webContents;
    let frame;
    // A paint already queued before the theme change may arrive first. Complete
    // successive invalidations before freezing the actual transmitted bitmap.
    for (let pass = 0; pass < 3; pass++) frame = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { contents.removeListener('paint', painted); reject(new Error('No composed RYUO frame')); }, 5000);
      function painted(_event, _dirty, image) { clearTimeout(timer); resolve(image); }
      contents.once('paint', painted); contents.invalidate();
    });
    return frame.toPNG().toString('base64');
  });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(image, 'base64'));
}
async function inject(snapshot) {
  await app.evaluate(({ BrowserWindow }, snapshot) => {
    global.ryuoQaSnapshot = { ...snapshot, sampledAt: new Date().toISOString() };
    global.ryuoQaOriginalSends ||= new Map();
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents;
      if (!global.ryuoQaOriginalSends.has(contents)) {
        const original = contents.send;
        global.ryuoQaOriginalSends.set(contents, original);
        contents.send = function(channel, ...args) {
          return original.call(this, channel, ...(channel === 'panel:status-changed' ? [global.ryuoQaSnapshot] : args));
        };
      }
      contents.send('panel:status-changed', global.ryuoQaSnapshot);
    }
  }, snapshot);
}
async function geometry(count, skin, variant) {
  await expect(screen.locator('.provider-card:visible')).toHaveCount(count);
  await expect(screen.locator('.screen-mascot')).toHaveCount(1);
  await expect(screen.locator('.screen-trend')).toHaveCount(0);
  const result = await screen.evaluate(() => {
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const box = selector => rect(document.querySelector(selector));
    const agents = box('.screen-agent-module');
    return { width: innerWidth, height: innerHeight, agents, sidebar: box('.screen-sidebar'),
      figure: box('.screen-mascot .mascot-figure'), bubble: box('.screen-mascot .mascot-bubble'),
      bubbleText: document.querySelector('.mascot-bubble').textContent,
      cards: [...document.querySelectorAll('.provider-card')].filter(card => card.getClientRects().length).map(card => ({
        ...rect(card), overflow: card.scrollWidth > card.clientWidth + 2 || card.scrollHeight > card.clientHeight + 2,
      })),
      interactive: document.querySelectorAll('button,input,select,a,[tabindex="0"]').length,
      bodyOverflow: document.body.scrollWidth > innerWidth || document.body.scrollHeight > innerHeight,
    };
  });
  const detail = JSON.stringify({ count, skin, variant, ...result });
  assert.deepEqual([result.width, result.height], [2240, 1080], detail);
  assert.ok(Math.abs(result.agents.width / result.sidebar.width - 2.5) < 0.02, detail);
  assert.ok(result.agents.right < result.sidebar.x && result.sidebar.right <= 2240, detail);
  assert.ok(result.figure.bottom <= result.bubble.y + 2 && result.bubble.bottom <= 1080, detail);
  assert.ok(result.bubbleText, detail);
  assert.equal(result.interactive, 0, detail); assert.equal(result.bodyOverflow, false, detail);
  assert.equal(new Set(result.cards.map(card => Math.round(card.x))).size, count === 6 ? 3 : 2, detail);
  assert.equal(new Set(result.cards.map(card => Math.round(card.y))).size, count === 2 ? 1 : 2, detail);
  for (const card of result.cards) { assert.ok(card.right <= result.agents.right + 2 && card.bottom <= 1080, detail); assert.equal(card.overflow, false, detail); }
  checks.push({ count, skin, variant, ...result });
}
try {
  app = await electron.launch({ args: [path.resolve('tests/fixtures/tray-main.cjs')], env: {
    ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'glow-running', AI_WATCH_STREAM_PREVIEW: '1',
  } });
  desktop = await app.firstWindow(); desktop.on('pageerror', error => errors.push(error.message));
  await expect.poll(() => desktop.evaluate(() => window.panel.getState()).then(state => state.stream.status)).toBe('running');
  await outputWindow();
  const original = await desktop.evaluate(() => window.panel.getStatus());
  for (const count of counts) {
    await desktop.evaluate(count => window.panel.setStreamConfig({ agentsPerPage: count }), count);
    await outputWindow();
    for (const skin of ['watch', 'dial', 'party']) for (const variant of ['light', 'dark', 'anime']) {
      await desktop.evaluate(async ({ skin, variant }) => {
        await window.panel.setSkin(skin); await window.panel.setTheme(variant === 'light' ? 'light' : 'dark'); await window.panel.setAnimeMode(variant === 'anime');
      }, { skin, variant });
      await expect(screen.locator('main')).toHaveClass(new RegExp(`skin-${skin}`));
      await expect.poll(() => screen.locator('main').evaluate(main => main.classList.contains('anime-mode'))).toBe(variant === 'anime');
      await expect.poll(() => screen.evaluate(() => document.documentElement.dataset.theme)).toBe(variant === 'light' ? 'light' : 'dark');
      await screen.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
      await geometry(count, skin, variant);
    }
  }
  await desktop.evaluate(async () => { await window.panel.setSkin('watch'); await window.panel.setTheme('dark'); await window.panel.setAnimeMode(true); });
  // Produce comparison images in fresh output windows after the rapid skin
  // matrix. This also starts each page at the same companion and metric state.
  for (const count of counts) {
    await desktop.evaluate(count => window.panel.setStreamConfig({ agentsPerPage: count }), count);
    await outputWindow();
    await expect(screen.locator('main')).toHaveClass(/anime-mode/);
    await expect(screen.locator('.provider-card:visible .avatar[data-anime="true"]')).toHaveCount(count);
    await geometry(count, 'watch', 'anime-comparison');
    await capture(`ryuo4-agents-${count}`);
  }
  if (counts.includes(2)) {
    await desktop.evaluate(() => window.panel.setStreamConfig({ agentsPerPage: 2, pageSeconds: 4 }));
    await outputWindow();
    const visibleIds = [], pageNumbers = [];
    for (let index = 0; index < 4; index++) {
      await expect(screen.locator('.provider-card:visible')).toHaveCount(2);
      const current = await screen.locator('main').getAttribute('data-page');
      pageNumbers.push(Number(current));
      visibleIds.push(...await screen.locator('.provider-card:visible').evaluateAll(cards => cards.map(card => card.dataset.provider)));
      if (index < 3) await expect.poll(() => screen.locator('main').getAttribute('data-page'), { timeout: 6500 }).not.toBe(current);
    }
    assert.deepEqual(pageNumbers, [1, 2, 3, 4], 'two-card layout must rotate through four pages');
    assert.deepEqual([...new Set(visibleIds)].sort(), [...ids].sort(), 'four pages must cover all eight enabled Agents');
    checks.push({ layout: '2 × 1', pages: pageNumbers, providers: visibleIds });
  }
  for (const reason of ['input', 'approval']) {
    const snapshot = structuredClone(original);
    Object.assign(snapshot.codex, { activity: 'waiting', waitingTasks: 1, waitingReason: reason, taskDetails: [] });
    await inject(snapshot);
    await expect(screen.locator('.screen-attention')).toHaveAttribute('data-reason', reason);
    await screen.waitForFunction(() => [...document.querySelectorAll('.screen-attention img')].every(image => image.complete && image.naturalWidth > 0));
    const result = await screen.locator('.screen-attention').evaluate(element => {
      const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const content = element.querySelector('.screen-attention-content'), character = element.querySelector('.screen-attention-character'), title = element.querySelector('h1');
      const image = character.querySelector('img'), imageBox = rect(image), orbit = rect(character.querySelector('.screen-attention-orbit'));
      const face = character.querySelector('.avatar-face'), faceStyle = getComputedStyle(face);
      const containedHeight = Math.min(imageBox.height, imageBox.width * image.naturalHeight / image.naturalWidth);
      return { bounds: rect(element), content: rect(content), character: rect(character), title: rect(title), titleText: title.textContent,
        textAlign: getComputedStyle(content).textAlign, titleTextAlign: getComputedStyle(title).textAlign,
        textParts: [...content.children].map(part => ({ className: part.className, ...rect(part) })),
        face: rect(face), faceRadius: faceStyle.borderTopLeftRadius, faceOverflow: faceStyle.overflow, faceMask: faceStyle.maskImage, faceClip: faceStyle.clipPath,
        portraitCenter: { x: imageBox.x + imageBox.width / 2, y: imageBox.bottom - containedHeight / 2 },
        orbit, imageBox, orbitCenter: { x: orbit.x + orbit.width / 2, y: orbit.y + orbit.height / 2 },
        overflow: content.scrollWidth > content.clientWidth + 2 || content.scrollHeight > content.clientHeight + 2,
        color: getComputedStyle(title).color };
    });
    const detail = JSON.stringify({ reason, ...result });
    assert.deepEqual([result.bounds.x, result.bounds.y, result.bounds.width, result.bounds.height], [0, 0, 2240, 1080], detail);
    assert.ok(result.content.x === 0 && Math.abs(result.content.width / result.character.width - 2.5) < 0.02, detail);
    assert.ok(result.title.right <= result.character.x && result.character.right === 2240, detail);
    assert.equal(result.textAlign, 'center', detail); assert.equal(result.titleTextAlign, 'center', detail);
    assert.ok(Math.abs(result.content.x + result.content.width / 2 - 800) < 2, detail);
    for (const part of result.textParts) assert.ok(Math.abs(part.x + part.width / 2 - 800) < 2, detail);
    assert.ok(Math.abs(result.face.width - result.face.height) < 2, detail);
    const radius = parseFloat(result.faceRadius), radiusRatio = result.faceRadius.includes('%') ? radius / 100 : radius / result.face.width;
    assert.ok(radiusRatio >= 0.49, 'Reminder portrait must have circular clipping: ' + detail);
    assert.equal(result.faceOverflow, 'hidden', detail); assert.equal(result.faceMask, 'none', detail);
    assert.match(result.faceClip, /^circle\(50%/, detail);
    assert.ok(Math.abs(result.face.x + result.face.width / 2 - result.orbitCenter.x) < 4 && Math.abs(result.face.y + result.face.height / 2 - result.orbitCenter.y) < 4, detail);
    assert.ok(Math.abs(result.portraitCenter.x - result.orbitCenter.x) < 4 && Math.abs(result.portraitCenter.y - result.orbitCenter.y) < 4, detail);
    assert.ok(Math.abs(result.portraitCenter.y - 540) < 4 && Math.abs(result.orbitCenter.y - 540) < 4, detail);
    assert.ok(result.orbit.x < result.character.x && result.imageBox.x < result.character.x, 'Reminder artwork may cross the bend into the left area: ' + detail);
    assert.ok(result.orbit.x >= 0 && result.orbit.right <= 2240 && result.imageBox.x >= 0 && result.imageBox.right <= 2240, detail);
    assert.equal(result.overflow, false, detail); assert.match(result.titleText, reason === 'input' ? /有问题想问你/ : /需要你的授权/);
    checks.push({ reason, ...result });
    await capture(`ryuo4-waiting-${reason}`);
  }
  await inject(original); await expect(screen.locator('.screen-attention')).toHaveCount(0);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, remindersOnly ? 'reminder-checks.json' : 'checks.json'), JSON.stringify({ usbOpened: false, data: 'synthetic', humanAcceptance: { monitoringAgentsPerPage: 4, monitoringLayout: 'selected', reminderStyle: 'pending' }, checks }, null, 2));
  const panels = [['ryuo4-agents-4','已选方案：四个 Agent · 2 × 2'],['ryuo4-waiting-input','等待回答 · 左侧文字居中 / 右侧圆形角色'],['ryuo4-waiting-approval','等待授权 · 左侧文字居中 / 右侧圆形角色']];
  await writeFile(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><title>RYUO IV 四卡布局与提醒预览</title><style>body{margin:32px;background:#16191e;color:#edf0f4;font:18px system-ui}img{display:block;width:100%;margin:16px 0 40px}h1{font-size:28px}p{color:#bbc3ce}details{margin:48px 0;color:#bbc3ce}summary{cursor:pointer}</style><h1>ROG 龙王 IV · 已选择四 Agent 方案</h1><p>原生 2240 × 1080 · 默认每页四卡 · 右侧单看板娘与台词</p><p>合成测试数据 · 无 USB · 监看布局已选择，圆形头像与居中文字提醒等待确认</p>' + panels.map(([file,title])=>`<h2>${title}</h2><img src="${file}.png" alt="${title}">`).join('') + '<details><summary>备选：六个 Agent · 3 × 2（保留切换选项）</summary><img src="ryuo4-agents-6.png" alt="六 Agent 备选方案"></details>');
  console.log(`RYUO layout QA passed: ${checks.length} checks; ${remindersOnly ? 'question/approval alert geometry' : `all skins and variants, ${counts.join('/')} cards, mascot-only sidebar and question/approval alerts`}; screenshots in .local/qa/screen-ryuo4. USB was not opened.`);
} finally {
  if (app) await app.close().catch(() => {});
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(profile, { recursive: true, force: true });
}
