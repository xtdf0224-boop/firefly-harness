import { Ban, Check, Cpu, Gauge, TriangleAlert } from 'lucide-react';
import { useId } from 'react';
import type { Effort } from '../../../lib/effort';
import { PROVIDER_BY_ID, engineLabel } from '../../../lib/providers';
import { AGENT_ACTIVITY, PERMISSION, type StatusMeta } from '../../../lib/status';
import type { Agent, AgentEngine, ModelState, ProviderId, ToolDef, ToolId } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { choiceEfforts, effortMenu, engineChoices, menuValue, modelMenuGroups, parseMenuValue } from '../../../state/models';
import { useApp } from '../../../state/store';
import { AgentAvatar, Button, Panel, StatusChip, Switch, cx } from '../../ui';
import { MenuSelect } from '../../ui/MenuSelect';
import { PERM_ICON, type CallStat, type Presence } from './util';

const DISABLED_META: StatusMeta = { label: '已停用', tone: 'neutral', icon: Ban };

/** 「Claude Sonnet 5.5 · Claude Code」: the engine as saved on the agent, whether or not its way is ready any more. */
function engineText(models: ModelState, e: AgentEngine) {
  const [provider, auth] = e.key.split(':');
  const p = PROVIDER_BY_ID[provider as ProviderId];
  if (!p) return e.key;
  return engineLabel(p, auth === 'api' ? 'api' : 'cli', auth === 'api' ? undefined : models.providers[p.id].driver, e.model);
}

export interface AgentCardProps {
  agent: Agent;
  /** Every tool, so each one can be switched on or off for this agent. */
  allTools: ToolDef[];
  stat?: CallStat;
  presence?: Presence;
}

