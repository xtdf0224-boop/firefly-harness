/* Headless check of the 网络与 API side: the API drivers against local fake servers (plain Node fetch, which
   is what api.cjs falls back to outside Electron), the readable network errors, and which keys are accepted.
   Plain assertions, no test runner. The net.fetch path (Chromium's stack) needs real Electron and is proven
   by a windowless Electron script, not here. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

let failures = 0;
function expect(label: string, cond: boolean, extra = '') {
  console.log(`${cond ? '  ok ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}
function eq<T>(label: string, actual: T, expected: T) {
  const same = isDeepStrictEqual(actual, expected);
  expect(label, same, same ? '' : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const req = createRequire(path.join(process.cwd(), 'package.json'));
type Ev = { type: string; text?: string; level?: string; input?: number; output?: number };
type Spec = Record<string, unknown>;
const api = req('./electron/ai/api.cjs') as {
  streamOpenAI(spec: Spec, key: string, emit: (e: Ev) => void, signal: AbortSignal): Promise<{ text: string; stopReason: string }>;
  streamAnthropic(spec: Spec, key: string, emit: (e: Ev) => void, signal: AbortSignal): Promise<{ text: string; stopReason: string }>;
  netError(e: unknown): Error & { code?: string };
  httpError(status: number, body: string, provider: string): Error & { code?: string };
};

/* ───────────────────────── fake server ───────────────────────── */

interface Seen { body: Record<string, unknown>; headers: http.IncomingHttpHeaders }
const seen: Record<string, Seen[]> = {};
const chat = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => JSON.stringify({ choices: [{ delta, finish_reason: finish }], ...extra });
const sse = (...frames: string[]) => frames.map((f) => `data: ${f}\n\n`).join('');

