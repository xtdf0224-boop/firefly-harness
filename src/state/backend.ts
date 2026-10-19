/* The seam between the UI and whatever executes agents.
   The UI only talks to `backend` through these methods and renders whatever lands in the store.
   This file ships the mock implementation, driven by the in-browser simulator (engine.ts).
   A real harness would implement the same interface over its API, and write server events into
   the store with the same shapes (Run, ToolCall, Approval…) — see README「接入真实后端」. */
import * as engine from './engine';
import * as live from './live';
import { store } from './store';

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

export interface HarnessBackend {
  /** 'mock' renders the 演示模式 badges everywhere. */
  readonly kind: 'mock' | 'live';
  startRun(taskId: string): Result<string>;
  pauseRun(runId: string): Result;
  resumeRun(runId: string): Result;
  cancelRun(runId: string): Result;
  retryRun(runId: string, mode: 'resume' | 'restart'): Result<string>;
  decideApproval(approvalId: string, decision: 'approve' | 'reject'): Result;
  sendMessage(taskId: string, text: string): Result;
  reconnect(connectionId: string): Result;
  /** Demo-only: make a connection drop. A live backend reports drops instead. */
  simulateDisconnect?(connectionId: string): Result;
}

function openRunOf(taskId: string) {
  const s = store.get();
  return s.tasks[taskId]?.runIds.map((id) => s.runs[id]).find((r) => r && ['queued', 'running', 'paused', 'awaiting'].includes(r.status));
}

export const mockBackend: HarnessBackend = {
  kind: 'mock',

  startRun(taskId) {
    if (!store.get().tasks[taskId]) return fail('找不到这个任务。');
    if (openRunOf(taskId)) return fail('这个任务已有进行中的运行。');
    if (!engine.gatewayUp(store.get())) return fail('模型网关未连接，恢复连接后才能开始。');
    let id = '';
    store.update((d) => { id = engine.startTaskRun(d, taskId, Date.now()).id; });
    return ok(id);
  },

  pauseRun(runId) {
    let done = false;
    store.update((d) => { const r = d.runs[runId]; if (r) done = engine.pauseRun(d, r, 'user', Date.now()); });
    return done ? ok(undefined) : fail('只有运行中或等待确认的任务可以暂停。');
  },

  resumeRun(runId) {
    let error: string | undefined = '找不到这个运行。';
    store.update((d) => { const r = d.runs[runId]; if (r) error = engine.resumeRun(d, r, Date.now()); });
    return error ? fail(error) : ok(undefined);
  },

  cancelRun(runId) {
    let done = false;
    store.update((d) => { const r = d.runs[runId]; if (r) done = engine.cancelRun(d, r, Date.now()); });
    return done ? ok(undefined) : fail('这个运行已经结束。');
  },

  retryRun(runId, mode) {
    const prev = store.get().runs[runId];
    if (!prev) return fail('找不到这个运行。');
    if (openRunOf(prev.taskId)) return fail('这个任务已有进行中的运行。');
    if (!engine.gatewayUp(store.get())) return fail('模型网关未连接，恢复连接后才能重试。');
    let id = '';
    store.update((d) => { id = engine.startTaskRun(d, prev.taskId, Date.now(), { retryOf: runId, mode }).id; });
    return ok(id);
  },

  decideApproval(approvalId, decision) {
    let found = false;
    store.update((d) => { found = !!engine.decideApproval(d, approvalId, decision, Date.now()); });
    return found ? ok(undefined) : fail('这项确认已经处理过或已失效。');
  },

  sendMessage(taskId, text) {
    const task = store.get().tasks[taskId];
    if (!task) return fail('找不到这个任务。');
    const runId = task.runIds[task.runIds.length - 1];
    store.update((d) => {
      d.tasks[taskId].messages.push({ id: `msg_${Date.now().toString(36)}u`, role: 'user', runId, text, at: Date.now(), simulated: false });
      engine.pushEvent(d, { runId, kind: 'user', level: 'info', text: `你发送了补充说明` });
      engine.touch(d, taskId, Date.now());
    });
    // Canned reply: the simulator cannot understand the message, and says so.
    window.setTimeout(() => {
      store.update((d) => {
        const t = d.tasks[taskId];
        if (!t) return;
        const live = openRunOf(taskId);
        const quoted = text.length > 30 ? `${text.slice(0, 30)}…` : text;
        t.messages.push({
          id: `msg_${Date.now().toString(36)}r`, role: 'agent', agentId: 'orchestrator', runId, kind: 'reply', at: Date.now(), simulated: true,
          text: live
            ? `（模拟回复）收到「${quoted}」。演示模式不会真正理解这条补充；接入真实后端后，它会进入编排 Agent 的上下文，并从下一步开始生效。`
            : `（模拟回复）收到「${quoted}」。当前没有进行中的运行；演示模式不会理解这条说明，再次运行仍会执行同一段模拟脚本，接入真实后端后它才会影响运行。`,
        });
        engine.touch(d, taskId, Date.now());
      });
    }, 1100);
    return ok(undefined);
  },

  reconnect(connectionId) {
    store.update((d) => engine.reconnect(d, connectionId, Date.now()));
    return ok(undefined);
  },

  simulateDisconnect(connectionId) {
    store.update((d) => { engine.disconnect(d, connectionId, Date.now()); });
    return ok(undefined);
  },
};

