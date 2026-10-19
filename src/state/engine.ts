/* ⚠ 模拟执行引擎 / SIMULATION ENGINE
   Plays the scripts in scenarios.ts against app state: plans, tool calls, approvals, failures,
   retries and connection drops. It never calls a model or runs a command. All functions take an
   immer draft so the same code powers live ticks, user actions and the pre-generated sample history. */
import type { Draft } from 'immer';
import type {
  AgentId, AppState, Approval, DataSource, Message, PlanStep, Run, RunEvent, Task, Toast, ToolCall, ToolDef,
} from '../lib/types';
import { duration, json } from '../lib/format';
import { completionLine, eventLine } from '../lib/persona';
import { beatsFor, getScenario, type Beat, type Scenario } from './scenarios';
import { uid } from './store';

type D = Draft<AppState>;
type DRun = Draft<Run>;
type DTask = Draft<Task>;
type DStep = Draft<PlanStep>;

export const TICK_MS = 200;
export const GATEWAY_ID = 'model-gateway';
/** Context window shown in the status panel: 1M, the usual size for this generation of models. */
export const CONTEXT_LIMIT = 1_000_000;
const EVENT_CAP = 600;
const TERMINAL_CAP = 800;
const RECONNECT_DELAY_MS = 10_000;
const RECONNECT_MS = 1_600;

/** While generating sample history nothing should toast, announce or celebrate. */
let quiet = false;

export const scenarioOf = (task: Pick<Task, 'scenarioId' | 'goal'>): Scenario => getScenario(task.scenarioId, task.goal);
const agentFor = (agent: AgentId, task: Pick<Task, 'agentIds'>): AgentId => (task.agentIds.includes(agent) ? agent : 'orchestrator');
const agentName = (d: D, id: AgentId) => d.agents.find((a) => a.id === id)?.name ?? id;
const toolDef = (d: D, id: ToolDef['id']) => d.tools.find((t) => t.id === id)!;
export const gatewayUp = (s: Pick<AppState, 'connections'>) => s.connections.find((c) => c.id === GATEWAY_ID)?.status !== 'disconnected'
  && s.connections.find((c) => c.id === GATEWAY_ID)?.status !== 'reconnecting';

/* ───────────────────────── feedback helpers ───────────────────────── */

export function pushEvent(d: D, e: Omit<RunEvent, 'id' | 'at'> & { at?: number }) {
  d.events.push({ id: uid('evt'), at: e.at ?? Date.now(), ...e });
  if (d.events.length > EVENT_CAP) d.events.splice(0, d.events.length - EVENT_CAP);
}

export function toast(d: D, t: Omit<Toast, 'id' | 'createdAt' | 'ttl'> & { ttl?: number }) {
  if (quiet) return;
  const ttl = t.ttl ?? (t.tone === 'danger' ? 9000 : t.tone === 'warning' ? 7000 : 4500);
  if (t.key) dropToasts(d, t.key);
  d.toasts.push({ id: uid('toast'), createdAt: Date.now(), ...t, ttl });
  if (d.toasts.length > 3) d.toasts.splice(0, d.toasts.length - 3);
}

/** Remove toasts whose subject has been dealt with. */
export function dropToasts(d: D, key: string) {
  if (d.toasts.some((x) => x.key === key)) d.toasts = d.toasts.filter((x) => x.key !== key);
}

export function announce(d: D, text: string) {
  if (quiet) return;
  d.announcement = { text, at: Date.now() };
}

function say(task: DTask, m: Omit<Message, 'id' | 'simulated'>) {
  task.messages.push({ id: uid('msg'), simulated: true, ...m });
}

function term(run: DRun, stream: 'cmd' | 'stdout' | 'stderr' | 'sys', text: string, at: number) {
  run.terminal.push({ id: uid('ln'), at, runId: run.id, stream, text });
  if (run.terminal.length > TERMINAL_CAP) run.terminal.splice(0, run.terminal.length - TERMINAL_CAP);
}

function addTokens(run: DRun, [input, output]: [number, number]) {
  const u = run.usage;
  u.inputTokens += input;
  u.outputTokens += output;
  u.cachedTokens += Math.round(input * 0.42);
  u.contextUsed = Math.min(u.contextLimit, u.contextUsed + Math.round(input * 0.32) + output);
  u.series.push(u.inputTokens + u.outputTokens);
  if (u.series.length > 120) u.series.splice(0, u.series.length - 120);
}

