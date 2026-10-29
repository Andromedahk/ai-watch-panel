import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real renderer/preload/main IPC, synthetic data and a private profile. The
// preview branch never opens HID/ADB; only the failure below is injected.
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-ryuo-brightness-'));
const output = path.resolve('.local/qa/ryuo-brightness');
await mkdir(output, { recursive: true });
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
  locked: false, animate: false, theme: 'dark', language: 'zh-CN',
}));
let app, desktop;
const errors = [], checks = [];
const launch = () => electron.launch({ args: [path.resolve('tests/fixtures/tray-main.cjs')], env: {
  ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture', AI_WATCH_STREAM_PREVIEW: '1',
} });
async function openSettings() {
  desktop = await app.firstWindow();
  desktop.on('pageerror', error => errors.push(error.message));
  await desktop.waitForFunction(() => document.querySelector('main')?.dataset.sampledAt);
  await desktop.locator('.toolbar button').last().click();
  await expect(desktop.locator('.stream-settings')).toBeVisible();
}
async function setBrightness(value) {
  await desktop.getByRole('slider', { name: '龙王屏幕亮度', exact: true }).evaluate((input, next) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(next));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await expect(desktop.locator('.stream-brightness output')).toHaveText(`${value}%`);
}
try {
  app = await launch();
  await openSettings();
  assert.equal((await desktop.evaluate(() => window.panel.getState())).ryuoBrightness, null);
  await expect(desktop.locator('.stream-brightness')).toHaveCount(0);
  await desktop.getByRole('combobox', { name: '屏幕类型', exact: true }).selectOption('ryuo4');
  const slider = desktop.getByRole('slider', { name: '龙王屏幕亮度', exact: true });
  const apply = desktop.getByRole('button', { name: '应用亮度', exact: true });
  await expect(slider).toHaveValue('85');
  await expect(slider).toHaveAttribute('min', '1');
  await expect(slider).toHaveAttribute('max', '100');
  await expect(desktop.locator('.stream-brightness-saved')).toContainText('尚未设置亮度');
  await expect(apply).toBeEnabled();
  await slider.focus(); await slider.press('Home'); await expect(slider).toHaveValue('1');
  await slider.press('End'); await expect(slider).toHaveValue('100');
  checks.push('Only RYUO shows the control; unconfigured value is labeled and keyboard bounds are 1–100.');

  await setBrightness(60);
  const initial = await desktop.evaluate(() => window.panel.getState());
  await app.evaluate(({ BrowserWindow }, state) => {
    BrowserWindow.getAllWindows().forEach(window => window.webContents.send('panel:changed', {
      ...state, stream: { ...state.stream, frames: 42, droppedFrames: 2 },
    }));
  }, initial);
  await expect(slider).toHaveValue('60');
  await expect(desktop.getByRole('combobox', { name: '屏幕类型', exact: true })).toHaveValue('ryuo4');
  checks.push('Statistics refresh preserves both the brightness edit and the selected device.');
  await apply.click();
  await expect(desktop.locator('.stream-brightness-result')).toContainText('亮度 60%，未连接设备');
  assert.equal((await desktop.evaluate(() => window.panel.getState())).stream.status, 'stopped');
  assert.equal(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).ryuoBrightness, 60);
  checks.push('Brightness applies through real preview IPC before streaming and persists independently.');

  await desktop.getByRole('combobox', { name: '每页 Agent 数量', exact: true }).selectOption('2');
  await desktop.getByRole('button', { name: '开启小屏幕串流', exact: true }).click();
  await expect.poll(() => desktop.evaluate(() => window.panel.getState()).then(state => state.stream.status)).toBe('running');
  assert.equal((await desktop.evaluate(() => window.panel.getState())).stream.agentsPerPage, 2);
  checks.push('The two-Agent page selection is saved when streaming starts.');
  const screenId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .find(window => window.webContents.getURL().includes('surface=screen')).id);
  await app.evaluate(({ ipcMain }) => {
    // Retain the real handler in this isolated pinned-Electron fixture so retry
    // still exercises validation, the preview branch and preference persistence.
    const original = ipcMain._invokeHandlers.get('panel:ryuo-brightness');
    if (typeof original !== 'function') throw new Error('Missing brightness IPC handler');
    global.ryuoBrightnessQa = { attempts: [], fail: true };
    ipcMain.removeHandler('panel:ryuo-brightness');
    ipcMain.handle('panel:ryuo-brightness', (event, value) => {
      global.ryuoBrightnessQa.attempts.push(value);
      if (global.ryuoBrightnessQa.fail) {
        global.ryuoBrightnessQa.fail = false;
        return Promise.reject(new Error('HID disconnected · QA'));
      }
      return original(event, value);
    });
  });
  await setBrightness(50);
  await apply.click();
  await expect(desktop.locator('.stream-brightness [role="alert"]')).toContainText('HID disconnected · QA');
  await expect(apply).toBeEnabled();
  assert.equal((await desktop.evaluate(() => window.panel.getState())).ryuoBrightness, 60);
  await apply.click();
  await expect(desktop.locator('.stream-brightness-result')).toContainText('亮度 50%，未连接设备');
  await expect(desktop.locator('.stream-brightness [role="alert"]')).toHaveCount(0);
  assert.deepEqual(await app.evaluate(() => global.ryuoBrightnessQa.attempts), [50, 50]);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .find(window => window.webContents.getURL().includes('surface=screen')).id), screenId);
  assert.equal((await desktop.evaluate(() => window.panel.getState())).stream.status, 'running');
  checks.push('Failed writes keep the previous saved value; retry succeeds without recreating the stream window.');
  const holding = await desktop.evaluate(() => window.panel.getState());
  assert.equal(holding.stream.ryuoBrightnessStatus, 'holding');
  await app.evaluate(({ BrowserWindow }, state) => {
    BrowserWindow.getAllWindows().filter(window => !window.webContents.getURL().includes('surface=screen'))
      .forEach(window => window.webContents.send('panel:changed', { ...state, stream: {
        ...state.stream, ryuoBrightnessStatus: 'error', ryuoBrightnessError: '亮度保活已中断 · QA',
      } }));
  }, holding);
  await expect(desktop.locator('.stream-brightness [role="alert"]')).toContainText('亮度保活已中断 · QA');
  await expect(desktop.locator('.stream-brightness-result')).toHaveCount(0);
  await apply.click();
  await expect(desktop.locator('.stream-brightness-result')).toContainText('亮度 50%，未连接设备');
  await expect(desktop.locator('.stream-brightness [role="alert"]')).toHaveCount(0);
  checks.push('A failed background hold clears stale success and can be reapplied without stopping video.');
  await desktop.screenshot({ path: path.join(output, 'brightness-settings.png') });
  await desktop.getByRole('combobox', { name: '屏幕类型', exact: true }).selectOption('zhanyu');
  await expect(desktop.locator('.stream-brightness')).toHaveCount(0);
  await desktop.getByRole('combobox', { name: '屏幕类型', exact: true }).selectOption('ryuo4');
  await expect(slider).toHaveValue('50');
  checks.push('Changing device hides the controls and preserves the last setting.');
  await desktop.getByRole('button', { name: '关闭串流并恢复桌面面板', exact: true }).click();
  await expect.poll(() => desktop.evaluate(() => window.panel.getState()).then(state => state.stream.status)).toBe('stopped');
  assert.equal((await desktop.evaluate(() => window.panel.getState())).stream.ryuoBrightnessStatus, 'inactive');
  await app.close(); app = null;
  await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
    ...JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')),
    stream: { ...initial.stream, enabled: false, device: 'ryuo4' },
  }));
  app = await launch();
  await openSettings();
  await expect(desktop.getByRole('slider', { name: '龙王屏幕亮度', exact: true })).toHaveValue('50');
  await expect(desktop.locator('.stream-brightness-saved')).toContainText('上次设置：50%');
  checks.push('A new app process displays the saved value as the last setting, not a device readback.');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, rendererErrors: errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, rendererErrors: errors.length, output }));
} finally {
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true });
}
