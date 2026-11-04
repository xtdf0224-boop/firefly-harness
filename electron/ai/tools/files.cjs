// The file tools of the API path: read_file, list_directory, glob, search_file_content, write_file,
// edit_file. Every function takes already validated arguments, the run's ctx and an AbortSignal, and
// returns { ok, output, display, meta? }: `output` is what the model is told, `display` (at most 6000
// characters) what the card shows. All file access goes through fs.promises.
//
// Nothing here trusts that the permission step looked at the same file: each call resolves its path again
// (paths.resolveAsync), applies the rules again, and, when the call needed a question to the user, compares
// what it finds with the snapshot taken then (`args.expect`, see paths.snapshot). A path that needed a
// question and arrives without that snapshot is refused. Reading and writing use the canonical path
// (`real`), never the string the model wrote.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const P = require('./paths.cjs');

const fsp = fs.promises;
const MB = 1024 * 1024;

const LIMITS = {
  readFileBytes: 10 * MB, readLines: 2000, readOutputBytes: 200 * 1024,
  writeContentBytes: 2 * MB, writeFileBytes: 50 * MB, writeTotalBytes: 200 * MB, editFileBytes: 10 * MB,
  listItems: 500, globResults: 500, searchMatches: 200, searchFileBytes: 1 * MB, searchLineChars: 300,
  maxDirs: 20000, maxFiles: 20000, walkMs: 20000, displayChars: 6000, patternChars: 1000,
};
const NUL_CHECK_BYTES = 8192;
const CONFIRM_MISSING = '这次访问需要用户确认，但没有确认记录，已拒绝。';

/* ───────────── results ───────────── */

const cap = (text, n = LIMITS.displayChars) => (text.length > n ? `${text.slice(0, n - 40)}\n…（已截断，共 ${text.length} 字）` : text);
const fail = (message) => ({ ok: false, output: message, display: cap(message) });
const done = (output, display, meta) => ({ ok: true, output, display: cap(display === undefined ? output : display), meta });

/** Whole numbers from the model, clamped (numbers as text count; anything else is the default). */
function int(value, min, max, dflt) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const budgets = new WeakMap();
/** The run's running total of bytes written ({ used, limit }); ctx.writeBudget when the caller keeps one. */
function budgetOf(ctx) {
  if (ctx.writeBudget && typeof ctx.writeBudget.used === 'number') {
    if (typeof ctx.writeBudget.limit !== 'number') ctx.writeBudget.limit = LIMITS.writeTotalBytes;
    return ctx.writeBudget;
  }
  let b = budgets.get(ctx);
  if (!b) { b = { used: 0, limit: LIMITS.writeTotalBytes }; budgets.set(ctx, b); }
  return b;
}
function budgetError(ctx, bytes) {
  const b = budgetOf(ctx);
  return b.used + bytes > b.limit ? `这一轮已经写入了 ${P.sizeText(b.used)}，再写 ${P.sizeText(bytes)} 会超过一轮 ${P.sizeText(b.limit)} 的上限。` : '';
}

/* ───────────── decoding ───────────── */

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function hasNul(buf) {
  const n = Math.min(buf.length, NUL_CHECK_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function procInternals() {
  try { const proc = require('../proc.cjs'); return { proc, i: proc._internals || {} }; } catch { return { proc: {}, i: {} }; }
}
/** Text in the system's legacy code page (GBK on Chinese Windows), by the decoder the CLI drivers use. */
function decodeLegacy(buf) {
  const { i } = procInternals();
  try { if (typeof i.decodeLine === 'function') return i.decodeLine(buf); } catch { /* fall through */ }
  try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('latin1'); }
}
let legacyLabelCache = null;
/** The legacy code page as a TextDecoder label, for the worker (which does not load proc.cjs). */
function legacyLabel() {
  if (legacyLabelCache) return legacyLabelCache;
  let label = 'gbk';
  try {
    const { proc, i } = procInternals();
    const named = proc.legacyEncoding || i.legacyEncoding;
    if (typeof named === 'function') label = named();
    else if (process.platform === 'win32' && typeof i.decodeLine === 'function' && i.decodeLine(Buffer.from([0xd6, 0xd0])) !== '中') label = 'windows-1252';
  } catch { /* keep the guess */ }
  legacyLabelCache = label;
  return label;
}

/** → { text, enc } | { binary: true }. UTF-16 only with its byte order mark (the PowerShell `>` default); no BOM is kept in `text`. */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) { try { return { text: new TextDecoder('utf-16le').decode(buf), enc: 'UTF-16 LE' }; } catch { /* binary */ } }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { try { return { text: new TextDecoder('utf-16be').decode(buf), enc: 'UTF-16 BE' }; } catch { /* binary */ } }
  if (hasNul(buf)) return { binary: true };
  try { return { text: strictUtf8.decode(buf), enc: 'UTF-8' }; } catch { /* not UTF-8 */ }
  return { text: decodeLegacy(buf), enc: '系统代码页' };
}

/* ───────────── guards ───────────── */

/**
 * Resolve, apply the rules for `op`, and compare with what the permission step saw.
 * → { r, a } | { error }
 */
async function guard(p, ctx, op, expect) {
  const r = await P.resolveAsync(p, ctx);
  const a = P.assess(r, op, ctx);
  if (a.error) return { error: a.error };
  const changed = P.changedSince(expect, r);
  if (changed) return { error: changed };
  if ((a.mustAsk || a.blockedPath || ctx.confirmAll) && !expect) return { error: CONFIRM_MISSING };
  return { r, a };
}

