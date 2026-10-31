/* Headless check of the pure logic behind the UI: npm run check:unit
   Tool categories, model names and menus, 推理强度, the run clock, pause / cancel, the agent and
   task actions, the clean-up of saves that still hold 演示 data, and how the desktop side finds
   DeepSeek Harness. Plain assertions, no test runner. */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { format as formatUrl, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { produce, type Draft } from 'immer';
import { effortLevels, effortRequest, type LiveModel } from '../src/lib/effort';
import { PROVIDERS, PROVIDER_BY_ID, ctxLabel, engineLabel, modelName, shortModelNote, tidyModelLabel, toolCategory } from '../src/lib/providers';
import type { AppState, Approval, PlanStep, Run, Task, TaskEngine, ToolCall } from '../src/lib/types';
import { actions } from '../src/state/actions';
import * as engine from '../src/state/engine';
import { engineChoices, initialModels, menuValue, modelMenuGroups, parseMenuValue, petThrift } from '../src/state/models';
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

console.log('桌宠 picks the cheapest vision model');
eq('MiniMax M3 is a flagship, not the cheapest tier', petThrift('旗舰', 'MiniMax-M3'), 3);
eq('even without its note, "minimax" does not read as "mini"', petThrift(undefined, 'MiniMax-M3'), 3);
eq('Haiku is the cheapest tier', petThrift('快速', 'claude-haiku-5-5'), 0);
eq('Luna is the cheapest tier', petThrift('快速', 'gpt-6-luna'), 0);
eq('a gpt-x-mini id is the cheapest tier', petThrift(undefined, 'gpt-5-mini'), 0);
eq('a mini with a date suffix too', petThrift(undefined, 'gpt-5.1-mini-2026-01-01'), 0);
eq('Qwen Plus stays 均衡', petThrift('均衡', 'qwen3.7-plus'), 1);

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

/* ───────────────────────── finding the command-line tools (desktop side) ───────────────────────── */

console.log('Finding the command-line tools');
{
  const req = createRequire(path.join(process.cwd(), 'package.json'));
  type Query = (args: string[]) => Buffer | null;
  /** The PATH is read from both registry keys in one go: query(machineArgs, userArgs) → their outputs, one after the other. */
  type MultiQuery = (...queries: string[][]) => Buffer | null;
  type ProcInternals = {
    mergePath(proc: string, extra: string[]): string;
    registryPathDirs(query: MultiQuery): string[];
    searchPath(query?: MultiQuery): string;
    lookupOnPath(name: string, pathValue: string): string | null;
    useRegistry(read: MultiQuery | null): void;
    regQuery(...queries: string[][]): (Buffer & { utf8?: boolean }) | null;
    makeStreamDecoder(label?: string): { write(chunk: Buffer): string; end(): string };
    decodeLine(raw: Buffer, label?: string): string;
    codePageLabel(oem: number, acp: number): string;
  };
  const proc = req('./electron/ai/proc.cjs') as {
    installDirs(name: string, query?: Query): string[]; resolveCommand(name: string): string | null; forgetCommand(name: string): void;
    runOnce(exe: string, args: string[]): Promise<{ code: number; out: string; err: string }>;
    spawnCli(exe: string, args: string[], o: { onLine(l: string): void; onErr?(d: string): void }): { on(ev: 'close', fn: () => void): void; stdin: { end(): void } };
    _internals: ProcInternals;
  };
  const { installDirs, resolveCommand, forgetCommand, runOnce } = proc;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-dsh-'));
  const dir = (name: string) => { const p = path.join(base, name); fs.mkdirSync(p, { recursive: true }); return p; };
  /** A folder holding the named files (each a one-line batch file, unless given). */
  const bin = (folder: string, files: string[], body = '@echo ok\r\n') => { const d = dir(folder); for (const f of files) fs.writeFileSync(path.join(d, f), body); return d; };
  const gbk = (hex: string) => Buffer.from(hex, 'hex');
  // 不是内部或外部命令，也不是可运行的程序或批处理文件。 — what cmd.exe says in GBK, and 张三.
  const NOT_FOUND_GBK = gbk('b2bbcac7c4dab2bfbbf2cde2b2bfc3fcc1eea3acd2b2b2bbcac7bfc9d4cbd0d0b5c4b3ccd0f2bbf2c5fab4a6c0edcec4bcfea1a3');
  const NOT_FOUND = '不是内部或外部命令，也不是可运行的程序或批处理文件。';

  /* Reading what the console tools and the CLIs print (any platform). */
  {
    const { makeStreamDecoder, decodeLine, codePageLabel } = proc._internals;
    const whole = (label: string, chunks: Buffer[]) => { const d = makeStreamDecoder(label); return chunks.map((c) => d.write(c)).join('') + d.end(); };
    const zh = Buffer.from('张三 你好', 'utf8');
    eq('UTF-8 cut in the middle of a character stays exact', whole('gbk', [zh.subarray(0, 1), zh.subarray(1, 4), zh.subarray(4)]), '张三 你好');
    eq('cmd.exe\'s GBK message is read as GBK', whole('gbk', [NOT_FOUND_GBK]), NOT_FOUND);
    eq('also when a chunk ends inside a double-byte character', whole('gbk', [NOT_FOUND_GBK.subarray(0, 3), NOT_FOUND_GBK.subarray(3, 8), NOT_FOUND_GBK.subarray(8)]), NOT_FOUND);
    eq('UTF-8 first and GBK after it: each read in its own way', whole('gbk', [Buffer.from('ok 好\n', 'utf8'), NOT_FOUND_GBK]), `ok 好\n${NOT_FOUND}`);
    eq('a quote and ASCII before the GBK in one chunk', whole('gbk', [Buffer.concat([Buffer.from("'node' "), NOT_FOUND_GBK])]), `'node' ${NOT_FOUND}`);
    eq('a character left unfinished at the very end does not throw', typeof whole('gbk', [Buffer.from([0x61, 0xe5, 0xbd])]), 'string');
    eq('a stdout line in UTF-8 is exact', decodeLine(Buffer.from('{"a":"流萤"}', 'utf8'), 'gbk'), '{"a":"流萤"}');
    eq('a stdout line in GBK is read as GBK', decodeLine(gbk('d5c5c8fd'), 'gbk'), '张三');
    eq('and the next UTF-8 line is not affected by it', decodeLine(Buffer.from('流萤', 'utf8'), 'gbk'), '流萤');
    eq('code pages: Chinese, Taiwan, Russian, Western', [codePageLabel(936, 936), codePageLabel(950, 950), codePageLabel(866, 1251), codePageLabel(437, 1252), codePageLabel(850, 1252)],
      ['gbk', 'big5', 'ibm866', 'windows-1252', 'windows-1252']);
    // The real spawn: lines are cut on bytes, a character split between two writes survives, and a line that
    // is not UTF-8 does not turn the lines after it into mojibake.
    const script = 'const w=(b)=>process.stdout.write(Buffer.from(b));w("流萤\\n");w([0xd5,0xc5,0xc8,0xfd,0x0a]);w("流萤\\n");w([0xe6,0xb5]);setTimeout(()=>w([0x81,0x0a]),60)';
    const lines: string[] = [];
    await new Promise<void>((resolve) => { const c = proc.spawnCli(process.execPath, ['-e', script], { onLine: (l) => lines.push(l) }); c.on('close', resolve); c.stdin.end(); });
    eq('stdout through spawnCli: UTF-8 lines exact, a GBK line in between, a split character', [lines[0], lines[2], lines[3], lines.length], ['流萤', '流萤', '流', 4]);
    if (decodeLine(gbk('d5c5c8fd')) === '张三') eq('and the GBK line is read with the system code page', lines[1], '张三');
    else console.log('  (skipped the system-code-page check: this Windows is not GBK)');
  }

  if (process.platform === 'win32') {
    const { lookupOnPath, mergePath, registryPathDirs, searchPath, useRegistry } = proc._internals;
    const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const n = (tag: string) => `fireflycheck${tag}${process.pid}`;
    // The PATH is walked here, not by where.exe (which prints ? for what the console's code page lacks: 한글, emoji).
    const a = n('a');
    const npmDir = bin('张三\\AppData\\Roaming\\npm', [`${a}.cmd`, a, `${a}.ps1`]);
    eq('npm\'s .cmd is taken, never its extensionless or .ps1 shim', lookupOnPath(a, npmDir), path.join(npmDir, `${a}.cmd`));
    const b = n('b');
    const both = bin('both', [`${b}.bat`, `${b}.cmd`, `${b}.exe`]);
    eq('.exe before .cmd before .bat inside one folder', lookupOnPath(b, both), path.join(both, `${b}.exe`));
    fs.rmSync(path.join(both, `${b}.exe`));
    eq('.cmd when there is no .exe', lookupOnPath(b, both), path.join(both, `${b}.cmd`));
    fs.rmSync(path.join(both, `${b}.cmd`));
    eq('.bat as the last resort', lookupOnPath(b, both), path.join(both, `${b}.bat`));
    const c = n('c');
    const early = bin('early', [`${c}.cmd`]);
    const late = bin('late', [`${c}.exe`]);
    eq('the first PATH entry that has it wins, whatever it is', lookupOnPath(c, `${early};${late}`), path.join(early, `${c}.cmd`));
    eq('quotes, empty entries and a trailing backslash do not matter', lookupOnPath(c, `;"${late}\\";  ;${early}`), path.join(late, `${c}.exe`));
    for (const who of ['한글', '😀x', '张三']) {
      const d = bin(`unicode\\${who}\\npm`, [`${c}.cmd`]);
      eq(`a folder named ${who} is found exactly, whatever the console code page`, lookupOnPath(c, d), path.join(d, `${c}.cmd`));
    }
    const cwd0 = process.cwd();
    process.chdir(base);
    fs.writeFileSync(path.join(base, `${n('here')}.cmd`), '@echo ok\r\n');
    eq('the working folder is not on the PATH unless it is named', [lookupOnPath(n('here'), '.'), lookupOnPath(n('here'), ''), lookupOnPath(n('here'), '\\\\127.0.0.1\\share;rel\\dir')], [null, null, null]);
    process.chdir(cwd0);
    eq('a name with a path in it is refused', lookupOnPath('..\\evil', both), null);

    // The PATH to search: the process's, then what the registry has that it lacks.
    eq('the registry\'s PATH only adds what the process PATH lacks',
      mergePath('C:\\A;"C:\\B\\";;C:\\C', ['c:\\a', 'C:\\b', 'D:\\New', '"D:\\Quoted"', 'D:\\NEW\\']), 'C:\\A;"C:\\B\\";C:\\C;D:\\New;D:\\Quoted');
    const MACHINE = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
    // What regQuery hands over: UTF-8, marked as such.
    const pathOut = (key: string, type: string, data: string) => Object.assign(Buffer.from(`\r\n${key}\r\n    Path    ${type}    ${data}\r\n\r\n`, 'utf8'), { utf8: true });
    const home = process.env.USERPROFILE || 'C:\\Users\\x';
    /** A stand-in registry: the output each key asked for would give, one after the other. */
    const registryOf = (table: Record<string, Buffer>): MultiQuery => (...queries) => {
      const outs = queries.map((args) => table[args[0]]).filter(Boolean);
      return outs.length ? Object.assign(Buffer.concat(outs), { utf8: outs.every((o) => (o as { utf8?: boolean }).utf8 === true) }) : null;
    };
    const fakeEnv = registryOf({
      [MACHINE]: pathOut('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'REG_EXPAND_SZ', '%SystemRoot%\\system32;C:\\Program Files\\nodejs\\'),
      'HKCU\\Environment': pathOut('HKEY_CURRENT_USER\\Environment', 'REG_EXPAND_SZ', '%userprofile%\\.local\\bin;D:\\한글\\bin;%NO_SUCH_VAR_X%\\z'),
    });
    eq('machine PATH first, %VAR% expanded whatever its case, an unknown %VAR% left out',
      registryPathDirs(fakeEnv), [`${process.env.SystemRoot}\\system32`, 'C:\\Program Files\\nodejs\\', `${home}\\.local\\bin`, 'D:\\한글\\bin']);
    const utf8Out = Object.assign(Buffer.from('\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    D:\\张三\\bin\r\n', 'utf8'), { utf8: true });
    eq('output marked UTF-8 is read as UTF-8 only', registryPathDirs(registryOf({ 'HKCU\\Environment': utf8Out })), ['D:\\张三\\bin']);
    if (/^[\x20-\x7e]*$/.test(base)) {
      const zhBin = bin('张三\\bin', []);
      const gbkOut = Buffer.concat([Buffer.from(`\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    ${base}\\`, 'latin1'), gbk('d5c5c8fd'), Buffer.from('\\bin\r\n', 'latin1')]);
      eq('legacy output (a Chinese Windows) is read every way: the folder that exists is the right reading', registryPathDirs(registryOf({ 'HKCU\\Environment': gbkOut })), [zhBin]);
    } else console.log('  (skipped the GBK registry check: the temp folder has non-ASCII characters)');

    // The real registry, through reg.exe under chcp 65001.
    const real = proc._internals.regQuery([MACHINE, '/v', 'Path'], ['HKCU\\Environment', '/v', 'Path']);
    expect('reg.exe is run under UTF-8, its output marked as such, one read for both keys',
      !!real && real.utf8 === true && /HKEY_LOCAL_MACHINE[\s\S]*Path\s+REG_\w+[\s\S]*HKEY_CURRENT_USER\\Environment[\s\S]*Path\s+REG_\w+/i.test(real.toString('utf8')));
    const oldPath = process.env.PATH || '';
    const merged = searchPath();
    const procParts = oldPath.split(';').filter((p) => p.trim());
    eq('the real merged PATH starts with the process PATH, entry for entry', merged.split(';').slice(0, procParts.length), procParts);
    expect('and has the machine PATH\'s System32 on it', merged.toLowerCase().split(';').some((p) => p.replace(/\\$/, '') === sys32.toLowerCase()));

    // regQuery's own tools are found by full path: Windows looks in the current folder first (unless
    // NoDefaultCurrentDirectoryInExePath is set), so a chcp.cmd beside the app would run at every start.
    {
      const planted = dir('planted-chcp');
      const marker = path.join(planted, 'PLANTED.txt');
      for (const ext of ['cmd', 'bat']) fs.writeFileSync(path.join(planted, `chcp.${ext}`), '@echo ran> "%~dp0PLANTED.txt"\r\n@"%SystemRoot%\\System32\\chcp.com" %*\r\n');
      const savedNoDefault = process.env.NoDefaultCurrentDirectoryInExePath;
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      const cwd0 = process.cwd();
      process.chdir(planted);
      try {
        // The control: a bare chcp, started from this folder the way regQuery used to, does run the planted one.
        req('node:child_process').spawnSync(path.join(sys32, 'cmd.exe'), ['/d', '/s', '/c', '"chcp 65001>nul"'], { windowsHide: true, windowsVerbatimArguments: true, timeout: 8000 });
        const control = fs.existsSync(marker);
        fs.rmSync(marker, { force: true });
        const got = proc._internals.regQuery(['HKCU\\Environment', '/v', 'Path']);
        if (control) expect('a chcp.cmd / chcp.bat in the working folder is not run by regQuery, and the registry is still read', !fs.existsSync(marker) && !!got && got.utf8 === true && /HKEY_CURRENT_USER/.test(got.toString('utf8')));
        else console.log('  (skipped the planted-chcp check: this Windows does not look in the working folder first)');
      } finally {
        process.chdir(cwd0);
        if (savedNoDefault !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = savedNoDefault;
      }
    }

    // A registry read that takes longer than the share window (antivirus hooking cmd.exe) is stamped when it is over,
    // so the 检测 of the next tools in the same batch still share it. (A clock that jumps 2.5 s on each read.)
    {
      const realNow = Date.now;
      let clock = realNow();
      let reads = 0;
      Date.now = () => clock;
      try {
        useRegistry((...queries) => { reads++; clock += 2500; return fakeEnv(...queries); });
        const slowTool = n('slowread');
        for (let i = 0; i < 3; i++) { forgetCommand(slowTool); resolveCommand(slowTool); }
        eq('a slow registry read is shared by the 检测 that follow it, not repeated for each', reads, 1);
        clock += 2100;
        forgetCommand(slowTool);
        resolveCommand(slowTool);
        eq('and read again once that moment has passed', reads, 2);
      } finally {
        Date.now = realNow;
        useRegistry(null);
      }
    }

    // A CLI installed since 萤火 started is on the registry's PATH only (stand-in registry, process PATH = System32).
    const savedEnv = { PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, AIROOM_DATA_DIR: process.env.AIROOM_DATA_DIR };
    try {
      const fresh = n('fresh');
      const helper = n('helper');
      const freshDir = bin('registry-only', [`${fresh}.cmd`]);
      fs.writeFileSync(path.join(freshDir, `${helper}.cmd`), '@echo from-helper\r\n');
      process.env.PATH = sys32;
      useRegistry(registryOf({ 'HKCU\\Environment': pathOut('HKEY_CURRENT_USER\\Environment', 'REG_EXPAND_SZ', freshDir) }));
      eq('a CLI that only the registry\'s PATH knows is found by the next 检测', resolveCommand(fresh), path.join(freshDir, `${fresh}.cmd`));
      const caller = path.join(bin('caller', []), 'caller.cmd');
      fs.writeFileSync(caller, `@${helper}\r\n`);
      eq('and a CLI 萤火 starts sees that PATH too (an npm shim finding its node)', (await runOnce(caller, [])).out.trim(), 'from-helper');
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      useRegistry(null);
    }
  }
  const own = dir('DSH');
  const CU = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
  const LM = 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
  const dshKey = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1bf39983-50d0-5fe0-9ef4-cece76f67c5e';
  const officeKey = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\827f4946-1f12-5a67-89e9-2c1982dc94c1';
  const machineKey = 'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{DSH}';
  // What reg.exe prints: the key, then `    name    REG_SZ    data` lines (and a localized footer).
  const out = (blocks: Array<[string, Array<[string, string]>]>) => Buffer.from(`\r\n${blocks.map(([key, vals]) =>
    `${key}\r\n${vals.map(([n, d]) => `    ${n}    REG_SZ    ${d}`).join('\r\n')}\r\n`).join('\r\n')}\r\n搜索结束: 找到 ${blocks.length} 匹配。\r\n`, 'utf8');
  const entry = (folder: string, extra: Array<[string, string]> = []): Array<[string, string]> => [
    ['DisplayName', 'DeepSeek Harness 0.2.0-rc.2'],
    ['UninstallString', `"${folder}\\Uninstall DeepSeek Harness.exe" /currentuser`],
    ['DisplayIcon', `${folder}\\DeepSeek Harness.exe,0`],
    ...extra,
  ];
  const reads: string[] = [];
  // A stand-in for reg.exe: searches by root, reads by key; anything else is "not found".
  const fake = (search: Record<string, Buffer>, keys: Record<string, Buffer>): Query => (args) => {
    if (args.length === 1) reads.push(args[0]);
    return (args.length > 1 ? search[args[0]] : keys[args[0]]) ?? null;
  };
  const userCase = fake(
    { [CU]: out([[dshKey, entry(own)], [officeKey, [['Comments', '赛博办公室：Claude Code / Codex / DeepSeek Harness 三位 AI 同事的群聊办公室']]]]) },
    { [dshKey]: out([[dshKey, entry(own, [['InstallLocation', own]])]]) },
  );
  eq('a DSH installed in its own folder (F:\\DSH) is found from the installed-programs list', installDirs('DeepSeek Harness', userCase), [own]);
  expect('only DSH\'s own entry is read, not apps that merely mention it', reads.includes(dshKey) && !reads.includes(officeKey));
  eq('without InstallLocation, the folder of its icon is used',
    installDirs('DeepSeek Harness', fake({ [CU]: out([[dshKey, entry(own)]]) }, { [dshKey]: out([[dshKey, entry(own, [['InstallLocation', '']])]]) })), [own]);
  eq('a trailing backslash or quotes do not matter',
    installDirs('DeepSeek Harness', fake({ [CU]: out([[dshKey, entry(own)]]) }, { [dshKey]: out([[dshKey, [['DisplayName', 'DeepSeek Harness'], ['InstallLocation', `"${own}\\"`]]]]) })), [own]);
  const gone = path.join(base, 'gone');
  eq('a folder that no longer exists is skipped',
    installDirs('DeepSeek Harness', fake({ [CU]: out([[dshKey, entry(gone)]]) }, { [dshKey]: out([[dshKey, entry(gone, [['InstallLocation', gone]])]]) })), []);
  eq('network paths are never used',
    installDirs('DeepSeek Harness', fake({ [CU]: out([[dshKey, entry('\\\\server\\share\\DSH')]]) }, { [dshKey]: out([[dshKey, entry('\\\\server\\share\\DSH', [['InstallLocation', '\\\\server\\share\\DSH']])]]) })), []);
  eq('another product whose name only starts the same is not taken',
    installDirs('DeepSeek Harness', fake({ [CU]: out([[dshKey, [['DisplayName', 'DeepSeek HarnessX 1.0'], ['DisplayIcon', `${own}\\x.exe,0`]]]]) }, { [dshKey]: out([[dshKey, [['DisplayName', 'DeepSeek HarnessX 1.0'], ['InstallLocation', own]]]]) })), []);
  const machine = dir('Program Files\\DeepSeek Harness');
  eq('a per-machine install is found when there is no per-user one',
    installDirs('DeepSeek Harness', fake({ [LM]: out([[machineKey, entry(machine)]]) }, { [machineKey]: out([[machineKey, entry(machine, [['InstallLocation', machine]])]]) })), [machine]);
  eq('a per-user install comes first',
    installDirs('DeepSeek Harness', fake({ [CU]: out([[dshKey, entry(own)]]), [LM]: out([[machineKey, entry(machine)]]) },
      { [dshKey]: out([[dshKey, entry(own, [['InstallLocation', own]])]]), [machineKey]: out([[machineKey, entry(machine, [['InstallLocation', machine]])]]) })), [own]);
  eq('nothing installed: nothing found', installDirs('DeepSeek Harness', () => null), []);
  // reg.exe writes the system code page: GBK on Chinese Windows, UTF-8 where that option is on.
  const zh = dir('流萤');
  eq('a Chinese folder name in UTF-8 output', installDirs('DeepSeek Harness', fake({ [CU]: out([[dshKey, entry(zh)]]) }, { [dshKey]: out([[dshKey, entry(zh, [['InstallLocation', zh]])]]) })), [zh]);
  if (/^[\x20-\x7e]*$/.test(base)) {
    const gbkDir = dir('心月AI变声器');
    const gbk = Buffer.concat([Buffer.from(`\r\n${dshKey}\r\n    DisplayName    REG_SZ    DeepSeek Harness 0.2.0\r\n    InstallLocation    REG_SZ    ${base}\\`, 'latin1'),
      Buffer.from('d0c4d4c24149b1e4c9f9c6f7', 'hex'), Buffer.from('\r\n', 'latin1')]);
    eq('a Chinese folder name in GBK output (Chinese Windows)', installDirs('DeepSeek Harness', fake({ [CU]: gbk }, { [dshKey]: gbk })), [gbkDir]);
  } else console.log('  (skipped the GBK check: the temp folder has non-ASCII characters)');

  // 命令路径 and 检测 for DSH, through the real desktop module (Electron faked).
  const fakeElectron = {
    // (main.cjs, loaded below, needs the app object to answer its start-up calls without opening anything.)
    app: { on() {}, getPath: () => base, requestSingleInstanceLock: () => true, quit() {}, whenReady: () => ({ then() {} }), commandLine: { appendSwitch() {} } },
    ipcMain: { on() {}, handle() {} }, dialog: {}, shell: {}, safeStorage: {},
    BrowserWindow: class {}, BaseWindow: class {}, WebContentsView: class {}, session: {}, Menu: {}, Tray: class {}, Notification: class {}, nativeImage: {},
  };
  const file = req.resolve('electron');
  req.cache[file] = { id: file, filename: file, loaded: true, exports: fakeElectron, children: [], paths: [], path: path.dirname(file) } as unknown as NodeJS.Module;
  type Detected = { found: boolean; detail?: string; path?: string; version?: string };
  const ai = req('./electron/ai/index.cjs') as { _internals: { exeFor(driver: string, custom?: string): string | null; detect(r: { driver: string; path?: string }): Promise<Detected>; loginLaunch(file: string): [string, string[]] } };
  const spawnSyncOf = (exe: string, args: string[]) => req('node:child_process').spawnSync(exe, args, { windowsHide: true, windowsVerbatimArguments: true, timeout: 15000 });
  const appDir = dir('Apps\\DeepSeek Harness');
  const cliDir = path.join(appDir, 'resources', 'runtime', 'cli', 'bin');
  fs.mkdirSync(cliDir, { recursive: true });
  const cli = path.join(cliDir, 'dsh.cmd');
  fs.writeFileSync(cli, '@echo 0.2.0-test\r\n');
  fs.writeFileSync(path.join(appDir, 'DeepSeek Harness.exe'), '');
  eq('命令路径 may be the DSH folder', ai._internals.exeFor('dsh', appDir), cli);
  eq('or the DSH app: its CLI is used, never the app itself', ai._internals.exeFor('dsh', path.join(appDir, 'DeepSeek Harness.exe')), cli);
  eq('or dsh.cmd itself', ai._internals.exeFor('dsh', cli), cli);
  eq('a folder without the CLI is not taken', ai._internals.exeFor('dsh', own), null);
  const lone = dir('Lone');
  fs.writeFileSync(path.join(lone, 'DeepSeek Harness.exe'), '');
  eq('an app without its CLI is never started', ai._internals.exeFor('dsh', path.join(lone, 'DeepSeek Harness.exe')), null);
  eq('other tools are not looked for inside a folder', ai._internals.exeFor('codex', appDir), null);
  const miss = await ai._internals.detect({ driver: 'dsh', path: own });
  expect('检测 with a folder that has no dsh says what to fill in', !miss.found && /安装文件夹/.test(miss.detail || ''), miss.detail);
  if (process.platform === 'win32') {
    const hit = await ai._internals.detect({ driver: 'dsh', path: appDir });
    eq('检测 with the DSH folder runs its dsh --version', [hit.found, hit.path, hit.version], [true, cli, '0.2.0-test']);
  }

  // 命令路径 as it is pasted: 「复制为路径」 puts quotes round it, and %USERPROFILE% is how Windows users write their folder.
  const ai2 = ai._internals as typeof ai._internals & { cleanCustom(c?: string): string };
  const shimDir = dir('shims');
  const okShim = path.join(shimDir, 'ok.cmd');
  fs.writeFileSync(okShim, '@echo 1.2.3\r\n');
  eq('a quoted path is the path', ai2.exeFor('qwen', `"${okShim}"`), okShim);
  eq('curly quotes too, and single quotes, and spaces round them', [ai2.exeFor('qwen', `“${okShim}”`), ai2.exeFor('qwen', `'${okShim}'`), ai2.exeFor('qwen', `  "${okShim}"  `)], [okShim, okShim, okShim]);
  eq('only one pair comes off, and never a quote inside the path', [ai2.cleanCustom('""x""'), ai2.cleanCustom('C:\\a "b\\c.cmd')], ['"x"', 'C:\\a "b\\c.cmd']);
  process.env.FIREFLY_CHECK_DIR = shimDir;
  eq('%VAR% in it is expanded, whatever its case', ai2.exeFor('qwen', '%firefly_check_dir%\\ok.cmd'), okShim);
  delete process.env.FIREFLY_CHECK_DIR;
  eq('a quoted path that is not there is still refused', ai2.exeFor('qwen', `"${okShim}x"`), null);
  eq('and a quoted DSH folder works like the plain one', ai2.exeFor('dsh', `"${appDir}"`), cli);
  if (process.platform === 'win32') {
    const pasted = await ai2.detect({ driver: 'qwen', path: `"${okShim}"` });
    eq('检测 with a pasted (quoted) path', [pasted.found, pasted.path, pasted.version], [true, okShim, '1.2.3']);
    const gone = await ai2.detect({ driver: 'qwen', path: `"${okShim}x"` });
    expect('and with a quoted path that is not there', !gone.found && /不存在/.test(gone.detail || ''), gone.detail);
    // A shim that is found but dies at once (npm's .cmd without node on the PATH): found:false with the reason, never a version.
    // Run with System32 as the whole PATH, so `node` is what cmd.exe cannot find (the message the Node hint is for).
    const noNode = path.join(shimDir, 'no-node.cmd');
    fs.writeFileSync(noNode, '@node "%~dp0x.js" %*\r\n');
    const savedPath = process.env.PATH;
    let dead: Detected & { login?: string };
    try {
      process.env.PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
      proc._internals.useRegistry(() => null);
      dead = await ai2.detect({ driver: 'qwen', path: noNode }) as Detected & { login?: string };
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
      proc._internals.useRegistry(null);
    }
    expect('检测 of a shim that cannot start says so, with the path', !dead.found && dead.path === noNode && (dead.detail || '').startsWith(`找到了 ${noNode}，但运行不起来：`), dead.detail);
    expect('and cmd.exe\'s message is readable (GBK on a Chinese Windows), not mojibake', !(dead.detail || '').includes('\ufffd') && /不是内部或外部命令|not recognized|nicht erkannt|n'est pas reconnu|no se reconoce|не является/i.test(dead.detail || ''), dead.detail);
    expect('and mentions Node when the message does', /Node 不在萤火的 PATH 里/.test(dead.detail || ''), dead.detail);
    expect('the advice is to click 检测 again, not to restart 萤火 (the PATH is read again on each 检测)', /再点一次「检测」/.test(dead.detail || '') && !/退出|托盘|重新打开|重启/.test(dead.detail || ''), dead.detail);
    expect('the message never becomes the version', !('version' in dead) && dead.login === undefined);
    const noTool = path.join(shimDir, 'no-tool.cmd');
    fs.writeFileSync(noTool, '@"zzz-missing-tool" %*\r\n');
    const dead2 = await ai2.detect({ driver: 'qwen', path: noTool });
    expect('no Node hint for another missing program', !dead2.found && /zzz-missing-tool/.test(dead2.detail || '') && !/Node/.test(dead2.detail || ''), dead2.detail);
    // Only cmd.exe's own "'node' is not recognized": a program whose name starts with node, or a CLI that names Node in its own error, gets none.
    const nodeish = path.join(shimDir, 'nodeish.cmd');
    fs.writeFileSync(nodeish, '@"node-not-here-xyz" "%~dp0x.js" %*\r\n');
    const dead4 = await ai2.detect({ driver: 'qwen', path: nodeish });
    expect('no Node hint for a missing program that is only named like node', !dead4.found && /node-not-here-xyz/.test(dead4.detail || '') && !/再点一次/.test(dead4.detail || ''), dead4.detail);
    const tooOld = path.join(shimDir, 'too-old.cmd');
    fs.writeFileSync(tooOld, '@echo Error: Node.js v16 is not supported, requires Node 20 or newer 1>&2\r\n@exit /b 1\r\n');
    const dead5 = await ai2.detect({ driver: 'qwen', path: tooOld });
    expect('no "Node is not on PATH" hint when Node is there but too old', !dead5.found && /Node\.js v16/.test(dead5.detail || '') && !/PATH|再点一次/.test((dead5.detail || '').replace(tooOld, '')), dead5.detail);
    const silent = path.join(shimDir, 'silent.cmd');
    fs.writeFileSync(silent, '@exit /b 5\r\n');
    const dead3 = await ai2.detect({ driver: 'qwen', path: silent });
    expect('a command that exits non-zero without a word is reported with its exit code', !dead3.found && /退出代码 5/.test(dead3.detail || ''), dead3.detail);
    // A start-up that is only slow is not "not found": the timeout (code -2) leaves it found, with no version and the reason.
    // (The 20 s wait is cut to 0.4 s for the check.)
    const slow = path.join(shimDir, 'slow.cmd');
    fs.writeFileSync(slow, '@ping -n 8 127.0.0.1 >nul\r\n@echo 9.9.9\r\n');
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => realSetTimeout(fn, ms === 20000 ? 400 : ms, ...rest)) as typeof setTimeout;
    let late: Detected & { login?: string };
    try { late = await ai2.detect({ driver: 'qwen', path: slow }) as Detected & { login?: string }; } finally { globalThis.setTimeout = realSetTimeout; }
    eq('a command that takes too long to print its version is found, with no version', [late.found, late.path, late.version, late.login], [true, slow, '', 'unknown']);
    expect('and the detail says the version check timed out', /版本检查超时/.test(late.detail || ''), late.detail);
    // A spawn failure stays "found but cannot run".
    const notExe = path.join(shimDir, 'not-a-program.exe');
    fs.writeFileSync(notExe, 'this is not an executable');
    const broken = await ai2.detect({ driver: 'qwen', path: notExe });
    expect('a file that cannot be started at all is still found:false, with the reason', !broken.found && broken.path === notExe && /^找到了 .*，但运行不起来：/.test(broken.detail || ''), broken.detail);

    // The login window: cmd.exe and PowerShell both by full path (`start "" powershell.exe` would look in the working folder first).
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const loginPs1 = path.join(shimDir, 'login-probe.ps1');
    const loginMarker = path.join(shimDir, 'login-ran.txt');
    fs.writeFileSync(loginPs1, `Set-Content -LiteralPath '${loginMarker}' -Value 'ran'\r\n`);
    const [loginCmd, loginArgs] = ai._internals.loginLaunch(loginPs1);
    const loginPowershell = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    expect('the login window starts the system\'s own PowerShell, by full path', path.isAbsolute(loginCmd) && /cmd\.exe$/i.test(loginCmd) && loginArgs[3].startsWith(`start "" "${loginPowershell}" `) && fs.existsSync(loginPowershell) && !/ powershell\.exe/i.test(loginArgs[3]), loginArgs[3]);
    // The same command line, run in the background of a hidden console (a visible window is not for a check): it does open the script.
    spawnSyncOf(loginCmd, [...loginArgs.slice(0, 3), loginArgs[3].replace('start ""', 'start "" /b')]);
    for (let i = 0; i < 100 && !fs.existsSync(loginMarker); i++) await new Promise((r) => setTimeout(r, 100));
    expect('and that command line runs the script', fs.existsSync(loginMarker));
    const loud = path.join(shimDir, 'loud.cmd');
    fs.writeFileSync(loud, '@echo 9.9.9\r\n@exit /b 3\r\n');
    const odd = await ai2.detect({ driver: 'qwen', path: loud });
    eq('one that prints a version is found even if it exits non-zero', [odd.found, odd.version], [true, '9.9.9']);
    const viaErr = path.join(shimDir, 'via-stderr.cmd');
    fs.writeFileSync(viaErr, '@echo 8.8.8 1>&2\r\n');
    const odd2 = await ai2.detect({ driver: 'qwen', path: viaErr });
    eq('a version printed on stderr counts when the command succeeded', [odd2.found, odd2.version], [true, '8.8.8']);

    // Claude Code's own installer leaves PATH alone and puts claude.exe in the user's .local\bin.
    const { useRegistry } = proc._internals;
    const saved = { PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, AIROOM_DATA_DIR: process.env.AIROOM_DATA_DIR };
    try {
      const profile = dir('profile');
      fs.mkdirSync(path.join(profile, '.local', 'bin'), { recursive: true });
      useRegistry(() => null);
      process.env.PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
      process.env.USERPROFILE = profile;
      process.env.APPDATA = dir('no-airoom');
      delete process.env.AIROOM_DATA_DIR;
      forgetCommand('claude');
      eq('no claude anywhere: nothing', ai2.exeFor('claude-code'), null);
      fs.writeFileSync(path.join(profile, '.local', 'bin', 'claude.exe'), '');
      eq('claude.exe in %USERPROFILE%\\.local\\bin is the last resort for Claude Code', ai2.exeFor('claude-code'), path.join(profile, '.local', 'bin', 'claude.exe'));
      eq('and only for Claude Code', ai2.exeFor('qwen'), null);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      useRegistry(null);
    }
  }

  // Who may talk to the shell: the main window's own page, found by identity. The old test compared the frame's
  // URL as text with pathToFileURL(file): win.loadFile hands Chromium url.format's file URL, which keeps ~ [ ] and
  // a bare % as written (checked against a hidden Electron window), so under C:\Users\ADMINI~1\… no page matched.
  const main = req('./electron/main.cjs') as { _internals: { pageUrls(file: string): Set<string>; appSenderCheck(getWin: () => unknown, urls: Set<string>): (e: unknown) => boolean } };
  const loadedUrl = (file: string) => new URL(formatUrl({ protocol: 'file', slashes: true, pathname: path.resolve(file) })).href;
  const portable = 'C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\x\\resources\\app.asar\\dist\\index.html';
  expect('the old comparison rejects the page under an 8.3 short path', loadedUrl(portable) !== pathToFileURL(portable).href, `${loadedUrl(portable)} vs ${pathToFileURL(portable).href}`);
  eq('the new one takes it', main._internals.pageUrls(portable).has(loadedUrl(portable)), true);
  const refused = ['a[1]', 'b]c', '100%', '50%x', 'tilde~and[brackets]', '张三', 'with space', 'a#b', "x'y", '{x}', '한글', 'plain']
    .filter((folder) => { const file = `D:\\${folder}\\resources\\app\\dist\\index.html`; return !main._internals.pageUrls(file).has(loadedUrl(file)); });
  eq('and under folders with [ ] % # \' { } spaces, Chinese or Korean names', refused, []);
  const frame: { url: string; parent: object | null } = { url: loadedUrl(portable), parent: null };
  const wc = { mainFrame: frame };
  const urls = main._internals.pageUrls(portable);
  const check = main._internals.appSenderCheck(() => ({ webContents: wc }), urls);
  eq('the main window\'s own page is accepted', check({ sender: wc, senderFrame: frame }), true);
  frame.url = `${loadedUrl(portable)}#/tasks`;
  eq('also with a #hash route', check({ sender: wc, senderFrame: frame }), true);
  const otherFrame = { url: loadedUrl(portable), parent: null };
  eq('another window\'s page is not', check({ sender: { mainFrame: otherFrame }, senderFrame: otherFrame }), false);
  eq('nor is a frame embedded in the page', check({ sender: wc, senderFrame: { url: frame.url, parent: frame } }), false);
  eq('nor an event whose frame is gone', check({ sender: wc, senderFrame: null }), false);
  frame.url = 'file:///C:/evil/index.html';
  eq('nor the same window after it went to another page', check({ sender: wc, senderFrame: frame }), false);
  frame.url = loadedUrl(portable);
  eq('nor anything when the window is gone', main._internals.appSenderCheck(() => null, urls)({ sender: wc, senderFrame: frame }), false);
  const dying = { get url(): string { throw new Error('Object has been destroyed'); }, parent: null };
  const dyingWc = { mainFrame: dying };
  eq('a frame that throws is refused, not fatal', main._internals.appSenderCheck(() => ({ webContents: dyingWc }), urls)({ sender: dyingWc, senderFrame: dying }), false);

  // System programs (cmd.exe, PowerShell, chcp, reg, taskkill) are started by full path: a bare name is looked up in the
  // working folder first, and 萤火's is wherever it was launched from (Downloads, for the installer's first run).
  // (Read from the source: the pet window's PowerShell call needs a real window to run.)
  const scanned = ['electron/ai/proc.cjs', 'electron/ai/index.cjs', 'electron/pet/window.cjs', 'electron/pet/sense.cjs'];
  for (const file of scanned.filter((f) => fs.existsSync(path.join(process.cwd(), f)))) { // 2.0.x has no electron/pet
    const code = fs.readFileSync(path.join(process.cwd(), file), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const bare = [...code.matchAll(/(?<![.\w])(?:spawn|spawnSync|execFile|execFileSync)\(\s*(['"`])([^'"`$]+)\1/g)].map((m) => m[2]).filter((p) => !/[\\/]/.test(p) && p !== 'which');
    const fallback = code.match(/\|\|\s*['"](?:cmd|powershell|chcp|reg|taskkill)(?:\.exe|\.com)?['"]|\bstart ""\s+(?:powershell|cmd)|(?:&|>)\s*chcp\b|["'`]chcp\s/gi) || [];
    eq(`${file}: no system program is started by its bare name`, [bare, fallback], [[], []]);
  }
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
