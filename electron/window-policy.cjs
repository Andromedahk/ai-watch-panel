const path = require('node:path');
const { isLanguage } = require('./i18n.cjs');
const RATIO = 4.5;
const COLLAPSED_WIDTH = 46;
// Work-area changes from the Dock/menu bar are not monitor geometry changes.
function displayGeometry(display) {
  const { x, y, width, height } = display.bounds;
  return JSON.stringify({ x, y, width, height, scaleFactor: display.scaleFactor, rotation: display.rotation });
}
const PROVIDER_ORDER = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];
function isEnabledProviders(value) {
  return Array.isArray(value) && new Set(value).size === value.length && value.every(id => PROVIDER_ORDER.includes(id));
}
function legacyOrder(value) {
  return Array.isArray(value) && [4, 6].includes(value.length) && new Set(value).size === value.length
    && value.every(id => PROVIDER_ORDER.slice(0, value.length).includes(id));
}
function migrateOrder(value) {
  if (isProviderOrder(value)) return [...value];
  return legacyOrder(value) ? [...value, ...PROVIDER_ORDER.filter(id => !value.includes(id))] : [...PROVIDER_ORDER];
}
function migrateEnabled(value) {
  if (!isEnabledProviders(value?.enabledProviders)) return [...PROVIDER_ORDER];
  const enabled = [...value.enabledProviders];
  if (enabled.length && legacyOrder(value.providerOrder)) {
    for (const id of PROVIDER_ORDER) if (!value.providerOrder.includes(id) && !enabled.includes(id)) enabled.push(id);
  }
  return enabled;
}
const isTheme = value => ['system', 'light', 'dark'].includes(value);
const isKimiSource = value => ['code', 'work'].includes(value);
function isProviderOrder(value) {
  return Array.isArray(value) && value.length === PROVIDER_ORDER.length
    && new Set(value).size === PROVIDER_ORDER.length && value.every(id => PROVIDER_ORDER.includes(id));
}

function panelBounds(workArea, side = 'right', collapsed = false) {
  const width = collapsed ? COLLAPSED_WIDTH : Math.max(1, Math.round(workArea.height / RATIO));
  return {
    x: side === 'left' ? workArea.x : workArea.x + workArea.width - width,
    y: workArea.y, width, height: workArea.height,
  };
}

function clampBounds(bounds, workArea) {
  return {
    ...bounds,
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - bounds.width))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - bounds.height))),
  };
}

function validProviderApps(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const apps = {};
  for (const id of PROVIDER_ORDER) {
    const file = value[id];
    if (typeof file === 'string' && file.length <= 4096 && !file.includes('\0') && path.isAbsolute(file)) apps[id] = file;
  }
  return apps;
}

function validPreferences(value) {
  return {
    side: value?.side === 'left' ? 'left' : 'right',
    locked: value?.locked === true,
    animate: value?.animate !== false,
    language: isLanguage(value?.language) ? value.language : 'zh-CN',
    theme: isTheme(value?.theme) ? value.theme : 'system',
    qwenKeychainAllowed: value?.qwenKeychainAllowed === true,
    kimiSource: isKimiSource(value?.kimiSource) ? value.kimiSource : 'code',
    widgetsEnabled: value?.widgetsEnabled === true,
    kimiWorkApp: validProviderApps({ kimi: value?.kimiWorkApp }).kimi || null,
    animeMode: value?.animeMode === true,
    providerApps: validProviderApps(value?.providerApps),
    providerOrder: migrateOrder(value?.providerOrder),
    enabledProviders: migrateEnabled(value),
  };
}

module.exports = { panelBounds, clampBounds, displayGeometry, validPreferences, isTheme, isLanguage, isKimiSource, isProviderOrder, isEnabledProviders, PROVIDER_ORDER, RATIO, COLLAPSED_WIDTH };
