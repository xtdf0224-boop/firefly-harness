/* 可用工具 · 编队装备: the three helpers x ten tools as one matrix, each cell a toggle. The 编排 Agent has no
   column: it may use every tool, under the policies set on 工具与技能. */
import { Check, Info, Wrench } from 'lucide-react';
import { PERMISSION } from '../../../lib/status';
import type { ToolDef } from '../../../lib/types';
import { Panel, cx } from '../../ui';
import { PERM_ICON } from '../config/util';
import { followsPolicyOnly, toggleTool, type Crew, type Member } from './crew';
import { CrewOrb } from './parts';

export const DENIED_TIP = '已在工具与技能中禁用';
export const FOLLOW_TIP = '：不按 Agent 单独限制，只受「工具与技能」里的策略控制';

export const CLI_NOTE = '命令行方式下按勾选限制：Claude Code 和 Kimi / Qwen / MiniMax Code 逐项遵守；Codex 只区分能否写文件和联网搜索；DeepSeek Harness 不受这里限制。API 方式在带工作文件夹的工作任务里也按勾选限制（「其他工具」不提供）；闲聊和汇报不带工具。';

export function ToolLoadout({ crew }: { crew: Crew }) {
  const helpers = crew.members.filter((m) => !m.lead);
  const sam = crew.mode === 'sam';
  const half = Math.ceil(crew.tools.length / 2);
  return (
    <Panel
      className="loadout-kit"
      icon={Wrench}
      title={<>可用工具<span className="loadout-kit__sub">{sam ? 'LOADOUT · 装备栏' : '编队装备'}</span></>}
      actions={(
        <p className="loadout-kit__lead">
          <CrewOrb m={crew.lead} mode={crew.mode} size="xs" />
          <span><b>{crew.persona ? `${crew.lead.name}（编排 Agent）` : crew.lead.name}</b>：全部工具，按「工具与技能」里的策略执行（自动、需确认或禁用）。</span>
        </p>
      )}
    >
      <div className="loadout-kit__grid">
        <Matrix tools={crew.tools.slice(0, half)} helpers={helpers} crew={crew} part={1} />
        <Matrix tools={crew.tools.slice(half)} helpers={helpers} crew={crew} part={2} />
      </div>
      <p className="loadout-note"><Info size={14} aria-hidden /><span>{CLI_NOTE}</span></p>
    </Panel>
  );
}

function Matrix({ tools, helpers, crew, part }: { tools: ToolDef[]; helpers: Member[]; crew: Crew; part: number }) {
  return (
    <table className="loadout-kit__table">
      <caption className="sr-only">可用工具（第 {part} 组）</caption>
      <thead>
        <tr>
          <th scope="col" className="loadout-kit__tool">工具</th>
          {helpers.map((m) => <th key={m.id} scope="col"><span className="loadout-kit__who"><CrewOrb m={m} mode={crew.mode} size="xs" />{m.short}</span></th>)}
        </tr>
      </thead>
      <tbody>
        {tools.map((t) => {
          const Icon = PERM_ICON[t.permission];
          const policy = PERMISSION[t.permission].label;
          return (
            <tr key={t.id}>
              <th scope="row" className="loadout-kit__tool" title={`${t.name}：${policy}`}>
                <span className={cx('loadout-kit__tname', `is-${t.permission}`)}>
                  <Icon size={13} aria-hidden className="loadout-kit__perm" />
                  <span className="truncate">{t.name}</span>
                  <span className="sr-only">（{policy}）</span>
                </span>
              </th>
              {helpers.map((m) => {
                if (followsPolicyOnly(t.id)) {
                  return (
                    <td key={m.id}>
                      <span className="loadout-follow" role="img" aria-label={`${m.name}：${t.name}${FOLLOW_TIP}`} title={`${t.name}${FOLLOW_TIP}`}>—</span>
                    </td>
                  );
                }
                const on = m.agent.tools.includes(t.id);
                // Disabled on 工具与技能: every call is denied, whatever is ticked; the tick is kept for when it is allowed again.
                const denied = t.permission === 'off';
                return (
                  <td key={m.id}>
                    <button type="button" className={cx('loadout-socket', on && 'is-on', (!m.agent.enabled || denied) && 'is-muted')} aria-pressed={on}
                      aria-label={`${m.name}：${t.name}`} title={`${m.name} · ${t.name}：${denied ? DENIED_TIP : on ? '可用' : '不可用'}`} onClick={() => toggleTool(m.agent, crew.tools, t.id)}>
                      <span className="loadout-socket__gem"><Check size={12} aria-hidden /></span>
                    </button>
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
