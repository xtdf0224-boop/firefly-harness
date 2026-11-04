// 萤火浏览器: a separate window the agents can drive (open a page, read it, click, type, scroll,
// screenshot). Its own session partition keeps cookies apart from the app; the user can log in to
// sites there and watch or take over at any time. CLI agents reach it through browser-mcp.cjs (an
// MCP stdio server they spawn), which calls back here over 127.0.0.1 with a random token.
// The window is two views: a toolbar (browser-ui/bar.html: back, forward, reload, home, address bar)
// and the page itself, which starts on browser-ui/start.html.
// Outside Electron (a check script run by plain Node) `require('electron')` is only a path, or fails: nothing of it is
// used then, and the address rules below still work.
const electron = (() => { try { const e = require('electron'); return e && typeof e === 'object' ? e : {}; } catch { return {}; } })();
const { app, BaseWindow, WebContentsView, ipcMain, session } = electron;
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const PARTITION = 'persist:firefly-browser';
const UI = path.join(__dirname, 'browser-ui');
const START = path.join(UI, 'start.html');
const BAR_HEIGHT = 48;
let win = null;   // BaseWindow
let bar = null;   // WebContentsView: toolbar
let page = null;  // WebContentsView: the web page agents drive
/** What the toolbar shows besides the page state: a message (blocked address…) and the agent's current action. */
const note = { message: '', agent: '' };
let server = null;
let endpoint = null; // { url, token }
let queue = Promise.resolve();

/** An IPv4 address (first two numbers) in a range an agent must not reach. */
const privateV4 = (a, b) => a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
  || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;

/** The eight 16-bit groups of an IPv6 literal (brackets already off), or null when it is not one. A dotted
 *  IPv4 tail (::ffff:1.2.3.4) and a zone id (fe80::1%eth0) are understood; `::` and leading zeros too. */
