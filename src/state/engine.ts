/* Bookkeeping that every part of the state layer shares: the event log, toasts and screen-reader
   announcements, the run clock (active time), and the controls that act on any run (pause on reload,
   cancel). Carrying a task out is live.ts's job — nothing in here talks to a model or runs a command.
   All functions take an immer draft, so they can be called from inside any store.update. */
import type { Draft } from 'immer';
import type { AppState, Run, RunEvent, Toast } from '../lib/types';
import { uid } from './store';

type D = Draft<AppState>;
type DRun = Draft<Run>;

export const TICK_MS = 200;
export const EVENT_CAP = 600;

/* ───────────────────────── feedback helpers ───────────────────────── */

export function pushEvent(d: D, e: Omit<RunEvent, 'id' | 'at'> & { at?: number }) {
  d.events.push({ id: uid('evt'), at: e.at ?? Date.now(), ...e });
  if (d.events.length > EVENT_CAP) d.events.splice(0, d.events.length - EVENT_CAP);
}

export function toast(d: D, t: Omit<Toast, 'id' | 'createdAt' | 'ttl'> & { ttl?: number }) {
  const ttl = t.ttl ?? (t.tone === 'danger' ? 9000 : t.tone === 'warning' ? 7000 : 4500);
  if (t.key) dropToasts(d, t.key);
  d.toasts.push({ id: uid('toast'), createdAt: Date.now(), ...t, ttl });
  if (d.toasts.length > 3) d.toasts.splice(0, d.toasts.length - 3);
}

/** Remove toasts whose subject has been dealt with. */
export function dropToasts(d: D, key: string) {
  if (d.toasts.some((x) => x.key === key)) d.toasts = d.toasts.filter((x) => x.key !== key);
}

export function announce(d: D, text: string) {
  d.announcement = { text, at: Date.now() };
}

/** A task counts as updated whenever something visible happens to it (not on every tick). */
export function touch(d: D, taskId: string, now: number) {
  const task = d.tasks[taskId];
  if (task) task.updatedAt = now;
}

/* ───────────────────────── run clock ───────────────────────── */

/** Real active time (excludes paused / awaiting): counted on the run and on the step it is working on. */
function addActive(run: DRun, dt: number) {
  run.activeMs += dt;
  if (run.cursor.phase !== 'executing') return;
  const step = run.plan[run.cursor.step];
  if (step && (step.status === 'running' || step.status === 'pending')) step.activeMs = (step.activeMs ?? 0) + dt;
}

export const needsTick = (s: AppState) => Object.values(s.runs).some((r) => r.status === 'running');

/** live.ts moves the runs themselves; the clock only counts the time they spend running. */
export function tick(d: D, _now: number, dt: number) {
  for (const run of Object.values(d.runs)) if (run.status === 'running') addActive(run, dt);
}

/* ───────────────────────── run controls ───────────────────────── */

export function findApproval(d: D | AppState, approvalId: string) {
  for (const run of Object.values(d.runs)) {
    const approval = run.approvals.find((a) => a.id === approvalId);
    if (approval) return { run, approval };
  }
  return undefined;
}

export function pauseRun(d: D, run: DRun, reason: 'user' | 'reload', now: number) {
  if (run.status !== 'running' && run.status !== 'awaiting') return false;
  run.pausedFrom = run.status;
  run.status = 'paused';
  run.pauseReason = reason;
  if (run.live) run.live.activity = 'paused';
  pushEvent(d, { at: now, runId: run.id, kind: 'run', level: reason === 'user' ? 'info' : 'warn',
    text: reason === 'reload' ? `页面重新载入，运行 #${run.attempt} 已暂停` : `运行 #${run.attempt} 已暂停` });
  if (reason !== 'reload') touch(d, run.taskId, now);
  return true;
}

/** Remove toasts whose action would resume this run. */
export function dropResumeToasts(d: D, runId: string) {
  const stale = (t: Draft<Toast>) => t.action?.command.type === 'resume-run' && t.action.command.runId === runId;
  if (d.toasts.some(stale)) d.toasts = d.toasts.filter((t) => !stale(t));
}

/** Marks the run, its steps, calls and approvals as cancelled. Stopping the agent itself is live.cancelLive's part. */
export function cancelRun(d: D, run: DRun, now: number) {
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return false;
  const task = d.tasks[run.taskId];
  run.status = 'cancelled';
  run.endedAt = now;
  run.cursor.phase = 'done';
  run.live = undefined;
  run.pausedFrom = undefined;
  run.pauseReason = undefined;
  for (const step of run.plan) {
    if (step.status === 'running' || step.status === 'awaiting') { step.status = 'cancelled'; step.endedAt = now; step.note = '运行被取消时正在执行'; }
    else if (step.status === 'pending') step.status = 'cancelled';
  }
  for (const call of run.toolCalls) if (call.status === 'running' || call.status === 'awaiting') Object.assign(call, { status: 'cancelled', endedAt: now });
  for (const approval of run.approvals) {
    if (approval.status !== 'pending') continue;
    approval.status = 'expired';
    dropToasts(d, `approval:${approval.id}`);
  }
  task?.messages.push({ id: uid('msg'), role: 'system', runId: run.id, at: now, text: `运行 #${run.attempt} 已取消。已生成的产物仍保留在「产物」中。` });
  pushEvent(d, { at: now, runId: run.id, kind: 'run', level: 'warn', text: `运行 #${run.attempt} 已取消` });
  touch(d, run.taskId, now);
  dropResumeToasts(d, run.id);
  return true;
}