/** When each hanging scenario's connection was seen closing: the server notices a client that hung up. */
const closedAt: Record<string, number> = {};
/** Send `first`, then keep the stream open with comment lines until the client hangs up. */
function hang(name: string, res: http.ServerResponse, first: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(first);
  const t = setInterval(() => res.write(': keep\n\n'), 40);
  res.on('close', () => { clearInterval(t); closedAt[name] = Date.now(); });
}
const aDelta = (text: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`;
const invalid400 = (res: http.ServerResponse, message: string) => {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }));
};

/** scenario name (first path segment) → how the fake server answers. */
const SCENARIOS: Record<string, (r: Seen, n: number, res: http.ServerResponse) => void> = {
  // ── OpenAI-compatible
  'sse-done': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(chat({ content: 'He' }), chat({ content: 'llo' }), chat({}, 'stop', { usage: { prompt_tokens: 5, completion_tokens: 2 } })) + 'data: [DONE]\n\n');
  },
  'sse-crlf': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${chat({ content: 'Hi' })}\r\n\r\ndata: ${chat({}, 'stop')}\r\n\r\ndata: [DONE]\r\n\r\n`);
  },
  'sse-done-nofinish': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(chat({ content: 'Hi' })) + 'data: [DONE]\n\n');
  },
  // [DONE] with nothing before it, or with only bookkeeping frames: the stream carried no reply
  'sse-bare-done': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  },
  'sse-usage-done': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 0 } })) + 'data: [DONE]\n\n');
  },
  'sse-reasoning-done': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(chat({ reasoning_content: 'hmm' })) + 'data: [DONE]\n\n');
  },
  'sse-toolcall-done': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(chat({ tool_calls: [{ index: 0, function: { name: 'look', arguments: '' } }] })) + 'data: [DONE]\n\n');
  },
  // the server keeps talking after the client has its answer (or gave up): does the client hang up?
  'sse-hang': (_r, _n, res) => hang('sse-hang', res, sse(chat({ content: 'Hi' }))),
  'sse-hang-error': (_r, _n, res) => hang('sse-hang-error', res, sse(chat({ content: 'Hi' }), JSON.stringify({ error: 'quota exhausted' }))),
  'junk-hang': (_r, _n, res) => hang('junk-hang', res, `${Array(250).fill('x'.repeat(1000)).join('\n')}\n`),
  'sse-cut': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(chat({ content: 'Hi' })));
  },
  'sse-nonewline': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`${sse(chat({ content: 'Hi' }))}data: ${chat({}, 'stop')}`);
  },
  'sse-split': (_r, _n, res) => {
    // one frame torn across two packets, and a multi-byte character torn inside a packet
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const whole = Buffer.from(sse(chat({ content: '你好' }), chat({}, 'stop')));
    res.write(whole.subarray(0, 40));
    setTimeout(() => res.end(whole.subarray(40)), 30);
  },
  'sse-mislabelled': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(sse(chat({ content: 'ok' }), chat({}, 'stop')));
  },
  'sse-event-error': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: error\ndata: {"code":"rate","message":"slow down"}\n\n');
  },
  'sse-string-error': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(JSON.stringify({ error: 'quota exhausted' })));
  },
  'json-error': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid token' } }));
  },
  'json-code': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 401, msg: '令牌无效' }));
  },
  'json-string-error': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad relay key' }));
  },
  'json-complete': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Whole reply', reasoning_content: 'hm' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
  },
  'json-unknown': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hello: 'world' }));
  },
  'html-200': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>Welcome</title></head><body>hi</body></html>');
  },
  'empty-200': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('');
  },
  'http401-string': (_r, _n, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid api key' }));
  },
  'http502-html': (_r, _n, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body>\r\n</html>');
  },
  'http502-notitle': (_r, _n, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html><body><h1>Oops</h1><p>' + 'x'.repeat(2000) + '</p></body></html>');
  },
  'stream-options': (r, _n, res) => {
    if (r.body.stream_options) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unknown parameter: stream_options' } }));
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(chat({ content: 'ok' }), chat({}, 'stop')));
    }
  },
  redirect: (_r, _n, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' });
    res.end();
  },
  // ── Anthropic Messages
  'a-sse': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 2 } } }],
      ['content_block_delta', { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } }],
      ['content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
      ['message_stop', { type: 'message_stop' }],
    ].map(([e, d]) => `event: ${e}\r\ndata: ${JSON.stringify(d)}\r\n\r\n`).join(''));
  },
  'a-cut': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'part' } })}\n\n`);
  },
  'a-bare-done': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  },
  'a-text-done': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`${aDelta('part')}data: [DONE]\n\n`);
  },
  'a-tool-done': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'look', input: {} } })}\n\ndata: [DONE]\n\n`);
  },
  'a-hang': (_r, _n, res) => hang('a-hang', res, aDelta('part')),
  'a-json': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [{ type: 'thinking', thinking: 'ponder' }, { type: 'text', text: 'Whole message' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 6 } }));
  },
  'a-json-error': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  },
  'a-html': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Home</title></head></html>');
  },
  'a-event-error': (_r, _n, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`);
  },
  // 400 about thinking while the body carries it; fine once it is gone
  'a-thinking': (r, _n, res) => {
    if (r.body.thinking || r.body.output_config) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '"thinking.type.adaptive" is not supported for this model' } }));
    } else SCENARIOS['a-sse'](r, 0, res);
  },
  'a-effort': (r, _n, res) => {
    if (r.body.output_config) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'This model does not support the effort parameter.' } }));
    } else SCENARIOS['a-sse'](r, 0, res);
  },
  // only one effort level is refused; the model takes the others
  'a-effort-max': (r, _n, res) => {
    if ((r.body.output_config as { effort?: string } | undefined)?.effort === 'max') invalid400(res, "output_config.effort: Input should be 'low', 'medium' or 'high'");
    else SCENARIOS['a-sse'](r, 0, res);
  },
  // the user's 「off」 (thinking disabled) is what is refused
  'a-off-refused': (r, _n, res) => {
    if ((r.body.thinking as { type?: string } | undefined)?.type === 'disabled') invalid400(res, 'thinking.type: Input should be adaptive');
    else SCENARIOS['a-sse'](r, 0, res);
  },
  // effort is named first, thinking only once effort is gone
  'a-both-refused': (r, _n, res) => {
    if (r.body.output_config) invalid400(res, 'output_config.effort: Extra inputs are not permitted');
    else if (r.body.thinking) invalid400(res, '"thinking.type.adaptive" is not supported for this model');
    else SCENARIOS['a-sse'](r, 0, res);
  },
  // a 400 that only happens to contain the words
  'a-wordy400': (_r, _n, res) => invalid400(res, 'messages.1.content.0: thinking blocks cannot be modified. Not worth the effort of retrying.'),
  'a-bad400': (_r, _n, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: text content blocks must be non-empty' } }));
  },
  'a-always400': (_r, _n, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking is not allowed here' } }));
  },
};

const counts: Record<string, number> = {};
const server = http.createServer((rq, res) => {
  const chunks: Buffer[] = [];
  rq.on('data', (c) => chunks.push(c));
  rq.on('end', () => {
    const name = (rq.url || '/').split('/')[1];
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* none */ }
    const rec = { body, headers: rq.headers };
    (seen[name] ||= []).push(rec);
    counts[name] = (counts[name] || 0) + 1;
    const handler = SCENARIOS[name];
    if (!handler) { res.writeHead(404); res.end('no such scenario'); return; }
    handler(rec, counts[name], res);
  });
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const port = (server.address() as AddressInfo).port;
const origin = `http://127.0.0.1:${port}`;

/* ───────────────────────── helpers ───────────────────────── */

interface Outcome { text: string; stop: string; events: Ev[]; err?: Error & { code?: string } }
async function runOpenAI(scenario: string, extra: Spec = {}): Promise<Outcome> {
  const events: Ev[] = [];
  try {
    const r = await api.streamOpenAI({ provider: 'gpt', baseUrl: `${origin}/${scenario}`, model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra }, 'sk-test-key-1234', (e) => events.push(e), new AbortController().signal);
    return { text: r.text, stop: r.stopReason, events };
  } catch (e) { return { text: '', stop: '', events, err: e as Error & { code?: string } }; }
}
async function runClaude(scenario: string, extraBody?: Spec, model = 'claude-test'): Promise<Outcome> {
  const events: Ev[] = [];
  try {
    const r = await api.streamAnthropic({ provider: 'claude', baseUrl: `${origin}/${scenario}`, model, messages: [{ role: 'user', content: 'hi' }], extraBody }, 'sk-ant-test-1234', (e) => events.push(e), new AbortController().signal);
    return { text: r.text, stop: r.stopReason, events };
  } catch (e) { return { text: '', stop: '', events, err: e as Error & { code?: string } }; }
}
const joined = (o: Outcome, type: string) => o.events.filter((e) => e.type === type).map((e) => e.text).join('');
const notices = (o: Outcome) => o.events.filter((e) => e.type === 'notice');
const NO_EFFORT = '这个模型不接受所选的推理强度，已按默认运行';

/* api.cjs falls back to the global fetch outside Electron. Wrap it to see each request's AbortSignal: a request
   whose stream is over must be aborted, or (under Chromium's net.fetch, which keeps reading after the body reader
   is cancelled) the provider goes on generating and billing. That path is proven in Electron; here the signal is. */
const signals: AbortSignal[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (init?.signal) signals.push(init.signal);
  return realFetch(input, init);
}) as typeof fetch;
const lastSignal = () => signals[signals.length - 1];
const waitClosed = async (name: string, ms = 1500) => {
  const end = Date.now() + ms;
  while (!closedAt[name] && Date.now() < end) await new Promise((ok) => setTimeout(ok, 20));
  return !!closedAt[name];
};
/** Stop is pressed shortly after the first text arrives; resolves with the error code the run ended in. */
async function stopAfterText(driver: 'openai' | 'claude', scenario: string): Promise<string> {
  const ac = new AbortController();
  const spec = { provider: driver === 'openai' ? 'gpt' : 'claude', baseUrl: `${origin}/${scenario}`, model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const run = driver === 'openai' ? api.streamOpenAI : api.streamAnthropic;
  try { await run(spec, 'sk-test-key-1234', (e) => { if (e.type === 'text') setTimeout(() => ac.abort(), 30); }, ac.signal); return ''; } catch (e) { return String((e as { code?: string }).code); }
}

/* ───────────────────────── OpenAI-compatible stream ───────────────────────── */

console.log('OpenAI-compatible stream');
{
  const o = await runOpenAI('sse-done');
  eq('a normal stream gives its text and finish_reason', [o.text, o.stop, o.err?.message], ['Hello', 'stop', undefined]);
  eq('usage is reported', o.events.find((e) => e.type === 'usage'), { type: 'usage', input: 5, output: 2, cached: 0 } as Ev);
  eq('the key goes in the Authorization header', seen['sse-done'][0].headers.authorization, 'Bearer sk-test-key-1234');
}
{
  const o = await runOpenAI('sse-crlf');
  eq('CRLF line endings work', [o.text, o.stop, o.err?.message], ['Hi', 'stop', undefined]);
}
{
  const o = await runOpenAI('sse-split');
  eq('a frame and a character torn across packets still read', [o.text, o.stop, o.err?.message], ['你好', 'stop', undefined]);
}
{
  const o = await runOpenAI('sse-done-nofinish');
  eq('[DONE] without any finish_reason counts as the end', [o.text, o.stop, o.err?.message], ['Hi', 'stop', undefined]);
}
{
  const o = await runOpenAI('sse-bare-done');
  expect('a bare [DONE] is an empty reply, not a finished one', o.err?.code === 'EEMPTY' && /模型没有返回内容/.test(o.err.message), o.err?.message || `${o.text}|${o.stop}`);
  const u = await runOpenAI('sse-usage-done');
  expect('usage frames then [DONE] is the same', u.err?.code === 'EEMPTY', u.err?.message || `${u.text}|${u.stop}`);
  const r = await runOpenAI('sse-reasoning-done');
  eq('[DONE] after reasoning only counts as the end', [r.text, r.stop, joined(r, 'thinking'), r.err?.message], ['', 'stop', 'hmm', undefined]);
  const t = await runOpenAI('sse-toolcall-done');
  eq('[DONE] after a tool call counts as the end', [t.stop, t.err?.message], ['stop', undefined]);
}
{
  const o = await runOpenAI('sse-cut');
  eq('a stream with neither finish_reason nor [DONE] is still incomplete', o.err?.code, 'EINCOMPLETE');
  expect('...and its text was streamed meanwhile', joined(o, 'text') === 'Hi');
}
{
  const o = await runOpenAI('sse-nonewline');
  eq('a last frame closed without a newline is read', [o.text, o.stop, o.err?.message], ['Hi', 'stop', undefined]);
}
{
  const o = await runOpenAI('sse-mislabelled');
  eq('an event stream labelled application/json still streams', [o.text, o.stop, o.err?.message], ['ok', 'stop', undefined]);
}
{
  const o = await runOpenAI('stream-options');
  eq('a gateway that rejects stream_options is retried without it', [o.text, seen['stream-options'].length, seen['stream-options'][1]?.body.stream_options], ['ok', 2, undefined]);
}

console.log('Replies that are not an event stream');
{
  const o = await runOpenAI('json-error');
  expect('HTTP 200 JSON error: its message is shown', o.err?.code === 'API_ERROR' && /Invalid token/.test(o.err.message), o.err?.message);
  expect('...and it is not called 回复不完整', !/不完整/.test(o.err?.message || ''));
}
{
  const o = await runOpenAI('json-code');
  expect('HTTP 200 {code, msg} body: the msg is shown', /令牌无效/.test(o.err?.message || ''), o.err?.message);
}
{
  const o = await runOpenAI('json-string-error');
  expect('a string-valued error field is shown', /bad relay key/.test(o.err?.message || ''), o.err?.message);
}
{
  const o = await runOpenAI('json-complete');
  eq('a complete chat.completion JSON is accepted', [o.text, o.stop, o.err?.message], ['Whole reply', 'stop', undefined]);
  eq('...with its reasoning and usage', [joined(o, 'thinking'), o.events.find((e) => e.type === 'usage')?.output], ['hm', 4]);
}
{
  const o = await runOpenAI('json-unknown');
  expect('an unrecognised JSON body says so', o.err?.code === 'EBADBODY' && /无法识别/.test(o.err.message), o.err?.message);
}
{
  const o = await runOpenAI('html-200');
  eq('a web page is named as one', o.err?.message, '服务地址返回的是网页，不是接口：请检查服务地址');
}
{
  const o = await runOpenAI('empty-200');
  eq('an empty 200 is incomplete', o.err?.code, 'EINCOMPLETE');
}
{
  const o = await runOpenAI('sse-event-error');
  expect('`event: error` with {code,message} is an error', o.err?.code === 'API_ERROR' && /slow down/.test(o.err.message), o.err?.message);
}
{
  const o = await runOpenAI('sse-string-error');
  expect('a frame {error:"…"} is an error with its text', /quota exhausted/.test(o.err?.message || ''), o.err?.message);
}

console.log('HTTP errors');
{
  const o = await runOpenAI('http401-string');
  eq('{"error":"…"} keeps its text', o.err?.message, '密钥无效或已过期（HTTP 401）：invalid api key');
}
{
  const o = await runOpenAI('http502-html');
  eq('an HTML error page is reduced to its title', o.err?.message, '服务端出错，稍后再试（HTTP 502）：502 Bad Gateway');
  const p = await runOpenAI('http502-notitle');
  expect('an HTML page with no title becomes one short line', !/[<>]/.test(p.err?.message || '') && (p.err?.message.length || 0) < 80, p.err?.message);
}
eq('a JSON error body still works', api.httpError(429, JSON.stringify({ error: { message: 'slow down' } }), 'gpt').message, '请求太频繁或额度用完（HTTP 429）：slow down');
eq('a plain-text body is shown', api.httpError(500, 'upstream died', 'gpt').message, '服务端出错，稍后再试（HTTP 500）：upstream died');
eq('an empty body adds nothing', api.httpError(403, '', 'gpt').message, '没有权限（账号未开通该模型，或地区不可用）（HTTP 403）');

console.log('Network errors');
{
  const cases: Array<[string, unknown, RegExp]> = [
    ['ECONNREFUSED', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), /^连不上服务。需要代理的话.*（ECONNREFUSED）$/],
    ['UND_ERR_CONNECT_TIMEOUT', Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), /^连不上服务.*（UND_ERR_CONNECT_TIMEOUT）$/],
    ['ENOTFOUND', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), /^找不到服务器：请检查服务地址和网络（ENOTFOUND）$/],
    ['EAI_AGAIN', Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } }), /^找不到服务器/],
    ['ECONNRESET', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), /^连接被中断.*（ECONNRESET）$/],
    ['UND_ERR_SOCKET', Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }), /^连接被中断/],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', Object.assign(new TypeError('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }), /^证书校验失败.*（DEPTH_ZERO_SELF_SIGNED_CERT）$/],
    ['SELF_SIGNED_CERT_IN_CHAIN', Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }), /^证书校验失败/],
    ['net::ERR_PROXY_CONNECTION_FAILED', new TypeError('net::ERR_PROXY_CONNECTION_FAILED'), /^连不上代理.*（ERR_PROXY_CONNECTION_FAILED）$/],
    ['net::ERR_TUNNEL_CONNECTION_FAILED', new TypeError('net::ERR_TUNNEL_CONNECTION_FAILED'), /^连不上代理/],
    ['net::ERR_NAME_NOT_RESOLVED', new TypeError('net::ERR_NAME_NOT_RESOLVED'), /^找不到服务器.*（ERR_NAME_NOT_RESOLVED）$/],
    ['net::ERR_CONNECTION_TIMED_OUT', new TypeError('net::ERR_CONNECTION_TIMED_OUT'), /^连不上服务。需要代理的话.*（ERR_CONNECTION_TIMED_OUT）$/],
    ['net::ERR_TIMED_OUT', new TypeError('net::ERR_TIMED_OUT'), /^连不上服务/],
    ['net::ERR_CONNECTION_REFUSED', new TypeError('net::ERR_CONNECTION_REFUSED'), /^连不上服务/],
    ['net::ERR_CONNECTION_RESET', new TypeError('net::ERR_CONNECTION_RESET'), /^连接被中断.*（ERR_CONNECTION_RESET）$/],
    ['net::ERR_CONNECTION_CLOSED', new TypeError('net::ERR_CONNECTION_CLOSED'), /^连接被中断/],
    // what Chromium reports when a gateway or proxy cuts a stream part-way
    ['net::ERR_INCOMPLETE_CHUNKED_ENCODING', new TypeError('net::ERR_INCOMPLETE_CHUNKED_ENCODING'), /^连接被中断.*（ERR_INCOMPLETE_CHUNKED_ENCODING）$/],
    ['net::ERR_CONNECTION_ABORTED', new TypeError('net::ERR_CONNECTION_ABORTED'), /^连接被中断.*（ERR_CONNECTION_ABORTED）$/],
    ['net::ERR_CONTENT_LENGTH_MISMATCH', new TypeError('net::ERR_CONTENT_LENGTH_MISMATCH'), /^连接被中断.*（ERR_CONTENT_LENGTH_MISMATCH）$/],
    ['net::ERR_HTTP2_PROTOCOL_ERROR', new TypeError('net::ERR_HTTP2_PROTOCOL_ERROR'), /^连接被中断.*（ERR_HTTP2_PROTOCOL_ERROR）$/],
    ['net::ERR_EMPTY_RESPONSE', new TypeError('net::ERR_EMPTY_RESPONSE'), /^连接被中断.*（ERR_EMPTY_RESPONSE）$/],
    ['net::ERR_INTERNET_DISCONNECTED', new TypeError('net::ERR_INTERNET_DISCONNECTED'), /^电脑没有联网.*（ERR_INTERNET_DISCONNECTED）$/],
    ['net::ERR_CERT_AUTHORITY_INVALID', new TypeError('net::ERR_CERT_AUTHORITY_INVALID'), /^证书校验失败.*（ERR_CERT_AUTHORITY_INVALID）$/],
    ['net::ERR_SSL_PROTOCOL_ERROR', new TypeError('net::ERR_SSL_PROTOCOL_ERROR'), /^证书校验失败/],
  ];
  for (const [label, e, re] of cases) {
    const m = api.netError(e).message;
    expect(`${label} → hint`, re.test(m), m);
  }
  eq('the raw code stays on err.code', api.netError(new TypeError('net::ERR_CONNECTION_REFUSED')).code, 'ERR_CONNECTION_REFUSED');
  eq('an unknown failure keeps the old form', api.netError(new Error('boom')).message, '网络错误：boom');
  eq('an unknown code is shown raw', api.netError(Object.assign(new Error('x'), { cause: { code: 'EWEIRD' } })).message, '网络错误：EWEIRD');
}
{
  // A real refused connection through the fetch path.
  const dead = http.createServer();
  await new Promise<void>((ok) => dead.listen(0, '127.0.0.1', ok));
  const deadPort = (dead.address() as AddressInfo).port;
  await new Promise<void>((ok) => dead.close(() => ok()));
  const events: Ev[] = [];
  let err: (Error & { code?: string }) | undefined;
  try { await api.streamOpenAI({ provider: 'gpt', baseUrl: `http://127.0.0.1:${deadPort}`, model: 'm', messages: [{ role: 'user', content: 'x' }] }, 'sk-test-key-1234', (e) => events.push(e), new AbortController().signal); } catch (e) { err = e as Error & { code?: string }; }
  expect('a refused connection reads as a hint with its code', /^连不上服务.*（ECONNREFUSED）$/.test(err?.message || ''), err?.message);
}
{
  const o = await runOpenAI('redirect');
  expect('a redirect is refused with an explanation', /跳转/.test(o.err?.message || ''), o.err?.message);
}