const aborted = (signal) => !!signal && signal.aborted;
const STOPPED = '已停止。';

/** The bytes of a regular file, read from its canonical path and checked on the way: it is the file that was
 *  looked at, it fits, and the path still leads where it did. */
async function readVerified(real, maxBytes, signal) {
  const before = await fsp.lstat(real, { bigint: true });
  if (!before.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' });
  const fh = await fsp.open(real, 'r');
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev) throw Object.assign(new Error('changed'), { code: 'ECHANGED' });
    if (st.size > BigInt(maxBytes)) throw Object.assign(new Error('too big'), { code: 'ETOOBIG', size: Number(st.size) });
    const again = await fsp.realpath(real);
    if (!P.sameLocation(again, real)) throw Object.assign(new Error('moved'), { code: 'ECHANGED' });
    if (aborted(signal)) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    const size = Number(st.size);
    const buf = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const { bytesRead } = await fh.read(buf, got, size - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return got === size ? buf : buf.subarray(0, got);
  } finally {
    await fh.close().catch(() => {});
  }
}

function readError(e, rel) {
  if (e && e.code === 'ABORTED') return STOPPED;
  if (e && e.code === 'ECHANGED') return '文件在等待确认期间变了，请重新读取后再试。';
  if (e && e.code === 'ETOOBIG') return `文件太大（${P.sizeText(e.size)}），不能一次读取。`;
  if (e && e.code === 'ENOTFILE') return `“${rel}”不是普通文件。`;
  return P.ioMessage(e, rel);
}

/* ───────────── read_file ───────────── */

/** Why a resolved path is not a file that can be read whole ('' when it is): what the file system says, nothing from inside it. */
function fileProblem(r, rel, maxBytes) {
  if (!r.exists) return `找不到文件：${rel}`;
  if (r.isDir) return `“${rel}”是文件夹，不是文件；要看里面有什么请用 list_directory。`;
  if (!r.isFile) return `“${rel}”不是普通文件。`;
  if (r.size > maxBytes) return `文件太大（${P.sizeText(r.size)}，上限 ${P.sizeText(maxBytes)}），不能一次读取。可以用 search_file_content 找需要的部分。`;
  return '';
}

/** → { text, lines[], enc } | { error } for a resolved file, shared by read_file and the edit planner. */
async function loadText(r, rel, maxBytes, signal) {
  const problem = fileProblem(r, rel, maxBytes);
  if (problem) return { error: problem };
  let buf;
  try { buf = await readVerified(r.real, maxBytes, signal); } catch (e) { return { error: readError(e, rel) }; }
  const dec = decodeText(buf);
  if (dec.binary) return { error: `“${rel}”看起来是二进制文件（前 8 KB 里有 NUL 字节），不能当文本读取。` };
  return { buf, text: dec.text, enc: dec.enc };
}

async function readFile(args, ctx, signal) {
  const rel = P.relative(args.path, ctx);
  if (aborted(signal)) return fail(STOPPED);
  const g = await guard(args.path, ctx, 'read', args.expect);
  if (g.error) return fail(g.error);
  const loaded = await loadText(g.r, rel, LIMITS.readFileBytes, signal);
  if (loaded.error) return fail(loaded.error);

  const lines = loaded.text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = loaded.text === '' ? 0 : lines.length;
  const note = loaded.enc === 'UTF-8' ? '' : `（文件不是 UTF-8，已按 ${loaded.enc} 解码）`;
  if (total === 0) return done(`文件：${rel}（文件是空的）`, undefined, { totalLines: 0 });
  const start = int(args.offset, 1, Number.MAX_SAFE_INTEGER, 1) - 1;
  if (start >= total) return fail(`offset ${start + 1} 超出范围：“${rel}”只有 ${total} 行。`);
  const limit = int(args.limit, 1, LIMITS.readLines, LIMITS.readLines);

  const out = [];
  let bytes = 0;
  for (let i = start; i < Math.min(total, start + limit); i++) {
    let line = lines[i];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    let size = Buffer.byteLength(line) + 1;
    if (size > LIMITS.readOutputBytes) { line = `${line.slice(0, 50000)}…（这一行太长，已截断）`; size = Buffer.byteLength(line) + 1; }
    if (out.length && bytes + size > LIMITS.readOutputBytes) break;
    out.push(line);
    bytes += size;
  }
  const from = start + 1;
  const to = start + out.length;
  let head = `文件：${rel}（第 ${from}–${to} 行，共 ${total} 行）${note}`;
  if (to < total) head += `\n还有 ${total - to} 行没有读出；用 offset=${to + 1} 继续读取。`;
  const body = out.join('\n');
  return done(`${head}\n${body}`, `${head}\n${P.visible(body, true)}`, { totalLines: total, from, to, bytes, encoding: loaded.enc });
}

/* ───────────── list_directory ───────────── */

/** The start of a displayed path: '' for the work folder itself, 'src/' below it, 'C:/x/' outside it. */
function displayPrefix(dirReal, ctx) {
  const base = ctx.realCwd || ctx.cwd;
  if (P.within(base, dirReal)) {
    const rel = path.relative(base, dirReal);
    return rel ? `${rel.split(path.sep).join('/')}/` : '';
  }
  return `${dirReal.split(path.sep).join('/')}/`;
}

