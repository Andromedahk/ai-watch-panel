const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WindowLayout } = require('../electron/window-layout.cjs');
const { panelBounds, validPreferences, isLayout } = require('../electron/window-policy.cjs');
function fixture() {
  const area = { x: -1600, y: 25, width: 1600, height: 900 };
  const window = new EventEmitter(); let bounds = { x: -320, y: 25, width: 200, height: 900 }, full = false;
  Object.assign(window, { getBounds: () => ({ ...bounds }), isFullScreen: () => full,
    setFullScreen: value => { full = value; if (value) bounds = { ...area }; queueMicrotask(() => window.emit(value ? 'enter-full-screen' : 'leave-full-screen')); },
    setAlwaysOnTop: () => {}, setVisibleOnAllWorkspaces: () => {}, setHiddenInMissionControl: () => {} });
  const preferences = validPreferences({ locked: true }); let saves = 0, changes = 0;
  const layout = new WindowLayout({ window, screen: { getDisplayMatching: () => ({ workArea: area }) },
    getPreferences: () => preferences, save: () => { saves++; }, changed: () => { changes++; }, pin: () => {},
    setBounds: value => { bounds = { ...value }; } });
  return { window, preferences, layout, area, counts: () => ({ saves, changes }) };
}
test('double layout exactly doubles rounded single width, keeps height and either edge on HiDPI work areas', () => {
  for (const height of [768, 900, 1055, 1440]) for (const side of ['left', 'right']) {
    const area = { x: -2560, y: 25, width: 2560, height };
    const single = panelBounds(area, side), double = panelBounds(area, side, false, 'double');
    assert.equal(double.width, single.width * 2); assert.equal(double.height, height);
    assert.equal(side === 'left' ? double.x : double.x + double.width, side === 'left' ? single.x : single.x + single.width);
    assert.equal(panelBounds(area, side, true, 'double').width, 46);
  }
  assert.equal(panelBounds({ x: 0, y: 0, width: 200, height: 900 }, 'right', false, 'double').width, 200);
});
test('queued fullscreen entry and exit restore manually moved bounds and preceding double mode', async () => {
  const f = fixture(); await f.layout.change('double'); const double = f.window.getBounds();
  const enter = f.layout.change('fullscreen'), exit = f.layout.change('double'); await Promise.all([enter, exit]);
  assert.equal(f.window.isFullScreen(), false); assert.deepEqual(f.window.getBounds(), double);
  assert.equal(f.preferences.layout, 'double'); assert.equal(f.preferences.windowLayout, 'double');
  assert.equal(f.preferences.locked, true); assert.equal(f.layout.transitioning, false);
});
test('native fullscreen exit restores bounds and saved layout', async () => {
  const f = fixture(), initial = f.window.getBounds(); await f.layout.change('fullscreen');
  f.window.setFullScreen(false); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.window.getBounds(), initial); assert.equal(f.preferences.layout, 'single');
});
test('invalid layout input changes neither preferences nor bounds; old profiles retain single mode', async () => {
  const f = fixture(), initial = f.window.getBounds();
  for (const value of [null, {}, ['double'], '__proto__', 'maximized']) {
    assert.equal(isLayout(value), false); await assert.rejects(f.layout.change(value));
    assert.equal(validPreferences({ layout: value }).layout, 'single');
  }
  assert.deepEqual(f.window.getBounds(), initial); assert.equal(f.counts().saves, 0);
});
test('failed preference write rolls back the native transition and window geometry', async () => {
  const f = fixture(), initial = f.window.getBounds(); f.layout.save = () => { throw new Error('write failed'); };
  await assert.rejects(f.layout.change('fullscreen'), /write failed/);
  assert.equal(f.window.isFullScreen(), false); assert.equal(f.preferences.layout, 'single');
  assert.deepEqual(f.window.getBounds(), initial);
});

test('Dock work-area changes during fullscreen preserve the original normal size and moved edge', async () => {
  const f = fixture(); await f.layout.change('double'); const original = f.window.getBounds();
  await f.layout.change('fullscreen'); f.area.height += 85; await f.layout.change('double');
  assert.deepEqual(f.window.getBounds(), original);
  await f.layout.change('single'); assert.equal(f.window.getBounds().width, original.width / 2);
  assert.equal(f.window.getBounds().height, original.height);
});
