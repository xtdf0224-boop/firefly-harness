/* Agent 选择: checkbox list. 编排 Agent is always on (disabled + 必选); agents switched off in the
   Agents page are disabled with 已停用. The custom checkbox draws a check mark, so state is a shape
   as well as a colour. */
import { useId } from 'react';
import type { Agent, AgentId } from '../../../lib/types';
import { AgentAvatar, Badge, cx } from '../../ui';

function AgentOption({ agent, checked, onToggle }: { agent: Agent; checked: boolean; onToggle: (id: AgentId, on: boolean) => void }) {
  const id = useId();
  const required = agent.id === 'orchestrator';
  const off = !agent.enabled;
  return (
    <label className={cx('new-task-agent', checked && 'is-checked', required && 'is-required', off && 'is-off')}>
      <input
        type="checkbox"
        className="new-task-check"
        checked={checked}
        disabled={required || off}
        aria-labelledby={`${id}-name`}
        aria-describedby={`${id}-desc`}
        onChange={(e) => onToggle(agent.id, e.target.checked)}
      />
      <AgentAvatar agent={agent} size="sm" />
      <span className="new-task-agent__text">
        <span className="new-task-agent__name" id={`${id}-name`}>
          {agent.name}
          {required && <Badge tone="info">必选</Badge>}
          {off && <Badge tone="neutral">已停用</Badge>}
        </span>
        <span className="new-task-agent__role" id={`${id}-desc`}>{agent.role}</span>
      </span>
      <span className="new-task-agent__model mono" title="配置的模型（演示模式不会真实调用）">{agent.model}</span>
    </label>
  );
}

export function AgentPicker({ agents, selected, onToggle }: { agents: Agent[]; selected: ReadonlySet<AgentId>; onToggle: (id: AgentId, on: boolean) => void }) {
  return (
    <fieldset className="new-task-section">
      <legend className="new-task-legend">参与的 Agent</legend>
      <p className="field__hint">取消勾选后，该 Agent 的步骤会交给编排 Agent。可在「Agent」页启用或停用成员。</p>
      <div className="new-task-agents">
        {agents.map((a) => (
          <AgentOption key={a.id} agent={a} checked={a.id === 'orchestrator' || (a.enabled && selected.has(a.id))} onToggle={onToggle} />
        ))}
      </div>
    </fieldset>
  );
}
