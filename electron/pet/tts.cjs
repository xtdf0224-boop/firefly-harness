// Speech for the 桌宠 (docs/PET.md §6): ElevenLabs, MiniMax and Microsoft's read-aloud voices (edge).
// Everything runs in the main process; the audio goes to the pet window as mp3 chunks. The two keyed
// services keep their keys here (OS-encrypted, like the model keys) and never hand them to a page.
// Electron is only required inside functions, so the helpers can be loaded from a plain node script.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { secMsGec, TRUSTED_CLIENT_TOKEN } = require('./tts-edge-gec.cjs');

const KEYED = new Set(['elevenlabs', 'minimax']);
const ORDER = ['elevenlabs', 'minimax', 'edge'];
const MAX_TEXT = 600;
const TIMEOUT_MS = 25_000;
/** ElevenLabs / MiniMax calls: time allowed for the response headers, and for the call as a whole (body included). */
const FIRST_BYTE_MS = 8_000;
const TOTAL_MS = 30_000;

/** Voices used when a fallback service has no voice of the user's choosing. */
const DEFAULT_VOICE = { elevenlabs: '21m00Tcm4TlvDq8ikWAM', minimax: 'female-shaonv', edge: 'zh-CN-XiaoxiaoNeural' };

/**
 * Speech models (checked against the vendors' docs 2026-10-20; docs/PET.md §6). The first of each list is the
 * recommended one, used when nothing is chosen. ElevenLabs' list is replaced by the account's own (GET /v1/models)
 * when a key is saved; MiniMax has no such list, so this one is it. Only models that speak Mandarin are offered.
 */
const MODELS = {
  elevenlabs: [
    { id: 'eleven_v4', name: 'Eleven v4', note: '最新旗舰，音质和中文口音最好，比 Flash 慢一些' },
    { id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2', note: '上一代稳定款，更多保留声音原本的口音和特点' },
    { id: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5', note: '最快（约 75 毫秒出声），音质略低' },
    { id: 'eleven_v4_turbo', name: 'Eleven v4 Turbo', note: '官方只保证实时对话接口，朗读可能用不了，用不了时自动换回推荐模型' },
    { id: 'eleven_v3', name: 'Eleven v3', note: '上一代表现力模型，只支持稳定度', legacy: true },
    { id: 'eleven_turbo_v2_5', name: 'Eleven Turbo v2.5', note: '已停止维护，官方建议换 Flash v2.5', legacy: true },
  ],
  minimax: [
    { id: 'speech-2.8-hd', name: 'Speech 2.8 HD', note: '最新高清版，音质最好，支持（笑）（叹气）这类语气词' },
    { id: 'speech-2.8-turbo', name: 'Speech 2.8 Turbo', note: '最新极速版，更快更便宜，音质稍逊 HD' },
    { id: 'speech-2.6-hd', name: 'Speech 2.6 HD', note: '上一代高清版，情绪可选耳语、流畅', legacy: true },
    { id: 'speech-2.6-turbo', name: 'Speech 2.6 Turbo', note: '上一代低延迟版', legacy: true },
    { id: 'speech-02-hd', name: 'Speech 02 HD', note: '更早的高清版，复刻相似度高', legacy: true },
    { id: 'speech-02-turbo', name: 'Speech 02 Turbo', note: '更早的低延迟版', legacy: true },
  ],
};
/** Models that are known not to work on the endpoints used here, or are gone: never offered from a live list. */
const EL_HIDDEN = new Set(['eleven_v3_conversational', 'eleven_multilingual_v1', 'eleven_monolingual_v1', 'eleven_flash_v2', 'eleven_turbo_v2']);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** 实时陪玩 plays raw samples as they arrive. */
const PCM_MIME = 'audio/pcm;rate=24000';
const FAST_EL_MODEL = 'eleven_flash_v2_5';
/** The model a service speaks with: the chosen one when it looks like a model id, else the recommended one. */
const pickModel = (provider, chosen) => (typeof chosen === 'string' && MODEL_ID.test(chosen) ? chosen : (MODELS[provider] ? MODELS[provider][0].id : ''));
/** China (the older and the current documented host), then international: a key belongs to one region. */
const MM_HOSTS = ['https://api.minimaxi.com', 'https://api.minimax.io', 'https://api.minimax.cn'];
const EDGE_VERSION = '143.0.3650.75';

/** Microsoft's Chinese read-aloud voices; the live list needs another signed call, so it is fixed here. */
const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（温柔，默认）' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊（活泼）' },
  { id: 'zh-CN-YunxiNeural', name: '云希（少年）' },
  { id: 'zh-CN-YunjianNeural', name: '云健（沉稳）' },
  { id: 'zh-CN-YunyangNeural', name: '云扬（新闻）' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏（少年）' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北（辽宁）' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮（陕西）' },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻（台湾）' },
  { id: 'zh-HK-HiuMaanNeural', name: '曉曼（粤语）' },
];

