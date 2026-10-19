/* 工具调用 tab: filter, search, and the chronological list of ToolCallItem. */
import { ArrowDown, Search, SearchX, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { json } from '../../lib/format';
import type { ToolCall } from '../../lib/types';
import { actions } from '../../state/actions';
import { shallow, useApp } from '../../state/store';
import { Button, EmptyState, Segmented, cx } from '../ui';
import { useFollowScroll, useRemembered, useSpokenResult } from './consoleHooks';
import { ToolCallItem } from './ToolCallItem';

type CallFilter = 'all' | 'running' | 'awaiting' | 'error';

const EMPTY_CALLS: ToolCall[] = [];
const matchFilter = (call: ToolCall, filter: CallFilter) => filter === 'all' || call.status === filter;

/** Lower-cased search text per call. Calls are immutable snapshots, so the result can be cached. */
const haystacks = new WeakMap<ToolCall, string>();
function haystack(call: ToolCall, agentName: string) {
  let text = haystacks.get(call);
  if (text === undefined) {
    text = [call.title, call.tool, agentName, call.error?.code, call.error?.message, json(call.input)].filter(Boolean).join('\n').toLowerCase();
    haystacks.set(call, text);
  }
  return text;
}

export function ToolCallsTab({ runId }: { runId?: string }) {
  const calls = useApp((s) => (runId ? s.runs[runId]?.toolCalls : undefined)) ?? EMPTY_CALLS;
  const paused = useApp((s) => (runId ? s.runs[runId]?.status === 'paused' : false));
  const agents = useApp((s) => s.agents);
  const focusId = useApp((s) => s.console.focusId);

  const [filter, setFilter] = useRemembered<CallFilter>('calls.filter', 'all');
  const [query, setQuery] = useRemembered('calls.query', '');
  const q = query.trim().toLowerCase();

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  const counts = useApp((s) => {
    const list = runId ? s.runs[runId]?.toolCalls ?? EMPTY_CALLS : EMPTY_CALLS;
    return {
      all: list.length,
      running: list.filter((c) => c.status === 'running').length,
      awaiting: list.filter((c) => c.status === 'awaiting').length,
      error: list.filter((c) => c.status === 'error').length,
    };
  }, shallow);

  const visible = useMemo(
    () => calls.filter((c) => matchFilter(c, filter) && (!q || haystack(c, agentName(c.agentId)).includes(q))),
    [calls, filter, q, agents],
  );

  const scroll = useFollowScroll<HTMLDivElement>(visible.length);
  const spoken = useSpokenResult(`${filter}|${q}`, () => (
    visible.length === 0 ? '没有符合条件的调用'
      : filter === 'all' && !q ? `显示全部 ${counts.all} 次调用` : `显示 ${visible.length} / ${counts.all} 次调用`
  ));

  /* ── “view this call” requests from toasts, the errors tab and the steps view ── */
  const [flashId, setFlashId] = useState<string>();
  const timers = useRef<{ flash?: number; raf?: number }>({});
  useEffect(() => () => {
    window.clearTimeout(timers.current.flash);
    cancelAnimationFrame(timers.current.raf ?? 0);
  }, []);

  useEffect(() => {
    if (!focusId) return;
    const target = calls.find((c) => c.id === focusId);
    if (target) {
      // A filter or search that hides the call would make the request a silent no-op.
      if (!matchFilter(target, filter) || (q && !haystack(target, agentName(target.agentId)).includes(q))) {
        setFilter('all');
        setQuery('');
      }
      scroll.setFollowing(false);
      setFlashId(focusId);
      window.clearTimeout(timers.current.flash);
      timers.current.flash = window.setTimeout(() => setFlashId(undefined), 1800);
      cancelAnimationFrame(timers.current.raf ?? 0);
      // Two frames: let the filter reset and the expansion render before measuring.
      timers.current.raf = requestAnimationFrame(() => {
        timers.current.raf = requestAnimationFrame(() => {
          const box = scroll.ref.current;
          const el = box?.querySelector<HTMLElement>(`[data-call-id="${CSS.escape(focusId)}"]`);
          if (box && el) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
          // Land keyboard focus on the row: the tab that asked (errors, a toast) may have unmounted.
          el?.querySelector<HTMLElement>('.tool-call__toggle')?.focus({ preventScroll: true });
        });
      });
    }
    // The request is one-shot: consume it so returning to this tab later does not replay it.
    actions.openConsole('tools');
  }, [focusId]);

  const clearFilters = () => { setFilter('all'); setQuery(''); };
  const filtering = filter !== 'all' || q !== '';

  return (
    <>
      <div className="console__toolbar">
        <Segmented<CallFilter> size="sm" label="按状态筛选工具调用" value={filter} onChange={setFilter} options={[
          { value: 'all', label: `全部 ${counts.all}` },
          { value: 'running', label: `进行中 ${counts.running}` },
          { value: 'awaiting', label: `待确认 ${counts.awaiting}` },
          { value: 'error', label: `出错 ${counts.error}` },
        ]} />
        {filtering && counts.all > 0 && <span className="console__hint">显示 {visible.length} / {counts.all}</span>}
        <span className="sr-only" role="status">{spoken}</span>
        <div className="console__search">
          <Search size={14} aria-hidden />
          <label className="sr-only" htmlFor="console-call-search">搜索工具调用</label>
          <input id="console-call-search" className="input" type="search" value={query} placeholder="搜索工具调用"
            autoComplete="off" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      <div className="console__pane">
        <div ref={scroll.ref} className="console__scroll" onScroll={scroll.onScroll} onClickCapture={scroll.onClickCapture}>
          {visible.length > 0 ? (
            <ol className="console-calls" aria-label="工具调用列表">
              {visible.map((call) => (
                <li key={call.id} className={cx('console-calls__item', call.id === flashId && 'is-flash')}>
                  <ToolCallItem call={call} showStep paused={paused} defaultOpen={call.id === focusId} />
                </li>
              ))}
            </ol>
          ) : counts.all === 0 ? (
            <EmptyState compact icon={Wrench}
              title={runId ? '这次运行还没有工具调用' : '还没有运行'}
              body={runId ? 'Agent 调用工具后，输入、输出和耗时会显示在这里。' : '开始一个任务后，Agent 的工具调用会显示在这里。'} />
          ) : (
            <EmptyState compact icon={SearchX} title="没有符合条件的调用" body="换一个状态或关键词试试。"
              actions={<Button size="sm" variant="secondary" onClick={clearFilters}>清除筛选</Button>} />
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
