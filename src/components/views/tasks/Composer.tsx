/* 新建任务 composer. Plain controlled form: goal (required), name (optional), template cards,
   agent checkboxes, start-now switch. Everything is local state until submit; the only store write
   is actions.createTask. */
import { AlertCircle, Info, Play, Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AgentId, AppState, ScenarioId } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { TEMPLATES, type Scenario } from '../../../state/scenarios';
import { useApp } from '../../../state/store';
import { Button, Panel, SimTag, Switch } from '../../ui';
import { AgentPicker } from './AgentPicker';
import { TemplatePicker } from './TemplatePicker';

const TITLE_CLIP = 24;

/** First line of the goal, cut to ~24 characters: the fallback task name. */
function deriveTitle(goal: string) {
  const first = goal.split('\n')[0].trim();
  const chars = Array.from(first);
  return chars.length > TITLE_CLIP ? `${chars.slice(0, TITLE_CLIP).join('')}…` : first;
}

/** A focus request from elsewhere (actions.requestFocus('composer')) is honoured only when fresh. */
const selectComposerFocus = (s: AppState) => (s.focusRequest?.target === 'composer' ? s.focusRequest.at : 0);

export function Composer() {
  const agents = useApp((s) => s.agents);
  const focusAt = useApp(selectComposerFocus);
  const [goal, setGoal] = useState('');
  const [title, setTitle] = useState('');
  const [override, setOverride] = useState<AgentId[] | null>(null);
  const [start, setStart] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const base = useId();
  const ids = { goal: `${base}-goal`, title: `${base}-title`, err: `${base}-goal-err`, hint: `${base}-goal-hint` };

  useEffect(() => {
    if (!focusAt || Date.now() - focusAt > 2000) return;
    goalRef.current?.focus();
    goalRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focusAt]);

  // The scenario follows the goal text: unchanged template goal → that template, anything else → 通用流程.
  const trimmed = goal.trim();
  const template = trimmed ? TEMPLATES.find((t) => t.goal.trim() === trimmed) : undefined;
  const scenarioId: ScenarioId = template?.id ?? 'general';

  // Default roster: the template's agents, or every enabled agent. Once the user ticks a box, their list wins
  // until they pick another template.
  const enabled = agents.filter((a) => a.enabled).map((a) => a.id);
  const defaults = template ? template.agents.filter((id) => enabled.includes(id)) : enabled;
  const chosen = new Set<AgentId>([...(override ?? defaults), 'orchestrator']);
  const agentIds = agents.filter((a) => a.id === 'orchestrator' || (a.enabled && chosen.has(a.id))).map((a) => a.id);

  const pickTemplate = (t: Scenario) => {
    if (template?.id === t.id) {
      // Pressing the selected card again undoes the fill.
      setGoal('');
      if (title.trim() === t.title) setTitle('');
      setOverride(null);
      return;
    }
    setGoal(t.goal);
    setTitle(t.title);
    setOverride(null);
    setInvalid(false);
  };

  const toggleAgent = (id: AgentId, on: boolean) => setOverride(on ? [...agentIds, id] : agentIds.filter((x) => x !== id));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed) {
      setInvalid(true);
      goalRef.current?.focus();
      return;
    }
    actions.createTask({ title: title.trim() || template?.title || deriveTitle(trimmed), goal: trimmed, scenarioId, agentIds, start });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.currentTarget.requestSubmit();
    }
  };

  const showCustomHint = !!trimmed && scenarioId === 'general';
  const describedBy = [invalid && ids.err, showCustomHint && ids.hint].filter(Boolean).join(' ') || undefined;

  return (
    <Panel className="new-task-composer" label="新建任务" title="目标与配置" energy actions={<SimTag />} bodyClassName="new-task-composer__body">
      <form className="new-task-form" onSubmit={submit} onKeyDown={onKeyDown} noValidate>
        <div className="new-task-section">
          <div className="field">
            <label className="field__label" htmlFor={ids.goal}>
              目标<span className="new-task-required" aria-hidden> *</span>
              <span className="sr-only">（必填）</span>
            </label>
            <textarea
              id={ids.goal}
              ref={goalRef}
              className="textarea new-task-goal"
              rows={5}
              value={goal}
              required
              aria-required="true"
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              placeholder="例如：重构登录模块并补充单元测试"
              onChange={(e) => { setGoal(e.target.value); if (invalid && e.target.value.trim()) setInvalid(false); }}
            />
            {invalid && (
              <p className="new-task-error" id={ids.err} role="alert">
                <AlertCircle size={14} aria-hidden />
                <span>请先描述一个目标，Agent 才知道要做什么。</span>
              </p>
            )}
            {showCustomHint && (
              <p className="new-task-note" id={ids.hint} role="status">
                <Info size={14} aria-hidden />
                <span>自定义目标会使用通用的模拟流程。</span>
              </p>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor={ids.title}>任务名称<span className="new-task-optional">（可选）</span></label>
            <input
              id={ids.title}
              className="input"
              type="text"
              value={title}
              maxLength={80}
              autoComplete="off"
              placeholder="留空则根据目标自动生成"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        </div>

        <TemplatePicker selectedId={template?.id} onPick={pickTemplate} />
        <AgentPicker agents={agents} selected={chosen} onToggle={toggleAgent} />

        <div className="new-task-footer">
          <div className="new-task-footer__option">
            <Switch checked={start} onChange={setStart} label="创建后立即开始" description="关闭后只创建任务，稍后在任务页手动开始。" />
          </div>
          <div className="new-task-footer__submit">
            <span className="new-task-footer__count">已选 {agentIds.length} 个 Agent</span>
            <Button type="submit" variant="primary" size="lg" icon={start ? Play : Plus} kbd="Ctrl ↵">
              {start ? '开始任务' : '创建任务'}
            </Button>
          </div>
        </div>
      </form>
    </Panel>
  );
}
