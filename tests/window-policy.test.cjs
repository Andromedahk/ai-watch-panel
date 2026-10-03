const test = require('node:test');
const assert = require('node:assert/strict');
const { panelBounds, clampBounds, validPreferences, isProviderOrder, isEnabledProviders, PROVIDER_ORDER } = require('../electron/window-policy.cjs');

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
  assert.deepEqual(validPreferences({ side: 'anywhere', locked: 'yes', animate: 0 }), { side: 'right', locked: false, animate: true, theme: 'system', providerOrder: PROVIDER_ORDER, enabledProviders: PROVIDER_ORDER, qwenKeychainAllowed: false, kimiSource: 'code', kimiWorkApp: null, animeMode: false, providerApps: {} });
});
test('provider order rejects missing, duplicate and unknown cards and migrates old preferences', () => {
  for (const value of [null, 'codex', [], ['codex', 'codex', 'claude', 'deepseek'], ['claude', 'codex', 'antigravity', 'other']]) {
    assert.equal(isProviderOrder(value), false);
    assert.deepEqual(validPreferences({ providerOrder: value }).providerOrder, PROVIDER_ORDER);
  }
  const reversed = [...PROVIDER_ORDER].reverse();
  assert.equal(isProviderOrder(reversed), true);
  const settings = validPreferences({ side: 'left', locked: true, animate: false, theme: 'system', providerOrder: reversed });
  assert.deepEqual(settings, { side: 'left', locked: true, animate: false, theme: 'system', providerOrder: reversed, enabledProviders: PROVIDER_ORDER, qwenKeychainAllowed: false, kimiSource: 'code', kimiWorkApp: null, animeMode: false, providerApps: {} });
  reversed.reverse();
  assert.notDeepEqual(settings.providerOrder, reversed);
});

test('theme defaults to system for older settings and accepts only known modes', () => {
  for (const theme of [undefined, null, '', 'auto', 1, {}, ['dark']]) assert.equal(validPreferences({ theme }).theme, 'system');
  for (const theme of ['system', 'dark', 'light']) assert.equal(validPreferences({ theme }).theme, theme);
});
test('Qwen login access is opt-in and only the literal true enables it', () => {
  for (const value of [undefined, null, false, 0, 1, '', 'true', 'yes', {}, [true]]) {
    assert.equal(validPreferences({ qwenKeychainAllowed: value }).qwenKeychainAllowed, false);
  }
  assert.equal(validPreferences({ qwenKeychainAllowed: true }).qwenKeychainAllowed, true);
});
test('legacy four- and six-card orders append new providers without reordering existing cards', () => {
  assert.deepEqual(PROVIDER_ORDER, ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy']);
  const four = ['codex', 'deepseek', 'claude', 'antigravity'];
  const six = ['kimi', 'codex', 'deepseek', 'claude', 'zcode', 'antigravity'];
  assert.deepEqual(validPreferences({ providerOrder: four }).providerOrder, [...four, 'zcode', 'kimi', 'qwen', 'workbuddy']);
  assert.deepEqual(validPreferences({ providerOrder: six }).providerOrder, [...six, 'qwen', 'workbuddy']);
  assert.equal(isProviderOrder(four), false);
  assert.equal(isProviderOrder(six), false);
  assert.deepEqual(validPreferences({ providerOrder: six.slice(0, 5) }).providerOrder, PROVIDER_ORDER);
});

test('current eight-card configuration accepts every enabled count including zero without adding cards', () => {
  for (let length = 0; length <= PROVIDER_ORDER.length; length++) {
    const enabled = PROVIDER_ORDER.slice(0, length);
    assert.equal(isEnabledProviders(enabled), true);
    assert.deepEqual(validPreferences({ providerOrder: PROVIDER_ORDER, enabledProviders: enabled }).enabledProviders, enabled);
  }
  for (const enabledProviders of [null, 'kimi', ['kimi', 'kimi'], ['unknown']]) {
    assert.equal(isEnabledProviders(enabledProviders), false);
    assert.deepEqual(validPreferences({ enabledProviders }).enabledProviders, PROVIDER_ORDER);
  }
});

test('six-provider selection migration retains disabled cards and enables only the two new modules', () => {
  const legacy = ['kimi', 'codex', 'deepseek', 'claude', 'zcode', 'antigravity'];
  const selected = ['kimi', 'codex'];
  const migrated = validPreferences({ providerOrder: legacy, enabledProviders: selected });
  assert.deepEqual(migrated.enabledProviders, [...selected, 'qwen', 'workbuddy']);
  assert.deepEqual(validPreferences({ providerOrder: legacy, enabledProviders: [] }).enabledProviders, []);
  // Migration happens once; disabling the newly introduced modules remains durable afterward.
  assert.deepEqual(validPreferences({ providerOrder: migrated.providerOrder, enabledProviders: selected }).enabledProviders, selected);
  selected.push('claude');
  assert.deepEqual(migrated.enabledProviders, ['kimi', 'codex', 'qwen', 'workbuddy']);
  const four = ['codex', 'deepseek', 'claude', 'antigravity'];
  assert.deepEqual(validPreferences({ providerOrder: four, enabledProviders: ['codex'] }).enabledProviders, ['codex', 'zcode', 'kimi', 'qwen', 'workbuddy']);
  assert.deepEqual(validPreferences({ providerOrder: four, enabledProviders: [] }).enabledProviders, []);
});

test('anime mode is disabled for older preferences and only explicit true opts in', () => {
  for (const animeMode of [undefined, null, false, 'true', 1, {}, []]) assert.equal(validPreferences({ animeMode }).animeMode, false);
  assert.equal(validPreferences({ animeMode: true }).animeMode, true);
});

test('launch preferences retain only known provider absolute local paths', () => {
  const path = require('node:path');
  const file = path.resolve('example.app');
  const original = { claude: file, codex: 'https://example.invalid', qwen: 'relative.app', workbuddy: `${file}\0`, deepseek: true, kimi: '/', extra: file };
  assert.deepEqual(validPreferences({ providerApps: original }).providerApps, { claude: file, kimi: '/' });
  assert.deepEqual(validPreferences({ providerApps: [file] }).providerApps, {});
  assert.deepEqual(validPreferences({ providerApps: null }).providerApps, {});
  original.claude = 'changed';
  assert.equal(validPreferences({ providerApps: { codex: file } }).providerApps.codex, file);
});


test('Kimi source stays explicit and launch selections remain separate', () => {
  for (const kimiSource of [undefined, null, false, 'auto', 'Work', {}]) assert.equal(validPreferences({ kimiSource }).kimiSource, 'code');
  assert.equal(validPreferences({ kimiSource: 'work' }).kimiSource, 'work');
  const path = require('node:path'); const codeApp = path.resolve('Code.app'), workApp = path.resolve('Work.app');
  const settings = validPreferences({ kimiSource: 'work', providerApps: { kimi: codeApp }, kimiWorkApp: workApp });
  assert.equal(settings.providerApps.kimi, codeApp); assert.equal(settings.kimiWorkApp, workApp);
  assert.equal(validPreferences({ kimiWorkApp: 'https://example.invalid' }).kimiWorkApp, null);
});
