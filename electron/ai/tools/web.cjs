// web_fetch and web_search for the API tools, run by the app itself in the main process.
// Fetching is built so that the model cannot use it to reach this computer or the local network:
//  - only http / https, no user:pass@, no single-label names (http://nas/), no local / private / reserved addresses
//    (the browser's isPrivateHost, which also reads the IPv6 forms that carry an IPv4 address);
//  - its own in-memory session ("firefly-fetch": no cookies, no logins, nothing shared with the 萤火浏览器);
//  - redirects are never followed by the network stack: every one is checked here, as a new request, up to 5;
//  - the name is looked up on this computer too, proxy or not, and every address it has is checked (net.BlockList;
//    198.18.0.0/15 is allowed, it is what a proxy's fake-ip mode hands out). With no proxy a name that cannot be looked
//    up is refused; with a proxy (which may know names this computer's DNS does not) a failed or slow lookup counts for
//    nothing, and only an answer that is local or private refuses. Names made to point at 127.0.0.1 or the LAN on
//    request (nip.io, sslip.io, localtest.me…) are refused by their suffix;
//  - 30 seconds in all, 3 MB of body counted after decompression, text-like content types only.
// What is left: the name is looked up here and again by the network stack (or the proxy) when it connects, so a DNS
// server that answers differently the second time (DNS rebinding) can still get through; with a proxy that has its own
// DNS (fake-ip, TUN) the answer here says nothing about where the proxy connects. Electron is loaded when it is first
// needed, so that a plain Node check can load this file; what a check replaces is in _internals.
'use strict';

const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const PARTITION = 'firefly-fetch'; // no "persist:" in front: kept in memory only
// Read at the time of use, so that a check can shorten them.
const LIMITS = {
  MAX_BYTES: 3 * 1024 * 1024, // of the body after decompression
  MAX_REDIRECTS: 5,
  TIMEOUT_MS: 30000,
  TEXT_CHARS: 20000,
  WORKER_MS: 5000,
  LOOKUP_MS: 3000, // how long a lookup that is allowed to fail (a proxy is in the way) is waited for
};
const DISPLAY_CHARS = 6000;
const RESULTS = 8;
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.1';

/* ───────────── what the model may ask for ───────────── */

let browserApi = null;
/** The browser module's address rules (loaded the first time they are needed). */
function browser() {
  if (!browserApi) browserApi = _internals.browser();
  return browserApi;
}

// Services that answer any name under them with the address written in the name (127.0.0.1.nip.io): a public-looking name for a local address.
const REBINDING = ['nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me'];