function ipv6Groups(host) {
  let s = String(host || '').replace(/%.*$/, '');
  if (!s.includes(':') || !/^[0-9a-f:.]+$/i.test(s)) return null;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) return null;
    s = `${s.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const rest = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + rest.length > 7) return null;
  const all = halves.length === 1 ? head : [...head, ...Array(8 - head.length - rest.length).fill('0'), ...rest];
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return groups.some(Number.isNaN) ? null : groups;
}

/** An IPv6 address (eight groups) that is local, private, reserved, or carries one of those IPv4 addresses. */
function privateV6(g) {
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::/96: unspecified, loopback, IPv4-compatible (::7f00:1 is 127.0.0.1)
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return true; // ::ffff:0:0/96, IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4(g[6] >> 8, g[6] & 255); // 64:ff9b::/96, NAT64
  if (g[0] === 0x2002) return privateV4(g[1] >> 8, g[1] & 255); // 2002::/16, 6to4: the IPv4 address follows the prefix
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00; // unique-local, link-local, site-local, multicast
}

/** Loopback, private, link-local and similar hosts: the agent's browser never reaches them. A name with no
 *  dot (http://nas/) is a device on the local network, so it counts too. */
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal') return true;
  const v4 = h.replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return privateV4(Number(v4[1]), Number(v4[2]));
  if (h.includes(':')) {
    if (h === '::' || h === '::1' || h.startsWith('::ffff:') || /^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
    const groups = ipv6Groups(h);
    return !groups || privateV6(groups); // not an address at all: never let it through
  }
  // Bare numbers (http://2130706433/) are IPv4 too.
  return /^(0x[0-9a-f]+|\d+)$/.test(h) || !h.includes('.');
}

function blockedUrl(url) {
  try {
    const u = new URL(url);
    return /^(https?|wss?):$/.test(u.protocol) && isPrivateHost(u.hostname);
  } catch { return false; }
}

const PRIVATE_NOTE = '为了安全，萤火浏览器不会打开本机或内网地址（localhost、127.0.0.1、192.168.x.x、不带点的主机名等）。';

/** Why an address an agent asked to open must not be opened, or null: written as a local address (blockedUrl), or a name
 *  that this computer looks up to one (127.0.0.1.nip.io, localtest.me). Links, redirects and what a page loads are
 *  judged by their text only (they cannot wait for a lookup). A lookup that fails or is slow counts for nothing. */
async function navigationBlock(url) {
  if (blockedUrl(url)) return PRIVATE_NOTE;
  try { return await require('./tools/web.cjs').checkNameLocal(new URL(url).hostname); } catch { return null; }
}

function hardenSession() {
  const ses = session.fromPartition(PARTITION);
  if (ses.__fireflyHardened) return ses;
  ses.__fireflyHardened = true;
  // A web page (or a redirect) must not be able to reach services on this computer or the LAN.
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: blockedUrl(details.url) }));
  // No camera, microphone, location, notifications… for pages the agent opens.
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // No downloads: an agent should not be able to drop files on the disk through the browser.
  ses.on('will-download', (e) => e.preventDefault());
  return ses;
}

const alive = (view) => !!view && !view.webContents.isDestroyed();
/** The page agents drive (null when the window is closed). */
const pageContents = () => (alive(page) ? page.webContents : null);

function layout() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  bar.setBounds({ x: 0, y: 0, width, height: BAR_HEIGHT });
  page.setBounds({ x: 0, y: BAR_HEIGHT, width, height: Math.max(0, height - BAR_HEIGHT) });
}

/** Push the page's state to the toolbar. The start page shows an empty address bar. */
function sendState() {
  if (!alive(bar)) return;
  const wc = pageContents();
  const url = wc ? wc.getURL() : '';
  bar.webContents.send('ffbar:state', {
    url: /^https?:/i.test(url) ? url : '',
    canGoBack: !!wc && wc.navigationHistory.canGoBack(),
    canGoForward: !!wc && wc.navigationHistory.canGoForward(),
    loading: !!wc && wc.isLoading(),
    message: note.message,
    agent: note.agent,
  });
}

function setNote(key, text) {
  note[key] = text;
  sendState();
}

/** Address-bar text → URL: a web address as typed (https:// added), anything else becomes a search. */
function toUrl(text) {
  const t = String(text || '').trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (!/\s/.test(t) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/.test(t)) return `https://${t}`;
  if (/^localhost(:\d+)?([/?#]|$)/i.test(t)) return `http://${t}`;
  return `https://cn.bing.com/search?q=${encodeURIComponent(t)}`;
}

function go(url) {
  const wc = pageContents();
  if (!wc) return;
  if (blockedUrl(url)) { setNote('message', PRIVATE_NOTE); return; }
  setNote('message', '');
  wc.loadURL(url).catch((e) => { if (!/ERR_ABORTED/.test(String(e.message))) setNote('message', `打不开这个网址：${e.message}`); });
}

function goHome() {
  const wc = pageContents();
  if (!wc) return;
  setNote('message', '');
  wc.loadFile(START).catch(() => {});
}

// Toolbar commands. Only the toolbar of the current window may send them. (A check script loads this file in
// plain Node, where `require('electron')` is just a path and `ipcMain` / `app` are undefined: no wiring then.)
if (ipcMain) ipcMain.on('ffbar', (e, cmd, arg) => {
  if (!alive(bar) || e.sender !== bar.webContents) return;
  const wc = pageContents();
  if (!wc) return;
  if (cmd === 'navigate') go(toUrl(arg));
  else if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (cmd === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (cmd === 'reload') { setNote('message', ''); wc.reload(); }
  else if (cmd === 'home') goHome();
  else if (cmd === 'refresh') sendState();
  else if (cmd === 'focus-page') wc.focus();
});

function ensureWindow(show = true) {
  if (win && !win.isDestroyed()) {
    if (show && !win.isVisible()) win.showInactive();
    return win;
  }
  hardenSession();
  win = new BaseWindow({
    width: 1280,
    height: 900,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: '萤火浏览器',
    backgroundColor: '#080d18',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
  });
  win.removeMenu();
  bar = new WebContentsView({
    webPreferences: { preload: path.join(UI, 'bar-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  page = new WebContentsView({
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false },
  });
  bar.setBackgroundColor('#0b1221');
  page.setBackgroundColor('#ffffff');
  win.contentView.addChildView(page);
  win.contentView.addChildView(bar);
  layout();
  win.on('resize', layout);
  // The toolbar is our own page: it never navigates anywhere and opens nothing.
  bar.webContents.on('will-navigate', (e) => e.preventDefault());
  bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  bar.webContents.on('did-finish-load', sendState);
  bar.webContents.loadFile(path.join(UI, 'bar.html'));

  const wc = page.webContents;
  // Popups open in the same window; only web pages, never file:// or other schemes.
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) go(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!/^(https?:|about:blank)/i.test(url) || blockedUrl(url)) e.preventDefault(); });
  wc.on('will-redirect', (e, url) => { if (!/^https?:/i.test(url) || blockedUrl(url)) e.preventDefault(); });
  // alert()/confirm() would block the page (and every queued action) until someone clicks.
  wc.on('dom-ready', () => { wc.executeJavaScript('window.alert = () => {}; window.confirm = () => true; window.prompt = () => null;', true).catch(() => {}); });
  wc.on('page-title-updated', (e, t) => { e.preventDefault(); if (win && !win.isDestroyed()) win.setTitle(t ? `${t} — 萤火浏览器` : '萤火浏览器'); });
  for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page']) wc.on(ev, sendState);
  wc.on('did-navigate', () => setNote('message', ''));
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return; // -3: aborted (a newer navigation took over)
    setNote('message', /BLOCKED_BY_CLIENT/.test(desc) || blockedUrl(url) ? PRIVATE_NOTE : `打不开：${desc}`);
  });
  // Closing the window ends its pages too: nothing keeps playing or running in the background.
  const views = [bar.webContents, page.webContents];
  win.on('closed', () => {
    win = null; bar = null; page = null;
    for (const c of views) { try { if (!c.isDestroyed()) c.close(); } catch { /* already gone */ } }
  });
  // Ctrl+L / F6 / Alt+D in the page jump to the address bar, as in any browser.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = String(input.key).toLowerCase();
    if ((input.control && k === 'l') || k === 'f6' || (input.alt && k === 'd')) {
      e.preventDefault();
      if (alive(bar)) { bar.webContents.focus(); bar.webContents.send('ffbar:focus-url'); }
    }
  });
  wc.loadFile(START).catch(() => {});
  if (show) win.showInactive();
  return win;
}

