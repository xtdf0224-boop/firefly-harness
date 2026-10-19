/* Small helpers shared by the workspace components: status mapping, durations, whether a task's
   model can run right now, and the one-shot focus-request hook. Nothing here renders. */
import { Circle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { RUN_STATUS, STEP_STATUS, type StatusMeta } from '../../lib/status';
import type { AppState, PlanStep, RunStatus } from '../../lib/types';
import { engineChoices, type EngineChoice } from '../../state/models';
import { useApp } from '../../state/store';

/** Chip for a task that has no run yet. */
export const NO_RUN_META: StatusMeta = { label: '未开始', tone: 'neutral', icon: Circle };

export const RUN_ENDED: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);
export const RUN_OPEN: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'paused', 'awaiting']);

/** Step tallies for the workspace. `done` counts only steps that really ran to completion; a step
 *  the user rejected (or whose tool is disabled) is `skipped` and is reported separately, so the
 *  header, the steps bar and the finished-run callout never claim more than was executed. */
export function stepCounts(plan: readonly PlanStep[]) {
  let done = 0;
  let skipped = 0;
  for (const st of plan) {
    if (st.status === 'done') done += 1;
    else if (st.status === 'skipped') skipped += 1;
  }
  return { done, skipped, total: plan.length };
}

/** Status chip metadata for a plan step in the context of its run:
 *  - a step that was running when the run paused reads 已暂停 instead of 执行中;
 *  - a step that never started in a finished run reads 未执行. */
export function stepMeta(step: PlanStep, runStatus: RunStatus): StatusMeta {
  if (step.status === 'running' && runStatus === 'paused') return RUN_STATUS.paused;
  if (step.status === 'pending' && RUN_ENDED.has(runStatus)) return STEP_STATUS.cancelled;
  return STEP_STATUS[step.status];
}

/** Active ms of a step — excludes approval and pause time, so it agrees with 运行时间 and the tool
 *  call durations. Runs saved before steps tracked activeMs fall back to their wall-clock stamps. */
export function stepDuration(step: PlanStep, runRunning: boolean, now: number): number | undefined {
  if (step.startedAt == null) return undefined;
  if (step.activeMs != null) return step.activeMs;
  if (step.endedAt != null) return Math.max(0, step.endedAt - step.startedAt);
  return runRunning && step.status === 'running' ? Math.max(0, now - step.startedAt) : undefined;
}

/** Can the task's own model run right now? 'ready': its way (key saved / CLI signed in) is set up;
 *  'unavailable': it was, but is not any more; 'unset': the task never recorded a model. */
export type EngineState = 'ready' | 'unavailable' | 'unset';

const selectChoices = (s: AppState) => engineChoices(s.models);
const sameChoices = (a: EngineChoice[], b: EngineChoice[]) => a.length === b.length && a.every((c, i) => c.key === b[i].key && c.label === b[i].label);

export function useTaskEngine(taskId: string) {
  const engine = useApp((s) => s.tasks[taskId]?.engine);
  const choices = useApp(selectChoices, sameChoices);
  const state: EngineState = !engine ? 'unset' : choices.some((c) => c.key === `${engine.provider}:${engine.auth}`) ? 'ready' : 'unavailable';
  return { engine, choices, state };
}

type FocusTarget = NonNullable<AppState['focusRequest']>['target'];

/** Runs `onRequest` once per fresh `actions.requestFocus(target)`. Requests older than 3 s are
 *  ignored, so a stale request in the store never fires when the workspace mounts later. */
export function useFocusRequest(target: FocusTarget, onRequest: () => void) {
  const at = useApp((s) => (s.focusRequest?.target === target ? s.focusRequest.at : 0));
  const handled = useRef(0);
  const callback = useRef(onRequest);
  useEffect(() => { callback.current = onRequest; });
  useEffect(() => {
    if (!at || at === handled.current) return;
    handled.current = at;
    if (Date.now() - at > 3000) return;
    callback.current();
  }, [at]);
}

/** Collapse "\n" inside a paragraph without leaving a stray space between two CJK characters. */
export const isCjk = (ch?: string) => !!ch && /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch);
