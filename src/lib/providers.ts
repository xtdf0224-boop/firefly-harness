/* 模型接入目录: the eight vendors, how each can be reached (API key, or a CLI agent that signs in
   with an account or uses the vendor's key), their endpoints and suggested models. Model names are
   suggestions — any model id the vendor accepts can be typed in. */
import type { DriverId, ProviderConfig, ProviderId } from './types';

/** `ctx`: context window in tokens, when the vendor documents it. */
export interface ModelOption { id: string; note?: string; ctx?: number }
export interface RegionOption {
  id: string;
  label: string;
  /** OpenAI-compatible base (…/v1) or, for Claude, the Messages API root. */
  baseUrl: string;
  /** The vendor's Anthropic-compatible endpoint, used to drive Claude Code with this vendor's key. */
  compatUrl?: string;
}

export interface DriverInfo {
  id: DriverId;
  label: string;
  bin: string;
  install: string;
  /** 'account': the CLI signs in with its own account; 'key': it uses the vendor's API key saved here. */
  auth: 'account' | 'key';
  /** How approvals work: per call (the workbench asks you), or by sandbox only. */
  approvals: 'per-call' | 'sandbox';
  note: string;
  homepage: string;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  vendor: string;
  glyph: string;
  protocol: 'openai' | 'anthropic';
  regions: RegionOption[];
  models: ModelOption[];
  /** CLI model suggestions ('' first = the CLI's own default). */
  cliModels: Partial<Record<DriverId, ModelOption[]>>;
  keyUrl: string;
  keyHelp: string;
  drivers: DriverId[];
}