/* ───────────── keys ───────────── */

/** The MiniMax host that last accepted the key (the key belongs to one region); forgotten when the key changes. */
let mmHost = null;

const keyFile = () => path.join(require('electron').app.getPath('userData'), 'tts-keys.json');

function readKeys() {
  try {
    const data = JSON.parse(fs.readFileSync(keyFile(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

function writeKeys(data) {
  const file = keyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(data, null, 2);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch {
    // AppData behind a filter driver can refuse the rename (EXDEV): write in place.
    fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
    try { fs.unlinkSync(tmp); } catch { /* leave it */ }
  }
}

const safe = () => require('electron').safeStorage;
const hintOf = (key) => `••••${key.slice(-4)}`;

function saveKey(provider, key) {
  if (!KEYED.has(provider)) return { ok: false, error: '这个语音服务不需要密钥' };
  // Keys copied from a web page or a chat often carry zero-width characters that trim() leaves in (as in ai/secrets.cjs).
  const clean = String(key || '').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').trim();
  if (clean.length < 8 || clean.length > 4096 || /\s/.test(clean)) return { ok: false, error: '密钥格式不对：应为一串不含空格的字符' };
  // Keys are plain ASCII; anything else would fail later as a header error that blames the network.
  if (!/^[\x21-\x7e]+$/.test(clean)) return { ok: false, error: '密钥里有看不见的字符或中文、全角符号，请重新复制' };
  try {
    if (!safe().isEncryptionAvailable()) return { ok: false, error: '系统加密不可用，无法安全保存密钥' };
    const data = readKeys();
    data[provider] = { hint: hintOf(clean), value: safe().encryptString(clean).toString('base64'), savedAt: Date.now() };
    writeKeys(data);
    if (provider === 'minimax') mmHost = null; // a key from another region needs the host found again
    return { ok: true, hint: data[provider].hint };
  } catch (e) {
    return { ok: false, error: `没能保存密钥：${e && e.message || e}` };
  }
}

function clearKey(provider) {
  if (provider === 'minimax') mmHost = null;
  const data = readKeys();
  if (data[provider]) {
    delete data[provider];
    // A failed write leaves the key on disk and in use: say so, so the page does not report it deleted.
    try { writeKeys(data); } catch (e) { return { ok: false, error: `没能删除密钥：${e && e.message || e}` }; }
  }
  return { ok: true };
}

/** Main process only. */
function getKey(provider) {
  const entry = readKeys()[provider];
  if (!entry || !entry.value) return null;
  try { return safe().decryptString(Buffer.from(entry.value, 'base64')); } catch { return null; }
}

/** { elevenlabs?: '••••abcd', minimax?: '••••wxyz' } */
function hints() {
  const out = {};
  for (const [id, entry] of Object.entries(readKeys())) if (KEYED.has(id) && entry && entry.hint) out[id] = entry.hint;
  return out;
}

/* ───────────── text ───────────── */

/** Control characters (tab, LF and CR excepted: they become spaces below), non-characters and lone surrogates.
 *  The SSML sent to Microsoft is XML, which rejects them. */
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** What is worth reading aloud: no Markdown, links, emoji or control characters, one run of text. */
function speakable(text) {
  return String(text || '')
    .replace(UNSAFE_CHARS, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`#>~]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT)
    .replace(UNSAFE_CHARS, '') // the cut may have split a surrogate pair
    .trim();
}

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function abortError() {
  return Object.assign(new Error('已取消'), { name: 'AbortError', code: 'ABORT' });
}
const isAbort = (e) => !!e && (e.name === 'AbortError' || e.code === 'ABORT');

/**
 * net.fetch with the limits the two keyed services get: a redirect is an error (the key is never sent on to
 * another host), FIRST_BYTE_MS for the response headers, and TOTAL_MS from `t0` for the whole call, body
 * included. `userSignal` is the caller's cancel. Resolves { res, signal, done, cutShort }: call done() when
 * the body has been read (it clears the timers); cutShort() is the error to throw if the call was cancelled
 * or ran out of time while the body was being read, otherwise null.
 */
async function guardedFetch(url, init, userSignal, label, t0 = Date.now()) {
  if (userSignal && userSignal.aborted) throw abortError();
  const ac = new AbortController();
  let slow = false;
  const give = () => { slow = true; ac.abort(); };
  const onUser = () => ac.abort();
  const firstTimer = setTimeout(give, FIRST_BYTE_MS);
  const totalTimer = setTimeout(give, Math.max(1, TOTAL_MS - (Date.now() - t0)));
  if (userSignal) userSignal.addEventListener('abort', onUser, { once: true });
  const done = () => {
    clearTimeout(firstTimer);
    clearTimeout(totalTimer);
    if (userSignal) userSignal.removeEventListener('abort', onUser);
  };
  const cutShort = () => {
    if (userSignal && userSignal.aborted) return abortError();
    return slow ? Object.assign(new Error(`${label} 响应太慢，已放弃`), { code: 'SLOW' }) : null;
  };
  try {
    const res = await require('electron').net.fetch(url, { ...init, redirect: 'error', signal: ac.signal });
    clearTimeout(firstTimer);
    return { res, signal: ac.signal, done, cutShort };
  } catch (e) {
    done();
    throw cutShort() || e;
  }
}

/* ───────────── ElevenLabs ───────────── */

/** A readable reason from an ElevenLabs error response. */
async function elError(res) {
  let detail = '';
  try {
    const j = await res.json();
    const d = j && j.detail;
    detail = typeof d === 'string' ? d : d && (d.message || d.status) ? String(d.message || d.status) : '';
  } catch { /* no body */ }
  if (res.status === 401) return 'ElevenLabs 密钥无效或已过期';
  if (res.status === 402) return 'ElevenLabs 账号需要付费计划才能用这个声音';
  if (res.status === 429) return 'ElevenLabs 请求太频繁或额度用完了';
  return `ElevenLabs 出错（${res.status}）${detail ? `：${detail.slice(0, 120)}` : ''}`;
}

/** 400 / 404 / 422: the request itself was refused (most often a model this endpoint or account does not take). */
const refused = (status, message) => Object.assign(new Error(message), [400, 404, 422].includes(status) ? { code: 'REQUEST' } : {});

/** Models that take language_code (the docs: not Multilingual v2; Flash v2.5 and v3 / v4 do). */
const EL_LANG = /^(eleven_flash_v2_5|eleven_v3|eleven_v4)/;

/**
 * The streaming request for one line. `o.pcm`: raw 24 kHz 16-bit mono instead of MP3 (实时陪玩); `o.previous`: what she
 * said just before in the same reply, so the sentences flow together; `o.plain`: neither language nor previous text
 * (the retry after a model refused them).
 */
function elevenRequest(text, voiceId, model, o = {}) {
  const id = pickModel('elevenlabs', model);
  const body = { text, model_id: id };
  if (!o.plain && o.pcm) {
    if (EL_LANG.test(id)) body.language_code = 'zh';
    if (o.previous && id !== 'eleven_v3') body.previous_text = String(o.previous).slice(-200);
  }
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${o.pcm ? 'pcm_24000' : 'mp3_44100_64'}`,
    body,
  };
}

/** GET /v1/models → the models that can read Mandarin aloud, in the catalog's order first, with its notes. */
function elevenModelList(raw) {
  const known = new Map(MODELS.elevenlabs.map((m, i) => [m.id, { ...m, order: i }]));
  const out = [];
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!m || typeof m.model_id !== 'string' || !MODEL_ID.test(m.model_id) || EL_HIDDEN.has(m.model_id)) continue;
    if (m.can_do_text_to_speech === false) continue;
    const langs = Array.isArray(m.languages) ? m.languages : [];
    const zh = langs.some((l) => l && (l.language_id === 'zh' || /chinese|mandarin/i.test(String(l.name || ''))));
    if (langs.length && !zh) continue;
    const k = known.get(m.model_id);
    out.push({
      id: m.model_id,
      name: k ? k.name : String(m.name || m.model_id).slice(0, 60),
      note: k ? k.note : '你账号里的模型',
      ...(k && k.legacy ? { legacy: true } : {}),
      order: k ? k.order : 100 + out.length,
    });
  }
  out.sort((a, b) => a.order - b.order);
  const rec = MODELS.elevenlabs[0].id;
  return out.map(({ order, ...m }) => (m.id === rec ? { ...m, recommended: true } : m));
}

async function elevenModels() {
  const key = getKey('elevenlabs');
  if (!key) return null;
  const h = await guardedFetch('https://api.elevenlabs.io/v1/models', { headers: { 'xi-api-key': key, accept: 'application/json' } }, null, 'ElevenLabs');
  let j;
  try {
    if (!h.res.ok) throw new Error(await elError(h.res));
    j = await h.res.json();
  } catch (e) {
    throw h.cutShort() || e;
  } finally { h.done(); }
  const list = elevenModelList(j);
  return list.length ? list : null;
}

async function elevenVoices() {
  const key = getKey('elevenlabs');
  if (!key) throw new Error('还没有保存 ElevenLabs 的密钥');
  const h = await guardedFetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key, accept: 'application/json' } }, null, 'ElevenLabs');
  let j;
  try {
    if (!h.res.ok) throw new Error(await elError(h.res));
    j = await h.res.json();
  } catch (e) {
    throw h.cutShort() || e;
  } finally { h.done(); }
  const list = Array.isArray(j && j.voices) ? j.voices : [];
  return list
    .filter((v) => v && typeof v.voice_id === 'string')
    .map((v) => ({
      id: v.voice_id,
      name: `${v.name || v.voice_id}${v.category && v.category !== 'premade' ? ` · ${v.category === 'generated' ? '设计' : v.category === 'cloned' ? '克隆' : v.category}` : ''}`,
      ...(typeof v.preview_url === 'string' ? { preview: v.preview_url } : {}),
    }));
}

