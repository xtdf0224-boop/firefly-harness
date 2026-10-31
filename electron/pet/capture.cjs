// Looking at the game: a hidden page (dist/capture.html) captures ONE window with getDisplayMedia, judges
// "is it moving / a cut scene / black" locally, and hands out a JPEG or PNG of the latest frame on request.
// Nothing here decides *whether* she may look: electron/pet/index.cjs only calls start(hwnd) for the
// foreground window that policy.cjs marked 'watch'. Frames never leave this process unless the caller
// sends one on.
//
// start(hwnd) names the window that is *wanted* until stop(). While it is wanted, a failed start, frames that
// stop coming, or a crashed page are retried here (1, 3, then every 10 s), so status().active stays true
// across retries and status().live says whether pixels are flowing.
const { BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const path = require('node:path');
const { pathToFileURL, format: formatUrl } = require('node:url');

const PARTITION = 'firefly-capture';
const PAGE = path.join(__dirname, '..', '..', 'dist', 'capture.html');
/** The page's address as win.loadFile gives it to Chromium, and as pathToFileURL spells it: they differ when the
 *  folder has ~ [ ] or a bare % in it (C:\Users\ADMINI~1\…). Who is asking is decided by identity below, not by this. */
const PAGE_URLS = new Set([new URL(formatUrl({ protocol: 'file', slashes: true, pathname: path.resolve(PAGE) })).href, pathToFileURL(PAGE).href]);
const GRAB_TIMEOUT_MS = 4000;
const READY_TIMEOUT_MS = 8000;
/** The page's own start can take about 7.5 s when its frame reader stays silent (2.5 s + a 4 s <video> fallback). */
const START_EXEC_TIMEOUT_MS = 10_000;
/** After the page says it started: how long its first "live" message may take to arrive. */
const LIVE_GRACE_MS = 2000;
/** Waits before the 1st, 2nd, 3rd... retry; the last one repeats. */
const RETRY_MS = [1000, 3000, 10_000];
/** The hidden page is closed this long after the last stop(), to give its memory back. */
const IDLE_CLOSE_MS = 90_000;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

/** @type {BrowserWindow | null} */
let win = null;
let ready = false;
let readyWaiters = [];
let wired = false;
let sessionReady = false;
let idleTimer = null;
let retryTimer = null;

/**
 * The window that is wanted: { hwnd, gen, n, run, fails, abort } or null.
 * gen: the page session whose messages count (0 = none right now); n: attempt counter;
 * run: the attempt in flight; fails: failures in a row; abort: ends the attempt in flight early.
 */
let target = null;
/** Increases on every start attempt and every stop; the page keeps the highest it has seen and ignores older ones. */
let gen = 0;
let live = false;
let black = false;
let lastErr = '';
let size = null;
let sceneCbs = [];
let liveCbs = [];
let grabSeq = 0;
/** id → { resolve, timer } */
const pending = new Map();

const alive = () => !!win && !win.isDestroyed() && !win.webContents.isDestroyed();
const fromPage = (e) => alive() && e.sender === win.webContents;
const decimal = (v) => (/^\d{1,20}$/.test(String(v || '')) && String(v) !== '0' ? String(v) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function failPending() {
  for (const [, p] of pending) { clearTimeout(p.timer); p.resolve(null); }
  pending.clear();
}

/** The one place `live` changes, so listeners hear every change. */
function setLive(v) {
  if (live === v) return;
  live = v;
  for (const fn of liveCbs) { try { fn(live); } catch { /* a listener must not break the others */ } }
}

/* ───────────── the hidden page ───────────── */

function prepareSession() {
  if (sessionReady) return;
  sessionReady = true;
  const ses = session.fromPartition(PARTITION);
  // The page may capture, and only the window we picked: no picker, no screen, no audio.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const t = target;
      const frame = request.frame;
      if (!t || !t.gen || !alive() || !frame || frame !== win.webContents.mainFrame) { callback({}); return; }
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      // Stopped or switched while the list was being read: hand out nothing.
      if (target !== t || !t.gen) { callback({}); return; }
      const src = sources.find((s) => s.id === `window:${t.hwnd}:0`);
      if (!src) { lastErr = 'the game window is not in the capture list'; callback({}); return; }
      callback({ video: src });
    } catch (e) {
      lastErr = `capture source: ${e && e.message || e}`;
      try { callback({}); } catch { /* answered already */ }
    }
  }, { useSystemPicker: false });
  const fromCapturePage = (wc) => alive() && wc === win.webContents;
  // Electron 44 asks for getDisplayMedia as 'media' with no camera/microphone types; anything that names a
  // device (a getUserMedia call) is refused, and the display-media handler above still picks the only window.
  const displayOnly = (permission, details) => permission === 'display-capture'
    || (permission === 'media' && !!details && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(!!wc && fromCapturePage(wc) && displayOnly(permission, details)));
  ses.setPermissionCheckHandler((wc, permission, _origin, details) => !!wc && fromCapturePage(wc)
    && (permission === 'display-capture' || (permission === 'media' && !(details && details.mediaType && details.mediaType !== 'unknown'))));
}

