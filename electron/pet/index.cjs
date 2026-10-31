// The 桌宠 in the main process: owns the pet window, the hotkeys, the sense helper, the capture page, the
// voice and 实时陪玩, and is the only door between them and the app page (docs/PET.md §3). The page
// (src/pet/brain.ts) decides what she says; this decides what she may see, and passes things along.
//
//   app page ──pet:config / pet:say / pet:frame / pet:ocr / pet:tts:* / pet:rt──▶ here ──▶ pet window, capture page
//   app page ◀──pet:event───────────────────────────────────────────────────── here ◀── sense, capture, pet window
const { app, ipcMain, Menu, Notification } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const petWindow = require('./window.cjs');
const hotkeys = require('./hotkeys.cjs');
const sense = require('./sense.cjs');
const policy = require('./policy.cjs');
const capture = require('./capture.cjs');
const tts = require('./tts.cjs');
const realtime = require('./realtime.cjs');

/** The foreground program must hold still this long before it counts as a change. */
const FOCUS_DEBOUNCE_MS = 1500;
/** Switched on, she waits for the sense helper to say what is in front (an anti-cheat game?) before showing; this long at most. */
const FIRST_REPORT_MS = 6000;
/** Reading the screen's text costs a little CPU: not more often than this, and only when the picture is calm. */
const OCR_GAP_MS = 30_000;
/** 实时陪玩: what she said in the last this-many ms is what her own voice coming back through the speakers would say. */
const ECHO_MS = 20_000;
/** …but only while she is speaking and this long after (the room's echo and the recogniser's lag). */
const ECHO_TAIL_MS = 3000;
/** After her voice stops, the turn detection stays strict this long (the last words still ring in the room). */
const BUSY_TAIL_MS = 800;
/** A live reply whose sentences are all handed out but whose sound never started is let go after this long. */
const LIVE_IDLE_MS = 6000;
/** One block of microphone samples is a few KiB; anything past this is not one. */
const MAX_MIC_BYTES = 64 * 1024;
/** The chat panel's log keeps this many messages (both ways). */
const CHAT_MAX = 60;
/** A reply still being written that has not grown for this long never will (every reply ends well before: the slowest,
 *  a web search, gives up after 100 s); it stops looking like she is typing. */
const CHAT_STALE_MS = 120_000;
/** Where sense.cjs puts the pictures it hands to OCR. */
const TEMP_DIR = path.join(os.tmpdir(), 'firefly-pet');
const MOODS = new Set(['idle', 'talk', 'think', 'watch', 'happy', 'sleep']);
const PROVIDERS = new Set(['elevenlabs', 'minimax', 'edge']);
/** What the brain is told when the sense helper is gone: no program known, nothing to look at (policy 'never'). */
const UNKNOWN_APP = Object.freeze({ exe: '', title: '', pid: 0, hwnd: '0', fullscreen: 'no', isGame: false, policy: 'never' });

const DEFAULT_CFG = {
  enabled: false, mode: 'firefly', scale: 1, watch: true, neverWatch: [], gameAllow: [], gameDeny: [],
  hotkeyAsk: 'Ctrl+Alt+F', hotkeyPause: 'Ctrl+Alt+P',
  voice: { enabled: true, provider: 'elevenlabs', voiceId: '', volume: 80, fallback: true, models: { elevenlabs: '', minimax: '' } },
};

let host = null;
let cfg = DEFAULT_CFG;
let registered = false;
/** The last thing sense reported (to classify again when the lists change). */
let lastRaw = null;
/** The program in front, as the brain knows it. */
let focus = null;
let pendingRaw = null;
let focusTimer = null;
let paused = false;
let speakAbort = null;
let speakingId = '';
let ocrAt = 0;
let ocrBusy = false;
let seenText = [];
/** Bumped whenever looking stops, so a read that began before the stop is known to be out of date. */
let lookEpoch = 0;
/** Lines the pet window began reading aloud and has not finished: the brain waits for each one's end. */
const reading = new Set();
/** An anti-cheat game is in front: her window is hidden (never merely lowered) until it is not. */
let overlayHidden = false;
/** The brain has been told that no program is known (so it is told once, not at every missed heartbeat). */
let lostSent = false;
/** The sense helper has reported the program in front since she was switched on (or was waited for long enough). */
let senseHeard = false;
let firstReportTimer = null;
let watchSeq = 0;
let rtOn = false;
/** 实时陪玩's options (the brain sends them with op 'start'). */
let rtOpts = { listen: 'auto', sensitivity: 50, fastVoice: true, autoOffMin: 20 };
/** She is hearing the user (speech detected, or the hotkey asked her to listen). */
let listening = false;
/** Her spoken reply being read aloud: { id, queue, busy, ac, said, seq, part }. */
let liveUtt = null;
/** The user started talking while she was: cut her off once their words are clear. */
let barge = false;
/** What she said recently ({ text, at }), to tell her own voice coming back through the speakers from the user's. */
let recentSpeech = [];
/** When her voice last stopped (for the echo window and the busy tail). */
let lastVoiceEnd = 0;
let busyTimer = null;
let wasBusy = false;
/** Live replies cut off by the user: late sentences for them are not read. */
const cutIds = new Set();
let hotkeyNote = '';
let unsubs = [];
/** The chat panel's messages (PetChatEntry), oldest first; see "the chat log" below. */
let chatLog = [];
let chatSeq = 0;
let chatStaleTimer = null;

