/* public/pet/<mode>/rig.json (made by scripts/pet-rig.py): where the figure bends, and which pictures each pose
   can blend in. Read defensively: a missing or broken rig means the plain picture switcher is used instead. */

export type PuppetPose = 'idle' | 'watch' | 'think' | 'happy' | 'sleep';
export const PUPPET_POSES: PuppetPose[] = ['idle', 'watch', 'think', 'happy', 'sleep'];

export interface PoseRig {
  /** File names (no extension) in the mode's folder. */
  weights: string;
  blink?: string;
  talk?: string;
}

export interface Rig {
  size: number;
  foot: number;
  hip: number;
  chest: number;
  pivot: [number, number];
  /** Heights between which the head tilt fades in: [bottom, top]. */
  neck: [number, number];
  amp: { breath: number; tilt: number; hair: number; accent: number };
  mouth: { kind: 'open' | 'glow'; box: [number, number, number, number] };
  poses: Partial<Record<PuppetPose, PoseRig>>;
}

const FILE = /^[a-z0-9_-]{1,40}$/;
const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** A checked rig, or null when anything needed is missing or out of range. */
export function parseRig(raw: unknown): Rig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const size = num(r.size, 64, 4096);
  if (!size) return null;
  const at = (v: unknown) => num(v, 0, size);
  const pair = (v: unknown): [number, number] | null => (Array.isArray(v) && v.length === 2 && at(v[0]) !== null && at(v[1]) !== null ? [v[0] as number, v[1] as number] : null);
  const foot = at(r.foot), hip = at(r.hip), chest = at(r.chest);
  const pivot = pair(r.pivot), neck = pair(r.neck);
  if (foot === null || hip === null || chest === null || !pivot || !neck || !(chest < hip && hip <= foot) || !(neck[1] < neck[0])) return null;
  const a = (r.amp && typeof r.amp === 'object' ? r.amp : {}) as Record<string, unknown>;
  const amp = { breath: num(a.breath, 0, 20), tilt: num(a.tilt, 0, 10), hair: num(a.hair, 0, 30), accent: num(a.accent, 0, 20) };
  if (amp.breath === null || amp.tilt === null || amp.hair === null || amp.accent === null) return null;
  const m = (r.mouth && typeof r.mouth === 'object' ? r.mouth : {}) as Record<string, unknown>;
  const box = Array.isArray(m.box) && m.box.length === 4 && m.box.every((v) => at(v) !== null) ? (m.box as [number, number, number, number]) : null;
  if (!box || !(box[0] < box[2] && box[1] < box[3]) || (m.kind !== 'open' && m.kind !== 'glow')) return null;
  const poses: Rig['poses'] = {};
  const p = (r.poses && typeof r.poses === 'object' ? r.poses : {}) as Record<string, unknown>;
  for (const pose of PUPPET_POSES) {
    const e = p[pose] as Record<string, unknown> | undefined;
    if (!e || typeof e.weights !== 'string' || !FILE.test(e.weights)) continue;
    poses[pose] = {
      weights: e.weights,
      ...(typeof e.blink === 'string' && FILE.test(e.blink) ? { blink: e.blink } : {}),
      ...(typeof e.talk === 'string' && FILE.test(e.talk) ? { talk: e.talk } : {}),
    };
  }
  if (!poses.idle) return null;
  return { size, foot, hip, chest, pivot, neck, amp: { breath: amp.breath, tilt: amp.tilt, hair: amp.hair, accent: amp.accent }, mouth: { kind: m.kind, box }, poses };
}

/** The pose actually drawn: one the rig does not know falls back to idle. */
export const rigPose = (rig: Rig, pose: PuppetPose): PuppetPose => (rig.poses[pose] ? pose : 'idle');