function wireIpc() {
  if (wired) return;
  wired = true;
  ipcMain.on('pet-capture:ready', (e) => {
    if (!fromPage(e)) return;
    ready = true;
    const w = readyWaiters;
    readyWaiters = [];
    w.forEach((fn) => fn(true));
  });
  ipcMain.on('pet-capture:state', (e, s) => {
    if (!fromPage(e) || !s || typeof s !== 'object' || !target || !target.gen || s.gen !== target.gen) return;
    const t = target;
    const next = !!s.live;
    const dropped = live && !next;
    if (!next) { black = false; size = null; }
    else if (Number.isFinite(s.width) && Number.isFinite(s.height)) size = { width: s.width, height: s.height };
    if (typeof s.error === 'string' && s.error) lastErr = `capture page: ${s.error.slice(0, 200)}`;
    setLive(next);
    // Frames stopped coming (the window closed, the capture was cut off) while the window is still wanted.
    if (dropped && target === t) {
      t.gen = 0;
      if (!t.run) scheduleRetry(t);
    }
  });
  ipcMain.on('pet-capture:scene', (e, ev) => {
    if (!fromPage(e) || !ev || typeof ev !== 'object' || !target || !target.gen || ev.gen !== target.gen) return;
    if (!['static', 'motion', 'cut', 'settled', 'black'].includes(ev.state)) return;
    black = ev.state === 'black';
    // The page reports how long the condition had already held; the brain wants the wall-clock moment it began.
    const held = Math.max(0, Number(ev.since) || 0);
    const out = { state: ev.state, since: Date.now() - held, change: Math.min(1, Math.max(0, Number(ev.change) || 0)) };
    for (const fn of sceneCbs) { try { fn(out); } catch { /* a listener must not break the others */ } }
  });
  ipcMain.on('pet-capture:result', (e, r) => {
    if (!fromPage(e) || !r || typeof r !== 'object') return;
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    clearTimeout(p.timer);
    if (!r.ok || !r.data) { p.resolve(null); return; }
    const data = Buffer.from(r.data);
    p.resolve(data.length && data.length <= MAX_RESULT_BYTES ? { data, width: Number(r.width) || 0, height: Number(r.height) || 0 } : null);
  });
}

/** Everything that belonged to the page that is gone: no frames, no pending grabs, nobody waiting for "ready". */
function dropWindowState() {
  ready = false;
  black = false;
  size = null;
  failPending();
  const w = readyWaiters;
  readyWaiters = [];
  w.forEach((fn) => fn(false));
  setLive(false);
}

function ensureWindow() {
  if (alive()) return;
  prepareSession();
  ready = false;
  win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      partition: PARTITION,
      preload: path.join(__dirname, 'capture-preload.cjs'),
      // It is never shown; its timers and frames must keep running anyway.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  const self = win;
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (event, url) => { if (!PAGE_URLS.has(url.split('#')[0])) event.preventDefault(); };
  wc.on('will-navigate', guard);
  wc.on('will-frame-navigate', (event) => { if (event.isMainFrame) guard(event, event.url); });
  wc.on('render-process-gone', (_e, details) => lostWindow(self, `capture page crashed${details && details.reason ? ` (${details.reason})` : ''}`));
  win.on('closed', () => lostWindow(self, 'capture page closed'));
  win.loadFile(PAGE).catch((e) => { lastErr = `capture page: ${e && e.message || e}`; });
}

