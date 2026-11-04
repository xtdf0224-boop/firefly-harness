// run_shell_command for the API tools: one PowerShell per command, started directly (not through spawnCli)
// so that the output stays bounded, the environment can be cleaned, and the whole process tree can be
// ended on a timeout or a stop. Plain Node: nothing here needs Electron.
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const proc = require('../proc.cjs');

const isWin = process.platform === 'win32';
const MAX_COMMAND = 8000;
const DEFAULT_TIMEOUT = 120;
const MIN_TIMEOUT = 1;
const MAX_TIMEOUT = 600;
const HEAD_CHARS = 12000; // what the model gets of the start of the output…
const TAIL_CHARS = 12000; // …and of the end; whatever is between is left out
const MAX_BYTES = 64 * 1024 * 1024; // more than this and the command is ended
const DISPLAY_CHARS = 6000; // the approval / result card
const EXIT_GRACE_MS = 1500; // pipes still open this long after the shell exited: a grandchild holds them
const KILL_WAIT_MS = 3000; // a stop does not wait longer than this for taskkill
const TALL_COMMAND = 10; // rows: a command longer than this does not fit the card's scroll box, so its last line is said in the reason
const LAST_CHARS = 120;

/** A character class made from [from, to] code point pairs (no escapes: they are easy to get wrong in a source file). */
const charClass = (ranges) => new RegExp(`[${ranges.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`);
// In a command: C0 controls (but not tab, LF, CR), DEL and C1 (NEL is a newline to PowerShell), the line and paragraph
// separators, the zero-width space and word joiner, the bidirectional controls and the byte order mark. (The zero-width
// joiner and non-joiner stay: emoji sequences and some scripts need them.)
const BAD_IN_COMMAND = charClass([[0, 8], [11, 12], [14, 31], [127, 159], [0x061c, 0x061c], [0x200b, 0x200b], [0x200e, 0x200f], [0x2028, 0x202e], [0x2060, 0x2060], [0x2066, 0x2069], [0xfeff, 0xfeff]]);
const BIDI_IN_COMMAND = charClass([[0x061c, 0x061c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]]);
// Any of these in a git command and it is not "just git" any more (see isPureGit).
const NOT_PURE = new RegExp(`[;&|<>\`$(){}[\\]]|${charClass([[0, 31], [127, 159], [0x061c, 0x061c], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2060], [0x2066, 0x2069], [0xfeff, 0xfeff]]).source}`);

// PowerShell's stop-parsing token (--%, also with the dashes PowerShell reads as '-': – — ―) turns on cmd-style %VAR%
// expansion for everything after it, which the path and address checks cannot see: never just git.
const STOP_PARSING = new RegExp(`${charClass([[45, 45], [0x2013, 0x2015]]).source}{2}%`);

/** Said on the approval card and in the tool's guidance: the process tree is ended, but not what got away from it. */
const DETACH_NOTE = '超时或停止时会结束命令启动的整个进程树；用 Start-Process、计划任务、服务等方式脱离进程树的程序可能会留下来。';

/* ───────────── what may be run ───────────── */

/**
 * The command as the model wrote it → { ok: true, command, lines, chars, shown } or { ok: false, error }.
 * `shown` is the text for the card: the same command with every run of 2 or more blank lines folded into a note (so
 * padding cannot push the real command below the fold); what runs is always `command`, untouched. `last` is its last
 * line that has anything on it, cut to 120 characters: a long command shows it in the card's reason (see reasonFor).
 */
function validate(command) {
  if (typeof command !== 'string') return { ok: false, error: '命令必须是文字。' };
  if (!command.trim()) return { ok: false, error: '命令是空的。' };
  if (command.length > MAX_COMMAND) return { ok: false, error: `命令太长（${command.length} 字，最多 ${MAX_COMMAND} 字）。长内容请先写成脚本文件再运行。` };
  if (BIDI_IN_COMMAND.test(command)) return { ok: false, error: '命令里有文字方向控制符，卡片上看到的和实际执行的可能不一样，已拒绝。' };
  if (BAD_IN_COMMAND.test(command)) return { ok: false, error: '命令里有控制字符或不可见字符，已拒绝。' };
  const rows = command.split(/\r\n|\r|\n/);
  const shown = [];
  let blank = 0;
  let last = '';
  for (const row of rows) {
    if (row.trim()) {
      if (blank >= 2) shown.push(`（… 省略 ${blank} 个空行 …）`);
      else if (blank === 1) shown.push('');
      blank = 0;
      shown.push(row);
      last = row.trim();
    } else blank += 1;
  }
  if (last.length > LAST_CHARS) {
    last = last.slice(0, LAST_CHARS - 1);
    if (isHighSurrogate(last.charCodeAt(last.length - 1))) last = last.slice(0, -1); // keep a pair together
    last += '…';
  }
  return { ok: true, command, lines: rows.length, chars: command.length, shown: shown.join('\n'), last };
}

