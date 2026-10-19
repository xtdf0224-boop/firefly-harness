// The page's only door to the desktop: model access calls, all handled in electron/ai/index.cjs.
// API keys go in through saveKey and never come back out.
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
ipcRenderer.on('ai:event', (_e, ev) => { for (const l of listeners) l(ev); });
const commands = new Set();
ipcRenderer.on('app:command', (_e, cmd) => { for (const l of commands) l(cmd); });

contextBridge.exposeInMainWorld('fireflyDesktop', {
  version: 1,
  info: () => ipcRenderer.invoke('ai:info'),
  saveKey: (provider, key) => ipcRenderer.invoke('ai:key:save', provider, key),
  clearKey: (provider) => ipcRenderer.invoke('ai:key:clear', provider),
  detect: (req) => ipcRenderer.invoke('ai:detect', req),
  models: (req) => ipcRenderer.invoke('ai:models', req),
  openLogin: (req) => ipcRenderer.invoke('ai:login', req),
  test: (spec) => ipcRenderer.invoke('ai:test', spec),
  pickFolder: (start) => ipcRenderer.invoke('ai:folder:pick', start),
  workspaceFolder: (name) => ipcRenderer.invoke('ai:folder:workspace', name),
  openFolder: (dir) => ipcRenderer.invoke('ai:folder:open', dir),
  start: (spec) => ipcRenderer.invoke('ai:start', spec),
  input: (id, text) => ipcRenderer.invoke('ai:input', id, text),
  answer: (id, requestId, decision, input) => ipcRenderer.invoke('ai:answer', id, requestId, decision, input),
  stop: (id, how) => ipcRenderer.invoke('ai:stop', id, how),
  onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  /** The shell around the page: tray preferences, system notifications, commands from the tray menu. */
  app: {
    setPrefs: (prefs) => ipcRenderer.send('app:prefs', prefs),
    notify: (n) => ipcRenderer.send('app:notify', n),
    onCommand: (fn) => { commands.add(fn); return () => commands.delete(fn); },
  },
  browser: {
    open: () => ipcRenderer.invoke('browser:open'),
    clear: () => ipcRenderer.invoke('browser:clear'),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    import: () => ipcRenderer.invoke('skills:import'),
    confirmImport: (token) => ipcRenderer.invoke('skills:import:confirm', token),
    create: (name) => ipcRenderer.invoke('skills:create', name),
    installExamples: () => ipcRenderer.invoke('skills:examples'),
    setEnabled: (folder, enabled) => ipcRenderer.invoke('skills:enable', folder, enabled),
    remove: (folder) => ipcRenderer.invoke('skills:remove', folder),
    open: (folder) => ipcRenderer.invoke('skills:open', folder),
  },
});