/** A task counts as updated whenever something visible happens to it (not on every tick). */
export function touch(d: D, taskId: string, now: number) {
  const task = d.tasks[taskId];
  if (task) task.updatedAt = now;
}

/** Real active time (excludes paused / awaiting): counted on the run and on the step it is working on. */
function addActive(run: DRun, dt: number) {
  run.activeMs += dt;
  if (run.cursor.phase !== 'executing') return;
  const step = run.plan[run.cursor.step];
  if (step && (step.status === 'running' || step.status === 'pending')) step.activeMs = (step.activeMs ?? 0) + dt;
}

function nextStep(run: DRun) {
  const c = run.cursor;
  c.step += 1;
  c.beat = 0;
  c.beatElapsed = 0;
  c.beatStarted = false;
}

/* ───────────────────────── run lifecycle ───────────────────────── */

/** Create a run for a task (not started). With `retryOf` + mode 'resume', finished steps carry over. */
export function newRun(d: D, taskId: string, now: number, opts: { retryOf?: string; mode?: 'resume' | 'restart'; source?: DataSource } = {}): DRun {
  const task = d.tasks[taskId];
  const sc = scenarioOf(task);
  const prev = opts.retryOf ? d.runs[opts.retryOf] : undefined;
  const plan: PlanStep[] = sc.steps.map((st, index) => ({
    id: uid('step'), index, title: st.title, detail: st.detail, agentId: agentFor(st.agent, task), status: 'pending', toolCallIds: [],
  }));
  const run: Run = {
    id: uid('run'), taskId, attempt: task.runIds.length + 1, status: 'queued', createdAt: now, activeMs: 0,
    plan, planReady: false, toolCalls: [], approvals: [], artifacts: [], errors: [], terminal: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextUsed: 0, contextLimit: CONTEXT_LIMIT, series: [] },
    cursor: { phase: 'planning', step: 0, beat: 0, beatElapsed: 0, beatStarted: false },
    source: opts.source ?? 'simulated',
  };
  if (prev) {
    run.retryOf = prev.id;
    run.retryMode = opts.mode ?? 'resume';
    if (prev.status === 'failed' && prev.failure) {
      const at = prev.plan.findIndex((s) => s.id === prev.failure!.stepId);
      if (at >= 0) run.fixStepIndex = at;
    }
    if (run.retryMode === 'resume' && prev.planReady) {
      run.planReady = true;
      run.cursor.phase = 'executing';
      const carried = new Map<string, string>();
      prev.plan.forEach((old, i) => {
        if (old.status !== 'done') return;
        Object.assign(plan[i], { status: 'done', carried: true, startedAt: old.startedAt, endedAt: old.endedAt, activeMs: old.activeMs, note: `沿用第 ${prev.attempt} 次运行的结果` });
        carried.set(old.id, plan[i].id);
      });
      run.cursor.step = Math.max(0, plan.findIndex((s) => s.status !== 'done'));
      if (plan.every((s) => s.status === 'done')) run.cursor.step = plan.length;
      for (const a of prev.artifacts) {
        const stepId = carried.get(a.stepId);
        if (stepId) run.artifacts.push({ ...a, id: uid('art'), runId: run.id, stepId });
      }
      run.usage.contextUsed = Math.round(prev.usage.contextUsed * 0.5);
    }
  }
  d.runs[run.id] = run;
  task.runIds.push(run.id);
  task.updatedAt = now;
  return d.runs[run.id];
}

export function beginRun(d: D, run: DRun, now: number) {
  const task = d.tasks[run.taskId];
  run.status = 'running';
  run.startedAt = now;
  run.live = { agentId: 'orchestrator', activity: 'thinking', text: run.planReady ? '准备继续执行' : '拆解目标、制定计划' };
  term(run, 'sys', `# 模拟终端 · 运行 #${run.attempt} —— 以下输出由演示脚本生成，没有执行任何真实命令`, now);
  const resumeAt = run.plan[run.cursor.step];
  const carried = run.plan.filter((st) => st.carried).length;
  const text = run.retryOf
    ? run.retryMode !== 'resume'
      ? `第 ${run.attempt} 次运行（模拟）：从头重新执行。`
      : !run.planReady
        ? `第 ${run.attempt} 次运行（模拟）：上次在计划完成前被取消，重新制定计划并开始执行。`
        : resumeAt
          ? `第 ${run.attempt} 次运行（模拟）：从第 ${resumeAt.index + 1} 步「${resumeAt.title}」继续${carried > 0 ? '，前面已完成的步骤沿用上次结果' : '，上次没有已完成的步骤可沿用'}。`
          : `第 ${run.attempt} 次运行（模拟）：上次的步骤都已完成，直接汇总。`
    : `开始运行（模拟）。`;
  say(task, { role: 'system', runId: run.id, text, at: now });
  pushEvent(d, { at: now, runId: run.id, kind: 'run', level: 'info', text: `运行 #${run.attempt} 开始：${task.title}` });
}

