import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Isolated profiles and synthetic fixtures only. No real account or application is accessed.
const output = process.env.AI_WATCH_INSIGHTS_OUTPUT || '.local/qa/insights';
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-insights-'));
const errors = [];
let app, page;
const settings = () => page.getByRole('button', { name: '打开配置', exact: true }).click();
const closeSettings = () => page.getByRole('button', { name: '关闭配置', exact: true }).click();
const shown = () => page.locator('.insight').evaluateAll(items => items.map(item => item.dataset.insight));
async function launch(prefs, height = 1000) {
  await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ locked: false, animate: true, language: 'zh-CN', theme: 'dark', ...prefs }));
  app = await electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 420, height });
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.dataset.sampledAt));
}
async function geometry(label) {
  const row = await page.evaluate(() => {
    const list = document.querySelector('.provider-viewport'), area = document.querySelector('.insights');
    const cards = [...list.querySelectorAll(':scope > .provider-card')].map(card => card.getBoundingClientRect());
    const box = list.getBoundingClientRect(), panels = area ? [...area.children].map(item => item.getBoundingClientRect()) : [];
    return { scrolls: list.scrollHeight > list.clientHeight + 1, cardsInside: cards.every(card => card.bottom <= box.bottom + 1 && card.top >= box.top - 1),
      below: !area || area.getBoundingClientRect().top >= box.bottom - .5, inWindow: !area || area.getBoundingClientRect().bottom <= innerHeight,
      panelsInside: !area || panels.every(panel => panel.bottom <= area.getBoundingClientRect().bottom + 1 && panel.height > 40) };
  });
  assert.deepEqual(row, { scrolls: false, cardsInside: true, below: true, inWindow: true, panelsInside: true }, label);
}
async function setTest(id, activity) {
  const names = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
  await settings();
  await page.locator('.settings-nav').getByRole('button', { name: '模块', exact: true }).click();
  const box = page.getByRole('checkbox', { name: '测试模式', exact: true });
  if (!(await box.isChecked())) await box.check();
  if (id) await page.getByRole('combobox', { name: `${names[id]} 测试任务状态`, exact: true }).selectOption(activity);
  await closeSettings();
}
try {
  await mkdir(output, { recursive: true });
  // Two modules leave room: every enabled panel except the anime-only mascot appears under the cards.
  await launch({ skin: 'watch', animeMode: false, enabledProviders: ['claude', 'codex'] });
  await expect.poll(shown).toEqual(['resets', 'trend', 'timeline']);
  await geometry('watch/two modules');
  assert.equal(await page.locator('.insight-timeline .insight-empty').count(), 1, 'a static live fixture has no state changes yet');
  // Eight modules fill the window: nothing is squeezed in.
  await page.evaluate(() => window.panel.setEnabled(['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy']));
  await expect(page.locator('.insights')).toHaveCount(0);
  await page.evaluate(() => window.panel.setEnabled(['claude', 'codex']));
  await expect.poll(shown).toEqual(['resets', 'trend', 'timeline']);
  // A shorter window drops panels in priority order (trend first, then resets) and keeps the cards whole.
  await page.setViewportSize({ width: 420, height: 720 });
  await expect.poll(async () => (await shown()).length).toBeLessThan(3);
  assert.ok((await shown()).every(id => ['timeline', 'resets'].includes(id)));
  await geometry('watch/short window');
  await page.setViewportSize({ width: 420, height: 1000 });

  // Settings switch panels on and off and persist them; malformed IPC values are refused.
  await settings();
  await page.getByRole('checkbox', { name: '额度趋势', exact: true }).uncheck();
  await closeSettings();
  await expect.poll(shown).toEqual(['resets', 'timeline']);
  assert.equal(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).insights.trend, false);
  for (const value of [null, { timeline: true }, { timeline: 'yes', resets: true, trend: true, mascot: true }, { timeline: true, resets: true, trend: true, mascot: true, x: true }]) {
    assert.equal(await page.evaluate(async value => { try { await window.panel.setInsights(value); return false; } catch { return true; } }, value), true);
  }
  await page.evaluate(() => window.panel.setInsights({ timeline: true, resets: true, trend: true, mascot: true }));

  // Test mode: sample history fills the timeline and trend; new waiting states go to the top of the timeline.
  await setTest('claude', 'approval');
  await expect.poll(shown).toEqual(['resets', 'trend', 'timeline']);
  await expect(page.locator('.insight-timeline li').first()).toHaveAttribute('data-kind', 'waiting');
  await expect(page.locator('.insight-timeline li').first().locator('.insight-name')).toHaveText('Claude');
  await expect(page.locator('.insight-timeline li').first().locator('.insight-what')).toHaveText('等你授权');
  assert.ok(await page.locator('.insight-trend li').count() >= 2);
  assert.ok(await page.locator('.insight-resets li').count() >= 1);
  await expect(page.locator('.insight-resets li').first().locator('.insight-when')).toHaveText(/小时|分钟/);
  await page.screenshot({ path: `${output}/watch-test.png` });

  // The mascot only appears in anime mode and speaks for whoever needs you.
  for (const skin of ['watch', 'dial', 'party']) {
    await page.evaluate(async skin => { await window.panel.setSkin(skin); await window.panel.setAnimeMode(true); }, skin);
    await expect.poll(shown).toContain('mascot');
    await expect(page.locator('.insight-mascot')).toHaveAttribute('data-mood', 'alert');
    await expect(page.locator('.mascot-bubble')).toHaveText('Claude 在等你授权哦');
    await geometry(`${skin}/anime`);
    await page.screenshot({ path: `${output}/${skin}-anime.png` });
  }
  await setTest('claude', 'running');
  await expect(page.locator('.insight-mascot')).toHaveAttribute('data-mood', 'busy');
  await page.evaluate(() => window.panel.setAnimeMode(false));
  await expect.poll(shown).not.toContain('mascot');

  // Wide layouts put the panels side by side.
  await page.evaluate(() => window.panel.setLayout('double'));
  await page.setViewportSize({ width: 900, height: 1000 });
  await expect(page.locator('.insights')).toHaveClass(/is-wide/);
  await geometry('double');
  await page.evaluate(() => window.panel.setLayout('single'));

  // The live journal keeps no task text; test-mode history never reaches storage.
  await setTest(null);
  await settings(); await page.locator('.settings-nav').getByRole('button', { name: '模块', exact: true }).click();
  await page.getByRole('checkbox', { name: '测试模式', exact: true }).uncheck(); await closeSettings();
  await page.waitForTimeout(2500);
  const stored = await page.evaluate(() => localStorage.getItem('ai-watch:journal') || '');
  assert.doesNotMatch(stored, /合成|测试|task|title|prompt/i);
  assert.deepEqual(errors, []);
  console.log('Insights acceptance passed: space-only rendering, priority drop, settings persistence and IPC validation, test-mode timeline / resets / trend, anime-only mascot moods in three skins, wide layout and private journal. Synthetic data only.');
} finally {
  await app?.close(); await rm(profile, { recursive: true, force: true });
}
