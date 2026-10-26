const { contextBridge, ipcRenderer } = require('electron');
const subscribe = channel => callback => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
// This surface cannot request filesystem access, open apps, refresh, sort or grant permissions.
contextBridge.exposeInMainWorld('panel', {
  getState: () => ipcRenderer.invoke('screen:state'),
  getStatus: () => ipcRenderer.invoke('screen:status'),
  onState: subscribe('panel:changed'),
  onStatus: subscribe('panel:status-changed'),
});