function finishPlanning(d: D, run: DRun, task: DTask, sc: Scenario, now: number) {
  run.planReady = true;
  run.cursor.phase = 'executing';
  run.cursor.beatElapsed = 0;
  addTokens(run, [2800, 520]);
  const v = d.settings.persona ? d.settings.mode : undefined;
  say(task, { role: 'agent', agentId: 'orchestrator', runId: run.id, kind: 'plan', at: now, persona: v,
    text: v ? `${eventLine(v, 'plan', d.settings.callName || '开拓者')}${sc.planIntro}` : sc.planIntro });
  pushEvent(d, { at: now, runId: run.id, kind: 'step', level: 'info', text: `计划已生成：共 ${run.plan.length} 步` });
}

function startStep(d: D, run: DRun, step: DStep, now: number) {
  step.status = 'running';
  step.startedAt = now;
  step.activeMs = step.activeMs ?? 0;
  step.note = undefined;
  pushEvent(d, { at: now, runId: run.id, kind: 'step', level: 'info', text: `开始第 ${step.index + 1} 步：${step.title}`, refId: step.id });
}

function finishStep(d: D, run: DRun, step: DStep, now: number) {
  step.status = 'done';
  step.endedAt = now;
  pushEvent(d, { at: now, runId: run.id, kind: 'step', level: 'success', text: `完成第 ${step.index + 1} 步：${step.title}`, refId: step.id });
}

/** The closing message of a run that skipped steps: says what was not done instead of the canned
 *  "everything passed" text, and only mentions artifacts that exist. */
function skippedSummary(run: DRun, sc: Scenario, skipped: DStep[]): string {
  const names = skipped.map((st) => `第 ${st.index + 1} 步「${st.title}」`).join('、');
  const effects = skipped.map((st) => sc.summarySkipped?.[st.index]).filter(Boolean).join('');
  const kept = run.artifacts.length ? '其余步骤的产物仍保留在「产物」里。' : '';
  return `运行已结束，但有 ${skipped.length} 步被跳过：${names}。被跳过的步骤没有执行，也就没有它们的结果。${effects || '其余步骤已按计划完成。'}${kept}`;
}

function completeRun(d: D, run: DRun, task: DTask, sc: Scenario, now: number) {
  const skipped = run.plan.filter((st) => st.status === 'skipped');
  run.status = 'completed';
  run.endedAt = now;
  run.cursor.phase = 'done';
  run.live = undefined;
  const v = d.settings.persona ? d.settings.mode : undefined;
  const closing = skipped.length ? skippedSummary(run, sc, skipped) : sc.summary;
  say(task, { role: 'agent', agentId: 'orchestrator', runId: run.id, kind: 'summary', at: now, persona: v,
    text: v && !skipped.length ? `${eventLine(v, 'done', d.settings.callName || '开拓者')}${closing}` : closing });
  pushEvent(d, { at: now, runId: run.id, kind: 'run', level: skipped.length ? 'warn' : 'success',
    text: `运行 #${run.attempt} ${skipped.length ? `已结束（${skipped.length} 步被跳过）` : '完成'}：${task.title}` });
  touch(d, task.id, now);
  // The title stays '任务完成': ToastHost keys the celebration on it.
  toast(d, { tone: 'success', title: '任务完成',
    body: skipped.length
      ? `「${task.title}」· 运行已结束，其中 ${skipped.length} 步被跳过，没有执行。（模拟运行）`
      : `${completionLine(d.settings.mode, task.title)}（模拟运行）`,
    action: { label: '查看产物', command: { type: 'open-task', taskId: task.id, runId: run.id, tab: 'artifacts' } } });
  announce(d, skipped.length
    ? `任务「${task.title}」已结束，${skipped.length} 步被跳过（模拟运行）`
    : `任务「${task.title}」已完成（模拟运行）`);
  if (!quiet) d.celebration = { runId: run.id, at: now };
}

