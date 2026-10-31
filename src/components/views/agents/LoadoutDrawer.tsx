/* 装备抽屉: everything one agent can be set to — enable, model, 推理强度, tools — in a drawer that slides over
   the page. A modal dialog: focus moves in, Tab stays inside (and a focus guard pulls back anything that
   gets out), Esc (an open menu first) or a click on the scrim closes it, and focus goes back to the button
   that opened it. The four members are tabs. */
import { ArrowUpRight, Check, Cpu, Gauge, Info, OctagonX, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Effort } from '../../../lib/effort';
import { focusMainHeading } from '../../../lib/focus';
import { PERMISSION } from '../../../lib/status';
import type { AgentId, ToolDef } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { choiceEfforts, engineChoices, menuValue, modelMenuGroups, parseMenuValue } from '../../../state/models';
import { useApp } from '../../../state/store';
import { Button, StatusChip, Switch, cx } from '../../ui';
import { MenuSelect } from '../../ui/MenuSelect';
import { PERM_ICON } from '../config/util';
import { asset, engineText, followsPolicyOnly, toggleTool, type Crew, type Member } from './crew';
import { EffortLadder } from './EffortLadder';
import { CrewOrb, PvCredit, PvStill } from './parts';
import { CLI_NOTE, DENIED_TIP, FOLLOW_TIP } from './ToolLoadout';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

/** What Tab can reach inside the dialog: the roving tabs and rungs that are parked at tabindex -1 are not stops. */
const tabStops = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);

export function LoadoutDrawer({ crew, id, onSelect, onClose }: { crew: Crew; id: AgentId; onSelect: (id: AgentId) => void; onClose: () => void }) {
  const m = crew.members.find((x) => x.id === id) ?? crew.lead;
  const titleId = useId();
  const uid = useId();
  const root = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const menuAtPress = useRef(false);
  const tabs = useRef<Partial<Record<AgentId, HTMLButtonElement | null>>>({});
  // Read while rendering: by the time effects run, the page behind is inert and has already dropped its focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const latest = useRef({ id, onClose });
  latest.current = { id, onClose };
  const tabId = (x: AgentId) => `${uid}-tab-${x}`;
  const panelId = `${uid}-panel`;

  // Focus moves in on open and goes back to the opener on close (or to the page heading if the opener is gone).
  // Esc is read on the document, so it works wherever focus is; an open menu stops it first. Focus that lands
  // outside the dialog (the menu's own list excepted) is pulled back to the selected tab.
  useEffect(() => {
    const prev = opener;
    close.current?.focus();
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) latest.current.onClose();
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as Element | null;
      if (!t || root.current?.contains(t) || t.closest?.('.mselect-pop')) return;
      (tabs.current[latest.current.id] ?? close.current)?.focus();
    };
    // A press that dismisses an open menu must not also close the drawer: note the menu before its own
    // capture handler (added later, when it opens) unmounts it; the scrim's click reads this.
    const onPress = () => { menuAtPress.current = !!document.querySelector('.mselect-pop'); };
    document.addEventListener('keydown', onEsc);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      document.removeEventListener('keydown', onEsc);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('pointerdown', onPress, true);
      if (prev && prev !== document.body && prev.isConnected) prev.focus?.();
      else focusMainHeading();
    };
  }, [opener]);

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Tab' || !root.current?.contains(e.target as Node)) return;
    const list = tabStops(root.current);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === root.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  };

  const onTabKey = (e: KeyboardEvent) => {
    const ids = crew.members.map((x) => x.id);
    const i = ids.indexOf(id);
    const next = e.key === 'ArrowRight' ? (i + 1) % ids.length : e.key === 'ArrowLeft' ? (i + ids.length - 1) % ids.length : e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onSelect(ids[next]);
    tabs.current[ids[next]]?.focus();
  };

  return (
    <>
      <div className="loadout-scrim" onClick={() => { if (menuAtPress.current) menuAtPress.current = false; else onClose(); }} aria-hidden />
      <aside ref={root} className="loadout-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-agent={m.id} data-state={m.trail} onKeyDown={onKey}>
        <div className="loadout-tabs" role="tablist" aria-label="编队成员" onKeyDown={onTabKey}>
          {crew.members.map((x) => (
            <button key={x.id} ref={(el) => { tabs.current[x.id] = el; }} type="button" role="tab" id={tabId(x.id)} className={cx('loadout-tab', x.id === id && 'is-on')}
              aria-selected={x.id === id} aria-controls={panelId} tabIndex={x.id === id ? 0 : -1} onClick={() => onSelect(x.id)}>
              <CrewOrb m={x} mode={crew.mode} size="xs" /><span>{x.short}</span>
            </button>
          ))}
        </div>
        <header className="loadout-head">
          <CrewOrb m={m} mode={crew.mode} size="lg" />
          <div className="loadout-head__id">
            <h2 id={titleId}>{m.name}{m.title && <span className="crew-tag">{m.lead ? '编排 · ' : ''}{m.title}</span>}</h2>
            <p>{m.agent.role}</p>
          </div>
          <StatusChip meta={m.meta} size="sm" />
          <button ref={close} type="button" className="icon-btn icon-btn--md icon-btn--ghost loadout-head__x" aria-label="关闭配置" title="关闭（Esc）" onClick={onClose}><X size={18} aria-hidden /></button>
        </header>
        <Stats m={m} onClose={onClose} />
        <div className="loadout-body" key={m.id} id={panelId} role="tabpanel" aria-labelledby={tabId(id)}>
          <Figure m={m} crew={crew} />
          <EnableRow m={m} leadName={crew.lead.name} />
          <p className="loadout-desc">{m.agent.description}</p>
          {m.lead ? <LeadModel /> : <ModelFields m={m} crew={crew} />}
          <ToolFields m={m} tools={crew.tools} />
          <Now m={m} onClose={onClose} />
        </div>
      </aside>
    </>
  );
}

