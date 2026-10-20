const fs = require('node:fs');
const path = require('node:path');
const { makeWidgetSnapshot } = require('./widget-snapshot.cjs');

// Only the main process owns this bridge. Neither credentials nor file paths cross IPC.
class WidgetPublisher {
  constructor({ bridge = null, now = Date.now } = {}) {
    this.bridge = bridge;
    this.now = now;
    this.lastPublishedAt = null;
    this.lastReload = -Infinity;
    this.signature = null;
    this.selection = null;
    this.error = false;
  }
  get available() {
    try { return this.bridge?.available() === true; } catch { return false; }
  }
  publish(snapshot, preferences, { isTestData = false } = {}) {
    if (!preferences.widgetsEnabled || !this.available) return false;
    const now = this.now();
    const value = makeWidgetSnapshot(snapshot, preferences, { now, isTestData });
    // Heartbeats keep collection time fresh without writing on every five-second poll.
    const signature = JSON.stringify({ theme: value.theme, language: value.language, isTestData: value.isTestData,
      rows: value.rows.map(({ observedAt: _observed, ...row }) => row) });
    // Clearing authentication or changing the visible source must invalidate the
    // system timeline promptly, even within the normal refresh budget.
    const selection = JSON.stringify({ theme: value.theme, language: value.language,
      rows: value.rows.map(row => [row.id, row.name, snapshot?.[row.id]?.connection === 'auth-required']) });
    if (signature === this.signature && now - Date.parse(this.lastPublishedAt) < 60000) return true;
    const reload = selection !== this.selection || now - this.lastReload >= 300000;
    try {
      if (this.bridge.publish(JSON.stringify(value), reload) !== true) throw new Error('Widget publication failed');
      this.signature = signature;
      this.selection = selection;
      this.lastPublishedAt = new Date(now).toISOString();
      if (reload) this.lastReload = now;
      this.error = false;
      return true;
    } catch {
      this.error = true;
      return false;
    }
  }
  clear() {
    if (!this.available) return false;
    try {
      if (this.bridge.clear() !== true) throw new Error('Widget clearing failed');
      this.signature = this.selection = this.lastPublishedAt = null;
      this.lastReload = -Infinity;
      this.error = false;
      return true;
    } catch { this.error = true; return false; }
  }
}

function loadWidgetBridge({ app, platform = process.platform, fixtureMode = false, fixtureWidgets = false }) {
  if (platform !== 'darwin') return null;
  if (fixtureMode && fixtureWidgets) {
    // Isolated GUI acceptance never touches the real shared container or widget gallery.
    const file = path.join(app.getPath('userData'), 'widget-snapshot.json');
    return { available: () => true, publish(json) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', json, { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
      return true;
    }, clear() { fs.rmSync(file, { force: true }); return true; } };
  }
  if (fixtureMode || !app.isPackaged) return null;
  try { return require(path.join(process.resourcesPath, 'widgets', 'widget-bridge.node')); }
  catch { return null; }
}

module.exports = { WidgetPublisher, loadWidgetBridge };
