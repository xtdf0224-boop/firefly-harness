/* Domain model of the harness. Everything the UI shows comes from these shapes, whether a real
   backend or the bundled simulator produced it. `simulated` / `source` fields carry the provenance
   so the UI can label demo data honestly. */

export type ViewId = 'new' | 'tasks' | 'task' | 'agents' | 'tools' | 'models' | 'history' | 'settings';
export type WorkspaceTab = 'conversation' | 'steps' | 'artifacts';
export type ConsoleTab = 'tools' | 'terminal' | 'errors' | 'timeline';

export type VisualMode = 'firefly' | 'sam';
export type MotionPref = 'system' | 'reduced' | 'full';
export type ParticleDensity = 'off' | 'low' | 'normal';
export type SimSpeed = 1 | 2 | 4;

/** Where a record came from. `simulated` = produced live by the in-browser simulator this session;
 *  `sample` = pre-generated example history. A real backend would use `live`. */
export type DataSource = 'simulated' | 'sample' | 'live';

export type RunStatus = 'queued' | 'running' | 'paused' | 'awaiting' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'awaiting' | 'done' | 'failed' | 'skipped' | 'cancelled';
export type ToolCallStatus = 'running' | 'awaiting' | 'ok' | 'error' | 'denied' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type AgentActivity = 'idle' | 'thinking' | 'tool' | 'waiting' | 'paused' | 'offline';
export type ConnectionStatus = 'connected' | 'degraded' | 'disconnected' | 'reconnecting';
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
/** What a work task's CLI agent may do: follow 工具与连接's policies, or only read. */
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
  /** 'demo' or a vendor: preselected for new tasks. */
  defaultEngine: 'demo' | ProviderId;
}

/** How a task runs. Undefined = the bundled simulator (演示模式). */
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

export interface Agent {
  id: AgentId;
  name: string;          // functional name, e.g. 编排 Agent
  role: string;          // one line: what it is for
  description: string;
  model: string;         // configured model id (in demo mode nothing is called)
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

export interface Connection {
  id: string;
  name: string;
  kind: 'model' | 'mcp' | 'runtime';
  endpoint: string;
  status: ConnectionStatus;
  latencyMs?: number;
  lastChangeAt: number;
  /** Next automatic reconnect attempt (epoch ms) while disconnected. */
  retryAt?: number;
  attempts: number;
  detail?: string;
  simulated: boolean;
}

export interface Task {
  id: string;
  title: string;
  goal: string;
  createdAt: number;
  updatedAt: number;
  scenarioId: ScenarioId;
  agentIds: AgentId[];
  /** Oldest first. The last entry is the current run. */
  runIds: string[];
  messages: Message[];
  source: DataSource;
  /** 闲聊 or 工作. Older saves have no kind: they are work tasks. */
  kind?: TaskKind;
  /** Real model; undefined = 演示模式. */
  engine?: TaskEngine;
  /** CLI session id, so later runs and chat turns continue the same conversation. */
  session?: string;
  /** Skill folders picked for this task; undefined = every enabled skill for its kind. */
  skills?: string[];
}

export type ScenarioId = 'refactor' | 'research' | 'report' | 'general';

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
  /** What the agent reported for this step (real runs). */
  result?: string;
}

export interface ToolCallError {
  code: string;            // e.g. EXIT_1, HTTP_429, ETIMEDOUT
  message: string;         // one line, human readable
  detail?: string;         // stack / stderr excerpt (monospace)
  recoverable: boolean;    // the agent retried on its own
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
  /** Planned duration of the simulated call — lets the UI draw progress. */
  expectedMs?: number;
  approvalId?: string;
  simulated: boolean;
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
  simulated: boolean;
  /** Still being written (a real model streaming its reply). */
  streaming?: boolean;
  /** Which voice spoke (流萤 or 萨姆), so switching modes later does not rename old messages. */
  persona?: VisualMode;
  /** The reply came from a real model (rendered as Markdown, no 模拟 tag). */
  live?: boolean;
  /** The model's visible reasoning for this reply (shown folded, like DeepSeek's 思考过程). */
  thinking?: string;
  /** A supplement sent during a live run that has already been handed to the agent. */
  delivered?: boolean;
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
  simulated: boolean;
}

export type EventKind = 'run' | 'step' | 'tool' | 'approval' | 'agent' | 'connection' | 'user' | 'error';
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
  /** Total tokens sampled after each beat, for the sparkline. */
  series: number[];
}

export interface RunCursor {
  phase: 'planning' | 'executing' | 'done';
  step: number;
  beat: number;
  /** Simulated ms already spent on the current beat. */
  beatElapsed: number;
  /** The current beat's start effects (tool call created, approval asked) have been applied. */
  beatStarted: boolean;
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
  pauseReason?: 'user' | 'disconnected' | 'reload';
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
  /** Plan index where the previous attempt failed; retry-only fix beats run there. */
  fixStepIndex?: number;
  failure?: { stepId: string; message: string };
  source: DataSource;
  /** Real runs: which model ran it, e.g. 「Claude · Claude Code · claude-sonnet-5-5」. */
  engineLabel?: string;
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
  simSpeed: SimSpeed;
  confirmBeforeCancel: boolean;
  openConsoleOnError: boolean;
  /** Demo control: the first attempt of the refactor scenario fails at the test step. */
  injectFailure: boolean;
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
  /** 'natural' reveals replies at a reading pace; 'instant' shows them at once. */
  typing: 'natural' | 'instant';
  /** Time-of-day greeting on the welcome page. */
  lifeGreeting: boolean;
  /** Little idle status next to her name (在看星星、待命中…). */
  lifeMood: boolean;
  /** In a quiet chat she may say something on her own (max twice in a row). */
  lifeNudge: boolean;
}

/** Serializable UI commands, so engine-made toasts can carry an action without importing the UI. */
export type UiCommand =
  | { type: 'open-task'; taskId: string; runId?: string; tab?: WorkspaceTab }
  /** With taskId / runId the command first opens that run, so the console shows the run the toast is about. */
  | { type: 'open-console'; tab: ConsoleTab; focusId?: string; taskId?: string; runId?: string }
  | { type: 'resume-run'; runId: string }
  | { type: 'retry-run'; runId: string; mode: 'resume' | 'restart' }
  | { type: 'show-approvals' }
  | { type: 'navigate'; view: ViewId }
  | { type: 'reconnect'; connectionId: string };

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
   *  thing (approval decided, run retried, connection back) removes it. */
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
  | { kind: 'reset-demo' }
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
  connections: Connection[];
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
