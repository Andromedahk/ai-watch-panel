import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Pass the packaged binary (macOS Contents/MacOS/AI Watch or Windows AI Watch.exe).
assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-release.mjs <packaged-executable>');
const executablePath = path.resolve(process.argv[2]);
assert.ok((await stat(executablePath)).isFile(), 'The packaged executable must be a file');
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const providers = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-release-'));
const env = { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' };
delete env.AI_WATCH_DEV_URL;
delete env.AI_WATCH_TEST_WIDGETS;
delete env.ELECTRON_RUN_AS_NODE;
let application;

try {
  await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
    language: 'zh-CN', skin: 'watch', theme: 'light', layout: 'single',
    animate: false, animeMode: false, providerOrder: providers, enabledProviders: providers,
    claudeHooksEnabled: false, claudeNetworkAllowed: false, qwenKeychainAllowed: false,
    widgetsEnabled: false,
  }));
  application = await electron.launch({ executablePath, env, timeout: 30000 });
  const rendererErrors = [];
  const trackedPages = new WeakSet();
  const trackPage = page => {
    if (trackedPages.has(page)) return;
    trackedPages.add(page);
    page.on('pageerror', error => rendererErrors.push(error.message));
    page.on('crash', () => rendererErrors.push('Renderer crashed'));
    page.on('console', message => {
      if (message.type() === 'error') rendererErrors.push(message.text());
    });
  };
  application.on('window', trackPage);
  const page = await application.firstWindow();
  trackPage(page);

  // Reload once with error listeners already installed to cover renderer bootstrap.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'AI WATCH', exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('main.panel')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.panel.getStatus()).then(status => status.isTestData), {
    timeout: 15000, message: 'The packaged application must load the synthetic fixture',
  }).toBe(true);
  await expect(page.locator('main.panel')).toHaveAttribute('data-sampled-at', /\S/);
  await expect(page.locator('.provider-card')).toHaveCount(providers.length);
  await expect(page.locator('.demo-tag')).toHaveText('测试');
  assert.deepEqual(await page.locator('.provider-card').evaluateAll(cards => cards.map(card => card.dataset.provider)), providers);
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    return windows.length === 1 && windows[0].isVisible() && !windows[0].isMinimized();
  }), { timeout: 10000, message: 'The packaged panel window must be visible' }).toBe(true);

  const native = await application.evaluate(({ app, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const preferences = win.webContents.getLastWebPreferences();
    return {
      packaged: app.isPackaged, version: app.getVersion(), profile: app.getPath('userData'),
      platform: process.platform, architecture: process.arch, url: win.webContents.getURL(),
      visible: win.isVisible(), sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration,
    };
  });
  assert.equal(native.packaged, true);
  assert.equal(native.version, version);
  assert.equal(native.platform, process.platform);
  assert.equal(native.architecture, process.arch);
  assert.equal(path.resolve(native.profile), path.resolve(profile));
  assert.equal(native.visible, true);
  assert.equal(native.sandbox, true);
  assert.equal(native.contextIsolation, true);
  assert.equal(native.nodeIntegration, false);
  assert.match(native.url, /^file:\/\/.*\/dist\/index\.html$/);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');

  await expect.poll(() => page.locator('.provider-card .avatar img').evaluateAll(images =>
    images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0)), {
    timeout: 10000, message: 'Bundled provider images must load',
  }).toBe(true);
  assert.deepEqual(rendererErrors, [], 'The packaged renderer must have no errors');
  console.log(JSON.stringify({
    result: 'passed', version: native.version, platform: native.platform, architecture: native.architecture,
    packaged: native.packaged, data: 'synthetic fixture', isolatedProfile: true,
    visibleWindow: native.visible, providerCards: providers.length, bundledImages: 'loaded',
    sandbox: native.sandbox, contextIsolation: native.contextIsolation,
    nodeIntegration: native.nodeIntegration, rendererErrors: rendererErrors.length,
  }, null, 2));
} finally {
  try {
    if (application) await application.close();
  } finally {
    // Windows can retain short-lived file handles while Chromium processes exit.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
