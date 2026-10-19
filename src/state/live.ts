/* 运行 / RUNS. Drives the connected models through the desktop bridge and writes what happens into
   the store (Run, PlanStep, ToolCall, Approval…).

   工作任务: plan turn (the model answers in its own voice, then a JSON plan) → one turn per step →
   a summary turn. API models only reason and write; CLI agents work in the task's folder with their
   own tools, and permission prompts become the workbench's 待确认操作. A step goes to the agent the
   plan names; an agent with its own model (Agent page) runs its steps on that model — an API model
   from the shared history, a CLI agent in the task's folder with its own session and tool list.
   闲聊任务: one reply per message, in 流萤's or 萨姆's voice. */
import type { Draft } from 'immer';
import { openStream, desktop, type StartSpec, type StreamEvent } from '../lib/desktop';
import { effortRequest } from '../lib/effort';
import { json } from '../lib/format';
import {
  GREET_PROMPT, NUDGE_PROMPT, PERSONA, completionLine, eventLine, mood, rolePrompt, systemPrompt, type PromptPurpose,
} from '../lib/persona';
import {
  CLAUDE_HEADLESS_DENY, CLAUDE_TOOLS, DRIVERS, PROVIDER_BY_ID, apiBaseUrl, contextOf, regionOf, toolCategory,
} from '../lib/providers';
import type {
  Agent, AgentId, AppState, Approval, Message, PlanStep, Run, Task, TaskEngine, ToolCall, ToolId, VisualMode,
} from '../lib/types';
import { announce, dropToasts, pushEvent, toast, touch } from './engine';
import { agentEngine } from './models';
import { skillsPrompt, taskSkills } from './skills';
import { store, uid } from './store';

type D = Draft<AppState>;
export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

const TERMINAL_CAP = 800;
const OPEN = new Set(['queued', 'running', 'paused', 'awaiting']);

/* ───────────── per-run runtime (not persisted) ───────────── */

interface PendingPermission { streamId: string; requestId: string; input: Record<string, unknown> }
interface RunCtx {
  streamId?: string;
  supportsInput: boolean;
  /** Set when the user paused or cancelled: the current turn's end must not advance the run. */
  halt?: 'pause' | 'cancel';
  approvals: Map<string, PendingPermission>;
  /** Bumped for every driver loop: an older loop that is still unwinding (pause → 继续) sees it and stops. */
  gen: number;
  /** The current driver loop, so a new one starts only after the old one has finished. */
  driver?: Promise<void>;
  phase?: 'plan' | 'step' | 'summary';
}
const runCtx = new Map<string, RunCtx>();
const ctxOf = (runId: string) => {
  let c = runCtx.get(runId);
  if (!c) { c = { supportsInput: false, approvals: new Map(), gen: 0 }; runCtx.set(runId, c); }
  return c;
};
/** Chat replies in flight: taskId → stream id. */
const chatBusy = new Map<string, string>();

/* ───────────── small helpers ───────────── */

const now = () => Date.now();
const s = () => store.get();
const settings = () => s().settings;
const voice = (): VisualMode | undefined => (settings().persona ? settings().mode : undefined);
const callName = () => settings().callName.trim() || '开拓者';

function term(run: Draft<Run>, stream: 'cmd' | 'stdout' | 'stderr' | 'sys', text: string, at: number) {
  run.terminal.push({ id: uid('ln'), at, runId: run.id, stream, text });
  if (run.terminal.length > TERMINAL_CAP) run.terminal.splice(0, run.terminal.length - TERMINAL_CAP);
}

function agentName(d: AppState | D, id: AgentId) {
  return d.agents.find((a) => a.id === id)?.name ?? id;
}

function promptContext(task: Task, purpose: PromptPurpose) {
  const st = settings();
  return {
    mode: st.mode,
    persona: st.persona,
    callName: callName(),
    cwd: task.engine?.cwd,
    mood: st.lifeMood ? mood(st.mode, purpose === 'chat' || purpose === 'nudge' ? 'idle' : 'running') : undefined,
  };
}

const isApi = (e: TaskEngine) => e.auth === 'api';

/** The base of a StartSpec for a task's engine: which program or URL, model, key, folder. */
function baseSpec(engine: TaskEngine): Result<StartSpec> {
  const info = PROVIDER_BY_ID[engine.provider];
  const cfg = s().models.providers[engine.provider];
  if (!info || !cfg) return fail('这个模型服务不在列表里。');
  if (engine.auth === 'api') {
    if (!cfg.keyHint) return fail(`还没有保存 ${info.name} 的 API Key，请到「模型接入」里保存。`);
    const { extraBody } = effortRequest(info.id, 'api', engine.model, engine.effort);
    // Reasoning counts against the output budget, and most models reason by default: leave room
    // unless thinking was switched off.
    return ok({ driver: info.protocol === 'anthropic' ? 'api-anthropic' : 'api-openai', provider: info.id, baseUrl: apiBaseUrl(info, cfg), model: engine.model, maxTokens: engine.effort === 'off' ? 8192 : 32000, extraBody });
  }
  const driver = engine.driver ?? cfg.driver;
  const d = DRIVERS[driver];
  if (!engine.cwd) return fail('这个任务没有工作文件夹。');
  const spec: StartSpec = { driver, provider: info.id, path: cfg.cliPath || undefined, cwd: engine.cwd, model: engine.model || undefined, effort: effortRequest(info.id, 'cli', engine.model, engine.effort).effort };
  if (driver === 'kimi' || driver === 'qwen' || driver === 'mcode') { spec.driver = 'acp'; spec.acp = driver; }
  if (d.auth === 'key' && !cfg.keyHint) return fail(`${d.label} 需要 ${info.name} 的 API Key，请到「模型接入」里保存。`);
  if (driver === 'claude-compat') {
    const url = regionOf(info, cfg).compatUrl;
    if (!url) return fail(`${info.name} 没有可用的 Anthropic 兼容端点。`);
    const model = engine.model || info.cliModels['claude-compat']?.[0]?.id || cfg.model;
    spec.model = undefined;
    spec.keyEnv = 'ANTHROPIC_AUTH_TOKEN';
    spec.env = compatEnv(url, model, contextOf(info, model));
  } else if (driver === 'qwen') {
    spec.keyEnv = 'OPENAI_API_KEY';
    spec.env = { OPENAI_BASE_URL: apiBaseUrl(info, cfg), OPENAI_MODEL: engine.model || 'qwen3.7-plus' };
    spec.model = undefined;
  }
  return ok(spec);
}

/** Environment that points Claude Code at a vendor's Anthropic-compatible endpoint (every model slot = one model). */
export function compatEnv(url: string, model: string, ctx?: { tokens: number; known: boolean }): Record<string, string> {
  // A documented 1M window: ask Claude Code for 1M ([1m], as the vendors' own guides do) and compact only near 1M.
  const big = !!ctx?.known && ctx.tokens >= 1_000_000;
  const main = big && !/\[1m\]$/i.test(model) ? `${model}[1m]` : model;
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: url, ANTHROPIC_MODEL: main, ANTHROPIC_SMALL_FAST_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main, ANTHROPIC_DEFAULT_OPUS_MODEL: main, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_FABLE_MODEL: main,
    API_TIMEOUT_MS: '600000',
  };
  if (ctx?.known) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.min(ctx.tokens, 1_000_000));
  return env;
}

const withSkills = (system: string, skills: string) => (skills ? `${system}\n\n${skills}` : system);

/** 浏览器控制 is on for a task, its driver can take MCP servers, and the browser tools are not both disabled. */
function browserOn(engine: TaskEngine) {
  if (!engine.browser || engine.auth !== 'cli' || engine.access === 'read') return false;
  const driver = engine.driver ?? s().models.providers[engine.provider].driver;
  if (driver === 'dsh') return false;
  const tools = s().tools;
  return !(tools.find((t) => t.id === 'browser_read')?.permission === 'off' && tools.find((t) => t.id === 'browser_act')?.permission === 'off');
}

const BROWSER_NOTE = '\n\n## 浏览器\n你可以用 firefly-browser 的 browser_* 工具操作「萤火浏览器」窗口（使用者看得到这个窗口）：browser_navigate 打开网页，读快照里的 ref，再用 browser_click / browser_type 操作，页面变化后重新 browser_snapshot。需要登录的网站，请使用者先在那个窗口里自己登录；不要替使用者输入密码、支付或提交不可撤销的操作，遇到这些停下来说明。';

/** What a 只读 task may never do. */
const READ_ONLY_BLOCK = new Set<ToolId>(['write_file', 'shell', 'git', 'browser_act']);
/** Claude Code already reads inside its folders (cwd + --add-dir) without asking; leaving these out of
    --allowedTools makes a read anywhere else come back as a permission request. */
const CLAUDE_READS = new Set(['Read', 'NotebookRead', 'Grep', 'Glob', 'LS']);

