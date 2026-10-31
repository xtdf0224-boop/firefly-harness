// 实时陪玩's ears (docs/PET.md §7): turn detection on the microphone (vad.cjs) and ElevenLabs Scribe v2 Realtime for
// the words. Only the user's speech is sent (from just before they start until they stop), committed by the local turn
// detection; a little silence keeps the socket open in between (the server drops it after 15 s without a message).
// What she says back is not done here: index.cjs reads the brain's sentences aloud (tts.live) and decides barge-in.
//
//   start(opts, hooks) → { ok } | { ok: false, error }     opts: { listen: 'auto'|'key', sensitivity, autoOffMin }
//     hooks: key() → ElevenLabs key | null; state(st, message?) with st 'connecting'|'live'|'closed'|'error';
//            speechStart(); partial(text); final(text); none()   (one of final / none ends every speechStart)
//   update(opts), listenOnce(), setBusy(on), pushMic(pcm16kBuffer), stop(message?), active()
'use strict';
const { Vad } = require('./vad.cjs');

const HOST = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
/** Names worth biasing the recogniser towards (≤ 20 characters each, up to 50). */
const KEYTERMS = ['流萤', '萨姆', '开拓者', '星穹铁道', '崩坏'];
const CHUNK_MS = 100;
const KEEPALIVE_MS = 10_000;
const CONNECT_TIMEOUT_MS = 8000;
/** After a commit, how long to wait for its transcript before treating the turn as empty. */
const COMMIT_WAIT_MS = 3500;
/** In the hotkey mode, how long she waits for the user to start talking. */
const KEY_WINDOW_MS = 8000;
/** The socket is renewed in a quiet moment after this long (no session cap is published; be safe). */
const ROLL_MS = 8 * 60_000;
const MAX_FAILS = 4;

let s = null;

const SILENCE_100MS = Buffer.alloc(16000 * 2 / 10).toString('base64');

function url(level) {
  const q = new URLSearchParams({ model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', commit_strategy: 'manual' });
  if (level === 0) {
    q.set('language_code', 'zh');
    q.set('filter_background_audio', 'true');
    for (const k of KEYTERMS) q.append('keyterms', k);
  }
  return `${HOST}?${q}`;
}

/** Errors the server sends before closing: which ones end the session, in words the user can act on. */
const FATAL = {
  auth_error: 'ElevenLabs 的密钥无效，实时陪玩听不了你说话。到 设置 › 桌宠 › 语音 里换一个。',
  quota_exceeded: 'ElevenLabs 的额度用完了，实时陪玩先停下。',
  unaccepted_terms: '要先在 ElevenLabs 后台接受「语音转文字」的使用条款，实时陪玩才能听你说话。',
};

function start(opts, hooks) {
  stop();
  const key = hooks.key();
  if (!key) return Promise.resolve({ ok: false, error: '实时陪玩用 ElevenLabs 听你说话：先在 设置 › 桌宠 › 语音 里保存 ElevenLabs 的密钥。' });
  const self = {
    opts: { listen: opts.listen === 'key' ? 'key' : 'auto', sensitivity: opts.sensitivity, autoOffMin: opts.autoOffMin },
    hooks,
    ws: null,
    live: false,
    level: 0, // 0 = full options, 1 = plain (after the server refused the options)
    fails: 0,
    since: Date.now(),
    lastSent: 0,
    lastHeard: Date.now(),
    turn: null, // { chunks: Buffer[], committed: boolean, timer }
    armedUntil: 0,
    timers: [],
    closing: false,
    vad: null,
  };
  s = self;
  self.vad = new Vad({
    sensitivity: self.opts.sensitivity,
    onStart: () => turnStart(self),
    onAudio: (frame) => turnAudio(self, frame),
    onEnd: () => turnEnd(self),
  });
  // The quiet keep-alive, the rolling renewal and the idle stop.
  self.timers.push(setInterval(() => tickle(self), 2000));
  return (async () => {
    let ok = await connect(self);
    // Refused or dropped before the session began (not for a reason that ends it): once more with the bare minimum.
    if (!ok && s === self && !self.fatal && self.level === 0) { self.level = 1; self.retryNow = false; ok = await connect(self); }
    if (ok && s === self) { self.ready = true; self.fatal = false; return { ok: true }; }
    if (s !== self) return { ok: false, cancelled: true, error: '实时陪玩已取消' };
    const error = self.error || '连不上 ElevenLabs 的语音识别';
    stop();
    return { ok: false, error };
  })();
}

function connect(self) {
  return new Promise((resolve) => {
    if (s !== self) { resolve(false); return; }
    self.live = false;
    self.hooks.state('connecting');
    let ws;
    try {
      ws = new WebSocket(url(self.level), { headers: { 'xi-api-key': self.hooks.key() || '' } });
    } catch (e) {
      self.error = `连不上 ElevenLabs 的语音识别：${(e && e.message) || e}`;
      resolve(false);
      return;
    }
    self.ws = ws;
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; clearTimeout(timer); self.abortConnect = null; resolve(ok); } };
    // stop() during the start ends this attempt at once instead of after the time-out.
    self.abortConnect = () => done(false);
    const timer = setTimeout(() => { self.error = 'ElevenLabs 的语音识别没有响应'; self.fatal = true; try { ws.close(); } catch { /* gone */ } done(false); }, CONNECT_TIMEOUT_MS);
    ws.onmessage = (ev) => {
      if (s !== self || self.ws !== ws) return;
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      const type = m && m.message_type;
      if (type === 'session_started') {
        self.live = true;
        self.since = Date.now();
        self.lastSent = Date.now();
        self.hooks.state('live');
        done(true);
        return;
      }
      if (type === 'partial_transcript') { if (self.turn && typeof m.text === 'string' && m.text.trim()) self.hooks.partial(m.text.trim()); return; }
      if (type === 'committed_transcript') { committed(self, typeof m.text === 'string' ? m.text.trim() : ''); return; }
      if (typeof m.error === 'string' || /error|exceeded|limited|overflow|exhausted|terms|invalid/.test(String(type))) {
        if (FATAL[type]) { self.fatal = true; self.error = FATAL[type]; done(false); if (self.ready) stop(FATAL[type], true); return; }
        self.error = `ElevenLabs 语音识别：${String(m.error || type).slice(0, 120)}`;
        // A sentence waiting for its words will not get them: it ends now instead of after the wait.
        if (self.turn && self.turn.committed) endTurn(self, '');
      }
    };
    ws.onclose = (ev) => {
      if (s !== self || self.ws !== ws) return;
      if (!self.live && !self.error && ev && ev.code && ev.code !== 1000) self.error = `ElevenLabs 语音识别断开了（${ev.code}${ev.reason ? `：${String(ev.reason).slice(0, 80)}` : ''}）`;
      self.ws = null;
      self.live = false;
      done(false);
      // While starting, start() decides what happens next.
      if (self.closing || !self.ready) return;
      // An open turn loses its words: the brain hears nothing for it.
      if (self.turn) endTurn(self, '');
      reconnect(self);
    };
    ws.onerror = () => { /* onclose follows */ };
  });
}

