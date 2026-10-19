// 主题光标: the 流萤 and 萨姆 cursor sets, drawn here as SVG, rendered to PNG (1x 32 px, 2x 64 px) and
// written into src/styles/cursors.css as data URIs (the packaged page opens from file://, so nothing
// depends on asset paths). Rendering uses a local Chrome over the DevTools protocol, so this is a
// developer tool: run `node scripts/gen-cursors.mjs` after changing a shape and commit the CSS.
// `--preview <file.png>` also writes a contact sheet (each cursor large, on dark and light ground).
//
// 流萤: slim silver-white arrow, deep teal outline, a mint edge, and a small glowing firefly at the tail.
// 萨姆: chamfered gunmetal armour plate with a firefly-green seam and visor slit, a green energy core.
// Every cursor has a dark outer outline so it reads on light pages as well as on the night ground.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const CSS_OUT = path.join(ROOT, 'src', 'styles', 'cursors.css');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/* ───────────── shapes (32 × 32 viewBox; hotspots in the same units) ───────────── */

const ARROW = 'M4 2.6 L4 23.2 L9.1 18.5 L12.5 26.2 L16.1 24.6 L12.8 17.1 L19.7 17.1 Z';
// 萨姆: the same silhouette with a chamfered tail and a cut heel — armour, not paper.
const ARROW_SAM = 'M4 2.4 L4 22.6 L8.7 18.6 L11.6 25.4 L13.2 26.2 L16.4 24.8 L16.6 23.6 L13.4 17.3 L19.6 17.3 L19.6 16.4 Z';

const FIREFLY_DEFS = `
  <linearGradient id="silver" x1="0" y1="0" x2=".55" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#cfe8ee"/></linearGradient>
  <linearGradient id="mint" x1="0" y1="0" x2=".55" y2="1"><stop offset="0" stop-color="#d9fff6"/><stop offset=".55" stop-color="#7eecd5"/><stop offset="1" stop-color="#3fcfb3"/></linearGradient>
  <radialGradient id="glow"><stop offset="0" stop-color="#f7ffdd"/><stop offset=".3" stop-color="#cdf78a" stop-opacity=".95"/><stop offset="1" stop-color="#b5f26b" stop-opacity="0"/></radialGradient>`;

const SAM_DEFS = `
  <linearGradient id="steel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a5868"/><stop offset=".5" stop-color="#27313d"/><stop offset="1" stop-color="#121820"/></linearGradient>
  <linearGradient id="flare" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ecffc4"/><stop offset=".5" stop-color="#b5f26b"/><stop offset="1" stop-color="#6fbf2a"/></linearGradient>
  <radialGradient id="core"><stop offset="0" stop-color="#f4ffd6"/><stop offset=".35" stop-color="#b5f26b" stop-opacity=".95"/><stop offset="1" stop-color="#7fd23a" stop-opacity="0"/></radialGradient>`;

/** A tiny firefly: glow, two translucent wings, a bright body. */
const firefly = (x, y, scale = 1, glow = 6) => `
  <circle cx="${x}" cy="${y}" r="${glow}" fill="url(#glow)" opacity=".8"/>
  <g transform="translate(${x} ${y}) scale(${scale})">
    <path d="M0 0 C-2.4 -2.2 -2.9 -4 -1.6 -4.5 C-.6 -4.8 .2 -3 0 0 Z" fill="#a9f7e6" stroke="#0b3b36" stroke-width=".35" opacity=".92"/>
    <path d="M0 0 C2.3 -1.6 4.1 -1.7 4.3 -.4 C4.4 .6 2.6 .7 0 0 Z" fill="#a9f7e6" stroke="#0b3b36" stroke-width=".35" opacity=".92"/>
    <ellipse cx=".3" cy=".5" rx="1.6" ry="1.9" fill="#f3ffd2" stroke="#2f5a10" stroke-width=".45"/>
  </g>`;