const KIND_ORDER = { dir: 0, file: 1, link: 2, other: 3 };

/** Whether a folder that lstat calls a plain folder really is one where it stands: a junction to a volume GUID path
 *  (\\?\Volume{…}\x) is not a link to Node, but its real path is somewhere else. One realpath per folder entered. */
async function sameRealDir(full) {
  try { return P.sameLocation(await fsp.realpath(full), full); } catch { return false; }
}

async function listDirectory(args, ctx, signal) {
  const p = args.path === undefined || args.path === null || args.path === '' ? '.' : args.path;
  const rel = P.relative(p, ctx);
  if (aborted(signal)) return fail(STOPPED);
  const g = await guard(p, ctx, 'list', args.expect);
  if (g.error) return fail(g.error);
  const r = g.r;
  if (!r.exists) return fail(`找不到文件夹：${rel}`);
  if (!r.isDir) return fail(`“${rel}”不是文件夹；读文件内容请用 read_file。`);
  const depth = int(args.depth, 1, 3, 1);
  const deadline = Date.now() + LIMITS.walkMs;
  const lines = [];
  let count = 0;
  let odd = 0;
  let cut = '';

  async function level(dirReal, indent, d) {
    let ents;
    try { ents = await fsp.readdir(dirReal, { withFileTypes: true }); } catch (e) { lines.push(`${indent}（无法读取：${e.code || e.message}）`); return; }
    const items = [];
    for (const ent of ents) {
      if (P.badSegment(ent.name)) { odd++; continue; }
      items.push({ name: ent.name, key: P.fold(ent.name), kind: ent.isSymbolicLink() ? 'link' : ent.isDirectory() ? 'dir' : ent.isFile() ? 'file' : 'other' });
    }
    items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const it of items) {
      if (cut) return;
      if (count >= LIMITS.listItems) { cut = 'items'; return; }
      if (aborted(signal)) { cut = 'stop'; return; }
      if (Date.now() > deadline) { cut = 'time'; return; }
      const full = path.join(dirReal, it.name);
      const shown = P.visible(it.name);
      let st = null;
      try { st = await fsp.lstat(full); } catch { /* gone since the listing */ }
      let kind = !st ? 'other' : st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'; // lstat, not the entry, decides
      // A mount point on a volume GUID (mklink /J x \\?\Volume{…}\…) is no link to lstat; its real path says where it goes.
      if (kind === 'dir' && !(await sameRealDir(full))) kind = 'link';
      count++;
      if (kind === 'dir') {
        const skipped = P.SKIP_DIRS.has(it.name.toLowerCase());
        lines.push(`${indent}${shown}/${skipped ? '  [默认不展开]' : ''}`);
        if (!skipped && d < depth) await level(full, `${indent}  `, d + 1);
      } else if (kind === 'file') lines.push(`${indent}${shown}  ${P.sizeText(st.size)}`);
      else if (kind === 'link') lines.push(`${indent}${shown}  [链接，不会进入]`);
      else lines.push(`${indent}${shown}  [其它类型]`);
    }
  }
  await level(r.real, '', 1);
  if (cut === 'stop') return fail(STOPPED);

  const label = rel === '.' ? '工作文件夹' : `“${rel}”`;
  let text = count ? `${label}的内容（${count} 项${depth > 1 ? `，展开 ${depth} 层` : ''}）：\n${lines.join('\n')}` : `${label}是空文件夹。`;
  if (cut === 'items') text += `\n…只列出了前 ${LIMITS.listItems} 项；用 path 指定子目录可以继续看。`;
  if (cut === 'time') text += `\n…列目录超过 ${LIMITS.walkMs / 1000} 秒，已停止。`;
  if (odd) text += `\n另有 ${odd} 个名字特殊（Windows 保留设备名、结尾是点或空格等）的项目没有列出。`;
  return done(text, undefined, { items: count, truncated: !!cut });
}

/* ───────────── glob and search_file_content: the worker ───────────── */

let workerFileCache = null;
function workerFile() {
  if (workerFileCache) return workerFileCache;
  const packed = path.join(__dirname, 'search-worker.cjs');
  // A worker may not be startable from inside app.asar: use the unpacked copy when the build has one.
  const unpacked = packed.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  workerFileCache = unpacked !== packed && fs.existsSync(unpacked) ? unpacked : packed;
  return workerFileCache;
}

/**
 * Runs the walk in a worker and collects what it reports. Terminated after `ms` or when `signal` fires
 * (a regular expression that never finishes cannot be interrupted any other way). → { items, stats, stop,
 * regexMode, timedOut, aborted, error }; items found before the end are kept.
 */