/* ───────────────────────── Claude (Messages API) ───────────────────────── */

console.log('Claude Messages stream');
{
  const o = await runClaude('a-sse');
  eq('a normal stream gives text and stop reason', [o.text, o.stop, o.err?.message], ['Hello', 'end_turn', undefined]);
  eq('thinking and usage come through', [joined(o, 'thinking'), o.events.find((e) => e.type === 'usage')], ['hmm', { type: 'usage', input: 9, output: 3, cached: 2 } as Ev]);
  eq('the key goes in x-api-key', seen['a-sse'][0].headers['x-api-key'], 'sk-ant-test-1234');
}
{
  const o = await runClaude('a-cut');
  eq('a cut-off stream is incomplete', o.err?.code, 'EINCOMPLETE');
}
{
  const o = await runClaude('a-bare-done');
  expect('a bare [DONE] is an empty reply here too', o.err?.code === 'EEMPTY' && /模型没有返回内容/.test(o.err.message), o.err?.message || `${o.text}|${o.stop}`);
  const t = await runClaude('a-text-done');
  eq('[DONE] after text counts as the end', [t.text, t.stop, t.err?.message], ['part', 'end_turn', undefined]);
  const u = await runClaude('a-tool-done');
  eq('[DONE] after a tool call counts as the end', [u.stop, u.err?.message], ['end_turn', undefined]);
}
{
  const o = await runClaude('a-json');
  eq('a complete message JSON is accepted', [o.text, o.stop, o.err?.message], ['Whole message', 'end_turn', undefined]);
  eq('...with its thinking and usage', [joined(o, 'thinking'), o.events.find((e) => e.type === 'usage')], ['ponder', { type: 'usage', input: 9, output: 6, cached: 0 } as Ev]);
}
{
  const o = await runClaude('a-json-error');
  expect('a 200 error message shows its text', /invalid x-api-key/.test(o.err?.message || ''), o.err?.message);
}
{
  const o = await runClaude('a-html');
  eq('a web page is named as one', o.err?.message, '服务地址返回的是网页，不是接口：请检查服务地址');
}
{
  const o = await runClaude('a-event-error');
  expect('an error event is an error', o.err?.code === 'overloaded_error' && /Overloaded/.test(o.err.message), o.err?.message);
}

