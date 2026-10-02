import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-qa-'));
const live = process.env.AI_WATCH_LIVE_QA === '1';
const variant = process.env.AI_WATCH_TEST_STATUS || 'fixture';
const glow = !live && variant.startsWith('glow-');
const app = await electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: live ? '' : variant } });
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: 'AI WATCH', exact: true }).waitFor();
  // Wait on committed DOM state; an asynchronous predicate can resolve before rendering.
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.getAttribute('data-sampled-at')));
  const expected = await page.evaluate(() => window.panel.getStatus());
  await page.waitForFunction((snapshot) => {
    const cards = document.querySelectorAll('.provider-card');
    const quotasReady = ['claude', 'codex', 'antigravity'].every((id, index) => {
      const card = cards[index];
      return card?.querySelector('.task-line > span:nth-child(2)')?.textContent === snapshot[id].task
        && card.querySelectorAll('.quota').length === (id === 'claude' && !snapshot[id].quotas.length ? 0 : Math.max(1, Math.min(3, snapshot[id].quotas.length)));
    });
    const balanceReady = cards[3]?.querySelector('.balance-content')
      && cards[3].querySelector('.task-line > span:nth-child(2)')?.textContent === snapshot.deepseek.task;
    return quotasReady && balanceReady && (snapshot.deepseek.balance?.wallets.length
      ? cards[3].querySelector('.balance-total')?.getAttribute('title') === `${snapshot.deepseek.balance.wallets[0].currency} ${snapshot.deepseek.balance.wallets[0].total}`
      : Boolean(cards[3].querySelector('.balance-empty')));
  }, expected);
  const native = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const display = screen.getDisplayMatching(win.getBounds());
    return { bounds: win.getBounds(), workArea: display.workArea, scaleFactor: display.scaleFactor,
      resizable: win.isResizable(), nodeIntegration: win.webContents.getLastWebPreferences().nodeIntegration,
      contextIsolation: win.webContents.getLastWebPreferences().contextIsolation,
      sandbox: win.webContents.getLastWebPreferences().sandbox };
  });
  assert.equal(native.bounds.height, native.workArea.height);
  assert.ok(Math.abs(native.bounds.width * 4.5 - native.bounds.height) <= 2.25);
  assert.equal(native.bounds.x + native.bounds.width, native.workArea.x + native.workArea.width);
  assert.equal(native.bounds.y, native.workArea.y);
  assert.equal(native.resizable, false);
  assert.equal(native.nodeIntegration, false);
  assert.equal(native.contextIsolation, true);
  assert.equal(native.sandbox, true);
  const layout = await page.evaluate(() => {
    const regions = [...document.querySelector('.panel-regions').children].map((element) => {
      const rect = element.getBoundingClientRect();
      return { height: rect.height, overflowX: element.scrollWidth > element.clientWidth,
        overflowY: element.scrollHeight > element.clientHeight };
    });
    const overlaps = [...document.querySelectorAll('.provider-card')].map((card) => {
      const header = card.querySelector('.card-heading').getBoundingClientRect();
      const first = card.querySelector('.quota, .balance-content, .claude-empty').getBoundingClientRect();
      const last = card.querySelector('.quota:last-child, .balance-content, .claude-empty').getBoundingClientRect();
      const footer = card.querySelector('.task-line').getBoundingClientRect();
      return header.bottom > first.top || last.bottom > footer.top;
    });
    const images = [...document.querySelectorAll('.panel-regions .avatar img')];
    return { regions, overlaps, images: images.length === 4 && images.every((image) => image.complete && image.naturalWidth > 0),
      quotaCount: document.querySelectorAll('[role="progressbar"]').length };
  });
  assert.equal(layout.regions.length, 5);
  for (const region of layout.regions) { assert.equal(region.overflowX, false); assert.equal(region.overflowY, false); }
  assert.ok(Math.abs(layout.regions[0].height * 2 - layout.regions[1].height) < 1);
  for (const region of layout.regions.slice(2)) assert.ok(Math.abs(region.height - layout.regions[1].height) < 1);
  assert.equal(layout.images, true);
  assert.ok(layout.overlaps.every((value) => value === false));
  assert.ok(layout.quotaCount >= 3);
  assert.equal(await page.locator('.provider-card').last().getByRole('progressbar').count(), 0);
  if (!live) {
    assert.equal(layout.quotaCount, 5);
    assert.equal(await page.locator('.claude-empty strong').innerText(), 'Code 额度暂不可用');
    assert.equal(await page.locator('.task-line .status-dot.waiting').count(), variant === 'glow-running' ? 0 : 1);
    assert.equal(await page.locator('.quota-unknown').count(), 1);
    assert.equal(await page.locator('.quota-pagination').innerText(), '1/5');
    assert.equal(await page.locator('.balance-total strong').innerText(), '13.57');
    assert.equal(await page.locator('.currency-switch').innerText(), 'CNY ↔');
  }
  if (glow) {
    const lights = await page.locator('.panel-regions .avatar').evaluateAll(elements => elements.map(el => ({
      state: el.getAttribute('data-glow'), color: el.getAttribute('data-provider') === 'antigravity' ? 'rainbow' : getComputedStyle(el).getPropertyValue('--halo-color').trim(),
      duration: getComputedStyle(el, '::before').animationDuration,
    })));
    assert.deepEqual(lights.map(l => l.state), ['running', variant === 'glow-attention' ? 'attention' : 'running', 'running', 'running']);
    assert.ok(lights.every(l => l.duration === '5s'));
    assert.equal(lights[1].color, variant === 'glow-attention' ? '#ff555f' : '#c5d494');
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.card-heading .avatar'), '::before').opacity) > .98);
    console.log(JSON.stringify({ glow: variant, colors: lights.map(l => l.color), cycle: '5 seconds' }));
  }
  const output = live ? '.local/qa/live-panel.png' : glow ? `docs/screenshots/${variant}.png` : 'docs/screenshots/panel.png';
  await mkdir(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, animations: glow ? 'allow' : 'disabled' });
  const status = await page.evaluate(async () => {
    const snapshot = await window.panel.getStatus();
    return ['claude', 'codex', 'antigravity', 'deepseek'].map(id => ({ provider: id, source: snapshot[id].source,
      connection: snapshot[id].connection, activity: snapshot[id].activity, quotaRows: snapshot[id].quotas.length,
      walletCount: snapshot[id].balance?.wallets.length }));
  });
  assert.equal(layout.quotaCount, status.filter(provider => provider.provider !== 'deepseek')
    .reduce((total, provider) => total + (provider.provider === 'claude' && !provider.quotaRows ? 0 : Math.max(1, Math.min(3, provider.quotaRows))), 0));
  console.log(JSON.stringify({ result: 'passed', data: live ? 'local adapters' : 'synthetic fixture',
    logicalSize: `${native.bounds.width}×${native.bounds.height}`, scaleFactor: native.scaleFactor,
    regions: 5, quotaRows: layout.quotaCount, images: '4 loaded', overflow: 'none', isolation: 'enabled', status }, null, 2));
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
