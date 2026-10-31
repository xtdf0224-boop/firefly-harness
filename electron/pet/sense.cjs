// Sense: what the user is doing. Supervises the resident PowerShell helper (sense.ps1), which reports
// the foreground program and the idle time and runs Windows OCR on request (in its own runspace, so
// recognition never delays the 1 s polling). Nothing here touches Electron, so it can be required from
// a plain node script.
//
// start({ onFocus, onIdle, onLost }):
//   onFocus(raw)   the foreground program changed. raw = { exe, title, pid, hwnd, fullscreen, rect, path };
//                  path is the full image path, for policy.cjs only (it must not go to a page or a model).
//                  hwnd '0' with exe '' means "no foreground window" (lock screen, UAC).
//   onIdle(s)      user idle seconds, every 15 s (also the helper's heartbeat)
//   onLost()       what onFocus last said can no longer be trusted: the helper exited / is being restarted,
//                  or sent nothing for 45 s. Fires once per outage; the next onFocus is from a fresh helper.
// The temp folder with the OCR images is swept synchronously on start() and stop().
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { killTree } = require('../ai/proc.cjs');

const OCR_TIMEOUT_MS = 8000;
const MAX_OCR_OUTSTANDING = 2; // asked for and not yet answered, counting requests we gave up on but the helper may still be running
const ABANDONED_TTL_MS = 20000;
const MAX_PNG_BYTES = 24 * 1024 * 1024;
const MAX_BACKOFF_MS = 60000;
const HEALTHY_MS = 30000;
const BEAT_TIMEOUT_MS = 45000; // the helper says something at least every 15 s
const WATCHDOG_MS = 5000;
const STALE_FILE_MS = 10 * 60000;
const TMP_DIR = path.join(os.tmpdir(), 'firefly-pet');
const FULLSCREEN = new Set(['no', 'borderless', 'exclusive']);
// Chinese OCR puts a space between almost every character; join them back.
const CJK = '\\u2E80-\\u9FFF\\uF900-\\uFAFF\\u3000-\\u303F\\uFF00-\\uFFEF';
const CJK_GAP = new RegExp(`(?<=[${CJK}])[ \\t]+(?=[${CJK}])`, 'g');

let child = null;
let callbacks = { onFocus: null, onIdle: null, onLost: null };
let wanted = false;
let restartTimer = null;
let backoffMs = 0;
let startedAt = 0;
let stderrTail = '';
let lastErr = '';
let seq = 0;
let lastSweep = 0;
let scriptPath = null;
let lastBeat = 0;
let lostSent = false;
let watchdog = null;
let watchdogAt = 0;
/** id → { resolve, timer } */
const pending = new Map();
/** id → when we gave up on it (the helper may still be busy with it) */
const abandoned = new Map();
let ocrCalls = 0;

/** Run the script in place, or from a copy in the temp folder when it sits inside app.asar (PowerShell cannot read an asar). */
function resolveScript() {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  const src = path.join(__dirname, 'sense.ps1');
  if (!/[\\/]app\.asar[\\/]/i.test(src)) return (scriptPath = src);
  const unpacked = src.replace(/([\\/]app\.asar)([\\/])/i, '$1.unpacked$2');
  if (fs.existsSync(unpacked)) return (scriptPath = unpacked);
  const body = fs.readFileSync(src);
  const copy = path.join(TMP_DIR, `sense-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 10)}.ps1`);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  let same = false;
  try { same = fs.readFileSync(copy).equals(body); } catch { /* not there yet */ }
  if (!same) fs.writeFileSync(copy, body);
  return (scriptPath = copy);
}

