// The pet's two global hotkeys: open (or close) the chat panel, and pause / resume watching.
const { globalShortcut } = require('electron');

/** Holding a hotkey down repeats it (after Windows' repeat delay, 250–1000 ms, many times a second), and both hotkeys are
 *  toggles: a press this soon after the last one (or after the last repeat) is the same press. */
const REPEAT_MS = 800;

/** What we registered, per key: { wanted, active (the combination registered now, '' if none), error }, and the
 *  callbacks (so unchanged settings leave the registration alone). */
let applied = null;
const NONE = { ok: true, errors: [], ask: false, pause: false };
let lastResult = NONE;

function clear() {
  if (applied) {
    for (const key of ['ask', 'pause']) {
      const a = applied[key];
      if (a && a.active) { try { globalShortcut.unregister(a.active); } catch { /* already gone */ } }
    }
  }
  applied = null;
  lastResult = NONE;
}

/** fn, once per press: the repeats of a held key (and a bounce right after) do nothing. */
function oncePerPress(fn) {
  let last = 0;
  return () => {
    const t = Date.now();
    const again = t - last < REPEAT_MS;
    last = t;
    if (!again) fn();
  };
}

/** Register one combination: '' when it took, else why not. */
function take(label, accelerator, fn) {
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, fn);
  } catch {
    return `${label}快捷键「${accelerator}」格式不对。`;
  }
  return ok ? '' : `${label}快捷键 ${accelerator} 注册失败，可能被别的程序占用了。`;
}

function register(label, accelerator, fn, taken) {
  if (!accelerator) return { wanted: accelerator, active: '', error: null };
  if (taken.has(accelerator.toLowerCase())) return { wanted: accelerator, active: '', error: `${label}快捷键 ${accelerator} 和另一个桌宠快捷键重复了。` };
  taken.add(accelerator.toLowerCase());
  const error = take(label, accelerator, fn);
  return { wanted: accelerator, active: error ? '' : accelerator, error: error || null };
}

/**
 * Register both hotkeys (replacing the previous ones). A new combination that cannot be registered leaves the one it
 * replaced working, if it still can be. Returns what could not be registered, and whether each key works as set
 * (`ask` / `pause`: false when not set, or not registered).
 */
function apply({ ask, pause }, { onAsk, onPause }) {
  const want = { ask: String(ask || '').trim(), pause: String(pause || '').trim() };
  // Same keys as last time and both took: nothing to redo.
  if (applied && applied.ask.wanted === want.ask && applied.pause.wanted === want.pause && !lastResult.errors.length) {
    applied.fns.ask = onAsk;
    applied.fns.pause = onPause;
    return lastResult;
  }
  const before = applied ? { ask: applied.ask.active, pause: applied.pause.active } : { ask: '', pause: '' };
  clear();
  const fns = { ask: onAsk, pause: onPause };
  // Indirect callbacks so a re-apply with new handlers does not need to re-register.
  const cbs = { ask: oncePerPress(() => fns.ask && fns.ask()), pause: oncePerPress(() => fns.pause && fns.pause()) };
  const labels = { ask: '呼出', pause: '暂停' };
  const taken = new Set();
  const keys = { ask: register(labels.ask, want.ask, cbs.ask, taken), pause: register(labels.pause, want.pause, cbs.pause, taken) };
  for (const key of ['ask', 'pause']) {
    const k = keys[key];
    const old = before[key];
    // The new combination did not take: the old one goes on working, unless it is the same or the other key has it now.
    if (k.active || !k.error || !old || old.toLowerCase() === k.wanted.toLowerCase() || taken.has(old.toLowerCase())) continue;
    if (!take(labels[key], old, cbs[key])) {
      k.active = old;
      k.error = `${k.error}暂时还用原来的 ${old}。`;
      taken.add(old.toLowerCase());
    }
  }
  applied = { ...keys, fns };
  const errors = [keys.ask.error, keys.pause.error].filter(Boolean);
  const works = (k) => !!k.active && k.active === k.wanted;
  lastResult = { ok: errors.length === 0, errors, ask: works(keys.ask), pause: works(keys.pause) };
  return lastResult;
}

module.exports = { apply, clear };
