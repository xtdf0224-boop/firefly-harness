// Direct API calls: OpenAI-compatible Chat Completions (GPT, DeepSeek, Kimi, Qwen, GLM, MiniMax,
// 豆包) and the Anthropic Messages API (Claude). Both stream; text arrives as `text` events,
// reasoning as `thinking`, token counts as `usage`. The key is read here and never leaves this process.
// A message's content is a string, or (user turns, checked in index.cjs) a list of text and base64
// image parts, as the 桌宠 sends a screenshot.

const FIRST_BYTE_MS = 90_000;
const COMPLETION_TOKENS = new Set(['gpt', 'kimi', 'qwen', 'minimax']);
/** Request-body keys the page may add for reasoning effort / thinking (validated in index.cjs). */
const EXTRA_KEYS = new Set(['reasoning_effort', 'thinking', 'enable_thinking', 'reasoning_split', 'output_config']);
function applyExtra(body, extra) {
  for (const [k, v] of Object.entries(extra || {})) if (EXTRA_KEYS.has(k)) body[k] = v;
}
const IDLE_MS = 180_000;
/** What a model or relay refused of the reasoning fields, by base URL + model + effort level: 'effort' (output_config
    only) or 'both' (thinking too). Later requests at that level leave those fields out. A level the model takes is
    never affected, and the user's explicit 「off」 is never kept here. */
const refusedReasoning = new Map();
/** A 400 that names a field, not one that merely contains the word ("thinking blocks must…", "not worth the effort"). */
const THINKING_ERROR = /\bthinking\b(?!\s+blocks?\b)|\badaptive\b/i;
const EFFORT_ERROR = /output_config|\beffort\b(?=\s*(?:[:.=]|param|field|level|setting|value))|["'`]effort["'`]/i;
const NO_EFFORT = '这个模型不接受所选的推理强度，已按默认运行。';

/** The reason inside an error body, whatever shape the vendor chose ({error:{message}}, {error:"…"}, {code,msg}, …). */
function errorDetail(j) {
  if (!j || typeof j !== 'object') return '';
  const e = j.error;
  const d = (typeof e === 'string' ? e : e && (e.message || e.msg || e.code)) || j.message || j.msg || j.base_resp?.status_msg || j.detail;
  return typeof d === 'string' || typeof d === 'number' ? String(d) : '';
}

/** Turn an HTTP failure into one readable line. */
function httpError(status, body, provider) {
  const text = String(body || '');
  let detail = '';
  if (/^\s*</.test(text)) {
    // A gateway's own error page: its title says enough, the markup is noise.
    detail = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text) || [])[1] || '服务返回的是网页，不是接口的错误信息';
  } else {
    try { detail = errorDetail(JSON.parse(text)); } catch { detail = text.slice(0, 300); }
  }
  detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 300);
  const why = status === 401 ? '密钥无效或已过期'
    : status === 403 ? '没有权限（账号未开通该模型，或地区不可用）'
      : status === 404 ? '找不到接口或模型（检查服务地址与模型名）'
        : status === 402 ? '账户余额不足'
          : status === 429 ? '请求太频繁或额度用完'
            : status >= 500 ? '服务端出错，稍后再试'
              : '请求被拒绝';
  const err = new Error(`${why}（HTTP ${status}）${detail ? `：${detail}` : ''}`);
  err.code = `HTTP_${status}`;
  err.provider = provider;
  return err;
}

/** The raw code of a failed request: Node's (cause.code), or Chromium's `net::ERR_…` out of the message. */
function errorCode(e) {
  const c = e && ((e.cause && e.cause.code) || e.code);
  if (c) return String(c);
  const m = /net::(ERR_[A-Z0-9_]+)/.exec(String((e && e.message) || ''));
  return m ? m[1] : '';
}

/** A short Chinese hint for the failures people actually hit; '' for the rest. */
function netHint(code, e) {
  if (/^ERR_(PROXY|TUNNEL)/.test(code)) return '连不上代理：请确认代理软件开着，代理地址和端口没有变（萤火会用系统代理）';
  if (/^(ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED)$/.test(code)) return '找不到服务器：请检查服务地址和网络';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return '证书校验失败：系统不信任服务的 HTTPS 证书（常见于公司网络或安全软件改写了证书），也请检查电脑的日期和时间';
  if (/^(ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ENETUNREACH|ENETDOWN|EHOSTUNREACH)$/.test(code)) return '电脑没有联网，或网络刚刚切换：请检查网络后重试';
  if (/^(UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|ETIMEDOUT|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ECONNREFUSED|ERR_CONNECTION_REFUSED)$/.test(code)) return '连不上服务。需要代理的话，请确认代理软件开着（萤火会用系统代理）';
  if (/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE|ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONTENT_LENGTH_MISMATCH|ERR_HTTP2_PROTOCOL_ERROR)$/.test(code)) return '连接被中断：网络不稳定，或被代理、防火墙拦下，稍后再试';
  // redirect:'error' turns a redirect into a bare failure (Node: "fetch failed", cause "unexpected redirect").
  if (/redirect/i.test(`${e && e.message} ${e && e.cause && e.cause.message}`)) return '服务地址发生了跳转，萤火不会把密钥发给别的地址：请把服务地址改成跳转后的最终地址';
  return '';
}

/** A failed request as one readable error: the hint, with the raw code in brackets. */
function netError(e) {
  const code = errorCode(e);
  const hint = netHint(code, e);
  const err = new Error(hint ? (code ? `${hint}（${code}）` : hint) : `网络错误：${code || (e && e.message) || '未知错误'}`);
  err.code = code || 'ENETWORK';
  return err;
}

/** Cap on what is kept of a body that is not an event stream (it is only read to say what it was). */
const OTHER_MAX = 200_000;

/** Read an SSE body, calling onData(json, event) for each `data:` payload. Resolves { frames, done, other }:
    `done` is true once `data: [DONE]` came; `other` is what arrived instead of frames (a JSON or HTML body
    from a server that ignored stream:true, or sent it with the wrong content-type). `r` is post()'s result:
    however the read ends (finished, Stop, an error frame, idle, too much junk) its request is aborted. */
async function readSse(r, signal, onData) {
  const { res, abort } = r;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let idle;
  let idled = false;
  let frames = 0;
  let sawDone = false;
  let other = '';
  let event = '';
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => { idled = true; reader.cancel(new Error('IDLE')).catch(() => {}); }, IDLE_MS); };
  // Stop / pause / cancel must end the read even while the model is silently reasoning.
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  const keep = (text) => { if (!frames && !sawDone && other.length < OTHER_MAX) other += `${text}\n`; };
  const handle = (raw) => {
    const line = raw.replace(/\r$/, '');
    if (!line) { event = ''; return; }
    if (line.startsWith('event:')) { event = line.slice(6).trim(); return; }
    if (!line.startsWith('data:')) { if (!/^(:|id:|retry:)/.test(line)) keep(line); return; }
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { sawDone = true; return; }
    let json;
    try { json = JSON.parse(data); } catch { keep(data); return; }
    frames++;
    onData(json, event);
  };
  arm();
  try {
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch (e) {
        if (signal.aborted || idled) break;
        throw netError(e);
      }
      if (chunk.done) break;
      if (signal.aborted) break;
      arm();
      buf += decoder.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        handle(line);
      }
      if (!frames && !sawDone && other.length >= OTHER_MAX) break;
    }
    // A last line the server closed the connection on, without a newline.
    if (!signal.aborted && !idled) { buf += decoder.decode(); if (buf) handle(buf); }
  } finally {
    clearTimeout(idle);
    signal.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
    // Cancelling the reader is not enough under Chromium's net.fetch: the connection stays open, the provider keeps
    // generating (and billing) the reply nobody reads. Only aborting the request closes it.
    abort();
  }
  if (idled && !signal.aborted) throw Object.assign(new Error(`超过 ${IDLE_MS / 60000} 分钟没有收到数据，连接已断开`), { code: 'EIDLE' });
  return { frames, done: sawDone, other };
}

/** A 200 reply with no event-stream frames in it: return its JSON when it is a complete reply (`valid` says),
    otherwise throw what it really was (an error body, a web page, something else). */
