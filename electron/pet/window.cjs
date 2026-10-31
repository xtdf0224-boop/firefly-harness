// The 桌宠 window: a transparent, frameless, always-on-top window that loads dist/pet.html.
// It never takes focus (so a game keeps its keyboard) except while the chat panel holds the keyboard, and it
// lets clicks fall through to whatever is underneath except where the sprite, the bubble or the panel is.
const { app, BrowserWindow, screen, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL, format: formatUrl } = require('node:url');

const BASE_W = 300;
const BASE_H = 400;
const MARGIN = 12;
/** The room (page pixels at 100 %) the window keeps above her head for the chat panel, open or not (see frameRect). */
const CHAT_H = 230;
/** The OS may refuse to hand over the keyboard: after this long without it the window stops being focusable. */
const FOCUS_WAIT_MS = 6000;
const SCALE_MIN = 0.6;
const SCALE_MAX = 1.6;
/** Own in-memory session: the microphone permission below must not leak into the main window. */
const PARTITION = 'firefly-pet';
const PAGE = path.join(__dirname, '..', '..', 'dist', 'pet.html');
/** Both spellings of the page's address (see pageUrls in main.cjs: under a path with ~ [ ] or % they differ). */
const PAGE_URLS = new Set([new URL(formatUrl({ protocol: 'file', slashes: true, pathname: path.resolve(PAGE) })).href, pathToFileURL(PAGE).href]);

/** @type {BrowserWindow | null} */
let win = null;
let scale = 1;
let wantShown = false;
let ready = false;
let loaded = false;
let lastState = null;
let loadWaiters = [];
let crashes = [];
/** The page kept crashing, so the window was let go: only the next show() builds a new one. */
let gaveUp = false;
/** When the window was last closed under us (Alt+F4 while the panel had the keyboard): it is built again, not in a loop. */
let closes = [];
/** The app is quitting (or Windows is ending the session): a window that closes now stays closed. */
let quitting = false;
let sessionReady = false;
let screenWired = false;

let interactive = false;
let dragging = false;
let dragStart = null;
/** A press that moves the pointer less than this (screen pixels) is a click on her, not a drag (the page's DRAG_PX). */
const DRAG_PX = 4;
/** The current value passed to setIgnoreMouseEvents, so it is only touched when it changes. */
let ignoring = null;

/** The chat panel is open (the window is taller) / holds the keyboard right now. */
let chatOpen = false;
let chatFocused = false;
let chatTimer = null;
/** Where she stands: her own rectangle, the bottom of the window. Kept here and never read back from the window: on
 *  Windows at fractional display scaling getBounds() can come back a pixel off what setBounds() was given, and each
 *  open/close re-deriving her place from it would walk her down the screen. */
let stand = null;
/** Where the user put her: the bottom centre of her rectangle ({ cx, bottom }), as dropped or as saved. `stand` is this
 *  kept on a display; a display that goes away or shrinks for a while (a monitor unplugged, a full-screen game at a lower
 *  resolution) moves her only for that while, and she is placed from here again when the screens change back. */
let home = null;
/** The window as last placed around `stand` (frameRect; moved into the work area while the panel is open, if it had to). */
let placed = null;
/** The window that had the keyboard before the panel took it (decimal HWND), to hand it back. */
let restoreTarget = null;

const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  try { fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...readState(), ...patch })); } catch { /* not important */ }
}

const alive = () => !!win && !win.isDestroyed() && !win.webContents.isDestroyed();
const clampScale = (s) => Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number.isFinite(s) ? s : 1)) * 100) / 100;
const sizeFor = (s) => ({ width: Math.round(BASE_W * s), height: Math.round(BASE_H * s) });

/** Keep the whole window on the display it mostly sits on (the one nearest its centre). */
function clampRect(r) {
  const d = screen.getDisplayNearestPoint({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  const b = d.bounds;
  return {
    x: Math.round(Math.min(Math.max(r.x, b.x), Math.max(b.x, b.x + b.width - r.width))),
    y: Math.round(Math.min(Math.max(r.y, b.y), Math.max(b.y, b.y + b.height - r.height))),
    width: r.width,
    height: r.height,
  };
}

/** Bottom-right of the primary display's work area: she stands on the taskbar. */
function defaultRect(size) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - size.width - MARGIN, y: wa.y + wa.height - size.height, ...size };
}

/** The bottom centre of a rectangle of hers. */
const feetOf = (r) => ({ cx: r.x + r.width / 2, bottom: r.y + r.height });

/** The bottom centre of where she stands. */
function feet() {
  return feetOf(stand);
}

