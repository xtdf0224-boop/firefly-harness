/* Headless check of the simulator state machine: npm run check:engine
   Plays runs to the end through the same functions the UI uses and asserts the outcomes. */
import { produce, type Draft } from 'immer';
import type { AppState } from '../src/lib/types';
import * as engine from '../src/state/engine';
import { seededState } from '../src/state/seed';
import { stepProgress } from '../src/state/selectors';

let failures = 0;
function expect(label: string, cond: boolean, extra = '') {
  console.log(`${cond ? '  ok ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

let s: AppState = seededState(Date.now());
let now = Date.now();
const upd = (fn: (d: Draft<AppState>) => void) => { s = produce(s, fn); };
const runsOf = (taskId: string) => s.tasks[taskId].runIds.map((id) => s.runs[id]);
const last = (taskId: string) => runsOf(taskId).at(-1)!;

/** Tick until the run leaves 'running', answering approvals with `decide`. */
function play(taskId: string, decide: (title: string) => 'approve' | 'reject' = () => 'approve', maxMs = 300_000, humanMs = 0) {
  for (let t = 0; t < maxMs; t += 200) {
    now += 200;
    upd((d) => engine.tick(d, now, 200));
    const run = last(taskId);
    if (run.status === 'awaiting') {
      const a = run.approvals.find((x) => x.status === 'pending')!;
      now += humanMs;
      upd((d) => { engine.decideApproval(d, a.id, decide(a.title), now); });
    } else if (run.status !== 'running') return run;
  }
  return last(taskId);
}

console.log('Sample history');
const order = s.taskOrder.map((id) => s.tasks[id]);
for (const t of order) console.log(`  · ${t.title}: ${runsOf(t.id).map((r) => `${r.status} [${r.plan.map((p) => p.status[0]).join('')}]`).join(', ')}`);
const refactor = order.find((t) => t.scenarioId === 'refactor')!;
const research = order.find((t) => t.scenarioId === 'research')!;
const report = order.find((t) => t.scenarioId === 'report')!;
expect('refactor sample failed at 运行测试', last(refactor.id).status === 'failed' && s.runs[last(refactor.id).id].plan[3].status === 'failed');
expect('research sample completed', last(research.id).status === 'completed' && last(research.id).artifacts.length === 2);
expect('research shows a self-healed 429', last(research.id).toolCalls.some((c) => c.error?.code === 'HTTP_429'));
expect('report sample cancelled', last(report.id).status === 'cancelled');
expect('sample produced no toasts', s.toasts.length === 0, String(s.toasts.length));

console.log('Retry failed refactor (resume)');
const failedId = last(refactor.id).id;
upd((d) => { engine.startTaskRun(d, refactor.id, now, { retryOf: failedId, mode: 'resume' }); });
let r = last(refactor.id);
expect('retry is attempt 2 starting at step 4', r.attempt === 2 && r.cursor.step === 3 && r.plan.slice(0, 3).every((p) => p.carried));
expect('carried artifacts copied', r.artifacts.length === 2, r.artifacts.map((a) => a.name).join(','));
r = play(refactor.id);
expect('retry completed', r.status === 'completed', r.status);
expect('fix beat ran (2 approvals in step 4)', r.approvals.length === 2, String(r.approvals.length));
expect('final artifacts = 3', r.artifacts.length === 3, r.artifacts.map((a) => a.name).join(','));
expect('celebration set', s.celebration?.runId === r.id);

console.log('New refactor task: reject the write');
const newTask = (scenarioId: 'refactor' | 'general' | 'research', goal = '测试目标') => {
  const id = `task_t${Math.round(now)}`;
  upd((d) => { d.tasks[id] = { id, title: goal, goal, createdAt: now, updatedAt: now, scenarioId, agentIds: ['orchestrator', 'coder', 'reviewer', 'researcher'], runIds: [], messages: [], source: 'simulated' }; d.taskOrder.unshift(id); });
  upd((d) => { engine.startTaskRun(d, id, now); });
  now += 1;
  return id;
};
let id = newTask('refactor');
r = play(id, (title) => (title.startsWith('写入') ? 'reject' : 'approve'));
expect('run still fails at tests (inject on)', r.status === 'failed', r.status);
expect('step 3 skipped after rejection', r.plan[2].status === 'skipped' && !!r.plan[2].note);
const failedRunId = r.id;
const failToast = s.toasts.find((t) => t.key === `run:${failedRunId}`);
expect('failure toast carries task + run for 查看错误', failToast?.action?.command.type === 'open-console'
  && failToast.action.command.taskId === id && failToast.action.command.runId === failedRunId);
const stderrLines = r.terminal.filter((l) => l.stream === 'stderr');
const passLines = r.terminal.filter((l) => l.text.includes('✓'));
expect('failed test output: only failing lines are stderr', stderrLines.length > 0 && stderrLines.every((l) => /[✗×]/.test(l.text)) && passLines.every((l) => l.stream === 'stdout'),
  `${stderrLines.length} stderr`);
expect('task.updatedAt follows the run end', s.tasks[id].updatedAt === r.endedAt, `${s.tasks[id].updatedAt} vs ${r.endedAt}`);
expect('skipped step reported apart from done', (() => { const p = stepProgress(r); return p.skipped === 1 && p.done === 2 && p.finished === 3; })());

console.log('Injection off → clean pass');
upd((d) => { d.settings.injectFailure = false; });
id = newTask('refactor');
r = play(id);
expect('completed without failure', r.status === 'completed', r.status);
const summaryOf = (run: typeof r) => s.tasks[run.taskId].messages.filter((m) => m.runId === run.id && m.kind === 'summary').at(-1)?.text ?? '';
expect('clean run keeps the success summary', summaryOf(r).includes('9 项单元测试全部通过'));
expect('clean run: no skipped steps', stepProgress(r).skipped === 0 && stepProgress(r).done === 5);

console.log('Reject the write (no injected failure) → honest summary');
id = newTask('refactor');
r = play(id, (title) => (title.startsWith('写入') ? 'reject' : 'approve'));
expect('completed with the write step skipped', r.status === 'completed' && r.plan[2].status === 'skipped', `${r.status} ${r.plan[2].status}`);
expect('summary names the skipped step', summaryOf(r).includes('被跳过') && summaryOf(r).includes('修改代码'), summaryOf(r));
expect('summary does not claim passing tests', !summaryOf(r).includes('全部通过'));
expect('no diff artifact exists, and the summary does not point to one', !r.artifacts.some((a) => a.name === 'login.ts.diff') && !summaryOf(r).includes('都在「产物」里'));
const changelog = r.artifacts.find((a) => a.name === '变更说明.md')?.content ?? '';
expect('changelog says nothing was written', changelog.includes('没有写入任何代码改动') && !changelog.includes('src/auth/rateLimit.ts | 新增') && !changelog.includes('全部通过'));
expect('completion toast says steps were skipped', s.toasts.some((t) => t.title === '任务完成' && t.body?.includes('被跳过')));
expect('progress: 4 done, 1 skipped', (() => { const p = stepProgress(r); return p.done === 4 && p.skipped === 1 && p.total === 5; })());

console.log('Step time excludes waiting for approval');
id = newTask('general', '统计步骤用时');
r = play(id, () => 'approve', 300_000, 30_000);
const writeStep = r.plan[2];
expect('run completed', r.status === 'completed', r.status);
expect('wall time of the approval step includes the wait', (writeStep.endedAt! - writeStep.startedAt!) >= 30_000);
expect('active time of the step does not', (writeStep.activeMs ?? 0) > 0 && (writeStep.activeMs ?? 0) < 10_000, String(writeStep.activeMs));
expect('step active times add up to no more than the run', r.plan.reduce((n, p) => n + (p.activeMs ?? 0), 0) <= r.activeMs + 1);
expect('updatedAt follows approval + completion', s.tasks[id].updatedAt === r.endedAt);

console.log('Disconnect / reconnect');
id = newTask('general', '整理一下文档结构');
for (let i = 0; i < 20; i++) { now += 200; upd((d) => engine.tick(d, now, 200)); }
upd((d) => { engine.disconnect(d, engine.GATEWAY_ID, now); });
r = last(id);
expect('run paused by disconnect', r.status === 'paused' && r.pauseReason === 'disconnected', `${r.status}/${r.pauseReason}`);
let resumeErr: string | undefined;
upd((d) => { resumeErr = engine.resumeRun(d, d.runs[r.id], now); });
expect('resume refused while disconnected', !!resumeErr, resumeErr);
for (let i = 0; i < 70; i++) { now += 200; upd((d) => engine.tick(d, now, 200)); }
expect('gateway back after auto reconnect', s.connections.find((c) => c.id === engine.GATEWAY_ID)!.status === 'connected');
expect('run still paused after reconnect', last(id).status === 'paused');
expect('reconnect toast offers 继续运行', s.toasts.some((t) => t.key === `conn:${engine.GATEWAY_ID}` && t.action?.command.type === 'resume-run'));
upd((d) => { resumeErr = engine.resumeRun(d, d.runs[r.id], now); });
expect('resume works after reconnect', !resumeErr && ['running', 'awaiting'].includes(last(id).status), last(id).status);
expect('stale reconnect toast is gone after resume', !s.toasts.some((t) => t.key === `conn:${engine.GATEWAY_ID}`));
r = play(id);
expect('general run completed', r.status === 'completed', r.status);

console.log('Tool disabled → step skipped');
upd((d) => { d.tools.find((t) => t.id === 'shell')!.permission = 'off'; });
id = newTask('refactor');
r = play(id);
expect('completed with test step skipped', r.status === 'completed' && r.plan[3].status === 'skipped', `${r.status} ${r.plan[3].status}`);
upd((d) => { d.tools.find((t) => t.id === 'shell')!.permission = 'confirm'; });

console.log('Reject while paused');
upd((d) => { d.tools.find((t) => t.id === 'write_file')!.permission = 'confirm'; });
id = newTask('general', '暂停时拒绝');
for (let i = 0; i < 200 && last(id).status === 'running'; i++) { now += 200; upd((d) => engine.tick(d, now, 200)); }
expect('awaiting the write approval', last(id).status === 'awaiting', last(id).status);
upd((d) => { engine.pauseRun(d, d.runs[last(id).id], 'user', now); });
upd((d) => { engine.decideApproval(d, last(id).approvals[0].id, 'reject', now); });
expect('rejected while paused: still paused, live text updated', last(id).status === 'paused' && last(id).live?.text.startsWith('已跳过') === true, `${last(id).status} / ${last(id).live?.text}`);
upd((d) => { engine.resumeRun(d, d.runs[last(id).id], now); });
r = play(id);
expect('run completes after resume', r.status === 'completed' && r.plan[2].status === 'skipped', `${r.status} ${r.plan[2].status}`);

console.log('Web tools disabled → research is marked');
upd((d) => { d.tools.find((t) => t.id === 'web_search')!.permission = 'off'; });
id = newTask('research');
r = play(id);
expect('research completed with the search step skipped', r.status === 'completed' && r.plan[1].status === 'skipped', `${r.status} ${r.plan[1].status}`);
expect('research summary says nothing was found', summaryOf(r).includes('没有检索到任何资料'), summaryOf(r));
expect('research report carries the skip notice', (r.artifacts.find((a) => a.name === '向量数据库选型报告.md')?.content ?? '').includes('> 注意：本次运行有 1 步被跳过'));
upd((d) => { d.tools.find((t) => t.id === 'web_search')!.permission = 'auto'; });

console.log('Pause, cancel');
id = newTask('general', '暂停测试');
for (let i = 0; i < 15; i++) { now += 200; upd((d) => engine.tick(d, now, 200)); }
upd((d) => { engine.pauseRun(d, d.runs[last(id).id], 'user', now); });
const before = last(id).cursor.beatElapsed;
for (let i = 0; i < 15; i++) { now += 200; upd((d) => engine.tick(d, now, 200)); }
expect('paused run does not advance', last(id).cursor.beatElapsed === before && last(id).status === 'paused');
upd((d) => { engine.cancelRun(d, d.runs[last(id).id], now); });
r = last(id);
expect('cancelled: no pending/running steps left', r.status === 'cancelled' && r.plan.every((p) => !['pending', 'running', 'awaiting'].includes(p.status)));
expect('restart after cancel works', (() => { upd((d) => { engine.startTaskRun(d, id, now, { retryOf: r.id, mode: 'restart' }); }); return last(id).attempt === 2 && last(id).cursor.phase === 'planning'; })());

console.log('Cancel during planning, then resume');
id = newTask('general', '规划阶段取消');
upd((d) => { engine.cancelRun(d, d.runs[last(id).id], now); });
upd((d) => { engine.startTaskRun(d, id, now, { retryOf: last(id).id, mode: 'resume' }); });
const planningRetry = s.tasks[id].messages.filter((m) => m.role === 'system').at(-1)?.text ?? '';
expect('retry before a plan existed does not claim reused steps', !last(id).planReady && planningRetry.includes('重新制定计划') && !planningRetry.includes('沿用'), planningRetry);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