/** Why this address is refused, or null when it may be fetched. Looks at the address only; names are looked up later. */
function checkUrl(url) {
  if (typeof url !== 'string') return '网址必须是文字。';
  const text = url.trim();
  if (!text) return '网址是空的。';
  if (text.length > 4000) return '网址太长。';
  let u;
  try { u = new URL(text); } catch { return `不是有效的网址：${text.slice(0, 120)}`; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '只能访问 http:// 或 https:// 开头的网址。';
  if (u.username || u.password) return '不能访问带账号密码的网址（user:pass@）。';
  const host = u.hostname;
  if (!host) return '网址里没有主机名。';
  let privateHost;
  try { privateHost = browser().isPrivateHost(host); } catch (e) { return `内部错误：无法检查网址（${e.message}）。`; }
  if (privateHost) {
    if (!host.includes('.') && !host.includes(':') && host !== 'localhost') return `不能访问没有点的主机名（局域网设备名）：${host}`;
    return `不能访问本机或内网地址：${host}`;
  }
  const bare = host.replace(/\.$/, '').toLowerCase();
  const rebinding = REBINDING.find((suffix) => bare === suffix || bare.endsWith(`.${suffix}`));
  if (rebinding) return `不能访问 ${rebinding} 这类可以把名字指到本机或内网的域名：${host}`;
  return null;
}

/** { ok: true, href, host } with the address as the network would see it (new URL().href), or { ok: false, error }. */
function inspectUrl(url) {
  const error = checkUrl(url);
  if (error) return { ok: false, error };
  const u = new URL(url.trim());
  return { ok: true, href: u.href, host: u.hostname };
}

/* ───────────── addresses a name turned into ───────────── */

let lists = null;
function blockLists() {
  if (lists) return lists;
  const v4 = new net.BlockList();
  for (const [a, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
    ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3], // multicast, reserved, broadcast
    // 198.18.0.0/15 is left out on purpose: fake-ip proxies answer every name from there
  ]) v4.addSubnet(a, bits, 'ipv4');
  const v6 = new net.BlockList();
  v6.addAddress('::', 'ipv6');
  v6.addAddress('::1', 'ipv6');
  for (const [a, bits] of [['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) v6.addSubnet(a, bits, 'ipv6');
  lists = { v4, v6 };
  return lists;
}

/** The IPv4 address an IPv6 one carries (mapped, compatible, NAT64, 6to4), as text, or null. */
function embeddedV4(g) {
  const dotted = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return dotted(g[6], g[7]); // ::ffff:0:0/96
  if (zeros(0, 6)) return dotted(g[6], g[7]); // ::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return dotted(g[6], g[7]); // 64:ff9b::/96
  if (g[0] === 0x2002) return dotted(g[1], g[2]); // 2002::/16
  return null;
}

/** Whether this address (a lookup result) must not be connected to. Anything that is not an address is refused. */
function addressBlocked(address) {
  const a = String(address || '').replace(/%.*$/, '');
  try {
    const kind = net.isIP(a);
    if (kind === 4) return blockLists().v4.check(a, 'ipv4');
    if (kind === 6) {
      const groups = browser().ipv6Groups(a);
      if (!groups) return true;
      const v4 = embeddedV4(groups);
      return v4 ? blockLists().v4.check(v4, 'ipv4') : blockLists().v6.check(a, 'ipv6');
    }
  } catch { /* fall through */ }
  return true;
}

/* ───────────── one request ───────────── */

const stopError = () => Object.assign(new Error('已停止'), { code: 'STOPPED' });

/** `promise`, but rejected as soon as `signal` aborts. */
function until(signal, promise) {
  if (signal.aborted) return Promise.reject(stopError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(stopError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

const hardened = new WeakSet();
/** The session every fetch goes through. Requests to a refused address are also cancelled there, as a second line. */
function fetchSession() {
  const ses = _internals.electron().session.fromPartition(PARTITION);
  if (!hardened.has(ses)) {
    hardened.add(ses);
    try { ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !!checkUrl(details.url) })); } catch { /* the request is checked before it is made anyway */ }
  }
  return ses;
}

function userAgent() {
  const chrome = process.versions.chrome || '130.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

const mediaType = (value) => String(Array.isArray(value) ? value[0] : value || '').split(';')[0].trim().toLowerCase();
/** text/*, JSON, XML and XHTML (and the +json / +xml kinds: RSS, Atom, JSON-LD…). */
const readableType = (t) => t.startsWith('text/') || t === 'application/json' || t === 'application/xml' || t === 'application/xhtml+xml'
  || /^application\/[\w.-]+\+(json|xml)$/.test(t);

/**
 * One GET. The network stack never follows a redirect (redirect: 'manual', and the request is not told to):
 * → { kind: 'redirect', status, url } | { kind: 'response', status, statusText, type, contentType, body, truncated, unreadable }.
 * `unreadable`: the content type is not one we read; the body is not downloaded.
 */
function requestOnce(url, signal) {
  return new Promise((resolve, reject) => {
    let req;
    let settled = false;
    let onAbort = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (onAbort) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    try {
      req = _internals.electron().net.request({ method: 'GET', url, session: fetchSession(), redirect: 'manual', credentials: 'omit', useSessionCookies: false });
    } catch (e) { reject(e); return; }
    onAbort = () => { try { req.abort(); } catch { /* already over */ } finish(reject, stopError()); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    req.setHeader('User-Agent', userAgent());
    req.setHeader('Accept', ACCEPT);
    req.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
    req.on('login', (_info, callback) => callback()); // never answer a password prompt
    // A redirect not followed ends the request with an error of its own: it comes after finish(), and is ignored.
    req.on('redirect', (status, _method, redirectUrl) => finish(resolve, { kind: 'redirect', status, url: String(redirectUrl) }));
    req.on('error', (e) => finish(reject, e));
    req.on('response', (res) => {
      if (settled) return;
      const contentType = Array.isArray(res.headers['content-type']) ? res.headers['content-type'][0] : String(res.headers['content-type'] || '');
      const base = { kind: 'response', status: res.statusCode, statusText: res.statusMessage || '', type: mediaType(contentType), contentType };
      if (!readableType(base.type)) {
        try { req.abort(); } catch { /* already over */ }
        finish(resolve, { ...base, body: Buffer.alloc(0), truncated: false, unreadable: true });
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        if (settled) return;
        total += chunk.length; // already decompressed: what counts is what the page really holds
        if (total > LIMITS.MAX_BYTES) {
          const keep = chunk.length - (total - LIMITS.MAX_BYTES);
          if (keep > 0) chunks.push(chunk.subarray(0, keep));
          try { req.abort(); } catch { /* already over */ }
          finish(resolve, { ...base, body: Buffer.concat(chunks), truncated: true });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(resolve, { ...base, body: Buffer.concat(chunks), truncated: false }));
      res.on('error', (e) => finish(reject, e));
      res.on('aborted', () => finish(reject, new Error('net::ERR_CONNECTION_ABORTED')));
    });
    req.end();
  });
}

/** The name looked up on this computer: { found } with every address it has, or { failed: true } (no answer, or none within `ms`;
 *  0 waits as long as it takes). A stop is thrown (code STOPPED). */
async function lookupHost(host, signal, ms) {
  let timer = null;
  try {
    const answer = Promise.resolve().then(() => _internals.lookup(host, { all: true }));
    answer.catch(() => {}); // a lookup that fails after its time is over is nobody's error
    const limit = ms ? new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }) : null;
    const found = await until(signal, limit ? Promise.race([answer, limit]) : answer);
    return Array.isArray(found) ? { found } : { failed: true };
  } catch (e) {
    if (e && e.code === 'STOPPED') throw e;
    return { failed: true };
  } finally { clearTimeout(timer); }
}

const pointsLocal = (host, address) => `${host} 指向本机或内网地址（${address}，按本机的域名解析），已拒绝。`;

/**
 * Before a request, proxy or not: the name is looked up here and every address must be fine. → reason or null.
 * A name that cannot be looked up is refused when this computer connects itself, and let through (the proxy may
 * know it) when a proxy does; an answer that is local or private is refused either way.
 */
async function checkResolved(url, signal) {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return null; // an address as written: checkUrl has judged it
  let proxy = 'DIRECT';
  try { proxy = String(await until(signal, fetchSession().resolveProxy(url))); } catch (e) { if (e && e.code === 'STOPPED') throw e; }
  const direct = !proxy.trim() || proxy.split(';').some((entry) => entry.trim().toUpperCase() === 'DIRECT');
  const r = await lookupHost(host, signal, direct ? 0 : LIMITS.LOOKUP_MS);
  if (r.failed) return direct ? `找不到这个主机：${host}` : null;
  const bad = r.found.find((entry) => addressBlocked(entry.address));
  return bad ? pointsLocal(host, bad.address) : null;
}

/**
 * For a name something else is about to open (the browser tool): the reason when it is looked up here to a local or
 * private address, else null. No answer in time counts for nothing: the page load reports a name that is not there itself.
 */
async function checkNameLocal(host, signal = new AbortController().signal) {
  const name = String(host || '').replace(/^\[|\]$/g, '');
  if (!name || net.isIP(name)) return null; // an address as written is judged by its text
  const r = await lookupHost(name, signal, LIMITS.LOOKUP_MS);
  const bad = r.found && r.found.find((entry) => addressBlocked(entry.address));
  return bad ? pointsLocal(name, bad.address) : null;
}

const NET_ERRORS = [
  [/ERR_NAME_NOT_RESOLVED|ENOTFOUND/, '找不到这个主机（域名解析失败）。'],
  [/ERR_CONNECTION_REFUSED/, '对方拒绝了连接。'],
  [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/, '连接超时。'],
  [/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE/, '连接被中断。'],
  [/ERR_CERT_|ERR_SSL_|ERR_BAD_SSL/, '对方的 HTTPS 证书不被信任，已拒绝。'],
  [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/, '没有网络连接。'],
  [/ERR_TOO_MANY_REDIRECTS/, '重定向次数太多。'],
  [/ERR_BLOCKED_BY_CLIENT/, '这个地址被萤火的安全规则拦下了。'],
];
const netError = (e) => {
  const message = String(e && e.message || e);
  const known = NET_ERRORS.find(([re]) => re.test(message));
  return known ? known[1] : `请求失败：${message.slice(0, 200)}`;
};

/**
 * Fetch an address and follow its redirects, one checked request at a time.
 * `allowHost(hostname)`: a further limit on where it may go (search stays on Bing).
 * → { ok: true, href, requested, status, type, body, truncated, ... } | { ok: false, error, stopped? }
 */
async function fetchChecked(url, { signal, allowHost } = {}) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, LIMITS.TIMEOUT_MS);
  const onStop = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onStop, { once: true }); }
  try {
    const requested = new URL(url.trim()).href;
    let current = requested;
    for (let hop = 0; ; hop++) {
      const where = hop ? '重定向到了不允许的地址：' : '';
      const bad = checkUrl(current) || (allowHost && !allowHost(new URL(current).hostname) ? `不在允许访问的网站范围内：${new URL(current).hostname}` : null);
      if (bad) return { ok: false, error: `${where}${bad}` };
      const unresolved = await checkResolved(current, ac.signal);
      if (unresolved) return { ok: false, error: `${where}${unresolved}` };
      const r = await requestOnce(current, ac.signal);
      if (r.kind === 'redirect') {
        if (hop >= LIMITS.MAX_REDIRECTS) return { ok: false, error: `重定向超过 ${LIMITS.MAX_REDIRECTS} 次，已放弃。` };
        try { current = new URL(r.url, current).href; } catch { return { ok: false, error: '重定向的地址无效。' }; }
        continue;
      }
      return { ok: true, href: current, requested, ...r };
    }
  } catch (e) {
    if (signal && signal.aborted) return { ok: false, stopped: true, error: '已停止。' };
    if (timedOut) return { ok: false, error: `网页超过 ${LIMITS.TIMEOUT_MS / 1000} 秒没有响应，已放弃。` };
    return { ok: false, error: netError(e) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onStop);
  }
}

