/* Headless check of the command-line drivers and what live.ts does with them: npm run check:driver
   Codex and Claude Code are driven through the real electron/ai drivers, with a tiny fake CLI that
   prints recorded JSON lines (nothing talks to a model). The same fake sits behind a fake desktop
   bridge, so the real live.ts runs a chat and a work run against it: a session the CLI has lost, the
   system prompt that must not change from turn to turn, the permission check, the history sent to an
   API model, and which program path a task is given. Plain assertions, no test runner. */
import { hooks } from './driver-check-env';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { systemPrompt, whenText } from '../src/lib/persona';
import type { StartSpec } from '../src/lib/desktop';
import type { Message, Run, Task, TaskEngine } from '../src/lib/types';
import { actions } from '../src/state/actions';
import * as live from '../src/state/live';
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

/* ───────────────────────── the fake CLI ───────────────────────── */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-driver-check-'));
const logFile = path.join(dir, 'calls.jsonl');
const work = path.join(dir, 'work');
fs.mkdirSync(work);

// Behaves like Claude Code (stream-json on stdin and stdout) or Codex (`exec`, the prompt on stdin), by its arguments.
// FAKE_MODE picks what it does; every call is appended to FAKE_LOG.
fs.writeFileSync(path.join(dir, 'fake-cli.cjs'), `
const fs = require('node:fs');
const args = process.argv.slice(2);
const env = process.env;
const claude = args.includes('--output-format');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const calls = () => { try { return fs.readFileSync(env.FAKE_LOG, 'utf8').split('\\n').filter(Boolean).length; } catch { return 0; } };
let input = '';
let began = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; if (claude && input.includes('\\n')) begin(); });
process.stdin.on('end', () => { if (claude) process.exit(0); begin(); });
function begin() { if (began) return; began = true; run(); }
function run() {
  const n = calls() + 1;
  const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : ''; };
  const resumed = claude ? at('--resume') : (args[0] === 'exec' && args[1] === 'resume' ? args[args.length - 2] : '');
  const prompt = claude ? JSON.parse(input.split('\\n')[0]).message.content[0].text : input;
  const sf = at('--append-system-prompt-file');
  const system = sf ? fs.readFileSync(sf, 'utf8') : '';
  fs.appendFileSync(env.FAKE_LOG, JSON.stringify({ n, args, resumed, prompt, system }) + '\\n');
  const mode = env.FAKE_MODE || 'ok';
  if (claude) {
    const sid = 'sess-' + n;
    const lost = 'No conversation found with session ID: ' + resumed;
    if (resumed && mode === 'lose-stderr') { process.stderr.write(lost + '\\n'); process.exit(1); }
    const losing = resumed && (mode === 'lose' || mode === 'lose-always') && (!env.FAKE_LOSE || prompt.includes(env.FAKE_LOSE));
    if (losing) return out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [lost], session_id: 'junk-id', queued_turn_count: 0 });
    if (mode === 'lose-always' && !resumed) return out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [lost], session_id: sid, queued_turn_count: 0 });
    if ((mode === 'perm' || mode === 'perm-plain') && prompt.includes('现在执行第')) {
      // A PowerShell write that Claude Code's own safety check flagged (or, in perm-plain, an ordinary request), asked while the step runs.
      out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake' });
      out({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'PowerShell', tool_use_id: 'tu-1', input: { command: 'Set-Content settings.local.json x' }, decision_reason: 'Claude requested permissions to write to settings.local.json', blocked_path: mode === 'perm' ? env.FAKE_BLOCKED : '' } });
      return setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: '完成。小结：做好了', session_id: sid, queued_turn_count: 0 }), 600);
    }
    if (mode === 'errors') return out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom 1', 'boom 2'], session_id: sid, queued_turn_count: 0 });
    if (mode === 'bare') return out({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: sid, queued_turn_count: 0 });
    const text = prompt.includes('\`\`\`json') ? '好的。\\n\`\`\`json\\n{"steps":[{"title":"第一步","detail":"做点什么","agent":"orchestrator"}]}\\n\`\`\`'
      : prompt.includes('现在执行第') ? '完成。\\n小结：做好了' : '你好，这是第 ' + n + ' 次回复';
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake' });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    return out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, queued_turn_count: 0, usage: { input_tokens: 10, output_tokens: 5 } });
  }
  const usage = { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 };
  const reply = () => out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '答好了' } });
  if (mode === 'reconnect') {
    out({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' });
    out({ type: 'thread.started', thread_id: 'th-1' });
    out({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion)' });
    reply();
    out({ type: 'turn.completed', usage });
    process.exit(0);
  }
  if (mode === 'recovered') {
    // One blip, then a stream that recovers (no event) and stays quiet for longer than the gap, then another blip.
    out({ type: 'thread.started', thread_id: 'th-1' });
    out({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' });
    setTimeout(() => {
      out({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' });
      setTimeout(() => { reply(); out({ type: 'turn.completed', usage }); process.exit(0); }, 20);
    }, 300);
    return;
  }
  if (mode === 'fail') { out({ type: 'thread.started', thread_id: 'th-1' }); out({ type: 'error', message: 'bad key' }); out({ type: 'turn.failed', error: { message: 'bad key' } }); process.exit(1); }
  if (mode === 'exit-error') { out({ type: 'error', message: 'out of quota' }); process.exit(1); }
  if (mode === 'lost') { process.stderr.write('Error: thread/resume: thread/resume failed: no rollout found for thread id ' + resumed + '\\n'); process.exit(1); }
  if (mode === 'forever') { setInterval(() => out({ type: 'error', message: 'Reconnecting... waiting for network (Connection failed)' }), 15); return; }
  out({ type: 'thread.started', thread_id: 'th-1' });
  reply();
  out({ type: 'turn.completed', usage });
  process.exit(0);
}
`);
const isWin = process.platform === 'win32';
const fakeExe = path.join(dir, isWin ? 'fake.cmd' : 'fake.sh');
fs.writeFileSync(fakeExe, isWin ? `@"${process.execPath}" "%~dp0fake-cli.cjs" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'fake-cli.cjs')}" "$@"\n`);
if (!isWin) fs.chmodSync(fakeExe, 0o755);

