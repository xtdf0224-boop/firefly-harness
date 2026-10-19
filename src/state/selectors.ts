import type { AgentActivity, AgentId, AppState, Approval, Run, RunStatus, Task } from '../lib/types';
import { isOpenRun } from '../lib/status';
import { GATEWAY_ID } from './engine';

export type TaskStatus = RunStatus | 'draft';

export const currentTask = (s: AppState): Task | undefined => (s.selectedTaskId ? s.tasks[s.selectedTaskId] : undefined);

/** The run shown in the workspace: the selected one if it belongs to the task, else the latest. */
export function currentRun(s: AppState): Run | undefined {
  const task = currentTask(s);
  if (!task) return undefined;
  const id = s.selectedRunId && task.runIds.includes(s.selectedRunId) ? s.selectedRunId : task.runIds[task.runIds.length - 1];
  return id ? s.runs[id] : undefined;
}

export function latestRun(s: AppState, task: Task): Run | undefined {
  const id = task.runIds[task.runIds.length - 1];
  return id ? s.runs[id] : undefined;
}

export function taskStatus(s: AppState, task: Task): TaskStatus {
  return latestRun(s, task)?.status ?? 'draft';
}

export const openRuns = (s: AppState): Run[] => Object.values(s.runs).filter((r) => isOpenRun(r.status));

/** Pending approvals across every task, oldest first. */
export function pendingApprovals(s: AppState): Approval[] {
  return Object.values(s.runs).flatMap((r) => r.approvals.filter((a) => a.status === 'pending')).sort((a, b) => a.createdAt - b.createdAt);
}

/** `done` counts steps that really ran to completion; skipped steps (rejected approval, disabled tool)
 *  are counted apart so "4/5" never hides a step that did not run. `finished` = done + skipped. */
export function stepProgress(run?: Run) {
  if (!run) return { done: 0, skipped: 0, finished: 0, total: 0, current: -1 };
  const done = run.plan.filter((st) => st.status === 'done').length;
  const skipped = run.plan.filter((st) => st.status === 'skipped').length;
  const current = run.plan.findIndex((st) => st.status === 'running' || st.status === 'awaiting');
  return { done, skipped, finished: done + skipped, total: run.plan.length, current };
}

export const gateway = (s: AppState) => s.connections.find((c) => c.id === GATEWAY_ID);

/** What an agent is doing in the context of a run. */
export function agentActivity(s: AppState, run: Run | undefined, agentId: AgentId): AgentActivity {
  if (!run || !isOpenRun(run.status)) return 'idle';
  const gw = gateway(s);
  if (gw && (gw.status === 'disconnected' || gw.status === 'reconnecting')) return 'offline';
  if (run.live?.agentId !== agentId) return 'idle';
  if (run.status === 'paused') return 'paused';
  if (run.status === 'awaiting') return 'waiting';
  return run.live.activity;
}

/** Wall time of a run: from start to end, or to now while it is open. */
export function wallMs(run: Run, now: number) {
  if (!run.startedAt) return 0;
  return (run.endedAt ?? now) - run.startedAt;
}

export const runLabel = (run: Pick<Run, 'attempt'>) => `运行 #${run.attempt}`;