function runWorker(data, signal, ms = LIMITS.walkMs) {
  return new Promise((resolve) => {
    const res = { items: [], stats: null, stop: '', regexMode: '', timedOut: false, aborted: false, error: '' };
    let w;
    let finished = false;
    let timer = null;
    let grace = null;
    const settle = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(res);
    };
    // Ask the worker to stop, and answer when it has gone (messages it sent before that are still delivered).
    const halt = () => {
      if (!w) return settle();
      w.terminate().catch(() => {});
      grace = setTimeout(settle, 1500);
    };
    const onAbort = () => { res.aborted = true; halt(); };
    if (signal) {
      if (signal.aborted) { res.aborted = true; return resolve(res); }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      w = new Worker(workerFile(), {
        workerData: { ...data, deadline: Date.now() + ms - 1000, limits: LIMITS, legacy: legacyLabel() },
        resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 48 },
      });
    } catch (e) {
      res.error = `无法启动搜索：${e.message || e}`;
      return settle();
    }
    timer = setTimeout(() => { res.timedOut = true; halt(); }, ms);
    w.on('message', (m) => {
      if (!m) return;
      if (m.type === 'items') for (const it of m.items) res.items.push(it);
      else if (m.type === 'start') res.regexMode = m.regexMode || '';
      else if (m.type === 'done') { res.stats = m.stats; res.stop = m.stop; res.regexMode = m.regexMode || res.regexMode; settle(); w.terminate().catch(() => {}); } else if (m.type === 'error') { res.error = m.message; settle(); w.terminate().catch(() => {}); }
    });
    w.on('error', (e) => { res.error = res.error || (e && e.message) || String(e); settle(); });
    w.on('exit', () => settle());
  });
}

const cmpPath = (a, b) => {
  const x = a.split('/').map(P.fold);
  const y = b.split('/').map(P.fold);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length - y.length;
};

/** Notes on what the walk left out, for the end of the output. */
function walkNotes(res) {
  const s = res.stats || {};
  const notes = [];
  if (res.timedOut || res.stop === 'time') notes.push(`搜索超过 ${LIMITS.walkMs / 1000} 秒，已停止，上面是目前找到的部分；可以缩小范围（path 或 glob）再试。`);
  if (res.stop === 'files') notes.push(`已扫描 ${LIMITS.maxFiles} 个文件，剩下的没有扫；请缩小范围。`);
  if (res.stop === 'dirs') notes.push(`已扫描 ${LIMITS.maxDirs} 个文件夹，剩下的没有扫；请缩小范围。`);
  const skipped = [];
  if (s.big) skipped.push(`${s.big} 个超过 ${P.sizeText(LIMITS.searchFileBytes)} 的文件`);
  if (s.binary) skipped.push(`${s.binary} 个二进制文件`);
  if (s.sensitive) skipped.push(`${s.sensitive} 个可能含密钥的文件（.env、*.pem 等）`);
  if (s.links) skipped.push(`${s.links} 个链接（不会进入）`);
  if (s.odd) skipped.push(`${s.odd} 个名字特殊的项目`);
  if (skipped.length) notes.push(`跳过了：${skipped.join('、')}。`);
  return notes;
}

async function walkStart(args, ctx, signal, wantDir) {
  const p = args.path === undefined || args.path === null || args.path === '' ? '.' : args.path;
  const rel = P.relative(p, ctx);
  if (aborted(signal)) return { error: STOPPED };
  const g = await guard(p, ctx, 'list', args.expect);
  if (g.error) return { error: g.error };
  const r = g.r;
  if (!r.exists) return { error: `找不到：${rel}` };
  if (wantDir && !r.isDir) return { error: `“${rel}”不是文件夹。` };
  if (!r.isDir && !r.isFile) return { error: `“${rel}”不是文件夹或普通文件。` };
  return { r, rel };
}

async function glob(args, ctx, signal) {
  const bad = P.checkGlobPattern(args.pattern, 'pattern');
  if (bad) return fail(bad);
  const s = await walkStart(args, ctx, signal, true);
  if (s.error) return fail(s.error);
  const res = await runWorker({ mode: 'glob', root: s.r.real, rootIsFile: false, inGit: !!s.r.gitInternal, outPrefix: displayPrefix(s.r.real, ctx), glob: args.pattern }, signal);
  if (res.aborted) return fail(STOPPED);
  if (res.error && !res.items.length) return fail(`查找失败：${res.error}`);
  const all = res.items.slice().sort(cmpPath);
  const shown = all.slice(0, LIMITS.globResults);
  const label = s.rel === '.' ? '工作文件夹' : `“${s.rel}”`;
  const notes = walkNotes(res);
  let text;
  if (!all.length) text = `在${label}下没有文件匹配“${args.pattern}”。`;
  else {
    text = `在${label}下匹配“${args.pattern}”的文件共 ${all.length} 个${all.length > shown.length ? `（只列出前 ${shown.length} 个）` : ''}，路径相对工作文件夹，可直接用于 read_file：\n${shown.join('\n')}`;
  }
  if (notes.length) text += `\n${notes.join('\n')}`;
  return done(text, P.visible(text, true), { count: all.length, truncated: all.length > shown.length });
}

