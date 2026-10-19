/* 模型接入 state and actions: per-vendor settings (non-secret), saved-key hints from the desktop
   process, CLI detection, login and connection tests. */
import { desktop, type StartSpec } from '../lib/desktop';
import {
  DRIVERS, PROVIDERS, PROVIDER_BY_ID, apiBaseUrl, contextOf, ctxLabel, defaultProviderConfig, engineLabel, modelInfo, readiness, regionOf, shortModelNote, tidyModelLabel,
} from '../lib/providers';
import { EFFORT_HINT, EFFORT_LABEL, effortLevels, type Effort, type LiveModel } from '../lib/effort';
import type { AgentEngine, AuthMode, DriverId, ModelState, ProviderConfig, ProviderId, TaskEngine } from '../lib/types';
import { announce, toast } from './engine';
import { refreshSkills } from './skills';
import { compatEnv } from './live';
import { store } from './store';

export function initialModels(): ModelState {
  return {
    providers: Object.fromEntries(PROVIDERS.map((p) => [p.id, defaultProviderConfig(p)])) as Record<ProviderId, ProviderConfig>,
    desktop: !!desktop,
    encryption: false,
    defaultEngine: '',
  };
}

/** Merge saved (non-secret) settings over the defaults; drop anything that no longer exists. */
export function restoreModels(saved: Partial<ModelState> | undefined): ModelState {
  const base = initialModels();
  if (!saved?.providers) return base;
  for (const p of PROVIDERS) {
    const old = saved.providers[p.id];
    if (!old) continue;
    const merged = { ...base.providers[p.id], ...old, id: p.id, keyHint: undefined };
    if (!p.drivers.includes(merged.driver)) merged.driver = p.drivers[0];
    if (!p.regions.some((r) => r.id === merged.region)) merged.region = p.regions[0].id;
    base.providers[p.id] = merged;
  }
  base.defaultEngine = saved.defaultEngine && PROVIDER_BY_ID[saved.defaultEngine as ProviderId] ? saved.defaultEngine as ProviderId : '';
  return base;
}

const feedback = (tone: 'success' | 'danger' | 'info' | 'warning', title: string, body?: string) =>
  store.update((d) => { toast(d, { tone, title, body }); announce(d, `${title}${body ? `：${body}` : ''}`); });

function patch(id: ProviderId, fn: (c: ProviderConfig) => void) {
  store.update((d) => { const c = d.models.providers[id]; if (c) fn(c as ProviderConfig); });
}

/** Ask the desktop process which keys are saved; detect the CLIs that are in use. */
export async function refreshModels() {
  if (!desktop) return;
  try {
    const info = await desktop.info();
    store.update((d) => {
      d.models.desktop = true;
      d.models.encryption = info.encryption;
      d.models.workspaceRoot = info.workspaceRoot;
      for (const p of PROVIDERS) d.models.providers[p.id].keyHint = info.keys[p.id];
    });
  } catch { /* the bridge is there but not answering: leave everything as not set up */ }
  const st = store.get();
  const toDetect = PROVIDERS.filter((p) => st.models.providers[p.id].auth === 'cli' || st.models.providers[p.id].cli);
  await Promise.all(toDetect.map((p) => detectCli(p.id, true)));
  await Promise.all([refreshLiveModels(), refreshSkills()]);
}

/** Ask CLIs that can list their models (Codex) which ones the account has, with their effort levels. */
export async function refreshLiveModels(fresh = false) {
  if (!desktop?.models) return;
  const st = store.get();
  const drivers = new Set<DriverId>();
  for (const p of PROVIDERS) {
    const c = st.models.providers[p.id];
    if (c.cli?.found && c.driver === 'codex') drivers.add('codex');
  }
  for (const driver of drivers) {
    const c = Object.values(st.models.providers).find((x) => x.driver === driver);
    try {
      const list = await desktop.models({ driver, path: c?.cliPath || undefined, fresh });
      if (list?.length) store.update((d) => { d.models.live = { ...(d.models.live ?? {}), [driver]: list }; });
    } catch { /* keep the static list */ }
  }
}