/* ───────────── reading the body ───────────── */

/** The page's bytes → text, in the charset it declares (header, then <meta> / <?xml?>), UTF-8 otherwise, GB18030 if that is not UTF-8. */
function decodeBody(buf, contentType) {
  let label = (/charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || '') || [])[1] || '';
  if (!label && /html|xml/i.test(contentType || '')) {
    const head = buf.subarray(0, 2048).toString('latin1');
    label = (/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head) || /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head) || [])[1] || '';
  }
  if (label) { try { return new TextDecoder(label.toLowerCase()).decode(buf); } catch { /* an encoding this build does not know */ } }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('gb18030').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

let workerSource = null;
// The worker is started from its source text, not from the file: a worker thread cannot count on loading a file from inside app.asar.
function workerCode() {
  if (workerSource === null) workerSource = fs.readFileSync(path.join(__dirname, 'html-worker.cjs'), 'utf8');
  return workerSource;
}

/** One job for html-worker.cjs, on a worker thread that is ended after `ms`. */
function runWorker(job, signal, ms = LIMITS.WORKER_MS) {
  return new Promise((resolve, reject) => {
    const { Worker } = require('node:worker_threads');
    let worker;
    let done = false;
    let timer = null;
    let onAbort = null;
    const end = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      try { worker.terminate(); } catch { /* already gone */ }
      fn(value);
    };
    try {
      worker = new Worker(workerCode(), { eval: true, workerData: job, resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 } });
    } catch (e) { reject(e); return; }
    timer = setTimeout(() => end(reject, Object.assign(new Error('worker timeout'), { code: 'WORKER_TIMEOUT' })), ms);
    if (signal) { onAbort = () => end(reject, stopError()); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    worker.once('message', (m) => end(resolve, m));
    worker.once('error', (e) => end(reject, e));
    worker.once('exit', (code) => end(reject, new Error(`worker exited (${code})`)));
  });
}

