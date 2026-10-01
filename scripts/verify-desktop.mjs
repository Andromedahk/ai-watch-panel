import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-qa-'));
const app = await electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile } });
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: 'AI WATCH', exact: true }).waitFor();
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
      const first = card.querySelector('.quota').getBoundingClientRect();
      const last = card.querySelector('.quota:last-child').getBoundingClientRect();
      const footer = card.querySelector('.task-line').getBoundingClientRect();
      return header.bottom > first.top || last.bottom > footer.top;
    });
    return { regions, overlaps, images: [...document.querySelectorAll('.avatar img')].every((image) => image.complete && image.naturalWidth > 0),
      quotaCount: document.querySelectorAll('[role="progressbar"]').length };
  });
  assert.equal(layout.regions.length, 5);
  for (const region of layout.regions) { assert.equal(region.overflowX, false); assert.equal(region.overflowY, false); }
  assert.ok(Math.abs(layout.regions[0].height * 2 - layout.regions[1].height) < 1);
  for (const region of layout.regions.slice(2)) assert.ok(Math.abs(region.height - layout.regions[1].height) < 1);
  assert.equal(layout.images, true);
  assert.ok(layout.overlaps.every((value) => value === false));
  assert.equal(layout.quotaCount, 10);
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/panel.png', animations: 'disabled' });
  console.log(JSON.stringify({ result: 'passed', logicalSize: `${native.bounds.width}×${native.bounds.height}`, scaleFactor: native.scaleFactor, regions: 5, quotaRows: layout.quotaCount, images: '4 loaded', overflow: 'none', isolation: 'enabled' }, null, 2));
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
