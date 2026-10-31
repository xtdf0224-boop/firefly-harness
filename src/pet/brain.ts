/* The 桌宠's brain (docs/PET.md §5). It lives in the app page, where the model access, the persona and
   the settings already are. It listens to what the desktop senses (the program in front, the picture,
   the user's questions), decides when to speak and what to say, asks a model, and sends the line back
   to the pet window. Trigger rules are in triggers.ts, prompts in prompts.ts, question routing in
   route.ts; this file is the plumbing between them and the bridge. `createBrain` takes its
   dependencies as arguments so scripts/pet-brain-check.ts can drive it with fakes. */
import { desktop, openStream, type ContentPart, type StartSpec, type StreamEvent } from '../lib/desktop';
import type { ModelState, PetSettings, TaskEngine, VisualMode } from '../lib/types';
import { actions } from '../state/actions';
import { petApiSpec, petCliSpec } from '../state/live';
import { petChatEngine, petVisionEngine, petWebEngine } from '../state/models';
import { store } from '../state/store';
import type { FocusApp, PetBridge, PetEvent, PetFrame, PetLine, PetMood, PetRuntimeConfig } from './contracts';
import {
  DESCRIBE_SYSTEM, askText, cliPrompt, cutAt, describeText, errorLine, flatten, isSkip, noModelLine, petSystem, proactiveText,
  remember, shapeAnswer, speechChunks, thinkLine, tidy, toMessages, trimLine, type AskCtx, type NoImage, type PetWho, type Turn,
} from './prompts';
import { routeQuestion } from './route';
import {
  LIMITS, imagesLeft, newMemory, nextTrigger, noteLine, noteUser, tickIgnored, trackScene, type SceneTrack, type Trigger, type TriggerCtx,
} from './triggers';

/** How often the brain looks at whether to say something of her own. */
const TICK_MS = 5000;
/** A reply that has not finished by then is given up on. */
const ASK_TIMEOUT_MS = 45_000;
const WEB_TIMEOUT_MS = 100_000;
const PROACTIVE_TIMEOUT_MS = 30_000;
const OCR_WAIT_MS = 4000;
/** 实时陪玩: a spoken reply that has not finished by then is given up on; the picture is not waited for longer than this. */
const LIVE_TIMEOUT_MS = 20_000;
const LIVE_FRAME_WAIT_MS = 700;
/** 实时陪玩: a sentence heard this soon after the last one, while the reply to it has not started speaking, is one question. */
const LIVE_JOIN_MS = 6000;
/** 实时陪玩: right after a spoken exchange she does not also start a line of her own. */
const LIVE_QUIET_MS = 20_000;
/** The bubble shows the first part of a reply while it is still being written. */
const STREAM_PUSH_MS = 150;
/** A line that has been "speaking" this long without an end message lost it (the pet page crashed, hid or reloaded). */
const SPEAKING_WATCHDOG_MS = 60_000;

export interface BrainDeps {
  bridge: PetBridge;
  read(): { pet: PetSettings; mode: VisualMode; callName: string; models: ModelState };
  stream(spec: StartSpec, on: (ev: StreamEvent) => void, onId?: (id: string) => void): Promise<string>;
  stop(id: string): void;
  /** Nobody is at a prompt for a reply to the pet: whatever a command-line model asks to do is refused. */
  deny(id: string, requestId: string): void;
  /** A scratch folder for the command-line model. */
  workspace(): Promise<string>;
  toast(t: { tone: 'info' | 'warning' | 'danger' | 'success'; title: string; body?: string }): void;
  now(): number;
  rand(): number;
}

export interface Brain {
  start(): () => void;
  /** One look at whether she has something to say on her own (the timer calls this). */
  tick(): Promise<void>;
  handle(ev: PetEvent): void;
  ask(text: string): Promise<void>;
  realtime(on: boolean): Promise<void>;
  /** For tests: what she remembers of the conversation. */
  history: Turn[];
}

const CLICK: Record<VisualMode, string[]> = {
  firefly: ['嗯？我在呢。', '怎么啦？', '在的在的。', '想让我做点什么吗？'],
  sam: ['在线。', '收到。', '待命。'],
};
const PAUSE: Record<VisualMode, { on: string; off: string }> = {
  firefly: { on: '好，先不看了。想让我看的时候，再按一下就好。', off: '那我继续看着啦。' },
  sam: { on: '观测暂停。', off: '观测恢复。' },
};

const image = (f: PetFrame): ContentPart => ({ type: 'image', mime: 'image/jpeg', data: f.data });
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/** A model call in flight. `abort` settles the call that is waiting on it (set by run). */
interface Active { cancelled: boolean; id?: string; abort?: () => void }

