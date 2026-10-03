// Shared, offline catalogs: both the sandboxed view and native menus use these.
const catalogs = {
  'zh-CN': require('./locales/zh-CN.json'), 'zh-HK': require('./locales/zh-HK.json'), 'zh-TW': require('./locales/zh-TW.json'),
  en: require('./locales/en.json'), ja: require('./locales/ja.json'), ko: require('./locales/ko.json'),
  ru: require('./locales/ru.json'), uk: require('./locales/uk.json'), es: require('./locales/es.json'), pt: require('./locales/pt.json'),
  fr: require('./locales/fr.json'), de: require('./locales/de.json'), it: require('./locales/it.json'), vi: require('./locales/vi.json'),
  hi: require('./locales/hi.json'), he: require('./locales/he.json'), ar: require('./locales/ar.json'),
};
const languages = [
  ['zh-CN', '简体中文'], ['zh-HK', '繁體中文（香港）'], ['zh-TW', '正體中文（台灣）'],
  ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['ru', 'Русский'], ['uk', 'Українська'],
  ['es', 'Español'], ['pt', 'Português'], ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano'],
  ['vi', 'Tiếng Việt'], ['hi', 'हिन्दी'], ['he', 'עברית'], ['ar', 'العربية'],
].map(([id, name]) => ({ id, name, dir: ['he', 'ar'].includes(id) ? 'rtl' : 'ltr' }));
const isLanguage = value => typeof value === 'string' && (value === 'system' || Object.hasOwn(catalogs, value));
function resolveLanguage(value, system = []) {
  if (isLanguage(value) && value !== 'system') return value;
  for (const candidate of Array.isArray(system) ? system : [system]) {
    if (typeof candidate !== 'string') continue;
    const tag = candidate.replace(/_/g, '-').toLowerCase(), primary = tag.split('-')[0];
    if (primary === 'zh') {
      if (/-(hk|mo)(-|$)/.test(tag)) return 'zh-HK';
      if (/-tw(-|$)|-hant(-|$)/.test(tag)) return 'zh-TW';
      return 'zh-CN';
    }
    const normalized = primary === 'iw' ? 'he' : primary;
    if (Object.hasOwn(catalogs, normalized)) return normalized;
  }
  return 'en';
}
const isolate = value => `\u2068${value}\u2069`;
function createI18n(language, system) {
  const locale = resolveLanguage(language, system);
  const dir = ['ar', 'he'].includes(locale) ? 'rtl' : 'ltr';
  const dictionary = catalogs[locale];
  const number = (value, options = {}) => {
    const text = String(value);
    const small = text.match(/^(−?<)(.+)$/);
    const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 3, ...options }).format(small ? small[2] : value);
    return small ? small[1] + formatted : formatted;
  };
  const percent = value => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value / 100);
  const date = (value, options) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat(locale, options ? { hourCycle: 'h23', ...options } : { dateStyle: 'short', timeStyle: 'short' }).format(parsed) : '';
  };
  function t(key, params = {}) {
    const template = Object.hasOwn(dictionary, key) ? dictionary[key] : Object.hasOwn(catalogs.en, key) ? catalogs.en[key] : key;
    return template.replace(/\{(p\d+|[A-Za-z]+)\}/g, (match, name) => {
      if (!Object.hasOwn(params, name)) return match;
      const raw = params[name];
      const value = typeof raw === 'number' ? number(raw) : Object.hasOwn(dictionary, String(raw)) ? dictionary[String(raw)] : Object.hasOwn(catalogs.en, String(raw)) ? catalogs.en[String(raw)] : String(raw);
      return dir === 'rtl' ? isolate(value) : value;
    });
  }
  // Standardized display fields only; preserve vendor names and account math.
  function label(value) {
    if (typeof value !== 'string') return '';
    if (Object.hasOwn(dictionary, value)) return dictionary[value];
    if (locale === 'zh-CN') return value;
    return value.replace(/\bOAuth 应用\b/g, 'OAuth')
      .replace(/(\d+)\s*(小时|分钟|天|周|月)(?:额度)?/g, (_, count, unit) => number(Number(count), { style: 'unit', unit: { 小时: 'hour', 分钟: 'minute', 天: 'day', 周: 'week', 月: 'month' }[unit], unitDisplay: 'short' }))
      .replace(/积分池\s*(\d+)/g, (_, count) => `${t('积分')} ${number(Number(count))}`)
      .replace(/(体验版|标准版|青春版|高级版|旗舰版|企业版)积分/g, (_, plan) => `${t(plan)} · ${t('积分')}`)
      .replace(/企业积分（不限量）/g, `${t('企业积分')} (∞)`)
      .replace(/(?:测试|演示)模型[^·]*(?:·.*)?$/, t('测试'));
  }
  return { language: locale, dir, t, label, number, percent, date, isolate };
}
module.exports = { catalogs, languages, isLanguage, resolveLanguage, createI18n };