/** Her window with the panel closed, standing at `f`. */
function standAt(f) {
  const size = sizeFor(scale);
  return { x: Math.round(f.cx - size.width / 2), y: Math.round(f.bottom - size.height), ...size };
}

const workAreaOf = (c) => screen.getDisplayNearestPoint({ x: Math.round(c.x + c.width / 2), y: Math.round(c.y + c.height / 2) }).workArea;

/**
 * The window around her standing in `c`: always as tall as with the chat panel open (a work area shorter than that gets
 * a shorter panel), her feet at its bottom. Above her head it draws nothing and lets clicks through, and it may reach
 * past the top of the screen. Opening or closing the panel then neither resizes nor moves it: on Windows a transparent
 * window that grows upward shows its old picture at the new place for a frame or two, so she jumped up and back each
 * time the panel opened, and the panel flashed in the wrong place without her when it closed.
 */
function frameRect(c) {
  const height = Math.max(c.height, Math.min(Math.round((BASE_H + CHAT_H) * scale), workAreaOf(c).height));
  return { x: c.x, y: c.y + c.height - height, width: c.width, height };
}

/**
 * The window with the panel open: the same as frameRect while the panel fits above her inside the work area. With no room
 * above her (or standing past a side of the work area) the whole window moves into the work area while the panel is
 * open, and she with it; it moves back when the panel closes.
 */
function openRect(c) {
  const wa = workAreaOf(c);
  const f = frameRect(c);
  return {
    x: Math.round(Math.min(Math.max(f.x, wa.x), Math.max(wa.x, wa.x + wa.width - f.width))),
    y: Math.round(Math.max(f.y, wa.y)),
    width: f.width,
    height: f.height,
  };
}

const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const nearRect = (a, b) => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;

/** Put the window around where she stands (`c`, her own size): the frame, or moved for the open panel when it has to. */
function place(c) {
  const r = chatOpen ? openRect(c) : frameRect(c);
  const was = placed;
  stand = c;
  placed = r;
  // Compared with what was set last, not only with getBounds(): at fractional display scaling that reads back a pixel
  // or two off, and every open and close would set the same rectangle again.
  if (!was || !sameRect(r, was) || !nearRect(win.getBounds(), r)) win.setBounds(r);
}

/** Where she was put last time (the first time: on the taskbar at the bottom right). Not kept on a display here: the one
 *  she was on may be missing for now, and placing her does that. */
function startHome() {
  const saved = readState().petBounds;
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return feetOf(defaultRect(sizeFor(scale)));
  const sized = Number.isFinite(saved.width) && Number.isFinite(saved.height) && saved.width > 0 && saved.height > 0;
  return feetOf({ x: saved.x, y: saved.y, ...(sized ? { width: saved.width, height: saved.height } : sizeFor(scale)) });
}

function saveBounds() {
  if (!alive() || !home) return;
  // Where the user put her, at her size: never the taller window of the open panel, nor a place a display change pushed
  // her to for a while.
  const { x, y, width, height } = standAt(home);
  writeState({ petBounds: { x, y, width, height } });
}

/* ───────────── click-through ───────────── */

function applyIgnore() {
  if (!alive()) return;
  // The open chat panel does not make the whole window solid: it is hit-tested like the figure (data-hit).
  const ignore = !(interactive || dragging);
  if (ignore === ignoring) return;
  ignoring = ignore;
  // forward: true keeps mousemove flowing to the page, so the UI can tell when the pointer reaches the sprite.
  if (ignore) win.setIgnoreMouseEvents(true, { forward: true }); else win.setIgnoreMouseEvents(false);
}

function setInteractive(on) {
  interactive = !!on;
  applyIgnore();
}

/**
 * Forget what the page last said about the pointer and put the window back to click-through. A reloaded page, a hidden
 * window or a lost focus can leave `interactive` / `dragging` stuck on, and then the whole window would swallow clicks.
 * `tell`: the page forgets too (it only reports changes, so after a hide it would never say the pointer is over her again).
 */
function resetPointer(tell) {
  interactive = false;
  dragging = false;
  dragStart = null;
  ignoring = null; // apply it again even if it looks unchanged
  applyIgnore();
  if (tell) send('pet-ui:command', { type: 'pointer' });
}

/* ───────────── when the page's state is lost ───────────── */

/** fn(why) when the page has reloaded or crashed, or the window was hidden or closed: whatever it was playing is gone. */
let resetCbs = [];
function onReset(fn) {
  if (typeof fn !== 'function') return () => {};
  resetCbs.push(fn);
  return () => { resetCbs = resetCbs.filter((f) => f !== fn); };
}
function notifyReset(why) {
  for (const fn of resetCbs) { try { fn(why); } catch { /* a listener must not break the others */ } }
}