async function elevenSynth(text, voiceId, { onChunk, signal, model, pcm = false, previous = '', plain = false }) {
  const key = getKey('elevenlabs');
  if (!key) throw new Error('还没有保存 ElevenLabs 的密钥');
  const rq = elevenRequest(text, voiceId, model, { pcm, previous, plain });
  const h = await guardedFetch(rq.url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: pcm ? 'application/octet-stream' : 'audio/mpeg' },
    body: JSON.stringify(rq.body),
  }, signal, 'ElevenLabs');
  try {
    if (!h.res.ok) throw refused(h.res.status, await elError(h.res));
    if (!h.res.body) throw new Error('ElevenLabs 没有返回声音');
    const reader = h.res.body.getReader();
    // Cancel or time-out while a read is pending: end the read so the loop below can see why.
    h.signal.addEventListener('abort', () => { reader.cancel().catch(() => {}); }, { once: true });
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) { total += value.length; onChunk(Buffer.from(value), pcm ? PCM_MIME : 'audio/mpeg'); }
    }
    if (h.signal.aborted) throw h.cutShort() || new Error('ElevenLabs 连接中断');
    if (!total) throw new Error('ElevenLabs 返回了空的声音');
  } catch (e) {
    throw h.cutShort() || e;
  } finally { h.done(); }
}