/** Tool policy → Claude Code allow / deny lists, or Codex sandbox. `only`: an agent's own tool list. */
function policySpec(spec: StartSpec, engine: TaskEngine, access: 'chat' | 'work', only?: ToolId[]) {
  spec.access = access;
  const readOnly = engine.access === 'read';
  spec.readOnly = readOnly;
  if (access === 'chat') { spec.sandbox = 'read-only'; return spec; }
  const tools = s().tools;
  const allow = new Set<string>(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList']);
  const deny = new Set<string>(CLAUDE_HEADLESS_DENY);
  for (const t of tools) {
    const names = CLAUDE_TOOLS[t.id] ?? [];
    const blocked = t.permission === 'off' || (readOnly && READ_ONLY_BLOCK.has(t.id)) || (!!only && t.id !== 'other' && !only.includes(t.id));
    if (blocked) names.forEach((n) => deny.add(n));
    else if (t.permission === 'auto') names.filter((n) => !CLAUDE_READS.has(n)).forEach((n) => allow.add(n));
  }
  spec.allow = [...allow];
  spec.deny = [...deny];
  const writeOff = tools.find((t) => t.id === 'write_file')?.permission === 'off' || (!!only && !only.includes('write_file'));
  const cfg = s().models.providers[engine.provider];
  spec.sandbox = readOnly || writeOff ? 'read-only' : cfg.codexSandbox === 'danger-full-access' ? 'danger-full-access' : 'workspace-write';
  spec.webSearch = tools.find((t) => t.id === 'web_search')?.permission !== 'off' && (!only || only.includes('web_search'));
  return spec;
}

/* ───────────── streaming text into messages ───────────── */

interface Sink {
  taskId: string;
  runId?: string;
  agentId: AgentId;
  kind?: Message['kind'];
  persona?: VisualMode;
  /** Turn raw model text into what the bubble shows (e.g. hide the JSON plan). */
  view?: (raw: string) => string;
  msgId?: string;
  raw: string;
  all: string;
  /** Reasoning text that belongs to the current bubble. */
  think: string;
  timer?: number;
  /** Create the bubble right away (typing dots) instead of on the first text. */
  eager?: boolean;
  /** A chat reply stays one bubble: tool use and turn breaks continue it instead of closing it. */
  single?: boolean;
  /** What she is doing right now (shown under a chat bubble while a tool runs). */
  activity?: string;
}

function sinkFlush(k: Sink, final = false, keepThink = false) {
  if (k.timer !== undefined) { window.clearTimeout(k.timer); k.timer = undefined; }
  // 「写完再显示」: nothing of the text shows until it is final (the bubble keeps its typing dots).
  const text = !final && settings().typing === 'instant' ? '' : (k.view ? k.view(k.raw) : k.raw).replace(/^\s+/, '');
  const think = k.think.trim() ? k.think : undefined;
  store.update((d) => {
    const task = d.tasks[k.taskId];
    if (!task) return;
    let m = k.msgId ? task.messages.find((x) => x.id === k.msgId) : undefined;
    if (!m) {
      if (!text && !think && !(k.eager && !final)) return;
      if (final && !text.trim() && !(keepThink && think)) return;
      k.msgId = uid('msg');
      task.messages.push({ id: k.msgId, role: 'agent', agentId: k.agentId, runId: k.runId, kind: k.kind, text, at: now(), streaming: !final, persona: k.persona, thinking: think, activity: final ? undefined : k.activity });
      touch(d, k.taskId, now());
      return;
    }
    if (final && !text.trim() && !(keepThink && think)) { task.messages = task.messages.filter((x) => x.id !== m!.id); return; }
    m.text = final ? text.trimEnd() : text;
    m.streaming = !final;
    m.activity = final ? undefined : k.activity;
    if (think) m.thinking = think;
  });
}

function sinkText(k: Sink, delta: string) {
  k.raw += delta;
  k.all += delta;
  // 打字节奏「一次显示」: keep the typing dots until the reply (or this bubble) is complete.
  if (settings().typing === 'instant') return;
  if (k.timer === undefined) k.timer = window.setTimeout(() => { k.timer = undefined; sinkFlush(k); }, 70);
}

function sinkThink(k: Sink, delta: string) {
  k.think += delta;
  if (k.timer === undefined) k.timer = window.setTimeout(() => { k.timer = undefined; sinkFlush(k); }, 120);
}

/** A pause in one chat reply (a tool, a new model turn): start a new paragraph, keep the bubble open. */
function sinkPause(k: Sink, activity?: string) {
  if (k.raw.trim() && !k.raw.endsWith('\n\n')) { k.raw += k.raw.endsWith('\n') ? '\n' : '\n\n'; k.all += '\n\n'; }
  k.activity = activity;
  if (k.msgId || activity) sinkFlush(k);
}

/** Close the current bubble; the next text starts a new one. */
function sinkBreak(k: Sink, keepThink = false) {
  if (!k.msgId && !k.raw.trim() && !(keepThink && k.think.trim())) { k.raw = ''; return; }
  sinkFlush(k, true, keepThink);
  k.msgId = undefined;
  k.raw = '';
  k.think = '';
  if (k.all && !k.all.endsWith('\n')) k.all += '\n\n';
}

/* ───────────── one model turn ───────────── */

interface TurnOpts {
  task: Task;
  runId?: string;
  stepId?: string;
  agentId: AgentId;
  kind?: Message['kind'];
  spec: StartSpec;
  view?: (raw: string) => string;
  eager?: boolean;
  /** A chat reply: tracked in chatBusy so a second message waits for it. */
  chat?: boolean;
  /** A CLI turn of an agent on its own model: its session id goes to task.agentSessions[agent]. */
  sessionAgent?: AgentId;
  /** Tool categories this agent may use (its Agent-page list); others are refused. */
  onlyTools?: ToolId[];
}

interface TurnResult { text: string; stopReason?: string; plan?: Array<{ text: string; status: string }> }

/** 「正在查看：README.md」 — what a tool call looks like from the outside, for the chat bubble. */
function activityText(name: string, input: Record<string, unknown>, title: string) {
  const verb: Record<ToolId, string> = {
    read_file: '正在查看', code_search: '正在搜索', write_file: '正在写入', shell: '正在运行命令', git: '正在运行 Git',
    web_search: '正在搜索网页', web_fetch: '正在打开网页', browser_read: '正在看网页', browser_act: '正在操作网页', other: '正在使用工具',
  };
  const what = (title || name).replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${verb[toolCategory(name, input)]}：${what}`;
}

function preview(category: ToolId, name: string, input: Record<string, unknown>): { text: string; kind: Approval['previewKind'] } {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  if (category === 'shell' || category === 'git') return { text: `$ ${str('command') || json(input)}`, kind: 'command' };
  if (category === 'write_file') {
    const file = str('file_path') || str('path') || str('notebook_path');
    if (str('old_string') || str('new_string')) {
      const minus = str('old_string').split('\n').map((l) => `-${l}`).join('\n');
      const plus = str('new_string').split('\n').map((l) => `+${l}`).join('\n');
      return { text: `--- ${file}\n+++ ${file}\n${minus}\n${plus}`.slice(0, 8000), kind: 'diff' };
    }
    if (str('content')) return { text: `+++ ${file}（新文件）\n${str('content').split('\n').slice(0, 80).map((l) => `+${l}`).join('\n')}`.slice(0, 8000), kind: 'diff' };
  }
  return { text: `${name}\n${json(input)}`.slice(0, 8000), kind: 'request' };
}

function runTurn(o: TurnOpts): Promise<TurnResult> {
  const k: Sink = { taskId: o.task.id, runId: o.runId, agentId: o.agentId, kind: o.kind, persona: o.agentId === 'orchestrator' ? voice() : undefined, view: o.view, raw: '', all: '', think: '', eager: o.eager, single: o.chat };
  const calls = new Map<string, string>(); // CLI call id → our ToolCall id
  let plan: TurnResult['plan'];
  let myId = '';
  // A newer turn of the same run may own the stream slot by the time this one ends.
  const release = () => { if (!o.runId || o.chat) return; const c = runCtx.get(o.runId); if (c && c.streamId === myId) c.streamId = undefined; };
  const base = o.runId ? { ...s().runs[o.runId]?.usage } : undefined;
  if (k.eager) sinkFlush(k);

  return new Promise<TurnResult>((resolve, reject) => {
    const withRun = (fn: (d: D, run: Draft<Run>) => void) => {
      if (!o.runId) return;
      store.update((d) => { const run = d.runs[o.runId!]; if (run) fn(d, run); });
    };

    const ensureCall = (d: D, run: Draft<Run>, cliId: string | undefined, name: string, input: Record<string, unknown>, title: string) => {
      const known = cliId ? calls.get(cliId) : undefined;
      if (known) return run.toolCalls.find((c) => c.id === known);
      const category = toolCategory(name, input);
      const call: ToolCall = {
        id: uid('call'), runId: run.id, stepId: o.stepId ?? '', agentId: o.agentId, tool: category, toolName: name,
        title: title || name, input, status: 'running', startedAt: now(),
      };
      run.toolCalls.push(call);
      if (cliId) calls.set(cliId, call.id);
      const step = run.plan.find((st) => st.id === o.stepId);
      step?.toolCallIds.push(call.id);
      const def = d.tools.find((t) => t.id === category);
      pushEvent(d, { runId: run.id, kind: 'tool', level: 'info', text: `${agentName(d, o.agentId)} 调用「${def?.name ?? name}」：${call.title}`, refId: call.id });
      if (category === 'shell' || category === 'git') term(run, 'cmd', `$ ${String(input.command ?? call.title)}`, now());
      return run.toolCalls[run.toolCalls.length - 1];
    };

    const on = (ev: StreamEvent) => {
      switch (ev.type) {
        case 'session':
          store.update((d) => {
            const t = d.tasks[o.task.id];
            if (!t) return;
            if (o.sessionAgent) t.agentSessions = { ...t.agentSessions, [o.sessionAgent]: ev.sessionId };
            else t.session = ev.sessionId;
          });
          break;
        case 'text':
          sinkText(k, ev.text);
          break;
        case 'thinking':
          sinkThink(k, ev.text);
          if (!o.chat) withRun((_d, run) => { if (run.live && run.live.activity !== 'thinking') run.live = { agentId: o.agentId, activity: 'thinking', text: '思考中…' }; });
          break;
        case 'text-break':
          if (k.single) sinkPause(k, k.activity);
          else sinkBreak(k);
          break;
        case 'tool':
          if (k.single) sinkPause(k, activityText(ev.name, ev.input, ev.title));
          else sinkBreak(k);
          withRun((d, run) => {
            const call = ensureCall(d, run, ev.callId, ev.name, ev.input, ev.title);
            if (call && run.status === 'running') run.live = { agentId: o.agentId, activity: 'tool', text: call.title };
          });
          break;
        case 'tool-end':
          if (k.single && k.activity) { k.activity = undefined; sinkFlush(k); }
          withRun((d, run) => {
            const id = calls.get(ev.callId);
            const call = id ? run.toolCalls.find((c) => c.id === id) : undefined;
            if (!call) return;
            const t = now();
            const denied = !ev.ok && call.status === 'denied';
            if (!denied) call.status = ev.ok ? 'ok' : 'error';
            call.output = denied ? call.output : ev.output;
            call.endedAt = t;
            call.durationMs = t - call.startedAt;
            if ((call.tool === 'shell' || call.tool === 'git') && ev.output) {
              ev.output.split('\n').slice(0, 60).forEach((line) => term(run, ev.ok ? 'stdout' : 'stderr', line, t));
            }
            const def = d.tools.find((x) => x.id === call.tool);
            if (!ev.ok && !denied) {
              const first = (ev.output || '执行失败').split('\n').find((l) => l.trim()) ?? '执行失败';
              call.error = { code: ev.exitCode != null ? `EXIT_${ev.exitCode}` : 'TOOL_ERROR', message: first.slice(0, 200), detail: ev.output?.slice(0, 4000), recoverable: true };
              run.errors.push({ id: uid('err'), at: t, runId: run.id, stepId: call.stepId, toolCallId: call.id, title: call.title, code: call.error.code, message: call.error.message, detail: call.error.detail, fatal: false });
              pushEvent(d, { runId: run.id, kind: 'error', level: 'warn', text: `「${def?.name ?? call.toolName}」出错：${call.error.message}`, refId: call.id });
            } else if (ev.ok) {
              pushEvent(d, { runId: run.id, kind: 'tool', level: 'success', text: `「${def?.name ?? call.toolName}」完成：${call.title}`, refId: call.id });
            }
            if (run.status === 'running') run.live = { agentId: o.agentId, activity: 'thinking', text: '继续处理…' };
          });
          break;
        case 'permission':
          onPermission(o, ev, (d, run) => ensureCall(d, run, ev.callId, ev.name, ev.input, ev.title));
          break;
        case 'plan':
          plan = ev.entries;
          break;
        case 'usage':
          withRun((_d, run) => {
            const u = run.usage;
            if (ev.total && base) {
              u.inputTokens = (base.inputTokens ?? 0) + ev.input;
              u.outputTokens = (base.outputTokens ?? 0) + ev.output;
              u.cachedTokens = (base.cachedTokens ?? 0) + ev.cached;
            } else {
              u.inputTokens += ev.input;
              u.outputTokens += ev.output;
              u.cachedTokens += ev.cached;
            }
            // One API request's input is the context. A CLI turn's total adds up many requests, so only a per-request
            // figure (Claude Code reports one) says how full the window is.
            if (!ev.total && u.contextLimit) u.contextUsed = Math.min(u.contextLimit, ev.input + ev.output);
            else if (ev.context && u.contextLimit) u.contextUsed = Math.min(u.contextLimit, ev.context);
            u.series.push(u.inputTokens + u.outputTokens);
            if (u.series.length > 120) u.series.splice(0, u.series.length - 120);
          });
          break;
        case 'notice':
          withRun((d, run) => {
            pushEvent(d, { runId: run.id, kind: 'agent', level: ev.level === 'error' ? 'error' : 'warn', text: ev.text });
            term(run, 'sys', `# ${ev.text}`, now());
          });
          break;
        case 'stdout':
          withRun((_d, run) => term(run, 'stdout', ev.text, now()));
          break;
        case 'done': {
          const cut = ev.stopReason === 'length' || ev.stopReason === 'max_tokens';
          sinkBreak(k, cut);
          release();
          if (cut) {
            store.update((d) => {
              d.tasks[o.task.id]?.messages.push({ id: uid('msg'), role: 'system', runId: o.runId, at: now(),
                text: '这次回复达到了输出长度上限，后面的内容被截断了。可以让它「继续」，或把强度调低一些。' });
              if (o.runId) { const run = d.runs[o.runId]; if (run) pushEvent(d, { runId: run.id, kind: 'agent', level: 'warn', text: '模型回复达到输出上限，被截断' }); }
            });
          }
          resolve({ text: (k.all.trim() || ev.text || '').trim(), stopReason: ev.stopReason, plan });
          break;
        }
        case 'error':
          sinkBreak(k);
          release();
          reject(Object.assign(new Error(ev.message), { code: ev.code }));
          break;
        default: break;
      }
    };

    // The id arrives before any buffered events are replayed, so permission requests can be answered.
    const onId = (id: string) => {
      myId = id;
      if (o.chat) chatBusy.set(o.task.id, id);
      if (!o.runId || o.chat) return;
      const c = ctxOf(o.runId);
      c.streamId = id;
      c.supportsInput = o.spec.driver === 'claude-code' || o.spec.driver === 'claude-compat';
      const r = live(o.runId);
      // Paused or cancelled while the program was starting: stop it straight away.
      if (!r || !(r.status === 'running' || r.status === 'awaiting') || c.halt) void desktop?.stop(id, r?.status === 'paused' ? 'interrupt' : 'kill');
    };
    openStream(o.spec, on, onId).catch((e: Error) => { sinkBreak(k); reject(e); });
  });
}

