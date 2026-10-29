const { app, BrowserWindow, ipcMain, screen, dialog, Menu, Tray, nativeImage, nativeTheme, net, shell, systemPreferences, safeStorage } = require('electron');
const { createI18n, isLanguage } = require('./i18n.cjs');
const { PanelTray } = require('./panel-tray.cjs');
const { ScreenStream, streamAvailability, streamDeviceAvailability } = require('./screen-stream.cjs');
const { validateStreamConfig } = require('./screen-stream-policy.cjs');
// About links only to this fixed project page; the renderer never supplies a URL.
const { homepage: REPOSITORY } = require('../package.json');
const { traySummary } = require('./tray-summary.cjs');
const { WidgetPublisher, loadWidgetBridge } = require('./widget-publisher.cjs');
const { electronTransport } = require('./kimi-work-transport.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { panelBounds, clampBounds, displayGeometry, validPreferences, isSyncRole, isSyncPort, isTheme, isKimiSource, isClaudeSource, isLayout, isProviderOrder, isEnabledProviders, isSkin, isInsights, isInsightOrder, isMascotInterval, PROVIDER_ORDER, COLLAPSED_WIDTH } = require('./window-policy.cjs');
const { requestKimiWorkSubscription } = require('./kimi-work-api.cjs');
const { requestZcodeJson } = require('./zcode-account-api.cjs');
const { WindowLayout } = require('./window-layout.cjs');
const { taskDetail } = require('./task-details.cjs');
const { LocalStatusReader, unavailable } = require('./local-status.cjs');
const { ClaudeStatusReader, resolveClaudePaths } = require('./claude-status.cjs');
const { ClaudeHooks } = require('./claude-hooks.cjs');
const { createClaudeActivityBridge } = require('./claude-activity-bridge.cjs');
const { readDesktopActivity } = require('./claude-desktop.cjs');
const { ProviderLauncher } = require('./provider-launcher.cjs');
const { cleanupOrphanedHelpers } = require('./orphan-helpers.cjs');
const { clearStartupDiskCaches, clearSessionCaches } = require('./app-cache.cjs');
const { LanSyncController } = require('./lan-sync-controller.cjs');
const { CloudStatusController, projectStatus } = require('./cloud-status.cjs');
const { CloudActionAdapter } = require('./cloud-actions.cjs');
const statusReader = new LocalStatusReader({ onCodexActivity: snapshot => {
  if (fixtureMode || preferences?.syncRole === 'client') return;
  statusSnapshot = { ...statusSnapshot, sampledAt: snapshot.sampledAt, codex: snapshot.codex };
  publishStatus();
}, claudeReader: new ClaudeStatusReader({
  desktopActivityReader: createClaudeActivityBridge({
    permissionReader: prompt => systemPreferences.isTrustedAccessibilityClient(prompt),
    readActivity: readDesktopActivity, platform: process.platform,
  }),
}) });
// Electron's network stack follows the system proxy. The API reader owns the fixed URL.
statusReader.kimiWorkReader.request = token => requestKimiWorkSubscription(token, { transport: electronTransport(net) });
statusReader.zcodeReader.accountReader.request = (family, kind, token) => requestZcodeJson(family, kind, token, { transport: electronTransport(net) });
let statusTimer;
let statusSnapshot = statusReader.current;
const fixtureVariant = process.env.AI_WATCH_TEST_STATUS;
const fixtureMode = Boolean(process.env.AI_WATCH_TEST_PROFILE && ['fixture', 'glow-running', 'glow-attention'].includes(fixtureVariant));
const providerLauncher = new ProviderLauncher({ fixtureMode });
let claudeHooks = null, claudeHooksStatus = { supported: process.platform !== 'win32', installed: false };
// Test profiles register hooks in a private copy of the settings file, never the user's real one.
function createClaudeHooks() {
  const settingsFile = process.env.AI_WATCH_TEST_PROFILE ? path.join(app.getPath('userData'), 'claude-config', 'settings.json')
    : path.join(resolveClaudePaths().config, 'settings.json');
  claudeHooks = new ClaudeHooks({ settingsFile, dataDir: app.getPath('userData') });
  statusReader.claudeReader.hooks = claudeHooks;
}
async function applyClaudeHooks(enabled) {
  try {
    if (enabled) await claudeHooks.install(); else await claudeHooks.uninstall();
    claudeHooksStatus = await claudeHooks.status();
  } catch (error) {
    claudeHooksStatus = { supported: claudeHooks.supported, installed: false, error: ['settings-invalid', 'settings-unreadable', 'unsupported-platform'].includes(error.message) ? error.message : 'write-failed' };
    throw error;
  }
}
// A sync client shows the host's data and pauses its own readers.
const isSyncClient = () => preferences?.syncRole === 'client';
let lanSync = null, remoteJournal = null;
let cloudSync = null, cloudActions = null;
function acceptRemote(snapshot) {
  if (!isSyncClient()) return;
  if (snapshot.status && typeof snapshot.status === 'object') {
    statusSnapshot = { ...snapshot.status, remote: { host: snapshot.host || null, sentAt: snapshot.sentAt || null } };
    publishStatus();
  }
  if (snapshot.journal && typeof snapshot.journal === 'object') {
    remoteJournal = snapshot.journal;
    if (window && !window.isDestroyed()) window.webContents.send('panel:journal-changed', remoteJournal);
  }
}
async function applySync() {
  if (!lanSync) return;
  const wasClient = Boolean(statusSnapshot?.remote);
  if (isSyncClient() && !wasClient) {
    // Never show this machine's own readings as if they came from the host.
    statusSnapshot = { sampledAt: null, remote: { host: null, sentAt: null },
      ...Object.fromEntries(PROVIDER_ORDER.map(id => [id, { ...unavailable(id), task: '等待主客户端数据', detail: '子客户端只显示主客户端同步的数据' }])) };
    publishStatus();
  }
  await lanSync.apply(preferences.syncRole, preferences.syncPort);
  if (!isSyncClient() && wasClient) {
    // Leaving client mode: drop the host's data and read this machine again.
    remoteJournal = null; statusSnapshot = statusReader.current;
    if (window && !window.isDestroyed()) window.webContents.send('panel:journal-changed', null);
    await refreshLocalStatus(true).catch(() => {});
  }
  if (preferences.syncRole === 'host') lanSync.publish({ status: statusSnapshot });
}
// Tray and widgets filter by data source; a client follows the host's sources.
function viewPreferences() {
  if (!isSyncClient() || !statusSnapshot?.remote) return preferences;
  return { ...preferences, kimiSource: statusSnapshot.kimi?.kimiSource || 'code', claudeSource: statusSnapshot.claude?.claudeSource || preferences.claudeSource };
}
async function refreshLocalStatus(force = false) {
  if (isSyncClient()) return statusSnapshot;
  statusSnapshot = fixtureMode
    ? JSON.parse(await fs.promises.readFile(path.join(__dirname, '../tests/fixtures/local-status.json'), 'utf8'))
    : await statusReader.poll(force);
  if (fixtureMode && fixtureVariant?.startsWith('glow-')) {
    for (const id of PROVIDER_ORDER) Object.assign(statusSnapshot[id], { activity: 'running', activeTasks: 1, task: '合成测试 · 任务运行中' });
    if (fixtureVariant === 'glow-attention') Object.assign(statusSnapshot.codex, { activity: 'waiting', activeTasks: 1, waitingTasks: 1, waitingReason: 'both', task: '合成测试 · 待回答 / 待授权' });
  }
  if (fixtureMode) {
    if (preferences.layout === 'fullscreen' || preferences.stream.enabled) for (const id of PROVIDER_ORDER) statusSnapshot[id].taskDetails = [taskDetail({
      title: 'UI review · sample task', state: statusSnapshot[id].activity, updatedAt: Date.now(), operation: 'fileChange', steps: 6, toolCalls: 3, progress: 65,
    }, { live: true, source: 'local-api' })];
    statusSnapshot.sampledAt = new Date().toISOString();
    for (const id of PROVIDER_ORDER) statusSnapshot[id].sampledAt = statusSnapshot.sampledAt;
    statusSnapshot.kimi.kimiSource = preferences.kimiSource;
    statusSnapshot.claude.claudeSource = preferences.claudeSource;
    if (preferences.kimiSource === 'work') Object.assign(statusSnapshot.kimi, {
      activity: 'unknown', activeTasks: 0, waitingTasks: 0, task: '合成测试 · Work 活动未知',
      quotas: [{ model: '共享积分', period: '订阅额度', remaining: 75, reset: '2099-01-01T00:00:00Z', resetKind: 'expiry' },
        { model: '共享积分', period: '赠送额度', remaining: 50, reset: '2099-01-01T00:00:00Z', resetKind: 'expiry' }],
    });
  }
  publishStatus();
  return statusSnapshot;
}
function publishStatus() {
  screenStream?.broadcast('panel:status-changed', statusSnapshot);
  if (window && !window.isDestroyed()) window.webContents.send('panel:status-changed', statusSnapshot);
  if (preferences?.syncRole === 'host') lanSync?.publish({ status: statusSnapshot });
  panelTray?.updateMenu();
  publishWidgets();
}

let window;
let screenStream;
let streamShutdownComplete = false;
let streamShuttingDown = false;
let streamDesktopBounds;
let streamDesktopCollapsed = false;
let streamSettingsBounds;
let streamOperation = Promise.resolve();
let panelTray;
let widgetPublisher;
let widgetHealth;
let preferences;
let collapsed = false;
let expandedBounds;
let windowLayout;
let lastDisplayId;
const displayLayouts = new Map();
let repositioning = false;
const providerIds = PROVIDER_ORDER;
const devUrl = process.env.AI_WATCH_DEV_URL;
// A separate profile lets the acceptance script exercise preferences safely.
if (process.env.AI_WATCH_TEST_PROFILE) app.setPath('userData', process.env.AI_WATCH_TEST_PROFILE);
const preferencePath = () => path.join(app.getPath('userData'), 'preferences.json');

function readPreferences() {
  try { return validPreferences(JSON.parse(fs.readFileSync(preferencePath(), 'utf8'))); }
  catch { return validPreferences({}); }
}
function savePreferences() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(preferencePath(), JSON.stringify(preferences, null, 2));
}
const currentLanguage = () => createI18n(preferences?.language || 'zh-CN', app.getPreferredSystemLanguages());
function buildApplicationMenu() {
  const { t } = currentLanguage();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'AI Watch', submenu: [
      { role: 'about', label: t('关于') + ' AI Watch' }, { type: 'separator' },
      { label: t('展开 / 收起'), accelerator: 'CommandOrControl+Shift+B', click: () => { void setCollapsed(!collapsed).catch(() => {}); } },
      { label: t('收纳到菜单栏'), accelerator: 'CommandOrControl+Shift+H', enabled: panelTray.available, click: () => panelTray.store() },
      { label: t('额度速览'), accelerator: 'CommandOrControl+Shift+U', enabled: panelTray.available, click: () => panelTray.openMenu() },
      { label: t('重新贴边'), enabled: !preferences.stream.enabled, click: dock }, { type: 'separator' }, { role: 'quit', label: t('退出 AI Watch') },
    ] }] : []),
    { label: t('编辑'), submenu: [['undo','撤销'], ['redo','重做'], [null,null], ['cut','剪切'], ['copy','复制'], ['paste','粘贴'], ['selectAll','全选']].map(([role,label]) => role ? { role, label: t(label) } : { type: 'separator' }) },
  ]));
}
function currentState() {
  const display = screen.getDisplayMatching(window.getBounds());
  const { providerApps: _privateLaunchPaths, kimiWorkApp: _privateWorkPath, cacheCleanupPending: _cacheFlag, ...publicPreferences } = preferences;
  return { ...publicPreferences, stream: screenStream?.state() || { ...preferences.stream, ...streamAvailability({ packaged: app.isPackaged, device: preferences.stream.device }), deviceAvailability: streamDeviceAvailability({ packaged: app.isPackaged }), status: 'stopped', error: null, frames: 0, droppedFrames: 0, preview: false }, surface: 'desktop', collapsed, desktop: true, platform: process.platform,
    trayAvailable: panelTray?.available === true, stored: panelTray?.stored === true,
    widgetsAvailable: widgetPublisher?.available === true, widgetSyncError: widgetPublisher?.error === true,
    widgetBackground: panelTray?.widgetBackground === true,
    widgetLastPublishedAt: widgetPublisher?.lastPublishedAt || null,
    claudeHooksStatus,
    lanSync: lanSync?.summary() ?? { role: 'off', state: 'off' },
    cloudSync: cloudSync?.summary(),
    resolvedLanguage: currentLanguage().language,
    resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    scaleFactor: display.scaleFactor, bounds: window.getBounds() };
}
function emitState() {
  const details = preferences?.stream.enabled || preferences?.layout === 'fullscreen' && !collapsed;
  if (statusReader.taskDetailsEnabled !== details) {
    statusReader.setTaskDetailsEnabled(details);
    if (!isSyncClient()) {
      statusSnapshot = statusReader.current;
      if (window && !window.isDestroyed()) window.webContents.send('panel:status-changed', statusSnapshot);
      void refreshLocalStatus().catch(() => {});
    }
  }
  panelTray?.updateMenu();
  publishWidgets();
  if (window && !window.isDestroyed()) window.webContents.send('panel:changed', currentState());
  if (screenStream?.window && !screenStream.window.isDestroyed()) {
    screenStream.broadcast('panel:changed', screenStream.screenState());
    screenStream.broadcast('panel:status-changed', statusSnapshot);
  }
}
function publishWidgets() {
  widgetPublisher?.publish(statusSnapshot, { ...viewPreferences(), language: currentLanguage().language }, { isTestData: fixtureMode });
  const health = `${widgetPublisher?.available === true}:${widgetPublisher?.error === true}`;
  if (health !== widgetHealth) {
    widgetHealth = health;
    if (window && !window.isDestroyed()) window.webContents.send('panel:changed', currentState());
  }
}
function updateAppearance() {
  if (!window || window.isDestroyed()) return;
  window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#111519' : '#edf1f5');
  emitState();
}
function setBounds(bounds) {
  repositioning = true;
  window.setBounds(bounds);
  setTimeout(() => { repositioning = false; }, 100);
}
function dock() {
  if (preferences.stream.enabled) return;
  if (preferences.layout === 'fullscreen' || windowLayout?.transitioning) return;
  const display = screen.getDisplayMatching(window.getBounds());
  lastDisplayId = display.id;
  setBounds(panelBounds(display.workArea, preferences.side, collapsed, preferences.layout));
  if (!collapsed) expandedBounds = window.getBounds();
  emitState();
}
function lock() {
  const pinned = preferences.locked && !preferences.stream.enabled && preferences.layout !== 'fullscreen' && !window.isFullScreen();
  window.setAlwaysOnTop(pinned, 'floating');
  if (process.platform !== 'win32') {
    window.setVisibleOnAllWorkspaces(pinned, { visibleOnFullScreen: pinned });
  }
  if (process.platform === 'darwin') window.setHiddenInMissionControl(pinned);
}
async function setCollapsed(value) {
  await windowLayout?.pending;
  if (preferences.stream.enabled && streamDesktopBounds) {
    if (collapsed === value) return;
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    if (value) {
      streamSettingsBounds = window.getBounds();
      setBounds(panelBounds(area, preferences.side, true));
    } else {
      setBounds(clampBounds(streamSettingsBounds, area));
    }
    collapsed = value;
    window.setResizable(!value);
    lock(); emitState();
    return;
  }
  if (value && preferences.layout === 'fullscreen') await windowLayout.change(preferences.windowLayout);
  if (collapsed === value) return;
  const display = screen.getDisplayMatching(window.getBounds());
  if (value) {
    expandedBounds = window.getBounds();
    const old = expandedBounds;
    const newWidth = COLLAPSED_WIDTH;
    setBounds({ ...old, width: newWidth, x: preferences.side === 'right' ? old.x + old.width - newWidth : old.x });
  } else {
    const current = window.getBounds();
    const width = panelBounds({ ...display.workArea, height: current.height }, preferences.side, false, preferences.layout).width;
    setBounds(clampBounds({ ...current, width,
      x: preferences.side === 'right' ? current.x + current.width - width : current.x,
    }, display.workArea));
  }
  collapsed = value;
  emitState();
}
function requirePanel(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Invalid panel sender');
  }
}
function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => { requirePanel(event); return callback(...args); });
}

