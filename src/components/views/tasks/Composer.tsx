/* 新建 on the home page: one centered message box, like Claude / ChatGPT / DeepSeek / Cyrene.
   The chips under the text pick 闲聊 or 工作, the model, and — for a CLI agent at work — the folder and
   permissions (or, for API / 演示, which agents take part). Enter starts it. */
import { FolderOpen, Globe, Hammer, MessageCircle, Shield, Sparkles, Users, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { desktop } from '../../../lib/desktop';
import { PERSONA } from '../../../lib/persona';
import { DRIVERS } from '../../../lib/providers';
import type { AgentId, AppState, TaskKind, WorkAccess } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { engineChoices, engineFromChoice, type EngineChoice } from '../../../state/models';
import { skillsForKind } from '../../../state/skills';
import { shallow, useApp } from '../../../state/store';
import { AgentAvatar, Segmented, cx } from '../../ui';
import { ModelChips, type ModelPick } from '../../workspace/ModelChips';
import { ChipSelect, PromptBox } from '../../workspace/PromptBox';

const TITLE_CLIP = 24;

/** First line of the text, cut to ~24 characters: the task's name. */
function deriveTitle(text: string) {
  const first = text.split('\n')[0].trim();
  const chars = Array.from(first);
  return chars.length > TITLE_CLIP ? `${chars.slice(0, TITLE_CLIP).join('')}…` : first;
}

const selectComposerFocus = (s: AppState) => (s.focusRequest?.target === 'composer' ? s.focusRequest.at : 0);
const selectChoices = (s: AppState) => engineChoices(s.models);
const sameChoices = (a: EngineChoice[], b: EngineChoice[]) => a.length === b.length && a.every((c, i) => c.key === b[i].key && c.label === b[i].label && c.tested === b[i].tested);

const KIND_OPTIONS: Array<{ value: TaskKind; label: string; icon: typeof MessageCircle; hint: string }> = [
  { value: 'chat', label: '闲聊', icon: MessageCircle, hint: '随便聊聊，不动文件也不执行命令' },
  { value: 'work', label: '工作', icon: Hammer, hint: '交给 Agent 一个目标：制定计划、调用工具、关键操作前征求确认' },
];

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function Composer() {
  const agents = useApp((s) => s.agents);
  const focusAt = useApp(selectComposerFocus);
  const choices = useApp(selectChoices, sameChoices);
  const { def, desktopOk } = useApp((s) => ({ def: s.models.defaultEngine, desktopOk: s.models.desktop }), shallow);
  const { mode, personaOn } = useApp((s) => ({ mode: s.settings.mode, personaOn: s.settings.persona }), shallow);

  const [kind, setKind] = useState<TaskKind>('chat');
  const [text, setText] = useState('');
  const [override, setOverride] = useState<AgentId[] | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [engineKey, setEngineKey] = useState('');
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<ModelPick['effort']>(undefined);
  const [skillsOff, setSkillsOff] = useState<string[]>([]);
  const [browserOn, setBrowserOn] = useState(false);
  const skillList = useApp((s) => s.skills?.list);
  const [folder, setFolder] = useState('');
  const [access, setAccess] = useState<WorkAccess>('policy');
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const base = useId();
  const errId = `${base}-err`;

  useEffect(() => {
    if (focusAt && Date.now() - focusAt < 2000) textRef.current?.focus();
  }, [focusAt]);

  const defaultKey = useMemo(() => (def === 'demo' ? 'demo' : choices.find((c) => c.provider === def)?.key ?? 'demo'), [choices, def]);
  const key = engineKey && (engineKey === 'demo' || choices.some((c) => c.key === engineKey)) ? engineKey : defaultKey;
  const choice = choices.find((c) => c.key === key);
  const model = pickedModel ?? choice?.model ?? '';
  const cli = choice?.auth === 'cli';
  const driver = cli && choice?.driver ? DRIVERS[choice.driver] : undefined;
  const who = personaOn ? PERSONA[mode].name : '编排 Agent';

  const offeredSkills = choice ? skillsForKind(skillList, kind) : [];
  const canBrowse = !!cli && choice?.driver !== 'dsh';
  const enabled = agents.filter((a) => a.enabled).map((a) => a.id);
  const chosen = new Set<AgentId>([...(override ?? enabled), 'orchestrator']);
  const agentIds = cli ? (['orchestrator'] as AgentId[]) : agents.filter((a) => a.id === 'orchestrator' || (a.enabled && chosen.has(a.id))).map((a) => a.id);

  const submit = async () => {
    const trimmed = text.trim();
    if (kind === 'work' && !trimmed) { setInvalid(true); textRef.current?.focus(); return; }
    setBusy(true);
    try {
      let engine;
      if (choice) {
        let cwd: string | undefined;
        if (choice.auth === 'cli') {
          // Minute precision alone would put two tasks started in the same minute in one folder.
          const slug = `${kind}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`;
          cwd = kind === 'work' && folder ? folder : await desktop!.workspaceFolder(slug);
        }
        engine = engineFromChoice(choice, { cwd, access: kind === 'work' ? access : undefined, model, effort, browser: kind === 'work' && canBrowse && browserOn && access !== 'read' });
      }
      const title = kind === 'chat' ? (trimmed ? deriveTitle(trimmed) : `和${who}的闲聊`) : deriveTitle(trimmed);
      const off = offeredSkills.filter((x) => skillsOff.includes(x.folder));
      const skills = off.length ? offeredSkills.filter((x) => !skillsOff.includes(x.folder)).map((x) => x.folder) : undefined;
      actions.createTask({ title, goal: trimmed, kind, engine, scenarioId: 'general', agentIds, start: true, skills });
    } finally {
      setBusy(false);
    }
  };

  const hint = !choice
    ? (choices.length ? '演示模式：回复和执行过程都是模拟的。' : desktopOk ? '还没有接入模型：现在是演示模式，回复和执行都是模拟的。' : '浏览器开发版只能用演示模式。')
    : choice.auth === 'api'
      ? (kind === 'work' ? 'API 方式只思考和写作，不会读写你的文件、不会执行命令；要动手请选命令行方式。' : `通过 ${choice.label.split(" · ").slice(0, 2).join(" · ")}${model ? ` · ${model}` : ""} 对话。`)
      : kind === 'work'
        ? `${driver?.label} 会在工作文件夹里读写文件、执行命令${driver?.approvals === 'per-call' ? '，需要确认的操作会先问你' : '，它的无头模式不能逐项确认，按沙箱策略执行'}。`
        : `通过 ${driver?.label} 聊天，不会动文件。`;

  const chips = (
    <>
      <Segmented<TaskKind> size="sm" className="pchip-seg" label="类型" options={KIND_OPTIONS} value={kind} onChange={(v) => { setKind(v); setInvalid(false); }} />
      <ModelChips pick={{ key, model, effort }} onPick={(p) => { setEngineKey(p.key); setPickedModel(p.key === 'demo' ? null : p.model); setEffort(p.effort); }} />
      {kind === 'work' && cli && (
        <span className="pchip pchip--folder" title={folder || '自动新建一个独立文件夹'}>
          <FolderOpen size={13} aria-hidden />
          <button type="button" onClick={async () => { const d = await desktop?.pickFolder(folder || undefined); if (d) setFolder(d); }}>
            {folder ? baseName(folder) : '独立文件夹'}
          </button>
          {folder && <button type="button" className="pchip__x" aria-label="改用独立文件夹" onClick={() => setFolder('')}><X size={11} aria-hidden /></button>}
        </span>
      )}
      {kind === 'work' && cli && (
        <ChipSelect<WorkAccess> icon={Shield} label="权限" value={access} onChange={setAccess}
          title={access === 'read' ? '只能读取和搜索' : '按「工具与连接」里的策略'}
          options={[{ value: 'policy', label: '按工具策略' }, { value: 'read', label: '只读' }]} />
      )}
      {kind === 'work' && !cli && <AgentsChip ids={agentIds} onToggle={(id, on) => setOverride(on ? [...agentIds, id] : agentIds.filter((x) => x !== id))} />}
      {kind === 'work' && canBrowse && access !== 'read' && (
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
    <div className="home-composer">
      <PromptBox
        variant="home"
        id={`${base}-text`}
        value={text}
        onChange={(v) => { setText(v); if (invalid && v.trim()) setInvalid(false); }}
        onSubmit={() => void submit()}
        inputRef={textRef}
        label={kind === 'chat' ? `和${who}聊天` : `交给${who}的任务`}
        placeholder={kind === 'chat' ? `和${who}聊点什么…` : `交给${who}一个目标，例如：给 utils 目录补上单元测试，并修好失败的用例`}
        allowEmpty
        sending={busy}
        invalid={invalid}
        describedBy={invalid ? errId : undefined}
        chips={chips}
        hint={invalid ? <span className="pbox__err" id={errId} role="alert">先描述一个目标，Agent 才知道要做什么。</span> : <span className={cx(choice && 'is-live')}>{hint}</span>}
      />
    </div>
  );
}

/** 技能: which installed skills this task may use (all enabled ones by default). */
function SkillsChip({ skills, off, onToggle }: { skills: Array<{ folder: string; name: string; description: string }>; off: string[]; onToggle: (folder: string, on: boolean) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const on = skills.filter((s) => !off.includes(s.folder)).length;
  return (
    <details ref={ref} className="pchip pchip--menu" onKeyDown={(e) => { if (e.key === 'Escape' && ref.current) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); } }}>
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

/** 参与的 Agent: a small menu of checkboxes (API and 演示 work only — a CLI agent works alone). */
function AgentsChip({ ids, onToggle }: { ids: AgentId[]; onToggle: (id: AgentId, on: boolean) => void }) {
  const agents = useApp((s) => s.agents);
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <details ref={ref} className="pchip pchip--menu" onKeyDown={(e) => { if (e.key === 'Escape' && ref.current) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); } }}>
      <summary title="参与的 Agent"><Users size={13} aria-hidden />{ids.length} 个 Agent</summary>
      <div className="pchip__menu" role="group" aria-label="参与的 Agent">
        {agents.map((a) => {
          const required = a.id === 'orchestrator';
          return (
            <label key={a.id} className={cx('pchip__opt', !a.enabled && 'is-off')}>
              <input type="checkbox" checked={required || (a.enabled && ids.includes(a.id))} disabled={required || !a.enabled}
                onChange={(e) => onToggle(a.id, e.target.checked)} />
              <AgentAvatar agent={a} size="sm" />
              <span className="pchip__opt-text"><strong>{a.name}</strong><small>{required ? '必选 · ' : !a.enabled ? '已停用 · ' : ''}{a.role}</small></span>
            </label>
          );
        })}
      </div>
    </details>
  );
}
