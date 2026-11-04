// The loop of an API run that works with the workbench's own tools (docs/API-TOOLS.md, section 6): ask the model, show each
// tool call and wait for the person's answer, run the tool, hand the result back, ask again. index.cjs checks the work folder
// and starts this; it never requires index.cjs (index requires it).
//
// Events are the ones the command-line agents already send, so the page needs nothing new to show them: text / thinking /
// usage / notice from api.cjs, and for each call text-break, tool, permission, tool-end. Ids on the events are ours (c1, c2…
// and r1, r2…), never the vendor's: those repeat between turns on several gateways and stay inside the history.
//
// Stopping: from the moment stop() or interrupt() is called nothing is sent except one `done` with stopReason 'interrupted'
// (the page has already marked the calls as cancelled; a tool-end now would turn them into errors). That `done` goes out at
// once, from inside stop(), whatever is still running: the request is aborted, a command is killed by tools/shell.cjs, a
// question waiting for the person counts as a no, and whatever is left of the loop unwinds without saying anything.
'use strict';

const api = require('./api.cjs');
const tools = require('./tools/index.cjs');

const MAX_ROUNDS = 50; // requests to the model per run
const MAX_CALLS = 100; // tool calls per run, refused ones included
const MAX_REPLY_CALLS = 32; // tool calls taken from one reply
const CONTEXT_RATIO = 0.85; // of spec.contextLimit, judged by the last request's input + output
const REPEAT_AT = 3; // the same read-like call this many times in a row is not run again
const REPEAT_TOOLS = new Set(['read_file', 'list_directory', 'glob', 'search_file_content', 'web_fetch', 'web_search']);
const MAX_FOLLOW_UP_CHARS = 20000;
const MAX_QUEUED = 20;

const DENIED_FOR_MODEL = '用户在萤火工作台里拒绝了这次操作。请换一种不需要它的做法，或说明为什么需要。';
const DENIED_FOR_CARD = '你拒绝了这次调用，它没有执行。';
const TRUNCATED_ARGS = '工具参数被输出长度上限截断了。请分几次做：例如先写文件的前一部分，再用 write_file 的 append 追加剩下的。';
const BAD_ARGS = '工具参数不是合法的 JSON 对象，没有执行。请重新调用，并给出合法的参数。';
const TOO_MANY = '一次最多 32 个工具调用，剩下的请分批';
const REPEATED = '这个调用和前两次完全一样，结果不会变，所以没有再执行。请换一种做法，或直接根据已有的结果继续。';
const REFUSAL_TEXT = '模型拒绝了这次请求或内容被服务商过滤了。';
const CONTEXT_OVER = '这一步的对话已经超过了模型的上下文窗口，先停在这里。';

/**
 * An HTTP 400/413 that says the conversation no longer fits the model (services word it differently, and the 85 % guard is
 * blind when the window is unknown or the service sends no usage): then the step winds down as `context`, like the guard.
 * Only the wording about the context / input length counts. An image that is too big names the image, not the context.
 */
const CONTEXT_WORDS = /context[ _-]?(length|window|limit)|prompt (is )?too long|(input|prompt|request) (is |was )?too (long|large)|(input|prompt) length|(max|maximum)\b[^.;]{0,30}\b(length|tokens)|too many (input |prompt )?tokens|token(s)? limit|exceeds?[^.;]{0,20}\btokens?\b|reduce the length|decrease input length|上下文|超出[^。]{0,8}(长度|限制)|输入[^。]{0,6}(过长|太长|超长)/i;
const TOO_LARGE_WORDS = /too (large|big)|entity too|request_too_large|maximum allowed number of bytes|太大|过大/i;
const IMAGE_WORDS = /\bimages?\b|图片|图像|截图|screenshot/i;
const STRONG_CONTEXT = /context[ _-]?(length|window|limit)|prompt (is )?too long|too many (input |prompt )?tokens|上下文/i;
function isContextOverflow(e, round) {
  if (round <= 1 || !e) return false;
  const code = String(e.code || '');
  if (code !== 'HTTP_400' && code !== 'HTTP_413') return false;
  const msg = String(e.message || '');
  if (IMAGE_WORDS.test(msg) && !STRONG_CONTEXT.test(msg)) return false;
  return CONTEXT_WORDS.test(msg) || (code === 'HTTP_413' && TOO_LARGE_WORDS.test(msg));
}