/** A CLI agent asks before using a tool: decide by policy, or ask the user. */
function onPermission(o: TurnOpts, ev: Extract<StreamEvent, { type: 'permission' }>, ensureCall: (d: D, run: Draft<Run>) => Draft<ToolCall> | undefined) {
  const streamId = o.chat ? chatBusy.get(o.task.id) : o.runId ? ctxOf(o.runId).streamId : undefined;
  const answer = (decision: 'allow' | 'deny') => { if (streamId) void desktop?.answer(streamId, ev.requestId, decision, ev.input); };
  if (!o.runId || o.chat || !streamId) { answer('deny'); return; }
  const category = toolCategory(ev.name, ev.input);
  const st = s();
  const def = st.tools.find((t) => t.id === category);
  const readOnly = o.task.engine?.access === 'read' && READ_ONLY_BLOCK.has(category);
  const notMine = !!o.onlyTools && category !== 'other' && !o.onlyTools.includes(category);
  if (readOnly || notMine || def?.permission === 'off') {
    answer('deny');
    store.update((d) => {
      const run = d.runs[o.runId!];
      if (!run) return;
      const call = ensureCall(d, run);
      if (call) Object.assign(call, { status: 'denied', endedAt: now(), durationMs: 0,
        output: readOnly ? '这个任务是只读的，已自动拒绝。' : notMine ? `${agentName(d, o.agentId)} 没有「${def?.name ?? category}」这个工具（在 Agent 页可以调整），已自动拒绝。` : `「${def?.name}」已在「工具与技能」中禁用，已自动拒绝。` });
      pushEvent(d, { runId: run.id, kind: 'approval', level: 'warn', text: `已自动拒绝：${ev.title || ev.name}` });
    });
    return;
  }
  const outside = outsideFolders(o.task, ev);
  if (def?.permission === 'auto' && !outside) { answer('allow'); return; }

  const pv = preview(category, ev.name, ev.input);
  let approvalId = '';
  store.update((d) => {
    const run = d.runs[o.runId!];
    const task = d.tasks[o.task.id];
    if (!run || !task) return;
    const call = ensureCall(d, run);
    const step = run.plan.find((x) => x.id === o.stepId);
    const approval: Approval = {
      id: uid('apr'), runId: run.id, taskId: task.id, stepId: o.stepId ?? '', toolCallId: call?.id ?? '', agentId: o.agentId,
      tool: category, title: `${def?.name ?? ev.name}：${ev.title || ev.name}`.slice(0, 120),
      reason: outside
        ? `这次要访问工作文件夹以外的位置：${outside}。自动放行只适用于工作文件夹以内，请确认。`
        : ev.reason ? String(ev.reason) : `${(o.runId ? d.runs[o.runId]?.agentEngines?.[o.agentId] : undefined)?.label ?? task.engine?.label ?? '模型'} 想要${def?.name ?? `使用 ${ev.name}`}，需要你的确认。`,
      preview: pv.text, previewKind: pv.kind, risk: def?.risk ?? 'medium', status: 'pending', createdAt: now(),
    };
    approvalId = approval.id;
    run.approvals.push(approval);
    if (call) { call.status = 'awaiting'; call.approvalId = approval.id; }
    if (step && step.status === 'running') step.status = 'awaiting';
    if (run.status === 'running') run.status = 'awaiting';
    run.live = { agentId: o.agentId, activity: 'waiting', text: `等待确认：${approval.title}` };
    pushEvent(d, { runId: run.id, kind: 'approval', level: 'warn', text: `等待确认：${approval.title}`, refId: approval.id });
    toast(d, { tone: 'warning', title: '需要你的确认', body: `${agentName(d, o.agentId)} 请求：${approval.title}`, key: `approval:${approval.id}`, action: { label: '去确认', command: { type: 'show-approvals' } } });
    announce(d, `需要确认：${approval.title}`);
  });
  if (approvalId) ctxOf(o.runId).approvals.set(approvalId, { streamId, requestId: ev.requestId, input: ev.input });
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath', 'absolute_path', 'dir_path', 'directory'];
const normPath = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** The first path a tool request names outside the task folder and the skills folder, if any. */
function outsideFolders(task: Task, ev: Extract<StreamEvent, { type: 'permission' }>): string {
  if (ev.blockedPath) return ev.blockedPath;
  const roots = [task.engine?.cwd, s().skills?.root].filter((x): x is string => !!x).map(normPath);
  const named = [...(ev.paths ?? []), ...PATH_KEYS.map((key) => ev.input[key]).filter((x): x is string => typeof x === 'string' && !!x.trim())];
  for (const p of named) {
    const n = normPath(p);
    const absolute = /^([a-z]:)?\//.test(n) || n.startsWith('~') || n.startsWith('//');
    if (absolute ? !roots.some((r) => n === r || n.startsWith(`${r}/`)) : /(^|\/)\.\.(\/|$)/.test(n)) return p;
  }
  return '';
}

/* ───────────── work runs ───────────── */

const live = (runId: string) => s().runs[runId];
/** The run should stop driving: paused, cancelled, finished — or a newer driver loop took over. */
const halted = (runId: string, gen?: number) => {
  const r = live(runId);
  const c = runCtx.get(runId);
  return !r || !(r.status === 'running' || r.status === 'awaiting') || !!c?.halt || (gen !== undefined && c?.gen !== gen);
};

/** User messages sent during the run that the model has not seen yet. */
function extrasFor(task: Task, run: Run) {
  return task.messages.filter((m) => m.role === 'user' && m.runId === run.id && !m.delivered).map((m) => m.text);
}

function markDelivered(taskId: string, runId: string) {
  store.update((d) => { for (const m of d.tasks[taskId]?.messages ?? []) if (m.role === 'user' && m.runId === runId) m.delivered = true; });
}

function planPrompt(task: Task, run: Run | undefined, cli: boolean) {
  const st = s();
  const ids = rosterOf(task);
  const roster = ids.length <= 1
    ? `- orchestrator：你自己（这次由你一个人${cli ? '在工作文件夹里' : ''}完成全部步骤）`
    : ids.map((id) => {
      const a = st.agents.find((x) => x.id === id);
      const own = run?.agentEngines?.[id];
      const how = id === 'orchestrator' ? '你自己' : own ? `用 ${own.label}${own.auth === 'cli' ? '，能在工作文件夹里动手' : '，只能思考和写作，不能动文件'}` : cli ? '由你以这个角色完成' : '';
      return `- ${id}：${a?.name ?? id}，${a?.role ?? ''}${how ? `（${how}）` : ''}`;
    }).join('\n');
  const extras = task.messages.filter((m) => m.role === 'user' && m.text !== task.goal).map((m) => `- ${m.text}`).join('\n');
  return [
    `任务目标：\n${task.goal}`,
    extras ? `补充说明：\n${extras}` : '',
    `可以分派的 Agent：\n${roster}`,
    '请先用你的口吻说一两句话（不超过 60 字），然后给出 2 到 6 步的执行计划，放在一个 ```json 代码块里，格式：',
    '{"steps":[{"title":"不超过 14 个字","detail":"一句话：这一步做什么、产出什么","agent":"orchestrator"}]}',
    cli ? '你可以先只读地了解一下工作文件夹里的情况，但这一轮不要修改任何文件，也不要开始执行。' : '这一轮只做计划，不要开始执行。',
  ].filter(Boolean).join('\n\n');
}

function parsePlan(raw: string, allowed: AgentId[]): Array<{ title: string; detail: string; agent: AgentId }> | null {
  const block = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [block?.[1], raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      const steps = Array.isArray(j) ? j : j.steps;
      if (!Array.isArray(steps) || !steps.length) continue;
      return steps.slice(0, 8).map((x: { title?: unknown; detail?: unknown; agent?: unknown }) => ({
        title: String(x.title ?? '').slice(0, 40) || '未命名步骤',
        detail: String(x.detail ?? '').slice(0, 300),
        agent: allowed.includes(x.agent as AgentId) ? (x.agent as AgentId) : 'orchestrator',
      }));
    } catch { /* try next */ }
  }
  return null;
}

