/* Saves tasks, runs and preferences to localStorage (best effort — private windows or blocked
   storage just mean a fresh start each time). On load, a run that was mid-step is paused, never
   silently resumed. Preferences (settings, tool policy, agents, model access) live under their own
   small key so they keep saving even when the task history has grown too big for the storage quota. */
import { produce } from 'immer';
import { EFFORT_LABEL, type Effort } from '../lib/effort';
import { PROVIDER_BY_ID } from '../lib/providers';
import type { AgentEngine, AppState, Message, Run, Settings, ToolId } from '../lib/types';
import { pauseRun, toast } from './engine';
import { normalizeAfterLoad } from './live';
import { restoreModels } from './models';
import { DEFAULT_SETTINGS, emptyState, syncPersonaAgent } from './seed';
import { store } from './store';

const KEY = 'firefly-harness/v1';
const PREFS_KEY = 'firefly-harness/prefs';
const VERSION = 1;
/** Bumped when the saved task history changes shape.
 *  2: the 演示模式 simulator is gone, so older saves are cleaned on load (see dropDemoData). */
const DATA_REV = 2;

/** Bumped when a setting's meaning changes; older saved values for it are replaced by the new default.
 *  2: the wallpaper transparency model changed (halo glass), so 壁纸可见度 / 面板通透度 restart at their defaults. */
const SETTINGS_REV = 2;
/** Bumped when a tool's default policy becomes stricter.
 *  2: 抓取网页 asks first (fetched pages can carry injected instructions and a fetch can carry data out). */
const POLICY_REV = 2;

type Prefs = Pick<AppState, 'settings' | 'navCollapsed'> & {
  settingsRev?: number;
  policyRev?: number;
  console: Pick<AppState['console'], 'open' | 'height' | 'tab'>;
  tools: Array<{ id: string; permission: string }>;
  agents: Array<{ id: string; enabled: boolean; tools?: ToolId[]; engine?: AgentEngine }>;
  models?: Pick<AppState['models'], 'providers' | 'defaultEngine'>;
};

type Saved = Partial<Prefs> & Pick<AppState, 'tasks' | 'taskOrder' | 'runs' | 'events'> & { version: number; rev?: number };
type Loose = Record<string, unknown>;

function read<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch { return undefined; }
}

/** Settings that exist and have the right kind of value; anything else (removed keys, garbage) is ignored. */
function pickSettings(raw: unknown): Partial<Settings> {
  const out: Loose = {};
  if (raw && typeof raw === 'object') {
    for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
      const v = (raw as Loose)[key];
      if (typeof v === typeof def) out[key] = v;
    }
  }
  return out as Partial<Settings>;
}

/** An agent's saved model, if it still names a vendor, a way (`claude:cli`) and a known effort. */
function validEngine(raw: unknown): AgentEngine | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { key, model, effort } = raw as Loose;
  if (typeof key !== 'string' || typeof model !== 'string') return undefined;
  const [provider, auth, ...rest] = key.split(':');
  if (!Object.hasOwn(PROVIDER_BY_ID, provider) || (auth !== 'api' && auth !== 'cli') || rest.length) return undefined;
  return { key, model, effort: typeof effort === 'string' && Object.hasOwn(EFFORT_LABEL, effort) ? effort as Effort : undefined };
}

const strip = (o: object, keys: string[]) => { for (const k of keys) delete (o as Loose)[k]; };

/** Saves from before the simulator was removed: keep what real models did, drop the 演示 tasks (they
 *  have no model) and everything they made, and remove fields that no longer exist. */
