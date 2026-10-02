import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const names = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', deepseek: 'DeepSeek Harness', zcode: 'ZCode', kimi: 'Kimi Code', qwen: 'Qwen（千问）', workbuddy: 'WorkBuddy' };
const ids = Object.keys(names);
const feedbackName = id => id === 'claude' ? 'Claude' : id === 'qwen' ? '千问' : names[id];
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-anime-'));
// An isolated profile plus fixture mode prevents this suite from opening real apps or reading credentials.
const launch = () => electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
let app = await launch();
let preview;
try {
  let page = await app.firstWindow();
  const ready = () => page.waitForFunction(() => Boolean(document.querySelector('main')?.getAttribute('data-sampled-at')));
  const card = id => page.locator(`.provider-card[data-provider="${id}"]`);
  const state = () => page.evaluate(() => window.panel.getState());
  const open = () => page.getByRole('button', { name: '打开配置', exact: true }).click();
  const close = () => page.getByRole('button', { name: '关闭配置', exact: true }).click();
  const mode = () => page.getByRole('checkbox', { name: '二次元模式', exact: true });
  const setMode = async value => { if (await mode().isChecked() !== value) await mode().click(); await expect(mode()).toBeChecked({ checked: value }); };
  const launchButton = id => page.getByRole('button', { name: `打开 ${names[id]}`, exact: true });
  await ready();
  assert.equal((await state()).animeMode, false);
  await expect(page.locator('.panel')).not.toHaveClass(/anime-mode/);
  await expect(page.locator('.provider-card .avatar-launch')).toHaveCount(8);
  const originalImages = await page.locator('.provider-card .avatar img').evaluateAll(images => images.map(image => image.src));
  for (const id of ids) {
    assert.equal((await page.evaluate(id => window.panel.openProvider(id), id)).status, 'test');
    await launchButton(id).click();
    await expect(page.locator('.toast')).toContainText(/测试|模拟/);
    await expect(page.locator('.toast')).toContainText(feedbackName(id));
  }
  for (const invalid of [null, 'invalid', '../Codex.app', {}, ['codex']]) {
    assert.equal(await page.evaluate(async id => {
      try { await window.panel.openProvider(id); return false; } catch { return true; }
    }, invalid), true);
  }
  for (const invalid of [null, 1, 'true', {}, [true]]) {
    assert.equal(await page.evaluate(async value => {
      try { await window.panel.setAnimeMode(value); return false; } catch { return true; }
    }, invalid), true);
  }
  // Both keyboard activation keys work; holding the launcher cannot start card sorting.
  await page.locator('.provider-viewport').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  await launchButton('claude').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.toast')).toContainText(/测试|模拟/);
  await launchButton('codex').focus(); await page.keyboard.press('Space');
  await expect(page.locator('.toast')).toContainText(/测试|模拟/);
  const logo = await launchButton('claude').boundingBox();
  await page.mouse.move(logo.x + logo.width / 2, logo.y + logo.height / 2); await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(page.locator('.is-dragging')).toHaveCount(0);
  await page.mouse.up();
  assert.deepEqual((await state()).providerOrder, ids);
  await open(); await setMode(true); await expect(mode()).toBeChecked(); await close();
  await expect(page.locator('.panel')).toHaveClass(/anime-mode/);
  assert.equal((await state()).animeMode, true);
  const animeImages = await page.locator('.provider-card .avatar img').evaluateAll(images => images.map(image => image.src));
  assert.equal(new Set(animeImages).size, 8);
  assert.ok(animeImages.every((image, index) => image !== originalImages[index]));
  await page.evaluate(async () => {
    const current = await window.panel.getState();
    await window.panel.configure({ side: current.side, locked: current.locked, animate: current.animate });
  });
  assert.equal((await state()).animeMode, true);

  // Select synthetic local PNGs through the real image bridge, without opening a native dialog.
  const paths = [];
  for (const [index, color] of ['#fe45a0', '#2299ee'].entries()) {
    const data = await page.evaluate(color => {
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 24;
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 16, 24);
      return canvas.toDataURL('image/png').split(',')[1];
    }, color);
    const file = path.join(profile, `synthetic-${index}.png`); await writeFile(file, Buffer.from(data, 'base64')); paths.push(file);
  }
  await open();
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, paths[0]);
  await page.getByRole('button', { name: '替换 Claude Code 图片', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('ai-watch:images') || '{}').claude?.startsWith('data:image/png'));
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, paths[1]);
  await page.getByRole('button', { name: '替换 Claude Code 二次元图片', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('ai-watch:anime-images') || '{}').claude?.startsWith('data:image/png'));
  await close();
  const customAnime = await card('claude').locator('.avatar img').getAttribute('src');
  assert.match(customAnime, /^data:image\/png/);
  await open(); await setMode(false); await expect(mode()).not.toBeChecked(); await close();
  const customNormal = await card('claude').locator('.avatar img').getAttribute('src');
  assert.match(customNormal, /^data:image\/png/); assert.notEqual(customNormal, customAnime);
  for (const [index, id] of ids.entries()) if (id !== 'claude') {
    assert.equal(await card(id).locator('.avatar img').evaluate(image => image.src), originalImages[index]);
  }
  await open(); await setMode(true); await close();
  assert.equal(await card('claude').locator('.avatar img').getAttribute('src'), customAnime);
  assert.equal(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).animeMode, true);
  // Renderer test mode must stop before the main-process launch bridge, including in desktop builds.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__animeLaunchAttempts = 0;
    ipcMain.removeHandler('panel:open-provider');
    ipcMain.handle('panel:open-provider', () => {
      globalThis.__animeLaunchAttempts++;
      return { status: 'error', message: 'Unexpected real launch attempt in UI test mode' };
    });
  });
  await open(); await page.getByRole('checkbox', { name: '测试模式', exact: true }).check(); await close();
  await launchButton('claude').click();
  await expect(page.locator('.toast')).toContainText(/测试|模拟/);
  assert.equal(await app.evaluate(() => globalThis.__animeLaunchAttempts), 0);
  await app.close(); app = await launch(); page = await app.firstWindow(); await ready();
  assert.equal((await state()).animeMode, true);
  await expect(page.locator('.panel')).toHaveClass(/anime-mode/);
  assert.equal(await card('claude').locator('.avatar img').getAttribute('src'), customAnime);
  await open(); await setMode(false); await close();
  assert.equal(await card('claude').locator('.avatar img').getAttribute('src'), customNormal);
  await open(); await setMode(true); await close();
  await page.getByRole('button', { name: '收起面板', exact: true }).click();
  await expect(page.locator('.rail-providers .avatar-launch')).toHaveCount(8);
  for (const id of ids) {
    await launchButton(id).click(); await expect(page.locator('.toast')).toContainText(/测试|模拟/);
    await expect(page.locator('.toast')).toContainText(feedbackName(id));
    if (id === ids[0]) {
      await expect(page.locator('.panel')).not.toHaveClass(/collapsed/);
      await expect(page.locator('.toast')).toBeVisible();
    }
  }
  // Missing desktop apps must give a readable recovery hint even when the panel is collapsed.
  await page.getByRole('button', { name: '收起面板', exact: true }).click();
  await expect(page.locator('.panel')).toHaveClass(/collapsed/);
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('panel:open-provider');
    ipcMain.handle('panel:open-provider', () => ({ status: 'missing', message: '未找到桌面应用，请在设置中选择启动应用。' }));
  });
  await launchButton('kimi').click();
  await expect(page.locator('.panel')).not.toHaveClass(/collapsed/);
  await expect(page.locator('.toast')).toBeVisible();
  await expect(page.locator('.toast')).toContainText('选择启动应用');
  await open();
  await page.getByRole('button', { name: '选择 Kimi Code 启动应用', exact: true }).click();
  await expect(page.locator('.toast')).toContainText(/测试.*模拟选择/);
  await expect(page.locator('.toast')).toContainText('Kimi Code');
  await close();
  console.log('Launcher and persistence checks passed: eight fixed providers, strict IPC, mouse and keyboard, no logo long-press sorting, independent ordinary/anime images, cold restart and collapsed launchers. Fixture mode only.');

  // A separate sandboxed, no-preload window exercises preview behavior and exact logical screen sizes.
  const previewPromise = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, file) => {
    const window = new BrowserWindow({ show: false, frame: false, width: 320, height: 1440,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'anime-preview' } });
    await window.loadFile(file);
  }, path.resolve('dist/index.html'));
  preview = await previewPromise;
  await preview.getByRole('button', { name: '打开 Claude Code', exact: true }).click();
  await expect(preview.locator('.toast')).toContainText('桌面版');
  const settings = () => preview.getByRole('button', { name: '打开配置', exact: true }).click();
  const dismiss = () => preview.getByRole('button', { name: '关闭配置', exact: true }).click();
  const previewCard = id => preview.locator(`.provider-card[data-provider="${id}"]`);
  const scroll = bottom => preview.locator('.provider-viewport').evaluate((element, bottom) => element.scrollTo({ top: bottom ? element.scrollHeight : 0, behavior: 'instant' }), bottom);
  await settings();
  await preview.getByRole('checkbox', { name: '二次元模式', exact: true }).check();
  await preview.getByRole('checkbox', { name: '测试模式', exact: true }).check();
  await preview.getByRole('button', { name: '全部运行', exact: true }).click();
  await dismiss();
  await expect(preview.locator('.panel')).toHaveClass(/anime-mode/);
  await preview.getByRole('button', { name: '打开 Claude Code', exact: true }).click();
  await expect(preview.locator('.toast')).toContainText(/测试|模拟/);

  async function geometry(size, theme) {
    const metrics = await preview.locator('.provider-card').evaluateAll(cards => {
      const box = element => { const { x, y, top, bottom, left, right, width, height } = element.getBoundingClientRect(); return { x, y, top, bottom, left, right, width, height }; };
      return cards.map(card => ({ id: card.dataset.provider, card: box(card), heading: box(card.querySelector('.card-heading')),
        avatar: box(card.querySelector('.avatar')), identity: box(card.querySelector('.identity')), content: box(card.querySelector('.quota-area')), footer: box(card.querySelector('.task-line')),
        identityText: [...card.querySelectorAll('.identity h2, .identity .eyebrow, .identity .plan-summary')].map(element => ({ box: box(element), overflow: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1 })),
        imageLoaded: card.querySelectorAll('.avatar img').length === 1 && [...card.querySelectorAll('.avatar img')].every(image => image.complete && image.naturalWidth > 0),
        imageFit: getComputedStyle(card.querySelector('.avatar img') || card).objectFit,
        overflow: card.scrollWidth > card.clientWidth + 1 || card.scrollHeight > card.clientHeight + 1,
        rows: [...card.querySelectorAll('.quota, .credit-item')].map(row => ({ box: box(row), overflow: row.scrollHeight > row.clientHeight + 1 || row.scrollWidth > row.clientWidth + 1 })) }));
    });
    assert.equal(metrics.length, 8);
    const header = await preview.locator('.control-region').boundingBox();
    assert.ok(Math.abs(header.height * 2 - metrics[0].card.height) < 1);
    for (const item of metrics) {
      const context = JSON.stringify({ size, theme, ...item });
      assert.equal(item.imageLoaded, true, context); assert.equal(item.imageFit, 'contain', context); assert.equal(item.overflow, false, context);
      const ratio = item.avatar.width * item.avatar.height / (item.card.width * item.card.height);
      assert.ok(ratio >= .20 && ratio <= .28, `Avatar area ${ratio}: ${context}`);
      assert.ok(item.heading.bottom <= item.content.top + 1, context);
      assert.ok(item.identity.top >= item.heading.top - 1 && item.identity.bottom <= item.heading.bottom + 1, context);
      assert.ok(item.avatar.right < item.identity.left && item.identity.right <= item.heading.right + 1, context);
      for (const text of item.identityText) {
        assert.equal(text.overflow, false, context);
        assert.ok(text.box.left >= item.identity.left - 1 && text.box.right <= item.identity.right + 1, context);
      }
      assert.ok(item.content.bottom <= item.footer.top + 1, context);
      assert.ok(item.footer.bottom <= item.card.bottom + 1, context);
      for (const row of item.rows) {
        assert.equal(row.overflow, false, context);
        assert.ok(row.box.top >= item.content.top - 1 && row.box.bottom <= item.footer.top + 1, context);
      }
    }
    assert.equal(await preview.locator('.provider-viewport').evaluate(element => element.scrollHeight > element.clientHeight && element.scrollWidth <= element.clientWidth), true);
  }
  await mkdir('docs/screenshots', { recursive: true });
  for (const size of [{ width: 320, height: 1440 }, { width: 200, height: 900 }]) {
    await preview.setViewportSize(size);
    for (const theme of ['light', 'dark']) {
      await settings(); await preview.getByRole('checkbox', { name: '暗夜模式', exact: true }).setChecked(theme === 'dark'); await dismiss();
      await expect(preview.locator('html')).toHaveAttribute('data-theme', theme);
      await geometry(size, theme); await scroll(false);
      await expect(preview.locator('.hidden-activity-light')).toHaveCount(4);
      await expect(previewCard('claude').locator('.avatar')).toHaveAttribute('data-glow', 'running');
      const modelNames = await previewCard('antigravity').locator('.model-name').allTextContents();
      for (let current = 2; current <= 4; current++) {
        await previewCard('antigravity').getByRole('button', { name: 'Antigravity 下一页额度', exact: true }).click();
        await expect(previewCard('antigravity').locator('.quota-pagination')).toHaveText(`${current}/4`);
        modelNames.push(...await previewCard('antigravity').locator('.model-name').allTextContents());
      }
      assert.equal(new Set(modelNames).size, 7, 'Compact layout keeps every model quota reachable');
      for (let current = 3; current >= 1; current--) await previewCard('antigravity').getByRole('button', { name: 'Antigravity 上一页额度', exact: true }).click();
      await previewCard('claude').getByRole('button', { name: 'Claude Code 下一页额度', exact: true }).click();
      await expect(previewCard('claude').locator('.model-name')).toHaveText('Opus');
      await previewCard('claude').getByRole('button', { name: 'Claude Code 上一页额度', exact: true }).click();
      await expect(preview.locator('.toast')).toBeHidden();
      await preview.screenshot({ path: `docs/screenshots/anime-first-${size.height}-${theme}.png`, animations: 'disabled' });
      await scroll(true);
      for (const id of ['qwen', 'workbuddy']) {
        await previewCard(id).getByRole('button', { name: `${names[id]} 下一页额度`, exact: true }).click();
        await expect(previewCard(id).locator('.quota-pagination')).toHaveText('2/2');
        await geometry(size, theme);
        await previewCard(id).getByRole('button', { name: `${names[id]} 上一页额度`, exact: true }).click();
      }
      await preview.screenshot({ path: `docs/screenshots/anime-more-${size.height}-${theme}.png`, animations: 'disabled' });
      await settings();
      await preview.getByRole('combobox', { name: 'Claude Code 测试数据显示', exact: true }).selectOption('free');
      await dismiss(); await scroll(false); await geometry(size, theme);
      const empty = await previewCard('claude').locator('.claude-empty').evaluate(element => ({
        overflow: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
        top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom,
        titleTop: element.querySelector('strong').getBoundingClientRect().top,
        descriptionBottom: element.querySelector('p').getBoundingClientRect().bottom,
      }));
      assert.equal(empty.overflow, false);
      assert.ok(empty.titleTop > empty.top && empty.descriptionBottom < empty.bottom);
      if (size.height === 1440 && theme === 'dark') await previewCard('claude').screenshot({ path: 'docs/screenshots/anime-card-empty-dark.png', animations: 'disabled' });
      await settings();
      await preview.getByRole('combobox', { name: 'Claude Code 测试数据显示', exact: true }).selectOption('unknown');
      await dismiss(); await geometry(size, theme);
      await expect(previewCard('claude').locator('.plan-name')).toHaveText('未知');
      await expect(previewCard('claude').locator('.plan-summary')).toHaveAttribute('title', '套餐：套餐未知');
      await settings();
      await preview.getByRole('combobox', { name: 'Claude Code 测试数据显示', exact: true }).selectOption('normal');
      await dismiss();
    }
  }
  await settings();
  await preview.getByRole('combobox', { name: 'Codex 测试任务状态', exact: true }).selectOption('input');
  await dismiss(); await scroll(false);
  await expect(previewCard('codex').locator('.avatar')).toHaveAttribute('data-glow', 'attention');
  await expect(previewCard('codex').locator('.avatar')).toHaveCSS('--halo-color', '#ff555f');
  await settings(); await preview.getByRole('checkbox', { name: '二次元模式', exact: true }).uncheck(); await dismiss();
  await expect(preview.locator('.panel')).not.toHaveClass(/anime-mode/);
  await preview.reload(); await expect(preview.locator('.panel')).not.toHaveClass(/anime-mode/);
  console.log('Anime layout checks passed: independent default artwork, approximately one-quarter card image area, four-card ratio, scroll, two themes at 320×1440 and 200×900, all quota/credit pagination, running and Codex waiting halos, preview launch feedback and saved preview preference. Screenshots contain synthetic data only.');
} finally {
  await preview?.close();
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