function plainBody(text, valid, provider) {
  const t = String(text || '').trim();
  if (!t) throw incomplete();
  if (/^</.test(t)) throw Object.assign(new Error('服务地址返回的是网页，不是接口：请检查服务地址'), { code: 'EBADURL', provider });
  const snippet = t.replace(/\s+/g, ' ').slice(0, 120);
  let j;
  try { j = JSON.parse(t); } catch { throw Object.assign(new Error(`服务返回的内容不是接口格式：${snippet}`), { code: 'EBADBODY', provider }); }
  if (valid(j)) return j;
  const detail = errorDetail(j);
  if (detail) throw Object.assign(new Error(`服务返回错误：${detail.replace(/\s+/g, ' ').slice(0, 300)}`), { code: 'API_ERROR', provider });
  throw Object.assign(new Error(`服务返回的内容无法识别：${snippet}`), { code: 'EBADBODY', provider });
}

/** The message of an error frame ({error:{…}}, {error:"…"}, `event: error`, {code,message}), or null for a normal frame. */
function frameError(j, event) {
  if (j.error) return String((typeof j.error === 'string' ? j.error : j.error.message || j.error.msg || j.error.code) || '服务返回错误');
  if (event === 'error' || (j.code && !j.choices && (j.message || j.msg))) return String(j.message || j.msg || '服务返回错误');
  return null;
}

/** Routes text inside <think>…</think> (MiniMax and some others put reasoning in the content) to thinking.
    Call `.end()` when the stream is over: a held-back possible tag start (a trailing 「<」) is real text. */
function thinkSplitter(emit) {
  let inThink = false;
  let pending = '';
  const push = (chunk) => {
    pending += chunk;
    for (;;) {
      const tag = inThink ? '</think>' : '<think>';
      const at = pending.indexOf(tag);
      if (at >= 0) {
        if (at > 0) emit(inThink ? 'thinking' : 'text', pending.slice(0, at));
        pending = pending.slice(at + tag.length);
        inThink = !inThink;
        continue;
      }
      // Keep a possible partial tag at the end for the next chunk.
      let keep = 0;
      for (let k = Math.min(tag.length - 1, pending.length); k > 0; k--) {
        if (tag.startsWith(pending.slice(-k))) { keep = k; break; }
      }
      const out = pending.slice(0, pending.length - keep);
      if (out) emit(inThink ? 'thinking' : 'text', out);
      pending = pending.slice(pending.length - keep);
      return;
    }
  };
  push.end = () => {
    if (pending) emit(inThink ? 'thinking' : 'text', pending);
    pending = '';
  };
  return push;
}

/** The stream closed before the model said it was done: what arrived is only part of the reply. */
const incomplete = () => Object.assign(new Error('连接提前结束，没有收到模型的结束信号，回复不完整。可以重新生成或重试这一步。'), { code: 'EINCOMPLETE' });

/** The stream ended with [DONE] but nothing was said before it. */
const emptyReply = () => Object.assign(new Error('模型没有返回内容（服务只发来了结束标记）。可以重新生成或重试这一步。'), { code: 'EEMPTY' });

/** Content for the OpenAI-compatible API: a string stays one; parts become text / image_url blocks in order. */
function openAiContent(content) {
  if (!Array.isArray(content)) return String(content);
  const out = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === 'text' && p.text) out.push({ type: 'text', text: String(p.text) });
    else if (p.type === 'image' && p.data) out.push({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } });
  }
  return out;
}

/** The same for the Messages API. Images go first: Claude answers a question about an image better when it has seen the image. */
function anthropicContent(content) {
  if (!Array.isArray(content)) return String(content);
  const images = [];
  const texts = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === 'image' && p.data) images.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } });
    else if (p.type === 'text' && p.text) texts.push({ type: 'text', text: String(p.text) });
  }
  return [...images, ...texts];
}

function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, '')}${suffix}`;
}

/** Electron's net.fetch (Chromium's network stack: the Windows system proxy, PAC files and the Windows
    certificate store apply, which Node's fetch ignores) once the app is ready; the global fetch elsewhere
    (plain Node, the check scripts). */
function pickFetch() {
  try {
    const { app, net } = require('electron');
    if (net && typeof net.fetch === 'function' && app && app.isReady()) return (url, init) => net.fetch(url, init);
  } catch { /* not under Electron */ }
  return fetch;
}

/** One request. Resolves { res, abort }: the controller behind the request outlives the headers, and `abort()` ends the
    request itself (readSse calls it when the stream ends for any reason; Stop reaches it through `signal` too). */
async function post(url, headers, body, signal) {
  const first = new AbortController();
  const timer = setTimeout(() => first.abort(), FIRST_BYTE_MS);
  const onAbort = () => first.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const abort = () => { signal.removeEventListener('abort', onAbort); first.abort(); };
  let sent = false;
  try {
    // No redirects: the key must only go to the address safeBaseUrl approved. No cookies either.
    const res = await pickFetch()(url, { method: 'POST', headers, body: JSON.stringify(body), signal: first.signal, redirect: 'error', credentials: 'omit' });
    sent = true;
    return { res, abort };
  } catch (e) {
    if (signal.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
    if (first.signal.aborted) throw Object.assign(new Error('连接超时：服务没有响应'), { code: 'ETIMEDOUT' });
    throw netError(e);
  } finally {
    clearTimeout(timer);
    if (!sent) signal.removeEventListener('abort', onAbort);
  }
}

/** The body of a failed reply as text. That request is finished with. */
async function failureText({ res, abort }) {
  try { return await res.text(); } finally { abort(); }
}

/**
 * OpenAI-compatible streaming chat.
 * spec: { provider, baseUrl, model, system, messages, maxTokens, extraBody }
 */
async function streamOpenAI(spec, key, emit, signal) {
  const messages = [];
  if (spec.system) messages.push({ role: 'system', content: spec.system });
  for (const m of spec.messages || []) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: openAiContent(m.content) });
  const body = { model: spec.model, messages, stream: true, stream_options: { include_usage: true } };
  // OpenAI, Kimi, Qwen and MiniMax have moved to max_completion_tokens (it counts thinking tokens too);
  // DeepSeek, GLM and Ark still document max_tokens. OpenAI's reasoning models only take the default temperature.
  if (spec.maxTokens) body[COMPLETION_TOKENS.has(spec.provider) ? 'max_completion_tokens' : 'max_tokens'] = spec.maxTokens;
  applyExtra(body, spec.extraBody);
  // No temperature: GPT-6, Kimi and the reasoning modes elsewhere reject or ignore non-default values.
  const url = joinUrl(spec.baseUrl, '/chat/completions');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}`, accept: 'text/event-stream' };
  let r = await post(url, headers, body, signal);
  if (r.res.status === 400) {
    const text = await failureText(r);
    // A few gateways reject stream_options; try once without it.
    if (/stream_options/i.test(text)) {
      delete body.stream_options;
      r = await post(url, headers, body, signal);
    } else throw httpError(400, text, spec.provider);
  }
  if (!r.res.ok) throw httpError(r.res.status, await failureText(r), spec.provider);

  let full = '';
  let finish = '';
  let content = false; // the stream carried a reply: text, reasoning or a tool call
  const split = thinkSplitter((type, text) => { content = true; if (type === 'text') full += text; emit({ type, text }); });
  const onFrame = (j, event) => {
    const failure = frameError(j, event);
    if (failure) throw Object.assign(new Error(failure), { code: 'API_ERROR' });
    const choice = Array.isArray(j.choices) ? j.choices[0] : undefined;
    // A gateway that ignored stream:true sends the whole reply as choices[0].message.
    const delta = choice && (choice.delta || choice.message);
    if (delta) {
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) { content = true; emit({ type: 'thinking', text: reasoning }); }
      if (typeof delta.content === 'string' && delta.content) split(delta.content);
      if ((Array.isArray(delta.tool_calls) && delta.tool_calls.length) || delta.function_call) content = true;
    }
    if (choice && choice.finish_reason) finish = choice.finish_reason;
    if (j.usage) {
      const u = j.usage;
      emit({
        type: 'usage',
        input: u.prompt_tokens ?? u.input_tokens ?? 0,
        output: u.completion_tokens ?? u.output_tokens ?? 0,
        cached: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
      });
    }
  };
  const got = await readSse(r, signal, onFrame);
  if (!got.frames && !got.done && !signal.aborted) {
    // Not an event stream: an error body, a web page, or the complete reply in one piece.
    onFrame(plainBody(got.other, (j) => !!j && Array.isArray(j.choices), spec.provider), '');
    if (!finish) finish = 'stop';
  }
  split.end();
  if (signal.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
  // [DONE] is the stream's own end marker: some gateways send it without any finish_reason. It only counts when
  // something came before it; a bare [DONE] is how some gateways answer an upstream failure.
  if (!finish) {
    if (!got.done) throw incomplete();
    if (!content) throw emptyReply();
  }
  return { text: full, stopReason: finish || 'stop' };
}

