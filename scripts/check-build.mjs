// After `vite build`: the glass needs an unprefixed backdrop-filter on .panel in the shipped CSS.
// (A hand-written -webkit- line next to it once made the minifier drop the standard property.)
import fs from 'node:fs';
const dir = new URL('../dist/assets/', import.meta.url);
const css = fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(new URL(f, dir), 'utf8')).join('\n');
const panelRules = css.match(/\.panel\{[^}]*\}/g) ?? [];
const ok = panelRules.some((r) => /(^|[;{])backdrop-filter:/.test(r));
const wall = fs.existsSync(new URL('../dist/wallpapers/firefly-2560.avif', import.meta.url));
console.log(`${ok ? '  ok ' : '  FAIL'} built .panel keeps unprefixed backdrop-filter`);
console.log(`${wall ? '  ok ' : '  FAIL'} wallpapers copied to dist/`);
process.exit(ok && wall ? 0 : 1);
