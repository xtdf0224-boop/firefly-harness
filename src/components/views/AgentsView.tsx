import { Bot, Plug, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { crewSubtitle, crewTag } from '../../lib/persona';
import { PERMISSION } from '../../lib/status';
import type { AgentId } from '../../lib/types';
import { actions } from '../../state/actions';
import { engineChoices } from '../../state/models';
import { useApp } from '../../state/store';
import '../../styles/models-agents.css';
import '../../styles/agents-formation.css';
import { Button, cx } from '../ui';
import { buildCrew, asset } from './agents/crew';
import { FormationChart, TrailKey } from './agents/FormationChart';
import { LoadoutDrawer } from './agents/LoadoutDrawer';
import { ToolLoadout } from './agents/ToolLoadout';
import { PERM_ICON, sameRecord, selectAgentStats, selectLastErrors, selectPresence } from './config/util';

const LEGEND = (['auto', 'confirm', 'off'] as const).map((p) => ({ id: p, Icon: PERM_ICON[p], label: PERMISSION[p].label }));

/** Agent page: a night-sky formation chart (the lead and three helpers joined by light trails), the
    tool matrix, and a loadout drawer that holds each agent's settings. */
export function AgentsView() {
  const agents = useApp((s) => s.agents);
  const tools = useApp((s) => s.tools);
  const models = useApp((s) => s.models);
  const mode = useApp((s) => s.settings.mode);
  const persona = useApp((s) => s.settings.persona);
  const stats = useApp(selectAgentStats, sameRecord);
  const presence = useApp(selectPresence, sameRecord);
  const errors = useApp(selectLastErrors, sameRecord);
  const first = useApp((s) => engineChoices(s.models).length === 0);
  const [open, setOpen] = useState<AgentId | null>(null);

  const crew = useMemo(
    () => buildCrew({ mode, persona, first, agents, tools, models, stats, presence, errors }),
    [mode, persona, first, agents, tools, models, stats, presence, errors],
  );

  return (
    <>
      <div className="view agents-view" inert={open ? true : undefined}>
        <header className="view__header agents-head">
          <div className="view__heading">
            <h1 className="view__title" tabIndex={-1}>
              <Bot size={20} aria-hidden />Agent
              <span className="agents-head__tag">{crewTag(mode)}</span>
              {persona && <span className="agents-head__sub">{crewSubtitle(mode)}</span>}
            </h1>
            <p className="view__desc">多 Agent 工作时，每个 Agent 可以用自己的模型，例如编码用 Claude Code、检索用 DeepSeek API。没有单独指定的，就跟随新建任务时选的模型。</p>
          </div>
          <div className="view__actions">
            <div className="agents-legend">
              <span>工具图标</span>
              <ul className="agents-legend__list" aria-label="工具图标说明">
                {LEGEND.map(({ id, Icon, label }) => (
                  <li key={id} className={cx('agents-legend__item', `is-${id}`)}><Icon size={13} aria-hidden />{label}</li>
                ))}
              </ul>
            </div>
          </div>
        </header>
        {first && (
          <div className="agents-callout" role="note">
            {mode === 'sam' && <span className="agents-callout__hazard" aria-hidden />}
            <img className="agents-callout__pet" src={asset(`pet/${mode}/think.png`)} alt="" width={84} height={84} draggable={false} />
            <div className="agents-callout__body">
              <p className="agents-callout__title"><TriangleAlert size={16} aria-hidden />还没有可用的模型</p>
              <p className="agents-callout__text">先到「模型接入」接入一个，这里才能给 Agent 选模型。</p>
            </div>
            <Button variant="warning" icon={Plug} onClick={() => actions.navigate('models')}>去模型接入</Button>
          </div>
        )}
        <FormationChart crew={crew} onOpen={setOpen} />
        <TrailKey crew={crew} />
        <ToolLoadout crew={crew} />
      </div>
      {open && <LoadoutDrawer crew={crew} id={open} onSelect={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}
