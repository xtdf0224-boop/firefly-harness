/* Scene analysis for the 桌宠 capture page: pure logic, no DOM, so it can be unit tested in node.
   The page feeds one 64x36 luma thumbnail every ~500 ms (or null when no new frame arrived) and gets back a
   scene event only when the state changes. See docs/PET.md §3.3 (SceneState). */
import type { SceneState } from '../contracts';

export const THUMB_W = 64;
export const THUMB_H = 36;
export const THUMB_LEN = THUMB_W * THUMB_H;

/** What the page emits. `since`: how long (ms) the condition behind the state had held when the event fired
    (static / settled: calm time, black: dark time; motion / cut: 0). `change`: mean abs luma difference, 0..1. */
export interface SceneEvent { state: SceneState; since: number; change: number }

export interface SceneTuning {
  /** A sample with less change than this is "calm" (fraction of full luma scale). */
  calmMad: number;
  /** A still scene with at least this much change is moving again. */
  motionMad: number;
  /** A cut needs both: big mean change and a different 64-bit dHash. */
  cutMad: number;
  cutHamming: number;
  /** Calm time after a cut before 'settled'. */
  settleMs: number;
  /** Calm time before 'static'. */
  staticMs: number;
  /** A cut that never calms down (gameplay right after it) turns into plain motion after this long. */
  cutMaxMs: number;
  /** Very dark and frozen for this long: exclusive fullscreen or a minimized window. */
  blackMs: number;
  /** Dark = mean luma at most this and at most `blackBright` of pixels brighter than BRIGHT_LUMA. Strict: a blank capture
   *  is all but pure black, while a night scene, a fade or a loading screen still has a little light (a HUD, a spinner). */
  blackMean: number;
  blackBright: number;
  /** Leaving black needs the picture to light up a little (hysteresis), or to move at all (a blank capture never does). */
  blackExitMean: number;
  blackExitBright: number;
}

export const DEFAULT_TUNING: SceneTuning = {
  calmMad: 0.012,
  motionMad: 0.03,
  cutMad: 0.12,
  cutHamming: 14,
  settleMs: 700,
  staticMs: 3000,
  cutMaxMs: 10_000,
  blackMs: 2000,
  blackMean: 0.012,
  blackBright: 0.005,
  blackExitMean: 0.025,
  blackExitBright: 0.02,
};

const BRIGHT_LUMA = 48;

/** BT.601-ish luma of an RGBA buffer (ImageData.data) into `out` (allocated when omitted). */
export function lumaFromRGBA(rgba: ArrayLike<number>, out?: Uint8Array): Uint8Array {
  const n = Math.floor(rgba.length / 4);
  const y = out && out.length >= n ? out : new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) y[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return y;
}

/** Mean absolute difference of two equally sized luma buffers, 0..1. */
export function meanAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; sum += d < 0 ? -d : d; }
  return sum / (n * 255);
}

/** 64-bit difference hash as two 32-bit halves. */
export interface Hash64 { hi: number; lo: number }

const COL_EDGE = Array.from({ length: 10 }, (_, i) => Math.floor((i * THUMB_W) / 9));
const ROW_EDGE = Array.from({ length: 9 }, (_, j) => Math.floor((j * THUMB_H) / 8));

/** dHash over a 9x8 grid of block means of a 64x36 thumbnail: bit = left cell brighter than its right neighbour. */
export function dhash(luma: ArrayLike<number>): Hash64 {
  const cells = new Float64Array(9 * 8);
  for (let j = 0; j < 8; j++) {
    for (let i = 0; i < 9; i++) {
      let sum = 0;
      let count = 0;
      for (let y = ROW_EDGE[j]; y < ROW_EDGE[j + 1]; y++) {
        for (let x = COL_EDGE[i]; x < COL_EDGE[i + 1]; x++) { sum += luma[y * THUMB_W + x]; count++; }
      }
      cells[j * 9 + i] = count ? sum / count : 0;
    }
  }
  let hi = 0;
  let lo = 0;
  for (let j = 0; j < 8; j++) {
    for (let i = 0; i < 8; i++) {
      const bit = cells[j * 9 + i] > cells[j * 9 + i + 1] ? 1 : 0;
      const k = j * 8 + i;
      if (k < 32) hi = (hi | (bit << (31 - k))) >>> 0;
      else lo = (lo | (bit << (63 - k))) >>> 0;
    }
  }
  return { hi, lo };
}

