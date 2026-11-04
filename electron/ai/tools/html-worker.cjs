// HTML work for web.cjs, done on a worker thread so that a hostile page cannot hold the main process up:
// web.cjs ends the worker if it takes too long. { kind: 'html', html, baseUrl, maxChars } → the readable text of
// the page; { kind: 'bing', html, max } → the results of a Bing results page. The two functions are also
// exported (when this file is loaded on the main thread, as the checks do). No dependencies.
'use strict';

const { isMainThread, parentPort, workerData } = require('node:worker_threads');

/* ───────────── entities ───────────── */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', laquo: '«', raquo: '»', middot: '·', bull: '•',
  deg: '°', plusmn: '±', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', larr: '←', rarr: '→', uarr: '↑',
  darr: '↓', hearts: '♥', check: '✓', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', iexcl: '¡', iquest: '¿',
};

function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,9});/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      if (!(n > 0 && n <= 0x10ffff) || (n >= 0xd800 && n <= 0xdfff)) return ' ';
      return String.fromCodePoint(n);
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/* ───────────── HTML → text ───────────── */

const SKIP_WITH_CONTENT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'object', 'embed', 'math', 'select', 'datalist']);
const BREAK2 = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'figure', 'fieldset']);
const BREAK1 = new Set([
  'div', 'li', 'ul', 'ol', 'dl', 'dd', 'dt', 'tr', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'form', 'figcaption', 'caption',
  'address', 'summary', 'details', 'dialog', 'center', 'body', 'thead', 'tbody', 'tfoot', 'option', 'legend',
]);
const HREF_RE = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const ALT_RE = /(?:^|\s)alt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const attr = (re, raw) => { const m = re.exec(raw.length > 4000 ? raw.slice(0, 4000) : raw); return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : ''; };
const isNameChar = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;
const isLetter = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);

/** The tag that starts at html[lt] === '<': { name, closing, raw (attributes), end (index after '>') }. Quotes are honoured for a while, then not. */
function readTag(html, lt) {
  let i = lt + 1;
  let closing = false;
  if (html.charCodeAt(i) === 47) { closing = true; i += 1; }
  const nameStart = i;
  while (i < html.length && isNameChar(html.charCodeAt(i))) i += 1;
  const name = html.slice(nameStart, i).toLowerCase();
  const cap = Math.min(html.length, i + 2000);
  let j = i;
  let quote = 0;
  for (; j < cap; j++) {
    const c = html.charCodeAt(j);
    if (quote) { if (c === quote) quote = 0; } else if (c === 34 || c === 39) quote = c; else if (c === 62) break;
  }
  if (j >= cap) {
    j = html.indexOf('>', i);
    if (j < 0) j = html.length;
  }
  return { name, closing, raw: html.slice(i, j), end: Math.min(html.length, j + 1) };
}

function resolveHref(href, base) {
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(javascript|mailto|tel|data|blob|about):/i.test(h)) return '';
  try {
    const u = new URL(h, base || undefined);
    return /^https?:$/.test(u.protocol) && u.href.length <= 300 ? u.href : '';
  } catch { return ''; }
}

/**
 * The readable text of an HTML page: block elements become lines, headings get #, list items -, table cells are
 * separated by |, links become [text](address), scripts and styles are gone. → { title, text, truncated }.
 * Stops reading a little after `maxChars` of text.
 */
