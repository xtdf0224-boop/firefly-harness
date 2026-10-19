import { Ban } from 'lucide-react';
import { useId } from 'react';
import { AGENT_ACTIVITY, PERMISSION, type StatusMeta } from '../../../lib/status';
import type { Agent, DataSource, ToolDef, ToolId } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { AgentAvatar, Panel, SimTag, StatusChip, Switch, cx } from '../../ui';
import { PERM_ICON, type CallStat, type Presence } from './util';

export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

const DISABLED_META: StatusMeta = { label: '已停用', tone: 'neutral', icon: Ban };

export interface AgentCardProps {
  agent: Agent;
  toolsById: Partial<Record<ToolId, ToolDef>>;
  stat?: CallStat;
  presence?: Presence;
  source: DataSource;
}

export function AgentCard({ agent, toolsById, stat, presence, source }: AgentCardProps) {
  const modelId = useId();
  const toolsId = useId();
  const activity = presence?.activity ?? 'idle';
  const activityMeta = AGENT_ACTIVITY[activity];
  const isOrchestrator = agent.id === 'orchestrator';
  const models = MODELS.includes(agent.model) ? MODELS : [...MODELS, agent.model];
  const tools = agent.tools.map((id) => toolsById[id]).filter((t): t is ToolDef => !!t);
  const { steps, calls, errors } = stat ?? { steps: 0, calls: 0, errors: 0 };

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
        <label className="label" htmlFor={modelId}>模型</label>
        <select id={modelId} className="select" value={agent.model} onChange={(e) => actions.setAgentModel(agent.id, e.target.value)}>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <p className="agents-hint">演示模式不会调用模型</p>
      </div>

      <div className="agents-field">
        <p className="label" id={toolsId}>可用工具</p>
        {tools.length === 0
          ? <p className="agents-hint">没有可用工具</p>
          : (
            <ul className="agents-tools" aria-labelledby={toolsId}>
              {tools.map((t) => {
                const Icon = PERM_ICON[t.permission];
                const label = PERMISSION[t.permission].label;
                return (
                  <li key={t.id} className={cx('agents-tool', `is-${t.permission}`)} title={`${t.name}：${label}`}>
                    <Icon size={12} aria-hidden />
                    <span>{t.name}</span>
                    <span className="sr-only">（{label}）</span>
                  </li>
                );
              })}
            </ul>
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
        <SimTag source={source} />
      </footer>
    </Panel>
  );
}