/* ───────────── page helpers (run inside the page) ───────────── */

// Tags visible interactive elements with data-ff-ref and returns a compact outline of the page.
const SNAPSHOT_JS = `(() => {
  const EL_MAX = 4500;
  const TEXT_MAX = 6000;
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  // Passwords, card numbers and one-time codes never leave the page: no value, not even as a label.
  const secret = (el) => { const ty = (el.type || '').toLowerCase(); const ac = (el.getAttribute('autocomplete') || '').toLowerCase(); return ty === 'password' || /(^|\\s)(cc-|one-time-code|current-password|new-password)/.test(ac); };
  const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || (el.tagName === 'INPUT' ? '' : el.innerText) || (secret(el) ? '' : el.value) || el.getAttribute('alt') || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const roleOf = (el) => { const t = el.tagName.toLowerCase(); const r = el.getAttribute('role'); if (r) return r; if (t === 'a') return 'link'; if (t === 'button' || t === 'summary') return 'button'; if (t === 'select') return 'combobox'; if (t === 'textarea' || el.isContentEditable) return 'textbox'; if (t === 'input') { const ty = (el.type || 'text').toLowerCase(); return ty === 'checkbox' ? 'checkbox' : ty === 'radio' ? 'radio' : ['submit', 'button', 'reset'].includes(ty) ? 'button' : 'textbox'; } return 'clickable'; };
  document.querySelectorAll('[data-ff-ref]').forEach((el) => el.removeAttribute('data-ff-ref'));
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=option], [contenteditable=""], [contenteditable=true], [onclick]';
  // Elements in or nearest the viewport first, so scrolling brings new ones into reach.
  const found = [];
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    found.push({ el, dist: r.bottom < 0 ? -r.bottom : r.top > innerHeight ? r.top - innerHeight : 0 });
    if (found.length >= 2000) break;
  }
  found.sort((a, b) => a.dist - b.dist);
  const lines = [];
  let used = 0;
  let n = 0;
  for (const { el } of found) {
    const role = roleOf(el);
    let line = '[ref=' + (n + 1) + '] ' + role + ' "' + label(el) + '"';
    if (role === 'link' && el.getAttribute('href')) line += ' -> ' + el.getAttribute('href').slice(0, 100);
    if (role === 'textbox' && el.value) line += secret(el) ? ' (已填写)' : ' value="' + String(el.value).slice(0, 60) + '"';
    if (role === 'checkbox' || role === 'radio') line += el.checked ? ' (checked)' : '';
    if (el.disabled) line += ' (disabled)';
    if (used + line.length > EL_MAX) break;
    n += 1;
    el.setAttribute('data-ff-ref', String(n));
    used += line.length + 1;
    lines.push(line);
  }
  if (found.length > n) lines.push('…另有 ' + (found.length - n) + ' 个离当前视口较远的元素没有列出，滚动后再读取即可看到。');
  // Page text from about the current scroll position on.
  const all = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  const height = Math.max(1, document.documentElement.scrollHeight);
  const from = scrollY > 0 ? Math.max(0, Math.floor(all.length * scrollY / height) - 300) : 0;
  let text = all.slice(from, from + TEXT_MAX);
  if (from > 0) text = '…（前面的文字已省略）' + text;
  if (from + TEXT_MAX < all.length) text += '\\n…（后面还有，可以滚动后再读取）';
  return '页面：' + document.title + '\\n网址：' + location.href + '\\n滚动：' + Math.round(scrollY) + ' / ' + Math.max(0, height - innerHeight)
    + '\\n\\n页面文字：\\n' + text + '\\n\\n可操作的元素（用 ref 指定）：\\n' + lines.join('\\n');
})()`;

