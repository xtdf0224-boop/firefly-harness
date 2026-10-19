/* Everything a component can do. Each run control goes through `backend` and then gives visible
   feedback (toast + screen-reader announcement), whether it succeeded or not. */
import type {
  AgentEngine, AgentId, ConsoleTab, Dialog, Settings, Task, TaskEngine, TaskKind, ToolId, ToolPermission, Toast, UiCommand, ViewId, WorkspaceTab,
} from '../lib/types';
import { backend } from './backend';
import { announce, dropToasts, pushEvent, toast as pushToast } from './engine';
import { forgetTask, reply } from './live';
import { syncPersonaAgent } from './seed';
import { store, uid } from './store';

type ToastInput = Omit<Toast, 'id' | 'createdAt' | 'ttl'> & { ttl?: number };

function feedback(t: ToastInput, spoken?: string) {
  store.update((d) => {
    pushToast(d, t);
    announce(d, spoken ?? `${t.title}${t.body ? `：${t.body}` : ''}`);
  });
}

const NO_MODEL: ToastInput = {
  tone: 'warning', title: '还没有选择模型', body: '先到「模型接入」连接一个模型，再回来给任务选上它。',
  action: { label: '去模型接入', command: { type: 'navigate', view: 'models' } },
};

const runOf = (runId: string) => store.get().runs[runId];
const orchestratorName = () => store.get().agents.find((a) => a.id === 'orchestrator')?.name ?? '编排 Agent';
const taskOfRun = (runId: string) => store.get().tasks[runOf(runId)?.taskId ?? ''];
/** The status panel is a drawer below 1280px; docked above, where "open" has no meaning. */
const drawerMode = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1279px)').matches;

