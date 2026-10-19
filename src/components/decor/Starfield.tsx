/* Starfield — the fixed full-viewport canvas behind the whole app.

   Two layers of light:
     · stars      low-density, silver / mint tinted; a few carry a tiny cross glint. Drawn once into an
                  offscreen "static layer" and blitted each frame; only the few that twinkle (and the
                  glints) are redrawn on top.
     · fireflies  soft glowing particles from a pre-rendered radial-gradient sprite, drifting on
                  smooth sine-wander paths, pulsing slowly, wrapping at the edges.
   萨姆 mode adds an extremely faint diagonal plating grid + scanlines to the static layer and fewer
   fireflies.

   Everything is deterministic (mulberry32): star i and firefly i always have the same look and
   position (in unit coordinates), so a resize never reshuffles the sky.

   Budget: DPR capped at 1.5, ~30 fps through requestAnimationFrame with frame skipping, paused while
   the tab is hidden, debounced resize. Reduced motion (or particles "off"): one static frame, no loop. */
import { useEffect, useRef } from 'react';
import { usePageVisible, useReducedMotion } from '../../lib/hooks';
import type { ParticleDensity, VisualMode } from '../../lib/types';
import { useApp } from '../../state/store';

/* ───────────── deterministic data ───────────── */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Silver and mint-tinted star colours [r, g, b]. */
const STAR_TINTS: ReadonlyArray<readonly [number, number, number]> = [
  [214, 226, 236],
  [172, 240, 226],
];
/** Firefly-green and mint [r, g, b] + the pale core colour of each sprite. */
const FLY_TINTS: ReadonlyArray<{ rgb: readonly [number, number, number]; core: string }> = [
  { rgb: [181, 242, 107], core: 'rgb(244, 255, 214)' },
  { rgb: [95, 227, 200], core: 'rgb(230, 255, 248)' },
];

interface StarSeed {
  u: number; v: number;     // unit position
  r: number;                // radius, css px
  a: number;                // base alpha
  tint: 0 | 1;
  glint: boolean;
  twinkle: boolean;
  period: number;           // s
  phase: number;            // rad
}
interface FlySeed {
  u: number; v: number;
  radius: number;           // glow radius, css px (10–18); the core is ~0.14 of it
  speed: number;            // px/s base (9–18); modulated ±11 % → 8–20
  heading: number;          // base direction, rad
  a1: number; w1: number; p1: number;   // wander terms (angle noise)
  a2: number; w2: number; p2: number;
  sw: number; sp: number;               // slow speed modulation
  period: number;           // s (3–7)
  phase: number;
  peak: number;             // brightest alpha (0.45–0.65)
  tint: 0 | 1;
}

const MAX_STARS = 1800;
const MAX_FLIES = 48;
let starPool: StarSeed[] | undefined;
let flyPool: FlySeed[] | undefined;

function getStarPool(): StarSeed[] {
  if (starPool) return starPool;
  const rnd = mulberry32(0x0f1ef1e5);
  const pool: StarSeed[] = [];
  for (let i = 0; i < MAX_STARS; i++) {
    const glint = i % 19 === 7;
    const size = Math.pow(rnd(), 2.4);               // most stars are tiny
    pool.push({
      u: rnd(),
      v: rnd(),
      r: glint ? 0.9 + rnd() * 0.5 : 0.4 + size * 1.0,
      a: glint ? 0.8 + rnd() * 0.15 : 0.25 + (0.15 * size + 0.4 * rnd()),   // 0.25–0.8
      tint: rnd() < 0.34 ? 1 : 0,
      glint,
      twinkle: glint || rnd() < 0.3,
      period: 5 + rnd() * 8,
      phase: rnd() * Math.PI * 2,
    });
  }
  starPool = pool;
  return pool;
}

function getFlyPool(): FlySeed[] {
  if (flyPool) return flyPool;
  const rnd = mulberry32(0xb33f1e5);
  const pool: FlySeed[] = [];
  for (let i = 0; i < MAX_FLIES; i++) {
    const near = rnd();                               // bigger = nearer = a little faster and brighter
    pool.push({
      u: rnd(),
      v: rnd(),
      radius: 10 + near * 8,
      speed: 9 + 9 * (near * 0.6 + rnd() * 0.4),
      heading: rnd() * Math.PI * 2,
      a1: 0.7 + rnd() * 0.5, w1: 0.12 + rnd() * 0.2, p1: rnd() * Math.PI * 2,
      a2: 0.25 + rnd() * 0.3, w2: 0.35 + rnd() * 0.4, p2: rnd() * Math.PI * 2,
      sw: 0.1 + rnd() * 0.2, sp: rnd() * Math.PI * 2,
      period: 3 + rnd() * 4,
      phase: rnd() * Math.PI * 2,
      peak: 0.45 + 0.2 * (near * 0.5 + rnd() * 0.5),
      tint: rnd() < 0.72 ? 0 : 1,                     // mostly firefly-green
    });
  }
  flyPool = pool;
  return pool;
}