/* ───────────────────────── the request is closed when its stream ends ───────────────────────── */

console.log('The request is closed when its stream ends');
{
  const o = await runOpenAI('sse-done');
  expect('a finished stream aborts its request', o.text === 'Hello' && lastSignal().aborted);
  const c = await runClaude('a-sse');
  expect('...on the Claude path too', c.text === 'Hello' && lastSignal().aborted);
  const j = await runOpenAI('json-complete');
  expect('...and a reply that came as one JSON body', j.text === 'Whole reply' && lastSignal().aborted);
}
{
  // a retry makes a second request: the first one's body was read to the end, the second is the stream
  await runOpenAI('stream-options');
  expect('a request retried without stream_options: the streaming one is aborted', lastSignal().aborted);
}
{
  const code = await stopAfterText('openai', 'sse-hang');
  eq('Stop ends the run as ABORTED', code, 'ABORTED');
  expect('...aborts the request', lastSignal().aborted);
  expect('...and the server sees the connection close', await waitClosed('sse-hang'));
}
{
  const code = await stopAfterText('claude', 'a-hang');
  eq('Stop on the Claude path ends the run as ABORTED', code, 'ABORTED');
  expect('...aborts the request', lastSignal().aborted);
  expect('...and the server sees the connection close', await waitClosed('a-hang'));
}
{
  const o = await runOpenAI('sse-hang-error');
  expect('an error frame mid-stream ends the run with its text', o.err?.code === 'API_ERROR' && /quota exhausted/.test(o.err.message), o.err?.message);
  expect('...aborts the request', lastSignal().aborted);
  expect('...and the server sees the connection close', await waitClosed('sse-hang-error'));
}
{
  const o = await runOpenAI('junk-hang');
  expect('a body that is not an event stream is cut at the size cap', o.err?.code === 'EBADBODY', o.err?.message);
  expect('...aborts the request', lastSignal().aborted);
  expect('...and the server sees the connection close', await waitClosed('junk-hang'));
}

