/* Character wallpaper under the starfield.
   Each wallpaper is one self-contained layer: blurred 48px preview → the full image (AVIF/WebP, width
   picked by the browser) → its own tint → a night grade whose opacity is the inverse of 壁纸可见度
   (→ scanlines for 萨姆). Shared edge shading sits on top where the nav, status panel and console are.
   The starfield's fireflies drift above all of it.
   It also publishes the transparency variables the glass panels read:
     --wp-dim     grade opacity (how much the wallpaper is dimmed)
     --glass-a    panel surface alpha
     --glass-dim  brightness applied to whatever shows through a panel (keeps text contrast)
   Switching 流萤 ⇄ 萨姆 crossfades whole layers (look included). Layers keep a fixed order and fade by
   class, so switching back mid-fade simply reverses. The other mode's layer is mounted, hidden, once
   the browser is idle, so its image is already loaded when you switch. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ViewId } from '../../lib/types';
import { useApp } from '../../state/store';
import { cx } from '../ui';
import { WALLPAPERS, wallpaperFor, type WallpaperDef } from './wallpapers';

/** 自动调节: the welcome page shows the art fully; dense pages dim it slightly. */
const VIEW_SHIFT: Record<ViewId, number> = {
  new: -0.08, tasks: 0, task: 0.06, agents: 0.03, tools: 0.04, models: 0.04, history: 0.05, settings: 0,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The faintest grey on the art: #adbac6 at 稳重, moving 70% of the way to --text-2 (#c3cfd8) at 通透. */
function faintGrey(halo: number) {
  const from = [0xad, 0xba, 0xc6];
  const to = [0xc3, 0xcf, 0xd8];
  const t = 0.7 * halo;
  return `rgb(${from.map((c, i) => Math.round(c + (to[i] - c) * t)).join(' ')})`;
}

/** Grade opacity from 壁纸可见度 (0–100) and the current page. */
export function wallpaperDim(visibility: number, view: ViewId, adaptive: boolean) {
  const base = 0.62 - 0.6 * (visibility / 100);           // 0 → .62 (faint), 80 → .14, 100 → .02 (as painted)
  return clamp(base + (adaptive ? VIEW_SHIFT[view] : 0), 0, 0.9);
}

/** Clear smoked glass. Legibility no longer comes from darkening whole panels: every glyph carries a
 *  dark halo (see app.css --text-halo), so panels can stay thin and the art shows through them.
 *  - 面板通透度 (0–100) sets the tint alpha .80 (稳重) … .45 (通透) and the blur 20px … 10px, so at the
 *    clear end she is still recognisable through a panel; the text halo strengthens as panels clear.
 *  - The brightness applied to what shows through keeps the light reaching a panel at a fixed share of
 *    the raw art (`reach`), so 壁纸可见度 changes the gaps but not the panels. */
export function glassFor(glass: number, dim: number) {
  const p = glass / 100;
  const reach = 0.6 + 0.1 * p;                                // share of the raw art that reaches a panel
  return { alpha: 0.8 - 0.35 * p, blur: 20 - 10 * p, halo: p, dim: clamp(reach / (1 - dim), 0.06, 1) };
}

export function Wallpaper() {
  const on = useApp((s) => s.settings.wallpaper);
  const mode = useApp((s) => s.settings.mode);
  const visibility = useApp((s) => s.settings.wallpaperVisibility);
  const glass = useApp((s) => s.settings.panelGlass);
  const adaptive = useApp((s) => s.settings.wallpaperAdaptive);
  const view = useApp((s) => s.view);
  const current = wallpaperFor(mode).id;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.wallpaper = on ? 'on' : 'off';
    const dim = wallpaperDim(visibility, view, adaptive);
    const g = glassFor(glass, dim);
    root.style.setProperty('--wp-dim', dim.toFixed(3));
    root.style.setProperty('--glass-a', g.alpha.toFixed(3));
    root.style.setProperty('--glass-dim', g.dim.toFixed(3));
    root.style.setProperty('--glass-blur', `${g.blur.toFixed(1)}px`);
    root.style.setProperty('--halo-k', g.halo.toFixed(2));
    root.style.setProperty('--text-3-wp', faintGrey(g.halo));
  }, [on, visibility, glass, adaptive, view]);

  // The other mode's layer joins (hidden) when the browser is idle; once mounted, a layer stays.
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    if (!on || warm) return;
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) {
      const h = idle(() => setWarm(true), { timeout: 5000 });
      return () => (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(h);
    }
    const t = window.setTimeout(() => setWarm(true), 2500);
    return () => window.clearTimeout(t);
  }, [on, warm]);

  if (!on) return null;
  return (
    <div className="wallpaper" aria-hidden="true">
      {WALLPAPERS.filter((w) => warm || w.id === current).map((w) => <Layer key={w.id} def={w} active={w.id === current} />)}
      <div className="wallpaper__edges" />
    </div>
  );
}

function Layer({ def, active }: { def: WallpaperDef; active: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  // A cached image can finish before React attaches onLoad.
  useEffect(() => { if (img.current?.complete && img.current.naturalWidth > 0) setLoaded(true); }, []);
  const base = import.meta.env.BASE_URL;
  const srcSet = (ext: string) => def.widths.map((w) => `${base}wallpapers/${def.id}-${w}.${ext} ${w}w`).join(', ');
  return (
    <div className={cx('wallpaper__layer', `wallpaper__layer--${def.id}`, active && 'is-active', loaded && 'is-loaded')}>
      <div className="wallpaper__lqip" style={{ backgroundImage: `url("${def.lqip}")`, backgroundPosition: def.focus }} />
      <picture>
        <source type="image/avif" srcSet={srcSet('avif')} sizes="100vw" />
        <source type="image/webp" srcSet={srcSet('webp')} sizes="100vw" />
        <img
          ref={img}
          className="wallpaper__img"
          src={`${base}wallpapers/${def.id}-2560.webp`}
          alt=""
          decoding="async"
          draggable={false}
          style={{ objectPosition: def.focus }}
          onLoad={() => setLoaded(true)}
        />
      </picture>
      <div className="wallpaper__tint" />
      <div className="wallpaper__grade" />
    </div>
  );
}
