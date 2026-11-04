// Paths for the API tools (electron/ai/tools): what the model may name, what it resolves to, and what
// each place means (work folder, skills folder, hard no-go zones, secrets, files other agents read as
// orders). A string from the model never reaches the file system as it is: resolve() validates it, walks
// it segment by segment so that links are seen, and hands back the canonical path that every later step
// must use. Nothing here talks to the renderer; files.cjs and tools/index.cjs act on what it reports.
//
// The walk is written once as a generator that asks for lstat / realpath, and driven either with the
// sync calls (resolve, checkWorkFolder: at the start of a run) or with fs.promises (resolveAsync: the
// tools, so a slow or dead drive never freezes the main process). Both give the same answer.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isWin = process.platform === 'win32';
const MAX_PATH_CHARS = 32000;
const CACHE_MS = 30_000;

const WORK_FOLDER_ERROR = '工作文件夹不能是磁盘根目录、用户主目录、系统目录或萤火自己的数据目录，请选一个具体的项目文件夹。';

/** Folders the walks do not go into (listing them by name is fine). */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', '__pycache__', '.venv', 'venv', '.cache']);

/* ───────────── small pure helpers ───────────── */

// C0 and C1 controls, DEL, and the bidi controls (U+202A–202E, U+2066–2069, LRM, RLM, ALM): a path with one
// of them can read as another path on a card, and no real file needs them.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_G = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$)$/;

/** Control and bidi characters written out (U+202E → \u{202e}) so that a name cannot disguise itself on a card. */
function visible(s, keepLines) {
  return String(s).replace(CONTROL_G, (c) => {
    if (keepLines && (c === '\n' || c === '\t')) return c; // text for a card keeps its line breaks
    return c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : `\\u{${c.codePointAt(0).toString(16)}}`;
  });
}

/** Case folding for comparing names: NTFS maps single code points to upper case, so ß stays ß and the
 *  Kelvin sign stays the Kelvin sign (toLowerCase would call both equal to ASCII spellings). */
function fold(s) {
  const text = String(s);
  if (!isWin) return text;
  if (/^[\u0000-\u007f]*$/.test(text)) return text.toUpperCase();
  let out = '';
  for (const ch of text) {
    const up = ch.toUpperCase();
    out += [...up].length === 1 ? up : ch;
  }
  return out;
}

const trimSep = (p) => {
  const root = path.parse(p).root;
  return p.length > root.length ? p.replace(/[\\/]+$/, '') : p;
};
/** A path as a comparison key: normalized, no trailing separator, case-folded on Windows. */
const keyOf = (p) => fold(trimSep(path.normalize(String(p))));

/** `child` is `parent` itself or somewhere below it. Lexical: both sides should already be canonical. */
function within(parent, child) {
  if (!parent || !child) return false;
  const a = keyOf(parent);
  const b = keyOf(child);
  if (a === b) return true;
  return b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}
const sameLocation = (a, b) => !!a && !!b && keyOf(a) === keyOf(b);

const segments = (p) => String(p).split(/[\\/]+/).filter((s) => s && s !== '.');
/** The segments below the root (G:\a\b → a, b). */
const partsOf = (p) => String(p).slice(path.parse(String(p)).root.length).split(/[\\/]+/).filter(Boolean);

/** Why one path segment cannot be used as it is ('' when it can). Names that Windows reads as something
 *  else: devices (con.txt is CON), names with trailing dots or spaces (stripped, so `a.txt.` is `a.txt`),
 *  streams (`a.txt:s`). Also used on the names a directory walk finds. */
