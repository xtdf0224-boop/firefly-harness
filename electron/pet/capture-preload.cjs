// Preload of the hidden capture page (dist/capture.html): a narrow bridge to electron/pet/capture.cjs.
// Nothing else of Electron or Node reaches the page.
const { contextBridge, ipcRenderer } = require('electron');

const commands = new Set();
const grabs = new Set();
ipcRenderer.on('pet-capture:cmd', (_e, c) => { for (const fn of commands) fn(c); });
ipcRenderer.on('pet-capture:grab', (_e, r) => { for (const fn of grabs) fn(r); });

contextBridge.exposeInMainWorld('fireflyCapture', {
  /** The page is ready to take its first command. */
  ready: () => ipcRenderer.send('pet-capture:ready'),
  /** { gen, live, error?, width?, height? } */
  state: (s) => ipcRenderer.send('pet-capture:state', s),
  /** { gen, state, since, change } */
  scene: (e) => ipcRenderer.send('pet-capture:scene', e),
  /** { id, ok, data?: Uint8Array, width?, height? } */
  result: (r) => ipcRenderer.send('pet-capture:result', r),
  /** { op: 'stop', gen }: `gen` numbers every start and stop on the desktop side, so the page can tell a late one from a current one. */
  onCommand: (fn) => { commands.add(fn); return () => commands.delete(fn); },
  onGrab: (fn) => { grabs.add(fn); return () => grabs.delete(fn); },
});