/** The page died under us (renderer crash, closed from outside): drop it, and if its window is still wanted, bring it back. */
function lostWindow(self, why) {
  if (win !== self) return;
  lastErr = why;
  const t = target;
  closeWindow();
  if (!t || t !== target) return;
  t.gen = 0;
  if (t.abort) t.abort(); // the attempt in flight ends now and schedules the retry itself
  else if (!t.run) scheduleRetry(t);
}

function whenReady() {
  if (ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
    readyWaiters.push((ok) => { clearTimeout(timer); resolve(ok); });
  });
}

function closeWindow() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const w = win;
  win = null;
  if (w && !w.isDestroyed()) w.destroy();
  dropWindowState();
}

/** Tell the page to end whatever it is capturing or about to capture. Returns the generation it carried. */
function pageStop() {
  const g = ++gen;
  if (alive()) {
    try { win.webContents.send('pet-capture:cmd', { op: 'stop', gen: g }); } catch { /* going away */ }
  }
  return g;
}

/* ───────────── starting, and starting again ───────────── */

/** executeJavaScript with a user gesture (getDisplayMedia refuses to run without one), but never forever. */
function execStart(g, aborted) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('the capture page did not answer in time'), { timedOut: true })), START_EXEC_TIMEOUT_MS);
  });
  const ended = aborted.then(() => { throw Object.assign(new Error('the capture was ended'), { aborted: true }); });
  const code = `window.__petCapture ? window.__petCapture.start(${g}) : false`;
  return Promise.race([win.webContents.executeJavaScript(code, true), timeout, ended]).finally(() => clearTimeout(timer));
}

/** One try at getting frames. `cur()` turns false when stop() or a newer start has taken over. */
async function tryStart(mine, cur, g, aborted) {
  ensureWindow();
  const isReady = await Promise.race([whenReady(), aborted.then(() => false)]);
  if (!isReady || !cur() || !alive()) {
    if (cur()) {
      if (!lastErr) lastErr = 'the capture page did not start';
      closeWindow(); // a fresh page for the next try
    }
    return false;
  }
  let res;
  try {
    res = await execStart(g, aborted);
  } catch (e) {
    // An ended attempt keeps the reason that ended it (a crash sets its own message).
    if (cur() && !(e && e.aborted)) lastErr = `capture start: ${e && e.message || e}`;
    if (cur() && e && e.timedOut) closeWindow(); // a page that does not answer is replaced, not asked again
    return false;
  }
  if (!cur()) return false;
  if (res !== true) {
    if (!lastErr) lastErr = 'the capture page could not start';
    return false;
  }
  // The page reports "live" just before it answers; give that message a moment to arrive.
  const until = Date.now() + LIVE_GRACE_MS;
  while (cur() && !live && alive() && Date.now() < until) await sleep(50);
  if (!cur()) return false;
  if (!live) {
    if (!lastErr) lastErr = 'no frames arrived';
    return false;
  }
  mine.fails = 0;
  return true;
}

async function attempt(mine) {
  const n = ++mine.n;
  const g = ++gen;
  const cur = () => target === mine && mine.n === n;
  let abort;
  const aborted = new Promise((r) => { abort = r; });
  mine.gen = g;
  mine.abort = abort;
  setLive(false);
  black = false;
  size = null;
  lastErr = '';
  let ok = false;
  try {
    ok = await tryStart(mine, cur, g, aborted);
  } catch (e) {
    if (cur()) lastErr = `capture start: ${e && e.message || e}`;
  }
  if (cur()) {
    mine.abort = null;
    if (!ok) {
      // Nothing from this attempt counts any more, and whatever the page half-started is ended.
      mine.gen = 0;
      pageStop();
    }
  }
  return ok && cur();
}