/* Routes each call by the task's engine: tasks with a connected model go to live.ts, everything else
   (sample history, 演示模式 tasks) stays with the simulator. */
const taskOfRun = (runId: string) => store.get().tasks[store.get().runs[runId]?.taskId ?? ''];
const isLive = (task?: { engine?: unknown }) => !!task?.engine;

export const backend: HarnessBackend = {
  kind: 'live',
  startRun(taskId) {
    const task = store.get().tasks[taskId];
    return isLive(task) ? live.startLiveRun(taskId) : mockBackend.startRun(taskId);
  },
  pauseRun(runId) {
    return isLive(taskOfRun(runId)) && store.get().runs[runId]?.source === 'live' ? live.pauseLive(runId) : mockBackend.pauseRun(runId);
  },
  resumeRun(runId) {
    return isLive(taskOfRun(runId)) && store.get().runs[runId]?.source === 'live' ? live.resumeLive(runId) : mockBackend.resumeRun(runId);
  },
  cancelRun(runId) {
    if (store.get().runs[runId]?.source === 'live') live.cancelLive(runId);
    // Marking the run, its steps, calls and approvals as cancelled is the same for both.
    let done = false;
    store.update((d) => { const r = d.runs[runId]; if (r) done = engine.cancelRun(d, r, Date.now()); });
    return done ? ok(undefined) : fail('这个运行已经结束。');
  },
  retryRun(runId, mode) {
    const task = taskOfRun(runId);
    return isLive(task) ? live.startLiveRun(task.id, { retryOf: runId, mode }) : mockBackend.retryRun(runId, mode);
  },
  decideApproval(approvalId, decision) {
    const found = engine.findApproval(store.get(), approvalId);
    if (found?.run.source === 'live') return live.decideLive(approvalId, decision) ? ok(undefined) : fail('这项确认已经处理过或已失效。');
    return mockBackend.decideApproval(approvalId, decision);
  },
  sendMessage(taskId, text) {
    const task = store.get().tasks[taskId];
    if (!task) return fail('找不到这个任务。');
    if (task.kind === 'chat') {
      store.update((d) => {
        d.tasks[taskId].messages.push({ id: `msg_${Date.now().toString(36)}u`, role: 'user', text, at: Date.now(), simulated: false });
        engine.touch(d, taskId, Date.now());
      });
      void live.reply(taskId);
      return ok(undefined);
    }
    return isLive(task) ? live.messageLive(taskId, text) : mockBackend.sendMessage(taskId, text);
  },
  reconnect: (id) => mockBackend.reconnect(id),
  simulateDisconnect: (id) => mockBackend.simulateDisconnect!(id),
};