async function search(args, ctx, signal) {
  const pattern = args.pattern;
  if (typeof pattern !== 'string' || !pattern) return fail('pattern 是空的。');
  if (pattern.length > LIMITS.patternChars) return fail(`pattern 太长了（最多 ${LIMITS.patternChars} 字）。`);
  if (args.glob !== undefined && args.glob !== null && args.glob !== '') {
    const bad = P.checkGlobPattern(args.glob, 'glob');
    if (bad) return fail(bad);
  }
  const s = await walkStart(args, ctx, signal, false);
  if (s.error) return fail(s.error);
  const isFile = !s.r.isDir;
  const outPrefix = displayPrefix(isFile ? path.dirname(s.r.real) : s.r.real, ctx);
  const res = await runWorker({
    mode: 'search', root: s.r.real, rootIsFile: isFile, inGit: !!s.r.gitInternal, outPrefix, pattern, ignoreCase: !!args.ignore_case,
    glob: args.glob ? String(args.glob) : '',
  }, signal);
  if (res.aborted) return fail(STOPPED);
  if (res.error && !res.items.length) return fail(`搜索失败：${res.error}`);
  const items = res.items.slice(0, LIMITS.searchMatches);
  const label = s.rel === '.' ? '工作文件夹' : `“${s.rel}”`;
  const notes = walkNotes(res);
  if (res.stop === 'limit' || res.items.length >= LIMITS.searchMatches) notes.unshift(`已达到 ${LIMITS.searchMatches} 条上限，可能还有更多；请缩小范围（path 或 glob）。`);
  if (res.regexMode === 'literal') notes.unshift('pattern 不是合法的正则表达式，已按普通文字搜索。');
  let text;
  if (!items.length) text = `在${label}里没有找到匹配“${pattern}”的内容。`;
  else {
    const files = new Set(items.map((x) => x.slice(0, x.search(/:\d+: /)))).size;
    text = `在${label}里搜索“${pattern}”${args.ignore_case ? '（忽略大小写）' : ''}：${items.length} 处匹配，涉及 ${files} 个文件。格式“路径:行号: 内容”，路径相对工作文件夹：\n${items.join('\n')}`;
  }
  if (notes.length) text += `\n${notes.join('\n')}`;
  return done(text, P.visible(text, true), { matches: items.length, truncated: notes.length > 0 });
}

/* ───────────── writing ───────────── */

/** Write `buf` to `real`: a new file exclusively, an existing one through a temporary file renamed over it
 *  (a stop or a crash in the middle never leaves half a file), or in place when it has other hard links
 *  or Windows will not let the name be replaced. */
async function commitFile(real, buf, o) {
  if (!o.exists) {
    const fh = await fsp.open(real, 'wx'); // EEXIST if it appeared meanwhile
    try { await fh.writeFile(buf); } finally { await fh.close(); }
    return;
  }
  if (!o.inPlace) {
    const tmp = path.join(path.dirname(real), `.ff-tmp-${crypto.randomBytes(6).toString('hex')}`);
    let made = false;
    try {
      const fh = await fsp.open(tmp, 'wx');
      made = true;
      try { await fh.writeFile(buf); } finally { await fh.close(); }
      await fsp.rename(tmp, real);
      return;
    } catch (e) {
      if (made) await fsp.unlink(tmp).catch(() => {});
      if (!['EPERM', 'EACCES', 'EBUSY', 'EXDEV'].includes(e && e.code)) throw e;
    }
  }
  await fsp.writeFile(real, buf);
}

/** Create the folders above a new file, and make sure they are where they were meant to be. */
async function ensureParent(real) {
  const dir = path.dirname(real);
  await fsp.mkdir(dir, { recursive: true });
  const rp = await fsp.realpath(dir);
  if (!P.sameLocation(rp, dir)) throw Object.assign(new Error('moved'), { code: 'ECHANGED' });
}

/** The first `n` bytes of a file. */
async function readHead(real, n) {
  const fh = await fsp.open(real, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close().catch(() => {});
  }
}

/** The start of a file, cut at `size` bytes, is UTF-8 (the cut may have split the last character: up to 3 bytes are forgiven). */
function headIsUtf8(head, size) {
  for (let k = 0; k <= (head.length < size ? 3 : 0); k++) {
    try { strictUtf8.decode(head.subarray(0, head.length - k)); return true; } catch { /* try one byte less */ }
  }
  return false;
}

const REWRITE_HOW = '如确实要追加，先用 read_file 读出全文，再用 write_file 整体重写成 UTF-8（这会改变文件编码，请先和用户说明）。';
/**
 * Appending writes UTF-8 bytes. '' when the file can take them; else why not: a UTF-16 file (the PowerShell `>`
 * default), a binary one, or one in a legacy code page would end up half in one encoding and half in another.
 * Looks at the first 8 KB (a UTF-8 BOM is fine).
 */
async function appendProblem(r, rel) {
  if (!r.exists || !r.isFile || !r.size) return '';
  let head;
  try { head = await readHead(r.real, NUL_CHECK_BYTES); } catch (e) { return readError(e, rel); }
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return `“${rel}”是 UTF-16 LE 编码的文件，往里追加 UTF-8 文字会弄坏它。${REWRITE_HOW}`;
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return `“${rel}”是 UTF-16 BE 编码的文件，往里追加 UTF-8 文字会弄坏它。${REWRITE_HOW}`;
  if (hasNul(head)) return `“${rel}”看起来是二进制文件（前 8 KB 里有 NUL 字节），不能往里追加文字。`;
  if (!headIsUtf8(head, r.size)) return `“${rel}”不是 UTF-8 编码的文本（看起来是系统代码页），往里追加 UTF-8 文字会弄坏里面的中文等字符。${REWRITE_HOW}`;
  return '';
}

function writeProblem(args, ctx) {
  if (typeof args.content !== 'string') return 'content 必须是文字。';
  const bytes = Buffer.byteLength(args.content);
  if (bytes > LIMITS.writeContentBytes) return `一次最多写入 ${P.sizeText(LIMITS.writeContentBytes)}（这次是 ${P.sizeText(bytes)}）。请分几次写：先用 write_file 写前一部分，再用 append 追加剩下的。`;
  return budgetError(ctx, bytes);
}

