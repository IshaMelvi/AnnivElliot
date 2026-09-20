const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  listSources: () => ipcRenderer.invoke('list-sources'),
  selectSource: (id) => ipcRenderer.invoke('select-source', id)
});
