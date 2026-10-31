/* Pure logic for the Agent page's formation chart: no React, no DOM. */
import type { AgentActivity, VisualMode } from './types';
import type { CrewState } from './persona';

export interface Pt { x: number; y: number }

/** disabled → off; else first use → first; else the live activity (idle when none). */
export function crewState(enabled: boolean, activity: AgentActivity | undefined, first: boolean): CrewState {
  if (!enabled) return 'off';
  if (first) return 'first';
  return activity ?? 'idle';
}

const n = (v: number) => String(Math.round(v * 10) / 10);

/** SVG path data for the trail from the lead (`from`) to a member (`to`): `go` ends 22 px short of `to`, `back` is the return path, offset. */
export function trailPaths(mode: VisualMode, from: Pt, to: Pt): { go: string; back: string } {
  const C = from;
  const O = to;
  const dir = O.x >= C.x ? 1 : -1;
  const end = O.x - 22 * dir;
  if (mode === 'sam') {
    const mx = C.x + (O.x - C.x) * 0.42;
    const sx = mx + Math.abs(O.y - C.y) * 0.18 * dir;
    const off = O.y < C.y ? 7 : -7;
    return {
      go: `M${n(C.x)} ${n(C.y)} H${n(mx)} L${n(sx)} ${n(O.y)} H${n(end)}`,
      back: `M${n(end)} ${n(O.y + off)} H${n(sx + 7 * dir)} L${n(mx + 7 * dir)} ${n(C.y + off)} H${n(C.x + 26 * dir)}`,
    };
  }
  const dx = O.x - C.x;
  const bend = O.y < C.y ? 26 : O.y > C.y ? -26 : 20;
  return {
    go: `M${n(C.x)} ${n(C.y)} C${n(C.x + dx * 0.55)} ${n(C.y)} ${n(O.x - dx * 0.5)} ${n(O.y)} ${n(end)} ${n(O.y)}`,
    back: `M${n(end)} ${n(O.y + 6)} C${n(O.x - dx * 0.45)} ${n(O.y + bend)} ${n(C.x + dx * 0.5)} ${n(C.y + bend * 0.9)} ${n(C.x + 24 * dir)} ${n(C.y + 8)}`,
  };
}