export const actions = {
  /* ── navigation ── */
  navigate(view: ViewId) {
    store.update((d) => { d.view = view; d.statusDrawerOpen = false; });
  },
  openTask(taskId: string, runId?: string, tab?: WorkspaceTab) {
    store.update((d) => {
      if (!d.tasks[taskId]) return;
      d.view = 'task';
      d.selectedTaskId = taskId;
      d.selectedRunId = runId;
      d.statusDrawerOpen = false;
      if (tab) d.workspaceTab = tab;
    });
  },
  selectRun(runId: string) {
    store.update((d) => { d.selectedRunId = runId; });
  },
  setWorkspaceTab(tab: WorkspaceTab) {
    store.update((d) => { d.workspaceTab = tab; });
  },
  toggleNav() {
    store.update((d) => { d.navCollapsed = !d.navCollapsed; });
  },
  /** Replay the 开机动画 (Settings › 外观 › 预览). */
  playBoot() {
    store.update((d) => { d.bootAt = Date.now(); d.peek = false; });
  },
  togglePeek(on?: boolean) {
    store.update((d) => {
      d.peek = d.settings.wallpaper ? (on ?? !d.peek) : false;
      if (d.peek) d.statusDrawerOpen = false;
    });
  },
  toggleStatusDrawer(open?: boolean) {
    store.update((d) => { d.statusDrawerOpen = open ?? !d.statusDrawerOpen; });
  },
  requestFocus(target: 'approvals' | 'composer' | 'console' | 'plan') {
    store.update((d) => {
      d.focusRequest = { target, at: Date.now() };
      if (target === 'approvals' && drawerMode()) d.statusDrawerOpen = true;
      if (target === 'console') d.console.open = true;
    });
  },

  /* ── tasks ── */
  createTask(input: { title: string; goal: string; kind?: TaskKind; engine?: TaskEngine; agentIds: AgentId[]; start: boolean; skills?: string[] }): string {
    const id = uid('task');
    const now = Date.now();
    const kind = input.kind ?? 'work';
    store.update((d) => {
      const first = input.goal.trim();
      const task: Task = {
        id, title: input.title.trim() || (kind === 'chat' ? '闲聊' : '未命名任务'), goal: first, createdAt: now, updatedAt: now,
        agentIds: input.agentIds.length ? input.agentIds : ['orchestrator'], runIds: [],
        messages: first ? [{ id: uid('msg'), role: 'user', text: first, at: now }] : [],
        kind, engine: input.engine, skills: input.skills,
      };
      d.tasks[id] = task;
      d.taskOrder.unshift(id);
      d.view = 'task';
      d.selectedTaskId = id;
      d.selectedRunId = undefined;
      d.workspaceTab = 'conversation';
      pushEvent(d, { kind: 'user', level: 'info', text: `${kind === 'chat' ? '新建闲聊' : '新建任务'}：${task.title}` });
    });
    // The composer is disabled until a model is ready; this only catches a task whose model went away.
    if (!input.engine) { feedback(NO_MODEL); return id; }
    if (kind === 'chat') {
      if (input.goal.trim()) void reply(id);
      return id;
    }
    if (input.start) {
      const r = backend.startRun(id);
      if (r.ok) feedback({ tone: 'running', title: '任务已创建并开始运行', body: `${input.engine.label} 正在制定计划。` });
      else feedback({ tone: 'warning', title: '任务已创建，但还没开始', body: r.error });
    } else {
      feedback({ tone: 'info', title: '任务已创建', body: '准备好后点「开始」。' });
    }
    return id;
  },
  /** Switch the model a task uses; the next reply starts a fresh conversation with it. */
  setTaskEngine(taskId: string, engine: TaskEngine) {
    store.update((d) => {
      const t = d.tasks[taskId];
      if (!t) return;
      const sameModel = t.engine && engine.provider === t.engine.provider && engine.auth === t.engine.auth && engine.driver === t.engine.driver && engine.model === t.engine.model;
      t.engine = engine;
      if (!sameModel) t.session = undefined;
      t.messages.push({ id: uid('msg'), role: 'system', text: `已切换到 ${engine.label}。`, at: Date.now() });
    });
  },
  requestDeleteTask(taskId: string) {
    store.update((d) => { d.dialog = { kind: 'delete-task', taskId }; });
  },
  deleteTask(taskId: string) {
    const task = store.get().tasks[taskId];
    if (!task) return;
    // Stop the real agent first: it must not keep editing the folder of a task that no longer exists.
    forgetTask(taskId);
    store.update((d) => {
      const gone = new Set(task.runIds);
      // Toasts about this task (approval, failure, completion) would be left with dead actions.
      for (const runId of task.runIds) {
        dropToasts(d, `run:${runId}`);
        for (const a of d.runs[runId]?.approvals ?? []) dropToasts(d, `approval:${a.id}`);
      }
      d.toasts = d.toasts.filter((t) => {
        const c = t.action?.command;
        if (!c) return true;
        if ('taskId' in c && c.taskId === taskId) return false;
        if ('runId' in c && c.runId && gone.has(c.runId)) return false;
        return true;
      });
      for (const runId of task.runIds) delete d.runs[runId];
      d.events = d.events.filter((e) => !e.runId || !gone.has(e.runId));
      delete d.tasks[taskId];
      d.taskOrder = d.taskOrder.filter((id) => id !== taskId);
      if (d.selectedTaskId === taskId) { d.selectedTaskId = undefined; d.selectedRunId = undefined; if (d.view === 'task') d.view = 'tasks'; }
    });
    feedback({ tone: 'neutral', title: '任务已删除', body: `「${task.title}」及其运行记录已移除。` });
  },

  /* ── run control ── */
  startRun(taskId: string) {
    const r = backend.startRun(taskId);
    if (r.ok) {
      store.update((d) => { d.selectedRunId = undefined; });
      feedback({ tone: 'running', title: '开始运行', body: `${orchestratorName()} 正在制定计划。` });
    } else feedback({ tone: 'danger', title: '无法开始', body: r.error });
  },
  pauseRun(runId: string) {
    const r = backend.pauseRun(runId);
    if (r.ok) feedback({ tone: 'paused', title: '已暂停', body: '当前调用已中断，点「继续」会重新执行这一步。' });
    else feedback({ tone: 'warning', title: '无法暂停', body: r.error });
  },
  resumeRun(runId: string) {
    const r = backend.resumeRun(runId);
    if (r.ok) feedback({ tone: 'running', title: '已继续', body: runOf(runId)?.status === 'awaiting' ? '还有待确认的操作，处理后才会往下执行。' : '从暂停处继续执行。' });
    else feedback({ tone: 'danger', title: '无法继续', body: r.error });
  },
  requestCancel(runId: string) {
    if (store.get().settings.confirmBeforeCancel) store.update((d) => { d.dialog = { kind: 'cancel-run', runId }; });
    else actions.cancelRun(runId);
  },
  cancelRun(runId: string) {
    const r = backend.cancelRun(runId);
    if (r.ok) feedback({ tone: 'neutral', title: '已取消运行', body: '未完成的步骤已停止，已生成的产物仍然保留。' });
    else feedback({ tone: 'warning', title: '无法取消', body: r.error });
  },
  retryRun(runId: string, mode: 'resume' | 'restart' = 'resume') {
    const prev = runOf(runId);
    const r = backend.retryRun(runId, mode);
    if (r.ok) {
      store.update((d) => { d.selectedRunId = undefined; if (prev) { d.view = 'task'; d.selectedTaskId = prev.taskId; } });
      // Describe the run that was actually created, not the one it replaces.
      const next = runOf(r.value);
      const cancelled = prev?.status === 'cancelled';
      const carried = next ? next.plan.filter((st) => st.carried).length : 0;
      if (mode === 'restart') {
        feedback({ tone: 'running', title: '已从头重新运行', body: '所有步骤会重新执行。' });
      } else if (!next?.planReady) {
        feedback({ tone: 'running', title: cancelled ? '已继续运行' : '已开始重试', body: '上次在计划完成前结束，会重新制定计划。' });
      } else {
        const at = next.plan.find((st) => !st.carried && st.status !== 'done');
        feedback({ tone: 'running', title: cancelled ? '已继续未完成的步骤' : '已开始重试',
          body: at
            ? `从第 ${at.index + 1} 步「${at.title}」继续${carried > 0 ? `，前 ${carried} 步沿用上次结果` : ''}。`
            : '前面的步骤都已完成，直接汇总。' });
      }
    } else feedback({ tone: 'danger', title: '无法重试', body: r.error });
  },
  decideApproval(approvalId: string, decision: 'approve' | 'reject') {
    const r = backend.decideApproval(approvalId, decision);
    if (!r.ok) return feedback({ tone: 'warning', title: '无法处理', body: r.error });
    if (decision === 'approve') feedback({ tone: 'success', title: '已批准', body: 'Agent 会执行这项操作。', ttl: 3000 });
    else feedback({ tone: 'neutral', title: '已拒绝', body: '这项操作不会执行，Agent 会换一种做法或向你说明。', ttl: 3500 });
  },
  sendMessage(taskId: string, text: string) {
    const r = backend.sendMessage(taskId, text.trim());
    if (!r.ok) feedback({ tone: 'danger', title: '发送失败', body: r.error });
  },

  /* ── agents and tools ── */
  setToolPermission(toolId: ToolId, permission: ToolPermission) {
    store.update((d) => {
      const tool = d.tools.find((t) => t.id === toolId);
      if (tool) tool.permission = permission;
    });
    const tool = store.get().tools.find((t) => t.id === toolId);
    feedback({ tone: 'info', title: '工具策略已更新', body: `「${tool?.name}」：${permission === 'auto' ? '自动执行' : permission === 'confirm' ? '需要确认' : '已禁用'}，从下一次调用开始生效。` });
  },
  setAgentEnabled(agentId: AgentId, enabled: boolean) {
    if (agentId === 'orchestrator' && !enabled) return feedback({ tone: 'warning', title: '编排 Agent 不能停用', body: '它负责拆解目标和分派步骤。' });
    store.update((d) => { const a = d.agents.find((x) => x.id === agentId); if (a) a.enabled = enabled; });
    const agent = store.get().agents.find((a) => a.id === agentId);
    feedback({ tone: 'info', title: enabled ? 'Agent 已启用' : 'Agent 已停用', body: enabled ? `新任务可以选择「${agent?.name}」。` : `新任务中它的步骤会交给编排 Agent。` });
  },
  /** Give an agent its own model, or (undefined) let it follow the task's. The 编排 Agent always follows the task. */
  setAgentEngine(agentId: AgentId, engine: AgentEngine | undefined) {
    if (agentId === 'orchestrator') return feedback({ tone: 'info', title: '编排 Agent 用任务的模型', body: '它负责拆解和汇总，跟着任务选的模型走。' });
    store.update((d) => { const a = d.agents.find((x) => x.id === agentId); if (a) a.engine = engine; });
  },
  /** Tools an agent may use when its steps run on a command-line agent. */
  setAgentTools(agentId: AgentId, tools: ToolId[]) {
    store.update((d) => {
      const a = d.agents.find((x) => x.id === agentId);
      if (a) a.tools = d.tools.map((t) => t.id).filter((id) => tools.includes(id));
    });
  },

  /* ── settings ── */
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    store.update((d) => {
      d.settings[key] = value;
      if (key === 'mode' || key === 'persona') syncPersonaAgent(d);
    });
  },
  /** Delete every task, run and event; settings, model access, agents and tool policies stay. */
  clearHistory() {
    const count = store.get().taskOrder.length;
    for (const id of Object.keys(store.get().tasks)) forgetTask(id);
    store.update((d) => {
      d.tasks = {};
      d.taskOrder = [];
      d.runs = {};
      d.events = [];
      d.selectedTaskId = undefined;
      d.selectedRunId = undefined;
      d.celebration = undefined;
      d.console.focusId = undefined;
      d.focusRequest = undefined;
      // What is left would point at tasks and runs that no longer exist.
      d.toasts = d.toasts.filter((t) => !t.action || t.action.command.type === 'navigate');
      if (d.view === 'task') d.view = 'tasks';
    });
    feedback({ tone: 'neutral', title: '任务记录已清除', body: `${count} 个任务及其运行记录已移除，设置、模型接入、Agent 和工具策略都还在。` });
  },

  /* ── console ── */
  toggleConsole(open?: boolean) {
    store.update((d) => { d.console.open = open ?? !d.console.open; });
  },
  openConsole(tab: ConsoleTab, focusId?: string) {
    store.update((d) => { d.console.open = true; d.console.tab = tab; d.console.focusId = focusId; });
  },
  setConsoleTab(tab: ConsoleTab) {
    store.update((d) => { d.console.tab = tab; });
  },
  setConsoleHeight(height: number) {
    store.update((d) => { d.console.height = Math.round(Math.min(Math.max(height, 160), window.innerHeight * 0.7)); });
  },

  /* ── toasts, dialogs, celebration ── */
  toast(t: ToastInput, spoken?: string) { feedback(t, spoken); },
  dismissToast(id: string) {
    store.update((d) => { d.toasts = d.toasts.filter((t) => t.id !== id); });
  },
  openDialog(dialog: Dialog) {
    store.update((d) => { d.dialog = dialog; });
  },
  closeDialog() {
    store.update((d) => { d.dialog = undefined; });
  },
  confirmDialog() {
    const dialog = store.get().dialog;
    store.update((d) => { d.dialog = undefined; });
    if (!dialog) return;
    if (dialog.kind === 'cancel-run') actions.cancelRun(dialog.runId);
    else if (dialog.kind === 'delete-task') actions.deleteTask(dialog.taskId);
    else if (dialog.kind === 'clear-history') actions.clearHistory();
  },
  clearCelebration() {
    store.update((d) => { d.celebration = undefined; });
  },

  /** Run a command carried by a toast or link. */
  run(cmd: UiCommand) {
    switch (cmd.type) {
      case 'open-task': return actions.openTask(cmd.taskId, cmd.runId, cmd.tab);
      case 'open-console':
        // Show the run the command is about, not whichever one the console happened to be following.
        if (cmd.taskId) actions.openTask(cmd.taskId, cmd.runId);
        return actions.openConsole(cmd.tab, cmd.focusId);
      case 'resume-run': {
        // A stale toast (the run was already resumed or cancelled) does nothing instead of raising an error.
        if (runOf(cmd.runId)?.status !== 'paused') return;
        const task = taskOfRun(cmd.runId);
        if (task) actions.openTask(task.id, cmd.runId);
        return actions.resumeRun(cmd.runId);
      }
      case 'retry-run': return actions.retryRun(cmd.runId, cmd.mode);
      case 'show-approvals': return actions.requestFocus('approvals');
      case 'navigate': return actions.navigate(cmd.view);
    }
  },
};
