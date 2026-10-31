/* Shared helpers for the roster / tools / history / settings views: stat selectors, stable-equality
   helpers for useApp, and the permission icons. Nothing here touches the store except through selectors. */
import { Ban, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import { isOpenRun } from '../../../lib/status';
import type { AgentActivity, AppState, ToolPermission } from '../../../lib/types';
import { agentActivity } from '../../../state/selectors';
import { shallow } from '../../../state/store';

export const PERM_ICON: Record<ToolPermission, LucideIcon> = { auto: Zap, confirm: ShieldCheck, off: Ban };

export type Dict<T> = Record<string, T | undefined>;

/** Equality for selectors that build a new record each call: same keys, shallow-equal values. */
export function sameRecord<T>(a: Dict<T>, b: Dict<T>) {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => k in b && shallow(a[k], b[k]));
}

/** Equality for selectors that build a new array of plain row objects each call. */
export function sameList<T>(a: readonly T[], b: readonly T[]) {
  return a === b || (a.length === b.length && a.every((x, i) => shallow(x, b[i])));
}

export interface CallStat { steps: number; calls: number; errors: number }
const blank = (): CallStat => ({ steps: 0, calls: 0, errors: 0 });

/** Per agent, across every run: finished steps (carried-over steps are not counted twice), tool calls, failed calls. */
export function selectAgentStats(s: AppState): Dict<CallStat> {
  const out: Dict<CallStat> = {};
  for (const run of Object.values(s.runs)) {
    for (const st of run.plan) if (st.status === 'done' && !st.carried) (out[st.agentId] ??= blank()).steps++;
    for (const c of run.toolCalls) {
      const stat = (out[c.agentId] ??= blank());
      stat.calls++;
      if (c.status === 'error') stat.errors++;
    }
  }
  return out;
}

/** Per tool, across every run. */
export function selectToolStats(s: AppState): Dict<CallStat> {
  const out: Dict<CallStat> = {};
  for (const run of Object.values(s.runs)) {
    for (const c of run.toolCalls) {
      const stat = (out[c.tool] ??= blank());
      stat.calls++;
      if (c.status === 'error') stat.errors++;
    }
  }
  return out;
}

export interface Presence {
  taskId: string;
  runId: string;
  title: string;
  activity: AgentActivity;
  /** The run's live line, e.g. 「第 4 步 · 改写会话校验」. */
  text: string;
}

/** The open run each agent is currently the live agent of (first one wins). */
export function selectPresence(s: AppState): Dict<Presence> {
  const out: Dict<Presence> = {};
  for (const run of Object.values(s.runs)) {
    if (!isOpenRun(run.status)) continue;
    const id = run.live?.agentId;
    const task = s.tasks[run.taskId];
    if (!id || !task || out[id]) continue;
    out[id] = { taskId: task.id, runId: run.id, title: task.title, activity: agentActivity(s, run, id), text: run.live?.text ?? '' };
  }
  return out;
}

/** An agent's latest failed tool call across every run; `open` = a failed call sits in a run that is still open. */
export interface LastError { id: string; taskId: string; runId: string; title: string; message: string; at: number; open: boolean }

export function selectLastErrors(s: AppState): Dict<LastError> {
  const out: Dict<LastError> = {};
  for (const run of Object.values(s.runs)) {
    const open = isOpenRun(run.status);
    for (const c of run.toolCalls) {
      if (c.status !== 'error') continue;
      const prev = out[c.agentId];
      const latest = !prev || c.startedAt > prev.at;
      out[c.agentId] = {
        id: latest ? c.id : prev.id,
        taskId: latest ? run.taskId : prev.taskId,
        runId: latest ? run.id : prev.runId,
        title: latest ? c.title : prev.title,
        message: latest ? c.error?.message ?? '' : prev.message,
        at: latest ? c.startedAt : prev.at,
        open: open || !!prev?.open,
      };
    }
  }
  return out;
}
