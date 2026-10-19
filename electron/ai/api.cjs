// Direct API calls: OpenAI-compatible Chat Completions (GPT, DeepSeek, Kimi, Qwen, GLM, MiniMax,
// 豆包) and the Anthropic Messages API (Claude). Both stream; text arrives as `text` events,
// reasoning as `thinking`, token counts as `usage`. The key is read here and never leaves this process.

const FIRST_BYTE_MS = 90_000;
const COMPLETION_TOKENS = new Set(['gpt', 'kimi', 'qwen', 'minimax']);
/** Request-body keys the page may add for reasoning effort / thinking (validated in index.cjs). */
const EXTRA_KEYS = new Set(['reasoning_effort', 'thinking', 'enable_thinking', 'reasoning_split', 'output_config']);
function applyExtra(body, extra) {
  for (const [k, v] of Object.entries(extra || {})) if (EXTRA_KEYS.has(k)) body[k] = v;
}
const IDLE_MS = 180_000;

/** Turn an HTTP failure into one readable line. */
function httpError(status, body, provider) {
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = (j.error && (j.error.message || j.error.msg || j.error.code)) || j.message || j.msg || j.base_resp?.status_msg || '';
  } catch { detail = String(body || '').slice(0, 300); }
  detail = String(detail).replace(/\s+/g, ' ').trim();
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

/** Read an SSE body, calling onData(json) for each `data:` payload. */
async function readSse(res, signal, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let idle;
  let idled = false;
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => { idled = true; reader.cancel(new Error('IDLE')).catch(() => {}); }, IDLE_MS); };
  // Stop / pause / cancel must end the read even while the model is silently reasoning.
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  arm();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (signal.aborted) break;
      arm();
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        onData(json);
      }
    }
  } finally {
    clearTimeout(idle);
    signal.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
  if (idled && !signal.aborted) throw Object.assign(new Error(`超过 ${IDLE_MS / 60000} 分钟没有收到数据，连接已断开`), { code: 'EIDLE' });
}

/** Routes text inside <think>…</think> (MiniMax and some others put reasoning in the content) to thinking. */
function thinkSplitter(emit) {
  let inThink = false;
  let pending = '';
  return (chunk) => {
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
}

function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, '')}${suffix}`;
}

async function post(url, headers, body, signal) {
  const first = new AbortController();
  const timer = setTimeout(() => first.abort(), FIRST_BYTE_MS);
  const onAbort = () => first.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    // No redirects: the key must only go to the address safeBaseUrl approved.
    return await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: first.signal, redirect: 'error' });
  } catch (e) {
    if (signal.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
    const err = new Error(first.signal.aborted ? '连接超时：服务没有响应' : `网络错误：${e.cause?.code || e.message}`);
    err.code = first.signal.aborted ? 'ETIMEDOUT' : (e.cause?.code || 'ENETWORK');
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * OpenAI-compatible streaming chat.
 * spec: { provider, baseUrl, model, system, messages, maxTokens, extraBody }
 */
async function streamOpenAI(spec, key, emit, signal) {
  const messages = [];
  if (spec.system) messages.push({ role: 'system', content: spec.system });
  for (const m of spec.messages || []) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) });
  const body = { model: spec.model, messages, stream: true, stream_options: { include_usage: true } };
  // OpenAI, Kimi, Qwen and MiniMax have moved to max_completion_tokens (it counts thinking tokens too);
  // DeepSeek, GLM and Ark still document max_tokens. OpenAI's reasoning models only take the default temperature.
  if (spec.maxTokens) body[COMPLETION_TOKENS.has(spec.provider) ? 'max_completion_tokens' : 'max_tokens'] = spec.maxTokens;
  applyExtra(body, spec.extraBody);
  // No temperature: GPT-6, Kimi and the reasoning modes elsewhere reject or ignore non-default values.
  const url = joinUrl(spec.baseUrl, '/chat/completions');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}`, accept: 'text/event-stream' };
  let res = await post(url, headers, body, signal);
  if (res.status === 400) {
    const text = await res.text();
    // A few gateways reject stream_options; try once without it.
    if (/stream_options/i.test(text)) {
      delete body.stream_options;
      res = await post(url, headers, body, signal);
    } else throw httpError(400, text, spec.provider);
  }
  if (!res.ok) throw httpError(res.status, await res.text(), spec.provider);

  let full = '';
  let finish = '';
  const split = thinkSplitter((type, text) => { if (type === 'text') full += text; emit({ type, text }); });
  await readSse(res, signal, (j) => {
    if (j.error) throw Object.assign(new Error(j.error.message || '服务返回错误'), { code: 'API_ERROR' });
    const choice = Array.isArray(j.choices) ? j.choices[0] : undefined;
    const delta = choice && choice.delta;
    if (delta) {
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) emit({ type: 'thinking', text: reasoning });
      if (typeof delta.content === 'string' && delta.content) split(delta.content);
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
  });
  if (signal.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
  return { text: full, stopReason: finish };
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
    messages: (spec.messages || []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })),
  };
  if (spec.system) body.system = spec.system;
  applyExtra(body, spec.extraBody);
  // No temperature / top_p: Claude 5.x returns 400 for any non-default sampling value.
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', accept: 'text/event-stream' };
  const res = await post(url, headers, body, signal);
  if (!res.ok) throw httpError(res.status, await res.text(), spec.provider);

  let full = '';
  let stop = '';
  let input = 0;
  let cached = 0;
  await readSse(res, signal, (j) => {
    if (j.type === 'error') throw Object.assign(new Error(j.error?.message || '服务返回错误'), { code: j.error?.type || 'API_ERROR' });
    if (j.type === 'message_start' && j.message?.usage) {
      input = (j.message.usage.input_tokens || 0) + (j.message.usage.cache_creation_input_tokens || 0) + (j.message.usage.cache_read_input_tokens || 0);
      cached = j.message.usage.cache_read_input_tokens || 0;
    } else if (j.type === 'content_block_delta' && j.delta) {
      if (j.delta.type === 'text_delta' && j.delta.text) { full += j.delta.text; emit({ type: 'text', text: j.delta.text }); }
      else if (j.delta.type === 'thinking_delta' && j.delta.thinking) emit({ type: 'thinking', text: j.delta.thinking });
    } else if (j.type === 'message_delta') {
      if (j.delta?.stop_reason) stop = j.delta.stop_reason;
      if (j.usage) emit({ type: 'usage', input, output: j.usage.output_tokens || 0, cached });
    }
  });
  if (signal.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
  return { text: full, stopReason: stop };
}

module.exports = { streamOpenAI, streamAnthropic, thinkSplitter };
