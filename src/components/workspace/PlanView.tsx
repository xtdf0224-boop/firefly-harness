/* 任务计划: the plan as a vertical rail (wide) or a horizontal stepper (narrow — pure CSS, the
   markup is the same). Every step is a button that opens its card in the 执行步骤 tab. */
import { Loader } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { duration } from '../../lib/format';
import { useNow, useReducedMotion } from '../../lib/hooks';
import { shallow, useApp } from '../../state/store';
import { AgentAvatar, EngineTag, Panel, StatusChip } from '../ui';
import { RUN_OPEN, stepDuration, stepMeta } from './shared';

const SKELETON_ROWS = [0, 1, 2, 3];

export interface PlanViewProps {
  /** The run being viewed. Undefined = the task has not run yet. */
  runId?: string;
  onOpenStep: (stepId: string) => void;
}

export function PlanView({ runId, onOpenStep }: PlanViewProps) {
  const run = useApp((s) => {
    const r = runId ? s.runs[runId] : undefined;
    return r ? { plan: r.plan, planReady: r.planReady, status: r.status } : undefined;
  }, shallow);
  const agents = useApp((s) => s.agents);
  const reduced = useReducedMotion();
  const running = run?.status === 'running';
  const now = useNow(1000, running);
  const listRef = useRef<HTMLOListElement>(null);

  const currentId = run?.planReady ? run.plan.find((st) => st.status === 'running' || st.status === 'awaiting')?.id : undefined;

  // Keep the active step in view as the run moves on (the rail scrolls vertically, the stepper horizontally).
  useEffect(() => {
    const list = listRef.current;
    const host = list?.parentElement;
    const item = currentId ? list?.querySelector<HTMLElement>(`[data-step-id="${currentId}"]`) : null;
    if (!host || !item) return;
    host.scrollTo({
      top: item.offsetTop - (host.clientHeight - item.offsetHeight) / 2,
      left: item.offsetLeft - (host.clientWidth - item.offsetWidth) / 2,
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [currentId, reduced]);

  const open = !!run && RUN_OPEN.has(run.status);
  const steps = run?.planReady ? run.plan : undefined;

  return (
    <Panel
      id="ws-plan" className="ws-plan" label="任务计划" energy flush bodyClassName="ws-plan__body"
      title={steps ? `计划 · ${steps.length} 步` : '计划'}
    >
      {steps ? (
        <ol className="ws-plan__list" role="list" ref={listRef}>
          {steps.map((step) => {
            const meta = stepMeta(step, run!.status);
            const agent = agents.find((a) => a.id === step.agentId);
            const dur = stepDuration(step, running, now);
            const current = step.status === 'running' || step.status === 'awaiting';
            // Breathing only while the run really is working or waiting (not paused, not finished).
            const breathing = current && run!.status !== 'paused';
            return (
              <li
                key={step.id} className="ws-plan__item" data-step-id={step.id} data-status={step.status}
                data-current={current ? 'true' : undefined} data-live={breathing ? 'true' : undefined}
              >
                <button
                  type="button" className="ws-plan__step" aria-current={current ? 'step' : undefined}
                  title={`查看第 ${step.index + 1} 步的执行详情`} onClick={() => onOpenStep(step.id)}
                >
                  <span className="ws-badge" aria-hidden>{step.index + 1}</span>
                  <span className="ws-plan__main">
                    <span className="ws-plan__title"><span className="sr-only">第 {step.index + 1} 步：</span>{step.title}</span>
                    <span className="ws-plan__meta">
                      {agent && (
                        <span className="ws-plan__agent">
                          <AgentAvatar agent={agent} size="sm" />
                          <span className="ws-plan__agent-name">{agent.name}</span>
                        </span>
                      )}
                      <StatusChip meta={meta} size="sm" />
                      {step.engineLabel && <EngineTag label={step.engineLabel} compact />}
                      {dur != null && <span className="ws-plan__dur">{duration(dur)}</span>}
                    </span>
                    {step.note && <span className="ws-plan__note">{step.note}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="ws-plan__empty">
          {!run ? (
            <p className="ws-plan__hint">开始运行后，编排 Agent 会在这里列出计划。</p>
          ) : open ? (
            <>
              <ul className="ws-plan__skeleton" role="presentation" aria-hidden>
                {SKELETON_ROWS.map((i) => <li key={i} data-still={run.status !== 'running' && run.status !== 'queued' ? 'true' : undefined}><i /><b /></li>)}
              </ul>
              <p className="ws-plan__hint">
                <Loader size={14} aria-hidden className={run.status === 'running' ? 'spin' : undefined} />
                {run.status === 'paused' ? '运行已暂停，计划尚未生成。' : '编排 Agent 正在制定计划…'}
              </p>
            </>
          ) : (
            <p className="ws-plan__hint">计划尚未生成</p>
          )}
        </div>
      )}
    </Panel>
  );
}