/* ───────────── dragging ───────────── */

function drag(phase, x, y) {
  if (!alive()) return;
  let px = Number(x);
  let py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) ({ x: px, y: py } = screen.getCursorScreenPoint());
  if (phase === 'start') {
    dragging = true;
    dragStart = { px, py, stand: { ...stand }, moved: false };
    applyIgnore();
    return;
  }
  if (!dragStart) return;
  const dx = Math.round(px - dragStart.px);
  const dy = Math.round(py - dragStart.py);
  // Where she would stand, moved with the pointer.
  const s = { ...dragStart.stand, x: dragStart.stand.x + dx, y: dragStart.stand.y + dy };
  if (phase === 'move') {
    dragStart.moved = true;
    // The window as it is placed around her now (the panel may have opened or closed since the press), moved with her.
    // setBounds with a fixed size (not setPosition): moving across displays with different scaling would otherwise
    // let Windows resize the window under the pointer.
    win.setBounds({ x: s.x + placed.x - stand.x, y: s.y + placed.y - stand.y, width: placed.width, height: placed.height });
  } else if (phase === 'end') {
    const moved = dragStart.moved || Math.hypot(dx, dy) >= DRAG_PX;
    dragging = false;
    dragStart = null;
    applyIgnore();
    // A click (or a double-click) on her is not a drop: she stays where she stands, even where the open panel has
    // pushed her window away from her feet.
    if (!moved) return;
    // She stands where she was dropped (with the panel open, the window is placed around that again).
    place(clampRect(standAt({ cx: s.x + s.width / 2, bottom: s.y + s.height })));
    home = feet();
    saveBounds();
  }
}

/* ───────────── size ───────────── */

/** Resize around the bottom centre (her feet stay where the user put them) and remember the new size. */
function applyScale(next) {
  const s = clampScale(next);
  if (s === scale) return;
  scale = s;
  if (!alive() || !home) return;
  place(clampRect(standAt(home)));
  saveBounds();
}

/** The screens changed (one added, removed or resized): place her from where the user put her again. */
function reclamp() {
  if (!alive() || dragging || !home) return;
  place(clampRect(standAt(home)));
}

/* ───────────── the chat panel ───────────── */

/** Open the panel (the window already has room for it above her) and give it the keyboard. */
function openChat() {
  if (!alive()) return;
  if (!chatOpen) {
    const c = standAt(feet());
    chatOpen = true;
    place(c);
  }
  takeKeys();
}

/** The open panel takes the keyboard: the window is focusable only for this. */
function takeKeys() {
  if (!alive() || !chatOpen) return;
  chatFocused = win.isFocused();
  win.setFocusable(true);
  // Electron on Windows lets a focusable window into the taskbar again.
  win.setSkipTaskbar(true);
  if (!win.isVisible()) win.showInactive();
  win.focus();
  clearTimeout(chatTimer);
  // The OS may refuse to hand over the keyboard; do not stay focusable for nothing. The panel stays: a click into it tries again.
  chatTimer = setTimeout(() => { if (chatOpen && !chatFocused) letGoKeys(); }, FOCUS_WAIT_MS);
}

/** Back to a window that never takes focus (an open panel stays open). */
function letGoKeys() {
  clearTimeout(chatTimer);
  chatFocused = false;
  if (!alive()) return;
  win.setFocusable(false);
  win.setSkipTaskbar(true);
}

/** Close the panel: the window goes back around where she stands (if it moved for the panel), and the keyboard goes back
 *  to the window she took it from. */
function closeChat(notifyUi) {
  if (!chatOpen) return;
  const hadFocus = alive() && win.isFocused();
  const c = alive() ? standAt(feet()) : null;
  chatOpen = false;
  letGoKeys();
  if (alive()) {
    place(c);
    applyIgnore();
    if (notifyUi) send('pet-ui:command', { type: 'close-chat' });
  }
  // Only while she had it (Esc, ×, the hotkey, hidden): if the user clicked elsewhere, they chose a window already.
  if (hadFocus && restoreTarget) refocus(restoreTarget);
  restoreTarget = null;
}

