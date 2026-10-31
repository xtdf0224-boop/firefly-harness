/* The desktop pet's message shapes, shared by the brain (main page), the pet window and the capture page.
   The desktop side (electron/pet/*.cjs) uses the same channel names and fields; see docs/PET.md. */
import type { AgentEngine, VisualMode } from '../lib/types';

export type PetMood = 'idle' | 'talk' | 'think' | 'watch' | 'happy' | 'sleep';
export type SceneState = 'static' | 'motion' | 'cut' | 'settled' | 'black';
export type FullscreenKind = 'no' | 'borderless' | 'exclusive';
export type WatchPolicy = 'watch' | 'chat-only' | 'never';
export type TtsProvider = 'elevenlabs' | 'minimax' | 'edge';

export interface FocusApp {
  exe: string;          // lower-case file name, e.g. 'starrail.exe'
  title: string;
  pid: number;
  hwnd: string;         // decimal window handle, as desktopCapturer writes it in 'window:<hwnd>:0'
  fullscreen: FullscreenKind;
  isGame: boolean;
  game?: string;        // display name when known (崩坏：星穹铁道)
  policy: WatchPolicy;
  /** A game with an anti-cheat (policy.cjs): her window is hidden while it is in front, so she says nothing. */
  antiCheat?: boolean;
}

/** One thing the pet says. `speak`: also read it aloud. */
export interface PetLine {
  id: string;
  text: string;
  mood?: PetMood;
  speak?: boolean;
  /** More text was cut from the bubble (the full answer). */
  more?: string;
  streaming?: boolean;
}

export interface PetFrame {
  mime: 'image/jpeg';
  data: string;         // base64
  width: number;
  height: number;
  at: number;
}

/** What the main page sends to the desktop whenever the pet settings or mode change. */
export interface PetRuntimeConfig {
  enabled: boolean;
  mode: VisualMode;
  scale: number;
  watch: boolean;
  neverWatch: string[];
  gameAllow: string[];
  gameDeny: string[];
  hotkeyAsk: string;
  hotkeyPause: string;
  voice: { enabled: boolean; provider: TtsProvider; voiceId: string; volume: number; fallback: boolean; models: { elevenlabs: string; minimax: string } };
}

export interface PetUiState {
  mode: VisualMode;
  scale: number;
  watching: boolean;
  paused: boolean;
  realtime: boolean;
  /** 实时陪玩 is hearing the user right now (speech detected, or the hotkey asked her to listen). */
  listening?: boolean;
  voice: boolean;
}

export type PetEvent =
  | { type: 'focus'; app: FocusApp }
  | { type: 'idle'; seconds: number }
  /** `since`: the wall-clock moment (ms since the epoch) the state began; the capture page only reports how long it had held and capture.cjs converts. */
  | { type: 'scene'; state: SceneState; since: number; change: number }
  | { type: 'text'; lines: string[]; at: number }
  | { type: 'ask'; text: string }
  | { type: 'click' }
  | { type: 'pause'; paused: boolean }
  | { type: 'spoken'; lineId: string; state: 'start' | 'end' }
  | { type: 'rt'; state: 'connecting' | 'live' | 'closed' | 'error'; message?: string }
  /** After the desktop (re)registers the two global hotkeys: which ones work (false = not set, or could not be
   *  registered), and why not (one Chinese sentence each). */
  | { type: 'hotkeys'; ask: boolean; pause: boolean; errors: string[] }
  /** 实时陪玩, what she hears: `start` = the user began talking (and cut her off if she was speaking); `partial` /
   *  `final` = the transcript so far / of the whole sentence; `none` = the turn ended without words. */
  | { type: 'hear'; state: 'start' | 'partial' | 'final' | 'none'; text?: string };

export type RealtimeCmd =
  | { op: 'start'; listen: 'auto' | 'key'; sensitivity: number; fastVoice: boolean; autoOffMin: number }
  | { op: 'stop' }
  /** One sentence of a live reply, read aloud as soon as it is written. Sentences with the same `id` play back to back. */
  | { op: 'say'; id: string; text: string }
  /** Stop her live speech now (the user cut in, or a newer reply replaced it). */
  | { op: 'hush' };

/** One speech model of a voice service, as the settings list shows it. */
export interface TtsModel {
  id: string;
  name: string;
  /** Short Chinese note: quality / speed / caveats. */
  note?: string;
  /** The one used when nothing is chosen. */
  recommended?: boolean;
  /** Old or being retired: still works, listed last. */
  legacy?: boolean;
}