console.log('Claude: thinking / effort refused');
{
  const body = { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } };
  const o = await runClaude('a-thinking', body, 'claude-old');
  eq('HTTP 400 about thinking is retried without thinking and output_config', [o.text, o.err?.message, seen['a-thinking'].length], ['Hello', undefined, 2]);
  eq('the first try carried them, the retry did not', [!!seen['a-thinking'][0].body.thinking, !!seen['a-thinking'][0].body.output_config, 'thinking' in seen['a-thinking'][1].body, 'output_config' in seen['a-thinking'][1].body], [true, true, false, false]);
  eq('...and the page is told the level was dropped', notices(o).map((e) => [e.level, e.text]), [['warn', `${NO_EFFORT}。`]]);
  const again = await runClaude('a-thinking', body, 'claude-old');
  eq('the next request for that model and level sends one request, without them', [again.text, seen['a-thinking'].length, 'thinking' in seen['a-thinking'][2].body], ['Hello', 3, false]);
  eq('...and is told again', notices(again).length, 1);
  const other = await runClaude('a-thinking', body, 'claude-new');
  eq('another model is tried with them again', [other.text, seen['a-thinking'].length, !!seen['a-thinking'][3].body.thinking], ['Hello', 5, true]);
}
{
  const o = await runClaude('a-effort', { output_config: { effort: 'high' } }, 'claude-old');
  eq('a refused effort alone is retried too', [o.text, seen['a-effort'].length, 'output_config' in seen['a-effort'][1].body], ['Hello', 2, false]);
}
{
  // The model refuses effort 'max' only: that level loses its effort, thinking stays, other levels are untouched.
  const level = (effort: string) => ({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort } });
  const bodies = () => seen['a-effort-max'].map((x) => x.body);
  const max1 = await runClaude('a-effort-max', level('max'), 'claude-x');
  eq('a 400 naming only output_config drops output_config and keeps thinking', [max1.text, bodies().length, !!bodies()[1].thinking, 'output_config' in bodies()[1]], ['Hello', 2, true, false]);
  eq('...with a notice', notices(max1).map((e) => e.text), [`${NO_EFFORT}。`]);
  const high = await runClaude('a-effort-max', level('high'), 'claude-x');
  eq('another level of the same model is sent as chosen, no notice', [high.text, bodies().length, !!bodies()[2].thinking, (bodies()[2].output_config as { effort?: string }).effort, notices(high).length], ['Hello', 3, true, 'high', 0]);
  const max2 = await runClaude('a-effort-max', level('max'), 'claude-x');
  eq('the refused level is remembered: one request, thinking kept, told again', [max2.text, bodies().length, !!bodies()[3].thinking, 'output_config' in bodies()[3], notices(max2).length], ['Hello', 4, true, false, 1]);
  const dflt = await runClaude('a-effort-max', { thinking: { type: 'adaptive', display: 'summarized' } }, 'claude-x');
  eq('a request with no effort of its own is untouched', [dflt.text, bodies().length, !!bodies()[4].thinking, notices(dflt).length], ['Hello', 5, true, 0]);
}
{
  // The user's 「off」 is never remembered as refused: it is asked for every time, and told every time it was dropped.
  const off = { thinking: { type: 'disabled' }, output_config: { effort: 'low' } };
  const first = await runClaude('a-off-refused', off, 'claude-y');
  eq('a refused off is retried without the fields, with a notice', [first.text, seen['a-off-refused'].length, notices(first).length], ['Hello', 2, 1]);
  const second = await runClaude('a-off-refused', off, 'claude-y');
  eq('...but not remembered: the next off request carries them again', [second.text, seen['a-off-refused'].length, (seen['a-off-refused'][2].body.thinking as { type?: string }).type, notices(second).length], ['Hello', 4, 'disabled', 1]);
}
{
  const o = await runClaude('a-both-refused', { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } }, 'claude-z');
  eq('effort refused first, then thinking: both are dropped, in two steps', [o.text, seen['a-both-refused'].length, 'output_config' in seen['a-both-refused'][1].body, !!seen['a-both-refused'][1].body.thinking, 'thinking' in seen['a-both-refused'][2].body], ['Hello', 3, false, true, false]);
  const again = await runClaude('a-both-refused', { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } }, 'claude-z');
  eq('...and remembered as both', [again.text, seen['a-both-refused'].length, 'thinking' in seen['a-both-refused'][3].body], ['Hello', 4, false]);
}
{
  const o = await runClaude('a-wordy400', { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }, 'claude-w');
  expect('a 400 that merely contains "thinking blocks" or "effort" is not retried', seen['a-wordy400'].length === 1 && o.err?.code === 'HTTP_400' && notices(o).length === 0, `${seen['a-wordy400'].length} requests, ${o.err?.message}`);
}
{
  const o = await runClaude('a-bad400', { thinking: { type: 'adaptive' } });
  expect('an unrelated 400 is not retried and shows its text', seen['a-bad400'].length === 1 && o.err?.code === 'HTTP_400' && /non-empty/.test(o.err.message), o.err?.message);
}
{
  const o = await runClaude('a-always400', { thinking: { type: 'adaptive' } });
  expect('a 400 that persists after the retry is an error, not a loop', seen['a-always400'].length === 2 && o.err?.code === 'HTTP_400', `${seen['a-always400'].length} requests, ${o.err?.message}`);
}
{
  const o = await runClaude('a-bad400');
  expect('a plain request (no thinking fields) is never retried', seen['a-bad400'].length === 2 && o.err?.code === 'HTTP_400', `${seen['a-bad400'].length} requests`);
}