/** 萨姆's energy core: a small hexagon with a green glow. */
const core = (x, y, r = 2.5, glow = 6) => {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    return `${(x + r * Math.cos(a)).toFixed(2)},${(y + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
  return `<circle cx="${x}" cy="${y}" r="${glow}" fill="url(#core)" opacity=".75"/>
    <polygon points="${pts}" fill="url(#flare)" stroke="#0b1404" stroke-width=".7" stroke-linejoin="round"/>
    <circle cx="${x}" cy="${y}" r="${(r * 0.38).toFixed(2)}" fill="#fbffe8"/>`;
};

const fireflyArrow = (fill) => `
  <path d="${ARROW}" fill="${fill}" stroke="#04211f" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M5.4 5.9 L5.4 20" stroke="${fill === 'url(#mint)' ? '#ffffff' : '#5fe3c8'}" stroke-width="1" stroke-linecap="round" opacity=".9"/>`;

const samArrow = (fill, seam) => `
  <path d="${ARROW_SAM}" fill="${fill}" stroke="#05080a" stroke-width="2.4" stroke-linejoin="miter"/>
  <path d="${ARROW_SAM}" fill="none" stroke="${seam}" stroke-width=".9" stroke-linejoin="miter"/>
  <path d="M6.2 7.6 L10.8 12.2" stroke="${seam === '#b5f26b' ? '#d8ff9c' : '#0b1404'}" stroke-width="1.3" stroke-linecap="square"/>
  <path d="M4.9 14.3 L8.9 14.3" stroke="${seam}" stroke-width=".6" opacity=".7"/>`;

/** The 禁止 badge: a ring with a slash. */
const noBadge = (x, y, color, sam) => sam
  ? `<polygon points="${octagon(x, y, 5.6)}" fill="#1a0b08" stroke="#05080a" stroke-width="2.2" stroke-linejoin="miter"/>
     <polygon points="${octagon(x, y, 5.6)}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="miter"/>
     <path d="M${x - 3} ${y + 3} L${x + 3} ${y - 3}" stroke="${color}" stroke-width="1.7" stroke-linecap="square"/>`
  : `<circle cx="${x}" cy="${y}" r="5.4" fill="#2a0d0a" stroke="#04211f" stroke-width="2.4"/>
     <circle cx="${x}" cy="${y}" r="5.4" fill="none" stroke="${color}" stroke-width="1.6"/>
     <path d="M${x - 3.6} ${y + 3.6} L${x + 3.6} ${y - 3.6}" stroke="${color}" stroke-width="1.7" stroke-linecap="round"/>`;

function octagon(x, y, r) {
  return Array.from({ length: 8 }, (_, i) => {
    const a = Math.PI / 8 + (i * Math.PI) / 4;
    return `${(x + r * Math.cos(a)).toFixed(2)},${(y + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
}

/** I-beam: a dark outline under a light (or green) beam, with a little light beside it. */
const ibeam = (stroke, accent) => {
  const d = 'M12.2 5 C14.4 5 15.4 5.6 16 7 C16.6 5.6 17.6 5 19.8 5 M16 7 L16 25 M12.2 27 C14.4 27 15.4 26.4 16 25 C16.6 26.4 17.6 27 19.8 27 M13.5 16 L18.5 16';
  return `<path d="${d}" fill="none" stroke="#04211f" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>${accent}`;
};
const ibeamSam = () => {
  const d = 'M12 5 L20 5 M16 5 L16 27 M12 27 L20 27 M13.6 16 L18.4 16';
  return `<path d="${d}" fill="none" stroke="#05080a" stroke-width="3.8" stroke-linecap="square"/>
    <path d="${d}" fill="none" stroke="#b5f26b" stroke-width="1.6" stroke-linecap="square"/>
    <path d="M12 5 L13.4 5 M18.6 5 L20 5 M12 27 L13.4 27 M18.6 27 L20 27" stroke="#ecffc4" stroke-width="1.6" stroke-linecap="square"/>`;
};

/** 忙碌: an open ring (three quarters) beside the arrow. */
const ring = (x, y, color, outline) => `<path d="M${x + 4.6} ${y} A4.6 4.6 0 1 1 ${x} ${y - 4.6}" fill="none" stroke="${outline}" stroke-width="4.2" stroke-linecap="round"/>
  <path d="M${x + 4.6} ${y} A4.6 4.6 0 1 1 ${x} ${y - 4.6}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`;

/** Up–down resize: a double arrow (the console's height handle). */
const NS = 'M16 3 L22 10 L18.2 10 L18.2 22 L22 22 L16 29 L10 22 L13.8 22 L13.8 10 L10 10 Z';
const NS_SAM = 'M16 2.6 L22.4 9.6 L18.4 9.6 L18.4 22.4 L22.4 22.4 L16 29.4 L9.6 22.4 L13.6 22.4 L13.6 9.6 L9.6 9.6 Z';

const svg = (defs, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs>${defs}</defs>${body}</svg>`;

/** name → [svg, hotspot x, hotspot y] per mode. */
export const CURSORS = {
  firefly: {
    default: [svg(FIREFLY_DEFS, `${fireflyArrow('url(#silver)')}${firefly(22.4, 24.2, 0.95, 5.5)}`), 4, 3],
    pointer: [svg(FIREFLY_DEFS, `${fireflyArrow('url(#mint)')}${firefly(22.4, 24.2, 1.1, 7.5)}<path d="M23.8 13.6 l.6 1.6 1.6 .6 -1.6 .6 -.6 1.6 -.6 -1.6 -1.6 -.6 1.6 -.6 Z" fill="#f3ffd2" opacity=".9"/>`), 4, 3],
    text: [svg(FIREFLY_DEFS, ibeam('#ffffff', '<circle cx="20.6" cy="16" r="3.4" fill="url(#glow)" opacity=".9"/><circle cx="20.6" cy="16" r=".9" fill="#f3ffd2"/>')), 16, 16],
    'not-allowed': [svg(FIREFLY_DEFS, `${fireflyArrow('url(#silver)')}${noBadge(22.6, 23.6, '#ff8b7b', false)}`), 4, 3],
    'ns-resize': [svg(FIREFLY_DEFS, `<path d="${NS}" fill="url(#silver)" stroke="#04211f" stroke-width="1.5" stroke-linejoin="round"/><circle cx="16" cy="16" r="1.6" fill="#5fe3c8" stroke="#04211f" stroke-width=".5"/>`), 16, 16],
    progress: [svg(FIREFLY_DEFS, `${fireflyArrow('url(#silver)')}${ring(22.6, 23.6, '#5fe3c8', '#04211f')}`), 4, 3],
  },
  sam: {
    default: [svg(SAM_DEFS, `${samArrow('url(#steel)', '#b5f26b')}${core(22.6, 24, 2.6, 5.5)}`), 4, 3],
    pointer: [svg(SAM_DEFS, `${samArrow('url(#flare)', '#0b1404')}${core(22.6, 24, 3, 7.5)}<path d="M23.4 12.6 L26.6 15.8 M25.4 11.4 L28.4 14.4" stroke="#b5f26b" stroke-width="1.2" stroke-linecap="square" opacity=".9"/>`), 4, 3],
    text: [svg(SAM_DEFS, ibeamSam()), 16, 16],
    'not-allowed': [svg(SAM_DEFS, `${samArrow('url(#steel)', '#b5f26b')}${noBadge(22.6, 23.6, '#ff7a59', true)}`), 4, 3],
    'ns-resize': [svg(SAM_DEFS, `<path d="${NS_SAM}" fill="url(#steel)" stroke="#05080a" stroke-width="2.2" stroke-linejoin="miter"/><path d="${NS_SAM}" fill="none" stroke="#b5f26b" stroke-width=".9" stroke-linejoin="miter"/><rect x="14.6" y="14.6" width="2.8" height="2.8" fill="#b5f26b" stroke="#0b1404" stroke-width=".5" transform="rotate(45 16 16)"/>`), 16, 16],
    progress: [svg(SAM_DEFS, `${samArrow('url(#steel)', '#b5f26b')}${ring(22.6, 23.6, '#b5f26b', '#05080a')}`), 4, 3],
  },
};

/* ───────────── rendering ───────────── */

async function withChrome(fn) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-cursor-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch { await sleep(250); }
  }
  if (!page) { chrome.kill(); throw new Error('Chrome did not start (set CHROME to its path)'); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  try { return await fn(send, sleep); } finally { ws.close(); chrome.kill(); }
}

async function render(send, sleep, html, width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
  await sleep(350);
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
  return Buffer.from(shot.result.data, 'base64');
}

const bare = (s, size) => `<!doctype html><html><body style="margin:0;background:transparent"><img style="display:block" width="${size}" height="${size}" src="data:image/svg+xml;utf8,${encodeURIComponent(s)}"></body></html>`;

async function main() {
  const preview = process.argv.includes('--preview') ? process.argv[process.argv.indexOf('--preview') + 1] : '';
  await withChrome(async (send, sleep) => {
    await send('Page.enable');
    const blocks = [];
    for (const [mode, set] of Object.entries(CURSORS)) {
      const vars = [];
      // Painted art (build/cursors/<mode>/, made by scripts/cursors-from-sheet.py) wins over the SVG shapes.
      const art = path.join(ROOT, 'build', 'cursors', mode);
      const spots = fs.existsSync(path.join(art, 'hotspots.json')) ? JSON.parse(fs.readFileSync(path.join(art, 'hotspots.json'), 'utf8')) : {};
      for (const [name, [s, hx0, hy0]] of Object.entries(set)) {
        const painted = spots[name] && fs.existsSync(path.join(art, `${name}.png`)) && fs.existsSync(path.join(art, `${name}@2x.png`));
        const one = painted ? fs.readFileSync(path.join(art, `${name}.png`)).toString('base64') : (await render(send, sleep, bare(s, 32), 32, 32)).toString('base64');
        const two = painted ? fs.readFileSync(path.join(art, `${name}@2x.png`)).toString('base64') : (await render(send, sleep, bare(s, 64), 64, 64)).toString('base64');
        const [hx, hy] = painted ? spots[name] : [hx0, hy0];
        vars.push(`  --cur-${name}: -webkit-image-set(url("data:image/png;base64,${one}") 1x, url("data:image/png;base64,${two}") 2x) ${hx} ${hy}, ${name};`);
      }
      blocks.push(`:root[data-cursor="on"][data-mode="${mode}"] {\n${vars.join('\n')}\n}`);
    }
    fs.writeFileSync(CSS_OUT, `/* 主题光标 — generated by scripts/gen-cursors.mjs; do not edit by hand.
   Each --cur-* is the system keyword until 设置 › 主题光标 turns the themed set on (html[data-cursor="on"]);
   the stylesheets use var(--cur-pointer) etc. wherever they set a cursor. */
:root { ${Object.keys(CURSORS.firefly).map((n) => `--cur-${n}: ${n === 'default' ? 'auto' : n};`).join(' ')} }
html { cursor: var(--cur-default); }
a[href], summary, select, [role="button"], [role="option"], [role="switch"], [role="tab"], [role="menuitem"], button:not(:disabled),
label:has(> input[type="checkbox"]:not(:disabled), > input[type="radio"]:not(:disabled)) { cursor: var(--cur-pointer); }
input:not([type="checkbox"], [type="radio"], [type="range"], [type="button"], [type="submit"], [type="color"]):not(:disabled),
textarea:not(:disabled), [contenteditable="true"], [contenteditable=""] { cursor: var(--cur-text); }
:disabled, [aria-disabled="true"] { cursor: var(--cur-not-allowed); }
[aria-busy="true"] { cursor: var(--cur-progress); }

${blocks.join('\n\n')}
`);
    if (preview) {
      const cells = Object.entries(CURSORS).map(([mode, set]) => Object.entries(set).map(([name, [s]]) => {
        const src = `data:image/svg+xml;utf8,${encodeURIComponent(s)}`;
        return `<figure><div class="pair"><div class="d"><img width="128" height="128" src="${src}"><img width="32" height="32" src="${src}"></div><div class="l"><img width="128" height="128" src="${src}"><img width="32" height="32" src="${src}"></div></div><figcaption>${mode} · ${name}</figcaption></figure>`;
      }).join('')).join('');
      const html = `<!doctype html><html><head><style>body{margin:0;padding:16px;background:#5a6470;font:13px sans-serif;color:#fff;display:grid;grid-template-columns:repeat(5,max-content);gap:12px}
        figure{margin:0}.pair{display:flex;flex-direction:column;gap:6px}.d,.l{display:flex;align-items:flex-end;gap:6px;padding:8px;border-radius:8px}.d{background:#0b1221}.l{background:#f3f4f6}
        figcaption{margin-top:4px}</style></head><body>${cells}</body></html>`;
      fs.writeFileSync(preview, await render(send, sleep, html, 1000, 760));
    }
  });
  console.log(`cursors written to ${path.relative(ROOT, CSS_OUT)}${preview ? ` · preview ${preview}` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