/** `timeout` as the model gave it (undefined → 120 s) → { ok: true, value } with a whole number of seconds in 1–600, or an error. */
function normalizeTimeout(v) {
  if (v === undefined || v === null || v === '') return { ok: true, value: DEFAULT_TIMEOUT };
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, error: 'timeout 必须是数字（秒）。' };
  return { ok: true, value: Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, Math.round(n))) };
}

/** The line for the approval card, made by the app and not writable by the model. A long command is also quoted by its
 *  last line: the card's box shows the start, and the end is where a command that was padded would hide what it does. */
function reasonFor(info, timeoutSec) {
  const base = `命令共 ${info.lines} 行、${info.chars} 字，超时 ${timeoutSec} 秒`;
  return info.lines > TALL_COMMAND && info.last ? `${base}；最后一行：「${info.last}」` : base;
}

/* ───────────── "just git" ───────────── */

const GIT_SUBS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'stash', 'tag', 'fetch', 'pull', 'push',
  'merge', 'rebase', 'remote', 'init', 'rev-parse', 'ls-files', 'blame', 'mv', 'rm', 'cherry-pick', 'revert', 'describe', 'shortlog', 'grep', 'clone',
]);
// Long options that run a program, point git somewhere else or write outside the folder. git accepts any unique
// prefix of a long option (--exe is --exec), so a word that is the start of one of these is refused too.
const GIT_LONG_NO = [
  '--config-env', '--config', '--exec-path', '--exec', '--git-dir', '--work-tree', '--namespace', '--upload-pack', '--receive-pack',
  '--template', '--separate-git-dir', '--output', '--open-files-in-pager', '--ext-diff', '--textconv', '--no-index', '--reference', '--reference-if-able',
];
// Short options are bundled (-qc is -q -c, -fx is -f -x) and take their value attached (-ccore.x=1, -xcalc, -F../x),
// so the letters of the whole cluster up to a '=' are looked at, not the first one.
const GIT_SHORT_NO = /^-(?!-)[^=]*[cCxO]/; // -c key=value, -C dir, rebase -x <command>, grep -O<pager>
const GIT_SHORT_U = /^-(?!-)[^=]*u/; // clone / fetch / pull -u <program> (upload-pack); push -u only sets the upstream
const GIT_TAKES_URL = new Set(['clone', 'fetch', 'pull', 'ls-remote']);
// To these git reads host:path (no slash before the colon) as an ssh address, so any word with a colon is one unless it is
// an https remote; a refspec with a colon (main:main) asks like a shell command, which is rare enough.
const GIT_NET = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);
// A path outside the folder, in any spelling: a drive (C:\x, and C:x, which is relative to that drive's folder), the root or a
// UNC path (\x, //host/share), or '..' as a part of the path (a range such as main..topic is not one).
const GIT_PATHISH = /^([A-Za-z]:|[\\/]|\.\.([\\/]|$))|[\\/]\.\.([\\/]|$)/;
const GIT_URLISH = /:\/\/|::|^[^\s/@]+@[^\s:]+:/; // https://host/x, ext::program, user@host:path
const GIT_LOCAL_TLD = new Set(['localhost', 'local', 'internal']);
const QUOTES = new RegExp(charClass([[34, 34], [39, 39], [0x2018, 0x201e]]).source, 'g'); // PowerShell reads the curly quotes as quotes too

/** What a word can be besides itself: the part after the first '=' (--file=C:/x), and for a short option what is left after
 *  one to three option letters (-FC:/x, -nF../x), where the value is attached. */