/** Hand the keyboard back to a window by HWND (best effort; one short PowerShell call). */
function refocus(hwnd) {
  if (process.platform !== 'win32' || !/^\d{1,20}$/.test(String(hwnd))) return;
  if (hwnd === ownHwnd()) return;
  const script = [
    "Add-Type -Namespace FF -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool IsWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);'",
    '$h = [IntPtr][int64]$env:FF_HWND',
    'if ([FF.U]::IsWindow($h)) { if ([FF.U]::IsIconic($h)) { [void][FF.U]::ShowWindow($h, 9) }; [void][FF.U]::SetForegroundWindow($h) }',
  ].join('; ');
  // By full path: a bare name is looked up in the current folder first (where 萤火 was launched from).
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 10_000, env: { ...process.env, FF_HWND: String(hwnd) } }, () => {});
  } catch { /* not important */ }
}

function ownHwnd() {
  if (!alive()) return '';
  const buf = win.getNativeWindowHandle();
  return String(buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0));
}

/* ───────────── window ───────────── */

function prepareSession() {
  if (sessionReady) return;
  sessionReady = true;
  const ses = session.fromPartition(PARTITION);
  // Only the pet window's own page, and only the microphone (实时陪玩); no camera, no screen, nothing else.
  // Who asks is decided by identity, not by the page's URL as text.
  const fromPet = (wc) => !!wc && alive() && wc === win.webContents;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const types = Array.isArray(details && details.mediaTypes) ? details.mediaTypes : [];
    cb(permission === 'media' && fromPet(wc) && (!details || details.isMainFrame !== false) && types.length > 0 && types.every((t) => t === 'audio'));
  });
  ses.setPermissionCheckHandler((wc, permission) => permission === 'media' && fromPet(wc));
}

function wireScreen() {
  if (screenWired) return;
  screenWired = true;
  screen.on('display-added', reclamp);
  screen.on('display-removed', reclamp);
  screen.on('display-metrics-changed', reclamp);
}

/** Build the window again soon (it was closed under us while she is switched on), but not in a loop. */
function rebuildSoon() {
  const now = Date.now();
  closes = closes.filter((t) => now - t < 60_000);
  closes.push(now);
  if (closes.length > 3) return;
  setTimeout(() => { if (!alive() && wantShown && !quitting && !gaveUp) show(); }, 300);
}

/** The page will not stay up: the panel closes (the keyboard goes back) and the window goes; a dead page must not sit
 *  on the screen or hold the keyboard. The next show() builds a new one. */
function letGo(self) {
  gaveUp = true;
  closeChat(false);
  if (win === self && alive()) win.destroy();
}

