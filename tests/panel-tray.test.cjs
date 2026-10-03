const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PanelTray } = require('../electron/panel-tray.cjs');

function fixture(platform, options = {}) {
  const calls = [], timers = new Map();
  let time = 10000, serial = 0, visible = true, destroyed = false;
  const window = { isDestroyed: () => destroyed, isMinimized: () => false,
    hide: () => { visible = false; calls.push('hide'); },
    show: () => { visible = true; calls.push('show'); }, focus: () => calls.push('focus'),
    setSkipTaskbar: skip => calls.push(`skip:${skip}`) };
  class Tray extends EventEmitter {
    constructor(icon) { super(); if (options.failTray) throw new Error('No tray'); this.icon = icon; }
    isDestroyed() { return this.dead === true; }
    destroy() { this.dead = true; calls.push('destroy-tray'); }
    setContextMenu(menu) { this.menu = menu; }
    setToolTip(text) { this.tooltip = text; }
    popUpContextMenu(menu) { this.openedMenu = menu; calls.push('open-menu'); }
  }
  const app = { quit: () => calls.push('quit'), dock: { hide: () => calls.push('hide-dock'),
    show: options.dockShow || (() => { calls.push('show-dock'); return Promise.resolve(); }) } };
  const Menu = { buildFromTemplate(items) { return { items, getMenuItemById: id => items.find(item => item.id === id) }; } };
  const icon = { isEmpty: () => options.emptyIcon === true, setTemplateImage: value => calls.push(`template:${value}`) };
  const panel = new PanelTray({ app, window, Tray, Menu, nativeImage: { createFromPath: () => icon }, platform, getSummary: options.getSummary,
    onChange: () => calls.push('changed'), onRefresh: () => calls.push('refresh'), now: () => time,
    schedule: (fn, ms) => { timers.set(++serial, { fn, ms }); return serial; }, cancel: id => timers.delete(id) });
  return { panel, calls, timers, get visible() { return visible; },
    advance(ms) { time += ms; for (const [id, timer] of timers) { timers.delete(id); timer.fn(); } },
    destroyWindow() { destroyed = true; } };
}

test('macOS stores behind a template menu icon and restores the same live window', async () => {
  const f = fixture('darwin');
  assert.ok(f.calls.includes('template:true'));
  assert.equal(f.panel.store(), true);
  assert.equal(f.visible, false);
  assert.equal(f.panel.available, true);
  assert.equal(f.panel.menu.getMenuItemById('store-panel').enabled, false);
  assert.ok(f.calls.includes('hide-dock'));
  assert.equal(await f.panel.restore(), true);
  assert.equal(f.visible, true);
  assert.equal(f.panel.stored, false);
  assert.ok(f.calls.indexOf('show-dock') < f.calls.indexOf('show'));
  assert.equal(f.panel.menu.getMenuItemById('store-panel').enabled, true);
  f.panel.dispose();
});

test('Windows opens quota menu on click without restoring, and restores on double-click', async () => {
  const f = fixture('win32');
  assert.match(f.panel.tray.icon, /tray\.ico$/);
  assert.equal(f.panel.store(), true);
  assert.equal(f.visible, false);
  f.panel.tray.emit('click');
  assert.equal(f.visible, false);
  assert.ok(f.calls.includes('open-menu'));
  assert.equal(f.panel.tray.openedMenu, f.panel.menu);
  f.panel.tray.emit('double-click');
  assert.equal(f.visible, true);
  assert.ok(f.calls.indexOf('skip:true') < f.calls.indexOf('skip:false'));
  assert.equal(f.calls.some(call => call.includes('dock')), false);
  f.panel.dispose();
});

test('quota menu changes with background data and skips rebuilding unchanged labels', () => {
  let label = 'Codex    7 天 · 剩余 75%';
  const f = fixture('darwin', { getSummary: () => ({ rows: [{ id: 'codex', label }], isTestData: true }) });
  assert.equal(f.panel.menu.items[0].label, '额度速览 · 测试数据');
  assert.equal(f.panel.menu.getMenuItemById('quota-codex').label, label);
  assert.equal(f.panel.menu.getMenuItemById('quota-codex').enabled, false);
  const unchanged = f.panel.menu;
  f.panel.updateMenu(); assert.equal(f.panel.menu, unchanged);
  f.panel.store(); label = 'Codex    7 天 · 剩余 0%'; f.panel.updateMenu();
  assert.equal(f.visible, false);
  assert.equal(f.panel.menu.getMenuItemById('quota-codex').label, label);
  assert.equal(f.panel.menu.getMenuItemById('store-panel').enabled, false);
  f.panel.openMenu(); assert.ok(f.calls.includes('open-menu'));
  f.panel.dispose();
});

test('close stores; explicit quit destroys the icon and allows the window to close', () => {
  const f = fixture('win32');
  let prevented = false;
  f.panel.handleClose({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  f.panel.menu.items.find(item => item.label === '退出 AI Watch').click();
  assert.ok(f.calls.includes('quit'));
  f.panel.dispose();
  prevented = false;
  f.panel.handleClose({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(f.panel.available, false);
});

test('tray creation failure never hides or traps the panel', () => {
  for (const options of [{ failTray: true }, { emptyIcon: true }]) {
    const f = fixture('darwin', options);
    assert.equal(f.panel.available, false);
    assert.equal(f.panel.store(), false);
    f.panel.handleClose({ preventDefault: () => assert.fail('close should stay available') });
    assert.equal(f.visible, true);
  }
});

test('rapid macOS restore/store cancels stale Dock work and delays repeated hide calls', async () => {
  const f = fixture('darwin');
  f.panel.store(); await f.panel.restore(); f.panel.store();
  assert.equal(f.calls.filter(call => call === 'hide-dock').length, 1);
  assert.equal([...f.timers.values()][0].ms, 1100);
  await f.panel.restore();
  assert.equal(f.timers.size, 0);
  f.panel.store(); f.advance(1100);
  assert.equal(f.calls.filter(call => call === 'hide-dock').length, 2);
  f.panel.dispose();
});

test('later store and quit take priority over a pending macOS Dock show', async () => {
  let resolve;
  const f = fixture('darwin', { dockShow: () => new Promise(done => { resolve = done; }) });
  f.panel.store(); const restoration = f.panel.restore(); f.panel.store(); resolve();
  assert.equal(await restoration, false);
  assert.equal(f.visible, false);
  const quitting = f.panel.restore(); f.panel.dispose(); resolve();
  assert.equal(await quitting, false);
  assert.equal(f.visible, false);
});
