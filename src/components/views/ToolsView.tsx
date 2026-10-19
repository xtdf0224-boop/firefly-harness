import { Info, Plug, Wrench } from 'lucide-react';
import { PERMISSION } from '../../lib/status';
import { useApp } from '../../state/store';
import { Panel, SimTag, cx } from '../ui';
import { ConnectionCard } from './config/ConnectionCard';
import { ToolRow } from './config/ToolRow';
import { PERM_ICON, sameRecord, selectToolStats } from './config/util';
import { BrowserPanel } from './config/BrowserPanel';
import { SkillsPanel } from './config/SkillsPanel';
import { ViewHeader } from './config/ViewHeader';

const POLICY_HELP = [
  { id: 'auto', text: '直接调用' },
  { id: 'confirm', text: '每次调用前出现在「待确认操作」' },
  { id: 'off', text: '相关步骤会被跳过' },
] as const;

/** Tool policies (auto / confirm / off) and the state of every connection the agents depend on. */
export function ToolsView() {
  const tools = useApp((s) => s.tools);
  const connections = useApp((s) => s.connections);
  const stats = useApp(selectToolStats, sameRecord);

  return (
    <div className="view tools-view">
      <ViewHeader icon={Plug} title="工具与连接" desc="设置 Agent 调用工具的方式，并查看各项连接的状态。" />

      <div className="callout callout--neutral" role="note">
        <Info size={18} aria-hidden className="callout__icon" />
        <div className="callout__body">
          <p className="callout__text">
            工具策略同时作用于演示和接入的模型：命令行 Agent 要用某个工具时，按这里的设置自动执行、先问你或直接拒绝。下方「连接状态」是演示数据。
          </p>
        </div>
      </div>

      <SkillsPanel />
      <BrowserPanel />

      <Panel label="工具策略" title="工具" icon={Wrench} energy flush>
        <ul className="tools-policy" aria-label="调用策略说明">
          {POLICY_HELP.map(({ id, text }) => {
            const Icon = PERM_ICON[id];
            return (
              <li key={id} className={cx('tools-policy__item', `is-${id}`)}>
                <Icon size={16} aria-hidden />
                <p><strong>{PERMISSION[id].label}</strong><span aria-hidden> = </span><span className="sr-only">：</span>{text}</p>
              </li>
            );
          })}
        </ul>

        <div className="tools-listwrap">
          <div className="tools-list">
            <div className="tools-cols" aria-hidden>
              <span>工具</span><span>风险</span><span>调用策略</span><span>使用情况</span>
            </div>
            <ul className="tools-rows">
              {tools.map((tool) => <ToolRow key={tool.id} tool={tool} stat={stats[tool.id]} />)}
            </ul>
          </div>
        </div>
      </Panel>

      <Panel label="连接" title="连接状态" icon={Plug} energy actions={<SimTag />}>
        <ul className="tools-conns">
          {connections.map((c) => <ConnectionCard key={c.id} conn={c} />)}
        </ul>
      </Panel>
    </div>
  );
}
