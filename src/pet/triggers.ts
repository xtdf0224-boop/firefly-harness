/* When the 桌宠 may speak up on her own (docs/PET.md §5). Pure: the brain feeds in the facts and gets
   back which trigger (if any) fires. No timers, no store, no IPC, so scripts/pet-brain-check.ts can
   drive it with a fake clock and a fake dice. */
import type { PetProactivity } from '../lib/types';
import type { FocusApp, SceneState } from './contracts';

export type ProactiveKind = 'greet' | 'stuck' | 'cut' | 'text';

const SEC = 1000;
const MIN = 60_000;

export const LIMITS = {
  /** No interruptions this long after the user asked or clicked. */
  userQuietMs: 60 * SEC,
  /** A line nobody reacted to (ask or click) within this counts as ignored. */
  ignoredAfterMs: 90 * SEC,
  /** Two ignored lines in a row and she goes quiet for quietMs. */
  ignoredQuota: 2,
  quietMs: 10 * MIN,
  /** Between two model calls for a line of her own, even when the model answered SKIP. */
  attemptGapMs: 30 * SEC,
  greetAfterMs: 20 * SEC,
  greetWindowMs: 2 * MIN,
  greetAgainMs: 45 * MIN,
  staticMs: 4 * MIN,
  staticWindowMs: 30 * MIN,
  idleMaxSec: 30,
  idleFreshMs: 45 * SEC,
  /** A cut scene counts when the cut + motion stretch before the picture settled lasted at least this long. */
  cutMinMs: 15 * SEC,
  cutWindowMs: 45 * SEC,
  textGapMs: 5 * MIN,
  textWindowMs: 20 * SEC,
  textMinLines: 2,
  /** A line she starts herself is at most this many characters. */
  lineMax: 40,
  /** The shortest cooldown any setting can reach (the 设置 limit is 60 s too). */
  cooldownFloorMs: 60 * SEC,
};

/** `chance`: odds that an eligible trigger actually fires; `cooldown`: multiplier on the cooldown setting (never below 1:
    the setting is a floor, so a busier profile raises the odds but does not shorten the wait). */
const PROFILE: Record<PetProactivity, { chance: number; cooldown: number } | undefined> = {
  off: undefined,
  low: { chance: 0.35, cooldown: 2.5 },
  normal: { chance: 0.65, cooldown: 1 },
  high: { chance: 0.9, cooldown: 1 },
};

export const proactiveProfile = (p: PetProactivity) => PROFILE[p];

/** Minimum gap between two lines she starts herself (Infinity when proactivity is off). `cooldownSec` is a true floor:
    no profile goes below it, and nothing goes below 60 s. */
export function cooldownMs(p: PetProactivity, cooldownSec: number) {
  const prof = PROFILE[p];
  if (!prof) return Infinity;
  const setting = Math.max(LIMITS.cooldownFloorMs, (Number.isFinite(cooldownSec) ? cooldownSec : 0) * SEC);
  return setting * Math.max(1, prof.cooldown);
}

/* ───────────── the hourly picture budget ───────────── */

export const HOUR = 60 * MIN;

/** Screenshots sent in the last hour (drops the older ones from the list). */
export function imagesUsed(sent: number[], now: number) {
  while (sent.length && now - sent[0] >= HOUR) sent.shift();
  return sent.length;
}

/** Pictures kept back for the user's own questions: lines she starts herself never use these. */
export const askReserve = (perHour: number) => Math.min(5, Math.ceil(perHour * 0.25));

export function imagesLeft(sent: number[], perHour: number, now: number, forProactive: boolean) {
  const cap = forProactive ? perHour - askReserve(perHour) : perHour;
  return Math.max(0, cap - imagesUsed(sent, now));
}

/* ───────────── scene tracking ───────────── */

export interface SceneTrack {
  state: SceneState;
  /** When this state began (ms). */
  since: number;
  /** The state before this one, and how long it lasted. */
  prev?: SceneState;
  prevMs?: number;
  /** While the state is 'cut' or 'motion': when the current run of cut + motion began (its first cut). Gameplay motion before
      that first cut is not part of it. A run ends at static, settled or black. */
  runSince?: number;
  /** In 'settled' / 'static': how long the cut + motion run just before it lasted (0 = there was none). A real cut scene
      is a cut, some motion, then a hard cut back, so the cut state alone is far shorter than the scene. */
  runMs?: number;
}

/** A `since` from the capture page is trusted only when it looks like a wall-clock time near now. */
function sane(since: number, at: number) {
  return Number.isFinite(since) && since >= at - 6 * HOUR && since <= at + 5 * SEC ? since : at;
}

