/* Shared parts of the API-tools check (scripts/apitools-check.ts): the assertion helpers, temp folders, one loopback server
   that hosts a fake model service per scenario (picked by the first path segment, like net-check.ts), the frames the three
   protocols stream, and `drive`, which feeds agent.runAgent a fake emit and answers its questions. Nothing here touches
   the network beyond 127.0.0.1. */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import type { AddressInfo } from 'node:net';

// The modules under test are plain CommonJS with no types: everything that comes out of them is `Any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

export const tally = { failures: 0, checks: 0 };
export function expect(label: string, cond: boolean, extra: unknown = '') {
  tally.checks++;
  const note = extra === '' || extra === undefined ? '' : typeof extra === 'string' ? extra : JSON.stringify(extra);
  console.log(`${cond ? '  ok ' : '  FAIL'} ${label}${!cond && note ? ` — ${note.slice(0, 700)}` : ''}`);
  if (!cond) tally.failures++;
}
export function eq<T>(label: string, actual: T, expected: T) {
  const same = isDeepStrictEqual(actual, expected);
  expect(label, same, same ? '' : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
export const section = (title: string) => console.log(title);

export const req = createRequire(path.join(process.cwd(), 'package.json'));
export const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
export const isWin = process.platform === 'win32';
/** A character made from its code, so that no invisible character sits in this source file. */
export const ch = (code: number) => String.fromCharCode(code);

/* ───────────────────────── temp folders ───────────────────────── */

const temps: string[] = [];
export function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `firefly-apitools-${prefix}-`));
  temps.push(d);
  return d;
}
export function rm(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a child process may still hold it */ }
}
export function cleanupTemps() {
  for (const d of temps.splice(0)) rm(d);
}
export const write = (file: string, text: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

/* ───────────────────────── the fake model services ───────────────────────── */

export interface Rec { url: string; headers: http.IncomingHttpHeaders; body: Any }
/** How a fake service answers one request. `frames` are streamed as server-sent events: an object (a `data:` line), a
 *  `{ event, data }` pair, or the text '[DONE]'. */
export interface Reply { status?: number; headers?: Record<string, string>; frames?: Any[]; json?: Any; delay?: number; hang?: boolean; destroyAfter?: boolean }
export interface Scenario { base: string; reqs: Rec[]; close(): void }
type Handler = (rec: Rec, n: number) => Reply | undefined;

const scenarios = new Map<string, { handler: Handler; reqs: Rec[] }>();
let hubServer: http.Server | null = null;
let hubOrigin = '';
let scenarioSeq = 0;

/** Starts the one loopback server (127.0.0.1, any free port). */
export async function startHub() {
  if (hubServer) return;
  const server = http.createServer((rq, res) => {
    let raw = '';
    rq.on('data', (d) => { raw += d; });
    rq.on('end', async () => {
      const name = (rq.url || '/').split('/')[1];
      const sc = scenarios.get(name);
      if (!sc) { res.writeHead(404); res.end('no such scenario'); return; }
      let body: Any = null;
      try { body = JSON.parse(raw); } catch { /* not JSON */ }
      const rec: Rec = { url: (rq.url || '/').slice(name.length + 1), headers: rq.headers, body };
      sc.reqs.push(rec);
      const r = sc.handler(rec, sc.reqs.length) || {};
      if (r.delay) await sleep(r.delay);
      res.statusCode = r.status || 200;
      for (const [k, v] of Object.entries(r.headers || {})) res.setHeader(k, v);
      if (r.json !== undefined) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(r.json)); return; }
      res.setHeader('content-type', 'text/event-stream');
      for (const f of r.frames || []) {
        if (f === '[DONE]') res.write('data: [DONE]\n\n');
        else if (f && f.event) res.write(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);
        else res.write(`data: ${JSON.stringify(f)}\n\n`);
      }
      if (r.destroyAfter) { setTimeout(() => res.socket?.destroy(), 100); return; }
      if (r.hang) return; // left open: the client has to hang up
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  hubServer = server;
  hubOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
export async function stopHub() {
  if (!hubServer) return;
  const s = hubServer;
  hubServer = null;
  s.closeAllConnections?.();
  await new Promise<void>((ok) => s.close(() => ok()));
}

/** A fake service of its own: `base` goes into the spec as baseUrl, `reqs` records every request body it got. */
export function fakeService(handler: Handler): Scenario {
  const name = `s${++scenarioSeq}`;
  const sc = { handler, reqs: [] as Rec[] };
  scenarios.set(name, sc);
  return { base: `${hubOrigin}/${name}`, reqs: sc.reqs, close: () => { scenarios.delete(name); } };
}

/* OpenAI Chat Completions frames */
export const chunk = (delta: Any, finish?: string | null, extra?: Any) => ({ choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(extra || {}) });
export const usageFrame = (input: number, output: number) => ({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } });
export interface Call { id?: string; name: string; args?: Any }
const argText = (a: Any) => (typeof a === 'string' ? a : JSON.stringify(a || {}));

export function oaiReply(o: { text?: string; calls?: Call[]; finish?: string; usage?: [number, number]; reasoning?: string } = {}): Reply {
  const frames: Any[] = [];
  if (o.reasoning !== undefined) frames.push(chunk({ reasoning_content: o.reasoning }));
  if (o.text) frames.push(chunk({ content: o.text }));
  (o.calls || []).forEach((c, i) => {
    frames.push(chunk({ tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: argText(c.args) } }] }));
  });
  frames.push(chunk({}, o.finish || (o.calls && o.calls.length ? 'tool_calls' : 'stop')));
  if (o.usage) frames.push(usageFrame(o.usage[0], o.usage[1]));
  frames.push('[DONE]');
  return { frames };
}

