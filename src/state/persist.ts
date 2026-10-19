/* Saves tasks, runs and preferences to localStorage (best effort — private windows or blocked
   storage just mean a fresh demo each time). On load, a run that was mid-step is paused, never
   silently resumed. Preferences (settings, tool policy, model access) live under their own small key
   so they keep saving even when the task history has grown too big for the storage quota. */
import { produce } from 'immer';
import type { AppState, Run } from '../lib/types';
import { pauseRun, toast } from './engine';
import { normalizeAfterLoad } from './live';
import { restoreModels } from './models';
import { DEFAULT_SETTINGS, emptyState, seededState, syncPersonaAgent } from './seed';
import { store } from './store';

const KEY = 'firefly-harness/v1';
const PREFS_KEY = 'firefly-harness/prefs';
const VERSION = 1;

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
  agents: Array<{ id: string; enabled: boolean; model: string }>;
  models?: Pick<AppState['models'], 'providers' | 'defaultEngine'>;
};

type Saved = Partial<Prefs> & Pick<AppState, 'tasks' | 'taskOrder' | 'runs' | 'events'> & { version: number };

function read<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch { return undefined; }
}

export function loadState(now: number): AppState {
  const saved = read<Saved>(KEY);
  if (!saved || saved.version !== VERSION || !saved.tasks || !saved.runs) return seededState(now);
  // Older saves kept the preferences inside the main blob.
  const prefs: Partial<Prefs> = read<Prefs>(PREFS_KEY) ?? saved;
  const models = restoreModels(prefs.models);

  const savedSettings = { ...prefs.settings };
  if ((prefs.settingsRev ?? 1) < 2) {
    savedSettings.wallpaperVisibility = DEFAULT_SETTINGS.wallpaperVisibility;
    savedSettings.panelGlass = DEFAULT_SETTINGS.panelGlass;
  }
  const base = emptyState(now, { ...DEFAULT_SETTINGS, ...savedSettings });
  return produce(base, (d) => {
    d.tasks = saved.tasks as typeof d.tasks;
    d.taskOrder = saved.taskOrder.filter((id) => saved.tasks[id]);
    d.runs = saved.runs as typeof d.runs;
    d.models = models;
    d.events = (saved.events ?? []) as typeof d.events;
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
      if (agent) { agent.enabled = a.id === 'orchestrator' ? true : !!a.enabled; agent.model = a.model || agent.model; }
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
    agents: s.agents.map((a) => ({ id: a.id, enabled: a.enabled, model: a.model })),
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
    const saved: Saved = { version: VERSION, tasks: s.tasks, taskOrder: s.taskOrder, runs, events: s.events.slice(-200) };
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