/** API runs keep no hidden state: the conversation is rebuilt from the plan and step results. */
function apiHistory(task: Task, run: Run) {
  const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: planPrompt(task, run, false) }];
  if (run.planReady) {
    msgs.push({ role: 'assistant', content: `计划：\n${run.plan.map((st, i) => `${i + 1}. ${st.title}（${st.agentId}）：${st.detail}`).join('\n')}` });
    run.plan.forEach((st, i) => {
      if (st.status !== 'done' || !st.result) return;
      msgs.push({ role: 'user', content: `执行第 ${i + 1} 步「${st.title}」。` });
      msgs.push({ role: 'assistant', content: st.result });
    });
  }
  return msgs;
}

function stepPrompt(run: Run, i: number, extras: string[], cli: boolean) {
  const st = run.plan[i];
  const a = s().agents.find((x) => x.id === st.agentId);
  const who = st.agentId !== 'orchestrator' ? `这一步由「${a?.name ?? st.agentId}」（${a?.role ?? ''}）负责${cli ? '，请以这个角色来做' : ''}。` : '';
  return [
    `现在执行第 ${i + 1}/${run.plan.length} 步「${st.title}」：${st.detail}`,
    who,
    extras.length ? `${callName()} 刚刚补充：\n${extras.map((x) => `- ${x}`).join('\n')}` : '',
    cli ? '可以用你的工具在工作文件夹里完成这一步。只做这一步，不要提前做后面的步骤。' : '',
    '完成后，最后一行以「小结：」开头，用一句话说明这一步做成了什么。',
  ].filter(Boolean).join('\n\n');
}

function specFor(task: Task, run: Run, purpose: PromptPurpose, agent: AgentId, prompt: string, access: 'chat' | 'work', engine: TaskEngine = task.engine!): Result<StartSpec> {
  const b = baseSpec(engine);
  if (!b.ok) return b;
  const spec = b.value;
  // Chat-access turns (the summary) run without tools, so they get the skill text itself.
  const inline = isApi(engine) || access === 'chat';
  const skillText = skillsPrompt(task, inline);
  if (isApi(engine)) {
    spec.system = withSkills(agent === 'orchestrator' ? systemPrompt(purpose, promptContext(task, purpose)) : rolePrompt(agent, callName()), skillText);
    spec.messages = [...apiHistory(task, run), { role: 'user', content: prompt }];
    return ok(spec);
  }
  const own = toolsOf(agent);
  const useBrowser = browserOn(engine) && access === 'work' && (!own || own.includes('browser_read') || own.includes('browser_act'));
  const role = agent !== 'orchestrator' ? `\n\n${rolePrompt(agent, callName())}` : '';
  spec.system = withSkills(systemPrompt(purpose === 'plan' || purpose === 'step' ? 'cli' : purpose, promptContext(task, 'cli')) + role, skillText) + (useBrowser ? BROWSER_NOTE : '');
  spec.skills = !!skillText && !inline;
  spec.browser = useBrowser;
  spec.prompt = prompt;
  spec.sessionId = engine === task.engine ? task.session : task.agentSessions?.[agent];
  return ok(policySpec(spec, engine, access, toolsOf(agent)));
}

