/* 事件时间线 tab: run / step / tool / approval events in order, newest at the bottom. */
import { ArrowDown, Bot, History, ListChecks, Play, SearchX, ShieldAlert, User, Wrench, XOctagon, type LucideIcon } from 'lucide-react';
import { memo, useMemo } from 'react';
import { timeOfDay } from '../../lib/format';
import type { EventKind, RunEvent } from '../../lib/types';
import { shallow, useApp } from '../../state/store';
import { Button, EmptyState, Segmented, cx } from '../ui';
import { useFollowScroll, useRemembered, useSpokenResult } from './consoleHooks';

type Scope = 'run' | 'all';
type KindFilter = 'all' | 'run' | 'step' | 'tool' | 'approval' | 'error';

const KIND_ICON: Record<EventKind, LucideIcon> = {
  run: Play, step: ListChecks, tool: Wrench, approval: ShieldAlert, agent: Bot, user: User, error: XOctagon,
};
const KIND_LABEL: Record<EventKind, string> = {
  run: '运行', step: '步骤', tool: '工具', approval: '确认', agent: 'Agent', user: '用户', error: '错误',
};
const KIND_FILTERS: Array<{ id: KindFilter; label: string }> = [
  { id: 'all', label: '全部' }, { id: 'run', label: '运行' }, { id: 'step', label: '步骤' }, { id: 'tool', label: '工具' },
  { id: 'approval', label: '确认' }, { id: 'error', label: '错误' },
];
const LEVEL_WORD: Partial<Record<RunEvent['level'], string>> = { warn: '警告', error: '错误' };

/** The 工具 chip also covers Agent retry notes (they are about a tool call); 错误 covers any error-level event. */
function matchKind(e: RunEvent, kind: KindFilter) {
  switch (kind) {
    case 'all': return true;
    case 'tool': return e.kind === 'tool' || e.kind === 'agent';
    case 'error': return e.kind === 'error' || e.level === 'error';
    default: return e.kind === kind;
  }
}

const NO_LABELS: Record<string, string> = {};

/* ── day separators: the rows only carry a time of day, so a list that crosses midnight would read
   as if time ran backwards. A separator marks every change of calendar day (and the start of the
   list when it is not today). ── */
type Row = { kind: 'day'; key: string; iso: string; label: string } | { kind: 'event'; event: RunEvent };

const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function dayLabel(at: number, today: Date) {
  const d = new Date(at);
  const diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return `${d.getFullYear() === today.getFullYear() ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日`;
}

function withDays(events: RunEvent[]): Row[] {
  const today = new Date();
  const todayKey = dayKey(today.getTime());
  const rows: Row[] = [];
  let prev: string | undefined;
  for (const event of events) {
    const key = dayKey(event.at);
    if (prev === undefined ? key !== todayKey : key !== prev) {
      rows.push({ kind: 'day', key: `day-${key}-${event.id}`, iso: key, label: dayLabel(event.at, today) });
    }
    rows.push({ kind: 'event', event });
    prev = key;
  }
  return rows;
}

export function TimelineTab({ runId }: { runId?: string }) {
  const events = useApp((s) => s.events);
  const [scope, setScope] = useRemembered<Scope>('tl.scope', 'run');
  const [kind, setKind] = useRemembered<KindFilter>('tl.kind', 'all');

  // Only the “all events” view labels which run an event belongs to.
  const runLabels = useApp((s) => {
    if (scope !== 'all') return NO_LABELS;
    return Object.fromEntries(Object.values(s.runs).map((r) => [r.id, `${s.tasks[r.taskId]?.title ?? '任务'} · 运行 #${r.attempt}`]));
  }, shallow);

  const visible = useMemo(
    () => events.filter((e) => (scope === 'all' || (runId !== undefined && e.runId === runId)) && matchKind(e, kind)),
    [events, scope, runId, kind],
  );
  const rows = useMemo(() => withDays(visible), [visible]);
  const scroll = useFollowScroll<HTMLDivElement>(rows.length);
  const filtering = kind !== 'all';
  const spoken = useSpokenResult(`${scope}|${kind}`, () => (visible.length === 0 ? '没有符合条件的事件' : `${visible.length} 条事件`));

  return (
    <>
      <div className="console__toolbar">
        <Segmented<Scope> size="sm" label="事件范围" value={scope} onChange={setScope} options={[
          { value: 'run', label: '当前运行' },
          { value: 'all', label: '全部事件', hint: '包括其他运行的事件' },
        ]} />
        <div className="console-chips" role="group" aria-label="事件类型">
          {KIND_FILTERS.map((f) => (
            <button key={f.id} type="button" className="console-chip" aria-pressed={kind === f.id} onClick={() => setKind(f.id)}>{f.label}</button>
          ))}
        </div>
        <div className="console__toolbar-end">
          <span className="console__hint">{visible.length} 条事件</span>
          <span className="sr-only" role="status">{spoken}</span>
        </div>
      </div>

      <div className="console__pane">
        <div ref={scroll.ref} className="console__scroll" onScroll={scroll.onScroll}>
          {visible.length > 0 ? (
            <ol className="tl" aria-label="事件时间线">
              {rows.map((row) => row.kind === 'day' ? (
                <li key={row.key} className="tl__day"><time dateTime={row.iso}>{row.label}</time></li>
              ) : (
                <TimelineItem key={row.event.id} event={row.event}
                  source={scope === 'all' && row.event.runId && row.event.runId !== runId ? runLabels[row.event.runId] : undefined} />
              ))}
            </ol>
          ) : filtering ? (
            <EmptyState compact icon={SearchX} title="没有符合条件的事件" body="换一个事件类型试试。"
              actions={<Button size="sm" variant="secondary" onClick={() => setKind('all')}>显示全部类型</Button>} />
          ) : scope === 'run' && !runId ? (
            <EmptyState compact icon={History} title="还没有运行" body="开始一个任务后，它的事件会按时间显示在这里。" />
          ) : (
            <EmptyState compact icon={History} title="还没有事件"
              body="运行、步骤、工具调用和确认都会记录在这里。"
              actions={scope === 'run' ? <Button size="sm" variant="secondary" onClick={() => setScope('all')}>查看全部事件</Button> : undefined} />
          )}
        </div>
        {!scroll.following && visible.length > 0 && (
          <button type="button" className="console__jump" onClick={scroll.jump}>
            <ArrowDown size={13} aria-hidden />跳到最新
          </button>
        )}
      </div>
    </>
  );
}

const TimelineItem = memo(function TimelineItem({ event, source }: { event: RunEvent; source?: string }) {
  // Events saved by older versions can carry a kind that no longer exists.
  const Icon = KIND_ICON[event.kind] ?? History;
  const word = LEVEL_WORD[event.level];
  return (
    <li className={cx('tl__item', `tl__item--${event.level}`)}>
      <time className="tl__time" dateTime={new Date(event.at).toISOString()}>{timeOfDay(event.at)}</time>
      <span className="tl__node"><Icon size={12} aria-hidden /></span>
      <div className="tl__body">
        <span className="tl__text">
          <span className="sr-only">{KIND_LABEL[event.kind] ?? '事件'}：</span>
          {event.text}
          {word && <span className="tl__level">{word}</span>}
        </span>
        {source && <span className="tl__src">{source}</span>}
      </div>
    </li>
  );
});
