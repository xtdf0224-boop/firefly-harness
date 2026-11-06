/* Exercise runAcp through real JSON-RPC stdio. The fake agent records the selected permission scope;
   no model, real workspace file, or persistent agent permission is involved. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

interface Event { type: string; requestId?: string; text?: string; level?: string }
interface Controller { done: Promise<void>; answer(id: string, decision: string): void; stop(): void }
interface Option { kind: string; optionId?: string; name: string }

export async function acpPermissionChecks() {
  let failures = 0;
  const eq = (label: string, actual: unknown, expected: unknown) => {
    const same = isDeepStrictEqual(actual, expected);
    console.log(`  ${same ? 'ok ' : 'FAIL'} ${label}${same ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
    if (!same) failures++;
  };
  const req = createRequire(path.join(process.cwd(), 'package.json'));
  const { runAcp } = req('./electron/ai/acp.cjs') as {
    runAcp(spec: Record<string, unknown>, emit: (event: Event) => void): Controller;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-acp-permissions-'));
  const cli = path.join(dir, 'agent.cjs');
  fs.writeFileSync(cli, `
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const options = JSON.parse(process.env.FIREFLY_TEST_OPTIONS);
let promptId;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (message.method === 'session/new') {
    send({ id: message.id, result: { sessionId: 'test-session' } });
  } else if (message.method === 'session/prompt') {
    promptId = message.id;
    send({ id: 100, method: 'session/request_permission', params: {
      sessionId: 'test-session', options,
      toolCall: { toolCallId: 'test-call', kind: 'edit', title: 'Write one file', rawInput: { path: 'draft.txt' } },
    } });
  } else if (message.id === 100 && message.result) {
    send({ method: 'session/update', params: { sessionId: 'test-session', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(message.result.outcome) },
    } } });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
    process.stdin.destroy();
    process.exitCode = 0;
  }
});
`, 'utf8');

  async function drive(options: Array<Option | null>, decision: 'allow' | 'deny', access = 'work') {
    const events: Event[] = [];
    let controller: Controller;
    controller = runAcp({
      exe: process.execPath, args: [cli], cwd: dir, prompt: 'Test one permission', access, label: 'Test ACP',
      env: { FIREFLY_TEST_OPTIONS: JSON.stringify(options) },
    }, (event) => {
      events.push(event);
      if (event.type === 'permission') controller.answer(event.requestId!, decision);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        controller.done,
        new Promise((_, reject) => { timer = setTimeout(() => { controller.stop(); reject(new Error('ACP permission check timed out')); }, 10000); }),
      ]);
    } finally { clearTimeout(timer); }
    const text = events.find((event) => event.type === 'text')?.text;
    return { outcome: text ? JSON.parse(text) : null, events };
  }

  const allowOnce = { kind: 'allow_once', optionId: 'allow-this', name: 'Allow this operation' };
  const rejectOnce = { kind: 'reject_once', optionId: 'reject-this', name: 'Reject this operation' };
  const allowAlways = { kind: 'allow_always', optionId: 'allow-persistent', name: 'Always allow' };
  const rejectAlways = { kind: 'reject_always', optionId: 'reject-persistent', name: 'Always reject' };
  try {
    console.log('ACP: permission answers apply to this operation');
    const once = [allowAlways, rejectAlways, allowOnce, rejectOnce];
    const allowed = await drive(once, 'allow');
    eq('approval selects allow_once even when allow_always comes first', allowed.outcome, { outcome: 'selected', optionId: 'allow-this' });
    eq('ordinary approval still has one permission card and completes', allowed.events.filter((event) => event.type === 'permission' || event.type === 'done').map((event) => event.type), ['permission', 'done']);
    eq('ordinary approval has no warning', allowed.events.filter((event) => event.type === 'notice'), []);
    const rejected = await drive(once, 'deny');
    eq('rejection selects reject_once even when reject_always comes first', rejected.outcome, { outcome: 'selected', optionId: 'reject-this' });

    const lasting = await drive([allowAlways, rejectOnce], 'allow');
    eq('without allow_once the operation is cancelled', lasting.outcome, { outcome: 'cancelled' });
    eq('there is no approval card offering an unsupported single-operation grant', lasting.events.some((event) => event.type === 'permission'), false);
    eq('the cancellation explains the missing single-operation choice', lasting.events.filter((event) => event.type === 'notice').map((event) => [event.level, event.text]), [['warn', 'Test ACP 没有提供“仅本次允许”选项，这次操作已取消。']]);
    eq('cancelled permission lets the agent finish its turn', lasting.events.at(-1)?.type, 'done');

    const noSingleReject = await drive([allowOnce, rejectAlways], 'deny');
    eq('without reject_once a rejected call is cancelled', noSingleReject.outcome, { outcome: 'cancelled' });
    const chatReject = await drive(once, 'allow', 'chat');
    eq('chat rejects through reject_once', chatReject.outcome, { outcome: 'selected', optionId: 'reject-this' });
    eq('chat never asks for a tool approval', chatReject.events.some((event) => event.type === 'permission'), false);
    const chatAlways = await drive([allowAlways, rejectAlways], 'allow', 'chat');
    eq('chat cancels when only persistent choices exist', chatAlways.outcome, { outcome: 'cancelled' });
    const malformed = await drive([null, { kind: 'allow_once', optionId: '', name: 'Malformed' }, allowAlways], 'allow');
    eq('an unusable single-operation choice cannot select a persistent grant', malformed.outcome, { outcome: 'cancelled' });
  } finally {
    // runAcp resolves when it receives the result, just before the fake CLI releases its working folder on Windows.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  return failures;
}
