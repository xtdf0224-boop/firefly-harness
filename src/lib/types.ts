/* Domain model of the harness. Everything the UI shows comes from these shapes: tasks, the runs real
   models carry out (live.ts drives them through the desktop bridge), and the settings around them. */

export type ViewId = 'new' | 'tasks' | 'task' | 'agents' | 'tools' | 'models' | 'history' | 'settings';
export type WorkspaceTab = 'conversation' | 'steps' | 'artifacts';
export type ConsoleTab = 'tools' | 'terminal' | 'errors' | 'timeline';

export type VisualMode = 'firefly' | 'sam';
export type MotionPref = 'system' | 'reduced' | 'full';
export type ParticleDensity = 'off' | 'low' | 'normal';

export type RunStatus = 'queued' | 'running' | 'paused' | 'awaiting' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'awaiting' | 'done' | 'failed' | 'skipped' | 'cancelled';
export type ToolCallStatus = 'running' | 'awaiting' | 'ok' | 'error' | 'denied' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type AgentActivity = 'idle' | 'thinking' | 'tool' | 'waiting' | 'paused';
export type ToolPermission = 'auto' | 'confirm' | 'off';
export type Risk = 'low' | 'medium' | 'high';
export type Tone = 'neutral' | 'info' | 'running' | 'success' | 'warning' | 'danger' | 'paused';

export type AgentId = 'orchestrator' | 'researcher' | 'coder' | 'reviewer';
export type ToolId = 'read_file' | 'write_file' | 'shell' | 'code_search' | 'web_search' | 'web_fetch' | 'git' | 'browser_read' | 'browser_act' | 'other';

/* ───────────── 模型接入 ───────────── */

export type ProviderId = 'claude' | 'gpt' | 'deepseek' | 'kimi' | 'qwen' | 'glm' | 'minimax' | 'doubao';
/** CLI programs the desktop app can drive. `claude-compat` = Claude Code pointed at another vendor's
 *  Anthropic-compatible endpoint with that vendor's key. */
export type DriverId = 'claude-code' | 'codex' | 'kimi' | 'qwen' | 'mcode' | 'dsh' | 'claude-compat';
export type AuthMode = 'cli' | 'api';
/** What a work task's CLI agent may do: follow 工具与技能's policies, or only read. */
export type WorkAccess = 'policy' | 'read';

export interface CliStatus {
  found: boolean;
  path?: string;
  version?: string;
  login: 'yes' | 'no' | 'unknown' | 'n/a';
  account?: string;
  detail?: string;
  at: number;
}

export interface ConnectionTest {
  ok: boolean;
  at: number;
  ms: number;
  message: string;
  auth: AuthMode;
  driver?: DriverId;
}

/** Non-secret settings for one vendor. The key itself lives encrypted in the desktop process. */
export interface ProviderConfig {
  id: ProviderId;
  /** Which way new tasks use this vendor. */
  auth: AuthMode;
  driver: DriverId;
  region: string;
  /** Overrides the region's base URL when not empty. */
  baseUrl: string;
  model: string;
  /** Model passed to the CLI; '' = the CLI's own default. */
  cliModel: string;
  /** Custom path to the CLI; '' = find it on PATH. */
  cliPath: string;
  /** Codex only: its Windows sandbox fails on some machines; 'danger-full-access' runs without it. */
  codexSandbox?: 'workspace-write' | 'danger-full-access';
  /** Default 推理强度 for new tasks using the API way / the CLI way; undefined = the model's own default. */
  effort?: import('./effort').Effort;
  cliEffort?: import('./effort').Effort;
  /** '••••abcd' when a key is saved. */
  keyHint?: string;
  cli?: CliStatus;
  test?: ConnectionTest;
}

export interface ModelState {
  providers: Record<ProviderId, ProviderConfig>;
  /** Models a CLI reports live (Codex: the account's models and their effort levels). Not saved. */
  live?: Partial<Record<DriverId, import('./effort').LiveModel[]>>;
  /** Running inside the desktop app (model access needs it). */
  desktop: boolean;
  encryption: boolean;
  workspaceRoot?: string;
  /** Vendor preselected for new tasks ('' = the first one that is ready). */
  defaultEngine: ProviderId | '';
}

/** How a task (or one agent's steps) runs: which vendor, which way, which model. */
export interface TaskEngine {
  kind: 'live';
  provider: ProviderId;
  auth: AuthMode;
  driver?: DriverId;
  model: string;
  /** e.g. 「Claude · Claude Code」 — shown in headers and messages. */
  label: string;
  /** Working folder for CLI agents. */
  cwd?: string;
  access?: WorkAccess;
  /** 推理强度; undefined = the model's / tool's own default. */
  effort?: import('./effort').Effort;
  /** 浏览器控制: the CLI agent may drive the 萤火浏览器 window. */
  browser?: boolean;
}

