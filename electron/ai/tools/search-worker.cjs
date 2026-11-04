// Walks a folder for glob and search_file_content, in a worker thread: the regular expression comes from
// the model (a catastrophic one never returns), and a walk of 20 000 files is slow. The caller
// (files.cjs) terminates the worker after 20 s or when the run is stopped; what was found by then has
// been sent already, in batches.
//
// The walk never enters a symbolic link or a directory junction (lstat decides, not the directory entry),
// skips the folders and names that paths.cjs lists, and checks the real path of every file once more
// before its content is read. It is told where to start (an already resolved real path) and only reports.
'use strict';
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const P = require('./paths.cjs');

const fsp = fs.promises;
const MAX_DEPTH = 100;
const CHUNK = 8; // files read at once
const NUL_CHECK_BYTES = 8192;

/* ───────────── glob patterns ───────────── */
// Matched without regular expressions (a glob is linear to match; a translated one can backtrack):
// `*` `?` `[abc]` `[!a-c]` inside a name, `**` for any number of folders, {a,b} written out beforehand.

function parseSegment(seg, ignoreCase) {
  const chars = Array.from(seg);
  const nodes = [];
  const f = (c) => (ignoreCase ? P.fold(c) : c);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '*') { if (!nodes.length || nodes[nodes.length - 1].t !== 'star') nodes.push({ t: 'star' }); } else if (c === '?') nodes.push({ t: 'any' });
    else if (c === '[') {
      let j = i + 1;
      const neg = chars[j] === '!' || chars[j] === '^';
      if (neg) j++;
      const start = j;
      if (chars[j] === ']') j++;
      while (j < chars.length && chars[j] !== ']') j++;
      if (j >= chars.length) { nodes.push({ t: 'lit', c: f(c) }); continue; } // no closing bracket: an ordinary [
      const body = chars.slice(start, j);
      const items = [];
      for (let k = 0; k < body.length; k++) {
        if (body[k + 1] === '-' && k + 2 < body.length) { items.push([f(body[k]), f(body[k + 2])]); k += 2; } else items.push([f(body[k]), f(body[k])]);
      }
      nodes.push({ t: 'cls', neg, items });
      i = j;
    } else nodes.push({ t: 'lit', c: f(c) });
  }
  return nodes;
}

function matchOne(node, ch) {
  if (node.t === 'any') return true;
  if (node.t === 'lit') return node.c === ch;
  const hit = node.items.some(([lo, hi]) => ch >= lo && ch <= hi);
  return node.neg ? !hit : hit;
}

/** One name against one segment pattern (iterative `*` with a single backtrack point: no blow-up). */
function matchSegment(nodes, name, ignoreCase) {
  const chars = Array.from(name).map((c) => (ignoreCase ? P.fold(c) : c));
  let n = 0;
  let s = 0;
  let starN = -1;
  let starS = 0;
  while (s < chars.length) {
    const nd = nodes[n];
    if (nd && nd.t === 'star') { starN = n++; starS = s; continue; }
    if (nd && matchOne(nd, chars[s])) { n++; s++; continue; }
    if (starN >= 0) { n = starN + 1; s = ++starS; continue; }
    return false;
  }
  while (nodes[n] && nodes[n].t === 'star') n++;
  return n === nodes.length;
}

/**
 * A relative glob as { start(), step(state, name), matches(state), alive(state) }. A state is where the
 * pattern has got to after the folders so far; `alive` says whether anything below can still match (a
 * folder that cannot is not entered), `matches` whether the path so far is a match. A pattern without a
 * `/` matches names at any depth (`*.ts` is `**` + `/*.ts`), like ripgrep's --glob; a trailing `/` means
 * everything below. Case-insensitive on Windows.
 */
function compileGlob(pattern, ignoreCase = P.isWin) {
  const alts = P.expandBraces(String(pattern).replace(/\\/g, '/')) || [];
  const compiled = alts.map((alt) => {
    const trailing = alt.endsWith('/');
    let segs = alt.split('/').filter((s) => s && s !== '.');
    if (!segs.length) segs = ['**'];
    if (segs.length === 1 && segs[0] !== '**' && !alt.includes('/')) segs.unshift('**');
    if (trailing) segs.push('**');
    return segs.map((s) => (s === '**' ? { dstar: true } : { nodes: parseSegment(s, ignoreCase) }));
  });
  const closure = (alt, set) => {
    const out = new Set(set);
    for (const i of [...out]) for (let j = i; alt[j] && alt[j].dstar; j++) out.add(j + 1);
    return out;
  };
  return {
    start: () => compiled.map((alt) => closure(alt, [0])),
    step: (state, name) => state.map((set, k) => {
      const alt = compiled[k];
      const next = new Set();
      for (const i of set) {
        const p = alt[i];
        if (!p) continue;
        if (p.dstar) next.add(i);
        else if (matchSegment(p.nodes, name, ignoreCase)) next.add(i + 1);
      }
      return closure(alt, next);
    }),
    matches: (state) => state.some((set, k) => set.has(compiled[k].length)),
    alive: (state) => state.some((set) => set.size > 0),
  };
}

