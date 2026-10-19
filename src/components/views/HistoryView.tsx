import { Check, History, List, Plus, Search, type LucideIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { clock, percent, tokens } from '../../lib/format';
import { RUN_STATUS } from '../../lib/status';
import { actions } from '../../state/actions';
import { useApp } from '../../state/store';
import { Button, EmptyState, Panel, cx } from '../ui';
import { HistoryTable } from './config/HistoryTable';
import { isFinished, matchesFilter, selectHistoryRows, type StatusFilter } from './config/historyData';
import { sameList } from './config/util';
import { ViewHeader } from './config/ViewHeader';

const FILTERS: Array<{ id: StatusFilter; label: string; icon: LucideIcon }> = [
  { id: 'all', label: '全部', icon: List },
  { id: 'completed', label: '已完成', icon: RUN_STATUS.completed.icon },
  { id: 'failed', label: '失败', icon: RUN_STATUS.failed.icon },
  { id: 'cancelled', label: '已取消', icon: RUN_STATUS.cancelled.icon },
  { id: 'open', label: '进行中', icon: RUN_STATUS.running.icon },
];

/** Every run of every task: summary tiles, status filters, search and the table. */
export function HistoryView() {
  const rows = useApp(selectHistoryRows, sameList);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const searchId = useId();

  const summary = useMemo(() => {
    const finished = rows.filter((r) => isFinished(r.status));
    const completed = finished.filter((r) => r.status === 'completed').length;
    const inTok = rows.reduce((n, r) => n + r.inputTokens, 0);
    const outTok = rows.reduce((n, r) => n + r.outputTokens, 0);
    return {
      total: rows.length,
      open: rows.length - finished.length,
      finished: finished.length,
      completed,
      rate: finished.length ? percent(completed, finished.length) : undefined,
      meanMs: finished.length ? finished.reduce((n, r) => n + r.activeMs, 0) / finished.length : undefined,
      inTok,
      outTok,
    };
  }, [rows]);

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, rows.filter((r) => matchesFilter(r.status, f.id)).length])) as Record<StatusFilter, number>,
    [rows],
  );

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => rows.filter((r) => matchesFilter(r.status, filter) && (!needle || r.title.toLowerCase().includes(needle))),
    [rows, filter, needle],
  );
  const filtered = filter !== 'all' || needle !== '';
  const clearFilters = () => { setFilter('all'); setQuery(''); };

  const tiles = [
    { id: 'total', label: '运行总数', value: String(summary.total), sub: `进行中 ${summary.open} · 已结束 ${summary.finished}` },
    { id: 'rate', label: '成功率', value: summary.rate != null ? `${summary.rate}%` : '—', sub: `已完成 ${summary.completed} / 已结束 ${summary.finished}` },
    { id: 'mean', label: '平均运行时间', value: summary.meanMs != null ? clock(summary.meanMs) : '—', sub: '分:秒 · 按已结束的运行计算' },
    { id: 'tokens', label: 'Token 总计', value: tokens(summary.inTok + summary.outTok), sub: `输入 ${tokens(summary.inTok)} · 输出 ${tokens(summary.outTok)}` },
  ];

  return (
    <div className="view history-view">
      <ViewHeader icon={History} title="运行历史" desc="所有工作任务的每一次运行：用了哪个模型、花了多久、用了多少 Token。闲聊不产生运行记录。" />

      {rows.length > 0 && (
        <ul className="history-tiles" aria-label="运行统计">
          {tiles.map((t) => (
            <li key={t.id} className="history-tile">
              <p className="label">{t.label}</p>
              <p className="history-tile__value">{t.value}</p>
              <p className="history-tile__sub">{t.sub}</p>
            </li>
          ))}
        </ul>
      )}

      <Panel
        title="运行记录"
        icon={History}
        energy
        flush
        actions={rows.length > 0 ? <span className="history-count">显示 {shown.length} / {rows.length}</span> : undefined}
      >
        {rows.length === 0 ? (
          <EmptyState
            icon={History}
            title="还没有运行记录"
            body="在「新建」里选「工作」，把一个目标交给 Agent，它的每一次运行都会记录在这里。"
            actions={<Button variant="primary" icon={Plus} onClick={() => actions.navigate('new')}>新建任务</Button>}
          />
        ) : (
          <>
            <div className="history-toolbar">
              <div className="history-filters" role="group" aria-label="按状态筛选">
                {FILTERS.map((f) => {
                  const on = filter === f.id;
                  const Icon = on ? Check : f.icon;
                  return (
                    <button key={f.id} type="button" className={cx('history-filter', on && 'is-on')} aria-pressed={on} onClick={() => setFilter(f.id)}>
                      <Icon size={14} aria-hidden />
                      <span>{f.label}</span>
                      <span className="history-filter__count">{counts[f.id]}</span>
                    </button>
                  );
                })}
              </div>
              <div className="history-search">
                <label htmlFor={searchId} className="sr-only">搜索任务标题</label>
                <Search size={14} aria-hidden />
                <input id={searchId} type="search" className="input" placeholder="搜索任务标题" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
              </div>
            </div>
            <p className="sr-only" role="status">显示 {shown.length} 条运行，共 {rows.length} 条</p>
            {shown.length > 0 ? (
              <HistoryTable rows={shown} />
            ) : (
              <EmptyState
                compact
                icon={Search}
                title="没有符合条件的运行"
                body={filtered ? '换个状态或关键词试试。' : undefined}
                actions={<Button size="sm" onClick={clearFilters}>清除筛选</Button>}
              />
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
