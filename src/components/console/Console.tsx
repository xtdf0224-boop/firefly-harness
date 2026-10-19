/* The collapsible bottom console: tool calls, terminal output, errors and the event timeline of the
   run being looked at. Collapsed it is a one-line bar with live counters; open it has a drag handle
   (and arrow keys) for its height. Everything inside is the real record of the run being looked at. */
import { ChevronDown, ChevronUp, History, SquareTerminal, Wrench, XOctagon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { timeOfDay } from '../../lib/format';
import { RUN_STATUS } from '../../lib/status';
import type { ConsoleTab, RunEvent } from '../../lib/types';
import { actions } from '../../state/actions';
import { runLabel } from '../../state/selectors';
import { shallow, useApp } from '../../state/store';
import { EngineTag, IconButton, Kbd, StatusChip, Tabs, ToneDot, cx, tabPanelProps, type TabItem } from '../ui';
import { consoleRunId } from './consoleRun';
import { ErrorsTab } from './ErrorsTab';
import { TerminalTab } from './TerminalTab';
import { TimelineTab } from './TimelineTab';
import { ToolCallsTab } from './ToolCallsTab';

const BODY_ID = 'console-body';
const MIN_H = 160;
const STEP_H = 24;
const maxHeight = () => Math.max(MIN_H, Math.floor(window.innerHeight * 0.7));

function panelFor(tab: ConsoleTab, runId?: string) {
  // Keyed by run so a different run starts with fresh scroll and follow state.
  const key = runId ?? 'none';
  switch (tab) {
    case 'tools': return <ToolCallsTab key={key} runId={runId} />;
    case 'terminal': return <TerminalTab key={key} runId={runId} />;
    case 'errors': return <ErrorsTab key={key} runId={runId} />;
    case 'timeline': return <TimelineTab key={key} runId={runId} />;
  }
}

export function Console() {
  const open = useApp((s) => s.console.open);
  const tab = useApp((s) => s.console.tab);
  const height = useApp((s) => s.console.height);
  const runId = useApp(consoleRunId);

  const info = useApp((s) => {
    const run = runId ? s.runs[runId] : undefined;
    return run ? { attempt: run.attempt, status: run.status, engineLabel: run.engineLabel, title: s.tasks[run.taskId]?.title ?? '未命名任务' } : undefined;
  }, shallow);

  const counts = useApp((s) => {
    const run = runId ? s.runs[runId] : undefined;
    let running = 0;
    if (run) for (const c of run.toolCalls) if (c.status === 'running') running++;
    return { calls: run?.toolCalls.length ?? 0, running, errors: run?.errors.length ?? 0, lines: run?.terminal.length ?? 0 };
  }, shallow);

  const eventCount = useApp((s) => (runId ? s.events.reduce((n, e) => (e.runId === runId ? n + 1 : n), 0) : 0));

  const lastEvent = useApp((s): RunEvent | undefined => {
    if (!runId) return undefined;
    for (let i = s.events.length - 1; i >= 0; i--) if (s.events[i].runId === runId) return s.events[i];
    return undefined;
  });

  /* ── focus: keep it somewhere sensible when the console folds or unfolds ── */
  const sectionRef = useRef<HTMLElement>(null);
  const barToggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    const section = sectionRef.current;
    if (!section || !section.contains(document.activeElement)) return;
    const target = open ? section.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') : barToggleRef.current;
    target?.focus();
  }, [open]);

  // actions.requestFocus('console') opens the console and asks us to take focus.
  const focusReq = useApp((s) => s.focusRequest);
  const handledFocus = useRef(focusReq?.at);
  useEffect(() => {
    if (!focusReq || focusReq.at === handledFocus.current) return;
    handledFocus.current = focusReq.at;
    if (focusReq.target !== 'console') return;
    const id = requestAnimationFrame(() => {
      sectionRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [focusReq]);

  /* ── height: drag the top edge or use the arrow keys ── */
  const [maxH, setMaxH] = useState(maxHeight);
  useEffect(() => {
    const on = () => setMaxH(maxHeight());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const shown = Math.min(Math.max(height, MIN_H), maxH);

  const drag = useRef<{ startY: number; startH: number } | null>(null);
  const pending = useRef({ height: 0, raf: 0 });
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => cancelAnimationFrame(pending.current.raf), []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startH: shown };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    pending.current.height = d.startH + (d.startY - e.clientY);
    if (!pending.current.raf) {
      pending.current.raf = requestAnimationFrame(() => {
        pending.current.raf = 0;
        actions.setConsoleHeight(pending.current.height);
      });
    }
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onResizeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === 'ArrowUp' ? shown + STEP_H
      : e.key === 'ArrowDown' ? shown - STEP_H
        : e.key === 'Home' ? MIN_H
          : e.key === 'End' ? maxH
            : undefined;
    if (next === undefined) return;
    e.preventDefault();
    actions.setConsoleHeight(next);
  };

  const tabs: Array<TabItem<ConsoleTab>> = [
    { id: 'tools', label: '工具调用', icon: Wrench, count: counts.calls, badgeLabel: '次调用' },
    { id: 'terminal', label: '终端输出', icon: SquareTerminal, count: counts.lines, badgeLabel: '行' },
    { id: 'errors', label: '错误', icon: XOctagon, count: counts.errors, tone: 'danger', badgeLabel: '个错误' },
    { id: 'timeline', label: '事件时间线', icon: History, count: eventCount, badgeLabel: '条事件' },
  ];

  return (
    <section ref={sectionRef} className="console panel" aria-label="控制台" data-open={open} data-dragging={dragging || undefined}>
      {/* Collapsed: one 40px bar. */}
      <div className="console__bar" hidden={open}>
        <button ref={barToggleRef} type="button" className="console__toggle" aria-expanded={false} aria-controls={BODY_ID}
          onClick={() => actions.toggleConsole(true)}>
          <ChevronUp size={16} aria-hidden />
          <span>控制台</span>
          <Kbd>Ctrl `</Kbd>
        </button>
        <button type="button" className="console__summary" onClick={() => actions.openConsole('tools')}>
          <Wrench size={13} aria-hidden />
          <span>工具调用 {counts.calls}</span>
          {counts.running > 0 && (
            <span className="console__live">
              <ToneDot tone="running" live label="进行中" />
              <span>{counts.running}<span className="console__live-text"> 进行中</span></span>
            </span>
          )}
        </button>
        <button type="button" className={cx('console__summary', counts.errors > 0 && 'is-danger')} onClick={() => actions.openConsole('errors')}>
          <XOctagon size={13} aria-hidden />
          <span>错误 {counts.errors}</span>
        </button>
        <button type="button" className="console__latest" onClick={() => actions.openConsole('timeline')}
          title={lastEvent ? `最新事件：${lastEvent.text}` : undefined}>
          {lastEvent ? (
            <>
              <time className="console__latest-time" dateTime={new Date(lastEvent.at).toISOString()}>{timeOfDay(lastEvent.at)}</time>
              <span className="truncate">{lastEvent.text}</span>
            </>
          ) : <span>暂无事件</span>}
        </button>
        {info?.engineLabel && <EngineTag label={info.engineLabel} compact />}
      </div>

      {/* Open: resize handle, header, active tab. */}
      <div id={BODY_ID} className="console__content" hidden={!open}>
        <div className={cx('console__resize', dragging && 'is-dragging')} role="separator" aria-orientation="horizontal" aria-label="调整控制台高度"
          aria-valuenow={shown} aria-valuemin={MIN_H} aria-valuemax={maxH} aria-valuetext={`${shown} 像素`} tabIndex={0}
          onKeyDown={onResizeKey} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
          onDoubleClick={() => actions.setConsoleHeight(280)} />
        <header className="console__head">
          <Tabs<ConsoleTab> idBase="console" label="控制台内容" size="sm" items={tabs} value={tab} onChange={actions.setConsoleTab} />
          <div className="console__run">
            {info ? (
              <>
                <StatusChip meta={RUN_STATUS[info.status]} size="sm" className="console__run-status" />
                <span className="console__run-name truncate">{runLabel(info)} · {info.title}</span>
                {info.engineLabel && <EngineTag label={info.engineLabel} />}
              </>
            ) : <span className="console__run-name console__run-name--none">没有运行</span>}
          </div>
          <IconButton icon={ChevronDown} label="收起控制台" size="sm" aria-expanded aria-controls={BODY_ID}
            onClick={() => actions.toggleConsole(false)} />
        </header>
        {/* One panel element per tab so every tab's aria-controls resolves; only the active one has content. */}
        {tabs.map((t) => (
          <div key={t.id} {...tabPanelProps('console', t.id)} tabIndex={-1} className="console__panel" hidden={t.id !== tab}>
            {open && t.id === tab && panelFor(t.id, runId)}
          </div>
        ))}
      </div>
    </section>
  );
}