/**
 * Anthropic Messages API streaming.
 * spec: { baseUrl, model, system, messages, maxTokens, extraBody }
 */
async function streamAnthropic(spec, key, emit, signal) {
  const base = String(spec.baseUrl).replace(/\/+$/, '');
  const url = /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  const body = {
    model: spec.model,
    max_tokens: spec.maxTokens || 4096,
    stream: true,
    messages: (spec.messages || []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: anthropicContent(m.content) })),
  };
  if (spec.system) body.system = spec.system;
  applyExtra(body, spec.extraBody);
  // No temperature / top_p: Claude 5.x returns 400 for any non-default sampling value.
  // A model or relay that refused thinking / effort at one level is not asked again at that level this session.
  // The user's explicit 「off」 (thinking disabled / between_tools) is asked for every time, never remembered.
  const level = body.output_config ? body.output_config.effort : '';
  const off = !!body.thinking && (body.thinking.type === 'disabled' || body.thinking.type === 'between_tools');
  const memo = `${base}|${spec.model}|${level}`;
  let dropped = (body.thinking || body.output_config) && !off ? refusedReasoning.get(memo) : undefined;
  const drop = (what) => {
    if (what === 'both') delete body.thinking;
    delete body.output_config;
    dropped = what;
  };
  if (dropped) drop(dropped);
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', accept: 'text/event-stream' };
  let r = await post(url, headers, body, signal);
  // Older Claude models and some relays reject adaptive thinking or an effort level. Retry without what the error
  // names: only output_config when it names that alone (thinking stays), both when it names thinking. Twice at most,
  // for a model that names effort first and thinking only once effort is gone.
  for (let tries = 0; tries < 2 && r.res.status === 400 && (body.thinking || body.output_config); tries++) {
    const text = await failureText(r);
    const thinking = !!body.thinking && THINKING_ERROR.test(text);
    if (!thinking && !(body.output_config && EFFORT_ERROR.test(text))) throw httpError(400, text, spec.provider);
    drop(thinking ? 'both' : 'effort');
    r = await post(url, headers, body, signal);
    if (r.res.ok && !off) refusedReasoning.set(memo, dropped);
  }
  if (!r.res.ok) throw httpError(r.res.status, await failureText(r), spec.provider);
  if (dropped) emit({ type: 'notice', level: 'warn', text: NO_EFFORT });

  let full = '';
  let stop = '';
  let ended = false;
  let content = false; // the stream carried a reply: text, thinking or a tool call
  let input = 0;
  let cached = 0;
  const startUsage = (u) => {
    input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    cached = u.cache_read_input_tokens || 0;
  };
  const onFrame = (j, event) => {
    if (j.type === 'error' || event === 'error') {
      const message = typeof j.error === 'string' ? j.error : j.error?.message || j.message || j.msg;
      throw Object.assign(new Error(message ? String(message) : '服务返回错误'), { code: j.error?.type || 'API_ERROR' });
    }
    if (j.type === 'message_start' && j.message?.usage) startUsage(j.message.usage);
    else if (j.type === 'content_block_delta' && j.delta) {
      if (j.delta.type === 'text_delta' && j.delta.text) { content = true; full += j.delta.text; emit({ type: 'text', text: j.delta.text }); }
      else if (j.delta.type === 'thinking_delta' && j.delta.thinking) { content = true; emit({ type: 'thinking', text: j.delta.thinking }); }
    } else if (j.type === 'content_block_start') {
      if (/tool_use$/.test(String(j.content_block?.type))) content = true;
    } else if (j.type === 'message_delta') {
      if (j.delta?.stop_reason) stop = j.delta.stop_reason;
      if (j.usage) emit({ type: 'usage', input, output: j.usage.output_tokens || 0, cached });
    } else if (j.type === 'message_stop') ended = true;
  };
  const got = await readSse(r, signal, onFrame);
  if (!got.frames && !got.done && !signal.aborted) {
    // Not an event stream: an error body, a web page, or the complete message in one piece.
    const m = plainBody(got.other, (j) => !!j && j.type !== 'error' && (j.type === 'message' || Array.isArray(j.content)), spec.provider);
    if (m.usage) startUsage(m.usage);
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b && b.type === 'text' && b.text) { full += b.text; emit({ type: 'text', text: b.text }); }
      else if (b && b.type === 'thinking' && b.thinking) emit({ type: 'thinking', text: b.thinking });
    }
    stop = m.stop_reason || 'end_turn';
    if (m.usage) emit({ type: 'usage', input, output: m.usage.output_tokens || 0, cached });
  }
  if (signal.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
  // [DONE] only counts as the end when something came before it (as on the OpenAI path).
  if (!ended && !stop) {
    if (!got.done) throw incomplete();
    if (!content) throw emptyReply();
  }
  return { text: full, stopReason: stop || 'end_turn' };
}

/* ───────────── 带工具的调用（工作任务里的 API 模型） ─────────────
   One request of the agent loop (agent.cjs): the same transports as above plus `tools`, and everything the next request
   must carry back (the assistant message with its reasoning, signatures and the vendor's call ids). The functions above
   stay as they are: chat, summary, the pet and the connection test never come through here. */

/** A tool turn can write a whole file in one call; a smaller output cap would cut it short. */
const TOOL_MIN_TOKENS = 16_000;
const toolMaxTokens = (spec) => Math.max(Number(spec && spec.maxTokens) || 0, TOOL_MIN_TOKENS);
/** Waits before the 1st, 2nd and 3rd retry of one request, the longest a `retry-after` is waited out (longer asks are
    cut to it), and the ask beyond which waiting is pointless (a daily limit, an hour): then the request fails at once. */
const RETRY_DELAYS = [2000, 5000, 10000];
const RETRY_AFTER_MAX = 180_000;
const RETRY_AFTER_GIVE_UP = 300_000;
const aborted = () => Object.assign(new Error('已停止'), { code: 'ABORTED' });

/** Errors that are the service's own hiccup, whether HTTP status or an error frame inside a stream. */
const TRANSIENT_FRAME_CODES = /^(overloaded_error|api_error|server_error|rate_limit_error|rate_limit_exceeded|engine_overloaded_error|service_unavailable_error|slow_down)$/;
/** Network failures no retry can fix: certificates, names that do not resolve. */
const FATAL_NET_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|^(ENOTFOUND|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED)$/;
/** A 429 that means the account is out of money or quota, not that the service is busy. The error's own code or an
    unmistakable phrase, not the bare words billing / balance (a rate-limit text points at a billing page, a "load balancer"
    is a busy one). GLM answers an empty account with HTTP 429 and 余额不足. */
const OUT_OF_QUOTA = /insufficient_quota|exceeded_current_quota|billing_not_active|billing_hard_limit|insufficient[ _](balance|funds|credit)|credit balance|余额|欠费/i;
/** A finish_reason that says the service failed, not the model: retried like an error when nothing was shown yet. */
const SERVICE_FINISH = /^(network_error|insufficient_system_resource|aborted)$/;
const RESPONSES_404 = '这个服务地址不支持 Responses 接口：GPT 在工作任务里调用工具需要它。';
const NO_TOOLS_TEXT = '这个模型或服务地址不支持工具调用';
/** A 400 on the first request that says the tools themselves are not accepted (a model or relay without function calling).
    Only wording that says "not supported": a complaint about one tool's schema is not this. */
