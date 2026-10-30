/* Header panel of the workspace: back link, run selector, drawer button, task title + run status,
   run controls and the compact run meta (time · steps · tokens). */
import { ArrowLeft, Clock3, FolderOpen, History, PanelRight } from 'lucide-react';
import { desktop } from '../../lib/desktop';
import { clock, tokens } from '../../lib/format';
import { useMedia } from '../../lib/hooks';
import { RUN_STATUS } from '../../lib/status';
import { actions } from '../../state/actions';
import { pendingApprovals } from '../../state/selectors';
import { shallow, useApp } from '../../state/store';
import { Badge, Button, EngineTag, IconButton, StatusChip } from '../ui';
import { MenuSelect } from '../ui/MenuSelect';
import { RunControls } from './RunControls';
import { NO_RUN_META, stepCounts } from './shared';

const NO_ITEMS: string[] = [];

/** The desktop side answers with an error text when the folder is gone or cannot be opened (an empty string means it opened). */
async function openFolder(dir: string) {
  let error = '';
  try { error = (await desktop?.openFolder(dir)) ?? ''; } catch (e) { error = e instanceof Error ? e.message : String(e); }
  if (error) actions.toast({ tone: 'warning', title: '没能打开工作文件夹', body: error });
}

export interface RunHeaderProps {
  taskId: string;
  /** The run being viewed (selected, or the latest). */
  runId?: string;
  /** The task's latest run: the one the controls act on. */
  latestId?: string;
}

export function RunHeader({ taskId, runId, latestId }: RunHeaderProps) {
  const task = useApp((s) => {
    const t = s.tasks[taskId];
    return t ? { title: t.title, runs: t.runIds.length, engine: t.engine?.label, cwd: t.engine?.cwd } : undefined;
  }, shallow);
  // Primitives only: seconds instead of ms keeps the header at ~1 render per second while running.
  const run = useApp((s) => {
    const r = runId ? s.runs[runId] : undefined;
    if (!r) return undefined;
    const { done, skipped, total } = stepCounts(r.plan);
    return {
      status: r.status, attempt: r.attempt, engine: r.engineLabel, sec: Math.floor(r.activeMs / 1000),
      done, skipped, total, planReady: r.planReady, tokens: r.usage.inputTokens + r.usage.outputTokens,
    };
  }, shallow);
  const latest = useApp((s) => {
    const r = latestId ? s.runs[latestId] : undefined;
    return r ? { status: r.status, attempt: r.attempt } : undefined;
  }, shallow);
  const pending = useApp((s) => pendingApprovals(s).length);
  const narrow = useMedia('(max-width: 1279px)');

  if (!task) return null;
  const meta = run ? RUN_STATUS[run.status] : NO_RUN_META;
  const historic = !!run && !!latestId && runId !== latestId;
  // The viewed run's model wins: an older run may have used another one than the task has now.
  const engine = run?.engine ?? task.engine;

  return (
    <section className="panel ws-header" aria-label="任务概览" data-run={run?.status ?? 'draft'} data-live={run?.status === 'running' ? 'true' : undefined}>
      <div className="panel__header panel__header--energy ws-header__bar">
        <div className="panel__heading">
          <IconButton icon={ArrowLeft} label="返回任务列表" onClick={() => actions.navigate('tasks')} />
          <span className="label">任务</span>
          {engine && <EngineTag label={engine} />}
        </div>
        <div className="panel__actions ws-header__tools">
          {task.cwd && desktop && (
            <IconButton icon={FolderOpen} variant="ghost" label={`打开工作文件夹：${task.cwd}`} onClick={() => void openFolder(task.cwd!)} />
          )}
          {task.runs > 1 && runId && <RunSelect taskId={taskId} value={runId} />}
          {narrow && (
            <span className="ws-drawer-btn">
              <IconButton
                icon={PanelRight} variant="secondary" onClick={() => actions.toggleStatusDrawer(true)}
                label={pending ? `打开状态面板（${pending} 项待确认）` : '打开状态面板'}
              />
              {pending > 0 && <span className="ws-drawer-btn__badge" aria-hidden><Badge tone="warning">{pending}</Badge></span>}
            </span>
          )}
        </div>
        {/* Energy sweep along the line while a run is live; hidden under reduced motion. */}
        <span className="ws-sweep" aria-hidden><i /></span>
      </div>

      <div className="ws-header__title">
        <h1 className="ws-title">{task.title}</h1>
        <span className="ws-status" data-celebrate-target>
          <StatusChip meta={meta} size="lg" />
        </span>
        {run && task.runs > 1 && <span className="ws-attempt">运行 #{run.attempt}</span>}
      </div>

      <div className="ws-header__controls">
        <RunControls taskId={taskId} runId={latestId} status={latest?.status} />
        {run && (
          <div className="ws-meta">
            <dl aria-label="运行概况">
              <div><dt>运行时间</dt><dd>{clock(run.sec * 1000)}</dd></div>
              <div>
                <dt>步骤</dt>
                <dd>
                  {run.planReady ? `${run.done}/${run.total}` : '—'}
                  {run.planReady && run.skipped > 0 && <span className="ws-meta__skip"> · {run.skipped} 步已跳过</span>}
                </dd>
              </div>
              <div><dt>Token</dt><dd>{run.tokens > 0 ? tokens(run.tokens) : '—'}</dd></div>
            </dl>
          </div>
        )}
      </div>

      {historic && run && latest && (
        <p className="ws-historic">
          <Clock3 size={14} aria-hidden />
          <span>
            正在查看历史运行 #{run.attempt}。上方的操作作用于最新的运行 #{latest.attempt}（{RUN_STATUS[latest.status].label}）。
          </span>
          <Button size="sm" variant="secondary" onClick={() => latestId && actions.selectRun(latestId)}>回到最新</Button>
        </p>
      )}
    </section>
  );
}

/** The task's runs, newest first, in the app's own menu. */
function RunSelect({ taskId, value }: { taskId: string; value: string }) {
  // "runId|attempt|status" strings compare shallowly, so the list does not re-render every tick.
  const items = useApp((s) => s.tasks[taskId]?.runIds
    .map((rid) => { const r = s.runs[rid]; return r ? `${rid}|${r.attempt}|${r.status}` : ''; })
    .filter(Boolean)
    .reverse() ?? NO_ITEMS, shallow);
  const options = items.map((item, i) => {
    const [rid, attempt, status] = item.split('|');
    return { value: rid, label: `运行 #${attempt}`, sub: i === 0 ? '最新' : undefined, meta: RUN_STATUS[status as keyof typeof RUN_STATUS].label };
  });
  return <MenuSelect variant="chip" icon={History} label="查看运行" value={value} options={options} onChange={actions.selectRun} search={false} minWidth={200} />;
}
