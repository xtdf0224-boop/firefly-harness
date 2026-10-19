/* ConvergenceBurst — the 萤火聚合 completion moment.

   When state.celebration is set (a run just completed), ~26 glowing dots start on a ring around the
   [data-celebrate-target] element, travel to its centre along gentle curves, shrink into the core,
   and bloom: a ring plus a soft flash. ≤ 2.2 s in total, then everything is removed and the
   celebration is cleared. The target is used only while the user is looking at the run that
   completed (task view, that run selected) — otherwise a status chip on screen belongs to some other
   run, so the burst gathers at the centre of #main instead.

   Reduced motion: nothing travels or scales — a static soft ring is shown around the target for
   ~1.4 s. The overlay never takes pointer events or focus and is aria-hidden (completion is already
   announced by the engine's toast and live region). Nodes are built imperatively and animated with
   the Web Animations API so React doesn't re-render for decoration. */
import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../../lib/hooks';
import type { Celebration } from '../../lib/types';
import { actions } from '../../state/actions';
import { currentRun } from '../../state/selectors';
import { store, useApp } from '../../state/store';

const FRESH_MS = 6000;          // ignore celebrations older than this (e.g. restored state)
const DOT_COUNT = 26;
const DOT_SIZE = 20;            // css px of the glowing dot element
const LAND_BY = 1450;           // every dot has landed by now (so the bloom ends ≤ ~2.1 s)
const BLOOM_MS = 700;
const STATIC_RING_MS = 1400;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Anchor { x: number; y: number; w: number; h: number; found: boolean }

/** Is the user looking at the run that just completed? Only then is a status chip on screen "its" chip. */
function isWatching(runId: string): boolean {
  const s = store.get();
  return s.view === 'task' && currentRun(s)?.id === runId;
}

/** With `useTarget`: first visible [data-celebrate-target] (preferring one inside the viewport). Else the centre of #main. */
function findAnchor(useTarget: boolean): Anchor {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let fallback: DOMRect | undefined;
  const targets = useTarget ? Array.from(document.querySelectorAll<HTMLElement>('[data-celebrate-target]')) : [];
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || el.getClientRects().length === 0) continue;
    const inView = r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
    if (inView) return anchorOf(r, true);
    fallback ??= r;
  }
  if (fallback) return anchorOf(fallback, true);
  const main = document.getElementById('main')?.getBoundingClientRect();
  if (main && main.width > 0 && main.height > 0) return anchorOf(main, false);
  return { x: vw / 2, y: vh / 2, w: 0, h: 0, found: false };
}

function anchorOf(r: DOMRect, found: boolean): Anchor {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return {
    x: clamp(r.left + r.width / 2, 24, vw - 24),
    y: clamp(r.top + r.height / 2, 24, vh - 24),
    w: r.width,
    h: r.height,
    found,
  };
}

function el(className: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  return d;
}

/** Point `p` (0..1) along a quadratic curve from a to b bent by `bend` px (perpendicular). */
function curvePoint(ax: number, ay: number, bx: number, by: number, bend: number, p: number): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const cx = (ax + bx) / 2 + (-dy / len) * bend;
  const cy = (ay + by) / 2 + (dx / len) * bend;
  const q = 1 - p;
  return [q * q * ax + 2 * q * p * cx + p * p * bx, q * q * ay + 2 * q * p * cy + p * p * by];
}