/* ───────────── small helpers ───────────── */

/** The app page: main.cjs says which window and frame that is (identity, not a URL compared as text). */
function fromApp(e) {
  return !!host && typeof host.isAppSender === 'function' && host.isAppSender(e) === true;
}
function fromPet(e) {
  const w = petWindow.get();
  if (!w || !e || e.sender !== w.webContents) return false;
  // Not just her window: her page, in its top frame (nothing it might embed gets to speak for her).
  // She only ever loads her own page: window.cjs blocks every navigation away from it.
  const f = e.senderFrame;
  return !!f && f === e.sender.mainFrame;
}
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e)) throw new Error('拒绝：调用不是来自萤火页面');
    return fn(e, ...args);
  });
}
function listen(channel, check, fn) {
  ipcMain.on(channel, (e, ...args) => {
    if (!check(e)) return;
    // A malformed message from a page must not become an uncaught exception in the main process.
    try { fn(e, ...args); } catch { /* dropped */ }
  });
}

/** An event for the app page. */
function emit(ev) {
  const w = host && host.getMainWindow();
  if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('pet:event', ev);
}
/** A command for the app page (the pet menu and the hotkeys can ask for page-level things). */
function toPage(cmd, show = false) {
  if (host) host.sendCommandToPage(cmd, show);
}

const isOwn = (f) => !!f && f.pid === process.pid;
const strings = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 200) : []);
const clamp = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);

/** A speech model id as the services write them (eleven_v3, speech-2.8-hd); anything else = the recommended one. */
const modelId = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v.trim()) ? v.trim() : '');

/** Whatever the page sends is checked field by field: the desktop side never trusts its shape. */
function sanitizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const v = r.voice && typeof r.voice === 'object' ? r.voice : {};
  const vm = v.models && typeof v.models === 'object' ? v.models : {};
  return {
    enabled: r.enabled === true,
    mode: r.mode === 'sam' ? 'sam' : 'firefly',
    scale: clamp(r.scale, 0.6, 1.6, 1),
    watch: r.watch !== false,
    neverWatch: strings(r.neverWatch),
    gameAllow: strings(r.gameAllow),
    gameDeny: strings(r.gameDeny),
    hotkeyAsk: typeof r.hotkeyAsk === 'string' ? r.hotkeyAsk.trim().slice(0, 40) : DEFAULT_CFG.hotkeyAsk,
    hotkeyPause: typeof r.hotkeyPause === 'string' ? r.hotkeyPause.trim().slice(0, 40) : DEFAULT_CFG.hotkeyPause,
    voice: {
      enabled: v.enabled !== false,
      provider: PROVIDERS.has(v.provider) ? v.provider : 'edge',
      voiceId: typeof v.voiceId === 'string' ? v.voiceId.trim().slice(0, 200) : '',
      volume: clamp(v.volume, 0, 100, 80),
      fallback: v.fallback !== false,
      models: { elevenlabs: modelId(vm.elevenlabs), minimax: modelId(vm.minimax) },
    },
  };
}

function sanitizeLine(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.text !== 'string') return null;
  const line = { id: raw.id.slice(0, 80), text: raw.text.slice(0, 2000) };
  if (MOODS.has(raw.mood)) line.mood = raw.mood;
  if (raw.speak === true) line.speak = true;
  if (raw.streaming === true) line.streaming = true;
  if (typeof raw.more === 'string' && raw.more) line.more = raw.more.slice(0, 6000);
  return line;
}

/* ───────────── what the pet window shows ───────────── */

/** Is she looking at the game right now? Pixels only flow while all of this holds. */
function canSee() {
  const st = capture.status();
  return cfg.enabled && cfg.watch && !paused && !!focus && focus.policy === 'watch' && focus.isGame && st.live && st.hwnd === focus.hwnd;
}

function uiState() {
  return { mode: cfg.mode, scale: cfg.scale, watching: canSee(), paused: paused && cfg.watch, realtime: rtOn, listening: rtOn && listening, voice: cfg.voice.enabled };
}
const sendState = () => petWindow.sendState(uiState());

/* ───────────── the program in front, and whether to look ───────────── */

/** Is this a game with an anti-cheat? policy.cjs decides (its list, and what it finds next to the game). */
function isAntiCheat(raw) {
  try { return !!policy.isAntiCheat(raw); } catch { return false; }
}

/**
 * Her window is a transparent always-on-top overlay, which an anti-cheat may take for a cheat's: while such a
 * game is in front she is hidden altogether (not just lowered) and says nothing; she comes back when it is not.
 */
function syncOverlay(hide) {
  if (overlayHidden === hide) return;
  overlayHidden = hide;
  // Over an anti-cheat game she says nothing: a live reply stops before her window goes, and so does 实时陪玩 (her
  // microphone and the recogniser would go on unseen).
  if (hide && liveUtt) { cutIds.add(liveUtt.id); stopLive(true); }
  if (hide && realtime.active()) { realtime.stop('反作弊游戏在前台，实时陪玩先结束了；换到别的程序后可以再开始。'); setRt(false); }
  if (hide) { petWindow.hide(); chatSettle(); }
  else if (cfg.enabled) petWindow.show();
}

/** Show her, once it is known what is in front (it might be an anti-cheat game); if the sense helper says nothing for a
 *  while she comes anyway, and the user is told why she cannot keep out of the way of such games. */