function badSegment(seg) {
  if (!seg || seg === '.' || seg === '..') return '';
  if (CONTROL_RE.test(seg)) return '含有控制字符或方向控制字符';
  if (!isWin) return '';
  if (seg.includes(':')) return '含有“:”（Windows 的备用数据流或盘符写法）';
  if (/[<>"|?*]/.test(seg)) return '含有 Windows 不允许的字符';
  if (/[ .]$/.test(seg)) return '以空格或句点结尾（Windows 会悄悄去掉它，容易指到别的文件）';
  const base = seg.split('.')[0].replace(/ +$/, '').toUpperCase();
  if (RESERVED_RE.test(base)) return '是 Windows 的保留设备名';
  return '';
}

/** What a path string from the model must satisfy before anything is done with it ('' = fine). */
function checkRaw(p) {
  if (typeof p !== 'string') return '路径必须是文字。';
  if (!p.trim()) return '路径是空的。';
  if (p.length > MAX_PATH_CHARS) return '路径太长了。';
  if (CONTROL_RE.test(p)) return '路径里有控制字符或方向控制字符，已拒绝。';
  if (isWin) {
    if (/^[\\/]{2}/.test(p)) return '不支持网络路径（\\\\server\\share）以及以 \\\\?\\、\\\\.\\ 开头的路径。';
    let rest = p;
    if (/^[A-Za-z]:/.test(p)) {
      if (!/^[A-Za-z]:[\\/]/.test(p)) return '不支持只写盘符不写目录的路径（如 C:foo），请写完整的绝对路径或相对工作文件夹的路径。';
      rest = p.slice(2);
    }
    if (rest.includes(':')) return '路径里不能含“:”（盘符之外），它可能指向文件的备用数据流。';
    for (const seg of rest.split(/[\\/]+/)) {
      const why = badSegment(seg);
      if (why) return `路径里的“${visible(seg).slice(0, 60)}”${why}。`;
    }
  } else if (p.split(/[\\/]+/).includes('..')) {
    return '路径里不能含“..”，请写相对工作文件夹的路径或绝对路径。';
  }
  return '';
}

/** Error code → a sentence for the model. */
function ioMessage(e, what) {
  const target = what ? `“${what}”` : '这个路径';
  switch (e && e.code) {
    case 'ENOENT': return `找不到${target}。`;
    case 'ENOTDIR': return `${target}的某一级不是文件夹。`;
    case 'EACCES': case 'EPERM': return `没有权限访问${target}。`;
    case 'EBUSY': return `${target}正被其它程序占用。`;
    case 'EISDIR': return `${target}是文件夹，不是文件。`;
    case 'ENOSPC': return '磁盘空间不足。';
    case 'ELOOP': return `${target}的链接绕成了圈。`;
    case 'ENAMETOOLONG': return `${target}太长了。`;
    default: return `${target}访问失败（${(e && (e.code || e.message)) || '未知错误'}）。`;
  }
}

/* ───────────── file names that mean something ───────────── */

// Keys, certificates, password stores and credential files: reading one is a decision for the user. One list
// for read_file, glob and search_file_content (list_directory shows names only, so it is not filtered).
// Everything that starts with .env is one family (.envrc, .env-prod, .env_local), as in protectedReason.
const SENSITIVE_RES = [
  /^\.env/i, /\.(pem|key|pfx|p12|p8|kdbx|ppk|jks|keystore)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)/i, /^auth\.json$/i, /^credentials/i, /^\.git-credentials$/i, /^\.netrc$/i, /^\.npmrc$/i, /^\.pgpass$/i,
  /^\.(pypirc|dockercfg|htpasswd)$/i, /^kubeconfig$/i, /\.kubeconfig$/i, /\.tfvars(\.json)?$/i, /\.tfstate(\.backup)?$/i,
  /^client_secret.*\.json$/i, /^service[-_]?account.*\.json$/i,
];
// Inside a .git folder the repository's own config and credentials are secret too: a remote URL can carry
// a token (https://user:token@host/...).
const GIT_SENSITIVE_RE = /^(config|credentials)$/i;
/** `inGit`: the name is in (or is the content of) a .git folder. */
function isSensitiveName(name, inGit) {
  const n = String(name || '');
  return SENSITIVE_RES.some((re) => re.test(n)) || (!!inGit && GIT_SENSITIVE_RE.test(n));
}

// Files that other agents or tools read as instructions or configuration, or run: writing one is a way
// to give orders to something that has no approval step. (Folders are checked on every segment.)
const PROTECTED_FILES = new Set(['.MCP.JSON', '.NPMRC', '.CURSORRULES', '.WINDSURFRULES', '.GITMODULES']);
const PROTECTED_DIRS = new Set(['.CLAUDE', '.CODEX', '.CURSOR', '.VSCODE', '.GITHUB', '.HUSKY', '.QWEN', '.KIMI', '.DSH', '.GEMINI', '.WINDSURF',
  '.AGENTS', '.ROO', '.CONTINUE', '.JUNIE', '.AMAZONQ', '.CLINERULES']); // every segment counts, so a file named .clinerules too
// Instruction files by pattern, not by exact name: AGENTS.md, AGENT.md, AGENTS.override.md (Codex reads it before
// AGENTS.md), CLAUDE.local.md, GEMINI.md … A harmless name like claude-notes.md is asked about too, which is cheap.
const AGENT_MD_RE = /^(AGENTS?|CLAUDE|GEMINI|QWEN|KIMI|CODEX)([.-][^/\\]+)?\.MD$/;
const AGENT_NOTE = '其它 Agent 或工具会把这个文件当作指令或配置读取（或自动执行），请确认';

// Names are compared upper-cased. On Windows that is the NTFS fold; elsewhere fold() leaves the case alone,
// so the sets above (upper case) would never match.
const upper = (s) => (isWin ? fold(s) : String(s).toUpperCase());

function protectedReason(segs) {
  for (let i = 0; i < segs.length; i++) {
    const s = upper(segs[i]);
    const last = i === segs.length - 1;
    if (PROTECTED_DIRS.has(s)) return AGENT_NOTE;
    if (last && (PROTECTED_FILES.has(s) || AGENT_MD_RE.test(s) || /^\.ENV/.test(s))) return AGENT_NOTE;
  }
  return '';
}
const isGitName = (seg) => { const s = upper(seg); return s === '.GIT' || /^GIT~\d+$/.test(s); };

/* ───────────── the walk ───────────── */

const SYNC_OPS = { lstat: (p) => fs.lstatSync(p), realpath: (p) => fs.realpathSync.native(p) };
// fs.promises.realpath is the native one (case and 8.3 names are expanded), same as the sync call above.
const ASYNC_OPS = { lstat: (p) => fs.promises.lstat(p), realpath: (p) => fs.promises.realpath(p) };

function runSync(gen) {
  let step = gen.next();
  while (!step.done) {
    const [op, arg] = step.value;
    let res;
    try { res = { v: SYNC_OPS[op](arg) }; } catch (e) { res = { e }; }
    step = gen.next(res);
  }
  return step.value;
}
async function runAsync(gen) {
  let step = gen.next();
  while (!step.done) {
    const [op, arg] = step.value;
    let res;
    try { res = { v: await ASYNC_OPS[op](arg) }; } catch (e) { res = { e }; }
    step = gen.next(res);
  }
  return step.value;
}

/**
 * Canonical form of an absolute path that has been through checkRaw / path.resolve. From the root, one
 * segment at a time: a symbolic link or directory junction must resolve (a dangling one is an error, not
 * a "new file"); the first segment that does not exist ends the walk and the rest is appended as it is.
 * The deepest existing part then goes through realpath once more, so that case, 8.3 short names (GIT~1
 * is .git) and mapped drives come out the way the file system names them.
 * Yields ['lstat'|'realpath', path] and gets { v } or { e } back.
 * → { real, exists, linked, network, stat } | { error }. `linked`: a link was crossed below `cwdLiteral`
 * (the work folder itself may be a junction without that counting).
 */
function* canonicalGen(literal, cwdLiteral) {
  const root = path.parse(literal).root;
  const parts = literal.slice(root.length).split(path.sep).filter(Boolean);
  const skip = cwdLiteral && within(cwdLiteral, literal) ? partsOf(cwdLiteral).length : 0;
  let cur = root;
  let rest = [];
  let linked = false;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(cur, parts[i]);
    const st = yield ['lstat', next];
    if (st.e) {
      if (st.e.code === 'ENOENT') { rest = parts.slice(i); break; }
      return { error: st.e.code === 'ENOTDIR' ? `“${parts[i - 1] || root}”不是文件夹，里面不能有“${visible(parts[i])}”。` : ioMessage(st.e, visible(parts[i])) };
    }
    if (st.v.isSymbolicLink()) {
      const rp = yield ['realpath', next];
      if (rp.e) return { error: `“${visible(parts[i])}”是指向不存在或无法访问的位置的链接（悬空链接），已拒绝。` };
      if (i >= skip) linked = true;
      cur = rp.v;
      // Past a link into a network share nothing more is touched: asking the share about the rest of the path
      // would already be a connection the user has not approved.
      if (isWin && /^[\\/]{2}/.test(cur)) return { real: path.join(cur, ...parts.slice(i + 1)), exists: false, linked, network: true, stat: null };
    } else cur = next;
  }
  const rp = yield ['realpath', cur];
  if (rp.e) return { error: ioMessage(rp.e, visible(path.basename(cur) || cur)) };
  const real = rest.length ? path.join(rp.v, ...rest) : rp.v;
  const network = isWin && /^[\\/]{2}/.test(real);
  let stat = null;
  if (!rest.length && !network) {
    const s = yield ['lstat', real];
    if (s.e) return { error: ioMessage(s.e, visible(path.basename(real) || real)) };
    stat = s.v;
  }
  return { real, exists: !rest.length, linked, network, stat };
}

