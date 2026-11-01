const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ScreenStream } = require('../electron/screen-stream.cjs');

test('Studio brightness capability controls the actual slider and timeout gives firmware-neutral advice', async () => {
  const env = { RYUO_STUDIO_BRIDGE: process.execPath, RYUO_ADB: __filename,
    RYUO_FFMPEG: require.resolve('../electron/screen-stream.cjs'), RYUO_AI_WATCH_SERIAL: 'fixture-device',
    RYUO_AI_WATCH_APP_ROOT: __dirname };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const windowDescriptor = Object.getOwnPropertyDescriptor(global, 'window');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  const previousLoaders = new Map(['.ts', '.tsx'].map(extension => [extension, require.extensions[extension]]));
  const realSetTimeout = global.setTimeout;
  let sent = 0;
  const config = { enabled: false, device: 'ryuo4', width: 2240, height: 1080, fps: 30,
    bitrateMbps: 6, pageSeconds: 12, showMascot: true, agentsPerPage: 4, oledGuard: false };
  const stream = new ScreenStream({ app: { isPackaged: true }, getConfig: () => config,
    spawnProcess() {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      return child;
    } });
  try {
    Object.assign(process.env, env);
    const studioState = stream.state();
    assert.equal(studioState.brightnessMinimum, 8);
    assert.equal(studioState.deviceAvailability.ryuo4.brightnessMinimum, 8);
    assert.equal(studioState.deviceAvailability.zhanyu.brightnessMinimum, undefined);
    Object.defineProperty(global, 'navigator', { configurable: true, value: { languages: ['zh-CN'] } });
    Object.defineProperty(global, 'window', { configurable: true, value: { panel: {
      startStream() { ++sent; }, setRyuoBrightness() { ++sent; },
    } } });
    for (const extension of previousLoaders.keys()) require.extensions[extension] = (module, filename) => {
      const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
      }, fileName: filename });
      module._compile(result.outputText, filename);
    };
    const { StreamSettings } = require('../src/StreamSettings.tsx');
    const renderSlider = state => renderToStaticMarkup(React.createElement(StreamSettings, {
      state, onState() { ++sent; },
    })).match(/<input[^>]*type="range"[^>]*>/)?.[0];
    const saved = Object.freeze({ platform: 'win32', stream: studioState, ryuoBrightness: 1 });
    const studioSlider = renderSlider(saved);
    assert.match(studioSlider, /min="8"/);
    assert.match(studioSlider, /value="8"/);
    assert.equal(saved.ryuoBrightness, 1, 'clamping the edit must preserve the saved value');
    assert.equal(sent, 0, 'rendering must not apply brightness or save preferences');
    delete process.env.RYUO_STUDIO_BRIDGE;
    const legacyState = stream.state();
    assert.equal(legacyState.brightnessMinimum, undefined);
    const legacySlider = renderSlider({ ...saved, stream: legacyState });
    assert.match(legacySlider, /min="1"/);
    assert.match(legacySlider, /value="1"/);

    Object.assign(process.env, env);
    global.setTimeout = (callback, delay, ...args) => {
      if (delay === 90000) { queueMicrotask(() => callback(...args)); return 0; }
      return realSetTimeout(callback, delay, ...args);
    };
    await assert.rejects(stream.startBridge(config, stream.generation), error => {
      assert.match(error.message, /USB.*ADB/);
      assert.doesNotMatch(error.message, /播放器|com\.ryuo|HTTP/);
      return true;
    });
  } finally {
    global.setTimeout = realSetTimeout;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const [extension, loader] of previousLoaders) {
      if (loader) require.extensions[extension] = loader; else delete require.extensions[extension];
    }
    if (windowDescriptor) Object.defineProperty(global, 'window', windowDescriptor); else delete global.window;
    if (navigatorDescriptor) Object.defineProperty(global, 'navigator', navigatorDescriptor); else delete global.navigator;
    if (stream.child) for (const pipe of [stream.child.stdin, stream.child.stdout, stream.child.stderr]) pipe.destroy();
  }
});
