/* The state callout under the header: one message per run state, plus every pending approval of
   the run as a full ApprovalCard (preview capped and laid out beside the facts, see workspace.css,
   so the plan and tabs stay in view while the run waits). Failed runs use role="alert";
   everything else role="status". */
import { FlaskConical, Loader, Package, Play, CirclePlay, RotateCcw, Terminal, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { clock } from '../../lib/format';
import { RUN_STATUS } from '../../lib/status';
import type { Approval, RunStatus } from '../../lib/types';
import { actions } from '../../state/actions';
import { gatewayUp } from '../../state/engine';
import { shallow, useApp } from '../../state/store';
import { Button, cx } from '../ui';
import { ApprovalCard } from '../shell/ApprovalCard';
import { stepCounts } from './shared';

const NO_APPROVALS: Approval[] = [];

type CalloutTone = 'neutral' | 'running' | 'success' | 'warning' | 'danger' | 'paused';

function Callout({ tone, icon: Icon, title, children, actions: buttons, role = 'status', live, spin }: {
  tone: CalloutTone; icon: LucideIcon; title: ReactNode; children?: ReactNode; actions?: ReactNode;
  role?: 'status' | 'alert'; live?: boolean; spin?: boolean;
}) {
  return (
    <div className={cx('callout', `callout--${tone}`, live && 'ws-callout--live')} role={role}>
      <Icon className={cx('callout__icon', spin && 'spin')} size={18} aria-hidden />
      <div className="callout__body">
        <p className="callout__title">{title}</p>
        {children}
      </div>
      {buttons && <div className="callout__actions">{buttons}</div>}
    </div>
  );
}

const PAUSE_TEXT: Record<'user' | 'disconnected' | 'reload', string> = {
  user: '你暂停了运行。',
  disconnected: '连接断开后自动暂停，恢复连接后可继续。',
  reload: '页面重新载入后已暂停。',
};

export interface RunCalloutProps {
  taskId: string;
  /** The run being viewed. Undefined = the task has not run yet. */
  runId?: string;
  /** The latest run. Action buttons only appear when the viewed run is the latest one. */
  latestId?: string;
}

export function RunCallout({ runId, latestId }: RunCalloutProps) {
  const run = useApp((s) => {
    const r = runId ? s.runs[runId] : undefined;
    if (!r) return undefined;
    return {
      status: r.status, pauseReason: r.pauseReason, planReady: r.planReady, plan: r.plan, failure: r.failure,
      // Only needed once the run has finished; keeping it 0 while running avoids a render per second.
      sec: r.status === 'completed' ? Math.floor(r.activeMs / 1000) : 0,
      artifacts: r.artifacts.length,
    };
  }, shallow);
  const pending = useApp((s) => (runId ? s.runs[runId]?.approvals.filter((a) => a.status === 'pending') : undefined) ?? NO_APPROVALS, shallow);
  const up = useApp(gatewayUp);
  const interactive = !!runId && runId === latestId;

  if (!runId || !run) {
    return (
      <Callout tone="neutral" icon={CirclePlay} title="准备就绪">
        <p className="callout__text">点击开始后，编排 Agent 会先制定计划；写文件、执行命令等操作会先征求你的确认。</p>
        <p className="ws-callout__tag">
          <span className="sim-tag" title="演示模式：由浏览器内的模拟器生成，没有调用真实模型、工具或命令。">
            <FlaskConical size={11} aria-hidden />将由模拟器执行
          </span>
        </p>
      </Callout>
    );
  }

  const status: RunStatus = run.status;
  const approvalCards = pending.length > 0 && (status === 'awaiting' || status === 'paused') && (
    <div className="ws-approvals" role="group" aria-label="待确认的操作">
      {pending.map((a) => <ApprovalCard key={a.id} approval={a} />)}
    </div>
  );

  let callout: ReactNode = null;
  switch (status) {
    case 'queued':
      callout = <Callout tone="neutral" icon={RUN_STATUS.queued.icon} title="排队中"><p className="callout__text">等待模拟器开始执行。</p></Callout>;
      break;

    case 'running':
      if (!run.planReady) {
        callout = <Callout tone="running" icon={Loader} spin live title="编排 Agent 正在制定计划…" />;
      }
      break;

    case 'awaiting':
      callout = (
        <Callout tone="warning" icon={RUN_STATUS.awaiting.icon} title="等待你的确认">
          <p className="callout__text">
            {pending.length > 1 ? `${pending.length} 项操作等待批准：` : '待批准：'}
            {pending.map((a) => `「${a.title}」`).join('、')}
          </p>
        </Callout>
      );
      break;

    case 'paused':
      callout = (
        <Callout
          tone="paused" icon={RUN_STATUS.paused.icon} title="运行已暂停"
          actions={interactive && (
            <Button variant="primary" size="sm" icon={Play} disabled={!up} title={up ? undefined : '模型网关未连接'} onClick={() => actions.resumeRun(runId)}>继续</Button>
          )}
        >
          <p className="callout__text">
            {PAUSE_TEXT[run.pauseReason ?? 'user']}
            {pending.length > 0 && `还有 ${pending.length} 项操作待确认。`}
            {!up && interactive && '模型网关未连接，暂时不能继续。'}
          </p>
        </Callout>
      );
      break;

    case 'failed': {
      const step = run.plan.find((s) => s.id === run.failure?.stepId);
      callout = (
        <Callout
          tone="danger" role="alert" icon={RUN_STATUS.failed.icon}
          title={step ? `第 ${step.index + 1} 步「${step.title}」失败` : '运行失败'}
          actions={interactive && (
            <>
              <Button variant="primary" size="sm" icon={RotateCcw} disabled={!up} title={up ? undefined : '模型网关未连接'} onClick={() => actions.retryRun(runId, 'resume')}>从失败处重试</Button>
              <Button variant="ghost" size="sm" icon={Terminal} onClick={() => actions.openConsole('errors')}>查看错误</Button>
            </>
          )}
        >
          {run.failure && <p className="callout__text">{run.failure.message}</p>}
        </Callout>
      );
      break;
    }

    case 'cancelled':
      callout = <Callout tone="neutral" icon={RUN_STATUS.cancelled.icon} title="运行已取消"><p className="callout__text">已生成的产物仍然保留。</p></Callout>;
      break;

    case 'completed': {
      // A run can finish with steps the user rejected (or whose tool is disabled). That is still
      // "completed", but it must not read as a clean success: no ember, neutral tone, skip note.
      const { skipped, total } = stepCounts(run.plan);
      callout = (
        <Callout
          tone={skipped > 0 ? 'neutral' : 'success'} icon={RUN_STATUS.completed.icon}
          title={<>运行完成{skipped === 0 && <span className="ws-ember" aria-hidden />}</>}
          actions={run.artifacts > 0 && <Button size="sm" icon={Package} onClick={() => actions.setWorkspaceTab('artifacts')}>查看产物</Button>}
        >
          <p className="callout__text">
            共 {total} 步，用时 {clock(run.sec * 1000)}
            {skipped > 0 ? `，其中 ${skipped} 步已跳过未执行。` : '。'}
          </p>
          <p className="ws-callout__quiet">{skipped > 0 ? '被跳过的步骤没有执行，原因见「执行步骤」。' : '这一程已经抵达终点。'}</p>
        </Callout>
      );
      break;
    }
  }

  if (!callout && !approvalCards) return null;
  return <div className="ws-callouts">{callout}{approvalCards}</div>;
}