/** Agents taking part in a task's runs (the 编排 Agent always does). */
function rosterOf(task: Task): AgentId[] {
  const ids = task.agentIds.filter((id) => s().agents.some((a) => a.id === id && (a.enabled || id === 'orchestrator')));
  return ids.includes('orchestrator') ? ids : ['orchestrator', ...ids];
}

/** A sub-agent's tool list (Agent page); the 编排 Agent follows the 工具策略 alone. */
const toolsOf = (agent: AgentId): ToolId[] | undefined => {
  const a: Agent | undefined = s().agents.find((x) => x.id === agent);
  return agent === 'orchestrator' || !a ? undefined : a.tools;
};

/** The CLI session a turn runs in: 'task' (the task's own), an agent id (its own CLI model), or '' for API turns. */
function sessionKey(run: Run, agent: AgentId, engine: TaskEngine): string {
  if (isApi(engine)) return '';
  return agent !== 'orchestrator' && run.agentEngines?.[agent] ? agent : 'task';
}

/** The session a done step's result lives in (the same keys as sessionKey; API results live in none). */
function producer(run: Run, st: PlanStep): string {
  const own = st.agentId !== 'orchestrator' ? run.agentEngines?.[st.agentId] : undefined;
  if (own) return own.auth === 'cli' ? st.agentId : '';
  return s().tasks[run.taskId]?.engine?.auth === 'cli' ? 'task' : '';
}

/** Results of done steps this session neither produced nor was told about yet. */
function unseen(run: Run, key: string) {
  const told = new Set(run.shown?.[key] ?? []);
  const news = run.plan.filter((st) => st.status === 'done' && st.result && !told.has(st.id) && producer(run, st) !== key);
  if (!news.length) return '';
  return `其他 Agent 刚完成的步骤（供你接着做）：\n\n${news.map((st) => `### ${st.title}（${agentName(s(), st.agentId)}）\n${(st.result ?? '').slice(0, 3000)}`).join('\n\n')}`;
}

function markShown(runId: string, key: string) {
  store.update((d) => {
    const r = d.runs[runId];
    if (!r) return;
    const ids = r.plan.filter((st) => st.status === 'done').map((st) => st.id);
    r.shown = { ...r.shown, [key]: ids };
  });
}

