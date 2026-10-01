const test = require('node:test');
const assert = require('node:assert/strict');
const { panelBounds, clampBounds, validPreferences } = require('../electron/window-policy.cjs');

test('right docking uses the full available height with the requested ratio', () => {
  const result = panelBounds({ x: 0, y: 25, width: 1920, height: 1080 });
  assert.deepEqual(result, { x: 1680, y: 25, width: 240, height: 1080 });
});
test('left docking respects negative external-display coordinates', () => {
  assert.deepEqual(panelBounds({ x: -2560, y: 0, width: 2560, height: 1440 }, 'left'), { x: -2560, y: 0, width: 320, height: 1440 });
});
test('collapsed rail keeps the right edge aligned', () => {
  assert.deepEqual(panelBounds({ x: 100, y: 30, width: 1600, height: 900 }, 'right', true), { x: 1654, y: 30, width: 46, height: 900 });
});
test('rounding preserves ratio to within one logical pixel across display sizes', () => {
  for (const height of [650, 768, 900, 1055, 1440, 2160]) {
    const result = panelBounds({ x: 0, y: 0, width: 3840, height });
    assert.ok(Math.abs(result.width * 4.5 - height) <= 2.25);
  }
});
test('restore clamps a moved rail into the available display area', () => {
  assert.deepEqual(clampBounds({ x: 1500, y: 100, width: 200, height: 900 }, { x: 0, y: 25, width: 1600, height: 900 }), { x: 1400, y: 25, width: 200, height: 900 });
});
test('unknown configuration values fall back without broadening capabilities', () => {
  assert.deepEqual(validPreferences({ side: 'anywhere', locked: 'yes', animate: 0 }), { side: 'right', locked: false, animate: true });
});
