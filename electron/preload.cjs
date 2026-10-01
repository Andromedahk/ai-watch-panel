const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  getState: () => ipcRenderer.invoke('panel:state'),
  getStatus: () => ipcRenderer.invoke('panel:status'),
  refreshStatus: () => ipcRenderer.invoke('panel:refresh'),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('panel:status-changed', listener);
    return () => ipcRenderer.removeListener('panel:status-changed', listener);
  },
  setLocked: (locked) => ipcRenderer.invoke('panel:lock', locked),
  setCollapsed: (collapsed) => ipcRenderer.invoke('panel:collapse', collapsed),
  configure: (preferences) => ipcRenderer.invoke('panel:configure', preferences),
  dock: () => ipcRenderer.invoke('panel:dock'),
  chooseImage: (provider) => ipcRenderer.invoke('panel:image', provider),
  quit: () => ipcRenderer.invoke('panel:quit'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('panel:changed', listener);
    return () => ipcRenderer.removeListener('panel:changed', listener);
  },
});
