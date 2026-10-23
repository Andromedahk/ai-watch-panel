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
  store: () => ipcRenderer.invoke('panel:store'),
  setWidgetsEnabled: (enabled) => ipcRenderer.invoke('panel:widgets-enabled', enabled),
  widgetBackground: () => ipcRenderer.invoke('panel:widget-background'),
  configure: (preferences) => ipcRenderer.invoke('panel:configure', preferences),
  setOrder: (order) => ipcRenderer.invoke('panel:order', order),
  setEnabled: (ids) => ipcRenderer.invoke('panel:enabled', ids),
  setQwenAccess: (allowed) => ipcRenderer.invoke('panel:qwen-access', allowed),
  setKimiSource: (source) => ipcRenderer.invoke('panel:kimi-source', source),
  setClaudeSource: (source) => ipcRenderer.invoke('panel:claude-source', source),
  setClaudeNetworkAccess: (allowed) => ipcRenderer.invoke('panel:claude-network-access', allowed),
  setClaudeHooks: (enabled) => ipcRenderer.invoke('panel:claude-hooks', enabled),
  requestClaudeActivityAccess: () => ipcRenderer.invoke('panel:claude-activity-access'),
  clearCache: () => ipcRenderer.invoke('panel:clear-cache'),
  setAnimeMode: (enabled) => ipcRenderer.invoke('panel:anime-mode', enabled),
  setInsights: (insights) => ipcRenderer.invoke('panel:insights', insights),
  setInsightOrder: (order) => ipcRenderer.invoke('panel:insight-order', order),
  setMascotInterval: (seconds) => ipcRenderer.invoke('panel:mascot-interval', seconds),
  setSkin: (skin) => ipcRenderer.invoke('panel:skin', skin),
  openProvider: (provider) => ipcRenderer.invoke('panel:open-provider', provider),
  chooseProviderApp: (provider) => ipcRenderer.invoke('panel:choose-provider-app', provider),
  setLanguage: (language) => ipcRenderer.invoke('panel:language', language),
  setLayout: (layout) => ipcRenderer.invoke('panel:layout', layout),
  setTheme: (theme) => ipcRenderer.invoke('panel:theme', theme),
  dock: () => ipcRenderer.invoke('panel:dock'),
  chooseImage: (provider) => ipcRenderer.invoke('panel:image', provider),
  openRepository: () => ipcRenderer.invoke('panel:open-repository'),
  quit: () => ipcRenderer.invoke('panel:quit'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('panel:changed', listener);
    return () => ipcRenderer.removeListener('panel:changed', listener);
  },
});
