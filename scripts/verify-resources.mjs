import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-resources-'));
const linkedProfile = `${profile}-link`;
const cpuEnabled = process.argv.includes('--cpu');
const metrics = [];
const processAudits = [];
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
  locked: false, animate: true, theme: 'dark', language: 'zh-CN', claudeSource: 'desktop',
  providerOrder: ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'],
  enabledProviders: ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'],
}));
const launch = (selectedProfile = profile) => electron.launch({
  args: [path.resolve('tests/fixtures/tray-main.cjs')],
  env: { ...process.env, AI_WATCH_TEST_PROFILE: selectedProfile, AI_WATCH_TEST_STATUS: 'glow-running' },
});
let app;
const errors = [];
const setupPage = async () => {
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.dataset.sampledAt));
  assert.equal((await page.evaluate(() => window.panel.getStatus())).isTestData, true);
  return page;
};
const processIds = async () => {
  const children = await app.evaluate(({ app, BrowserWindow }) => ({
    renderer: BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId(),
    all: app.getAppMetrics().map(item => item.pid),
  }));
  return { renderer: children.renderer, all: [...new Set([app.process().pid, children.renderer, ...children.all].filter(Boolean))] };
};
const remainingProcesses = async ids => {
  try {
    const { stdout } = await execute('ps', ['-p', ids.join(','), '-o', 'pid='], { timeout: 2000 });
    return stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim()) return [];
    throw error;
  }
};
const closeAndVerify = async () => {
  const audit = await processIds();
  await app.close(); app = null;
  await expect.poll(() => remainingProcesses(audit.all), { timeout: 10000 }).toEqual([]);
  processAudits.push({ rendererRecordedBeforeExit: Boolean(audit.renderer), processesBeforeExit: audit.all.length, remaining: 0 });
};
const sampleCpu = async mode => {
  if (!cpuEnabled) return;
  await app.evaluate(({ app }) => app.getAppMetrics());
  const started = performance.now();
  await new Promise(resolve => setTimeout(resolve, 8000));
  const rows = await app.evaluate(({ app }) => app.getAppMetrics().map(item => ({
    type: item.type, cpuPercent: item.cpu.percentCPUUsage,
    workingSetMiB: Math.round(item.memory.workingSetSize / 1024 * 10) / 10,
  })));
  metrics.push({ mode, sampleMs: Math.round(performance.now() - started),
    totalCpuPercent: Math.round(rows.reduce((total, item) => total + item.cpuPercent, 0) * 100) / 100, processes: rows });
};
const pseudoAnimation = locator => locator.evaluate(element => {
  const style = getComputedStyle(element, '::before');
  return { name: style.animationName, state: style.animationPlayState, duration: style.animationDuration };
});

