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

module.exports = { streamOpenAI, streamAnthropic, thinkSplitter, openAiContent, anthropicContent, netError, httpError };