function dropDemoData(saved: Saved) {
  const real = new Set<string>();
  for (const [id, run] of Object.entries(saved.runs)) {
    if (saved.tasks[run.taskId] && (run as unknown as Loose).source === 'live') real.add(id);
    else delete saved.runs[id];
  }
  // A message is the user's own history when it was not made by the simulator — or belongs to a real
  // run (the old cancel notice was tagged simulated even on real runs).
  const kept = (m: Message) => (!(m as unknown as Loose).simulated || (!!m.runId && real.has(m.runId))) && !(m.runId && !real.has(m.runId));
  for (const [id, task] of Object.entries(saved.tasks)) {
    task.runIds = task.runIds.filter((runId) => real.has(runId));
    task.messages = task.messages.filter(kept);
    // Demo tasks have nothing real left. A real chat that was switched to 演示模式 keeps its history
    // (engine stays unset; the UI asks for a model).
    const own = task.messages.some((m) => m.role === 'user' || m.role === 'agent');
    if (!task.engine && !task.runIds.length && !own) { delete saved.tasks[id]; continue; }
    if (!task.engine && (task as unknown as Loose).source !== 'live' && !task.runIds.length && !task.messages.some((m) => (m as unknown as Loose).live)) { delete saved.tasks[id]; continue; }
    strip(task, ['scenarioId', 'source']);
    for (const m of task.messages) strip(m, ['simulated', 'live']);
  }
  for (const run of Object.values(saved.runs)) {
    strip(run, ['source', 'fixStepIndex']);
    strip(run.cursor, ['beat', 'beatElapsed', 'beatStarted']);
    for (const c of run.toolCalls) strip(c, ['simulated', 'expectedMs']);
    for (const a of run.artifacts) strip(a, ['simulated']);
  }
  saved.events = (saved.events ?? []).filter((e) => (!e.runId || real.has(e.runId)) && (e.kind as string) !== 'connection' && !e.text.includes('（模拟'));
}

export function loadState(now: number): AppState {
  const blob = read<Saved>(KEY);
  const saved = blob && blob.version === VERSION && blob.tasks && blob.runs ? blob : undefined;
  if (saved && (saved.rev ?? 1) < DATA_REV) dropDemoData(saved);
  // Older saves kept the preferences inside the main blob.
  const prefs: Partial<Prefs> = read<Prefs>(PREFS_KEY) ?? saved ?? {};
  const models = restoreModels(prefs.models);

  const savedSettings = pickSettings(prefs.settings);
  if ((prefs.settingsRev ?? 1) < 2) {
    savedSettings.wallpaperVisibility = DEFAULT_SETTINGS.wallpaperVisibility;
    savedSettings.panelGlass = DEFAULT_SETTINGS.panelGlass;
  }
  const base = emptyState(now, { ...DEFAULT_SETTINGS, ...savedSettings });
  return produce(base, (d) => {
    if (saved) {
      d.tasks = saved.tasks;
      d.taskOrder = saved.taskOrder.filter((id) => saved.tasks[id]);
      d.runs = saved.runs;
      d.events = saved.events ?? [];
    }
    d.models = models;
    d.navCollapsed = !!prefs.navCollapsed;
    d.console.open = !!prefs.console?.open;
    d.console.height = prefs.console?.height ?? d.console.height;
    d.console.tab = prefs.console?.tab ?? d.console.tab;
    for (const t of prefs.tools ?? []) {
      const tool = d.tools.find((x) => x.id === t.id);
      if (!tool || !(t.permission === 'auto' || t.permission === 'confirm' || t.permission === 'off')) continue;
      // A tool whose default became stricter keeps an old 自动 only if it was saved after the change.
      if ((prefs.policyRev ?? 1) < 2 && t.id === 'web_fetch' && t.permission === 'auto') continue;
      tool.permission = t.permission;
    }
    for (const a of prefs.agents ?? []) {
      const agent = d.agents.find((x) => x.id === a.id);
      if (!agent) continue;
      agent.enabled = a.id === 'orchestrator' ? true : !!a.enabled;
      if (Array.isArray(a.tools)) agent.tools = d.tools.map((t) => t.id).filter((id) => a.tools!.includes(id));
      // The 编排 Agent always follows the task's model.
      agent.engine = a.id === 'orchestrator' ? undefined : validEngine(a.engine);
    }
    for (const run of Object.values(d.runs)) {
      if (run.status === 'running' || run.status === 'queued') {
        if (run.status === 'queued') run.status = 'running';
        pauseRun(d, run, 'reload', now);
      }
    }
    // Runs saved before the window became 1M.
    for (const run of Object.values(d.runs)) if (run.usage.contextLimit === 200_000) run.usage.contextLimit = 1_000_000;
    normalizeAfterLoad(d);
    syncPersonaAgent(d);
  });
}

