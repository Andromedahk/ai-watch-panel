import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// OLED guard on the streamed surface: synthetic data, isolated profile and the
// preview stream, so USB, ADB, credentials and physical displays are never touched.
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-oled-'));
const output = path.resolve('.local/qa/screen-oled-guard');
const ids = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];
await mkdir(output, { recursive: true });
// Animations off: the guard is panel protection and must keep moving regardless.
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
  locked: false, animate: false, language: 'zh-CN', theme: 'dark', skin: 'watch',
  animeMode: true, mascotInterval: 5, providerOrder: ids, enabledProviders: ids,
  stream: { enabled: true, device: 'ryuo4', width: 2240, height: 1080, fps: 30,
    bitrateMbps: 6, pageSeconds: 120, showMascot: true, agentsPerPage: 4, oledGuard: true },
}));
let app, desktop, screen;
const errors = [], checks = [];
async function outputWindow(device) {
  await expect.poll(() => app.windows().some(page => page.url().includes('surface=screen'))).toBe(true);
  screen = app.windows().find(page => page.url().includes('surface=screen'));
  screen.on('pageerror', error => errors.push(error.message));
  await expect(screen.locator('main')).toHaveAttribute('data-device', device);
  await screen.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
}
async function capture(name) {
  const image = await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=screen')).webContents;
    let frame;
    for (let pass = 0; pass < 3; pass++) frame = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { contents.removeListener('paint', painted); reject(new Error('No composed frame')); }, 5000);
      function painted(_event, _dirty, image) { clearTimeout(timer); resolve(image); }
      contents.once('paint', painted); contents.invalidate();
    });
    return frame.toPNG().toString('base64');
  });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(image, 'base64'));
}
async function guarded(device) {
  const main = screen.locator('main');
  await expect(main).toHaveAttribute('data-oled-guard', 'true');
  await expect(screen.locator('.screen-module-heading strong')).toHaveCount(0);
  await expect(screen.locator('.screen-module-heading time')).toHaveCount(0);
  assert.equal(await screen.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(0, 0, 0)');
  // Seek the drift to each quarter: the 95% UI must sit exactly in each corner.
  const corners = [];
  for (const [quarter, corner] of [[0, 'top-left'], [1, 'top-right'], [2, 'bottom-right'], [3, 'bottom-left']]) {
    const box = await screen.evaluate(quarter => {
      const main = document.querySelector('main');
      const drift = main.getAnimations().find(animation => animation.animationName === 'screen-oled-drift');
      if (!drift) return null;
      drift.pause(); drift.currentTime = quarter * 120_000;
      const r = main.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, viewport: [innerWidth, innerHeight] };
    }, quarter);
    assert.ok(box, `${device}: drift animation must run with animations off`);
    const [width, height] = box.viewport, detail = JSON.stringify({ device, corner, box });
    assert.ok(Math.abs(box.width - width * .95) < 1 && Math.abs(box.height - height * .95) < 1, detail);
    assert.ok(Math.abs(box.x - (quarter === 1 || quarter === 2 ? width * .05 : 0)) < 1, detail);
    assert.ok(Math.abs(box.y - (quarter >= 2 ? height * .05 : 0)) < 1, detail);
    assert.ok(box.x >= -0.5 && box.y >= -0.5 && box.right <= width + 0.5 && box.bottom <= height + 0.5, detail);
    corners.push({ corner, ...box });
    if (quarter === 0 || quarter === 2) { await screen.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await new Promise(r => setTimeout(r, 500)); await capture(`${device}-${corner}`); }
  }
  await screen.evaluate(() => document.querySelector('main').getAnimations().find(animation => animation.animationName === 'screen-oled-drift').play());
  // Each companion refresh (5 s here) replays the sidebar fade with an alternating name.
  const sidebar = screen.locator('.screen-sidebar');
  await expect.poll(() => sidebar.getAttribute('data-oled-refresh'), { timeout: 8000 }).not.toBe(null);
  const first = await sidebar.getAttribute('data-oled-refresh');
  assert.ok(await sidebar.evaluate(element => element.getAnimations().some(animation => animation.animationName.startsWith('screen-oled-refresh'))), `${device}: sidebar refresh animation`);
  await expect.poll(() => sidebar.getAttribute('data-oled-refresh'), { timeout: 8000 }).not.toBe(first);
  checks.push({ device, corners, sidebarRefresh: true });
}
try {
  app = await electron.launch({ args: [path.resolve('tests/fixtures/tray-main.cjs')], env: {
    ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'glow-running', AI_WATCH_STREAM_PREVIEW: '1',
  } });
  desktop = await app.firstWindow(); desktop.on('pageerror', error => errors.push(error.message));
  await expect.poll(() => desktop.evaluate(() => window.panel.getState()).then(state => state.stream.status)).toBe('running');
  await expect(desktop.getByRole('checkbox', { name: 'OLED 防烧屏', exact: true })).toBeChecked();
  await outputWindow('ryuo4');
  await guarded('ryuo4');
  await desktop.evaluate(() => window.panel.setStreamConfig({ device: 'zhanyu', width: 2240, height: 1080, bitrateMbps: 8 }));
  await outputWindow('zhanyu');
  await guarded('zhanyu');
  await desktop.evaluate(() => window.panel.setStreamConfig({ oledGuard: false }));
  await outputWindow('zhanyu');
  await expect(screen.locator('main')).not.toHaveAttribute('data-oled-guard', /.*/);
  await expect(screen.locator('.screen-module-heading strong')).toHaveText('AI WATCH');
  assert.equal(await screen.evaluate(() => getComputedStyle(document.querySelector('main')).transform), 'none');
  assert.equal(await screen.evaluate(() => document.querySelector('.screen-sidebar').hasAttribute('data-oled-refresh')), false);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'checks.json'), JSON.stringify({ usbOpened: false, data: 'synthetic', checks }, null, 2));
  console.log(`OLED guard QA passed: ${checks.length} devices, four corners each, sidebar refresh and off state; screenshots in .local/qa/screen-oled-guard. USB was not opened.`);
} finally {
  if (app) await app.close().catch(() => {});
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(profile, { recursive: true, force: true });
}