function gitCandidates(w) {
  const out = [w];
  const eq = w.indexOf('=');
  if (eq >= 0) out.push(w.slice(eq + 1));
  if (/^-(?!-)/.test(w)) for (let k = 2; k <= 4 && k < w.length; k++) out.push(w.slice(k));
  return out;
}

/** https://host.tld/… where the host is a name that looks public: dotted, last part not a number (no 127.0.0.1, 2130706433,
 *  0x7f.1), not localhost / .local / .internal, no login before the @ and nothing the address parser would read differently. */
function gitHttpsRemote(word) {
  const m = /^https:\/\/([^/?#]*)/i.exec(word);
  if (!m || !m[1] || m[1].includes('@')) return false;
  const labels = m[1].replace(/:\d*$/, '').replace(/\.$/, '').toLowerCase().split('.');
  if (labels.length < 2 || !labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l))) return false;
  const tld = labels[labels.length - 1];
  return /^[a-z]/.test(tld) && !GIT_LOCAL_TLD.has(tld);
}

/**
 * Whether a command is only git doing git things: the first word is `git`, the second an ordinary subcommand,
 * and nothing in it lets PowerShell run anything else or git run a program of its choice. Anything else is a
 * shell command. src/lib/providers.ts toolCategory() must apply the same rule.
 */
function isPureGit(command) {
  if (typeof command !== 'string') return false;
  const text = command.trim();
  if (!text || NOT_PURE.test(text) || STOP_PARSING.test(text)) return false;
  const words = text.split(/\s+/);
  if (words[0] !== 'git' || !GIT_SUBS.has(words[1])) return false;
  const sub = words[1];
  const rest = words.slice(2).map((w) => w.replace(QUOTES, '')); // PowerShell passes "-c" on as -c
  if (sub === 'remote' && rest.length && !['-v', '--verbose', 'show', 'get-url'].includes(rest[0])) return false; // not add / set-url: that points git at another place
  const takesUrl = GIT_TAKES_URL.has(sub);
  for (const w of rest) {
    if (GIT_SHORT_NO.test(w)) return false;
    if (takesUrl && GIT_SHORT_U.test(w)) return false;
    if (w.startsWith('--') && w !== '--') {
      const name = w.split('=')[0];
      if (GIT_LONG_NO.some((long) => long.startsWith(name))) return false;
    }
    for (const c of gitCandidates(w)) {
      if (GIT_PATHISH.test(c)) return false;
      // An address or a transport: only clone / fetch / pull / ls-remote take one, and only https://host.tld; push goes to a named remote.
      if (GIT_URLISH.test(c) && !(takesUrl && gitHttpsRemote(c))) return false;
      if (GIT_NET.has(sub) && c.includes(':') && !(takesUrl && gitHttpsRemote(c))) return false;
    }
  }
  return true;
}

/* ───────────── environment ───────────── */

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const DROPPED = /^(NODE_OPTIONS$|ELECTRON_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|DEEPSEEK_|KIMI_|MOONSHOT_|DASHSCOPE_|ZHIPU|MINIMAX_|ARK_)/i;

/** Set a variable, replacing any of the same name in another case (Windows names are case-insensitive). */
function setEnv(env, name, value) {
  for (const k of Object.keys(env)) if (k.toLowerCase() === name.toLowerCase()) delete env[k];
  env[name] = value;
}

/**
 * What a command inherits: this process's environment without anything that looks like a secret or belongs to
 * the app or to another AI tool, and with git and cmd told not to look for programs in the folder or ask questions.
 * (The PATH is added by run(), from the registry too.)
 */
function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || v === null || SECRET_NAME.test(k) || DROPPED.test(k)) continue;
    out[k] = String(v);
  }
  setEnv(out, 'NoDefaultCurrentDirectoryInExePath', '1'); // cmd does not run a git.bat that sits in the work folder
  setEnv(out, 'GIT_TERMINAL_PROMPT', '0');
  setEnv(out, 'GCM_INTERACTIVE', 'never');
  // `git commit` without -m, `git tag -a`, `git rebase -i` would open the user's editor (a window on their desktop, and a
  // command that hangs until it closes); ':' is git's own "no editor": the message stays empty and the commit is aborted.
  setEnv(out, 'GIT_EDITOR', ':');
  setEnv(out, 'GIT_SEQUENCE_EDITOR', ':');
  return out;
}