function serializeStream(callback) {
  const next = streamOperation.then(callback);
  streamOperation = next.catch(() => {});
  return next;
}
function requireInteractivePanel() {
  if (preferences.stream.enabled) throw new Error('小屏幕串流模式已关闭打开程序、排序和手动刷新');
}
function resetUnavailableStream() {
  if (!preferences.stream.enabled || screenStream.availability().available) return;
  preferences.stream.enabled = false;
  try { savePreferences(); } catch { /* Missing optional resources must not block normal startup, even in a read-only profile. */ }
}
async function setStreamDesktop(enabled) {
  await windowLayout.pending;
  if (enabled) {
    if (!streamDesktopBounds) { streamDesktopBounds = window.getBounds(); streamDesktopCollapsed = collapsed; }
    collapsed = false;
    windowLayout.transitioning = true;
    try { await windowLayout.nativeFullscreen(false); }
    finally { windowLayout.transitioning = false; }
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    const width = Math.min(880, area.width), height = Math.min(900, area.height);
    setBounds({ x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height });
    streamSettingsBounds = window.getBounds();
    window.setResizable(true);
  } else if (streamDesktopBounds) {
    window.setResizable(false);
    collapsed = streamDesktopCollapsed;
    setBounds(streamDesktopBounds);
    streamDesktopBounds = null;
    streamSettingsBounds = null;
    if (preferences.layout === 'fullscreen' && !collapsed) {
      // Preserve WindowLayout's original normal bounds across the temporary settings window.
      windowLayout.transitioning = true;
      try { await windowLayout.nativeFullscreen(true); }
      finally { windowLayout.transitioning = false; }
    }
  }
  lock(); buildApplicationMenu(); emitState();
}

