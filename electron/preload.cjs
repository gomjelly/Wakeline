// 렌더러에 노출하는 최소 API (window.wakeline)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wakeline', {
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  getWindowState: () => ipcRenderer.invoke('window:state'),
  moveToDisplay: (displayId, fullscreen) => ipcRenderer.invoke('window:moveToDisplay', displayId, fullscreen),
  setFullscreen: (on) => ipcRenderer.invoke('window:setFullscreen', on),
  listCaptureSources: () => ipcRenderer.invoke('capture:listSources'),
  selectCaptureSource: (id) => ipcRenderer.invoke('capture:select', id),
  getTestConfig: () => ipcRenderer.invoke('test:config'),
  getTestVideo: () => ipcRenderer.invoke('test:video'),
  sendMetrics: (line) => ipcRenderer.send('test:metrics', line),
  onDisplaysChanged: (cb) => {
    const handler = (_e, displays) => cb(displays);
    ipcRenderer.on('displays:changed', handler);
    return () => ipcRenderer.removeListener('displays:changed', handler);
  },
  onWindowState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('window:state', handler);
    return () => ipcRenderer.removeListener('window:state', handler);
  },
});
