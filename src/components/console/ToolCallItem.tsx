/* One expandable tool call. Used by the console list and by the workspace steps view.
   A disclosure row (status · tool · title · agent · duration) over a details region with the
   input, output, error and call metadata. All data shown here comes from the simulator unless the
   call says otherwise, so every output block carries a SimTag. */
import { ArrowRight, ChevronRight, Hand, PauseCircle, RotateCcw, XOctagon } from 'lucide-react';
import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { duration, json, timeOfDay } from '../../lib/format';
import { TOOL_STATUS, type StatusMeta } from '../../lib/status';
import type { DataSource, ToolCall } from '../../lib/types';
import { actions } from '../../state/actions';
import { shallow, useApp } from '../../state/store';
import { Badge, CodeBlock, SimTag, StatusChip, cx } from '../ui';

export interface ToolCallItemProps {
  call: ToolCall;
  /** Start expanded (e.g. when the console is opened on this call). */
  defaultOpen?: boolean;
  /** Show the plan step it belongs to (console list); the steps view already groups by step. */
  showStep?: boolean;
  /** The run is paused: a running call shows as paused rather than progressing. */
  paused?: boolean;
  /** Denser row for nested use inside a step card. */
  dense?: boolean;
}

const PAUSED_META: StatusMeta = { label: '已暂停', tone: 'paused', icon: PauseCircle };

type Accent = 'danger' | 'warning' | 'running' | 'paused' | undefined;

/** After a click expands a row, bring it into view inside whatever scrolls it (the console list or
 *  the workspace). Only the scroll container moves, never the page, and the row's top stays visible. */
function revealInScroller(el: HTMLElement) {
  let box: HTMLElement | null = el.parentElement;
  while (box) {
    const overflowY = getComputedStyle(box).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && box.scrollHeight > box.clientHeight) break;
    box = box.parentElement;
  }
  if (!box) return;
  const item = el.getBoundingClientRect();
  const view = box.getBoundingClientRect();
  const margin = 8;
  if (item.top < view.top + margin) box.scrollTop -= view.top + margin - item.top;
  else if (item.bottom > view.bottom - margin) box.scrollTop += Math.min(item.bottom - (view.bottom - margin), item.top - (view.top + margin));
}

function ToolCallItemView({ call, defaultOpen = false, showStep = false, paused = false, dense = false }: ToolCallItemProps) {
  const [open, setOpen] = useState(defaultOpen);
  // Opening the console on an already-rendered call flips this prop to true after mount.
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);

  const baseId = useId();
  const regionId = `${baseId}-details`;
  const rootRef = useRef<HTMLDivElement>(null);
  const revealOnOpen = useRef(false);
  useLayoutEffect(() => {
    if (open && revealOnOpen.current && rootRef.current) revealInScroller(rootRef.current);
    revealOnOpen.current = false;
  }, [open]);

  const running = call.status === 'running';
  const ctx = useApp((s) => {
    const run = s.runs[call.runId];
    const step = showStep ? run?.plan.find((p) => p.id === call.stepId) : undefined;
    /* Live progress is the simulator's own position in the beat (simulated ms spent so far), not a
       wall-clock estimate: it holds still while paused, survives a remount or reload, and follows
       the simulation speed. Only the call the cursor is on can be running. */
    const current = running && run ? run.plan[run.cursor.step]?.toolCallIds.at(-1) === call.id : false;
    return {
      agent: s.agents.find((a) => a.id === call.agentId)?.name ?? call.agentId,
      source: (call.simulated ? (run?.source === 'sample' ? 'sample' : 'simulated') : 'live') as DataSource,
      stepNo: step ? step.index + 1 : 0,
      stepTitle: step?.title ?? '',
      elapsed: current && run ? run.cursor.beatElapsed : undefined,
    };
  }, shallow);

  const elapsed = ctx.elapsed != null && call.expectedMs ? Math.min(ctx.elapsed, call.expectedMs) : ctx.elapsed;
  const ratio = elapsed != null && call.expectedMs ? Math.min(1, elapsed / call.expectedMs) : undefined;

  const meta = running && paused ? PAUSED_META : TOOL_STATUS[call.status];
  const accent: Accent = call.status === 'error' ? 'danger'
    : call.status === 'awaiting' ? 'warning'
      : running ? (paused ? 'paused' : 'running') : undefined;

  const timeText = call.status === 'denied' ? '未执行'
    : running ? (elapsed != null ? duration(elapsed) : '—')
      : call.durationMs != null ? duration(call.durationMs) : '—';

  return (
    <div ref={rootRef} className={cx('tool-call', dense && 'tool-call--dense', open && 'is-open', accent && `tool-call--${accent}`)}
      data-call-id={call.id} data-status={call.status}>
      <div className="tool-call__head">
        <button type="button" className="tool-call__toggle" aria-expanded={open} aria-controls={regionId} onClick={() => { revealOnOpen.current = !open; setOpen(!open); }}>
          <StatusChip meta={meta} size="sm" title={meta === PAUSED_META ? '运行已暂停，这次调用停在原处' : undefined} />
          <span className="tool-call__tool">{call.toolName ?? call.tool}</span>
          <span className="tool-call__title">{call.title}</span>
          <span className="tool-call__agent">{ctx.agent}</span>
          <span className="tool-call__time">{timeText}</span>
          <ChevronRight className="tool-call__chev" size={14} aria-hidden />
        </button>
        {ratio != null && (
          <span className="tool-call__progress" aria-hidden>
            <span className="tool-call__bar" style={{ transform: `scaleX(${ratio})` }} />
          </span>
        )}
      </div>
      <div id={regionId} role="region" aria-label={`${call.title} 的调用详情`} className="tool-call__body" hidden={!open}>
        {open && (
          <Details call={call} source={ctx.source} timeText={timeText}
            stepLabel={showStep && ctx.stepNo ? `第 ${ctx.stepNo} 步 · ${ctx.stepTitle}` : undefined} />
        )}
      </div>
    </div>
  );
}

