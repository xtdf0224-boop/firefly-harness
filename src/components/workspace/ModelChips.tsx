/* 模型 + 强度 chips, shared by the home box and the chat box.
   模型: one menu grouped by service and way (Claude · API, GPT · Codex CLI…) listing concrete models —
   the CLI's live list when it has one (Codex), otherwise the catalog. 强度: only the levels the chosen
   model or tool accepts; hidden when it cannot be tuned. */
import { Cpu, Gauge } from 'lucide-react';
import { EFFORT_HINT, EFFORT_LABEL, type Effort } from '../../lib/effort';
import { DRIVERS, PROVIDER_BY_ID } from '../../lib/providers';
import type { AppState } from '../../lib/types';
import { choiceEfforts, engineChoices, modelOptions, type EngineChoice } from '../../state/models';
import { useApp } from '../../state/store';
import { ChipGroupSelect, ChipSelect } from './PromptBox';

export interface ModelPick {
  /** EngineChoice key, or 'demo'. */
  key: string;
  /** Concrete model id ('' = the tool's default). */
  model: string;
  effort?: Effort;
}

export const groupLabel = (c: Pick<EngineChoice, 'provider' | 'auth' | 'driver'>) =>
  `${PROVIDER_BY_ID[c.provider].name} · ${c.auth === 'api' ? 'API' : DRIVERS[c.driver ?? PROVIDER_BY_ID[c.provider].drivers[0]].label}`;

/** The menu as a stable string, so the chips re-render only when it changes. */
function menuSig(s: AppState) {
  return engineChoices(s.models).map((c) => `${c.key}:${modelOptions(s.models, c).map((m) => m.id).join(',')}`).join('|');
}

export function ModelChips({ pick, onPick, allowDemo = true }: { pick: ModelPick; onPick: (p: ModelPick) => void; allowDemo?: boolean }) {
  useApp(menuSig);
  const models = useApp((s) => s.models);
  const choices = engineChoices(models);
  const choice = choices.find((c) => c.key === pick.key);
  const levels = choice ? choiceEfforts(models, choice, pick.model) : [];

  const groups = [
    ...(allowDemo ? [{ label: '', options: [{ value: 'demo|', label: '演示模式' }] }] : []),
    ...choices.map((c) => {
      const options = modelOptions(models, c).map((m) => ({ value: `${c.key}|${m.id}`, label: m.id ? `${m.label}${m.note && m.label === m.id ? `  ·  ${m.note}` : ''}` : `默认（${m.note ?? '工具自己选'}）` }));
      // The model in use is no longer listed (custom id changed, live list dropped it): keep showing it.
      if (c.key === pick.key && !options.some((o) => o.value === `${c.key}|${pick.model}`)) options.unshift({ value: `${c.key}|${pick.model}`, label: `${pick.model || '默认'}（当前）` });
      return { label: groupLabel(c), options };
    }),
  ];
  // The engine in use is not ready any more (key removed, CLI signed out): show it as it is, not as 演示模式.
  const provider = pick.key === 'demo' ? undefined : PROVIDER_BY_ID[pick.key.split(':')[0] as keyof typeof PROVIDER_BY_ID];
  const stale = !choice && provider ? `${provider.name} · ${pick.model || '默认'}` : '';
  if (stale) groups.push({ label: '当前（不可用）', options: [{ value: `${pick.key}|${pick.model}`, label: `${stale}（需要到「模型接入」里重新配置）` }] });
  const value = choice || stale ? `${pick.key}|${pick.model}` : 'demo|';
  const shown = choice ? `${groupLabel(choice)} · ${pick.model || '默认'}` : stale ? `${stale}（不可用）` : '演示模式';
  const p = choice ? PROVIDER_BY_ID[choice.provider] : undefined;
  const chip = stale ? `${stale}（不可用）` : !choice || !p ? '演示模式'
    : `${p.name} · ${pick.model || (choice.auth === 'api' ? '默认' : `${DRIVERS[choice.driver ?? p.drivers[0]].label} 默认`)}`;

  const onModel = (v: string) => {
    const [key, ...rest] = v.split('|');
    const model = rest.join('|');
    if (key === pick.key && model === pick.model) return;
    const next = choices.find((c) => c.key === key);
    if (!next && key !== 'demo') return;
    const nextLevels = next ? choiceEfforts(models, next, model) : [];
    onPick({ key, model, effort: pick.effort && nextLevels.includes(pick.effort) ? pick.effort : undefined });
  };

  return (
    <>
      <ChipGroupSelect icon={Cpu} label="使用的模型" value={value} groups={groups} onChange={onModel} title={shown} display={chip} />
      {choice && levels.length > 0 && (
        <ChipSelect<string> icon={Gauge} label="推理强度" value={pick.effort ?? ''}
          title={pick.effort ? `推理强度：${EFFORT_LABEL[pick.effort]}${EFFORT_HINT[pick.effort] ? `（${EFFORT_HINT[pick.effort]}）` : ''}` : '推理强度：用模型自己的默认'}
          onChange={(v) => onPick({ ...pick, effort: (v || undefined) as Effort | undefined })}
          options={[{ value: '', label: '强度 · 默认' }, ...levels.map((l) => ({ value: l, label: `强度 · ${EFFORT_LABEL[l]}` }))]} />
      )}
    </>
  );
}

/** The model a choice uses when nothing else is picked: what 模型接入 has configured. */
export function defaultModel(c: EngineChoice | undefined) {
  return c?.model ?? '';
}