function failRun(d: D, run: DRun, task: DTask, step: DStep, message: string, now: number) {
  step.status = 'failed';
  step.endedAt = now;
  step.note = message;
  run.status = 'failed';
  run.endedAt = now;
  run.cursor.phase = 'done';
  run.failure = { stepId: step.id, message };
  run.live = undefined;
  say(task, {
    role: 'agent', agentId: step.agentId, runId: run.id, kind: 'error', at: now,
    text: `第 ${step.index + 1} 步「${step.title}」失败：${message}。可以在控制台「错误」里查看详情；点「重试」后我会从这一步继续，前面已完成的步骤会沿用。`,
  });
  pushEvent(d, { at: now, runId: run.id, kind: 'run', level: 'error', text: `运行 #${run.attempt} 失败：第 ${step.index + 1} 步「${step.title}」`, refId: step.id });
  touch(d, task.id, now);
  toast(d, { tone: 'danger', title: '执行失败（模拟）', body: `第 ${step.index + 1} 步「${step.title}」：${message}`, key: `run:${run.id}`,
    action: { label: '查看错误', command: { type: 'open-console', tab: 'errors', taskId: task.id, runId: run.id } } });
  announce(d, `执行失败（模拟）：第 ${step.index + 1} 步 ${step.title}`);
  // Only open the console by itself when it is already following this run; otherwise it would show another run's errors.
  const following = d.view === 'task' && d.selectedTaskId === task.id && (!d.selectedRunId || d.selectedRunId === run.id);
  if (!quiet && d.settings.openConsoleOnError && following) { d.console.open = true; d.console.tab = 'errors'; }
}

/* ───────────────────────── beats ───────────────────────── */

type BeatStart = 'go' | 'wait' | 'skip';

function startBeat(d: D, run: DRun, task: DTask, step: DStep, beat: Beat, now: number): BeatStart {
  const agentId = agentFor(beat.agent, task);
  if (beat.t === 'think') {
    run.live = { agentId, activity: 'thinking', text: beat.activity };
    return 'go';
  }
  if (beat.t === 'artifact') return 'go';

  const def = toolDef(d, beat.tool);
  const call: ToolCall = {
    id: uid('call'), runId: run.id, stepId: step.id, agentId, tool: beat.tool, title: beat.title, input: beat.input,
    status: 'running', startedAt: now, expectedMs: beat.ms, simulated: true,
  };
  run.toolCalls.push(call);
  step.toolCallIds.push(call.id);
  pushEvent(d, { at: now, runId: run.id, kind: 'tool', level: 'info', text: `${agentName(d, agentId)} 调用「${def.name}」：${beat.title}`, refId: call.id });

  const live = run.toolCalls[run.toolCalls.length - 1];
  if (def.permission === 'off') {
    Object.assign(live, { status: 'denied', endedAt: now, durationMs: 0, output: `「${def.name}」已在「工具与连接」中禁用，调用没有执行。` });
    step.status = 'skipped';
    step.endedAt = now;
    step.note = `「${def.name}」已禁用，此步骤已跳过`;
    say(task, { role: 'agent', agentId, runId: run.id, kind: 'note', at: now,
      text: `「${def.name}」当前被禁用，我跳过了「${step.title}」。如需执行，可以在「工具与连接」里重新启用后再运行一次。` });
    pushEvent(d, { at: now, runId: run.id, kind: 'tool', level: 'warn', text: `「${def.name}」已禁用，跳过第 ${step.index + 1} 步`, refId: call.id });
    nextStep(run);
    return 'skip';
  }

  if (def.permission === 'confirm') {
    const spec = beat.approval ?? {
      title: beat.title,
      reason: `「${def.name}」的策略是调用前需要确认。`,
      preview: beat.tool === 'shell' ? `$ ${String(beat.input.command ?? '')}` : json(beat.input),
      previewKind: beat.tool === 'shell' ? 'command' as const : 'request' as const,
      risk: def.risk,
    };
    const approval: Approval = {
      id: uid('apr'), runId: run.id, taskId: task.id, stepId: step.id, toolCallId: call.id, agentId, tool: beat.tool,
      title: spec.title, reason: spec.reason, preview: spec.preview, previewKind: spec.previewKind, risk: spec.risk,
      status: 'pending', createdAt: now,
    };
    run.approvals.push(approval);
    live.status = 'awaiting';
    live.approvalId = approval.id;
    step.status = 'awaiting';
    run.status = 'awaiting';
    run.live = { agentId, activity: 'waiting', text: `等待确认：${spec.title}` };
    pushEvent(d, { at: now, runId: run.id, kind: 'approval', level: 'warn', text: `等待确认：${spec.title}`, refId: approval.id });
    toast(d, { tone: 'warning', title: '需要你的确认', body: `${agentName(d, agentId)} 请求：${spec.title}（模拟）`, key: `approval:${approval.id}`,
      action: { label: '去确认', command: { type: 'show-approvals' } } });
    announce(d, `需要确认（模拟）：${spec.title}`);
    return 'wait';
  }

  if (beat.approval) pushEvent(d, { at: now, runId: run.id, kind: 'approval', level: 'info', text: `按「自动执行」策略直接执行：${beat.approval.title}`, refId: call.id });
  run.live = { agentId, activity: 'tool', text: beat.title };
  if (beat.tool === 'shell') term(run, 'cmd', `$ ${String(beat.input.command ?? '')}`, now);
  return 'go';
}

