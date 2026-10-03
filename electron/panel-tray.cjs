const path = require('node:path');
const { createI18n } = require('./i18n.cjs');

// Hiding preserves the renderer and readers. Without a tray, never hide the app.
class PanelTray {
  constructor({ app, window, Tray, Menu, nativeImage, platform = process.platform,
    onChange = () => {}, onRefresh = () => {}, getSummary = () => ({ rows: [], isTestData: false }), getLanguage = () => 'zh-CN', now = Date.now,
    schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { app, window, platform, onChange, now, schedule, cancel, getSummary, getLanguage, Menu, onRefresh });
    this.stored = false;
    this.quitting = false;
    this.revision = 0;
    this.lastDockHide = -Infinity;
    this.dockTimer = null;
    this.tray = null;
    try {
      const assets = path.join(__dirname, 'assets');
      let icon = path.join(assets, platform === 'win32' ? 'tray.ico' : 'tray.png');
      if (platform === 'darwin') {
        icon = nativeImage.createFromPath(path.join(assets, 'trayTemplate.png'));
        if (icon.isEmpty()) throw new Error('Missing tray image');
        icon.setTemplateImage(true);
      }
      this.tray = new Tray(icon);
      this.updateMenu();
      if (platform === 'win32') {
        this.tray.on('click', () => this.openMenu());
        this.tray.on('double-click', () => { void this.restore(); });
      } else if (platform !== 'darwin') {
        this.tray.on('click', () => { void this.restore(); });
      }
    } catch {
      this.tray?.destroy();
      this.tray = null;
    }
  }
  get available() { return Boolean(this.tray && !this.tray.isDestroyed()); }

  updateMenu() {
    if (!this.available) return;
    const { rows, isTestData } = this.getSummary();
    const i18n = createI18n(this.getLanguage());
    const { t } = i18n;
    const nativeLabel = value => i18n.dir === 'rtl' ? '\u200f' + value : value;
    const signature = JSON.stringify({ language: i18n.language, rows, isTestData, stored: this.stored });
    if (signature !== this.menuSignature) {
      this.menu = this.Menu.buildFromTemplate([
        { label: nativeLabel(t('额度速览') + ' · ' + t(isTestData ? '测试数据' : '每个模块一项')), enabled: false },
        ...(rows.length ? rows.map(row => ({ id: `quota-${row.id}`, label: nativeLabel(row.label), enabled: false }))
          : [{ label: nativeLabel(t('尚未启用监看模块')), enabled: false }]),
        { type: 'separator' },
        { id: 'show-panel', label: nativeLabel(t('显示面板')), click: () => { void this.restore(); } },
        { id: 'store-panel', label: this.platform === 'darwin' ? nativeLabel(t('收纳到菜单栏')) : nativeLabel(t('收纳到托盘')), enabled: !this.stored, click: () => this.store() },
        { label: nativeLabel(t('刷新本地状态')), click: () => { void Promise.resolve().then(this.onRefresh).catch(() => {}); } },
        { type: 'separator' },
        { label: nativeLabel(t('退出 AI Watch')), click: () => this.app.quit() },
      ]);
      this.tray.setContextMenu(this.menu);
      this.menuSignature = signature;
    }
    this.tray.setToolTip('AI Watch · ' + t(this.stored ? '已收纳，后台监看中' : 'AI 工具监看面板'));
  }
  openMenu() {
    if (!this.available || this.quitting) return;
    this.updateMenu();
    if (this.platform === 'darwin' || this.platform === 'win32') this.tray.popUpContextMenu(this.menu);
  }
  store() {
    if (!this.available || this.window.isDestroyed() || this.quitting) return false;
    if (this.stored) return true;
    ++this.revision;
    this.stored = true;
    this.window.hide();
    if (this.platform === 'win32') this.window.setSkipTaskbar(true);
    if (this.platform === 'darwin') this.hideDock();
    this.updateMenu();
    this.onChange();
    return true;
  }
  hideDock() {
    const delay = Math.max(0, 1100 - (this.now() - this.lastDockHide));
    const hide = () => {
      this.dockTimer = null;
      if (!this.stored || this.quitting) return;
      this.app.dock.hide();
      this.lastDockHide = this.now();
    };
    // Electron/macOS can ignore two dock.hide calls less than a second apart.
    if (delay) this.dockTimer = this.schedule(hide, delay);
    else hide();
  }
  async restore() {
    if (this.window.isDestroyed() || this.quitting) return false;
    const revision = ++this.revision;
    this.stored = false;
    if (this.dockTimer !== null) this.cancel(this.dockTimer);
    this.dockTimer = null;
    if (this.platform === 'darwin') {
      try { await this.app.dock.show(); } catch { /* The panel can still be shown. */ }
    }
    // A later store or quit wins over a pending Dock restoration.
    if (revision !== this.revision || this.quitting || this.window.isDestroyed()) return false;
    if (this.platform === 'win32') this.window.setSkipTaskbar(false);
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
    this.updateMenu();
    this.onChange();
    return true;
  }
  handleClose(event) {
    if (this.quitting || !this.available) return;
    if (this.store()) event.preventDefault();
  }
  dispose() {
    this.quitting = true;
    ++this.revision;
    if (this.dockTimer !== null) this.cancel(this.dockTimer);
    this.dockTimer = null;
    this.tray?.destroy();
    this.tray = null;
  }
}
module.exports = { PanelTray };
