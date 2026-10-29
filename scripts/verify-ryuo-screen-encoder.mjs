import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, stat, symlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Reproducible source-only chain, with no permanent runtime resources installed.
// Supply absolute tool paths: --python <Python executable> --ffmpeg <FFmpeg with libx265 and MPEG-TS>.
function requiredTool(flag) {
  const index = process.argv.indexOf(flag);
  assert.ok(index >= 0 && process.argv[index + 1] && path.isAbsolute(process.argv[index + 1]), `${flag} requires an absolute executable path`);
  return process.argv[index + 1];
}
const python = requiredTool('--python');
const ffmpeg = requiredTool('--ffmpeg');
assert.ok(['win32', 'darwin'].includes(process.platform), 'Electron streaming QA requires Windows or macOS');
assert.ok((await stat(python)).isFile());
assert.ok((await stat(ffmpeg)).isFile());
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-ryuo-encoder-'));
const resources = path.join(profile, 'resources');
const encoder = path.join(resources, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const output = path.resolve('.local/qa/ryuo-encoder');
await mkdir(path.dirname(encoder), { recursive: true });
if (process.platform === 'win32') await copyFile(ffmpeg, encoder);
else await symlink(ffmpeg, encoder);
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
  locked: false, animate: true, theme: 'dark', language: 'zh-CN', animeMode: true, mascotInterval: 5,
  stream: { enabled: false, device: 'ryuo4', width: 2240, height: 1080, fps: 30, bitrateMbps: 6,
    pageSeconds: 12, showMascot: true, agentsPerPage: 4 },
}));
const env = { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'glow-running',
  XANALI_PYTHON: python, AI_WATCH_RYUO_QA_RESOURCES: resources };
delete env.AI_WATCH_STREAM_PREVIEW;
delete env.RYUO_ADB;
const errors = [];
let app;
try {
  await mkdir(output, { recursive: true });
  app = await electron.launch({ args: [path.resolve('tests/fixtures/ryuo-screen-encoder-main.cjs')], env });
  app.on('window', page => page.on('pageerror', error => errors.push(error.message)));
  const desktop = await app.firstWindow();
  desktop.on('pageerror', error => errors.push(error.message));
  await expect(desktop.locator('.provider-card')).toHaveCount(8);
  const initial = await desktop.evaluate(() => window.panel.getState());
  assert.equal(initial.stream.device, 'ryuo4');
  assert.equal(initial.stream.preview, false);
  await desktop.getByRole('button', { name: '打开配置', exact: true }).click();
  await desktop.getByRole('button', { name: '开启小屏幕串流', exact: true }).click();
  await expect.poll(() => desktop.evaluate(() => window.panel.getState()).then(state => state.stream.status), { timeout: 20000 }).toBe('running');
  await expect(desktop.locator('main')).toHaveAttribute('data-surface', 'controller');
  await expect.poll(() => app.evaluate(() => global.aiWatchRyuoEncoderQA.calls[0]?.events.some(event => event.type === 'stats' && event.data.elapsed >= 3 && event.data.frames > 0 && event.data.bytes > 0)), { timeout: 12000 }).toBe(true);
  const outputPage = app.windows().find(page => page.url().includes('surface=screen'));
  assert.ok(outputPage);
  assert.deepEqual(await outputPage.evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 2240, height: 1080 });
  const calls = await app.evaluate(() => global.aiWatchRyuoEncoderQA.calls);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('--dry-run'));
  const ready = calls[0].events.find(event => event.type === 'ready').data;
  assert.equal(ready.device, 'ryuo4');
  assert.equal(ready.codec, 'hevc');
  assert.equal(ready.container, 'mpegts');
  assert.equal(ready.dryRun, true);
  assert.equal(ready.pixelFormat, 'bgra');
  assert.equal(ready.frameBytes, 2240 * 1080 * 4);
  assert.equal(ready.frameMetric, 'submitted');
  const screenshot = await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=screen')).webContents;
    const image = await contents.capturePage();
    return { size: image.getSize(), png: image.toPNG().toString('base64') };
  });
  assert.deepEqual(screenshot.size, { width: 2240, height: 1080 });
  await writeFile(path.join(output, 'encoder-input.png'), Buffer.from(screenshot.png, 'base64'));
  const staticStart = await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=screen')).webContents.stopPainting();
    return global.aiWatchRyuoEncoderQA.calls[0].events.filter(event => event.type === 'stats').at(-1).data;
  });
  await expect.poll(() => app.evaluate((_electron, { elapsed, frames, bytes }) => {
    const latest = global.aiWatchRyuoEncoderQA.calls[0].events.filter(event => event.type === 'stats').at(-1)?.data;
    return latest && latest.elapsed >= elapsed + 2 && latest.frames > frames + 10 && latest.bytes > bytes;
  }, staticStart), { timeout: 7000 }).toBe(true);
  await desktop.getByRole('button', { name: '关闭串流并恢复桌面面板', exact: true }).click();
  await expect.poll(() => app.evaluate(() => global.aiWatchRyuoEncoderQA.calls[0].closed), { timeout: 15000 }).toBe(true);
  const finished = (await app.evaluate(() => global.aiWatchRyuoEncoderQA.calls))[0];
  assert.deepEqual(finished.exit, { code: 0, signal: null });
  assert.equal(finished.stderr, '');
  assert.equal(finished.spawnError, undefined);
  assert.deepEqual(finished.events.filter(event => ['error', 'invalid-json'].includes(event.type)), []);
  const stopped = finished.events.find(event => event.type === 'stopped').data;
  assert.equal(stopped.dryRun, true);
  assert.equal(stopped.restored, false);
  assert.equal(stopped.failed, false);
  assert.equal(stopped.frameMetric, 'submitted');
  await expect(desktop.locator('main')).toHaveAttribute('data-surface', 'desktop');
  await expect(desktop.locator('.provider-card')).toHaveCount(8);
  await expect(desktop.locator('.stream-error')).toContainText('尚未确认');
  const final = await desktop.evaluate(() => window.panel.getState());
  assert.equal(final.stream.enabled, false);
  assert.equal(final.stream.status, 'error');
  assert.equal(app.windows().filter(page => page.url().includes('surface=screen')).length, 0);
  assert.deepEqual(errors, []);
  const stats = finished.events.filter(event => event.type === 'stats').at(-1).data;
  await writeFile(path.join(output, 'encoder-report.json'), JSON.stringify({
    ready, stats, stopped, exit: finished.exit, stderr: finished.stderr,
    deviceAccess: false, sourceMode: true, desktopRestored: true, staticRepeat: true,
  }, null, 2));
  console.log(`RYUO Electron source encoder passed: ${stats.frames} submitted BGRA frames, ${stats.bytes} HEVC MPEG-TS bytes; 2240×1080/30 FPS/6 Mbps, static repeat, clean EOF, restored desktop, no USB.`);
} finally {
  if (app) await app.close().catch(() => {});
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(profile, { recursive: true, force: true });
}
