/* The Agent page's view model: one Member per agent (name, state, model, pose, the lines she says),
   built once in AgentsView from the store and handed to the chart, the matrix and the drawer. */
import { Ban } from 'lucide-react';
import { EFFORT_LABEL, type Effort } from '../../../lib/effort';
import { crewLine, crewPose, crewTitle, leadLine, PERSONA, type CrewPose, type CrewState } from '../../../lib/persona';
import { crewState } from '../../../lib/formation';
import { PROVIDER_BY_ID, engineLabel } from '../../../lib/providers';
import { AGENT_ACTIVITY, type StatusMeta } from '../../../lib/status';
import type { Agent, AgentActivity, AgentEngine, AgentId, ModelState, ProviderId, ToolDef, ToolId, VisualMode } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { choiceEfforts, engineChoices } from '../../../state/models';
import type { CallStat, Dict, LastError, Presence } from '../config/util';

/** The PV credit, word for word as the boot screen writes it. */
export const PV_CREDIT = '画面：《崩坏：星穹铁道》流萤角色 PV「壳中萤火」© HoYoverse';

const DISABLED_META: StatusMeta = { label: '已停用', tone: 'neutral', icon: Ban };

/** Public URL of a file under public/ (the app can be served from a sub-path). */
export const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`;

/** 「Claude Sonnet 5.5 · Claude Code」: the engine as saved on the agent, whether or not its way is ready any more. */
export function engineText(models: ModelState, e: AgentEngine) {
  const [provider, auth] = e.key.split(':');
  const p = PROVIDER_BY_ID[provider as ProviderId];
  if (!p) return e.key;
  return engineLabel(p, auth === 'api' ? 'api' : 'cli', auth === 'api' ? undefined : models.providers[p.id].driver, e.model);
}

export interface ModelLine {
  /** follow: the task's model; own: its own, ready; broken: its own, but that way is not ready. */
  kind: 'follow' | 'own' | 'broken';
  text: string;
  /** 强度 label, only for `own` with a level set that the model still offers. */
  effort?: string;
  /** Levels the chosen model offers (empty = cannot be tuned). */
  levels: Effort[];
}

function modelLineOf(models: ModelState, agent: Agent): ModelLine {
  const e = agent.engine;
  if (agent.id === 'orchestrator' || !e) return { kind: 'follow', text: '跟随任务', levels: [] };
  const choice = engineChoices(models).find((c) => c.key === e.key);
  if (!choice) return { kind: 'broken', text: engineText(models, e), levels: [] };
  const levels = choiceEfforts(models, choice, e.model);
  return { kind: 'own', text: engineText(models, e), effort: e.effort && levels.includes(e.effort) ? EFFORT_LABEL[e.effort] : undefined, levels };
}

/** What a trail between the lead and a member looks like. */
export type TrailState = 'dormant' | 'off' | 'idle' | 'thinking' | 'tool' | 'waiting' | 'paused';

export interface Member {
  agent: Agent;
  id: AgentId;
  lead: boolean;
  /** 「检索」「编码」「审查」 / the lead's name: for sentences that name a member. */
  short: string;
  name: string;
  /** Role title (寻光者 …); empty when the persona is off. */
  title: string;
  state: CrewState;
  /** What the agent is doing in an open run (idle when nothing). */
  activity: AgentActivity;
  /** The status chip: 已停用 for a disabled agent, else the activity. */
  meta: StatusMeta;
  trail: TrailState;
  stat: CallStat;
  presence?: Presence;
  model: ModelLine;
  toolsOn: number;
  pose: CrewPose;
  /** What she says about it on the chart (for the lead: about the whole formation). */
  quote: string;
  /** What she says in the drawer (for the lead: about her own post). */
  drawerLine: string;
  /** One plain line about what it is doing. */
  now: string;
  lastError?: LastError;
}

export interface Crew {
  mode: VisualMode;
  persona: boolean;
  first: boolean;
  members: Member[];
  lead: Member;
  tools: ToolDef[];
  /** How many of `tools` can be set per agent (the n/N in 「工具 n/N」). */
  toolTotal: number;
}

/** 其他工具 is not limited per agent at run time (only by its policy on 工具与技能), so it has no per-agent switch. */
export const followsPolicyOnly = (id: ToolId) => id === 'other';

const SHORT: Record<AgentId, string> = { orchestrator: '编排', researcher: '检索', coder: '编码', reviewer: '审查' };
const BLANK: CallStat = { steps: 0, calls: 0, errors: 0 };

interface CrewInput {
  mode: VisualMode;
  persona: boolean;
  first: boolean;
  agents: Agent[];
  tools: ToolDef[];
  models: ModelState;
  stats: Dict<CallStat>;
  presence: Dict<Presence>;
  errors: Dict<LastError>;
}

export function buildCrew(i: CrewInput): Crew {
  const { mode, persona, first } = i;
  const leadAgent = i.agents.find((a) => a.id === 'orchestrator') ?? i.agents[0];
  const leadName = persona ? PERSONA[mode].name : leadAgent.name;

  const members: Member[] = i.agents.map((agent) => {
    const id = agent.id;
    const lead = id === 'orchestrator';
    const presence = i.presence[id];
    const stat = i.stats[id] ?? BLANK;
    const activity: AgentActivity = first ? 'idle' : presence?.activity ?? 'idle';
    const state = crewState(agent.enabled, activity, first);
    const trail: TrailState = state === 'first' ? 'dormant' : state === 'off' ? 'off' : (state as TrailState);
    const name = lead ? leadName : agent.name;
    // First use shows no live line, and a stopped agent never claims its current step finishes.
    const now = !agent.enabled ? (presence && !first ? `新的步骤交给${leadName}` : `它的步骤交给${leadName}`)
      : !first && presence?.text ? presence.text
        : stat.steps + stat.calls > 0 ? '待命' : '还没有参与过任务';
    const line = !persona ? agent.role : lead ? '' : crewLine(mode, id, state);
    return {
      agent, id, lead, short: lead ? leadName : SHORT[id], name,
      title: persona ? crewTitle(mode, id) : '',
      state, activity,
      meta: agent.enabled ? AGENT_ACTIVITY[activity] : DISABLED_META,
      trail, stat, presence,
      model: modelLineOf(i.models, agent),
      // Usable = switched on for this agent and not disabled on 工具与技能; saved 'other' is harmless but not counted.
      toolsOn: agent.tools.filter((t) => !followsPolicyOnly(t) && i.tools.find((d) => d.id === t)?.permission !== 'off').length,
      pose: crewPose(id, state, stat.steps),
      quote: line, drawerLine: line, now,
      lastError: i.errors[id],
    };
  });

  const lead = members.find((m) => m.lead) ?? members[0];
  // What she says about the whole formation: name a member that waits, one that is busy, one in trouble.
  const crew = members.filter((m) => !m.lead && m.agent.enabled);
  const waiting = crew.find((m) => m.activity === 'waiting');
  const busy = crew.find((m) => m.activity === 'thinking' || m.activity === 'tool');
  const troubled = crew.find((m) => m.lastError?.open);
  const paused = crew.find((m) => m.activity === 'paused');
  // One voice at a time: the card and the orchestrator's drawer say the same line.
  if (persona) lead.quote = lead.drawerLine = leadLine(mode, { first, activity: lead.activity, waiting: waiting?.short, busy: busy?.short, troubled: troubled?.short, paused: paused?.short, alone: crew.length === 0 });

  return { mode, persona, first, members, lead, tools: i.tools, toolTotal: i.tools.filter((t) => !followsPolicyOnly(t.id)).length };
}

/** Switch one tool on or off for an agent. */
export function toggleTool(agent: Agent, tools: ToolDef[], id: ToolId) {
  actions.setAgentTools(agent.id, tools.map((t) => t.id).filter((x) => (x === id ? !agent.tools.includes(id) : agent.tools.includes(x))));
}