export function ConvergenceBurst() {
  const celebration = useApp((s) => s.celebration);
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!celebration || !root) return;
    const c: Celebration = celebration;

    // Stale or invisible: nothing to show, just clear the flag.
    if (Date.now() - c.at > FRESH_MS || document.hidden) {
      actions.clearCelebration();
      return;
    }

    const anchor = findAnchor(isWatching(c.runId));
    const nodes: HTMLElement[] = [];
    const anims: Animation[] = [];
    let timer = 0;

    const finish = () => {
      actions.clearCelebration();
    };

    if (reducedRef.current) {
      // A still, soft ring around the target. No travel, no scale.
      const ring = el('burst__ring burst__ring--static');
      const pad = 8;
      if (anchor.found) {
        ring.style.left = `${anchor.x - anchor.w / 2 - pad}px`;
        ring.style.top = `${anchor.y - anchor.h / 2 - pad}px`;
        ring.style.width = `${anchor.w + pad * 2}px`;
        ring.style.height = `${anchor.h + pad * 2}px`;
      } else {
        ring.style.left = `${anchor.x - 60}px`;
        ring.style.top = `${anchor.y - 60}px`;
        ring.style.width = '120px';
        ring.style.height = '120px';
        ring.classList.add('burst__ring--round');
      }
      root.appendChild(ring);
      nodes.push(ring);
      timer = window.setTimeout(finish, STATIC_RING_MS);
    } else {
      const rnd = mulberry32((c.at ^ 0x9e3779b1) >>> 0);
      const half = DOT_SIZE / 2;
      const cx = anchor.x;
      const cy = anchor.y;
      let landMax = 0;

      for (let i = 0; i < DOT_COUNT; i++) {
        const angle = ((i + (rnd() - 0.5) * 0.7) / DOT_COUNT) * Math.PI * 2;
        const dist = 160 + rnd() * 200;
        const sx = cx + Math.cos(angle) * dist;
        const sy = cy + Math.sin(angle) * dist;
        const dur = Math.round(900 + rnd() * 500);
        const delay = Math.round(rnd() * Math.min(350, LAND_BY - dur));
        const bend = (rnd() < 0.5 ? -1 : 1) * dist * (0.12 + rnd() * 0.16);
        const mint = rnd() < 0.3;
        landMax = Math.max(landMax, delay + dur);

        const dot = el(mint ? 'burst__dot burst__dot--mint' : 'burst__dot');
        root.appendChild(dot);
        nodes.push(dot);

        // Sample the curve so the path stays smooth; opacity/scale ride on the same keyframes.
        const steps = [0, 0.12, 0.3, 0.5, 0.7, 0.88, 1];
        const frames: Keyframe[] = steps.map((p) => {
          const [x, y] = curvePoint(sx, sy, cx, cy, bend, p);
          const scale = p < 0.12 ? 0.4 + (p / 0.12) * 0.6 : p < 0.7 ? 1 : 1 - ((p - 0.7) / 0.3) * 0.8;
          const opacity = p === 0 ? 0 : p < 0.88 ? 1 : p < 1 ? 0.95 : 0;
          return { offset: p, transform: `translate(${(x - half).toFixed(1)}px, ${(y - half).toFixed(1)}px) scale(${scale.toFixed(3)})`, opacity };
        });
        anims.push(dot.animate(frames, { duration: dur, delay, easing: 'cubic-bezier(0.45, 0.05, 0.3, 1)', fill: 'both' }));
      }

      // Bloom at the target as the last dots land: a gathering glow, then a ring and a soft flash.
      const bloomAt = Math.max(900, landMax - 100);
      const ring = el('burst__ring');
      const flash = el('burst__flash');
      root.append(flash, ring);
      nodes.push(flash, ring);
      const place = (node: HTMLElement, size: number) => {
        node.style.left = `${cx - size / 2}px`;
        node.style.top = `${cy - size / 2}px`;
        node.style.width = `${size}px`;
        node.style.height = `${size}px`;
      };
      place(ring, 72);
      place(flash, 160);
      anims.push(ring.animate(
        [{ transform: 'scale(0.3)', opacity: 0.9 }, { transform: 'scale(2.2)', opacity: 0 }],
        { duration: BLOOM_MS, delay: bloomAt, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' },
      ));
      anims.push(flash.animate(
        [
          { transform: 'scale(0.3)', opacity: 0 },
          { transform: 'scale(0.6)', opacity: 0.4, offset: 0.29 },
          { transform: 'scale(1)', opacity: 0.9, offset: 0.4, easing: 'ease-out' },
          { transform: 'scale(1.7)', opacity: 0 },
        ],
        { duration: BLOOM_MS + 150, delay: bloomAt - 250, easing: 'linear', fill: 'forwards' },
      ));
      timer = window.setTimeout(finish, bloomAt + BLOOM_MS + 40);
    }

    return () => {
      window.clearTimeout(timer);
      for (const a of anims) a.cancel();
      for (const n of nodes) n.remove();
    };
  }, [celebration]);

  return <div ref={rootRef} className="burst" aria-hidden="true" />;
}
