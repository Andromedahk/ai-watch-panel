import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import shared from '../electron/i18n.cjs';
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-i18n-'));
await writeFile(path.join(profile,'preferences.json'), JSON.stringify({language:'zh-CN',locked:true,animate:false}));
let app;
const launch = () => electron.launch({ args:[path.resolve('tests/fixtures/tray-main.cjs')], env:{...process.env, AI_WATCH_TEST_PROFILE:profile, AI_WATCH_TEST_STATUS:'fixture'} });
try {
  app = await launch(); const page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('main')?.dataset.sampledAt);
  const errors = []; page.on('pageerror',error=>errors.push(error.message));
  const originalStatus = await page.evaluate(()=>window.panel.getStatus());
  const withoutSampling = value => JSON.parse(JSON.stringify(value,(key,item)=>key==='sampledAt'?undefined:item));
  const original = await page.evaluate(()=>window.panel.getState());
  await mkdir('.local/qa/i18n',{recursive:true});
  for (const { id, dir } of shared.languages) {
    const i = shared.createI18n(id);
    await page.locator('.toolbar button').last().click();
    await page.locator('.language-settings select').selectOption(id);
    await expect(page.locator('html')).toHaveAttribute('lang',id);
    await expect(page.locator('html')).toHaveAttribute('dir',dir);
    await expect(page.locator('#settings-title')).toHaveText(i.t('面板配置'));
    const saved = JSON.parse(await readFile(path.join(profile,'preferences.json'),'utf8'));
    assert.equal(saved.language,id);
    const menu = await app.evaluate(() => global.aiWatchTestMenu.items.map(item=>({label:item.label,id:item.id})));
    assert.ok(menu[0].label.includes(i.t('额度速览')));
    assert.equal(menu.filter(row=>row.id?.startsWith('quota-')).length,8);
    assert.ok(menu.find(row=>row.id==='quota-codex').label.includes(i.t('7 天')));
    await page.locator('.settings-heading button').click();
    if (!id.startsWith('zh') && id !== 'ja') {
      const text = await page.locator('.provider-card').allTextContents();
      assert.doesNotMatch(text.join(' '), /[\p{Script=Han}]/u, `${id} untranslated card text`);
    }
    for (const anime of [false,true]) for (const theme of ['light','dark']) for (const width of [200,320]) {
      await page.evaluate(async ({anime,theme}) => { await window.panel.setAnimeMode(anime); await window.panel.setTheme(theme); },{anime,theme});
      await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setBounds({width,height:width*4.5}),width);
      await page.waitForFunction(width=>innerWidth===width,width);
      const header = await page.locator('.overview').evaluate(element => {
        const box=element.getBoundingClientRect(), text=element.querySelector('.running-summary').getBoundingClientRect(),time=element.querySelector('time').getBoundingClientRect();
        return {inside:text.left>=box.left-1&&text.right<=box.right+1&&time.left>=box.left-1&&time.right<=box.right+1, separate:text.right<=time.left+1||time.right<=text.left+1};
      });
      assert.ok(header.inside&&header.separate, `${id}/${width}: overview overlap`);
      const layout = await page.locator('.provider-card').evaluateAll(cards=>cards.map(card=>{
        const box=card.getBoundingClientRect(),hero=card.querySelector('.card-heading').getBoundingClientRect(),avatar=card.querySelector('.avatar-launch').getBoundingClientRect(),identity=card.querySelector('.identity').getBoundingClientRect(),area=card.querySelector('.quota-area').getBoundingClientRect(),footer=card.querySelector('.task-line').getBoundingClientRect();
        const rightToLeft=document.documentElement.dir==='rtl';
        return { id:card.dataset.provider, width:box.width,
          ordered:rightToLeft?identity.right<=avatar.left+1:avatar.right<=identity.left+1,
          dataFits:area.bottom<=footer.top+1,
          heroFits:hero.bottom<=area.top+1,
          inside:[hero,avatar,identity,area,footer].every(r=>r.left>=box.left-1&&r.right<=box.right+1),
        };
      }));
      for (const card of layout) assert.ok(card.ordered&&card.dataFits&&card.heroFits&&card.inside, `${id}/${anime}/${theme}/${width}: ${JSON.stringify(card)}`);
      if (anime && theme==='dark' && width===320 && ['en','ar','he','zh-TW'].includes(id)) await page.screenshot({path:`.local/qa/i18n/${id}.png`,animations:'disabled'});
    }
    const state = await page.evaluate(()=>window.panel.getState());
    assert.equal(state.language,id); assert.equal(state.locked,original.locked); assert.deepEqual(state.providerOrder,original.providerOrder); assert.deepEqual(state.enabledProviders,original.enabledProviders);
  }
  assert.deepEqual(withoutSampling(await page.evaluate(()=>window.panel.getStatus())), withoutSampling(originalStatus));
  // Validate the narrow bridge and keep the choice when saving unrelated settings.
  for (const value of ['__proto__','en-US',{},['ar']]) {
    assert.equal(await page.evaluate(async value=>{try{await window.panel.setLanguage(value);return false;}catch{return true;}},value),true);
  }
  await page.evaluate(async()=>{await window.panel.setLanguage('ar');await window.panel.configure({side:'left',locked:false,animate:false});});
  assert.equal((await page.evaluate(()=>window.panel.getState())).language,'ar');
  await page.locator('.toolbar button').last().click();
  await page.locator('.test-toggle input').check();
  await page.locator('.settings-heading button').click();
  await expect(page.locator('main')).toHaveAttribute('data-test-mode','true');
  await page.locator('[data-provider="codex"] .avatar-launch').click();
  await expect(page.locator('.toast')).not.toContainText(/[\p{Script=Han}]/u);
  await page.locator('.toolbar button').last().click();
  await page.locator('.test-toggle input').uncheck();
  await page.locator('.settings-heading button').click();
  await page.locator('[data-provider="antigravity"] .quota-pagination button').last().click();
  await expect(page.locator('[data-provider="antigravity"] .quota-pagination > span')).toContainText('2');
  await page.evaluate(()=>window.panel.store());
  await app.evaluate(({app})=>app.emit('activate'));
  await expect.poll(()=>page.evaluate(()=>window.panel.getState()).then(s=>s.stored)).toBe(false);
  assert.equal((await page.evaluate(()=>window.panel.getState())).language,'ar');
  assert.deepEqual(errors,[]);
  await app.close(); app=null;
  app = await launch(); const reopened=await app.firstWindow();
  await expect(reopened.locator('html')).toHaveAttribute('lang','ar');
  await expect(reopened.locator('html')).toHaveAttribute('dir','rtl');
  await expect(reopened.locator('main')).toHaveAttribute('data-test-mode','false');
  assert.equal((await reopened.evaluate(()=>window.panel.getState())).language,'ar');
  console.log('i18n checks passed: 17 languages, native menu sync, persistence/restart, invalid-input rejection, 136 card layouts, RTL ordering, test mode, pagination, tray restore and unchanged provider selection.');
} finally { if(app)await app.close().catch(()=>{}); await rm(profile,{recursive:true,force:true}); }
