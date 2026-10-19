import { Bot, TriangleAlert } from 'lucide-react';
import { PERMISSION } from '../../lib/status';
import { actions } from '../../state/actions';
import { engineChoices } from '../../state/models';
import { useApp } from '../../state/store';
import '../../styles/models-agents.css';
import { Button } from '../ui';
import { AgentCard } from './config/AgentCard';
import { PERM_ICON, sameRecord, selectAgentStats, selectPresence } from './config/util';
import { ViewHeader } from './config/ViewHeader';

const LEGEND = (['auto', 'confirm', 'off'] as const).map((p) => ({ id: p, Icon: PERM_ICON[p], label: PERMISSION[p].label }));

/** Agent roster: who takes part in tasks, which model each one runs on, and which tools it may call. */
export function AgentsView() {
  const agents = useApp((s) => s.agents);
  const tools = useApp((s) => s.tools);
  const stats = useApp(selectAgentStats, sameRecord);
  const presence = useApp(selectPresence, sameRecord);
  const noModel = useApp((s) => engineChoices(s.models).length === 0);

  return (
    <div className="view agents-view">
      <ViewHeader
        icon={Bot}
        title="Agent"
        desc="多 Agent 工作时，每个 Agent 可以用自己的模型，例如编码用 Claude Code、检索用 DeepSeek API。没有单独指定的，就跟随新建任务时选的模型。"
        actions={(
          <div className="agents-legend">
            <span>工具图标</span>
            <ul className="agents-legend__list" aria-label="工具图标说明">
              {LEGEND.map(({ id, Icon, label }) => (
                <li key={id} className="agents-legend__item"><Icon size={13} aria-hidden />{label}</li>
              ))}
            </ul>
          </div>
        )}
      />
      {noModel && (
        <div className="callout callout--warning" role="note">
          <TriangleAlert size={18} aria-hidden className="callout__icon" />
          <div className="callout__body"><p className="callout__text">还没有可用的模型。先到「模型接入」接入一个，这里才能给 Agent 选模型。</p></div>
          <div className="callout__actions"><Button size="sm" variant="secondary" onClick={() => actions.navigate('models')}>去模型接入</Button></div>
        </div>
      )}
      <div className="agents-grid">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} allTools={tools} stat={stats[agent.id]} presence={presence[agent.id]} />
        ))}
      </div>
    </div>
  );
}