/* ───────────── MiniMax ───────────── */

/** POST JSON to MiniMax. The key belongs to one region: a "wrong key" answer from the first host tries the other. */
async function mmPost(pathname, body, signal) {
  const key = getKey('minimax');
  if (!key) throw new Error('还没有保存 MiniMax 的密钥');
  const t0 = Date.now();
  let last;
  for (const host of mmHost ? [mmHost] : MM_HOSTS) {
    let h;
    try {
      h = await guardedFetch(`${host}${pathname}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, signal, 'MiniMax', t0);
    } catch (e) {
      if (signal && signal.aborted) throw abortError();
      last = e && e.code === 'SLOW' ? e : new Error(`连不上 MiniMax（${host.replace('https://', '')}）`);
      continue;
    }
    // The body is only read for a good answer; whatever stops the read (cancel, time) ends the call.
    const res = h.res;
    const j = res.ok ? await res.json().catch(() => null) : null;
    if (!res.ok) res.body?.cancel().catch(() => {});
    h.done();
    const cut = h.cutShort();
    if (cut) throw cut;
    if (!res.ok) { last = new Error(`MiniMax 出错（HTTP ${res.status}）`); continue; }
    const code = j && j.base_resp && j.base_resp.status_code;
    if (code === 1004 || code === 2049) { last = new Error('MiniMax 密钥无效（或不是这个地域的密钥）'); continue; }
    mmHost = host;
    // 2013: invalid parameters (a model this account or host does not take, among others).
    if (code && code !== 0) throw Object.assign(new Error(`MiniMax：${(j.base_resp.status_msg || `错误 ${code}`).slice(0, 120)}`), code === 2013 ? { code: 'REQUEST' } : {});
    return j;
  }
  throw last || new Error('MiniMax 没有响应');
}

async function minimaxVoices() {
  const j = await mmPost('/v1/get_voice', { voice_type: 'all' });
  const out = [];
  const add = (list, label, keep) => {
    for (const v of Array.isArray(list) ? list : []) {
      if (!v || typeof v.voice_id !== 'string') continue;
      const name = typeof v.voice_name === 'string' && v.voice_name ? v.voice_name : v.voice_id;
      if (keep && !keep(v, name)) continue;
      out.push({ id: v.voice_id, name: label ? `${name} · ${label}` : name });
    }
  };
  // Designed and cloned voices first (they are the user's own), then the Chinese stock voices.
  add(j && j.voice_generation, '设计');
  add(j && j.voice_cloning, '克隆');
  add(j && j.system_voice, '', (v, name) => /[㐀-鿿]/.test(name) || /^Chinese/i.test(v.voice_id));
  return out;
}

/** The T2A request for one line (every listed model takes these fields). */
function minimaxBody(text, voiceId, model, pcm = false) {
  return {
    model: pickModel('minimax', model),
    text,
    stream: false,
    language_boost: 'Chinese',
    voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0 },
    audio_setting: pcm ? { format: 'pcm', sample_rate: 24000, channel: 1 } : { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
    output_format: 'hex',
  };
}

async function minimaxSynth(text, voiceId, { onChunk, signal, model, pcm = false }) {
  const j = await mmPost('/v1/t2a_v2', minimaxBody(text, voiceId, model, pcm), signal);
  const hex = j && j.data && j.data.audio;
  if (typeof hex !== 'string' || !hex) throw new Error('MiniMax 没有返回声音');
  const buf = Buffer.from(hex, 'hex');
  const step = 32 * 1024;
  for (let i = 0; i < buf.length; i += step) onChunk(buf.subarray(i, i + step), pcm ? PCM_MIME : 'audio/mpeg');
}

/* ───────────── Microsoft read-aloud (edge) ───────────── */

// The Sec-MS-GEC token is made from the PC's clock: a clock that is off gets a refused handshake that looks like a network error.
const CLOCK_HINT = '（如果系统时间不准，请先在 Windows 设置里校准时间）';

const edgeStamp = () => new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT/, '$1 $3 $2 $4 $5 GMT+0000 (Coordinated Universal Time)');

function edgeSynth(text, voiceId, { onChunk, signal }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortError()); return; }
    const major = EDGE_VERSION.split('.')[0];
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
      + `&ConnectionId=${crypto.randomUUID().replace(/-/g, '')}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=2-${EDGE_VERSION}`;
    let ws;
    try {
      ws = new WebSocket(url, {
        headers: {
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
          Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
        },
      });
    } catch (e) { reject(new Error(`连不上微软语音：${e && e.message || e}${CLOCK_HINT}`)); return; }
    ws.binaryType = 'arraybuffer';
    let settled = false;
    let bytes = 0;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { ws.close(); } catch { /* closed already */ }
      if (err) reject(err); else if (!bytes) reject(new Error('微软语音没有返回声音')); else resolve();
    };
    const onAbort = () => finish(abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish(new Error('微软语音超时')), TIMEOUT_MS);
    ws.onopen = () => {
      const name = /^[A-Za-z]{2,3}-[A-Za-z]{2,4}(-[A-Za-z0-9]+)*Neural$/.test(voiceId) ? voiceId : DEFAULT_VOICE.edge;
      const lang = name.split('-').slice(0, 2).join('-');
      ws.send(`X-Timestamp:${edgeStamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n');
      ws.send(`X-RequestId:${crypto.randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${edgeStamp()}Z\r\nPath:ssml\r\n\r\n`
        + `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${name}'>`
        + `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${xmlEscape(text)}</prosody></voice></speak>`);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data.includes('Path:turn.end')) finish();
        return;
      }
      const b = Buffer.from(ev.data);
      if (b.length < 2) return;
      const headerLen = b.readUInt16BE(0);
      const header = b.subarray(2, 2 + headerLen).toString('utf8');
      if (!header.includes('Path:audio')) return;
      const body = b.subarray(2 + headerLen);
      if (body.length) { bytes += body.length; onChunk(Buffer.from(body), 'audio/mpeg'); }
    };
    ws.onerror = () => finish(new Error(`连不上微软语音${CLOCK_HINT}`));
    ws.onclose = () => finish(bytes ? undefined : new Error(`微软语音连接被关闭${CLOCK_HINT}`));
  });
}