export type TaskKind = 'chat' | 'work';

/** A skill folder in <userData>/skills (SKILL.md frontmatter + body). */
export interface SkillInfo {
  folder: string;
  name: string;
  description: string;
  modes: TaskKind[];
  dir: string;
  skillFile: string;
  enabled: boolean;
  body: string;
  version?: string;
  author?: string;
  /** Why it cannot be used yet (no SKILL.md, no description…). */
  error?: string;
}

/** An agent's own model, set on the Agent page: an engine choice (`claude:cli`…), model and effort. */
export interface AgentEngine {
  /** EngineChoice key: `${provider}:${auth}`. */
  key: string;
  /** '' = that way's default model. */
  model: string;
  effort?: import('./effort').Effort;
}

export interface Agent {
  id: AgentId;
  name: string;          // functional name, e.g. 编排 Agent
  role: string;          // one line: what it is for
  description: string;
  /** Its own model for the steps it is given; undefined = the task's model. The 编排 Agent always uses the task's. */
  engine?: AgentEngine;
  /** Tools it may use when its steps run on a command-line agent. */
  tools: ToolId[];
  enabled: boolean;
  /** Short glyph text for the avatar (1–2 chars). */
  glyph: string;
  /** Hue token name used for the avatar ring: one of mint | firefly | silver | gold. */
  hue: 'mint' | 'firefly' | 'silver' | 'gold';
}

export interface ToolDef {
  id: ToolId;
  name: string;
  description: string;
  category: '文件' | '执行' | '检索' | '网络' | '版本控制';
  permission: ToolPermission;
  risk: Risk;
}

export interface Task {
  id: string;
  title: string;
  goal: string;
  createdAt: number;
  updatedAt: number;
  agentIds: AgentId[];
  /** Oldest first. The last entry is the current run. */
  runIds: string[];
  messages: Message[];
  /** 闲聊 or 工作. Older saves have no kind: they are work tasks. */
  kind?: TaskKind;
  /** The model the task runs on (undefined only if it was never set up; the UI asks to pick one). */
  engine?: TaskEngine;
  /** CLI session id, so later runs and chat turns continue the same conversation. */
  session?: string;
  /** CLI sessions of agents that run on their own command-line model. */
  agentSessions?: Partial<Record<AgentId, string>>;
  /** Skill folders picked for this task; undefined = every enabled skill for its kind. */
  skills?: string[];
}

export interface PlanStep {
  id: string;
  index: number;            // 0-based position in the plan
  title: string;
  detail: string;
  agentId: AgentId;
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
  /** Active running time in ms: excludes time spent paused or waiting for an approval, like Run.activeMs.
   *  Older saved runs lack it; fall back to endedAt − startedAt. */
  activeMs?: number;
  toolCallIds: string[];
  /** Short explanation shown under the step (why skipped / failed / carried over). */
  note?: string;
  /** True when a retry reused this step's result from the previous attempt. */
  carried?: boolean;
  /** What the agent reported for this step. */
  result?: string;
  /** The model that ran this step, when it was not the task's own (an agent with its own model). */
  engineLabel?: string;
}

export interface ToolCallError {
  code: string;            // e.g. EXIT_1, HTTP_429, ETIMEDOUT
  message: string;         // one line, human readable
  detail?: string;         // stack / stderr excerpt (monospace)
  recoverable: boolean;    // the agent carried on after it (the call failed, not the step)
}

export interface ToolCall {
  id: string;
  runId: string;
  stepId: string;
  agentId: AgentId;
  tool: ToolId;
  title: string;           // human summary: 读取 src/auth/login.ts
  input: Record<string, unknown>;
  output?: string;
  error?: ToolCallError;
  status: ToolCallStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;     // active (unpaused) duration
  approvalId?: string;
  /** The CLI's own tool name (PowerShell, Edit, apply_patch…) when `tool` is a mapped category. */
  toolName?: string;
}

export interface Approval {
  id: string;
  runId: string;
  taskId: string;
  stepId: string;
  toolCallId: string;
  agentId: AgentId;
  tool: ToolId;
  title: string;            // 写入 3 个文件
  reason: string;           // why the agent wants to do it
  preview: string;          // command or diff text (monospace)
  previewKind: 'command' | 'diff' | 'request';
  risk: Risk;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt?: number;
}

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  agentId?: AgentId;
  runId?: string;
  text: string;
  at: number;
  kind?: 'plan' | 'note' | 'summary' | 'error' | 'reply';
  /** Still being written (the model is streaming its reply). */
  streaming?: boolean;
  /** Which voice spoke (流萤 or 萨姆), so switching modes later does not rename old messages. */
  persona?: VisualMode;
  /** The model's visible reasoning for this reply (shown folded, like DeepSeek's 思考过程). */
  thinking?: string;
  /** A supplement sent during a live run that has already been handed to the agent. */
  delivered?: boolean;
  /** While a chat reply is being written: what she is doing right now (a tool she is using). */
  activity?: string;
}