const fail = (message, extra) => ({ ok: false, output: message, display: message, ...extra });
const clipDisplay = (s) => (s.length > DISPLAY_CHARS ? `${s.slice(0, DISPLAY_CHARS - 20)}\n…（卡片里只显示开头）` : s);

/** What a worker failure means for the model. */
function workerError(e, what) {
  if (e && e.code === 'STOPPED') return fail('已停止。', { stopped: true });
  if (e && e.code === 'WORKER_TIMEOUT') return fail(`${what}太复杂，处理超过 ${LIMITS.WORKER_MS / 1000} 秒，已放弃。`);
  return fail(`${what}处理失败：${String(e && e.message || e).slice(0, 200)}`);
}

/* ───────────── web_fetch ───────────── */

/** Fetch a page and give back its text: `url` → { ok, output, display } (+ stopped: true when `signal` ended it). */
async function fetchPage(url, signal) {
  const bad = checkUrl(url);
  if (bad) return fail(bad);
  let r;
  try { r = await fetchChecked(url, { signal }); } catch (e) { return fail(`网络功能不可用：${String(e && e.message || e).slice(0, 200)}`); }
  if (!r.ok) return fail(r.error, r.stopped ? { stopped: true } : undefined);
  const status = `${r.status}${r.statusText ? ` ${r.statusText}` : ''}`;
  const where = r.href === r.requested ? r.href : `${r.href}（由 ${r.requested} 跳转而来）`;
  if (r.unreadable) return fail(`网址：${where}\n状态：${status}\n${r.type ? `这个地址返回的内容类型是 ${r.type}，萤火只读取网页、文本、JSON 和 XML。` : '这个地址没有返回可读的内容。'}`);
  const raw = decodeBody(r.body, r.contentType);
  let title = '';
  let text;
  let tooLong = r.truncated;
  if (r.type === 'text/html' || r.type === 'application/xhtml+xml') {
    let parsed;
    try { parsed = await _internals.runWorker({ kind: 'html', html: raw, baseUrl: r.href, maxChars: LIMITS.TEXT_CHARS }, signal); } catch (e) { return workerError(e, '网页'); }
    if (!parsed || parsed.ok === false) return fail(`网页处理失败：${parsed && parsed.error || '未知错误'}`);
    ({ title, text } = parsed);
    tooLong = tooLong || !!parsed.truncated;
  } else {
    text = raw.replace(/\r\n/g, '\n').trim();
  }
  if (text.length > LIMITS.TEXT_CHARS) {
    text = text.slice(0, LIMITS.TEXT_CHARS);
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1); // not in the middle of an emoji
    tooLong = true;
  }
  const lines = [`网址：${where}`, `状态：${status}`];
  if (title) lines.push(`标题：${title}`);
  if (r.truncated) lines.push('（网页超过 3 MB，只读取了开头。）');
  const head = lines.join('\n');
  if (r.status < 200 || r.status >= 300) {
    const output = `${head}\n${text ? `\n${text.slice(0, 2000)}` : ''}`.trimEnd();
    return fail(output);
  }
  const output = `${head}\n\n${text || '（页面没有可读的文字）'}${tooLong ? `\n\n…（内容太长，只显示前 ${LIMITS.TEXT_CHARS} 字）` : ''}`;
  return { ok: true, output, display: clipDisplay(output) };
}