/* ───────────── the API ───────────── */

const RUN = { elevenlabs: elevenSynth, minimax: minimaxSynth, edge: edgeSynth };

/** The services to try: the chosen one first, then the rest in ElevenLabs → MiniMax → edge order. */
function chain(provider, fallback) {
  const first = ORDER.includes(provider) ? provider : 'edge';
  return fallback ? [first, ...ORDER.filter((p) => p !== first)] : [first];
}

/**
 * Read `text` aloud: `onChunk(buffer, mime)` is called as audio arrives. Resolves { provider } with the
 * service that spoke. With voice.fallback a failing service is replaced by the next one; once audio has
 * started the line is not switched to another voice. Rejects with a Chinese message.
 */
async function synth(text, voice, { onChunk, signal, strictModel = false } = {}) {
  const clean = speakable(text);
  if (!clean) throw new Error('没有可以读的文字');
  const v = voice && typeof voice === 'object' ? voice : {};
  const chosen = v.models && typeof v.models === 'object' ? v.models : {};
  const sink = typeof onChunk === 'function' ? onChunk : () => {};
  let lastError;
  for (const provider of chain(v.provider, !!v.fallback)) {
    const id = provider === v.provider && v.voiceId ? String(v.voiceId) : DEFAULT_VOICE[provider];
    const model = MODELS[provider] ? pickModel(provider, chosen[provider]) : '';
    // A chosen model the service refuses (renamed, not on this account or endpoint): she still speaks, with the
    // recommended one. 试听 (strictModel) reports the refusal instead, so the choice is never silently replaced.
    const models = model && !strictModel && model !== MODELS[provider][0].id ? [model, MODELS[provider][0].id] : [model];
    for (const m of models) {
      if (signal && signal.aborted) throw abortError();
      let started = false;
      try {
        await RUN[provider](clean, id, { onChunk: (buf, mime) => { started = true; sink(buf, mime); }, signal, model: m });
        return { provider, model: m };
      } catch (e) {
        if (isAbort(e) || (signal && signal.aborted)) throw abortError();
        lastError = e;
        if (started) throw e;
        if (!(e && e.code === 'REQUEST')) break;
      }
    }
  }
  throw lastError || new Error('语音合成失败');
}