function showSoon() {
  if (overlayHidden) return;
  if (senseHeard) { petWindow.show(); return; }
  if (firstReportTimer) return;
  firstReportTimer = setTimeout(() => {
    firstReportTimer = null;
    if (!cfg.enabled || senseHeard) return;
    senseHeard = true;
    if (!overlayHidden) petWindow.show();
    senseTrouble();
  }, FIRST_REPORT_MS);
}

/** The sense helper did not report in time. Only slow (still starting, a virus scan)? Then she hides as soon as it says
 *  an anti-cheat game is in front. Not running at all: say so once. */
function senseTrouble() {
  const why = String(sense.lastError() || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if ((sense.running() && !why) || !Notification.isSupported()) return;
  new Notification({ title: '桌宠读不到前台程序', body: `所以她分不出前台是不是带反作弊的游戏，也看不了游戏画面。${why ? `原因：${why}` : ''}`.slice(0, 240) }).show();
}

function applyFocus(raw) {
  lastRaw = raw;
  lostSent = false;
  syncOverlay(isAntiCheat(raw));
  const next = policy.classify(raw, { neverWatch: cfg.neverWatch, gameAllow: cfg.gameAllow, gameDeny: cfg.gameDeny });
  const same = focus && focus.exe === next.exe && focus.hwnd === next.hwnd && focus.title === next.title
    && focus.fullscreen === next.fullscreen && focus.policy === next.policy && focus.isGame === next.isGame && focus.game === next.game
    && focus.antiCheat === next.antiCheat;
  focus = next;
  if (!same) emit({ type: 'focus', app: next });
  void updateWatch();
}

function onFocus(raw) {
  // The pet's own window (the chat panel) holds the keyboard for a while: the game stays "the program in front".
  if (raw.hwnd === petWindow.hwnd()) return;
  // The first report since she was switched on: she may appear now, unless it is an anti-cheat game.
  const first = !senseHeard;
  if (first) { senseHeard = true; clearTimeout(firstReportTimer); firstReportTimer = null; }
  // At once: her window goes when an anti-cheat game takes the front, and looking stops when the game is no longer in front.
  // Coming back and looking again wait for the focus to settle.
  if (isAntiCheat(raw)) syncOverlay(true);
  else if (first && cfg.enabled && !overlayHidden) petWindow.show();
  const st = capture.status();
  if (st.active && st.hwnd !== raw.hwnd) { stopLooking(); sendState(); }
  // Settling is about the window, not its title: a title that keeps changing (a clock, a song's name) must not put the
  // change off for ever, so only another window starts the wait again (the newest report is the one applied).
  const settling = !!focusTimer && !!pendingRaw && pendingRaw.hwnd === raw.hwnd && pendingRaw.exe === raw.exe && pendingRaw.fullscreen === raw.fullscreen;
  pendingRaw = raw;
  if (settling) return;
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => { focusTimer = null; if (pendingRaw) applyFocus(pendingRaw); }, FOCUS_DEBOUNCE_MS);
}

/**
 * The sense helper is gone or has gone quiet, so what was last known about the program in front is stale: forget it,
 * stop looking, and tell the brain that no program is known. (A hidden overlay stays hidden: it may still be a game.)
 */
function onLost() {
  clearTimeout(focusTimer);
  focusTimer = null;
  pendingRaw = null;
  lastRaw = null;
  focus = null;
  if (!lostSent) { lostSent = true; emit({ type: 'focus', app: { ...UNKNOWN_APP } }); }
  void updateWatch();
}

function wantWatch() {
  // Another window is settling in front: the program last applied is not the one to look at any more.
  if (pendingRaw && focus && pendingRaw.hwnd !== focus.hwnd) return false;
  return cfg.enabled && cfg.watch && !paused && !!focus && focus.policy === 'watch' && focus.isGame && /^\d+$/.test(focus.hwnd) && focus.hwnd !== '0';
}

/** The text read so far belongs to a screen she is no longer allowed to see. */
function forgetText() {
  seenText = [];
  lookEpoch++;
}

function stopLooking() {
  forgetText();
  capture.stop();
}

async function updateWatch() {
  const seq = ++watchSeq;
  if (!wantWatch()) {
    forgetText();
    if (capture.status().active) capture.stop();
    sendState();
    return;
  }
  const hwnd = focus.hwnd;
  const st = capture.status();
  if (st.active && st.hwnd === hwnd) { sendState(); return; }
  await capture.start(hwnd);
  // The foreground may have changed while the page was starting; the newest call decides.
  if (seq !== watchSeq) return;
  if (!(wantWatch() && focus.hwnd === hwnd)) stopLooking();
  sendState();
}

function setPaused(v) {
  if (paused === v) return;
  paused = v;
  emit({ type: 'pause', paused });
  void updateWatch();
  sendState();
}

/* ───────────── reading the screen's text ───────────── */

async function readText() {
  if (!canSee()) return [];
  const hwnd = focus.hwnd;
  const epoch = lookEpoch;
  // Still the same game, and looking has not stopped in between?
  const same = () => canSee() && focus.hwnd === hwnd && epoch === lookEpoch;
  const png = await capture.png({ maxSide: 1600 });
  if (!png || !same()) return [];
  const lines = await sense.ocrPng(png);
  // Paused, switched off or in another program by now: nothing that was read is passed on.
  return same() ? lines : [];
}

