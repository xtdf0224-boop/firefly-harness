/* Input checks for the 桌宠 settings, kept apart from the React code so they can be tested alone:
   hotkeys as Electron accelerators, programs as lower-case exe names, the 百炼 workspace id. */

export type Checked = { ok: true; value: string } | { ok: false; error: string };
const fail = (error: string): Checked => ({ ok: false, error });

/* ───────────── hotkeys ───────────── */

/* Spellings Electron accepts → its canonical name. Windows has no Command / Option key, so those are refused. */
const MODIFIER: Record<string, string> = {
  ctrl: 'Ctrl', control: 'Ctrl', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl',
  alt: 'Alt', shift: 'Shift',
  super: 'Super', meta: 'Super', win: 'Super', windows: 'Super',
};
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'];
const NOT_ON_WINDOWS = new Set(['command', 'cmd', 'option', 'altgr']);

const KEY: Record<string, string> = {
  space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert',
  enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  printscreen: 'PrintScreen', plus: 'Plus',
  numdec: 'numdec', numadd: 'numadd', numsub: 'numsub', nummult: 'nummult', numdiv: 'numdiv',
};
/* The unshifted punctuation keys; "+" is the separator, so the plus key is spelled Plus. */
const PUNCTUATION = new Set(['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/']);

/* Combinations a global shortcut must never take over: they would break copy / paste or window switching everywhere. */
const RESERVED = new Set([
  'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+A', 'Ctrl+S',
  'Alt+F4', 'Alt+Tab', 'Alt+Space', 'Alt+Escape', 'Ctrl+Escape', 'Ctrl+Shift+Escape', 'Ctrl+Alt+Delete',
]);

function keyName(t: string): string | undefined {
  if (/^[a-z0-9]$/i.test(t)) return t.toUpperCase();
  const f = /^f(\d{1,2})$/i.exec(t);
  if (f && +f[1] >= 1 && +f[1] <= 24) return `F${+f[1]}`;
  const n = /^num([0-9])$/i.exec(t);
  if (n) return `num${n[1]}`;
  const named = KEY[t.toLowerCase()];
  if (named) return named;
  return PUNCTUATION.has(t) ? t : undefined;
}

/** Check a hotkey the way Electron's globalShortcut reads it and return it in canonical spelling ("alt + f" → "Alt+F"). */
export function parseAccelerator(raw: string): Checked {
  const text = raw.trim();
  if (!text) return fail('热键不能为空');
  const parts = text.split('+').map((p) => p.trim());
  if (parts.length < 2 || parts.some((p) => !p)) return fail('写法是「修饰键+按键」，例如 Ctrl+Alt+F');
  const key = keyName(parts[parts.length - 1]);
  const mods = new Set<string>();
  for (const m of parts.slice(0, -1)) {
    const lower = m.toLowerCase();
    if (NOT_ON_WINDOWS.has(lower)) return fail(`Windows 上没有「${m}」键，请用 Ctrl、Alt、Shift 或 Win`);
    const name = MODIFIER[lower];
    if (!name) return fail(`「${m}」不是修饰键。修饰键有 Ctrl、Alt、Shift、Win，按键写在最后`);
    mods.add(name);
  }
  if (!key) return fail(`「${parts[parts.length - 1]}」不是可用的按键：用字母、数字、F1–F24、方向键等`);
  // Shift alone only changes the letter that is typed; a global shortcut on it would eat normal typing.
  if (!mods.has('Ctrl') && !mods.has('Alt') && !mods.has('Super')) return fail('至少要带 Ctrl、Alt 或 Win 之一，否则会抢走平时的打字');
  const value = [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
  if (RESERVED.has(value)) return fail(`${value} 是系统或常用快捷键，换一个组合`);
  return { ok: true, value };
}

/* ───────────── programs ───────────── */

export const MAX_NAMES = 200;

/** A program as the lists store it: the lower-case file name ("C:\Games\StarRail.exe" → "starrail.exe", "starrail" → "starrail.exe"). */
export function parseExe(raw: string): Checked {
  let s = raw.trim().replace(/^["']+|["']+$/g, '');
  s = s.slice(Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')) + 1).trim().toLowerCase();
  if (!s) return fail('请填程序名，例如 starrail.exe');
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(s)) return fail('程序名里有不能用的字符');
  if (/\.(lnk|url|bat|cmd|msi|dll|com|ps1)$/.test(s)) return fail('要填程序本身的 .exe 文件名，不是快捷方式或脚本');
  if (!s.endsWith('.exe')) s += '.exe';
  if (s === '.exe') return fail('请填程序名，例如 starrail.exe');
  if (s.length > 100) return fail('程序名太长了');
  return { ok: true, value: s };
}

/* ───────────── numbers and ids ───────────── */

/** A whole number clamped into lo–hi (what the field shows after you leave it). */
export function parseIntIn(lo: number, hi: number) {
  return (raw: string): Checked => {
    const text = raw.trim();
    const n = Number(text);
    if (!text || !Number.isFinite(n)) return fail('请输入数字');
    return { ok: true, value: String(Math.min(hi, Math.max(lo, Math.round(n)))) };
  };
}