/* ───────────────────────── key validation ───────────────────────── */

console.log('Saving a key');
{
  const saved: Array<{ provider: string; value: string }> = [];
  const fake = {
    app: { getPath: () => path.join(process.cwd(), 'node_modules', '.cache', 'net-check-user') },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => { saved.push({ provider: 'x', value: s }); return Buffer.from(s); }, decryptString: (b: Buffer) => b.toString() },
  };
  const electronPath = req.resolve('electron');
  req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fake, children: [], paths: [], path: '' } as unknown as NodeJS.Module;
  const fsReal = req('node:fs') as typeof import('node:fs');
  const dir = fake.app.getPath();
  fsReal.rmSync(dir, { recursive: true, force: true });
  const secrets = req('./electron/ai/secrets.cjs') as { save(provider: string, key: string): string };
  const tryKey = (key: string) => { try { return { hint: secrets.save('gpt', key) }; } catch (e) { return { error: (e as Error).message }; } };
  const BAD = '密钥里有看不见的字符或中文、全角符号，请重新复制';
  eq('a normal key is saved', tryKey('sk-proj-AbC123_xyz.-0987'), { hint: '••••0987' });
  eq('what was encrypted is the key itself', saved[saved.length - 1].value, 'sk-proj-AbC123_xyz.-0987');
  eq('a pasted key with surrounding spaces and a newline is trimmed', tryKey('  sk-test-key-1234\r\n'), { hint: '••••1234' });
  eq('a zero-width space inside is dropped, not stored', [tryKey('sk-test-​key-5678'), saved[saved.length - 1].value], [{ hint: '••••5678' }, 'sk-test-key-5678']);
  eq('zero-width joiner / word joiner / BOM at the ends are dropped', [tryKey('﻿⁠sk-test-key-9999‌‍'), saved[saved.length - 1].value], [{ hint: '••••9999' }, 'sk-test-key-9999']);
  eq('an ellipsis is refused', tryKey('sk-test…key-1234'), { error: BAD });
  eq('a full-width hyphen is refused', tryKey('sk－test-key-1234'), { error: BAD });
  eq('a pasted Chinese label is refused', tryKey('密钥：sk-test-key-1234'), { error: BAD });
  eq('a full-width colon is refused', tryKey('sk-test：key1234'), { error: BAD });
  eq('a non-breaking space is refused as whitespace', tryKey('sk-test key-1234'), { error: '密钥格式不对：应为一串不含空格的字符' });
  eq('a key with a space inside is refused as before', tryKey('sk-test key-1234'), { error: '密钥格式不对：应为一串不含空格的字符' });
  eq('a too-short key is refused as before', tryKey('abc'), { error: '密钥格式不对：应为一串不含空格的字符' });
  eq('only zero-width characters is refused as too short', tryKey('​​​​​​​​​'), { error: '密钥格式不对：应为一串不含空格的字符' });
  eq('an unknown provider is refused', (() => { try { secrets.save('nope', 'sk-test-key-1234'); return ''; } catch (e) { return (e as Error).message; } })(), '未知的模型服务');
  fsReal.rmSync(dir, { recursive: true, force: true });
}

server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