/** Put a notice under the title of a canned report when earlier steps were skipped. */
function withSkipNote(md: string, skipped: DStep[]): string {
  const names = skipped.map((st) => `第 ${st.index + 1} 步「${st.title}」`).join('、');
  const note = `> 注意：本次运行有 ${skipped.length} 步被跳过（${names}），下面的内容不包含这些步骤的结果。`;
  const at = md.indexOf('\n');
  return at < 0 ? `${md}\n\n${note}` : `${md.slice(0, at)}\n\n${note}${md.slice(at)}`;
}

/** Failing result lines go to stderr; passing results and the rest of the report stay on stdout. */
const isErrorLine = (line: string) => /[✗×]|\bFAIL\b|Error/.test(line);

function endBeat(d: D, run: DRun, task: DTask, step: DStep, beat: Beat, now: number) {
  const agentId = agentFor(beat.agent, task);
  if (beat.t === 'think') {
    addTokens(run, beat.tokens);
    if (beat.say) say(task, { role: 'agent', agentId, runId: run.id, kind: beat.kind ?? 'note', text: beat.say, at: now });
    return;
  }
  if (beat.t === 'artifact') {
    const skipped = run.plan.filter((st) => st.status === 'skipped');
    let content: string;
    if (typeof beat.content === 'function') content = beat.content(skipped.map((st) => st.index));
    else if (skipped.length && beat.kind === 'report' && beat.language === 'md') content = withSkipNote(beat.content, skipped);
    else content = beat.content;
    run.artifacts.push({ id: uid('art'), runId: run.id, stepId: step.id, name: beat.name, kind: beat.kind, language: beat.language, content, createdAt: now, simulated: true });
    pushEvent(d, { at: now, runId: run.id, kind: 'step', level: 'success', text: `生成产物：${beat.name}` });
    return;
  }
  const def = toolDef(d, beat.tool);
  const callId = step.toolCallIds[step.toolCallIds.length - 1];
  const call = run.toolCalls.find((c) => c.id === callId);
  if (!call) return;
  addTokens(run, beat.tokens);
  call.endedAt = now;
  call.durationMs = beat.ms;
  const f = beat.fail;
  const fails = !!f && (f.onAttempt === 'always' || f.onAttempt.includes(run.attempt)) && (!f.requiresInject || d.settings.injectFailure);
  if (!fails) {
    call.status = 'ok';
    call.output = beat.output;
    beat.terminal?.forEach((line) => term(run, 'stdout', line, now));
    pushEvent(d, { at: now, runId: run.id, kind: 'tool', level: 'success', text: `「${def.name}」完成：${beat.title}（${duration(beat.ms)}）`, refId: call.id });
    return;
  }
  call.status = 'error';
  call.error = { ...f!.error };
  call.output = f!.output;
  f!.terminal?.forEach((line) => term(run, isErrorLine(line) ? 'stderr' : 'stdout', line, now));
  run.errors.push({ id: uid('err'), at: now, runId: run.id, stepId: step.id, toolCallId: call.id, title: beat.title, code: f!.error.code, message: f!.error.message, detail: f!.error.detail, fatal: f!.fatal });
  pushEvent(d, { at: now, runId: run.id, kind: 'error', level: 'error', text: `「${def.name}」出错：${f!.error.message}`, refId: call.id });
  if (f!.fatal) failRun(d, run, task, step, f!.error.message, now);
  else pushEvent(d, { at: now, runId: run.id, kind: 'agent', level: 'warn', text: `${agentName(d, agentId)} 将自动重试这次调用`, refId: call.id });
}

