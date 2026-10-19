// 萤火 · Agent 工作台 — desktop shell.
// Loads the built web app (dist/index.html) in a locked-down window: no Node in the page, context
// isolation and sandbox on, external links open in the system browser, in-app navigation stays put.
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('node:path');

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
  // Never navigate the app window away from the bundled page.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