async function writeFile(args, ctx, signal) {
  const rel = P.relative(args.path, ctx);
  if (aborted(signal)) return fail(STOPPED);
  const problem = writeProblem(args, ctx);
  if (problem) return fail(problem);
  const g = await guard(args.path, ctx, 'write', args.expect);
  if (g.error) return fail(g.error);
  const r = g.r;
  if (r.exists && r.isDir) return fail(`“${rel}”是文件夹，不能当文件写。`);
  if (r.exists && !r.isFile) return fail(`“${rel}”不是普通文件，不能写。`);
  const append = !!args.append;
  if (append && r.exists) {
    const bad = await appendProblem(r, rel);
    if (bad) return fail(bad);
  }
  const buf = Buffer.from(args.content, 'utf8');
  const finalSize = (append && r.exists ? r.size : 0) + buf.length;
  if (finalSize > LIMITS.writeFileBytes) return fail(`写完后文件会有 ${P.sizeText(finalSize)}，超过 ${P.sizeText(LIMITS.writeFileBytes)} 的上限。`);
  try {
    if (!r.exists) await ensureParent(r.real);
    if (append) await fsp.appendFile(r.real, buf);
    else await commitFile(r.real, buf, { exists: r.exists, inPlace: r.hardLinks });
  } catch (e) {
    if (e && e.code === 'EEXIST') return fail('文件在写入前被创建了，请重新读取后再试。');
    return fail(e && e.code === 'ECHANGED' ? '文件夹的位置在写入时变了，已停止。' : P.ioMessage(e, rel));
  }
  budgetOf(ctx).used += buf.length;
  const mode = append ? 'append' : r.exists ? 'overwrite' : 'create';
  const text = append
    ? `已追加到 ${rel}：${P.sizeText(buf.length)}${r.exists ? `，文件现在共 ${P.sizeText(finalSize)}` : '（文件原来不存在，已新建）'}。`
    : `已${r.exists ? '覆盖' : '新建'} ${rel}：${P.sizeText(buf.length)}。`;
  return done(text, undefined, { mode, bytes: buf.length, size: finalSize, created: !r.exists });
}

/* ───────────── edit_file ───────────── */

const countOf = (text, s) => { let n = 0; for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + s.length)) n++; return n; };

/**
 * How `old` is found in `text`: as written, or, when the file uses CRLF and the strings only LF (the model
 * sees lines without the CR), with both converted to CRLF so the file keeps its line endings.
 */
function locate(text, oldS, newS) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const bareLf = (text.match(/(?<!\r)\n/g) || []).length;
  const hasCr = oldS.includes('\r') || newS.includes('\r');
  if (crlf > 0 && crlf >= bareLf && !hasCr) {
    const o = oldS.replace(/\n/g, '\r\n');
    const count = countOf(text, o);
    if (count > 0) return { old: o, new: newS.replace(/\n/g, '\r\n'), count, converted: true };
  }
  const plain = countOf(text, oldS);
  if (plain === 0 && crlf === 0 && oldS.includes('\r\n')) { // the other way round: CRLF strings, an LF file
    const o = oldS.replace(/\r\n/g, '\n');
    const count = countOf(text, o);
    if (count > 0) return { old: o, new: newS.replace(/\r\n/g, '\n'), count, converted: true };
  }
  return { old: oldS, new: newS, count: plain, converted: false };
}

/**
 * Read the file and find the edit, without writing anything. → { error } | { r, a, text, bom, found, firstLine } |
 * { r, a, cardOnly: true } for the permission step (requireExpect false) on a target the user has to be asked about
 * (a key file, a protected file, a link, confirmAll …): its contents are not matched against old_string before the
 * answer, because "not found" / "found N times" / the whitespace hint would tell the model what is in a file it was
 * never allowed to read. The run (requireExpect true) matches after the answer, and still gives no hint for such a file.
 */
