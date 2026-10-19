/* 错误 tab: every error of the run, newest first. */
import { CheckCircle2, ChevronRight, Flag, RotateCcw, Wrench, XOctagon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { timeOfDay } from '../../lib/format';
import type { StatusMeta } from '../../lib/status';
import type { DataSource, PlanStep, RunErrorRecord } from '../../lib/types';
import { actions } from '../../state/actions';
import { useApp } from '../../state/store';
import { Badge, Button, CodeBlock, EmptyState, SimTag, StatusChip, cx } from '../ui';

const EMPTY_ERRORS: RunErrorRecord[] = [];
const EMPTY_PLAN: PlanStep[] = [];

const FATAL: StatusMeta = { label: '导致运行失败', tone: 'danger', icon: Flag };
const RECOVERED: StatusMeta = { label: '已自动恢复', tone: 'success', icon: RotateCcw };

export function ErrorsTab({ runId }: { runId?: string }) {
  const errors = useApp((s) => (runId ? s.runs[runId]?.errors : undefined)) ?? EMPTY_ERRORS;
  const plan = useApp((s) => (runId ? s.runs[runId]?.plan : undefined)) ?? EMPTY_PLAN;
  const runStatus = useApp((s) => (runId ? s.runs[runId]?.status : undefined));
  const source = useApp((s): DataSource => (runId ? s.runs[runId]?.source : undefined) ?? 'simulated');
  // Retry only belongs on the task's newest run, as in the workspace: retrying an older failed run
  // while a newer one exists would branch a spurious extra run from it.
  const isLatest = useApp((s) => {
    const task = runId ? s.tasks[s.runs[runId]?.taskId ?? ''] : undefined;
    return !!task && task.runIds[task.runIds.length - 1] === runId;
  });

  const sorted = useMemo(() => [...errors].sort((a, b) => b.at - a.at), [errors]);
  const fatalCount = errors.filter((e) => e.fatal).length;
  const stepLabel = (stepId?: string) => {
    const step = stepId ? plan.find((p) => p.id === stepId) : undefined;
    return step ? `第 ${step.index + 1} 步 · ${step.title}` : undefined;
  };

  return (
    <>
      {runId && (
        <div className="console__toolbar">
          <SimTag source={source} />
          <span className="console__note">
            {errors.length === 0
              ? '没有错误'
              : `共 ${errors.length} 个错误：${fatalCount} 个导致运行失败，${errors.length - fatalCount} 个已自动恢复`}
          </span>
        </div>
      )}
      <div className="console__pane">
        <div className="console__scroll">
          {sorted.length > 0 ? (
            <ul className="errs" aria-label="错误列表">
              {sorted.map((err, i) => (
                <li key={err.id}>
                  <ErrorCard err={err} step={stepLabel(err.stepId)} retryable={err.fatal && runStatus === 'failed' && isLatest}
                    historic={err.fatal && runStatus === 'failed' && !isLatest}
                    runId={runId!} defaultOpen={err.fatal && i === 0} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact icon={CheckCircle2}
              title={runId ? '没有错误' : '还没有运行'}
              body={runId ? '这次运行没有出现错误。' : '开始一个任务后，运行中的错误会显示在这里。'} />
          )}
        </div>
      </div>
    </>
  );
}

function ErrorCard({ err, step, retryable, historic, runId, defaultOpen }: {
  err: RunErrorRecord; step?: string; retryable: boolean; historic: boolean; runId: string; defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const detailId = useId();
  return (
    <article className={cx('err-card', err.fatal ? 'err-card--fatal' : 'err-card--recovered')}>
      <header className="err-card__head">
        <XOctagon className="err-card__icon" size={16} aria-hidden />
        <h3 className="err-card__title">{err.title}</h3>
        <Badge tone="danger" className="err-card__code">{err.code}</Badge>
        <StatusChip meta={err.fatal ? FATAL : RECOVERED} size="sm" glow={false} />
        <span className="err-card__meta">
          <time dateTime={new Date(err.at).toISOString()}>{timeOfDay(err.at)}</time>
          {step && <span className="err-card__step"> · {step}</span>}
        </span>
      </header>
      <p className="err-card__msg">{err.message}</p>

      {err.detail && (
        <>
          <button type="button" className="err-card__disclosure" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((v) => !v)}>
            <ChevronRight size={13} aria-hidden />错误详情
          </button>
          <div id={detailId} hidden={!open}>
            {open && <CodeBlock code={err.detail} caption="错误详情" maxHeight={200} wrap />}
          </div>
        </>
      )}

      {(retryable || historic || err.toolCallId) && (
        <div className="err-card__actions">
          {retryable && (
            <Button size="sm" variant="primary" icon={RotateCcw} onClick={() => actions.retryRun(runId, 'resume')}>从失败处重试</Button>
          )}
          {historic && <span className="err-card__note">这是历史运行，重试请在最新运行上进行</span>}
          {err.toolCallId && (
            <Button size="sm" variant="ghost" icon={Wrench} onClick={() => actions.openConsole('tools', err.toolCallId)}>查看调用</Button>
          )}
        </div>
      )}
    </article>
  );
}
