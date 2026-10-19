/* Run controls: which buttons exist depends on the status of the task's latest run. Feedback
   (toast + screen-reader announcement) comes from `actions`, not from here. */
import { Hand, Pause, Play, RefreshCw, RotateCcw, Square } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { RunStatus } from '../../lib/types';
import { actions } from '../../state/actions';
import { gatewayUp } from '../../state/engine';
import { useApp } from '../../state/store';
import { Button } from '../ui';

export interface RunControlsProps {
  taskId: string;
  /** The latest run (controls always act on it). Undefined = the task has not run yet. */
  runId?: string;
  status?: RunStatus;
}

export function RunControls({ taskId, runId, status }: RunControlsProps) {
  const up = useApp(gatewayUp);
  const hintId = useId();

  // Starting, resuming and retrying all need the model gateway; pausing and cancelling do not.
  const needsGateway = !runId || status === 'paused' || status === 'failed' || status === 'cancelled' || status === 'completed';
  const blocked = !up && needsGateway;
  const gate = blocked ? { disabled: true, title: '模型网关未连接', 'aria-describedby': hintId } : {};
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
      {blocked && <span className="ws-controls__hint" id={hintId}>模型网关未连接，恢复连接后才能{verb}。</span>}
    </div>
  );
}