/** After a calm moment: read the text and tell the brain about lines it has not seen. */
function scheduleOcr() {
  const now = Date.now();
  if (ocrBusy || now - ocrAt < OCR_GAP_MS || !canSee()) return;
  ocrAt = now;
  ocrBusy = true;
  readText().then((lines) => {
    const fresh = lines.filter((l) => !seenText.includes(l));
    seenText = [...seenText, ...fresh].slice(-300);
    if (fresh.length) emit({ type: 'text', lines: fresh.slice(0, 20), at: Date.now() });
  }).catch(() => {}).finally(() => { ocrBusy = false; });
}

/* ───────────── what she says ───────────── */

async function speak(line) {
  if (speakAbort) speakAbort.abort();
  const ac = new AbortController();
  speakAbort = ac;
  speakingId = line.id;
  let seq = 0;
  const volume = cfg.voice.volume;
  try {
    await tts.synth(line.text, cfg.voice, {
      signal: ac.signal,
      onChunk: (buf, mime) => petWindow.sendAudio({ lineId: line.id, seq: seq++, chunk: new Uint8Array(buf), mime, volume }),
    });
    petWindow.sendAudio({ lineId: line.id, end: true });
  } catch (e) {
    if (!ac.signal.aborted) petWindow.sendAudio({ lineId: line.id, end: true, failed: String((e && e.message) || e).slice(0, 120) });
  } finally {
    if (speakAbort === ac) { speakAbort = null; speakingId = ''; }
  }
}

/**
 * Whatever was being read cannot finish: the pet page reloaded or crashed, her window was hidden, or she is shutting
 * down. The brain holds back proactive talk until a line it heard start has ended, so tell it each one has.
 */
function endSpoken() {
  if (speakAbort) { speakAbort.abort(); speakAbort = null; }
  // A live reply being read stops with it (and is not picked up again by its late sentences).
  if (liveUtt) { cutIds.add(liveUtt.id); stopLive(petWindow.isVisible()); }
  const ids = new Set(reading);
  if (speakingId) ids.add(speakingId);
  speakingId = '';
  reading.clear();
  updateBusy();
  for (const lineId of ids) emit({ type: 'spoken', lineId, state: 'end' });
}

function say(raw) {
  const line = sanitizeLine(raw);
  // Nothing is shown or read while she is hidden for an anti-cheat game.
  if (!line || !cfg.enabled || overlayHidden) return { ok: false };
  // A different line replaces whatever is being read.
  if (speakAbort && speakingId !== line.id) { speakAbort.abort(); speakAbort = null; speakingId = ''; }
  petWindow.sendLine(line);
  chatHers(line);
  if (line.speak && !line.streaming && cfg.voice.enabled) {
    // Read the ordinary way: a live reply still playing gives way.
    if (liveUtt) stopLive(true);
    noteSpeech(line.text);
    void speak(line);
  }
  return { ok: true };
}

async function testVoice(v) {
  const x = v && typeof v === 'object' ? v : {};
  if (!PROVIDERS.has(x.provider)) return { ok: false, error: '未知的语音服务' };
  petWindow.create();
  let waited;
  await Promise.race([petWindow.whenReady(), new Promise((r) => { waited = setTimeout(r, 6000); })]);
  clearTimeout(waited);
  const id = `test-${Date.now()}`;
  let seq = 0;
  const volume = cfg.voice.volume;
  try {
    const r = await tts.test(
      { provider: x.provider, voiceId: String(x.voiceId || '').slice(0, 200), model: modelId(x.model), text: String(x.text || '').slice(0, 200) },
      { onChunk: (buf, mime) => petWindow.sendAudio({ lineId: id, seq: seq++, chunk: new Uint8Array(buf), mime, volume }) },
    );
    petWindow.sendAudio({ lineId: id, end: true });
    return r;
  } finally {
    // With the pet switched off, her window was built just for this: it goes back to sleep.
    petWindow.park();
  }
}

/* ───────────── the chat log ───────────── */
// Everything said both ways lately, for the chat panel. It lives here rather than in her page, so it outlives the panel,
// a reloaded page and a recreated window, for as long as the app runs (it is never written to disk).

function chatPut(entry) {
  const i = chatLog.findIndex((e) => e.id === entry.id);
  if (i >= 0) chatLog[i] = entry;
  else {
    chatLog.push(entry);
    if (chatLog.length > CHAT_MAX) chatLog = chatLog.slice(-CHAT_MAX);
  }
  petWindow.sendChat({ op: 'put', entry });
  if (entry.streaming) {
    clearTimeout(chatStaleTimer);
    chatStaleTimer = setTimeout(() => chatSettle(), CHAT_STALE_MS);
  }
}

/**
 * Her replies still being written (all, or only `onlyId`), except `keepId`, will not grow any more: a newer line took
 * over, the brain dropped the reply (the user cut in), or she was hidden or switched off before it ended. One that never
 * got past "let me think" goes; one with words in it stays as far as it got. A reply that does go on after all simply
 * comes back under its id.
 */
function chatSettle(keepId, onlyId) {
  for (const e of chatLog.slice()) {
    if (e.who !== 'her' || !e.streaming || e.id === keepId || (onlyId && e.id !== onlyId)) continue;
    if (e.mood === 'think') {
      chatLog = chatLog.filter((x) => x !== e);
      petWindow.sendChat({ op: 'drop', id: e.id });
    } else chatPut({ ...e, streaming: false });
  }
  if (!chatLog.some((e) => e.streaming)) clearTimeout(chatStaleTimer);
}