/** Memoised: a list of calls re-renders only the rows whose call object changed. */
export const ToolCallItem = memo(ToolCallItemView);

/* ───────────── details ───────────── */

function Details({ call, source, timeText, stepLabel }: { call: ToolCall; source: DataSource; timeText: string; stepLabel?: string }) {
  const err = call.error;
  return (
    <>
      <div className="tool-call__io">
        <CodeBlock code={json(call.input)} language="json" caption="输入 · JSON" maxHeight={220} wrap />
        <Output call={call} source={source} />
      </div>

      {err && (
        <div className="callout callout--danger tool-call__error" role="group" aria-label="错误详情">
          <XOctagon className="callout__icon" size={16} aria-hidden />
          <div className="callout__body">
            <p className="callout__title tool-call__error-title">
              <Badge tone="danger" className="tool-call__code">{err.code}</Badge>
              <span>{err.message}</span>
            </p>
            <p className="callout__text tool-call__error-note">
              {err.recoverable ? <><RotateCcw size={12} aria-hidden />Agent 已自动重试</> : '导致步骤失败'}
            </p>
            {err.detail && <CodeBlock code={err.detail} caption="错误详情" maxHeight={180} wrap className="tool-call__detail" />}
          </div>
        </div>
      )}

      {call.status === 'awaiting' && (
        <div className="callout callout--warning" role="group" aria-label="待确认">
          <Hand className="callout__icon" size={16} aria-hidden />
          <div className="callout__body">
            <p className="callout__title">待确认</p>
            <p className="callout__text">这次调用要等你批准后才会执行。</p>
          </div>
          <div className="callout__actions">
            <button type="button" className="tool-call__link" onClick={() => actions.requestFocus('approvals')}>
              前往确认<ArrowRight size={13} aria-hidden />
            </button>
          </div>
        </div>
      )}

      <dl className="tool-call__meta">
        <MetaItem label="调用 ID" mono>{call.id}</MetaItem>
        <MetaItem label="开始时间">{timeOfDay(call.startedAt)}</MetaItem>
        <MetaItem label="耗时">{timeText}</MetaItem>
        {stepLabel && <MetaItem label="所属步骤">{stepLabel}</MetaItem>}
      </dl>
    </>
  );
}

function MetaItem({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="tool-call__meta-item">
      <dt className="label">{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{children}</dd>
    </div>
  );
}

function Output({ call, source }: { call: ToolCall; source: DataSource }) {
  const tag = <SimTag source={source} compact />;
  switch (call.status) {
    case 'running':
      return (
        <Placeholder tag={tag}>
          <span className="tool-call__skel" style={{ width: '92%' }} aria-hidden />
          <span className="tool-call__skel" style={{ width: '68%' }} aria-hidden />
          <span className="tool-call__skel" style={{ width: '44%' }} aria-hidden />
          <span className="tool-call__ph-text">等待输出…</span>
        </Placeholder>
      );
    case 'awaiting':
      return <Placeholder tag={tag}><span className="tool-call__ph-text">尚未执行，批准后才会产生输出。</span></Placeholder>;
    case 'denied':
      return (
        <Placeholder tag={tag}>
          <span className="tool-call__ph-text">已拒绝，未执行</span>
          {call.output && <span className="tool-call__ph-sub">{call.output}</span>}
        </Placeholder>
      );
    case 'cancelled':
      return <Placeholder tag={tag}><span className="tool-call__ph-text">运行取消时中止</span></Placeholder>;
    default:
      return call.output
        ? <CodeBlock code={call.output} caption="输出" tag={tag} maxHeight={220} wrap />
        : <Placeholder tag={tag}><span className="tool-call__ph-text">没有输出</span></Placeholder>;
  }
}

function Placeholder({ tag, children }: { tag: ReactNode; children: ReactNode }) {
  return (
    <figure className="code tool-call__ph">
      <figcaption className="code__bar">
        <span className="code__lang">输出</span>
        <span className="code__tools">{tag}</span>
      </figcaption>
      <div className="tool-call__ph-body">{children}</div>
    </figure>
  );
}
