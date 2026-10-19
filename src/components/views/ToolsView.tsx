import { Info, Wrench } from 'lucide-react';
import { PERMISSION } from '../../lib/status';
import { useApp } from '../../state/store';
import { Panel, cx } from '../ui';
import { ToolRow } from './config/ToolRow';
import { PERM_ICON, sameRecord, selectToolStats } from './config/util';
import { BrowserPanel } from './config/BrowserPanel';
import { SkillsPanel } from './config/SkillsPanel';
import { ViewHeader } from './config/ViewHeader';

const POLICY_HELP = [
  { id: 'auto', text: '直接调用' },
  { id: 'confirm', text: '每次调用前出现在「待确认操作」' },
  { id: 'off', text: 'Agent 不能调用，它会换一种做法或说明做不到' },
] as const;

/** Skills, the 萤火浏览器 window agents can drive, and the tool policies (auto / confirm / off). */
export function ToolsView() {
  const tools = useApp((s) => s.tools);
  const stats = useApp(selectToolStats, sameRecord);

  return (
    <div className="view tools-view">
      <ViewHeader icon={Wrench} title="工具与技能" desc="管理 Agent 能用的技能，准备好萤火浏览器，并设置它调用工具的方式。" />

      <div className="callout callout--neutral" role="note">
        <Info size={18} aria-hidden className="callout__icon" />
        <div className="callout__body">
          <p className="callout__text">
            工具策略作用于所有任务里的命令行 Agent：它要用某个工具时，按这里的设置自动执行、先问你，或直接拒绝。Claude Code 和 Kimi / Qwen / MiniMax Code 逐项遵守；Codex 不能逐项确认，只按沙箱区分能否写文件和联网搜索；DeepSeek Harness 按它自己的权限设置执行。通过 API 接入的模型只思考和写作，不会调用工具。
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
    </div>
  );
}
