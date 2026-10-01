const { app, BrowserWindow, ipcMain, screen, dialog, Menu, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { panelBounds, clampBounds, validPreferences } = require('./window-policy.cjs');

let window;
let preferences;
let collapsed = false;
let expandedBounds;
let lastDisplayId;
let repositioning = false;
const providerIds = ['claude', 'codex', 'antigravity', 'deepseek'];
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
function currentState() {
  const display = screen.getDisplayMatching(window.getBounds());
  return { ...preferences, collapsed, desktop: true, platform: process.platform,
    scaleFactor: display.scaleFactor, bounds: window.getBounds() };
}
function emitState() {
  if (window && !window.isDestroyed()) window.webContents.send('panel:changed', currentState());
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
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    preferences = readPreferences();
    const display = screen.getPrimaryDisplay();
    lastDisplayId = display.id;
    window = new BrowserWindow({
      ...panelBounds(display.workArea, preferences.side), title: 'AI Watch',
      frame: false, resizable: false, maximizable: false, fullscreenable: false,
      show: false, backgroundColor: '#111519', autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: 'AI Watch', submenu: [
        { role: 'about' }, { type: 'separator' },
        { label: '展开 / 收起', accelerator: 'CommandOrControl+Shift+B', click: () => setCollapsed(!collapsed) },
        { label: '重新贴边', click: dock }, { type: 'separator' }, { role: 'quit' },
      ] }] : []),
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    ]));
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
    for (const event of ['display-metrics-changed', 'display-removed']) screen.on(event, dock);
    handle('panel:state', currentState);
    handle('panel:lock', (value) => {
      if (typeof value !== 'boolean') throw new Error('Invalid lock state');
      preferences.locked = value; lock(); savePreferences(); emitState(); return currentState();
    });
    handle('panel:collapse', (value) => {
      if (typeof value !== 'boolean') throw new Error('Invalid collapse state');
      setCollapsed(value); return currentState();
    });
    handle('panel:configure', (value) => {
      const next = validPreferences(value);
      const changedSide = next.side !== preferences.side;
      preferences = next; savePreferences(); lock();
      if (changedSide) dock();
      emitState(); return currentState();
    });
    handle('panel:dock', () => { dock(); return currentState(); });
    handle('panel:image', async (provider) => {
      if (!providerIds.includes(provider)) throw new Error('Invalid provider');
      const result = await dialog.showOpenDialog(window, {
        title: '选择助手图片', properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (result.canceled) return null;
      const file = result.filePaths[0];
      if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('图片不能超过 8 MB');
      const image = require('electron').nativeImage.createFromPath(file);
      if (image.isEmpty()) throw new Error('无法读取这张图片');
      return image.resize({ width: 256 }).toDataURL();
    });
    handle('panel:quit', () => app.quit());
    app.on('activate', () => window.show());
  });
  app.on('window-all-closed', () => app.quit());
}