async function editPlan(args, ctx, signal, expect, requireExpect) {
  const rel = P.relative(args.path, ctx);
  const oldS = args.old_string;
  const newS = args.new_string;
  if (typeof oldS !== 'string' || typeof newS !== 'string') return { error: 'old_string 和 new_string 都必须是文字。' };
  if (oldS === '') return { error: 'old_string 不能是空的；要新建文件或整体重写请用 write_file。' };
  if (oldS === newS) return { error: 'old_string 和 new_string 一样，没有要改的。' };
  const newBytes = Buffer.byteLength(newS);
  if (newBytes > LIMITS.writeContentBytes) return { error: `new_string 最多 ${P.sizeText(LIMITS.writeContentBytes)}（这次是 ${P.sizeText(newBytes)}）。大段内容请用 write_file 分几次写。` };
  const g = requireExpect ? await guard(args.path, ctx, 'write', expect) : await (async () => {
    const r = await P.resolveAsync(args.path, ctx);
    const a = P.assess(r, 'write', ctx);
    return a.error ? { error: a.error } : { r, a };
  })();
  if (g.error) return { error: g.error };
  const { r } = g;
  if (!r.exists) return { error: `找不到文件：${rel}。要新建文件请用 write_file。` };
  const gated = !!(g.a.mustAsk || ctx.confirmAll || r.sensitive || r.protectedWrite);
  if (gated && !requireExpect) {
    const problem = fileProblem(r, rel, LIMITS.editFileBytes);
    if (problem) return { error: problem };
    return { r, a: g.a, cardOnly: true, replaceAll: !!args.replace_all, rel };
  }
  const loaded = await loadText(r, rel, LIMITS.editFileBytes, signal);
  if (loaded.error) return { error: loaded.error };
  if (loaded.enc !== 'UTF-8') return { error: `“${rel}”不是 UTF-8 编码的文本（${loaded.enc}），直接改会弄坏里面的中文等字符。如确实要改，先用 read_file 读出全文，再用 write_file 整体重写成 UTF-8（这会改变文件编码，请先和用户说明）。` };
  const found = locate(loaded.text, oldS, newS);
  if (found.count === 0) {
    const t = oldS.trim();
    const hint = !gated && t && t !== oldS && countOf(loaded.text, t) > 0 ? `去掉 old_string 首尾的空白或换行后能找到 ${countOf(loaded.text, t)} 处，请检查首尾空白。` : '请先用 read_file 看一下文件现在的内容；缩进、空格和换行都要和文件里完全一致。';
    return { error: `在“${rel}”里找不到 old_string。${hint}` };
  }
  if (found.count > 1 && !args.replace_all) {
    return { error: `在“${rel}”里找到了 ${found.count} 处 old_string，无法确定要改哪一处。请在 old_string 里多带几行上下文让它唯一，或者把 replace_all 设为 true 替换全部。` };
  }
  // The size of the result, in bytes, before any string is built: replace_all on a big file with a long new_string would
  // otherwise freeze the main process (and run into the string length limit) only to be refused afterwards.
  const times = args.replace_all ? found.count : 1;
  const projected = loaded.buf.length + times * (Buffer.byteLength(found.new) - Buffer.byteLength(found.old));
  if (projected > LIMITS.writeFileBytes) return { error: `改完后文件会有 ${P.sizeText(projected)}，超过 ${P.sizeText(LIMITS.writeFileBytes)} 的上限。` };
  const over = budgetError(ctx, projected);
  if (over) return { error: over };
  const bom = loaded.buf.length >= 3 && loaded.buf[0] === 0xef && loaded.buf[1] === 0xbb && loaded.buf[2] === 0xbf;
  const firstLine = loaded.text.slice(0, loaded.text.indexOf(found.old)).split('\n').length;
  return { r, a: g.a, text: loaded.text, bom, found, firstLine, replaceAll: !!args.replace_all, rel };
}

async function editFile(args, ctx, signal) {
  const rel = P.relative(args.path, ctx);
  if (aborted(signal)) return fail(STOPPED);
  const plan = await editPlan(args, ctx, signal, args.expect, true);
  if (plan.error) return fail(plan.error);
  const { r, text, bom, found } = plan;
  if (args.expect && typeof args.expect.count === 'number' && args.expect.count !== found.count) return fail('文件在等待确认期间变了，请重新读取后再试。');
  const next = plan.replaceAll ? text.split(found.old).join(found.new) : text.slice(0, text.indexOf(found.old)) + found.new + text.slice(text.indexOf(found.old) + found.old.length);
  const body = Buffer.from(next, 'utf8');
  const buf = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  if (buf.length > LIMITS.writeFileBytes) return fail(`改完后文件会有 ${P.sizeText(buf.length)}，超过 ${P.sizeText(LIMITS.writeFileBytes)} 的上限。`);
  const over = budgetError(ctx, buf.length);
  if (over) return fail(over);
  if (aborted(signal)) return fail(STOPPED);
  try {
    await commitFile(r.real, buf, { exists: true, inPlace: r.hardLinks });
  } catch (e) {
    return fail(P.ioMessage(e, rel));
  }
  budgetOf(ctx).used += buf.length;
  const n = plan.replaceAll ? found.count : 1;
  const extra = found.converted ? '文件用 CRLF 换行，已按 CRLF 匹配并写回。' : '';
  return done(`已修改 ${rel}：替换了 ${n} 处（第 ${plan.firstLine} 行起）。${extra}`, undefined, { replacements: n, firstLine: plan.firstLine, bytes: buf.length });
}

/* ───────────── what the permission step needs ───────────── */

const NAMES = ['read_file', 'list_directory', 'glob', 'search_file_content', 'write_file', 'edit_file'];

/**
 * For the permission step (tools/index.cjs prepare): resolve and judge a call without doing it.
 * `args` are the whitelisted fields of the tool. →
 *   { ok: false, error }   cannot run; no question to the user (the error goes to the model)
 *   { ok: true, path: <literal absolute path>, real, title, blockedPath, mustAsk, risk, reason, expect, mode? }
 * `expect` is what to pass back as args.expect when the call runs. `reason` is only what the rules say
 * (link, secrets, protected file, overwrite size…): the caller adds its own notes (custom service address).
 */