/* Anthropic Messages frames */
const ae = (event: string, data: Any) => ({ event, data: { type: event, ...data } });
export type ABlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input?: Any; raw?: string };
export function aReply(blocks: ABlock[], stop: string, usage: [number, number] = [50, 7]): Reply {
  const f: Any[] = [ae('message_start', { message: { usage: { input_tokens: usage[0] } } })];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      f.push(ae('content_block_start', { index, content_block: { type: 'text', text: '' } }), ae('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } }));
    } else if (b.type === 'thinking') {
      f.push(ae('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }), ae('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } }));
      if (b.signature) f.push(ae('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } }));
    } else if (b.type === 'redacted_thinking') {
      f.push(ae('content_block_start', { index, content_block: { type: 'redacted_thinking', data: b.data } }));
    } else {
      f.push(ae('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }));
      const json = b.raw !== undefined ? b.raw : b.input === undefined ? '' : JSON.stringify(b.input);
      // the arguments arrive in two pieces
      const cut = Math.floor(json.length / 2);
      f.push(ae('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(0, cut) } }), ae('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(cut) } }));
    }
    f.push(ae('content_block_stop', { index }));
  });
  f.push(ae('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: usage[1] } }), ae('message_stop', {}));
  return { frames: f };
}

/* OpenAI Responses frames */
export function rReply(items: Any[], opts: { usage?: [number, number]; status?: string; incomplete?: string } = {}): Reply {
  const usage = opts.usage || [40, 5];
  const frames: Any[] = [];
  items.forEach((item, output_index) => {
    if (item.type === 'message') {
      const text = (item.content || []).map((c: Any) => c.text).join('');
      frames.push({ type: 'response.output_text.delta', output_index, content_index: 0, delta: text });
    }
    frames.push({ type: 'response.output_item.done', output_index, item });
  });
  const response = { status: opts.incomplete ? 'incomplete' : 'completed', ...(opts.incomplete ? { incomplete_details: { reason: opts.incomplete } } : {}), output: items, usage: { input_tokens: usage[0], output_tokens: usage[1] } };
  frames.push({ type: opts.incomplete ? 'response.incomplete' : 'response.completed', response });
  return { frames: frames.map((f) => ({ event: f.type, data: f })) };
}
export const rMessage = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
export const rCall = (call_id: string, name: string, args: Any) => ({ type: 'function_call', call_id, name, arguments: argText(args) });

/* ───────────────────────── a browser that is not there ───────────────────────── */

/** browser-tools.cjs asks for its browser once and keeps it, so one fake serves every check (installed first, in apitools-check.ts). */
export const fakeBrowser = {
  infos: new Map<number, Any>(),
  calls: [] as Array<[string, Any]>,
  describeRef: async (ref: number): Promise<Any> => fakeBrowser.infos.get(ref) || null,
  runQueued: async (tool: string, args: Any): Promise<Any> => {
    fakeBrowser.calls.push([tool, args]);
    if (tool === 'browser_screenshot') return { content: [{ type: 'text', text: 'shot' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] };
    return { content: [{ type: 'text', text: `did ${tool}` }] };
  },
};
export function installFakeBrowser() {
  (req('./electron/ai/tools/browser-tools.cjs') as Any)._internals.browser = () => fakeBrowser;
}

/* ───────────────────────── the loop, driven ───────────────────────── */

export type Protocol = 'openai' | 'anthropic' | 'responses';
export interface DriveEnv {
  work: string; userData: string; events: Any[]; reqs: Rec[]; ctx: Any; spec: Any; agent: Any; ms: number; timedOut: boolean;
  cleanup(): void;
}
export interface DriveOpts {
  name?: string;
  protocol?: Protocol;
  replies: Reply[] | ((rec: Rec, n: number) => Reply);
  spec?: Any;
  ctx?: Any;
  /** Answer to a permission event; null/undefined leaves it unanswered. Default: allow everything. */
  decide?: ((ev: Any, env: DriveEnv) => string | null | undefined) | null;
  onEvent?: (ev: Any, agent: Any, env: DriveEnv) => void;
  onStart?: (agent: Any, env: DriveEnv) => void;
  setup?: (work: string) => void;
  timeout?: number;
  /** How long to watch for stray events after the last one. */
  settle?: number;
}

const AGENT = req('./electron/ai/agent.cjs') as Any;

/** The ctx tools/index.cjs gets from index.cjs for a run. */
export function makeCtx(work: string, userData: string, over: Any = {}): Any {
  const skillsRoot = path.join(userData, 'skills');
  fs.mkdirSync(skillsRoot, { recursive: true });
  return {
    cwd: work, realCwd: fs.realpathSync.native(work), skillsRoot, userData,
    readOnly: false, tools: ['read_file', 'write_file', 'shell', 'code_search', 'web_search', 'web_fetch'], browser: false, images: false, confirmAll: false, shellOnlyGit: false,
    ...over,
  };
}

export async function drive(o: DriveOpts): Promise<DriveEnv> {
  const work = tmp('w');
  const userData = tmp('u');
  if (o.setup) o.setup(work);
  const replies = o.replies;
  const svc = fakeService((rec, n) => (typeof replies === 'function' ? replies(rec, n) : replies[Math.min(n - 1, replies.length - 1)]));
  const protocol: Protocol = o.protocol || 'openai';
  const spec: Any = {
    provider: protocol === 'anthropic' ? 'claude' : protocol === 'responses' ? 'gpt' : 'deepseek',
    driver: protocol === 'anthropic' ? 'api-anthropic' : 'api-openai',
    baseUrl: svc.base, model: 'm', system: 'SYS', messages: [{ role: 'user', content: 'go' }], maxTokens: 8192,
    ...(o.spec || {}),
  };
  const ctx = makeCtx(work, userData, o.ctx || {});
  const events: Any[] = [];
  const env = { work, userData, events, reqs: svc.reqs, ctx, spec, agent: null as Any, ms: 0, timedOut: false, cleanup: () => { svc.close(); rm(work); rm(userData); } } as DriveEnv;
  const decide: DriveOpts['decide'] = o.decide === undefined ? () => 'allow' : o.decide;
  const emit = (ev: Any) => {
    events.push(ev);
    if (ev.type === 'permission' && decide) {
      const d = decide(ev, env);
      // The wait must already be registered when the event goes out (the agent does that), so answering at once is fine; a forged `input` rides along on purpose.
      if (d) setImmediate(() => env.agent.answer(ev.requestId, d, { evil: true }));
    }
    if (o.onEvent) o.onEvent(ev, env.agent, env);
  };
  env.agent = AGENT.runAgent({ spec, key: 'sk-test', emit, protocol, ctx });
  if (o.onStart) o.onStart(env.agent, env);
  const t0 = Date.now();
  const winner = await Promise.race([env.agent.done.then(() => 'done'), sleep(o.timeout || 30000).then(() => 'timeout')]);
  env.ms = Date.now() - t0;
  env.timedOut = winner === 'timeout';
  if (env.timedOut) { env.agent.stop(); console.log(`  (timed out: ${o.name || ''})`); }
  await sleep(o.settle ?? 60); // anything sent after the end would show up here
  return env;
}

export const types = (events: Any[]) => events.map((e) => e.type as string);
export const of = (events: Any[], type: string) => events.filter((e) => e.type === type);
export const terminal = (events: Any[]) => events.filter((e) => e.type === 'done' || e.type === 'error');
