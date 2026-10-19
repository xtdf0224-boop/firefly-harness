/* 最近任务 on the welcome page: up to four compact cards, newest activity first. */
import { ArrowRight } from 'lucide-react';
import { useMemo } from 'react';
import { StatusChip, SimTag, Button } from '../../ui';
import { useNow } from '../../../lib/hooks';
import { relative } from '../../../lib/format';
import { actions } from '../../../state/actions';
import { useApp } from '../../../state/store';
import { metaOf, selectSummaries, summariesEqual } from './taskInfo';

const LIMIT = 4;

export function RecentTasks() {
  const summaries = useApp(selectSummaries, summariesEqual);
  const now = useNow(30_000);
  const recent = useMemo(() => [...summaries].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LIMIT), [summaries]);
  if (!recent.length) return null;

  return (
    <section className="view__section new-task-recent" aria-labelledby="new-task-recent-title">
      <div className="new-task-recent__head">
        <h2 className="new-task-recent__title" id="new-task-recent-title">最近任务</h2>
        <Button variant="ghost" size="sm" iconRight={ArrowRight} onClick={() => actions.navigate('tasks')}>查看全部任务</Button>
      </div>
      <ul className="new-task-recent__list">
        {recent.map((t) => (
          <li key={t.id}>
            <button type="button" className="new-task-recent__card" onClick={() => actions.openTask(t.id)}>
              <span className="new-task-recent__top">
                <StatusChip meta={metaOf(t.status)} size="sm" />
                <SimTag source={t.source} />
              </span>
              <span className="new-task-recent__name">{t.title}</span>
              <span className="new-task-recent__time">更新于 {relative(t.updatedAt, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
