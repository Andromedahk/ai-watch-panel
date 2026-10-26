const test = require('node:test');
const assert = require('node:assert/strict');
const { panelBounds, clampBounds, displayGeometry, validPreferences, isProviderOrder, isEnabledProviders, isInsights, isInsightOrder, INSIGHT_ORDER, PROVIDER_ORDER } = require('../electron/window-policy.cjs');

test('Dock work-area changes preserve placement; monitor geometry changes still resize', () => {
  const original = { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 2, rotation: 0,
    workArea: { x: 0, y: 25, width: 2560, height: 1370 } };
  assert.equal(displayGeometry(original), displayGeometry({ ...original, workArea: { ...original.workArea, height: 1400 } }));
  for (const changed of [{ ...original, scaleFactor: 1 }, { ...original, rotation: 90 },
    { ...original, bounds: { ...original.bounds, x: -2560 } }, { ...original, bounds: { ...original.bounds, height: 2160 } }]) {
    assert.notEqual(displayGeometry(original), displayGeometry(changed));
  }
});

test('right docking uses the full available height with a readable width', () => {
  const result = panelBounds({ x: 0, y: 25, width: 1920, height: 1080 });
  assert.deepEqual(result, { x: 1602, y: 25, width: 318, height: 1080 });
});
test('left docking respects negative external-display coordinates', () => {
  assert.deepEqual(panelBounds({ x: -2560, y: 0, width: 2560, height: 1440 }, 'left'), { x: -2560, y: 0, width: 420, height: 1440 });
});
test('collapsed rail keeps the right edge aligned', () => {
  assert.deepEqual(panelBounds({ x: 100, y: 30, width: 1600, height: 900 }, 'right', true), { x: 1636, y: 30, width: 64, height: 900 });
});
test('panel width tracks height but stays within the readable range', () => {
  for (const height of [650, 768, 900, 1055, 1440, 2160]) {
    const result = panelBounds({ x: 0, y: 0, width: 3840, height });
    assert.ok(result.width >= 300 && result.width <= 420, `${height}: ${result.width}`);
    assert.equal(result.width, Math.max(300, Math.min(420, Math.round(height / 3.4))));
  }
  assert.equal(panelBounds({ x: 0, y: 0, width: 280, height: 900 }).width, 280);
});
test('skin preference accepts only the three known skins', () => {
  for (const skin of ['watch', 'dial', 'party']) assert.equal(validPreferences({ skin }).skin, skin);
  for (const skin of [undefined, 'classic', '__proto__', 1, ['dial']]) assert.equal(validPreferences({ skin }).skin, 'watch');
});
test('restore clamps a moved rail into the available display area', () => {
  assert.deepEqual(clampBounds({ x: 1500, y: 100, width: 200, height: 900 }, { x: 0, y: 25, width: 1600, height: 900 }), { x: 1400, y: 25, width: 200, height: 900 });
});
test('unknown configuration values fall back without broadening capabilities', () => {
  assert.deepEqual(validPreferences({ side: 'anywhere', locked: 'yes', animate: 0 }), { side: 'right', locked: false, animate: true, language: 'zh-CN', theme: 'system', providerOrder: PROVIDER_ORDER, enabledProviders: PROVIDER_ORDER, qwenKeychainAllowed: false, kimiSource: 'code', widgetsEnabled: false, claudeSource: 'desktop', claudeNetworkAllowed: false, claudeHooksEnabled: false, cacheCleanupPending: false, kimiWorkApp: null, animeMode: false, insights: { timeline: true, resets: true, trend: true, mascot: true }, insightOrder: INSIGHT_ORDER, mascotInterval: 15, syncRole: 'off', syncPort: 47321, skin: 'watch', layout: 'single', windowLayout: 'single', providerApps: {} });
});
test('provider order rejects missing, duplicate and unknown cards and migrates old preferences', () => {
  for (const value of [null, 'codex', [], ['codex', 'codex', 'claude', 'deepseek'], ['claude', 'codex', 'antigravity', 'other']]) {
    assert.equal(isProviderOrder(value), false);
    assert.deepEqual(validPreferences({ providerOrder: value }).providerOrder, PROVIDER_ORDER);
  }
  const reversed = [...PROVIDER_ORDER].reverse();
  assert.equal(isProviderOrder(reversed), true);
  const settings = validPreferences({ side: 'left', locked: true, animate: false, language: 'zh-CN', theme: 'system', providerOrder: reversed });
  assert.deepEqual(settings, { side: 'left', locked: true, animate: false, language: 'zh-CN', theme: 'system', providerOrder: reversed, enabledProviders: PROVIDER_ORDER, qwenKeychainAllowed: false, kimiSource: 'code', widgetsEnabled: false, claudeSource: 'desktop', claudeNetworkAllowed: false, claudeHooksEnabled: false, cacheCleanupPending: false, kimiWorkApp: null, animeMode: false, insights: { timeline: true, resets: true, trend: true, mascot: true }, insightOrder: INSIGHT_ORDER, mascotInterval: 15, syncRole: 'off', syncPort: 47321, skin: 'watch', layout: 'single', windowLayout: 'single', providerApps: {} });
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
test('Claude network queries are opt-in and reject coercion in saved preferences', () => {
  for (const value of [undefined, null, false, 0, 1, '', 'true', 'yes', {}, [true]]) {
    assert.equal(validPreferences({ claudeNetworkAllowed: value }).claudeNetworkAllowed, false);
  }
  assert.equal(validPreferences({ claudeNetworkAllowed: true }).claudeNetworkAllowed, true);
  for (const value of ['true', 1, null, {}]) assert.equal(validPreferences({ claudeHooksEnabled: value }).claudeHooksEnabled, false);
  assert.equal(validPreferences({ claudeHooksEnabled: true }).claudeHooksEnabled, true);
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
test('lower-half insights default on, keep explicit choices and reject malformed IPC values', () => {
  const all = { timeline: true, resets: true, trend: true, mascot: true };
  for (const insights of [undefined, null, 'all', [], 1]) assert.deepEqual(validPreferences({ insights }).insights, all);
  assert.deepEqual(validPreferences({ insights: { trend: false, mascot: false, extra: false } }).insights, { ...all, trend: false, mascot: false });
  assert.equal(isInsights({ ...all, mascot: false }), true);
  for (const value of [null, [], {}, { ...all, timeline: 'false' }, { ...all, extra: true }, { timeline: true, resets: true, trend: true }]) assert.equal(isInsights(value), false);
});

test('lower-half ordering migrates old preferences and strictly validates full permutations', () => {
  assert.deepEqual(INSIGHT_ORDER, ['resets', 'trend', 'timeline', 'mascot']);
  for (const value of [undefined, null, {}, 'timeline', [], ['timeline'], ['resets', 'trend', 'timeline', 'timeline'], ['resets', 'trend', 'timeline', 'other']]) {
    assert.equal(isInsightOrder(value), false);
    assert.deepEqual(validPreferences({ insightOrder: value }).insightOrder, INSIGHT_ORDER);
  }
  const order = ['mascot', 'timeline', 'resets', 'trend'];
  assert.equal(isInsightOrder(order), true);
  const preferences = validPreferences({ insightOrder: order, insights: { mascot: false, trend: false } });
  assert.deepEqual(preferences.insightOrder, order);
  assert.equal(preferences.insights.mascot, false);
  // Preferences own the array even when some panels are hidden.
  order.reverse();
  assert.deepEqual(preferences.insightOrder, ['mascot', 'timeline', 'resets', 'trend']);
  const roundTrip = validPreferences(JSON.parse(JSON.stringify(preferences)));
  assert.deepEqual(roundTrip.insightOrder, preferences.insightOrder);
  const defaults = validPreferences({}); defaults.insightOrder.reverse();
  assert.deepEqual(validPreferences({}).insightOrder, INSIGHT_ORDER);
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

 test('widget sync is opt-in and requires a literal boolean', () => {
  for (const value of [undefined, null, false, 1, 'true', {}, [true]]) assert.equal(validPreferences({ widgetsEnabled: value }).widgetsEnabled, false);
  assert.equal(validPreferences({ widgetsEnabled: true }).widgetsEnabled, true);
});

test('LAN sync stays off unless a valid role is saved, and ports stay unprivileged', () => {
  for (const role of ['off', 'host', 'client']) assert.equal(validPreferences({ syncRole: role }).syncRole, role);
  for (const role of [undefined, 'server', 'HOST', true, ['host']]) assert.equal(validPreferences({ syncRole: role }).syncRole, 'off');
  assert.equal(validPreferences({ syncPort: 50000 }).syncPort, 50000);
  for (const port of [80, 1023, 65536, '47321', 47321.5, null]) assert.equal(validPreferences({ syncPort: port }).syncPort, 47321);
});