/** The user's words: typed in the panel, or heard (实时陪玩). */
function chatMine(text, voice) {
  const entry = { id: `me_${Date.now().toString(36)}_${++chatSeq}`, who: 'me', text, at: Date.now() };
  if (voice) entry.voice = true;
  chatPut(entry);
}

/** One of her lines as it reaches the window: a new message, or the one with the same id growing. */
function chatHers(line) {
  if (!line.text) return;
  // Any other line while an older reply is still being written (a newer question, her own line, a reaction): that one
  // is not being written any more.
  chatSettle(line.id);
  const prev = chatLog.find((e) => e.id === line.id);
  const entry = { id: line.id, who: 'her', text: line.text, at: prev ? prev.at : Date.now() };
  if (line.more) entry.more = line.more;
  if (line.streaming) entry.streaming = true;
  if (line.mood) entry.mood = line.mood;
  chatPut(entry);
}

/* ───────────── hotkeys, menu ───────────── */

/** The program in front as sense last reported it (not her own window): it gets the keyboard back when the panel closes. */
function frontHwnd() {
  const f = pendingRaw || focus;
  return f && !isOwn(f) ? String(f.hwnd || '') : '';
}

/** Open the chat panel: the hotkey, the menu, a double-click on her, the chat button beside her. */
function openChat() {
  // Not over an anti-cheat game: the panel would bring her window back (nor before it is known what is in front).
  if (!cfg.enabled || overlayHidden || !senseHeard) return;
  petWindow.show();
  if (!petWindow.chatState().focused) petWindow.setRestoreTarget(frontHwnd());
  petWindow.sendCommand({ type: 'chat' });
}

function onAskKey() {
  if (!cfg.enabled || overlayHidden) return;
  // 实时陪玩 by hotkey: the 呼出 key means "listen to me now" (and she stops talking).
  if (rtOn && rtOpts.listen === 'key') {
    if (realtime.listenOnce()) {
      quiet();
      setListening(true);
      // The brain stops the reply it is still writing.
      emit({ type: 'hear', state: 'start' });
    }
    return;
  }
  // Pressed again while typing in the panel: it closes, and the keyboard goes back to the game.
  const st = petWindow.chatState();
  if (st.open && st.focused) { petWindow.sendCommand({ type: 'close-chat' }); return; }
  openChat();
}

function applyHotkeys() {
  const r = hotkeys.apply({ ask: cfg.hotkeyAsk, pause: cfg.hotkeyPause }, { onAsk: onAskKey, onPause: () => setPaused(!paused) });
  // The settings page shows which one did not take, and the brain only names a key that works.
  emit({ type: 'hotkeys', ask: r.ask === true, pause: r.pause === true, errors: r.errors.slice(0, 2) });
  const note = r.errors.join('\n');
  // Say so once (a system notification: the page may be hidden), not at every settings change.
  if (note && note !== hotkeyNote && Notification.isSupported()) {
    new Notification({ title: '桌宠快捷键没有生效', body: note.slice(0, 240) }).show();
  }
  hotkeyNote = note;
}

function showMenu() {
  const w = petWindow.get();
  if (!w) return;
  const f = focus;
  const items = [];
  const chat = petWindow.chatState();
  items.push(chat.open
    ? { label: '收起聊天框', click: () => petWindow.sendCommand({ type: 'close-chat' }) }
    : { label: '和她聊天', click: () => openChat() });
  items.push({ type: 'separator' });
  if (f && f.exe && f.policy !== 'never' && !isOwn(f)) {
    if (f.isGame && f.policy === 'watch') items.push({ label: `不看「${f.game || f.exe}」，只聊天`, click: () => toPage({ type: 'pet-watch', exe: f.exe, allow: false }) });
    else if (!f.isGame) items.push({ label: `把「${f.exe}」当作游戏，让她看`, click: () => toPage({ type: 'pet-watch', exe: f.exe, allow: true }) });
  }
  if (cfg.watch) items.push({ label: paused ? '继续观看' : '暂停观看', click: () => setPaused(!paused) });
  items.push({ label: rtOn ? '结束实时陪玩' : '开始实时陪玩', click: () => toPage({ type: 'pet-realtime', on: !rtOn }) });
  items.push({ type: 'separator' });
  items.push({ label: '桌宠设置…', click: () => toPage({ type: 'pet-settings' }, true) });
  items.push({ label: '打开萤火', click: () => host && host.showMainWindow() });
  items.push({ label: '隐藏桌宠', click: () => toPage({ type: 'pet-toggle' }) });
  Menu.buildFromTemplate(items).popup({ window: w });
}

/* ───────────── 实时陪玩 ───────────── */
// realtime.cjs hears; the brain answers; here her answer is read aloud sentence by sentence (tts.live, raw PCM played as
// it arrives), and the user talking over her cuts her off once their words are clear (not her own voice coming back).

const herSpeaking = () => !!liveUtt || reading.size > 0;
function updateBusy() {
  const now = herSpeaking();
  clearTimeout(busyTimer);
  if (now) { wasBusy = true; realtime.setBusy(true); return; }
  if (wasBusy) { wasBusy = false; lastVoiceEnd = Date.now(); }
  // Her last words still ring in the room for a moment: stay strict a little longer.
  busyTimer = setTimeout(() => { if (!herSpeaking()) realtime.setBusy(false); }, BUSY_TAIL_MS);
  if (busyTimer.unref) busyTimer.unref();
}
function setListening(v) { if (listening === v) return; listening = v; sendState(); }