function create() {
  if (alive()) return win;
  // Asked for again after the page kept crashing: a fresh start.
  if (gaveUp) { gaveUp = false; crashes = []; }
  prepareSession();
  wireScreen();
  ready = false;
  loaded = false;
  ignoring = null;
  interactive = false;
  dragging = false;
  dragStart = null;
  chatOpen = false;
  chatFocused = false;
  home = startHome();
  const r = clampRect(standAt(home));
  stand = r;
  placed = frameRect(r);
  win = new BrowserWindow({
    ...placed,
    show: false,
    transparent: true,
    frame: false,
    thickFrame: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    title: '萤火桌宠',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // The pet speaks without a click, and keeps animating while a game covers the screen.
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  const self = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  applyIgnore();

  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (event, url) => { if (!PAGE_URLS.has(url.split('#')[0])) event.preventDefault(); };
  wc.on('will-navigate', guard);
  wc.on('will-frame-navigate', (event) => { if (event.isMainFrame) guard(event, event.url); });

  win.once('ready-to-show', () => {
    ready = true;
    if (wantShown && alive()) { awake(true); win.showInactive(); }
  });
  wc.on('did-finish-load', () => {
    loaded = true;
    // A fresh page knows nothing of the pointer or of what the last one was playing.
    resetPointer();
    notifyReset('load');
    if (lastState) wc.send('pet-ui:state', lastState);
    // A reloaded page starts with the panel closed: open it again once the page listens.
    if (chatOpen) loadWaiters.push(() => { if (chatOpen && win === self) send('pet-ui:command', { type: 'chat' }); });
    // Let the page mount its listeners before anything is sent at it.
    setTimeout(() => { if (win === self) { const w = loadWaiters; loadWaiters = []; w.forEach((fn) => fn()); } }, 250);
  });
  // A crashed page (or one killed from outside) is a blank rectangle on top of the desktop: reload it, but not in a loop.
  // One that keeps crashing is let go.
  wc.on('render-process-gone', (_e, details) => {
    loaded = false;
    resetPointer();
    notifyReset('gone');
    if (win !== self || (details && details.reason === 'clean-exit')) return;
    const now = Date.now();
    crashes = crashes.filter((t) => now - t < 60_000);
    crashes.push(now);
    if (crashes.length > 3) { letGo(self); return; }
    setTimeout(() => { if (win === self && alive()) win.reload(); }, 1000);
  });
  win.on('focus', () => { if (chatOpen) chatFocused = true; });
  win.on('blur', () => {
    // Clicking elsewhere does not close the panel: she lets go of the keyboard, and outside the panel and her figure clicks
    // fall through again. A click back into the panel takes the keyboard again (focusChat).
    if (chatOpen) { letGoKeys(); restoreTarget = null; }
    if (win === self) resetPointer();
  });
  win.on('hide', () => {
    if (win !== self) return;
    resetPointer(true);
    notifyReset('hide');
  });
  // Logging off or shutting down closes every window: that is not one to build again.
  win.on('session-end', () => { quitting = true; });
  win.on('closed', () => {
    if (win !== self) return;
    win = null;
    ready = false;
    loaded = false;
    chatOpen = false;
    chatFocused = false;
    restoreTarget = null;
    clearTimeout(chatTimer);
    notifyReset('closed');
    const w = loadWaiters;
    loadWaiters = [];
    w.forEach((fn) => fn());
    // Closed under us (Alt+F4 while the panel had the keyboard): she is still switched on, so she comes back.
    if (wantShown && !quitting && !gaveUp) rebuildSoon();
  });
  win.loadFile(PAGE).catch(() => { /* a missing dist/pet.html leaves the window hidden */ });
  return win;
}

/** While she is on screen the page keeps animating under a covering game (no background throttling); while
 *  hidden (anti-cheat game in front, pet switched off) Chromium may pause its frames and timers again. */
function awake(on) {
  try { win.webContents.setBackgroundThrottling(!on); } catch { /* the page is going away */ }
}

function show() {
  wantShown = true;
  create();
  if (ready && alive()) { awake(true); win.showInactive(); }
}

function hide() {
  wantShown = false;
  // Hidden (switched off, an anti-cheat game in front): the panel goes with her, and so does whatever she was saying
  // (a hidden window's sound plays on).
  closeChat(true);
  send('pet-ui:command', { type: 'hush' });
  if (alive()) { awake(false); win.hide(); }
}

/** A voice test played in a window that is not switched on: it goes back to sleep like a hidden one (the sound plays on). */
function park() {
  if (alive() && !wantShown) awake(false);
}

/** The app is quitting: a window that closes from now on stays closed. */
function shutdown() {
  quitting = true;
}

const isVisible = () => alive() && win.isVisible();

/** Resolves once the pet page has loaded and had a moment to mount (or the window is gone). */
function whenReady() {
  if (!alive()) return Promise.resolve();
  if (loaded) return Promise.resolve();
  return new Promise((resolve) => loadWaiters.push(resolve));
}

/* ───────────── messages to the page ───────────── */

function send(channel, payload) {
  if (!alive() || !loaded) return;
  try { win.webContents.send(channel, payload); } catch { /* the page is going away */ }
}

function sendState(state) {
  lastState = state;
  send('pet-ui:state', state);
}
const sendLine = (line) => send('pet-ui:line', line);
const sendLineDelta = (d) => send('pet-ui:line-delta', d);
const sendAudio = (a) => send('pet-ui:audio', a);
const sendMood = (m) => send('pet-ui:mood', typeof m === 'string' ? { mood: m } : m);
/** The chat log (PetChatMsg): the whole of it, or one message. */
const sendChat = (m) => send('pet-ui:chat', m);

function sendCommand(c) {
  if (!c || typeof c.type !== 'string') return;
  if (c.type === 'chat') openChat();
  else if (c.type === 'close-chat') closeChat(false);
  send('pet-ui:command', c);
}

/** The panel is open / holds the keyboard. */
const chatState = () => ({ open: chatOpen, focused: chatOpen && alive() && win.isFocused() });

/** Which window gets the keyboard back when the panel closes (decimal HWND). */
function setRestoreTarget(hwnd) {
  restoreTarget = /^\d{1,20}$/.test(String(hwnd || '')) ? String(hwnd) : null;
}

module.exports = {
  create, get: () => (alive() ? win : null), show, hide, isVisible,
  sendState, sendLine, sendLineDelta, sendAudio, sendMood, sendCommand,
  setInteractive, drag, applyScale,
  // Beyond the fixed API (used by index.cjs):
  hwnd: ownHwnd, whenReady, setRestoreTarget, onReset,
  sendChat, chatState, focusChat: takeKeys, park, shutdown,
};