export interface Artifact {
  id: string;
  runId: string;
  stepId: string;
  name: string;               // file name or title
  kind: 'file' | 'diff' | 'report';
  language?: string;          // ts, md, json, diff…
  content: string;
  createdAt: number;
}

export type EventKind = 'run' | 'step' | 'tool' | 'approval' | 'agent' | 'user' | 'error';
export interface RunEvent {
  id: string;
  at: number;
  runId?: string;
  kind: EventKind;
  level: 'info' | 'success' | 'warn' | 'error';
  text: string;
  refId?: string;
}

export interface TerminalLine {
  id: string;
  at: number;
  runId: string;
  stream: 'cmd' | 'stdout' | 'stderr' | 'sys';
  text: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  contextUsed: number;
  contextLimit: number;
  /** Total tokens sampled after each usage report, for the sparkline. */
  series: number[];
}

export interface RunCursor {
  phase: 'planning' | 'executing' | 'done';
  /** Plan index being worked on. */
  step: number;
}

/** What the run's active agent is doing right now — drives the status panel and step glow. */
export interface LiveActivity {
  agentId: AgentId;
  activity: AgentActivity;
  text: string;
}

export interface Run {
  id: string;
  taskId: string;
  attempt: number;          // 1-based, increments on retry
  status: RunStatus;
  /** Why the run is paused, when it is. */
  pauseReason?: 'user' | 'reload';
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** Active running time in ms (excludes paused / awaiting time). Wall time = (endedAt ?? now) − startedAt. */
  activeMs: number;
  /** Status to return to on resume ('running' or 'awaiting'). */
  pausedFrom?: 'running' | 'awaiting';
  live?: LiveActivity;
  plan: PlanStep[];
  planReady: boolean;
  toolCalls: ToolCall[];
  approvals: Approval[];
  artifacts: Artifact[];
  errors: RunErrorRecord[];
  terminal: TerminalLine[];
  usage: Usage;
  cursor: RunCursor;
  /** Which run this one retried, if any. */
  retryOf?: string;
  retryMode?: 'resume' | 'restart';
  failure?: { stepId: string; message: string };
  /** Which model ran it, e.g. 「Claude · Claude Code · Claude Sonnet 5.5」. */
  engineLabel?: string;
  /** Agents that ran on their own model in this run (snapshot taken when the run started). */
  agentEngines?: Partial<Record<AgentId, TaskEngine>>;
  /** Which done steps each CLI session has been told about ('task' = the task's own session, or an
   *  agent id): results produced elsewhere are handed to a session once, before its next turn. */
  shown?: Record<string, string[]>;
}

export interface RunErrorRecord {
  id: string;
  at: number;
  runId: string;
  stepId?: string;
  toolCallId?: string;
  title: string;
  code: string;
  message: string;
  detail?: string;
  fatal: boolean;
}

export interface Settings {
  mode: VisualMode;
  motion: MotionPref;
  particles: ParticleDensity;
  /** 主题光标: the 流萤 / 萨姆 cursor set instead of the system's. */
  themeCursor: boolean;
  confirmBeforeCancel: boolean;
  openConsoleOnError: boolean;
  /** Desktop: the close button tucks the window into the system tray instead of quitting. */
  closeToTray: boolean;
  /** Show the character wallpaper under the starfield (流萤 and 萨姆 each have their own). */
  wallpaper: boolean;
  /** 0–100: how clearly the wallpaper shows through the night grade. */
  wallpaperVisibility: number;
  /** 0–100: how see-through the glass panels are (code and logs always stay opaque). */
  panelGlass: number;
  /** Let the welcome page show more of the wallpaper and dim it on dense pages. */
  wallpaperAdaptive: boolean;
  /** Play the 开机动画 when the workbench opens. */
  bootAnimation: boolean;
  /** Title screen of the 开机动画: wait for a click (like the game) or enter by itself. */
  bootEnter: 'click' | 'auto';
  /** 编排 Agent speaks as 流萤 (or 萨姆 in 萨姆 mode). */
  persona: boolean;
  /** How she addresses you. */
  callName: string;
  /** 'natural' shows a reply as it is written; 'instant' waits and shows each finished reply at once. */
  typing: 'natural' | 'instant';
  /** Time-of-day greeting on the welcome page. */
  lifeGreeting: boolean;
  /** Little idle status next to her name (在看星星、待命中…). */
  lifeMood: boolean;
  /** In a quiet chat she may say something on her own (max twice in a row). */
  lifeNudge: boolean;
  /** 桌宠 (docs/PET.md). */
  pet: PetSettings;
}