/** What a CLI agent that has not worked on this run yet needs to know: the goal, the plan, what is done. */
function briefing(task: Task, run: Run) {
  const done = run.plan.filter((st) => st.status === 'done' && st.result);
  return [
    `任务目标：\n${task.goal}`,
    `计划：\n${run.plan.map((st, i) => `${i + 1}. ${st.title}（${agentName(s(), st.agentId)}）：${st.detail}`).join('\n')}`,
    done.length ? `已完成的步骤：\n${done.map((st) => `### ${st.title}\n${(st.result ?? '').slice(0, 3000)}`).join('\n\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

async function planTurn(runId: string, gen: number) {
  const run = live(runId)!;
  const task = s().tasks[run.taskId];
  const engine = task.engine!;
  const cli = !isApi(engine);
  const spec = specFor(task, run, 'plan', 'orchestrator', planPrompt(task, run, cli), 'work');
  markDelivered(task.id, runId);
  if (!spec.ok) throw Object.assign(new Error(spec.error), { code: 'CONFIG' });
  if (isApi(engine)) spec.value.messages = [{ role: 'user', content: planPrompt(task, run, false) }];
  store.update((d) => { const r = d.runs[runId]; if (r) r.live = { agentId: 'orchestrator', activity: 'thinking', text: '拆解目标、制定计划' }; });
  const res = await runTurn({ task, runId, agentId: 'orchestrator', kind: 'plan', spec: spec.value, view: (raw) => raw.split('```')[0], eager: true });
  if (halted(runId, gen) || res.stopReason === 'interrupted') return;
  const allowed: AgentId[] = rosterOf(task);
  const parsed = parsePlan(res.text, allowed)
    ?? (res.plan?.length ? res.plan.map((p) => ({ title: p.text.slice(0, 40), detail: p.text, agent: 'orchestrator' as AgentId })) : null);
  store.update((d) => {
    const r = d.runs[runId];
    const t = d.tasks[task.id];
    if (!r || !t) return;
    const steps = parsed ?? [{ title: '完成目标', detail: task.goal.slice(0, 120), agent: 'orchestrator' as AgentId }];
    r.plan = steps.map((x, index): PlanStep => ({ id: uid('step'), index, title: x.title, detail: x.detail, agentId: x.agent, status: 'pending', toolCallIds: [] }));
    r.planReady = true;
    r.cursor = { phase: 'executing', step: 0 };
    // The intro bubble shows only the words before the JSON; give it a voice line if it was empty.
    const intro = [...t.messages].reverse().find((m) => m.runId === runId && m.kind === 'plan');
    if (!intro) t.messages.push({ id: uid('msg'), role: 'agent', agentId: 'orchestrator', runId, kind: 'plan', text: voice() ? eventLine(voice()!, 'plan', callName()) : '计划已生成。', at: now(), persona: voice() });
    if (!parsed) t.messages.push({ id: uid('msg'), role: 'system', runId, text: '没能从回复里读出计划，改为一步完成整个目标。', at: now() });
    pushEvent(d, { runId, kind: 'step', level: 'info', text: `计划已生成：共 ${r.plan.length} 步` });
  });
}

async function stepTurn(runId: string, i: number, gen: number) {
  let run = live(runId)!;
  const task = s().tasks[run.taskId];
  const extras = extrasFor(task, run);
  markDelivered(task.id, runId);
  const resumed = run.plan[i].status !== 'pending';
  store.update((d) => {
    const r = d.runs[runId];
    const st = r?.plan[i];
    if (!r || !st) return;
    if (st.status === 'pending') {
      st.status = 'running';
      st.startedAt = now();
      st.activeMs = 0;
      pushEvent(d, { runId, kind: 'step', level: 'info', text: `开始第 ${i + 1} 步：${st.title}`, refId: st.id });
    } else st.status = 'running';
    r.cursor.step = i;
    r.live = { agentId: st.agentId, activity: 'thinking', text: st.title };
  });
  run = live(runId)!;
  const step = run.plan[i];
  const agent: AgentId = rosterOf(task).includes(step.agentId) ? step.agentId : 'orchestrator';
  const own = agent !== 'orchestrator' ? run.agentEngines?.[agent] : undefined;
  const engine = own ?? task.engine!;
  const ownCli = !!own && own.auth === 'cli';
  let prompt = stepPrompt(run, i, extras, !isApi(engine)) + (resumed ? '\n\n（这一步刚才被中断过，请检查已经做了什么，再接着完成。）' : '');
  // A CLI agent on its own model starts without the run's history: brief it once.
  const key = sessionKey(run, agent, engine);
  if (ownCli && !task.agentSessions?.[agent]) prompt = `${briefing(task, run)}\n\n---\n\n${prompt}`;
  else if (key) { const news = unseen(run, key); if (news) prompt = `${news}\n\n---\n\n${prompt}`; }
  if (key) markShown(runId, key);
  const spec = specFor(task, run, 'step', agent, prompt, 'work', engine);
  if (!spec.ok) throw Object.assign(new Error(own ? `${agentName(s(), agent)}（${own.label}）：${spec.error}` : spec.error), { code: 'CONFIG' });
  if (own) store.update((d) => { const st = d.runs[runId]?.plan[i]; if (st) st.engineLabel = own.label; });
  const res = await runTurn({
    task, runId, stepId: step.id, agentId: agent, kind: 'note', spec: spec.value, eager: true,
    sessionAgent: ownCli ? agent : undefined, onlyTools: toolsOf(agent),
  });
  if (res.stopReason === 'interrupted' || halted(runId, gen)) return;
  store.update((d) => {
    const r = d.runs[runId];
    const st = r?.plan[i];
    if (!r || !st) return;
    st.status = 'done';
    st.endedAt = now();
    st.result = res.text.slice(0, 20000);
    const summary = res.text.split('\n').reverse().find((l) => /^\s*\**小结[：:]/.test(l));
    st.note = summary ? summary.replace(/^\s*\**小结[：:]\**\s*/, '').slice(0, 120) : undefined;
    pushEvent(d, { runId, kind: 'step', level: 'success', text: `完成第 ${i + 1} 步：${st.title}`, refId: st.id });
    touch(d, r.taskId, now());
  });
}

async function summaryTurn(runId: string, gen: number) {
  const run = live(runId)!;
  const task = s().tasks[run.taskId];
  const skipped = run.plan.filter((st) => st.status === 'skipped').length;
  const extras = extrasFor(task, run);
  markDelivered(task.id, runId);
  const prompt = [
    `所有步骤都已结束${skipped ? `（其中 ${skipped} 步被跳过，没有执行）` : ''}。请用你的口吻向「${callName()}」做最终汇报：先一句话给结论，再分点列出关键结果；有文件改动的话列出位置。不超过 300 字，不要再贴大段代码。`,
    extras.length ? `${callName()} 在最后补充了：\n${extras.map((x) => `- ${x}`).join('\n')}\n请在汇报里回应这些补充。这一轮不能再动手；如果需要再做，请提醒对方重新运行。` : '',
  ].filter(Boolean).join('\n\n');
  // A CLI session writing the summary has not seen what other agents' own models did.
  const key = sessionKey(run, 'orchestrator', task.engine!);
  const news = key ? unseen(run, key) : '';
  const spec = specFor(task, run, 'summary', 'orchestrator', news ? `${news}\n\n---\n\n${prompt}` : prompt, 'chat');
  if (!spec.ok) throw Object.assign(new Error(spec.error), { code: 'CONFIG' });
  if (key) markShown(runId, key);
  store.update((d) => { const r = d.runs[runId]; if (r) r.live = { agentId: 'orchestrator', activity: 'thinking', text: '整理结果、写总结' }; });
  const res = await runTurn({ task, runId, agentId: 'orchestrator', kind: 'summary', spec: spec.value, eager: true });
  if (res.stopReason === 'interrupted' || halted(runId, gen)) return;
  completeLive(runId, res.text);
  // Something sent while the summary was being written still gets an answer.
  if (extrasFor(s().tasks[task.id], run).length) void reply(task.id, { followUp: true });
}

function report(task: Task, run: Run, summary: string) {
  const lines = [`# ${task.title}`, '', `> ${run.engineLabel ?? '模型'} · 运行 #${run.attempt} · ${new Date().toLocaleString('zh-CN')}`, '', '## 总结', '', summary.trim() || '（没有总结）', '', '## 各步骤结果', ''];
  run.plan.forEach((st, i) => {
    lines.push(`### ${i + 1}. ${st.title}`, '');
    lines.push(st.status === 'done' ? (st.result?.trim() || '（没有文字结果）') : st.status === 'skipped' ? '（已跳过，没有执行）' : `（${st.status}）`, '');
  });
  return lines.join('\n');
}

function changes(run: Run) {
  const parts: string[] = [];
  for (const c of run.toolCalls) {
    if (c.tool !== 'write_file' || c.status !== 'ok') continue;
    parts.push(preview('write_file', c.toolName ?? 'write', c.input).text);
  }
  return parts.join('\n\n');
}

function completeLive(runId: string, summary: string) {
  store.update((d) => {
    const r = d.runs[runId];
    const t = r ? d.tasks[r.taskId] : undefined;
    if (!r || !t) return;
    const at = now();
    const last = r.plan[r.plan.length - 1];
    r.artifacts.push({ id: uid('art'), runId, stepId: last?.id ?? '', name: '结果汇总.md', kind: 'report', language: 'md', content: report(t as Task, r as Run, summary), createdAt: at });
    const diff = changes(r as Run);
    if (diff) r.artifacts.push({ id: uid('art'), runId, stepId: last?.id ?? '', name: '文件改动.diff', kind: 'diff', language: 'diff', content: diff, createdAt: at });
    r.status = 'completed';
    r.endedAt = at;
    r.cursor.phase = 'done';
    r.live = undefined;
    const skipped = r.plan.filter((st) => st.status === 'skipped').length;
    pushEvent(d, { runId, kind: 'run', level: skipped ? 'warn' : 'success', text: `运行 #${r.attempt} ${skipped ? `已结束（${skipped} 步被跳过）` : '完成'}：${t.title}` });
    touch(d, t.id, at);
    toast(d, { tone: 'success', title: '任务完成', body: skipped ? `「${t.title}」· 运行已结束，其中 ${skipped} 步被跳过。` : completionLine(d.settings.mode, t.title),
      action: { label: '查看产物', command: { type: 'open-task', taskId: t.id, runId, tab: 'artifacts' } } });
    announce(d, `任务「${t.title}」已完成`);
    d.celebration = { runId, at };
  });
  runCtx.delete(runId);
}

function failLive(runId: string, e: Error & { code?: string }, phase?: RunCtx['phase']) {
  store.update((d) => {
    const r = d.runs[runId];
    const t = r ? d.tasks[r.taskId] : undefined;
    if (!r || !t || !OPEN.has(r.status)) return;
    const at = now();
    let step = r.plan.find((st) => st.status === 'running' || st.status === 'awaiting');
    if (!step) {
      // Failed while planning or summing up: give the failure a step of its own to show on.
      const summary = phase === 'summary';
      r.plan.push({ id: uid('step'), index: r.plan.length, title: summary ? '汇总结果' : '制定计划', detail: summary ? '整理各步骤的结果，写最终汇报' : '编排 Agent 拆解目标',
        agentId: 'orchestrator', status: 'running', toolCallIds: [], startedAt: summary ? at : r.startedAt });
      step = r.plan[r.plan.length - 1];
    }
    step.status = 'failed';
    step.endedAt = at;
    step.note = e.message.slice(0, 200);
    r.status = 'failed';
    r.endedAt = at;
    r.cursor.phase = 'done';
    r.live = undefined;
    r.failure = { stepId: step.id, message: e.message };
    for (const a of r.approvals) if (a.status === 'pending') { a.status = 'expired'; dropToasts(d, `approval:${a.id}`); }
    for (const c of r.toolCalls) if (c.status === 'running' || c.status === 'awaiting') Object.assign(c, { status: 'cancelled', endedAt: at });
    r.errors.push({ id: uid('err'), at, runId, stepId: step.id, title: step.title, code: e.code || 'ERROR', message: e.message.split('\n')[0].slice(0, 300), detail: e.message, fatal: true });
    const v = d.settings.persona ? d.settings.mode : undefined;
    t.messages.push({ id: uid('msg'), role: 'agent', agentId: 'orchestrator', runId, kind: 'error', at, persona: v,
      text: `${v ? `${eventLine(v, 'failed', d.settings.callName || '开拓者')}\n\n` : ''}第 ${step.index + 1} 步「${step.title}」失败：${e.message}` });
    pushEvent(d, { runId, kind: 'run', level: 'error', text: `运行 #${r.attempt} 失败：${step.title}`, refId: step.id });
    touch(d, t.id, at);
    toast(d, { tone: 'danger', title: '执行失败', body: `「${step.title}」：${e.message.split('\n')[0].slice(0, 120)}`, key: `run:${runId}`,
      action: { label: '查看错误', command: { type: 'open-console', tab: 'errors', taskId: t.id, runId } } });
    announce(d, `执行失败：${step.title}`);
    const following = d.view === 'task' && d.selectedTaskId === t.id;
    if (d.settings.openConsoleOnError && following) { d.console.open = true; d.console.tab = 'errors'; }
  });
  runCtx.delete(runId);
}

async function driveRun(runId: string, gen: number) {
  const c = ctxOf(runId);
  c.halt = undefined;
  try {
    if (!live(runId)?.planReady) {
      c.phase = 'plan';
      await planTurn(runId, gen);
      if (halted(runId, gen)) return;
    }
    for (let guard = 0; guard < 20; guard++) {
      const r = live(runId);
      if (!r || halted(runId, gen)) return;
      const i = r.plan.findIndex((st) => st.status === 'pending' || st.status === 'running' || st.status === 'awaiting');
      if (i < 0) break;
      c.phase = 'step';
      await stepTurn(runId, i, gen);
      if (halted(runId, gen)) return;
    }
    c.phase = 'summary';
    await summaryTurn(runId, gen);
  } catch (e) {
    const err = e as Error & { code?: string };
    if (!halted(runId, gen)) failLive(runId, err, c.phase);
    else if (gen === runCtx.get(runId)?.gen && live(runId)?.status === 'paused') {
      store.update((d) => { const r = d.runs[runId]; if (r) pushEvent(d, { runId, kind: 'run', level: 'info', text: `暂停时中断了当前调用：${err.message.slice(0, 80)}` }); });
    }
  }
}

/** Start (or restart after 继续) the driver loop — only once the previous loop has unwound. */
function launch(runId: string) {
  const c = ctxOf(runId);
  const gen = ++c.gen;
  const prev = c.driver ?? Promise.resolve();
  c.driver = prev.catch(() => {}).then(() => (runCtx.get(runId)?.gen === gen && !halted(runId) ? driveRun(runId, gen) : undefined));
}

/* ───────────── backend surface for live tasks ───────────── */

export function startLiveRun(taskId: string, retry?: { retryOf: string; mode: 'resume' | 'restart' }): Result<string> {
  const st = s();
  const task = st.tasks[taskId];
  if (!task?.engine) return fail('这个任务没有接入模型。');
  if (!desktop) return fail('需要桌面版才能调用模型。');
  const b = baseSpec(task.engine);
  if (!b.ok) return b;
  if (task.runIds.some((id) => OPEN.has(st.runs[id]?.status))) return fail('这个任务已有进行中的运行。');
  const prev = retry ? st.runs[retry.retryOf] : undefined;
  let id = '';
  store.update((d) => {
    const t = d.tasks[taskId];
    const at = now();
    if (retry) dropToasts(d, `run:${retry.retryOf}`);
    // 从头运行 starts fresh CLI conversations; 继续 keeps the agents' memory of what they did.
    if (!retry || retry.mode === 'restart') { t.session = undefined; t.agentSessions = undefined; }
    const run: Run = {
      id: uid('run'), taskId, attempt: t.runIds.length + 1, status: 'running', createdAt: at, startedAt: at, activeMs: 0,
      plan: [], planReady: false, toolCalls: [], approvals: [], artifacts: [], errors: [], terminal: [],
      // The model's window (1M for most of this generation); CLI agents compact on their own.
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextUsed: 0, contextLimit: contextOf(PROVIDER_BY_ID[t.engine!.provider], t.engine!.model).tokens, series: [] },
      cursor: { phase: 'planning', step: 0 },
      engineLabel: t.engine!.label,
      live: { agentId: 'orchestrator', activity: 'thinking', text: '准备开始' },
    };
    if (prev) {
      run.retryOf = prev.id;
      run.retryMode = retry!.mode;
      const real = prev.plan.filter((x) => !((x.title === '制定计划' || x.title === '汇总结果') && x.status === 'failed'));
      if (retry!.mode === 'resume' && prev.planReady && real.length) {
        run.planReady = true;
        run.cursor.phase = 'executing';
        run.plan = real.map((old, index) => (old.status === 'done'
          ? { ...old, id: uid('step'), index, toolCallIds: [], carried: true, note: `沿用第 ${prev.attempt} 次运行的结果` }
          : { id: uid('step'), index, title: old.title, detail: old.detail, agentId: old.agentId, status: 'pending', toolCallIds: [] }));
      }
    }
    // Agents with their own model (Agent page), as set now; one whose way is not ready falls back to the task's.
    const own: NonNullable<Run['agentEngines']> = {};
    const noFolder: string[] = [];
    for (const id of rosterOf(t as Task)) {
      if (id === 'orchestrator') continue;
      const e = agentEngine(d.models as AppState['models'], d.agents.find((a) => a.id === id)?.engine, { cwd: t.engine!.cwd, access: t.engine!.access, browser: t.engine!.browser });
      if (!e) continue;
      // A command-line agent works in the task's folder; a task made without one cannot host it.
      if (e.auth === 'cli' && !t.engine!.cwd) { noFolder.push(agentName(d, id)); continue; }
      own[id] = e;
    }
    if (Object.keys(own).length) run.agentEngines = own;
    // 继续 keeps an agent's session only if it is still on the same program (a Codex thread cannot be resumed by Claude Code).
    for (const [id, sid] of Object.entries(t.agentSessions ?? {})) {
      const was = prev?.agentEngines?.[id as AgentId];
      const now = own[id as AgentId];
      if (sid && (!was || !now || was.provider !== now.provider || was.driver !== now.driver || now.auth !== 'cli')) delete t.agentSessions![id as AgentId];
    }
    d.runs[run.id] = run;
    t.runIds.push(run.id);
    t.updatedAt = at;
    id = run.id;
    const carried = run.plan.filter((x) => x.carried).length;
    const skillNames = taskSkills(t as Task).map((x) => x.name);
    t.messages.push({ id: uid('msg'), role: 'system', runId: run.id, at,
      text: `${run.attempt > 1 ? `第 ${run.attempt} 次运行` : '开始运行'}（${t.engine!.label}${t.engine!.cwd ? ` · ${t.engine!.cwd}` : ''}）${carried ? `：前 ${carried} 步沿用上次结果` : ''}。${Object.entries(own).map(([id, e]) => `${agentName(d, id as AgentId)}用 ${e!.label}。`).join('')}${noFolder.length ? `${noFolder.join('、')}的命令行模型需要工作文件夹，这个任务没有，这次改用任务的模型。` : ''}${skillNames.length ? `可用技能：${skillNames.join('、')}。` : ''}${browserOn(t.engine as TaskEngine) ? '可以操作萤火浏览器。' : ''}` });
    term(run, 'sys', `# 运行 #${run.attempt} · ${t.engine!.label}${t.engine!.cwd ? ` · 工作文件夹 ${t.engine!.cwd}` : ''}`, at);
    pushEvent(d, { runId: run.id, kind: 'run', level: 'info', text: `运行 #${run.attempt} 开始：${t.title}` });
  });
  launch(id);
  return ok(id);
}

export function pauseLive(runId: string): Result {
  const r = live(runId);
  if (!r || (r.status !== 'running' && r.status !== 'awaiting')) return fail('只有运行中或等待确认的任务可以暂停。');
  const c = ctxOf(runId);
  c.halt = 'pause';
  if (c.streamId) void desktop?.stop(c.streamId, 'interrupt');
  store.update((d) => {
    const run = d.runs[runId];
    if (!run) return;
    run.pausedFrom = 'running';
    run.status = 'paused';
    run.pauseReason = 'user';
    if (run.live) run.live.activity = 'paused';
    const at = now();
    // The agent's question dies with the interrupted call; it will ask again after 继续.
    for (const a of run.approvals) if (a.status === 'pending') { a.status = 'expired'; dropToasts(d, `approval:${a.id}`); }
    for (const call of run.toolCalls) if (call.status === 'awaiting' || call.status === 'running') Object.assign(call, { status: 'cancelled', endedAt: at });
    for (const st of run.plan) if (st.status === 'awaiting') st.status = 'running';
    pushEvent(d, { runId, kind: 'run', level: 'info', text: `运行 #${run.attempt} 已暂停（当前调用已中断，继续时这一步会重新执行）` });
    touch(d, run.taskId, at);
  });
  c.approvals.clear();
  return ok(undefined);
}

export function resumeLive(runId: string): Result {
  const r = live(runId);
  if (!r || r.status !== 'paused') return fail('这个运行没有处于暂停状态。');
  const task = s().tasks[r.taskId];
  if (!task?.engine) return fail('这个任务没有接入模型。');
  const b = baseSpec(task.engine);
  if (!b.ok) return b;
  store.update((d) => {
    const run = d.runs[runId];
    if (!run) return;
    run.status = 'running';
    run.pauseReason = undefined;
    run.pausedFrom = undefined;
    run.live = { agentId: run.live?.agentId ?? 'orchestrator', activity: 'thinking', text: '继续执行' };
    pushEvent(d, { runId, kind: 'run', level: 'info', text: `运行 #${run.attempt} 继续` });
    touch(d, run.taskId, now());
    dropToasts(d, `run:${runId}`);
  });
  // The pause flag stopped the old loop; the new one must not see it (the generation check keeps
  // the old loop stopped while it unwinds).
  ctxOf(runId).halt = undefined;
  launch(runId);
  return ok(undefined);
}

export function cancelLive(runId: string): boolean {
  const r = live(runId);
  if (!r || !OPEN.has(r.status)) return false;
  const c = ctxOf(runId);
  c.halt = 'cancel';
  if (c.streamId) void desktop?.stop(c.streamId, 'kill');
  runCtx.delete(runId);
  return true;
}

export function decideLive(approvalId: string, decision: 'approve' | 'reject'): boolean {
  let runId = '';
  for (const r of Object.values(s().runs)) if (r.approvals.some((a) => a.id === approvalId && a.status === 'pending')) runId = r.id;
  if (!runId) return false;
  const pending = ctxOf(runId).approvals.get(approvalId);
  ctxOf(runId).approvals.delete(approvalId);
  if (pending) void desktop?.answer(pending.streamId, pending.requestId, decision === 'approve' ? 'allow' : 'deny', pending.input);
  store.update((d) => {
    const run = d.runs[runId];
    const a = run?.approvals.find((x) => x.id === approvalId);
    if (!run || !a) return;
    const at = now();
    a.status = pending ? (decision === 'approve' ? 'approved' : 'rejected') : 'expired';
    a.decidedAt = at;
    dropToasts(d, `approval:${a.id}`);
    const call = run.toolCalls.find((c) => c.id === a.toolCallId);
    if (call) {
      if (decision === 'approve' && pending) { call.status = 'running'; call.startedAt = at; }
      else Object.assign(call, { status: 'denied', endedAt: at, durationMs: 0, output: '你拒绝了这次调用，它没有执行。' });
    }
    const step = run.plan.find((x) => x.id === a.stepId);
    const more = run.approvals.some((x) => x.status === 'pending');
    if (step && step.status === 'awaiting' && !more) step.status = 'running';
    if (run.status === 'awaiting' && !more) {
      run.status = 'running';
      run.live = { agentId: a.agentId, activity: decision === 'approve' ? 'tool' : 'thinking', text: decision === 'approve' ? a.title : `已拒绝：${a.title}` };
    }
    pushEvent(d, { runId, kind: 'approval', level: decision === 'approve' ? 'success' : 'warn', text: `${decision === 'approve' ? '已批准' : '已拒绝'}：${a.title}`, refId: a.id });
    touch(d, run.taskId, at);
  });
  return true;
}

/** A message on a live work task: pass it to the running agent, or answer it after the run. */
export function messageLive(taskId: string, text: string): Result {
  const task = s().tasks[taskId];
  if (!task?.engine) return fail('这个任务没有接入模型。');
  const open = task.runIds.map((id) => s().runs[id]).find((r) => r && OPEN.has(r.status));
  const runId = open?.id ?? task.runIds[task.runIds.length - 1];
  const c = open ? runCtx.get(open.id) : undefined;
  const forward = !!(open && c?.streamId && c.supportsInput && open.status === 'running');
  store.update((d) => {
    const t = d.tasks[taskId];
    t.messages.push({ id: uid('msg'), role: 'user', runId, text, at: now(), delivered: forward || undefined });
    pushEvent(d, { runId, kind: 'user', level: 'info', text: '你发送了补充说明' });
    touch(d, taskId, now());
  });
  if (open) {
    if (forward) {
      void desktop?.input(c!.streamId!, `${callName()} 补充：${text}`);
      note(taskId, open.id, '已转达给正在执行的 Agent。');
    } else note(taskId, open.id, '这条补充会在下一步（或最后的汇报）交给 Agent。');
    return ok(undefined);
  }
  void reply(taskId, { followUp: true });
  return ok(undefined);
}

function note(taskId: string, runId: string | undefined, text: string) {
  store.update((d) => { d.tasks[taskId]?.messages.push({ id: uid('msg'), role: 'system', runId, text, at: now() }); });
}

/* ───────────── 闲聊 ───────────── */

export function isReplying(taskId: string) { return chatBusy.has(taskId); }

function chatHistory(task: Task, limit = 30) {
  const msgs = task.messages.filter((m) => (m.role === 'user' || m.role === 'agent') && m.text.trim() && !m.streaming).slice(-limit);
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of msgs) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${m.text}`;
    else out.push({ role, content: m.text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/** Reply to the latest message (chat tasks, or a follow-up on a finished work task). */
export async function reply(taskId: string, opts: { nudge?: boolean; greet?: boolean; followUp?: boolean } = {}) {
  const task = s().tasks[taskId];
  if (!task) return;
  if (chatBusy.has(taskId)) return;
  const engine = task.engine;
  const v = voice();
  if (!engine) {
    // Greetings and nudges need a model too; only a message the user sent deserves an answer here.
    if (!opts.greet && !opts.nudge) {
      store.update((d) => { d.tasks[taskId]?.messages.push({ id: uid('msg'), role: 'system', text: '这个对话还没有选模型。在下面选一个已接入的模型，或先到「模型接入」里接入一个。', at: now() }); });
    }
    return;
  }
  const b = baseSpec(engine);
  const purpose: PromptPurpose = opts.nudge || opts.greet ? 'nudge' : opts.followUp ? 'reply' : 'chat';
  const hint = opts.greet ? GREET_PROMPT : opts.nudge ? NUDGE_PROMPT : undefined;
  if (!b.ok) {
    store.update((d) => { d.tasks[taskId]?.messages.push({ id: uid('msg'), role: 'system', text: `没能回复：${b.error}`, at: now() }); });
    return;
  }
  const spec = b.value;
  const lastRun = task.runIds.length ? s().runs[task.runIds[task.runIds.length - 1]] : undefined;
  let system = systemPrompt(purpose, promptContext(task, purpose));
  if (opts.followUp && lastRun) {
    system += `\n\n这是一个工作任务的追问。任务目标：${task.goal}\n最近一次运行（#${lastRun.attempt}，${lastRun.status}）的结果：\n${lastRun.plan.map((st, i) => `${i + 1}. ${st.title}：${(st.result ?? st.note ?? st.status).slice(0, 600)}`).join('\n')}\n这次回复不能使用工具；如果需要再动手，请提醒对方点「重试」或「从头运行」。`;
  }
  // Everything said since her last answer (several messages can queue up while she replies).
  const lastAgent = task.messages.map((m) => m.role).lastIndexOf('agent');
  const userText = task.messages.slice(lastAgent + 1).filter((m) => m.role === 'user').map((m) => m.text).join('\n\n');
  // Replies never have tools, so skills come as text.
  const skillText = opts.nudge || opts.greet ? '' : skillsPrompt(task, true);
  system = withSkills(system, skillText);
  spec.skills = false;
  if (isApi(engine)) {
    spec.system = system;
    spec.messages = chatHistory(task);
    if (hint) spec.messages.push({ role: 'user', content: hint });
    if (!spec.messages.length) spec.messages = [{ role: 'user', content: hint ?? (userText || '你好') }];
    spec.maxTokens = engine.effort === 'off' ? 4096 : 16000;
  } else {
    spec.system = system;
    let prompt = hint ?? userText;
    // A new CLI session (model switched, 重新生成, first CLI turn) has not seen the conversation so far.
    const past = task.session ? '' : transcript(task, lastAgent + 1);
    if (past) prompt = `（下面是你们之前的对话记录，接着聊就好，不用复述。）\n\n${past}\n\n---\n\n${prompt}`;
    spec.prompt = prompt;
    spec.sessionId = task.session;
    spec.cwd = engine.cwd;
    policySpec(spec, engine, 'chat');
  }
  const started = now();
  chatBusy.set(taskId, 'starting');
  try {
    await runTurn({ task, runId: opts.followUp ? lastRun?.id : undefined, agentId: 'orchestrator', kind: opts.followUp ? 'reply' : undefined, spec, eager: true, chat: true });
  } catch (e) {
    store.update((d) => {
      d.tasks[taskId]?.messages.push({ id: uid('msg'), role: 'agent', agentId: 'orchestrator', kind: 'error', at: now(), persona: v,
        text: `${v === 'sam' ? '通信中断。' : v === 'firefly' ? '抱歉……我没能回复。' : '没能回复。'}${(e as Error).message}` });
      toast(d, { tone: 'danger', title: '回复失败', body: (e as Error).message.slice(0, 140), key: `chat:${taskId}` });
    });
  } finally {
    chatBusy.delete(taskId);
  }
  // Messages that arrived while she was replying (or greeting) get their own answer.
  const after = s().tasks[taskId];
  if (after && after.messages.some((m) => m.role === 'user' && m.at > started)) void reply(taskId, hint ? {} : opts);
}

