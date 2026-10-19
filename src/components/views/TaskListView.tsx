/* 任务列表 (view 'tasks'): every task with the state of its latest run. Search, status filter and
   sort are local view state. Rows come from selectSummaries (flat, comparable), so the engine's
   five-per-second commits don't repaint the list unless something visible changed. */
import { FilterX, Plus, RotateCcw, SearchX, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNow } from '../../lib/hooks';
import { actions } from '../../state/actions';
import { useApp } from '../../state/store';
import { Badge, Button, EmptyState, Panel, SimTag } from '../ui';
import { TaskRow } from './tasks/TaskRow';
import { FILTERS, TaskToolbar, type SortKey, type StatusFilter } from './tasks/TaskToolbar';
import { selectSummaries, summariesEqual } from './tasks/taskInfo';

export function TaskListView() {
  const tasks = useApp(selectSummaries, summariesEqual);
  const agents = useApp((s) => s.agents);
  const now = useNow(30_000);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('updated');

  const q = query.trim().toLowerCase();
  // Counts follow the search, so each pill shows what clicking it would list.
  const searched = useMemo(
    () => (q ? tasks.filter((t) => t.title.toLowerCase().includes(q) || t.goal.toLowerCase().includes(q)) : tasks),
    [tasks, q],
  );
  const counts = useMemo(() => {
    const out = {} as Record<StatusFilter, number>;
    for (const f of FILTERS) out[f.id] = searched.filter((t) => f.test(t.status)).length;
    return out;
  }, [searched]);
  const visible = useMemo(() => {
    const test = FILTERS.find((f) => f.id === status)?.test ?? (() => true);
    const key = sort === 'created' ? 'createdAt' : 'updatedAt';
    return searched.filter((t) => test(t.status)).sort((a, b) => b[key] - a[key]);
  }, [searched, status, sort]);

  const clearFilters = () => { setQuery(''); setStatus('all'); };

  return (
    <div className="view task-list-view">
      <header className="view__header">
        <div className="view__heading">
          <h1 className="view__title">
            任务列表
            {tasks.length > 0 && (
              <Badge tone="neutral" title={`共 ${tasks.length} 个任务`}>
                {tasks.length}<span className="sr-only"> 个任务</span>
              </Badge>
            )}
          </h1>
          <p className="view__desc">所有任务及其最近一次运行的状态。</p>
        </div>
        <div className="view__actions">
          <Button variant="primary" icon={Plus} onClick={() => actions.navigate('new')}>新建任务</Button>
        </div>
      </header>

      <Panel className="task-list-panel" aria-label="任务列表" flush>
        {tasks.length === 0 ? (
          <div className="task-list-empty">
            <span className="task-list-empty__spark task-list-empty__spark--a" aria-hidden />
            <span className="task-list-empty__spark task-list-empty__spark--b" aria-hidden />
            <span className="task-list-empty__spark task-list-empty__spark--c" aria-hidden />
            <div className="task-list-empty__stage">
              <span className="task-list-empty__rings" aria-hidden />
              <EmptyState
                icon={Sparkles}
                title="还没有任务"
                body="从一个清晰的目标开始，Agent 会帮你拆解步骤、调用工具，并在关键操作前征求你的确认。"
                actions={(
                  <>
                    <Button variant="primary" icon={Plus} onClick={() => actions.navigate('new')}>新建任务</Button>
                    <Button variant="ghost" icon={RotateCcw} onClick={() => actions.openDialog({ kind: 'reset-demo' })}>恢复示例任务</Button>
                  </>
                )}
              />
            </div>
            <p className="task-list-empty__note">
              <SimTag />
              <span>演示模式：新任务由浏览器内的模拟器执行。</span>
            </p>
          </div>
        ) : (
          <>
            <TaskToolbar
              query={query} onQuery={setQuery} status={status} onStatus={setStatus} counts={counts}
              sort={sort} onSort={setSort} shown={visible.length} total={tasks.length}
            />
            {visible.length === 0 ? (
              <EmptyState
                compact
                icon={SearchX}
                title="没有符合条件的任务"
                body="换个关键词，或者查看全部状态。"
                actions={<Button icon={FilterX} onClick={clearFilters}>清除筛选</Button>}
                className="task-list-nomatch"
              />
            ) : (
              <ul className="task-list-rows" aria-label="任务">
                {visible.map((t) => <TaskRow key={t.id} task={t} agents={agents} now={now} />)}
              </ul>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