export type PetProactivity = 'off' | 'low' | 'normal' | 'high';
export type PetVoiceProvider = 'elevenlabs' | 'minimax' | 'edge';
/** The speech model per keyed service (the API model id); '' = the recommended one. Kept per service so switching back keeps it. */
export type PetVoiceModels = { elevenlabs: string; minimax: string };

export interface PetSettings {
  /** Show the pet window. */
  enabled: boolean;
  /** Let her look at the foreground game window on this PC (frames stay local unless sent with a question). */
  watch: boolean;
  /** How often she speaks up on her own; 'normal' = now and then. */
  proactivity: PetProactivity;
  /** Minimum seconds between two lines she starts herself. */
  cooldownSec: number;
  /** At most this many screenshots sent to a model per hour. */
  imagesPerHour: number;
  /** API model that looks at screenshots; unset = the cheapest connected vision model. */
  vision?: AgentEngine;
  /** CLI model for questions that need the web (攻略、配装); unset = a logged-in Claude Code / Codex. */
  web?: AgentEngine;
  voice: { enabled: boolean; provider: PetVoiceProvider; voiceId: string; volume: number; fallback: boolean; models: PetVoiceModels };
  hotkeyAsk: string;
  hotkeyPause: string;
  /** Programs she never looks at (lower-case exe names). */
  neverWatch: string[];
  /** Programs the user marked as games she may watch. */
  gameAllow: string[];
  /** Programs the user marked as chat only (added to the built-in anti-cheat list). */
  gameDeny: string[];
  /** 实时陪玩 (docs/PET.md §7): she listens on the microphone and answers aloud.
   *  listen: 'auto' = whenever the user talks; 'key' = the 呼出 hotkey starts one sentence (for speakers / noisy games).
   *  sensitivity 0–100: how quiet speech may be to count. fastVoice: ElevenLabs Flash v2.5 for her replies (she starts
   *  talking sooner). autoOffMin: ends by itself after this many minutes without the user talking. */
  realtime: { listen: 'auto' | 'key'; sensitivity: number; fastVoice: boolean; autoOffMin: number };
  /** Size on screen, 0.6–1.6. */
  scale: number;
}

/** Serializable UI commands, so engine-made toasts can carry an action without importing the UI. */
export type UiCommand =
  | { type: 'open-task'; taskId: string; runId?: string; tab?: WorkspaceTab }
  /** With taskId / runId the command first opens that run, so the console shows the run the toast is about. */
  | { type: 'open-console'; tab: ConsoleTab; focusId?: string; taskId?: string; runId?: string }
  | { type: 'resume-run'; runId: string }
  | { type: 'retry-run'; runId: string; mode: 'resume' | 'restart' }
  | { type: 'show-approvals' }
  | { type: 'navigate'; view: ViewId };

export interface Toast {
  id: string;
  tone: Tone;
  title: string;
  body?: string;
  action?: { label: string; command: UiCommand };
  createdAt: number;
  /** ms; 0 = stays until dismissed */
  ttl: number;
  /** Toasts about the same thing share a key: a newer one replaces the older, and resolving the
   *  thing (approval decided, run retried) removes it. */
  key?: string;
}

export interface ConsoleState {
  open: boolean;
  tab: ConsoleTab;
  height: number;
  /** Tool call to scroll to / expand when the console opens. */
  focusId?: string;
}

export type Dialog =
  | { kind: 'cancel-run'; runId: string }
  | { kind: 'clear-history' }
  | { kind: 'delete-task'; taskId: string };

export interface Celebration { runId: string; at: number }

export interface AppState {
  view: ViewId;
  selectedTaskId?: string;
  /** Run shown in the workspace; defaults to the task's latest run. */
  selectedRunId?: string;
  workspaceTab: WorkspaceTab;
  console: ConsoleState;
  statusDrawerOpen: boolean;
  navCollapsed: boolean;
  settings: Settings;
  tasks: Record<string, Task>;
  /** Newest first. */
  taskOrder: string[];
  runs: Record<string, Run>;
  agents: Agent[];
  tools: ToolDef[];
  models: ModelState;
  /** Installed skills (read from the desktop side; not saved in the page). */
  skills?: { root: string; list: SkillInfo[]; loaded: boolean };
  events: RunEvent[];        // global timeline, newest last, capped
  toasts: Toast[];
  dialog?: Dialog;
  celebration?: Celebration;
  /** Live-region text for screen readers; replaced on every announcement. */
  announcement: { text: string; at: number };
  /** Set by 预览 in Settings to replay the 开机动画. Not persisted. */
  bootAt?: number;
  /** 赏图: the interface fades out so the wallpaper shows in full. Not persisted. */
  peek?: boolean;
  /** One-shot request for a region to scroll into view and take focus (e.g. pending approvals). */
  focusRequest?: { target: 'approvals' | 'composer' | 'console' | 'plan'; at: number };
}