/** The way a CLI engine runs (the engine's own driver, else its vendor's). */
const driverOf = (e: TaskEngine, models: ModelState) => e.driver ?? models.providers[e.provider]?.driver;

/** The command-line model for a web question. Claude Code is preferred even over a chosen Codex: its tools are denied by name
    and every permission request is refused, while Codex keeps a shell and read access to the whole disk. */
function webEngineFor(models: ModelState, pref: PetSettings['web'], cwd: string | undefined): TaskEngine | undefined {
  const pick = petWebEngine(models, pref, cwd);
  if (pick && driverOf(pick, models) !== 'claude-code') {
    const auto = petWebEngine(models, undefined, cwd); // automatic choice: Claude Code before Codex
    if (auto && driverOf(auto, models) === 'claude-code') return auto;
  }
  return pick;
}

/* ───────────── which hotkeys the desktop could register ───────────── */

/** What the desktop said after it last registered the two global hotkeys (a `hotkeys` PetEvent). */
export interface HotkeyStatus { ask: boolean; pause: boolean; errors: string[] }

let hotkeyStatus: HotkeyStatus | undefined;
const hotkeyListeners = new Set<() => void>();

/** For the settings page (React's useSyncExternalStore): `get` is undefined until the desktop has said anything, and
 *  then nothing is assumed to have failed. The same object is returned until the next event. */
export const hotkeyStore = {
  get: (): HotkeyStatus | undefined => hotkeyStatus,
  subscribe(fn: () => void) {
    hotkeyListeners.add(fn);
    return () => { hotkeyListeners.delete(fn); };
  },
};
function publishHotkeys(s: HotkeyStatus | undefined) {
  hotkeyStatus = s;
  hotkeyListeners.forEach((fn) => fn());
}

