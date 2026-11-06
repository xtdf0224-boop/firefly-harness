/* The page side of the API tools: the real src/state/live.ts against a fake desktop bridge (driver-check-env.ts) whose
   streams are scripted like the main process's tool loop is — what spec an API work task is started with (tools, folder,
   prompts), how each question is answered (自动 / 待确认 / mustAsk / deny / read-only), the final answer being used, the
   supplements, the Coding Plan note, and how older tasks stay as they were. Review fixes: the card says when it cut, a service
   without tool calls moves the run to think-and-write (NO_RESPONSES / NO_TOOLS), the plan is found in the whole reply, skills reach
   a turn without read_file, and the new-task hint puts 只读 first. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hooks } from './driver-check-env';
import { actions } from '../src/state/actions';
import { workHint } from '../src/components/views/tasks/Composer';
import * as live from '../src/state/live';
import { emptyState } from '../src/state/seed';
import { store } from '../src/state/store';
import type { AgentId } from '../src/lib/types';
import { type Any, eq, expect, section } from './apitools-check-lib';

const DENIED_CARD = '你拒绝了这次调用，它没有执行。';

const until = async (what: string, cond: () => boolean, ms = 10000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) { expect(`(waiting for ${what})`, false); return false; }
    await new Promise((r) => setTimeout(r, 15));
  }
  return true;
};

export async function rendererChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-apitools-page-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  store.init(emptyState(Date.now()));
  store.update((d: Any) => { for (const id of ['deepseek', 'qwen']) d.models.providers[id].keyHint = '••••1234'; });

  /* The fake desktop side: a scripted stream per turn. Like the real one it registers the wait for an answer before it sends the question. */
  let seq = 0;
  const waiters = new Map<string, (decision: string) => void>();
  hooks.onAnswer = (_id, requestId, decision) => { const w = waiters.get(requestId); if (w) { waiters.delete(requestId); w(decision); } };
  const emit = (id: string, ev: Record<string, unknown>) => hooks.handlers.forEach((h) => h({ id, type: String(ev.type), ...ev }));
  const waitAnswer = (requestId: string) => new Promise<string>((resolve) => waiters.set(requestId, resolve));
  const ask = (id: string, ev: Record<string, unknown>) => { const w = waitAnswer(String(ev.requestId)); emit(id, { type: 'permission', ...ev }); return w; };
  type Script = (spec: Any, id: string, text: string) => Promise<void>;
  let script: Record<string, Script> = {};
  const specs = hooks.starts as Any[];
  hooks.start = async (spec: never) => {
    const id = `st${++seq}`;
    specs.push(spec);
    setTimeout(() => { void turn(spec as Any, id); }, 5);
    return id;
  };
  const userText = (spec: Any): string => { const m = spec.messages?.at(-1); return typeof m?.content === 'string' ? m.content : (spec.prompt ?? ''); };
  const PLAN = '```json\n{"steps":[{"title":"写文件","detail":"写 a.txt","agent":"orchestrator"},{"title":"检查","detail":"读回来","agent":"reviewer"}]}\n```';
  async function turn(spec: Any, id: string) {
    const text = userText(spec);
    const phase = text.includes('请先用你的口吻说一两句话') ? 'plan' : text.includes('现在执行第') ? 'step' : 'summary';
    const step = /现在执行第 (\d)\//.exec(text)?.[1];
    const custom = script[phase + (step ?? '')];
    if (custom) { await custom(spec, id, text); return; }
    if (phase === 'plan') {
      emit(id, { type: 'text', text: '我先看看。' });
      emit(id, { type: 'text-break' });
      if (spec.tools) {
        const input = { path: work };
        emit(id, { type: 'tool', callId: 'c1', name: 'list_directory', input, title: '列出 .' });
        const d = await ask(id, { requestId: 'r1', callId: 'c1', name: 'list_directory', input, title: '列出 .' });
        emit(id, { type: 'tool-end', callId: 'c1', ok: d === 'allow', output: 'a.txt' });
      }
      emit(id, { type: 'text', text: '例如这样：\n```json\n[1,2,3]\n```\n' });
      emit(id, { type: 'text-break' });
      emit(id, { type: 'text', text: `好，计划如下。\n${PLAN}` });
      emit(id, { type: 'done', text: `我先看看。\n\n例如这样：\n\`\`\`json\n[1,2,3]\n\`\`\`\n\n好，计划如下。\n${PLAN}`, final: `好，计划如下。\n${PLAN}`, stopReason: 'stop' });
      return;
    }
    emit(id, { type: 'text', text: phase === 'step' ? `做完了。\n小结：完成第 ${step} 步` : '汇报：都做完了。' });
    emit(id, { type: 'done', text: '', stopReason: 'stop', ...(phase === 'step' ? { final: `做完了。\n小结：完成第 ${step} 步` } : {}) });
  }
  const engineOf = (over: Record<string, unknown> = {}): Any => ({ kind: 'live', provider: 'deepseek', auth: 'api', model: 'deepseek-flash', label: 'DeepSeek V4.1 Flash · API', cwd: work, access: 'policy', ...over });
  const tasks = () => store.get().tasks as Any;
  const runOf = (taskId: string): Any => store.get().runs[tasks()[taskId].runIds.at(-1)] as Any;
  const doneRun = (taskId: string) => until('the run to end', () => ['completed', 'failed'].includes(runOf(taskId)?.status));
  const reset = () => { specs.length = 0; hooks.answers.length = 0; hooks.inputs.length = 0; hooks.stops.length = 0; };
  const setTools = (fn: (id: string) => string | undefined) => store.update((d: Any) => { for (const t of d.tools) { const p = fn(t.id); if (p) t.permission = p; } });
  const create = (title: string, goal: string, engine: Any, agentIds: AgentId[] = ['orchestrator']) => actions.createTask({ title, goal, kind: 'work', engine, agentIds, start: true }) as string;

  section('canAct');
  {
    const e = (o: Record<string, unknown>): Any => ({ kind: 'live', provider: 'claude', model: 'm', label: 'x', ...o });
    expect('a command-line agent can act, in any access', live.canAct(e({ auth: 'cli' }), 'work') && live.canAct(e({ auth: 'cli' }), 'chat'));
    expect('an API model with a folder acts in a work task', live.canAct(e({ auth: 'api', cwd: 'D:/w' }), 'work'));
    expect('…but not in chat access (the summary)', !live.canAct(e({ auth: 'api', cwd: 'D:/w' }), 'chat'));
    expect('…and not without a folder (older tasks)', !live.canAct(e({ auth: 'api' }), 'work'));
  }

  section('An API work task with a folder: plan, steps, summary');
  let tid = '';
  {
    tid = create('T', '做一件事 GOAL1', engineOf(), ['orchestrator', 'reviewer']);
    await until('the plan turn\'s question to be answered', () => hooks.answers.length >= 1);
    const plan = specs[0];
    eq('plan turn: driver, folder, access', [plan.driver, plan.cwd, plan.access], ['api-openai', work, 'work']);
    eq('plan turn: it may only look', plan.tools, ['read_file', 'code_search']);
    expect('plan turn: one user message, the plan prompt', plan.messages.length === 1 && plan.messages[0].role === 'user' && plan.messages[0].content.includes('任务目标：\n做一件事 GOAL1'));
    expect('plan turn: the roster tells the helper it can act', plan.messages[0].content.includes('reviewer：') && plan.messages[0].content.includes('由你以这个角色完成') && plan.messages[0].content.includes('你可以先只读地了解'));
    expect('plan turn: the work-folder system prompt, with the folder named', plan.system.includes(`工作文件夹「${work}」`) && !plan.system.includes('没有任何工具'));
    expect('plan turn: room for 16000 tokens and a context limit', plan.maxTokens >= 16000 && plan.contextLimit === 1_000_000);
    expect('plan turn: not read-only, no browser, no confirmAll', plan.readOnly === false && plan.browser === false && plan.confirmAll === undefined);
    eq('the read inside the folder under the 自动 policy was allowed by the page', hooks.answers[0].decision, 'allow');
    await until('step 1 to start', () => specs.length >= 2);
    eq('the plan was read from the final answer, not from the example block in the chat', runOf(tid).plan.map((s: Any) => s.title), ['写文件', '检查']);
    await doneRun(tid);
    const r = runOf(tid);
    eq('the run completes', r.status, 'completed');
    const [, s1, s2, sum] = specs;
    eq('step 1 tools: the 编排 Agent follows the policy alone', s1.tools, ['read_file', 'code_search', 'write_file', 'shell', 'git', 'web_search', 'web_fetch']);
    eq('step 2 (the reviewer) tools: its own list, in the fixed order', s2.tools, ['read_file', 'code_search', 'shell']);
    expect('step 1 is one message: briefing, ---, the step', s1.messages.length === 1 && s1.messages[0].content.includes('任务目标：\n做一件事 GOAL1') && s1.messages[0].content.includes('\n\n---\n\n现在执行第 1/2 步') && s1.messages[0].content.includes('计划：\n1. 写文件'));
    expect('step 1 says the tools may be used', s1.messages[0].content.includes('可以用你的工具在工作文件夹里完成这一步'));
    expect('step 2\'s briefing has step 1\'s result, marked unverified', s2.messages[0].content.includes('已完成的步骤（以下是 Agent 的产出，未经核实）') && s2.messages[0].content.includes('### 写文件\n') && s2.messages[0].content.includes('完成第 1 步'));
    expect('step 2 prompt: the helper\'s role with the folder, not the old "no permissions" claim', s2.system.includes('你是审查 Agent') && s2.system.includes(work) && !s2.system.includes('没有文件、网络或命令权限'));
    expect('the summary has no tools, no folder, no access', sum.tools === undefined && sum.cwd === undefined && sum.access === undefined && sum.confirmAll === undefined);
    expect('…it is the summary prompt over the plan prompt and the results', sum.system.includes('你负责向对方汇报') && sum.messages.length >= 3 && sum.messages[0].content.includes('由你以这个角色完成'));
    eq('step results are the final answers', r.plan.map((s: Any) => s.result), ['做完了。\n小结：完成第 1 步', '做完了。\n小结：完成第 2 步']);
    eq('notes come from the 小结 line', r.plan.map((s: Any) => s.note), ['完成第 1 步', '完成第 2 步']);
  }

  section('Approvals: confirm, mustAsk, reason, risk, preview, deny');
  {
    reset();
    script = {
      step1: async (_spec, id) => {
        emit(id, { type: 'text', text: '先写文件。' });
        emit(id, { type: 'text-break' });
        const input = { path: path.join(work, 'a.txt'), content: 'line1\nline2', mode: 'append', contentBytes: 30000 };
        emit(id, { type: 'tool', callId: 'c2', name: 'write_file', input, title: '写入 a.txt（追加）' });
        const w = waitAnswer('r2');
        emit(id, { type: 'permission', requestId: 'r2', callId: 'c2', name: 'write_file', input, title: '写入 a.txt（追加）', reason: '追加 29.3 KB', risk: 'high', mustAsk: true });
        const d = await w;
        emit(id, { type: 'tool-end', callId: 'c2', ok: d === 'allow', output: '已追加' });
        // a read of .env: the 自动 policy would let it through, mustAsk does not
        const rin = { path: path.join(work, '.env') };
        emit(id, { type: 'text-break' });
        emit(id, { type: 'tool', callId: 'c3', name: 'read_file', input: rin, title: '读取 .env' });
        const d2 = await ask(id, { requestId: 'r3', callId: 'c3', name: 'read_file', input: rin, title: '读取 .env', reason: '这可能是密钥或凭据文件，内容会发给模型服务商', risk: 'high', mustAsk: true });
        emit(id, { type: 'tool-end', callId: 'c3', ok: d2 === 'allow', output: DENIED_CARD });
        // a place outside the folder, with the desktop side's own reason
        const oin = { path: path.join(dir, 'other', 'x.txt') };
        emit(id, { type: 'tool', callId: 'c4', name: 'read_file', input: oin, title: '读取 ../other/x.txt' });
        await ask(id, { requestId: 'r4', callId: 'c4', name: 'read_file', input: oin, title: '读取 ../other/x.txt', reason: '实际位置：D:\\x（经过目录联接）', blockedPath: oin.path, risk: 'high' });
        emit(id, { type: 'tool-end', callId: 'c4', ok: false, output: 'x' });
        emit(id, { type: 'done', text: '写了一些。\n小结：不全', final: '写了一些。\n小结：不全', stopReason: 'max_rounds' });
      },
    };
    setTools((id) => (id === 'read_file' ? 'auto' : undefined));
    const id = create('T2', '审批 GOAL2', engineOf());
    await until('the first approval', () => (runOf(id)?.approvals.length ?? 0) >= 1);
    let r = runOf(id);
    const a1 = r.approvals[0];
    expect('the write is an approval, high risk from the desktop side', a1.tool === 'write_file' && a1.risk === 'high' && a1.status === 'pending');
    expect('…titled with the tool and the call', a1.title.startsWith('写入文件：写入 a.txt（追加）'), a1.title);
    expect('…the reason is the desktop side\'s', a1.reason === '追加 29.3 KB', a1.reason);
    expect('…the preview says append and the full size', a1.preview.startsWith(`+++ ${path.join(work, 'a.txt')}（追加）`) && a1.preview.endsWith('…（共 29 KB，只显示开头）'), a1.preview);
    expect('the stream was not answered before the person decided', !hooks.answers.some((a) => a.requestId === 'r2'));
    actions.decideApproval(a1.id, 'approve');
    await until('the second approval', () => runOf(id).approvals.length >= 2);
    r = runOf(id);
    const a2 = r.approvals[1];
    eq('mustAsk made a read under 自动 ask anyway', [a2.tool, a2.status, a2.risk], ['read_file', 'pending', 'high']);
    expect('…with the desktop side\'s reason', a2.reason.includes('密钥或凭据文件'), a2.reason);
    eq('the first approval reached the stream as allow', hooks.answers.map((a) => [a.requestId, a.decision]), [['r1', 'allow'], ['r2', 'allow']]);
    actions.decideApproval(a2.id, 'reject');
    await until('the third approval', () => runOf(id).approvals.length >= 3);
    r = runOf(id);
    const a3 = r.approvals[2];
    expect('the note about the place outside the folder and the desktop reason are both kept', a3.reason.includes('这次要访问工作文件夹以外的位置') && a3.reason.includes('实际位置：D:\\x（经过目录联接）'), a3.reason);
    expect('a rejected call shows as denied, not as an error', r.toolCalls.find((c: Any) => c.id === a2.toolCallId)?.status === 'denied');
    actions.decideApproval(a3.id, 'approve');
    await doneRun(id);
    r = runOf(id);
    eq('the answers reached the stream in order', hooks.answers.map((a) => [a.requestId, a.decision]), [['r1', 'allow'], ['r2', 'allow'], ['r3', 'deny'], ['r4', 'allow']]);
    expect('a run that hit the call limit says so in the conversation', tasks()[id].messages.some((m: Any) => m.role === 'system' && m.text === '这一步调用工具的次数到了上限，先停在这里。'));
    expect('…the step still counts as done, the reason in its note', r.plan[0].status === 'done' && r.plan[0].note.startsWith('调用工具的次数到了上限，先停在这里') && r.plan[0].note.includes('不全'), String(r.plan[0].note));
    expect('the rejected call left no error record', !r.errors.some((e: Any) => e.toolCallId === a2.toolCallId));
    script = {};
  }

  section('Policy decides the rest: auto in the folder, deny when disabled or not this agent\'s');
  {
    reset();
    script = {
      step1: async (_spec, id) => {
        const calls: Array<[string, string, Record<string, unknown>]> = [
          ['r10', 'read_file', { path: path.join(work, 'a.txt') }],
          ['r11', 'write_file', { path: path.join(work, 'b.txt'), content: 'x', mode: 'create' }],
          ['r12', 'run_shell_command', { command: 'git log (Start-Process calc)' }],
          ['r13', 'run_shell_command', { command: 'git status' }],
        ];
        for (const [requestId, name, input] of calls) {
          emit(id, { type: 'tool', callId: requestId, name, input, title: name });
          const d = await ask(id, { requestId, callId: requestId, name, input, title: name });
          emit(id, { type: 'tool-end', callId: requestId, ok: d === 'allow', output: d === 'allow' ? 'ok' : DENIED_CARD });
        }
        emit(id, { type: 'done', text: '好。\n小结：试过了', final: '好。\n小结：试过了', stopReason: 'stop' });
      },
    };
    setTools((id) => (id === 'read_file' ? 'auto' : id === 'git' ? 'auto' : id === 'shell' ? 'confirm' : id === 'write_file' ? 'off' : undefined));
    const id = create('T2b', '策略 GOAL2b', engineOf());
    await until('the questions', () => (runOf(id)?.approvals.length ?? 0) >= 1 && hooks.answers.length >= 2);
    const byId = (rid: string) => hooks.answers.find((a) => a.requestId === rid)?.decision;
    eq('read under 自动, inside the folder: allowed by the page', byId('r10'), 'allow');
    eq('a write while writing is switched off: denied by the page', byId('r11'), 'deny');
    expect('git (auto) with a PowerShell sub-expression is a shell command: it was not answered, it waits for the person', byId('r12') === undefined);
    expect('…and it shows as a 执行命令 approval', runOf(id).approvals.some((a: Any) => a.tool === 'shell' && a.status === 'pending'), runOf(id).approvals);
    actions.decideApproval(runOf(id).approvals.find((a: Any) => a.tool === 'shell').id, 'approve');
    await doneRun(id);
    eq('a plain git status under the git policy 自动 is allowed without a question', byId('r13'), 'allow');
    script = {};
    setTools((tid2) => (tid2 === 'read_file' || tid2 === 'code_search' || tid2 === 'web_search' || tid2 === 'browser_read' ? 'auto' : 'confirm'));
  }

  section('Supplements while a tool turn runs');
  {
    reset();
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => { release = r; });
    script = { step1: async (_spec, id) => { emit(id, { type: 'text', text: '在做。' }); await hold; emit(id, { type: 'done', text: '在做。\n小结：好', final: '在做。\n小结：好', stopReason: 'stop' }); } };
    const id = create('T3', '补充 GOAL3', engineOf());
    await until('step 1 to run', () => specs.length >= 2 && (runOf(id)?.plan.length ?? 0) > 0);
    await new Promise((r) => setTimeout(r, 60));
    actions.sendMessage(id, '多加一个文件 EXTRA1');
    await until('the supplement to reach the stream', () => hooks.inputs.length >= 1);
    expect('it was forwarded to the running tool turn', hooks.inputs[0].text.includes('补充：多加一个文件 EXTRA1'), hooks.inputs[0]);
    await until('the delivered note', () => tasks()[id].messages.some((m: Any) => m.text === '已转达给正在执行的 Agent。'));
    expect('…and marked as delivered', tasks()[id].messages.find((m: Any) => m.text === '多加一个文件 EXTRA1').delivered === true);
    hooks.inputResult = false; // the loop has just ended
    actions.sendMessage(id, '又一条 EXTRA2');
    await until('the second forward', () => hooks.inputs.length >= 2);
    await until('the note that it waits', () => tasks()[id].messages.some((m: Any) => m.text.startsWith('这一轮刚好结束了')));
    expect('input() saying false takes the delivered mark back', tasks()[id].messages.find((m: Any) => m.text === '又一条 EXTRA2').delivered === undefined);
    hooks.inputResult = true;
    release();
    await doneRun(id);
    const step2 = specs.find((s) => userText(s).includes('现在执行第 2/'));
    expect('the one that was not delivered goes to the next step as 刚刚补充, the delivered one does not', !!step2 && userText(step2).includes('刚刚补充：\n- 又一条 EXTRA2') && !userText(step2).includes('刚刚补充：\n- 多加一个文件'));
    expect('both are in the briefing\'s 补充说明', !!step2 && userText(step2).includes('补充说明：\n- 多加一个文件 EXTRA1\n- 又一条 EXTRA2'));
    script = {};
  }
  {
    // The loop took three supplements, and the step hit a limit before a request carried the last two: done says unread 2.
    reset();
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => { release = r; });
    script = { step1: async (_spec, id) => {
      emit(id, { type: 'text', text: '在做。' });
      await hold;
      emit(id, { type: 'done', text: '在做。', final: '在做。\n小结：做了一半', stopReason: 'max_rounds', unread: 2 });
    } };
    const id = create('T3b', '补充 GOAL3B', engineOf());
    await until('step 1 to run', () => specs.length >= 2 && (runOf(id)?.plan.length ?? 0) > 0);
    await new Promise((r) => setTimeout(r, 60));
    for (const t of ['先到的 EXTRA3', '后到的 EXTRA4', '最后的 EXTRA5']) actions.sendMessage(id, t);
    await until('the three forwards', () => hooks.inputs.length >= 3);
    await until('their delivered notes', () => tasks()[id].messages.filter((m: Any) => m.text === '已转达给正在执行的 Agent。').length >= 3);
    release();
    await doneRun(id);
    const msg = (t: string) => tasks()[id].messages.find((m: Any) => m.text === t);
    const step2 = specs.find((s) => userText(s).includes('现在执行第 2/'));
    expect('unread 2 on done: the next step gets the last two as 刚刚补充, not the first one', !!step2 && userText(step2).includes('刚刚补充：\n- 后到的 EXTRA4\n- 最后的 EXTRA5') && !userText(step2).includes('刚刚补充：\n- 先到的'), step2 && userText(step2));
    expect('…with a note saying so', tasks()[id].messages.some((m: Any) => m.role === 'system' && m.text.startsWith('这一轮在 Agent 读到你最后 2 条补充之前就结束了')));
    eq('…and once that step has them, all three count as delivered', [msg('先到的 EXTRA3').delivered, msg('后到的 EXTRA4').delivered, msg('最后的 EXTRA5').delivered], [true, true, true]);
    script = {};
  }
  {
    // The same on an error: the step fails, and the supplement it never read is not counted as delivered.
    reset();
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => { release = r; });
    script = { step1: async (_spec, id) => { await hold; emit(id, { type: 'error', message: '请求被拒绝（HTTP 401）', code: 'HTTP_401', unread: 1 }); } };
    const id = create('T3c', '补充 GOAL3C', engineOf());
    await until('step 1 to run', () => specs.length >= 2 && (runOf(id)?.plan.length ?? 0) > 0);
    await new Promise((r) => setTimeout(r, 60));
    actions.sendMessage(id, '出错前的 EXTRA6');
    await until('the forward', () => hooks.inputs.length >= 1);
    await until('its delivered note', () => tasks()[id].messages.some((m: Any) => m.text === '已转达给正在执行的 Agent。'));
    release();
    await doneRun(id);
    eq('unread 1 on error: the step fails, and the supplement goes back to waiting', [runOf(id).status, tasks()[id].messages.find((m: Any) => m.text === '出错前的 EXTRA6').delivered], ['failed', undefined]);
    expect('…with a note that says a retry carries it, not the next step', tasks()[id].messages.some((m: Any) => m.role === 'system' && m.text === '这一轮在 Agent 读到你最后那条补充之前就出错结束了；重试时这条补充会和其它补充说明一起交给 Agent。'));
    script = {};
  }
  {
    // While the step waits for an approval, an API tool turn still takes supplements: the loop sends them with that tool's result.
    reset();
    script = { step1: async (_spec, id) => {
      const input = { path: path.join(work, 'w.txt'), content: 'x', mode: 'create' };
      emit(id, { type: 'tool', callId: 'c5', name: 'write_file', input, title: '写入 w.txt' });
      const d = await ask(id, { requestId: 'r5', callId: 'c5', name: 'write_file', input, title: '写入 w.txt' });
      emit(id, { type: 'tool-end', callId: 'c5', ok: d === 'allow', output: '已写入' });
      emit(id, { type: 'done', text: '写好了。\n小结：好', final: '写好了。\n小结：好', stopReason: 'stop' });
    } };
    const id = create('T3f', '补充 GOAL3F', engineOf());
    await until('the step to wait for its approval', () => runOf(id)?.status === 'awaiting');
    actions.sendMessage(id, '审批时补的 EXTRA9');
    await until('the forward', () => hooks.inputs.length >= 1);
    await until('its delivered note', () => tasks()[id].messages.some((m: Any) => m.text === '已转达给正在执行的 Agent。'));
    expect('a supplement sent while the step waits for an approval goes to the running API tool turn', hooks.inputs[0].text.includes('补充：审批时补的 EXTRA9'), hooks.inputs[0]);
    actions.decideApproval(runOf(id).approvals.find((a: Any) => a.status === 'pending').id, 'approve');
    await doneRun(id);
    const step2 = specs.find((s) => userText(s).includes('现在执行第 2/'));
    expect('…so the next step does not get it again as 刚刚补充', !!step2 && !userText(step2).includes('刚刚补充：\n- 审批时补的'), step2 && userText(step2));
    script = {};
  }
  {
    // Paused: the interrupted done counts the supplement, and the resumed step gets it.
    reset();
    script = { step1: async (_spec, id) => {
      emit(id, { type: 'text', text: '在做。' });
      await until('the pause to reach the stream', () => hooks.stops.some((x) => x.id === id));
      emit(id, { type: 'done', text: '', final: '', stopReason: 'interrupted', unread: 1 });
    } };
    const id = create('T3d', '补充 GOAL3D', engineOf());
    await until('step 1 to run', () => specs.length >= 2 && (runOf(id)?.plan.length ?? 0) > 0);
    await new Promise((r) => setTimeout(r, 60));
    actions.sendMessage(id, '暂停前的 EXTRA7');
    await until('the forward', () => hooks.inputs.length >= 1);
    await until('its delivered note', () => tasks()[id].messages.some((m: Any) => m.text === '已转达给正在执行的 Agent。'));
    actions.pauseRun(runOf(id).id);
    await until('the note for a paused run', () => tasks()[id].messages.some((m: Any) => m.role === 'system' && m.text === '这一轮在 Agent 读到你最后那条补充之前就结束了；继续运行时这条补充会交给 Agent。'));
    eq('paused with unread 1: the supplement waits again', tasks()[id].messages.find((m: Any) => m.text === '暂停前的 EXTRA7').delivered, undefined);
    script = {};
    actions.resumeRun(runOf(id).id);
    await doneRun(id);
    const again = specs.filter((s) => userText(s).includes('现在执行第 1/')).at(-1);
    expect('…and the resumed step 1 gets it as 刚刚补充', !!again && userText(again).includes('刚刚补充：\n- 暂停前的 EXTRA7'), again && userText(again));
  }
  {
    // Cancelled: nothing more runs, so the supplement is taken back without a note promising more.
    reset();
    script = { step1: async (_spec, id) => {
      await until('the cancel to reach the stream', () => hooks.stops.some((x) => x.id === id));
      emit(id, { type: 'done', text: '', final: '', stopReason: 'interrupted', unread: 1 });
    } };
    const id = create('T3e', '补充 GOAL3E', engineOf());
    await until('step 1 to run', () => specs.length >= 2 && (runOf(id)?.plan.length ?? 0) > 0);
    await new Promise((r) => setTimeout(r, 60));
    actions.sendMessage(id, '取消前的 EXTRA8');
    await until('the forward', () => hooks.inputs.length >= 1);
    await until('its delivered note', () => tasks()[id].messages.some((m: Any) => m.text === '已转达给正在执行的 Agent。'));
    actions.cancelRun(runOf(id).id);
    await until('the interrupted done to be handled', () => tasks()[id].messages.find((m: Any) => m.text === '取消前的 EXTRA8').delivered === undefined);
    eq('cancelled with unread 1: taken back, the run cancelled, and no note about a next step', [runOf(id).status, tasks()[id].messages.some((m: Any) => m.role === 'system' && m.text.startsWith('这一轮在 Agent 读到你最后'))], ['cancelled', false]);
    script = {};
  }

  section('Read-only, the browser, a disabled tool, a custom address, Coding Plan, older tasks');
  {
    reset();
    const id = create('RO', '只读 GOAL4', engineOf({ access: 'read', browser: true }));
    await doneRun(id);
    const [p, s1] = specs;
    eq('read-only: the plan turn only looks', p.tools, ['read_file', 'code_search']);
    eq('read-only: a step gets no write, command, git or browser action', s1.tools, ['read_file', 'code_search', 'web_search', 'web_fetch']);
    expect('read-only: spec.readOnly, no browser, the system prompt says so', s1.readOnly === true && s1.browser === false && s1.system.includes('这个任务是只读的') && !s1.system.includes('## 浏览器'));
  }
  {
    reset();
    setTools((tid2) => (tid2 === 'shell' || tid2 === 'web_fetch' ? 'off' : undefined));
    const id = create('BR', '浏览器 GOAL5', engineOf({ browser: true }), ['orchestrator', 'researcher']);
    await doneRun(id);
    const steps = specs.slice(1);
    eq('tools switched off are not offered; the browser is', steps[0].tools, ['read_file', 'code_search', 'write_file', 'git', 'web_search', 'browser_read', 'browser_act']);
    expect('the browser flag and its note', steps[0].browser === true && steps[0].system.includes('## 浏览器'));
    expect('"other" is never offered', !steps[0].tools.includes('other'));
    setTools((tid2) => (tid2 === 'shell' || tid2 === 'web_fetch' ? 'confirm' : undefined));
  }
  {
    reset();
    setTools(() => 'off');
    const id = create('NT', '没有工具 GOAL6', engineOf());
    await doneRun(id);
    const p = specs[0];
    expect('every tool off: a plain turn that says so, with no tools, no folder, no access', p.tools === undefined && p.cwd === undefined && p.access === undefined && p.system.includes('## 没有可用的工具'));
    setTools((tid2) => (tid2 === 'read_file' || tid2 === 'code_search' || tid2 === 'web_search' || tid2 === 'browser_read' ? 'auto' : 'confirm'));
  }
  {
    reset();
    store.update((d: Any) => { d.models.providers.deepseek.baseUrl = 'https://relay.example.com/v1'; });
    const id = create('RL', '中转 GOAL7', engineOf());
    await doneRun(id);
    eq('a custom service address asks about every call', [specs[0].confirmAll, specs[0].baseUrl], [true, 'https://relay.example.com/v1']);
    store.update((d: Any) => { d.models.providers.deepseek.baseUrl = 'https://api.deepseek.com'; });
    reset();
    const id2 = create('RL2', '官方 GOAL7b', engineOf());
    await doneRun(id2);
    expect('the official address typed by hand does not', specs[0].confirmAll === undefined);
    store.update((d: Any) => { d.models.providers.deepseek.baseUrl = ''; });
  }
  {
    reset();
    store.update((d: Any) => { d.models.providers.qwen.region = 'coding'; });
    const id = create('CP', '套餐 GOAL8', engineOf({ provider: 'qwen', model: 'qwen3.7-plus' }));
    await doneRun(id);
    eq('the Coding Plan note is on the timeline once', store.get().events.filter((e: Any) => e.runId === runOf(id).id && e.text.startsWith('Coding Plan')).length, 1);
    expect('…and in the terminal', runOf(id).terminal.some((l: Any) => l.text.includes('Coding Plan 的密钥')));
    const id2 = create('CP2', '套餐 GOAL8b', engineOf({ provider: 'qwen', model: 'qwen3.7-plus', cwd: undefined }));
    await doneRun(id2);
    expect('no note for a task that cannot act', !store.get().events.some((e: Any) => e.runId === runOf(id2).id && e.text.startsWith('Coding Plan')));
    store.update((d: Any) => { d.models.providers.qwen.region = 'cn'; });
  }
  {
    reset();
    const id = create('OLD', '旧任务 GOAL9', engineOf({ cwd: undefined, access: undefined }), ['orchestrator', 'reviewer']);
    await doneRun(id);
    const [p, s1, s2] = specs;
    expect('an older API task (no folder): no tools, no folder', p.tools === undefined && p.cwd === undefined && p.access === undefined && s1.tools === undefined);
    expect('…the old plan prompt', p.messages.length === 1 && p.messages[0].content.includes('这一轮只做计划，不要开始执行') && !p.messages[0].content.includes('在工作文件夹里'));
    expect('…the old step: history and prompt, no tool wording', s1.messages.length >= 3 && !s1.messages.at(-1).content.includes('可以用你的工具'));
    expect('…the helper thinks and writes only, with no talk of permissions', s2.system.includes('这次只能思考和写作') && !s2.system.includes('权限'));
    expect('…the orchestrator prompt has no folder line', !s1.system.includes('工作文件夹「'));
  }

  section('A command-line task is unchanged, and its helpers are no longer told they have no files');
  {
    reset();
    const eng = { kind: 'live', provider: 'claude', auth: 'cli', driver: 'claude-code', model: 'sonnet', label: 'Claude · Claude Code', cwd: work };
    const id = create('CLI', 'CLI GOAL10', eng, ['orchestrator', 'reviewer']);
    await doneRun(id);
    const [p, s1, s2] = specs;
    expect('the plan is a prompt spec with no API tools', p.driver === 'claude-code' && typeof p.prompt === 'string' && p.messages === undefined && p.tools === undefined && p.confirmAll === undefined);
    expect('the plan prompt still says the folder can be looked at', p.prompt.includes('你可以先只读地了解'));
    expect('the step prompt is the one it was', s1.prompt.includes('可以用你的工具在工作文件夹里完成这一步'));
    expect('a helper is no longer told it has no file or command access', s2.system.includes('你是审查 Agent') && !s2.system.includes('没有文件、网络或命令权限') && s2.system.includes('以实际提供给你的为准'), s2.system.slice(-200));
  }

  /* ───────── review fixes: the card says when it cut, tool-less services, the plan in the full text, skills without read_file, the hint ───────── */

  section('The approval card always says when it shows less than the call carries');
  {
    reset();
    const BIG = path.join(work, 'big.md');
    // 40 lines of 300 characters: under the desktop side's 80-line and 20 KB notes, over the card's 8000
    const body40 = Array.from({ length: 40 }, (_, i) => `L${String(i).padStart(2, '0')}${'x'.repeat(297)}`).join('\n');
    const body120 = Array.from({ length: 120 }, (_, i) => `l${i}`).join('\n');
    const url = `https://example.com/${'a'.repeat(9000)}`;
    const asks: Array<[string, string, Record<string, unknown>]> = [
      ['r30', 'write_file', { path: BIG, content: body40, mode: 'create' }],
      ['r31', 'edit_file', { path: BIG, old_string: 'A'.repeat(5000), new_string: `${'B'.repeat(4900)}END-NEW` }],
      ['r32', 'edit_file', { path: BIG, old_string: 'O'.repeat(8100), new_string: 'EVIL-NEW-TEXT' }],
      ['r33', 'write_file', { path: BIG, content: body120, mode: 'create' }],
      ['r34', 'write_file', { path: BIG, content: 'short', mode: 'create' }],
      ['r35', 'web_fetch', { url }],
      // what the desktop side cut to 20 KB for the page comes with its full size: that is the total, not what reached the page
      ['r36', 'write_file', { path: BIG, content: body120, mode: 'create', contentBytes: 50000 }],
      ['r37', 'edit_file', { path: BIG, old_string: 'Q'.repeat(5000), new_string: 'N', oldBytes: 30000 }],
      ['r38', 'edit_file', { path: BIG, old_string: 'q', new_string: 'SHORT-CUT', newBytes: 25000 }],
    ];
    script = {
      step1: async (_spec, id) => {
        for (const [requestId, name, input] of asks) {
          emit(id, { type: 'tool', callId: requestId, name, input, title: name });
          const d = await ask(id, { requestId, callId: requestId, name, input, title: name });
          emit(id, { type: 'tool-end', callId: requestId, ok: d === 'allow', output: d === 'allow' ? 'ok' : DENIED_CARD });
        }
        emit(id, { type: 'done', text: '好。\n小结：问完了', final: '好。\n小结：问完了', stopReason: 'stop' });
      },
    };
    const id = create('CARD', '卡片 GOAL11', engineOf());
    const previews: string[] = [];
    for (let n = 1; n <= asks.length; n++) {
      await until(`approval ${n}`, () => (runOf(id)?.approvals.length ?? 0) >= n);
      const a = runOf(id).approvals[n - 1];
      previews.push(a.preview);
      actions.decideApproval(a.id, 'approve');
    }
    await doneRun(id);
    const [p1, p2, p3, p4, p5, p6, p7, p8, p9] = previews;
    // (1) a write of 12 KB in 40 long lines: the old card stopped at 8000 characters and said nothing
    expect('a long write: the card says it shows 8000 of the characters', p1.endsWith(`\n…（卡片只显示前 ${live.CARD_CHARS} 字，共 ${body40.length} 字）`), p1.slice(-80));
    expect('…and it is not cut below that (the first 7 lines are whole)', p1.includes(`+L06${'x'.repeat(297)}`) && !p1.includes('+L39'));
    // (2) an edit with 5 KB on each side: each side has its own budget and its own note, so the + side is there
    expect('an edit: the old side says it was cut', p2.includes(`\n…（卡片里的旧内容只显示前 ${live.SIDE_CHARS} 字，共 5000 字）`), p2.slice(0, 120));
    expect('…the new side too, and it follows the old side', p2.includes(`\n…（卡片里的新内容只显示前 ${live.SIDE_CHARS} 字，共 4907 字）`) && p2.indexOf('+BBBB') > p2.indexOf('-AAAA'));
    expect('…the whole card stays small', p2.length < 8000, p2.length);
    // (3) an old_string of 8100 characters used to push all the new text off the card
    expect('a huge old_string: the new text is still on the card', p3.includes('\n+EVIL-NEW-TEXT') && p3.includes('旧内容只显示前 3500 字，共 8100 字'), p3.slice(-160));
    expect('…and the new side, not cut, has no note', !p3.includes('新内容'));
    // (4) more than 80 lines
    expect('over 80 lines: it says so, with the line count', p4.includes('\n…（卡片只显示前 80 行，共 120 行）') && p4.includes('\n+l79') && !p4.includes('+l80'), p4.slice(-80));
    // (5) a short write is shown whole, with no note
    eq('a short write has no note', p5, `+++ ${BIG}（新文件）\n+short`);
    // (6) any other long request
    expect('a long request says so too', /\n…（卡片只显示前 8000 字，共 \d+ 字）$/.test(p6) && p6.length < 8200, p6.slice(-80));
    // (7)–(9) a text the desktop side already cut: the card gives its full size, never the count of the part it got
    expect('a write cut by the desktop side: 80 lines shown, the total is its full size, not the 120 lines that reached the page', p7.includes('\n…（卡片只显示前 80 行）') && !p7.includes('共 120 行') && p7.endsWith('\n…（共 49 KB，只显示开头）'), p7.slice(-120));
    expect('an edit whose old side was cut there: the old side\'s total is its full size, the uncut new side has no note', p8.includes('旧内容只显示前 3500 字，共 29 KB）') && !p8.includes('共 5000 字') && !p8.includes('新内容'), p8.slice(0, 200));
    expect('…a side cut there that fits the card still says it is only the start', p9.includes('+SHORT-CUT') && p9.includes('新内容只显示开头，共 24 KB）'), p9);
    // the 文件改动 record is the same text, worded for the record
    const diff = runOf(id).artifacts.find((a: Any) => a.name === '文件改动.diff')?.content ?? '';
    expect('the 文件改动.diff record says where it cut, too', diff.includes(`…（这份记录只显示前 ${live.CARD_CHARS} 字，共 ${body40.length} 字）`) && diff.includes('这份记录里的旧内容只显示前 3500 字，共 5000 字'), diff.slice(0, 120));
    expect('…and gives a text the desktop side cut by its full size', diff.includes('这份记录里的旧内容只显示前 3500 字，共 29 KB'), diff.slice(0, 200));
    script = {};
  }

  section('A service that cannot do tool calls: the turn is run again without tools, and so is the rest of the run');
  const NO_RESPONSES_MSG = '当前 GPT 服务地址缺少工作任务使用的 Responses 接口。本次 API 步骤改为文字回复，无法生成本地文件。请在「模型接入」换用支持 Responses 工具调用的地址后重新运行。';
  const NO_TOOLS_MSG = '当前模型或服务地址拒绝了工具调用。本次 API 步骤改为文字回复，无法生成本地文件。请在「模型接入」选择支持工具调用的模型和地址后重新运行。';
  const planOnly = (planText: string): Script => async (spec, id) => {
    if (spec.tools) { emit(id, { type: 'error', message: '这个服务地址不支持 Responses 接口，不能调用工具。', code: 'NO_RESPONSES' }); return; }
    emit(id, { type: 'text', text: planText });
    emit(id, { type: 'done', text: planText, stopReason: 'stop' });
  };
  {
    reset();
    script = { plan: planOnly(`好，计划如下。\n${PLAN}`) };
    const id = create('NR', '没有 responses GOAL12', engineOf(), ['orchestrator', 'reviewer']);
    await doneRun(id);
    const r = runOf(id);
    eq('the run completes (the plan turn did not fail it)', r.status, 'completed');
    expect('the run is marked tool-less, and the person is told', r.noTools === true && tasks()[id].messages.filter((m: Any) => m.role === 'system' && m.text === NO_RESPONSES_MSG).length === 1);
    expect('…also on the timeline', store.get().events.some((e: Any) => e.runId === r.id && e.text === NO_RESPONSES_MSG));
    expect('the plan turn was tried with tools first, then run once more without', specs.length >= 2 && !!specs[0].tools && specs[1].tools === undefined, specs.map((s) => !!s.tools));
    const [, p, s1, s2, sum] = specs;
    expect('the second try is a plain turn: no folder, no access, no confirmAll', p.cwd === undefined && p.access === undefined && p.confirmAll === undefined && p.readOnly === undefined);
    expect('…its prompt is the planning-only one (it does not offer to look at the folder)', p.messages.length === 1 && p.messages[0].content.includes('这一轮只做计划，不要开始执行') && !p.messages[0].content.includes('你可以先只读地了解') && !p.messages[0].content.includes('在工作文件夹里'), p.messages[0].content.slice(-100));
    eq('the plan came from it', r.plan.map((st: Any) => st.title), ['写文件', '检查']);
    expect('every later turn is plain too: steps and the summary have no tools and no folder', [s1, s2, sum].every((x) => x.tools === undefined && x.cwd === undefined && x.access === undefined), [s1, s2, sum].map((x) => x.tools));
    expect('a step is the old think-and-write turn: history of the plan, and no talk of tools', s1.messages.length >= 3 && s1.messages[0].content.includes('这一轮只做计划') && !s1.messages.at(-1).content.includes('可以用你的工具') && !s1.messages.at(-1).content.includes('任务目标：\n'), s1.messages.map((m: Any) => m.content.slice(0, 20)));
    expect('…the helper is told it can only think and write', s2.system.includes('这次只能思考和写作') && !s2.system.includes(work));
    eq('the turns: plan twice (tools, then plain), two steps, the summary', specs.length, 5);
  }
  {
    reset();
    // The plan works with tools; the first step finds out. Only that step is run again.
    script = {
      step1: async (spec, id) => {
        if (spec.tools) { emit(id, { type: 'error', message: '请求被拒绝（HTTP 400）：tools is not supported', code: 'NO_TOOLS' }); return; }
        emit(id, { type: 'text', text: '做完了。\n小结：完成第 1 步' });
        emit(id, { type: 'done', text: '', final: '做完了。\n小结：完成第 1 步', stopReason: 'stop' });
      },
    };
    const id = create('NT2', '没有 tools GOAL13', engineOf(), ['orchestrator', 'reviewer']);
    await doneRun(id);
    const r = runOf(id);
    eq('a step that finds out is run again, and the run completes', r.status, 'completed');
    eq('the turns: plan (tools), step 1 (tools), step 1 again, step 2, summary', specs.map((x) => (x.tools ? 'tools' : 'plain')), ['tools', 'tools', 'plain', 'plain', 'plain']);
    expect('the retry of step 1 is briefed by history, not by tool talk', specs[2].messages.length >= 3 && specs[2].messages.at(-1).content.includes('现在执行第 1/2 步') && !specs[2].messages.at(-1).content.includes('可以用你的工具'));
    expect('…step 1 is not marked failed, and the person is told once', r.plan[0].status === 'done' && !r.failure && tasks()[id].messages.filter((m: Any) => m.text === NO_TOOLS_MSG).length === 1);
    expect('…step 2 sees step 1\'s result in its history', specs[3].messages.some((m: Any) => m.role === 'assistant' && m.content.includes('完成第 1 步')));
    script = {};
  }
  {
    reset();
    // The plain turn is tried once: if that fails as well, the run fails (no loop)
    script = { plan: async (_spec, id) => { emit(id, { type: 'error', message: '不支持', code: 'NO_RESPONSES' }); } };
    const id = create('NR3', '再失败 GOAL14', engineOf());
    await doneRun(id);
    eq('a plain retry that fails again fails the run, after exactly two tries', [runOf(id).status, specs.length], ['failed', 2]);
    reset();
    // Any other failure is not a reason to give up the tools
    script = { plan: async (_spec, id) => { emit(id, { type: 'error', message: '请求被拒绝（HTTP 401）', code: 'HTTP_401' }); } };
    const id2 = create('NR4', '别的错误 GOAL15', engineOf());
    await doneRun(id2);
    expect('another error code fails the run as before: one try, not marked tool-less, nothing said', runOf(id2).status === 'failed' && specs.length === 1 && !runOf(id2).noTools && !tasks()[id2].messages.some((m: Any) => m.text === NO_TOOLS_MSG));
    script = {};
  }

  section('The plan is found in the whole reply when the last message has none');
  {
    reset();
    const PLAN_A = '```json\n{"steps":[{"title":"A步","detail":"旧的","agent":"orchestrator"}]}\n```';
    const PLAN_B = '```json\n{"steps":[{"title":"B步","detail":"改过的","agent":"orchestrator"}]}\n```';
    const full = `先这样：\n${PLAN_A}\n再想了想，改成：\n${PLAN_B}\n例如这样写：\n\`\`\`json\n[1,2,3]\n\`\`\`\n`;
    script = {
      plan: async (_spec, id) => {
        emit(id, { type: 'text', text: full });
        emit(id, { type: 'text-break' });
        emit(id, { type: 'text', text: '好的，以上是计划。' });
        emit(id, { type: 'done', text: `${full}\n\n好的，以上是计划。`, final: '好的，以上是计划。', stopReason: 'stop' });
      },
    };
    const id = create('PL', '计划在前面 GOAL16', engineOf());
    await doneRun(id);
    eq('a plan said before a last message without one is used — the last block, and not the [1,2,3] example', runOf(id).plan.map((st: Any) => st.title), ['B步']);
    expect('…with no "could not read the plan" note', !tasks()[id].messages.some((m: Any) => m.text.startsWith('没能从回复里读出计划')));
    script = {};
    reset();
    script = { plan: async (_spec, id) => { emit(id, { type: 'text', text: '没有计划，只是聊聊。' }); emit(id, { type: 'done', text: '没有计划，只是聊聊。', final: '没有计划，只是聊聊。', stopReason: 'stop' }); } };
    const id2 = create('PL2', '真没有计划 GOAL17', engineOf());
    await doneRun(id2);
    expect('a reply with no plan at all still becomes the one-step plan, with the note', runOf(id2).plan[0]?.title === '完成目标' && tasks()[id2].messages.some((m: Any) => m.text.startsWith('没能从回复里读出计划')));
    script = {};
  }

  section('Skills reach a turn that has no read_file');
  {
    const skill = { folder: 'demo', name: '演示技能', description: '做演示', modes: ['work'], dir: 'D:/skills/demo', skillFile: 'D:/skills/demo/SKILL.md', enabled: true, body: '步骤：先 A 后 B。' };
    store.update((d: Any) => { d.skills = { root: 'D:/skills', list: [skill], loaded: true }; });
    const BODY = skill.body;
    reset();
    let id = create('SK1', '技能 GOAL18', engineOf());
    await doneRun(id);
    expect('with read_file the list is given and the files are to be read (as before)', specs[1].system.includes('SKILL.md：D:/skills/demo/SKILL.md') && specs[1].system.includes('先用读取工具读它的 SKILL.md') && !specs[1].system.includes(BODY));

    reset();
    setTools((tid2) => (tid2 === 'read_file' ? 'off' : undefined));
    id = create('SK2', '技能 GOAL19', engineOf());
    await doneRun(id);
    const [pl, st] = specs;
    expect('read_file off, no command tool (the plan turn): the skill text is in the prompt', pl.tools.join() === 'code_search' && pl.system.includes(BODY) && !pl.system.includes('先用读取工具读它的 SKILL.md'), pl.tools);
    expect('…worded for a turn that cannot run scripts', pl.system.includes('这一轮不能运行脚本或读写文件') && !pl.system.includes('文件夹：D:/skills/demo'));
    expect('read_file off, with the command tool (a step): the text, the folder, and that scripts can be run', st.tools.includes('shell') && !st.tools.includes('read_file') && st.system.includes(BODY) && st.system.includes('文件夹：D:/skills/demo') && st.system.includes('命令行工具运行') && !st.system.includes('这一轮不能运行脚本'), st.system.slice(-300));
    setTools(() => 'confirm');
    setTools((tid2) => (tid2 === 'read_file' || tid2 === 'code_search' || tid2 === 'web_search' || tid2 === 'browser_read' ? 'auto' : undefined));

    reset();
    setTools(() => 'off');
    id = create('SK3', '技能 GOAL20', engineOf());
    await doneRun(id);
    expect('every tool off: the text, and the no-tools note', specs[0].system.includes(BODY) && specs[0].system.includes('## 没有可用的工具') && !specs[0].system.includes('先用读取工具读它的 SKILL.md'));
    setTools(() => 'confirm');
    setTools((tid2) => (tid2 === 'read_file' || tid2 === 'code_search' || tid2 === 'web_search' || tid2 === 'browser_read' ? 'auto' : undefined));

    reset();
    const helper = (store.get().agents as Any[]).find((a) => a.id === 'reviewer');
    const keep = [...helper.tools];
    store.update((d: Any) => { d.agents.find((a: Any) => a.id === 'reviewer').tools = ['code_search', 'shell']; });
    id = create('SK4', '技能 GOAL21', engineOf(), ['orchestrator', 'reviewer']);
    await doneRun(id);
    const [, o1, h2] = specs;
    expect('a helper whose Agent-page list has no read_file gets the text, the orchestrator the list', h2.system.includes(BODY) && h2.system.includes('文件夹：D:/skills/demo') && o1.system.includes('SKILL.md：D:/skills/demo/SKILL.md') && !o1.system.includes(BODY));
    store.update((d: Any) => { d.agents.find((a: Any) => a.id === 'reviewer').tools = keep; });
    store.update((d: Any) => { d.skills = undefined; });
  }

  section('The plan roster names the tools each Agent\'s steps will get');
  {
    const toolName = (tool: string) => (store.get().tools as Any[]).find((t) => t.id === tool).name as string;
    const named = (tools: string[]) => tools.map(toolName).join('、');
    const lineOf = (text: string, agent: string) => text.split('\n').find((l) => l.startsWith(`- ${agent}：`)) ?? '';
    const planText = (spec: Any): string => (spec.messages ? spec.messages[0].content : spec.prompt);
    const PLAN3 = '```json\n{"steps":[{"title":"写","detail":"写","agent":"orchestrator"},{"title":"查","detail":"查","agent":"researcher"},{"title":"审","detail":"审","agent":"reviewer"}]}\n```';
    const plan3: Script = async (_spec, sid) => {
      emit(sid, { type: 'text', text: `计划如下。\n${PLAN3}` });
      emit(sid, { type: 'done', text: `计划如下。\n${PLAN3}`, final: `计划如下。\n${PLAN3}`, stopReason: 'stop' });
    };
    const ALL3: AgentId[] = ['orchestrator', 'researcher', 'reviewer'];
    const sameAsSteps = (label: string, text: string) => {
      for (const [agent, step] of [['orchestrator', specs[1]], ['researcher', specs[2]], ['reviewer', specs[3]]] as const) {
        const want = step.tools ? `执行时能用的工具：${named(step.tools)}）` : '执行时没有可用的工具，只能思考和写作）';
        expect(`${label}: the ${agent} line lists exactly the tools its step got`, lineOf(text, agent).includes(want), [lineOf(text, agent), want]);
      }
    };

    reset();
    script = { plan: plan3 };
    let id = create('RS1', '名单 GOAL30', engineOf({ browser: true }), ALL3);
    await doneRun(id);
    let text = planText(specs[0]);
    eq('the three steps ran on the Agents the plan named', runOf(id).plan.map((x: Any) => x.agentId), ALL3);
    sameAsSteps('API with the browser', text);
    expect('…the researcher has the browser, the reviewer neither the browser nor writing', lineOf(text, 'researcher').includes('浏览网页、操作网页') && !lineOf(text, 'reviewer').includes('浏览网页') && !lineOf(text, 'reviewer').includes('写入文件'));
    expect('…and the planner is told to give a step to an Agent that has its tool, the browser named', text.includes('需要某个工具的步骤，请派给列出了这个工具的 Agent') && text.includes('「浏览网页」「操作网页」指萤火浏览器'));
    expect('…the roster comes before the plan format', text.indexOf('可以分派的 Agent：') < text.indexOf('请派给列出了这个工具的 Agent') && text.indexOf('请派给列出了这个工具的 Agent') < text.indexOf('请先用你的口吻'));

    reset();
    script = { plan: plan3 };
    id = create('RS2', '名单 GOAL31', engineOf({ access: 'read', browser: true }), ALL3);
    await doneRun(id);
    text = planText(specs[0]);
    sameAsSteps('read-only', text);
    expect('read-only: no Agent is said to write, run commands, use git or the browser', ['写入文件', '执行命令', 'Git 操作', '浏览网页', '操作网页', '指萤火浏览器'].every((w) => !text.includes(w)), text);

    reset();
    script = { plan: plan3 };
    setTools((t) => (t === 'shell' ? 'off' : undefined));
    const keep = [...(store.get().agents as Any[]).find((a) => a.id === 'researcher').tools];
    store.update((d: Any) => { d.agents.find((a: Any) => a.id === 'researcher').tools = []; });
    id = create('RS3', '名单 GOAL32', engineOf(), ALL3);
    await doneRun(id);
    text = planText(specs[0]);
    sameAsSteps('a tool off, an Agent with none', text);
    expect('a tool switched off in 工具与技能 is in nobody\'s list', !text.includes('执行命令') && lineOf(text, 'reviewer').includes('执行时能用的工具：读取文件、代码搜索）'), lineOf(text, 'reviewer'));
    expect('an Agent with no tools of its own is said to only think and write, and its step runs without tools', lineOf(text, 'researcher').includes('执行时没有可用的工具，只能思考和写作') && specs[2].tools === undefined && specs[2].system.includes('## 没有可用的工具'), lineOf(text, 'researcher'));
    store.update((d: Any) => { d.agents.find((a: Any) => a.id === 'researcher').tools = keep; });
    setTools((t) => (t === 'shell' ? 'confirm' : undefined));

    reset();
    script = { plan: plan3 };
    store.update((d: Any) => { d.agents.find((a: Any) => a.id === 'reviewer').engine = { key: 'qwen:api', model: 'qwen3.7-plus' }; });
    id = create('RS4', '名单 GOAL33', engineOf({ browser: true }), ALL3);
    await doneRun(id);
    text = planText(specs[0]);
    sameAsSteps('an Agent on its own API model', text);
    expect('…its own model is named, then its tools', specs[3].provider === 'qwen' && lineOf(text, 'reviewer').includes('能在工作文件夹里动手；执行时能用的工具：'), lineOf(text, 'reviewer'));
    store.update((d: Any) => { delete d.agents.find((a: Any) => a.id === 'reviewer').engine; });

    reset();
    script = { plan: plan3 };
    const claudeEng = { kind: 'live', provider: 'claude', auth: 'cli', driver: 'claude-code', model: 'sonnet', label: 'Claude · Claude Code', cwd: work, browser: true };
    id = create('RS5', '名单 GOAL34', claudeEng, ALL3);
    await doneRun(id);
    text = planText(specs[0]);
    expect('command line: the orchestrator has all nine, the browser included', lineOf(text, 'orchestrator').includes(`执行时能用的工具：${named(['read_file', 'code_search', 'write_file', 'shell', 'git', 'web_search', 'web_fetch', 'browser_read', 'browser_act'])}）`), lineOf(text, 'orchestrator'));
    expect('…the researcher its six with the browser, the reviewer its three', lineOf(text, 'researcher').includes('执行时能用的工具：读取文件、代码搜索、网页搜索、抓取网页、浏览网页、操作网页）') && lineOf(text, 'reviewer').includes('执行时能用的工具：读取文件、代码搜索、执行命令）'), [lineOf(text, 'researcher'), lineOf(text, 'reviewer')]);
    expect('…and the browser reaches exactly the steps whose Agent lists it', specs[1].browser === true && specs[2].browser === true && specs[3].browser === false);
    expect('…the reviewer\'s step denies the tools its line leaves out', specs[3].deny.includes('Write') && specs[3].deny.includes('Edit') && specs[3].deny.includes('WebFetch'), specs[3].deny);

    // Claude Code with 执行命令 off: its bare Bash / PowerShell deny also takes git, so nobody is said to have Git 操作 either.
    reset();
    script = { plan: plan3 };
    setTools((t) => (t === 'shell' ? 'off' : undefined));
    const reviewerTools = [...(store.get().agents as Any[]).find((a) => a.id === 'reviewer').tools];
    store.update((d: Any) => { d.agents.find((a: Any) => a.id === 'reviewer').tools = ['read_file', 'git']; });
    id = create('RS5b', '名单 GOAL34b', claudeEng, ALL3);
    await doneRun(id);
    text = planText(specs[0]);
    expect('Claude Code, 执行命令 off: no 执行命令 and no Git 操作 in the roster, and the steps deny Bash', !text.includes('执行命令') && !text.includes('Git 操作') && specs[1].deny.includes('Bash') && specs[1].deny.includes('PowerShell'), text);
    expect('…an Agent that lists git but not the command tool has only its reads', lineOf(text, 'reviewer').includes('执行时能用的工具：读取文件）'), lineOf(text, 'reviewer'));

    // Kimi Code (ACP) asks about every call, but its question may come without the command text, so a git command is judged as a
    // command: with the command tool off, git is not promised either.
    reset();
    script = { plan: plan3 };
    const kimiEng = { kind: 'live', provider: 'kimi', auth: 'cli', driver: 'kimi', model: 'kimi-k3', label: 'Kimi · Kimi Code', cwd: work, browser: true };
    id = create('RS5c', '名单 GOAL34c', kimiEng, ALL3);
    await doneRun(id);
    text = planText(specs[0]);
    expect('Kimi Code, 执行命令 off: no 执行命令 and no Git 操作 either; the git-only Agent has its reads', lineOf(text, 'reviewer').includes('执行时能用的工具：读取文件）') && !text.includes('执行命令') && !text.includes('Git 操作') && specs[0].driver === 'acp', lineOf(text, 'reviewer'));
    expect('…the others keep what the gates leave them', lineOf(text, 'orchestrator').includes('执行时能用的工具：读取文件、代码搜索、写入文件、网页搜索、抓取网页、浏览网页、操作网页）'), lineOf(text, 'orchestrator'));
    store.update((d: Any) => { d.agents.find((a: Any) => a.id === 'reviewer').tools = reviewerTools; });
    setTools((t) => (t === 'shell' ? 'confirm' : undefined));

    reset();
    script = { plan: plan3 };
    id = create('RS5d', '名单 GOAL34d', { ...claudeEng, access: 'read' }, ALL3);
    await doneRun(id);
    text = planText(specs[0]);
    expect('Claude Code, 只读: nobody writes, runs commands, uses git or the browser', ['写入文件', '执行命令', 'Git 操作', '浏览网页', '操作网页'].every((w) => !text.includes(w)) && lineOf(text, 'orchestrator').includes('执行时能用的工具：读取文件、代码搜索、网页搜索、抓取网页）') && specs[1].deny.includes('Write') && specs[1].deny.includes('Bash'), text);

    // Codex follows only its sandbox and the web-search switch; its shell reads, searches and runs git anyway; the browser is all or nothing.
    reset();
    script = { plan: plan3 };
    const researcherTools = [...(store.get().agents as Any[]).find((a) => a.id === 'researcher').tools];
    store.update((d: Any) => { d.agents.find((a: Any) => a.id === 'researcher').tools = ['read_file', 'browser_read']; });
    const codexEng = { kind: 'live', provider: 'gpt', auth: 'cli', driver: 'codex', model: 'gpt-6-sol', label: 'GPT · Codex', cwd: work, browser: true };
    id = create('RS5e', '名单 GOAL34e', codexEng, ALL3);
    await doneRun(id);
    text = planText(specs[0]);
    expect('Codex: the orchestrator writes and searches the web, has no fetch tool, and has the browser', lineOf(text, 'orchestrator').includes('执行时能用的工具：读取文件、代码搜索、写入文件、执行命令、Git 操作、网页搜索、浏览网页、操作网页）') && specs[1].sandbox === 'workspace-write' && specs[1].webSearch === true && specs[1].browser === true, lineOf(text, 'orchestrator'));
    expect('…an Agent that lists only 浏览网页 gets the whole browser and commands, but in a read-only sandbox neither writing nor git', lineOf(text, 'researcher').includes('执行时能用的工具：读取文件、代码搜索、执行命令、浏览网页、操作网页）') && specs[2].browser === true && specs[2].sandbox === 'read-only' && specs[2].webSearch === false, lineOf(text, 'researcher'));
    expect('…the reviewer: reads and commands; no writing, git, web search or browser', lineOf(text, 'reviewer').includes('执行时能用的工具：读取文件、代码搜索、执行命令）') && specs[3].browser === false && specs[3].sandbox === 'read-only', lineOf(text, 'reviewer'));
    store.update((d: Any) => { d.agents.find((a: Any) => a.id === 'researcher').tools = researcherTools; });

    // DeepSeek Harness follows neither 工具与技能 nor the Agent page (only its read-only mode), and takes no browser.
    reset();
    script = { plan: plan3 };
    setTools((t) => (t === 'shell' ? 'off' : undefined));
    store.update((d: Any) => { d.agents.find((a: Any) => a.id === 'researcher').tools = []; });
    const dshEng = { kind: 'live', provider: 'deepseek', auth: 'cli', driver: 'dsh', model: 'deepseek-flash', label: 'DeepSeek · DSH', cwd: work, browser: true };
    id = create('RS6', '名单 GOAL35', dshEng, ALL3);
    await doneRun(id);
    text = planText(specs[0]);
    const dshAll = '执行时能用的工具：读取文件、代码搜索、写入文件、执行命令、Git 操作、网页搜索、抓取网页）';
    expect('DeepSeek Harness: every Agent can do everything but the browser, whatever its list or the policy says', ALL3.every((a) => lineOf(text, a).includes(dshAll)) && !text.includes('只能思考和写作'), text);
    expect('…nobody is said to have the browser, and its steps get none', !text.includes('浏览网页') && !text.includes('指萤火浏览器') && specs.slice(1, 4).every((x: Any) => x.browser === false), text);
    reset();
    script = { plan: plan3 };
    id = create('RS6b', '名单 GOAL35b', { ...dshEng, access: 'read' }, ALL3);
    await doneRun(id);
    text = planText(specs[0]);
    expect('…in a 只读 task (its read-only mode): reads and the web only', ALL3.every((a) => lineOf(text, a).includes('执行时能用的工具：读取文件、代码搜索、网页搜索、抓取网页）')), text);
    store.update((d: Any) => { d.agents.find((a: Any) => a.id === 'researcher').tools = researcherTools; });
    setTools((t) => (t === 'shell' ? 'confirm' : undefined));
    script = {};

    // Every tool off: every Agent only thinks and writes, and the rule about tools is left out.
    reset();
    setTools(() => 'off');
    id = create('RS6c', '名单 GOAL35c', engineOf(), ['orchestrator', 'reviewer']);
    await doneRun(id);
    text = planText(specs[0]);
    expect('every tool off: each line says it only thinks and writes, and there is no rule about tools', lineOf(text, 'orchestrator').includes('执行时没有可用的工具，只能思考和写作') && lineOf(text, 'reviewer').includes('执行时没有可用的工具，只能思考和写作') && !text.includes('请派给列出了这个工具的 Agent'), text);
    setTools(() => 'confirm');
    setTools((t) => (t === 'read_file' || t === 'code_search' || t === 'web_search' || t === 'browser_read' ? 'auto' : undefined));

    reset();
    id = create('RS7', '名单 GOAL36', engineOf());
    await doneRun(id);
    text = planText(specs[0]);
    expect('one Agent: its line lists its tools, and there is no assignment rule', lineOf(text, 'orchestrator').includes(`完成全部步骤；执行时能用的工具：${named(specs[1].tools)}）`) && !text.includes('请派给列出了这个工具的 Agent'), lineOf(text, 'orchestrator'));

    reset();
    id = create('RS8', '名单 GOAL37', engineOf({ cwd: undefined, access: undefined }), ['orchestrator', 'reviewer']);
    await doneRun(id);
    text = planText(specs[0]);
    expect('a task that cannot act: no tool lists and no rule, as before', !text.includes('执行时') && !text.includes('请派给列出了这个工具的 Agent') && lineOf(text, 'reviewer') === '- reviewer：审查 Agent，运行测试、复核结论', text);
  }

  section('The new-task hint: 只读 comes first');
  {
    const claude = { label: 'Claude Code', approvals: 'per-call' } as const;
    const policy = (o: { cli: boolean; agentCli: boolean; apiAgent?: boolean }) => workHint({ ...o, access: 'policy', driver: o.cli ? claude : undefined });
    const read = (o: { cli: boolean; agentCli: boolean; apiAgent?: boolean }) => workHint({ ...o, access: 'read', driver: o.cli ? claude : undefined });
    eq('read-only, API model alone: what it really may do, the web included', read({ cli: false, agentCli: false }), '只读：API 模型读取和搜索工作文件夹里的内容（读工作文件夹和技能文件夹以外的位置会先问你），也可能联网搜索、抓取网页；不写文件、不执行命令；读到的内容会发给模型服务商。');
    const cliApiRead = read({ cli: true, agentCli: false, apiAgent: true });
    expect('read-only on a command-line model with an API Agent: the Agent is named, read-only, with the web and its own provider', cliApiRead.startsWith('只读：Claude Code ') && cliApiRead.includes('用 API 模型的 Agent 同样只读') && cliApiRead.includes('抓取网页') && cliApiRead.includes('它所用的服务商') && !cliApiRead.includes('读写文件'), cliApiRead);
    const cliApi = policy({ cli: true, agentCli: false, apiAgent: true });
    expect('a command-line task with an API Agent says that Agent acts too, with the workbench\'s tools, and whose provider reads it', cliApi.startsWith('Claude Code 会在工作文件夹里读写文件、执行命令') && cliApi.includes('用 API 模型的 Agent 用萤火自己的工具在同一个文件夹里读写文件、执行命令') && cliApi.includes('它所用的服务商'), cliApi);
    eq('…and says nothing of it when no Agent has an API model', policy({ cli: true, agentCli: false }), 'Claude Code 会在工作文件夹里读写文件、执行命令，需要确认的操作会先问你。');
    const withHelper = read({ cli: false, agentCli: true });
    expect('read-only with a command-line helper: says it is read-only, also for the helper, and not that it writes', withHelper.startsWith('只读：') && withHelper.includes('命令行模型的 Agent 也按只读运行') && !withHelper.includes('读写文件'), withHelper);
    const cliRead = read({ cli: true, agentCli: false });
    expect('read-only on a command-line model: the same', cliRead.startsWith('只读：Claude Code ') && !cliRead.includes('读写文件') && !cliRead.includes('会在工作文件夹里'), cliRead);
    const mixed = policy({ cli: false, agentCli: true });
    expect('an API task with a command-line helper says where the API model\'s reads go, and that the helper may not ask', mixed.includes('读到的内容会发给模型服务商') && mixed.includes('取决于它的工具'), mixed);
    expect('the other cases are as they were', policy({ cli: false, agentCli: true }).includes('都在工作文件夹里读写文件、执行命令') && policy({ cli: true, agentCli: false }).startsWith('Claude Code 会在工作文件夹里读写文件、执行命令，需要确认的操作会先问你') && policy({ cli: false, agentCli: false }).startsWith('API 模型用萤火自己的工具'));
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a stream may still hold it */ }
}
