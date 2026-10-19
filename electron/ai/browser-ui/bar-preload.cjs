// Preload for the 萤火浏览器 toolbar: a handful of navigation calls, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ffBar', {
  navigate: (text) => ipcRenderer.send('ffbar', 'navigate', String(text).slice(0, 4000)),
  back: () => ipcRenderer.send('ffbar', 'back'),
  forward: () => ipcRenderer.send('ffbar', 'forward'),
  reload: () => ipcRenderer.send('ffbar', 'reload'),
  home: () => ipcRenderer.send('ffbar', 'home'),
  refresh: () => ipcRenderer.send('ffbar', 'refresh'),
  focusPage: () => ipcRenderer.send('ffbar', 'focus-page'),
  onState: (cb) => { ipcRenderer.on('ffbar:state', (_e, s) => cb(s)); },
  onFocusUrl: (cb) => { ipcRenderer.on('ffbar:focus-url', () => cb()); },
});
