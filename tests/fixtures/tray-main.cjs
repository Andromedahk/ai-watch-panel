// Observe the real native menu in an isolated test process, without adding a
// production IPC endpoint or exposing Electron objects to the renderer.
const { Tray } = require('electron');
const setContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (menu) {
  global.aiWatchTestTray = this;
  global.aiWatchTestMenu = menu;
  return setContextMenu.call(this, menu);
};
require('../../electron/main.cjs');
