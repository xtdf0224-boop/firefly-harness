/* 推理强度. One scale in the UI (默认 / 关闭思考 / 低 / 中 / 高 / 很高 / 最高 / 极限); each vendor and CLI
   accepts a subset and spells it its own way. This file says which levels a model offers and how a
   level becomes a request: API body fields, Claude Code's --effort, or Codex's model_reasoning_effort. */
import type { DriverId, ProviderId } from './types';

export type Effort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export const EFFORT_LABEL: Record<Effort, string> = {
  off: '关闭思考', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极限',
};
export const EFFORT_HINT: Partial<Record<Effort, string>> = {
  off: '不思考，最快',
  max: '最慢、最费额度',
  ultra: 'Codex 会自动分派子任务',
};
const ORDER: Effort[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const sortEfforts = (list: Effort[]) => ORDER.filter((e) => list.includes(e));

/** A model as the UI lists it (static catalog or a CLI's live list). */
export interface LiveModel {
  id: string;
  label: string;
  note?: string;
  efforts?: string[];
  defaultEffort?: string;
  isDefault?: boolean;
}

type Body = Record<string, unknown>;
interface ApiEffort {
  /** Levels this model accepts. */
  levels: (model: string) => Effort[];
  /** Request-body fields for a level. */
  body: (level: Effort, model: string) => Body;
}

const re = (v: string): Body => ({ reasoning_effort: v });

/** API request fields per vendor — checked against each vendor's official docs on 2026-10-18
   (multi-agent research with adversarial re-checks). */
const API: Partial<Record<ProviderId, ApiEffort>> = {
  // Claude 5.x: output_config.effort low…max; thinking is adaptive and always on, except Haiku 5.5
  // (thinking: disabled, effort ≤ high) and Sonnet 5.5 (thinking: between_tools, effort ≤ high).
  // display "summarized" makes the thinking text visible (the default "omitted" streams empty strings).
  claude: {
    levels: (m) => (/haiku-5-5|sonnet-5-5/.test(m) ? ['off', 'low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'xhigh', 'max']),
    body: (l, m) => (l === 'off'
      ? { thinking: { type: /haiku/.test(m) ? 'disabled' : 'between_tools' }, output_config: { effort: 'low' } }
      : { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: l } }),
  },
  // GPT-6: reasoning_effort low…max; only Luna (and the older GPT-6 Sol) accept "none".
  gpt: {
    levels: (m) => (/luna|^gpt-6-sol$/.test(m) ? ['off', 'low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'xhigh', 'max']),
    body: (l) => re(l === 'off' ? 'none' : l),
  },
  // DeepSeek V4: reasoning_effort low / high / max; thinking.type disabled turns it off.
  deepseek: {
    levels: () => ['off', 'low', 'high', 'max'],
    body: (l) => (l === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, ...re(l) }),
  },
  // Kimi: K3 always reasons (reasoning_effort low / high / max, no thinking object); K2.6 can switch
  // thinking off; K2.7 Code always thinks and takes no effort.
  kimi: {
    levels: (m) => (/k3/.test(m) ? ['low', 'high', 'max'] : /k2\.6/.test(m) ? ['off'] : []),
    body: (l, m) => (/k2\.6/.test(m) ? { thinking: { type: l === 'off' ? 'disabled' : 'enabled' } } : re(l)),
  },
  // Qwen 3.8: reasoning_effort low / medium / xhigh, enable_thinking false turns it off.
  // Qwen 3.7 Plus has no effort, only the thinking switch.
  qwen: {
    levels: (m) => (/qwen3\.8/.test(m) ? ['off', 'low', 'medium', 'xhigh'] : /qwen3\.7|qwen-plus|qwen-flash/.test(m) ? ['off'] : []),
    body: (l, m) => (l === 'off' ? { enable_thinking: false } : /qwen3\.8/.test(m) ? { enable_thinking: true, ...re(l) } : { enable_thinking: true }),
  },
  // GLM-5.3: thinking is always on; reasoning_effort low / high / max.
  glm: {
    levels: () => ['low', 'high', 'max'],
    body: (l) => ({ thinking: { type: 'enabled' }, ...re(l) }),
  },
  // MiniMax: only M3.1 Flash Preview takes an effort (low…max, cannot turn off); M3 can turn thinking
  // off; M2.x ignores both.
  minimax: {
    levels: (m) => (/M3\.1-Flash/i.test(m) ? ['low', 'medium', 'high', 'xhigh', 'max'] : /M3$/i.test(m) ? ['off'] : []),
    body: (l) => (l === 'off' ? { thinking: { type: 'disabled' } } : { reasoning_split: true, ...re(l) }),
  },
  // 豆包 Seed 2.1 / Evolving: reasoning_effort (xhigh / max act as high); thinking disabled turns it off.
  doubao: {
    levels: () => ['off', 'low', 'medium', 'high'],
    body: (l) => (l === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, ...re(l) }),
  },
};

const CLAUDE_CODE: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_FALLBACK: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Levels offered for a way of running a model ([] = this one cannot be tuned). */
export function effortLevels(provider: ProviderId, auth: 'api' | 'cli', driver: DriverId | undefined, model: string, live?: LiveModel[]): Effort[] {
  if (auth === 'api') return sortEfforts(API[provider]?.levels(model) ?? []);
  if (driver === 'claude-code' || driver === 'claude-compat') return CLAUDE_CODE;
  if (driver === 'codex') {
    const hit = live?.find((m) => m.id === model) ?? (model ? undefined : live?.find((m) => m.isDefault));
    const list = (hit?.efforts ?? []).filter((e): e is Effort => e in EFFORT_LABEL && e !== 'off');
    return sortEfforts(list.length ? list : CODEX_FALLBACK);
  }
  return [];
}

/** How a level reaches the model: CLI flag value, or API body fields. */
export function effortRequest(provider: ProviderId, auth: 'api' | 'cli', model: string, level: Effort | undefined): { effort?: string; extraBody?: Body } {
  // Claude streams its thinking as text only when asked for a summary; ask for it even at the default effort.
  // (A hand-typed older Claude id or a relay may refuse these fields: api.cjs retries once without them.)
  if (!level) return auth === 'api' && provider === 'claude' ? { extraBody: { thinking: { type: 'adaptive', display: 'summarized' } } } : {};
  if (auth === 'cli') return { effort: level === 'off' ? undefined : level };
  const spec = API[provider];
  if (!spec || !spec.levels(model).includes(level)) return {};
  return { extraBody: spec.body(level, model) };
}