/** Move a running run forward by `simDt` simulated ms. */
function advance(d: D, run: DRun, simDt: number, now: number) {
  const task = d.tasks[run.taskId];
  if (!task) return;
  const sc = scenarioOf(task);
  let budget = simDt;
  for (let guard = 0; guard < 64 && run.status === 'running'; guard++) {
    const c = run.cursor;
    if (c.phase === 'done') return;
    if (c.phase === 'planning') {
      run.live = { agentId: 'orchestrator', activity: 'thinking', text: '拆解目标、制定计划' };
      const need = sc.planningMs - c.beatElapsed;
      if (budget < need) { c.beatElapsed += budget; return; }
      budget -= need;
      finishPlanning(d, run, task, sc, now);
      continue;
    }
    const step = run.plan[c.step];
    if (!step) { completeRun(d, run, task, sc, now); return; }
    if (step.status === 'done' || step.status === 'skipped') { nextStep(run); continue; }
    if (step.status === 'pending') startStep(d, run, step, now);
    const beats = beatsFor(sc.steps[c.step], run.fixStepIndex === c.step);
    const beat = beats[c.beat];
    if (!beat) { finishStep(d, run, step, now); nextStep(run); continue; }
    if (!c.beatStarted) {
      c.beatStarted = true;
      const start = startBeat(d, run, task, step, beat, now);
      if (start === 'wait') return;
      if (start === 'skip') continue;
    }
    const need = (beat.t === 'artifact' ? 0 : beat.ms) - c.beatElapsed;
    if (budget < need) { c.beatElapsed += budget; return; }
    budget -= Math.max(0, need);
    endBeat(d, run, task, step, beat, now);
    if (run.status !== 'running') return;
    c.beat += 1;
    c.beatElapsed = 0;
    c.beatStarted = false;
  }
}

/* ───────────────────────── user controls ───────────────────────── */

export function findApproval(d: D | AppState, approvalId: string) {
  for (const run of Object.values(d.runs)) {
    const approval = run.approvals.find((a) => a.id === approvalId);
    if (approval) return { run, approval };
  }
  return undefined;
}

export function decideApproval(d: D, approvalId: string, decision: 'approve' | 'reject', now: number): DRun | undefined {
  const found = findApproval(d, approvalId);
  if (!found || found.approval.status !== 'pending') return undefined;
  const run = found.run as DRun;
  const approval = run.approvals.find((a) => a.id === approvalId)!;
  const task = d.tasks[run.taskId];
  const call = run.toolCalls.find((c) => c.id === approval.toolCallId);
  const step = run.plan.find((s) => s.id === approval.stepId);
  approval.status = decision === 'approve' ? 'approved' : 'rejected';
  approval.decidedAt = now;
  dropToasts(d, `approval:${approval.id}`);
  touch(d, run.taskId, now);
  const unblock = () => {
    if (run.status === 'awaiting') run.status = 'running';
    else if (run.status === 'paused' && run.pausedFrom === 'awaiting') run.pausedFrom = 'running';
  };
  if (decision === 'approve') {
    if (call) {
      call.status = 'running';
      call.startedAt = now;
      if (call.tool === 'shell') term(run, 'cmd', `$ ${String(call.input.command ?? '')}`, now);
    }
    if (step) step.status = 'running';
    run.live = { agentId: approval.agentId, activity: run.status === 'paused' ? 'paused' : 'tool', text: approval.title };
    unblock();
    pushEvent(d, { at: now, runId: run.id, kind: 'approval', level: 'success', text: `已批准：${approval.title}`, refId: approval.id });
    return run;
  }
  if (call) Object.assign(call, { status: 'denied', endedAt: now, durationMs: 0, output: '你拒绝了这次调用，它没有执行。' });
  if (step) {
    step.status = 'skipped';
    step.endedAt = now;
    step.note = `你拒绝了「${approval.title}」，此步骤已跳过`;
  }
  say(task, { role: 'agent', agentId: approval.agentId, runId: run.id, kind: 'note', at: now,
    text: `好的，我不会执行「${approval.title}」。这一步已跳过，后续步骤会基于现状继续，并在总结中标明。` });
  if (step && run.cursor.step === step.index) nextStep(run);
  run.live = { agentId: approval.agentId, activity: run.status === 'paused' ? 'paused' : 'thinking', text: `已跳过：${approval.title}` };
  unblock();
  pushEvent(d, { at: now, runId: run.id, kind: 'approval', level: 'warn', text: `已拒绝：${approval.title}（步骤已跳过）`, refId: approval.id });
  return run;
}