const TOOL_WORD = '(?:tools?|functions?|tool[_ -]?choice|tool[_ -]?calls?|tool[_ -]?use|function[_ -]?call(?:ing|s)?)';
const TOOLS_UNSUPPORTED = [
  // "tools is not supported with this model", "Function calling is not enabled", "tool_choice unsupported"
  new RegExp(`\\b${TOOL_WORD}\\b[^.;\\n]{0,40}?\\b(?:not\\s+(?:be\\s+)?(?:supported|available|allowed|permitted|enabled|implemented)|unsupported)`, 'i'),
  // "does not support tools", "doesn't currently support function calling"
  new RegExp(`\\b(?:does(?:n't|\\s+not)|do(?:n't|\\s+not)|cannot|can't|unable\\s+to|no)\\s+(?:\\w+\\s+){0,2}?support(?:s|ed)?\\s+(?:\\w+\\s+){0,2}?${TOOL_WORD}\\b`, 'i'),
  // "Unrecognized request argument supplied: tools", "Unknown parameter: 'tools'"
  new RegExp(`\\b(?:unrecognized|unknown|unexpected|unsupported)\\s+(?:request\\s+)?(?:parameter|param|field|argument|key|property)s?\\b[^.;\\n]{0,30}?[\\s'"\`:：]+${TOOL_WORD}['"\`]?\\s*(?:$|[.,;)\\]])`, 'i'),
  // "tools: Extra inputs are not permitted"
  new RegExp(`\\b${TOOL_WORD}['"\`]?\\s*[:：]\\s*extra inputs are not permitted`, 'i'),
  /不(?:支持|接受|允许)[^。；\n]{0,12}(?:工具|函数调用|function|tool)|(?:工具|函数)(?:调用)?[^。；\n]{0,8}(?:不支持|不可用|未开通)/i,
];

/** 'openai' | 'anthropic' | 'responses'. */
function toolProtocol(spec) {
  if (spec && spec.driver === 'api-anthropic') return 'anthropic';
  if (spec && spec.provider === 'gpt') return 'responses';
  return 'openai';
}

