/* Saves tasks, runs and preferences to localStorage (best effort — private windows or blocked
   storage just mean a fresh demo each time). On load, a run that was mid-step is paused, never
   silently resumed. */
import { produce } from 'immer';
import type { AppState } from '../lib/types';
import { pauseRun } from './engine';
import { DEFAULT_SETTINGS, emptyState, seededState } from './seed';

const KEY = 'firefly-harness/v1';
const VERSION = 1;

/** Bumped when a setting's meaning changes; older saved values for it are replaced by the new default.
 *  2: the wallpaper transparency model changed (halo glass), so 壁纸可见度 / 面板通透度 restart at their defaults. */
const SETTINGS_REV = 2;

type Saved = Pick<AppState, 'settings' | 'tasks' | 'taskOrder' | 'runs' | 'events' | 'navCollapsed'> & {
  settingsRev?: number;
  version: number;
  console: Pick<AppState['console'], 'open' | 'height' | 'tab'>;
  tools: Array<{ id: string; permission: string }>;
  agents: Array<{ id: string; enabled: boolean; model: string }>;
};

export function loadState(now: number): AppState {
  let saved: Saved | undefined;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) saved = JSON.parse(raw) as Saved;
  } catch { saved = undefined; }
  if (!saved || saved.version !== VERSION || !saved.tasks || !saved.runs) return seededState(now);

  const savedSettings = { ...saved.settings };
  if ((saved.settingsRev ?? 1) < 2) {
    savedSettings.wallpaperVisibility = DEFAULT_SETTINGS.wallpaperVisibility;
    savedSettings.panelGlass = DEFAULT_SETTINGS.panelGlass;
  }
  const base = emptyState(now, { ...DEFAULT_SETTINGS, ...savedSettings });
  return produce(base, (d) => {
    d.tasks = saved.tasks as typeof d.tasks;
    d.taskOrder = saved.taskOrder.filter((id) => saved.tasks[id]);
    d.runs = saved.runs as typeof d.runs;
    d.events = (saved.events ?? []) as typeof d.events;
    d.navCollapsed = !!saved.navCollapsed;
    d.console.open = !!saved.console?.open;
    d.console.height = saved.console?.height ?? d.console.height;
    d.console.tab = saved.console?.tab ?? d.console.tab;
    for (const t of saved.tools ?? []) {
      const tool = d.tools.find((x) => x.id === t.id);
      if (tool && (t.permission === 'auto' || t.permission === 'confirm' || t.permission === 'off')) tool.permission = t.permission;
    }
    for (const a of saved.agents ?? []) {
      const agent = d.agents.find((x) => x.id === a.id);
      if (agent) { agent.enabled = a.id === 'orchestrator' ? true : !!a.enabled; agent.model = a.model || agent.model; }
    }
    for (const run of Object.values(d.runs)) {
      if (run.status === 'running' || run.status === 'queued') {
        if (run.status === 'queued') run.status = 'running';
        pauseRun(d, run, 'reload', now);
      }
    }
  });
}

let timer: number | undefined;
let latest: AppState | undefined;

function write() {
  timer = undefined;
  const s = latest;
  if (!s) return;
  const saved: Saved = {
    version: VERSION,
    settingsRev: SETTINGS_REV,
    settings: s.settings,
    tasks: s.tasks,
    taskOrder: s.taskOrder,
    runs: s.runs,
    events: s.events.slice(-200),
    navCollapsed: s.navCollapsed,
    console: { open: s.console.open, height: s.console.height, tab: s.console.tab },
    tools: s.tools.map((t) => ({ id: t.id, permission: t.permission })),
    agents: s.agents.map((a) => ({ id: a.id, enabled: a.enabled, model: a.model })),
  };
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* storage full or blocked: keep running in memory */ }
}

/** Throttled save; only fields worth keeping trigger it. */
export function saveSoon(next: AppState, prev: AppState) {
  if (next.tasks === prev.tasks && next.runs === prev.runs && next.settings === prev.settings && next.tools === prev.tools
    && next.agents === prev.agents && next.console === prev.console && next.navCollapsed === prev.navCollapsed && next.taskOrder === prev.taskOrder) return;
  latest = next;
  if (timer === undefined) timer = window.setTimeout(write, 1000);
}

export function flushSave() {
  if (timer !== undefined) { window.clearTimeout(timer); write(); }
}
