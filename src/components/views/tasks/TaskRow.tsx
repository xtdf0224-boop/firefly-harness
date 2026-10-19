/* One row of the task list. The main <button> opens the task; delete is a separate trailing button.
   Accents: running → breathing mint edge; awaiting → gold edge + 待确认 badge; failed → dashed danger
   edge + the failure message. The chip always carries the status as icon + text. */
import { AlertTriangle, Trash2 } from 'lucide-react';
import { memo, useId } from 'react';
import { relative } from '../../../lib/format';
import type { Agent, Tone } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { AgentAvatar, Badge, EngineTag, IconButton, Meter, StatusChip, cx } from '../../ui';
import { metaOf, progressText, runText, type TaskSummary } from './taskInfo';

const METER_TONE: Partial<Record<TaskSummary['status'], Tone>> = {
  completed: 'success', failed: 'danger', awaiting: 'warning', paused: 'paused', cancelled: 'neutral', queued: 'neutral',
};

function AgentStack({ agents, ids }: { agents: Agent[]; ids: string[] }) {
  const members = ids.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
  return (
    <span className="task-list-row__agents" aria-hidden>
      {members.map((a) => (
        <span key={a.id} title={a.name} className="task-list-row__agent"><AgentAvatar agent={a} size="sm" /></span>
      ))}
    </span>
  );
}

export const TaskRow = memo(function TaskRow({ task, agents, now }: { task: TaskSummary; agents: Agent[]; now: number }) {
  const uid = useId();
  const meta = metaOf(task.status, task.kind);
  const hasRun = task.status !== 'draft' && task.kind !== 'chat';
  const progress = progressText(task);
  const names = task.agentIds.map((id) => agents.find((a) => a.id === id)?.name).filter(Boolean).join('、');
  const engineText = task.engine ? `使用模型：${task.engine}` : '还没有选模型';
  const updated = relative(task.updatedAt, now);
  const description = [
    meta.label,
    task.pending > 0 ? `${task.pending} 项待确认` : '',
    task.failure ? `失败原因：${task.failure}` : '',
    runText(task),
    progress,
    names ? `参与：${names}` : '',
    `更新于 ${updated}`,
    engineText,
  ].filter(Boolean).join('，');

  return (
    <li className={cx('task-list-row', `task-list-row--${task.status}`, task.status === 'running' && 'is-breathing')}>
      <button type="button" className="task-list-row__main" onClick={() => actions.openTask(task.id)} aria-labelledby={`${uid}-t`} aria-describedby={`${uid}-d`}>
        <span className="task-list-row__status"><StatusChip meta={meta} /></span>

        <span className="task-list-row__text">
          <span className="task-list-row__title-line">
            <span className="task-list-row__title truncate" id={`${uid}-t`}>{task.title}</span>
            {task.pending > 0 && <Badge tone="warning" title={`${task.pending} 项操作等待你确认`}>待确认 {task.pending}</Badge>}
          </span>
          <span className="task-list-row__goal truncate">{task.goal}</span>
          {task.status === 'failed' && (
            <span className="task-list-row__failure">
              <AlertTriangle size={13} aria-hidden />
              <span className="truncate">{task.failure || '运行失败，打开任务查看原因。'}</span>
            </span>
          )}
        </span>

        <span className="task-list-row__aside">
          <span className="task-list-row__line">
            <span className="task-list-row__run">{runText(task)}</span>
            <span className="task-list-row__time">{updated}</span>
          </span>
          {hasRun && (
            <span className="task-list-row__line">
              {task.stepsTotal > 0 && (
                <span className="task-list-row__meter">
                  <Meter value={task.stepsDone} max={task.stepsTotal} segments={12} tone={METER_TONE[task.status] ?? 'running'} label="步骤进度" valueText={progress} />
                </span>
              )}
              <span className="task-list-row__steps">{progress}</span>
            </span>
          )}
          <span className="task-list-row__line">
            <AgentStack agents={agents} ids={task.agentIds} />
            {task.engine ? <EngineTag label={task.engine} compact /> : <Badge tone="warning" title="这个任务还没有选模型，打开后可以选一个">未选模型</Badge>}
          </span>
        </span>
        <span className="sr-only" id={`${uid}-d`}>{description}</span>
      </button>

      <IconButton className="task-list-row__delete" icon={Trash2} label={`删除任务「${task.title}」`} onClick={() => actions.requestDeleteTask(task.id)} />
    </li>
  );
});