const calls = (): Array<{ n: number; args: string[]; resumed: string; prompt: string; system: string }> => {
  try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const resetCalls = () => fs.rmSync(logFile, { force: true });

const req = createRequire(path.join(process.cwd(), 'package.json'));
type Ev = Record<string, unknown> & { type: string };
type Driver = (spec: Record<string, unknown>, emit: (ev: Ev) => void) => { done: Promise<void> };
const { runClaude } = req('./electron/ai/claude.cjs') as { runClaude: Driver };
const { runCodex } = req('./electron/ai/codex.cjs') as { runCodex: Driver };

/** Run a driver to its last event. */
async function drive(run: Driver, spec: Record<string, unknown>, mode: string) {
  resetCalls();
  const events: Ev[] = [];
  const ctl = run({ exe: fakeExe, cwd: work, prompt: '你好', env: { FAKE_MODE: mode, FAKE_LOG: logFile }, access: 'chat', sandbox: 'read-only', ...spec }, (ev) => events.push(ev));
  await Promise.race([ctl.done, new Promise((_, no) => setTimeout(() => no(new Error(`driver hung (${mode})`)), 20000))]);
  const end = events.find((e) => e.type === 'done' || e.type === 'error');
  return { events, end, notices: events.filter((e) => e.type === 'notice') };
}

/* ───────────────────────── Codex ───────────────────────── */

console.log('Codex: errors and completion');
{
  const r = await drive(runCodex, {}, 'reconnect');
  eq('a stream that dropped and reconnected is a finished turn', [r.end?.type, r.end?.text], ['done', '答好了']);
  eq('each reconnect is a warning, not a red error', r.notices.map((n) => n.level), ['warn', 'warn']);
  expect('…no error event comes out of it', !r.events.some((e) => e.type === 'error'));
}
{
  // The stream recovered after the first notice (Codex prints nothing for that) and stayed quiet longer than half the limit.
  const r = await drive(runCodex, { reconnectLimitMs: 200 }, 'recovered');
  eq('a later blip after a long quiet stretch starts a new streak: the turn is done', [r.end?.type, r.end?.text], ['done', '答好了']);
}
{
  const r = await drive(runCodex, {}, 'fail');
  eq('turn.failed fails the turn with its message', [r.end?.type, r.end?.message, r.end?.code], ['error', 'bad key', 'EXIT_1']);
}
{
  const r = await drive(runCodex, {}, 'exit-error');
  eq('a non-zero exit after a bare error event uses that error as the reason', [r.end?.type, r.end?.message], ['error', 'out of quota']);
}
{
  const r = await drive(runCodex, { sessionId: 'th-old' }, 'lost');
  eq('resuming a thread Codex no longer has is reported as a lost session', [r.end?.type, r.end?.code], ['error', 'SESSION_LOST']);
  expect('…with the CLI\'s own words', /no rollout found/.test(String(r.end?.message)));
  const r2 = await drive(runCodex, {}, 'lost');
  expect('without a session to resume the same failure is an ordinary exit error', r2.end?.code === 'EXIT_1');
}
{
  const t0 = Date.now();
  const r = await drive(runCodex, { reconnectLimitMs: 120 }, 'forever');
  eq('endless 「Reconnecting…」 is cut off with a clear message', [r.end?.type, r.end?.code], ['error', 'NETWORK']);
  expect('…which says what to check', /网络|代理/.test(String(r.end?.message)));
  expect('…and does not wait for ever', Date.now() - t0 < 15000);
}

/* ───────────────────────── Claude Code ───────────────────────── */

console.log('Claude Code: failed results and lost sessions');
{
  const r = await drive(runClaude, {}, 'ok');
  eq('a normal turn is done', [r.end?.type, r.end?.text], ['done', '你好，这是第 1 次回复']);
}
{
  const r = await drive(runClaude, {}, 'errors');
  eq('a failed result without text reports what is in errors', [r.end?.type, r.end?.message, r.end?.code], ['error', 'boom 1\nboom 2', 'error_during_execution']);
}
{
  const r = await drive(runClaude, {}, 'bare');
  eq('with nothing else the subtype is the message', [r.end?.message, r.end?.code], ['error_max_turns', 'error_max_turns']);
}
{
  const r = await drive(runClaude, { sessionId: 'sess-old' }, 'lose');
  eq('--resume of a session Claude no longer has is a lost session', [r.end?.type, r.end?.code], ['error', 'SESSION_LOST']);
  expect('…and its message is the readable one', /No conversation found/.test(String(r.end?.message)));
  eq('…it was asked to resume that id', calls()[0].resumed, 'sess-old');
}
{
  const r = await drive(runClaude, { sessionId: 'sess-old' }, 'lose-stderr');
  eq('the same said only on stderr is recognised too', [r.end?.type, r.end?.code], ['error', 'SESSION_LOST']);
  const r2 = await drive(runClaude, {}, 'lose-always');
  expect('with no session to resume, "No conversation found" is not a lost session', r2.end?.code !== 'SESSION_LOST', String(r2.end?.code));
}

/* ───────────────────────── the system prompt stays put ───────────────────────── */

// The fake bridge runs the real driver behind a fake CLI, and records what live.ts asked for.
const started: StartSpec[] = [];
let mode = 'ok';
let loseOn = '';
let streamSeq = 0;
hooks.start = async (spec: StartSpec) => {
  const id = `st${++streamSeq}`;
  started.push(spec);
  const driver = spec.driver === 'codex' ? runCodex : runClaude;
  const env: Record<string, string> = { ...spec.env, FAKE_MODE: mode, FAKE_LOG: logFile, FAKE_BLOCKED: path.join(work, '.claude', 'settings.local.json') };
  if (loseOn) env.FAKE_LOSE = loseOn;
  setTimeout(() => {
    driver({ ...spec, exe: fakeExe, cwd: work, env, access: spec.access ?? 'work' } as unknown as Record<string, unknown>, (ev) => hooks.handlers.forEach((h) => h({ id, ...ev })));
  }, 5);
  return id;
};

store.init(emptyState(Date.now()));

console.log('The system prompt');
{
  const ctx = { mode: 'firefly' as const, persona: true, callName: '开拓者', cwd: work, mood: '整理星图' };
  const a = live.steadySystem(systemPrompt('chat', ctx, new Date(2026, 9, 1, 3, 5)));
  const b = live.steadySystem(systemPrompt('chat', { ...ctx, mood: '看星星' }, new Date(2026, 9, 30, 21, 40)));
  eq('a command-line model\'s system prompt is the same at any time and in any mood', a, b);
  expect('…and does not carry the clock', !a.includes(whenText(new Date(2026, 9, 1, 3, 5))) && /此刻是 …/.test(a));
  const raw = systemPrompt('chat', ctx, new Date(2026, 9, 1, 3, 5));
  expect('an API model\'s system prompt still has the clock', raw.includes(whenText(new Date(2026, 9, 1, 3, 5))));
  eq('a prompt with no clock line passes through', live.steadySystem('你好'), '你好');
  const line = live.turnContext(true, '整理星图', new Date(2026, 9, 1, 3, 5));
  expect('the per-turn line carries the time and the mood, and says it is not the user\'s', line.includes(whenText(new Date(2026, 9, 1, 3, 5))) && line.includes('整理星图') && line.includes('不是对方说的'));
  expect('…without a persona there is no mood', !live.turnContext(false, '整理星图').includes('整理星图'));
}

/* ───────────────────────── permission check ───────────────────────── */

console.log('Paths outside the task folder');
{
  const roots = ['C:\\Users\\me\\task', 'C:/Users/me/skills'];
  eq('a path inside the folder is not outside', live.outsidePath(roots, ['C:\\Users\\me\\task\\out.txt']), '');
  eq('…whatever the case and slashes', live.outsidePath(roots, ['c:/users/ME/task/sub/a.txt']), '');
  eq('a path in the skills folder is not outside', live.outsidePath(roots, ['C:/Users/me/skills/x/SKILL.md']), '');
  eq('a path elsewhere is outside', live.outsidePath(roots, ['C:\\Users\\me\\other\\a.txt']), 'C:\\Users\\me\\other\\a.txt');
  eq('a folder that only shares a prefix is outside', live.outsidePath(roots, ['C:/Users/me/task-old/a.txt']), 'C:/Users/me/task-old/a.txt');
  eq('a relative path that climbs out is outside', live.outsidePath(roots, ['..\\secret.txt']), '..\\secret.txt');
  eq('a plain relative path is inside', live.outsidePath(roots, ['out.txt']), '');
  eq('the first outside path is the one named', live.outsidePath(roots, ['C:/Users/me/task/a', 'D:/x', 'E:/y']), 'D:/x');
}

/* ───────────────────────── chat history ───────────────────────── */

console.log('What an API model is shown');
{
  const msg = (role: Message['role'], text: string, kind?: Message['kind']): Message => ({ id: text, role, text, at: 1, kind });
  const task = { messages: [msg('user', '问题一'), msg('agent', '没能回复。网络错误：ENOTFOUND', 'error'), msg('user', '问题二'), msg('agent', '回答二')] } as unknown as Task;
  eq('the notice of a failed reply is not an assistant turn', live.chatHistory(task), [{ role: 'user', content: '问题一\n\n问题二' }, { role: 'assistant', content: '回答二' }]);
}

/* ───────────────────────── which program a task runs ───────────────────────── */

console.log('Program path of a task');
{
  store.update((d) => { d.models.providers.deepseek.cliPath = 'X:/tools/claude.cmd'; d.models.providers.deepseek.driver = 'claude-compat'; d.models.providers.deepseek.keyHint = '••••1234'; });
  const eng = (driver: TaskEngine['driver']): TaskEngine => ({ kind: 'live', provider: 'deepseek', auth: 'cli', driver, model: 'deepseek-flash', label: 'DeepSeek', cwd: work });
  const same = live.baseSpec(eng('claude-compat'));
  const other = live.baseSpec(eng('dsh'));
  const none = live.baseSpec(eng(undefined));
  eq('the card\'s path goes to a task on the card\'s current program', same.ok && same.value.path, 'X:/tools/claude.cmd');
  eq('…also to a task that follows the card', none.ok && none.value.path, 'X:/tools/claude.cmd');
  eq('a task on the card\'s other program does not get it, and finds its own on PATH', other.ok && [other.value.driver, other.value.path], ['dsh', undefined]);
}

/* ───────────────────────── a lost session, through live.ts ───────────────────────── */

const claudeEngine: TaskEngine = { kind: 'live', provider: 'claude', auth: 'cli', driver: 'claude-code', model: 'sonnet', label: 'Claude · Claude Code', cwd: work };
const until = async (what: string, cond: () => boolean, ms = 20000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) { expect(`(waiting for ${what})`, false); return false; }
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
};
const task = (id: string) => store.get().tasks[id];