/* ───────────── running ───────────── */

/** The start and the end of a long output, with a note for what was left out between them. */
class Sink {
  constructor() { this.head = ''; this.tail = ''; this.total = 0; this.headDone = false; }

  push(text) {
    if (!text) return;
    this.total += text.length;
    let rest = text;
    if (!this.headDone) {
      const room = HEAD_CHARS - this.head.length;
      if (rest.length <= room) { this.head += rest; return; }
      let cut = room;
      if (cut > 0 && isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1; // keep a pair together
      this.head += rest.slice(0, cut);
      this.headDone = true;
      rest = rest.slice(cut);
    }
    this.tail += rest;
    if (this.tail.length > TAIL_CHARS * 2) this.tail = lastChars(this.tail, TAIL_CHARS);
  }

  result() {
    const tail = lastChars(this.tail, TAIL_CHARS);
    const omitted = this.total - this.head.length - tail.length;
    return omitted > 0 ? `${this.head}\n…（中间省略 ${omitted} 字）…\n${tail}` : this.head + tail;
  }
}
const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c) => c >= 0xdc00 && c <= 0xdfff;
function lastChars(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(-n);
  return isLowSurrogate(cut.charCodeAt(0)) ? cut.slice(1) : cut;
}

/** At most `max` characters for a card: the start and the end, the middle folded into a note. */
function clip(text, max = DISPLAY_CHARS) {
  if (text.length <= max) return text;
  const note = `\n…（卡片里省略了中间 ${text.length - max + 40} 字）…\n`;
  const keep = max - note.length;
  const head = Math.floor(keep * 0.4);
  return text.slice(0, head) + note + lastChars(text, keep - head);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const WRAPPER_HEAD = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$global:LASTEXITCODE = 0', // set before the tail reads it: under Set-StrictMode an unset variable is an error
];
const WRAPPER_TAIL = 'if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }';

/** The wrapped script PowerShell runs: quiet progress, UTF-8 out, and the real exit code of a native program
 *  (-EncodedCommand alone reports only 0 or 1). One line each: a `#` comment at the end of the command must not swallow the next. */
function buildScript(command) {
  return [...WRAPPER_HEAD, command, WRAPPER_TAIL].join('\n');
}

/* ───────────── PowerShell's error stream ───────────── */

// With -EncodedCommand, Windows PowerShell 5.1 writes everything that is not plain output (errors, warnings, verbose
// text, progress, Write-Host's information record) to stderr as CLIXML, a block of XML after "#< CLIXML", even with
// -OutputFormat Text (measured on this design's invocation). A native program's own stderr is plain. This turns the
// XML back into the text the console would have shown, and drops the records that only repeat or only report progress.
const CLIXML_MARK = '#< CLIXML';
const OBJS_MARK = '<Objs ';
const WRAPPER_ECHO = `${WRAPPER_HEAD.join('\r\n')}\r\n`; // an error report can quote the script from its start

function unescapeClixml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/_x([0-9a-f]{4})_/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** One <Objs>…</Objs> document → the text of its error / warning / verbose / debug strings. */
function clixmlText(doc) {
  let out = '';
  const re = /<S S="([^"]*)">([\s\S]*?)<\/S>/g;
  for (let m = re.exec(doc); m; m = re.exec(doc)) {
    const kind = m[1].toLowerCase();
    const text = unescapeClixml(m[2]);
    if (kind === 'error') out += text.endsWith('\n') ? text : `${text}\n`;
    else if (kind === 'warning') out += `WARNING: ${text}\n`;
    else if (kind === 'verbose') out += `VERBOSE: ${text}\n`;
    else if (kind === 'debug') out += `DEBUG: ${text}\n`;
  }
  return out.split(WRAPPER_ECHO).join('');
}

