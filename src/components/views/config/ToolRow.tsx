import { PERMISSION, RISK } from '../../../lib/status';
import type { ToolDef, ToolPermission } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { Badge, Segmented } from '../../ui';
import { PERM_ICON, type CallStat } from './util';

const POLICY_OPTIONS = (['auto', 'confirm', 'off'] as const).map((p) => ({
  value: p, label: PERMISSION[p].label, icon: PERM_ICON[p], hint: PERMISSION[p].hint,
}));

/** One tool: what it does, how risky it is, the call policy, and how much it has been used. */
export function ToolRow({ tool, stat }: { tool: ToolDef; stat?: CallStat }) {
  const risk = RISK[tool.risk];
  const calls = stat?.calls ?? 0;
  const errors = stat?.errors ?? 0;
  return (
    <li className="tools-row" data-permission={tool.permission}>
      <div className="tools-row__info">
        <div className="tools-row__name">
          <h3>{tool.name}</h3>
          <Badge tone="neutral">{tool.category}</Badge>
        </div>
        <p className="tools-row__desc">{tool.description}</p>
      </div>
      <div className="tools-row__risk"><Badge tone={risk.tone} title={`风险等级：${risk.label}`}>{risk.label}</Badge></div>
      <div className="tools-row__policy">
        <Segmented<ToolPermission>
          size="sm"
          label={`${tool.name} 的调用策略`}
          options={POLICY_OPTIONS}
          value={tool.permission}
          onChange={(v) => actions.setToolPermission(tool.id, v)}
        />
      </div>
      <p className="tools-row__usage">
        <span>调用 <strong>{calls}</strong></span>
        <span aria-hidden> · </span>
        <span className={errors > 0 ? 'is-error' : undefined}>出错 <strong>{errors}</strong></span>
      </p>
    </li>
  );
}