export function pauseRun(d: D, run: DRun, reason: 'user' | 'disconnected' | 'reload', now: number) {
  if (run.status !== 'running' && run.status !== 'awaiting') return false;
  run.pausedFrom = run.status;
  run.status = 'paused';
  run.pauseReason = reason;
  if (run.live) run.live.activity = 'paused';
  pushEvent(d, { at: now, runId: run.id, kind: 'run', level: reason === 'user' ? 'info' : 'warn',
    text: reason === 'disconnected' ? `连接断开，运行 #${run.attempt} 已自动暂停` : reason === 'reload' ? `页面重新载入，运行 #${run.attempt} 已暂停` : `运行 #${run.attempt} 已暂停` });
  if (reason !== 'reload') touch(d, run.taskId, now);
  return true;
}

/** Returns an error message when the run cannot resume. */
export function resumeRun(d: D, run: DRun, now: number): string | undefined {
  if (run.status !== 'paused') return '这个运行没有处于暂停状态。';
  if (!gatewayUp(d)) return '模型网关仍未连接，恢复连接后才能继续。';
  const pending = run.approvals.some((a) => a.status === 'pending');
  run.status = pending ? 'awaiting' : 'running';
  run.pauseReason = undefined;
  run.pausedFrom = undefined;
  if (run.live) {
    const script = run.cursor.phase === 'executing' ? scenarioOf(d.tasks[run.taskId]).steps[run.cursor.step] : undefined;
    const beat = script ? beatsFor(script, run.fixStepIndex === run.cursor.step)[run.cursor.beat] : undefined;
    run.live.activity = pending ? 'waiting' : beat?.t === 'tool' ? 'tool' : 'thinking';
  }
  pushEvent(d, { at: now, runId: run.id, kind: 'run', level: 'info', text: `运行 #${run.attempt} 继续` });
  touch(d, run.taskId, now);
  // The "连接已恢复 · 继续运行" toast is stale once its run is going again (and once nothing is left waiting).
  dropResumeToasts(d, run.id);
  if (!Object.values(d.runs).some((r) => r.status === 'paused' && r.pauseReason === 'disconnected')) dropToasts(d, `conn:${GATEWAY_ID}`);
  return undefined;
}

/** Remove toasts whose action would resume this run. */
function dropResumeToasts(d: D, runId: string) {
  const stale = (t: Draft<Toast>) => t.action?.command.type === 'resume-run' && t.action.command.runId === runId;
  if (d.toasts.some(stale)) d.toasts = d.toasts.filter((t) => !stale(t));
}

export function cancelRun(d: D, run: DRun, now: number) {
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return false;
  const task = d.tasks[run.taskId];
  run.status = 'cancelled';
  run.endedAt = now;
  run.cursor.phase = 'done';
  run.live = undefined;
  run.pausedFrom = undefined;
  run.pauseReason = undefined;
  for (const step of run.plan) {
    if (step.status === 'running' || step.status === 'awaiting') { step.status = 'cancelled'; step.endedAt = now; step.note = '运行被取消时正在执行'; }
    else if (step.status === 'pending') step.status = 'cancelled';
  }
  for (const call of run.toolCalls) if (call.status === 'running' || call.status === 'awaiting') Object.assign(call, { status: 'cancelled', endedAt: now });
  for (const approval of run.approvals) {
    if (approval.status !== 'pending') continue;
    approval.status = 'expired';
    dropToasts(d, `approval:${approval.id}`);
  }
  say(task, { role: 'system', runId: run.id, at: now, text: `运行 #${run.attempt} 已取消。已生成的产物仍保留在「产物」中。` });
  pushEvent(d, { at: now, runId: run.id, kind: 'run', level: 'warn', text: `运行 #${run.attempt} 已取消` });
  touch(d, run.taskId, now);
  dropResumeToasts(d, run.id);
  return true;
}

export function startTaskRun(d: D, taskId: string, now: number, mode?: { retryOf: string; mode: 'resume' | 'restart' }): DRun {
  if (mode) dropToasts(d, `run:${mode.retryOf}`);
  const run = newRun(d, taskId, now, mode ? { retryOf: mode.retryOf, mode: mode.mode } : {});
  beginRun(d, run, now);
  return run;
}

/* ───────────────────────── connections ───────────────────────── */