export function trackScene(t: SceneTrack | undefined, ev: { state: SceneState; since: number }, at: number): SceneTrack {
  if (t && t.state === ev.state) return t;
  const since = sane(ev.since, at);
  const next: SceneTrack = { state: ev.state, since, prev: t?.state, prevMs: t ? Math.max(0, since - t.since) : undefined };
  // A run of cut + motion in progress: the state before was cut, or motion that already belongs to a run.
  const run = t && (t.state === 'cut' || t.state === 'motion') ? t.runSince : undefined;
  if (ev.state === 'cut') next.runSince = run ?? since;
  else if (ev.state === 'motion') next.runSince = run;
  else if (ev.state === 'settled' || ev.state === 'static') next.runMs = run === undefined ? 0 : Math.max(0, since - run);
  return next;
}

/* ───────────── what she remembers about her own talking ───────────── */

export interface Memory {
  /** Any line of hers (answer or proactive), when it was said. */
  lastLineAt: number;
  /** The user's last ask or click. */
  lastUserAt: number;
  /** The last time a proactive trigger went to the model. */
  lastAttemptAt: number;
  /** Silent until then (two ignored lines in a row). */
  quietUntil: number;
  ignored: number;
  /** When her last proactive line was said, while nobody has reacted to it yet. */
  pendingSince?: number;
  /** Trigger instances already rolled, so a miss is not re-rolled every few seconds. */
  decided: Map<string, number>;
  /** Games she greeted lately, by exe. */
  greeted: Map<string, number>;
  /** The last notable-text line she commented on. */
  lastTextAt: number;
}

export const newMemory = (): Memory => ({
  lastLineAt: 0, lastUserAt: 0, lastAttemptAt: 0, quietUntil: 0, ignored: 0, decided: new Map(), greeted: new Map(), lastTextAt: 0,
});

/** Count a proactive line nobody reacted to within 90 s; two in a row start the quiet period. */
export function tickIgnored(m: Memory, now: number) {
  if (m.pendingSince !== undefined && now - m.pendingSince >= LIMITS.ignoredAfterMs) {
    m.pendingSince = undefined;
    m.ignored++;
    if (m.ignored >= LIMITS.ignoredQuota) { m.quietUntil = now + LIMITS.quietMs; m.ignored = 0; }
  }
}

/** The user asked or clicked: any pending line was noticed, the streak is over. */
export function noteUser(m: Memory, now: number) {
  tickIgnored(m, now);
  m.lastUserAt = now;
  m.pendingSince = undefined;
  m.ignored = 0;
}

/** She said something. `proactive`: she started it herself (so it can be ignored). */
export function noteLine(m: Memory, now: number, proactive: boolean) {
  m.lastLineAt = now;
  if (proactive) m.pendingSince = now;
}

/* ───────────── notable on-screen text ───────────── */

const CJK = /[㐀-鿿]/g;

/** OCR lines worth a comment: a few real words, not HUD numbers, timers or one-letter debris. */
export function notableLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || seen.has(line)) continue;
    const cjk = line.match(CJK)?.length ?? 0;
    const latin = (line.match(/[A-Za-z]/g)?.length ?? 0);
    const words = line.split(' ').filter((w) => /[A-Za-z]{2,}/.test(w)).length;
    if (cjk >= 4 || (latin >= 12 && words >= 3)) { seen.add(line); out.push(line); }
  }
  return out;
}

/* ───────────── deciding ───────────── */

export interface TriggerCtx {
  now: number;
  proactivity: PetProactivity;
  cooldownSec: number;
  /** The program in front, or undefined when it is not one she may talk about (her own window, nothing). */
  focus?: FocusApp;
  /** When that program came to the front. */
  focusSince: number;
  scene?: SceneTrack;
  idle?: { seconds: number; at: number };
  /** The latest recognised text. */
  text?: { lines: string[]; at: number };
  /** The user paused watching (hotkey / menu). */
  paused: boolean;
  /** 设置 › 允许看游戏画面. */
  watching: boolean;
  /** A reply is being written. */
  busy: boolean;
  /** 实时陪玩 is on: it does the talking. */
  realtime: boolean;
  /** Pictures she may still send on her own this hour. */
  images: number;
}

export interface Trigger {
  kind: ProactiveKind;
  /** Identifies this instance (a game session, a static stretch, a cut scene…). */
  key: string;
  /** The line needs a picture. */
  image: boolean;
  /** Recognised text this line is about. */
  lines?: string[];
  /** Stuck: how long the picture has not changed. */
  staticMs?: number;
}