try {
  app = await launch(); let page = await setupPage();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 50, width: 200, height: 900 }));
  await page.waitForFunction(() => innerWidth === 200 && innerHeight === 900);
  const claude = page.locator('.provider-card[data-provider="claude"]');
  const avatar = claude.locator('.avatar');
  await expect(claude).toHaveAttribute('data-animation-paused', 'false');
  await expect(avatar).toHaveAttribute('data-glow', 'running');
  await expect.poll(() => pseudoAnimation(avatar)).toEqual({ name: 'logo-breathe', state: 'running', duration: '5s' });

  const rainbow = page.locator('.provider-card[data-provider="antigravity"] .avatar-halo > span');
  await expect(rainbow).toHaveCount(1);
  await expect.poll(() => pseudoAnimation(rainbow)).toEqual({ name: 'halo-spectrum', state: 'running', duration: '10s' });
  const spectrum = await rainbow.evaluate(element => {
    const style = getComputedStyle(element, '::before');
    const frames = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules])
      .find(rule => rule instanceof CSSKeyframesRule && rule.name === 'halo-spectrum');
    return { background: style.backgroundImage, willChange: style.willChange,
      declarations: frames ? [...frames.cssRules].flatMap(rule => [...rule.style]) : [] };
  });
  assert.match(spectrum.background, /conic-gradient/);
  assert.equal(spectrum.willChange, 'transform');
  assert.deepEqual(spectrum.declarations, ['transform']);
  await sampleCpu('single-visible');

  await page.locator('.provider-viewport').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(claude).toHaveAttribute('data-animation-paused', 'true');
  await expect(avatar).toHaveAttribute('data-glow', 'running');
  await expect.poll(() => pseudoAnimation(avatar)).toEqual({ name: 'logo-breathe', state: 'paused', duration: '5s' });
  await expect.poll(() => claude.locator('.status-dot.active').evaluate(element => getComputedStyle(element).animationPlayState)).toBe('paused');
  await expect.poll(() => pseudoAnimation(rainbow)).toEqual({ name: 'halo-spectrum', state: 'paused', duration: '10s' });
  const hiddenLight = page.locator('.hidden-activity-light[data-provider="claude"]');
  await expect(hiddenLight).toHaveAttribute('data-glow', 'running');
  await expect.poll(() => pseudoAnimation(hiddenLight)).toEqual({ name: 'logo-breathe', state: 'running', duration: '5s' });
  await sampleCpu('single-scrolled');
  await page.locator('.provider-viewport').evaluate(element => { element.scrollTop = 0; });
  await expect(claude).toHaveAttribute('data-animation-paused', 'false');
  await expect.poll(() => pseudoAnimation(avatar)).toEqual({ name: 'logo-breathe', state: 'running', duration: '5s' });

  await page.evaluate(() => window.panel.store());
  await expect.poll(() => page.evaluate(() => window.panel.getState()).then(value => value.stored)).toBe(true);
  await expect(page.locator('main')).toHaveClass(/animations-paused/);
  const pausedAnimations = await page.locator('main').evaluate(main => {
    const rows = [];
    for (const element of main.querySelectorAll('*')) for (const pseudo of [null, '::before', '::after']) {
      const style = getComputedStyle(element, pseudo);
      if (style.animationName !== 'none') rows.push(style.animationPlayState.split(',').every(state => state.trim() === 'paused'));
    }
    return rows;
  });
  assert.ok(pausedAnimations.length > 8); assert.ok(pausedAnimations.every(Boolean));
  await sampleCpu('stored');
  await app.evaluate(({ app }) => app.emit('activate'));
  await expect.poll(() => page.evaluate(() => window.panel.getState()).then(value => value.stored)).toBe(false);
  await expect(page.locator('main')).not.toHaveClass(/animations-paused/);
  await expect.poll(() => pseudoAnimation(avatar)).toEqual({ name: 'logo-breathe', state: 'running', duration: '5s' });

  // Replace the real request with a failing sentinel in this isolated fixture.
  // The fixture handler must bypass it even when its UI control is clicked.
  await app.evaluate((_electron, filename) => {
    const { ClaudeStatusReader } = process.mainModule.require(filename);
    global.aiWatchResourceAxRequests = 0;
    ClaudeStatusReader.prototype.requestActivityAccess = async () => {
      global.aiWatchResourceAxRequests++; throw new Error('Fixture attempted a real activity request');
    };
  }, path.resolve('electron/claude-status.cjs'));
  await page.getByRole('button', { name: '打开配置', exact: true }).click();
  await expect.poll(() => pseudoAnimation(avatar)).toEqual({ name: 'logo-breathe', state: 'paused', duration: '5s' });
  const source = page.locator('.segmented[aria-label="Claude 数据来源"]');
  await expect(source.getByRole('button', { name: 'Claude Desktop', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '识别桌面活动（辅助功能）', exact: true }).click();
  assert.equal(await app.evaluate(() => global.aiWatchResourceAxRequests), 0);
  await source.getByRole('button', { name: 'Claude Code', exact: true }).click();
  await expect(source.getByRole('button', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(claude.locator('h2')).toHaveText('Claude Code');
  await source.getByRole('button', { name: 'Claude Desktop', exact: true }).click();
  await expect(claude.locator('h2')).toHaveText('Claude');
  await source.getByRole('button', { name: 'Claude Code', exact: true }).click();
  await expect(source.getByRole('button', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const invalid of ['auto', 'Desktop', null, {}, ['code']]) {
    assert.equal(await page.evaluate(async value => {
      try { await window.panel.setClaudeSource(value); return false; } catch { return true; }
    }, invalid), true);
  }
  assert.equal((await page.evaluate(() => window.panel.getState())).claudeSource, 'code');
  await page.evaluate(() => localStorage.setItem('AI_WATCH_CACHE_KEEP', 'KEEP'));
  await writeFile(path.join(profile, 'claude-desktop-plan.json'), 'KEEP');
  await page.getByRole('button', { name: '清理缓存', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('已清理缓存');
  assert.equal(await page.evaluate(() => localStorage.getItem('AI_WATCH_CACHE_KEEP')), 'KEEP');
  assert.equal(await readFile(path.join(profile, 'claude-desktop-plan.json'), 'utf8'), 'KEEP');
  assert.equal(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).cacheCleanupPending, true);
  const deferredCache = path.join(profile, 'GPUCache', 'AI_WATCH_TEST_CACHE_SENTINEL');
  await mkdir(path.dirname(deferredCache), { recursive: true }); await writeFile(deferredCache, 'CACHE');
  await page.locator('.settings-heading button').click();
  await expect.poll(() => pseudoAnimation(avatar)).toEqual({ name: 'logo-breathe', state: 'running', duration: '5s' });
  assert.equal(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).claudeSource, 'code');

  if (cpuEnabled) {
    await page.evaluate(() => window.panel.setLayout('double'));
    await expect(page.locator('main')).toHaveAttribute('data-layout', 'double');
    await sampleCpu('double-visible');
    await page.evaluate(() => window.panel.setLayout('fullscreen'));
    await expect(page.locator('main')).toHaveAttribute('data-layout', 'fullscreen');
    await sampleCpu('fullscreen-visible');
    await page.evaluate(() => window.panel.setLayout('single'));
  }
  await closeAndVerify();
  app = await launch(); page = await setupPage();
  await assert.rejects(stat(deferredCache), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).cacheCleanupPending, false);
  assert.equal(await page.evaluate(() => localStorage.getItem('AI_WATCH_CACHE_KEEP')), 'KEEP');
  assert.equal(await readFile(path.join(profile, 'claude-desktop-plan.json'), 'utf8'), 'KEEP');
  await expect(page.locator('.provider-card[data-provider="claude"] h2')).toHaveText('Claude Code');
  assert.equal((await page.evaluate(() => window.panel.getState())).claudeSource, 'code');
  await page.getByRole('button', { name: '打开配置', exact: true }).click();
  await expect(page.locator('.segmented[aria-label="Claude 数据来源"]').getByRole('button', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await closeAndVerify();

  // A protected root must still be refused by disk cleanup, without preventing
  // the application from opening or rewriting the user's saved preferences.
  const protectedCache = path.join(profile, 'GPUCache', 'AI_WATCH_PROTECTED_CACHE_SENTINEL');
  await mkdir(path.dirname(protectedCache), { recursive: true }); await writeFile(protectedCache, 'KEEP');
  const rejectedPreferences = { ...JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')), cacheCleanupPending: true };
  const savedPreferences = JSON.stringify(rejectedPreferences);
  await writeFile(path.join(profile, 'preferences.json'), savedPreferences);
  await symlink(profile, linkedProfile, process.platform === 'win32' ? 'junction' : 'dir');
  app = await launch(linkedProfile); page = await setupPage();
  await expect(page.locator('.provider-card[data-provider="claude"] h2')).toHaveText('Claude Code');
  const preservedState = await page.evaluate(() => window.panel.getState());
  assert.equal(preservedState.claudeSource, 'code'); assert.equal(preservedState.theme, 'dark');
  assert.equal(preservedState.cacheCleanupPending, undefined);
  assert.equal(await readFile(path.join(profile, 'preferences.json'), 'utf8'), savedPreferences);
  assert.equal(await readFile(protectedCache, 'utf8'), 'KEEP');
  assert.equal(await page.evaluate(() => localStorage.getItem('AI_WATCH_CACHE_KEEP')), 'KEEP');
  assert.equal(await readFile(path.join(profile, 'claude-desktop-plan.json'), 'utf8'), 'KEEP');
  await closeAndVerify();
  assert.deepEqual(errors, []);
  await mkdir('.local/qa/resources', { recursive: true });
  await writeFile('.local/qa/resources/report.json', JSON.stringify({
    syntheticFixture: true, checks: ['visible breathing', 'offscreen pause with active indication', 'scroll resume',
      'compositor spectrum transform', 'stored pause', 'restore resume', 'Claude source UI and invalid IPC',
      'fixture activity access bypass', 'source persistence', 'cache button preserves settings/storage/plan', 'deferred disk cache cleanup',
      'rejected cache root preserves startup/settings/storage/plan', 'main and helper exit'],
    processAudits, metrics,
  }, null, 2));
  console.log('Resource checks passed: visible/offscreen/hidden animation states, running hidden activity indicator, transform spectrum, Claude source controls, invalid IPC, fixture access isolation, restart persistence, safe startup after rejected cache root and no remaining main/renderer/helpers after all exits.');
  if (cpuEnabled) console.log(JSON.stringify({ syntheticFixture: true, metrics }, null, 2));
} finally {
  if (app) await closeAndVerify();
  await rm(linkedProfile, { force: true });
  await rm(profile, { recursive: true, force: true });
}
