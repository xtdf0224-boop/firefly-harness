// 萤火浏览器: a separate window the agents can drive (open a page, read it, click, type, scroll,
// screenshot). Its own session partition keeps cookies apart from the app; the user can log in to
// sites there and watch or take over at any time. CLI agents reach it through browser-mcp.cjs (an
// MCP stdio server they spawn), which calls back here over 127.0.0.1 with a random token.
// The window is two views: a toolbar (browser-ui/bar.html: back, forward, reload, home, address bar)
// and the page itself, which starts on browser-ui/start.html.
const { app, BaseWindow, WebContentsView, ipcMain, session } = require('electron');
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

/** Loopback, private, link-local and similar hosts: the agent's browser never reaches them. */
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal') return true;
  const v4 = h.replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (h.includes(':')) return h === '::' || h === '::1' || h.startsWith('::ffff:') || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  // Bare numbers (http://2130706433/) are IPv4 too.
  return /^(0x[0-9a-f]+|\d+)$/.test(h);
}

function blockedUrl(url) {
  try {
    const u = new URL(url);
    return /^(https?|wss?):$/.test(u.protocol) && isPrivateHost(u.hostname);
  } catch { return false; }
}

const PRIVATE_NOTE = '为了安全，萤火浏览器不会打开本机或内网地址（localhost、127.0.0.1、192.168.x.x 等）。';

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

// Toolbar commands. Only the toolbar of the current window may send them.
ipcMain.on('ffbar', (e, cmd, arg) => {
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

const focusJs = (ref, clear) => `(() => {
  const el = document.querySelector('[data-ff-ref="${ref}"]');
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (${clear ? 'true' : 'false'}) {
    if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    else if (el.isContentEditable) el.textContent = '';
  }
  return true;
})()`;

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
      if (blockedUrl(url)) return fail(PRIVATE_NOTE);
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
      const ok = await js(wc, focusJs(ref, args.clear !== false));
      if (!ok) return fail(`找不到 ref=${ref}，请重新 browser_snapshot。`);
      await within(wc.insertText(String(args.text ?? '').slice(0, 20000)), 10000, '输入文字');
      if (args.submit) { await press(wc, 'Enter'); await sleep(800); await waitLoad(wc, 15000); }
      return text(await snapshot(wc));
    }
    case 'browser_press': {
      const key = String(args.key || '');
      if (!KEYS.has(key)) return fail(`不支持的按键：${key}。可用：${[...KEYS].join(', ')}`);
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
        // One action at a time, in order — and none may hold the queue for more than a minute.
        const tool = String(msg.tool);
        const job = queue.then(async () => {
          setNote('agent', ACTION_LABEL[tool] || '浏览');
          try { return await within(run(tool, msg.args || {}), 60000, '这个浏览器动作'); } finally { setNote('agent', ''); }
        }).catch((e) => fail(`浏览器出错：${e.message}`));
        queue = job.catch(() => {});
        job.then((out) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); });
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

app.on('before-quit', shutdown);

const getEndpoint = () => endpoint;

module.exports = { startBridge, getEndpoint, mcpLaunch, open, clearData, run, isPrivateHost, pageContents, toUrl };
