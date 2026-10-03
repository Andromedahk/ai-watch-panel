const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { languages, catalogs, isLanguage, resolveLanguage, createI18n } = require('../electron/i18n.cjs');
const { validPreferences } = require('../electron/window-policy.cjs');
const { traySummary } = require('../electron/tray-summary.cjs');

test('all 17 requested languages have complete offline catalogs and matching placeholders', () => {
  assert.deepEqual(languages.map(item => item.id), ['zh-CN','zh-HK','zh-TW','en','ja','ko','ru','uk','es','pt','fr','de','it','vi','hi','he','ar']);
  const keys = Object.keys(catalogs['zh-CN']).sort();
  for (const { id, dir } of languages) {
    assert.equal(dir, ['ar','he'].includes(id) ? 'rtl' : 'ltr');
    assert.deepEqual(Object.keys(catalogs[id]).sort(), keys, id);
    for (const key of keys) {
      assert.ok(catalogs[id][key].trim(), `${id}: ${key}`);
      const placeholders = text => [...new Set(text.match(/\{p\d+\}/g) || [])].sort();
      assert.deepEqual(placeholders(catalogs[id][key]), placeholders(catalogs.en[key]), `${id}: ${key}`);
    }
  }
});
test('visible static translation calls are covered in every catalog', () => {
  const keys = new Set();
  for (const file of ['src/App.tsx','src/TestControls.tsx','src/i18n.ts','electron/main.cjs','electron/panel-tray.cjs','electron/tray-summary.cjs']) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node) {
      if (ts.isCallExpression(node) && (node.expression.getText(source) === 't' || node.expression.getText(source).endsWith('.t')) && ts.isStringLiteral(node.arguments[0])) keys.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  for (const key of keys) for (const { id } of languages) assert.ok(Object.hasOwn(catalogs[id], key), `${id}: missing ${key}`);
});
test('language preferences reject coercion, prototypes and unsupported IDs', () => {
  for (const value of [null, undefined, '', 'auto', 'EN', 'en-US', '__proto__', ['ar'], {}, 1]) {
    assert.equal(isLanguage(value), false); assert.equal(validPreferences({ language:value }).language, 'zh-CN');
  }
  for (const value of ['system', ...languages.map(item => item.id)]) assert.equal(validPreferences({language:value}).language, value);
});
test('system language matching distinguishes Chinese regions and has a predictable fallback', () => {
  for (const [system, expected] of [['zh_HK','zh-HK'],['zh-Hant-HK','zh-HK'],['zh-MO','zh-HK'],['zh-Hant','zh-TW'],['zh-TW','zh-TW'],['zh-Hans-SG','zh-CN'],['pt-BR','pt'],['en-GB','en'],['iw-IL','he'],['ar-EG','ar']]) assert.equal(resolveLanguage('system',[system]), expected);
  assert.equal(resolveLanguage('system',['xx','de-AT']), 'de');
  assert.equal(resolveLanguage('system',['xx']), 'en');
  assert.equal(resolveLanguage('zh-CN',['ar']), 'zh-CN');
});
test('locale formatting keeps exact large decimals, zero, small amounts and RTL inserts', () => {
  const en = createI18n('en'), de = createI18n('de'), ar = createI18n('ar');
  assert.equal(en.number('10000000000000000000.03',{minimumFractionDigits:2,maximumFractionDigits:2}), '10,000,000,000,000,000,000.03');
  assert.equal(de.number('12.50',{minimumFractionDigits:2,maximumFractionDigits:2}), '12,50');
  assert.equal(en.number('<0.01',{maximumFractionDigits:2}), '<0.01');
  assert.equal(en.percent(0), '0%');
  assert.equal(en.date('invalid'), '');
  for (const value of ['__proto__', 'constructor', 'toString']) { assert.equal(en.t(value), value); assert.equal(en.label(value), value); }
  assert.equal(en.label('30 分钟'), '30 min');
  assert.equal(en.label('代码审查'), 'Code review');
  assert.match(ar.t('打开 {p0}',{p0:'Codex'}), /\u2068Codex\u2069/);
});
test('translated tray summaries retain one real quota and never leak task or account details', () => {
  const snapshot = { codex:{ connection:'ready', task:'PRIVATE', detail:'SECRET', quotas:[{model:'Codex',period:'5 小时',remaining:99},{model:'Codex',period:'1 周',remaining:0}] }, deepseek:{ connection:'ready', balance:{wallets:[{currency:'CNY',total:'0.003'}]} } };
  for (const { id } of languages) {
    const rows = traySummary(snapshot,{ language:id, enabledProviders:['codex','deepseek'] });
    assert.equal(rows.length,2); assert.doesNotMatch(rows.map(row=>row.label).join(' '), /PRIVATE|SECRET|99/);
    assert.ok(rows[0].label.includes(createI18n(id).t('7 天')));
    assert.ok(rows[1].label.includes('<'));
  }
});
