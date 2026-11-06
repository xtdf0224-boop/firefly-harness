// Real browser queue and API tool dispatch with a controlled WebContents. No window or network.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

module.exports = async function browserCancelChecks({ req, tools, fakeBrowser, eq, expect }) {
  class Window extends EventEmitter {
    constructor() { super(); this.contentView = { addChildView() {} }; }
    getContentBounds() { return { width: 800, height: 600 }; }
    removeMenu() {} showInactive() {} focus() {}
    isDestroyed() { return false; } isVisible() { return true; }
  }
  class Contents extends EventEmitter {
    constructor() {
      super();
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
      this.inputs = []; this.typed = []; this.nextScript = null; this.onType = null;
    }
    loadFile() { return Promise.resolve(); }
    getURL() { return 'https://fixture.example/'; }
    isLoading() { return false; } isDestroyed() { return false; }
    setWindowOpenHandler() {} send() {}
    executeJavaScript(code) {
      const next = this.nextScript;
      this.nextScript = null;
      if (next) return Promise.resolve(next());
      if (code.includes('getBoundingClientRect')) return Promise.resolve({ x: 10, y: 10 });
      return Promise.resolve('snapshot');
    }
    sendInputEvent(input) { this.inputs.push(input); }
    insertText(text) { this.typed.push(text); this.onType?.(); return Promise.resolve(); }
  }
  class View {
    constructor() { this.webContents = new Contents(); }
    setBackgroundColor() {} setBounds() {}
  }
  const session = { webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} };
  const electron = { BaseWindow: Window, WebContentsView: View, session: { fromPartition: () => session } };
  const filename = req.resolve('./electron/ai/browser.cjs');
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mod, exports: mod.exports, __dirname: path.dirname(filename),
    require: (name) => name === 'electron' ? electron : req(name),
    setTimeout, clearTimeout, URL, Buffer, console,
  }, { filename });
  const browser = mod.exports;
  browser.open();
  const wc = browser.pageContents();
  const savedQueue = fakeBrowser.runQueued;
  fakeBrowser.runQueued = (name, args, signal) => browser.runQueued(name, args, signal);
  const ctx = { tools: ['browser_act'], browser: true };
  try {
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let release;
    wc.nextScript = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
    const blocker = browser.runQueued('browser_snapshot', {});
    await started;
    const queued = new AbortController();
    const cancelledClick = tools.execute('browser_click', { ref: 1 }, ctx, queued.signal);
    queued.abort();
    release('snapshot');
    await blocker;
    const cancelled = await cancelledClick;
    expect('a cancelled API browser action is skipped when it leaves the shared queue', !cancelled.ok && /已停止/.test(cancelled.output), cancelled);
    eq('the cancelled queued click sends no input', wc.inputs.length, 0);

    const clicking = new AbortController();
    wc.nextScript = () => { clicking.abort(); return { x: 10, y: 10 }; };
    const click = await browser.runQueued('browser_click', { ref: 1 }, clicking.signal);
    expect('cancellation during target lookup prevents the actual click', click.isError && wc.inputs.length === 0, click);

    const typing = new AbortController();
    wc.nextScript = () => { typing.abort(); return 'ok'; };
    const type = await tools.execute('browser_type', { ref: 1, text: 'test' }, ctx, typing.signal);
    expect('cancellation while focusing prevents insertText', !type.ok && wc.typed.length === 0, type);

    const submitting = new AbortController();
    wc.nextScript = () => 'ok';
    wc.onType = () => submitting.abort();
    const submit = await browser.runQueued('browser_type', { ref: 1, text: 'test', submit: true }, submitting.signal);
    expect('cancellation after typing prevents the submission key', submit.isError && wc.typed.length === 1 && wc.inputs.length === 0, submit);
    wc.onType = null;

    const pressing = new AbortController();
    wc.nextScript = () => { pressing.abort(); return false; };
    const key = await tools.execute('browser_press', { key: 'Delete' }, ctx, pressing.signal);
    expect('cancellation during a key safety check prevents the key event', !key.ok && wc.inputs.length === 0, key);

    const legacy = await browser.runQueued('browser_click', { ref: 1 });
    expect('the queue keeps running and CLI calls without a signal still click', !legacy.isError, legacy);
    eq('the later successful click sends exactly one mouse gesture', wc.inputs.map((input) => input.type), ['mouseMove', 'mouseDown', 'mouseUp']);
  } finally {
    fakeBrowser.runQueued = savedQueue;
  }
};
