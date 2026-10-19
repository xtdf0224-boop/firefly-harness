/* Which run the console follows. On a task page it mirrors the workspace; elsewhere it falls back
   to the most recently started open run, then the most recently started run, then nothing. */
import { isOpenRun } from '../../lib/status';
import type { AppState, Run } from '../../lib/types';
import { currentRun } from '../../state/selectors';

const startedOf = (run: Run) => run.startedAt ?? run.createdAt;

export function consoleRunId(s: AppState): string | undefined {
  if (s.view === 'task' && s.selectedTaskId && s.tasks[s.selectedTaskId]) return currentRun(s)?.id;
  let open: Run | undefined;
  let latest: Run | undefined;
  for (const run of Object.values(s.runs)) {
    if (!latest || startedOf(run) > startedOf(latest)) latest = run;
    if (isOpenRun(run.status) && (!open || startedOf(run) > startedOf(open))) open = run;
  }
  return (open ?? latest)?.id;
}