function setRt(on) {
  if (rtOn === on) return;
  rtOn = on;
  if (!on) { stopLive(true); barge = false; listening = false; }
  sendState();
}

/** Stop her live reply; `hushWindow` also drops what the window is playing. */
function stopLive(hushWindow) {
  // Cut off: its words in the log stop where they got to.
  if (liveUtt) { clearTimeout(liveUtt.idle); liveUtt.ac.abort(); chatSettle(undefined, liveUtt.id); liveUtt = null; }
  if (hushWindow) petWindow.sendCommand({ type: 'hush' });
  updateBusy();
}

/** She stops talking at once: the live reply (its late sentences are refused) and a line read the ordinary way. */
function quiet() {
  if (liveUtt) { cutIds.add(liveUtt.id); if (cutIds.size > 16) cutIds.delete(cutIds.values().next().value); }
  stopLive(true);
  if (speakAbort) { speakAbort.abort(); speakAbort = null; speakingId = ''; }
}

function noteSpeech(text) {
  const t = Date.now();
  recentSpeech = recentSpeech.filter((x) => t - x.at < ECHO_MS).concat({ text: String(text || ''), at: t }).slice(-12);
}

const norm = (t) => String(t || '').replace(/[\s\p{P}\p{S}]/gu, '');

/** Words from the microphone that are her own recent words coming back through the speakers. Only while she speaks
 *  and shortly after: later, the user repeating her words is the user. */
function isEcho(text) {
  const heard = norm(text);
  if (heard.length < 2) return false;
  const t = Date.now();
  if (!herSpeaking() && t - lastVoiceEnd > ECHO_TAIL_MS) return false;
  const said = norm(recentSpeech.filter((x) => t - x.at < ECHO_MS).map((x) => x.text).join(''));
  if (!said) return false;
  if (said.includes(heard)) return true;
  // Mostly the same pairs of characters as something she just said (the recogniser rarely hears her exactly).
  const pairs = (x) => { const out = new Set(); for (let k = 0; k + 1 < x.length; k++) out.add(x.slice(k, k + 2)); return out; };
  const a = pairs(heard);
  const b = pairs(said);
  let hit = 0;
  for (const p of a) if (b.has(p)) hit++;
  return a.size >= 3 && hit / a.size >= 0.75;
}

function liveSay(id, text) {
  if (!rtOn || !cfg.enabled || overlayHidden || cutIds.has(id)) return { ok: false };
  if (!cfg.voice.enabled) return { ok: true }; // the bubble shows it; nothing is read
  if (!liveUtt || liveUtt.id !== id) {
    stopLive(false);
    // A line being read the ordinary way stops: the live reply takes over. (The window drops the older live
    // reply's sound itself when the first sound of this one arrives.)
    if (speakAbort) { speakAbort.abort(); speakAbort = null; speakingId = ''; }
    liveUtt = { id, queue: [], busy: false, ac: new AbortController(), said: '', seq: 0, part: 0, idle: null };
  }
  // The user is in the middle of a sentence: once their words are clear, they may cut her off.
  if (listening) barge = true;
  noteSpeech(text);
  clearTimeout(liveUtt.idle);
  liveUtt.queue.push(text);
  updateBusy();
  void pump(liveUtt);
  return { ok: true };
}

async function pump(u) {
  if (u.busy) return;
  u.busy = true;
  try {
    while (liveUtt === u && u.queue.length) {
      const text = u.queue.shift();
      const volume = cfg.voice.volume;
      try {
        await tts.live(text, cfg.voice, {
          signal: u.ac.signal,
          fast: rtOpts.fastVoice,
          previous: u.said,
          onPcm: (buf) => { if (liveUtt === u) petWindow.sendAudio({ lineId: u.id, seq: u.seq++, chunk: new Uint8Array(buf), mime: tts._internals.PCM_MIME, volume, live: true }); },
          // Microsoft read-aloud gives MP3: the window decodes each sentence and plays it after the one before.
          onMp3: (buf) => {
            if (liveUtt !== u) return;
            const part = `${u.id}~${u.part++}`;
            petWindow.sendAudio({ lineId: part, group: u.id, seq: 0, chunk: new Uint8Array(buf), mime: 'audio/mpeg', volume });
            petWindow.sendAudio({ lineId: part, end: true });
          },
        });
        u.said = `${u.said}${text}`.slice(-400);
      } catch {
        if (u.ac.signal.aborted) return;
        // This sentence stays silent (the bubble still shows it); the next one tries again.
      }
    }
  } finally {
    u.busy = false;
    // Everything is handed to the window; its 'spoken end' says when she has finished (the reply keeps its state for
    // sentences still to come until then). If no sound ever started, it is let go after a while.
    if (liveUtt === u && !u.queue.length) {
      clearTimeout(u.idle);
      u.idle = setTimeout(() => { if (liveUtt === u && !u.busy && !u.queue.length && !reading.has(u.id)) { liveUtt = null; updateBusy(); } }, LIVE_IDLE_MS);
      if (u.idle.unref) u.idle.unref();
    }
  }
}

