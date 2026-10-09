const { app, BrowserWindow, ipcMain, screen, dialog, Menu, Tray, nativeImage, nativeTheme, net } = require('electron');
const { createI18n, isLanguage } = require('./i18n.cjs');
const { PanelTray } = require('./panel-tray.cjs');
const { traySummary } = require('./tray-summary.cjs');
const { WidgetPublisher, loadWidgetBridge } = require('./widget-publisher.cjs');
const { electronTransport } = require('./kimi-work-transport.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { panelBounds, clampBounds, displayGeometry, validPreferences, isTheme, isKimiSource, isProviderOrder, isEnabledProviders, PROVIDER_ORDER } = require('./window-policy.cjs');
const { requestKimiWorkSubscription } = require('./kimi-work-api.cjs');
const { requestZcodeJson } = require('./zcode-account-api.cjs');
const { LocalStatusReader } = require('./local-status.cjs');
const { ProviderLauncher } = require('./provider-launcher.cjs');
const statusReader = new LocalStatusReader();
// Electron's network stack follows the system proxy. The API reader owns the fixed URL.
statusReader.kimiWorkReader.request = token => requestKimiWorkSubscription(token, { transport: electronTransport(net) });
statusReader.zcodeReader.accountReader.request = (family, kind, token) => requestZcodeJson(family, kind, token, { transport: electronTransport(net) });
let statusTimer;
let statusSnapshot = statusReader.current;
const fixtureVariant = process.env.AI_WATCH_TEST_STATUS;
const fixtureMode = Boolean(process.env.AI_WATCH_TEST_PROFILE && ['fixture', 'glow-running', 'glow-attention'].includes(fixtureVariant));
const providerLauncher = new ProviderLauncher({ fixtureMode });
async function refreshLocalStatus(force = false) {
  statusSnapshot = fixtureMode
    ? JSON.parse(await fs.promises.readFile(path.join(__dirname, '../tests/fixtures/local-status.json'), 'utf8'))
    : await statusReader.poll(force);
  if (fixtureMode && fixtureVariant?.startsWith('glow-')) {
    for (const id of PROVIDER_ORDER) Object.assign(statusSnapshot[id], { activity: 'running', activeTasks: 1, task: '合成测试 · 任务运行中' });
    if (fixtureVariant === 'glow-attention') Object.assign(statusSnapshot.codex, { activity: 'waiting', activeTasks: 1, waitingTasks: 1, waitingReason: 'both', task: '合成测试 · 待回答 / 待授权' });
  }
  if (fixtureMode) {
    statusSnapshot.sampledAt = new Date().toISOString();
    for (const id of PROVIDER_ORDER) statusSnapshot[id].sampledAt = statusSnapshot.sampledAt;
    statusSnapshot.kimi.kimiSource = preferences.kimiSource;
    if (preferences.kimiSource === 'work') Object.assign(statusSnapshot.kimi, {
      activity: 'unknown', activeTasks: 0, waitingTasks: 0, task: '合成测试 · Work 活动未知',
      quotas: [{ model: '共享积分', period: '订阅额度', remaining: 75, reset: '2099-01-01T00:00:00Z', resetKind: 'expiry' },
        { model: '共享积分', period: '赠送额度', remaining: 50, reset: '2099-01-01T00:00:00Z', resetKind: 'expiry' }],
    });
  }
  if (window && !window.isDestroyed()) window.webContents.send('panel:status-changed', statusSnapshot);
  panelTray?.updateMenu();
  publishWidgets();
  return statusSnapshot;
}

let window;
let panelTray;
let widgetPublisher;
let widgetHealth;
let preferences;
let collapsed = false;
let expandedBounds;
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
      { label: t('展开 / 收起'), accelerator: 'CommandOrControl+Shift+B', click: () => setCollapsed(!collapsed) },
      { label: t('收纳到菜单栏'), accelerator: 'CommandOrControl+Shift+H', enabled: panelTray.available, click: () => panelTray.store() },
      { label: t('额度速览'), accelerator: 'CommandOrControl+Shift+U', enabled: panelTray.available, click: () => panelTray.openMenu() },
      { label: t('重新贴边'), click: dock }, { type: 'separator' }, { role: 'quit', label: t('退出 AI Watch') },
    ] }] : []),
    { label: t('编辑'), submenu: [['undo','撤销'], ['redo','重做'], [null,null], ['cut','剪切'], ['copy','复制'], ['paste','粘贴'], ['selectAll','全选']].map(([role,label]) => role ? { role, label: t(label) } : { type: 'separator' }) },
  ]));
}
function currentState() {
  const display = screen.getDisplayMatching(window.getBounds());
  const { providerApps: _privateLaunchPaths, kimiWorkApp: _privateWorkPath, ...publicPreferences } = preferences;
  return { ...publicPreferences, collapsed, desktop: true, platform: process.platform,
    trayAvailable: panelTray?.available === true, stored: panelTray?.stored === true,
    widgetsAvailable: widgetPublisher?.available === true, widgetSyncError: widgetPublisher?.error === true,
    widgetBackground: panelTray?.widgetBackground === true,
    widgetLastPublishedAt: widgetPublisher?.lastPublishedAt || null,
    resolvedLanguage: currentLanguage().language,
    resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    scaleFactor: display.scaleFactor, bounds: window.getBounds() };
}
function emitState() {
  panelTray?.updateMenu();
  publishWidgets();
  if (window && !window.isDestroyed()) window.webContents.send('panel:changed', currentState());
}
function publishWidgets() {
  widgetPublisher?.publish(statusSnapshot, { ...preferences, language: currentLanguage().language }, { isTestData: fixtureMode });
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
  const display = screen.getDisplayMatching(window.getBounds());
  lastDisplayId = display.id;
  setBounds(panelBounds(display.workArea, preferences.side, collapsed));
  if (!collapsed) expandedBounds = window.getBounds();
  emitState();
}
function lock() {
  window.setAlwaysOnTop(preferences.locked, 'floating');
  if (process.platform !== 'win32') {
    window.setVisibleOnAllWorkspaces(preferences.locked, { visibleOnFullScreen: preferences.locked });
  }
  if (process.platform === 'darwin') window.setHiddenInMissionControl(preferences.locked);
}
function setCollapsed(value) {
  if (collapsed === value) return;
  const display = screen.getDisplayMatching(window.getBounds());
  if (value) {
    expandedBounds = window.getBounds();
    const old = expandedBounds;
    const newWidth = 46;
    setBounds({ ...old, width: newWidth, x: preferences.side === 'right' ? old.x + old.width - newWidth : old.x });
  } else {
    const current = window.getBounds();
    const width = panelBounds(display.workArea).width;
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

if (!app.requestSingleInstanceLock()) app.quit();
else {
  // A widget may only reopen the panel; no URL can launch a provider or carry a path.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (url === 'aiwatch://panel' || url === 'aiwatch://panel/') void panelTray?.restore();
  });
  app.on('second-instance', () => { void panelTray?.restore(); });
  app.whenReady().then(() => {
    preferences = readPreferences();
    widgetPublisher = new WidgetPublisher({ bridge: loadWidgetBridge({ app, fixtureMode,
      fixtureWidgets: process.env.AI_WATCH_TEST_WIDGETS === '1' }) });
    statusReader.setKimiSource(preferences.kimiSource);
    statusReader.qwenReader.setKeychainAllowed(!fixtureMode && preferences.qwenKeychainAllowed);
    nativeTheme.themeSource = preferences.theme;
    const display = screen.getPrimaryDisplay();
    for (const item of screen.getAllDisplays()) displayLayouts.set(item.id, displayGeometry(item));
    lastDisplayId = display.id;
    window = new BrowserWindow({
      ...panelBounds(display.workArea, preferences.side), title: 'AI Watch',
      frame: false, resizable: false, maximizable: false, fullscreenable: false,
      show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#111519' : '#edf1f5', autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    if (process.platform === 'win32') app.setAppUserModelId('app.aiwatch.panel');
    panelTray = new PanelTray({ app, window, Tray, Menu, nativeImage,
      getSummary: () => ({ rows: traySummary(statusSnapshot, { ...preferences, language: currentLanguage().language }), isTestData: fixtureMode }),
      getLanguage: () => currentLanguage().language,
      onChange: () => { emitState(); buildApplicationMenu(); }, onRefresh: () => refreshLocalStatus(true) });
    window.on('close', event => panelTray.handleClose(event));
    nativeTheme.on('updated', updateAppearance);
    buildApplicationMenu();
    lock();
    window.once('ready-to-show', () => window.show());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });
    if (devUrl) {
      if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(devUrl)) throw new Error('Dev URL must be local');
      window.loadURL(devUrl);
    } else window.loadFile(path.join(__dirname, '../dist/index.html'));
    window.on('move', () => {
      if (repositioning) return;
      const target = screen.getDisplayMatching(window.getBounds());
      if (target.id !== lastDisplayId) {
        lastDisplayId = target.id;
        const dimensions = panelBounds(target.workArea, preferences.side, collapsed);
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
    handle('panel:refresh', () => refreshLocalStatus(true));
    handle('panel:lock', (value) => {
      if (typeof value !== 'boolean') throw new Error('Invalid lock state');
      preferences.locked = value; lock(); savePreferences(); emitState(); return currentState();
    });
    handle('panel:collapse', (value) => {
      if (typeof value !== 'boolean') throw new Error('Invalid collapse state');
      setCollapsed(value); return currentState();
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
      const next = validPreferences({ ...value, language: preferences.language, theme: preferences.theme, providerOrder: preferences.providerOrder, enabledProviders: preferences.enabledProviders, qwenKeychainAllowed: preferences.qwenKeychainAllowed,
        kimiSource: preferences.kimiSource, kimiWorkApp: preferences.kimiWorkApp, widgetsEnabled: preferences.widgetsEnabled, animeMode: preferences.animeMode, providerApps: preferences.providerApps });
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
    handle('panel:open-provider', (id) => providerLauncher.launch(id,
      id === 'kimi' && preferences.kimiSource === 'work' ? preferences.kimiWorkApp : preferences.providerApps[id], preferences.kimiSource));
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
      if (!fixtureMode && !value) {
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
    handle('panel:kimi-source', async (value) => {
      if (!isKimiSource(value)) throw new Error('Invalid Kimi source');
      const previous = preferences.kimiSource;
      preferences.kimiSource = value;
      try { savePreferences(); } catch (error) { preferences.kimiSource = previous; throw error; }
      const pending = statusReader.pending;
      statusReader.setKimiSource(value);
      statusSnapshot = { ...statusSnapshot, sampledAt: new Date().toISOString(), kimi: statusReader.current.kimi };
      window.webContents.send('panel:status-changed', statusSnapshot);
      emitState();
      if (pending) await pending.catch(() => {});
      await refreshLocalStatus(true);
      return currentState();
    });
    handle('panel:order', (value) => {
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
    handle('panel:quit', () => app.quit());
    void refreshLocalStatus().catch(() => {});
    statusTimer = setInterval(() => { void refreshLocalStatus().catch(() => {}); }, 5000);
    app.on('activate', () => { void panelTray.restore(); });
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { panelTray?.dispose(); clearInterval(statusTimer); nativeTheme.removeListener('updated', updateAppearance); statusReader.codexAttention.close(); statusReader.codexQuotaReader.close(); });
}
