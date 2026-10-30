// Child-process helpers for the CLI drivers: find a command on PATH, spawn it (npm .cmd shims go
// through cmd.exe with verbatim quoting), split stdout into lines, and kill the whole tree.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isWin = process.platform === 'win32';
const cache = new Map();
// System tools by full path: a bare name would be looked up in the current folder first.
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
/** cmd.exe, as ComSpec names it, else the system's own copy (never the bare name). */
const cmdExe = () => process.env.ComSpec || path.join(SYS32, 'cmd.exe');

// Windows console tools (reg.exe) print in the system's legacy code page — GBK on Chinese Windows, so a
// Chinese user name in C:\Users\… is not UTF-8 — and turn what that page cannot hold into '?'. regQuery
// asks for UTF-8 (and marks what it got); output that is not marked is read every way it might be
// encoded, and only the right reading names files that exist.
const CODEPAGES = ['utf-8', 'gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1252'];

function readings(buf) {
  if (!buf || !buf.length) return [];
  if (buf.utf8) return [new TextDecoder('utf-8').decode(buf)];
  const texts = new Set();
  for (const enc of CODEPAGES) { try { texts.add(new TextDecoder(enc).decode(buf)); } catch { /* not in this build */ } }
  return [...texts];
}

function isUtf8(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

/** The legacy code page's decoder name for a pair of code page numbers (OEMCP is what cmd.exe prints in). */
function codePageLabel(oem, acp) {
  const multibyte = { 936: 'gbk', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr' };
  if (multibyte[oem]) return multibyte[oem];
  if (multibyte[acp]) return multibyte[acp];
  if (Number(oem) === 866) return 'ibm866';
  // TextDecoder has no 437 / 850 tables: the ANSI page is the nearest thing for accented letters.
  return Number(acp) === 874 || (Number(acp) >= 1250 && Number(acp) <= 1258) ? `windows-${acp}` : 'windows-1252';
}

let legacyLabel = null;
/** The system's legacy code page as a TextDecoder label: cmd.exe's own messages, and CLIs that write
 *  the local code page rather than UTF-8, come in it. Read once, only when some output was not UTF-8. */
function legacyEncoding() {
  if (legacyLabel) return legacyLabel;
  legacyLabel = 'gbk'; // this app's users: a guess for when the registry cannot be read
  if (isWin) {
    // Plain digits: no need for UTF-8 here.
    const get = (name) => {
      const buf = regDirect(['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', name]);
      const m = buf && /REG_SZ\s+(\d+)/.exec(buf.toString('latin1'));
      return m ? Number(m[1]) : 0;
    };
    const oem = get('OEMCP');
    if (oem) legacyLabel = codePageLabel(oem, get('ACP'));
  }
  return legacyLabel;
}

/** One stdout line (raw bytes): UTF-8 when it is valid UTF-8, the legacy code page when it is not. */
const lineDecoder = new TextDecoder('utf-8', { fatal: true });
function decodeLine(buf, label) {
  try { return lineDecoder.decode(buf); } catch { return new TextDecoder(label || legacyEncoding()).decode(buf); }
}

/** How many bytes at the end of `buf` are the start of a UTF-8 character that has not ended yet. */
function unfinishedUtf8(buf) {
  for (let n = 1; n <= Math.min(3, buf.length); n++) {
    const b = buf[buf.length - n];
    if ((b & 0xc0) === 0x80) continue; // a continuation byte: its first byte is further back
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > n ? n : 0;
  }
  return 0;
}

/**
 * A decoder for a stream of byte chunks (stderr): strict UTF-8 to begin with, so the output of a CLI stays
 * exact; at the first chunk that is not UTF-8 it re-reads that chunk, and everything after it, in the
 * legacy code page (cmd.exe's own GBK messages: 「'node' 不是内部或外部命令」).
 */
function makeStreamDecoder(label) {
  const strict = new TextDecoder('utf-8', { fatal: true });
  let legacy = null;
  let held = Buffer.alloc(0); // the unfinished character at the end of the last chunk (strict keeps it back too)
  return {
    write(chunk) {
      if (legacy) return legacy.decode(chunk, { stream: true });
      try {
        const text = strict.decode(chunk, { stream: true });
        const all = held.length ? Buffer.concat([held, chunk]) : chunk;
        held = all.subarray(all.length - unfinishedUtf8(all));
        return text;
      } catch {
        legacy = new TextDecoder(label || legacyEncoding());
        return legacy.decode(Buffer.concat([held, chunk]), { stream: true });
      }
    },
    end() {
      if (legacy) return legacy.decode();
      try { return strict.decode(); } catch { return new TextDecoder(label || legacyEncoding()).decode(held); }
    },
  };
}

/** %VAR% → its value, names matched without regard to case (as Windows does); an unknown name stays as written. */
function expandVars(s, env = process.env) {
  const text = String(s);
  if (!text.includes('%')) return text;
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return text.replace(/%([^%\r\n]+)%/g, (m, n) => (lower.has(n.toLowerCase()) ? lower.get(n.toLowerCase()) : m));
}

/* ───────────── the PATH to search ───────────── */

// The app lives in the tray for days, so its own PATH is the one it started with: a CLI (or Node) that was
// installed since is only on the registry's PATH. The lookup and the CLIs it starts get both.
const REG_ENV_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', // machine: Windows puts it first
  'HKCU\\Environment', // the user's own
];
const PATH_TTL_MS = 30_000;
/** 检测 for several tools arrives together: they share one reading of the registry. */
const PATH_SHARE_MS = 2000;
let pathCache = null; // { at, proc, value }

/** One PATH entry as a folder to look in, or null. Only local absolute folders: a relative entry would
 *  mean this app's own working folder, and a network share that is down would freeze the whole app. */
function pathDir(entry) {
  const dir = String(entry).replace(/"/g, '').trim();
  return /^[A-Za-z]:[\\/]/.test(dir) ? dir : null;
}

const sameDir = (e) => String(e).replace(/"/g, '').trim().replace(/[\\/]+$/, '').toLowerCase();

/** The process PATH, then the entries the registry's PATH has that it lacks (empty entries dropped). */
function mergePath(procPath, extraDirs) {
  const parts = String(procPath || '').split(';');
  const seen = new Set(parts.map(sameDir).filter(Boolean));
  for (const dir of extraDirs) {
    const key = sameDir(dir);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    parts.push(String(dir).replace(/"/g, '').trim());
  }
  return parts.filter((p) => p.trim()).join(';');
}

/** The folders of the registry's machine PATH, then the user's, %VAR% expanded (REG_EXPAND_SZ). */
function registryPathDirs(query = regQuery) {
  const dirs = [];
  const buf = query(...REG_ENV_KEYS.map((key) => [key, '/v', 'Path'])); // one read for both, machine's output first
  for (const k of regKeys(buf)) {
    const name = Object.keys(k.values).find((n) => n.toLowerCase() === 'path');
    if (!name) continue;
    for (const part of expandVars(k.values[name]).split(';')) {
      if (!part.trim() || part.includes('%')) continue;
      // Output in an unknown code page was read every way: only the right reading names a folder that exists.
      if (!buf.utf8 && !isDir(part)) continue;
      dirs.push(part);
    }
  }
  return dirs;
}

/** What to search and to hand to a CLI as PATH. A reading is kept for a short while. */
function searchPath(query) {
  const now = Date.now();
  const proc = String(process.env.PATH || '');
  if (!query && pathCache && pathCache.proc === proc && now - pathCache.at < PATH_TTL_MS) return pathCache.value;
  const value = isWin ? mergePath(proc, registryPathDirs(query || registry.read)) : proc;
  // Stamped when the read is over, not when it began: a slow read (an antivirus hooking cmd.exe) must not
  // leave the reading already older than PATH_SHARE_MS for the next 检测 of the same batch.
  if (!query) pathCache = { at: Date.now(), proc, value };
  return value;
}

/** Where the registry is read from: scripts/unit-check.ts swaps it for a stand-in (and drops the reading kept above). */
const registry = { read: (...queries) => regQuery(...queries) };
function useRegistry(read) { registry.read = read || ((...queries) => regQuery(...queries)); pathCache = null; }

function hasFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
/** An existing folder; never asked of a network share (a dead one would hold this process up). */
function isDir(p) { const dir = pathDir(p); try { return !!dir && fs.statSync(dir).isDirectory(); } catch { return false; } }

/**
 * The first <name>.exe, .cmd or .bat along `pathValue`, in PATH order and with that preference inside a
 * folder. Walked here rather than asked of where.exe, whose output turns what the console's code page
 * cannot hold (한글, emoji, a Chinese user name on an English Windows) into '?'. Never the extensionless
 * or .ps1 shims that npm leaves beside the .cmd: they cannot be spawned.
 */
function lookupOnPath(name, pathValue) {
  if (!name || /[\\/:*?"<>|]/.test(name)) return null;
  for (const entry of String(pathValue || '').split(';')) {
    const dir = pathDir(entry);
    if (!dir) continue;
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const p = path.join(dir, name + ext);
      if (hasFile(p)) return p;
    }
  }
  return null;
}

/** Full path of a command, or null. A custom path that exists wins over PATH. */
function resolveCommand(name, custom) {
  if (custom) return fs.existsSync(custom) ? custom : null;
  if (cache.has(name)) return cache.get(name);
  let found = null;
  try {
    if (isWin) found = lookupOnPath(name, searchPath());
    else {
      const first = String(spawnSync('which', [name], { windowsHide: true, timeout: 8000 }).stdout || '').split(/\r?\n/)[0].trim();
      if (first && fs.existsSync(first)) found = first;
    }
  } catch { found = null; }
  cache.set(name, found);
  return found;
}

/** 检测 looks again: the command, and the registry's PATH too unless it was read a moment ago. */
function forgetCommand(name) {
  cache.delete(name);
  if (pathCache && Date.now() - pathCache.at > PATH_SHARE_MS) pathCache = null;
}

/* Windows' installed-programs list (设置 › 应用), for apps that keep a CLI inside their own folder. */
const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

/** reg.exe as it comes: its output is in the legacy code page. */
function regDirect(args) {
  try {
    const r = spawnSync(path.join(SYS32, 'reg.exe'), ['query', ...args], { windowsHide: true, timeout: 8000 });
    return r.status === 0 && r.stdout && r.stdout.length ? r.stdout : null;
  } catch { return null; }
}

/** `reg query <args>` → its output (a Buffer, marked .utf8 when it is UTF-8) or null. Run under chcp 65001:
 *  reg.exe otherwise prints the legacy code page, where 한글 or emoji in a value become '?'. Several
 *  queries (`regQuery(a, b)`) share one cmd.exe (it is the slow part) and their outputs follow one another. */
function regQuery(...queries) {
  if (!isWin) return null;
  let r = null;
  try {
    const reg = q(path.join(SYS32, 'reg.exe'));
    const line = queries.map((args) => [reg, 'query', ...args.map(q)].join(' ')).join(' & ');
    // chcp by full path, and cmd.exe started in System32: a bare `chcp` is looked up in the current folder
    // first, where whatever sits beside the app (a chcp.cmd in Downloads) would run at every start.
    r = spawnSync(path.join(SYS32, 'cmd.exe'), ['/d', '/s', '/c', `"${q(path.join(SYS32, 'chcp.com'))} 65001>nul & ${line}"`], { cwd: SYS32, windowsHide: true, windowsVerbatimArguments: true, timeout: 8000 });
  } catch { r = null; } // an argument q() would not pass through cmd.exe
  if (!r || r.error) {
    const outs = queries.map(regDirect).filter(Boolean);
    return outs.length ? Buffer.concat(outs) : null;
  }
  // One query: a missing key is a failure. Several: whatever the others found still counts.
  if ((queries.length === 1 && r.status !== 0) || !r.stdout || !r.stdout.length) return null;
  if (isUtf8(r.stdout)) r.stdout.utf8 = true;
  return r.stdout;
}

/** `reg query` output → [{ key, values: { name: data } }], once for each distinct reading. */
function regKeys(buf) {
  const keys = [];
  for (const text of readings(buf)) {
    let cur = null;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('HKEY_')) keys.push(cur = { key: line.trim(), values: {} });
      else if (cur) {
        const m = /^ {4}(.+?) {4}REG_\w+ {4}(.*)$/.exec(line);
        if (m) cur.values[m[1]] = m[2];
      }
    }
  }
  return keys;
}

/** The folder an entry names: `F:\App` (InstallLocation), or the folder of `F:\App\app.exe,0`
 *  (DisplayIcon) / `"F:\App\Uninstall App.exe" /S` (UninstallString). Local drives only. */
function entryDir(value, isFile) {
  let s = typeof value === 'string' ? value.trim() : '';
  if (!s) return null;
  const quoted = /^"([^"]+)"/.exec(s);
  if (quoted) s = quoted[1];
  else if (isFile) s = s.replace(/,-?\d+$/, '').replace(/(\.exe)\s.*$/i, '$1');
  if (isFile) s = path.win32.dirname(s);
  if (!/^[A-Za-z]:[\\/]/.test(s)) return null;
  s = path.win32.normalize(s).replace(/([^:\\])\\+$/, '$1');
  try { return fs.statSync(s).isDirectory() ? s : null; } catch { return null; }
}

/**
 * Folders that the installed-programs list gives for an app whose display name starts with `name`:
 * per-user installs first, then per-machine. Only folders that exist; nothing off Windows.
 */
function installDirs(name, query = regQuery) {
  if (!isWin && query === regQuery) return [];
  const lower = name.toLowerCase();
  const named = (v) => typeof v === 'string' && v.toLowerCase().startsWith(lower) && /^(\s|$)/.test(v.slice(name.length));
  const dirs = [];
  for (const root of UNINSTALL_KEYS) {
    const hits = new Set(regKeys(query([root, '/s', '/f', name, '/d'])).filter((k) => named(k.values.DisplayName)).map((k) => k.key));
    for (const key of hits) {
      for (const { values: v } of regKeys(query([key]))) {
        for (const dir of [entryDir(v.InstallLocation, false), entryDir(v.DisplayIcon, true), entryDir(v.UninstallString, true)]) {
          if (dir && !dirs.includes(dir)) dirs.push(dir);
        }
      }
    }
    if (dirs.length) break;
  }
  return dirs;
}

/** Quote one argument for a cmd.exe command line. */
function q(a) {
  const s = String(a);
  // cmd.exe expands %VAR% even inside quotes, and does not treat \" as an escaped quote: refuse
  // anything that could break out (no prompt or user text is ever passed as an argument).
  if (s.includes('%') || /\r|\n/.test(s) || (s.includes('"') && /[&|<>^]/.test(s))) throw new Error(`不安全的命令行参数：${s.slice(0, 40)}`);
  if (s === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Spawn a CLI with stdin/stdout/stderr piped. stdout is split into lines for `onLine`.
 * Arguments must never carry user text through cmd.exe (it would expand %VAR% and ^): prompts go
 * through stdin.
 */
function spawnCli(exe, args, { cwd, env, onLine, onErr }) {
  const full = { ...process.env, ...(env || {}) };
  if (isWin && !Object.keys(env || {}).some((k) => k.toLowerCase() === 'path')) {
    // The CLI (and the node behind an npm shim) is looked up on the registry's PATH too, like in a new terminal.
    try { full[Object.keys(full).find((k) => k.toLowerCase() === 'path') || 'Path'] = searchPath(); } catch { /* keep this process's PATH */ }
  }
  const opts = { cwd, windowsHide: true, env: full, stdio: ['pipe', 'pipe', 'pipe'] };
  let child;
  if (isWin && /\.(cmd|bat)$/i.test(exe)) {
    const line = [q(exe), ...args.map(q)].join(' ');
    child = spawn(cmdExe(), ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  } else {
    child = spawn(exe, args, opts);
  }
  // stdout is read as bytes and cut at each LF before it is decoded, so a line that is not UTF-8 is read
  // in the legacy code page on its own and never turns the CLI's later (UTF-8) lines into mojibake.
  let pending = []; // the chunks of the line being read
  const emit = (raw) => {
    const line = decodeLine(raw).replace(/\r$/, '');
    if (line.trim()) onLine(line);
  };
  child.stdout.on('data', (chunk) => {
    let from = 0;
    for (let i = chunk.indexOf(10, from); i >= 0; i = chunk.indexOf(10, from)) {
      pending.push(chunk.subarray(from, i));
      emit(Buffer.concat(pending));
      pending = [];
      from = i + 1;
    }
    if (from < chunk.length) pending.push(chunk.subarray(from));
  });
  child.stdout.on('end', () => { if (pending.length) emit(Buffer.concat(pending)); pending = []; });
  // stderr is where cmd.exe reports a shim that cannot start, in its own code page.
  const errDecoder = makeStreamDecoder();
  child.stderr.on('data', (d) => { const text = errDecoder.write(d); if (text && onErr) onErr(text); });
  child.stderr.on('end', () => { const text = errDecoder.end(); if (text && onErr) onErr(text); });
  child.stdin.on('error', () => {});
  return child;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin && child.pid) {
    try { spawnSync(path.join(SYS32, 'taskkill.exe'),['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 8000 }); } catch { /* already gone */ }
  }
  try { child.kill(); } catch { /* already gone */ }
}

/** Run a command to completion and collect its output (detection, `auth status`, `--version`). */
function runOnce(exe, args, { cwd, env, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    let child;
    try {
      child = spawnCli(exe, args, { cwd, env, onLine: (l) => { out += `${l}\n`; }, onErr: (d) => { err += d; } });
    } catch (e) {
      resolve({ code: -1, out: '', err: String(e && e.message || e) });
      return;
    }
    child.stdin.end();
    const timer = setTimeout(() => { if (!done) { done = true; killTree(child); resolve({ code: -2, out, err: `${err}\n超时` }); } }, timeoutMs);
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out, err: String(e.message || e) }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? -1, out, err }); } });
  });
}

function parseJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** First meaningful string field of a tool input, for one-line titles. */
function summarizeInput(input) {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input.slice(0, 160) : '';
  for (const k of ['element', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'notebook_path']) {
    if (typeof input[k] === 'string' && input[k]) return input[k].slice(0, 160);
  }
  const s = JSON.stringify(input);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** Tool output in whatever shape a CLI reports it → plain text (capped). */
function flattenOutput(content, cap = 6000) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map((c) => (typeof c === 'string' ? c : c && typeof c.text === 'string' ? c.text
      : c && c.content ? flattenOutput(c.content, cap) : c && c.type === 'image' ? '[图片]' : '')).filter(Boolean).join('\n');
  } else if (content && typeof content === 'object') {
    text = typeof content.text === 'string' ? content.text : JSON.stringify(content, null, 2);
  }
  return text.length > cap ? `${text.slice(0, cap)}\n…（已截断，共 ${text.length} 字符）` : text;
}

module.exports = {
  resolveCommand, forgetCommand, installDirs, spawnCli, killTree, runOnce, parseJson, summarizeInput, flattenOutput, q, isWin, expandVars, SYS32, cmdExe,
  // Exposed for scripts/unit-check.ts.
  _internals: { mergePath, registryPathDirs, searchPath, lookupOnPath, useRegistry, regQuery, makeStreamDecoder, decodeLine, codePageLabel },
};
