const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  listSources: (extended = false) => ipcRenderer.invoke('list-sources', extended === true),
  selectSource: (id, systemAudio = true) => ipcRenderer.invoke('select-source', id, systemAudio),
  updates: {
    snapshot: () => ipcRenderer.invoke('updates:snapshot'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    setSessionActive: (active) => ipcRenderer.invoke('updates:setSessionActive', active),
    subscribe: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('updates:state', listener);
      return () => ipcRenderer.removeListener('updates:state', listener);
    }
  }
});
