/* Row model + selector for the run history table. One row per run, newest first. */
import { isOpenRun } from '../../../lib/status';
import type { AppState, RunStatus } from '../../../lib/types';
import { stepProgress } from '../../../state/selectors';

export interface HistoryRow {
  id: string;
  taskId: string;
  title: string;
  attempt: number;
  /** Attempt number of the run this one retried; 0 when that run is gone. Undefined for first attempts. */
  retryOf?: number;
  status: RunStatus;
  startedAt: number;
  activeMs: number;
  stepsDone: number;
  stepsTotal: number;
  inputTokens: number;
  outputTokens: number;
  artifacts: number;
  /** The model the run used, e.g. 「Claude Sonnet 5.5 · Claude Code」. */
  model: string;
  /** Models of Agents that ran their steps on a model of their own, joined with 、 ('' = none). */
  agentModels: string;
  agentModelCount: number;
}

export function selectHistoryRows(s: AppState): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const run of Object.values(s.runs)) {
    const task = s.tasks[run.taskId];
    if (!task) continue;
    const { done, total } = stepProgress(run);
    const own = [...new Set(Object.values(run.agentEngines ?? {}).map((e) => e?.label).filter((l): l is string => !!l))];
    rows.push({
      id: run.id,
      taskId: task.id,
      title: task.title,
      attempt: run.attempt,
      retryOf: run.retryOf ? (s.runs[run.retryOf]?.attempt ?? 0) : undefined,
      status: run.status,
      startedAt: run.startedAt ?? run.createdAt,
      activeMs: run.activeMs,
      stepsDone: done,
      stepsTotal: total,
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
      artifacts: run.artifacts.length,
      model: run.engineLabel ?? task.engine?.label ?? '',
      agentModels: own.join('、'),
      agentModelCount: own.length,
    });
  }
  return rows.sort((a, b) => b.startedAt - a.startedAt || b.attempt - a.attempt);
}

export type StatusFilter = 'all' | 'completed' | 'failed' | 'cancelled' | 'open';

export const matchesFilter = (status: RunStatus, filter: StatusFilter) => {
  switch (filter) {
    case 'all': return true;
    case 'open': return isOpenRun(status);
    default: return status === filter;
  }
};

export const isFinished = (status: RunStatus) => status === 'completed' || status === 'failed' || status === 'cancelled';
