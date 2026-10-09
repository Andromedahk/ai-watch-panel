const { traySummary } = require('./tray-summary.cjs');
const { validPreferences } = require('./window-policy.cjs');
const { resolveLanguage } = require('./i18n.cjs');

const NAMES = Object.freeze({
  claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity',
  deepseek: 'DeepSeek Harness', zcode: 'ZCode', kimi: 'Kimi Code',
  qwen: '千问', workbuddy: 'WorkBuddy',
});
const ACTIVITIES = new Set(['running', 'waiting', 'idle', 'unknown', 'offline']);

function safeText(value) {
  return typeof value === 'string'
    ? value.replace(/[\x00-\x1f\x7f&\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
    : '';
}
function weekly(value) {
  return /^(?:1(?:周|週|w|weeks?)|7(?:天|日|d|days?)|weekly|(?:每|本)?(?:周|週)(?:额度|配额)?)$/i.test(safeText(value).replace(/\s/g, ''));
}
function validTime(value, now) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now ? new Date(time).toISOString() : null;
}
function selectedQuota(id, quotas) {
  if (!Array.isArray(quotas)) return null;
  let candidates = quotas.filter(quota => quota && typeof quota === 'object');
  if (id === 'codex') {
    const primary = candidates.filter(quota => !/审查|review/i.test(safeText(quota.model)));
    if (primary.length) candidates = primary;
  }
  const week = candidates.find(quota => weekly(quota.period));
  if (week) return week;
  if (id === 'antigravity') return candidates.find(quota => /gemini.*pro/i.test(safeText(quota.model)))
    || candidates.find(quota => /gemini/i.test(safeText(quota.model))) || candidates[0] || null;
  if (id === 'kimi') return candidates.find(quota => /订阅/.test(safeText(quota.period))) || candidates[0] || null;
  return candidates[0] || null;
}
function selectedCredit(credits) {
  const candidates = Array.isArray(credits?.items) ? credits.items.filter(item => item && typeof item === 'object') : [];
  return candidates.find(item => /总|全部/.test(safeText(item.label)))
    || candidates.find(item => /套餐|订阅|企业/.test(safeText(item.label))) || candidates[0] || null;
}
function quotaForSummary(id, status) {
  if (id === 'deepseek') return null;
  const quota = selectedQuota(id, status?.quotas);
  if (quota && weekly(quota.period)) return quota;
  if (selectedCredit(status?.credits)) return null;
  return quota;
}
function quotaRemaining(quota) {
  const value = quota?.remaining;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
function metricStale(id, status, quota) {
  if (status.connection !== 'ready') return true;
  if (id === 'deepseek') return status.balance?.stale === true;
  if (quota) return quota.stale === true;
  if (selectedCredit(status.credits)) return status.credits?.stale === true;
  return false;
}
function summaryFor(id, status, preferences) {
  const row = traySummary({ [id]: status }, { ...preferences, providerOrder: [id], enabledProviders: [id] })[0];
  if (!row || typeof row.label !== 'string') return '额度未知';
  const separator = row.label.indexOf('    ');
  // traySummary owns provider-specific selection and formatting. WidgetKit does
  // not need its bidi isolates because the row is structured rather than a menu label.
  return (separator >= 0 ? row.label.slice(separator + 4) : row.label)
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
}

function makeWidgetSnapshot(snapshot, preferences, { now = Date.now(), isTestData = false } = {}) {
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const settings = validPreferences(preferences);
  const language = resolveLanguage(settings.language);
  const rows = settings.providerOrder.filter(id => settings.enabledProviders.includes(id)).slice(0, 8).map((id) => {
    let status = snapshot && typeof snapshot === 'object' ? snapshot[id] : undefined;
    const work = id === 'kimi' && settings.kimiSource === 'work';
    if (id === 'kimi' && status && (status.kimiSource || 'code') !== (work ? 'work' : 'code')) status = undefined;
    const name = work ? 'Kimi Work' : id === 'qwen' && !language.startsWith('zh') ? 'Qwen' : NAMES[id];
    if (!status || typeof status !== 'object') return {
      id, name, summary: summaryFor(id, undefined, { ...settings, language }), remaining: null,
      activity: 'unknown', stale: false, observedAt: null,
    };
    const authRequired = status.connection === 'auth-required';
    const quota = authRequired ? null : quotaForSummary(id, status);
    return {
      id, name, summary: summaryFor(id, status, { ...settings, language }),
      remaining: authRequired ? null : quotaRemaining(quota),
      activity: authRequired || work || !ACTIVITIES.has(status.activity) ? 'unknown' : status.activity,
      stale: authRequired ? false : metricStale(id, status, quota),
      observedAt: authRequired ? null : validTime(status.observedAt, timestamp),
    };
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date(timestamp).toISOString(),
    sampledAt: validTime(snapshot?.sampledAt, timestamp),
    theme: settings.theme,
    language,
    isTestData: isTestData === true,
    rows,
  };
}

module.exports = { makeWidgetSnapshot };
