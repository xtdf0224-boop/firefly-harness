/* 右侧运行状态面板：运行、活跃 Agent、模型、上下文、Token、待确认操作。
   每个分区自己订阅所需的最小切片，所以引擎每秒 5 次提交运行时间时只有「运行」分区重绘。 */
import { CheckCircle2, PauseCircle, Radar, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from 'react';
import { clock, percent, tokens } from '../../lib/format';
import { useMedia, useNow, useReducedMotion } from '../../lib/hooks';
import { AGENT_ACTIVITY, CONNECTION_STATUS, RUN_STATUS, isOpenRun } from '../../lib/status';
import type { AgentId, AppState, Approval, Run, Tone } from '../../lib/types';
import { actions } from '../../state/actions';
import { agentActivity, currentRun, gateway, openRuns, pendingApprovals, runLabel, stepProgress, wallMs } from '../../state/selectors';
import { shallow, useApp } from '../../state/store';
import { AgentAvatar, Badge, EmptyState, IconButton, Meter, SimTag, Sparkline, StatusChip, cx } from '../ui';
import { ApprovalCard } from './ApprovalCard';
import { DRAWER_QUERY } from './queries';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const PAUSE_REASON: Record<NonNullable<Run['pauseReason']>, string> = {
  user: '你暂停了运行',
  disconnected: '连接断开后自动暂停',
  reload: '页面重新载入后暂停',
};

/** 面板展示哪个运行：任务视图里是当前任务的运行，其他视图里是最近开始的进行中运行。 */
function panelRunId(s: AppState): string | undefined {
  if (s.view === 'task') return currentRun(s)?.id;
  let best: Run | undefined;
  for (const r of openRuns(s)) {
    if (!best || (r.startedAt ?? r.createdAt) > (best.startedAt ?? best.createdAt)) best = r;
  }
  return best?.id;
}

function Section({ title, right, className, innerRef, flash, focusable, children }: {
  title: string;
  right?: ReactNode;
  className?: string;
  innerRef?: Ref<HTMLElement>;
  flash?: boolean;
  focusable?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={cx('status-panel__section', className, flash && 'is-flash')} aria-labelledby={id} ref={innerRef} tabIndex={focusable ? -1 : undefined}>
      <div className="status-panel__head">
        <h2 className="label status-panel__heading" id={id}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

/* ───────────── 运行 ───────────── */

function RunSection({ runId, taskView, viewTaskId }: { runId: string; taskView: boolean; viewTaskId: string | undefined }) {
  const run = useApp((s) => s.runs[runId]);
  const taskTitle = useApp((s) => { const r = s.runs[runId]; return r ? s.tasks[r.taskId]?.title : undefined; });
  const open = !!run && isOpenRun(run.status);
  const now = useNow(1000, open);
  if (!run) return null;

  const meta = RUN_STATUS[run.status];
  const { total, current } = stepProgress(run);
  // Counted here from the plan so the numbers stay right whichever way stepProgress treats skipped steps:
  // `done` = actually executed, `skipped` = rejected / disabled, `finished` = how far through the plan the run is.
  const done = run.plan.filter((p) => p.status === 'done').length;
  const skipped = run.plan.filter((p) => p.status === 'skipped').length;
  const finished = done + skipped;
  const planning = open && !run.planReady;
  const foreign = !taskView || viewTaskId !== run.taskId;

  let currentText: string | undefined;
  if (planning) currentText = run.live?.text ?? '拆解目标、制定计划';
  else if (run.status === 'failed' && run.failure) {
    const failed = run.plan.find((p) => p.id === run.failure!.stepId);
    currentText = failed ? `失败于第 ${failed.index + 1} 步 · ${failed.title}` : run.failure.message;
  } else if (open && current >= 0) currentText = `第 ${current + 1} 步 · ${run.plan[current].title}`;
  else if (run.status === 'completed') currentText = skipped > 0 ? `已完成 ${done} 步，${skipped} 步已跳过` : `全部 ${total} 步已完成`;

  return (
    <Section title="运行">
      {foreign && taskTitle && (
        <p className="status-panel__viewing">
          <span>正在查看：</span>
          <button type="button" className="shell-link" title={taskTitle} onClick={() => actions.openTask(run.taskId)}>{taskTitle}</button>
        </p>
      )}
      <div className={cx('status-panel__run', run.status === 'running' && 'is-breathing')}>
        <div className="status-panel__runhead">
          <span className="status-panel__chip" data-celebrate-target={taskView ? undefined : ''}>
            <StatusChip meta={meta} size="lg" glow={false} />
          </span>
          <span className="status-panel__runno">{runLabel(run)}</span>
          <SimTag source={run.source} />
        </div>
        {run.status === 'paused' && run.pauseReason && (
          <p className="status-panel__note">
            <PauseCircle size={14} aria-hidden />
            <span>{PAUSE_REASON[run.pauseReason]}</span>
          </p>
        )}
        <dl className="kv">
          <dt>运行时间</dt>
          <dd className="mono">{clock(run.activeMs)}</dd>
          <dt>总耗时</dt>
          <dd className="mono">{clock(wallMs(run, now))}</dd>
          <dt>步骤</dt>
          <dd>
            {planning || total === 0 ? '计划生成中' : `${finished} / ${total}`}
            {!planning && skipped > 0 && <span className="status-panel__skipped">（含 {skipped} 步已跳过）</span>}
          </dd>
        </dl>
        {!planning && total > 0 && (
          <Meter
            value={finished}
            max={total}
            label="步骤进度"
            tone={run.status === 'failed' ? 'danger' : run.status === 'completed' ? 'success' : 'running'}
            segments={Math.min(24, Math.max(3, total * 3))}
            valueText={skipped > 0 ? `已完成 ${done} 步，跳过 ${skipped} 步，共 ${total} 步` : `已完成 ${done} 步，共 ${total} 步`}
          />
        )}
        {currentText && <p className="status-panel__step">{currentText}</p>}
      </div>
    </Section>
  );
}

/* ───────────── Agent ───────────── */

function AgentRow({ runId, agentId }: { runId: string; agentId: AgentId }) {
  const agent = useApp((s) => s.agents.find((a) => a.id === agentId));
  const activity = useApp((s) => agentActivity(s, s.runs[runId], agentId));
  const liveText = useApp((s) => {
    const r = s.runs[runId];
    return r && isOpenRun(r.status) && r.live?.agentId === agentId ? r.live.text : undefined;
  });
  if (!agent) return null;
  const meta = AGENT_ACTIVITY[activity];
  return (
    <li className={cx('status-panel__agent', liveText !== undefined && 'is-live')} data-tone={meta.tone}>
      <span aria-hidden="true"><AgentAvatar agent={agent} activity={activity} /></span>
      <div className="status-panel__agent-main">
        <div className="status-panel__agent-top">
          <span className="status-panel__agent-name truncate">{agent.name}</span>
          <StatusChip meta={meta} size="sm" />
        </div>
        <p className="status-panel__agent-text">{liveText ?? '待命'}</p>
        <p className="status-panel__agent-model">{agent.model}</p>
      </div>
    </li>
  );
}

function AgentSection({ runId }: { runId: string }) {
  const agentIds = useApp((s) => { const r = s.runs[runId]; return r ? s.tasks[r.taskId]?.agentIds : undefined; }, shallow);
  if (!agentIds || agentIds.length === 0) return null;
  return (
    <Section title="活跃 Agent">
      <ul className="status-panel__agents">
        {agentIds.map((id) => <AgentRow key={id} runId={runId} agentId={id} />)}
      </ul>
    </Section>
  );
}

/* ───────────── 模型 ───────────── */

function ModelSection() {
  const gw = useApp(gateway);
  const model = useApp((s) => s.agents.find((a) => a.id === 'orchestrator')?.model);
  // No gateway configured also means nothing real is being called.
  const simulated = !gw || gw.simulated;
  return (
    <Section title="模型" right={gw ? <SimTag source={gw.simulated ? 'simulated' : 'live'} /> : undefined}>
      <dl className="kv">
        {gw ? (
          <>
            <dt>{gw.name}</dt>
            <dd><StatusChip meta={CONNECTION_STATUS[gw.status]} size="sm" /></dd>
            <dt>延迟</dt>
            <dd className="mono">{gw.latencyMs != null ? `${gw.latencyMs} ms` : '—'}</dd>
          </>
        ) : (
          <>
            <dt>模型网关</dt>
            <dd>未配置</dd>
          </>
        )}
        <dt>主模型</dt>
        <dd className="mono status-panel__model">{model ?? '—'}</dd>
      </dl>
      {gw?.detail && <p className="status-panel__muted">{gw.detail}</p>}
      {simulated && <p className="status-panel__muted">演示模式不调用模型</p>}
    </Section>
  );
}

/* ───────────── 上下文 / Token ───────────── */

function ContextSection({ runId }: { runId: string }) {
  const usage = useApp((s) => s.runs[runId]?.usage);
  const source = useApp((s) => s.runs[runId]?.source ?? 'simulated');
  if (!usage) return null;
  const pct = percent(usage.contextUsed, usage.contextLimit);
  const tone: Tone = pct > 90 ? 'danger' : pct > 75 ? 'warning' : 'running';
  return (
    <Section title="上下文" right={<SimTag source={source} compact />}>
      <Meter value={usage.contextUsed} max={usage.contextLimit} label="上下文使用量" tone={tone} segments={24} valueText={`已使用 ${pct}%`} />
      <p className="status-panel__figure">
        <span className="mono tabular">{tokens(usage.contextUsed)} / {tokens(usage.contextLimit)}</span>
        <span aria-hidden="true"> · </span>
        <span className="tabular">{pct}%</span>
        {pct > 75 && (
          <span className={cx('status-panel__warn', pct > 90 && 'is-danger')}>
            <TriangleAlert size={12} aria-hidden />
            {pct > 90 ? '即将用满' : '用量偏高'}
          </span>
        )}
      </p>
    </Section>
  );
}

function TokenSection({ runId }: { runId: string }) {
  const usage = useApp((s) => s.runs[runId]?.usage);
  const source = useApp((s) => s.runs[runId]?.source ?? 'simulated');
  if (!usage) return null;
  const stats: Array<[string, number, boolean?]> = [
    ['输入', usage.inputTokens],
    ['输出', usage.outputTokens],
    ['缓存命中', usage.cachedTokens],
    ['合计', usage.inputTokens + usage.outputTokens, true],
  ];
  return (
    <Section title="Token 消耗" right={<SimTag source={source} />}>
      <dl className="status-panel__stats">
        {stats.map(([label, value, strong]) => (
          <div key={label} className={cx('status-panel__stat', strong && 'is-total')}>
            <dt>{label}</dt>
            <dd className="mono tabular">{tokens(value)}</dd>
          </div>
        ))}
      </dl>
      <Sparkline values={usage.series} label="Token 累计曲线" width={282} height={36} />
      {source !== 'live' && <p className="status-panel__muted">{source === 'sample' ? '示例数据' : '模拟计量'}，不对应真实账单</p>}
    </Section>
  );
}

/* ───────────── 待确认操作 ───────────── */

function ApprovalsSection({ approvals, innerRef, flash }: { approvals: Approval[]; innerRef: Ref<HTMLElement>; flash: boolean }) {
  const count = approvals.length;
  return (
    <Section
      title="待确认操作"
      className={cx('status-panel__section--approvals', count > 0 && 'has-pending')}
      innerRef={innerRef}
      flash={flash}
      focusable
      right={count > 0 ? <Badge tone="warning">{count}<span className="sr-only"> 个待确认</span></Badge> : undefined}
    >
      {count > 0 ? (
        <ul className="status-panel__approvals">
          {approvals.map((a) => <li key={a.id}><ApprovalCard approval={a} compact showTask /></li>)}
        </ul>
      ) : (
        <p className="status-panel__none"><CheckCircle2 size={14} aria-hidden /><span>没有待确认的操作</span></p>
      )}
    </Section>
  );
}

/* ───────────── 面板 ───────────── */

export function StatusPanel() {
  const runId = useApp(panelRunId);
  const taskView = useApp((s) => s.view === 'task');
  const viewTaskId = useApp((s) => (s.view === 'task' ? s.selectedTaskId : undefined));
  const approvals = useApp(pendingApprovals, shallow);
  const drawerOpen = useApp((s) => s.statusDrawerOpen);
  const focusAt = useApp((s) => (s.focusRequest?.target === 'approvals' ? s.focusRequest.at : 0));
  const drawer = useMedia(DRAWER_QUERY);
  const reduced = useReducedMotion();

  const asideRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const approvalsRef = useRef<HTMLElement | null>(null);
  const handledAt = useRef(focusAt);
  const rafRef = useRef(0);
  const flashTimer = useRef<number | undefined>(undefined);
  const [flash, setFlash] = useState(false);

  // 抽屉打开时：焦点交给关闭按钮，其余界面设为 inert（键盘和读屏都够不到遮罩后面的内容），
  // 关闭后撤销 inert 并把焦点还给原来的控件。
  useEffect(() => {
    if (!drawer || !drawerOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const behind = Array.from(document.querySelectorAll<HTMLElement>('.app > :not(.status-panel):not(.app__drawer-scrim)'))
      .filter((el) => !el.hasAttribute('inert'));
    behind.forEach((el) => el.setAttribute('inert', ''));
    const raf = requestAnimationFrame(() => {
      const aside = asideRef.current;
      if (aside && !aside.contains(document.activeElement)) aside.querySelector<HTMLElement>('[data-drawer-close]')?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      behind.forEach((el) => el.removeAttribute('inert'));
      if (previous && previous !== document.body && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [drawer, drawerOpen]);

  // 抽屉是模态的：Tab / Shift+Tab 在抽屉内首尾之间循环（Esc 由 App 处理）。
  const trapTab = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Tab' || !drawer || !drawerOpen) return;
    const aside = asideRef.current;
    if (!aside) return;
    const list = Array.from(aside.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const inList = !!active && list.includes(active);
    // A focused non-tabbable element (e.g. the approvals section) counts as sitting between its neighbours.
    const hasAfter = !!active && list.some((el) => !!(active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
    const hasBefore = !!active && list.some((el) => !!(active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING));
    if (!e.shiftKey && (active === last || (!inList && !hasAfter))) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && (active === first || active === aside || (!inList && !hasBefore))) { e.preventDefault(); last.focus(); }
  };

  // 「去确认」之类的请求：滚到待确认分区、聚焦第一个「批准」、短暂高亮。
  useEffect(() => {
    if (!focusAt || focusAt === handledAt.current) return;
    handledAt.current = focusAt;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const section = approvalsRef.current;
      const scroller = scrollRef.current;
      if (!section || !scroller) return;
      scroller.scrollTo({ top: Math.max(0, section.offsetTop - 8), behavior: reduced ? 'auto' : 'smooth' });
      (section.querySelector<HTMLElement>('button[data-approve]') ?? section).focus({ preventScroll: true });
      setFlash(true);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(false), 1200);
    });
  }, [focusAt, reduced]);

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    window.clearTimeout(flashTimer.current);
  }, []);

  const approvalsSection = <ApprovalsSection approvals={approvals} innerRef={approvalsRef} flash={flash} />;
  const pendingFirst = approvals.length > 0;

  return (
    // 作为抽屉打开时是模态对话框（背后有遮罩）；停靠在右侧时仍是普通的 complementary 地标，所以不加 role。
    <aside
      className="status-panel panel"
      aria-label="运行状态"
      ref={asideRef}
      role={drawer && drawerOpen ? 'dialog' : undefined}
      aria-modal={drawer && drawerOpen ? true : undefined}
      onKeyDown={trapTab}
    >
      {drawer && (
        <div className="status-panel__bar">
          <span className="label">运行状态</span>
          <IconButton icon={X} label="关闭状态面板" size="sm" data-drawer-close onClick={() => actions.toggleStatusDrawer(false)} />
        </div>
      )}
      <div className="status-panel__scroll" ref={scrollRef}>
        {runId ? (
          <RunSection runId={runId} taskView={taskView} viewTaskId={viewTaskId} />
        ) : (
          <Section title="运行">
            {taskView ? (
              <EmptyState compact icon={Radar} title="这个任务还没有运行" body="在工作区点「开始」后，这里会显示运行状态。" />
            ) : (
              <EmptyState compact icon={Radar} title="没有进行中的运行" body="开始一个任务后，这里会显示运行状态。" />
            )}
          </Section>
        )}
        {/* 有待确认操作时提到最前面：它会让整个运行停下来，不该藏在滚动区下方。 */}
        {pendingFirst && approvalsSection}
        {runId && <AgentSection runId={runId} />}
        <ModelSection />
        {runId && <ContextSection runId={runId} />}
        {runId && <TokenSection runId={runId} />}
        {!pendingFirst && approvalsSection}
      </div>
    </aside>
  );
}