/** Why she must stay quiet right now, or undefined when she may speak. */
export function blocked(m: Memory, c: TriggerCtx): string | undefined {
  if (!PROFILE[c.proactivity]) return 'off';
  if (c.paused) return 'paused';
  if (c.busy) return 'busy';
  if (c.realtime) return 'realtime';
  if (c.now < m.quietUntil) return 'quiet';
  if (c.now - m.lastLineAt < cooldownMs(c.proactivity, c.cooldownSec)) return 'cooldown';
  if (c.now - m.lastUserAt < LIMITS.userQuietMs) return 'user';
  if (c.now - m.lastAttemptAt < LIMITS.attemptGapMs) return 'attempt';
  return undefined;
}

interface Candidate extends Trigger {
  /** The moment it stops being worth saying. */
  expires: number;
  /** Multiplier on the odds (the optional comment is rarer than a greeting). */
  odds: number;
}

function candidates(m: Memory, c: TriggerCtx): Candidate[] {
  const out: Candidate[] = [];
  const app = c.focus;
  if (!app || app.policy === 'never') return out;
  const sceneOk = app.policy === 'watch' && c.watching;
  const scene = c.scene;

  // A cut scene ended and the picture settled: a short comment, with a look. How long it lasted is the whole cut + motion
  // run before the settling (a 30 s scene reads cut 10 s, motion 20 s, a hard cut back, settled).
  if (sceneOk && scene && scene.state === 'settled' && scene.prev === 'cut' && (scene.runMs ?? 0) >= LIMITS.cutMinMs) {
    out.push({ kind: 'cut', key: `cut:${scene.since}`, image: true, expires: scene.since + LIMITS.cutWindowMs, odds: 1 });
  }

  // Just entered a game: say hello once the picture settles (or after 20 s). No picture needed. Not over an anti-cheat
  // game: her window is hidden there and anything she says is dropped (a game the user marked 不要看 is not that: she is still there).
  if (app.isGame && !app.antiCheat) {
    const settledAt = scene && scene.state === 'settled' ? scene.since : 0;
    const ready = (settledAt > 0 && settledAt >= c.focusSince) || c.now - c.focusSince >= LIMITS.greetAfterMs;
    const last = m.greeted.get(app.exe);
    if (ready && (last === undefined || c.now - last >= LIMITS.greetAgainMs)) {
      out.push({ kind: 'greet', key: `greet:${app.exe}:${c.focusSince}`, image: false, expires: c.focusSince + LIMITS.greetWindowMs, odds: 1 });
    }
  }

  // New on-screen text (dialogue, a quest): an optional comment, from the text alone.
  if (sceneOk && c.text && c.now - m.lastTextAt >= LIMITS.textGapMs && c.now - c.text.at <= LIMITS.textWindowMs) {
    const lines = notableLines(c.text.lines);
    if (lines.length >= LIMITS.textMinLines) out.push({ kind: 'text', key: `text:${c.text.at}`, image: false, lines, expires: c.text.at + LIMITS.textWindowMs, odds: 0.6 });
  }

  // The picture has not moved for minutes while the user keeps working: maybe stuck, so offer help.
  if (sceneOk && scene && scene.state === 'static' && c.now - scene.since >= LIMITS.staticMs && c.idle
    && c.idle.seconds < LIMITS.idleMaxSec && c.now - c.idle.at <= LIMITS.idleFreshMs) {
    out.push({ kind: 'stuck', key: `stuck:${scene.since}`, image: true, staticMs: c.now - scene.since, expires: scene.since + LIMITS.staticWindowMs, odds: 1 });
  }
  return out;
}

/**
 * The trigger that fires now, or undefined. Each trigger instance is rolled once: a miss (or a
 * trigger whose moment passed) is remembered in `m.decided`, so the same stretch of play does not
 * get re-rolled every tick. A firing trigger marks the attempt time; the caller reports the line
 * with noteLine() once it is actually said.
 */
export function nextTrigger(m: Memory, c: TriggerCtx, rand: () => number = Math.random): Trigger | undefined {
  const prof = PROFILE[c.proactivity];
  if (!prof) return undefined;
  for (const [k, at] of m.decided) if (c.now - at > HOUR) m.decided.delete(k);
  if (blocked(m, c)) return undefined;
  for (const cand of candidates(m, c)) {
    if (m.decided.has(cand.key)) continue;
    if (c.now > cand.expires) { m.decided.set(cand.key, c.now); continue; }
    if (cand.image && c.images <= 0) continue;
    m.decided.set(cand.key, c.now);
    if (cand.kind === 'greet' && c.focus) m.greeted.set(c.focus.exe, c.now);
    if (rand() >= prof.chance * cand.odds) continue;
    m.lastAttemptAt = c.now;
    if (cand.kind === 'text') m.lastTextAt = c.now;
    const { expires: _e, odds: _o, ...trigger } = cand;
    return trigger;
  }
  return undefined;
}
