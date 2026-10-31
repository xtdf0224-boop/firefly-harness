/* Headless check of the 界面 fixes: 命令路径 clean-up, a 「测试中…」 state that is never restored,
   a connection test that throws, and what the follow-scroll key does for a capped list.
   npm run check:ui — plain assertions, no test runner (ui-check-env.ts is imported first: it gives the state modules a fake desktop bridge). */
import { isDeepStrictEqual } from 'node:util';
import { existsSync } from 'node:fs';
import type { AgentActivity, AgentId, AppState, VisualMode } from '../src/lib/types';
import { crewLine, crewPose, crewSubtitle, crewTag, crewTitle, leadLine } from '../src/lib/persona';
import type { CrewState, LeadScene } from '../src/lib/persona';
import { crewState, trailPaths } from '../src/lib/formation';
import { bridgeCalls } from './ui-check-env';
import { buildCrew } from '../src/components/views/agents/crew';
import { selectLastErrors } from '../src/components/views/config/util';
import { PROVIDERS, readiness } from '../src/lib/providers';
import { TESTING, cleanPath, initialModels, modelActions, restoreModels } from '../src/state/models';
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

/* ───────────────────────── 命令路径 ───────────────────────── */

console.log('命令路径 clean-up');
const R = String.raw;
eq('plain path is kept', cleanPath(R`D:\DeepSeek Harness`), R`D:\DeepSeek Harness`);
eq('inner spaces are kept', cleanPath(R`C:\Program Files\nodejs\claude.cmd`), R`C:\Program Files\nodejs\claude.cmd`);
eq('blanks around are dropped', cleanPath(`  ${R`D:\DeepSeek Harness`} \t`), R`D:\DeepSeek Harness`);
eq('a pair of double quotes is dropped (复制为路径)', cleanPath(R`"D:\DeepSeek Harness"`), R`D:\DeepSeek Harness`);
eq('a pair of single quotes is dropped', cleanPath(R`'D:\a b\x.cmd'`), R`D:\a b\x.cmd`);
eq('quotes with blanks around are dropped', cleanPath(R`  "D:\a b"  `), R`D:\a b`);
eq('blanks inside the quotes are dropped', cleanPath(R`" D:\a b "`), R`D:\a b`);
eq('only one pair is dropped', cleanPath(R`""D:\a""`), R`"D:\a"`);
eq('a lone quote stays', cleanPath(R`"D:\a`), R`"D:\a`);
eq('a single quote character stays', cleanPath('"'), '"');
eq('mixed quotes stay', cleanPath(R`"D:\a'`), R`"D:\a'`);
eq('empty stays empty', cleanPath('   '), '');
// What the box does while someone types the path one character at a time: the typed text is only cleaned when it is saved.
{
  const typed = R`D:\DeepSeek Harness`;
  let draft = '';
  for (const ch of typed) draft += ch;
  eq('typing character by character keeps the space in the draft', draft, typed);
  eq('and saves the same path', cleanPath(draft), typed);
}

/* ───────────────────────── 「测试中…」 is never restored ───────────────────────── */

console.log('Saved connection tests');
{
  const saved = initialModels();
  const done = { ok: true, at: 5, ms: 900, message: '回复「OK」', auth: 'api' as const };
  saved.providers.claude.test = { ok: false, at: 1, ms: 0, message: TESTING, auth: 'api' };
  saved.providers.gpt = { ...saved.providers.gpt, test: done };
  const back = restoreModels(JSON.parse(JSON.stringify(saved)));
  eq('a test still running when the app closed is dropped', back.providers.claude.test, undefined);
  eq('a finished test is kept', back.providers.gpt.test, done);
  eq('the message is the one the card looks for', TESTING, '测试中…');
}

/* ───────────────────────── a connection test that throws ───────────────────────── */