console.log('A chat whose session the CLI lost');
{
  resetCalls();
  mode = 'ok';
  const id = actions.createTask({ title: '闲聊', goal: '第一句话 FIRSTMSG', kind: 'chat', engine: claudeEngine, agentIds: ['orchestrator'], start: true });
  await until('the first reply', () => !live.isReplying(id) && task(id).messages.some((m) => m.role === 'agent'));
  eq('the first turn starts a session', [task(id).session, started.at(-1)?.sessionId], ['sess-1', undefined]);
  const first = started.at(-1)!;
  expect('its message starts with the clock line, and the user\'s words follow', first.prompt?.startsWith('（此刻是') === true && first.prompt.includes('第一句话 FIRSTMSG'));
  expect('the clock line is not in what the chat shows', !task(id).messages.some((m) => m.text.includes('此刻是')));
  expect('its system prompt has no clock', !/^此刻是 \d/m.test(first.system ?? '') && !!first.system?.includes('此刻是 …'));

  mode = 'lose';
  const before = started.length;
  actions.sendMessage(id, '第二句话 SECONDMSG');
  await until('the second reply', () => !live.isReplying(id) && task(id).messages.filter((m) => m.role === 'agent').length >= 2);
  const turns = started.slice(before);
  eq('the turn is tried with the old session, then once without it', [turns.length, turns[0]?.sessionId, turns[1]?.sessionId], [2, 'sess-1', undefined]);
  expect('the new session is told the conversation so far', !!turns[1]?.prompt?.includes('第一句话 FIRSTMSG') && !!turns[1].prompt.includes('你好，这是第 1 次回复') && turns[1].prompt.includes('第二句话 SECONDMSG'));
  eq('the system prompt did not change between the turns', [turns[0]?.system, first.system].map((x) => x), [first.system, first.system]);
  expect('the lost id was forgotten and the new one kept', task(id).session !== 'sess-1' && task(id).session !== 'junk-id' && !!task(id).session, String(task(id).session));
  expect('the chat shows an answer and no error', task(id).messages.at(-1)?.role === 'agent' && !task(id).messages.some((m) => m.kind === 'error'));
  expect('the answer is the new session\'s', /这是第 \d+ 次回复/.test(task(id).messages.at(-1)?.text ?? ''));

  // And the turn after that resumes the new session, as before.
  mode = 'ok';
  const b2 = started.length;
  actions.sendMessage(id, '第三句话');
  await until('the third reply', () => !live.isReplying(id) && task(id).messages.filter((m) => m.role === 'agent').length >= 3);
  eq('the next turn resumes the new session', started[b2]?.sessionId, task(id).session && started[b2]?.sessionId);
  expect('…which is not the lost one', !!started[b2]?.sessionId && started[b2].sessionId !== 'sess-1');
  expect('…and without the transcript again', !started[b2]?.prompt?.includes('FIRSTMSG'));
}

