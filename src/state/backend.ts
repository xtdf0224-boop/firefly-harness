/* The seam between the UI and whatever executes agents.
   The UI only talks to `backend` through these methods and renders whatever lands in the store.
   Every call goes to live.ts, which drives the task's model (a command-line agent or an API)
   through the desktop bridge and writes what happens into the store as Run, ToolCall, Approval… */
import * as engine from './engine';
import * as live from './live';
import { store, uid } from './store';

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

export interface HarnessBackend {
  startRun(taskId: string): Result<string>;
  pauseRun(runId: string): Result;
  resumeRun(runId: string): Result;
  cancelRun(runId: string): Result;
  retryRun(runId: string, mode: 'resume' | 'restart'): Result<string>;
  decideApproval(approvalId: string, decision: 'approve' | 'reject'): Result;
  sendMessage(taskId: string, text: string): Result;
}

export const backend: HarnessBackend = {
  startRun: (taskId) => live.startLiveRun(taskId),
  pauseRun: (runId) => live.pauseLive(runId),
  resumeRun: (runId) => live.resumeLive(runId),

  cancelRun(runId) {
    if (!store.get().runs[runId]) return fail('找不到这个运行。');
    live.cancelLive(runId);
    // Marking the run, its steps, calls and approvals as cancelled does not depend on the model.
    let done = false;
    store.update((d) => { const r = d.runs[runId]; if (r) done = engine.cancelRun(d, r, Date.now()); });
    return done ? ok(undefined) : fail('这个运行已经结束。');
  },

  retryRun(runId, mode) {
    const taskId = store.get().runs[runId]?.taskId;
    if (!taskId) return fail('找不到这个运行。');
    return live.startLiveRun(taskId, { retryOf: runId, mode });
  },

  decideApproval(approvalId, decision) {
    return live.decideLive(approvalId, decision) ? ok(undefined) : fail('这项确认已经处理过或已失效。');
  },

  sendMessage(taskId, text) {
    const task = store.get().tasks[taskId];
    if (!task) return fail('找不到这个任务。');
    if (task.kind !== 'chat') return live.messageLive(taskId, text);
    store.update((d) => {
      d.tasks[taskId].messages.push({ id: uid('msg'), role: 'user', text, at: Date.now() });
      engine.touch(d, taskId, Date.now());
    });
    void live.reply(taskId);
    return ok(undefined);
  },
};
