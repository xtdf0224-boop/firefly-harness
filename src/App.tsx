import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ConvergenceBurst } from './components/decor/ConvergenceBurst';
import { Starfield } from './components/decor/Starfield';
import { BootSplash } from './components/decor/BootSplash';
import { PeekBar } from './components/decor/PeekBar';
import { Wallpaper } from './components/decor/Wallpaper';
import { Console } from './components/console/Console';
import { ConnectionBanner } from './components/shell/ConnectionBanner';
import { DialogHost, LiveRegion, ToastHost } from './components/shell/hosts';
import { SideNav } from './components/shell/SideNav';
import { StatusPanel } from './components/shell/StatusPanel';
import { AgentsView } from './components/views/AgentsView';
import { HistoryView } from './components/views/HistoryView';
import { ModelsView } from './components/views/ModelsView';
import { NewTaskView } from './components/views/NewTaskView';
import { SettingsView } from './components/views/SettingsView';
import { TaskListView } from './components/views/TaskListView';
import { ToolsView } from './components/views/ToolsView';
import { Workspace } from './components/workspace/Workspace';
import { focusIsLost, focusMainHeading } from './lib/focus';
import { useMedia, useReducedMotion } from './lib/hooks';
import type { ViewId } from './lib/types';
import { actions } from './state/actions';
import { store, useApp } from './state/store';

const NAV_KEYS: Record<string, ViewId> = { '1': 'new', '2': 'tasks', '3': 'agents', '4': 'tools', '5': 'models', '6': 'history', '7': 'settings' };
/** Page name for document.title; a task page uses the task's own title. */
const VIEW_TITLES: Record<Exclude<ViewId, 'task'>, string> = {
  new: '新建', tasks: '任务列表', agents: 'Agent', tools: '工具与连接', models: '模型接入', history: '运行历史', settings: '设置',
};

export function App() {
  const mode = useApp((s) => s.settings.mode);
  const view = useApp((s) => s.view);
  const hasTask = useApp((s) => !!(s.selectedTaskId && s.tasks[s.selectedTaskId]));
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const taskTitle = useApp((s) => (s.selectedTaskId ? s.tasks[s.selectedTaskId]?.title : undefined));
  const consoleOpen = useApp((s) => s.console.open);
  const consoleHeight = useApp((s) => s.console.height);
  const navCollapsed = useApp((s) => s.navCollapsed);
  const drawerOpen = useApp((s) => s.statusDrawerOpen);
  const peek = useApp((s) => !!s.peek && s.settings.wallpaper);
  const bootAt = useApp((s) => s.bootAt);
  // 开机动画: on launch when enabled, and again whenever Settings asks for a preview.
  const [booting, setBooting] = useState(() => store.get().settings.bootAnimation);
  const [bootLeaving, setBootLeaving] = useState(false);
  useEffect(() => { if (bootAt) { setBooting(true); setBootLeaving(false); } }, [bootAt]);
  const reduced = useReducedMotion();
  const narrow = useMedia('(max-width: 1279px)');
  // Docked at >=1280px the drawer flag has no meaning; clear it so it cannot pop open when the window narrows.
  useEffect(() => { if (!narrow) actions.toggleStatusDrawer(false); }, [narrow]);

  useEffect(() => { document.documentElement.dataset.mode = mode; }, [mode]);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.console = consoleOpen ? 'open' : 'closed';
    root.style.setProperty('--console-h', `${consoleHeight}px`);
  }, [consoleOpen, consoleHeight]);
  useEffect(() => { document.documentElement.dataset.motion = reduced ? 'reduced' : 'full'; }, [reduced]);
  useEffect(() => { document.documentElement.dataset.peek = peek ? 'on' : 'off'; }, [peek]);
  useEffect(() => { document.documentElement.dataset.boot = booting ? (bootLeaving ? 'leaving' : 'on') : 'off'; }, [booting, bootLeaving]);

  // The tab title names the current page.
  const pageTitle = view === 'task' && hasTask && taskTitle ? taskTitle : VIEW_TITLES[view === 'task' ? 'tasks' : view];
  useEffect(() => { document.title = `${pageTitle} · 萤火`; }, [pageTitle]);

  // When the page changes and the element that had focus is gone (a list row, the composer's submit
  // button…), put focus on the new page's heading instead of letting it fall to <body>. Focus that is
  // still on a persistent control, such as the side nav, is left alone.
  const pageKey = `${view}:${view === 'task' && hasTask ? selectedTaskId : ''}`;
  const lastPageKey = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const previous = lastPageKey.current;
    lastPageKey.current = pageKey;
    if (previous === undefined || previous === pageKey) return;
    if (focusIsLost()) focusMainHeading();
  }, [pageKey]);

  // Global shortcuts: Ctrl+` console, Alt+1…7 sections, Esc closes the status drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (store.get().peek) {
        if (e.key === 'Escape' || (e.altKey && e.code === 'KeyW')) { e.preventDefault(); actions.togglePeek(false); }
        return;
      }
      if (e.altKey && !e.ctrlKey && e.code === 'KeyW' && store.get().settings.wallpaper) { e.preventDefault(); actions.togglePeek(true); return; }
      if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); actions.toggleConsole(); return; }
      if (e.altKey && !e.ctrlKey && !e.metaKey && NAV_KEYS[e.key]) { e.preventDefault(); actions.navigate(NAV_KEYS[e.key]); return; }
      if (e.key === 'Escape' && store.get().statusDrawerOpen && !store.get().dialog) actions.toggleStatusDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const content = (() => {
    switch (view) {
      case 'new': return <NewTaskView />;
      case 'task': return hasTask ? <Workspace /> : <TaskListView />;
      case 'tasks': return <TaskListView />;
      case 'agents': return <AgentsView />;
      case 'tools': return <ToolsView />;
      case 'models': return <ModelsView />;
      case 'history': return <HistoryView />;
      case 'settings': return <SettingsView />;
    }
  })();

  return (
    <>
      <Wallpaper />
      <Starfield />
      <a className="skip-link" href="#main">跳到主要内容</a>
      <div
        className="app"
        inert={peek || booting || undefined}
        data-nav={navCollapsed ? 'collapsed' : 'open'}
        data-console={consoleOpen ? 'open' : 'closed'}
        data-drawer={narrow ? (drawerOpen ? 'open' : 'closed') : 'docked'}
        style={{ ['--console-h' as string]: `${consoleHeight}px` }}
      >
        <SideNav />
        <main id="main" className="app__main" tabIndex={-1}>
          <ConnectionBanner />
          <div className="app__view" key={view}>{content}</div>
        </main>
        {narrow && drawerOpen && <div className="app__drawer-scrim" onClick={() => actions.toggleStatusDrawer(false)} aria-hidden />}
        <StatusPanel />
        <Console />
      </div>
      {peek && <PeekBar />}
      {booting && <BootSplash key={bootAt ?? 0} onLeave={() => setBootLeaving(true)} onDone={() => { setBooting(false); setBootLeaving(false); }} />}
      <ToastHost />
      <DialogHost />
      <LiveRegion />
      <ConvergenceBurst />
    </>
  );
}