function powershellExe() {
  // Always the full path: a bare name would be looked up in the app's launch folder first.
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** JSON for the helper's stdin: ASCII only, so no console code page can garble a path. */
function wire(obj) {
  return `${JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

function safe(fn) {
  try { fn(); } catch (e) { lastErr = `callback: ${e && e.message || e}`; }
}

function toFocus(m) {
  const r = m.rect && typeof m.rect === 'object' ? m.rect : {};
  const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
  return {
    exe: String(m.exe || '').toLowerCase(),
    title: String(m.title || ''),
    pid: n(m.pid),
    hwnd: String(m.hwnd || '0'),
    fullscreen: FULLSCREEN.has(m.fullscreen) ? m.fullscreen : 'no',
    rect: { x: n(r.x), y: n(r.y), w: n(r.w), h: n(r.h) },
    path: typeof m.path === 'string' ? m.path.slice(0, 520) : '',
  };
}

/** What the last focus report said can no longer be trusted. Once per outage. */
function fireLost() {
  if (lostSent) return;
  lostSent = true;
  const { onLost } = callbacks;
  if (onLost) safe(() => onLost());
}

/** Ask for a restart of a helper that has gone quiet; sleep/wake and a busy event loop get a grace period. */
function checkBeat() {
  const now = Date.now();
  const gap = now - watchdogAt;
  watchdogAt = now;
  if (!child) return;
  if (gap > 3 * WATCHDOG_MS) { lastBeat = now; return; } // the machine slept, or we were starved: the helper had no chance to speak
  if (now - lastBeat <= BEAT_TIMEOUT_MS) return;
  lastErr = 'sense helper: no heartbeat';
  fireLost();
  killTree(child); // 'close' follows and schedules the restart
}

function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((l) => String(l).replace(CJK_GAP, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function onLine(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (!m || typeof m !== 'object') return;
  lastBeat = Date.now(); // anything from the helper proves it is alive
  lostSent = false;
  if (m.t === 'focus') {
    const { onFocus } = callbacks;
    if (onFocus) safe(() => onFocus(toFocus(m)));
  } else if (m.t === 'idle') {
    const { onIdle } = callbacks;
    if (onIdle) safe(() => onIdle(Math.max(0, Math.round(Number(m.s) || 0))));
  } else if (m.t === 'ocr') {
    abandoned.delete(m.id);
    const p = pending.get(m.id);
    if (!p) return; // answered too late: the caller already gave up
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) lastErr = `ocr: ${m.error}`;
    p.resolve(m.error ? [] : normalizeLines(m.lines));
  } else if (m.t === 'error') {
    lastErr = String(m.message || 'sense helper error');
  }
}

function failPending() {
  for (const [, p] of pending) { clearTimeout(p.timer); p.resolve([]); }
  pending.clear();
  abandoned.clear(); // a new helper starts with an empty queue
}

/** Requests the helper may still be working on: ocrPng() calls in flight, or given up on a moment ago. */
function ocrOutstanding() {
  const now = Date.now();
  for (const [id, at] of abandoned) if (now - at > ABANDONED_TTL_MS) abandoned.delete(id);
  return ocrCalls + abandoned.size;
}

function scheduleRestart() {
  if (!wanted || restartTimer) return;
  backoffMs = Date.now() - startedAt > HEALTHY_MS ? 1000 : Math.min(MAX_BACKOFF_MS, (backoffMs || 500) * 2);
  restartTimer = setTimeout(() => { restartTimer = null; launch(); }, backoffMs);
  restartTimer.unref();
}

function launch() {
  if (!wanted || child) return;
  let c;
  try {
    c = spawn(powershellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', resolveScript()], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    lastErr = `spawn: ${e && e.message || e}`;
    startedAt = Date.now();
    scheduleRestart();
    return;
  }
  child = c;
  startedAt = Date.now();
  lastBeat = startedAt;
  stderrTail = '';
  let buf = '';
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
  c.stderr.setEncoding('utf8');
  c.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-1500); });
  c.stdin.on('error', () => { /* the helper is gone; 'close' handles it */ });
  const onEnd = () => {
    if (child !== c) return; // already stopped or replaced: nothing of ours is left to clean up
    child = null;
    failPending();
    if (stderrTail.trim()) lastErr = `sense helper: ${stderrTail.trim().slice(-400)}`;
    // Until the new helper reports, the last program it told us about is only a memory.
    fireLost();
    scheduleRestart();
  };
  c.on('error', (e) => { lastErr = `spawn: ${e && e.message || e}`; onEnd(); });
  c.on('close', onEnd);
}

/** Start sensing. Calling it again only replaces the callbacks. */
function start({ onFocus, onIdle, onLost } = {}) {
  const fn = (f) => (typeof f === 'function' ? f : null);
  callbacks = { onFocus: fn(onFocus), onIdle: fn(onIdle), onLost: fn(onLost) };
  if (process.platform !== 'win32') { lastErr = 'sense is Windows only'; return; }
  if (!wanted) { sweepTempNow(); lostSent = false; }
  wanted = true;
  if (!watchdog) {
    watchdogAt = Date.now();
    watchdog = setInterval(checkBeat, WATCHDOG_MS);
    watchdog.unref();
  }
  if (!child && !restartTimer) launch();
}

function stop() {
  wanted = false;
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  failPending();
  const c = child;
  child = null;
  backoffMs = 0;
  sweepTempNow();
  if (!c) return;
  try { c.stdin.write(wire({ op: 'quit' })); c.stdin.end(); } catch { /* already closed */ }
  // The helper also exits on its own when stdin closes; this is only for a stuck one.
  setTimeout(() => { if (c.exitCode === null) killTree(c); }, 1500).unref();
}

function running() { return wanted && !!child; }

function lastError() { return lastErr; }

/** Is a process with this id still running? (A crashed run leaves files named after its pid.) */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/**
 * Delete OCR images left in the temp folder, synchronously: ours (the helper is gone or about to be),
 * those of a process that no longer exists (an earlier crash), and any that is over ten minutes old.
 * Another running copy of the app keeps its files.
 */
function sweepTempNow() {
  lastSweep = Date.now();
  let names;
  try { names = fs.readdirSync(TMP_DIR); } catch { return; }
  for (const name of names) {
    const m = /^ocr-(\d+)-.*\.png$/.exec(name);
    if (!m) continue;
    const file = path.join(TMP_DIR, name);
    try {
      const pid = Number(m[1]);
      if (pid === process.pid || !pidAlive(pid) || Date.now() - fs.statSync(file).mtimeMs > STALE_FILE_MS) fs.unlinkSync(file);
    } catch { /* still open in the helper, or already gone: the next sweep gets it */ }
  }
}

/** The same, now and then while OCR is being used (a timeout can leave a file the helper still held). */
function sweepTemp() {
  if (Date.now() - lastSweep < 60000) return;
  lastSweep = Date.now();
  fs.readdir(TMP_DIR, (err, names) => {
    if (err) return;
    const now = Date.now();
    for (const name of names) {
      if (!/^ocr-.*\.png$/.test(name)) continue;
      const file = path.join(TMP_DIR, name);
      fs.stat(file, (e, st) => { if (!e && now - st.mtimeMs > STALE_FILE_MS) fs.unlink(file, () => {}); });
    }
  });
}

function removeFile(file) {
  fs.unlink(file, (err) => {
    // The helper may still hold it for a moment after a timeout: the next sweep will get it.
    if (err && err.code !== 'ENOENT') setTimeout(() => fs.unlink(file, () => {}), 3000).unref();
  });
}

/**
 * Recognise the text in a PNG with Windows OCR. Resolves the lines top to bottom; resolves [] when
 * there is no text or OCR is unavailable (see lastError()). It never rejects: OCR is a bonus.
 */
async function ocrPng(buffer, lang) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_PNG_BYTES) return [];
  const c = child;
  if (!c || !c.stdin.writable) { lastErr = 'ocr: the sense helper is not running'; return []; }
  // Recognition is one request at a time inside the helper. A caller that timed out leaves its request there,
  // so do not queue more behind it: an empty answer now is better than a late one that nobody reads.
  if (ocrOutstanding() >= MAX_OCR_OUTSTANDING) { lastErr = 'ocr: busy'; return []; }
  ocrCalls++;
  const tag = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(String(lang || '')) ? String(lang) : 'zh-Hans-CN';
  const id = `o${(++seq).toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const file = path.join(TMP_DIR, `ocr-${process.pid}-${id}.png`);
  try {
    await fs.promises.mkdir(TMP_DIR, { recursive: true });
    await fs.promises.writeFile(file, buffer);
    sweepTemp();
    if (child !== c) return []; // stopped or restarted while the file was being written
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        abandoned.set(id, Date.now());
        lastErr = 'ocr: timed out';
        // Take it back if the helper has not started on it yet.
        try { c.stdin.write(wire({ op: 'cancel', id })); } catch { /* the helper is gone */ }
        resolve([]);
      }, OCR_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      try {
        c.stdin.write(wire({ op: 'ocr', id, path: file, lang: tag }));
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        lastErr = `ocr: ${e && e.message || e}`;
        resolve([]);
      }
    });
  } catch (e) {
    lastErr = `ocr: ${e && e.message || e}`;
    return [];
  } finally {
    ocrCalls--;
    removeFile(file);
  }
}

module.exports = { start, stop, ocrPng, running, lastError };
