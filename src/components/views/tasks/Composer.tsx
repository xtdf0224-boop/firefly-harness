/* 新建 on the home page: one centered message box, like Claude / ChatGPT / DeepSeek / Cyrene.
   The chips under the text pick 闲聊 or 工作, the model (with its version) and 推理强度, and — for work —
   which Agents take part, plus the folder, permissions and browser of every 工作 task (a command-line
   agent works in the folder with its own tools, an API model with the workbench's own). Enter starts
   it. Locked until a model is ready. */
import { Cpu, FolderOpen, Globe, Hammer, MessageCircle, Shield, Sparkles, Users, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { desktop } from '../../../lib/desktop';
import type { Effort } from '../../../lib/effort';
import { PERSONA } from '../../../lib/persona';
import { DRIVERS, PROVIDER_BY_ID, engineLabel } from '../../../lib/providers';
import type { Agent, AgentId, AppState, DriverId, ModelState, TaskEngine, TaskKind, WorkAccess } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { agentEngine, choiceEfforts, defaultChoice, engineFromChoice, type EngineChoice } from '../../../state/models';
import { skillsForKind } from '../../../state/skills';
import { shallow, useApp } from '../../../state/store';
import { AgentAvatar, Segmented, cx } from '../../ui';
import { MenuSelect } from '../../ui/MenuSelect';
import { ModelChips } from '../../workspace/ModelChips';
import { PromptBox } from '../../workspace/PromptBox';
import { useChoices, useModelsKnown } from './choices';

const TITLE_CLIP = 24;

/** First line of the text, cut to ~24 characters: the task's name. */
function deriveTitle(text: string) {
  const first = text.split('\n')[0].trim();
  const chars = Array.from(first);
  return chars.length > TITLE_CLIP ? `${chars.slice(0, TITLE_CLIP).join('')}…` : first;
}

const selectComposerFocus = (s: AppState) => (s.focusRequest?.target === 'composer' ? s.focusRequest.at : 0);

const KIND_OPTIONS: Array<{ value: TaskKind; label: string; icon: typeof MessageCircle; hint: string }> = [
  { value: 'chat', label: '闲聊', icon: MessageCircle, hint: '随便聊聊，不动文件也不执行命令' },
  { value: 'work', label: '工作', icon: Hammer, hint: '交给 Agent 一个目标：制定计划、调用工具、关键操作前征求确认' },
];

const ACCESS_OPTIONS: Array<{ value: WorkAccess; label: string; sub: string }> = [
  { value: 'policy', label: '按工具策略', sub: '按「工具与技能」里设置的策略执行' },
  { value: 'read', label: '只读', sub: '只读取和搜索（也可能联网），不写文件、不执行命令' },
];

/** What the box says a 工作 task will do. 只读 comes first: it also binds a command-line model and the command-line Agents (they run read-only).
 *  `apiAgent`: a command-line task where an Agent with an API model of its own takes part (it works with the workbench's tools). */
export function workHint(o: { cli: boolean; agentCli: boolean; apiAgent?: boolean; access: WorkAccess; driver?: Pick<(typeof DRIVERS)[DriverId], 'label' | 'approvals'> }) {
  // What an API model does in a read-only task (docs/API-TOOLS.md §4): web_search / web_fetch stay, by the tool policy.
  const apiReads = '读取和搜索工作文件夹里的内容（读工作文件夹和技能文件夹以外的位置会先问你），也可能联网搜索、抓取网页';
  const apiAgent = o.cli && o.apiAgent;
  if (o.access === 'read') {
    const rest = '不写文件、不执行命令；读到的内容会发给模型服务商。';
    if (o.cli) {
      const own = `只读：${o.driver?.label} 只读取和搜索工作文件夹里的内容，${rest}`;
      return apiAgent ? `${own}用 API 模型的 Agent 同样只读：${apiReads}，读到的内容发给它所用的服务商。` : own;
    }
    return o.agentCli ? `只读：API 模型${apiReads}；命令行模型的 Agent 也按只读运行；都${rest}` : `只读：API 模型${apiReads}；${rest}`;
  }
  if (o.cli) {
    const own = `${o.driver?.label} 会在工作文件夹里读写文件、执行命令${o.driver?.approvals === 'per-call' ? '，需要确认的操作会先问你' : '，它的无头模式不能逐项确认，按沙箱策略执行'}。`;
    return apiAgent ? `${own}用 API 模型的 Agent 用萤火自己的工具在同一个文件夹里读写文件、执行命令，需要确认的操作会先问你；它读到的内容发给它所用的服务商。` : own;
  }
  if (o.agentCli) return 'API 模型用萤火自己的工具、命令行模型的 Agent 用它自己的工具，都在工作文件夹里读写文件、执行命令；API 模型需要确认的操作会先问你，读到的内容会发给模型服务商；命令行 Agent 能不能逐项确认取决于它的工具（Codex、DeepSeek Harness 的无头模式不能）。';
  return 'API 模型用萤火自己的工具在工作文件夹里读写文件、执行命令、抓取网页；需要确认的操作会先问你，读到的内容会发给模型服务商。';
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** A way's default 推理强度 (set on 模型接入), when the chosen model accepts it. */
const startEffort = (m: ModelState, c: EngineChoice, model: string): Effort | undefined =>
  (c.effort && choiceEfforts(m, c, model).includes(c.effort) ? c.effort : undefined);

interface Picked { key: string; model: string; effort?: Effort }

export function Composer() {
  const agents = useApp((s) => s.agents);
  const focusAt = useApp(selectComposerFocus);
  const skillList = useApp((s) => s.skills?.list);
  const { mode, personaOn } = useApp((s) => ({ mode: s.settings.mode, personaOn: s.settings.persona }), shallow);
  const { models, choices } = useChoices();
  const known = useModelsKnown();

  const [kind, setKind] = useState<TaskKind>('chat');
  const [text, setText] = useState('');
  const [override, setOverride] = useState<AgentId[] | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [pick, setPick] = useState<Picked | null>(null);
  const [skillsOff, setSkillsOff] = useState<string[]>([]);
  const [browserOn, setBrowserOn] = useState(false);
  const [folder, setFolder] = useState('');
  const [access, setAccess] = useState<WorkAccess>('policy');
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const base = useId();
  const errId = `${base}-err`;

  useEffect(() => {
    if (focusAt && Date.now() - focusAt < 2000) textRef.current?.focus();
  }, [focusAt]);

  // Nothing picked yet (or the picked way is gone): start from the default vendor and the effort set on 模型接入.
  const picked = pick && choices.some((c) => c.key === pick.key) ? pick : null;
  const choice = picked ? choices.find((c) => c.key === picked.key) : defaultChoice(models, choices);
  const model = picked ? picked.model : choice?.model ?? '';
  const effort = picked ? picked.effort : choice ? startEffort(models, choice, model) : undefined;
  const cli = choice?.auth === 'cli';
  const driver = cli && choice?.driver ? DRIVERS[choice.driver] : undefined;
  const who = personaOn ? PERSONA[mode].name : '编排 Agent';
  const taskName = choice ? engineLabel(PROVIDER_BY_ID[choice.provider], choice.auth, choice.driver, model) : '';

  // Each Agent's own model, when it has one that is ready (the 编排 Agent always follows the task).
  const own = useMemo(() => new Map<AgentId, TaskEngine | undefined>(
    agents.filter((a) => a.id !== 'orchestrator').map((a): [AgentId, TaskEngine | undefined] => [a.id, agentEngine(models, a.engine, {})]),
  ), [agents, models]);

  // Over an API model every enabled Agent takes part; over a command-line agent only those with a model of their own do.
  const defaults = agents.filter((a) => a.id !== 'orchestrator' && a.enabled && (!cli || own.get(a.id))).map((a) => a.id);
  const wanted = override ?? defaults;
  const agentIds: AgentId[] = kind === 'work'
    ? agents.filter((a) => a.id === 'orchestrator' || (a.enabled && wanted.includes(a.id))).map((a) => a.id)
    : ['orchestrator'];

  const work = kind === 'work';
  // Command-line tools in play: the task's own model and/or an Agent's. A 闲聊 over one needs a folder for its session;
  // for a 工作 task every model gets a folder anyway (an API model works in it with the workbench's own tools).
  const cliDrivers = [
    cli ? choice?.driver : undefined,
    ...(work ? agentIds.map((id) => { const e = own.get(id); return e?.auth === 'cli' ? e.driver : undefined; }) : []),
  ].filter((d): d is DriverId => !!d);
  const cliInvolved = cliDrivers.length > 0;
  const agentCli = cliDrivers.length > (cli ? 1 : 0);
  // An API model (the task's own, or an Agent's) drives the browser through the workbench's tools; a command-line one needs a driver that takes MCP servers (not DeepSeek Harness).
  const apiInvolved = !cli || agentIds.some((id) => own.get(id)?.auth === 'api');
  const canBrowse = apiInvolved || cliDrivers.some((d) => d !== 'dsh');

  const offeredSkills = choice ? skillsForKind(skillList, kind) : [];

  const onPick = (p: Picked) => {
    const next = choices.find((c) => c.key === p.key);
    if (!next) return;
    // ModelChips already settles 推理强度 (kept if the model has it, else the new way's default).
    setPick(p);
    // The default cast differs between API and command-line models.
    if ((next.auth === 'cli') !== cli) setOverride(null);
  };

  const submit = async () => {
    if (!choice) return;
    const trimmed = text.trim();
    if (work && !trimmed) { setInvalid(true); textRef.current?.focus(); return; }
    setBusy(true);
    try {
      let cwd: string | undefined;
      if (work || cliInvolved) {
        // Minute precision alone would put two tasks started in the same minute in one folder.
        const slug = `${kind}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`;
        cwd = work && folder ? folder : await desktop?.workspaceFolder(slug);
      }
      const engine = engineFromChoice(choice, {
        cwd, access: work ? access : undefined, model, effort,
        browser: work && canBrowse && browserOn && access !== 'read',
      });
      const title = kind === 'chat' ? (trimmed ? deriveTitle(trimmed) : `和${who}的闲聊`) : deriveTitle(trimmed);
      const off = offeredSkills.filter((x) => skillsOff.includes(x.folder));
      const skills = off.length ? offeredSkills.filter((x) => !skillsOff.includes(x.folder)).map((x) => x.folder) : undefined;
      actions.createTask({ title, goal: trimmed, kind, engine, agentIds, start: true, skills });
    } catch (e) {
      actions.toast({ tone: 'danger', title: '没能新建', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const hint = !choice
    ? (known ? '先接入一个模型，才能开始。' : '正在读取模型接入…')
    : !work
      ? (cli ? `通过 ${taskName} 聊天，不会动文件。` : `通过 ${taskName} 对话。`)
      : workHint({ cli, agentCli, apiAgent: cli && apiInvolved, access, driver });

  const chips = (
    <>
      <Segmented<TaskKind> size="sm" className="pchip-seg" label="类型" options={KIND_OPTIONS} value={kind} onChange={(v) => { setKind(v); setInvalid(false); }} />
      {choice && <ModelChips pick={{ key: choice.key, model, effort }} onPick={onPick} />}
      {work && (
        <span className="pchip pchip--folder" title={folder || '自动新建一个独立文件夹'}>
          <FolderOpen size={13} aria-hidden />
          <button type="button" onClick={async () => { const d = await desktop?.pickFolder(folder || undefined); if (d) setFolder(d); }}>
            {folder ? baseName(folder) : '独立文件夹'}
          </button>
          {folder && <button type="button" className="pchip__x" aria-label="改用独立文件夹" onClick={() => setFolder('')}><X size={11} aria-hidden /></button>}
        </span>
      )}
      {work && (
        <MenuSelect<WorkAccess> variant="chip" icon={Shield} label="权限" value={access} onChange={setAccess} options={ACCESS_OPTIONS}
          title={access === 'read' ? '只能读取和搜索' : '按「工具与技能」里的策略'} />
      )}
      {work && <AgentsChip agents={agents} ids={agentIds} own={own} onToggle={(id, on) => setOverride(on ? [...wanted, id] : wanted.filter((x) => x !== id))} />}
      {work && canBrowse && access !== 'read' && (
        <button type="button" className={cx('pchip pchip--toggle', browserOn && 'is-on')} aria-pressed={browserOn}
          title={browserOn ? 'Agent 可以操作萤火浏览器（点击、输入会先征求确认）' : '让 Agent 可以操作萤火浏览器'} onClick={() => setBrowserOn((v) => !v)}>
          <Globe size={13} aria-hidden />浏览器{browserOn ? ' · 开' : ''}
        </button>
      )}
      {offeredSkills.length > 0 && (
        <SkillsChip skills={offeredSkills} off={skillsOff} onToggle={(f, on) => setSkillsOff((prev) => (on ? prev.filter((x) => x !== f) : [...prev, f]))} />
      )}
    </>
  );

  return (
    // A disabled fieldset locks every control inside it (text box, chips, send) until a model is ready.
    <fieldset className={cx('home-composer', !choice && 'is-locked')} disabled={!choice}>
      <PromptBox
        variant="home"
        id={`${base}-text`}
        value={text}
        onChange={(v) => { setText(v); if (invalid && v.trim()) setInvalid(false); }}
        onSubmit={() => void submit()}
        inputRef={textRef}
        label={kind === 'chat' ? `和${who}聊天` : `交给${who}的任务`}
        placeholder={!choice ? '先接入一个模型，才能聊天或交给 Agent 任务'
          : kind === 'chat' ? `和${who}聊点什么…` : `交给${who}一个目标，例如：给 utils 目录补上单元测试，并修好失败的用例`}
        allowEmpty
        sending={busy}
        invalid={invalid}
        describedBy={invalid ? errId : undefined}
        chips={chips}
        hint={invalid ? <span className="pbox__err" id={errId} role="alert">先描述一个目标，Agent 才知道要做什么。</span> : <span className={cx(choice && 'is-live')}>{hint}</span>}
      />
    </fieldset>
  );
}

/** A <details> chip menu: closes on an outside click, and on Esc with focus back on its summary. */
function useChipMenu() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDetailsElement>) => {
    if (e.key === 'Escape' && ref.current) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); }
  };
  return { ref, onKeyDown };
}

/** 技能: which installed skills this task may use (all enabled ones by default). */
function SkillsChip({ skills, off, onToggle }: { skills: Array<{ folder: string; name: string; description: string }>; off: string[]; onToggle: (folder: string, on: boolean) => void }) {
  const { ref, onKeyDown } = useChipMenu();
  const on = skills.filter((s) => !off.includes(s.folder)).length;
  return (
    <details ref={ref} className="pchip pchip--menu" onKeyDown={onKeyDown}>
      <summary title="这次可以用的技能"><Sparkles size={13} aria-hidden />技能 {on}/{skills.length}</summary>
      <div className="pchip__menu" role="group" aria-label="这次可以用的技能">
        {skills.map((s) => (
          <label key={s.folder} className="pchip__opt pchip__opt--skill">
            <input type="checkbox" checked={!off.includes(s.folder)} onChange={(e) => onToggle(s.folder, e.target.checked)} />
            <Sparkles size={14} aria-hidden />
            <span className="pchip__opt-text"><strong className="mono">{s.name}</strong><small>{s.description}</small></span>
          </label>
        ))}
      </div>
    </details>
  );
}

/** 参与的 Agent: a small menu of checkboxes. Each row says which model that Agent will use. */
function AgentsChip({ agents, ids, own, onToggle }: {
  agents: Agent[];
  ids: AgentId[];
  own: Map<AgentId, TaskEngine | undefined>;
  onToggle: (id: AgentId, on: boolean) => void;
}) {
  const { ref, onKeyDown } = useChipMenu();
  return (
    <details ref={ref} className="pchip pchip--menu" onKeyDown={onKeyDown}>
      <summary title="参与的 Agent"><Users size={13} aria-hidden />{ids.length} 个 Agent</summary>
      <div className="pchip__menu" role="group" aria-label="参与的 Agent">
        {agents.map((a) => {
          const required = a.id === 'orchestrator';
          const engine = own.get(a.id);
          return (
            <label key={a.id} className={cx('pchip__opt', !a.enabled && 'is-off')}>
              <input type="checkbox" checked={required || (a.enabled && ids.includes(a.id))} disabled={required || !a.enabled}
                onChange={(e) => onToggle(a.id, e.target.checked)} />
              <AgentAvatar agent={a} size="sm" />
              <span className="pchip__opt-text">
                <strong>{a.name}</strong>
                <small>{required ? '必选 · ' : !a.enabled ? '已停用 · ' : ''}{a.role}</small>
                {engine
                  ? <small className="pchip__opt-model is-own"><Cpu size={11} aria-hidden />{engine.label}</small>
                  : <small className="pchip__opt-model">{a.engine && !required ? '跟随任务（它选的模型现在用不了）' : '跟随任务'}</small>}
              </span>
            </label>
          );
        })}
      </div>
    </details>
  );
}