/**
 * 实时陪玩: one sentence, streamed. ElevenLabs and MiniMax give raw 24 kHz 16-bit mono PCM (`onPcm`, always whole samples);
 * Microsoft read-aloud only gives MP3 (`onMp3`, one sentence's worth, to be decoded by the page). `fast` reads with
 * ElevenLabs Flash v2.5; `previous` is the text already spoken in this reply. Resolves { provider, mime }; rejects in
 * Chinese once every service in the chain failed before any audio.
 */
async function live(text, voice, { onPcm, onMp3, signal, fast = false, previous = '' } = {}) {
  const clean = speakable(text);
  if (!clean) throw new Error('没有可以读的文字');
  const v = voice && typeof voice === 'object' ? voice : {};
  const chosen = v.models && typeof v.models === 'object' ? v.models : {};
  let carry = null;
  // A network chunk can end half way through a sample: the odd byte waits for the next chunk.
  const pcmOut = (buf) => {
    let b = carry ? Buffer.concat([carry, buf]) : buf;
    carry = null;
    if (b.length % 2) { carry = Buffer.from(b.subarray(b.length - 1)); b = b.subarray(0, b.length - 1); }
    if (b.length && typeof onPcm === 'function') onPcm(b);
  };
  let lastError;
  for (const provider of chain(v.provider, !!v.fallback)) {
    if (signal && signal.aborted) throw abortError();
    const id = provider === v.provider && v.voiceId ? String(v.voiceId) : DEFAULT_VOICE[provider];
    let started = false;
    try {
      if (provider === 'edge') {
        const parts = [];
        await edgeSynth(clean, id, { onChunk: (buf) => { started = true; parts.push(Buffer.from(buf)); }, signal });
        if (typeof onMp3 === 'function') onMp3(Buffer.concat(parts));
        return { provider, mime: 'audio/mpeg' };
      }
      const fastEl = provider === 'elevenlabs' && fast;
      const model = fastEl ? FAST_EL_MODEL : pickModel(provider, chosen[provider]);
      // A chosen model the service refuses: once more with the recommended one, as synth() does. Never on the Flash fast
      // path, and never after sound started (the sentence is not switched to another model half way).
      const models = !fastEl && model && model !== MODELS[provider][0].id ? [model, MODELS[provider][0].id] : [model];
      for (let i = 0; i < models.length; i++) {
        const run = (plain) => RUN[provider](clean, id, { onChunk: (buf) => { started = true; pcmOut(Buffer.from(buf)); }, signal, model: models[i], pcm: true, previous, plain });
        try {
          try {
            await run(false);
          } catch (e) {
            // Refused (a model that does not take the language or the previous text): once more without them.
            if (started || !(e && e.code === 'REQUEST') || provider !== 'elevenlabs') throw e;
            await run(true);
          }
          break;
        } catch (e) {
          if (started || !(e && e.code === 'REQUEST') || i === models.length - 1) throw e;
        }
      }
      return { provider, mime: PCM_MIME };
    } catch (e) {
      if (isAbort(e) || (signal && signal.aborted)) throw abortError();
      lastError = e;
      if (started) throw e;
    }
  }
  throw lastError || new Error('语音合成失败');
}