/** A stream filter for the stderr text: push(text) → what can be passed on now; end() → whatever is left. */
function makeClixmlFilter() {
  let held = '';
  const partialMark = () => {
    for (let k = Math.min(CLIXML_MARK.length - 1, held.length); k > 0; k--) if (held.endsWith(CLIXML_MARK.slice(0, k))) return k;
    return 0;
  };
  const drain = (final) => {
    let out = '';
    for (;;) {
      let at = held.indexOf(CLIXML_MARK);
      if (at < 0 && held.startsWith(OBJS_MARK)) at = 0;
      if (at < 0) {
        const keep = final ? 0 : partialMark(); // the start of "#< CLIXML" may be split between two chunks
        out += held.slice(0, held.length - keep);
        held = held.slice(held.length - keep);
        return out;
      }
      out += held.slice(0, at);
      held = held.slice(at);
      let rest = held;
      let header = '';
      if (rest.startsWith(CLIXML_MARK)) {
        if (!final && /^#< CLIXML\r?$/.test(rest)) return out; // the line break after it has not arrived
        const m = /^#< CLIXML(\r?\n)?/.exec(rest);
        header = m[0];
        rest = rest.slice(header.length);
      }
      if (!rest.startsWith(OBJS_MARK)) {
        if (!final && (rest === '' || OBJS_MARK.startsWith(rest))) return out; // the document has not started arriving yet
        out += header; // "#< CLIXML" without a document after it: plain text after all
        held = rest;
        continue;
      }
      const end = rest.indexOf('</Objs>');
      if (end < 0) {
        if (!final) return out; // the document is still arriving
        out += held; // never finished: pass it on as it is
        held = '';
        return out;
      }
      out += clixmlText(rest.slice(0, end + 7));
      held = rest.slice(end + 7);
    }
  };
  return { push(text) { held += text; return drain(false); }, end() { return drain(true); } };
}

/** Windows PowerShell by full path (a bare name would be looked for in the work folder first), or null. */
function powershellExe() {
  const p = path.join(proc.SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : null;
}

/** What to start for a command: { file, args } or { error }. */
function launchFor(command) {
  if (!isWin) return { file: '/bin/sh', args: ['-c', command] };
  const file = _internals.powershellExe();
  if (!file) return { error: '找不到 Windows PowerShell（System32\\WindowsPowerShell\\v1.0\\powershell.exe）。' };
  const encoded = Buffer.from(buildScript(command), 'utf16le').toString('base64');
  return {
    file,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-InputFormat', 'None', '-EncodedCommand', encoded],
  };
}

/** The environment of a command. The registry's PATH is read without holding the main process up (a cold read takes
 *  0.2 s here and seconds when an antivirus hooks cmd.exe and reg.exe): the reading kept from before, or an asynchronous one. */
async function commandEnv() {
  const env = cleanEnv(process.env);
  try {
    const merged = await _internals.searchPath(); // the registry's PATH too: a tool installed since the app started
    if (merged) setEnv(env, Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path', merged);
  } catch { /* keep this process's PATH */ }
  return env;
}

/**
 * Start `file` and collect what it prints, stdout and stderr in the order it comes. Ends the process tree and
 * gives up on the pipes on a timeout, a stop or too much output, so a grandchild that holds a pipe cannot keep
 * this waiting. → { exitCode, reason: null | 'timeout' | 'abort' | 'size', text, error? }
 */
function execute(file, args, { cwd, env, timeoutSec, signal }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = _internals.spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !isWin });
    } catch (e) { resolve({ exitCode: null, reason: null, text: '', error: String(e && e.message || e) }); return; }
    const sink = new Sink();
    const decoders = [proc.makeStreamDecoder(), proc.makeStreamDecoder()]; // each stream has its own half-read characters
    const errFilter = makeClixmlFilter();
    let bytes = 0;
    let reason = null;
    let exitCode = null;
    let spawnError = null;
    let done = false;
    let runTimer = null;
    let graceTimer = null;
    let onAbort = null;

    const settle = () => {
      if (done) return;
      done = true;
      clearTimeout(runTimer);
      clearTimeout(graceTimer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      for (const s of [child.stdout, child.stderr]) { try { s.destroy(); } catch { /* already closed */ } }
      try { sink.push(decoders[0].end()); } catch { /* an unfinished character */ }
      try { sink.push(errFilter.push(decoders[1].end()) + errFilter.end()); } catch { /* an unfinished character */ }
      resolve({ exitCode: reason ? null : exitCode, reason, text: sink.result(), error: spawnError });
    };
    // The tree first, while its root still exists (taskkill /t walks down from the pid); then the pipes.
    const kill = (why) => {
      if (done || reason) return;
      reason = why;
      if (!child.pid) { settle(); return; }
      Promise.race([_internals.killTreeAsync(child.pid), delay(KILL_WAIT_MS)]).then(settle, settle);
    };
    const onData = (decoder, filter) => (chunk) => {
      if (done) return;
      bytes += chunk.length;
      const text = decoder.write(chunk);
      sink.push(filter ? filter.push(text) : text);
      if (bytes > MAX_BYTES) kill('size');
    };
    child.stdout.on('data', onData(decoders[0]));
    child.stderr.on('data', onData(decoders[1], errFilter));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.on('error', (e) => { spawnError = String(e && e.message || e); settle(); });
    child.on('exit', (code) => { exitCode = code; graceTimer = setTimeout(settle, EXIT_GRACE_MS); });
    child.on('close', (code) => { if (exitCode === null) exitCode = code; settle(); });

    runTimer = setTimeout(() => kill('timeout'), timeoutSec * 1000);
    if (signal) {
      onAbort = () => kill('abort');
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

const fail = (message) => ({ ok: false, output: message, display: clip(message), exitCode: null, timedOut: false });

/**
 * Run a command in `cwd` and wait for it. → { ok, output, display, exitCode, timedOut }: `output` is what the model
 * reads ("退出码 N" and the output), `display` the same for the card (at most 6000 characters). Never rejects.
 * `aborted: true` when `signal` ended it.
 */
async function run(command, { cwd, timeoutSec, signal } = {}) {
  const v = validate(command);
  if (!v.ok) return fail(v.error);
  const t = normalizeTimeout(timeoutSec);
  if (!t.ok) return fail(t.error);
  if (typeof cwd !== 'string' || !cwd) return fail('没有工作文件夹，不能执行命令。');
  try { if (!fs.statSync(cwd).isDirectory()) return fail('工作文件夹不是一个文件夹。'); } catch { return fail('工作文件夹不存在。'); }
  if (signal && signal.aborted) return { ...fail('命令还没开始就被停止了。'), aborted: true };
  const launch = launchFor(v.command);
  if (launch.error) return fail(launch.error);

  const env = await commandEnv();
  if (signal && signal.aborted) return { ...fail('命令还没开始就被停止了。'), aborted: true }; // stopped while the PATH was being read
  const raw = await execute(launch.file, launch.args, { cwd, env, timeoutSec: t.value, signal });
  if (raw.error) return fail(`无法启动命令：${raw.error}`);
  const text = raw.text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  let head;
  if (raw.reason === 'timeout') head = `命令超过 ${t.value} 秒，已被结束。`;
  else if (raw.reason === 'abort') head = '命令已被停止。';
  else if (raw.reason === 'size') head = `命令的输出超过 ${MAX_BYTES / 1024 / 1024} MB，已被结束。`;
  else if (raw.exitCode === null) head = '命令被系统结束了（没有退出码）。';
  else head = `退出码 ${raw.exitCode}`;
  const output = raw.reason || raw.exitCode === null
    ? `${head}${text ? `\n以下是结束前的输出：\n${text}` : ''}`
    : `${head}\n${text || '（没有输出）'}`;
  return {
    ok: !raw.reason && raw.exitCode === 0,
    output,
    display: clip(output),
    exitCode: raw.exitCode,
    timedOut: raw.reason === 'timeout',
    ...(raw.reason === 'abort' ? { aborted: true } : {}),
  };
}

// Swapped by checks (a fake spawn / taskkill, a fixed PATH).
const _internals = { spawn, killTreeAsync: proc.killTreeAsync, searchPath: () => proc.searchPathAsync(), powershellExe, buildScript, launchFor, Sink, clip, makeClixmlFilter };

module.exports = {
  run, isPureGit, cleanEnv, validate, normalizeTimeout, reasonFor, DETACH_NOTE,
  limits: { MAX_COMMAND, DEFAULT_TIMEOUT, MIN_TIMEOUT, MAX_TIMEOUT, HEAD_CHARS, TAIL_CHARS, MAX_BYTES, DISPLAY_CHARS },
  _internals,
};