const canonCache = new Map(); // key → { at, v }
/** The canonical form of a folder the rules compare against (skills, user data, zones); remembered for a while. */
function* realOfGen(p) {
  if (!p || typeof p !== 'string' || !path.isAbsolute(p)) return null;
  const k = keyOf(p);
  const hit = canonCache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
  const c = yield* canonicalGen(path.resolve(p), null);
  const v = c.error ? null : c.real;
  canonCache.set(k, { at: Date.now(), v });
  return v;
}

/* ───────────── hard no-go zones ───────────── */

function zoneRootNames(ctx) {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const list = [];
  for (const d of ['.ssh', '.aws', '.gnupg', '.claude', '.codex', '.dsh', '.kimi', '.azure', '.kube', '.gemini', '.qwen', '.cursor']) list.push(path.join(home, d));
  for (const f of [['.docker', 'config.json'], ['.git-credentials'], ['.netrc'], ['.npmrc'], ['.config', 'gh'], ['.config', 'gcloud']]) list.push(path.join(home, ...f));
  list.push(path.join(appData, 'Microsoft', 'Credentials'), path.join(appData, 'Microsoft', 'Protect'), path.join(local, 'Microsoft', 'Credentials'));
  // Browser profiles hold cookies and saved passwords.
  for (const f of [['Google', 'Chrome', 'User Data'], ['Google', 'Chrome SxS', 'User Data'], ['Microsoft', 'Edge', 'User Data'], ['BraveSoftware', 'Brave-Browser', 'User Data'],
    ['Chromium', 'User Data'], ['Vivaldi', 'User Data'], ['Yandex', 'YandexBrowser', 'User Data'], ['Opera Software'], ['Mozilla', 'Firefox', 'Profiles']]) list.push(path.join(local, ...f));
  list.push(path.join(appData, 'Mozilla', 'Firefox', 'Profiles'), path.join(appData, 'Opera Software'));
  if (!isWin) list.push(path.join(home, '.config', 'google-chrome'), path.join(home, '.config', 'chromium'), path.join(home, '.mozilla'));
  return list;
}