export const DRIVERS: Record<DriverId, DriverInfo> = {
  'claude-code': {
    id: 'claude-code', label: 'Claude Code', bin: 'claude', install: 'npm install -g @anthropic-ai/claude-code',
    auth: 'account', approvals: 'per-call', homepage: 'https://code.claude.com/docs/',
    note: '用 Claude 账号（Pro / Max 订阅）登录。写文件、执行命令前会在萤火里征求你的确认。',
  },
  codex: {
    id: 'codex', label: 'Codex CLI', bin: 'codex', install: 'npm install -g @openai/codex',
    auth: 'account', approvals: 'sandbox', homepage: 'https://github.com/openai/codex',
    note: '用 ChatGPT 账号登录。Codex 的无头模式不能逐项确认，按沙箱策略执行（工作文件夹内可写）。',
  },
  kimi: {
    id: 'kimi', label: 'Kimi Code CLI', bin: 'kimi', install: 'npm install -g @moonshot-ai/kimi-code',
    auth: 'account', approvals: 'per-call', homepage: 'https://moonshotai.github.io/kimi-code/',
    note: '用 Kimi 会员账号登录（需含 Kimi Code 额度）。通过 ACP 协议对接，操作前会征求确认。',
  },
  qwen: {
    id: 'qwen', label: 'Qwen Code', bin: 'qwen', install: 'npm install -g @qwen-code/qwen-code',
    auth: 'key', approvals: 'per-call', homepage: 'https://github.com/QwenLM/qwen-code',
    note: 'Qwen Code 使用阿里云百炼的 API Key（下面「API 密钥」里保存的那个）。通过 ACP 协议对接，操作前会征求确认。',
  },
  mcode: {
    id: 'mcode', label: 'MiniMax Code', bin: 'mcode', install: 'npm install -g @minimax-ai/code',
    auth: 'account', approvals: 'per-call', homepage: 'https://github.com/MiniMax-AI/minimax-code',
    note: '用 MiniMax 账号登录（国内账号；海外账号请在终端运行 mcode login --region global）。通过 ACP 协议对接，操作前会征求确认。',
  },
  dsh: {
    id: 'dsh', label: 'DeepSeek Harness', bin: 'dsh', install: '安装 DeepSeek Harness 桌面版（自带 dsh 命令）',
    auth: 'account', approvals: 'sandbox', homepage: 'https://www.npmjs.com/package/@deepseek-ai/dsh',
    note: '用 DeepSeek 账号登录（在 DeepSeek Harness 桌面版里登录一次即可）。无头模式按它自己的权限配置执行，不能逐项确认。',
  },
  'claude-compat': {
    id: 'claude-compat', label: 'Claude Code（兼容端点）', bin: 'claude', install: 'npm install -g @anthropic-ai/claude-code',
    auth: 'key', approvals: 'per-call', homepage: 'https://code.claude.com/docs/',
    note: '用这家的 API Key 驱动 Claude Code（厂商官方提供的 Anthropic 兼容端点）。登录信息与你自己的 Claude Code 分开保存；写文件、执行命令前会征求确认。',
  },
};

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'claude', name: 'Claude', vendor: 'Anthropic', glyph: 'C', protocol: 'anthropic',
    regions: [{ id: 'global', label: '官方', baseUrl: 'https://api.anthropic.com' }],
    models: [{ id: 'claude-sonnet-5-5', note: '均衡', ctx: 1_000_000 }, { id: 'claude-opus-5-5', note: '更强', ctx: 1_000_000 }, { id: 'claude-fable-5-1', note: '旗舰', ctx: 1_000_000 }, { id: 'claude-haiku-5-5', note: '快速', ctx: 1_000_000 }],
    cliModels: { 'claude-code': [{ id: '', note: 'Claude Code 默认' }, { id: 'sonnet[1m]', note: '1M 上下文' }, { id: 'opus[1m]', note: '1M 上下文' }, { id: 'claude-fable-5-1[1m]', note: '1M 上下文' }, { id: 'haiku' }] },
    keyUrl: 'https://platform.claude.com/settings/keys', keyHelp: '在 Claude 开发者平台的 API Keys 页面创建，以 sk-ant- 开头。',
    drivers: ['claude-code'],
  },
  {
    id: 'gpt', name: 'GPT', vendor: 'OpenAI', glyph: 'G', protocol: 'openai',
    regions: [{ id: 'global', label: '官方', baseUrl: 'https://api.openai.com/v1' }],
    models: [{ id: 'gpt-6.1-sol', note: '均衡', ctx: 1_050_000 }, { id: 'gpt-6-astra', note: '旗舰', ctx: 1_050_000 }, { id: 'gpt-6-luna', note: '快速', ctx: 1_050_000 }],
    cliModels: { codex: [{ id: '', note: 'Codex 默认' }, { id: 'gpt-6.1-sol' }, { id: 'gpt-6-astra' }, { id: 'gpt-6-luna' }] },
    keyUrl: 'https://platform.openai.com/api-keys', keyHelp: '在 OpenAI Platform 的 API keys 页面创建，以 sk- 开头。',
    drivers: ['codex'],
  },
  {
    id: 'deepseek', name: 'DeepSeek', vendor: '深度求索', glyph: 'D', protocol: 'openai',
    regions: [{ id: 'cn', label: '官方', baseUrl: 'https://api.deepseek.com', compatUrl: 'https://api.deepseek.com/anthropic' }],
    models: [{ id: 'deepseek-flash', note: 'V4.1 Flash', ctx: 1_000_000 }, { id: 'deepseek-v4-pro', note: 'V4 Pro' }],
    cliModels: { dsh: [{ id: 'deepseek-flash', note: 'DSH 默认' }, { id: 'deepseek-v4-pro' }], 'claude-compat': [{ id: 'deepseek-flash', ctx: 1_000_000 }, { id: 'deepseek-v4-pro' }] },
    keyUrl: 'https://platform.deepseek.com/api_keys', keyHelp: '在 DeepSeek 开放平台的 API keys 页面创建。',
    drivers: ['dsh', 'claude-compat'],
  },
  {
    id: 'kimi', name: 'Kimi', vendor: '月之暗面 Moonshot', glyph: 'K', protocol: 'openai',
    regions: [
      { id: 'cn', label: '国内', baseUrl: 'https://api.moonshot.cn/v1', compatUrl: 'https://api.moonshot.cn/anthropic' },
      { id: 'global', label: '国际', baseUrl: 'https://api.moonshot.ai/v1', compatUrl: 'https://api.moonshot.ai/anthropic' },
    ],
    models: [{ id: 'kimi-k3', note: '旗舰', ctx: 1_000_000 }, { id: 'kimi-k2.7-code', note: '编程', ctx: 256_000 }, { id: 'kimi-k2.7-code-highspeed', note: '快速编程', ctx: 256_000 }, { id: 'kimi-k2.6', ctx: 256_000 }],
    cliModels: { kimi: [{ id: '', note: 'Kimi Code 默认' }], 'claude-compat': [{ id: 'kimi-k3', ctx: 1_000_000 }, { id: 'kimi-k2.7-code', ctx: 256_000 }, { id: 'kimi-k2.7-code-highspeed', ctx: 256_000 }] },
    keyUrl: 'https://platform.kimi.com/console/api-keys', keyHelp: '在 Kimi 开放平台的 API Keys 页面创建；国内、国际站的密钥不通用。',
    drivers: ['kimi', 'claude-compat'],
  },
  {
    id: 'qwen', name: 'Qwen', vendor: '阿里云 通义千问', glyph: 'Q', protocol: 'openai',
    regions: [
      { id: 'cn', label: '国内（按量）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', compatUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' },
      { id: 'global', label: '国际（按量）', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
      { id: 'coding', label: 'Coding Plan', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', compatUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic' },
    ],
    models: [{ id: 'qwen3.7-plus', note: '均衡 · Coding Plan 可用' }, { id: 'qwen3.8-max', note: '旗舰' }, { id: 'qwen3.8-flash', note: '快速' }],
    cliModels: { qwen: [{ id: 'qwen3.7-plus' }, { id: 'qwen3.8-max' }], 'claude-compat': [{ id: 'qwen3.7-plus' }, { id: 'qwen3.8-max' }] },
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key', keyHelp: '在阿里云百炼的 API Key 页面创建，以 sk- 开头；密钥按地域独立，Coding Plan 有自己的密钥。',
    drivers: ['qwen', 'claude-compat'],
  },
  {
    id: 'glm', name: 'GLM', vendor: '智谱 Z.ai', glyph: 'Z', protocol: 'openai',
    regions: [
      { id: 'cn', label: '国内', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', compatUrl: 'https://open.bigmodel.cn/api/anthropic' },
      { id: 'global', label: '国际（Z.ai）', baseUrl: 'https://api.z.ai/api/paas/v4', compatUrl: 'https://api.z.ai/api/anthropic' },
      { id: 'coding', label: 'Coding Plan', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', compatUrl: 'https://open.bigmodel.cn/api/anthropic' },
    ],
    models: [{ id: 'glm-5.3', note: '旗舰', ctx: 1_000_000 }, { id: 'glm-5.3-flash', note: '快速', ctx: 1_000_000 }],
    cliModels: { 'claude-compat': [{ id: 'glm-5.3', ctx: 1_000_000 }, { id: 'glm-5.3-flash', ctx: 1_000_000 }] },
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', keyHelp: '在智谱开放平台的 API Keys 页面创建；GLM Coding Plan、标准 API 的密钥互不通用，国际站在 z.ai 创建。',
    drivers: ['claude-compat'],
  },
  {
    id: 'minimax', name: 'MiniMax', vendor: 'MiniMax 稀宇', glyph: 'M', protocol: 'openai',
    regions: [
      { id: 'cn', label: '国内', baseUrl: 'https://api.minimax.cn/v1', compatUrl: 'https://api.minimax.cn/anthropic' },
      { id: 'global', label: '国际', baseUrl: 'https://api.minimax.io/v1', compatUrl: 'https://api.minimax.io/anthropic' },
    ],
    models: [{ id: 'MiniMax-M3', note: '旗舰', ctx: 1_000_000 }, { id: 'MiniMax-M2.7', note: '均衡' }, { id: 'MiniMax-M2.7-highspeed', note: '快速' }, { id: 'MiniMax-M2.5', note: '编程' }],
    cliModels: { mcode: [{ id: '', note: 'MiniMax Code 默认' }], 'claude-compat': [{ id: 'MiniMax-M3', ctx: 1_000_000 }, { id: 'MiniMax-M2.5' }] },
    keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key', keyHelp: '在 MiniMax 开放平台的接口密钥页面创建；国际站在 platform.minimax.io。',
    drivers: ['mcode', 'claude-compat'],
  },
  {
    id: 'doubao', name: '豆包', vendor: '字节跳动 火山方舟', glyph: '豆', protocol: 'openai',
    regions: [
      { id: 'cn', label: '按量（北京）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
      { id: 'coding', label: 'Coding Plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', compatUrl: 'https://ark.cn-beijing.volces.com/api/coding' },
    ],
    models: [{ id: 'doubao-seed-2-1-pro-260915', note: '旗舰', ctx: 1_000_000 }, { id: 'doubao-seed-2-1-lite-260915', note: '快速', ctx: 1_000_000 }, { id: 'doubao-seed-evolving', note: '编程 · 最新' }],
    cliModels: { 'claude-compat': [{ id: 'doubao-seed-evolving' }, { id: 'doubao-seed-2.1-pro', ctx: 1_000_000 }, { id: 'ark-code-latest', note: '控制台里切换' }] },
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', keyHelp: '在火山方舟控制台的 API Key 管理页创建，并在「开通管理」里开通要用的模型。用 Coding Plan 订阅时请选「Coding Plan」，按量地址不消耗套餐额度。',
    drivers: ['claude-compat'],
  },
];

export const PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p])) as Record<ProviderId, ProviderInfo>;

export function defaultProviderConfig(p: ProviderInfo): ProviderConfig {
  const driver = p.drivers[0];
  return {
    id: p.id,
    auth: 'api',
    driver,
    region: p.regions[0].id,
    baseUrl: '',
    model: p.models[0].id,
    cliModel: p.cliModels[driver]?.[0]?.id ?? '',
    cliPath: '',
  };
}

/** Context window of a model: documented value, else 1M (this generation's usual size). */
export const DEFAULT_CONTEXT = 1_000_000;
export function contextOf(p: ProviderInfo, model: string): { tokens: number; known: boolean } {
  const id = model.replace(/\[1m\]$/i, '');
  const all = [...p.models, ...Object.values(p.cliModels).flat()].filter((m): m is ModelOption => !!m);
  const hit = all.find((m) => m.id === id || m.id === model);
  if (model.endsWith('[1m]')) return { tokens: DEFAULT_CONTEXT, known: true };
  return hit?.ctx ? { tokens: hit.ctx, known: true } : { tokens: DEFAULT_CONTEXT, known: false };
}

export const regionOf = (p: ProviderInfo, cfg: Pick<ProviderConfig, 'region'>) => p.regions.find((r) => r.id === cfg.region) ?? p.regions[0];
export const apiBaseUrl = (p: ProviderInfo, cfg: ProviderConfig) => cfg.baseUrl.trim() || regionOf(p, cfg).baseUrl;

/** Is this way of using the vendor set up? (A passing test is not required — just the ingredients.) */
export function readiness(p: ProviderInfo, cfg: ProviderConfig, auth: 'api' | 'cli'): { ready: boolean; reason?: string } {
  if (auth === 'api') return cfg.keyHint ? { ready: true } : { ready: false, reason: '还没有保存 API Key' };
  const d = DRIVERS[cfg.driver];
  if (!p.drivers.includes(cfg.driver)) return { ready: false, reason: '请选择命令行工具' };
  if (!cfg.cli) return { ready: false, reason: `还没有检测 ${d.label}` };
  if (!cfg.cli.found) return { ready: false, reason: `没有找到 ${d.bin} 命令` };
  if (d.auth === 'key' && !cfg.keyHint) return { ready: false, reason: `${d.label} 需要这家的 API Key` };
  if (cfg.driver === 'claude-compat' && !regionOf(p, cfg).compatUrl) {
    const alt = p.regions.find((r) => r.compatUrl);
    return { ready: false, reason: alt ? `「${regionOf(p, cfg).label}」没有 Claude Code 兼容端点，请把服务地区切到「${alt.label}」` : '这家没有 Claude Code 兼容端点' };
  }
  if (d.auth === 'account' && cfg.cli.login === 'no') return { ready: false, reason: `${d.label} 还没有登录` };
  return { ready: true };
}

export function engineLabel(p: ProviderInfo, auth: 'api' | 'cli', driver: DriverId | undefined, model: string) {
  const how = auth === 'api' ? 'API' : DRIVERS[driver ?? p.drivers[0]].label;
  return `${p.name} · ${how}${model ? ` · ${model}` : ''}`;
}

/** CLI tool names → the workbench's tool categories (for icons, policies and approvals). */
export function toolCategory(name: string, input?: Record<string, unknown>): import('./types').ToolId {
  const n = name.toLowerCase();
  const cmd = typeof input?.command === 'string' ? input.command.trim() : '';
  // firefly-browser tools: mcp__firefly-browser__browser_click (Claude Code), firefly_browser.browser_click (Codex)…
  // Going to a new address (navigate, back) can reach a signed-in site or carry data out: it is an action.
  const b = n.match(/browser_(navigate|snapshot|scroll|back|screenshot|wait|click|type|press)/);
  if (b) return ['click', 'type', 'press', 'navigate', 'back'].includes(b[1]) ? 'browser_act' : 'browser_read';
  // A command is git only when it is nothing but git: `git status; curl …` is a shell command.
  if (/^(bash|powershell|shell|execute|run_shell_command|exec_command|local_shell)$/.test(n)) return /^git(\s|$)/.test(cmd) && !/[;&|<>`$\n\r]/.test(cmd) ? 'git' : 'shell';
  if (/^(read|notebookread|read_file|read_many_files)$/.test(n)) return 'read_file';
  if (/^(write|edit|multiedit|notebookedit|apply_patch|write_file|replace|edit_file)$/.test(n)) return 'write_file';
  if (/^(grep|glob|ls|search|code_search|list_directory|search_file_content|find)$/.test(n)) return 'code_search';
  if (/^(websearch|web_search|google_web_search)$/.test(n)) return 'web_search';
  if (/^(webfetch|web_fetch|fetch)$/.test(n)) return 'web_fetch';
  return 'other';
}

/** Claude Code tool names for each workbench tool, used to build --allowedTools / --disallowedTools. */
export const CLAUDE_TOOLS: Record<import('./types').ToolId, string[]> = {
  read_file: ['Read', 'NotebookRead'],
  write_file: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  shell: ['Bash', 'PowerShell'],
  code_search: ['Grep', 'Glob', 'LS'],
  web_search: ['WebSearch'],
  web_fetch: ['WebFetch'],
  git: ['Bash(git:*)', 'PowerShell(git:*)'],
  browser_read: ['browser_snapshot', 'browser_scroll', 'browser_screenshot', 'browser_wait'].map((t) => `mcp__firefly-browser__${t}`),
  browser_act: ['browser_navigate', 'browser_back', 'browser_click', 'browser_type', 'browser_press'].map((t) => `mcp__firefly-browser__${t}`),
  other: [],
};

/** Interactive Claude Code tools that make no sense when nobody is at its prompt. */
export const CLAUDE_HEADLESS_DENY = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'RemoteTrigger'];