/* ───────────── web_search ───────────── */

const onBing = (host) => host === 'bing.com' || host.endsWith('.bing.com');

/** Search with Bing: `query` → { ok, output, display } with up to 8 titles, addresses and snippets. */
async function search(query, signal) {
  if (typeof query !== 'string') return fail('搜索词必须是文字。');
  const q = query.replace(/\s+/g, ' ').trim();
  if (!q) return fail('搜索词是空的。');
  if (q.length > 500) return fail('搜索词太长（最多 500 字）。');
  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
  let r;
  try { r = await fetchChecked(url, { signal, allowHost: onBing }); } catch (e) { return fail(`网络功能不可用：${String(e && e.message || e).slice(0, 200)}`); }
  if (!r.ok) return fail(`搜索失败：${r.error}`, r.stopped ? { stopped: true } : undefined);
  const noResults = `没有从必应的页面里解析出搜索结果（可能是页面改版、需要验证，或者确实没有结果）。可以用 browser_navigate 打开 ${url} 直接查看。`;
  if (r.unreadable || r.status < 200 || r.status >= 300) return fail(`搜索失败：必应返回了 ${r.status}。${noResults}`);
  let parsed;
  try { parsed = await _internals.runWorker({ kind: 'bing', html: decodeBody(r.body, r.contentType), max: RESULTS }, signal); } catch (e) { return workerError(e, '搜索结果页'); }
  const results = parsed && parsed.ok !== false && Array.isArray(parsed.results) ? parsed.results : [];
  if (!results.length) return fail(noResults);
  const rows = results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}${x.snippet ? `\n   ${x.snippet}` : ''}`);
  const output = `必应搜索「${q}」的前 ${results.length} 条结果：\n\n${rows.join('\n\n')}`;
  return { ok: true, output, display: clipDisplay(output) };
}

// Swapped by checks: Electron's net and session, the name lookup, the worker, the module with the address rules.
const _internals = {
  electron: () => require('electron'),
  lookup: (host, options) => dns.promises.lookup(host, options),
  runWorker,
  browser: () => require('../browser.cjs'),
  addressBlocked,
  embeddedV4,
  decodeBody,
  limits: LIMITS,
};

module.exports = { fetchPage, search, checkUrl, inspectUrl, checkNameLocal, _internals };