/** The app's own folders, from ctx: user data, the skills folder and the task folders default to where the app puts them. */
function dataDirs(ctx) {
  const userData = ctx && typeof ctx.userData === 'string' && path.isAbsolute(ctx.userData) ? ctx.userData : '';
  return {
    userData,
    skillsRoot: (ctx && ctx.skillsRoot) || (userData ? path.join(userData, 'skills') : ''),
    workspaceRoot: (ctx && ctx.workspaceRoot) || (userData ? path.join(userData, 'workspaces') : ''),
  };
}

const zoneCache = new Map(); // ctx key → { at, roots }
/** The zones as [{ root, except: [folders inside it that are fine] }], each in its written and canonical form. */
function* zoneRootsGen(ctx) {
  const { userData, skillsRoot, workspaceRoot } = dataDirs(ctx);
  const k = `${userData}|${skillsRoot}|${workspaceRoot}|${os.homedir()}|${process.env.APPDATA}|${process.env.LOCALAPPDATA}`;
  const hit = zoneCache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.roots;
  const roots = [];
  for (const root of zoneRootNames(ctx)) {
    roots.push({ root, except: [] });
    const real = yield* realOfGen(root);
    if (real && !sameLocation(real, root)) roots.push({ root: real, except: [] });
  }
  if (userData) {
    // The app's own data is a zone, except the task folders it creates (userData/workspaces) and the skills
    // folder (always readable; writing there is a protected write).
    const except = [];
    for (const f of [workspaceRoot, skillsRoot]) {
      except.push(f);
      const real = yield* realOfGen(f);
      if (real) except.push(real);
    }
    roots.push({ root: userData, except });
    const real = yield* realOfGen(userData);
    if (real && !sameLocation(real, userData)) roots.push({ root: real, except });
  }
  zoneCache.set(k, { at: Date.now(), roots });
  return roots;
}