/* ───────────── stats ───────────── */

function Stats({ m, onClose }: { m: Member; onClose: () => void }) {
  const { steps, calls, errors } = m.stat;
  const last = m.lastError;
  return (
    <>
      <dl className="loadout-stats">
        <div><dt>完成步骤</dt><dd>{steps}</dd></div>
        <div><dt>工具调用</dt><dd>{calls}</dd></div>
        <div className={cx(errors > 0 && 'is-err')}><dt>出错</dt><dd>{errors > 0 && <OctagonX size={15} aria-hidden />}{errors}</dd></div>
      </dl>
      {errors > 0 && last && (
        <p className="loadout-errnote">
          <TriangleAlert size={13} aria-hidden />
          <span>最近一次出错：{last.title}{last.message ? `：${last.message}` : ''}。
            <button type="button" className="agents-link crew-link" onClick={() => { onClose(); actions.openTask(last.taskId, last.runId); actions.openConsole('tools', last.id); }}>在控制台查看详情<ArrowUpRight size={12} aria-hidden /></button>
          </span>
        </p>
      )}
    </>
  );
}

/* ───────────── her figure and what she says ───────────── */

function Figure({ m, crew }: { m: Member; crew: Crew }) {
  const { mode, persona } = crew;
  const words = persona ? <blockquote>「{m.drawerLine}」{!m.lead && <cite>— {crew.lead.name} · {m.title}</cite>}</blockquote> : <blockquote className="is-plain">{m.drawerLine}</blockquote>;
  if (m.lead) {
    return (
      <figure className="loadout-figure loadout-figure--lead">
        <div className="loadout-figure__banner"><PvStill mode={mode} /><PvCredit /></div>
        {words}
      </figure>
    );
  }
  return (
    <figure className="loadout-figure" data-state={m.trail}>
      <span className="loadout-figure__petbox">
        <img className="loadout-figure__pet" src={asset(`pet/${mode}/${m.pose}.png`)} alt="" width={640} height={640} draggable={false} decoding="async" />
      </span>
      {words}
    </figure>
  );
}

