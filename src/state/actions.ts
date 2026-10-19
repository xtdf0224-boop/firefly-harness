/* Everything a component can do. Each run control goes through `backend` and then gives visible
   feedback (toast + screen-reader announcement), whether it succeeded or not. */
import type {
  AgentId, ConsoleTab, Dialog, ScenarioId, Settings, Task, ToolId, ToolPermission, Toast, UiCommand, ViewId, WorkspaceTab,
} from '../lib/types';
import { backend } from './backend';
import { announce, dropToasts, findApproval, pushEvent, toast as pushToast } from './engine';
import { seededState } from './seed';
import { store, uid } from './store';

type ToastInput = Omit<Toast, 'id' | 'createdAt' | 'ttl'> & { ttl?: number };

function feedback(t: ToastInput, spoken?: string) {
  store.update((d) => {
    pushToast(d, t);
    announce(d, spoken ?? `${t.title}${t.body ? `：${t.body}` : ''}`);
  });
}

const runOf = (runId: string) => store.get().runs[runId];
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
  createTask(input: { title: string; goal: string; scenarioId: ScenarioId; agentIds: AgentId[]; start: boolean }): string {
    const id = uid('task');
    const now = Date.now();
    store.update((d) => {
      const task: Task = {
        id, title: input.title.trim() || '未命名任务', goal: input.goal.trim(), createdAt: now, updatedAt: now,
        scenarioId: input.scenarioId, agentIds: input.agentIds.length ? input.agentIds : ['orchestrator'], runIds: [],
        messages: [{ id: uid('msg'), role: 'user', text: input.goal.trim(), at: now, simulated: false }], source: 'simulated',
      };
      d.tasks[id] = task;
      d.taskOrder.unshift(id);
      d.view = 'task';
      d.selectedTaskId = id;
      d.selectedRunId = undefined;
      d.workspaceTab = 'conversation';
      pushEvent(d, { kind: 'user', level: 'info', text: `新建任务：${task.title}` });
    });
    if (input.start) {
      const r = backend.startRun(id);
      if (r.ok) feedback({ tone: 'running', title: '任务已创建并开始运行', body: '演示模式：由本地模拟器执行。' });
      else feedback({ tone: 'warning', title: '任务已创建，但还没开始', body: r.error });
    } else {
      feedback({ tone: 'info', title: '任务已创建', body: '准备好后点「开始」。' });
    }
    return id;
  },
  requestDeleteTask(taskId: string) {
    store.update((d) => { d.dialog = { kind: 'delete-task', taskId }; });
  },
  deleteTask(taskId: string) {
    const task = store.get().tasks[taskId];
    if (!task) return;
    store.update((d) => {
      const gone = new Set(task.runIds);
      // Toasts about this task (approval, failure, completion, reconnect) would be left with dead actions.
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
      feedback({ tone: 'running', title: '开始运行', body: '编排 Agent 正在制定计划。（模拟）' });
    } else feedback({ tone: 'danger', title: '无法开始', body: r.error });
  },
  pauseRun(runId: string) {
    const r = backend.pauseRun(runId);
    if (r.ok) feedback({ tone: 'paused', title: '已暂停', body: '当前步骤停在原处，点「继续」即可恢复。（模拟运行）' });
    else feedback({ tone: 'warning', title: '无法暂停', body: r.error });
  },
  resumeRun(runId: string) {
    const r = backend.resumeRun(runId);
    if (r.ok) feedback({ tone: 'running', title: '已继续', body: runOf(runId)?.status === 'awaiting' ? '还有待确认的操作，处理后才会往下执行。（模拟运行）' : '从暂停处继续执行。（模拟运行）' });
    else feedback({ tone: 'danger', title: '无法继续', body: r.error });
  },
  requestCancel(runId: string) {
    if (store.get().settings.confirmBeforeCancel) store.update((d) => { d.dialog = { kind: 'cancel-run', runId }; });
    else actions.cancelRun(runId);
  },
  cancelRun(runId: string) {
    const r = backend.cancelRun(runId);
    if (r.ok) feedback({ tone: 'neutral', title: '已取消运行', body: '未完成的步骤已停止，已生成的产物仍然保留。（模拟运行）' });
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
      const resumeAt = next?.planReady ? next.plan[next.cursor.step] : undefined;
      const carried = next ? next.plan.filter((st) => st.carried).length : 0;
      if (mode === 'restart') {
        feedback({ tone: 'running', title: '已从头重新运行', body: '所有步骤会重新执行。（模拟运行）' });
      } else if (!next?.planReady) {
        feedback({ tone: 'running', title: cancelled ? '已继续运行' : '已开始重试', body: '上次在计划完成前结束，会重新制定计划。（模拟运行）' });
      } else {
        feedback({ tone: 'running', title: cancelled ? '已继续未完成的步骤' : '已开始重试',
          body: resumeAt
            ? `从第 ${resumeAt.index + 1} 步「${resumeAt.title}」继续${carried > 0 ? `，前 ${carried} 步沿用上次结果` : ''}。（模拟运行）`
            : '前面的步骤都已完成，直接汇总。（模拟运行）' });
      }
    } else feedback({ tone: 'danger', title: '无法重试', body: r.error });
  },
  decideApproval(approvalId: string, decision: 'approve' | 'reject') {
    const owner = findApproval(store.get(), approvalId)?.run;
    const r = backend.decideApproval(approvalId, decision);
    if (!r.ok) return feedback({ tone: 'warning', title: '无法处理', body: r.error });
    // A decision can be recorded while the run is paused; nothing runs until it is resumed.
    const after = owner ? runOf(owner.id) : undefined;
    const paused = after?.status === 'paused';
    const resumeHint = paused
      ? (after.pauseReason === 'disconnected' ? '连接恢复后点「继续」' : '点「继续」')
      : '';
    if (decision === 'approve') {
      feedback(paused
        ? { tone: 'info', title: '已记录批准', body: `运行仍处于暂停，${resumeHint}后才会执行。（模拟运行）`, ttl: 5000 }
        : { tone: 'success', title: '已批准', body: '模拟器继续往下执行，不会真的写文件或运行命令。', ttl: 3000 });
    } else {
      feedback({ tone: 'neutral', title: '已拒绝',
        body: paused ? `这项操作不会执行（模拟），对应步骤已跳过；运行仍处于暂停，${resumeHint}后继续后面的步骤。` : '这项操作不会执行（模拟），对应步骤已跳过。',
        ttl: paused ? 5000 : 3500 });
    }
  },
  sendMessage(taskId: string, text: string) {
    const r = backend.sendMessage(taskId, text.trim());
    if (!r.ok) feedback({ tone: 'danger', title: '发送失败', body: r.error });
  },

  /* ── agents, tools, connections ── */
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
  setAgentModel(agentId: AgentId, model: string) {
    store.update((d) => { const a = d.agents.find((x) => x.id === agentId); if (a) a.model = model; });
  },
  simulateDisconnect(connectionId: string) {
    const r = backend.simulateDisconnect?.(connectionId);
    if (r && !r.ok) feedback({ tone: 'warning', title: '无法模拟断开', body: r.error });
  },
  reconnect(connectionId: string) {
    backend.reconnect(connectionId);
    const c = store.get().connections.find((x) => x.id === connectionId);
    if (c) store.update((d) => announce(d, `正在重连${c.name}（模拟）`));
  },

  /* ── settings ── */
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    store.update((d) => { d.settings[key] = value; });
  },
  resetDemo() {
    const s = store.get();
    // Only tasks and runs are reset: the user stays on the page they pressed the button on, and keeps
    // their settings, tool policies, agent settings and layout. The selected task no longer exists.
    store.replace({
      ...seededState(Date.now(), s.settings),
      view: s.view === 'task' ? 'tasks' : s.view,
      tools: s.tools,
      agents: s.agents,
      console: s.console,
      navCollapsed: s.navCollapsed,
      statusDrawerOpen: s.statusDrawerOpen,
    });
    feedback({ tone: 'info', title: '演示数据已重置', body: '已恢复 3 个示例任务。' });
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
    else if (dialog.kind === 'reset-demo') actions.resetDemo();
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
      case 'reconnect': return actions.reconnect(cmd.connectionId);
    }
  },
};