async function plan(name, args, ctx, signal) {
  try {
    if (!NAMES.includes(name)) return { ok: false, error: `不认识的文件工具：${name}` };
    const dirTool = name === 'list_directory' || name === 'glob' || name === 'search_file_content';
    const p = dirTool && (args.path === undefined || args.path === null || args.path === '') ? '.' : args.path;
    const rel = P.relative(p, ctx);
    if (name === 'glob') { const bad = P.checkGlobPattern(args.pattern, 'pattern'); if (bad) return { ok: false, error: bad }; }
    if (name === 'search_file_content') {
      if (typeof args.pattern !== 'string' || !args.pattern) return { ok: false, error: 'pattern 是空的。' };
      if (args.pattern.length > LIMITS.patternChars) return { ok: false, error: `pattern 太长了（最多 ${LIMITS.patternChars} 字）。` };
      if (args.glob) { const bad = P.checkGlobPattern(args.glob, 'glob'); if (bad) return { ok: false, error: bad }; }
    }
    const isWrite = name === 'write_file' || name === 'edit_file';
    let extraReason = '';
    let mode;
    let count;
    let expectExtra = {};

    if (name === 'write_file') {
      const problem = writeProblem(args, ctx);
      if (problem) return { ok: false, error: problem };
    }
    let r;
    let a;
    if (name === 'edit_file') {
      const ep = await editPlan(args, ctx, signal, null, false);
      if (ep.error) return { ok: false, error: ep.error };
      r = ep.r; a = ep.a;
      if (ep.cardOnly) {
        extraReason = ep.replaceAll ? '替换全部匹配处（批准前不核对 old_string，处数批准后才知道）' : '批准前不核对 old_string 是否存在';
      } else {
        count = ep.found.count;
        if (ep.replaceAll) { extraReason = `替换全部 ${count} 处`; expectExtra = { count }; }
      }
    } else {
      r = await P.resolveAsync(p, ctx);
      a = P.assess(r, isWrite ? 'write' : name === 'read_file' ? 'read' : 'list', ctx);
      if (a.error) return { ok: false, error: a.error };
      // A target that cannot be what the tool wants is refused before the user is asked (only inside the
      // folders: for outside places, whether something exists is not the model's to learn without a question).
      if (r.inside || r.inSkills) {
        if (name === 'read_file' && !r.exists) return { ok: false, error: `找不到文件：${rel}` };
        if (name === 'read_file' && r.isDir) return { ok: false, error: `“${rel}”是文件夹，不是文件；要看里面有什么请用 list_directory。` };
        if ((name === 'list_directory' || name === 'glob') && !r.exists) return { ok: false, error: `找不到文件夹：${rel}` };
        if ((name === 'list_directory' || name === 'glob') && !r.isDir) return { ok: false, error: `“${rel}”不是文件夹。` };
        if (name === 'search_file_content' && !r.exists) return { ok: false, error: `找不到：${rel}` };
      }
      if (name === 'write_file') {
        if (r.exists && !r.isFile) return { ok: false, error: `“${rel}”不是普通文件，不能写。` };
        const bytes = Buffer.byteLength(args.content);
        const append = !!args.append;
        mode = append ? 'append' : r.exists ? 'overwrite' : 'create';
        if ((append && r.exists ? r.size : 0) + bytes > LIMITS.writeFileBytes) return { ok: false, error: `写完后文件会超过 ${P.sizeText(LIMITS.writeFileBytes)} 的上限。` };
        // The encoding of a file the user has to be asked about is not looked at before the answer (writeFile does it after).
        if (append && r.exists && !(a.mustAsk || ctx.confirmAll)) {
          const bad = await appendProblem(r, rel);
          if (bad) return { ok: false, error: bad };
        }
        if (append) extraReason = `追加 ${P.sizeText(bytes)}`;
        else if (r.exists) extraReason = `覆盖已有文件（${P.sizeText(r.size)} → ${P.sizeText(bytes)}）`;
        const lines = args.content === '' ? 0 : args.content.split('\n').length;
        if (lines > 80) extraReason += `${extraReason ? '；' : ''}共 ${lines} 行，卡片只显示前 80 行`;
      }
    }
    const title = {
      read_file: `读取 ${rel}`, list_directory: `列出 ${rel === '.' ? '工作文件夹' : rel}`, glob: `查找 ${P.visible(String(args.pattern)).slice(0, 80)}`,
      search_file_content: `搜索“${P.visible(String(args.pattern)).slice(0, 60)}”`, edit_file: `修改 ${rel}`,
      write_file: `写入 ${rel}${mode === 'append' ? '（追加）' : mode === 'overwrite' ? '（覆盖）' : ''}`,
    }[name];
    const reason = [a.reason, extraReason].filter(Boolean).join('；');
    return {
      ok: true, path: r.literal, real: r.real, title, blockedPath: a.blockedPath || undefined, mustAsk: a.mustAsk || !!ctx.confirmAll || undefined,
      risk: a.risk, reason: reason || undefined, expect: { ...P.snapshot(r), ...expectExtra }, mode,
    };
  } catch (e) {
    return { ok: false, error: `检查路径时出错：${(e && e.message) || e}` };
  }
}

/** An unexpected error inside a tool is that call's failed result, never an exception into the loop. */
const safe = (fn) => async (args, ctx, signal) => {
  try { return await fn(args && typeof args === 'object' ? args : {}, ctx, signal); } catch (e) { return fail(`内部错误：${(e && e.message) || e}`); }
};
const tools = {
  read_file: safe(readFile), list_directory: safe(listDirectory), glob: safe(glob), search_file_content: safe(search), write_file: safe(writeFile), edit_file: safe(editFile),
};

/** Run one of the file tools by name. */
function execute(name, args, ctx, signal) {
  return Object.prototype.hasOwnProperty.call(tools, name) ? tools[name](args, ctx, signal) : Promise.resolve(fail(`不认识的文件工具：${name}`));
}

module.exports = {
  readFile: tools.read_file, writeFile: tools.write_file, editFile: tools.edit_file, listDirectory: tools.list_directory, glob: tools.glob, search: tools.search_file_content,
  plan, execute, LIMITS, NAMES,
  // Exposed for scripts/apitools-check.ts.
  _internals: { locate, decodeText, runWorker, commitFile, budgetOf, displayPrefix, legacyLabel },
};
