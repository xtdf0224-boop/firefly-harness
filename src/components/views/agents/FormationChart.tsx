/* 萤火编队: the Agent page's chart. The lead (流萤 / 萨姆) stands left on the PV still; her emblem is the
   point every trail leaves from, and the three helpers are lights on the right, each holding her Q
   sprite in the pose of its state. Trails are measured from the emblem to each orb, so they line up
   at any width. Cards open the loadout drawer; the switch beside each card enables or stops it. */
import { ArrowUpRight, Cpu, Crosshair, Gauge, Settings2, ShieldCheck, TriangleAlert, Wrench } from 'lucide-react';
import { useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { trailPaths, type Pt } from '../../../lib/formation';
import type { AgentId } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { StatusChip, cx } from '../../ui';
import type { Crew, Member } from './crew';
import { CrewOrb, CrewStats, LeadMark, PvCredit, PvStill, pvAlt } from './parts';

export type OpenDrawer = (id: AgentId) => void;

const FLIES = [
  [62, 14, 0], [88, 40, -2.4], [51, 64, -4.1], [96, 84, -1.2], [72, 93, -5.3], [47, 30, -3.3], [80, 6, -6, 1], [58, 47, -0.7, 1],
] as const;

export function FormationChart({ crew, onOpen }: { crew: Crew; onOpen: OpenDrawer }) {
  const { mode, first, lead } = crew;
  const sam = mode === 'sam';
  const headId = useId();
  const mark = useRef<HTMLButtonElement>(null);
  const nodes = useRef<Partial<Record<AgentId, HTMLLIElement | null>>>({});
  const helpers = crew.members.filter((m) => !m.lead);
  const units = crew.members.filter((m) => m.agent.enabled).length;
  const live = crew.members.some((m) => m.presence);

  return (
    <section className="panel formation" aria-labelledby={headId} data-first={first || undefined}>
      <h2 className="sr-only" id={headId}>编队图：{lead.name}与三位 Agent</h2>
      <div className="formation__sky" aria-hidden>
        {!sam && FLIES.map(([x, y, d, s], i) => (
          <span key={i} className={cx('formation__fly', s && 'formation__fly--s')} style={{ ['--fx' as string]: `${x}%`, ['--fy' as string]: `${y}%`, ['--d' as string]: `${d}s` }} />
        ))}
      </div>
      {sam && (
        <div className="formation-hud" aria-hidden>
          <span className="formation-hud__tl">TACTICAL // FORMATION</span>
          <span className="formation-hud__tr">{first ? `UNITS ${units}/${crew.members.length} · POWER —` : `UNITS ${units}/${crew.members.length} · ${live ? 'OPS ACTIVE' : 'STANDBY'}`}</span>
          <span className="formation-hud__scan" />
        </div>
      )}
      <LeadPortrait crew={crew} onOpen={onOpen} />
      <button ref={mark} type="button" className="lead-mark" data-open="orchestrator" data-state={lead.trail} tabIndex={-1} aria-haspopup="dialog" aria-label={`${leadLabel(lead, crew.persona)}。打开配置`} onClick={() => onOpen('orchestrator')}>
        <LeadMark mode={mode} />
      </button>
      <ul className="formation-nodes" aria-label="协作 Agent">
        {helpers.map((m) => <FormationNode key={m.id} m={m} crew={crew} li={(el) => { nodes.current[m.id] = el; }} onOpen={onOpen} />)}
      </ul>
      {/* After the nodes: its layout effect measures their orbs, so their refs must be attached first. */}
      <Trails mark={mark} nodes={nodes} crew={crew} />
    </section>
  );
}

const leadLabel = (lead: Member, persona: boolean) => `${persona ? `${lead.name}（编排 Agent）` : lead.name}，${lead.meta.label}，跟随任务`;

/* ───────────── the lead ───────────── */

function LeadPortrait({ crew, onOpen }: { crew: Crew; onOpen: OpenDrawer }) {
  const { mode, lead, persona, first } = crew;
  const sam = mode === 'sam';
  const task = lead.presence;
  return (
    <div className="formation-lead">
      <div className="formation-lead__art"><PvStill mode={mode} alt={pvAlt(mode)} /></div>
      {sam && (
        <>
          <svg className="formation-cut" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden><path d="M100 0 L86 100" /></svg>
          <div className="formation-reticle" aria-hidden>
            <svg className="formation-reticle__ring" viewBox="0 0 120 120"><circle cx="60" cy="60" r="56" /></svg>
            <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="44" /><path d="M60 0v18M60 102v18M0 60h18M102 60h18" /></svg>
          </div>
          <p className="formation-callsign" aria-hidden>UNIT-00 // SAM · 完全燃烧</p>
        </>
      )}
      <PvCredit className="formation-lead__credit" />
      <div className="lead-card">
        <p className="lead-card__quote">{persona ? `「${lead.quote}」` : lead.quote}</p>
        <div className="lead-card__row">
          <button type="button" className="lead-card__name" data-open="orchestrator" aria-haspopup="dialog" aria-label={`${leadLabel(lead, persona)}。打开配置`} onClick={() => onOpen('orchestrator')}>
            <span className="lead-card__nm">{lead.name}</span>
            {persona && <span className="crew-tag"><span className="crew-tag__pre">编排 · </span>{lead.title}</span>}
            <span className="crew-adjust crew-adjust--inline" aria-hidden><Settings2 size={13} /><span className="crew-adjust__t">调整</span></span>
          </button>
          <StatusChip meta={lead.meta} size="sm" />
        </div>
        <p className="lead-card__meta">
          <Cpu size={13} aria-hidden />
          <span className="truncate">跟随任务<span className="lead-card__alltools"> · 全部工具</span></span>
          <span className="crew-lock" title="编排 Agent 必须启用：它负责拆解目标和分派步骤"><ShieldCheck size={12} aria-hidden />已启用 · 锁定</span>
        </p>
        <div className="lead-card__row lead-card__row--foot">
          {task && !first
            ? <p className="lead-card__task">参与<button type="button" className="agents-link crew-link" title={task.title} onClick={() => actions.openTask(task.taskId, task.runId)}><span className="truncate">{task.title}</span><ArrowUpRight size={12} aria-hidden /></button></p>
            : <p className="lead-card__task is-none">还没有参与的任务</p>}
          <CrewStats stat={lead.stat} className="crew-stats--lead" />
        </div>
      </div>
    </div>
  );
}

/* ───────────── a helper ───────────── */

function FormationNode({ m, crew, li, onOpen }: { m: Member; crew: Crew; li: (el: HTMLLIElement | null) => void; onOpen: OpenDrawer }) {
  const { mode, persona } = crew;
  const on = m.agent.enabled;
  const { model } = m;
  const tools = `工具 ${m.toolsOn}/${crew.toolTotal}`;
  const label = [
    persona && m.title ? `${m.name}（${m.title}）` : m.name,
    on ? m.meta.label : '已停用',
    `模型 ${model.text}${model.kind === 'broken' ? '（不可用）' : model.effort ? `，强度 ${model.effort}` : ''}`,
    tools,
    `完成步骤 ${m.stat.steps}，工具调用 ${m.stat.calls}，出错 ${m.stat.errors}`,
    m.now,
  ].join('，');
  return (
    <li ref={li} className={cx('formation-node', `formation-node--${m.id}`)} data-state={m.trail} data-on={on}>
      <CrewOrb m={m} mode={mode} pet />
      <div className="formation-node__card">
        <button type="button" className="formation-node__main" data-open={m.id} aria-haspopup="dialog" aria-label={`${label}。打开配置`} title={m.quote} onClick={() => onOpen(m.id)}>
          <span className="formation-node__top">
            <span className="formation-node__name">{m.name}</span>
            {m.title && <span className="formation-node__title">{m.title}</span>}
          </span>
          <span className={cx('formation-node__model', `is-${model.kind}`)} title={model.text}>
            {model.kind === 'broken' ? <TriangleAlert size={13} aria-hidden /> : <Cpu size={13} aria-hidden />}
            <span className="truncate">{model.text}</span>
            {model.kind === 'broken' && <span className="crew-pill crew-pill--warn">不可用</span>}
            {model.kind === 'own' && model.effort && <span className="crew-pill" title={`推理强度 ${model.effort}`}><Gauge size={11} aria-hidden /><span className="sr-only">推理强度 </span>{model.effort}</span>}
          </span>
          <span className="formation-node__now">
            <StatusChip meta={m.meta} size="sm" />
            <span className="truncate">{m.now}</span>
          </span>
          <span className="formation-node__say">{persona ? `「${m.quote}」` : m.quote}</span>
          <span className="formation-node__foot">
            <CrewStats stat={m.stat} className="crew-stats--node" />
            <span className={cx('formation-node__tools', m.toolsOn === 0 && 'is-none')}><Wrench size={12} aria-hidden />工具 <span><b>{m.toolsOn}</b>/{crew.toolTotal}</span></span>
          </span>
        </button>
        <span className="formation-node__ctl">
          <button type="button" role="switch" className={cx('crew-switch', on && 'is-on')} aria-checked={on} aria-label={`启用${m.name}`}
            title={on ? '已启用：点一下停用' : '已停用：点一下重新启用'} onClick={() => actions.setAgentEnabled(m.id, !on)}>
            <span className="crew-switch__thumb" aria-hidden />
          </button>
          <button type="button" className="crew-adjust" data-open={m.id} aria-haspopup="dialog" aria-label={`调整${m.name}`} title="调整" onClick={() => onOpen(m.id)}>
            <Settings2 size={13} aria-hidden /><span className="crew-adjust__t">调整</span>
          </button>
        </span>
      </div>
    </li>
  );
}

/* ───────────── trails ───────────── */

interface TrailGeo { w: number; h: number; items: Array<{ id: AgentId; go: string; back: string; mid: Pt; from: Pt; to: Pt }> }

/** One SVG over the chart. A ResizeObserver on the chart and the nodes re-measures the emblem and each orb;
    the callback only recomputes path data (the SVG is out of flow, so it cannot feed back into layout). */
function Trails({ mark, nodes, crew }: { mark: RefObject<HTMLButtonElement | null>; nodes: RefObject<Partial<Record<AgentId, HTMLLIElement | null>>>; crew: Crew }) {
  const { mode, first } = crew;
  const sam = mode === 'sam';
  const gid = useId().replace(/[^\w-]/g, '');
  const [geo, setGeo] = useState<TrailGeo>();
  const key = useRef('');
  const svg = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    // The chart is this SVG's parent; its own ref is not attached yet when a child's layout effect runs.
    const root = svg.current?.parentElement;
    if (!root) return undefined;
    const measure = () => {
      const m = mark.current;
      if (!m) return;
      const box = root.getBoundingClientRect();
      const mb = m.getBoundingClientRect();
      const from: Pt = { x: mb.left + mb.width / 2 - box.left, y: mb.top + mb.height / 2 - box.top };
      const items: TrailGeo['items'] = [];
      for (const [id, el] of Object.entries(nodes.current ?? {})) {
        const orb = el?.querySelector('.crew-orb');
        if (!orb) continue;
        const ob = orb.getBoundingClientRect();
        const to: Pt = { x: ob.left + ob.width / 2 - box.left, y: ob.top + ob.height / 2 - box.top };
        items.push({ id: id as AgentId, ...trailPaths(mode, from, to), mid: { x: (from.x + to.x) / 2, y: mode === 'sam' ? to.y : (from.y + to.y) / 2 }, from, to });
      }
      const next = `${box.width}x${box.height}|${items.map((i) => i.go + i.back).join('|')}`;
      if (next === key.current) return;
      key.current = next;
      setGeo({ w: box.width, h: box.height, items });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    for (const el of Object.values(nodes.current ?? {})) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [mark, nodes, mode]);

  const byId = useMemo(() => Object.fromEntries(crew.members.map((m) => [m.id, m])), [crew.members]);
  if (!geo) return <svg ref={svg} className="formation-trails" aria-hidden />;
  return (
    <svg ref={svg} className="formation-trails" width={geo.w} height={geo.h} viewBox={`0 0 ${geo.w} ${geo.h}`} aria-hidden>
      {/* One gradient per trail in user space: a level path has a zero-height box, which paints nothing with box units. */}
      <defs>
        {geo.items.map(({ id, from, to }) => (
          <linearGradient key={id} id={`${gid}-${id}`} gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
            <stop offset="0" style={{ stopColor: sam ? 'var(--firefly)' : 'var(--mint-strong)' }} />
            <stop offset="1" style={{ stopColor: sam ? 'var(--mint)' : 'var(--firefly)' }} />
          </linearGradient>
        ))}
      </defs>
      {geo.items.map(({ id, go, back, mid }) => {
        const m = byId[id];
        if (!m) return null;
        const err = !!m.lastError?.open && !first; // a failure in a run still open; the lifetime count lives on the orb and in the drawer
        return (
          <g key={id} className={cx('trail', `trail--${m.trail}`)} style={{ ['--tg' as string]: `url(#${gid}-${id})` }}>
            <path className="trail__base" d={go} />
            <path className="trail__glow" d={go} />
            <path className="trail__flow" d={go} />
            <path className="trail__back" d={back} />
            <path className="trail__backflow" d={back} />
            {err && <><circle className="trail__spark-halo" cx={mid.x} cy={mid.y} r="8" /><circle className="trail__spark" cx={mid.x} cy={mid.y} r="3.5" /></>}
          </g>
        );
      })}
    </svg>
  );
}

/* ───────────── legend under the chart ───────────── */

const KEY: Array<{ cls: string; label: string }> = [
  { cls: 'out', label: '分派步骤' }, { cls: 'back', label: '结果回传' }, { cls: 'wait', label: '等待确认' }, { cls: 'err', label: '出错（进行中）' },
];

/** Legend of the trails and a one-line hint. */
export function TrailKey({ crew }: { crew: Crew }) {
  const sam = crew.mode === 'sam';
  return (
    <div className="trail-key">
      <ul className="trail-key__list" aria-label="航迹图例">
        {KEY.map((k) => <li key={k.cls}><i className={`trail-key__sw trail-key__sw--${k.cls}`} />{k.label}</li>)}
      </ul>
      <p className="trail-key__hint"><Crosshair size={13} aria-hidden />{sam ? '选中任一单元，打开装备配置' : `点一下任意一只萤火（或${crew.lead.name}），打开它的配置`}</p>
    </div>
  );
}

