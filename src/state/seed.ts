/* The starting point of a fresh install: default settings, the agent roster, tool policies and an
   empty task list. Nothing is made up — tasks, runs and models all come from what the user does. */
import type { Agent, AppState, Settings, ToolDef } from '../lib/types';
import { PERSONA } from '../lib/persona';
import { initialModels } from './models';

export const DEFAULT_SETTINGS: Settings = {
  mode: 'firefly',
  motion: 'system',
  particles: 'normal',
  themeCursor: true,
  confirmBeforeCancel: true,
  openConsoleOnError: true,
  closeToTray: true,
  wallpaper: true,
  wallpaperVisibility: 80,
  panelGlass: 65,
  wallpaperAdaptive: true,
  bootAnimation: true,
  bootEnter: 'click',
  persona: true,
  callName: '开拓者',
  typing: 'natural',
  lifeGreeting: true,
  lifeMood: true,
  lifeNudge: true,
};

export const AGENTS: Agent[] = [
  { id: 'orchestrator', name: '编排 Agent', role: '拆解目标、分派步骤、汇总结果', glyph: '编', hue: 'mint',
    description: '负责理解目标、制定计划并把步骤分派给其他 Agent，最后汇总产出。遇到需要确认的操作时会暂停并征求你的意见。',
    tools: ['read_file', 'code_search', 'web_search'], enabled: true },
  { id: 'researcher', name: '检索 Agent', role: '检索资料、抓取文档、整理对比', glyph: '检', hue: 'silver',
    description: '擅长检索网页与项目内容，整理资料并给出有依据的对比。',
    tools: ['web_search', 'web_fetch', 'read_file', 'code_search', 'browser_read', 'browser_act'], enabled: true },
  { id: 'coder', name: '编码 Agent', role: '阅读与修改代码、执行命令', glyph: '码', hue: 'firefly',
    description: '负责阅读代码、生成改动并在确认后写入文件或执行命令。',
    tools: ['read_file', 'write_file', 'code_search', 'shell', 'git'], enabled: true },
  { id: 'reviewer', name: '审查 Agent', role: '运行测试、复核结论', glyph: '审', hue: 'gold',
    description: '负责运行测试、检查产出质量，并指出缺少依据的结论。',
    tools: ['read_file', 'shell', 'code_search'], enabled: true },
];

export const TOOLS: ToolDef[] = [
  { id: 'read_file',   name: '读取文件', category: '文件',     risk: 'low',    permission: 'auto',    description: '读取工作区内的文件内容。' },
  { id: 'write_file',  name: '写入文件', category: '文件',     risk: 'medium', permission: 'confirm', description: '创建或修改工作区内的文件。' },
  { id: 'code_search', name: '代码搜索', category: '检索',     risk: 'low',    permission: 'auto',    description: '在项目中按关键字或正则搜索。' },
  { id: 'shell',       name: '执行命令', category: '执行',     risk: 'high',   permission: 'confirm', description: '在任务的工作文件夹里执行命令。' },
  { id: 'web_search',  name: '网页搜索', category: '网络',     risk: 'low',    permission: 'auto',    description: '通过搜索服务检索网页。' },
  { id: 'web_fetch',   name: '抓取网页', category: '网络',     risk: 'medium', permission: 'confirm', description: '下载网页并提取正文。' },
  { id: 'git',         name: 'Git 操作', category: '版本控制', risk: 'medium', permission: 'confirm', description: '查看状态、提交与切换分支。' },
  { id: 'browser_read', name: '浏览网页', category: '网络',     risk: 'low',    permission: 'auto',    description: '读取萤火浏览器当前页面、截图、滚动（只在开启「浏览器」的命令行任务里出现）。' },
  { id: 'browser_act',  name: '操作网页', category: '网络',     risk: 'medium', permission: 'confirm', description: '在萤火浏览器里打开网址、后退、点击、输入、按键——打开的可能是你已登录的网站，点击和输入可能提交表单或改动网站上的数据。' },
  { id: 'other',       name: '其他工具', category: '执行',     risk: 'medium', permission: 'confirm', description: '命令行 Agent 自带的其他工具（子任务、MCP 工具等）。' },
];

/** 编排 Agent takes 流萤's (or 萨姆's) name when the persona is on. */
export function syncPersonaAgent(d: { agents: Agent[]; settings: Settings }) {
  const o = d.agents.find((a) => a.id === 'orchestrator');
  if (!o) return;
  const p = d.settings.persona ? PERSONA[d.settings.mode] : undefined;
  o.name = p ? p.name : AGENTS[0].name;
  o.glyph = p ? p.glyph : AGENTS[0].glyph;
}

export function emptyState(_now: number, settings: Settings = DEFAULT_SETTINGS): AppState {
  const agents = AGENTS.map((a) => ({ ...a }));
  syncPersonaAgent({ agents, settings });
  return {
    view: 'new',
    workspaceTab: 'conversation',
    console: { open: false, tab: 'tools', height: 280 },
    statusDrawerOpen: false,
    navCollapsed: false,
    settings,
    tasks: {},
    taskOrder: [],
    runs: {},
    agents,
    tools: TOOLS,
    models: initialModels(),
    events: [],
    toasts: [],
    announcement: { text: '', at: 0 },
  };
}