export const modelActions = {
  set(id: ProviderId, values: Partial<Omit<ProviderConfig, 'id'>>) {
    patch(id, (c) => {
      const driverChanged = values.driver && values.driver !== c.driver;
      Object.assign(c, values);
      if (driverChanged) {
        c.cli = undefined;
        // The old path points at the old program (dsh.cmd is not claude.cmd).
        if (values.cliPath === undefined) c.cliPath = '';
        c.cliModel = PROVIDER_BY_ID[id].cliModels[c.driver]?.[0]?.id ?? '';
      }
      if (values.driver || values.cliPath !== undefined || values.region || values.baseUrl !== undefined || values.model) c.test = undefined;
    });
    // Switching to the CLI way (or changing which CLI) checks it right away.
    const c = store.get().models.providers[id];
    if (values.driver || values.cliPath !== undefined || (values.auth === 'cli' && !c.cli)) void detectCli(id, true);
  },
  setDefault(engine: ProviderId) {
    store.update((d) => { d.models.defaultEngine = engine; });
  },
  async saveKey(id: ProviderId, key: string) {
    if (!desktop) return false;
    const r = await desktop.saveKey(id, key);
    if (!r.ok) { feedback('danger', '没能保存密钥', r.error); return false; }
    patch(id, (c) => { c.keyHint = r.hint; c.test = undefined; });
    feedback('success', '密钥已加密保存', `${PROVIDER_BY_ID[id].name} · ${r.hint}`);
    return true;
  },
  async clearKey(id: ProviderId) {
    if (!desktop) return;
    await desktop.clearKey(id);
    patch(id, (c) => { c.keyHint = undefined; c.test = undefined; });
    feedback('info', '密钥已删除', PROVIDER_BY_ID[id].name);
  },
  detect: (id: ProviderId) => detectCli(id, false),
  async login(id: ProviderId) {
    if (!desktop) return;
    const c = store.get().models.providers[id];
    const r = await desktop.openLogin({ driver: c.driver, path: c.cliPath || undefined });
    if (r.ok) feedback('info', '已打开登录窗口', `在新窗口里完成登录（${r.command}），然后回来点「检测」。`);
    else feedback('warning', '没能打开登录窗口', r.error);
  },
  async test(id: ProviderId, auth: AuthMode) {
    if (!desktop) return;
    const p = PROVIDER_BY_ID[id];
    const c = store.get().models.providers[id];
    const ready = readiness(p, c, auth);
    if (!ready.ready) { feedback('warning', '还不能测试', ready.reason); return; }
    patch(id, (x) => { x.test = { ok: false, at: Date.now(), ms: 0, message: '测试中…', auth, driver: auth === 'cli' ? c.driver : undefined }; });
    const spec = testSpec(id, auth);
    const r = await desktop.test(spec);
    patch(id, (x) => {
      x.test = r.ok
        ? { ok: true, at: Date.now(), ms: r.ms, message: `回复「${r.text || '（空）'}」${r.model ? ` · ${r.model}` : ''}`, auth, driver: auth === 'cli' ? c.driver : undefined }
        : { ok: false, at: Date.now(), ms: r.ms, message: r.error, auth, driver: auth === 'cli' ? c.driver : undefined };
    });
    if (r.ok) feedback('success', `${p.name} 连接正常`, `${auth === 'api' ? 'API' : DRIVERS[c.driver].label} · ${(r.ms / 1000).toFixed(1)} 秒`);
    else feedback('danger', `${p.name} 连接失败`, r.error.slice(0, 160));
  },
};

async function detectCli(id: ProviderId, quiet: boolean) {
  if (!desktop) return;
  const c = store.get().models.providers[id];
  const r = await desktop.detect({ driver: c.driver, path: c.cliPath || undefined });
  // The path may have been edited (or the driver switched) while this one was being checked.
  patch(id, (x) => { if (x.driver === c.driver && (x.cliPath || '') === (c.cliPath || '')) x.cli = { ...r, at: Date.now() }; });
  if (r.found && c.driver === 'codex' && !store.get().models.live?.codex) void refreshLiveModels();
  if (!quiet) {
    const d = DRIVERS[c.driver];
    if (!r.found) feedback('warning', `没有找到 ${d.label}`, r.detail);
    else feedback(r.login === 'no' ? 'warning' : 'success', `${d.label} ${r.version || ''}`.trim(),
      r.login === 'yes' ? `已登录${r.account ? ` · ${r.account}` : ''}` : r.login === 'no' ? '还没有登录' : r.login === 'n/a' ? '使用这里保存的 API Key' : '已找到');
  }
}