function popcount32(v: number): number {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function hamming(a: Hash64, b: Hash64): number {
  return popcount32((a.hi ^ b.hi) >>> 0) + popcount32((a.lo ^ b.lo) >>> 0);
}

/** Mean luma (0..1) and the fraction of pixels brighter than BRIGHT_LUMA. */
export function lumaStats(luma: ArrayLike<number>): { mean: number; bright: number } {
  const n = luma.length;
  if (n === 0) return { mean: 0, bright: 0 };
  let sum = 0;
  let bright = 0;
  for (let i = 0; i < n; i++) { const v = luma[i]; sum += v; if (v > BRIGHT_LUMA) bright++; }
  return { mean: sum / (n * 255), bright: bright / n };
}

/**
 * State machine over thumbnails. Time comes from the caller (`now`, ms, any monotonic clock), so a tick
 * with no new frame (`luma` null) still advances the time-based transitions (static, settled, black).
 *
 *   motion  <-> static        calm for staticMs / change >= motionMad
 *   any     ->  cut           hash distance >= cutHamming and change >= cutMad
 *   cut     ->  settled       calm for settleMs after the cut (cutMaxMs of motion: back to 'motion')
 *   any     ->  black         dark and frozen for blackMs; leaving black counts as a cut
 *
 * The first state is 'motion' and is not announced.
 */
export class SceneAnalyzer {
  private readonly t: SceneTuning;
  private cur: SceneState = 'motion';
  private prev: Uint8Array | null = null;
  private prevHash: Hash64 | null = null;
  private mean = 0;
  private bright = 0;
  private lastActiveAt = 0;
  private darkSince: number | null = null;
  private cutAt = 0;

  constructor(tuning: Partial<SceneTuning> = {}) {
    this.t = { ...DEFAULT_TUNING, ...tuning };
  }

  get state(): SceneState { return this.cur; }

  reset(): void {
    this.cur = 'motion';
    this.prev = null;
    this.prevHash = null;
    this.mean = 0;
    this.bright = 0;
    this.lastActiveAt = 0;
    this.darkSince = null;
    this.cutAt = 0;
  }

  push(luma: Uint8Array | null, now: number): SceneEvent | null {
    const t = this.t;
    let change = 0;
    let dist = 0;
    if (luma) {
      const hash = dhash(luma);
      if (this.prev && this.prevHash) {
        change = meanAbsDiff(luma, this.prev);
        dist = hamming(hash, this.prevHash);
      } else {
        this.lastActiveAt = now; // the first frame starts the clock
      }
      const s = lumaStats(luma);
      this.mean = s.mean;
      this.bright = s.bright;
      // Keep our own copy: the caller reuses its buffer.
      if (this.prev && this.prev.length === luma.length) this.prev.set(luma); else this.prev = luma.slice();
      this.prevHash = hash;
    } else if (!this.prev) {
      return null; // nothing seen yet
    }

    if (change >= t.calmMad) this.lastActiveAt = now;
    const calm = now - this.lastActiveAt;

    if (this.cur === 'black') {
      const lit = this.mean > t.blackExitMean || this.bright > t.blackExitBright || change >= t.calmMad;
      if (!lit) return null;
      this.darkSince = null;
      this.lastActiveAt = now;
      this.cutAt = now;
      return this.enter('cut', 0, change);
    }

    const dark = this.mean <= t.blackMean && this.bright <= t.blackBright;
    if (dark && change < t.calmMad) { if (this.darkSince === null) this.darkSince = now; } else this.darkSince = null;
    if (this.darkSince !== null && now - this.darkSince >= t.blackMs) return this.enter('black', now - this.darkSince, change);

    if (luma && dist >= t.cutHamming && change >= t.cutMad) {
      this.lastActiveAt = now;
      if (this.cur === 'cut') return null;
      this.cutAt = now;
      return this.enter('cut', 0, change);
    }

    switch (this.cur) {
      case 'cut':
        // A dark picture waits for the black verdict instead of "settling" on nothing.
        if (calm >= t.settleMs && !dark) return this.enter('settled', calm, change);
        if (now - this.cutAt >= t.cutMaxMs && change >= t.calmMad) return this.enter('motion', 0, change);
        return null;
      case 'static':
        return change >= t.motionMad ? this.enter('motion', 0, change) : null;
      case 'settled':
        if (change >= t.motionMad) return this.enter('motion', 0, change);
        return calm >= t.staticMs ? this.enter('static', calm, change) : null;
      default: // motion
        return calm >= t.staticMs ? this.enter('static', calm, change) : null;
    }
  }

  private enter(state: SceneState, since: number, change: number): SceneEvent {
    this.cur = state;
    return { state, since: Math.round(since), change: Math.round(Math.min(1, change) * 1000) / 1000 };
  }
}
