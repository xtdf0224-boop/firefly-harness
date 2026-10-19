/* Run controls: which buttons exist depends on the status of the task's latest run. Feedback
   (toast + screen-reader announcement) comes from `actions`, not from here. */
import { Hand, Pause, Play, RefreshCw, RotateCcw, Square } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { RunStatus } from '../../lib/types';
import { actions } from '../../state/actions';
import { Button } from '../ui';
import { useTaskEngine } from './shared';

export interface RunControlsProps {
  taskId: string;
  /** The latest run (controls always act on it). Undefined = the task has not run yet. */
  runId?: string;
  status?: RunStatus;
}

export function RunControls({ taskId, runId, status }: RunControlsProps) {
  const { state } = useTaskEngine(taskId);
  const hintId = useId();

  // Starting, resuming and retrying need a model that can run; pausing and cancelling do not.
  const needsModel = !runId || status === 'paused' || status === 'failed' || status === 'cancelled' || status === 'completed';
  const blocked = state !== 'ready' && needsModel;
  const gate = blocked ? { disabled: true, title: '这个任务的模型现在不可用', 'aria-describedby': hintId } : {};
  const verb = !runId ? '开始' : status === 'paused' ? '继续' : '重试';

  let buttons: ReactNode;
  if (!runId || !status) {
    buttons = (
      <Button variant="primary" size="lg" icon={Play} onClick={() => actions.startRun(taskId)} {...gate}>开始</Button>
    );
  } else {
    const id = runId;
    const cancel = <Button variant="danger" icon={Square} onClick={() => actions.requestCancel(id)}>取消</Button>;
    const pause = <Button icon={Pause} onClick={() => actions.pauseRun(id)}>暂停</Button>;
    switch (status) {
      case 'queued':
        buttons = cancel;
        break;
      case 'running':
        buttons = <>{pause}{cancel}</>;
        break;
      case 'awaiting':
        buttons = (
          <>
            <Button variant="warning" size="lg" icon={Hand} onClick={() => actions.requestFocus('approvals')}>前往确认</Button>
            {pause}
            {cancel}
          </>
        );
        break;
      case 'paused':
        buttons = (
          <>
            <Button variant="primary" size="lg" icon={Play} onClick={() => actions.resumeRun(id)} {...gate}>继续</Button>
            {cancel}
          </>
        );
        break;
      case 'failed':
        buttons = (
          <>
            <Button variant="primary" size="lg" icon={RotateCcw} onClick={() => actions.retryRun(id, 'resume')} {...gate}>从失败处重试</Button>
            <Button icon={RefreshCw} onClick={() => actions.retryRun(id, 'restart')} {...gate}>从头运行</Button>
          </>
        );
        break;
      case 'cancelled':
        buttons = (
          <>
            <Button variant="primary" size="lg" icon={RotateCcw} onClick={() => actions.retryRun(id, 'resume')} {...gate}>继续未完成的步骤</Button>
            <Button icon={RefreshCw} onClick={() => actions.retryRun(id, 'restart')} {...gate}>从头运行</Button>
          </>
        );
        break;
      case 'completed':
        buttons = <Button icon={RefreshCw} onClick={() => actions.retryRun(id, 'restart')} {...gate}>再次运行</Button>;
        break;
    }
  }

  return (
    <div className="ws-controls" role="group" aria-label="运行控制">
      {buttons}
      {blocked && <span className="ws-controls__hint" id={hintId}>模型现在不可用，到「模型接入」处理后才能{verb}。</span>}
    </div>
  );
}