function reconnect(self) {
  if (s !== self || self.closing) return;
  self.fails++;
  if (self.fails > MAX_FAILS) { stop(self.error || '和 ElevenLabs 语音识别的连接一直断开，实时陪玩先停下。', true); return; }
  const wait = self.retryNow ? 0 : Math.min(8000, 600 * 2 ** (self.fails - 1));
  self.retryNow = false;
  self.timers.push(setTimeout(() => { if (s === self && !self.closing) void connect(self); }, wait));
}

function send(self, obj) {
  if (!self.ws || !self.live) return false;
  try { self.ws.send(JSON.stringify(obj)); self.lastSent = Date.now(); return true; } catch { return false; }
}

/* ───────────── turns ───────────── */

function turnStart(self) {
  const prev = self.turn;
  // A commit of the turn this one replaces may still be waiting for its words; they will arrive first.
  const owed = prev && prev.committed ? (prev.owed || 0) + 1 : 0;
  if (prev) clearTimeout(prev.timer);
  self.turn = { chunks: [], bytes: 0, committed: false, timer: null, early: prev && prev.committed ? prev.early || '' : '', owed };
  self.lastHeard = Date.now();
  self.hooks.speechStart();
}

function turnAudio(self, frame) {
  const t = self.turn;
  if (!t || t.committed) return;
  t.chunks.push(frame);
  t.bytes += frame.length;
  if (t.bytes >= 16000 * 2 * CHUNK_MS / 1000) flushAudio(self);
}

function flushAudio(self) {
  const t = self.turn;
  if (!t || !t.chunks.length) return;
  const audio = Buffer.concat(t.chunks).toString('base64');
  t.chunks = [];
  t.bytes = 0;
  send(self, { message_type: 'input_audio_chunk', audio_base_64: audio, commit: false, sample_rate: 16000 });
}