/* ───────────── enable ───────────── */

function EnableRow({ m, leadName }: { m: Member; leadName: string }) {
  return (
    <section className="loadout-sec" aria-label="启用">
      <Switch
        label="启用"
        checked={m.agent.enabled}
        disabled={m.lead}
        description={m.lead ? '编排 Agent 必须启用：它负责拆解目标和分派步骤，关掉就没人带队了' : `停用后，它的步骤会交给${leadName}`}
        onChange={(v) => actions.setAgentEnabled(m.id, v)}
      />
      {m.lead && <span className="crew-lock"><ShieldCheck size={12} aria-hidden />已锁定</span>}
    </section>
  );
}

/* ───────────── model and 推理强度 ───────────── */

function LeadModel() {
  return (
    <div className="agents-field">
      <p className="label">模型</p>
      <p className="agent-follow"><Cpu size={14} aria-hidden />跟随任务：编排 Agent 总是用新建任务时选的模型</p>
    </div>
  );
}

function ModelFields({ m, crew }: { m: Member; crew: Crew }) {
  const modelId = useId();
  const effortLabel = useId();
  const models = useApp((s) => s.models);
  const agent = m.agent;
  const engine = agent.engine;
  const choices = useMemo(() => engineChoices(models), [models]);
  const choice = engine ? choices.find((c) => c.key === engine.key) : undefined;

  // Each model says how many 强度 levels it offers.
  const groups = useMemo(() => [
    { options: [{ value: '', label: '跟随任务', sub: '用新建任务时选的模型' }] },
    ...modelMenuGroups(models).map((g, i) => ({
      ...g,
      options: g.options.map((o) => {
        const n = choiceEfforts(models, choices[i], parseMenuValue(o.value).model).length;
        return { value: o.value, label: o.label, sub: [o.sub, o.meta].filter(Boolean).join(' · ') || undefined, meta: n ? `${n} 档` : '不可调' };
      }),
    })),
  ], [models, choices]);

  // Switching the model keeps the 强度 only if the new model still offers it.
  const onModel = (v: string) => {
    if (!v) { actions.setAgentEngine(agent.id, undefined); return; }
    const { key, model } = parseMenuValue(v);
    const next = choices.find((c) => c.key === key);
    const kept = engine?.effort && next && choiceEfforts(models, next, model).includes(engine.effort) ? engine.effort : undefined;
    actions.setAgentEngine(agent.id, { key, model, effort: kept });
  };

  return (
    <>
      <div className="agents-field">
        <label className="label" htmlFor={modelId}>模型</label>
        <MenuSelect variant="field" id={modelId} label={`${m.name} 的模型`} icon={Cpu} value={engine ? menuValue(engine.key, engine.model) : ''} groups={groups}
          display={engine ? engineText(models, engine) : undefined} onChange={onModel} minWidth={300} />
        {engine && !choice && (
          <div className="agent-warn" role="alert">
            <TriangleAlert size={14} aria-hidden />
            <span>这个模型现在不可用，它的步骤会改用任务的模型</span>
            <Button size="sm" variant="ghost" onClick={() => actions.navigate('models')}>去模型接入</Button>
          </div>
        )}
        {!engine && <p className="agents-hint">没有单独指定，它的步骤用新建任务时选的模型。</p>}
        {!engine && crew.first && (
          <div className="agent-warn" role="note">
            <TriangleAlert size={14} aria-hidden />
            <span>还没有接入任何模型，暂时只能跟随任务。</span>
            <Button size="sm" variant="ghost" onClick={() => actions.navigate('models')}>去模型接入</Button>
          </div>
        )}
      </div>
      {engine && choice && (
        <div className="agents-field">
          {m.model.levels.length > 0 ? (
            <>
              <p className="label" id={effortLabel}>推理强度<span className="loadout-label-sub">{crew.mode === 'sam' ? '出力' : '出力 · 越高越细致，也越慢'}</span></p>
              <EffortLadder levels={m.model.levels} value={engine.effort} labelledBy={effortLabel}
                onChange={(v: Effort | undefined) => actions.setAgentEngine(agent.id, { ...engine, effort: v })} />
            </>
          ) : (
            <>
              <p className="label">推理强度</p>
              <p className="agent-follow"><Gauge size={14} aria-hidden />这个模型不能调节推理强度</p>
            </>
          )}
        </div>
      )}
    </>
  );
}

