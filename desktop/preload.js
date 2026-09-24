const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  listSources: (extended = false) => ipcRenderer.invoke('list-sources', extended === true),
  selectSource: (id, systemAudio = true) => ipcRenderer.invoke('select-source', id, systemAudio)
});