export function AgentCard({ agent, allTools, stat, presence }: AgentCardProps) {
  const modelId = useId();
  const effortId = useId();
  const toolsId = useId();
  const models = useApp((s) => s.models);
  const activity = presence?.activity ?? 'idle';
  const activityMeta = AGENT_ACTIVITY[activity];
  const isOrchestrator = agent.id === 'orchestrator';
  const { steps, calls, errors } = stat ?? { steps: 0, calls: 0, errors: 0 };

  const engine = agent.engine;
  const choices = engineChoices(models);
  const choice = engine ? choices.find((c) => c.key === engine.key) : undefined;
  const levels = engine && choice ? choiceEfforts(models, choice, engine.model) : [];
  const groups = [{ options: [{ value: '', label: '跟随任务', sub: '用新建任务时选的模型' }] }, ...modelMenuGroups(models)];

  // Switching the model keeps the 强度 only if the new model still offers it.
  const onModel = (v: string) => {
    if (!v) { actions.setAgentEngine(agent.id, undefined); return; }
    const { key, model } = parseMenuValue(v);
    const next = choices.find((c) => c.key === key);
    const kept = engine?.effort && next && choiceEfforts(models, next, model).includes(engine.effort) ? engine.effort : undefined;
    actions.setAgentEngine(agent.id, { key, model, effort: kept });
  };

  const toggle = (id: ToolId) => actions.setAgentTools(agent.id, allTools.map((t) => t.id).filter((x) => (x === id ? !agent.tools.includes(id) : agent.tools.includes(x))));

  return (
    <Panel as="article" aria-label={agent.name} live={agent.enabled && !!activityMeta.live} className={cx('agents-card', !agent.enabled && 'is-disabled')} bodyClassName="agents-card__body">
      <div className="agents-card__head">
        <AgentAvatar agent={agent} activity={activity} size="lg" />
        <div className="agents-card__id">
          <h2 className="agents-card__name">{agent.name}</h2>
          <p className="agents-card__role">{agent.role}</p>
        </div>
        {!agent.enabled && <StatusChip meta={DISABLED_META} size="sm" />}
      </div>

      <div className="agents-card__switch">
        <Switch
          label="启用"
          checked={agent.enabled}
          disabled={isOrchestrator}
          description={isOrchestrator ? '编排 Agent 必须启用' : '停用后，它的步骤会交给编排 Agent'}
          onChange={(v) => actions.setAgentEnabled(agent.id, v)}
        />
      </div>

      <p className="agents-card__desc">{agent.description}</p>

      <div className="agents-field">
        {isOrchestrator ? (
          <>
            <p className="label">模型</p>
            <p className="agent-follow"><Cpu size={14} aria-hidden />跟随任务：编排 Agent 总是用新建任务时选的模型</p>
          </>
        ) : (
          <>
            <label className="label" htmlFor={modelId}>模型</label>
            <MenuSelect variant="field" id={modelId} label={`${agent.name} 的模型`} icon={Cpu} value={engine ? menuValue(engine.key, engine.model) : ''} groups={groups}
              display={engine ? engineText(models, engine) : undefined} onChange={onModel} minWidth={300} />
            {engine && !choice && (
              <div className="agent-warn" role="alert">
                <TriangleAlert size={14} aria-hidden />
                <span>这个模型现在不可用，它的步骤会改用任务的模型</span>
                <Button size="sm" variant="ghost" onClick={() => actions.navigate('models')}>去模型接入</Button>
              </div>
            )}
            {!engine && <p className="agents-hint">没有单独指定，它的步骤用新建任务时选的模型。</p>}
          </>
        )}
      </div>

      {engine && choice && (
        <div className="agents-field">
          <label className="label" htmlFor={effortId}>推理强度</label>
          {levels.length > 0 ? (
            <MenuSelect variant="field" id={effortId} label={`${agent.name} 的推理强度`} icon={Gauge} value={engine.effort && levels.includes(engine.effort) ? engine.effort : ''}
              options={effortMenu(levels)} minWidth={260}
              onChange={(v) => actions.setAgentEngine(agent.id, { ...engine, effort: (v || undefined) as Effort | undefined })} />
          ) : (
            <p className="agent-follow"><Gauge size={14} aria-hidden />这个模型不能调节推理强度</p>
          )}
        </div>
      )}

      <div className="agents-field">
        <p className="label" id={toolsId}>可用工具</p>
        {isOrchestrator ? (
          <p className="agents-hint">全部工具，按「工具与技能」里的策略执行（自动、需确认或禁用）。</p>
        ) : (
          <>
            <ul className="agent-tools" aria-labelledby={toolsId}>
              {allTools.map((t) => <ToolChip key={t.id} tool={t} on={agent.tools.includes(t.id)} onToggle={() => toggle(t.id)} />)}
            </ul>
            <p className="agents-hint">命令行方式下按勾选限制：Claude Code 和 Kimi / Qwen / MiniMax Code 逐项遵守；Codex 只区分能否写文件和联网搜索；DeepSeek Harness 不受这里限制。API 方式不使用工具。</p>
          </>
        )}
      </div>

      <div className="agents-field">
        <p className="label">当前</p>
        <div className="agents-now">
          <StatusChip meta={activityMeta} size="sm" />
          {presence && (
            <span className="agents-now__task">
              正在参与：
              <button type="button" className="agents-link" title={presence.title} onClick={() => actions.openTask(presence.taskId, presence.runId)}>{presence.title}</button>
            </span>
          )}
        </div>
      </div>

      <footer className="agents-card__foot">
        <dl className="agents-stats">
          <div className="agents-stat"><dt>完成步骤</dt><dd>{steps}</dd></div>
          <div className="agents-stat"><dt>工具调用</dt><dd>{calls}</dd></div>
          <div className={cx('agents-stat', errors > 0 && 'is-error')}><dt>出错</dt><dd>{errors}</dd></div>
        </dl>
      </footer>
    </Panel>
  );
}

/** One tool as a chip: a toggle (aria-pressed) for ordinary agents, plain text for the 编排 Agent. The icon shows the 工具策略. */
function ToolChip({ tool, on, onToggle }: { tool: ToolDef; on: boolean; onToggle?: () => void }) {
  const Icon = PERM_ICON[tool.permission];
  const label = PERMISSION[tool.permission].label;
  const inner = (
    <>
      <Icon size={12} aria-hidden className="agent-tool__perm" />
      <span>{tool.name}</span>
      <span className="sr-only">（{label}）</span>
      {on && <Check size={12} aria-hidden className="agent-tool__on" />}
    </>
  );
  const title = `${tool.name}：${label}`;
  return (
    <li>
      {onToggle
        ? <button type="button" className={cx('agent-tool', `is-${tool.permission}`, on && 'is-on')} aria-pressed={on} title={title} onClick={onToggle}>{inner}</button>
        : <span className={cx('agent-tool is-static', `is-${tool.permission}`, on && 'is-on')} title={title}>{inner}</span>}
    </li>
  );
}