/** Run an attempt; when it fails and the window is still wanted, try again later. */
function run(mine) {
  const p = attempt(mine).catch(() => false).then((ok) => {
    if (mine.run === p) mine.run = null;
    if (!ok && target === mine && !live) scheduleRetry(mine);
    return ok;
  });
  mine.run = p;
  return p;
}

function scheduleRetry(mine) {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (target !== mine) return;
  const delay = RETRY_MS[Math.min(mine.fails, RETRY_MS.length - 1)];
  mine.fails++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (target === mine && !mine.run && !live) void run(mine);
  }, delay);
  if (retryTimer.unref) retryTimer.unref();
}

/* ───────────── the API ───────────── */

/** Wire the IPC; the page itself is only created on the first start(). */
function init() {
  wireIpc();
  prepareSession();
}

/** Start capturing a window (decimal HWND). Resolves true once frames are coming in; false if the first try
    failed (it is retried in the background for as long as the window is wanted, i.e. until stop()). */
async function start(hwnd) {
  const h = decimal(hwnd);
  if (!h) return false;
  init();
  if (target && target.hwnd === h) {
    if (target.run) return target.run;
    if (live) return true;
    clearTimeout(retryTimer);
    retryTimer = null;
    return run(target);
  }
  stop();
  clearTimeout(idleTimer);
  idleTimer = null;
  const mine = { hwnd: h, gen: 0, n: 0, run: null, fails: 0, abort: null };
  target = mine;
  return run(mine);
}

/** Stop capturing (idempotent). The hidden page is closed a while later. */
function stop() {
  const t = target;
  target = null;
  black = false;
  size = null;
  clearTimeout(retryTimer);
  retryTimer = null;
  failPending();
  pageStop();
  if (t && t.abort) t.abort();
  if (alive()) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(closeWindow, IDLE_CLOSE_MS);
    if (idleTimer.unref) idleTimer.unref();
  }
  setLive(false);
  return !!t;
}

/** Ask the page for the latest frame: { data, width, height } or null. */
function grab(kind, maxSide) {
  if (!target || !live || !alive()) return Promise.resolve(null);
  const id = `g${++grabSeq}`;
  const side = Math.round(Math.min(2560, Math.max(160, Number(maxSide) || 1280)));
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, GRAB_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    try { win.webContents.send('pet-capture:grab', { id, kind, maxSide: side, quality: 0.82 }); } catch { pending.delete(id); clearTimeout(timer); resolve(null); }
  });
}

/** The latest frame as a JPEG: { mime, data (base64), width, height, at } or null. */
async function frame({ maxSide } = {}) {
  const r = await grab('jpeg', maxSide);
  return r ? { mime: 'image/jpeg', data: r.data.toString('base64'), width: r.width, height: r.height, at: Date.now() } : null;
}

/** The latest frame as a PNG buffer (for OCR) or null. */
async function png({ maxSide } = {}) {
  const r = await grab('png', maxSide);
  return r ? r.data : null;
}

/** fn({ state, since, change }): `since` is the wall-clock ms the state began. Returns the unsubscribe function. */
function onScene(fn) {
  if (typeof fn !== 'function') return () => {};
  sceneCbs.push(fn);
  return () => { sceneCbs = sceneCbs.filter((f) => f !== fn); };
}

/** fn(live) when frames start or stop coming in. Returns the unsubscribe function. */
function onLive(fn) {
  if (typeof fn !== 'function') return () => {};
  liveCbs.push(fn);
  return () => { liveCbs = liveCbs.filter((f) => f !== fn); };
}

/** active: a window is wanted (also while a retry is pending); live: its frames are coming in right now. */
const status = () => ({ active: !!target, live, hwnd: target ? target.hwnd : null, black, size });
const lastError = () => lastErr;

/** Stop and close the hidden page for good (app quit, pet switched off). */
function dispose() {
  stop();
  closeWindow();
}

module.exports = { init, start, stop, frame, png, onScene, onLive, status, lastError, dispose };
