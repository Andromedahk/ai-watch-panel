const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Render the real shared component; no copied mascot or speech implementation.
const previousLoaders = new Map(['.ts', '.tsx'].map(extension => [extension, require.extensions[extension]]));
for (const extension of previousLoaders.keys()) require.extensions[extension] = (module, filename) => {
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  }, fileName: filename });
  module._compile(result.outputText, filename);
};
const { Mascot } = require('../src/view/insights.tsx');
for (const [extension, loader] of previousLoaders) {
  if (loader) require.extensions[extension] = loader;
  else delete require.extensions[extension];
}

function view(id, { state = 'idle', attention = false, tightest = null, waitingReason } = {}) {
  return { id, name: id, color: '#dba487', state, attention, tightest,
    provider: { id, name: id, image: `${id}.svg`, local: { waitingReason } } };
}
function render(views, props = {}) {
  return renderToStaticMarkup(React.createElement(Mascot, {
    views, anime: true, image: () => undefined, interval: 15, paused: false,
    ...props,
  }));
}

test('passive mascot keeps its original status bubble and timer without interactive targets', () => {
  const html = render([view('claude')], { readOnly: true,
    sortHandle: React.createElement('button', {}, 'sort'), sortProps: { tabIndex: 0 },
    onOpen: () => { throw new Error('passive display cannot open an application'); },
  });
  assert.match(html, /data-read-only="true"/);
  assert.match(html, /data-mood="rest"/);
  assert.match(html, /大家都在休息，喝杯茶吧/);
  assert.match(html, /class="mascot-bubble" role="status"/);
  assert.match(html, /class="mascot-timer"/);
  assert.match(html, /<div class="mascot-figure"/);
  assert.doesNotMatch(html, /<button|tabindex|mascot-refresh|insight-sort-handle/);
});

test('desktop mascot keeps manual quips and application launching; interval zero still disables automatic refresh', () => {
  const html = render([view('codex')], { interval: 0, onOpen() {} });
  assert.match(html, /<button type="button" class="mascot-refresh"/);
  assert.match(html, /<button type="button" class="mascot-figure"/);
  assert.doesNotMatch(html, /class="mascot-timer"|data-auto-refresh/);
  assert.match(html, /class="mascot-bubble"/);
});

test('read-only output preserves waiting, running, quota and empty-state speech priority', () => {
  const waiting = render([view('claude', { state: 'running' }), view('codex', { state: 'waiting', attention: true, waitingReason: 'approval' })], { readOnly: true });
  assert.match(waiting, /data-mood="alert"/);
  assert.match(waiting, /codex 在等你授权哦/);
  const running = render([view('claude', { state: 'running' }), view('codex', { tightest: 5 })], { readOnly: true });
  assert.match(running, /claude 正在努力干活/);
  const low = render([view('codex', { tightest: 5 })], { readOnly: true });
  assert.match(low, /data-mood="worried"/);
  assert.match(low, /codex 的额度只剩 5% 了/);
  const empty = render([], { readOnly: true });
  assert.match(empty, /还没有助手上线/);
  assert.doesNotMatch(empty, /mascot-timer|<button/);
});