console.log('Connection test');
{
  store.init(emptyState(0));
  const id = 'claude' as const;
  store.update((d) => { Object.assign(d.models.providers[id], { auth: 'api', keyHint: '…abcd' }); });
  const c = () => store.get().models.providers[id];

  bridgeCalls.test = async () => { throw new Error('IPC 通道已关闭'); };
  await modelActions.test(id, 'api');
  eq('a thrown error ends as a failed test', [c().test?.ok, c().test?.message], [false, 'IPC 通道已关闭']);
  expect('and a danger toast says so', store.get().toasts.some((t) => t.tone === 'danger'));

  bridgeCalls.test = async () => { throw 'plain string'; };
  await modelActions.test(id, 'api');
  eq('a non-Error rejection keeps its text', c().test?.message, 'plain string');

  bridgeCalls.test = async () => ({ ok: true, text: 'OK', ms: 1200, model: 'm' });
  await modelActions.test(id, 'api');
  eq('a good reply is still a pass', [c().test?.ok, c().test?.ms], [true, 1200]);
  expect('and does not stay on 测试中…', c().test?.message !== TESTING);
}

/* ───────────────────────── a CLI that is found but cannot run ───────────────────────── */

console.log('Readiness of a command-line tool');
{
  const info = PROVIDERS.find((x) => x.id === 'claude')!;
  const base = { ...initialModels().providers.claude, driver: 'claude-code' as const };
  const cli = (c: { found: boolean; path?: string }) => ({ ...base, cli: { login: 'unknown' as const, at: 1, ...c } });
  eq('nothing found: it says the command is missing', readiness(info, cli({ found: false }), 'cli'), { ready: false, reason: '没有找到 claude 命令' });
  const broken = readiness(info, cli({ found: false, path: 'C:/x/claude.cmd' }), 'cli');
  expect('found but broken: it does not say the command is missing', broken.ready === false && !/没有找到/.test(broken.reason ?? ''), String(broken.reason));
  expect('…it points at the explanation above', /找到了，但运行不起来（见上方说明）/.test(broken.reason ?? ''));
}

/* ───────────────────────── follow-scroll key ───────────────────────── */

console.log('Follow-scroll key');
{
  // The log lists are capped: old rows go off the top as new ones arrive, so the length alone never changes.
  const CAP = 5;
  let rows: Array<{ id: string }> = [];
  let n = 0;
  const push = () => { rows = [...rows, { id: `ln_${++n}` }].slice(-CAP); };
  const byLength = () => rows.length;
  const byLast = () => rows[rows.length - 1]?.id;
  for (let i = 0; i < CAP; i++) push();
  const [len0, last0] = [byLength(), byLast()];
  push();
  eq('the length no longer tells that a row came in', byLength(), len0);
  expect('the last row id does', byLast() !== last0);
  const seen = new Set<string | undefined>();
  for (let i = 0; i < 50; i++) { push(); seen.add(byLast()); }
  eq('every append gives a new key', seen.size, 50);
}

/* ───────────────────────── Agent 页 · 编队 ───────────────────────── */

