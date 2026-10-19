/* 任务工作区 (view "task"): header + goal + state callout, then the plan next to the tabbed
   conversation / steps / artifacts. Reads the selected task and run from the store; every control
   goes through `actions`. All run data shown here is simulated and labelled as such. */
import { ListChecks, MessageSquare, Package } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useReducedMotion } from '../../lib/hooks';
import { actions } from '../../state/actions';
import { currentRun, latestRun } from '../../state/selectors';
import { shallow, useApp } from '../../state/store';
import { SimTag, Tabs, tabPanelProps, type TabItem } from '../ui';
import { ArtifactsView } from './ArtifactsView';
import { ChatWorkspace } from './ChatWorkspace';
import { Conversation } from './Conversation';
import { GoalCard } from './GoalCard';
import { PlanView } from './PlanView';
import { RunCallout } from './RunCallout';
import { RunHeader } from './RunHeader';
import { useFocusRequest } from './shared';
import { StepsView, type StepTarget } from './StepsView';
import type { WorkspaceTab } from '../../lib/types';

export function Workspace() {
  const taskId = useApp((s) => (s.selectedTaskId && s.tasks[s.selectedTaskId] ? s.selectedTaskId : undefined));
  const chat = useApp((s) => (taskId ? s.tasks[taskId]?.kind === 'chat' : false));
  // Keyed by task, so drafts, selections and scroll state never leak from one task into another.
  if (!taskId) return null;
  return chat ? <ChatWorkspace key={taskId} taskId={taskId} /> : <TaskWorkspace key={taskId} taskId={taskId} />;
}

function TaskWorkspace({ taskId }: { taskId: string }) {
  const { runId, latestId } = useApp((s) => {
    const task = s.tasks[taskId];
    return { runId: currentRun(s)?.id, latestId: task ? latestRun(s, task)?.id : undefined };
  }, shallow);
  const status = useApp((s) => (runId ? s.runs[runId]?.status : undefined));
  const tab = useApp((s) => s.workspaceTab);
  const messageCount = useApp((s) => s.tasks[taskId]?.messages.length ?? 0);
  const artifactCount = useApp((s) => (runId ? s.runs[runId]?.artifacts.length ?? 0 : 0));
  const source = useApp((s) => (runId ? s.runs[runId]?.source : s.tasks[taskId]?.source));
  const reduced = useReducedMotion();

  const [stepTarget, setStepTarget] = useState<StepTarget | null>(null);
  const openStep = useCallback((stepId: string) => {
    actions.setWorkspaceTab('steps');
    setStepTarget({ id: stepId, n: Date.now() });
  }, []);
  const clearStepTarget = useCallback(() => setStepTarget(null), []);

  // actions.requestFocus('plan' | 'composer'): bring the region into view / switch to its tab.
  useFocusRequest('plan', () => {
    const plan = document.getElementById('ws-plan');
    plan?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    plan?.querySelector<HTMLElement>('[aria-current="step"], .ws-plan__step')?.focus({ preventScroll: true });
  });
  useFocusRequest('composer', () => actions.setWorkspaceTab('conversation'));

  const tabs: Array<TabItem<WorkspaceTab>> = [
    { id: 'conversation', label: '对话', icon: MessageSquare, count: messageCount },
    { id: 'steps', label: '执行步骤', icon: ListChecks },
    { id: 'artifacts', label: '产物', icon: Package, count: artifactCount },
  ];

  return (
    <div className="workspace" data-run={status ?? 'draft'}>
      <RunHeader taskId={taskId} runId={runId} latestId={latestId} />
      <GoalCard taskId={taskId} />
      <RunCallout taskId={taskId} runId={runId} latestId={latestId} />

      <div className="ws-body">
        <PlanView runId={runId} onOpenStep={openStep} />

        <section className="panel ws-main" aria-label="任务内容">
          <div className="panel__header panel__header--energy ws-main__bar">
            <Tabs idBase="ws" label="任务内容" items={tabs} value={tab} onChange={actions.setWorkspaceTab} />
            {source && source !== 'live' && <SimTag source={source} />}
          </div>
          {/* The conversation stays mounted (hidden) so the draft and scroll position survive tab switches. */}
          <div {...tabPanelProps('ws', 'conversation')} tabIndex={undefined} className="ws-main__panel" hidden={tab !== 'conversation'}>
            <Conversation taskId={taskId} runId={runId} latestId={latestId} active={tab === 'conversation'} />
          </div>
          {/* Steps and artifacts render only while shown; the empty panel keeps aria-controls valid. */}
          <div {...tabPanelProps('ws', 'steps')} tabIndex={undefined} className="ws-main__panel" hidden={tab !== 'steps'}>
            {tab === 'steps' && <StepsView runId={runId} target={stepTarget} onHandled={clearStepTarget} />}
          </div>
          <div {...tabPanelProps('ws', 'artifacts')} tabIndex={undefined} className="ws-main__panel" hidden={tab !== 'artifacts'}>
            {tab === 'artifacts' && <ArtifactsView runId={runId} />}
          </div>
        </section>
      </div>
    </div>
  );
}
