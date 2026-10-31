/* The figure as a puppet ("pseudo Live2D", docs/PET.md §8): one picture per pose, bent in WebGL so she breathes,
   sways, blinks, moves her mouth with her voice and her hair lags when she is dragged. Without WebGL2 (or a rig,
   or if the pictures cannot be read) it falls back to <Sprite>, the plain picture switcher. A lost GPU context
   (driver reset, resume from sleep) falls back too, and tries again with a fresh canvas a few times. */
import { memo, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { VisualMode } from '../../lib/types';
import { Blinker, Babble, Lag, MouthEnvelope, breath, mouthTarget, sway } from './puppet/motion';
import { PuppetGL, type Frame, type PoseTex } from './puppet/gl';
import { parseRig, rigPose, type PuppetPose } from './puppet/rig';
import RIGS from './puppet/rigs.json';
import { Sprite, type PetPose } from './Sprite';

/** What the window tells the puppet every frame (a ref, so it never re-renders at frame rate). */
export interface PuppetInput {
  /** Her voice is playing: the mouth follows its level. */
  speaking: boolean;
  /** A line is shown without a voice: the mouth babbles. */
  babble: boolean;
  /** Loudness of the voice right now (RMS, 0 when silent). */
  level(): number;
  /** The last drag speed (screen px per ms) and when it was measured (performance.now()). */
  vx: number;
  vxAt: number;
}

/** A pose change crossfades for this long. */
const FADE_MS = 160;
/** Between frames when nothing quick is happening (breathing alone is fine at ~30 fps). */
const IDLE_FRAME_MS = 32;
/** Between frames while she talks, blinks or is dragged: about 60 fps, even on a 144 Hz screen. */
const QUICK_FRAME_MS = 15;
/** After a lost GPU context: at most this many fresh tries within RETRY_WINDOW_MS. */
const RETRIES = 5;
const RETRY_WINDOW_MS = 5 * 60_000;

const url = (mode: VisualMode, name: string) => `./pet/${mode}/${name}.png`;

function load(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  return img.decode().then(() => img);
}

export const Puppet = memo(function Puppet({ mode, pose, fallback, input }: {
  mode: VisualMode;
  pose: PuppetPose;
  /** The picture the plain switcher would show (it has its own blink / talk frames). */
  fallback: PetPose;
  input: MutableRefObject<PuppetInput>;
}) {
  const rig = useMemo(() => parseRig((RIGS as Record<string, unknown>)[mode]), [mode]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const poseRef = useRef(pose);
  poseRef.current = pose;
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  /** Bumped to try again on a fresh canvas (a canvas keeps its lost context). */
  const [gen, setGen] = useState(0);
  const losses = useRef<number[]>([]);
  const retry = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** A fresh canvas after a lost context is being tried and has not drawn yet: the GPU process may still be coming back,
   *  so a canvas that gives no WebGL2 yet counts as another loss (and is tried again) instead of ending it all. */
  const retrying = useRef(false);
  useEffect(() => () => clearTimeout(retry.current), []);

  useEffect(() => {
    const c = canvas.current;
    if (!rig || failed || !c) return;
    let alive = true;
    /** Give up on this canvas. `lost`: the GPU context went away, which usually comes back, so try again later. */
    const fail = (lost: boolean) => {
      if (!alive) return;
      alive = false;
      setReady(false);
      setFailed(true);
      if (!lost) return;
      const now = Date.now();
      losses.current = [...losses.current.filter((t) => now - t < RETRY_WINDOW_MS), now];
      if (losses.current.length > RETRIES) return;
      clearTimeout(retry.current);
      retry.current = setTimeout(() => { retrying.current = true; setFailed(false); setGen((g) => g + 1); }, 1500 * losses.current.length);
    };
    const gl = PuppetGL.create(c);
    if (!gl) { fail(retrying.current); return; }
    const lost = (e: Event) => { e.preventDefault(); fail(true); };
    c.addEventListener('webglcontextlost', lost);

    /* ── pictures → textures at about the canvas size ── */
    const names = new Set<string>();
    for (const p of Object.values(rig.poses)) {
      if (!p) continue;
      names.add(p.weights);
      if (p.blink) names.add(p.blink);
      if (p.talk) names.add(p.talk);
    }
    const poses = Object.keys(rig.poses) as PuppetPose[];
    poses.forEach((p) => names.add(p));
    const images = new Map<string, HTMLImageElement>();
    let tex: Partial<Record<PuppetPose, PoseTex>> | null = null;
    let texSize = 0;
    /** The size of the newest build asked for (0 = none in flight). */
    let wantSize = 0;
    let building = 0;
    const loaded = Promise.all([...names].map((n) => load(url(mode, n)).then((img) => { images.set(n, img); })));

    const build = async (px: number) => {
      const size = Math.max(96, Math.min(rig.size, Math.ceil(px * 1.25)));
      const near = wantSize || texSize;
      if (near && Math.abs(size - near) / near < 0.15) {
        // Back near the size we already have while a build for another size runs: that build is not needed.
        if (wantSize && texSize && Math.abs(size - texSize) / texSize < 0.15) { building++; wantSize = 0; }
        return;
      }
      wantSize = size;
      const job = ++building;
      const made = new Map<string, WebGLTexture>();
      try {
        await loaded;
        for (const [name, img] of images) {
          // Weight maps are data: no resampling beyond their own size, no colour management, no premultiply.
          const data = name.startsWith('w-');
          const bmp = data
            ? await createImageBitmap(img, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
            : await createImageBitmap(img, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high', premultiplyAlpha: 'premultiply' });
          if (!alive || job !== building) { bmp.close(); made.forEach((t) => gl.drop(t)); return; }
          made.set(name, gl.texture(bmp));
          bmp.close();
        }
      } catch {
        made.forEach((t) => gl.drop(t));
        if (job === building) wantSize = 0;
        if (!tex) fail(false);
        return;
      }
      const next: Partial<Record<PuppetPose, PoseTex>> = {};
      for (const p of poses) {
        const r = rig.poses[p]!;
        next[p] = { base: made.get(p)!, weights: made.get(r.weights)!, blink: r.blink ? made.get(r.blink) : undefined, talk: r.talk ? made.get(r.talk) : undefined };
      }
      const old = tex;
      tex = next;
      texSize = size;
      wantSize = 0;
      rested = false;
      if (old) for (const t of Object.values(old)) { gl.drop(t?.base); gl.drop(t?.weights); gl.drop(t?.blink); gl.drop(t?.talk); }
      if (alive) { retrying.current = false; setReady(true); }
    };

    /* ── size: the drawing buffer follows the element in device pixels (page zoom and DPI included) ── */
    // Resizing clears the buffer, and observers run after this frame's draw: the resize is applied in the next
    // tick, which draws right away, so no frame is shown empty.
    let pendingPx = 0;
    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      const box = e.devicePixelContentBoxSize?.[0];
      const px = Math.round(box ? box.inlineSize : e.contentRect.width * devicePixelRatio);
      if (px < 8) return;
      pendingPx = px;
      void build(px);
    });
    try { ro.observe(c, { box: 'device-pixel-content-box' }); } catch { ro.observe(c); }

    /* ── the loop ── */
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const blinker = new Blinker(performance.now());
    const env = new MouthEnvelope();
    const babble = new Babble();
    const lag = new Lag();
    let cur: PuppetPose | null = null;
    let prev: PuppetPose | null = null;
    let fadeStart = 0;
    let last = performance.now();
    let lastDraw = 0;
    let lastVxAt = 0;
    /** The last frame drawn was the still picture (reduced motion, nothing moving) and nothing changed since. */
    let rested = false;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // While something moves quickly every display frame is used (capped near 60 fps); otherwise the loop sleeps
    // on a timer between frames instead of waking at the display's rate only to skip.
    const later = (quick: boolean, now: number) => {
      if (!alive) return;
      if (quick) raf = requestAnimationFrame(tick);
      else timer = setTimeout(() => { raf = requestAnimationFrame(tick); }, Math.max(0, IDLE_FRAME_MS - (performance.now() - now) - 4));
    };
    const tick = (now: number) => {
      if (!alive) return;
      const t = tex;
      if (!t) { later(false, now); return; }
      if (gl.lost) { fail(true); return; }
      const dt = Math.min(100, Math.max(0, now - last));
      last = now;
      const inp = input.current;
      const want = rigPose(rig, poseRef.current);
      if (want !== cur) {
        // A change in the middle of a crossfade starts from whichever picture is showing more.
        const midway = prev !== null && (now - fadeStart) / FADE_MS < 0.5;
        prev = midway ? prev : cur;
        cur = want;
        fadeStart = now;
        blinker.reset(now, 400);
        rested = false;
      }
      if (inp.vxAt !== lastVxAt) { lastVxAt = inp.vxAt; lag.push(inp.vx, inp.vxAt); }
      const lagV = lag.step(now, dt);
      const target = inp.speaking ? mouthTarget(inp.level()) : inp.babble ? babble.level(now) : 0;
      const mouth = env.step(target, dt);
      const blink = t[cur!]?.blink ? blinker.amount(now) : 0;
      const fading = prev !== null && now - fadeStart < FADE_MS;
      const m = reduce?.matches ? 0 : 1;
      const quick = mouth > 0 || blink > 0 || fading || (m > 0 && !lag.settled) || inp.speaking || inp.babble;
      const resized = pendingPx > 0;
      if (resized) { gl.resize(pendingPx); pendingPx = 0; rested = false; }
      const due = resized || now - lastDraw >= (quick ? QUICK_FRAME_MS : IDLE_FRAME_MS - 4);
      if (due && !(rested && !quick)) {
        lastDraw = now;
        if (!fading) prev = null;
        const a = rig.amp;
        const frame: Frame = {
          fade: fading ? (now - fadeStart) / FADE_MS : 1,
          blink,
          mouth,
          breath: a.breath * breath(now) * m,
          tilt: (a.tilt * Math.PI / 180) * sway(now, 7300) * m,
          hairAmp: a.hair * (0.7 + 0.3 * sway(now, 11_000, 1.3)) * m,
          // Kept within one turn: a float32 uniform loses precision as page time grows over days.
          hairPhase: ((now / 2900) % 1) * Math.PI * 2,
          lag: lagV * Math.max(a.hair, a.accent) * 1.6 * m,
          accent: a.accent * sway(now, 1900, 0.6) * m,
        };
        const curTex = t[cur!];
        if (curTex) gl.draw(rig, curTex, prev ? t[prev] ?? null : null, frame);
        // With motion reduced and nothing moving, the next frame would be the same picture: do not draw it.
        rested = m === 0 && !quick;
      }
      later(quick, now);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      ro.disconnect();
      c.removeEventListener('webglcontextlost', lost);
      gl.dispose();
    };
  }, [mode, rig, failed, gen, input]);

  if (!rig || failed) return <Sprite mode={mode} pose={fallback} />;
  return (
    <>
      {!ready && <Sprite mode={mode} pose={fallback} />}
      <canvas key={gen} ref={canvas} className="pet-puppet" data-ready={ready ? '' : undefined} aria-hidden />
    </>
  );
});
