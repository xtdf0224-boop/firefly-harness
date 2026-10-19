/* 执行步骤: one card per plan step with its tool calls, pending approvals and live thinking row. */
import { Info, ListChecks, OctagonX } from 'lucide-react';
import { memo, useEffect, useId, useMemo } from 'react';
import { duration } from '../../lib/format';
import { useNow, useReducedMotion } from '../../lib/hooks';
import type { Agent, Approval, LiveActivity, PlanStep, RunStatus, ToolCall } from '../../lib/types';
import { actions } from '../../state/actions';
import { shallow, useApp } from '../../state/store';
import { ToolCallItem } from '../console/ToolCallItem';
import { ApprovalCard } from '../shell/ApprovalCard';
import { AgentAvatar, EmptyState, StatusChip } from '../ui';
import { RUN_ENDED, RUN_OPEN, stepCounts, stepDuration, stepMeta } from './shared';

export interface StepTarget { id: string; n: number }

export interface StepsViewProps {
  runId?: string;
  /** Set when the plan view asks for a step: scroll its card into view and move focus there. */
  target: StepTarget | null;
  /** Called once the request has been served, so a later visit to the tab does not scroll again. */
  onHandled: () => void;
}

export function StepsView({ runId, target, onHandled }: StepsViewProps) {
  const run = useApp((s) => {
    const r = runId ? s.runs[runId] : undefined;
    return r ? {
      plan: r.plan, planReady: r.planReady, status: r.status, toolCalls: r.toolCalls, approvals: r.approvals,
      retryOf: r.retryOf, live: r.live, source: r.source,
    } : undefined;
  }, shallow);
  const agents = useApp((s) => s.agents);
  const reduced = useReducedMotion();

  // Open the requested step: the card exists by the time this effect runs (the tab was just shown).
  useEffect(() => {
    if (!target || !run?.planReady) return;
    const card = document.getElementById(`step-${target.id}`);
    if (!card) return;
    // Scroll only the steps list itself (not the whole workspace), with the card at the top.
    const host = card.closest<HTMLElement>('.ws-steps__scroll');
    if (host) {
      const top = card.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop - 8;
      host.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
    }
    card.focus({ preventScroll: true });
    card.setAttribute('data-flash', 'true');
    window.setTimeout(() => card.removeAttribute('data-flash'), 1600); // harmless if the card is gone by then
    onHandled();
  }, [target?.n]);

  if (!run) {
    return <EmptyState icon={ListChecks} title="还没有执行步骤" body="开始运行后，每一步的工具调用和结果会按顺序出现在这里。" />;
  }
  if (!run.planReady) {
    return (
      <EmptyState
        compact icon={ListChecks}
        title={RUN_OPEN.has(run.status) ? '计划制定中' : '计划尚未生成'}
        body={RUN_OPEN.has(run.status) ? '计划生成后，每一步会在这里依次展开。' : '这次运行结束时还没有生成计划，所以没有可显示的步骤。'}
      />
    );
  }

  const { done, skipped, total } = stepCounts(run.plan);
  return (
    <div className="ws-steps">
      <div className="ws-steps__bar">
        <p>
          共 {total} 步 · 已完成 {done}{skipped > 0 && ` · 已跳过 ${skipped}`} · 工具调用 {run.toolCalls.length} 次
        </p>
      </div>
      <div className="ws-steps__scroll" role="region" aria-label="步骤列表" tabIndex={0}>
        <ol className="ws-steps__list" role="list">
          {run.plan.map((step) => (
            <li key={step.id}>
              <StepCard
                step={step} runStatus={run.status} toolCalls={run.toolCalls} approvals={run.approvals}
                live={run.live} retryOf={run.retryOf} agent={agents.find((a) => a.id === step.agentId)}
              />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

interface StepCardProps {
  step: PlanStep;
  runStatus: RunStatus;
  toolCalls: ToolCall[];
  approvals: Approval[];
  live?: LiveActivity;
  retryOf?: string;
  agent?: Agent;
}

const StepCard = memo(function StepCard({ step, runStatus, toolCalls, approvals, live, retryOf, agent }: StepCardProps) {
  const titleId = useId();
  const running = runStatus === 'running';
  const stepLive = step.status === 'running' && running;
  const now = useNow(1000, stepLive);
  const meta = stepMeta(step, runStatus);
  const dur = stepDuration(step, running, now);
  const ended = RUN_ENDED.has(runStatus);
  const idle = step.status === 'pending' || (step.status === 'cancelled' && step.startedAt == null);

  const calls = useMemo(
    () => step.toolCallIds.map((id) => toolCalls.find((c) => c.id === id)).filter((c): c is ToolCall => !!c),
    [step.toolCallIds, toolCalls],
  );
  const pending = useMemo(() => approvals.filter((a) => a.stepId === step.id && a.status === 'pending'), [approvals, step.id]);
  // For carried steps, name the run whose result was reused.
  const fromAttempt = useApp((s) => (step.carried && retryOf ? s.runs[retryOf]?.attempt : undefined));
  const thinking = stepLive && live?.activity === 'thinking' ? live.text : undefined;

  return (
    <article
      id={`step-${step.id}`} className="ws-step" tabIndex={-1} aria-labelledby={titleId}
      data-status={step.status} data-live={stepLive ? 'true' : undefined} data-idle={idle ? 'true' : undefined}
    >
      <header className="ws-step__head">
        <span className="ws-badge" aria-hidden>{step.index + 1}</span>
        <div className="ws-step__titles">
          <h3 className="ws-step__title" id={titleId}><span className="sr-only">第 {step.index + 1} 步：</span>{step.title}</h3>
          <p className="ws-step__sub">
            {agent && (
              <span className="ws-step__agent"><AgentAvatar agent={agent} size="sm" />{agent.name}</span>
            )}
            {dur != null && <span>耗时 {duration(dur)}</span>}
          </p>
        </div>
        <StatusChip meta={meta} />
      </header>

      {idle ? (
        <p className="ws-step__idle">{ended ? '未执行' : '尚未开始'}</p>
      ) : (
        <div className="ws-step__body">
          {step.detail && <p className="ws-step__detail">{step.detail}</p>}

          {step.carried ? (
            <p className="ws-step__carried">
              {fromAttempt ? `沿用第 ${fromAttempt} 次运行的结果` : '沿用上次运行的结果'}
              {retryOf && <button type="button" className="ws-link" onClick={() => actions.selectRun(retryOf)}>查看那次运行</button>}
            </p>
          ) : step.note ? (
            <p className="ws-step__note" data-tone={step.status === 'failed' ? 'danger' : undefined}>
              {step.status === 'failed' ? <OctagonX size={14} aria-hidden /> : <Info size={14} aria-hidden />}
              <span>{step.note}</span>
            </p>
          ) : null}

          {thinking && (
            <p className="ws-step__thinking">
              <span className="ws-pulse" aria-hidden />
              正在思考：{thinking}
            </p>
          )}

          {calls.length > 0 && (
            <ul className="ws-step__calls" role="list" aria-label="工具调用">
              {calls.map((c) => (
                <li key={c.id}><ToolCallItem call={c} dense paused={runStatus === 'paused'} /></li>
              ))}
            </ul>
          )}

          {pending.map((a) => <ApprovalCard key={a.id} approval={a} />)}
        </div>
      )}
    </article>
  );
});