/* ───────────── the expression ───────────── */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The model's pattern as a regular expression; one that does not parse is searched for as plain text. */
function makeMatcher(pattern, ignoreCase) {
  for (const flags of [ignoreCase ? 'iu' : 'u', ignoreCase ? 'i' : '']) {
    try { return { re: new RegExp(pattern, flags), mode: 'regex' }; } catch { /* next */ }
  }
  return { re: new RegExp(escapeRe(pattern), ignoreCase ? 'i' : ''), mode: 'literal' };
}

/* ───────────── the walk ───────────── */

function hasNul(buf) {
  const n = Math.min(buf.length, NUL_CHECK_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function run(data) {
  const { mode, root, rootIsFile, outPrefix, deadline } = data;
  const lim = data.limits;
  const stats = { dirs: 0, files: 0, links: 0, sensitive: 0, big: 0, binary: 0, odd: 0, unreadable: 0, skippedDirs: 0, escaped: 0 };
  const glob = data.glob ? compileGlob(data.glob, P.isWin) : null;
  let matcher = null;
  if (mode === 'search') {
    matcher = makeMatcher(data.pattern, !!data.ignoreCase);
    parentPort.postMessage({ type: 'start', regexMode: matcher.mode });
  }
  // The start folder is inside a .git folder (or is its config): config and credentials there hold tokens.
  // The walk itself never enters a .git folder below the start (SKIP_DIRS), so one flag for the start is enough;
  // relSegs is checked as well in case a .git name ever gets through.
  const rootInGit = !!data.inGit;
  const inGit = (relSegs) => rootInGit || relSegs.some((seg) => P.isGitName(seg));
  const legacy = data.legacy || 'gbk';
  const strict = new TextDecoder('utf-8', { fatal: true });
  let legacyDecoder = null;
  const decode = (buf) => {
    try { return strict.decode(buf); } catch {
      try { legacyDecoder = legacyDecoder || new TextDecoder(legacy); return legacyDecoder.decode(buf); } catch { return buf.toString('latin1'); }
    }
  };

  let stop = '';
  let pending = [];
  let lastFlush = Date.now();
  const flush = (force) => {
    if (pending.length && (force || pending.length >= 50 || Date.now() - lastFlush > 200)) {
      parentPort.postMessage({ type: 'items', items: pending });
      pending = [];
      lastFlush = Date.now();
    }
  };
  const total = { n: 0 };
  const timeUp = () => Date.now() > deadline;
  const display = (relSegs, name) => outPrefix + [...relSegs, name].join('/');

  /** Search one file; the hits as 'path:line: text'. */
  async function searchFile(dirReal, name, relSegs) {
    if (P.isSensitiveName(name, inGit(relSegs))) { stats.sensitive++; return []; }
    const full = path.join(dirReal, name);
    let st;
    try { st = await fsp.lstat(full); } catch { stats.unreadable++; return []; }
    if (st.isSymbolicLink()) { stats.links++; return []; }
    if (!st.isFile()) return [];
    if (st.size > lim.searchFileBytes) { stats.big++; return []; }
    if (st.size === 0) return [];
    // The real path once more, now that the content is about to be read: it must still be in the start folder.
    let rp;
    try { rp = await fsp.realpath(full); } catch { stats.unreadable++; return []; }
    if (rootIsFile ? !P.sameLocation(rp, root) : !P.within(root, rp)) { stats.escaped++; return []; }
    let buf;
    try { buf = await fsp.readFile(full); } catch { stats.unreadable++; return []; }
    if (hasNul(buf)) { stats.binary++; return []; }
    const lines = decode(buf).split('\n');
    const hits = [];
    const label = display(relSegs, name);
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (matcher.re.test(line.length > 20000 ? line.slice(0, 20000) : line)) {
        hits.push(`${label}:${i + 1}: ${line.length > lim.searchLineChars ? `${line.slice(0, lim.searchLineChars)}…` : line}`);
        if (hits.length >= lim.searchMatches) break;
      }
    }
    return hits;
  }

  async function handleFiles(dirReal, names, relSegs, state) {
    for (let i = 0; i < names.length && !stop; i += CHUNK) {
      if (timeUp()) { stop = 'time'; return; }
      const chunk = names.slice(i, i + CHUNK);
      if (mode === 'glob') {
        for (const name of chunk) {
          const next = glob.step(state, name);
          if (glob.matches(next) && !P.isSensitiveName(name, inGit(relSegs))) pending.push(display(relSegs, name));
          else if (glob.matches(next)) stats.sensitive++;
        }
      } else {
        const wanted = chunk.filter((name) => !glob || glob.matches(glob.step(state, name)));
        const results = await Promise.all(wanted.map((name) => searchFile(dirReal, name, relSegs)));
        for (const hits of results) {
          for (const h of hits) {
            if (total.n >= lim.searchMatches) { stop = 'limit'; break; }
            pending.push(h);
            total.n++;
          }
          if (stop) break;
        }
        if (total.n >= lim.searchMatches) stop = 'limit';
      }
      flush(false);
    }
  }

  async function visitDir(dirReal, state, relSegs, depth) {
    if (stop) return;
    if (timeUp()) { stop = 'time'; return; }
    if (stats.dirs >= lim.maxDirs) { stop = 'dirs'; return; }
    stats.dirs++;
    let ents;
    try { ents = await fsp.readdir(dirReal, { withFileTypes: true }); } catch { stats.unreadable++; return; }
    const keyed = ents.map((ent) => ({ ent, key: P.fold(ent.name) }));
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const files = [];
    const dirs = [];
    for (const { ent } of keyed) {
      const name = ent.name;
      if (P.badSegment(name)) { stats.odd++; continue; } // a device name or a trailing dot: not something to open
      let kind = ent.isSymbolicLink() ? 'link' : ent.isDirectory() ? 'dir' : ent.isFile() ? 'file' : 'other';
      if (kind !== 'file') {
        // Anything that could be entered is asked of lstat, not taken from the entry: a junction must not pass for a folder.
        try {
          const st = await fsp.lstat(path.join(dirReal, name));
          kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
        } catch { stats.unreadable++; continue; }
      }
      if (kind === 'link') { stats.links++; continue; }
      if (kind === 'dir') {
        if (P.SKIP_DIRS.has(name.toLowerCase())) { stats.skippedDirs++; continue; }
        // A junction to a volume GUID path (\\?\Volume{…}\x) is no link to lstat: its real path tells where it goes.
        let rp = '';
        try { rp = await fsp.realpath(path.join(dirReal, name)); } catch { stats.unreadable++; continue; }
        if (!P.sameLocation(rp, path.join(dirReal, name))) { stats.links++; continue; }
        dirs.push(name);
      } else if (kind === 'file') {
        stats.files++;
        if (stats.files > lim.maxFiles) { stop = 'files'; break; }
        files.push(name);
      }
    }
    await handleFiles(dirReal, files, relSegs, state);
    if (depth >= MAX_DEPTH) return;
    for (const name of dirs) {
      if (stop) break;
      const next = glob ? glob.step(state, name) : state;
      if (glob && !glob.alive(next)) continue;
      await visitDir(path.join(dirReal, name), next, [...relSegs, name], depth + 1);
    }
  }

  if (rootIsFile) {
    // search_file_content with a file as `path`: just that file.
    stats.files = 1;
    const dir = path.dirname(root);
    const hits = await searchFile(dir, path.basename(root), []);
    for (const h of hits.slice(0, lim.searchMatches)) pending.push(h);
    if (hits.length >= lim.searchMatches) stop = 'limit';
  } else {
    await visitDir(root, glob ? glob.start() : null, [], 0);
  }
  flush(true);
  parentPort.postMessage({ type: 'done', stats, stop, regexMode: matcher ? matcher.mode : '' });
}

if (isMainThread) {
  // Required from the main thread (scripts/apitools-check.ts): the pure parts only.
  module.exports = { compileGlob, makeMatcher, matchSegment, parseSegment };
} else {
  run(workerData).catch((e) => {
    try { parentPort.postMessage({ type: 'error', message: String((e && e.message) || e) }); } catch { /* the port is gone */ }
  });
}