function* inZoneGen(paths, ctx) {
  const roots = yield* zoneRootsGen(ctx);
  for (const p of paths) {
    if (!p) continue;
    for (const z of roots) {
      if (within(z.root, p) && !z.except.some((e) => within(e, p))) return true;
    }
  }
  return false;
}

/* ───────────── work folder ───────────── */

function* folderProblemGen(p, opts) {
  if (isWin && /^[\\/]{2}/.test(p)) return true; // UNC, \\?\, \\.\
  if (keyOf(path.parse(p).root) === keyOf(p)) return true; // a drive root
  const home = os.homedir();
  if (home && within(p, home)) return true; // the home folder, or a folder that holds it (C:\Users)
  // The application-data folders (every program keeps its tokens and settings there) and what holds them.
  for (const appData of [path.join(home, 'AppData'), process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (isWin && appData && within(p, appData)) return true;
  }
  const winDir = process.env.SystemRoot || process.env.windir;
  if (isWin && winDir && within(winDir, p)) return true;
  for (const v of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData']) {
    if (process.env[v] && sameLocation(process.env[v], p)) return true;
  }
  const dirs = dataDirs(opts);
  for (const guarded of [dirs.userData, dirs.skillsRoot]) {
    if (!guarded) continue;
    if (within(p, guarded)) return true;
    const real = yield* realOfGen(guarded);
    if (real && within(p, real)) return true;
  }
  // A folder inside a zone (~/.ssh, a browser profile…) makes every file in it a no-go: not a folder to work in.
  return yield* inZoneGen([p], opts);
}

/** null when `cwd` can be a work folder, else the sentence to show. It must exist; the checks are made on
 *  the folder as written and on what it really is (a junction named C:\work that points at the home folder). */
function checkWorkFolder(cwd, opts = {}) {
  try {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || CONTROL_RE.test(cwd)) return WORK_FOLDER_ERROR;
    if (isWin && /^[\\/]{2}/.test(cwd)) return WORK_FOLDER_ERROR;
    const literal = path.resolve(cwd);
    let real;
    try { real = fs.realpathSync.native(literal); } catch { return '工作文件夹不存在或无法访问，请重新选择。'; }
    if (!fs.statSync(real).isDirectory()) return '工作文件夹不是一个文件夹，请重新选择。';
    const options = opts || {};
    // Without the app's data folder the checks below would quietly skip the most important one.
    if (!dataDirs(options).userData) return '内部错误：检查工作文件夹时缺少应用数据目录（userData）。';
    for (const p of new Set([literal, real])) {
      if (runSync(folderProblemGen(p, options))) return WORK_FOLDER_ERROR;
    }
    return null;
  } catch {
    return WORK_FOLDER_ERROR;
  }
}

/* ───────────── resolve ───────────── */

/**
 * What a path from the model is. Never throws; `error` says why it cannot be used at all.
 * → { literal, real, inside, inSkills, zone, sensitive, protectedWrite, gitInternal, hardLinks, error?,
 *     linked, exists, isDir, isFile, size, network }
 *   literal  path.resolve(cwd, p): what to show in events (the renderer compares strings)
 *   real     the canonical path: what every file operation uses
 *   inside   real is in the work folder; inSkills: in the skills folder
 *   zone     'forbidden' for the hard no-go places
 *   linked   a link or junction below the work folder is crossed on the way (real is not where it reads)
 */