/** Speech models of a keyed service: { models, live }. ElevenLabs reads the account's list when a key is saved. */
async function models(provider) {
  if (!MODELS[provider]) throw new Error('未知的语音服务');
  const builtIn = () => MODELS[provider].map((m, i) => (i === 0 ? { ...m, recommended: true } : { ...m }));
  if (provider === 'elevenlabs') {
    let live = null;
    try { live = await elevenModels(); } catch { /* offline or a bad key: the built-in list still lets her choose */ }
    if (live) return { models: live, live: true };
  }
  return { models: builtIn(), live: false };
}

/** Voices of one service: [{ id, name, preview? }]. Rejects with a Chinese message (no key, bad key, offline). */
async function voices(provider) {
  if (provider === 'edge') return EDGE_VOICES.map((v) => ({ ...v }));
  if (provider === 'elevenlabs') return elevenVoices();
  if (provider === 'minimax') return minimaxVoices();
  throw new Error('未知的语音服务');
}

/** Synthesise a short line to see whether the service, key and voice work. `onChunk` receives the audio to play it. */
async function test({ provider, voiceId, model, text } = {}, { onChunk } = {}) {
  try {
    const models = MODELS[provider] ? { [provider]: model || '' } : {};
    await synth(String(text || '你好呀。'), { provider, voiceId, fallback: false, models }, { onChunk, strictModel: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

module.exports = { synth, live, voices, models, test, saveKey, clearKey, hints, getKey, _internals: { speakable, chain, xmlEscape, EDGE_VOICES, MODELS, RUN, pickModel, elevenRequest, elevenModelList, minimaxBody, PCM_MIME } };