function retryable(e) {
  if (!e || e.noRetry) return false;
  const code = String(e.code || '');
  const http = /^HTTP_(\d+)$/.exec(code);
  if (http) {
    const s = Number(http[1]);
    return s === 408 || s === 409 || s === 429 || (s >= 500 && s <= 599);
  }
  if (TRANSIENT_FRAME_CODES.test(code)) return true;
  if (/^(ABORTED|EBADURL|EBADBODY|API_ERROR|REFUSAL|CONTEXT)$/.test(code)) return false;
  // EEMPTY: a bare [DONE] is how some gateways answer an upstream failure.
  if (/^(ETIMEDOUT|EIDLE|EINCOMPLETE|EEMPTY)$/.test(code)) return true;
  // netError(): Node's or Chromium's own code, or ENETWORK when there was none.
  if (/^(E[A-Z0-9]+|ERR_[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+)$/.test(code)) {
    if (FATAL_NET_CODES.test(code)) return false;
    if (/服务地址发生了跳转/.test(String(e.message))) return false;
    return true;
  }
  return false;
}

/** Milliseconds a failed reply asked us to wait, or null. */
function retryAfterMs(res) {
  try {
    const ms = res.headers.get('retry-after-ms');
    if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
    const v = res.headers.get('retry-after');
    if (!v) return null;
    if (Number.isFinite(Number(v))) return Math.max(0, Number(v) * 1000);
    const at = Date.parse(v);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
  } catch { return null; }
}

/** A wait that Stop ends at once. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const onAbort = () => { clearTimeout(t); reject(aborted()); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The reasoning settings of this loop (what the page sent, as index.cjs cleaned it), copied, plus what api.cjs itself keeps
    from one request to the next under `__api`: the next generated call id, optional fields the first request had to give up,
    a downgrade notice not shown yet. agent.cjs passes the object back untouched; applyExtra ignores the extra key. */
function startExtra(src) {
  const prev = (src && src.__api) || {};
  const ex = { ...(src || {}) };
  ex.__api = { seq: prev.seq || 0, noticed: !!prev.noticed, pending: String(prev.pending || ''), drop: { ...(prev.drop || {}) } };
  return ex;
}

/** One POST. A 400 the caller can fix by dropping an optional field (`onBadRequest` says so) is sent again; any other
    failure becomes an httpError carrying `retryAfter` (ms) and, for an exhausted account, `noRetry`. */
async function sendRequest(url, headers, build, signal, provider, onBadRequest, on404) {
  for (;;) {
    const r = await post(url, headers, build(), signal);
    if (r.res.ok) return r;
    const status = r.res.status;
    const wait = retryAfterMs(r.res);
    let text = '';
    try { text = await failureText(r); } catch { if (signal.aborted) throw aborted(); }
    if (status === 400 && onBadRequest && onBadRequest(text)) continue;
    const err = status === 404 && on404 ? on404(text) : httpError(status, text, provider);
    if (wait !== null) err.retryAfter = wait;
    if (status === 429 && OUT_OF_QUOTA.test(text)) err.noRetry = true;
    throw err;
  }
}

/** Tool arguments as the vendors want them back: '' (a tool with no parameters) and null are `{}`, and so is anything cut
    off or not a JSON object (Kimi, DeepSeek and GLM check the string and answer 400 to a broken one). `input` is the parsed
    object, or null when the arguments were unusable. */
function parseArgs(raw) {
  const s = typeof raw === 'string' ? raw : '';
  if (!s.trim()) return { input: {}, echo: '{}' };
  try {
    const v = JSON.parse(s);
    if (v === null) return { input: {}, echo: '{}' };
    if (typeof v === 'object' && !Array.isArray(v)) return { input: v, echo: s };
  } catch { /* cut off, or never valid */ }
  return { input: null, echo: '{}' };
}

/** A frame's error code: the vendor's when it names a passing failure (so the request is retried), else API_ERROR. */
function frameCode(j) {
  const t = j && j.error && typeof j.error === 'object' ? (j.error.type || j.error.code) : '';
  return typeof t === 'string' && TRANSIENT_FRAME_CODES.test(t) ? t : 'API_ERROR';
}

/** Collects `delta.tool_calls` from an OpenAI-compatible stream (or `message.tool_calls` from a plain reply).
    By `index` when there is one; a second, different non-empty id on the same index is a new call (some gateways number
    every parallel call 0). Without `index`, a chunk carrying an id or a name starts a call and the others continue the last
    one. `id` may arrive as "" and `name` as null: the first non-empty value stays. Arguments are joined and parsed later. */
function toolCallAccumulator() {
  const list = [];
  const byIndex = new Map();
  let last = null;
  const fresh = () => { const c = { id: '', name: '', args: '' }; list.push(c); return c; };
  const add = (tc) => {
    if (!tc || typeof tc !== 'object') return;
    const fn = tc.function && typeof tc.function === 'object' ? tc.function : {};
    const id = typeof tc.id === 'string' ? tc.id : '';
    const name = typeof fn.name === 'string' ? fn.name : '';
    const idx = Number.isInteger(tc.index) ? tc.index : typeof tc.index === 'string' && /^\d+$/.test(tc.index) ? Number(tc.index) : null;
    let call;
    if (idx !== null) {
      call = byIndex.get(idx);
      if (call && id && call.id && id !== call.id) call = null;
      if (!call) { call = fresh(); byIndex.set(idx, call); }
    } else if (last && ((!id && !name) || (id && id === last.id))) call = last;
    else call = fresh();
    last = call;
    if (id && !call.id) call.id = id;
    if (name && !call.name) call.name = name;
    const a = fn.arguments;
    if (typeof a === 'string') call.args += a;
    else if (a && typeof a === 'object') call.args = JSON.stringify(a);
  };
  return { add, list: () => list };
}

/* ─── OpenAI-compatible Chat Completions ─── */

async function openaiTurn(c) {
  const { spec, key, em, signal, o, ex } = c;
  const provider = spec.provider;
  const drop = ex.__api.drop;
  const system = o.system != null ? o.system : spec.system;
  const build = () => {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const m of o.history || []) messages.push(m);
    const body = { model: spec.model, messages, stream: true };
    if (!drop.streamOptions) body.stream_options = { include_usage: true };
    if (Array.isArray(o.tools) && o.tools.length) body.tools = o.tools;
    body[COMPLETION_TOKENS.has(provider) ? 'max_completion_tokens' : 'max_tokens'] = toolMaxTokens(spec);
    applyExtra(body, ex);
    // GLM streams a tool call's arguments only when asked, and drops earlier reasoning unless told to keep it
    // (the reasoning is sent back in full). No tool_choice / parallel_tool_calls: several vendors accept only `auto`.
    if (provider === 'glm') {
      if (!drop.toolStream) body.tool_stream = true;
      if (!drop.clearThinking && body.thinking && body.thinking.type === 'enabled') body.thinking = { ...body.thinking, clear_thinking: false };
    }
    return body;
  };
  // First request of a turn only: a gateway that refuses one optional field names it; send again without it.
  const onBadRequest = c.firstCall ? (text) => {
    let what = '';
    if (!drop.streamOptions && /stream_options/i.test(text)) { drop.streamOptions = true; what = 'stream_options'; }
    else if (provider === 'glm' && !drop.toolStream && /tool_stream/i.test(text)) { drop.toolStream = true; what = 'tool_stream'; }
    else if (provider === 'glm' && !drop.clearThinking && /clear_thinking/i.test(text)) { drop.clearThinking = true; what = 'clear_thinking'; }
    if (!what) return false;
    ex.__api.pending = ex.__api.pending || `这个服务不接受 ${what}，已去掉后继续。`;
    return true;
  } : null;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}`, accept: 'text/event-stream' };
  const r = await sendRequest(joinUrl(spec.baseUrl, '/chat/completions'), headers, build, signal, provider, onBadRequest);
  c.announce();

  const acc = toolCallAccumulator();
  let raw = ''; // the content as the service sent it, <think> tags and all: that is what goes back
  let shown = ''; // what the person reads
  let reasoning = '';
  let reasoned = false; // reasoning_content appeared at all, even as ''
  let finish = '';
  let any = false; // the stream carried a reply: text, reasoning or a tool call
  let usage = null;
  const split = thinkSplitter((type, text) => { any = true; if (type === 'text') shown += text; em({ type, text }); });
  const onFrame = (j, event) => {
    const failure = frameError(j, event);
    if (failure) throw Object.assign(new Error(failure), { code: frameCode(j) });
    const choice = Array.isArray(j.choices) ? j.choices[0] : undefined;
    // A gateway that ignored stream:true sends the whole reply as choices[0].message.
    const delta = choice && (choice.delta || choice.message);
    if (delta) {
      const rc = delta.reasoning_content ?? delta.reasoning;
      if (typeof rc === 'string') {
        reasoned = true;
        if (rc) { any = true; reasoning += rc; em({ type: 'thinking', text: rc }); }
      }
      const content = Array.isArray(delta.content) ? delta.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('') : delta.content;
      if (typeof content === 'string' && content) { raw += content; split(content); }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) acc.add(tc);
        if (delta.tool_calls.length) any = true;
      } else if (delta.function_call && typeof delta.function_call === 'object') {
        acc.add({ function: delta.function_call }); // the pre-tool_calls shape
        any = true;
      }
    }
    // Qwen shows the string "null" on chunks that are not the last.
    if (choice && choice.finish_reason && choice.finish_reason !== 'null') finish = String(choice.finish_reason);
    if (j.usage && typeof j.usage === 'object') {
      const u = j.usage;
      const next = {
        input: u.prompt_tokens ?? u.input_tokens ?? 0,
        output: u.completion_tokens ?? u.output_tokens ?? 0,
        cached: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
      };
      if (!usage || next.input + next.output > 0) usage = next;
    }
  };
  const got = await readSse(r, signal, onFrame);
  if (!got.frames && !got.done && !signal.aborted) {
    // Not an event stream: an error body, a web page, or the complete reply in one piece.
    onFrame(plainBody(got.other, (j) => !!j && Array.isArray(j.choices), provider), '');
    if (!finish) finish = 'stop';
  }
  split.end();
  if (signal.aborted) throw aborted();

  const calls = [];
  const wire = [];
  const used = new Set();
  for (const t of acc.list()) {
    if (!t.id && !t.name && !t.args.trim()) continue; // chunks that carried nothing
    let id = t.id;
    if (!id || used.has(id)) { do { id = c.nextId(); } while (used.has(id)); }
    used.add(id);
    const name = t.name || 'unknown';
    const p = parseArgs(t.args);
    calls.push({ id, name, args: t.args, input: p.input });
    wire.push({ id, type: 'function', function: { name, arguments: p.echo } });
  }
  // [DONE] is the stream's own end marker: some gateways send it without any finish_reason. It only counts when
  // something came before it.
  if (!finish) {
    if (!got.done) throw incomplete();
    if (!any) throw emptyReply();
    finish = calls.length ? 'tool_calls' : 'stop';
  }
  if (SERVICE_FINISH.test(finish) && !c.state.emitted) throw Object.assign(new Error(`服务端中断了这次回复（${finish}）`), { code: 'EINCOMPLETE' });
  const assistant = { role: 'assistant', content: raw };
  if (reasoned) assistant.reasoning_content = reasoning;
  if (wire.length) assistant.tool_calls = wire;
  else if (!raw) assistant.content = '（无回复）'; // an empty assistant turn is refused by several services
  return { text: shown, stopReason: finish, truncated: finish === 'length', assistant, calls, usage };
}

/* ─── Anthropic Messages ─── */

/** `content` of one message with a cache breakpoint on its last block that may carry one: a copy, or null when no block can
    (a thinking block never carries it; an empty text block is refused with it). A string becomes one text block. */
function markLastBlock(content) {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }] : null;
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i];
    if (!b || typeof b !== 'object' || b.type === 'thinking' || b.type === 'redacted_thinking') continue;
    if (b.type === 'text' && !String(b.text || '').trim()) continue;
    const copy = content.slice();
    copy[i] = { ...b, cache_control: { type: 'ephemeral' } };
    return copy;
  }
  return null;
}

/**
 * The messages of one request with two cache breakpoints (prompt caching: a long tool loop re-sends the whole history every
 * round; cache reads cost a tenth and do not count toward the input-tokens-per-minute limit). One on the last block of the
 * last message, one on the last block of the user message before it: that is where the previous request put its own, so
 * a round that added more than 20 blocks (many parallel calls) still reads the earlier cache. Tools and system come before
 * the messages in the cached prefix. `history` itself is not touched.
 */
function withCacheBreakpoints(history) {
  const msgs = Array.isArray(history) ? history.slice() : [];
  const last = msgs.length - 1;
  if (last < 0) return msgs;
  let prev = -1;
  for (let i = last - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') { prev = i; break; }
  for (const i of [last, prev]) {
    if (i < 0 || !msgs[i]) continue;
    const content = markLastBlock(msgs[i].content);
    if (content) msgs[i] = { ...msgs[i], content };
  }
  return msgs;
}

async function anthropicTurn(c) {
  const { spec, key, em, signal, o, ex } = c;
  const base = String(spec.baseUrl).replace(/\/+$/, '');
  const url = /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  const system = o.system != null ? o.system : spec.system;
  // Read, never written: what streamAnthropic learnt about this model is a good place to start, but a refusal met in the
  // middle of a loop (a message that shape-checks differently) must not change how chat asks later.
  if (c.firstCall && (ex.thinking || ex.output_config)) {
    const off = !!ex.thinking && (ex.thinking.type === 'disabled' || ex.thinking.type === 'between_tools');
    const remembered = off ? undefined : refusedReasoning.get(`${base}|${spec.model}|${ex.output_config ? ex.output_config.effort : ''}`);
    if (remembered) {
      if (remembered === 'both') delete ex.thinking;
      delete ex.output_config;
      ex.__api.pending = NO_EFFORT;
    }
  }
  const drop = ex.__api.drop;
  const build = () => {
    // Cache breakpoints go on a copy of the messages: `history` keeps every block (and thinking signature) as it came.
    const body = { model: spec.model, max_tokens: toolMaxTokens(spec), stream: true, messages: drop.cacheControl ? o.history || [] : withCacheBreakpoints(o.history) };
    if (system) body.system = system;
    if (Array.isArray(o.tools) && o.tools.length) body.tools = o.tools;
    applyExtra(body, ex); // thinking / output_config as they are: they stay the same all loop long
    return body;
  };
  // First request of a turn only: what the error names (the cache marks, effort alone, or thinking too) is dropped once and
  // stays dropped in `extra`. A later 400 is a real error; "Expected `thinking` … but found `tool_use`" must not be mistaken for this.
  const onBadRequest = c.firstCall ? (text) => {
    // A relay that does not know cache_control says so: the loop works the same without it, only dearer. No notice.
    if (!drop.cacheControl && /cache_control/i.test(text)) { drop.cacheControl = true; return true; }
    if (!ex.thinking && !ex.output_config) return false;
    const thinking = !!ex.thinking && THINKING_ERROR.test(text);
    if (!thinking && !(ex.output_config && EFFORT_ERROR.test(text))) return false;
    if (thinking) delete ex.thinking;
    delete ex.output_config;
    ex.__api.pending = NO_EFFORT;
    return true;
  } : null;
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', accept: 'text/event-stream' };
  const r = await sendRequest(url, headers, build, signal, spec.provider, onBadRequest);
  c.announce();

  const blocks = []; // by the stream's block index
  let stop = '';
  let ended = false;
  let any = false;
  let shown = '';
  let outTok = 0;
  let seen = false; // the service reported usage
  const inTok = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const mergeUsage = (u) => {
    if (!u || typeof u !== 'object') return;
    seen = true;
    // The counters are cumulative, so the largest value seen stands: a relay's message_delta may carry 0 for what
    // message_start reported (or the reverse, a placeholder first), and the context guard must not lose the input count.
    for (const k of Object.keys(inTok)) if (typeof u[k] === 'number' && u[k] > inTok[k]) inTok[k] = u[k];
    if (typeof u.output_tokens === 'number' && u.output_tokens > outTok) outTok = u.output_tokens;
  };
  const say = (b, text) => { any = true; shown += text; b.text += text; em({ type: 'text', text }); };
  const think = (b, text) => { any = true; b.thinking += text; em({ type: 'thinking', text }); };
  const blockAt = (j, type) => {
    const idx = Number.isInteger(j.index) ? j.index : Math.max(blocks.length - 1, 0);
    if (!blocks[idx] && type) blocks[idx] = type === 'text' ? { type, text: '' } : { type, thinking: '', signature: '' };
    return blocks[idx];
  };
  const onFrame = (j, event) => {
    if (j.type === 'error' || event === 'error') {
      const message = typeof j.error === 'string' ? j.error : j.error?.message || j.message || j.msg;
      throw Object.assign(new Error(message ? String(message) : '服务返回错误'), { code: j.error?.type || 'API_ERROR' });
    }
    if (j.type === 'message_start') mergeUsage(j.message && j.message.usage);
    else if (j.type === 'content_block_start') {
      const cb = j.content_block || {};
      const idx = Number.isInteger(j.index) ? j.index : blocks.length;
      let b;
      if (cb.type === 'text') { b = { type: 'text', text: '' }; blocks[idx] = b; if (typeof cb.text === 'string' && cb.text) say(b, cb.text); }
      else if (cb.type === 'thinking') { b = { type: 'thinking', thinking: '', signature: typeof cb.signature === 'string' ? cb.signature : '' }; blocks[idx] = b; if (typeof cb.thinking === 'string' && cb.thinking) think(b, cb.thinking); }
      else if (cb.type === 'redacted_thinking') { any = true; blocks[idx] = { type: 'redacted_thinking', data: cb.data }; }
      else if (cb.type === 'tool_use') { any = true; blocks[idx] = { type: 'tool_use', id: typeof cb.id === 'string' ? cb.id : '', name: typeof cb.name === 'string' ? cb.name : '', json: '', start: cb.input }; }
      else blocks[idx] = { type: String(cb.type || 'unknown'), skip: true };
    } else if (j.type === 'content_block_delta' && j.delta) {
      const d = j.delta;
      if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) { const b = blockAt(j, 'text'); if (b.type === 'text') say(b, d.text); }
      else if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) { const b = blockAt(j, 'thinking'); if (b.type === 'thinking') think(b, d.thinking); }
      else if (d.type === 'signature_delta' && typeof d.signature === 'string') { const b = blockAt(j, 'thinking'); if (b.type === 'thinking') b.signature += d.signature; }
      else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') { const b = blockAt(j); if (b && b.type === 'tool_use') b.json += d.partial_json; }
    } else if (j.type === 'message_delta') {
      if (j.delta && j.delta.stop_reason) stop = j.delta.stop_reason;
      mergeUsage(j.usage);
    } else if (j.type === 'message_stop') ended = true;
  };
  const got = await readSse(r, signal, onFrame);
  if (!got.frames && !got.done && !signal.aborted) {
    // Not an event stream: an error body, a web page, or the complete message in one piece.
    const m = plainBody(got.other, (j) => !!j && j.type !== 'error' && (j.type === 'message' || Array.isArray(j.content)), spec.provider);
    mergeUsage(m.usage);
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (!b) continue;
      if (b.type === 'text') { const nb = { type: 'text', text: '' }; blocks.push(nb); if (typeof b.text === 'string' && b.text) say(nb, b.text); }
      else if (b.type === 'thinking') { const nb = { type: 'thinking', thinking: '', signature: typeof b.signature === 'string' ? b.signature : '' }; blocks.push(nb); if (typeof b.thinking === 'string' && b.thinking) think(nb, b.thinking); }
      else if (b.type === 'redacted_thinking') { any = true; blocks.push({ type: 'redacted_thinking', data: b.data }); }
      else if (b.type === 'tool_use') { any = true; blocks.push({ type: 'tool_use', id: typeof b.id === 'string' ? b.id : '', name: typeof b.name === 'string' ? b.name : '', json: '', start: b.input }); }
    }
    stop = m.stop_reason || 'end_turn';
    ended = true;
  }
  if (signal.aborted) throw aborted();
  // [DONE] only counts as the end when something came before it (as on the OpenAI path).
  if (!ended && !stop) {
    if (!got.done) throw incomplete();
    if (!any) throw emptyReply();
  }

  const content = [];
  const calls = [];
  const used = new Set();
  for (const b of blocks) {
    if (!b || b.skip) continue;
    // A text block of only whitespace is refused when sent back ("must contain non-whitespace text"): left out.
    if (b.type === 'text') { if (b.text && b.text.trim()) content.push({ type: 'text', text: b.text }); }
    else if (b.type === 'thinking') {
      // Thinking blocks, their signatures and redacted_thinking go back exactly as they came (a block with the text
      // left out by `display: omitted` is just a signature). One cut by max_tokens never got its signature and is refused
      // when sent back: it is left out (such a reply has no tool call to pair it with).
      if (!b.signature && stop === 'max_tokens') continue;
      if (b.thinking || b.signature) content.push(b.signature ? { type: 'thinking', thinking: b.thinking, signature: b.signature } : { type: 'thinking', thinking: b.thinking });
    } else if (b.type === 'redacted_thinking') content.push({ type: 'redacted_thinking', data: b.data });
    else if (b.type === 'tool_use') {
      const startObj = b.start && typeof b.start === 'object' && !Array.isArray(b.start) && Object.keys(b.start).length ? b.start : null;
      const args = b.json || (startObj ? JSON.stringify(startObj) : '');
      const p = parseArgs(args);
      let id = b.id;
      if (!id || used.has(id)) { do { id = c.nextId(); } while (used.has(id)); }
      used.add(id);
      const name = b.name || 'unknown';
      content.push({ type: 'tool_use', id, name, input: p.input || {} });
      calls.push({ id, name, args, input: p.input });
    }
  }
  // An empty assistant turn is refused, and so is one of thinking alone with nothing left to say after dropped blocks.
  if (!content.some((b) => b.type === 'text' || b.type === 'tool_use')) content.push({ type: 'text', text: '（无回复）' });
  stop = stop || 'end_turn';
  const input = inTok.input_tokens + inTok.cache_creation_input_tokens + inTok.cache_read_input_tokens;
  return {
    text: shown, stopReason: stop, truncated: stop === 'max_tokens',
    assistant: { role: 'assistant', content }, calls,
    usage: seen ? { input, output: outTok, cached: inTok.cache_read_input_tokens } : null,
  };
}

/* ─── OpenAI Responses ─── */

/** The visible text of a Responses output (a message's output_text / refusal parts). */
function responseText(items) {
  const out = [];
  for (const it of items) {
    if (!it || it.type !== 'message' || !Array.isArray(it.content)) continue;
    let t = '';
    for (const p of it.content) if (p && (p.type === 'output_text' || p.type === 'refusal')) t += typeof p.text === 'string' ? p.text : typeof p.refusal === 'string' ? p.refusal : '';
    if (t) out.push(t);
  }
  return out.join('\n\n');
}

/** The reasoning summaries of a Responses output. */
function responseThinking(items) {
  const out = [];
  for (const it of items) {
    if (!it || it.type !== 'reasoning' || !Array.isArray(it.summary)) continue;
    const t = it.summary.map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n\n');
    if (t) out.push(t);
  }
  return out.join('\n\n');
}

async function responsesTurn(c) {
  const { spec, key, em, signal, o, ex } = c;
  const provider = spec.provider;
  const drop = ex.__api.drop;
  const system = o.system != null ? o.system : spec.system;
  const effort = typeof ex.reasoning_effort === 'string' ? ex.reasoning_effort : '';
  // No applyExtra here: its flat `reasoning_effort` is the Chat Completions spelling; /responses wants reasoning.effort.
  const build = () => {
    const body = { model: spec.model };
    if (system) body.instructions = system;
    body.input = o.history || [];
    if (Array.isArray(o.tools) && o.tools.length) body.tools = o.tools;
    body.stream = true;
    body.store = false; // nothing kept on the service: the reasoning items come back encrypted and are replayed by us
    if (!drop.include) body.include = ['reasoning.encrypted_content'];
    if (!drop.reasoning) {
      const reasoning = {};
      if (effort) reasoning.effort = effort;
      if (effort !== 'none' && !drop.summary) reasoning.summary = 'auto';
      if (Object.keys(reasoning).length) body.reasoning = reasoning;
    }
    body.max_output_tokens = toolMaxTokens(spec);
    return body;
  };
  // First request of a turn only. Models without reasoning refuse the encrypted include; some accounts refuse
  // summaries until the organisation is verified; an old model id may refuse `reasoning` altogether.
  const onBadRequest = c.firstCall ? (text) => {
    if (!drop.include && /encrypted/i.test(text)) { drop.include = true; ex.__api.pending = ex.__api.pending || '这个模型不返回加密的推理内容，已去掉后继续。'; return true; }
    if (!drop.reasoning && !drop.summary && effort !== 'none' && /summary/i.test(text)) { drop.summary = true; ex.__api.pending = NO_EFFORT; return true; }
    if (!drop.reasoning && /reasoning/i.test(text)) { drop.reasoning = true; ex.__api.pending = NO_EFFORT; return true; }
    return false;
  } : null;
  // A relay without /responses answers 404 to the path; a missing model answers 404 too and keeps its own message.
  const on404 = (text) => (/model/i.test(text) && /not.?found|does not exist|不存在|找不到/i.test(text)
    ? httpError(404, text, provider)
    : Object.assign(new Error(RESPONSES_404), { code: 'NO_RESPONSES', provider })); // its own code: the page runs the task without tools
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}`, accept: 'text/event-stream' };
  const r = await sendRequest(joinUrl(spec.baseUrl, '/responses'), headers, build, signal, provider, onBadRequest, on404);
  c.announce();

  let shown = '';
  let sawText = false;
  let sawThink = false;
  let any = false;
  let thinkKey = '';
  let final = null; // the response object of completed / incomplete
  let status = '';
  const doneItems = new Map(); // output_index → item, for a stream whose completed event carries no output
  const onFrame = (j, event) => {
    const type = j.type || event;
    if (type === 'error' || event === 'error') {
      const e = j.error && typeof j.error === 'object' ? j.error : j;
      const code = typeof e.code === 'string' ? e.code : '';
      throw Object.assign(new Error(String(e.message || e.msg || '服务返回错误')), { code: TRANSIENT_FRAME_CODES.test(code) ? code : 'API_ERROR', provider });
    }
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      if (typeof j.delta === 'string' && j.delta) { any = true; sawText = true; shown += j.delta; em({ type: 'text', text: j.delta }); }
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      if (typeof j.delta === 'string' && j.delta) {
        // Summaries come in parts; the reader sees one paragraph per part.
        const k = `${j.output_index ?? j.item_id ?? ''}:${j.summary_index ?? j.content_index ?? ''}`;
        const text = sawThink && k !== thinkKey ? `\n\n${j.delta}` : j.delta;
        thinkKey = k;
        any = true;
        sawThink = true;
        em({ type: 'thinking', text });
      }
    } else if (type === 'response.output_item.added') {
      if (j.item && j.item.type === 'function_call') any = true;
    } else if (type === 'response.output_item.done') {
      if (j.item && typeof j.item === 'object') doneItems.set(Number.isInteger(j.output_index) ? j.output_index : doneItems.size, j.item);
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      final = j.response && typeof j.response === 'object' ? j.response : {};
      status = type === 'response.completed' ? 'completed' : 'incomplete';
    } else if (type === 'response.failed') {
      const e = (j.response && j.response.error) || j.error || {};
      const code = typeof e.code === 'string' ? e.code : '';
      throw Object.assign(new Error(String(e.message || '服务返回错误')), { code: TRANSIENT_FRAME_CODES.test(code) ? code : 'API_ERROR', provider });
    }
  };
  const got = await readSse(r, signal, onFrame);
  if (!got.frames && !got.done && !signal.aborted) {
    // Not an event stream: an error body, a web page, or the complete response in one piece.
    final = plainBody(got.other, (j) => !!j && !j.error && (j.object === 'response' || Array.isArray(j.output)), provider);
    status = final.status === 'incomplete' ? 'incomplete' : 'completed';
  }
  if (signal.aborted) throw aborted();
  if (!status) throw incomplete(); // the stream closed before response.completed / incomplete

  const items = final && Array.isArray(final.output) && final.output.length
    ? final.output
    : [...doneItems.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  // A service that sent no text events (or a plain reply): the text is in the finished items.
  if (!sawThink) { const t = responseThinking(items); if (t) { any = true; em({ type: 'thinking', text: t }); } }
  if (!sawText) { const t = responseText(items); if (t) { any = true; shown = t; em({ type: 'text', text: t }); } }
  let stopReason = 'completed';
  let truncated = false;
  if (status === 'incomplete') {
    const why = final && final.incomplete_details && final.incomplete_details.reason;
    if (why === 'max_output_tokens') { stopReason = 'length'; truncated = true; }
    else if (why === 'content_filter') throw Object.assign(new Error('模型拒绝了这次请求或内容被服务商过滤了。'), { code: 'REFUSAL', provider });
    else throw Object.assign(new Error(`模型的回复没有完成（${why || '原因不明'}）。可以重试这一步。`), { code: 'API_ERROR', provider });
  }
  if (!items.length && !any) throw emptyReply();

  const calls = [];
  const replay = [];
  const used = new Set();
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'function_call') {
      let id = typeof it.call_id === 'string' ? it.call_id : '';
      if (!id || used.has(id)) { do { id = c.nextId(); } while (used.has(id)); }
      used.add(id);
      const name = it.name || 'unknown';
      const args = typeof it.arguments === 'string' ? it.arguments : it.arguments && typeof it.arguments === 'object' ? JSON.stringify(it.arguments) : '';
      const p = parseArgs(args);
      calls.push({ id, name, args, input: p.input });
      replay.push({ ...it, call_id: id, name, arguments: p.echo });
    } else replay.push(it);
  }
  // A reasoning item with nothing after it is refused when replayed ("provided without its required following item").
  while (replay.length && replay[replay.length - 1].type === 'reasoning') replay.pop();
  const u = final && final.usage && typeof final.usage === 'object' ? final.usage : null;
  return {
    text: shown, stopReason, truncated, assistant: replay, calls,
    usage: u ? { input: u.input_tokens || 0, output: u.output_tokens || 0, cached: u.input_tokens_details?.cached_tokens || 0 } : null,
  };
}

