// After `vite build`: the glass needs an unprefixed backdrop-filter on .panel in the shipped CSS.
// (A hand-written -webkit- line next to it once made the minifier drop the standard property.)
// Also the 桌宠's two extra pages must have been built: dist/pet.html (the pet window) and
// dist/capture.html (the hidden capture page), each with its script, and the sprites copied.
import fs from 'node:fs';
const dist = new URL('../dist/', import.meta.url);
const dir = new URL('assets/', dist);
const css = fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(new URL(f, dir), 'utf8')).join('\n');
const panelRules = css.match(/\.panel\{[^}]*\}/g) ?? [];
const ok = panelRules.some((r) => /(^|[;{])backdrop-filter:/.test(r));
const wall = fs.existsSync(new URL('../dist/wallpapers/firefly-2560.avif', import.meta.url));
let good = ok && wall;
const report = (pass, text) => { console.log(`${pass ? '  ok ' : '  FAIL'} ${text}`); if (!pass) good = false; };
console.log(`${ok ? '  ok ' : '  FAIL'} built .panel keeps unprefixed backdrop-filter`);
console.log(`${wall ? '  ok ' : '  FAIL'} wallpapers copied to dist/`);

for (const [page, what] of [['pet.html', '桌宠窗口'], ['capture.html', '画面采集页']]) {
  const file = new URL(page, dist);
  const html = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  report(!!html, `dist/${page} was built (${what})`);
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  report(scripts.length > 0 && scripts.every((s) => fs.existsSync(new URL(s, dist))), `dist/${page} loads a script that exists`);
  report(/Content-Security-Policy/.test(html) && /script-src 'self'/.test(html), `dist/${page} carries the content security policy`);
}
// The hidden page must not pull in the app's React bundle: it only has to judge pictures.
const capture = fs.existsSync(new URL('capture.html', dist)) ? fs.readFileSync(new URL('capture.html', dist), 'utf8') : '';
const captureJs = [...capture.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => fs.existsSync(new URL(m[1], dist)) ? fs.readFileSync(new URL(m[1], dist), 'utf8') : '').join('');
report(captureJs.length > 0 && captureJs.length < 60_000 && /__petCapture/.test(captureJs), 'the capture page is small and exposes its start hook');
const pet = fs.existsSync(new URL('pet.html', dist)) ? fs.readFileSync(new URL('pet.html', dist), 'utf8') : '';
report(/\.css"/.test(pet), 'dist/pet.html has its stylesheet');
// Missing art is not an error: the pet draws a stand-in until public/pet/<mode>/*.png exists.
for (const mode of ['firefly', 'sam']) {
  const have = fs.existsSync(new URL(`pet/${mode}/idle.png`, dist));
  console.log(`  ${have ? 'ok ' : 'note'} ${have ? `the ${mode} sprites are copied to dist/pet/` : `no ${mode} sprites in public/pet/: the pet shows its drawn stand-in`}`);
}
// The puppet (src/pet/ui/puppet/rigs.json, from scripts/pet-rig.py) names pictures that must all have been shipped;
// a missing one would leave the puppet blank instead of falling back.
const rigs = JSON.parse(fs.readFileSync(new URL('../src/pet/ui/puppet/rigs.json', import.meta.url), 'utf8'));
for (const [mode, rig] of Object.entries(rigs)) {
  const files = Object.entries(rig.poses).flatMap(([pose, e]) => [pose, e.weights, e.blink, e.talk].filter(Boolean));
  const missing = files.filter((f) => !fs.existsSync(new URL(`pet/${mode}/${f}.png`, dist)));
  report(!missing.length, `every picture the ${mode} puppet uses is in dist/pet/${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
}
process.exit(good ? 0 : 1);