function* resolveGen(p, ctx) {
  const out = {
    literal: '', real: '', inside: false, inSkills: false, zone: undefined, sensitive: false, protectedWrite: '', gitInternal: false,
    hardLinks: false, linked: false, exists: false, isDir: false, isFile: false, size: 0, network: false,
  };
  const bad = checkRaw(p);
  if (bad) { out.error = bad; return out; }
  const cwd = ctx && ctx.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) { out.error = '工作文件夹无效。'; return out; }
  // Fail closed: without the app's data folder the no-go zone around it (keys, settings) cannot be enforced.
  if (!dataDirs(ctx).userData) { out.error = '内部错误：缺少应用数据目录（ctx.userData），无法判断受保护的位置。'; return out; }
  const literal = path.resolve(cwd, p);
  out.literal = literal;
  if (isWin && /^[\\/]{2}/.test(literal)) { out.error = '不支持网络路径。'; return out; }

  const c = yield* canonicalGen(literal, cwd);
  if (c.error) { out.error = c.error; return out; }
  const real = c.real;
  out.real = real;
  out.exists = c.exists;
  out.linked = c.linked;
  out.network = !!c.network;
  if (c.stat) {
    out.isDir = c.stat.isDirectory();
    out.isFile = c.stat.isFile();
    out.size = c.stat.size;
    out.hardLinks = c.stat.isFile() && c.stat.nlink > 1;
  }

  const realCwd = (ctx.realCwd && typeof ctx.realCwd === 'string' ? ctx.realCwd : null) || (yield* realOfGen(cwd)) || cwd;
  out.inside = within(realCwd, real);
  const skillsReal = yield* realOfGen(dataDirs(ctx).skillsRoot);
  out.inSkills = !!skillsReal && within(skillsReal, real);
  if (yield* inZoneGen([literal, real], ctx)) out.zone = 'forbidden';

  // Rules by name look at the part below the work folder (a work folder that happens to live in a folder
  // called .github is not protected for that reason); outside it, at the whole path.
  const segsReal = out.inside ? segments(path.relative(realCwd, real)) : segments(real);
  const segsLit = within(cwd, literal) ? segments(path.relative(cwd, literal)) : segments(literal);
  out.gitInternal = [...segsReal, ...segsLit].some(isGitName);
  // .git/config can hold a token in a remote URL (isSensitiveName knows, given inGit).
  out.sensitive = isSensitiveName(path.basename(literal), out.gitInternal) || isSensitiveName(path.basename(real), out.gitInternal);
  out.protectedWrite = protectedReason(segsReal) || protectedReason(segsLit)
    || (out.inSkills ? '这是萤火的技能文件夹，里面的脚本会被当作可信程序运行，请确认' : '');
  return out;
}

const resolve = (p, ctx) => runSync(resolveGen(p, ctx));
const resolveAsync = (p, ctx) => runAsync(resolveGen(p, ctx));

/** Short path for a title: relative to the work folder with forward slashes, the whole path when outside. */
function relative(p, ctx) {
  let text;
  try {
    const cwd = ctx && ctx.cwd;
    const lit = path.resolve(cwd, String(p));
    const rel = path.relative(cwd, lit);
    if (!rel) text = '.';
    else if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) text = lit;
    else text = rel.split(path.sep).join('/');
  } catch {
    text = String(p);
  }
  text = visible(text);
  return text.length > 100 ? `…${text.slice(-99)}` : text;
}

/* ───────────── what a resolved path allows ───────────── */

