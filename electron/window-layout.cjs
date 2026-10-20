const { panelBounds, displayGeometry, isLayout } = require('./window-policy.cjs');

// Native fullscreen transitions on macOS are asynchronous. Serialize changes and
// preserve the movable window's bounds before entering a fullscreen Space.
class WindowLayout {
  constructor({ window, screen, getPreferences, save, changed, pin, setBounds, platform = process.platform }) {
    Object.assign(this, { window, screen, getPreferences, save, changed, pin, setBounds, platform });
    this.pending = Promise.resolve(); this.transitioning = false; this.normalBounds = null;
    window.on('leave-full-screen', () => {
      if (this.transitioning || this.getPreferences().layout !== 'fullscreen') return;
      const preferences = this.getPreferences(); preferences.layout = preferences.windowLayout;
      this.restoreBounds(); this.pin(); this.save(); this.changed();
    });
  }
  change(layout) {
    if (!isLayout(layout)) return Promise.reject(new Error('Invalid layout'));
    const next = this.pending.then(() => this.apply(layout));
    this.pending = next.catch(() => {}); return next;
  }
  async nativeFullscreen(value) {
    if (this.window.isFullScreen() === value) return;
    const event = value ? 'enter-full-screen' : 'leave-full-screen';
    await new Promise((resolve, reject) => {
      const complete = () => { clearTimeout(timer); this.window.removeListener(event, complete); resolve(); };
      const timer = setTimeout(() => {
        this.window.removeListener(event, complete);
        if (this.window.isFullScreen() === value) resolve(); else reject(new Error('Fullscreen transition timed out'));
      }, 8000);
      this.window.once(event, complete);
      try { this.window.setFullScreen(value); } catch (error) { clearTimeout(timer); this.window.removeListener(event, complete); reject(error); }
    });
  }
  restoreBounds() {
    const display = this.screen.getDisplayMatching(this.normalBounds || this.window.getBounds());
    const physical = display.bounds ? `${display.id}:${displayGeometry(display)}` : null;
    // Dock animations can change workArea after a fullscreen transition. Restore
    // the saved frame exactly unless the physical monitor geometry changed.
    if (this.normalBounds && (!physical || physical === this.normalDisplay)) this.setBounds(this.normalBounds);
    else this.setBounds(panelBounds(display.workArea, this.getPreferences().side, false, this.getPreferences().windowLayout));
  }
  async apply(layout) {
    const preferences = this.getPreferences(), previous = preferences.layout;
    const previousNative = this.window.isFullScreen(), previousWindowLayout = preferences.windowLayout, beforeBounds = this.window.getBounds();
    if (previous === layout && this.window.isFullScreen() === (layout === 'fullscreen')) return;
    this.transitioning = true;
    try {
      if (layout === 'fullscreen') {
        this.normalBounds = this.window.getBounds();
        const display = this.screen.getDisplayMatching(this.normalBounds);
        this.normalDisplay = display.bounds ? `${display.id}:${displayGeometry(display)}` : null;
        if (previous !== 'fullscreen') preferences.windowLayout = previous;
        // Fullscreen belongs to its own desktop; temporarily suspend cross-desktop pinning.
        this.window.setAlwaysOnTop(false);
        if (this.platform !== 'win32') this.window.setVisibleOnAllWorkspaces(false);
        if (this.platform === 'darwin') this.window.setHiddenInMissionControl(false);
        await this.nativeFullscreen(true);
      } else {
        if (this.window.isFullScreen()) { await this.nativeFullscreen(false); this.restoreBounds(); }
        const old = this.window.getBounds(), display = this.screen.getDisplayMatching(old);
        const width = panelBounds({ ...display.workArea, height: old.height }, preferences.side, false, layout).width;
        // A mode change preserves the current height and movable edge. Explicit
        // docking and physical display changes still match the new work area.
        this.setBounds({ ...old, width,
          x: Math.round(Math.max(display.bounds?.x ?? display.workArea.x, Math.min(preferences.side === 'right' ? old.x + old.width - width : old.x,
            (display.bounds?.x ?? display.workArea.x) + display.workArea.width - width))) });
        preferences.windowLayout = layout;
      }
      preferences.layout = layout; this.save(); this.pin(); this.changed();
    } catch (error) {
      try { await this.nativeFullscreen(previousNative); if (!previousNative) this.setBounds(beforeBounds); } catch { /* Report the actual OS state if rollback also fails. */ }
      preferences.windowLayout = previousWindowLayout;
      preferences.layout = this.window.isFullScreen() ? 'fullscreen' : previous === 'fullscreen' ? previousWindowLayout : previous;
      this.pin(); this.changed(); throw error;
    } finally { this.transitioning = false; }
  }
}
module.exports = { WindowLayout };