const hearHooks = {
  key: () => tts.getKey('elevenlabs'),
  state: (st, message) => {
    if (st === 'live') setRt(true);
    else if (st === 'closed' || st === 'error') setRt(false);
    emit(message ? { type: 'rt', state: st, message } : { type: 'rt', state: st });
  },
  speechStart: () => {
    // While she talks it may be her own voice or the game: wait for words before cutting her off.
    if (herSpeaking()) { barge = true; return; }
    setListening(true);
    emit({ type: 'hear', state: 'start' });
  },
  partial: (text) => {
    // A word or two is not enough to tell the user from her own echo: wait for a little more.
    if (!barge || norm(text).length < 3 || isEcho(text)) return;
    barge = false;
    quiet();
    setListening(true);
    emit({ type: 'hear', state: 'start' });
  },
  final: (text) => {
    const cutIn = barge;
    barge = false;
    setListening(false);
    // Her own words coming back are not a question.
    if (isEcho(text)) { emit({ type: 'hear', state: 'none' }); return; }
    if (cutIn || herSpeaking()) { quiet(); if (cutIn) emit({ type: 'hear', state: 'start' }); }
    const said = String(text).slice(0, 500);
    if (said.trim()) chatMine(said.trim(), true);
    emit({ type: 'hear', state: 'final', text: said });
  },
  none: () => {
    barge = false;
    setListening(false);
    emit({ type: 'hear', state: 'none' });
  },
};

async function realtimeCmd(cmd) {
  if (!cmd || typeof cmd !== 'object') return { ok: false, error: '命令无效' };
  if (cmd.op === 'stop') { realtime.stop(); setRt(false); return { ok: true }; }
  if (cmd.op === 'hush') { stopLive(true); return { ok: true }; }
  if (cmd.op === 'say') {
    const id = typeof cmd.id === 'string' ? cmd.id.slice(0, 80) : '';
    const text = typeof cmd.text === 'string' ? cmd.text.slice(0, 400) : '';
    if (!id || !text.trim()) return { ok: false, error: '命令无效' };
    return liveSay(id, text);
  }
  if (cmd.op !== 'start') return { ok: false, error: '命令无效' };
  if (!cfg.enabled) return { ok: false, error: '先打开桌宠' };
  rtOpts = {
    listen: cmd.listen === 'key' ? 'key' : 'auto',
    sensitivity: clamp(cmd.sensitivity, 0, 100, 50),
    fastVoice: cmd.fastVoice !== false,
    autoOffMin: clamp(cmd.autoOffMin, 5, 120, 20),
  };
  // Already on: the new options apply without reconnecting.
  if (realtime.active()) { realtime.update(rtOpts); if (rtOpts.listen === 'auto') setListening(false); return { ok: true }; }
  const r = await realtime.start(rtOpts, hearHooks);
  if (!r || !r.ok) {
    setRt(false);
    emit({ type: 'rt', state: 'closed' });
    return { ok: false, error: (r && r.error) || '实时陪玩没能启动' };
  }
  return { ok: true };
}

/* ───────────── settings ───────────── */

function shutdownPet() {
  clearTimeout(focusTimer);
  focusTimer = null;
  clearTimeout(firstReportTimer);
  firstReportTimer = null;
  senseHeard = false;
  pendingRaw = null;
  watchSeq++;
  stopLooking();
  sense.stop();
  hotkeys.clear();
  hotkeyNote = '';
  emit({ type: 'hotkeys', ask: false, pause: false, errors: [] });
  endSpoken();
  if (realtime.active()) realtime.stop();
  setRt(false);
  petWindow.hide();
  chatSettle();
  focus = null;
  lastRaw = null;
  overlayHidden = false;
  lostSent = false;
}

function configure(next) {
  const prev = cfg;
  cfg = next;
  if (!cfg.enabled) { if (prev.enabled) shutdownPet(); return; }
  petWindow.applyScale(cfg.scale);
  // Over an anti-cheat game she stays hidden (syncOverlay brings her back when it is no longer in front), and just
  // switched on she waits to hear what is in front.
  showSoon();
  // A page that has just loaded may not have its listeners up yet when the first state goes out: send it again once it has.
  void petWindow.whenReady().then(sendState);
  applyHotkeys();
  if (!sense.running()) {
    sense.start({
      onFocus,
      onIdle: (seconds) => emit({ type: 'idle', seconds }),
      onLost,
    });
  }
  sendState();
  // A change of the lists or of the watch switch changes what the program in front is allowed.
  const listsChanged = ['neverWatch', 'gameAllow', 'gameDeny'].some((k) => prev[k].join('\n') !== cfg[k].join('\n'));
  if (listsChanged && lastRaw) applyFocus(lastRaw);
  else void updateWatch();
}

/* ───────────── wiring ───────────── */