/** window.fireflyDesktop.pet (main page). */
export interface PetBridge {
  configure(cfg: PetRuntimeConfig): void;
  say(line: PetLine): Promise<{ ok: boolean }>;
  frame(opts?: { maxSide?: number }): Promise<PetFrame | null>;
  ocr(): Promise<{ lines: string[] } | null>;
  voices(provider: TtsProvider): Promise<Array<{ id: string; name: string; preview?: string }> | { error: string }>;
  testVoice(v: { provider: TtsProvider; voiceId: string; model?: string; text: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Speech models of a keyed service: ElevenLabs' live list when a key is saved, else the built-in one. */
  ttsModels(provider: Exclude<TtsProvider, 'edge'>): Promise<{ models: TtsModel[]; live: boolean } | { error: string }>;
  saveTtsKey(provider: Exclude<TtsProvider, 'edge'>, key: string): Promise<{ ok: true; hint: string } | { ok: false; error: string }>;
  clearTtsKey(provider: Exclude<TtsProvider, 'edge'>): Promise<{ ok: true } | { ok: false; error: string }>;
  ttsKeys(): Promise<Partial<Record<TtsProvider, string>>>;
  realtime(cmd: RealtimeCmd): Promise<{ ok: true } | { ok: false; error: string }>;
  onEvent(fn: (ev: PetEvent) => void): () => void;
}

/** What the desktop asks the pet window to do (the 呼出 hotkey, the menu and a double-click open the chat panel). */
export type PetUiCommand =
  | { type: 'chat' } | { type: 'close-chat' } | { type: 'hush' }
  /** The desktop made the window click-through again (hidden, reloaded, lost the keyboard): forget what the pointer
   *  was over, so the next move reports it afresh. */
  | { type: 'pointer' };

/** One message in the chat panel's log. The desktop keeps the log (electron/pet/index.cjs), so it outlives the panel and her window. */
export interface PetChatEntry {
  id: string;
  who: 'me' | 'her';
  text: string;
  /** Her full answer when `text` is the cut-down version the bubble shows. */
  more?: string;
  /** Her reply is still being written: it grows under the same id. */
  streaming?: boolean;
  mood?: PetMood;
  /** The user's words heard through the microphone (实时陪玩), not typed. */
  voice?: boolean;
  /** Date.now() when the message began. */
  at: number;
}

/** `pet-ui:chat`: the whole log (when the page asks for it), one message added or grown, or one taken back. */
export type PetChatMsg =
  | { op: 'reset'; entries: PetChatEntry[] }
  | { op: 'put'; entry: PetChatEntry }
  | { op: 'drop'; id: string };

/** One message of `pet-ui:audio`: a chunk of a line's speech, or its end. */
export type PetAudioMsg =
  | {
    lineId: string;
    seq: number;
    chunk: Uint8Array;
    mime: string;
    /** 0–100: the page sets the gain from it (the voice services do not handle volume). */
    volume?: number;
    /** 实时陪玩: raw 16-bit PCM instead of mp3, played as it arrives. */
    live?: boolean;
  }
  | {
    lineId: string;
    end: true;
    /** Synthesis failed; the reason. The line is not played. */
    failed?: string;
  };

/** window.fireflyPet (pet window). */
export interface PetWindowBridge {
  onCommand(fn: (c: PetUiCommand) => void): () => void;
  onState(fn: (s: PetUiState) => void): () => void;
  onLine(fn: (l: PetLine) => void): () => void;
  onLineDelta(fn: (d: { id: string; text: string }) => void): () => void;
  onAudio(fn: (a: PetAudioMsg) => void): () => void;
  onMood(fn: (m: { mood: PetMood }) => void): () => void;
  onChat(fn: (m: PetChatMsg) => void): () => void;
  /** Send the user's message from the chat panel (the panel stays open). */
  ask(text: string): void;
  /** Ask for the whole log (answered with `{ op: 'reset' }`): the page does this once it listens. */
  chatSync(): void;
  /** Open the chat panel (double-click, the chat button); the desktop answers with the `chat` command. */
  chatOpen(): void;
  /** The user closed the panel (Esc, ×): the window shrinks back and hands the keyboard back. */
  chatClose(): void;
  /** The user clicked into the open panel while another window had the keyboard: take it again. */
  chatFocus(): void;
  /** The user clicked the figure (a press that did not turn into a drag). */
  click(): void;
  hit(over: boolean): void;
  drag(phase: 'start' | 'move' | 'end', x: number, y: number): void;
  menu(): void;
  spoken(lineId: string, state: 'start' | 'end'): void;
  mic(pcm: Int16Array): void;
  /** 实时陪玩: the microphone could not be opened, or it stopped (unplugged, taken by another program). The desktop
   *  ends the session and says why. */
  micFailed(): void;
}

export type { AgentEngine };