const centerJs = (ref) => `(() => {
  const el = document.querySelector('[data-ff-ref="${ref}"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

// Page-script pieces shared by focusJs and focusedSecretJs (SNAPSHOT_JS and describeJs carry their own copy of `secret`):
// a field that is never typed into, and where the keys would really go — through open shadow roots, and into a frame when
// it is same-origin (one that cannot be looked into, a payment form say, is null).
const PAGE_FOCUS_FNS = `
  const secret = (el) => { if (!el || el.nodeType !== 1) return false; const ty = (el.type || '').toLowerCase(); const ac = (el.getAttribute('autocomplete') || '').toLowerCase(); return ty === 'password' || /(^|\\s)(cc-|one-time-code|current-password|new-password)/.test(ac); };
  const deep = (a) => { while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a; };
  const isFrame = (a) => !!a && /^(IFRAME|FRAME|OBJECT|EMBED)$/.test(a.tagName || '');
  const focused = (top) => {
    let a = deep(top);
    if (isFrame(a)) {
      let doc = null;
      try { doc = a.contentDocument; } catch (e) { doc = null; }
      a = doc ? deep(doc.activeElement) : null;
      if (isFrame(a)) a = null;
    }
    return a;
  };`;

// The check and the focus in one page script, for every agent (the command-line agents' MCP tool comes straight here):
// the text goes wherever the focus is, so the focus must really land on this element or inside it (one that cannot take
// focus leaves it where it was, perhaps in a password field), and neither the element nor what ends up focused may be a
// password, card-number or one-time-code field. Clearing fires the page's input handlers, which may move the focus: the
// landing is checked again after it. → 'ok' | 'missing' | 'secret' | 'unfocused'.
const focusJs = (ref, clear) => `(() => {${PAGE_FOCUS_FNS}
  const el = document.querySelector('[data-ff-ref="${ref}"]');
  if (!el) return 'missing';
  if (secret(el)) return 'secret';
  const land = () => {
    const top = document.activeElement;
    if (!top || (top !== el && !el.contains(top))) return 'unfocused';
    const a = focused(top);
    if (!a) return 'unfocused';
    return secret(a) ? 'secret' : a;
  };
  el.scrollIntoView({ block: 'center' });
  el.focus();
  const at = land();
  if (typeof at === 'string') return at;
  if (${clear ? 'true' : 'false'} && at.ownerDocument === document) {
    if ('value' in at) { at.value = ''; at.dispatchEvent(new Event('input', { bubbles: true })); }
    else if (at.isContentEditable) at.textContent = '';
    const again = land();
    if (typeof again === 'string') return again;
    if (again !== at) return 'unfocused';
  }
  return 'ok';
})()`;

// Whether the keys of browser_press would land in a field that is never typed into (or a frame that cannot be looked into).
const focusedSecretJs = `(() => {${PAGE_FOCUS_FNS}
  const top = document.activeElement;
  if (!top) return false;
  const a = focused(top);
  return !a || secret(a);
})()`;

/** Keys that change what a field holds: never sent while a password, card or one-time-code field has the focus. */
const EDIT_KEYS = new Set(['Space', 'Backspace', 'Delete']);

// What the element with this ref really is, for the approval card: its own visible text first (a page can
// set aria-label to anything), then the other names it has. `role` and `secret` follow SNAPSHOT_JS: keep the two in step.
const describeJs = (ref) => `(() => {
  const el = document.querySelector('[data-ff-ref="${ref}"]');
  if (!el) return null;
  const t = el.tagName.toLowerCase();
  const ty = (el.type || '').toLowerCase();
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  const secret = ty === 'password' || /(^|\\s)(cc-|one-time-code|current-password|new-password)/.test(ac);
  const r = el.getAttribute('role');
  const bty = ty || 'text';
  const role = r || (t === 'a' ? 'link' : t === 'button' || t === 'summary' ? 'button' : t === 'select' ? 'combobox' : t === 'textarea' || el.isContentEditable ? 'textbox'
    : t === 'input' ? (bty === 'checkbox' ? 'checkbox' : bty === 'radio' ? 'radio' : ['submit', 'button', 'reset'].includes(bty) ? 'button' : 'textbox') : 'clickable');
  // A field's own content is what the user typed (or will type): never its label.
  const field = role === 'textbox' || role === 'combobox';
  const own = field ? '' : t === 'input' ? (['submit', 'button', 'reset'].includes(bty) ? el.value : '') : (el.innerText || '');
  const lab = el.labels && el.labels[0] ? el.labels[0].innerText : '';
  const label = own || lab || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('name') || '';
  return { tag: t, role, label: String(label).slice(0, 400), type: ty, autocomplete: ac, secret };
})()`;

/** What the agent is told for a field that is never typed into (the same words as tools/browser-tools.cjs SECRET_REFUSAL). */
const SECRET_REFUSAL = '不能替你在密码、银行卡或验证码输入框里输入。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve within ms, or reject with a TIMEOUT error (the work itself may keep going). */
function within(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error(`${what}超过 ${Math.round(ms / 1000)} 秒没有完成`), { code: 'TIMEOUT' })), ms); }),
  ]).finally(() => clearTimeout(t));
}
const js = (wc, code) => within(wc.executeJavaScript(code, true), 10000, '页面脚本');

function waitLoad(wc, ms = 30000) {
  return new Promise((resolve) => {
    if (!wc.isLoading()) { resolve(); return; }
    const done = () => { clearTimeout(t); wc.removeListener('did-stop-loading', done); resolve(); };
    const t = setTimeout(done, ms);
    wc.on('did-stop-loading', done);
  });
}

async function snapshot(wc) {
  return js(wc, SNAPSHOT_JS);
}

const KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space']);

async function press(wc, key) {
  const keyCode = key === 'Space' ? ' ' : key;
  wc.sendInputEvent({ type: 'keyDown', keyCode });
  if (key === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  wc.sendInputEvent({ type: 'keyUp', keyCode });
}

/* ───────────── tools ───────────── */

const text = (t) => ({ content: [{ type: 'text', text: String(t) }] });
const fail = (t) => ({ content: [{ type: 'text', text: String(t) }], isError: true });

async function run(tool, args) {
  ensureWindow(true);
  const wc = pageContents();
  if (!wc) return fail('萤火浏览器窗口已关闭。');
  const ref = args && Number.isInteger(Number(args.ref)) ? Number(args.ref) : null;
  switch (tool) {
    case 'browser_navigate': {
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) return fail('只能打开 http:// 或 https:// 开头的网址。');
      const blocked = await navigationBlock(url);
      if (blocked) return fail(blocked);
      try { await within(wc.loadURL(url), 30000, '打开网页'); } catch (e) {
        if (e.code === 'TIMEOUT') { wc.stop(); return fail(`网页 30 秒还没打开，已停止加载：${url}`); }
        if (/ERR_BLOCKED_BY_CLIENT/.test(String(e.message))) return fail(PRIVATE_NOTE);
        if (!/ERR_ABORTED/.test(String(e.message))) return fail(`打不开这个网址：${e.message}`);
      }
      await waitLoad(wc);
      await sleep(400);
      return text(await snapshot(wc));
    }
    case 'browser_snapshot':
      return text(await snapshot(wc));
    case 'browser_click': {
      if (ref === null) return fail('需要 ref（先用 browser_snapshot 获取）。');
      const c = await js(wc, centerJs(ref));
      if (!c) return fail(`找不到 ref=${ref}，页面可能已经变化，请重新 browser_snapshot。`);
      await sleep(120);
      const c2 = (await js(wc, centerJs(ref))) || c;
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: c2.x, y: c2.y, button: 'left', clickCount: 1 });
      await sleep(600);
      await waitLoad(wc, 15000);
      return text(await snapshot(wc));
    }
    case 'browser_type': {
      if (ref === null) return fail('需要 ref（先用 browser_snapshot 获取）。');
      const focus = await js(wc, focusJs(ref, args.clear !== false));
      if (focus === 'secret') return fail(SECRET_REFUSAL);
      if (focus === 'unfocused') return fail(`ref=${ref} 不能输入文字（焦点落不到它上面），请换一个输入框。`);
      if (focus !== 'ok') return fail(`找不到 ref=${ref}，请重新 browser_snapshot。`);
      await within(wc.insertText(String(args.text ?? '').slice(0, 20000)), 10000, '输入文字');
      if (args.submit) { await press(wc, 'Enter'); await sleep(800); await waitLoad(wc, 15000); }
      return text(await snapshot(wc));
    }
    case 'browser_press': {
      const key = String(args.key || '');
      if (!KEYS.has(key)) return fail(`不支持的按键：${key}。可用：${[...KEYS].join(', ')}`);
      if (EDIT_KEYS.has(key) && (await js(wc, focusedSecretJs))) return fail(SECRET_REFUSAL);
      await press(wc, key);
      await sleep(400);
      return text(await snapshot(wc));
    }
    case 'browser_scroll': {
      const dy = args.direction === 'up' ? -1 : 1;
      await js(wc, `window.scrollBy(0, ${dy} * Math.round(innerHeight * 0.85))`);
      await sleep(300);
      return text(await snapshot(wc));
    }
    case 'browser_back': {
      if (wc.navigationHistory?.canGoBack()) wc.navigationHistory.goBack();
      await sleep(300);
      await waitLoad(wc);
      return text(await snapshot(wc));
    }
    case 'browser_screenshot': {
      let img = await within(wc.capturePage(), 15000, '截图');
      const { width } = img.getSize();
      if (width > 1280) img = img.resize({ width: 1280 });
      return { content: [{ type: 'image', data: img.toPNG().toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `截图：${wc.getURL()}` }] };
    }
    case 'browser_wait': {
      const s = Math.min(Math.max(Number(args.seconds) || 1, 0.2), 10);
      await sleep(s * 1000);
      return text(await snapshot(wc));
    }
    default:
      return fail(`未知的浏览器工具：${tool}`);
  }
}

/* ───────────── the 127.0.0.1 bridge for browser-mcp.cjs ───────────── */

/** What the toolbar says the agent is doing. */
const ACTION_LABEL = {
  browser_navigate: '打开网页', browser_snapshot: '读取页面', browser_click: '点击', browser_type: '输入',
  browser_press: '按键', browser_scroll: '滚动', browser_back: '后退', browser_screenshot: '截图', browser_wait: '等待页面',
};

/** One action at a time, in order, and none may hold the queue for more than a minute: what the 127.0.0.1
 *  bridge and the app's own API tools both go through. Never rejects (a failure is an `isError` result). */
function runQueued(tool, args) {
  const name = String(tool);
  const job = queue.then(async () => {
    setNote('agent', ACTION_LABEL[name] || '浏览');
    try { return await within(run(name, args || {}), 60000, '这个浏览器动作'); } finally { setNote('agent', ''); }
  }).catch((e) => fail(`浏览器出错：${e.message}`));
  queue = job.catch(() => {});
  return job;
}

// A page may put anything in a label: control and direction characters are shown as <U+202E> and the like, so the card cannot be spoofed.
const ODD_CHARS = new RegExp(`[${[[0, 8], [11, 31], [127, 159], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');
const shown = (s) => String(s || '').replace(ODD_CHARS, (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`).replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * What the element with data-ff-ref = `ref` is, read from the page itself (not from what the model says it
 * is): { tag, role, label, type, autocomplete, url, secret }, or null when there is no page or no such element.
 * Does not open the window and does not wait in the action queue.
 */
async function describeRef(ref) {
  const n = Number(ref);
  const wc = pageContents();
  if (!wc || !Number.isInteger(n) || n < 1) return null;
  let info;
  try { info = await js(wc, describeJs(n)); } catch { return null; }
  if (!info || typeof info !== 'object') return null;
  return {
    tag: shown(info.tag), role: shown(info.role), label: shown(info.label), type: shown(info.type),
    autocomplete: shown(info.autocomplete), url: wc.getURL(), secret: !!info.secret,
  };
}

function startBridge() {
  if (endpoint) return Promise.resolve(endpoint);
  const token = crypto.randomBytes(24).toString('hex');
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/call' || req.headers['x-ff-token'] !== token) { res.writeHead(403); res.end(); return; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let msg;
        try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
        if (!msg || typeof msg !== 'object' || typeof msg.tool !== 'string') { res.writeHead(400); res.end(); return; }
        runQueued(String(msg.tool), msg.args || {}).then((out) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); });
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      endpoint = { url: `http://127.0.0.1:${server.address().port}/call`, token };
      resolve(endpoint);
    });
  });
}

/** How a CLI agent starts the MCP server: Electron's own binary in Node mode + the script. */
function mcpLaunch(ep) {
  const script = path.join(__dirname, 'browser-mcp.cjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return {
    command: process.execPath,
    args: [script],
    env: { ELECTRON_RUN_AS_NODE: '1', FF_BROWSER_URL: ep.url, FF_BROWSER_TOKEN: ep.token },
  };
}

function open() { ensureWindow(true).focus(); return true; }

async function clearData() {
  await session.fromPartition(PARTITION).clearStorageData();
  goHome();
  return true;
}

function shutdown() {
  try { server && server.close(); } catch { /* gone */ }
  server = null;
  endpoint = null;
}

if (app) app.on('before-quit', shutdown);

const getEndpoint = () => endpoint;

module.exports = {
  startBridge, getEndpoint, mcpLaunch, open, clearData, run, runQueued, describeRef, SECRET_REFUSAL, isPrivateHost, ipv6Groups, pageContents, toUrl, navigationBlock,
  // Exposed for scripts/apitools-check.ts.
  _internals: { focusJs, focusedSecretJs, EDIT_KEYS },
};
