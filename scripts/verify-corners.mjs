import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Corner audit: nothing with square (or smaller) corners may paint outside the
// curve of a rounded box it sits in or on, unless a rounded clip hides it.
// Runs on synthetic fixtures with isolated profiles only.
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-corners-'));
const ids = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];
let app, page;
const failures = new Map();

function audit() {
  const px = value => parseFloat(value) || 0;
  const visible = style => style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > .02;
  const paints = (style, el) => {
    if (el && ['IMG', 'svg', 'CANVAS', 'VIDEO'].includes(el.tagName)) return true;
    const bg = style.backgroundColor;
    const alpha = /rgba?\(([^)]+)\)/.exec(bg)?.[1].split(/[ ,/]+/).filter(Boolean)[3];
    return style.boxShadow !== 'none' || (bg !== 'transparent' && !(alpha !== undefined && parseFloat(alpha) === 0)) || style.backgroundImage !== 'none'
      || ['Top', 'Right', 'Bottom', 'Left'].some(side => px(style[`border${side}Width`]) > 0 && !/rgba\(0, 0, 0, 0\)|transparent/.test(style[`border${side}Color`]));
  };
  const radii = (style, rect) => {
    const raw = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map(key => {
      const value = style[key].split(' ')[0];
      return value.endsWith('%') ? parseFloat(value) / 100 * Math.min(rect.width, rect.height) : px(value);
    });
    // CSS scales all radii down together when adjacent ones exceed the side length.
    const f = Math.min(1, rect.width / ((raw[0] + raw[1]) || 1), rect.width / ((raw[3] + raw[2]) || 1), rect.height / ((raw[0] + raw[3]) || 1), rect.height / ((raw[1] + raw[2]) || 1));
    return raw.map(r => r * f);
  };
  const inside = (x, y, rect, r) => {
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
    const corners = [[rect.left + r[0], rect.top + r[0], r[0], x < rect.left + r[0] && y < rect.top + r[0]],
      [rect.right - r[1], rect.top + r[1], r[1], x > rect.right - r[1] && y < rect.top + r[1]],
      [rect.right - r[2], rect.bottom - r[2], r[2], x > rect.right - r[2] && y > rect.bottom - r[2]],
      [rect.left + r[3], rect.bottom - r[3], r[3], x < rect.left + r[3] && y > rect.bottom - r[3]]];
    return corners.every(([cx, cy, radius, inCorner]) => !inCorner || Math.hypot(x - cx, y - cy) <= radius + .01);
  };
  const shapeOf = (el, pseudo) => {
    const style = getComputedStyle(el, pseudo);
    let rect = el.getBoundingClientRect();
    if (pseudo) {
      if (style.content === 'none' || style.content === 'normal' || style.position !== 'absolute') return null;
      const host = rect, w = px(style.width), h = px(style.height);
      const left = style.left === 'auto' ? null : px(style.left), top = style.top === 'auto' ? null : px(style.top);
      const right = style.right === 'auto' ? null : px(style.right), bottom = style.bottom === 'auto' ? null : px(style.bottom);
      const bl = px(getComputedStyle(el).borderLeftWidth), bt = px(getComputedStyle(el).borderTopWidth);
      const x0 = left !== null ? host.left + bl + left : host.right - px(getComputedStyle(el).borderRightWidth) - right - w;
      const y0 = top !== null ? host.top + bt + top : host.bottom - px(getComputedStyle(el).borderBottomWidth) - bottom - h;
      if (!w || !h) return null;
      rect = { left: x0, top: y0, right: x0 + w, bottom: y0 + h, width: w, height: h };
    }
    return { style, rect, r: radii(style, rect) };
  };
  const clips = el => { const s = getComputedStyle(el); return s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.clipPath !== 'none'; };
  const name = (el, pseudo = '') => {
    const parts = [];
    for (let node = el; node && node !== document.body && parts.length < 4; node = node.parentElement) {
      parts.unshift(`${node.tagName.toLowerCase()}${node.classList.length ? '.' + [...node.classList].slice(0, 2).join('.') : ''}${node.dataset.provider ? `[${node.dataset.provider}]` : ''}`);
    }
    return parts.join(' > ') + pseudo;
  };
  const results = [];
  const all = [...document.querySelectorAll('main *')].filter(el => el.getClientRects().length);
  for (const host of all) {
    const hs = getComputedStyle(host);
    const box = host.getBoundingClientRect(), hr = radii(hs, box);
    // A frame like .avatar paints through a same-sized child (.avatar-face); its rings still pair with it.
    const same = child => { const r = child.getBoundingClientRect(); return Math.abs(r.left - box.left) < .5 && Math.abs(r.top - box.top) < .5 && Math.abs(r.width - box.width) < .5 && Math.abs(r.height - box.height) < .5; };
    if (!visible(hs) || !(paints(hs, host) || [...host.children].some(child => same(child) && paints(getComputedStyle(child), child)))) continue;
    if (hr.every(r => r < 4) || box.width < 12 || box.height < 12) continue;
    // Points just outside each rounded corner of the host.
    const points = [];
    hr.forEach((r, i) => {
      if (r < 4) return;
      const [cx, cy, sx, sy] = [[box.left + r, box.top + r, -1, -1], [box.right - r, box.top + r, 1, -1], [box.right - r, box.bottom - r, 1, 1], [box.left + r, box.bottom - r, -1, 1]][i];
      for (let a = 1; a < 8; a++) {
        const angle = a / 8 * Math.PI / 2;
        for (const extra of [1, Math.max(2, r * .3)]) points.push([cx + sx * Math.cos(angle) * (r + extra), cy + sy * Math.sin(angle) * (r + extra), i]);
      }
    });
    const candidates = [[host, '::before'], [host, '::after'], ...[...host.querySelectorAll('*')].map(el => [el, null])];
    for (const [el, pseudo] of candidates) {
      if (!pseudo && !el.getClientRects().length) continue;
      const shape = shapeOf(el, pseudo);
      if (!shape || !visible(shape.style) || !paints(shape.style, pseudo ? null : el)) continue;
      // A pseudo or child only counts while every ancestor up to the page leaves it visible.
      let hidden = false;
      for (let node = pseudo ? el : el.parentElement; node && node !== document.documentElement; node = node.parentElement) if (!visible(getComputedStyle(node))) { hidden = true; break; }
      if (hidden) continue;
      const clippers = [];
      for (let node = pseudo ? el : el.parentElement; node && node !== document.documentElement; node = node.parentElement) if (clips(node)) clippers.push(node);
      const d = [box.left - shape.rect.left, box.top - shape.rect.top, shape.rect.right - box.right, shape.rect.bottom - box.bottom];
      const ring = d.every(value => value > .4 && Math.abs(value - d[0]) < .6);
      const leak = !ring && points.find(([x, y]) => inside(x, y, shape.rect, shape.r) && clippers.every(node => {
        const s = getComputedStyle(node), rect = node.getBoundingClientRect();
        return inside(x, y, rect, radii(s, rect));
      }));
      // Rings drawn around the host (halos, glows) must stay concentric: radius grows by the offset.
      const clippedByHost = clippers.some(node => node === host || host.contains(node));
      if (!clippedByHost && d.every(value => value > .4 && Math.abs(value - d[0]) < .6) && shape.r.some((r, i) => hr[i] >= 4 && hr[i] < Math.min(box.width, box.height) / 2 - .5 && Math.abs(r - (hr[i] + d[0])) > .6)) {
        results.push(`${name(el, pseudo || '')} rings ${name(host)} ${d[0].toFixed(1)}px out with radius ${shape.r[0].toFixed(1)}px instead of ${(hr[0] + d[0]).toFixed(1)}px`);
      }
      if (leak) results.push(`${name(el, pseudo || '')} leaks past the ${['top-left', 'top-right', 'bottom-right', 'bottom-left'][leak[2]]} curve of ${name(host)}`);
    }
  }
  return [...new Set(results)];
}

