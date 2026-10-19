// 萤火 · Agent 工作台 — desktop shell.
// Loads the built web app (dist/index.html) in a locked-down window: no Node in the page, context
// isolation and sandbox on, external links open in the system browser, in-app navigation stays put.
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('node:path');
const ai = require('./ai/index.cjs');

// One window per user: a second launch focuses the existing one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/** @type {BrowserWindow | null} */
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#080d18',
    title: '萤火 · Agent 工作台',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // The boot clip is muted; this just lets it start without a click.
      autoplayPolicy: 'no-user-gesture-required',
      // Keep timers and media running when the window is covered (the boot clip must not stall).
      backgroundThrottling: false,
      // Model access (keys, CLI runs) — see electron/ai/index.cjs.
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  Menu.setApplicationMenu(null);

  win.once('ready-to-show', () => win && win.show());
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // Links with target=_blank (credits, GitHub) open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Never navigate the app window away from the bundled page — not even to another local file
  // (a dropped .html would otherwise run with the desktop bridge).
  const appUrl = require('node:url').pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
  const guard = (event, url) => {
    if (url.split('#')[0] === appUrl) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-frame-navigate', (event) => { if (!event.isMainFrame) return; guard(event, event.url); });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  ai.register();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
// Never leave a CLI agent running after the window is gone.
app.on('before-quit', () => ai.stopAll());
