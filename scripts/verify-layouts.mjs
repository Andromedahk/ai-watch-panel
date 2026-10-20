import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import shared from '../electron/i18n.cjs';
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-layouts-'));
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ locked: true, animate: false, theme: 'dark', language: 'zh-CN' }));
const launch = () => electron.launch({ args: [path.resolve('tests/fixtures/tray-main.cjs')], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
let app;
try {
  await mkdir('.local/qa/layouts', { recursive: true });
  app = await launch(); const page = await app.firstWindow();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('main')?.dataset.sampledAt);
  const state = () => page.evaluate(() => window.panel.getState());
  const single = await state(); assert.equal(single.layout, 'single');
  const titleSize = () => page.locator('[data-provider="codex"] h2').evaluate(el => getComputedStyle(el).fontSize);
  const font = await titleSize();
  await page.locator('.toolbar button').last().click();
  await page.locator('.layout-settings select').selectOption('double');
  await expect(page.locator('main')).toHaveAttribute('data-layout', 'double');
  await page.locator('.settings-heading button').click();
  const double = await state(); assert.equal(double.bounds.height, single.bounds.height); assert.equal(double.bounds.width, 2 * single.bounds.width); assert.equal(await titleSize(), font);
  const positions = await page.locator('.provider-card').evaluateAll(cards => cards.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
  assert.ok(Math.abs(positions[0].y - positions[1].y) < 1); assert.ok(positions[1].x > positions[0].x); assert.ok(positions[2].y > positions[0].y);
  // Drag to an adjacent column (both cards have the same vertical center).
  const before = double.providerOrder; const first = page.locator('.provider-card').nth(0), second = page.locator('.provider-card').nth(1);
  const a = await first.boundingBox(), b = await second.boundingBox();
  await page.mouse.move(a.x + a.width - 22, a.y + 22); await page.mouse.down(); await page.waitForTimeout(550);
  await page.mouse.move(b.x + b.width - 22, b.y + 22, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => state().then(s => s.providerOrder[0])).toBe(before[1]);
  await expect(page.locator('.provider-card').first()).toHaveAttribute('data-provider',before[1]);
  await expect(page.locator('.is-sorting')).toHaveCount(0); await page.waitForTimeout(200);
  await page.locator(`.provider-card[data-provider="${before[1]}"]`).focus(); await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => state().then(s => s.providerOrder[2])).toBe(before[1]);
  await page.evaluate(() => window.panel.setOrder(['claude','codex','antigravity','deepseek','zcode','kimi','qwen','workbuddy']));
  // Two-column scaling must preserve both compact card heights and RTL flow.
  for (const { id, dir } of shared.languages) {
    await page.evaluate(id => window.panel.setLanguage(id), id);
    for (const anime of [false,true]) for (const theme of ['light','dark']) {
      await page.evaluate(async ({anime,theme}) => { await window.panel.setAnimeMode(anime); await window.panel.setTheme(theme); },{anime,theme});
      await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:400,height:900}));
      await page.waitForFunction(()=>innerWidth===400&&innerHeight===900);
      const fit = await page.locator('.provider-card').evaluateAll(cards=>cards.map(card=>{
        const box=card.getBoundingClientRect(), hero=card.querySelector('.card-heading').getBoundingClientRect(), avatar=card.querySelector('.avatar-launch').getBoundingClientRect(), identity=card.querySelector('.identity').getBoundingClientRect(), area=card.querySelector('.quota-area').getBoundingClientRect(), footer=card.querySelector('.task-line').getBoundingClientRect();
        return {id:card.dataset.provider,inside:[hero,avatar,identity,area,footer].every(r=>r.left>=box.left-1&&r.right<=box.right+1),separate:hero.bottom<=area.top+1&&area.bottom<=footer.top+1,ordered:document.documentElement.dir==='rtl'?identity.right<=avatar.left+1:avatar.right<=identity.left+1};
      }));
      for(const card of fit)assert.ok(card.inside&&card.separate&&card.ordered,`${id}/${anime}/${theme}/double: ${JSON.stringify(card)}`);
    }
  }
  await page.evaluate(()=>window.panel.setLanguage('zh-CN'));
  await app.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows()[0].setBounds(bounds),double.bounds);
  await page.waitForTimeout(200);
  // Preserve a manually moved right edge across fullscreen and back.
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0], r = w.getBounds(); w.setBounds({ ...r, x: r.x - 80 }); });
  await page.waitForTimeout(200); const moved = (await state()).bounds;
  for (const invalid of [{}, ['double'], '__proto__', 'maximized']) assert.equal(await page.evaluate(async value => { try { await window.panel.setLayout(value); return false; } catch { return true; } }, invalid), true);
  await page.evaluate(() => window.panel.setLayout('fullscreen'));
  await expect(page.locator('main')).toHaveAttribute('data-layout', 'fullscreen');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), true);
  await expect(page.locator('.task-details')).toHaveCount(8);
  await expect(page.locator('.task-title').first()).toContainText('sample task');
  await expect(page.locator('.toast')).toHaveCount(0);
  // The compact fullscreen strip still exposes every individual allowance/pool.
  const snapshot = await page.evaluate(() => window.panel.getStatus());
  for (const id of ['antigravity','qwen','workbuddy']) {
    const card = page.locator(`[data-provider="${id}"]`), credit = id !== 'antigravity';
    const items = credit ? snapshot[id].credits.items : snapshot[id].quotas;
    for (let index=0;index<items.length;index++) {
      await expect(card.locator(credit ? '.credit-item' : '.quota-list > .quota')).toHaveCount(1);
      if (credit) await expect(card.locator('.credit-value bdi')).toHaveText(items[index].remaining);
      else await expect(card.locator('.quota-label strong bdi')).toHaveText(`${items[index].remaining}%`);
      if(index+1<items.length)await card.locator('.quota-pagination button').last().click();
    }
    for(let index=items.length-1;index>0;index--)await card.locator('.quota-pagination button').first().click();
  }
  const currency = page.locator('[data-provider="deepseek"] .currency-switch');
  if(await currency.count()) {
    const before = await page.locator('.balance-total').textContent();
    await currency.click(); assert.notEqual(await page.locator('.balance-total').textContent(), before);
    await currency.click(); assert.equal(await page.locator('.balance-total').textContent(), before);
  }
  for (const { id, dir } of shared.languages) {
    await page.evaluate(id => window.panel.setLanguage(id), id);
    for (const anime of [false, true]) for (const theme of ['light', 'dark']) {
      await page.evaluate(async ({ anime, theme }) => { await window.panel.setAnimeMode(anime); await window.panel.setTheme(theme); }, { anime, theme });
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      const controls = await page.locator('.toolbar button').evaluateAll(buttons => buttons.every(button => { const r = button.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; }));
      assert.ok(controls, `${id}: controls outside viewport`);
      const layout = await page.locator('.provider-card').evaluateAll(cards => cards.map(card => {
        const r = card.getBoundingClientRect(), boxes = ['.card-heading','.quota-area','.task-details','.task-line'].map(selector => card.querySelector(selector).getBoundingClientRect());
        const [heading, quota, tasks, footer] = boxes;
        return { id: card.dataset.provider,
          inside: boxes.every(b => b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1),
          separate: heading.bottom <= quota.top + 1 && quota.bottom <= tasks.top + 1 && tasks.bottom <= footer.top + 1,
          compact: quota.height <= 38 && Math.abs(tasks.left-quota.left)<1 && Math.abs(tasks.right-quota.right)<1,
          stripFit: [...card.querySelectorAll('.quota-area .source-tag,.quota-area .quota-pagination,.quota-area .quota,.quota-area .credit-item,.quota-area .balance-total,.quota-area .balance-empty,.quota-area .credits-empty,.quota-area .claude-empty')].every(el=>{
            const b=el.getBoundingClientRect();return !b.width||!b.height||(b.left>=quota.left-1&&b.right<=quota.right+1&&b.top>=quota.top-1&&b.bottom<=quota.bottom+1);
          }) };
      }));
      for (const card of layout) assert.ok(card.inside && card.separate && card.compact && card.stripFit, `${id}/${anime}/${theme}: ${JSON.stringify(card)}`);
      if (anime && theme === 'dark' && ['zh-CN', 'ar'].includes(id)) await page.screenshot({ path: `.local/qa/layouts/fullscreen-${id}.png`, animations: 'disabled', scale: 'css' });
    }
  }
  await page.evaluate(() => window.panel.setLanguage('zh-CN'));
  await page.locator('.toolbar button').last().click();
  await expect(page.locator('.settings-dialog')).toBeVisible(); await page.locator('.test-toggle input').check();
  await page.locator('.settings-heading button').click(); await expect(page.locator('main')).toHaveAttribute('data-test-mode','true');
  await expect(page.locator('.task-progress progress').first()).toHaveAttribute('value','65');
  await page.locator('.task-title').first().click(); assert.equal(await page.locator('.is-dragging').count(), 0);
  await page.locator('.toolbar button').last().click(); await page.locator('.test-toggle input').uncheck(); await page.locator('.settings-heading button').click();
  await expect(page.locator('main')).toHaveAttribute('data-test-mode','false');
  await page.evaluate(() => window.panel.store()); await app.evaluate(({app}) => app.emit('activate'));
  await expect.poll(() => state().then(s=>s.stored)).toBe(false);
  assert.equal((await state()).layout,'fullscreen');
  await page.keyboard.press('Escape'); await expect(page.locator('main')).toHaveAttribute('data-layout','double');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false);
  assert.deepEqual((await state()).bounds, moved); await expect(page.locator('.task-details')).toHaveCount(0);
  await page.evaluate(() => window.panel.configure({ side: 'right', locked: true, animate: false })); assert.equal((await state()).layout,'double');
  await page.evaluate(() => window.panel.setCollapsed(true)); assert.equal((await state()).bounds.width,46);
  await page.evaluate(() => window.panel.setCollapsed(false)); assert.equal((await state()).bounds.width,double.bounds.width);
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({path:'.local/qa/layouts/double.png',animations:'disabled',scale:'css'});
  await page.evaluate(() => window.panel.store()); await app.evaluate(({app}) => app.emit('activate'));
  await expect.poll(() => state().then(s=>s.stored)).toBe(false); assert.equal((await state()).layout,'double');
  assert.equal(JSON.parse(await readFile(path.join(profile,'preferences.json'),'utf8')).layout,'double');
  await app.close(); app=null; app=await launch(); const reopened=await app.firstWindow();
  await expect(reopened.locator('main')).toHaveAttribute('data-layout','double'); assert.equal((await reopened.evaluate(()=>window.panel.getState())).layout,'double');
  await reopened.evaluate(()=>window.panel.setLayout('fullscreen'));
  await app.close(); app=null; app=await launch(); const fullRestart=await app.firstWindow();
  await expect(fullRestart.locator('main')).toHaveAttribute('data-layout','fullscreen');
  await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await fullRestart.evaluate(()=>window.panel.setCollapsed(true));
  await expect(fullRestart.locator('main')).toHaveAttribute('data-layout','double'); assert.equal((await fullRestart.evaluate(()=>window.panel.getState())).bounds.width,46);
  await fullRestart.evaluate(()=>window.panel.setCollapsed(false)); await fullRestart.evaluate(()=>window.panel.setLayout('single'));
  await expect.poll(()=>fullRestart.evaluate(()=>window.panel.getStatus()).then(s=>Object.values(s).filter(p=>p?.taskDetails).length)).toBe(0);
  assert.deepEqual(errors,[]);
  console.log('Layout checks passed: native fullscreen entry/exit, exact 2x geometry, moved-position restore, two-dimensional sorting, compact 36px quota strips with full-width task areas, all allowance/credit pages and balance currencies, collapse, tray, persistence, invalid input, test restoration and 136 double/fullscreen locale/anime/theme layouts and fullscreen restart.');
} finally { if(app) await app.close().catch(()=>{}); await rm(profile,{recursive:true,force:true}); }