/** Before app.whenReady(): switches that must be set early. */
function beforeReady() {
  // A page nobody can see (the hidden capture page) must keep running; Chromium would otherwise treat it as occluded.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

/** host = { getMainWindow(), showMainWindow(), sendCommandToPage(cmd, show?), isAppSender(event) } */
function register(hostApi) {
  if (registered) return;
  registered = true;
  host = hostApi;
  capture.init();
  unsubs.push(capture.onScene((ev) => {
    emit({ type: 'scene', state: ev.state, since: ev.since, change: ev.change });
    if (ev.state === 'settled' || ev.state === 'static') scheduleOcr();
  }));
  unsubs.push(capture.onLive(() => sendState()));
  // The pet page reloaded or crashed, or her window was hidden: what it was playing is gone.
  unsubs.push(petWindow.onReset(() => endSpoken()));

  // From the app page.
  ipcMain.on('pet:config', (e, raw) => { if (fromApp(e)) configure(sanitizeConfig(raw)); });
  handle('pet:say', (_e, line) => say(line));
  handle('pet:frame', async (_e, opts) => (canSee() ? capture.frame({ maxSide: opts && opts.maxSide }) : null));
  handle('pet:ocr', async () => (canSee() ? { lines: (await readText()).slice(0, 40) } : null));
  handle('pet:tts:voices', async (_e, provider) => {
    try { return await tts.voices(String(provider)); } catch (err) { return { error: String((err && err.message) || err).slice(0, 200) }; }
  });
  handle('pet:tts:test', (_e, v) => testVoice(v));
  handle('pet:tts:models', async (_e, provider) => {
    try { return await tts.models(String(provider)); } catch (err) { return { error: String((err && err.message) || err).slice(0, 200) }; }
  });
  handle('pet:tts:key', (_e, provider, key) => tts.saveKey(String(provider), key));
  handle('pet:tts:clear', (_e, provider) => tts.clearKey(String(provider)));
  handle('pet:tts:keys', () => tts.hints());
  handle('pet:rt', (_e, cmd) => realtimeCmd(cmd));

  // From the pet window.
  // The chat panel. Sending does not close it; the message goes into the log, then to the brain.
  listen('pet-ui:ask', fromPet, (_e, m) => {
    const text = m && typeof m.text === 'string' ? m.text.trim().slice(0, 2000) : '';
    if (!text) return;
    chatMine(text, false);
    emit({ type: 'ask', text });
  });
  listen('pet-ui:chat-sync', fromPet, () => petWindow.sendChat({ op: 'reset', entries: chatLog.slice() }));
  listen('pet-ui:chat-open', fromPet, () => openChat());
  listen('pet-ui:chat-close', fromPet, () => petWindow.sendCommand({ type: 'close-chat' }));
  listen('pet-ui:chat-focus', fromPet, () => {
    const st = petWindow.chatState();
    if (!st.open || st.focused) return;
    petWindow.setRestoreTarget(frontHwnd());
    petWindow.focusChat();
  });
  listen('pet-ui:hit', fromPet, (_e, over) => petWindow.setInteractive(over === true));
  listen('pet-ui:drag', fromPet, (_e, m) => {
    if (m && ['start', 'move', 'end'].includes(m.phase)) petWindow.drag(m.phase, m.x, m.y);
  });
  listen('pet-ui:menu', fromPet, () => showMenu());
  listen('pet-ui:click', fromPet, () => emit({ type: 'click' }));
  listen('pet-ui:mic', fromPet, (_e, m) => {
    const pcm = m && m.pcm;
    // Only a block of samples (a typed array, small) goes on to the session.
    if (!rtOn || !ArrayBuffer.isView(pcm) || !pcm.byteLength || pcm.byteLength > MAX_MIC_BYTES) return;
    realtime.pushMic(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  });
  // 实时陪玩 cannot hear: the page could not open the microphone, or lost it. The session ends and says why (the text is
  // the desktop's own, never the page's).
  listen('pet-ui:mic-failed', fromPet, () => {
    if (!rtOn) return;
    realtime.stop('打不开麦克风：请在 Windows 设置的「隐私和安全性 › 麦克风」里允许桌面应用使用麦克风，或接上麦克风后再开始实时陪玩。', true);
    setRt(false);
  });
  listen('pet-ui:spoken', fromPet, (_e, m) => {
    if (!m || typeof m.lineId !== 'string' || (m.state !== 'start' && m.state !== 'end')) return;
    // Remember what is playing, so its end can be reported if the page cannot (endSpoken). A page could send any number of ids.
    const lineId = m.lineId.slice(0, 80);
    if (m.state === 'start') {
      if (reading.size >= 8) reading.delete(reading.values().next().value);
      reading.add(lineId);
    } else {
      reading.delete(lineId);
      if (liveUtt && liveUtt.id === lineId && !liveUtt.busy && !liveUtt.queue.length) { clearTimeout(liveUtt.idle); liveUtt = null; }
    }
    updateBusy();
    emit({ type: 'spoken', lineId, state: m.state });
  });
}

/** Pictures handed to OCR that the helper had not finished with when the app quit (sense.cjs names them ocr-<pid>-<id>.png). */
function removeTempFrames() {
  let names;
  try { names = fs.readdirSync(TEMP_DIR); } catch { return; }
  const mine = `ocr-${process.pid}-`;
  for (const name of names) {
    if (!name.startsWith(mine) || !name.endsWith('.png')) continue;
    try { fs.unlinkSync(path.join(TEMP_DIR, name)); } catch { /* still open: the next start sweeps it */ }
  }
}

/** App is quitting. */
function stopAll() {
  // Her window closing from here on is the app going away, not one to build again.
  petWindow.shutdown();
  clearTimeout(focusTimer);
  clearTimeout(firstReportTimer);
  try { stopLive(false); } catch { /* the page is going away too */ }
  try { endSpoken(); } catch { /* the page is going away too */ }
  try { realtime.stop(); } catch { /* not running */ }
  try { sense.stop(); } catch { /* not running */ }
  try { hotkeys.clear(); } catch { /* none */ }
  capture.dispose();
  forgetText();
  removeTempFrames();
  unsubs.forEach((fn) => fn());
  unsubs = [];
  const w = petWindow.get();
  if (w) w.destroy();
}

module.exports = { beforeReady, register, stopAll, _internals: { sanitizeConfig, sanitizeLine } };