/** The spec a connection test uses (the desktop side adds the key and a scratch folder). */
function testSpec(id: ProviderId, auth: AuthMode): StartSpec {
  const p = PROVIDER_BY_ID[id];
  const c = store.get().models.providers[id];
  if (auth === 'api') return { driver: p.protocol === 'anthropic' ? 'api-anthropic' : 'api-openai', provider: id, baseUrl: apiBaseUrl(p, c), model: c.model };
  const spec: StartSpec = { driver: c.driver, provider: id, path: c.cliPath || undefined, model: c.cliModel || undefined };
  if (c.driver === 'kimi' || c.driver === 'qwen' || c.driver === 'mcode') { spec.driver = 'acp'; spec.acp = c.driver; }
  if (c.driver === 'claude-compat') {
    const model = c.cliModel || c.model;
    spec.model = undefined;
    spec.keyEnv = 'ANTHROPIC_AUTH_TOKEN';
    spec.env = compatEnv(regionOf(p, c).compatUrl ?? '', model, contextOf(p, model));
  } else if (c.driver === 'qwen') {
    spec.keyEnv = 'OPENAI_API_KEY';
    spec.env = { OPENAI_BASE_URL: apiBaseUrl(p, c), OPENAI_MODEL: c.cliModel || 'qwen3.7-plus' };
    spec.model = undefined;
  }
  return spec;
}

export interface EngineChoice {
  key: string;
  provider: ProviderId;
  auth: AuthMode;
  driver?: DriverId;
  /** The model set on 模型接入 ('' = the tool's default). */
  model: string;
  /** The default 推理强度 set on 模型接入. */
  effort?: Effort;
  label: string;
  tested: boolean;
}

/** Ways a new task can run right now (vendors with a key or a found CLI). */
export function engineChoices(m: ModelState): EngineChoice[] {
  const out: EngineChoice[] = [];
  for (const p of PROVIDERS) {
    const c = m.providers[p.id];
    for (const auth of [c.auth, c.auth === 'api' ? 'cli' : 'api'] as AuthMode[]) {
      if (!readiness(p, c, auth).ready) continue;
      const model = auth === 'api' ? c.model : c.cliModel;
      out.push({
        key: `${p.id}:${auth}`, provider: p.id, auth, driver: auth === 'cli' ? c.driver : undefined, model,
        effort: auth === 'api' ? c.effort : c.cliEffort,
        label: engineLabel(p, auth, c.driver, model),
        tested: !!c.test?.ok && c.test.auth === auth && (auth === 'api' || c.test.driver === c.driver),
      });
    }
  }
  return out;
}

/** Models offered for a way of running a vendor: the catalog (or the CLI's live list), plus whatever was typed on 模型接入. */
export function modelOptions(m: ModelState, choice: Pick<EngineChoice, 'provider' | 'auth' | 'driver'>): LiveModel[] {
  const p = PROVIDER_BY_ID[choice.provider];
  const c = m.providers[choice.provider];
  const out: LiveModel[] = [];
  const add = (x: LiveModel) => { if (!out.some((y) => y.id === x.id)) out.push(x); };
  const named = (id: string, note?: string): LiveModel => {
    const info = modelInfo(p, id);
    return { id, label: info?.label ?? id, note: [note ?? info?.note, ctxLabel(info?.ctx)].filter(Boolean).join(' · ') || undefined };
  };
  if (choice.auth === 'api') {
    for (const x of p.models) add(named(x.id));
    if (c.model) add(named(c.model, '自定义'));
    return out;
  }
  const driver = choice.driver ?? c.driver;
  const tool = DRIVERS[driver].label;
  const live = m.live?.[driver];
  if (live?.length) {
    const def = live.find((x) => x.isDefault);
    add({ id: '', label: `默认（${tool} 自己选）`, note: def ? `现在是 ${modelInfo(p, def.id)?.label ?? tidyModelLabel(def.label)}` : undefined });
    // The CLI's own list: version names in the catalog's style, short Chinese notes instead of its English blurbs.
    for (const x of live) {
      const info = modelInfo(p, x.id);
      add({ ...x, label: info?.label ?? tidyModelLabel(x.label), note: [info?.note ?? shortModelNote(x.note), ctxLabel(info?.ctx)].filter(Boolean).join(' · ') || undefined });
    }
  } else {
    for (const x of p.cliModels[driver] ?? []) add(x.id ? named(x.id, x.note) : { id: '', label: `默认（${tool} 自己选）` });
    if (!out.some((x) => x.id === '')) out.unshift({ id: '', label: `默认（${tool} 自己选）` });
  }
  if (c.cliModel) add(named(c.cliModel, '自定义'));
  return out;
}

