const Big = require('big.js');
const { createI18n } = require('./i18n.cjs');
const { PROVIDER_ORDER } = require('./window-policy.cjs');

const NAMES = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity',
  deepseek: 'DeepSeek Harness', zcode: 'ZCode', kimi: 'Kimi Code', qwen: '千问', workbuddy: 'WorkBuddy' };
const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f&\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
const weekly = value => /^(?:1(?:周|週|w|weeks?)|7(?:天|日|d|days?)|weekly|(?:每|本)?(?:周|週)(?:额度|配额)?)$/i.test(text(value).replace(/\s/g, ''));

function decimal(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length > 128) return null;
  try { const number = new Big(value); return number.gte(0) ? number : null; } catch { return null; }
}
function amount(value, currency = '') {
  const number = decimal(value);
  if (!number) return null;
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '';
  if (number.gt(0) && number.lt(.01)) return `<${symbol}0.01`;
  const rendered = currency ? number.toFixed(2) : number.round(2).toFixed();
  const [whole, fraction] = rendered.split('.');
  return `${symbol}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
}
function selectQuota(id, quotas) {
  if (!Array.isArray(quotas)) return null;
  let candidates = quotas.filter(quota => quota && typeof quota === 'object');
  if (id === 'codex') {
    const primary = candidates.filter(quota => !/审查|review/i.test(text(quota.model)));
    if (primary.length) candidates = primary;
  }
  const week = candidates.find(quota => weekly(quota.period));
  if (week) return week;
  if (id === 'antigravity') return candidates.find(quota => /gemini.*pro/i.test(text(quota.model)))
    || candidates.find(quota => /gemini/i.test(text(quota.model))) || candidates[0] || null;
  if (id === 'kimi') return candidates.find(quota => /订阅/.test(text(quota.period))) || candidates[0] || null;
  return candidates[0] || null;
}
function quotaSummary(id, quota, status) {
  const scope = weekly(quota.period) ? '7 天' : id === 'antigravity' ? text(quota.model)
    : id === 'kimi' && /订阅/.test(text(quota.period)) ? '订阅积分' : text(quota.period) || '主要额度';
  const value = typeof quota.remaining === 'number' && Number.isFinite(quota.remaining)
    && quota.remaining >= 0 && quota.remaining <= 100 ? quota.remaining : null;
  if (value === null) return `${scope} · 未知`;
  const stale = quota.stale || status.connection !== 'ready';
  return `${scope} · ${stale ? '历史剩余' : '剩余'} ${value}%${stale ? '（非实时）' : ''}`;
}
function summarize(id, status) {
  if (!status) return '额度未知 · 尚未读取';
  // Never keep another account's cached value after login has been cleared.
  if (status.connection === 'auth-required') return '额度未知 · 待登录';
  if (id === 'deepseek') {
    const wallets = Array.isArray(status.balance?.wallets) ? status.balance.wallets : [];
    const wallet = wallets.find(item => item.currency === 'CNY') || wallets.find(item => item.currency === 'USD');
    const value = wallet && amount(wallet.total, wallet.currency);
    if (!value) return '余额未知';
    const stale = status.balance.stale || status.connection !== 'ready';
    return `${stale ? '历史余额' : '余额'} ${value} ${wallet.currency}${stale ? '（非实时）' : ''}`;
  }
  const quota = selectQuota(id, status.quotas);
  if (quota && weekly(quota.period)) return quotaSummary(id, quota, status);
  const credits = Array.isArray(status.credits?.items) ? status.credits.items : [];
  const primary = credits.find(item => /总|全部/.test(text(item.label)))
    || credits.find(item => /套餐|订阅|企业/.test(text(item.label))) || credits[0];
  if (primary) {
    const value = amount(primary.remaining);
    if (!value) return '主要积分 / 额度未知';
    const stale = status.credits.stale || status.connection !== 'ready';
    // This is a single existing pool or total; never sum reward points twice.
    return `${text(primary.label) || '主要积分'} · ${stale ? '历史剩余' : '剩余'} ${value} ${text(primary.unit)}${stale ? '（非实时）' : ''}`;
  }
  if (quota) return quotaSummary(id, quota, status);
  return id === 'claude' ? status?.claudeSource === 'desktop' ? '额度未知' : 'Code 额度暂不可用' : id === 'qwen' || id === 'workbuddy' ? '积分 / 额度未知' : '额度未知';
}

function translateSummary(value, i18n) {
  if (i18n.language === 'zh-CN') return value;
  const { t, label, number, percent, isolate } = i18n;
  const quota = value.match(/^(.*?) · (历史剩余|剩余) ([\d.]+)%(?:（非实时）)?$/);
  if (quota) return `${isolate(label(quota[1]))} · ${t(quota[2] === '历史剩余' ? '历史' : '剩余')} ${isolate(percent(Number(quota[3])))}`;
  const credit = value.match(/^(.*?) · (历史剩余|剩余) ([\d,.]+) (.*?)(?:（非实时）)?$/);
  if (credit) return `${label(credit[1])} · ${t(credit[2] === '历史剩余' ? '历史' : '剩余')} ${isolate(number(credit[3].replace(/,/g, ''), { maximumFractionDigits: 2 }))} ${label(credit[4])}`;
  const balance = value.match(/^(历史余额|余额) (<)?([¥$])([\d,.]+) (CNY|USD)(?:（非实时）)?$/);
  if (balance) return `${t(balance[1] === '历史余额' ? '历史余额' : '账号余额')} ${isolate(`${balance[2] || ''}${balance[3]}${number(balance[4].replace(/,/g, ''), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${balance[5]}`)}`;
  return value.split(' · ').map(label).join(' · ');
}
function traySummary(snapshot, preferences) {
  const i18n = createI18n(preferences?.language || 'zh-CN');
  const order = Array.isArray(preferences?.providerOrder) ? preferences.providerOrder : PROVIDER_ORDER;
  const enabled = Array.isArray(preferences?.enabledProviders) ? preferences.enabledProviders : PROVIDER_ORDER;
  return [...new Set(order)].filter(id => PROVIDER_ORDER.includes(id) && enabled.includes(id)).map(id => {
    const work = id === 'kimi' && preferences?.kimiSource === 'work';
    let status = snapshot?.[id];
    if (id === 'kimi' && status && (status.kimiSource || 'code') !== (work ? 'work' : 'code')) status = undefined;
    if (id === 'claude' && status && (status.claudeSource || 'code') !== (preferences?.claudeSource || 'code')) status = undefined;
    const name = id === 'claude' && preferences?.claudeSource === 'desktop' ? 'Claude' : work ? 'Kimi Work' : id === 'qwen' && i18n.language !== 'zh-CN' ? i18n.language.startsWith('zh') ? '千問' : 'Qwen' : NAMES[id];
    return { id, label: `${i18n.dir === 'rtl' ? i18n.isolate(name) : name}    ${translateSummary(summarize(id, status), i18n)}` };
  });
}
module.exports = { traySummary };