function turnEnd(self) {
  const t = self.turn;
  if (!t || t.committed) return;
  flushAudio(self);
  t.committed = true;
  self.lastHeard = Date.now();
  if (self.opts.listen === 'key') self.armedUntil = 0;
  if (!send(self, { message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16000 })) { endTurn(self, ''); return; }
  t.timer = setTimeout(() => { if (self.turn === t) endTurn(self, ''); }, COMMIT_WAIT_MS);
}

/** Two pieces of a transcript: a space only between two Latin letters or digits. */
const join = (a, b) => (a && b && /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? `${a} ${b}` : `${a || ''}${b || ''}`);

function committed(self, text) {
  const t = self.turn;
  if (!t) return;
  self.fails = 0; // the connection works: a later drop starts the retries afresh
  // Transcripts come back in commit order. The first `owed` ones belong to turns this one replaced: they are the
  // beginning of what the brain hears, not this turn's own words.
  if (t.owed > 0) { t.owed--; if (text) t.early = join(t.early, text); return; }
  if (t.committed) { endTurn(self, text); return; }
  // A commit the server made by itself in the middle of a long turn: keep it and wait for the rest.
  if (text) t.early = join(t.early, text);
}

function endTurn(self, text) {
  const t = self.turn;
  if (!t) return;
  clearTimeout(t.timer);
  self.turn = null;
  const all = join(t.early, text).trim();
  if (all) self.hooks.final(all);
  else self.hooks.none();
}

/* ───────────── housekeeping ───────────── */

function tickle(self) {
  if (s !== self) return;
  const now = Date.now();
  if (self.opts.listen === 'key' && self.armedUntil && now > self.armedUntil && !self.vad.active) {
    // Asked to listen, but nobody spoke.
    self.armedUntil = 0;
    self.hooks.none();
  }
  if (self.opts.autoOffMin && now - self.lastHeard > self.opts.autoOffMin * 60_000 && !self.turn) {
    stop(`已经 ${self.opts.autoOffMin} 分钟没听到你说话，实时陪玩先结束了。`, false);
    return;
  }
  if (self.live && self.fails && now - self.since > 30_000) self.fails = 0;
  if (!self.live || self.turn) return;
  // Renew the socket in a quiet moment, before any session cap can cut a sentence.
  if (now - self.since > ROLL_MS) {
    const old = self.ws;
    self.ws = null;
    self.live = false;
    try { if (old) old.close(1000); } catch { /* gone */ }
    void connect(self);
    return;
  }
  if (now - self.lastSent > KEEPALIVE_MS) send(self, { message_type: 'input_audio_chunk', audio_base_64: SILENCE_100MS, commit: false, sample_rate: 16000 });
}

/* ───────────── the API ───────────── */

function update(opts) {
  if (!s || !opts) return;
  s.opts.listen = opts.listen === 'key' ? 'key' : 'auto';
  s.opts.sensitivity = opts.sensitivity;
  s.opts.autoOffMin = opts.autoOffMin;
  s.vad.setSensitivity(opts.sensitivity);
  if (s.opts.listen === 'auto') s.armedUntil = 0;
}

/** The hotkey mode: listen for one sentence now. */
function listenOnce() {
  if (!s || !s.live) return false;
  s.armedUntil = Date.now() + KEY_WINDOW_MS;
  s.lastHeard = Date.now();
  return true;
}

function setBusy(on) { if (s) s.vad.setBusy(on); }

/** 16 kHz mono 16-bit PCM from the pet window. */
function pushMic(buf) {
  const self = s;
  if (!self || !self.live || !Buffer.isBuffer(buf) || !buf.length) return;
  // The hotkey mode keeps the turn detection running (so it knows the room) but lets a turn start only after the key.
  self.vad.setGate(self.opts.listen !== 'key' || !!self.armedUntil);
  self.vad.push(buf);
}

/** End the session. `message`: why, for the user; `failed`: it ended on an error. */
function stop(message, failed = false) {
  const self = s;
  if (!self) return;
  s = null;
  self.closing = true;
  if (self.abortConnect) self.abortConnect();
  self.timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
  if (self.turn) { clearTimeout(self.turn.timer); self.turn = null; self.hooks.none(); }
  try { if (self.ws) self.ws.close(1000); } catch { /* gone */ }
  self.ws = null;
  // A start that failed reports through its own result, not as a session that ended.
  if (self.ready) self.hooks.state(failed ? 'error' : 'closed', message);
}

const active = () => !!s;

module.exports = { start, update, listenOnce, setBusy, pushMic, stop, active, _internals: { url, KEYTERMS } };