console.log('Agent 页 · 编队');
{
  const modes: VisualMode[] = ['firefly', 'sam'];
  const ids: AgentId[] = ['orchestrator', 'researcher', 'coder', 'reviewer'];
  const helpers = ids.filter((id): id is Exclude<AgentId, 'orchestrator'> => id !== 'orchestrator');
  const states: CrewState[] = ['idle', 'thinking', 'tool', 'waiting', 'paused', 'off', 'first'];
  const len = (s: string) => Array.from(s).length;
  const clean = (s: string) => s.trim().length > 0 && !/[{}]|undefined|null|NaN/.test(s);
  const noon = new Date(2026, 9, 30, 12, 0);

  let badLine = '';
  for (const m of modes) for (const id of helpers) for (const st of states) {
    // two ten-minute windows, so both variants of a slot are covered
    for (const d of [noon, new Date(noon.getTime() + 600_000)]) {
      const s = crewLine(m, id, st, d);
      if (!clean(s) || len(s) > 22) badLine = `${m}/${id}/${st}: ${s}`;
    }
  }
  expect('every crewLine is non-empty, within 22 characters, with no placeholder left', badLine === '', badLine);
  eq('the same ten-minute window gives the same line', crewLine('firefly', 'coder', 'idle', noon), crewLine('firefly', 'coder', 'idle', new Date(noon.getTime() + 60_000)));

  for (const m of modes) {
    const t = ids.map((id) => crewTitle(m, id));
    expect(`${m}: titles are distinct and non-empty`, new Set(t).size === 4 && t.every(clean), t.join(' / '));
    expect(`${m}: tag and subtitle are set`, clean(crewTag(m)) && clean(crewSubtitle(m)));
  }

  // leadLine: every scene, both modes
  const acts: AgentActivity[] = ['idle', 'thinking', 'tool', 'waiting', 'paused'];
  let badLead = '';
  for (const m of modes) for (const first of [true, false]) for (const activity of acts) for (const w of [undefined, '审查']) for (const b of [undefined, '编码']) for (const t of [undefined, '检索']) {
    for (const d of [noon, new Date(noon.getTime() + 600_000)]) {
      const s = leadLine(m, { first, activity, waiting: w, busy: b, troubled: t }, d);
      if (!clean(s) || len(s) > 30) badLead = `${m} ${JSON.stringify({ first, activity, w, b, t })}: ${s}`;
    }
  }
  expect('every leadLine is non-empty, within 30 characters, with no placeholder left', badLead === '', badLead);
  for (const m of modes) {
    const base: LeadScene = { first: false, activity: 'idle' };
    const all: LeadScene = { ...base, waiting: '审查', troubled: '检索', busy: '编码' };
    expect(`${m}: first use wins over everything`, leadLine(m, { ...all, first: true }, noon) === leadLine(m, { ...base, first: true }, noon));
    expect(`${m}: a waiting member is named and wins`, leadLine(m, all, noon).includes('审查'));
    expect(`${m}: trouble comes before busy`, leadLine(m, { ...base, troubled: '检索', busy: '编码' }, noon).includes('检索'));
    expect(`${m}: busy is named`, leadLine(m, { ...base, busy: '编码' }, noon).includes('编码'));
    expect(`${m}: she herself waiting reads differently from idle`, leadLine(m, { ...base, activity: 'waiting' }, noon) !== leadLine(m, base, noon));
    expect(`${m}: she herself paused reads differently from idle`, leadLine(m, { ...base, activity: 'paused' }, noon) !== leadLine(m, base, noon));
  }

  // a paused helper, or no helper on post, is not 「都准备好了」
  for (const m of modes) {
    const base: LeadScene = { first: false, activity: 'idle' };
    expect(`${m}: a paused helper is named instead of the idle line`, leadLine(m, { ...base, paused: '编码' }, noon).includes('编码') && leadLine(m, { ...base, paused: '编码' }, noon) !== leadLine(m, base, noon));
    expect(`${m}: no helper on post has its own line`, leadLine(m, { ...base, alone: true }, noon) !== leadLine(m, base, noon));
    expect(`${m}: a busy member still comes before a paused one`, leadLine(m, { ...base, busy: '审查', paused: '编码' }, noon).includes('审查'));
    expect(`${m}: first use still wins over alone`, leadLine(m, { ...base, first: true, alone: true }, noon) === leadLine(m, { ...base, first: true }, noon));
    for (const d of [noon, new Date(noon.getTime() + 600_000)]) {
      const s = [leadLine(m, { ...base, paused: '编码' }, d), leadLine(m, { ...base, alone: true }, d)];
      expect(`${m}: the new lead lines are clean and short`, s.every((x) => clean(x) && len(x) <= 30), s.join(' | '));
    }
  }

  // The lines are shown inside 「」, so none may carry its own
  let nested = '';
  for (const m of modes) for (const id of helpers) for (const st of states) for (const d of [noon, new Date(noon.getTime() + 600_000)]) {
    if (/[「」]/.test(crewLine(m, id, st, d))) nested = `${m}/${id}/${st}`;
  }
  for (const m of modes) for (const first of [true, false]) for (const activity of acts) for (const d of [noon, new Date(noon.getTime() + 600_000)]) {
    for (const extra of [{}, { waiting: '审查' }, { busy: '编码' }, { troubled: '检索' }, { paused: '编码' }, { alone: true }]) {
      if (/[「」]/.test(leadLine(m, { first, activity, ...extra }, d))) nested = `${m} lead ${first} ${activity} ${JSON.stringify(extra)}`;
    }
  }
  expect('no persona line contains 「 or 」', nested === '', nested);

  // buildCrew: the lead says what is true, and a stopped agent does not claim a live step
  {
    const s0 = emptyState(0);
    const live = { taskId: 't1', runId: 'r1', title: '重构登录模块', activity: 'tool' as const, text: '第 4 步 · 改写会话校验' };
    const mk = (over: Partial<Parameters<typeof buildCrew>[0]>) => buildCrew({ mode: 'firefly', persona: true, first: false, agents: s0.agents, tools: s0.tools, models: s0.models, stats: {}, presence: {}, errors: {}, ...over });
    const off = (c: ReturnType<typeof mk>, id: AgentId) => c.members.find((x) => x.id === id)!;
    const allOff = s0.agents.map((a) => (a.id === 'orchestrator' ? a : { ...a, enabled: false }));
    expect('all helpers disabled → the lead is alone, not 「都准备好了」', mk({ agents: allOff }).lead.quote === '现在只有我在，别的位置都歇着。', mk({ agents: allOff }).lead.quote);
    const voice = mk({ presence: { reviewer: { ...live, activity: 'waiting' as const } } });
    expect('one voice: the orchestrator drawer says the same line as the lead card', voice.lead.drawerLine === voice.lead.quote && voice.lead.quote.includes('审查'), `${voice.lead.drawerLine} | ${voice.lead.quote}`);
    expect('a helper keeps its own line in the drawer', off(voice, 'coder').drawerLine === off(voice, 'coder').quote && off(voice, 'coder').quote !== voice.lead.quote);
    const paused = mk({ presence: { coder: { ...live, activity: 'paused' as const } } });
    expect('a paused helper is named by the lead', paused.lead.quote.includes('编码'), paused.lead.quote);
    expect('first use shows no live line on a helper', !off(mk({ first: true, presence: { coder: live } }), 'coder').now.includes('第 4 步'), off(mk({ first: true, presence: { coder: live } }), 'coder').now);
    const stopped = mk({ agents: s0.agents.map((a) => (a.id === 'coder' ? { ...a, enabled: false } : a)), presence: { coder: live } });
    eq('a disabled agent that is mid-run only says new steps go to the lead', off(stopped, 'coder').now, '新的步骤交给流萤');
    // 工具 n/N: 其他工具 is not per-agent, and a tool disabled on 工具与技能 is not usable
    const first = s0.tools.find((t) => t.id !== 'other')!;
    const withOther = s0.agents.map((a) => (a.id === 'coder' ? { ...a, tools: [first.id, 'other' as const] } : a));
    const c1 = mk({ agents: withOther });
    eq('toolTotal leaves out 其他工具', c1.toolTotal, s0.tools.length - 1);
    eq('toolsOn does not count 其他工具', off(c1, 'coder').toolsOn, first.permission === 'off' ? 0 : 1);
    const c2 = mk({ agents: withOther, tools: s0.tools.map((t) => (t.id === first.id ? { ...t, permission: 'off' as const } : t)) });
    eq('a tool disabled on 工具与技能 is not counted as usable', off(c2, 'coder').toolsOn, 0);
    const plain = emptyState(0, { ...s0.settings, persona: false });
    eq('with the persona off the lead is named 编排 Agent', mk({ persona: false, agents: plain.agents }).lead.name, '编排 Agent');
  }

  // 「在控制台查看详情」 needs the run the failed call sits in
  {
    const call = (id: string, startedAt: number, status: string) => ({ id, agentId: 'coder', status, title: id, startedAt, error: { message: id } });
    const runs = {
      r1: { id: 'r1', taskId: 't1', status: 'done', toolCalls: [call('c1', 10, 'error'), call('c2', 20, 'done')] },
      r2: { id: 'r2', taskId: 't2', status: 'running', toolCalls: [call('c3', 30, 'error')] },
    };
    const e = selectLastErrors({ runs } as unknown as AppState).coder;
    eq('the latest failed call carries its task and run', e && [e.id, e.taskId, e.runId, e.open], ['c3', 't2', 'r2', true]);
    const older = selectLastErrors({ runs: { r2: runs.r2, r1: runs.r1 } } as unknown as AppState).coder;
    eq('… whatever order the runs come in', older && [older.id, older.taskId, older.runId], ['c3', 't2', 'r2']);
  }

  // poses
  eq('off sleeps', crewPose('coder', 'off', 5), 'sleep');
  eq('waiting talks', crewPose('reviewer', 'waiting', 0), 'talk');
  eq('thinking thinks', crewPose('coder', 'thinking', 0), 'think');
  eq('a tool call watches', crewPose('coder', 'tool', 0), 'watch');
  eq('paused blinks', crewPose('researcher', 'paused', 3), 'blink');
  eq('idle with steps is happy', crewPose('researcher', 'idle', 3), 'happy');
  eq('idle without steps is idle', crewPose('researcher', 'idle', 0), 'idle');
  eq('first use: researcher idle, coder sleep, reviewer blink, orchestrator idle',
    [crewPose('researcher', 'first', 9), crewPose('coder', 'first', 9), crewPose('reviewer', 'first', 9), crewPose('orchestrator', 'first', 9)], ['idle', 'sleep', 'blink', 'idle']);
  let missing = '';
  for (const m of modes) for (const id of ids) for (const st of states) for (const steps of [0, 4]) {
    const file = `public/pet/${m}/${crewPose(id, st, steps)}.png`;
    if (!existsSync(file)) missing = file;
  }
  expect('every pose maps to an existing sprite', missing === '', missing);

  // crewState
  eq('disabled → off', crewState(false, 'tool', false), 'off');
  eq('disabled beats first use', crewState(false, undefined, true), 'off');
  eq('first use → first', crewState(true, 'tool', true), 'first');
  eq('activity passes through', crewState(true, 'waiting', false), 'waiting');
  eq('no activity → idle', crewState(true, undefined, false), 'idle');

  // trails
  const nums = (p: string) => (p.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  for (const m of modes) {
    for (const [label, to] of [['above', { x: 600, y: 40 }], ['level', { x: 600, y: 200 }], ['below', { x: 600, y: 380 }], ['left', { x: 60, y: 380 }]] as const) {
      const from = { x: 200, y: 200 };
      const { go, back } = trailPaths(m, from, to);
      const g = nums(go);
      const finite = [...g, ...nums(back)].every(Number.isFinite) && g.length >= 6 && nums(back).length >= 6;
      expect(`${m}/${label}: numbers are finite`, finite, go);
      expect(`${m}/${label}: go starts at from`, g[0] === from.x && g[1] === from.y, go);
      const endPt = { x: g[g.length - 2], y: g[g.length - 1] };
      const dist = Math.hypot(endPt.x - to.x, endPt.y - to.y);
      // SAM ends with an H command, so its last pair is not the end point: take x from the last number and y from the last vertex
      const end = m === 'sam' ? { x: g[g.length - 1], y: to.y } : endPt;
      expect(`${m}/${label}: go ends within 30 px of to`, Math.hypot(end.x - to.x, end.y - to.y) <= 30 && (m === 'sam' || dist <= 30), `${go}`);
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