/** The conversation before index `upTo`, as plain text for a CLI session that starts without it. */
function transcript(task: Task, upTo: number) {
  const name = callName();
  const lines = task.messages.slice(0, upTo)
    .filter((m) => (m.role === 'user' || m.role === 'agent') && m.text.trim() && !m.streaming && m.kind !== 'error')
    .slice(-30)
    .map((m) => `${m.role === 'user' ? name : '你'}：${m.text.trim()}`);
  const text = lines.join('\n\n');
  return text.length > 20000 ? `…${text.slice(-20000)}` : text;
}

/** Stop the reply being written in a chat (keeps what has arrived so far). */
export function stopReply(taskId: string) {
  const id = chatBusy.get(taskId);
  if (id && id !== 'starting') void desktop?.stop(id, 'kill');
}

/** Drop her last answer and ask again. */
export function regenerate(taskId: string) {
  const task = s().tasks[taskId];
  if (!task || chatBusy.has(taskId)) return;
  const lastUser = task.messages.map((m) => m.role).lastIndexOf('user');
  store.update((d) => {
    const t = d.tasks[taskId];
    if (!t) return;
    t.messages = t.messages.filter((m, i) => !(i > lastUser && m.role === 'agent'));
    // A CLI session still holds the dropped answer: start a new one (it gets the conversation as text).
    if (t.engine?.auth === 'cli') t.session = undefined;
  });
  void reply(taskId, lastUser < 0 ? { greet: true } : {});
}