async function launch(prefs) {
  await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ locked: false, animate: true, language: 'zh-CN', ...prefs }));
  app = await electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: 'fixture' } });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 420, height: 1100 });
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.dataset.sampledAt));
}
async function testState(changes) {
  await page.getByRole('button', { name: '打开配置', exact: true }).click();
  await page.locator('.settings-nav').getByRole('button', { name: '模块', exact: true }).click();
  const box = page.getByRole('checkbox', { name: '测试模式', exact: true });
  if (!(await box.isChecked())) await box.check();
  for (const [label, value] of changes) await page.getByRole('combobox', { name: `${label} 测试任务状态`, exact: true }).selectOption(value);
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
}
async function check(label) {
  // Let entrances finish so their end state is what is audited.
  await page.waitForTimeout(1400);
  for (const issue of await page.evaluate(audit)) {
    if (!failures.has(issue)) failures.set(issue, []);
    failures.get(issue).push(label);
  }
}
try {
  for (const enabled of [ids.slice(0, 3), ids]) {
    await launch({ skin: 'watch', theme: 'dark', animeMode: false, enabledProviders: enabled });
    await testState([['Claude Code', 'running'], ['Codex', 'approval'], ['Antigravity', 'waiting']]);
    for (const skin of ['watch', 'dial', 'party']) for (const anime of [false, true]) for (const theme of ['dark', 'light']) {
      await page.evaluate(async ({ skin, anime, theme }) => { await window.panel.setSkin(skin); await window.panel.setAnimeMode(anime); await window.panel.setTheme(theme); }, { skin, anime, theme });
      await check(`${enabled.length}/${skin}/${anime ? 'anime' : 'logo'}/${theme}`);
      if (anime) {
        await page.locator('.mascot-refresh').click();
        await check(`${enabled.length}/${skin}/anime/${theme}/mascot-chat`);
      }
      // Hover the first card and its avatar: hover rings and backgrounds must follow the corners too.
      await page.locator('.provider-card').first().hover();
      await check(`${enabled.length}/${skin}/${anime ? 'anime' : 'logo'}/${theme}/hover`);
      await page.locator('.provider-card .avatar-launch').first().hover();
      await check(`${enabled.length}/${skin}/${anime ? 'anime' : 'logo'}/${theme}/avatar-hover`);
      await page.mouse.move(1, 1);
    }
    await page.evaluate(() => window.panel.setLayout('double'));
    await page.setViewportSize({ width: 900, height: 1100 });
    for (const skin of ['watch', 'dial', 'party']) {
      await page.evaluate(skin => window.panel.setSkin(skin), skin);
      await check(`${enabled.length}/${skin}/double`);
    }
    await page.evaluate(() => window.panel.setLayout('fullscreen'));
    for (const skin of ['watch', 'dial', 'party']) {
      await page.evaluate(skin => window.panel.setSkin(skin), skin);
      await check(`${enabled.length}/${skin}/fullscreen`);
    }
    await page.evaluate(() => window.panel.setLayout('single'));
    await page.setViewportSize({ width: 420, height: 1100 });
    // Mid-entrance frames and the settings sheet.
    await page.getByRole('button', { name: '刷新面板', exact: true }).click();
    await page.waitForTimeout(150);
    for (const issue of await page.evaluate(audit)) { if (!failures.has(issue)) failures.set(issue, []); failures.get(issue).push(`${enabled.length}/entrance`); }
    await page.getByRole('button', { name: '打开配置', exact: true }).click();
    await check(`${enabled.length}/settings`);
    await page.getByRole('button', { name: '关闭配置', exact: true }).click();
    await page.evaluate(() => window.panel.setCollapsed(true));
    await check(`${enabled.length}/collapsed`);
    await page.evaluate(() => window.panel.setCollapsed(false));
    await app.close(); app = null;
  }
  const report = [...failures].map(([issue, where]) => `${issue}\n    in ${where.length} views, e.g. ${where.slice(0, 3).join(', ')}`);
  assert.equal(report.length, 0, `Corner leaks:\n${report.join('\n')}`);
  console.log('Corner audit passed: no square or smaller-radius paint crosses a rounded corner in three skins × logo/anime × light/dark, hover, double and fullscreen layouts, mid-entrance frames, the settings sheet, waiting states, lower panels and the collapsed rail. Synthetic data only.');
} finally {
  await app?.close(); await rm(profile, { recursive: true, force: true });
}