const TURNS = { openai: openaiTurn, anthropic: anthropicTurn, responses: responsesTurn };

/**
 * One model request with tools.
 * opts: { system, history, tools (toolSchemas() output), extra (the previous call's `extra`; the first call: the page's cleaned
 *         extraBody), firstCall }
 * Resolves { text, stopReason, truncated, assistant, calls, extra, usage }:
 *   text       what the model said in this request (what the person read)
 *   assistant  the message to put back in `history` as it is: one message (openai, anthropic) or the array of output items (responses)
 *   calls      [{ id, name, args (the raw string), input (the parsed object, null when unusable) }]; `id` is the vendor's, filled in
 *              when it sent none
 *   extra      hand it back on the next call (carries what a first-request downgrade gave up)
 *   usage      { input, output, cached }, also emitted once as a `usage` event (zeros, nothing emitted, when the service reported none)
 * Retries (408/409/429/5xx, timeouts, dropped connections) happen in here, and only while nothing was shown.
 */
async function callWithTools(protocol, spec, key, emit, signal, opts) {
  const turn = TURNS[protocol];
  if (!turn) throw new Error(`未知的工具调用协议：${protocol}`);
  const o = opts || {};
  // Only the caller's `extra`: spec.extraBody has not been through cleanExtra() unless the caller says so.
  const ex = startExtra(o.extra);
  const state = { emitted: false };
  const em = (ev) => { if (ev && (ev.type === 'text' || ev.type === 'thinking')) state.emitted = true; emit(ev); };
  // The downgrade notice, once per loop, after the request that needed it went through.
  const announce = () => {
    const a = ex.__api;
    if (a.pending && !a.noticed) { a.noticed = true; emit({ type: 'notice', level: 'warn', text: a.pending }); }
    a.pending = '';
  };
  // Generated ids are numbered across the whole loop: a gateway that repeats `call_0` must not collide with the next turn.
  const nextId = () => `call_${ex.__api.seq++}`;
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw aborted();
    try {
      const r = await turn({ spec, key, em, signal, o, ex, state, announce, nextId, firstCall: !!o.firstCall });
      if (signal.aborted) throw aborted();
      const usage = r.usage ? { input: r.usage.input || 0, output: r.usage.output || 0, cached: r.usage.cached || 0 } : null;
      if (usage) emit({ type: 'usage', ...usage });
      return { text: r.text, stopReason: r.stopReason, truncated: !!r.truncated, assistant: r.assistant, calls: r.calls, extra: ex, usage: usage || { input: 0, output: 0, cached: 0 } };
    } catch (e) {
      if (signal.aborted) throw aborted();
      // The first request already refuses the tools: no round of this task can work here (the page may run it without tools).
      if (o.firstCall && Array.isArray(o.tools) && o.tools.length && e && e.code === 'HTTP_400' && TOOLS_UNSUPPORTED.some((re) => re.test(String(e.message)))) {
        throw Object.assign(new Error(`${NO_TOOLS_TEXT}（${e.message}）`), { code: 'NO_TOOLS', provider: e.provider });
      }
      if (state.emitted || attempt >= RETRY_DELAYS.length || !retryable(e)) throw e;
      // A wait of hours (a daily limit) is not waited out three times: say how long the service asked, and stop.
      if (e.retryAfter != null && e.retryAfter > RETRY_AFTER_GIVE_UP) {
        const mins = Math.round(e.retryAfter / 60_000);
        e.message = `${e.message}。服务要求等 ${mins >= 60 ? `${Math.round(mins / 60)} 小时` : `${mins} 分钟`}以后再试，所以没有自动重试。`;
        throw e;
      }
      const wait = e.retryAfter != null ? Math.min(Math.max(e.retryAfter, 1000), RETRY_AFTER_MAX) : RETRY_DELAYS[attempt];
      emit({ type: 'notice', level: 'warn', text: `连接出错，正在重试（第 ${attempt + 1} 次）…` });
      await sleep(wait, signal);
    }
  }
}