function htmlToText(html, { baseUrl = '', maxChars = 20000 } = {}) {
  const src = String(html);
  const limit = maxChars + 2000;
  const out = [];
  let len = 0;
  let want = 0; // line breaks owed before the next text
  let lastSpace = true; // the text so far ends in white space (or is empty)
  let pre = 0;
  let cell = 0;
  let title = '';
  let truncated = false;
  let anchor = null; // { href, at }

  const push = (s) => { if (s) { out.push(s); len += s.length; } };
  const emit = (s) => {
    if (!s) return;
    if (want > 0 && len > 0) push('\n'.repeat(want));
    want = 0;
    push(s);
    lastSpace = /\s$/.test(s);
  };
  const breakBefore = (n) => { if (n > want) want = n; };
  const text = (raw) => {
    let s = decodeEntities(raw);
    if (pre) { emit(s.replace(/\r\n?/g, '\n')); return; }
    s = s.replace(/\s+/g, ' ');
    if (s[0] === ' ' && (lastSpace || want > 0 || len === 0)) s = s.slice(1);
    emit(s);
  };
  const closeAnchor = () => {
    if (!anchor) return;
    const a = anchor;
    anchor = null;
    const seg = out.splice(a.at).join('');
    len -= seg.length;
    const label = seg.replace(/\s+/g, ' ').trim();
    if (!label) { push(seg); return; }
    const lead = /^\s*/.exec(seg)[0]; // the line breaks and spaces that came before the text stay where they were
    const trail = /\s*$/.exec(seg)[0];
    push(`${lead}[${label}](${a.href})${trail}`);
    lastSpace = trail.length > 0;
  };

  let i = 0;
  while (i < src.length) {
    if (len > limit) { truncated = true; break; }
    const lt = src.indexOf('<', i);
    if (lt < 0) { text(src.slice(i)); break; }
    if (lt > i) text(src.slice(i, lt));
    const next = src.charCodeAt(lt + 1);
    if (next === 33) { // <!-- comment -->, <!DOCTYPE>, <![CDATA[ ]]>
      if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? src.length : e + 3; } else { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; }
      continue;
    }
    if (next === 63) { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue; } // <?xml ?>
    if (!(isLetter(next) || (next === 47 && isLetter(src.charCodeAt(lt + 2))))) { text('<'); i = lt + 1; continue; }

    const tag = readTag(src, lt);
    i = tag.end;
    const { name } = tag;
    if (tag.closing) {
      if (name === 'a') closeAnchor();
      else if (name === 'pre') { pre = Math.max(0, pre - 1); breakBefore(2); } else if (/^h[1-6]$/.test(name) || BREAK2.has(name)) breakBefore(2);
      else if (BREAK1.has(name)) breakBefore(1);
      continue;
    }
    if (name === 'title') { // its text is the page title and nothing else
      const m = /<\/title\s*>/gi;
      m.lastIndex = i;
      const e = m.exec(src);
      if (!title) title = decodeEntities(src.slice(i, e ? e.index : Math.min(src.length, i + 500))).replace(/\s+/g, ' ').trim().slice(0, 200);
      i = e ? e.index + e[0].length : src.length;
      continue;
    }
    if (SKIP_WITH_CONTENT.has(name)) {
      const m = new RegExp(`</${name}[\\s/>]`, 'gi');
      m.lastIndex = i;
      const e = m.exec(src);
      if (!e) { i = src.length; break; }
      const close = src.indexOf('>', e.index);
      i = close < 0 ? src.length : close + 1;
      continue;
    }
    if (name === 'br') { want = Math.min(2, want + 1); continue; }
    if (name === 'hr') { breakBefore(1); emit('---'); breakBefore(1); continue; }
    if (name === 'a') {
      closeAnchor();
      const href = resolveHref(attr(HREF_RE, tag.raw), baseUrl);
      if (href) anchor = { href, at: out.length };
      continue;
    }
    if (name === 'img') {
      const alt = attr(ALT_RE, tag.raw).replace(/\s+/g, ' ').trim();
      if (alt.length >= 2) emit(`[图片：${alt.slice(0, 100)}]`);
      continue;
    }
    if (/^h[1-6]$/.test(name)) { breakBefore(2); emit(`${'#'.repeat(Number(name[1]))} `); continue; }
    if (name === 'li') { breakBefore(1); emit('- '); continue; }
    if (name === 'pre') { breakBefore(2); pre += 1; continue; }
    if (name === 'tr') { breakBefore(1); cell = 0; continue; }
    if (name === 'td' || name === 'th') { if (cell > 0) emit(' | '); cell += 1; continue; }
    if (name === 'table') cell = 0;
    if (BREAK2.has(name)) breakBefore(2);
    else if (BREAK1.has(name)) breakBefore(1);
  }
  closeAnchor();
  let body = out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    if (/[\ud800-\udbff]$/.test(body)) body = body.slice(0, -1); // not in the middle of an emoji
    truncated = true;
  }
  return { title, text: body, truncated };
}

/* ───────────── Bing results ───────────── */

const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** A link on a Bing results page → the address it leads to. Bing wraps results as bing.com/ck/a?…&u=a1<base64 of the address>. */
function unwrapBing(href) {
  let u;
  try { u = new URL(decodeEntities(href), 'https://www.bing.com/'); } catch { return ''; }
  if (!/^https?:$/.test(u.protocol)) return '';
  if (/(^|\.)bing\.com$/i.test(u.hostname)) {
    const enc = u.pathname.startsWith('/ck/a') ? u.searchParams.get('u') : null;
    if (enc && enc.startsWith('a1')) {
      try {
        const real = Buffer.from(enc.slice(2), 'base64').toString('utf8');
        if (/^https?:\/\/[^\s]+$/i.test(real)) return real;
      } catch { /* not base64 */ }
    }
    return '';
  }
  return u.href;
}

/** A Bing results page → [{ title, url, snippet }] (at most `max`). Empty when the page has no results this can read. */
function parseBing(html, max = 8) {
  const src = String(html);
  const starts = [];
  const re = /<li\b[^>]*\bclass\s*=\s*"[^"]*\bb_algo\b[^"]*"[^>]*>/gi;
  for (let m = re.exec(src); m && starts.length < 40; m = re.exec(src)) starts.push(m.index + m[0].length);
  const results = [];
  const seen = new Set();
  for (let k = 0; k < starts.length && results.length < max; k++) {
    const seg = src.slice(starts[k], Math.min(starts[k + 1] === undefined ? src.length : starts[k + 1], starts[k] + 20000));
    const h = /<h2\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(seg);
    if (!h) continue;
    const url = unwrapBing(attr(HREF_RE, h[1]));
    const title = stripTags(h[2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    const after = seg.slice(h.index + h[0].length);
    const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(after);
    results.push({ title: title.slice(0, 200), url, snippet: p ? stripTags(p[1]).slice(0, 400) : '' });
  }
  return results;
}

/* ───────────── worker entry ───────────── */

if (!isMainThread && parentPort && workerData && typeof workerData === 'object') {
  try {
    if (workerData.kind === 'html') parentPort.postMessage({ ok: true, ...htmlToText(workerData.html, workerData) });
    else if (workerData.kind === 'bing') parentPort.postMessage({ ok: true, results: parseBing(workerData.html, workerData.max) });
    else parentPort.postMessage({ ok: false, error: 'unknown job' });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e && e.message || e) });
  }
}

module.exports = { htmlToText, parseBing, unwrapBing, decodeEntities };
