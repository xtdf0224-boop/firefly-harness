/* The desktop bridge (electron/preload.cjs). In the browser dev build it is absent and every model
   feature says so instead of pretending. Keys go in through saveKey and never come back. */
import type { CliStatus, DriverId, ProviderId } from './types';
import type { PetBridge } from '../pet/contracts';

/** One part of an API message: text, or an image (a screenshot for the 桌宠) as base64. */
export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mime: 'image/jpeg' | 'image/png'; data: string };

export type StreamEvent =
  | { id: string; type: 'session'; sessionId: string }
  | { id: string; type: 'model'; model: string }
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'thinking'; text: string }
  | { id: string; type: 'text-break' }
  | { id: string; type: 'tool'; callId: string; name: string; input: Record<string, unknown>; title: string }
  | { id: string; type: 'tool-end'; callId: string; ok: boolean; output: string; exitCode?: number }
  | { id: string; type: 'plan'; entries: Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }> }
  | { id: string; type: 'permission'; requestId: string; callId?: string; name: string; input: Record<string, unknown>; title: string; reason?: string; blockedPath?: string; paths?: string[] }
  | { id: string; type: 'usage'; input: number; output: number; cached: number; total?: boolean; context?: number }
  | { id: string; type: 'notice'; text: string; level?: 'info' | 'warn' | 'error' }
  | { id: string; type: 'stdout'; text: string }
  | { id: string; type: 'done'; text: string; stopReason?: string; sessionId?: string; costUsd?: number }
  | { id: string; type: 'error'; message: string; code?: string; sessionId?: string };

export interface StartSpec {
  driver: 'api-openai' | 'api-anthropic' | DriverId | 'acp';
  provider: ProviderId;
  /* API */
  baseUrl?: string;
  model?: string;
  system?: string;
  /** Text, or (API drivers only, user turns only) text and images. */
  messages?: Array<{ role: 'user' | 'assistant'; content: string | ContentPart[] }>;
  maxTokens?: number;
  temperature?: number;
  /** Reasoning fields for the API body (validated by the desktop side). */
  extraBody?: Record<string, unknown>;
  /** CLI effort flag value (Claude Code --effort, Codex model_reasoning_effort). */
  effort?: string;
  /* CLI */
  acp?: 'kimi' | 'qwen' | 'mcode';
  path?: string;
  cwd?: string;
  prompt?: string;
  sessionId?: string;
  access?: 'chat' | 'work';
  /** A 只读 work task: no browser actions, DeepSeek Harness in its read-only mode. */
  readOnly?: boolean;
  allow?: string[];
  deny?: string[];
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  webSearch?: boolean;
  env?: Record<string, string>;
  keyEnv?: string;
  /** The run uses skills: Claude Code is allowed to read the skills folder. */
  skills?: boolean;
  /** Attach the firefly-browser MCP server (浏览器控制). */
  browser?: boolean;
}

/** What the tray menu or a notification asks the page to do. */
export type DesktopCommand = { type: 'new' } | { type: 'close-to-tray'; value: boolean } | { type: 'approvals' } | { type: 'open-task'; taskId: string }
  /** Tray / pet menu: show or hide the 桌宠, open its settings, start or stop 实时陪玩. */
  | { type: 'pet-toggle' } | { type: 'pet-settings' } | { type: 'pet-realtime'; on: boolean }
  /** Pet menu on a program: let her watch it (a game) or never look at it. */
  | { type: 'pet-watch'; exe: string; allow: boolean };

export interface DesktopBridge {
  version: number;
  info(): Promise<{ encryption: boolean; keys: Partial<Record<ProviderId, string>>; workspaceRoot: string; platform: string }>;
  saveKey(provider: ProviderId, key: string): Promise<{ ok: true; hint: string } | { ok: false; error: string }>;
  clearKey(provider: ProviderId): Promise<{ ok: true }>;
  detect(req: { driver: DriverId; path?: string }): Promise<Omit<CliStatus, 'at'>>;
  models(req: { driver: DriverId; path?: string; fresh?: boolean }): Promise<import('./effort').LiveModel[] | null>;
  openLogin(req: { driver: DriverId; path?: string }): Promise<{ ok: true; command: string } | { ok: false; error: string }>;
  test(spec: StartSpec): Promise<{ ok: true; text: string; ms: number; model?: string } | { ok: false; error: string; code?: string; ms: number }>;
  pickFolder(start?: string): Promise<string | null>;
  workspaceFolder(name: string): Promise<string>;
  openFolder(dir: string): Promise<string>;
  start(spec: StartSpec): Promise<string>;
  input(id: string, text: string): Promise<boolean>;
  answer(id: string, requestId: string, decision: 'allow' | 'deny', input?: Record<string, unknown>): Promise<boolean>;
  stop(id: string, how: 'interrupt' | 'kill'): Promise<boolean>;
  onEvent(fn: (ev: StreamEvent) => void): () => void;
  /** The window shell: tray preference, system notifications, commands from the tray menu. */
  app?: {
    setPrefs(prefs: { closeToTray: boolean }): void;
    notify(n: { title: string; body?: string; command?: DesktopCommand }): void;
    onCommand(fn: (cmd: DesktopCommand) => void): () => void;
  };
  browser?: { open(): Promise<boolean>; clear(): Promise<boolean> };
  /** 桌宠 (docs/PET.md). */
  pet?: PetBridge;
  skills?: {
    list(): Promise<{ root: string; skills: import('./types').SkillInfo[]; error?: string }>;
    import(): Promise<{ ok: true; name: string } | { ok: false; error?: string; canceled?: boolean; conflict?: string; token?: string; name?: undefined }>;
    confirmImport(token: string): Promise<{ ok: true; name: string } | { ok: false; error?: string; canceled?: boolean; conflict?: string; token?: string }>;
    create(name: string): Promise<{ ok: true; name: string; dir: string } | { ok: false; error: string }>;
    installExamples(): Promise<{ ok: true; added: string[] } | { ok: false; error: string }>;
    setEnabled(folder: string, enabled: boolean): Promise<boolean>;
    remove(folder: string): Promise<{ ok: true } | { ok: false; error: string }>;
    open(folder?: string): Promise<string>;
  };
}

declare global {
  interface Window { fireflyDesktop?: DesktopBridge }
}

export const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? window.fireflyDesktop : undefined;

/* One listener for all streams; each stream registers its own handler by id. Events that arrive
   before the handler is registered (start() resolves after the first events) are buffered. */
const handlers = new Map<string, (ev: StreamEvent) => void>();
const early = new Map<string, StreamEvent[]>();
desktop?.onEvent((ev) => {
  const h = handlers.get(ev.id);
  if (h) { h(ev); return; }
  const list = early.get(ev.id) ?? [];
  list.push(ev);
  early.set(ev.id, list);
  if (early.size > 50) early.delete(early.keys().next().value as string);
});

/** Start a stream and route its events to `on`. Resolves with the stream id. */
export async function openStream(spec: StartSpec, on: (ev: StreamEvent) => void, onId?: (id: string) => void): Promise<string> {
  if (!desktop) throw new Error('需要桌面版才能调用真实模型。');
  const id = await desktop.start(spec);
  onId?.(id);
  const finalOn = (ev: StreamEvent) => {
    if (ev.type === 'done' || ev.type === 'error') handlers.delete(id);
    on(ev);
  };
  handlers.set(id, finalOn);
  const buffered = early.get(id);
  if (buffered) { early.delete(id); buffered.forEach(finalOn); }
  return id;
}
