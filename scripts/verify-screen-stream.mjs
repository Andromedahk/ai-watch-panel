import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-screen-qa-'));
const output = path.resolve('.local/qa/screen');
await mkdir(output, { recursive: true });
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
  locked: false, animate: true, theme: 'dark', language: 'zh-CN', animeMode: true, mascotInterval: 5,
}));
const packagedArgument = process.argv.indexOf('--packaged');
const packaged = packagedArgument < 0 ? null : path.resolve(process.argv[packagedArgument + 1]);
const launch = () => electron.launch({ ...(packaged ? { executablePath: packaged, args: [] } : { args: [path.resolve('tests/fixtures/tray-main.cjs')] }), env: {
  ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'glow-running', AI_WATCH_STREAM_PREVIEW: '1',
} });
let app;
const errors = [];
async function outputWindow() {
  await expect.poll(() => app.windows().some(page => page.url().includes('surface=screen'))).toBe(true);
  return app.windows().find(page => page.url().includes('surface=screen'));
}
async function capture(name) {
  const encoded = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=screen'));
    return (await window.webContents.capturePage()).toPNG().toString('base64');
  });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(encoded, 'base64'));
}
async function inject(snapshot) {
  await app.evaluate(({ BrowserWindow }, value) => {
    global.screenQaSnapshot = value;
    if (!global.screenQaRestore) {
      const originals = BrowserWindow.getAllWindows().map(window => {
        const contents = window.webContents, original = contents.send;
        contents.send = function(channel, ...args) {
          return original.call(this, channel, ...(channel === 'panel:status-changed' ? [global.screenQaSnapshot] : args));
        };
        return () => { if (!contents.isDestroyed()) contents.send = original; };
      });
      global.screenQaRestore = () => { originals.forEach(restore => restore()); global.screenQaRestore = null; };
    }
    BrowserWindow.getAllWindows().forEach(window => window.webContents.send('panel:status-changed', value));
  }, snapshot);
}
try {
  app = await launch();
  let desktop = await app.firstWindow();
  desktop.on('pageerror', error => errors.push(error.message));
  await desktop.waitForFunction(() => document.querySelector('main')?.dataset.sampledAt);
  await desktop.locator('.toolbar button').last().click();
  await expect(desktop.locator('.stream-settings')).toBeVisible();
  await desktop.getByRole('button', { name: '开启小屏幕串流', exact: true }).click();
  await expect(desktop.locator('main')).toHaveAttribute('data-surface', 'controller');
  await expect.poll(() => desktop.evaluate(() => window.panel.getState()).then(state => state.stream.status)).toBe('running');
  await expect(desktop.locator('.provider-card')).toHaveCount(0);
  await expect(desktop.locator('.settings-dialog')).toBeVisible();
  await desktop.screenshot({ path: path.join(output, 'desktop-settings.png') });
  let screen = await outputWindow();
  screen.on('pageerror', error => errors.push(error.message));
  await expect(screen.locator('[data-surface="screen"]')).toBeAttached();
  assert.deepEqual(await screen.evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 2240, height: 1080 }, 'offscreen viewport must not inherit monitor or DPI limits');
  assert.deepEqual(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=screen')).webContents.capturePage()).getSize()), { width: 2240, height: 1080 }, 'native bitmap must match stream resolution without stretching');
  await expect(screen.locator('.provider-card:visible')).toHaveCount(4);
  await expect(screen.locator('.screen-mascot')).toHaveCount(1);
  assert.deepEqual((await screen.evaluate(() => Object.keys(window.panel))).sort(), ['getState', 'getStatus', 'onState', 'onStatus']);
  assert.equal(await screen.locator('button,input,select,a,[tabindex="0"]').count(), 0, 'screen must expose no interactive controls');
  assert.equal(await screen.evaluate(() => document.querySelector('main').classList.contains('animations-paused')), false);
  assert.ok(await screen.evaluate(() => document.getAnimations().some(animation => animation.playState === 'running')), 'original animations are retained');
  await expect(screen.locator('.mascot-bubble')).not.toHaveText('');
  const firstLine = await screen.locator('.mascot-bubble').textContent();
  await expect.poll(() => screen.locator('.mascot-bubble').textContent(), {timeout: 8000}).not.toBe(firstLine);
  await capture('screen-agents');

  for (const method of ['refreshStatus', 'openProvider', 'setOrder']) {
    assert.equal(await desktop.evaluate(async name => {
      try { await window.panel[name](name === 'openProvider' ? 'codex' : name === 'setOrder' ? ['claude','codex','antigravity','deepseek','zcode','kimi','qwen','workbuddy'] : true); return false; }
      catch { return true; }
    }, method), true, `${method} must be disabled during streaming`);
  }
  const controllerBounds = (await desktop.evaluate(() => window.panel.getState())).bounds;
  const beforeRailFrames = (await desktop.evaluate(() => window.panel.getState())).stream.frames;
  await desktop.getByRole('button', { name: '收起面板', exact: true }).click();
  await expect(desktop.locator('.collapsed-rail')).toBeVisible();
  await expect(desktop.locator('.settings-dialog')).not.toBeVisible();
  assert.equal((await desktop.evaluate(() => window.panel.getState())).bounds.width, 64);
  await expect.poll(() => desktop.evaluate(() => window.panel.getState()).then(state => state.stream.frames), { timeout: 10000 }).toBeGreaterThan(beforeRailFrames + 8);
  assert.equal(await screen.evaluate(() => document.querySelector('main').classList.contains('animations-paused')), false);
  await desktop.getByRole('button', { name: '展开面板', exact: true }).click();
  await expect(desktop.locator('.settings-dialog')).toBeVisible();
  assert.deepEqual((await desktop.evaluate(() => window.panel.getState())).bounds, controllerBounds);
  for (const invalid of [{ device: 'unsupported' }, { width: 2239 }, { fps: 0 }, { bitrateMbps: 51 }, { enabled: true }, { showMascot: 'yes' }]) {
    assert.equal(await desktop.evaluate(async value => { try { await window.panel.setStreamConfig(value); return false; } catch { return true; } }, invalid), true);
  }

  const firstFrames = (await desktop.evaluate(() => window.panel.getState())).stream.frames;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('surface=screen')).minimize());
  await expect.poll(() => desktop.evaluate(() => window.panel.getState()).then(state => state.stream.frames), { timeout: 10000 }).toBeGreaterThan(firstFrames + 8);
  await desktop.evaluate(() => window.panel.store());
  const storedFrames = (await desktop.evaluate(() => window.panel.getState())).stream.frames;
  await expect.poll(() => desktop.evaluate(() => window.panel.getState()).then(state => state.stream.frames), { timeout: 10000 }).toBeGreaterThan(storedFrames + 8);
  assert.equal(await screen.evaluate(() => document.querySelector('main').classList.contains('animations-paused')), false);
  const hiddenLine = await screen.locator('.mascot-bubble').textContent();
  await expect.poll(() => screen.locator('.mascot-bubble').textContent(), {timeout: 8000}).not.toBe(hiddenLine);
  await app.evaluate(({ app }) => app.emit('activate'));

  const original = await desktop.evaluate(() => window.panel.getStatus());
  const attention = structuredClone(original);
  Object.assign(attention.codex, { activity: 'waiting', waitingTasks: 1, waitingReason: 'approval' });
  Object.assign(attention.claude, { activity: 'waiting', waitingTasks: 1, waitingReason: 'input' });
  await inject(attention);
  await expect(screen.locator('.screen-attention')).toHaveCount(1);
  await expect(screen.locator('main')).toHaveAttribute('data-attention-count', '2');
  const bounds = await screen.locator('.screen-attention').evaluate(el => {
    const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  assert.equal(bounds.x, 0); assert.equal(bounds.y, 0);
  assert.equal(bounds.width, bounds.viewportWidth); assert.equal(bounds.height, bounds.viewportHeight);
  const firstAgent = await screen.locator('.screen-attention').getAttribute('data-provider');
  await expect.poll(() => screen.locator('.screen-attention').getAttribute('data-provider'), { timeout: 9000 }).not.toBe(firstAgent);
  await capture('screen-attention');
  await inject(original);
  await expect(screen.locator('.screen-attention')).toHaveCount(0);
  await app.evaluate(() => global.screenQaRestore?.());

  await desktop.evaluate(() => window.panel.setStreamConfig({ width: 1120, height: 540, pageSeconds: 4, showMascot: false }));
  screen = await outputWindow();
  assert.deepEqual(await screen.evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 1120, height: 540 });
  await expect(screen.locator('.screen-mascot')).toHaveCount(0);
  await expect(screen.locator('main')).toHaveAttribute('data-page', '1');
  await expect(screen.locator('main')).toHaveAttribute('data-page', '2', { timeout: 7000 });
  const overflow = await screen.evaluate(() => ({ body: document.body.scrollWidth > innerWidth, cards: [...document.querySelectorAll('.provider-card')].some(el => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1; }) }));
  assert.deepEqual(overflow, { body: false, cards: false });
  await capture('screen-compact');

  await app.close(); app = null;
  const saved = JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8'));
  assert.equal(saved.stream.enabled, true);
  app = await launch(); desktop = await app.firstWindow();
  await expect(desktop.locator('main')).toHaveAttribute('data-surface', 'controller');
  await expect.poll(() => desktop.evaluate(() => window.panel.getState()).then(state => state.stream.status), { timeout: 15000 }).toBe('running');
  await desktop.evaluate(() => window.panel.stopStream());
  await expect(desktop.locator('main')).toHaveAttribute('data-surface', 'desktop');
  assert.equal(app.windows().filter(page => page.url().includes('surface=screen')).length, 0);
  await expect(desktop.locator('.provider-card')).toHaveCount(8);
  assert.equal((await desktop.evaluate(() => window.panel.getState())).stream.enabled, false);
  assert.deepEqual(errors, []);
  console.log('Screen stream QA passed: settings desktop collapses to side rail and restores; separate read-only offscreen renderer; animation and frames while collapsed/minimized/stored; disabled interactions; bounded settings; fullscreen multi-agent waiting and automatic clearing; paging; layout; persisted restart; stop restores desktop. USB was not opened.');
} finally {
  if (app) await app.close().catch(() => {});
  // This folder was created by mkdtemp above, exclusively for this QA run.
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(profile, { recursive: true, force: true });
}
