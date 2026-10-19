// 萤火 · Agent 工作台 — desktop shell.
// Loads the built web app (dist/index.html) in a locked-down window: no Node in the page, context
// isolation and sandbox on, external links open in the system browser, in-app navigation stays put.
// A tray icon keeps it reachable: closing the window can tuck it into the tray while runs go on.
const { app, BrowserWindow, shell, Menu, Tray, Notification, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ai = require('./ai/index.cjs');
const browser = require('./ai/browser.cjs');

// One window per user: a second launch focuses the existing one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
/** Set once the app is really quitting, so closing the window no longer hides it. */
let quitting = false;
/** Mirrors 设置 › 关闭窗口时缩小到托盘 (the page tells us on load and on change). */
let closeToTray = true;

const APP_URL = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
const ICON = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  try { fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...readState(), ...patch })); } catch { /* not important */ }
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/** Ask the page to do something (from the tray menu or a notification). */
function command(cmd, show = true) {
  if (show) showWindow();
  if (win) win.webContents.send('app:command', cmd);
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开萤火', click: showWindow },
    { label: '新建任务', click: () => command({ type: 'new' }) },
    { label: '打开萤火浏览器', click: () => browser.open() },
    { type: 'separator' },
    { label: '关闭窗口时缩小到托盘', type: 'checkbox', checked: closeToTray, click: (item) => command({ type: 'close-to-tray', value: item.checked }, false) },
    { type: 'separator' },
    { label: '退出萤火', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  if (tray) return;
  let image = nativeImage.createFromPath(ICON);
  if (image.isEmpty()) image = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
  tray = new Tray(process.platform === 'win32' ? image : image.resize({ width: 16, height: 16 }));
  tray.setToolTip('萤火 · Agent 工作台');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => (win && win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
}

/** Only the app's own page may talk to the shell. */
const fromApp = (e) => !!e.senderFrame && typeof e.senderFrame.url === 'string' && e.senderFrame.url.split('#')[0] === APP_URL;

ipcMain.on('app:prefs', (e, prefs) => {
  if (!fromApp(e) || !prefs || typeof prefs !== 'object') return;
  if (typeof prefs.closeToTray === 'boolean') closeToTray = prefs.closeToTray;
  if (tray) tray.setContextMenu(trayMenu());
});

// A system notification while the window is hidden or minimized (an approval waiting, a run finished).
ipcMain.on('app:notify', (e, n) => {
  if (!fromApp(e) || !n || typeof n.title !== 'string' || !Notification.isSupported()) return;
  if (win && win.isVisible() && !win.isMinimized() && win.isFocused()) return;
  const note = new Notification({ title: n.title.slice(0, 80), body: typeof n.body === 'string' ? n.body.slice(0, 240) : '', icon: ICON, silent: false });
  note.on('click', () => (n.command && typeof n.command === 'object' ? command(n.command) : showWindow()));
  note.show();
});

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
  // The close button tucks the window into the tray (when that setting is on); runs keep going.
  win.on('close', (event) => {
    if (quitting || !closeToTray || !tray) return;
    event.preventDefault();
    win.hide();
    if (!readState().trayHinted) {
      writeState({ trayHinted: true });
      tray.displayBalloon({ title: '萤火还在托盘里', content: '任务会继续在后台运行。点托盘图标打开；右键可以退出，或在设置里改成关闭即退出。', iconType: 'info' });
    }
  });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', showWindow);

app.whenReady().then(() => {
  // Windows groups notifications by this id (the installer registers the same one).
  if (process.platform === 'win32') app.setAppUserModelId('io.github.xtdf0224-boop.firefly-harness');
  ai.register();
  createTray();
  createWindow();
});
app.on('window-all-closed', () => { if (quitting || !closeToTray) app.quit(); });
// Never leave a CLI agent running after the app is gone.
app.on('before-quit', () => { quitting = true; ai.stopAll(); });
