const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const previousLoaders = new Map(['.ts', '.tsx', '.css'].map(extension => [extension, require.extensions[extension]]));
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  }, fileName: filename });
  module._compile(result.outputText, filename);
};
require.extensions['.css'] = () => {};
const { screenTrendSeries, screenTrendPoint } = require('../src/screen-trend-data.ts');
const { ScreenQuotaTrend } = require('../src/ScreenQuotaTrend.tsx');
const { DAY } = require('../src/journal.ts');
for (const [extension, loader] of previousLoaders) {
  if (loader) require.extensions[extension] = loader;
  else delete require.extensions[extension];
}

const now = Date.now();
const view = id => ({ id, name: id, color: '#88bbcc' });
const journal = samples => ({ events: [], last: {}, samples });

test('screen history rejects future, expired, malformed and non-percentage readings without inventing missing data', () => {
  const input = journal({ codex: [[now - DAY - 1, 20], [now + 1, 90], [now, -1], [now, 101], [now, null], [now, NaN], [Infinity, 20], [now, '40'], null, [now - 1000, 0], [now, 100]],
    deepseek: [], claude: [[now - 1000, 40], [now, 35]] });
  const series = screenTrendSeries([view('codex'), view('deepseek')], input, now);
  assert.deepEqual(series.map(row => row.view.id), ['codex'], 'disabled and balance-only providers never become fake zero curves');
  assert.deepEqual(series[0].points, [[now - 1000, 0], [now, 100]], 'real zero and full quota remain valid');
});

test('screen history sorts and deduplicates observations while retaining the true last timestamp', () => {
  const input = journal({ codex: [[now - 100, 25], [now - DAY, 90], [now - 100, 20], [now - 200, 40]] });
  const original = structuredClone(input);
  const [series] = screenTrendSeries([view('codex')], input, now);
  assert.deepEqual(series.points, [[now - DAY, 90], [now - 200, 40], [now - 100, 20]]);
  assert.deepEqual(input, original, 'rendering does not rewrite the local or host journal');
  assert.deepEqual(screenTrendPoint([now - DAY, 100], now), [1, 3]);
  assert.deepEqual(screenTrendPoint([now - DAY / 2, 50], now), [50, 50]);
  assert.deepEqual(screenTrendPoint([now, 0], now), [99, 97]);
  assert.ok(screenTrendPoint(series.points.at(-1), now)[0] < 99, 'an old observation is not extended to the present');
});

function render(views, samples, props = {}) {
  return renderToStaticMarkup(React.createElement(ScreenQuotaTrend, { views, journal: journal(samples), ...props }));
}

test('a single history sample is a point, not a fabricated curve, and empty history remains explicit', () => {
  const one = render([view('codex')], { codex: [[now - 1000, 42]] });
  assert.match(one, /data-series-count="1"/);
  assert.match(one, /class="screen-trend-point"/);
  assert.doesNotMatch(one, /<polyline/);
  assert.match(one, /42%/);
  const empty = render([view('codex')], {});
  assert.match(empty, /data-history-empty="true"/);
  assert.match(empty, /记录中，稍后显示趋势/);
  assert.doesNotMatch(empty, /screen-trend-series|screen-trend-point|<polyline/);
});

test('history keeps a readable four-series page, test labels and no interactive controls', () => {
  const ids = ['claude', 'codex', 'antigravity', 'kimi', 'zcode'];
  const html = render(ids.map(view), Object.fromEntries(ids.map(id => [id, [[now - 60000, 90], [now - 1000, 25]]])), { testing: true });
  assert.match(html, /data-series-count="4"/);
  assert.match(html, /测试数据/);
  assert.equal((html.match(/<polyline/g) || []).length, 4);
  assert.doesNotMatch(html, /<button|<input|<select|tabindex|data-provider="zcode"/);
  assert.match(html, /1 \/ 2/);
});