export function createBrain(deps: BrainDeps): Brain {
  const { bridge } = deps;
  const mem = newMemory();
  const history: Turn[] = [];
  const imagesSent: number[] = [];
  let focus: FocusApp | undefined;
  let focusSince = 0;
  let scene: SceneTrack | undefined;
  let idle: { seconds: number; at: number } | undefined;
  let text: { lines: string[]; at: number } | undefined;
  let ocrLines: string[] = [];
  let paused = false;
  let speaking = false;
  let speakingSince = 0;
  let busy = 0;
  let active: Active | undefined;
  /** Her own line being written (a question cancels it). */
  let proactiveRun: Active | undefined;
  let ticking = false;
  let seq = 0;
  let rtLive = false;
  /** 实时陪玩: the spoken reply in flight, what it answers, and whether it has started talking. */
  let live: Active | undefined;
  let liveQ: { text: string; at: number; spoke: boolean; id: string; spoken: string[]; held: string[]; dropped: boolean } | undefined;
  /** 实时陪玩: the user is in the middle of a sentence (heard a start, no final yet): her reply waits. */
  let userTalking = false;
  let lastLiveAt = 0;
  let lastRt = '';
  let cwd: string | undefined;
  let lastCfg = '';
  let lastPet: PetSettings | undefined;
  let lastMode: VisualMode | undefined;
  let wasOn: boolean | undefined;
  let lastClickAt = 0;
  /** The id of the last line sent to the pet window. */
  let lastSentId = '';
  /** The desktop's last word on the hotkeys (undefined: nothing yet, so nothing is assumed to have failed). */
  let hotkeys: HotkeyStatus | undefined;

  const lineId = (p: string) => `${p}_${deps.now().toString(36)}_${++seq}`;
  const who = (): PetWho => { const r = deps.read(); return { mode: r.mode, callName: r.callName }; };

  /** Send a line to the pet window; resolves with whether it was shown (the desktop drops lines while her window is hidden). */
  async function sayShown(line: PetLine): Promise<boolean> {
    lastSentId = line.id;
    try { return (await bridge.say(line)).ok; } catch { return false; }
  }
  /** Send a line to the pet window. Lines that are still being written carry `streaming`. */
  function say(line: PetLine) {
    void sayShown(line);
  }
  function sayText(textLine: string, mood: PetMood, speak = false) {
    say({ id: lineId('l'), text: textLine, mood, speak });
  }

  /* ───────────── settings → desktop ───────────── */

  function config(): PetRuntimeConfig {
    const { pet, mode } = deps.read();
    return {
      enabled: pet.enabled, mode, scale: pet.scale, watch: pet.watch,
      neverWatch: pet.neverWatch, gameAllow: pet.gameAllow, gameDeny: pet.gameDeny,
      hotkeyAsk: pet.hotkeyAsk, hotkeyPause: pet.hotkeyPause, voice: pet.voice,
    };
  }
  function sync() {
    // The store changes many times a second while a task runs; only the pet's own settings matter here.
    const r = deps.read();
    if (r.pet === lastPet && r.mode === lastMode) return;
    lastPet = r.pet;
    lastMode = r.mode;
    // Looking switched off (or the pet itself): what was read off the screen goes with it.
    if (!r.pet.watch || !r.pet.enabled) forgetScreen();
    // Switched off just now: what she was in the middle of (an answer, a search, a line of her own) is dropped, not finished for nobody.
    if (wasOn && !r.pet.enabled) {
      stopWork();
      hotkeys = undefined;
      publishHotkeys(undefined);
    }
    // Switched on just now (not already on when the app started): a short hello that says how to ask.
    if (wasOn === false && r.pet.enabled) {
      const key = r.pet.hotkeyAsk;
      const mode = r.mode;
      // The pet window needs a moment to load before it can show a line; by then the desktop has said whether the hotkey took
      // (before it has said anything, nothing is assumed to have failed).
      setTimeout(() => {
        const keyed = hotkeys?.ask !== false;
        const hello = mode === 'sam'
          ? (keyed ? `桌面终端上线。${key} 呼出指令框。` : '桌面终端上线。双击终端呼出指令框。')
          : (keyed ? `我来啦。想问我什么的话，按 ${key} 就好。` : '我来啦。想问我什么的话，双击我，或者右键选「和她聊天」就好。');
        sayText(hello, 'happy');
      }, 1600);
    }
    wasOn = r.pet.enabled;
    // 实时陪玩 settings changed while it runs: the desktop takes the new ones without restarting.
    if (rtLive) {
      const opts = liveOptions(r.pet);
      const o = JSON.stringify(opts);
      if (o !== lastRt) { lastRt = o; void bridge.realtime(opts).catch(() => {}); }
    }
    const cfg = config();
    const sig = JSON.stringify(cfg);
    if (sig === lastCfg) return;
    lastCfg = sig;
    bridge.configure(cfg);
  }

  /* ───────────── what the desktop tells us ───────────── */

  /** Stop every reply she is working on (an answer, a search, her own line, a spoken reply): none of it is wanted any more. */
  function stopWork() {
    cancel(active);
    cancel(proactiveRun);
    if (liveQ) liveQ.dropped = true;
    cancel(live);
    liveQ = undefined;
    userTalking = false;
  }

  /** Text read off the screen is only kept while she may be looking: pausing, switching looking off or a program she must not watch drops it. */
  function forgetScreen() {
    text = undefined;
    ocrLines = [];
  }

  /** The program in front is a game she may look at right now (settings, pause and policy). */
  function mayWatch(pet: PetSettings) {
    return pet.enabled && pet.watch && !paused && !!focus?.isGame && focus.policy === 'watch';
  }

  function handle(ev: PetEvent) {
    const t = deps.now();
    switch (ev.type) {
      case 'focus': {
        const prev = focus;
        focus = ev.app;
        if (!prev || prev.exe !== ev.app.exe || prev.hwnd !== ev.app.hwnd) {
          focusSince = t;
          scene = undefined;
          forgetScreen();
        }
        // Also when the policy of the same program changed (the user marked it 不要看).
        if (ev.app.policy !== 'watch' || !ev.app.isGame) forgetScreen();
        break;
      }
      case 'idle': idle = { seconds: ev.seconds, at: t }; break;
      case 'scene': scene = trackScene(scene, { state: ev.state, since: ev.since }, t); break;
      case 'text':
        // A late recognition result for a program she may no longer look at is dropped.
        if (!mayWatch(deps.read().pet)) break;
        text = { lines: ev.lines, at: ev.at };
        ocrLines = [...ocrLines, ...ev.lines].slice(-30);
        break;
      case 'ask': void ask(ev.text); break;
      case 'click': {
        noteUser(mem, t);
        // A reaction would cut off a reply that is being thought, written or read aloud: then the click only counts as the user being there.
        if (busy > 0 || speaking) break;
        if (t - lastClickAt < 2500) break;
        lastClickAt = t;
        const list = CLICK[deps.read().mode];
        sayText(list[Math.floor(deps.rand() * list.length)], 'happy');
        break;
      }
      case 'pause': {
        paused = ev.paused;
        if (ev.paused) forgetScreen();
        const p = PAUSE[deps.read().mode];
        sayText(ev.paused ? p.on : p.off, ev.paused ? 'idle' : 'watch');
        break;
      }
      case 'hotkeys':
        hotkeys = { ask: ev.ask, pause: ev.pause, errors: [...ev.errors] };
        publishHotkeys(hotkeys);
        break;
      case 'spoken':
        speaking = ev.state === 'start';
        if (speaking) speakingSince = t;
        break;
      case 'rt':
        rtLive = ev.state === 'live' || ev.state === 'connecting';
        if (ev.state === 'error' || (ev.state === 'closed' && ev.message)) {
          deps.toast({ tone: ev.state === 'error' ? 'danger' : 'info', title: ev.state === 'error' ? '实时陪玩出错了' : '实时陪玩结束了', body: ev.message });
        }
        break;
      case 'hear':
        if (ev.state === 'start') {
          userTalking = true;
          noteUser(mem, t);
          // A line of her own being written gives way, and so does a reply that is already talking (the desktop has
          // cut her voice off); a reply that has not started talking waits for what the user is saying.
          cancel(proactiveRun);
          if (live && liveQ?.spoke) { liveQ.dropped = true; cancel(live); }
        } else if (ev.state === 'final') {
          userTalking = false;
          if (ev.text) void liveAsk(ev.text);
          else releaseHeld();
        } else if (ev.state === 'none') {
          // It was not speech after all (a cough, the game): what she held back is said now.
          userTalking = false;
          releaseHeld();
        }
        break;
    }
  }

  /* ───────────── running a model ───────────── */

  /** Start a stream and resolve with its last message: a command-line model may first say "let me look that up",
   *  search, then answer, and only the answer is hers to say. `onText` sees the current message so far. */
  function run(spec: StartSpec, a: Active, ms: number, onText?: (soFar: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      let acc = '';
      let fresh = false;
      let over = false;
      const finish = (fn: () => void) => { if (over) return; over = true; clearTimeout(timer); fn(); };
      const timer = setTimeout(() => {
        finish(() => { if (a.id) deps.stop(a.id); reject(new Error('等了太久，没有收到回复。')); });
      }, ms);
      // A cancelled call stops waiting at once (cancel() stops the stream itself).
      a.abort = () => finish(() => reject(new Error('已取消。')));
      deps.stream(spec, (ev) => {
        if (a.cancelled || over) return;
        if (ev.type === 'text') {
          if (fresh && ev.text.trim()) { acc = ''; fresh = false; }
          acc += ev.text;
          onText?.(acc);
        } else if (ev.type === 'text-break') fresh = true;
        else if (ev.type === 'permission') deps.deny(ev.id, ev.requestId);
        // `done` carries every message joined; the last one is the answer.
        else if (ev.type === 'done') finish(() => resolve(acc.trim() ? acc : ev.text));
        else if (ev.type === 'error') finish(() => reject(new Error(ev.message)));
      }, (id) => { a.id = id; if (a.cancelled) deps.stop(id); }).then((id) => { a.id = id; if (a.cancelled) deps.stop(id); }, (e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
    });
  }

  function cancel(a: Active | undefined) {
    if (!a) return;
    a.cancelled = true;
    if (a.id) deps.stop(a.id);
    a.abort?.();
  }

  async function scratch() {
    if (!cwd) cwd = await deps.workspace().catch(() => undefined);
    return cwd;
  }

  /** Why a picture cannot be had right now (undefined = she may look). */
  function noSight(pet: PetSettings): NoImage | undefined {
    if (!pet.watch) return 'off';
    if (paused) return 'paused';
    if (!focus || !focus.isGame || focus.policy === 'never') return 'none';
    if (focus.policy !== 'watch') return 'chat-only';
    // A black picture is only certain to be no picture in exclusive full screen; a loading screen or a dark scene looks the same,
    // so elsewhere she still tries to take a frame (and falls back to 'black' when none comes).
    if (scene?.state === 'black' && focus.fullscreen === 'exclusive') return 'black';
    return undefined;
  }

  /* ───────────── a question ───────────── */

  async function ask(raw: string) {
    const question = raw.trim();
    if (!question) return;
    const t = deps.now();
    noteUser(mem, t);
    cancel(active);
    // A line of her own still being written is dropped, and its stream stopped: the question comes first.
    cancel(proactiveRun);
    // So is a spoken reply (实时陪玩) in flight, or the two answers would cut each other's voice off.
    if (liveQ) liveQ.dropped = true;
    cancel(live);
    const a: Active = { cancelled: false };
    active = a;
    busy++;
    const id = lineId('ask');
    const w = who();
    try {
      const r = deps.read();
      const why = noSight(r.pet);
      const route = routeQuestion(question, { game: !!focus?.isGame && focus.policy !== 'never', watchable: !why });
      const workdir = await scratch();
      const vision = petVisionEngine(r.models, r.pet.vision);
      const web = route.kind === 'web' ? webEngineFor(r.models, r.pet.web, workdir) : undefined;
      // Only Codex is there to search: it keeps a shell and read access to the disk, so it gets nothing from the screen.
      const thin = !!web && driverOf(web, r.models) !== 'claude-code';
      const chat = petChatEngine(r.models, { vision: r.pet.vision, web: r.pet.web, cwd: workdir });
      if (!web && !chat) { say({ id, text: noModelLine(w.mode), mood: 'idle', speak: false }); return; }

      say({ id, text: thinkLine(w.mode, !!web), mood: 'think', streaming: true });

      // The picture: only when the question points at the screen, she may look, and a model can see it.
      // Text from the screen only goes along with questions about the game while she may look at it; small talk gets none of it.
      const aboutGame = route.kind !== 'chat' || route.wantsSight;
      const ctx: AskCtx = { question, app: focus, ocr: aboutGame && !why && !thin ? ocrLines.slice(-12) : [], image: false };
      let frame: PetFrame | null = null;
      if (route.wantsSight && thin) ctx.noImage = 'withheld';
      else if (route.wantsSight && !why) {
        if (!vision) ctx.noImage = 'no-model';
        else if (imagesLeft(imagesSent, r.pet.imagesPerHour, t, false) <= 0) ctx.noImage = 'budget';
        else {
          frame = await bridge.frame({ maxSide: 1280 }).catch(() => null);
          if (!frame) ctx.noImage = scene?.state === 'black' ? 'black' : 'none';
        }
        if (frame) {
          const o = await withTimeout(bridge.ocr().catch(() => null), OCR_WAIT_MS, null);
          if (o?.lines.length) ctx.ocr = o.lines.slice(-12);
        }
      } else if (route.wantsSight) ctx.noImage = why;
      if (a.cancelled) return;

      let answer: string;
      const push = streamer(id, a);
      if (web) {
        // The command-line model cannot take a picture: a short description of it goes along as text (never to Codex: no frame then).
        if (frame && vision) {
          imagesSent.push(deps.now());
          const spec = petApiSpec(vision, { system: DESCRIBE_SYSTEM, messages: [{ role: 'user', content: [image(frame), { type: 'text', text: describeText(question, focus) }] }], maxTokens: 160 });
          if (spec.ok) ctx.seen = tidy(await run(spec.value, a, ASK_TIMEOUT_MS).catch(() => '')).slice(0, 200) || undefined;
        }
        if (a.cancelled) return;
        // Codex also gets no earlier answers of hers: they may repeat what was on the screen.
        const spec = petCliSpec(web, { system: petSystem(w, 'web'), prompt: cliPrompt(ctx, thin ? [] : history, w), webSearch: true });
        if (!spec.ok) throw new Error(spec.error);
        answer = await run(spec.value, a, WEB_TIMEOUT_MS, push);
      } else {
        const engine = (frame ? vision : undefined) ?? chat!;
        ctx.image = !!frame;
        if (route.kind === 'web') ctx.noWeb = true;
        if (frame) imagesSent.push(deps.now());
        answer = await run(replySpec(engine, w, ctx, frame), a, ASK_TIMEOUT_MS, push);
      }
      if (a.cancelled) return;

      const shaped = shapeAnswer(answer);
      if (!shaped.text) throw new Error('模型没有回复。');
      say({ id, text: shaped.text, more: shaped.more, mood: 'talk', speak: true });
      const at = deps.now();
      remember(history, [{ role: 'user', text: question, at }, { role: 'assistant', text: shaped.text, at }], at);
      noteLine(mem, at, false);
    } catch (e) {
      if (!a.cancelled) say({ id, text: errorLine(w.mode, e instanceof Error ? e.message : String(e)), mood: 'idle', speak: false });
    } finally {
      busy--;
      if (active === a) active = undefined;
    }
  }

  /** The spec for an API model (or, with no API model at all, a command-line one without tools). */
  function replySpec(engine: TaskEngine, w: PetWho, ctx: AskCtx, frame: PetFrame | null): StartSpec {
    const body = askText(ctx);
    if (engine.auth === 'cli') {
      const s = petCliSpec(engine, { system: petSystem(w, 'ask'), prompt: cliPrompt(ctx, history, w), webSearch: false });
      if (!s.ok) throw new Error(s.error);
      return s.value;
    }
    const messages = toMessages(history, frame ? [image(frame), { type: 'text', text: body }] : body);
    const s = petApiSpec(engine, { system: petSystem(w, 'ask'), messages, maxTokens: 700 });
    if (!s.ok) throw new Error(s.error);
    return s.value;
  }

  /** A reply as far as it is written: the bubble's short part, and past that the whole of it (`more`), so the chat
   *  panel keeps growing with it. */
  function written(soFar: string): { text: string; more?: string } {
    const rich = tidy(soFar);
    const flat = flatten(rich);
    const text = cutAt(flat, 140);
    return text === flat ? { text } : { text, more: rich.slice(0, 6000) };
  }

  /** Shows the reply in the bubble as it is written (not read aloud until it is finished). */
  function streamer(id: string, a: Active) {
    let last = 0;
    return (soFar: string) => {
      const t = deps.now();
      if (a.cancelled || t - last < STREAM_PUSH_MS) return;
      const shown = written(soFar);
      if (!shown.text) return;
      last = t;
      say({ id, ...shown, mood: 'talk', streaming: true });
    };
  }

  /* ───────────── her own lines ───────────── */

  async function proactive(trigger: Trigger) {
    const r = deps.read();
    // Only a hello does not depend on the screen; the rest need her to be allowed to look right now (it may have changed since the trigger was rolled).
    const sees = mayWatch(r.pet);
    if (trigger.kind !== 'greet' && !sees) return;
    const w: PetWho = { mode: r.mode, callName: r.callName };
    const t = deps.now();
    // Registered at once so a question can cancel it at any point, even while the picture is being fetched.
    const a: Active = { cancelled: false };
    proactiveRun = a;
    busy++;
    try {
      const engine = trigger.image ? petVisionEngine(r.models, r.pet.vision) : petChatEngine(r.models, { vision: r.pet.vision, web: r.pet.web, cwd: await scratch() });
      if (!engine) return;
      let frame: PetFrame | null = null;
      if (trigger.image) {
        frame = await bridge.frame({ maxSide: 1024 }).catch(() => null);
        if (!frame || a.cancelled) return;
        imagesSent.push(deps.now());
      }
      const body = proactiveText({ kind: trigger.kind, app: focus, ocr: sees ? ocrLines.slice(-10) : [], lines: sees ? trigger.lines : undefined, staticMs: trigger.staticMs, image: !!frame });
      const system = petSystem(w, 'proactive');
      let spec: StartSpec;
      if (engine.auth === 'cli') {
        const s = petCliSpec(engine, { system, prompt: body, webSearch: false });
        if (!s.ok) return;
        spec = s.value;
      } else {
        const s = petApiSpec(engine, { system, messages: [{ role: 'user', content: frame ? [image(frame), { type: 'text', text: body }] : body }], maxTokens: 160 });
        if (!s.ok) return;
        spec = s.value;
      }
      if (a.cancelled) return;
      const raw = await run(spec, a, PROACTIVE_TIMEOUT_MS);
      // The user asked something while she was thinking: her own line would only get in the way.
      if (a.cancelled || mem.lastUserAt > t || busy > 1 || isSkip(raw)) return;
      const line = trimLine(raw, LIMITS.lineMax);
      if (!line) return;
      // A line the desktop did not show (her window is hidden) was not said: it is not counted, nor remembered.
      if (!await sayShown({ id: lineId('p'), text: line, mood: 'talk', speak: true })) return;
      const at = deps.now();
      noteLine(mem, at, true);
      remember(history, [{ role: 'assistant', text: line, at }], at);
    } catch { /* a line of her own is never worth an error message */ } finally {
      busy--;
      if (proactiveRun === a) proactiveRun = undefined;
    }
  }

  async function tick() {
    if (ticking) return;
    // The end of a spoken line can get lost (the pet page crashed, hid or reloaded): she must not stay mute for good.
    if (speaking && deps.now() - speakingSince > SPEAKING_WATCHDOG_MS) speaking = false;
    const { pet } = deps.read();
    if (!pet.enabled || pet.proactivity === 'off') return;
    ticking = true;
    try {
      const t = deps.now();
      tickIgnored(mem, t);
      const ctx: TriggerCtx = {
        now: t, proactivity: pet.proactivity, cooldownSec: pet.cooldownSec, focus, focusSince, scene, idle, text,
        paused, watching: pet.watch, busy: busy > 0 || speaking, realtime: rtLive && t - lastLiveAt < LIVE_QUIET_MS,
        images: imagesLeft(imagesSent, pet.imagesPerHour, t, true),
      };
      const trigger = nextTrigger(mem, ctx, deps.rand);
      if (trigger) await proactive(trigger);
    } finally {
      ticking = false;
    }
  }

  /* ───────────── 实时陪玩 ───────────── */

  /** The model for spoken replies: an API model (a command-line one takes seconds to start), one that sees if possible. */
  function liveEngine(models: ModelState, pet: PetSettings): TaskEngine | undefined {
    const v = petVisionEngine(models, pet.vision);
    if (v) return v;
    const c = petChatEngine(models, { vision: pet.vision });
    return c && c.auth === 'api' ? c : undefined;
  }

  /** What 实时陪玩 is started with (also sent again when these settings change while it runs). */
  function liveOptions(pet: PetSettings) {
    return { op: 'start' as const, listen: pet.realtime.listen, sensitivity: pet.realtime.sensitivity, fastVoice: pet.realtime.fastVoice, autoOffMin: pet.realtime.autoOffMin };
  }

  async function realtime(on: boolean) {
    if (!on) { await bridge.realtime({ op: 'stop' }).catch(() => {}); return; }
    const r = deps.read();
    if (!r.pet.enabled) { deps.toast({ tone: 'info', title: '先打开桌宠', body: '实时陪玩是桌宠的一项功能。' }); return; }
    if (!liveEngine(r.models, r.pet)) {
      deps.toast({ tone: 'warning', title: '还没有能实时回答的模型', body: '实时陪玩要一个用 API 接入的模型（最好能看图），到「模型接入」里接一个。' });
      return;
    }
    const opts = liveOptions(r.pet);
    lastRt = JSON.stringify(opts);
    const res = await bridge.realtime(opts).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    if (!res.ok) deps.toast({ tone: 'warning', title: '实时陪玩没能开始', body: res.error });
  }

  /** The sentences of a live reply that waited while the user was talking. */
  function releaseHeld() {
    const q = liveQ;
    // Held back while the user talked: said now, even if the reply finished meanwhile (unless a newer one replaced it).
    if (!q || q.dropped || !q.held.length) return;
    for (const text of q.held.splice(0)) {
      q.spoke = true;
      q.spoken.push(text);
      void bridge.realtime({ op: 'say', id: q.id, text }).catch(() => {});
    }
  }

  /** A filler sound or a cough is not a question. */
  const meaningful = (s: string) => /[\p{L}\p{N}]/u.test(s) && !/^[嗯啊哦呃额哈唉诶欸呀嘛哎噢喔\s，。！？,.!?…~]+$/u.test(s);

  /** A sentence she heard in 实时陪玩: answered at once, aloud, sentence by sentence, with the latest picture. */
  async function liveAsk(raw: string) {
    let question = raw.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!meaningful(question)) return;
    const t = deps.now();
    // Said in two breaths: the second half joins the first if the reply to it has not started talking yet.
    if (live && liveQ && !liveQ.spoke && t - liveQ.at < LIVE_JOIN_MS) question = `${liveQ.text}，${question}`.slice(0, 500);
    noteUser(mem, t);
    lastLiveAt = t;
    if (liveQ) liveQ.dropped = true;
    cancel(live);
    cancel(proactiveRun);
    const r = deps.read();
    const w: PetWho = { mode: r.mode, callName: r.callName };
    const why = noSight(r.pet);
    const route = routeQuestion(question, { game: !!focus?.isGame && focus.policy !== 'never', watchable: !why });
    // Things that need the web take the slower way (a command-line model searching) when one is there; without one
    // she answers here, from what she knows, and says it may be out of date.
    const canSearch = route.kind === 'web' && !!webEngineFor(r.models, r.pet.web, undefined);
    if (canSearch) { void ask(question); return; }
    const engine = liveEngine(r.models, r.pet);
    if (!engine) { say({ id: lineId('live'), text: noModelLine(w.mode), mood: 'idle', speak: false }); return; }
    const a: Active = { cancelled: false };
    live = a;
    const id = lineId('live');
    const q = { text: question, at: t, spoke: false, id, spoken: [] as string[], held: [] as string[], dropped: false };
    liveQ = q;
    busy++;
    let failed = false;
    /** What the bubble last showed of this reply, to close it if she is cut off. */
    const bubble: { tail?: { text: string; more?: string } } = {};
    try {
      const vision = petVisionEngine(r.models, r.pet.vision);
      // A picture only for what is about the screen, and within the hourly budget (small talk gets none).
      const wants = route.kind !== 'chat' || route.wantsSight;
      const ctx: AskCtx = { question, app: focus, ocr: !why && wants ? ocrLines.slice(-8) : [], image: false };
      if (route.kind === 'web') ctx.noWeb = true;
      let frame: PetFrame | null = null;
      if (wants) {
        if (why) ctx.noImage = why;
        else if (!vision) ctx.noImage = 'no-model';
        else if (imagesLeft(imagesSent, r.pet.imagesPerHour, t, false) <= 0) ctx.noImage = 'budget';
        else {
          frame = await withTimeout(bridge.frame({ maxSide: 960 }).catch(() => null), LIVE_FRAME_WAIT_MS, null);
          if (frame) imagesSent.push(deps.now());
          else if (route.wantsSight) ctx.noImage = scene?.state === 'black' ? 'black' : 'none';
        }
      }
      if (a.cancelled) return;
      ctx.image = !!frame;
      const body = askText(ctx);
      const spec = petApiSpec(engine, { system: petSystem(w, 'live'), messages: toMessages(history, frame ? [image(frame), { type: 'text', text: body }] : body), maxTokens: 260 });
      if (!spec.ok) throw new Error(spec.error);
      let done = 0;
      let last = 0;
      const speakNew = (soFar: string, final: boolean) => {
        const c = speechChunks(soFar, done, final);
        done = c.done;
        for (const piece of c.pieces) {
          const text = flatten(tidy(piece));
          if (!text) continue;
          // The user is saying something right now: hold it until they finish.
          if (userTalking) { q.held.push(text); continue; }
          q.spoke = true;
          q.spoken.push(text);
          void bridge.realtime({ op: 'say', id, text }).catch(() => {});
        }
      };
      const answer = await run(spec.value, a, LIVE_TIMEOUT_MS, (soFar) => {
        if (a.cancelled) return;
        speakNew(soFar, false);
        const now = deps.now();
        if (now - last >= STREAM_PUSH_MS) { last = now; bubble.tail = written(soFar); say({ id, ...bubble.tail, mood: 'talk', streaming: true }); }
      });
      if (a.cancelled) return;
      speakNew(answer, true);
      const shaped = shapeAnswer(answer);
      if (!shaped.text) throw new Error('模型没有回复。');
      // The bubble keeps the reply; it is not read again (the sentences above already were).
      say({ id, text: shaped.text, more: shaped.more, mood: 'talk', speak: false });
      const at = deps.now();
      remember(history, [{ role: 'user', text: question, at }, { role: 'assistant', text: shaped.text, at }], at);
      lastLiveAt = at;
      noteLine(mem, at, false);
    } catch (e) {
      failed = true;
      if (!a.cancelled) say({ id, text: errorLine(w.mode, e instanceof Error ? e.message : String(e)), mood: 'idle', speak: false });
    } finally {
      busy--;
      if (live === a) live = undefined;
      // Cut off while the bubble still showed the half-written reply and nothing newer replaced it: close it, or it stays "being written".
      if (a.cancelled && bubble.tail && lastSentId === id) say({ id, ...bubble.tail, mood: 'idle' });
      // Cut off or failed after she had started talking: what she did say stays in the conversation.
      if ((a.cancelled || failed) && q.spoken.length) {
        const at = deps.now();
        remember(history, [{ role: 'user', text: question, at }, { role: 'assistant', text: `${q.spoken.join('')}……`, at }], at);
      }
    }
  }

  /* ───────────── running ───────────── */

  function start() {
    sync();
    const off = bridge.onEvent(handle);
    const timer = setInterval(() => { void tick(); }, TICK_MS);
    const unsub = store.subscribe(sync);
    return () => { off(); unsub(); clearInterval(timer); cancel(active); cancel(proactiveRun); };
  }

  return { start, tick, handle, ask, realtime, history };
}


/* ───────────── the real thing ───────────── */

let current: Brain | undefined;

/** Called once from the app page; does nothing in the browser dev build (no desktop bridge, no pet). */
export function startPet(): void {
  const bridge = desktop?.pet;
  if (!bridge || current) return;
  current = createBrain({
    bridge,
    read: () => { const s = store.get(); return { pet: s.settings.pet, mode: s.settings.mode, callName: s.settings.callName, models: s.models }; },
    stream: openStream,
    stop: (id) => { void desktop?.stop(id, 'kill'); },
    deny: (id, requestId) => { void desktop?.answer(id, requestId, 'deny'); },
    workspace: () => desktop!.workspaceFolder('pet'),
    toast: (t) => actions.toast(t),
    now: Date.now,
    rand: Math.random,
  });
  current.start();
}

/** The pet menu's 开始 / 结束实时陪玩. */
export function petRealtime(on: boolean): void {
  void current?.realtime(on);
}