/** Value of one entry in a model menu: `${choice.key}|${model}`. */
export const menuValue = (key: string, model: string) => `${key}|${model}`;
export function parseMenuValue(v: string): { key: string; model: string } {
  const [key, ...rest] = v.split('|');
  return { key, model: rest.join('|') };
}

/** The grouped model menu (one group per vendor and way, models with their version names), shaped for
    MenuSelect. Shared by the message box chips, the Agent page and anywhere else a model is picked. */
export function modelMenuGroups(m: ModelState): Array<{ label: string; hint?: string; options: Array<{ value: string; label: string; sub?: string; meta?: string }> }> {
  return engineChoices(m).map((c) => {
    const p = PROVIDER_BY_ID[c.provider];
    const how = c.auth === 'api' ? 'API' : DRIVERS[c.driver ?? p.drivers[0]].label;
    return {
      label: `${p.name} · ${how}`,
      hint: c.auth === 'api' ? 'API 密钥' : DRIVERS[c.driver ?? p.drivers[0]].auth === 'account' ? '账号登录' : '用 API 密钥',
      options: modelOptions(m, c).map((x) => ({ value: menuValue(c.key, x.id), label: x.label, sub: x.id || undefined, meta: x.note })),
    };
  });
}

/** The 推理强度 menu for a choice + model: 默认 first, then each level with its hint. */
export function effortMenu(levels: Effort[], defaultLabel = '默认'): Array<{ value: string; label: string; sub?: string }> {
  return [{ value: '', label: defaultLabel, sub: '用模型自己的默认强度' }, ...levels.map((l) => ({ value: l, label: EFFORT_LABEL[l], sub: EFFORT_HINT[l] }))];
}

/** The engine choice new tasks start with: the default vendor (if ready), else the first ready one. */
export function defaultChoice(m: ModelState, choices = engineChoices(m)): EngineChoice | undefined {
  return (m.defaultEngine ? choices.find((c) => c.provider === m.defaultEngine) : undefined) ?? choices[0];
}

/** An agent's own model as a TaskEngine, or undefined when it follows the task (or its way is not ready any more). */
export function agentEngine(m: ModelState, ae: AgentEngine | undefined, extra: Pick<TaskEngine, 'cwd' | 'access' | 'browser'>): TaskEngine | undefined {
  if (!ae) return undefined;
  const choice = engineChoices(m).find((c) => c.key === ae.key);
  if (!choice) return undefined;
  const levels = choiceEfforts(m, choice, ae.model);
  return engineFromChoice(choice, { ...extra, model: ae.model, effort: ae.effort && levels.includes(ae.effort) ? ae.effort : undefined });
}

/** Effort levels for a choice + model (empty = cannot be tuned). */
export function choiceEfforts(m: ModelState, choice: Pick<EngineChoice, 'provider' | 'auth' | 'driver'>, model: string): Effort[] {
  const driver = choice.auth === 'cli' ? (choice.driver ?? m.providers[choice.provider].driver) : undefined;
  return effortLevels(choice.provider, choice.auth, driver, model, driver ? m.live?.[driver] : undefined);
}

export function engineFromChoice(choice: EngineChoice, extra: Pick<TaskEngine, 'cwd' | 'access' | 'browser'> & { model?: string; effort?: Effort }): TaskEngine {
  const p = PROVIDER_BY_ID[choice.provider];
  const model = extra.model ?? choice.model;
  const effort = extra.effort;
  const label = `${engineLabel(p, choice.auth, choice.driver, model)}${effort ? ` · ${EFFORT_LABEL[effort]}强度` : ''}`;
  return { kind: 'live', provider: choice.provider, auth: choice.auth, driver: choice.driver, model, label, cwd: extra.cwd, access: extra.access, effort, browser: extra.browser || undefined };
}
