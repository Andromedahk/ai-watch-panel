const RATIO = 4.5;
const COLLAPSED_WIDTH = 46;
const PROVIDER_ORDER = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi'];
function isEnabledProviders(value) {
  return Array.isArray(value) && new Set(value).size === value.length && value.every(id => PROVIDER_ORDER.includes(id));
}
function migrateOrder(value) {
  if (isProviderOrder(value)) return [...value];
  const legacy = PROVIDER_ORDER.slice(0, 4);
  return Array.isArray(value) && value.length === 4 && new Set(value).size === 4 && value.every(id => legacy.includes(id))
    ? [...value, 'zcode', 'kimi'] : [...PROVIDER_ORDER];
}
const isTheme = value => ['system', 'light', 'dark'].includes(value);
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

function validPreferences(value) {
  return {
    side: value?.side === 'left' ? 'left' : 'right',
    locked: value?.locked === true,
    animate: value?.animate !== false,
    theme: isTheme(value?.theme) ? value.theme : 'system',
    providerOrder: migrateOrder(value?.providerOrder),
    enabledProviders: isEnabledProviders(value?.enabledProviders) ? [...value.enabledProviders] : [...PROVIDER_ORDER],
  };
}

module.exports = { panelBounds, clampBounds, validPreferences, isTheme, isProviderOrder, isEnabledProviders, PROVIDER_ORDER, RATIO, COLLAPSED_WIDTH };
