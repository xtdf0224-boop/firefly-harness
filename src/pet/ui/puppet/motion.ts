/* What moves her, frame by frame (docs/PET.md §8). Pure functions of time plus small state machines, so the
   renderer only asks "how open are the eyes / mouth right now" and the checks can drive them with a fake clock.
   Times are milliseconds; amounts are 0…1 unless said otherwise. */

/** A random number in [0, 1); injectable so the checks are repeatable. */
export type Rand = () => number;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (t: number) => { const x = clamp01(t); return x * x * (3 - 2 * x); };

/* ───────────── blinking ───────────── */

/** Lids close fast, stay shut for a moment, open a little slower. */
export const BLINK = { close: 70, hold: 50, open: 110 } as const;
const BLINK_LEN = BLINK.close + BLINK.hold + BLINK.open;

/** How shut the eyes are `t` ms into one blink. */
export function blinkCurve(t: number): number {
  if (t <= 0 || t >= BLINK_LEN) return 0;
  if (t < BLINK.close) return ease(t / BLINK.close);
  if (t < BLINK.close + BLINK.hold) return 1;
  return 1 - ease((t - BLINK.close - BLINK.hold) / BLINK.open);
}

/** Blinks every 2.2–6 s; now and then twice in a row. `reset` is called after a pose change so she does not blink mid-crossfade. */
export class Blinker {
  private starts: number[] = [];
  private next: number;

  constructor(now: number, private readonly rand: Rand = Math.random) {
    this.next = now + this.gap();
  }

  private gap() { return 2200 + this.rand() * 3800; }

  reset(now: number, delay = 600) {
    this.starts = [];
    this.next = now + delay + this.rand() * 1200;
  }

  amount(now: number): number {
    // After a long pause (sleep, a hidden window) the missed blinks are skipped, not replayed one per call.
    if (now - this.next > BLINK_LEN) { this.starts = []; this.next = now + this.gap(); }
    if (now >= this.next) {
      this.starts = [this.next];
      // About one blink in six is a double blink.
      if (this.rand() < 0.17) this.starts.push(this.next + BLINK_LEN + 90);
      this.next = this.starts[this.starts.length - 1] + BLINK_LEN + this.gap();
    }
    let v = 0;
    for (const s of this.starts) v = Math.max(v, blinkCurve(now - s));
    return v;
  }
}

/* ───────────── breathing and idle sway ───────────── */

/** One breath: 0 = out, 1 = in. In for 40 % of the cycle, out for the rest, smooth at both ends. */
export function breath(now: number, period = 3800): number {
  const p = ((now % period) + period) % period / period;
  return p < 0.4 ? ease(p / 0.4) : 1 - ease((p - 0.4) / 0.6);
}

/** The slow sway of her head and the breeze in her hair: two sines that never quite repeat. */
export function sway(now: number, period: number, phase = 0): number {
  const a = (now / period) * Math.PI * 2 + phase;
  return 0.75 * Math.sin(a) + 0.25 * Math.sin(a * 2.31 + 1.7);
}

/* ───────────── the mouth ───────────── */

/** Output level (RMS of the samples, about 0…0.35 for speech) → how open the mouth should be. */
export function mouthTarget(rms: number): number {
  const v = clamp01((rms - 0.012) / 0.12);
  return Math.pow(v, 0.75);
}

/** Opens fast, closes a little slower, so it follows syllables without fluttering. */
export class MouthEnvelope {
  value = 0;
  constructor(private readonly attack = 28, private readonly release = 75) {}
  step(target: number, dt: number): number {
    const tau = target > this.value ? this.attack : this.release;
    const k = 1 - Math.exp(-Math.max(0, dt) / tau);
    this.value += (clamp01(target) - this.value) * k;
    if (this.value < 0.002) this.value = 0;
    return this.value;
  }
}

/** Mouth movement for a line shown without a voice: syllable-sized openings with short pauses. */
export class Babble {
  private until = 0;
  private target = 0;
  constructor(private readonly rand: Rand = Math.random) {}
  level(now: number): number {
    if (now >= this.until) {
      const pause = this.rand() < 0.16;
      this.target = pause ? 0 : 0.35 + this.rand() * 0.65;
      this.until = now + (pause ? 160 : 110) + this.rand() * 110;
    }
    return this.target;
  }
}

/* ───────────── dragging ───────────── */

/**
 * The hair's lag while she is dragged: a damped spring pulled against the direction of travel. `push(vx)` with the
 * window's speed (screen px per ms) while dragging; `step` gives the offset in -1.4…1.4 (1 = a brisk drag).
 */
export class Lag {
  value = 0;
  private vel = 0;
  private target = 0;
  private lastPush = -Infinity;
  push(vx: number, now: number) {
    this.target = Math.max(-1, Math.min(1, -vx * 0.9));
    this.lastPush = now;
  }
  step(now: number, dt: number): number {
    // Once the cursor stops (no new speed for a moment), the hair swings back.
    if (now - this.lastPush > 90) this.target = 0;
    const h = Math.min(dt, 50) / 1000;
    const k = 70, c = 7;
    this.vel += (k * (this.target - this.value) - c * this.vel) * h;
    this.value += this.vel * h;
    if (Math.abs(this.value) < 1e-4 && Math.abs(this.vel) < 1e-3 && this.target === 0) { this.value = 0; this.vel = 0; }
    this.value = Math.max(-1.4, Math.min(1.4, this.value));
    return this.value;
  }
  get settled() { return this.value === 0 && this.target === 0; }
}