/* ───────────── tools ───────────── */

function ToolFields({ m, tools }: { m: Member; tools: ToolDef[] }) {
  const labelId = useId();
  return (
    <div className="agents-field">
      <p className="label" id={labelId}>可用工具</p>
      {m.lead ? (
        <p className="agents-hint">全部工具，按「工具与技能」里的策略执行（自动、需确认或禁用）。</p>
      ) : (
        <>
          <ul className="agent-tools" aria-labelledby={labelId}>
            {tools.map((t) => <ToolChip key={t.id} tool={t} on={m.agent.tools.includes(t.id)} onToggle={() => toggleTool(m.agent, tools, t.id)} />)}
          </ul>
          <p className="agents-hint loadout-hint"><Info size={13} aria-hidden /><span>{CLI_NOTE}</span></p>
        </>
      )}
    </div>
  );
}

/** One tool as a toggle (aria-pressed). The icon shows the 工具策略; the check says it is on. */
function ToolChip({ tool, on, onToggle }: { tool: ToolDef; on: boolean; onToggle: () => void }) {
  const Icon = PERM_ICON[tool.permission];
  const label = PERMISSION[tool.permission].label;
  if (followsPolicyOnly(tool.id)) {
    return (
      <li>
        <span className={cx('agent-tool', 'is-static', `is-${tool.permission}`)} title={`${tool.name}${FOLLOW_TIP}`}>
          <Icon size={12} aria-hidden className="agent-tool__perm" />
          <span>{tool.name}</span>
          <span className="sr-only">（{label}{FOLLOW_TIP}）</span>
        </span>
      </li>
    );
  }
  // Disabled on 工具与技能: shown muted even when ticked (the tick is kept for when it is allowed again).
  const denied = tool.permission === 'off';
  return (
    <li>
      <button type="button" className={cx('agent-tool', `is-${tool.permission}`, on && 'is-on')} style={denied ? { opacity: 0.55 } : undefined} aria-pressed={on} title={denied ? `${tool.name}：${DENIED_TIP}` : `${tool.name}：${label}`} onClick={onToggle}>
        <Icon size={12} aria-hidden className="agent-tool__perm" />
        <span>{tool.name}</span>
        <span className="sr-only">（{label}）</span>
        {on && <Check size={12} aria-hidden className="agent-tool__on" />}
      </button>
    </li>
  );
}

/* ───────────── now ───────────── */

function Now({ m, onClose }: { m: Member; onClose: () => void }) {
  const p = m.presence;
  return (
    <div className="agents-field">
      <p className="label">当前</p>
      <div className="agents-now">
        <StatusChip meta={m.meta} size="sm" />
        {p && m.agent.enabled
          ? <span className="agents-now__task">正在参与：<button type="button" className="agents-link crew-link" title={p.title} onClick={() => { onClose(); actions.openTask(p.taskId, p.runId); }}><span className="truncate">{p.title}</span><ArrowUpRight size={12} aria-hidden /></button></span>
          : <span className="agents-now__task is-none">没有参与中的任务</span>}
      </div>
      <p className="loadout-nowline">{m.now}</p>
    </div>
  );
}