const sizeText = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} 字节`);

/**
 * What the rules say about doing `op` ('read' a file, 'list' a folder or search it, 'write') to a
 * resolved path. → { error, blockedPath, mustAsk, risk, reason }
 *   error     refuse outright (no question to the user)
 *   blockedPath / mustAsk / risk / reason   the fields of the permission event
 */
function assess(r, op, ctx) {
  const out = { error: '', blockedPath: '', mustAsk: false, risk: undefined, reason: '' };
  if (!r || r.error) { out.error = (r && r.error) || '路径无效。'; return out; }
  const notes = [];
  if (op === 'write') {
    if (ctx && ctx.readOnly) { out.error = '这个任务是只读的，不能写文件。'; return out; }
    if (r.zone) { out.error = '不能写这个位置：它保存着密钥、凭据或应用数据。'; return out; }
    if (!r.inside) { out.error = '只能写工作文件夹里的文件。'; return out; }
    if (r.gitInternal) { out.error = '不能直接改 .git 里的文件；需要的话用 git 命令。'; return out; }
  } else if (r.zone) {
    out.blockedPath = r.real;
    out.mustAsk = true;
    out.risk = 'high';
    notes.push('这个位置保存着密钥、凭据或应用数据，内容会发给模型服务商');
  } else if (!r.inside && !r.inSkills) {
    out.blockedPath = r.real;
    out.risk = 'high';
  }
  if (r.linked) {
    out.mustAsk = true;
    if (!r.inside && !r.inSkills && !out.blockedPath) out.blockedPath = r.real;
    notes.push(`实际位置：${visible(r.real)}（经过链接或目录联接）`);
  }
  if (r.network) { out.mustAsk = true; out.risk = 'high'; notes.push('这是网络位置'); }
  if (op === 'read' && r.sensitive) {
    out.mustAsk = true;
    out.risk = 'high';
    notes.push('这可能是密钥或凭据文件，内容会发给模型服务商');
  }
  if (op === 'write') {
    // A key or credential file is no more the model's to change than to read; and a write whose result the model
    // can compare (edit_file) would otherwise answer questions about contents it was never allowed to read.
    if (r.sensitive) { out.mustAsk = true; out.risk = 'high'; notes.push('这可能是密钥或凭据文件，改动它之前请确认'); }
    if (r.protectedWrite) { out.mustAsk = true; out.risk = 'high'; notes.push(r.protectedWrite); }
    if (r.hardLinks) { out.mustAsk = true; notes.push('这个文件有多个硬链接，改动会影响其它位置的同一个文件'); }
  }
  out.reason = notes.join('；');
  return out;
}

/** What the permission step looked at, to compare with what is found when the call finally runs. */
function snapshot(r) {
  return { real: r.real, exists: !!r.exists, hardLinks: !!r.hardLinks, linked: !!r.linked };
}

/** null when the path still is what `expect` (a snapshot) described. */
function changedSince(expect, r) {
  if (!expect) return null;
  if (!sameLocation(expect.real, r.real) || !!expect.exists !== !!r.exists || !!expect.hardLinks !== !!r.hardLinks || !!expect.linked !== !!r.linked) {
    return '文件在等待确认期间变了，请重新读取后再试。';
  }
  return null;
}

/* ───────────── relative patterns (glob) ───────────── */

/** `{a,b}` alternatives written out ("x/{a,b}.ts" → x/a.ts, x/b.ts), nested braces too; null when there would be over `max`. */
function expandBraces(pattern, max = 64) {
  const results = [];
  const work = [String(pattern)];
  while (work.length) {
    const s = work.pop();
    const open = s.indexOf('{');
    let close = -1;
    let depth = 0;
    const commas = [];
    if (open >= 0) {
      for (let i = open; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') { depth--; if (depth === 0) { close = i; break; } } else if (s[i] === ',' && depth === 1) commas.push(i);
      }
    }
    if (open < 0 || close < 0) { results.push(s); if (results.length + work.length > max) return null; continue; }
    if (!commas.length) { // `{x}` has nothing to choose from: the braces are ordinary characters
      work.push(`${s.slice(0, open)}\u0001${s.slice(open + 1, close)}\u0002${s.slice(close + 1)}`);
      continue;
    }
    const cuts = [open, ...commas, close];
    for (let i = 0; i < cuts.length - 1; i++) work.push(s.slice(0, open) + s.slice(cuts[i] + 1, cuts[i + 1]) + s.slice(close + 1));
    if (results.length + work.length > max) return null;
  }
  return results.map((r) => r.replace(/\u0001/g, '{').replace(/\u0002/g, '}')).sort();
}

/** null when `pattern` is a relative glob inside the start folder; else why not. No `:`, no leading
 *  separator, no `..` segment (also after {a,b} is written out). */
function checkGlobPattern(pattern, what = '匹配模式') {
  if (typeof pattern !== 'string' || !pattern.trim()) return `${what}是空的。`;
  if (pattern.length > 500) return `${what}太长了（最多 500 字）。`;
  if (CONTROL_RE.test(pattern)) return `${what}里有控制字符或方向控制字符。`;
  const alts = expandBraces(pattern);
  if (!alts) return `${what}里的 {a,b} 展开后太多了。`;
  for (const alt of alts) {
    if (alt.includes(':')) return `${what}必须是相对写法，不能含“:”（盘符或数据流）。`;
    if (/^[\\/]/.test(alt)) return `${what}必须是相对写法，不能以 / 或 \\ 开头；要换起始位置请用 path 参数。`;
    if (alt.split(/[\\/]+/).includes('..')) return `${what}不能含“..”；要换起始位置请用 path 参数。`;
  }
  return null;
}

module.exports = {
  checkWorkFolder, resolve, resolveAsync, relative, assess, snapshot, changedSince, checkGlobPattern, expandBraces,
  isSensitiveName, isGitName, badSegment, within, sameLocation, keyOf, fold, visible, sizeText, ioMessage, segments,
  SKIP_DIRS, WORK_FOLDER_ERROR, isWin,
  // Exposed for scripts/apitools-check.ts.
  _internals: { canonicalGen, resolveGen, runSync, runAsync, checkRaw, zoneRootsGen, protectedReason, isGitName, clearCache: () => { canonCache.clear(); zoneCache.clear(); } },
};
