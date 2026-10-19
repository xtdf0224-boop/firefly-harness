/* 示例模板: three selectable cards. A card is a toggle button (aria-pressed); the selected state is
   shown by a check + "已选用" text as well as the mint edge, so it never relies on colour alone. */
import { Check, FileCode2, ScrollText, Telescope, type LucideIcon } from 'lucide-react';
import { useId } from 'react';
import type { ScenarioId } from '../../../lib/types';
import { TEMPLATES, type Scenario } from '../../../state/scenarios';

const ICONS: Partial<Record<ScenarioId, LucideIcon>> = { refactor: FileCode2, research: Telescope, report: ScrollText };

function TemplateCard({ template, pressed, onPick }: { template: Scenario; pressed: boolean; onPick: (t: Scenario) => void }) {
  const id = useId();
  const Icon = ICONS[template.id] ?? FileCode2;
  return (
    <button
      type="button"
      className="new-task-template"
      aria-pressed={pressed}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-body`}
      onClick={() => onPick(template)}
    >
      <span className="new-task-template__head">
        <Icon className="new-task-template__icon" size={16} aria-hidden />
        <span className="new-task-template__name" id={`${id}-name`}>{template.name}</span>
        {pressed && (
          <span className="new-task-template__picked">
            <Check size={13} aria-hidden />
            已选用
          </span>
        )}
      </span>
      <span className="new-task-template__body" id={`${id}-body`}>
        <span className="new-task-template__blurb">{template.blurb}</span>
        <span className="label new-task-template__points-label">演示要点</span>
        <span className="new-task-template__points">
          {template.demonstrates.map((point) => (
            <span key={point} className="new-task-template__point">{point}</span>
          ))}
        </span>
      </span>
    </button>
  );
}

export function TemplatePicker({ selectedId, onPick }: { selectedId?: ScenarioId; onPick: (t: Scenario) => void }) {
  return (
    <fieldset className="new-task-section">
      <legend className="new-task-legend">示例模板</legend>
      <p className="field__hint">选一个模板会填入目标和任务名称，仍可继续修改。再点一次取消选用。</p>
      <div className="new-task-templates">
        {TEMPLATES.map((t) => <TemplateCard key={t.id} template={t} pressed={t.id === selectedId} onPick={onPick} />)}
      </div>
    </fieldset>
  );
}