/** Finish reasons that mean the model or the service refused or failed, not that it finished. */
const REFUSED = new Set(['refusal', 'content_filter', 'sensitive']);
const SERVICE_FAILED = new Set(['network_error', 'insufficient_system_resource', 'aborted']);

/** The raw finish reason of the last request → { stopReason } for `done`, or { error } when it was not a finish. */
function ending(raw) {
  const r = String(raw == null ? '' : raw);
  if (r === 'length' || r === 'max_tokens') return { stopReason: 'length' };
  if (REFUSED.has(r)) return { error: { message: REFUSAL_TEXT, code: 'REFUSAL' } };
  if (r === 'model_context_window_exceeded') return { error: { message: '这一步的对话超过了模型的上下文窗口。', code: 'CONTEXT' } };
  if (SERVICE_FAILED.has(r)) return { error: { message: `服务端中断了这次回复（${r}）。可以重试这一步。`, code: 'EINCOMPLETE' } };
  if (r === 'stop' || r === 'end_turn' || r === 'completed') return { stopReason: r };
  return { stopReason: 'stop' }; // tool_calls / tool_use with no call to run, stop_sequence…
}

/** A tool name from the model, safe to put on an event. */
const cleanName = (name) => String(name == null ? '' : name).replace(/[^\w.:-]/g, '_').slice(0, 64) || 'unknown';

/** The one message the run starts from (the page sends a single user message; a prompt string works too). */
function firstMessage(spec) {
  const msgs = Array.isArray(spec.messages) ? spec.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'user' && ((typeof m.content === 'string' && m.content.trim()) || (Array.isArray(m.content) && m.content.length))) return m.content;
  }
  return typeof spec.prompt === 'string' && spec.prompt.trim() ? spec.prompt : null;
}

/**
 * runAgent({ spec, key, emit, protocol, ctx }) → { done, answer(requestId, decision), send(text), interrupt(), stop() }
 *   spec      the page's StartSpec as index.cjs cleaned it (baseUrl checked, extraBody through cleanExtra)
 *   emit      sends one event to the page (index.cjs adds the stream id and takes the key out of the text)
 *   protocol  'openai' | 'anthropic' | 'responses' (api.toolProtocol)
 *   ctx       the run's tools/index.cjs ctx; one object for the whole run
 * `done` resolves when the last event (done or error) has been sent, or at once on stop().
 * send(text) returns false when the run is over, so the page can keep the text for the next step. Words it took that no
 * answered request carried when the run ended (the context, a limit, an error or a stop) are counted in that last event's
 * `unread`; a run that ends normally has read them all.
 */
