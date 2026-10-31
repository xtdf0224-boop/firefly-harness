// Turn detection for 实时陪玩 (docs/PET.md §7): when did the user start talking, when did they stop.
// 16 kHz mono 16-bit PCM in 20 ms frames; loudness against a noise floor that follows the room (and the game)
// slowly upwards and quickly downwards. While she is speaking a start needs to be louder and longer, so her own
// voice and game sound leaking into the microphone do not cut her off. Pure JS, no native parts.
'use strict';

const RATE = 16000;
const FRAME = 320; // 20 ms
const FRAME_MS = 20;

/** sensitivity 0…100 → thresholds. Higher = starts on quieter speech, ends sooner. */
function tuning(sensitivity) {
  const s = Math.max(0, Math.min(100, Number(sensitivity)));
  const k = Number.isFinite(s) ? s / 100 : 0.5;
  return {
    startDb: 17 - 9 * k, // above the floor to count as speech: 17 dB (deaf) … 8 dB (keen)
    minDb: -42 - 14 * k, // and never quieter than this absolute level (dBFS)
    startFrames: 3, // 60 ms of speech before it counts
    endMs: 820 - 300 * k, // this long below the end level ends the turn
  };
}

const dbOf = (sumSq, n) => (sumSq > 0 ? 10 * Math.log10(sumSq / n) : -120);

class Vad {
  /**
   * @param {{ sensitivity?: number, preRollMs?: number, maxMs?: number,
   *           onStart?: () => void, onAudio?: (pcm: Buffer) => void, onEnd?: (info: { ms: number, forced: boolean }) => void }} o
   */
  constructor(o = {}) {
    this.o = o;
    this.t = tuning(o.sensitivity ?? 50);
    this.preRoll = Math.round((o.preRollMs ?? 320) / FRAME_MS);
    this.maxFrames = Math.round((o.maxMs ?? 15_000) / FRAME_MS);
    this.floor = -60;
    this.speaking = false;
    this.run = 0; // loud frames in a row (before a start)
    this.quiet = 0; // quiet frames in a row (during speech)
    this.frames = 0; // frames in the current turn
    this.ring = []; // recent frames before a start
    this.rest = Buffer.alloc(0);
    this.busy = false;
    this.gate = true; // false: the floor keeps learning but no turn may start (the hotkey mode between presses)
    this.recent = []; // levels of the last second inside a turn
    this.hp = 0; // high-pass filter state
    this.prevIn = 0;
  }

  setSensitivity(v) { this.t = tuning(v); }

  /** She is talking: starting a turn needs more (louder and longer). */
  setBusy(on) { this.busy = !!on; }

  /** Whether a turn may start (the floor keeps following the room either way). */
  setGate(open) { this.gate = !!open; if (!this.gate) this.run = 0; }

  get active() { return this.speaking; }

  /** Feed 16-bit little-endian PCM (any length). */
  push(buf) {
    let data = this.rest.length ? Buffer.concat([this.rest, buf]) : buf;
    const whole = Math.floor(data.length / (FRAME * 2)) * FRAME * 2;
    for (let off = 0; off < whole; off += FRAME * 2) this.frame(data.subarray(off, off + FRAME * 2));
    this.rest = Buffer.from(data.subarray(whole));
  }

  /** End the current turn now (the hotkey mode's time limit, or the session stopping). */
  flush(forced = true) {
    if (!this.speaking) return;
    const ms = this.frames * FRAME_MS;
    this.reset();
    if (this.o.onEnd) this.o.onEnd({ ms, forced });
  }

  reset() {
    this.speaking = false;
    this.run = 0;
    this.quiet = 0;
    this.frames = 0;
    this.ring = [];
    this.recent = [];
  }

  frame(f) {
    // A one-pole high-pass (about 100 Hz) keeps hum and desk thumps out of the level.
    let sum = 0;
    for (let i = 0; i < FRAME; i++) {
      const x = f.readInt16LE(i * 2) / 32768;
      this.hp = 0.96 * (this.hp + x - this.prevIn);
      this.prevIn = x;
      sum += this.hp * this.hp;
    }
    const db = dbOf(sum, FRAME);
    const t = this.t;
    const startAt = Math.max(this.floor + t.startDb + (this.busy ? 7 : 0), t.minDb + (this.busy ? 6 : 0));
    const needFrames = this.busy ? t.startFrames + 7 : t.startFrames;
    const copy = Buffer.from(f);

    if (!this.speaking) {
      // The floor follows the background: down fast, up slowly (so a long sentence does not raise it).
      this.floor += (db < this.floor ? 0.25 : 0.02) * (db - this.floor);
      this.floor = Math.max(-85, Math.min(-25, this.floor));
      this.ring.push(copy);
      if (this.ring.length > this.preRoll) this.ring.shift();
      this.run = this.gate && db > startAt ? this.run + 1 : 0;
      if (this.run >= needFrames) {
        this.speaking = true;
        this.quiet = 0;
        this.frames = this.ring.length;
        if (this.o.onStart) this.o.onStart();
        if (this.o.onAudio) for (const r of this.ring) this.o.onAudio(r);
        this.ring = [];
      }
      return;
    }

    this.frames++;
    if (this.o.onAudio) this.o.onAudio(copy);
    // Inside a turn the floor creeps towards the quietest level of the last second, so a sound that never lets up
    // (game music, a fan) is absorbed within the turn instead of starting a new one the moment the cap ends it.
    this.recent.push(db);
    if (this.recent.length > 50) this.recent.shift();
    if (this.recent.length === 50) {
      const lo = Math.min(...this.recent);
      if (lo > this.floor) this.floor = Math.min(-25, this.floor + 0.004 * (lo - this.floor));
    }
    const endAt = Math.max(this.floor + t.startDb - 5, t.minDb - 4);
    this.quiet = db < endAt ? this.quiet + 1 : 0;
    if (this.quiet * FRAME_MS >= t.endMs) { this.flush(false); return; }
    if (this.frames >= this.maxFrames) this.flush(true);
  }
}

module.exports = { Vad, tuning, RATE, FRAME, FRAME_MS };
