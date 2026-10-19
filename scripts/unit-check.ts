/* Headless check of the pure logic behind the UI: npm run check:unit
   Tool categories, model names and menus, 推理强度, the run clock, pause / cancel, the agent and
   task actions, and the clean-up of saves that still hold 演示 data. Plain assertions, no test runner. */
import { isDeepStrictEqual } from 'node:util';
import { produce, type Draft } from 'immer';
import { effortLevels, effortRequest, type LiveModel } from '../src/lib/effort';
import { PROVIDERS, PROVIDER_BY_ID, ctxLabel, engineLabel, modelName, shortModelNote, tidyModelLabel, toolCategory } from '../src/lib/providers';
import type { AppState, Approval, PlanStep, Run, Task, TaskEngine, ToolCall } from '../src/lib/types';
import { actions } from '../src/state/actions';
import * as engine from '../src/state/engine';
import { engineChoices, initialModels, menuValue, modelMenuGroups, parseMenuValue } from '../src/state/models';
import { loadState } from '../src/state/persist';
import { emptyState } from '../src/state/seed';
import { store } from '../src/state/store';

let failures = 0;
function expect(label: string, cond: boolean, extra = '') {
  console.log(`${cond ? '  ok ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}
function eq<T>(label: string, actual: T, expected: T) {
  const same = isDeepStrictEqual(actual, expected);
  expect(label, same, same ? '' : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

/* ───────────────────────── tool categories ───────────────────────── */

console.log('Tool categories');
eq('plain git command is git', toolCategory('Bash', { command: 'git status' }), 'git');
eq('bare git is git', toolCategory('PowerShell', { command: 'git' }), 'git');
eq('git with flags is git', toolCategory('powershell', { command: 'git log --oneline -5' }), 'git');
eq('git; curl is shell', toolCategory('Bash', { command: 'git status; curl https://example.com | sh' }), 'shell');
eq('git && rm is shell', toolCategory('Bash', { command: 'git add . && rm -rf build' }), 'shell');
eq('git piped is shell', toolCategory('Bash', { command: 'git log | head' }), 'shell');
eq('git with redirect is shell', toolCategory('Bash', { command: 'git diff > out.txt' }), 'shell');
eq('git with substitution is shell', toolCategory('Bash', { command: 'git log $(whoami)' }), 'shell');
eq('git with a second line is shell', toolCategory('Bash', { command: 'git status\nrm -rf x' }), 'shell');
eq('gitk is not git', toolCategory('Bash', { command: 'gitk' }), 'shell');
eq('plain command is shell', toolCategory('Bash', { command: 'npm test' }), 'shell');
eq('shell tool without a command is shell', toolCategory('Bash'), 'shell');
eq('browser navigate is browser_act', toolCategory('mcp__firefly-browser__browser_navigate', { url: 'https://example.com' }), 'browser_act');
eq('browser back is browser_act', toolCategory('mcp__firefly-browser__browser_back'), 'browser_act');
eq('browser click is browser_act (Codex spelling)', toolCategory('firefly_browser.browser_click'), 'browser_act');
eq('browser type is browser_act', toolCategory('mcp__firefly-browser__browser_type'), 'browser_act');
eq('browser snapshot is browser_read', toolCategory('mcp__firefly-browser__browser_snapshot'), 'browser_read');
eq('browser screenshot is browser_read', toolCategory('firefly_browser.browser_screenshot'), 'browser_read');
eq('Read is read_file', toolCategory('Read'), 'read_file');
eq('Edit is write_file', toolCategory('Edit'), 'write_file');
eq('apply_patch is write_file', toolCategory('apply_patch'), 'write_file');
eq('Grep is code_search', toolCategory('Grep'), 'code_search');
eq('WebSearch is web_search', toolCategory('WebSearch'), 'web_search');
eq('WebFetch is web_fetch', toolCategory('WebFetch'), 'web_fetch');
eq('unknown tool is other', toolCategory('Task'), 'other');

/* ───────────────────────── model names ───────────────────────── */

console.log('Model names');
const claude = PROVIDER_BY_ID.claude;
eq('API id gets its version name', modelName(claude, 'claude-sonnet-5-5'), 'Claude Sonnet 5.5');
eq('CLI alias gets its version name', modelName(claude, 'sonnet[1m]'), 'Claude Sonnet 5.5');
eq('alias with [1m] on an API id', modelName(claude, 'claude-sonnet-5-5[1m]'), 'Claude Sonnet 5.5');
eq('opus alias', modelName(claude, 'opus[1m]'), 'Claude Opus 5.5');
eq('unknown model shows its id', modelName(claude, 'my-model'), 'my-model');
eq('empty model stays empty', modelName(claude, ''), '');
eq('GPT', modelName(PROVIDER_BY_ID.gpt, 'gpt-6.1-sol'), 'GPT-6.1 Sol');
eq('DeepSeek', modelName(PROVIDER_BY_ID.deepseek, 'deepseek-flash'), 'DeepSeek V4.1 Flash');
eq('Kimi', modelName(PROVIDER_BY_ID.kimi, 'kimi-k3'), 'Kimi K3');
eq('Qwen', modelName(PROVIDER_BY_ID.qwen, 'qwen3.8-max'), 'Qwen3.8 Max');
eq('GLM', modelName(PROVIDER_BY_ID.glm, 'glm-5.3'), 'GLM-5.3');
eq('MiniMax', modelName(PROVIDER_BY_ID.minimax, 'MiniMax-M3'), 'MiniMax M3');
eq('豆包', modelName(PROVIDER_BY_ID.doubao, 'doubao-seed-2-1-pro-260915'), '豆包 Seed 2.1 Pro');
expect('every catalog model has a name', PROVIDERS.every((p) => [...p.models, ...Object.values(p.cliModels).flat()].every((m) => !m || !m.id || !!m.label)));

console.log('Engine labels');
eq('CLI with a model', engineLabel(claude, 'cli', 'claude-code', 'sonnet[1m]'), 'Claude Sonnet 5.5 · Claude Code');
eq('CLI that picks the model itself', engineLabel(PROVIDER_BY_ID.gpt, 'cli', 'codex', ''), 'GPT · Codex CLI');
eq('API', engineLabel(PROVIDER_BY_ID.deepseek, 'api', undefined, 'deepseek-flash'), 'DeepSeek V4.1 Flash · API');
eq('compatible endpoint', engineLabel(PROVIDER_BY_ID.kimi, 'cli', 'claude-compat', 'kimi-k3'), 'Kimi K3 · Claude Code（兼容端点）');
eq('CLI without a driver uses the vendor first one', engineLabel(claude, 'cli', undefined, ''), 'Claude · Claude Code');

console.log('Context labels');
eq('1M', ctxLabel(1_000_000), '1M 上下文');
eq('256K', ctxLabel(256_000), '256K 上下文');
eq('1.05M reads as 1M (rounded down to a tenth)', ctxLabel(1_050_000), '1M 上下文');
eq('1.5M keeps its decimal', ctxLabel(1_500_000), '1.5M 上下文');
eq('a CLI name in catalog style', tidyModelLabel('GPT-5.6-Sol'), 'GPT-5.6 Sol');
eq('an English blurb becomes a short note', shortModelNote('Older generation workhorse model.'), '上一代');
eq('an unknown English blurb is dropped', shortModelNote('Something else entirely.'), undefined);
eq('undefined is empty', ctxLabel(undefined), '');
eq('0 is empty', ctxLabel(0), '');

/* ───────────────────────── 推理强度 ───────────────────────── */

console.log('Effort levels');
eq('Sonnet 5.5 API can switch thinking off', effortLevels('claude', 'api', undefined, 'claude-sonnet-5-5'), ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
eq('Opus 5.5 API cannot', effortLevels('claude', 'api', undefined, 'claude-opus-5-5'), ['low', 'medium', 'high', 'xhigh', 'max']);
eq('Claude Code', effortLevels('claude', 'cli', 'claude-code', 'sonnet[1m]'), ['low', 'medium', 'high', 'xhigh', 'max']);
eq('Claude Code on another vendor', effortLevels('kimi', 'cli', 'claude-compat', 'kimi-k3'), ['low', 'medium', 'high', 'xhigh', 'max']);
eq('GPT Luna can switch off', effortLevels('gpt', 'api', undefined, 'gpt-6-luna').includes('off'), true);
eq('GPT Astra cannot', effortLevels('gpt', 'api', undefined, 'gpt-6-astra').includes('off'), false);
eq('DeepSeek', effortLevels('deepseek', 'api', undefined, 'deepseek-flash'), ['off', 'low', 'high', 'max']);
eq('Kimi K3', effortLevels('kimi', 'api', undefined, 'kimi-k3'), ['low', 'high', 'max']);
eq('Kimi K2.7 Code takes none', effortLevels('kimi', 'api', undefined, 'kimi-k2.7-code'), []);
eq('Qwen3.8', effortLevels('qwen', 'api', undefined, 'qwen3.8-max'), ['off', 'low', 'medium', 'xhigh']);
eq('GLM', effortLevels('glm', 'api', undefined, 'glm-5.3'), ['low', 'high', 'max']);
eq('豆包', effortLevels('doubao', 'api', undefined, 'doubao-seed-2-1-pro-260915'), ['off', 'low', 'medium', 'high']);
eq('ACP tools cannot be tuned', effortLevels('kimi', 'cli', 'kimi', ''), []);
const codexLive: LiveModel[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high', 'ultra', 'bogus'] },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low'], isDefault: true },
];
eq('Codex lists what the account offers (unknown levels dropped)', effortLevels('gpt', 'cli', 'codex', 'gpt-6.1-sol', codexLive), ['low', 'medium', 'high', 'ultra']);
eq('Codex default model uses the default entry', effortLevels('gpt', 'cli', 'codex', '', codexLive), ['low']);
eq('Codex without a live list falls back', effortLevels('gpt', 'cli', 'codex', 'gpt-6.1-sol'), ['low', 'medium', 'high', 'xhigh', 'max']);

console.log('Effort requests');
const summarized = { thinking: { type: 'adaptive', display: 'summarized' } };
eq('Claude API default still asks for a thinking summary', effortRequest('claude', 'api', 'claude-sonnet-5-5', undefined), { extraBody: summarized });
eq('GPT API default sends nothing', effortRequest('gpt', 'api', 'gpt-6-astra', undefined), {});
eq('Claude API level', effortRequest('claude', 'api', 'claude-opus-5-5', 'high'), { extraBody: { ...summarized, output_config: { effort: 'high' } } });
eq('Haiku API off disables thinking', effortRequest('claude', 'api', 'claude-haiku-5-5', 'off'), { extraBody: { thinking: { type: 'disabled' }, output_config: { effort: 'low' } } });
eq('a level the model does not take is not sent', effortRequest('claude', 'api', 'claude-opus-5-5', 'off'), {});
eq('GPT Luna off is "none"', effortRequest('gpt', 'api', 'gpt-6-luna', 'off'), { extraBody: { reasoning_effort: 'none' } });
eq('DeepSeek level', effortRequest('deepseek', 'api', 'deepseek-flash', 'max'), { extraBody: { thinking: { type: 'enabled' }, reasoning_effort: 'max' } });
eq('DeepSeek off', effortRequest('deepseek', 'api', 'deepseek-flash', 'off'), { extraBody: { thinking: { type: 'disabled' } } });
eq('Qwen3.8 level', effortRequest('qwen', 'api', 'qwen3.8-max', 'xhigh'), { extraBody: { enable_thinking: true, reasoning_effort: 'xhigh' } });
eq('Qwen3.7 takes no level', effortRequest('qwen', 'api', 'qwen3.7-plus', 'medium'), {});
eq('CLI passes the level as a flag', effortRequest('claude', 'cli', 'sonnet[1m]', 'xhigh'), { effort: 'xhigh' });
eq('CLI default sends nothing', effortRequest('claude', 'cli', '', undefined), {});
expect('CLI off sends no flag', effortRequest('gpt', 'cli', '', 'off').effort === undefined);

/* ───────────────────────── model menu ───────────────────────── */

console.log('Model menu values');
eq('menuValue joins key and model', menuValue('claude:cli', 'sonnet[1m]'), 'claude:cli|sonnet[1m]');
eq('round trip', parseMenuValue(menuValue('claude:cli', 'sonnet[1m]')), { key: 'claude:cli', model: 'sonnet[1m]' });
eq('round trip with the tool default', parseMenuValue(menuValue('gpt:cli', '')), { key: 'gpt:cli', model: '' });
eq('round trip with a "|" in the model', parseMenuValue(menuValue('qwen:api', 'a|b')), { key: 'qwen:api', model: 'a|b' });
const models = initialModels();
eq('no model is ready on a fresh install', engineChoices(models).length, 0);
eq('so the menu is empty', modelMenuGroups(models).length, 0);
models.providers.claude.keyHint = '••••abcd';
models.providers.deepseek.keyHint = '••••wxyz';
const groups = modelMenuGroups(models);
eq('one group per ready way', groups.map((g) => g.label), ['Claude · API', 'DeepSeek · API']);
expect('every entry parses back to its group key', groups.every((g, i) => g.options.every((o) => parseMenuValue(o.value).key === engineChoices(models)[i].key)));
expect('entries show version names', groups[0].options.some((o) => o.label === 'Claude Sonnet 5.5') && groups[1].options.some((o) => o.label === 'DeepSeek V4.1 Flash'));

/* ───────────────────────── fixtures ───────────────────────── */

const CLAUDE_CLI: TaskEngine = { kind: 'live', provider: 'claude', auth: 'cli', driver: 'claude-code', model: 'sonnet[1m]', label: 'Claude Sonnet 5.5 · Claude Code', cwd: 'C:/work' };

const mkTask = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: id, goal: 'goal', createdAt: 0, updatedAt: 0, agentIds: ['orchestrator'], runIds: [], messages: [], engine: CLAUDE_CLI, ...extra,
});
const mkStep = (id: string, index: number, status: PlanStep['status']): PlanStep => ({ id, index, title: id, detail: '', agentId: 'orchestrator', status, toolCallIds: [] });
const mkCall = (id: string, runId: string, stepId: string, status: ToolCall['status']): ToolCall => ({
  id, runId, stepId, agentId: 'orchestrator', tool: 'shell', title: id, input: {}, status, startedAt: 0,
});
const mkApproval = (id: string, run: Run, stepId: string, toolCallId: string): Approval => ({
  id, runId: run.id, taskId: run.taskId, stepId, toolCallId, agentId: 'orchestrator', tool: 'shell', title: id, reason: '', preview: '', previewKind: 'command',
  risk: 'high', status: 'pending', createdAt: 0,
});
const mkRun = (id: string, taskId: string, status: Run['status'], extra: Partial<Run> = {}): Run => ({
  id, taskId, attempt: 1, status, createdAt: 0, startedAt: 0, activeMs: 0, plan: [], planReady: true, toolCalls: [], approvals: [], artifacts: [], errors: [], terminal: [],
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextUsed: 0, contextLimit: 1_000_000, series: [] },
  cursor: { phase: 'executing', step: 0 }, ...extra,
});

/* ───────────────────────── run clock, pause, cancel ───────────────────────── */

console.log('Run clock');
let s: AppState = emptyState(0);
const upd = (fn: (d: Draft<AppState>) => void) => { s = produce(s, fn); };
upd((d) => {
  d.tasks.t1 = mkTask('t1', { runIds: ['r1', 'r2', 'r3', 'r4'] });
  d.taskOrder = ['t1'];
  d.runs.r1 = mkRun('r1', 't1', 'running', { plan: [mkStep('s1', 0, 'running'), mkStep('s2', 1, 'pending')] });
  d.runs.r2 = mkRun('r2', 't1', 'running', { planReady: false, cursor: { phase: 'planning', step: 0 } });
  d.runs.r3 = mkRun('r3', 't1', 'paused', { pausedFrom: 'running', pauseReason: 'user', plan: [mkStep('s1', 0, 'running')] });
  d.runs.r4 = mkRun('r4', 't1', 'awaiting', { plan: [mkStep('s1', 0, 'awaiting')] });
});
expect('the clock runs while a run is running', engine.needsTick(s));
for (let i = 0; i < 5; i++) upd((d) => engine.tick(d, 0, 200));
expect('a running run counts its time', s.runs.r1.activeMs === 1000, String(s.runs.r1.activeMs));
expect('and the step it works on', s.runs.r1.plan[0].activeMs === 1000);
expect('not the steps still waiting', s.runs.r1.plan[1].activeMs === undefined);
expect('planning counts for the run only', s.runs.r2.activeMs === 1000 && s.runs.r2.plan.length === 0);
expect('a paused run stands still', s.runs.r3.activeMs === 0 && s.runs.r3.plan[0].activeMs === undefined);
expect('so does one waiting for an approval', s.runs.r4.activeMs === 0);
upd((d) => { d.runs.r1.status = 'completed'; d.runs.r2.status = 'completed'; });
expect('no clock when nothing is running', !engine.needsTick(s));

console.log('Pause');
upd((d) => { d.runs.r1.status = 'running'; d.runs.r1.live = { agentId: 'orchestrator', activity: 'tool', text: 'x' }; d.runs.r2.status = 'running'; });
upd((d) => { d.tasks.t1.updatedAt = 5; });
let paused = false;
upd((d) => { paused = engine.pauseRun(d, d.runs.r1, 'user', 100); });
expect('pause by the user', paused && s.runs.r1.status === 'paused' && s.runs.r1.pauseReason === 'user' && s.runs.r1.pausedFrom === 'running');
expect('the run shows as paused', s.runs.r1.live?.activity === 'paused');
expect('the task counts as updated', s.tasks.t1.updatedAt === 100);
upd((d) => { paused = engine.pauseRun(d, d.runs.r1, 'user', 200); });
expect('a paused run cannot be paused again', !paused);
upd((d) => { paused = engine.pauseRun(d, d.runs.r2, 'reload', 300); });
expect('pause on reload', paused && s.runs.r2.pauseReason === 'reload' && s.events.at(-1)?.text.includes('页面重新载入') === true);
expect('a reload does not touch the task', s.tasks.t1.updatedAt === 100);

console.log('Cancel');
upd((d) => {
  d.runs.r4.plan = [mkStep('s1', 0, 'awaiting'), mkStep('s2', 1, 'pending'), mkStep('s3', 2, 'done')];
  d.runs.r4.toolCalls = [mkCall('c1', 'r4', 's1', 'awaiting'), mkCall('c2', 'r4', 's3', 'ok')];
  d.runs.r4.approvals = [mkApproval('a1', d.runs.r4 as Run, 's1', 'c1')];
  d.runs.r4.live = { agentId: 'orchestrator', activity: 'waiting', text: 'x' };
  engine.toast(d, { tone: 'warning', title: '需要你的确认', key: 'approval:a1' });
  engine.toast(d, { tone: 'info', title: '继续', action: { label: '继续运行', command: { type: 'resume-run', runId: 'r4' } } });
  engine.toast(d, { tone: 'info', title: '别的运行', action: { label: '继续运行', command: { type: 'resume-run', runId: 'r3' } } });
});
let cancelled = false;
upd((d) => { cancelled = engine.cancelRun(d, d.runs.r4, 900); });
const r4 = s.runs.r4;
expect('run is cancelled', cancelled && r4.status === 'cancelled' && r4.endedAt === 900 && r4.cursor.phase === 'done' && !r4.live);
eq('open steps are cancelled, finished ones stay', r4.plan.map((p) => p.status), ['cancelled', 'cancelled', 'done']);
eq('open calls are cancelled, finished ones stay', r4.toolCalls.map((c) => c.status), ['cancelled', 'ok']);
expect('a pending approval expires', r4.approvals[0].status === 'expired');
expect('its toast is gone', !s.toasts.some((t) => t.key === 'approval:a1'));
expect('so is the toast that would resume it, but not another run\'s', !s.toasts.some((t) => t.action?.command.type === 'resume-run' && t.action.command.runId === 'r4')
  && s.toasts.some((t) => t.action?.command.type === 'resume-run' && t.action.command.runId === 'r3'));
const note = s.tasks.t1.messages.at(-1);
expect('the cancel note is a plain system message', note?.role === 'system' && note.runId === 'r4' && !('simulated' in note) && note.text.includes('已取消'));
upd((d) => { cancelled = engine.cancelRun(d, d.runs.r4, 1000); });
expect('a finished run cannot be cancelled again', !cancelled);

console.log('Events, toasts');
upd((d) => { for (let i = 0; i < engine.EVENT_CAP + 20; i++) engine.pushEvent(d, { kind: 'user', level: 'info', text: `e${i}` }); });
expect('the event log is capped, newest kept', s.events.length === engine.EVENT_CAP && s.events.at(-1)?.text === `e${engine.EVENT_CAP + 19}`);
upd((d) => { d.toasts = []; for (let i = 0; i < 5; i++) engine.toast(d, { tone: 'info', title: `t${i}` }); });
expect('at most three toasts', s.toasts.length === 3 && s.toasts.at(-1)?.title === 't4');
upd((d) => { engine.toast(d, { tone: 'info', title: 'a', key: 'k' }); engine.toast(d, { tone: 'info', title: 'b', key: 'k' }); });
expect('a newer toast replaces the one with the same key', s.toasts.filter((t) => t.key === 'k').length === 1 && s.toasts.find((t) => t.key === 'k')?.title === 'b');
upd((d) => engine.dropToasts(d, 'k'));
expect('and can be dropped by key', !s.toasts.some((t) => t.key === 'k'));
upd((d) => { engine.announce(d, '你好'); });
expect('announcements replace each other', s.announcement.text === '你好');
expect('findApproval looks through every run', engine.findApproval(s, 'a1')?.run.id === 'r4' && engine.findApproval(s, 'nope') === undefined);

/* ───────────────────────── actions ───────────────────────── */

console.log('Actions');
store.init(emptyState(0));
const orchestratorBefore = store.get().agents[0];
actions.setAgentEngine('orchestrator', { key: 'claude:cli', model: '' });
expect('the 编排 Agent cannot get its own model', store.get().agents[0].engine === undefined && store.get().agents[0] === orchestratorBefore);
const own = { key: 'deepseek:api', model: 'deepseek-flash', effort: 'high' as const };
actions.setAgentEngine('coder', own);
eq('another agent can', store.get().agents.find((a) => a.id === 'coder')?.engine, own);
actions.setAgentEngine('coder', undefined);
expect('and go back to the task\'s model', store.get().agents.find((a) => a.id === 'coder')?.engine === undefined);
actions.setAgentTools('coder', ['shell', 'read_file', 'bogus' as never]);
eq('tools are kept in the usual order, unknown ones dropped', store.get().agents.find((a) => a.id === 'coder')?.tools, ['read_file', 'shell']);

const noModel = actions.createTask({ title: '', goal: '写点东西', kind: 'chat', agentIds: [], start: true });
expect('a task without a model is created but not started', store.get().tasks[noModel].engine === undefined && store.get().tasks[noModel].runIds.length === 0);
expect('and the user is pointed to 模型接入', store.get().toasts.some((t) => t.action?.command.type === 'navigate' && t.action.command.view === 'models'));
const made = actions.createTask({ title: '整理文档', goal: '整理一下文档', kind: 'work', engine: CLAUDE_CLI, agentIds: [], start: false });
const madeTask = store.get().tasks[made];
expect('a work task keeps its model and defaults to the 编排 Agent', madeTask.engine?.label === CLAUDE_CLI.label && madeTask.agentIds.join() === 'orchestrator');
expect('and carries no demo fields', !('scenarioId' in madeTask) && !('source' in madeTask) && !('simulated' in madeTask.messages[0]));

store.update((d) => {
  d.settings.callName = '小明';
  d.tools.find((t) => t.id === 'shell')!.permission = 'off';
  d.runs.rx = mkRun('rx', made, 'completed');
  d.tasks[made].runIds.push('rx');
  engine.pushEvent(d, { runId: 'rx', kind: 'run', level: 'info', text: 'x' });
  engine.toast(d, { tone: 'info', title: '去看看', action: { label: '打开', command: { type: 'open-task', taskId: made } } });
  engine.toast(d, { tone: 'info', title: '去设置', action: { label: '模型接入', command: { type: 'navigate', view: 'models' } } });
  d.selectedTaskId = made;
  d.view = 'task';
});
actions.openDialog({ kind: 'clear-history' });
expect('the confirm dialog opens', store.get().dialog?.kind === 'clear-history');
actions.confirmDialog();
const cleared = store.get();
expect('clearing history removes tasks, runs and events', Object.keys(cleared.tasks).length === 0 && cleared.taskOrder.length === 0 && Object.keys(cleared.runs).length === 0 && cleared.events.length === 0);
expect('and leaves the open task view', cleared.selectedTaskId === undefined && cleared.view === 'tasks' && cleared.dialog === undefined);
expect('but keeps settings, tool policies and agents', cleared.settings.callName === '小明' && cleared.tools.find((t) => t.id === 'shell')?.permission === 'off' && cleared.agents.length === 4);
expect('toasts about the removed tasks are gone, the others stay', !cleared.toasts.some((t) => t.action?.command.type === 'open-task') && cleared.toasts.some((t) => t.action?.command.type === 'navigate'));

/* ───────────────────────── saved data ───────────────────────── */

console.log('Loading saves');
const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } },
});
const KEY = 'firefly-harness/v1';
const PREFS = 'firefly-harness/prefs';

let st = loadState(1_000);
expect('a fresh install is empty', Object.keys(st.tasks).length === 0 && st.taskOrder.length === 0 && st.events.length === 0 && !('connections' in st));
expect('with no model chosen', st.models.defaultEngine === '' && engineChoices(st.models).length === 0);
expect('and agents without a model of their own', st.agents.every((a) => a.engine === undefined && !('model' in a)));

// A save from the demo days: two tasks without a model, one real task with a leftover demo run, and old preferences.
const legacyEngine = { kind: 'live', provider: 'claude', auth: 'cli', driver: 'claude-code', model: 'sonnet[1m]', label: 'Claude Sonnet 5.5 · Claude Code', cwd: 'C:/work' };
const legacyRun = (id: string, taskId: string, source: string, status: string, extra: Record<string, unknown> = {}) => ({
  ...mkRun(id, taskId, status as Run['status'], extra as Partial<Run>),
  source, fixStepIndex: 3, cursor: { phase: 'executing', step: 1, beat: 2, beatElapsed: 40, beatStarted: true },
  toolCalls: [{ ...mkCall(`${id}_c`, id, 's', 'ok'), simulated: source !== 'live', expectedMs: 900 }],
  artifacts: [{ id: `${id}_a`, runId: id, stepId: 's', name: 'a.md', kind: 'report', content: 'x', createdAt: 0, simulated: source !== 'live' }],
});
const legacy = {
  version: 1,
  tasks: {
    t_demo: { ...mkTask('t_demo', { runIds: ['r_demo'] }), engine: undefined, scenarioId: 'refactor', source: 'sample' },
    t_sim: { ...mkTask('t_sim'), engine: undefined, scenarioId: 'general', source: 'simulated' },
    t_real: {
      ...mkTask('t_real', { runIds: ['r_real', 'r_old'] }), engine: legacyEngine, scenarioId: 'general', source: 'live',
      messages: [
        { id: 'm1', role: 'user', text: '整理文档', at: 1, simulated: false },
        { id: 'm2', role: 'system', text: '已切换到 演示模式。', at: 2, simulated: true },
        { id: 'm3', role: 'agent', text: '好的', at: 3, simulated: false, live: true },
        { id: 'm4', role: 'agent', text: '（模拟回复）', at: 4, runId: 'r_old', simulated: true },
        { id: 'm5', role: 'system', text: '开始运行', at: 5, runId: 'r_real', simulated: false },
      ],
    },
  },
  taskOrder: ['t_real', 't_sim', 't_demo'],
  runs: {
    r_demo: legacyRun('r_demo', 't_demo', 'sample', 'completed'),
    r_old: legacyRun('r_old', 't_real', 'simulated', 'completed'),
    r_real: legacyRun('r_real', 't_real', 'live', 'running', { plan: [mkStep('s', 0, 'running')] }),
  },
  events: [
    { id: 'e1', at: 1, runId: 'r_real', kind: 'run', level: 'info', text: '运行 #1 开始' },
    { id: 'e2', at: 2, runId: 'r_demo', kind: 'run', level: 'info', text: '演示运行' },
    { id: 'e3', at: 3, kind: 'connection', level: 'error', text: '模型网关连接已断开' },
    { id: 'e4', at: 4, kind: 'user', level: 'info', text: '你发送了补充说明（模拟）' },
    { id: 'e5', at: 5, kind: 'user', level: 'info', text: '新建任务：整理文档' },
  ],
};
const legacyPrefs = {
  settingsRev: 2, policyRev: 2,
  settings: { mode: 'sam', callName: '小明', simSpeed: 4, injectFailure: true, wallpaper: 'yes' },
  navCollapsed: true,
  console: { open: false, height: 300, tab: 'tools' },
  tools: [{ id: 'shell', permission: 'off' }],
  agents: [
    { id: 'orchestrator', enabled: false, model: 'claude-opus-5-5' },
    { id: 'coder', enabled: false, model: 'claude-sonnet-5-5' },
    { id: 'reviewer', enabled: true, model: 'claude-haiku-5-5' },
  ],
  models: { providers: {}, defaultEngine: 'demo' },
};
mem.set(KEY, JSON.stringify(legacy));
mem.set(PREFS, JSON.stringify(legacyPrefs));
st = loadState(2_000);
eq('only the real task survives', Object.keys(st.tasks), ['t_real']);
eq('in the task list too', st.taskOrder, ['t_real']);
eq('and only its real run', Object.keys(st.runs), ['r_real']);
eq('the task forgets the demo run', st.tasks.t_real.runIds, ['r_real']);
eq('demo messages are gone, real ones stay', st.tasks.t_real.messages.map((m) => m.id), ['m1', 'm3', 'm5']);
expect('removed fields are stripped', !('scenarioId' in st.tasks.t_real) && !('source' in st.tasks.t_real) && st.tasks.t_real.messages.every((m) => !('simulated' in m) && !('live' in m)));
const rr = st.runs.r_real as unknown as Record<string, unknown>;
expect('runs lose their simulator fields', !('source' in rr) && !('fixStepIndex' in rr) && isDeepStrictEqual(st.runs.r_real.cursor, { phase: 'executing', step: 1 })
  && st.runs.r_real.toolCalls.every((c) => !('simulated' in c) && !('expectedMs' in c)) && st.runs.r_real.artifacts.every((a) => !('simulated' in a)));
expect('a run that was going is paused, not resumed', st.runs.r_real.status === 'paused' && st.runs.r_real.pauseReason === 'reload');
eq('events of demo runs and connections are gone', st.events.map((e) => e.id).filter((id) => /^e\d$/.test(id)), ['e1', 'e5']);
eq('preferences keep the known settings', [st.settings.mode, st.settings.callName], ['sam', '小明']);
expect('and drop the removed or malformed ones', !('simSpeed' in st.settings) && !('injectFailure' in st.settings) && st.settings.wallpaper === true);
expect('tool policy is restored', st.tools.find((t) => t.id === 'shell')?.permission === 'off' && st.navCollapsed);
expect('the old default "demo" becomes none', st.models.defaultEngine === '');
const byId = (id: string) => st.agents.find((a) => a.id === id)!;
expect('agents keep enabled; the 编排 Agent stays on', byId('orchestrator').enabled && !byId('coder').enabled && byId('reviewer').enabled);
expect('the old per-agent model is dropped', st.agents.every((a) => a.engine === undefined && !('model' in a)));

// A save in the current format: nothing is cleaned, agent models are validated.
const current = {
  version: 1, rev: 2,
  tasks: { t_a: mkTask('t_a'), t_b: mkTask('t_b', { engine: undefined }) },
  taskOrder: ['t_a', 't_b'], runs: {}, events: [],
};
mem.set(KEY, JSON.stringify(current));
mem.set(PREFS, JSON.stringify({
  settingsRev: 2, policyRev: 2, settings: { mode: 'firefly' }, navCollapsed: false, console: { open: false, height: 280, tab: 'tools' }, tools: [],
  agents: [
    { id: 'orchestrator', enabled: true, engine: { key: 'claude:cli', model: '' } },
    { id: 'researcher', enabled: true, engine: { key: 'nope:cli', model: 'x' } },
    { id: 'coder', enabled: true, tools: ['read_file', 'bogus', 'shell'], engine: { key: 'deepseek:api', model: 'deepseek-flash', effort: 'high' } },
    { id: 'reviewer', enabled: true, engine: { key: 'gpt:xyz', model: '' } },
  ],
}));
st = loadState(3_000);
eq('a current save is kept as it is', Object.keys(st.tasks), ['t_a', 't_b']);
expect('the 编排 Agent never gets a model', byId('orchestrator').engine === undefined);
eq('a saved agent model is restored', byId('coder').engine, { key: 'deepseek:api', model: 'deepseek-flash', effort: 'high' });
expect('unknown vendors and ways are dropped', byId('researcher').engine === undefined && byId('reviewer').engine === undefined);
eq('saved agent tools are validated', byId('coder').tools, ['read_file', 'shell']);
expect('tools never saved keep their defaults', byId('researcher').tools.includes('web_search'));

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