/** The task is going away (deleted, or 清除所有任务记录): stop its runs and any reply being written. */
export function forgetTask(taskId: string) {
  const task = s().tasks[taskId];
  if (!task) return;
  for (const id of task.runIds) if (OPEN.has(s().runs[id]?.status)) cancelLive(id);
  stopReply(taskId);
  chatBusy.delete(taskId);
}

/* ───────────── reload ───────────── */

/** After a reload no stream survives: finish half-written bubbles and expire questions nobody can answer. */
export function normalizeAfterLoad(d: D) {
  for (const t of Object.values(d.tasks)) {
    t.messages = t.messages.filter((m) => !(m.streaming && !m.text.trim()));
    for (const m of t.messages) if (m.streaming) m.streaming = false;
  }
  for (const r of Object.values(d.runs)) {
    for (const a of r.approvals) if (a.status === 'pending') a.status = 'expired';
    for (const c of r.toolCalls) if (c.status === 'running' || c.status === 'awaiting') Object.assign(c, { status: 'cancelled' });
    for (const st of r.plan) if (st.status === 'awaiting') st.status = 'running';
    if (r.status === 'awaiting') { r.status = 'paused'; r.pausedFrom = 'running'; r.pauseReason = 'reload'; }
  }
}

export const personaName = (mode: VisualMode) => PERSONA[mode].name;