async function restoreStreamDesktop() {
  // Device recovery errors must not trap the desktop in the stream controller.
  preferences.stream.enabled = false;
  try { savePreferences(); }
  finally { await setStreamDesktop(false); }
}
async function startStreamOutput() {
  try {
    if (!streamDesktopBounds) await setStreamDesktop(true);
    await screenStream.start();
  } catch (error) {
    try { await restoreStreamDesktop(); }
    catch (cleanupError) { throw new Error(`${error.message}；${cleanupError.message}`); }
    throw error;
  }
}
async function stopStreamOutput() {
  try { await screenStream.stop(); }
  finally { await restoreStreamDesktop(); }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  // A widget may only reopen the panel; no URL can launch a provider or carry a path.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (url === 'aiwatch://panel' || url === 'aiwatch://panel/') void panelTray?.restore();
  });
  app.on('second-instance', () => { void panelTray?.restore(); });
  app.whenReady().then(async () => {
    await cleanupOrphanedHelpers({ packaged: app.isPackaged });
    preferences = readPreferences();
    if (preferences.cacheCleanupPending) {
      try {
        await clearStartupDiskCaches({ userData: app.getPath('userData') });
        preferences.cacheCleanupPending = false; savePreferences();
      } catch {
        // Cache maintenance is optional. A rejected profile root or transient
        // failure must not prevent startup; retain the request for a safe retry.
        preferences.cacheCleanupPending = true;
      }
    }
    statusReader.claudeReader.setDesktopPlanCacheFile(path.join(app.getPath('userData'), 'claude-desktop-plan.json'));
    createClaudeHooks();
    lanSync = new LanSyncController({ userData: app.getPath('userData'), onRemote: acceptRemote, onChange: () => emitState() });
    cloudActions = new CloudActionAdapter({ statusReader });
    cloudSync = new CloudStatusController({ userData: app.getPath('userData'), safeStorage,
      fetch: (...args) => net.fetch(...args), onChange: () => { if (window && !window.isDestroyed()) emitState(); },
      actions: { dispose: () => cloudActions.suspend(), execute: command => !fixtureMode && !isSyncClient() && preferences.enabledProviders.includes('codex')
        && Number.isFinite(Date.parse(statusSnapshot?.sampledAt)) && Date.now() - Date.parse(statusSnapshot.sampledAt) <= 30000
        ? cloudActions.execute(command) : Promise.resolve({ id: command.id, status: 'failed', error: 'local-actions-unavailable' }) },
      getSnapshot: async (allowActions, uploadFullContent) => {
        const localActions = allowActions && !fixtureMode && !isSyncClient() && preferences.enabledProviders.includes('codex');
        const requests = localActions ? await cloudActions.pending({ uploadFullContent }) : [];
        if (!localActions) cloudActions.suspend();
        return projectStatus(statusSnapshot, { enabledProviders: preferences.enabledProviders,
          requests: requests.filter(request => preferences.enabledProviders.includes(request.provider)), sample: fixtureMode });
      } });
    // Refresh the script on start so a moved or updated app keeps reporting; failures stay visible in settings.
    if (preferences.claudeHooksEnabled) await applyClaudeHooks(true).catch(() => {});
    widgetPublisher = new WidgetPublisher({ bridge: loadWidgetBridge({ app, fixtureMode,
      fixtureWidgets: process.env.AI_WATCH_TEST_WIDGETS === '1' }) });
    statusReader.setKimiSource(preferences.kimiSource);
    statusReader.setClaudeSource(preferences.claudeSource);
    statusReader.setClaudeNetworkAllowed(!fixtureMode && preferences.claudeNetworkAllowed);
    statusReader.qwenReader.setKeychainAllowed(!fixtureMode && preferences.qwenKeychainAllowed);
    nativeTheme.themeSource = preferences.theme;
    const display = screen.getPrimaryDisplay();
    for (const item of screen.getAllDisplays()) displayLayouts.set(item.id, displayGeometry(item));
    lastDisplayId = display.id;
    window = new BrowserWindow({
      ...panelBounds(display.workArea, preferences.side, false, preferences.layout === 'fullscreen' ? preferences.windowLayout : preferences.layout), title: 'AI Watch',
      frame: false, resizable: false, maximizable: false, fullscreenable: true,
      show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#111519' : '#edf1f5', autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    windowLayout = new WindowLayout({ window, screen, getPreferences: () => preferences, save: savePreferences, changed: emitState, pin: lock, setBounds });
    screenStream = new ScreenStream({ app, BrowserWindow, devUrl, getConfig: () => preferences.stream,
      getState: currentState, getStatus: () => statusSnapshot, onChange: emitState,
      preview: fixtureMode && process.env.AI_WATCH_STREAM_PREVIEW === '1' });
    resetUnavailableStream();
    if (process.platform === 'win32') app.setAppUserModelId('app.aiwatch.panel');
    panelTray = new PanelTray({ app, window, Tray, Menu, nativeImage,
      getSummary: () => ({ rows: traySummary(statusSnapshot, { ...viewPreferences(), language: currentLanguage().language }), isTestData: fixtureMode }),
      getLanguage: () => currentLanguage().language,
      onChange: () => { emitState(); buildApplicationMenu(); }, canRefresh: () => !preferences.stream.enabled,
      onRefresh: () => { requireInteractivePanel(); return refreshLocalStatus(true); } });
    window.on('close', event => panelTray.handleClose(event));
    nativeTheme.on('updated', updateAppearance);
    buildApplicationMenu();
    lock();
    window.once('ready-to-show', () => {
      window.show();
      if (preferences.stream.enabled) void serializeStream(startStreamOutput).catch(() => {});
      else if (preferences.layout === 'fullscreen') void windowLayout.change('fullscreen').catch(() => {});
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });
    if (devUrl) {
      if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(devUrl)) throw new Error('Dev URL must be local');
      window.loadURL(devUrl);
    } else window.loadFile(path.join(__dirname, '../dist/index.html'));
    window.on('move', () => {
      if (repositioning || preferences.stream.enabled || windowLayout.transitioning || preferences.layout === 'fullscreen') return;
      const target = screen.getDisplayMatching(window.getBounds());
      if (target.id !== lastDisplayId) {
        lastDisplayId = target.id;
        const dimensions = panelBounds(target.workArea, preferences.side, collapsed, preferences.layout);
        setBounds(clampBounds({ ...window.getBounds(), width: dimensions.width, height: dimensions.height, y: target.workArea.y }, target.workArea));
      }
      if (!collapsed) expandedBounds = window.getBounds();
      emitState();
    });
    screen.on('display-metrics-changed', (_event, display) => {
      const geometry = displayGeometry(display);
      const previous = displayLayouts.get(display.id);
      displayLayouts.set(display.id, geometry);
      // Compare actual monitor geometry, not backend metric flags or a timeout:
      // Dock animations may emit delayed events and must not reset a user position.
      if (geometry === previous) return;
      dock();
    });
    screen.on('display-added', (_event, display) => { displayLayouts.set(display.id, displayGeometry(display)); });
    screen.on('display-removed', (_event, display) => { displayLayouts.delete(display.id); dock(); });
    handle('panel:state', currentState);
    handle('panel:status', () => statusSnapshot);
    handle('panel:cloud-configure', value => { cloudSync.configure(value); emitState(); return currentState(); });
    handle('panel:cloud-forget', () => { cloudSync.forget(); emitState(); return currentState(); });
    ipcMain.handle('screen:state', event => { if (!screenStream.accepts(event)) throw new Error('Invalid screen sender'); return screenStream.screenState(); });
    ipcMain.handle('screen:status', event => { if (!screenStream.accepts(event)) throw new Error('Invalid screen sender'); return statusSnapshot; });
    handle('panel:stream-config', value => {
      const patch = validateStreamConfig(value, { partial: true });
      return serializeStream(async () => {
        if (streamShuttingDown) throw new Error('Application is shutting down');
        const previous = preferences.stream;
        const { enabled, ...config } = { ...previous, ...patch };
        preferences.stream = { ...validateStreamConfig(config), enabled };
        try { savePreferences(); } catch (error) { preferences.stream = previous; throw error; }
        emitState();
        if (enabled) await startStreamOutput();
        return currentState();
      });
    });
    handle('panel:stream-start', () => serializeStream(async () => {
      if (streamShuttingDown) throw new Error('Application is shutting down');
      screenStream.assertAvailable();
      const previous = preferences.stream.enabled;
      preferences.stream.enabled = true;
      try { savePreferences(); } catch (error) { preferences.stream.enabled = previous; throw error; }
      await startStreamOutput(); return currentState();
    }));
    handle('panel:stream-stop', () => {
      screenStream.cancelStart?.();
      return serializeStream(async () => {
        await stopStreamOutput(); return currentState();
      });
    });
    handle('panel:minimize', () => { window.minimize(); return currentState(); });
    handle('panel:clear-cache', async () => {
      const result = await clearSessionCaches({ session: window.webContents.session });
      if (!result.cleared.length) throw new Error('Cache cleanup unavailable');
      preferences.cacheCleanupPending = true; savePreferences();
      return { freedBytes: result.freedBytes };
    });
    handle('panel:refresh', () => { requireInteractivePanel(); return refreshLocalStatus(true); });
    handle('panel:lock', (value) => {
      if (typeof value !== 'boolean') throw new Error('Invalid lock state');
      preferences.locked = value; lock(); savePreferences(); emitState(); return currentState();
    });
    handle('panel:layout', async value => {
      requireInteractivePanel();
      if (!isLayout(value)) throw new Error('Invalid layout');
      if (collapsed) await setCollapsed(false);
      await windowLayout.change(value); return currentState();
    });
    handle('panel:collapse', async (value) => {
      if (typeof value !== 'boolean') throw new Error('Invalid collapse state');
      await setCollapsed(value); return currentState();
    });
    handle('panel:store', () => {
      if (!panelTray.store()) throw new Error('System tray unavailable');
      return currentState();
    });
    handle('panel:widgets-enabled', async (value) => {
      if (typeof value !== 'boolean') throw new Error('Invalid widget setting');
      if (!widgetPublisher.available) throw new Error('Signed native widget build required');
      const next = { ...preferences, widgetsEnabled: value, language: currentLanguage().language };
      const synced = value ? widgetPublisher.publish(statusSnapshot, next, { isTestData: fixtureMode }) : widgetPublisher.clear();
      if (!synced) throw new Error('Widget synchronization failed');
      const previous = preferences.widgetsEnabled;
      preferences.widgetsEnabled = value;
      try { savePreferences(); } catch (error) {
        preferences.widgetsEnabled = previous;
        if (!previous) widgetPublisher.clear(); else publishWidgets();
        throw error;
      }
      if (!value && panelTray.widgetBackground) await panelTray.restore();
      emitState(); return currentState();
    });
    handle('panel:widget-background', () => {
      if (!preferences.widgetsEnabled || !widgetPublisher.available || !widgetPublisher.publish(statusSnapshot,
        { ...preferences, language: currentLanguage().language }, { isTestData: fixtureMode })) throw new Error('Widgets are not ready');
      if (!panelTray.storeForWidgets()) throw new Error('Widget background mode unavailable');
      buildApplicationMenu();
      return currentState();
    });
    handle('panel:language', (value) => {
      if (!isLanguage(value)) throw new Error('Invalid language');
      const previous = preferences.language; preferences.language = value;
      try { savePreferences(); } catch (error) { preferences.language = previous; throw error; }
      buildApplicationMenu(); emitState(); return currentState();
    });
    handle('panel:configure', (value) => {
      const next = validPreferences({ ...value, stream: preferences.stream, syncRole: preferences.syncRole, syncPort: preferences.syncPort, layout: preferences.layout, windowLayout: preferences.windowLayout, language: preferences.language, theme: preferences.theme, providerOrder: preferences.providerOrder, enabledProviders: preferences.enabledProviders, qwenKeychainAllowed: preferences.qwenKeychainAllowed,
        kimiSource: preferences.kimiSource, claudeSource: preferences.claudeSource, claudeNetworkAllowed: preferences.claudeNetworkAllowed, claudeHooksEnabled: preferences.claudeHooksEnabled, cacheCleanupPending: preferences.cacheCleanupPending, kimiWorkApp: preferences.kimiWorkApp, widgetsEnabled: preferences.widgetsEnabled, animeMode: preferences.animeMode, insights: preferences.insights, insightOrder: preferences.insightOrder, mascotInterval: preferences.mascotInterval, skin: preferences.skin, providerApps: preferences.providerApps });
      const changedSide = next.side !== preferences.side;
      preferences = next; savePreferences(); lock();
      if (changedSide) dock();
      emitState(); return currentState();
    });
    handle('panel:anime-mode', (value) => {
      if (typeof value !== 'boolean') throw new Error('Invalid anime mode');
      const previous = preferences.animeMode;
      preferences.animeMode = value;
      try { savePreferences(); } catch (error) { preferences.animeMode = previous; throw error; }
      emitState(); return currentState();
    });
    handle('panel:insights', (value) => {
      if (!isInsights(value)) throw new Error('Invalid insights');
      const previous = preferences.insights;
      preferences.insights = { ...value };
      try { savePreferences(); } catch (error) { preferences.insights = previous; throw error; }
      emitState(); return currentState();
    });
    handle('panel:insight-order', (value) => {
      requireInteractivePanel();
      if (!isInsightOrder(value)) throw new Error('Invalid insight order');
      const previous = preferences.insightOrder;
      preferences.insightOrder = [...value];
      try { savePreferences(); } catch (error) { preferences.insightOrder = previous; throw error; }
      emitState(); return currentState();
    });
    handle('panel:mascot-interval', (value) => {
      if (!isMascotInterval(value)) throw new Error('Invalid mascot interval');
      const previous = preferences.mascotInterval;
      preferences.mascotInterval = value;
      try { savePreferences(); } catch (error) { preferences.mascotInterval = previous; throw error; }
      emitState(); return currentState();
    });
    handle('panel:skin', (value) => {
      if (!isSkin(value)) throw new Error('Invalid skin');
      const previous = preferences.skin;
      preferences.skin = value;
      try { savePreferences(); } catch (error) { preferences.skin = previous; throw error; }
      emitState(); return currentState();
    });
    handle('panel:sync-role', async (value) => {
      if (!isSyncRole(value)) throw new Error('Invalid sync role');
      const previous = preferences.syncRole;
      preferences.syncRole = value;
      try { savePreferences(); } catch (error) { preferences.syncRole = previous; throw error; }
      await applySync(); emitState(); return currentState();
    });
    handle('panel:sync-port', async (value) => {
      if (!isSyncPort(value)) throw new Error('Invalid sync port');
      const previous = preferences.syncPort;
      preferences.syncPort = value;
      try { savePreferences(); } catch (error) { preferences.syncPort = previous; throw error; }
      await applySync(); emitState(); return currentState();
    });
    handle('panel:sync-pair', async (address, code) => {
      if (typeof address !== 'string' || address.length > 80 || typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new Error('Invalid pairing');
      await lanSync.pairWith(address, code); emitState(); return currentState();
    });
    handle('panel:sync-forget', () => { lanSync.forget(); emitState(); return currentState(); });
    handle('panel:sync-regenerate', () => { lanSync.regenerate(); emitState(); return currentState(); });
    handle('panel:sync-discover', () => lanSync.discoverHosts());
    handle('panel:journal', (journal) => {
      // Only a host shares its journal; it is size-bounded and sanitized again on send.
      if (preferences.syncRole !== 'host' || !journal || typeof journal !== 'object' || JSON.stringify(journal).length > 2 * 1024 * 1024) return false;
      lanSync.publish({ journal }); return true;
    });
    handle('panel:remote-journal', () => (isSyncClient() ? remoteJournal : null));
    handle('panel:open-provider', (id) => {
      requireInteractivePanel();
      return isSyncClient() ? { status: 'remote', message: '' } : providerLauncher.launch(id,
        id === 'kimi' && preferences.kimiSource === 'work' ? preferences.kimiWorkApp : preferences.providerApps[id], preferences.kimiSource);
    });
    handle('panel:choose-provider-app', (id) => {
      const source = preferences.kimiSource;
      return providerLauncher.choose(id,
      options => dialog.showOpenDialog(window, { ...options, title: currentLanguage().t('选择 {p0} 启动应用', { p0: id === 'kimi' && source === 'work' ? 'Kimi Work' : { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', deepseek: 'DeepSeek Harness', zcode: 'ZCode', kimi: 'Kimi Code', qwen: 'Qwen', workbuddy: 'WorkBuddy' }[id] }), filters: options.filters?.map(filter => ({ ...filter, name: currentLanguage().t('应用') })) }),
      (provider, file) => {
        if (provider === 'kimi' && source === 'work') {
          const previous = preferences.kimiWorkApp;
          preferences.kimiWorkApp = file;
          try { savePreferences(); } catch (error) { preferences.kimiWorkApp = previous; throw error; }
          return;
        }
        const previous = preferences.providerApps;
        preferences.providerApps = { ...previous, [provider]: file };
        try { savePreferences(); } catch (error) { preferences.providerApps = previous; throw error; }
      }, source);
    });
    handle('panel:theme', (value) => {
      if (!isTheme(value)) throw new Error('Invalid theme');
      const previous = preferences.theme;
      preferences.theme = value;
      try { savePreferences(); } catch (error) { preferences.theme = previous; throw error; }
      nativeTheme.themeSource = value;
      updateAppearance(); return currentState();
    });
    handle('panel:enabled', (value) => {
      if (!isEnabledProviders(value)) throw new Error('Invalid enabled providers');
      const previous = preferences.enabledProviders;
      preferences.enabledProviders = [...value];
      try { savePreferences(); } catch (error) { preferences.enabledProviders = previous; throw error; }
      emitState(); return currentState();
    });
    handle('panel:qwen-access', (value) => {
      if (typeof value !== 'boolean') throw new Error('Invalid Qwen access setting');
      const previous = preferences.qwenKeychainAllowed;
      preferences.qwenKeychainAllowed = value;
      try { savePreferences(); } catch (error) { preferences.qwenKeychainAllowed = previous; throw error; }
      // Fixture profiles must never prompt the real keychain, even when testing this control.
      statusReader.qwenReader.setKeychainAllowed(!fixtureMode && value);
      if (!fixtureMode && !value && !isSyncClient()) {
        statusSnapshot = { ...statusSnapshot, sampledAt: new Date().toISOString(), qwen: {
          ...statusSnapshot.qwen, source: 'unavailable', connection: 'auth-required', accessRequired: true, plan: { name: null },
          credits: { items: [], stale: false }, quotas: [], observedAt: null,
          detail: '千问登录读取已关闭；本地智能体活动仍可监看。',
        } };
        window.webContents.send('panel:status-changed', statusSnapshot);
      }
      emitState();
      if (!fixtureMode) void refreshLocalStatus().catch(() => {});
      return currentState();
    });
    handle('panel:claude-activity-access', async () => {
      if (!fixtureMode && !isSyncClient() && preferences.claudeSource === 'desktop') {
        const result = await statusReader.claudeReader.requestActivityAccess();
        // macOS only prompts once per signature. A rebuilt ad hoc copy keeps a stale,
        // switched-on entry that no longer matches, so open the pane to re-add it.
        if (result.supported && result.trusted === false) {
          await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility').catch(() => {});
        }
      }
      return refreshLocalStatus(true);
    });
    handle('panel:claude-hooks', async (value) => {
      if (typeof value !== 'boolean') throw new Error('Invalid Claude hooks setting');
      await applyClaudeHooks(value).catch(() => {});
      // Only a successful install counts as on; a failed removal still turns reporting off.
      preferences.claudeHooksEnabled = value && claudeHooksStatus.installed;
      savePreferences(); emitState();
      await refreshLocalStatus(true);
      return currentState();
    });
    handle('panel:claude-network-access', async (value) => {
      if (typeof value !== 'boolean') throw new Error('Invalid Claude network setting');
      const previous = preferences.claudeNetworkAllowed;
      preferences.claudeNetworkAllowed = value;
      try { savePreferences(); } catch (error) { preferences.claudeNetworkAllowed = previous; throw error; }
      const pending = statusReader.pending;
      // Synthetic UI profiles must never read real credentials or prompt the keychain.
      statusReader.setClaudeNetworkAllowed(!fixtureMode && value);
      if (!fixtureMode && !isSyncClient()) {
        statusSnapshot = { ...statusSnapshot, sampledAt: new Date().toISOString(), claude: statusReader.current.claude };
        window.webContents.send('panel:status-changed', statusSnapshot);
      }
      emitState();
      if (pending) await pending.catch(() => {});
      await refreshLocalStatus(true);
      return currentState();
    });
    handle('panel:claude-source', async (value) => {
      if (!isClaudeSource(value)) throw new Error('Invalid Claude source');
      const previous = preferences.claudeSource;
      preferences.claudeSource = value;
      try { savePreferences(); } catch (error) { preferences.claudeSource = previous; throw error; }
      const pending = statusReader.pending;
      statusReader.setClaudeSource(value);
      if (!isSyncClient()) {
        statusSnapshot = { ...statusSnapshot, sampledAt: new Date().toISOString(), claude: statusReader.current.claude };
        window.webContents.send('panel:status-changed', statusSnapshot);
      }
      emitState();
      if (pending) await pending.catch(() => {});
      await refreshLocalStatus(true);
      return currentState();
    });
    handle('panel:kimi-source', async (value) => {
      if (!isKimiSource(value)) throw new Error('Invalid Kimi source');
      const previous = preferences.kimiSource;
      preferences.kimiSource = value;
      try { savePreferences(); } catch (error) { preferences.kimiSource = previous; throw error; }
      const pending = statusReader.pending;
      statusReader.setKimiSource(value);
      if (!isSyncClient()) {
        statusSnapshot = { ...statusSnapshot, sampledAt: new Date().toISOString(), kimi: statusReader.current.kimi };
        window.webContents.send('panel:status-changed', statusSnapshot);
      }
      emitState();
      if (pending) await pending.catch(() => {});
      await refreshLocalStatus(true);
      return currentState();
    });
    handle('panel:order', (value) => {
      requireInteractivePanel();
      if (!isProviderOrder(value)) throw new Error('Invalid provider order');
      const previous = preferences.providerOrder;
      preferences.providerOrder = [...value];
      try { savePreferences(); } catch (error) { preferences.providerOrder = previous; throw error; }
      emitState(); return currentState();
    });
    handle('panel:dock', () => { dock(); return currentState(); });
    handle('panel:image', async (provider) => {
      if (!providerIds.includes(provider)) throw new Error('Invalid provider');
      const result = await dialog.showOpenDialog(window, {
        title: currentLanguage().t('选择助手图片'), properties: ['openFile'],
        filters: [{ name: currentLanguage().t('图片'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (result.canceled) return null;
      const file = result.filePaths[0];
      if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('图片不能超过 8 MB');
      const image = require('electron').nativeImage.createFromPath(file);
      if (image.isEmpty()) throw new Error('无法读取这张图片');
      return image.resize({ width: 256 }).toDataURL();
    });
    handle('panel:open-repository', () => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(REPOSITORY) ? shell.openExternal(REPOSITORY) : undefined);
    handle('panel:quit', () => app.quit());
    await applySync().catch(() => {});
    void refreshLocalStatus().catch(() => {});
    statusTimer = setInterval(() => { void refreshLocalStatus().catch(() => {}); }, 5000);
    cloudSync.start();
    app.on('activate', () => { void panelTray.restore(); });
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (screenStream && !streamShutdownComplete) {
      event.preventDefault();
      if (!streamShuttingDown) {
        streamShuttingDown = true; screenStream.cancelStart?.();
        void serializeStream(() => screenStream.stop()).catch(() => {}).finally(() => { streamShutdownComplete = true; app.quit(); });
      }
      return;
    }
    panelTray?.dispose(); clearInterval(statusTimer); nativeTheme.removeListener('updated', updateAppearance);
    statusReader.codexAttention.close(); statusReader.codexQuotaReader.close();
    void lanSync?.close();
    cloudSync?.stop();
    cloudActions?.dispose();
    // Tear down Chromium's window/IPC while the host is still alive.
    if (window && !window.isDestroyed()) window.destroy();
  });
}
