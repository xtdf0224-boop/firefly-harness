/* Search, status filter (toggle buttons with counts) and sort for the task list. */
import { Check, List, Search, type LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { RUN_STATUS } from '../../../lib/status';
import type { TaskStatus } from '../../../state/selectors';
import { cx } from '../../ui';
import { MenuSelect } from '../../ui/MenuSelect';
import { DRAFT_META } from './taskInfo';

export type StatusFilter = 'all' | 'active' | 'awaiting' | 'completed' | 'failed' | 'cancelled' | 'draft';
export type SortKey = 'updated' | 'created';

interface FilterDef { id: StatusFilter; label: string; icon: LucideIcon; test: (status: TaskStatus) => boolean }

export const FILTERS: FilterDef[] = [
  { id: 'all',       label: '全部',     icon: List,                   test: () => true },
  { id: 'active',    label: '进行中',   icon: RUN_STATUS.running.icon, test: (s) => s === 'queued' || s === 'running' || s === 'paused' },
  { id: 'awaiting',  label: '等待确认', icon: RUN_STATUS.awaiting.icon, test: (s) => s === 'awaiting' },
  { id: 'completed', label: '已完成',   icon: RUN_STATUS.completed.icon, test: (s) => s === 'completed' },
  { id: 'failed',    label: '失败',     icon: RUN_STATUS.failed.icon,   test: (s) => s === 'failed' },
  { id: 'cancelled', label: '已取消',   icon: RUN_STATUS.cancelled.icon, test: (s) => s === 'cancelled' },
  { id: 'draft',     label: '未开始',   icon: DRAFT_META.icon,         test: (s) => s === 'draft' },
];

export const SORTS: Array<{ id: SortKey; label: string }> = [
  { id: 'updated', label: '最近更新' },
  { id: 'created', label: '创建时间' },
];

export function TaskToolbar({ query, onQuery, status, onStatus, counts, sort, onSort, shown, total }: {
  query: string;
  onQuery: (q: string) => void;
  status: StatusFilter;
  onStatus: (s: StatusFilter) => void;
  counts: Record<StatusFilter, number>;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  shown: number;
  total: number;
}) {
  const uid = useId();
  return (
    <div className="task-list-toolbar">
      <div className="task-list-toolbar__top">
        <div className="task-list-search">
          <label className="sr-only" htmlFor={`${uid}-q`}>搜索任务</label>
          <Search className="task-list-search__icon" size={15} aria-hidden />
          <input
            id={`${uid}-q`}
            className="input"
            type="search"
            value={query}
            autoComplete="off"
            placeholder="搜索标题或目标"
            onChange={(e) => onQuery(e.target.value)}
          />
        </div>
        <div className="task-list-sort">
          <span className="task-list-sort__label" aria-hidden>排序</span>
          <MenuSelect<SortKey> variant="field" label="排序" value={sort} onChange={onSort} options={SORTS.map((o) => ({ value: o.id, label: o.label }))} />
        </div>
        <p className="task-list-toolbar__count" role="status">
          {shown === total ? `共 ${total} 个任务` : `显示 ${shown} / ${total} 个任务`}
        </p>
      </div>
      <div className="task-list-filters" role="group" aria-label="按状态筛选">
        {FILTERS.map((f) => {
          const pressed = f.id === status;
          // Pressed = filled mint pill with a tick in place of the status icon (same as History).
          const Icon = pressed ? Check : f.icon;
          return (
            <button key={f.id} type="button" className={cx('task-list-filter', pressed && 'is-active')} aria-pressed={pressed} onClick={() => onStatus(f.id)}>
              <Icon size={14} aria-hidden />
              <span>{f.label}</span>
              <span className="task-list-filter__count">{counts[f.id]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