console.log('A chat whose session cannot be recovered');
{
  mode = 'ok';
  const id = actions.createTask({ title: '闲聊二', goal: '开场', kind: 'chat', engine: claudeEngine, agentIds: ['orchestrator'], start: true });
  await until('the first reply', () => !live.isReplying(id) && task(id).messages.some((m) => m.role === 'agent'));
  mode = 'lose-always';
  const before = started.length;
  actions.sendMessage(id, '再说一句');
  await until('the failure', () => !live.isReplying(id) && task(id).messages.some((m) => m.kind === 'error'));
  await new Promise((r) => setTimeout(r, 300));
  eq('only one retry: two starts, never a loop', started.length - before, 2);
  expect('the user is told, with the CLI\'s words', /No conversation found/.test(task(id).messages.find((m) => m.kind === 'error')?.text ?? ''));
}

console.log('A work run whose session the CLI lost');
{
  mode = 'ok';
  const id = actions.createTask({ title: '工作', goal: '做一件事 GOALTEXT', kind: 'work', engine: claudeEngine, agentIds: ['orchestrator'], start: false });
  const before = started.length;
  loseOn = '现在执行第'; // the plan turn is fine; the step turn finds its session gone
  mode = 'lose';
  const started1 = live.startLiveRun(id);
  expect('the run starts', started1.ok);
  const runId = started1.ok ? started1.value : '';
  const finished = await until('the run to end', () => { const r: Run | undefined = store.get().runs[runId]; return !!r && !['running', 'awaiting', 'queued', 'paused'].includes(r.status); });
  const run = store.get().runs[runId];
  eq('the run completes', finished && run?.status, 'completed');
  const turns = started.slice(before);
  // plan, step (lost), step again, summary
  eq('the step is run again without the lost session', [turns.length, /^sess-[0-9]+$/.test(turns[1]?.sessionId ?? ''), turns[2]?.sessionId], [4, true, undefined]);
  expect('…and briefed on the goal and the plan, then the step', !!turns[2]?.prompt?.includes('GOALTEXT') && !!turns[2].prompt.includes('计划：') && turns[2].prompt.includes('现在执行第 1/1 步'));
  expect('every turn starts with the clock line', turns.every((t) => t.prompt?.startsWith('（此刻是')));
  eq('the plan and step turns share one system prompt', turns[0]?.system, turns[1]?.system);
  expect('the run notes what happened', store.get().events.some((e) => e.runId === runId && /找不到之前的会话/.test(e.text)));
  expect('the step finished with its own result', run?.plan[0]?.status === 'done' && /做好了/.test(run.plan[0].result ?? ''));
  expect('the task now holds a session that is not the lost one', !!task(id).session && task(id).session !== turns[1]?.sessionId);
  loseOn = '';
}