/** The loop's first message (or one more user message): a message, or for Responses an input item. */
function userMessage(protocol, text) {
  if (protocol === 'responses') {
    const parts = Array.isArray(text)
      ? text.flatMap((p) => (p && p.type === 'text' && p.text ? [{ type: 'input_text', text: String(p.text) }] : p && p.type === 'image' && p.data ? [{ type: 'input_image', image_url: `data:${p.mime};base64,${p.data}` }] : []))
      : [{ type: 'input_text', text: String(text) }];
    return { role: 'user', content: parts };
  }
  if (protocol === 'anthropic') return { role: 'user', content: Array.isArray(text) ? anthropicContent(text) : String(text) };
  return { role: 'user', content: Array.isArray(text) ? openAiContent(text) : String(text) };
}

/** What the next request needs after the tools ran: one entry of `results` per call, the user's own words after them.
    results: [{ id, name, output, isError, image?: { mime, data } }]; followUps: strings. Returns messages / input items to append. */
function resultMessages(protocol, provider, results, followUps) {
  const rs = Array.isArray(results) ? results : [];
  const said = (r) => (r && r.output != null && String(r.output) !== '' ? String(r.output) : '（没有输出）'); // services refuse an empty result
  const texts = (Array.isArray(followUps) ? followUps : []).map((f) => (typeof f === 'string' ? f : f && f.text)).filter((t) => typeof t === 'string' && t.trim());
  if (protocol === 'anthropic') {
    // One user message: every tool_result first, then what the person added.
    const content = rs.map((r) => {
      const blocks = [{ type: 'text', text: said(r) }];
      if (r.image && r.image.data) blocks.push({ type: 'image', source: { type: 'base64', media_type: r.image.mime, data: r.image.data } });
      const block = { type: 'tool_result', tool_use_id: r.id, content: blocks };
      if (r.isError) block.is_error = true;
      return block;
    });
    for (const t of texts) content.push({ type: 'text', text: t });
    return content.length ? [{ role: 'user', content }] : [];
  }
  if (protocol === 'responses') {
    const out = rs.map((r) => ({
      type: 'function_call_output',
      call_id: r.id,
      output: r.image && r.image.data ? [{ type: 'input_text', text: said(r) }, { type: 'input_image', image_url: `data:${r.image.mime};base64,${r.image.data}` }] : said(r),
    }));
    if (texts.length) out.push({ role: 'user', content: texts.map((t) => ({ type: 'input_text', text: t })) });
    return out;
  }
  // OpenAI-compatible: a tool message per call (images are not put into tool results here), Kimi also wants the name.
  const out = rs.map((r) => {
    const m = { role: 'tool', tool_call_id: r.id, content: said(r) };
    if (provider === 'kimi') m.name = r.name;
    return m;
  });
  if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') });
  return out;
}

/** The tools list for a request body. defs: [{ name, toolId, description, parameters }]. */
function toolSchemas(protocol, provider, defs) {
  return (Array.isArray(defs) ? defs : []).map((d) => {
    const description = String(d.description || '');
    const p = d.parameters && typeof d.parameters === 'object' ? d.parameters : null;
    const parameters = p && p.type ? p : { type: 'object', properties: {}, ...(p || {}) };
    if (protocol === 'anthropic') return { name: d.name, description, input_schema: parameters };
    // strict:false: left out, Responses tries to turn the schema strict and the model fills optional fields with null.
    if (protocol === 'responses') return { type: 'function', name: d.name, description, parameters, strict: false };
    const fn = { name: d.name, description, parameters };
    if (provider === 'kimi') fn.strict = false; // Kimi defaults to strict and checks the schema against its own dialect
    return { type: 'function', function: fn };
  });
}

module.exports = {
  streamOpenAI, streamAnthropic, thinkSplitter, openAiContent, anthropicContent, netError, httpError,
  toolProtocol, callWithTools, userMessage, resultMessages, toolSchemas,
};
