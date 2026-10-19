/* Shared task facts for the welcome page and the task list: one flat, comparable summary per task,
   so lists re-render only when something a row shows actually changes (the engine commits run time
   five times a second). */
import { CircleDashed, MessageCircle } from 'lucide-react';
import { RUN_STATUS, isOpenRun, type StatusMeta } from '../../../lib/status';
import type { AgentId, AppState, DataSource } from '../../../lib/types';
import { latestRun, stepProgress, type TaskStatus } from '../../../state/selectors';
import { shallow } from '../../../state/store';

/** A task that has never been run. Same shape as the run statuses so it renders as a StatusChip. */
export const DRAFT_META: StatusMeta = { label: '未开始', tone: 'neutral', icon: CircleDashed };

export const CHAT_META: StatusMeta = { label: '闲聊', tone: 'info', icon: MessageCircle };

export const metaOf = (status: TaskStatus, kind?: 'chat' | 'work'): StatusMeta => (kind === 'chat' ? CHAT_META : status === 'draft' ? DRAFT_META : RUN_STATUS[status]);

export interface TaskSummary {
  id: string;
  title: string;
  goal: string;
  source: DataSource;
  createdAt: number;
  updatedAt: number;
  agentIds: AgentId[];
  /** Status of the latest run, or 'draft' when there is none. */
  status: TaskStatus;
  /** Latest run attempt (1-based); 0 when never run. */
  attempt: number;
  stepsDone: number;
  stepsTotal: number;
  /** Approvals waiting on the user in the latest run. */
  pending: number;
  /** Failure message of the latest run when it failed ('' when the run gave none). */
  failure?: string;
  kind: 'chat' | 'work';
  /** Real model label, when the task runs on one. */
  engine?: string;
}

/** One summary per task, newest created first (the store's taskOrder). */
export function selectSummaries(s: AppState): TaskSummary[] {
  const out: TaskSummary[] = [];
  for (const id of s.taskOrder) {
    const task = s.tasks[id];
    if (!task) continue;
    const run = latestRun(s, task);
    const { done, total } = stepProgress(run);
    out.push({
      id,
      title: task.title,
      goal: task.goal,
      // A retry of a sample task creates a live-simulated run, and everything else on the row
      // (status, progress, failure) comes from that run, so the provenance follows the latest run.
      source: run?.source ?? task.source,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      agentIds: task.agentIds,
      status: run?.status ?? 'draft',
      attempt: run?.attempt ?? 0,
      stepsDone: done,
      stepsTotal: total,
      pending: run && isOpenRun(run.status) ? run.approvals.filter((a) => a.status === 'pending').length : 0,
      failure: run?.status === 'failed' ? (run.failure?.message ?? '') : undefined,
      kind: task.kind ?? 'work',
      engine: task.engine?.label,
    });
  }
  return out;
}

/** Use as the `equal` argument of useApp(selectSummaries, …). */
export const summariesEqual = (a: TaskSummary[], b: TaskSummary[]) =>
  a.length === b.length && a.every((item, i) => shallow(item, b[i]));

/** "第 2 次运行" / "尚未运行". */
export const runText = (t: Pick<TaskSummary, 'status' | 'attempt'> & { kind?: 'chat' | 'work' }) => (t.kind === 'chat' ? '闲聊' : t.status === 'draft' ? '尚未运行' : `第 ${t.attempt} 次运行`);

/** "3/5 步", "计划生成中", or "" when the task never ran. */
export function progressText(t: Pick<TaskSummary, 'status' | 'stepsDone' | 'stepsTotal'>) {
  if (t.status === 'draft') return '';
  return t.stepsTotal > 0 ? `${t.stepsDone}/${t.stepsTotal} 步` : '计划生成中';
}