/* ───────────── configuration ───────────── */

const FLY_COUNT: Record<VisualMode, Record<ParticleDensity, number>> = {
  firefly: { off: 0, low: 12, normal: 28 },
  sam: { off: 0, low: 6, normal: 12 },
};
/** One star per this many css px². */
const STAR_AREA: Record<ParticleDensity, number> = { off: 9000, low: 12000, normal: 9000 };
const FRAME_MS = 1000 / 30 - 4;      // rAF at 60/120/144 Hz → ~30 fps
const DPR_CAP = 1.5;
const GLINT_PX = 15;                  // css size of the cross-glint sprite

/* ───────────── sprites ───────────── */

function makeCanvas(w: number, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Firefly sprite: pale core → colour → transparent. The sprite spans the glow diameter; the core is
 *  ~14 % of the radius, i.e. 1.4–2.5 px for the 10–18 px glow range. */
function makeFlySprite(rgb: readonly [number, number, number], core: string) {
  const S = 96;
  const c = makeCanvas(S);
  const g = c.getContext('2d')!;
  const [r, gg, b] = rgb;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, core);
  grad.addColorStop(0.07, core);
  grad.addColorStop(0.15, `rgba(${r}, ${gg}, ${b}, 0.95)`);
  grad.addColorStop(0.26, `rgba(${r}, ${gg}, ${b}, 0.42)`);
  grad.addColorStop(0.45, `rgba(${r}, ${gg}, ${b}, 0.14)`);
  grad.addColorStop(0.72, `rgba(${r}, ${gg}, ${b}, 0.035)`);
  grad.addColorStop(1, `rgba(${r}, ${gg}, ${b}, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return c;
}

/** Cross-glint sprite for the brighter stars: soft dot + four fading arms. */
function makeGlintSprite(rgb: readonly [number, number, number]) {
  const S = 48;
  const c = makeCanvas(S);
  const g = c.getContext('2d')!;
  const [r, gg, b] = rgb;
  const h = S / 2;
  const arm = (horizontal: boolean) => {
    const grad = horizontal ? g.createLinearGradient(0, 0, S, 0) : g.createLinearGradient(0, 0, 0, S);
    grad.addColorStop(0, `rgba(${r}, ${gg}, ${b}, 0)`);
    grad.addColorStop(0.5, `rgba(${r}, ${gg}, ${b}, 0.9)`);
    grad.addColorStop(1, `rgba(${r}, ${gg}, ${b}, 0)`);
    g.fillStyle = grad;
    if (horizontal) g.fillRect(0, h - 1.1, S, 2.2); else g.fillRect(h - 1.1, 0, 2.2, S);
  };
  arm(true);
  arm(false);
  const halo = g.createRadialGradient(h, h, 0, h, h, h * 0.5);
  halo.addColorStop(0, `rgba(255, 255, 255, 1)`);
  halo.addColorStop(0.3, `rgba(${r}, ${gg}, ${b}, 0.7)`);
  halo.addColorStop(1, `rgba(${r}, ${gg}, ${b}, 0)`);
  g.fillStyle = halo;
  g.fillRect(0, 0, S, S);
  return c;
}

let spriteCache: { fly: HTMLCanvasElement[]; glint: HTMLCanvasElement[] } | undefined;
function getSprites() {
  if (!spriteCache) {
    spriteCache = {
      fly: FLY_TINTS.map((t) => makeFlySprite(t.rgb, t.core)),
      glint: STAR_TINTS.map((t) => makeGlintSprite(t)),
    };
  }
  return spriteCache;
}

/* ───────────── scene ───────────── */

interface Fly { seed: FlySeed; x: number; y: number }

interface Scene {
  /** Move on `dt` seconds; `t` is the scene clock in seconds. */
  step(dt: number, t: number): void;
  /** Draw one frame. */
  draw(t: number): void;
  resize(): void;
  destroy(): void;
}

interface SceneOptions {
  canvas: HTMLCanvasElement;
  mode: VisualMode;
  particles: ParticleDensity;
  /** Reduced motion: a dimmer, frozen frame. */
  reduced: boolean;
  /** Stars twinkle only when something is animating. */
  twinkle: boolean;
  /** A wallpaper is showing: it brings its own sky, so stars thin out and fewer fireflies drift over it. */
  wallpaper: boolean;
}

function createScene({ canvas, mode, particles, reduced, twinkle, wallpaper }: SceneOptions): Scene | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const sprites = getSprites();
  const stars = getStarPool();
  const flyPoolAll = getFlyPool();
  const layer = makeCanvas(1);
  const layerCtx = layer.getContext('2d')!;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let flies: Fly[] = [];
  /** Stars redrawn every frame (twinkling + glints); everything else lives in the static layer. */
  let live: StarSeed[] = [];

  const starDim = reduced ? 0.85 : 1;
  const flyDim = reduced ? 0.7 : 1;

  /** 萨姆: faint diagonal plating seams + scanlines, composited at alpha ≤ 0.034 in one pass so
   *  crossings never add up. */
  function paintPlating(target: CanvasRenderingContext2D) {
    const g = makeCanvas(layer.width, layer.height);
    const gc = g.getContext('2d')!;
    gc.setTransform(dpr, 0, 0, dpr, 0, 0);
    gc.strokeStyle = 'rgb(140, 236, 214)';
    gc.fillStyle = 'rgb(140, 236, 214)';
    gc.lineWidth = 1;
    const step = 72;
    gc.setLineDash([46, 9, 5, 9]);
    gc.beginPath();
    for (let k = -h; k < w; k += step) { gc.moveTo(k, 0); gc.lineTo(k + h, h); }
    for (let k = 0; k < w + h; k += step * 2) { gc.moveTo(k, 0); gc.lineTo(k - h, h); }
    gc.stroke();
    gc.setLineDash([]);
    for (let y = 0; y < h; y += 4) gc.fillRect(0, y, w, 0.5);
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = 0.033;
    target.drawImage(g, 0, 0);
    target.restore();
  }

  function paintStatic() {
    layer.width = Math.max(1, Math.round(w * dpr));
    layer.height = Math.max(1, Math.round(h * dpr));
    layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layerCtx.clearRect(0, 0, w, h);
    if (mode === 'sam') paintPlating(layerCtx);

    const count = Math.min(MAX_STARS, Math.round(((w * h) / STAR_AREA[particles]) * (wallpaper ? 0.3 : 1)));
    live = [];
    const glintPx = GLINT_PX;
    for (let i = 0; i < count; i++) {
      const s = stars[i];
      const animated = twinkle && s.twinkle;
      if (animated) { live.push(s); continue; }
      const x = s.u * w;
      const y = s.v * h;
      if (s.glint) {
        layerCtx.globalAlpha = s.a * 0.9 * starDim;
        layerCtx.drawImage(sprites.glint[s.tint], x - glintPx / 2, y - glintPx / 2, glintPx, glintPx);
      } else {
        const [r, g, b] = STAR_TINTS[s.tint];
        layerCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(s.a * starDim).toFixed(3)})`;
        layerCtx.beginPath();
        layerCtx.arc(x, y, s.r, 0, Math.PI * 2);
        layerCtx.fill();
      }
    }
    layerCtx.globalAlpha = 1;
  }

  function buildFlies(prevW: number, prevH: number) {
    const area = w * h;
    const k = Math.min(1.5, Math.max(0.6, area / (1440 * 900)));
    const n = particles === 'off' ? 0 : Math.min(MAX_FLIES, Math.round(FLY_COUNT[mode][particles] * k * (wallpaper ? 0.75 : 1)));
    const next: Fly[] = [];
    for (let i = 0; i < n; i++) {
      const old = flies[i];
      if (old && prevW > 0 && prevH > 0) {
        next.push({ seed: old.seed, x: (old.x / prevW) * w, y: (old.y / prevH) * h });   // keep the field's shape
      } else {
        const seed = flyPoolAll[i];
        next.push({ seed, x: seed.u * w, y: seed.v * h });
      }
    }
    flies = next;
  }

  function resize() {
    const prevW = w;
    const prevH = h;
    w = Math.max(1, window.innerWidth);
    h = Math.max(1, window.innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    paintStatic();
    buildFlies(prevW, prevH);
  }

  function step(dt: number, t: number) {
    for (const f of flies) {
      const s = f.seed;
      const ang = s.heading + s.a1 * Math.sin(s.w1 * t + s.p1) + s.a2 * Math.sin(s.w2 * t + s.p2);
      const sp = s.speed * (1 + 0.11 * Math.sin(s.sw * t * 6 + s.sp));   // stays within ~8–20 px/s
      f.x += Math.cos(ang) * sp * dt;
      f.y += Math.sin(ang) * sp * dt;
      const m = s.radius;
      if (f.x < -m) f.x = w + m; else if (f.x > w + m) f.x = -m;
      if (f.y < -m) f.y = h + m; else if (f.y > h + m) f.y = -m;
    }
  }

  function draw(t: number) {
    ctx!.setTransform(1, 0, 0, 1, 0, 0);
    ctx!.globalAlpha = 1;
    ctx!.clearRect(0, 0, canvas.width, canvas.height);
    ctx!.drawImage(layer, 0, 0);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

    // twinkling stars and glints
    for (const s of live) {
      const pulse = 0.68 + 0.32 * Math.sin((t * Math.PI * 2) / s.period + s.phase);
      const a = s.a * pulse;
      const x = s.u * w;
      const y = s.v * h;
      if (s.glint) {
        ctx!.globalAlpha = a * 0.9;
        const px = GLINT_PX * (0.9 + 0.1 * pulse);
        ctx!.drawImage(sprites.glint[s.tint], x - px / 2, y - px / 2, px, px);
      } else {
        const [r, g, b] = STAR_TINTS[s.tint];
        ctx!.globalAlpha = a;
        ctx!.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx!.beginPath();
        ctx!.arc(x, y, s.r, 0, Math.PI * 2);
        ctx!.fill();
      }
    }

    // fireflies
    for (const f of flies) {
      const s = f.seed;
      const breath = 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / s.period + s.phase);
      const a = (0.25 + (s.peak - 0.25) * breath) * flyDim;
      const R = s.radius * (0.92 + 0.08 * breath);
      ctx!.globalAlpha = a;
      ctx!.drawImage(sprites.fly[s.tint], f.x - R, f.y - R, R * 2, R * 2);
    }
    ctx!.globalAlpha = 1;
  }

  resize();
  return { step, draw, resize, destroy() { flies = []; live = []; } };
}

