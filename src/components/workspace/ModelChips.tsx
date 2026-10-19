/* 模型 + 强度 chips, shared by the home box and the chat box.
   模型: one menu grouped by service and way (Claude · API, GPT · Codex CLI…) listing concrete models by
   their version names — the CLI's live list when it has one (Codex), otherwise the catalog. 强度: only the
   levels the chosen model or tool accepts; hidden when it cannot be tuned. */
import { Cpu, Gauge, Settings2 } from 'lucide-react';
import { useMemo } from 'react';
import { DRIVERS, PROVIDER_BY_ID, modelName } from '../../lib/providers';
import { EFFORT_HINT, EFFORT_LABEL, type Effort } from '../../lib/effort';
import type { DriverId, ModelState, ProviderId } from '../../lib/types';
import { actions } from '../../state/actions';
import { choiceEfforts, effortMenu, engineChoices, menuValue, modelMenuGroups, parseMenuValue } from '../../state/models';
import { useApp } from '../../state/store';
import { MenuSelect, type MenuGroup } from '../ui/MenuSelect';

export interface ModelPick {
  /** EngineChoice key (`claude:cli`); '' = nothing picked yet. */
  key: string;
  /** Concrete model id ('' = the tool's default). */
  model: string;
  effort?: Effort;
  /** The CLI tool the task actually runs on (it may differ from what 模型接入 is set to now). */
  driver?: DriverId;
}

/** 「Claude Sonnet 5.5 · Claude Code」, or 「Claude Code · 默认模型」 when the tool picks the model itself. */
function pickText(models: ModelState, pick: ModelPick) {
  const [id, auth] = pick.key.split(':');
  const p = PROVIDER_BY_ID[id as ProviderId];
  if (!p) return '';
  const way = auth === 'api' ? 'API' : DRIVERS[pick.driver ?? models.providers[p.id].driver].label;
  if (pick.model) return `${modelName(p, pick.model)} · ${way}`;
  return `${auth === 'api' ? p.name : way} · 默认模型`;
}

export function ModelChips({ pick, onPick }: { pick: ModelPick; onPick: (p: ModelPick) => void }) {
  const models = useApp((s) => s.models);
  const choices = engineChoices(models);
  const listed = choices.find((c) => c.key === pick.key);
  // The vendor's tool was switched on 模型接入 after this task started (DSH → Claude Code): the task still
  // runs on its own tool, so the menu entry of the new tool is a different choice, not the current one.
  const moved = !!(listed && pick.driver && listed.driver && pick.driver !== listed.driver);
  const choice = moved ? undefined : listed;
  const levels = choice ? choiceEfforts(models, choice, pick.model) : [];
  const value = moved ? `${pick.key}@${pick.driver}|${pick.model}` : menuValue(pick.key, pick.model);
  const text = pickText(models, pick);

  const groups = useMemo(() => {
    const out: Array<MenuGroup> = modelMenuGroups(models);
    // The model in use is not in the list: a custom id that was changed, a way that was signed out or
    // removed. Keep showing it, labelled for what it is, so the chip never claims something else.
    if (text && !out.some((g) => g.options.some((o) => o.value === value))) {
      out.push({
        label: '当前使用',
        options: [{ value, label: choice ? `${text}（当前）` : moved ? `${text}（当前）` : `${text}（不可用）`, sub: pick.model || undefined, disabled: !choice }],
      });
    }
    return out;
  }, [models, value, text, choice, pick.model]);

  if (!choices.length && !text) {
    return (
      <button type="button" className="pchip pchip--action" onClick={() => actions.navigate('models')}>
        <Cpu size={13} aria-hidden />先接入一个模型
      </button>
    );
  }

  const onModel = (v: string) => {
    const next = parseMenuValue(v);
    if (next.key === pick.key && next.model === pick.model) return;
    const c = choices.find((x) => x.key === next.key);
    if (!c) return;
    const nextLevels = choiceEfforts(models, c, next.model);
    // Keep the level when the new model has it; a different way starts from the default set on 模型接入.
    const keep = pick.effort && nextLevels.includes(pick.effort) ? pick.effort : undefined;
    const fallback = next.key !== pick.key && c.effort && nextLevels.includes(c.effort) ? c.effort : undefined;
    onPick({ key: next.key, model: next.model, effort: keep ?? fallback });
  };

  const footer = (
    <button type="button" className="model-manage" onClick={() => actions.navigate('models')}>
      <Settings2 size={13} aria-hidden />管理模型接入
    </button>
  );

  return (
    <>
      <MenuSelect
        variant="chip" icon={Cpu} label="使用的模型" value={value} groups={groups} onChange={onModel}
        display={text ? (choice || moved ? text : `${text}（不可用）`) : undefined} placeholder="选择模型"
        title={text ? `使用的模型：${text}${pick.model ? `\n模型 ID：${pick.model}` : ''}` : '选择要用的模型'}
        footer={footer} minWidth={320}
      />
      {choice && levels.length > 0 && (
        <MenuSelect
          variant="chip" icon={Gauge} label="推理强度" value={pick.effort ?? ''} options={effortMenu(levels)}
          display={`强度 · ${pick.effort ? EFFORT_LABEL[pick.effort] : '默认'}`}
          title={pick.effort ? `推理强度：${EFFORT_LABEL[pick.effort]}${EFFORT_HINT[pick.effort] ? `（${EFFORT_HINT[pick.effort]}）` : ''}` : '推理强度：用模型自己的默认'}
          onChange={(v) => onPick({ ...pick, effort: (v || undefined) as Effort | undefined })}
          minWidth={220}
        />
      )}
    </>
  );
}
