import { Bot } from 'lucide-react';
import { useMemo } from 'react';
import { PERMISSION } from '../../lib/status';
import type { ToolDef, ToolId } from '../../lib/types';
import { useApp } from '../../state/store';
import { AgentCard } from './config/AgentCard';
import { PERM_ICON, sameRecord, selectAgentStats, selectDataSource, selectPresence } from './config/util';
import { ViewHeader } from './config/ViewHeader';

const LEGEND = (['auto', 'confirm', 'off'] as const).map((p) => ({ id: p, Icon: PERM_ICON[p], label: PERMISSION[p].label }));

/** Agent roster: who takes part in tasks, which model each one is set to, and which tools it may call. */
export function AgentsView() {
  const agents = useApp((s) => s.agents);
  const tools = useApp((s) => s.tools);
  const stats = useApp(selectAgentStats, sameRecord);
  const presence = useApp(selectPresence, sameRecord);
  const source = useApp(selectDataSource);
  const toolsById = useMemo(() => Object.fromEntries(tools.map((t) => [t.id, t])) as Partial<Record<ToolId, ToolDef>>, [tools]);

  return (
    <div className="view agents-view">
      <ViewHeader
        icon={Bot}
        title="Agent"
        desc="参与任务的 Agent、它们使用的模型与可调用的工具。"
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
      <div className="agents-grid">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} toolsById={toolsById} stat={stats[agent.id]} presence={presence[agent.id]} source={source} />
        ))}
      </div>
    </div>
  );
}