let timer: number | undefined;
let latest: AppState | undefined;
let warned = false;

const cut = (v: unknown, max: number) => (typeof v === 'string' && v.length > max ? `${v.slice(0, max)}\n…（保存时截断）` : v);

/** A run as it is stored: long tool inputs and outputs are cut; `lean` also drops the bulky parts. */
function slim(run: Run, lean: boolean): Run {
  return {
    ...run,
    terminal: lean ? [] : run.terminal,
    toolCalls: run.toolCalls.map((c) => ({
      ...c,
      input: Object.fromEntries(Object.entries(c.input ?? {}).map(([k, v]) => [k, cut(v, lean ? 500 : 4000)])),
      output: cut(c.output, lean ? 500 : 4000) as string | undefined,
    })),
    artifacts: lean ? run.artifacts.map((a) => ({ ...a, content: cut(a.content, 2000) as string })) : run.artifacts,
    plan: lean ? run.plan.map((st) => ({ ...st, result: cut(st.result, 4000) as string | undefined })) : run.plan,
  };
}

function write() {
  timer = undefined;
  const s = latest;
  if (!s) return;
  const prefs: Prefs = {
    settingsRev: SETTINGS_REV,
    policyRev: POLICY_REV,
    settings: s.settings,
    navCollapsed: s.navCollapsed,
    console: { open: s.console.open, height: s.console.height, tab: s.console.tab },
    tools: s.tools.map((t) => ({ id: t.id, permission: t.permission })),
    agents: s.agents.map((a) => ({ id: a.id, enabled: a.enabled, tools: a.tools, engine: a.engine })),
    models: {
      // Never the key itself (it is not in the page); not even its hint, which is re-read from the desktop.
      providers: Object.fromEntries(Object.entries(s.models.providers).map(([id, c]) => [id, { ...c, keyHint: undefined }])) as AppState['models']['providers'],
      defaultEngine: s.models.defaultEngine,
    },
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* blocked storage: keep running in memory */ }

  // Newest runs keep their detail; when the quota is hit, older runs are slimmed first, then everything.
  const order = Object.values(s.runs).sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
  const attempt = (leanFrom: number) => {
    const runs: Record<string, Run> = {};
    order.forEach((r, i) => { runs[r.id] = slim(r, i >= leanFrom); });
    const saved: Saved = { version: VERSION, rev: DATA_REV, tasks: s.tasks, taskOrder: s.taskOrder, runs, events: s.events.slice(-200) };
    localStorage.setItem(KEY, JSON.stringify(saved));
  };
  for (const leanFrom of [Infinity, 10, 3, 0]) {
    try { attempt(leanFrom); return; } catch (e) {
      if (!(e instanceof DOMException) || !/quota/i.test(`${e.name} ${e.message}`)) return; // blocked, not full
    }
  }
  if (!warned) {
    warned = true;
    store.update((d) => toast(d, { tone: 'warning', title: '本地存储已满', key: 'storage-full',
      body: '任务记录太多，最新的改动没能保存。设置和模型接入不受影响；可以删除一些旧任务腾出空间。' }));
  }
}

/** Throttled save; only fields worth keeping trigger it. */
export function saveSoon(next: AppState, prev: AppState) {
  if (next.tasks === prev.tasks && next.runs === prev.runs && next.settings === prev.settings && next.tools === prev.tools
    && next.agents === prev.agents && next.console === prev.console && next.navCollapsed === prev.navCollapsed && next.taskOrder === prev.taskOrder
    && next.models === prev.models) return;
  latest = next;
  if (timer === undefined) timer = window.setTimeout(write, 1000);
}

export function flushSave() {
  if (timer !== undefined) { window.clearTimeout(timer); write(); }
}