console.log("A command policy of 自动 and Claude Code's own safety check");
{
  const shell = store.get().tools.find((t) => t.id === 'shell')!;
  const was = shell.permission;
  store.update((d) => { d.tools.find((t) => t.id === 'shell')!.permission = 'auto'; });
  const ask = async (m: string) => {
    mode = m;
    const id = actions.createTask({ title: '权限', goal: '改一个文件', kind: 'work', engine: claudeEngine, agentIds: ['orchestrator'], start: false });
    const r = live.startLiveRun(id);
    const runId = r.ok ? r.value : '';
    // The fake asks while the step runs: a flagged request waits for the user, an ordinary one is answered at once and the run goes on.
    if (m === 'perm') await until('the approval', () => (store.get().runs[runId]?.approvals.length ?? 0) > 0);
    else await until('the run to end', () => !['running', 'awaiting', 'queued', 'paused'].includes(store.get().runs[runId]?.status ?? 'running'));
    const found = store.get().runs[runId]?.approvals ?? [];
    actions.cancelRun(runId);
    return found;
  };
  const flagged = await ask('perm');
  eq('with 执行命令 = 自动, a request carrying a blockedPath inside the folder still becomes an approval', flagged.length, 1);
  expect('…which says what Claude Code said, not 「工作文件夹以外」', /Claude requested permissions/.test(flagged[0]?.reason ?? '') && !/工作文件夹以外/.test(flagged[0]?.reason ?? ''), String(flagged[0]?.reason));
  const plain = await ask('perm-plain');
  eq('…while the same command with no blockedPath is allowed without asking', plain.length, 0);
  store.update((d) => { d.tools.find((t) => t.id === 'shell')!.permission = was; });
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a child may still hold the folder */ }
console.log(failures ? `\n${failures} check(s) failed` : '\nAll driver checks passed');
process.exit(failures ? 1 : 0);