/* ───────────── component ───────────── */

interface Controller { setPaused(paused: boolean): void }

export function Starfield() {
  const mode = useApp((s) => s.settings.mode);
  const particles = useApp((s) => s.settings.particles);
  const wallpaper = useApp((s) => s.settings.wallpaper);
  const reduced = useReducedMotion();
  const visible = usePageVisible();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controller = useRef<Controller | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Animated = full motion and fireflies not switched off. Otherwise: one static frame.
    const animated = !reduced && particles !== 'off';
    const scene = createScene({ canvas, mode, particles, reduced, twinkle: animated, wallpaper });
    if (!scene) return;

    let raf = 0;
    let t = 0;
    let last = Number.NaN;
    let paused = !visibleRef.current;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (Number.isNaN(last)) { last = now; return; }
      const elapsed = now - last;
      if (elapsed < FRAME_MS) return;
      last = now;
      if (document.documentElement.dataset.boot === 'on') return;   // hidden under the 开机动画
      const dt = Math.min(elapsed / 1000, 0.1);
      t += dt;
      scene.step(dt, t);
      scene.draw(t);
    };
    const start = () => {
      if (!animated || paused || raf) return;
      last = Number.NaN;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    scene.draw(0);
    start();
    controller.current = {
      setPaused(p) {
        paused = p;
        if (p) stop(); else start();
      },
    };

    // Debounced resize: rebuild the static layer, then repaint immediately (also covers the static frame).
    let timer = 0;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { scene.resize(); scene.draw(t); }, 160);
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(timer);
      stop();
      scene.destroy();
      controller.current = null;
    };
  }, [mode, particles, reduced, wallpaper]);

  // Pause the loop completely while the tab is hidden.
  useEffect(() => { controller.current?.setPaused(!visible); }, [visible]);

  return <canvas ref={canvasRef} className="starfield" aria-hidden="true" />;
}