export function disconnect(d: D, connectionId: string, now: number) {
  const conn = d.connections.find((c) => c.id === connectionId);
  if (!conn || conn.status === 'disconnected') return 0;
  Object.assign(conn, { status: 'disconnected', lastChangeAt: now, attempts: 0, retryAt: now + RECONNECT_DELAY_MS, detail: '心跳超时（模拟断开）', latencyMs: undefined });
  let paused = 0;
  if (conn.kind === 'model') {
    for (const run of Object.values(d.runs)) {
      // The gateway is part of the simulation; real model runs have their own connections.
      if (run.source !== 'live' && pauseRun(d, run, 'disconnected', now)) {
        paused++;
        term(run, 'sys', `# 与${conn.name}的连接断开（模拟），运行已暂停`, now);
      }
    }
  }
  pushEvent(d, { at: now, kind: 'connection', level: 'error', text: `${conn.name}连接已断开（模拟）${paused ? `，${paused} 个运行已自动暂停` : ''}` });
  toast(d, { tone: 'danger', title: '连接已断开', body: `${conn.name}（模拟）${paused ? ` · ${paused} 个运行已自动暂停` : ''} · 10 秒后自动重连`, key: `conn:${connectionId}`,
    action: { label: '立即重连', command: { type: 'reconnect', connectionId } } });
  announce(d, `${conn.name}连接已断开（模拟）`);
  return paused;
}

export function reconnect(d: D, connectionId: string, now: number) {
  const conn = d.connections.find((c) => c.id === connectionId);
  if (!conn || (conn.status !== 'disconnected' && conn.status !== 'degraded')) return;
  Object.assign(conn, { status: 'reconnecting', lastChangeAt: now, attempts: conn.attempts + 1, retryAt: undefined, detail: `第 ${conn.attempts + 1} 次重连` });
  pushEvent(d, { at: now, kind: 'connection', level: 'info', text: `正在重连${conn.name}（第 ${conn.attempts} 次）` });
}

function connectionsTick(d: D, now: number) {
  for (const conn of d.connections) {
    if (conn.status === 'disconnected' && conn.retryAt && conn.retryAt <= now) reconnect(d, conn.id, now);
    else if (conn.status === 'reconnecting' && now - conn.lastChangeAt >= RECONNECT_MS) {
      Object.assign(conn, { status: 'connected', lastChangeAt: now, detail: undefined, latencyMs: 40 + ((conn.attempts * 37) % 60) });
      pushEvent(d, { at: now, kind: 'connection', level: 'success', text: `${conn.name}已重新连接` });
      const waiting = Object.values(d.runs).filter((r) => r.status === 'paused' && r.pauseReason === 'disconnected');
      toast(d, {
        tone: 'success', title: '连接已恢复', key: `conn:${conn.id}`,
        body: waiting.length ? `${conn.name}已重新连接（模拟）。${waiting.length} 个运行仍保持暂停，确认后点「继续」。` : `${conn.name}已重新连接（模拟）。`,
        action: waiting.length ? { label: '继续运行', command: { type: 'resume-run', runId: waiting[0].id } } : undefined,
      });
      announce(d, `${conn.name}已重新连接（模拟）`);
    }
  }
}

/* ───────────────────────── ticking ───────────────────────── */

export function needsTick(s: AppState) {
  return Object.values(s.runs).some((r) => r.status === 'running')
    || s.connections.some((c) => c.status === 'disconnected' || c.status === 'reconnecting');
}

export function tick(d: D, now: number, realDt: number) {
  connectionsTick(d, now);
  const speed = d.settings.simSpeed;
  for (const run of Object.values(d.runs)) {
    if (run.status !== 'running') continue;
    addActive(run, realDt);
    // Real runs (live.ts) only borrow the clock; the simulator never moves them.
    if (run.source !== 'live') advance(d, run, realDt * speed, now);
  }
}

/* ───────────────────────── sample history ───────────────────────── */

/** Play a run to its end offline (approving every request after a short "human" delay) to build
 *  sample history. Returns the time the run ended. */
export function simulateOffline(d: D, taskId: string, startAt: number, stop: 'complete' | { cancelAtStep: number }): number {
  quiet = true;
  try {
    let t = startAt;
    const run = newRun(d, taskId, t, { source: 'sample' });
    beginRun(d, run, t);
    for (let guard = 0; guard < 4000; guard++) {
      if (run.status === 'running') {
        if (typeof stop === 'object' && run.cursor.phase === 'executing' && run.cursor.step >= stop.cancelAtStep && run.cursor.beatElapsed > 600) {
          t += 1200;
          cancelRun(d, run, t);
          break;
        }
        t += 250;
        addActive(run, 250);
        advance(d, run, 250, t);
      } else if (run.status === 'awaiting') {
        t += 4200;
        const pending = run.approvals.find((a) => a.status === 'pending');
        if (pending) decideApproval(d, pending.id, 'approve', t);
      } else break;
    }
    return run.endedAt ?? t;
  } finally {
    quiet = false;
  }
}
