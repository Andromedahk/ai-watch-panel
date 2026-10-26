const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { validPreferences } = require('../electron/window-policy.cjs');

// Run the real main-process orchestration without creating OS windows or reading credentials.
function mainFixture(options = {}, capability = { available: true, unavailableReason: null }) {
  const mainPath = path.join(__dirname, '../electron/main.cjs');
  const originalRequire = createRequire(mainPath);
  const desktopEvents = [], screenEvents = [], published = [];
  const reader = { current: { localOnly: true }, taskDetailsEnabled: false, polls: 0,
    kimiWorkReader: {}, zcodeReader: { accountReader: {} },
    setTaskDetailsEnabled(value) { this.taskDetailsEnabled = value; },
    poll() { this.polls++; return Promise.resolve(this.current); } };
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const window = { bounds: { x: 1500, y: 0, width: 420, height: 1080 }, full: false,
    isDestroyed: () => false, getBounds() { return { ...this.bounds }; },
    setBounds(value) { this.bounds = value; }, isFullScreen() { return this.full; },
    setResizable(value) { this.resizable = value; }, setAlwaysOnTop() {}, setVisibleOnAllWorkspaces() {}, setHiddenInMissionControl() {},
    webContents: { send: (...args) => desktopEvents.push(args) } };
  const preferences = validPreferences(options);
  const output = { window: { isDestroyed: () => false }, broadcast: (...args) => screenEvents.push(args),
    starts: 0, stops: 0, async start() { this.starts++; }, async stop() { this.stops++; },
    availability: () => capability,
    state: () => ({ ...preferences.stream, status: 'running' }), screenState: () => ({ surface: 'screen' }) };
  const windowLayout = { pending: Promise.resolve(), transitioning: false, normalBounds: { x: 1400, y: 100, width: 400, height: 800 },
    async nativeFullscreen(value) { window.full = value; } };
  const electron = { app: { requestSingleInstanceLock: () => false, quit() {}, getPreferredSystemLanguages: () => ['zh-CN'] },
    screen: { getDisplayMatching: () => ({ workArea: area, scaleFactor: 1 }) }, nativeTheme: { shouldUseDarkColors: false },
    Menu: { buildFromTemplate: value => value, setApplicationMenu() {} }, systemPreferences: {} };
  const context = { module: { exports: {} }, __dirname: path.dirname(mainPath),
    process: { platform: process.platform, env: {} }, setTimeout: () => 0, clearTimeout,
    require(name) {
      if (name === 'electron') return electron;
      if (name === './local-status.cjs') return { LocalStatusReader: class { constructor() { return reader; } }, unavailable: () => ({}) };
      if (name === './claude-status.cjs') return { ClaudeStatusReader: class {}, resolveClaudePaths: () => ({}) };
      if (name === './claude-activity-bridge.cjs') return { createClaudeActivityBridge: () => ({}) };
      return originalRequire(name);
    } };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8') + `\nmodule.exports = {
    initialize(fixture) { window = fixture.window; preferences = fixture.preferences; screenStream = fixture.output;
      windowLayout = fixture.windowLayout; panelTray = { available: true, updateMenu() {} };
      lanSync = { publish: fixture.publish, summary: () => ({ role: preferences.syncRole }) }; savePreferences = fixture.save; },
    acceptRemote, emitState, refreshLocalStatus, publishStatus, setStreamDesktop, resetUnavailableStream,
    setCollapsed, startStreamOutput, stopStreamOutput, isCollapsed() { return collapsed; },
    setStatus(value) { statusSnapshot = value; }, status() { return statusSnapshot; },
  };`, context, { filename: mainPath });
  const main = context.module.exports;
  let saves = 0;
  main.initialize({ window, preferences, output, windowLayout, publish: value => published.push(value), save: () => { saves++; } });
  return { main, window, windowLayout, preferences, output, reader, desktopEvents, screenEvents, published, saves: () => saves };
}

test('upgrading to a package without optional streaming resources clears saved stream mode before showing the desktop', () => {
  const f = mainFixture({ stream: { enabled: true } }, { available: false, unavailableReason: 'component missing' });
  f.main.resetUnavailableStream();
  assert.equal(f.preferences.stream.enabled, false);
  assert.equal(f.saves(), 1);
  f.main.resetUnavailableStream(); assert.equal(f.saves(), 1);
  const supported = mainFixture({ stream: { enabled: true } });
  supported.main.resetUnavailableStream();
  assert.equal(supported.preferences.stream.enabled, true);
  assert.equal(supported.saves(), 0);
});

test('LAN client keeps host statuses on the small screen across stream mode changes without polling local readers', async () => {
  const f = mainFixture({ syncRole: 'client', stream: { enabled: true } });
  const remote = { sampledAt: 'sample', codex: { activity: 'waiting', waitingReason: 'approval', task: 'Remote Mac task' } };
  f.main.acceptRemote({ status: remote, host: 'Mac', sentAt: 'now' });
  const status = f.main.status();
  assert.equal(status.codex.task, 'Remote Mac task');
  assert.equal(f.screenEvents.at(-1)[1], status);
  assert.equal(f.desktopEvents.find(([channel]) => channel === 'panel:status-changed')[1], status);
  f.main.emitState();
  assert.equal(f.main.status(), status);
  assert.equal(f.reader.taskDetailsEnabled, true);
  assert.equal(await f.main.refreshLocalStatus(true), status);
  f.preferences.stream.enabled = false; f.main.emitState();
  assert.equal(f.main.status(), status);
  assert.equal(f.reader.polls, 0);
  assert.equal(f.published.length, 0);
});

test('host status updates publish to the screen, desktop and LAN from the same snapshot', () => {
  const f = mainFixture({ syncRole: 'host', stream: { enabled: true } });
  const status = { claude: { activity: 'running' } };
  f.main.setStatus(status); f.main.publishStatus();
  assert.equal(f.screenEvents.at(-1)[1], status);
  assert.equal(f.desktopEvents.find(([channel]) => channel === 'panel:status-changed')[1], status);
  assert.equal(f.published[0].status, status);
});

test('temporary stream settings window restores fullscreen without replacing the saved normal window bounds', async () => {
  const f = mainFixture({ layout: 'fullscreen', stream: { enabled: true } });
  const normal = f.windowLayout.normalBounds, original = f.window.getBounds();
  f.window.full = true;
  await f.main.setStreamDesktop(true);
  assert.equal(f.window.full, false);
  assert.equal(f.window.resizable, true);
  f.preferences.stream.enabled = false;
  await f.main.setStreamDesktop(false);
  assert.equal(f.window.full, true);
  assert.equal(f.window.resizable, false);
  assert.deepEqual(f.window.getBounds(), original);
  assert.equal(f.windowLayout.normalBounds, normal);
});

test('stream controller collapses to the side rail and restores resized settings without restarting output', async () => {
  for (const side of ['left', 'right']) {
    const f = mainFixture({ side, stream: { enabled: true } });
    const original = f.window.getBounds();
    await f.main.startStreamOutput();
    f.window.setBounds({ x: 500, y: 80, width: 800, height: 700 });
    const settings = f.window.getBounds();
    await f.main.setCollapsed(true);
    assert.equal(f.main.isCollapsed(), true);
    assert.equal(f.window.bounds.width, 64);
    assert.equal(f.window.bounds.x, side === 'left' ? 0 : 1856);
    assert.equal(f.window.resizable, false);
    assert.equal(f.preferences.stream.enabled, true);
    assert.equal(f.output.starts, 1);
    assert.equal(f.output.stops, 0);
    await f.main.setCollapsed(false);
    assert.equal(f.main.isCollapsed(), false);
    assert.deepEqual(f.window.getBounds(), settings);
    assert.equal(f.window.resizable, true);
    // Reapplying stream parameters must retain the user's collapsed controller.
    await f.main.setCollapsed(true);
    await f.main.startStreamOutput();
    assert.equal(f.main.isCollapsed(), true);
    assert.equal(f.window.bounds.width, 64);
    await f.main.stopStreamOutput();
    assert.equal(f.main.isCollapsed(), false);
    assert.equal(f.preferences.stream.enabled, false);
    assert.deepEqual(f.window.getBounds(), original);
  }
});

test('failed stream startup restores ordinary desktop and keeps it collapsible', async () => {
  const f = mainFixture({ stream: { enabled: true } });
  const original = f.window.getBounds();
  f.output.start = async () => { throw new Error('USB unavailable'); };
  await assert.rejects(f.main.startStreamOutput(), /USB unavailable/);
  assert.equal(f.preferences.stream.enabled, false);
  assert.deepEqual(f.window.getBounds(), original);
  assert.equal(f.window.resizable, false);
  await f.main.setCollapsed(true);
  assert.equal(f.main.isCollapsed(), true);
  assert.equal(f.window.bounds.width, 64);
  await f.main.setCollapsed(false);
  assert.equal(f.main.isCollapsed(), false);
});

test('stop restores desktop after device recovery fails, while preserving the recovery error', async () => {
  const f = mainFixture({ layout: 'fullscreen', stream: { enabled: true } });
  const original = f.window.getBounds();
  await f.main.startStreamOutput();
  await f.main.setCollapsed(true);
  f.output.stop = async () => { throw new Error('Vendor UI recovery unconfirmed'); };
  await assert.rejects(f.main.stopStreamOutput(), /Vendor UI recovery unconfirmed/);
  assert.equal(f.preferences.stream.enabled, false);
  assert.equal(f.main.isCollapsed(), false);
  assert.equal(f.window.full, true);
  assert.deepEqual(f.window.getBounds(), original);
});

test('screen preload exposes subscriptions and reads only, and removes listeners when unsubscribed', async () => {
  const calls = [], listeners = new Map();
  let panel;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/screen-preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'panel'); panel = api; } },
      ipcRenderer: { invoke: channel => { calls.push(channel); }, on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel); } } }),
  });
  assert.deepEqual(Object.keys(panel).sort(), ['getState', 'getStatus', 'onState', 'onStatus']);
  await panel.getState(); await panel.getStatus();
  assert.deepEqual(calls, ['screen:state', 'screen:status']);
  let received;
  const unsubscribe = panel.onStatus(value => { received = value; });
  listeners.get('panel:status-changed')({}, { codex: true });
  assert.deepEqual(received, { codex: true });
  unsubscribe(); assert.equal(listeners.size, 0);
});
