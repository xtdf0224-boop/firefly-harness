// Child-process helpers for the CLI drivers: find a command on PATH, spawn it (npm .cmd shims go
// through cmd.exe with verbatim quoting), split stdout into lines, and kill the whole tree.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');

const isWin = process.platform === 'win32';
const cache = new Map();

/** Full path of a command, or null. A custom path that exists wins over PATH. */
function resolveCommand(name, custom) {
  if (custom) return fs.existsSync(custom) ? custom : null;
  if (cache.has(name)) return cache.get(name);
  let found = null;
  try {
    const r = spawnSync(isWin ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // npm installs a POSIX shim, a .cmd and a .ps1 side by side; only the .cmd / .exe can be spawned here.
    found = (isWin ? lines.find((l) => /\.(cmd|bat|exe)$/i.test(l)) : lines[0]) || null;
  } catch { found = null; }
  cache.set(name, found);
  return found;
}

function forgetCommand(name) { cache.delete(name); }

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
  const opts = { cwd, windowsHide: true, env: { ...process.env, ...(env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] };
  let child;
  if (isWin && /\.(cmd|bat)$/i.test(exe)) {
    const line = [q(exe), ...args.map(q)].join(' ');
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  } else {
    child = spawn(exe, args, opts);
  }
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
  child.stdout.on('end', () => { if (buf.trim()) onLine(buf); buf = ''; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => onErr && onErr(d));
  child.stdin.on('error', () => {});
  return child;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin && child.pid) {
    try { spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 8000 }); } catch { /* already gone */ }
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

module.exports = { resolveCommand, forgetCommand, spawnCli, killTree, runOnce, parseJson, summarizeInput, flattenOutput, q, isWin };