function runAgent({ spec, key, emit, protocol, ctx }) {
  const ac = new AbortController();
  const pending = new Map(); // requestId → resolve('allow' | 'deny')
  const queued = []; // what the person added while the run was going
  const history = [];
  let unsent = 0; // of those, how many are in the history but no request has carried yet
  let finished = false;
  let stopped = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  /** The only way out: one terminal event, then nothing. */
  const finish = (ev) => {
    if (finished) return;
    finished = true;
    // The page marked these as passed on when send() took them; told how many the model never saw, it keeps them for the next step.
    const unread = queued.length + unsent;
    if (unread) ev.unread = unread;
    try { emit(ev); } catch { /* the page is gone */ }
    resolveDone();
  };
  const em = (ev) => { if (!finished) { try { emit(ev); } catch { /* the page is gone */ } } };

  const halt = () => {
    if (stopped || finished) return;
    stopped = true;
    try { ac.abort(); } catch { /* already */ }
    for (const resolve of pending.values()) resolve('deny'); // a question nobody will answer counts as a no, quietly
    pending.clear();
    finish({ type: 'done', text: '', final: '', stopReason: 'interrupted' });
  };

  const defs = tools.definitions(ctx);
  const system = [spec.system, tools.guidance(defs, ctx)].filter(Boolean).join('\n\n');
  const schemas = api.toolSchemas(protocol, spec.provider, defs);

  let final = ''; // what the last request said: the answer of the step
  let lastUsage = null; // { input, output } of the last request that reported any
  let pendingChars = 0; // characters added to the history since then (results, follow-ups)
  let callSeq = 0;
  let requestSeq = 0;
  let totalCalls = 0;
  let lastKey = ''; // for the repeat check: the previous read-like call and how often it came in a row
  let repeats = 0;

  const notice = (text) => em({ type: 'notice', level: 'warn', text });
  const finishDone = (stopReason) => finish({ type: 'done', text: final, final, stopReason });
  const finishError = (message, code) => finish({ type: 'error', message, code: code || 'API_ERROR' });

  /** The person's added words, as one list of strings, and the queue emptied. */
  const takeQueued = () => queued.splice(0).map((t) => `用户补充：${t}`);

  const contextFull = () => {
    const limit = Number(spec.contextLimit);
    if (!lastUsage || !(limit > 0)) return false;
    // The next request carries the last one's input and output plus what was added since (about 3 characters a token).
    return lastUsage.input + lastUsage.output + Math.ceil(pendingChars / 3) > limit * CONTEXT_RATIO;
  };

  /** A call that cannot run: the page sees it fail, the model is told why. */
  const refuse = (call, callId, message, input, title) => {
    em({ type: 'text-break' });
    em({ type: 'tool', callId, name: cleanName(call.name), input: input || {}, title: title || cleanName(call.name) });
    em({ type: 'tool-end', callId, ok: false, output: message });
    return { id: call.id, name: call.name, output: message, isError: true };
  };

  /**
   * One tool call: check it, ask, run it. → the result for the model, or null when the run was stopped on the way.
   * `truncated`: the reply was cut by the output limit (an argument that does not parse is then that cut).
   */
  const handleCall = async (call, truncated) => {
    const callId = `c${++callSeq}`;
    if (call.input === null) return refuse(call, callId, truncated ? TRUNCATED_ARGS : BAD_ARGS);
    const p = await tools.prepare(call.name, call.input, ctx, ac.signal);
    if (stopped) return null;
    if (!p.ok) return refuse(call, callId, p.error);

    // The same read again and again (a model going in circles) is cut short; calls whose result changes are not counted.
    if (REPEAT_TOOLS.has(call.name)) {
      const k = `${call.name}:${JSON.stringify(p.display)}`;
      repeats = k === lastKey ? repeats + 1 : 1;
      lastKey = k;
      if (repeats >= REPEAT_AT) return refuse(call, callId, REPEATED, p.display, p.title);
    } else {
      lastKey = '';
      repeats = 0;
    }

    // The wait is registered before the question goes out: an answer can never arrive first and be lost.
    const requestId = `r${++requestSeq}`;
    const answered = new Promise((resolve) => pending.set(requestId, resolve));
    em({ type: 'text-break' });
    em({ type: 'tool', callId, name: call.name, input: p.display, title: p.title });
    const ask = { type: 'permission', requestId, callId, name: call.name, input: p.display, title: p.title };
    if (p.reason) ask.reason = p.reason;
    if (p.blockedPath) ask.blockedPath = p.blockedPath;
    if (p.mustAsk) ask.mustAsk = true;
    if (p.risk) ask.risk = p.risk;
    em(ask);
    const decision = await answered;
    pending.delete(requestId);
    if (stopped) return null;
    if (decision !== 'allow') {
      em({ type: 'tool-end', callId, ok: false, output: DENIED_FOR_CARD });
      return { id: call.id, name: call.name, output: DENIED_FOR_MODEL, isError: true };
    }

    let out;
    try {
      out = await tools.execute(call.name, p.input, ctx, ac.signal);
    } catch (e) {
      const msg = `工具执行出错：${(e && e.message) || e}`;
      out = { ok: false, output: msg, display: msg };
    }
    if (stopped) return null;
    const end = { type: 'tool-end', callId, ok: !!out.ok, output: out.display };
    if (typeof out.exitCode === 'number') end.exitCode = out.exitCode;
    em(end);
    const res = { id: call.id, name: call.name, output: out.output, isError: !out.ok };
    if (out.image) res.image = out.image;
    return res;
  };

  const loop = async () => {
    const first = firstMessage(spec);
    if (first === null) { finishError('没有要处理的内容。', 'CONFIG'); return; }
    history.push(api.userMessage(protocol, first));
    pendingChars += typeof first === 'string' ? first.length : 0;
    let extra = spec.extraBody;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (stopped) return;
      if (contextFull()) {
        notice('这一步的对话快要超过模型的上下文窗口了，先停在这里。');
        finishDone('context');
        return;
      }
      let r;
      try {
        r = await api.callWithTools(protocol, spec, key, em, ac.signal, { system, history, tools: schemas, extra, firstCall: round === 1 });
      } catch (e) {
        if (stopped) return;
        // The conversation outgrew the window (the guard above only knows what usage told it): wind down, don't fail the step.
        if (isContextOverflow(e, round)) {
          notice(CONTEXT_OVER);
          finishDone('context');
          return;
        }
        // The code goes to the page as it is: NO_RESPONSES / NO_TOOLS (api.cjs) tell it to run this task without tools.
        finishError((e && e.message) || String(e), (e && e.code) || 'API_ERROR');
        return;
      }
      if (stopped) return;
      unsent = 0; // the model has answered a request that carried them
      for (const m of [].concat(r.assistant)) if (m) history.push(m); // one message, or for Responses the list of output items
      extra = r.extra;
      final = r.text;
      if (r.usage && r.usage.input + r.usage.output > 0) { lastUsage = r.usage; pendingChars = 0; }

      const end = ending(r.stopReason);
      if (end.error) { finishError(end.error.message, end.error.code); return; }

      if (!r.calls.length) {
        // Nothing to run. The person may have added something meanwhile: then the run goes on instead of ending.
        const more = takeQueued();
        if (more.length) {
          em({ type: 'text-break' }); // the answer above is closed: the reply to the added words must not be glued to it
          history.push(...api.resultMessages(protocol, spec.provider, [], more));
          unsent += more.length;
          pendingChars += more.reduce((n, t) => n + t.length, 0);
          continue;
        }
        finishDone(r.truncated ? 'length' : end.stopReason);
        return;
      }

      const results = [];
      let taken = 0;
      let crowded = false;
      for (const call of r.calls) {
        if (stopped) return;
        if (totalCalls >= MAX_CALLS) {
          notice(`这一步调用工具的次数到了上限（${MAX_CALLS} 次），先停在这里。`);
          finishDone('max_rounds');
          return;
        }
        totalCalls++;
        taken++;
        if (taken > MAX_REPLY_CALLS) {
          // Not run, not shown as cards: only answered, so that every call in the history has its result.
          results.push({ id: call.id, name: call.name, output: TOO_MANY, isError: true });
          crowded = true;
          continue;
        }
        const res = await handleCall(call, r.truncated);
        if (res === null) return; // stopped
        results.push(res);
      }
      if (stopped) return;
      if (crowded) notice(`一次回复里有超过 ${MAX_REPLY_CALLS} 个工具调用，多出来的没有执行。`);
      const more = takeQueued();
      history.push(...api.resultMessages(protocol, spec.provider, results, more));
      unsent += more.length;
      pendingChars += results.reduce((n, x) => n + String(x.output || '').length, 0) + more.reduce((n, t) => n + t.length, 0);
    }

    notice(`这一步调用模型的次数到了上限（${MAX_ROUNDS} 次），先停在这里。`);
    finishDone('max_rounds');
  };

  Promise.resolve()
    .then(loop)
    .catch((e) => {
      if (!stopped) finishError(`工具循环出错：${(e && e.message) || e}`, 'AGENT');
    });

  return {
    done,
    /** The person's answer to a question (requestId is ours). Whatever else the page sends along is not read. */
    answer(requestId, decision) {
      const resolve = pending.get(String(requestId));
      if (!resolve) return false;
      pending.delete(String(requestId));
      resolve(decision === 'allow' ? 'allow' : 'deny');
      return true;
    },
    /** Words the person adds mid-run; they go in with the next request. false = the run is over, nobody will read them. */
    send(text) {
      if (finished || stopped) return false;
      const t = String(text == null ? '' : text).trim().slice(0, MAX_FOLLOW_UP_CHARS);
      if (!t) return false;
      if (queued.length >= MAX_QUEUED) return false;
      queued.push(t);
      return true;
    },
    interrupt: halt,
    stop: halt,
  };
}

module.exports = { runAgent, _internals: { ending, firstMessage, cleanName, isContextOverflow, MAX_ROUNDS, MAX_CALLS, MAX_REPLY_CALLS, CONTEXT_RATIO } };
