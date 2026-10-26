import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Actual Electron BGRA paint -> packaged Python helper -> FFmpeg H.264. The
// fixture entry point appends --dry-run before spawning, so USB is never opened.
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-screen-encoder-'));
const output = path.resolve('.local/qa/screen-encoder');
const env = { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'glow-running' };
delete env.AI_WATCH_STREAM_PREVIEW;
delete env.XANALI_PYTHON;
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
  locked: false, animate: true, theme: 'dark', language: 'zh-CN', animeMode: true, mascotInterval: 5,
}));
const errors = [];
let app;
try {
  await mkdir(output, { recursive: true });
  app = await electron.launch({ args: [path.resolve('tests/fixtures/screen-encoder-main.cjs')], env });
  app.on('window', page => page.on('pageerror', error => errors.push(error.message)));
  const desktop = await app.firstWindow();
  desktop.on('pageerror', error => errors.push(error.message));
  await expect(desktop.locator('.provider-card')).toHaveCount(8);
  const initial = await desktop.evaluate(() => window.panel.getState());
  assert.equal(initial.stream.available, true);
  assert.equal(initial.stream.preview, false);
  await desktop.getByRole('button', { name: '打开配置', exact: true }).click();
  await desktop.getByRole('button', { name: '开启小屏幕串流', exact: true }).click();
  await expect.poll(() => desktop.evaluate(() => window.panel.getState()).then(state => state.stream.status), { timeout: 15000 }).toBe('running');
  await expect(desktop.locator('main')).toHaveAttribute('data-surface', 'controller');
  await expect.poll(() => app.evaluate(() => global.aiWatchEncoderQA.calls[0]?.events.some(event => event.type === 'stats' && event.data.elapsed >= 5 && event.data.frames > 0 && event.data.bytes > 0)), { timeout: 12000 }).toBe(true);
  const running = await desktop.evaluate(() => window.panel.getState());
  assert.equal(running.stream.preview, false, 'frame totals come from the real helper, not the preview pump');
  assert.ok(running.stream.frames > 0);
  const calls = await app.evaluate(() => global.aiWatchEncoderQA.calls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].basename, 'xanali-panel-bridge.exe');
  assert.equal(calls[0].args.at(-1), '--dry-run');
  const ready = calls[0].events.find(event => event.type === 'ready').data;
  assert.equal(ready.dryRun, true);
  assert.equal(ready.pixelFormat, 'bgra');
  assert.equal(ready.frameBytes, 2240 * 1080 * 4);
  const screenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()
    .find(window => window.webContents.getURL().includes('surface=screen')).webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(path.join(output, 'encoder-input.png'), Buffer.from(screenshot, 'base64'));

  // No USB takeover means the helper correctly says restored:false. Keep the
  // production recovery guard: surface its notice instead of inventing success.
  await desktop.getByRole('button', { name: '关闭串流并恢复桌面面板', exact: true }).click();
  await expect(desktop.locator('.stream-error')).toContainText('尚未确认原厂界面恢复');
  await expect.poll(() => app.evaluate(() => global.aiWatchEncoderQA.calls[0].closed)).toBe(true);
  const finished = (await app.evaluate(() => global.aiWatchEncoderQA.calls))[0];
  assert.deepEqual(finished.exit, { code: 0, signal: null });
  assert.equal(finished.stderr, '');
  assert.equal(finished.spawnError, undefined);
  assert.deepEqual(finished.events.filter(event => ['error', 'invalid-json'].includes(event.type)), []);
  const stopped = finished.events.find(event => event.type === 'stopped').data;
  assert.equal(stopped.dryRun, true);
  assert.equal(stopped.restored, false);
  assert.equal(stopped.failed, false);
  assert.ok(stopped.frames > 0);
  // Recovery warnings remain visible while the first stop restores the desktop.
  await expect(desktop.locator('main')).toHaveAttribute('data-surface', 'desktop');
  await expect(desktop.locator('.provider-card')).toHaveCount(8);
  await expect(desktop.getByRole('button', { name: '关闭串流并恢复桌面面板', exact: true })).toHaveCount(0);
  await expect(desktop.locator('.stream-error')).toContainText('尚未确认原厂界面恢复');
  const final = await desktop.evaluate(() => window.panel.getState());
  assert.equal(final.stream.enabled, false);
  assert.equal(final.stream.status, 'error');
  assert.match(final.stream.error, /尚未确认原厂界面恢复/);
  assert.equal(app.windows().filter(page => page.url().includes('surface=screen')).length, 0);
  assert.deepEqual(errors, [], 'renderer errors');
  const stats = finished.events.filter(event => event.type === 'stats').at(-1).data;
  await writeFile(path.join(output, 'encoder-report.json'), JSON.stringify({ ready, stats, stopped, exit: finished.exit, stderr: finished.stderr, deviceAccess: false }, null, 2));
  console.log(`Electron encoder chain passed: ${stats.frames} H.264 frames, ${stats.bytes} bytes from 2240×1080 BGRA; helper exit 0, no stderr, no USB. The first stop restored the desktop while preserving the truthful dry-run restoration notice.`);
} finally {
  if (app) await app.close().catch(() => {});
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(profile, { recursive: true, force: true });
}
