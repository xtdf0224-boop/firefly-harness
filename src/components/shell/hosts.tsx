/* 全局宿主：通知（Toast）、确认对话框、读屏播报区。
   Toast 本身不是 aria-live——播报统一由 LiveRegion 负责，避免同一条消息被读两遍。 */
import {
  Ban, CheckCircle2, CircleDot, Hand, Info, PauseCircle, RotateCcw, Trash2, TriangleAlert, X, XOctagon, type LucideIcon,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
import { isOpenRun } from '../../lib/status';
import type { Toast, Tone } from '../../lib/types';
import { actions } from '../../state/actions';
import { useApp } from '../../state/store';
import { WingMark } from '../decor/WingMark';
import { Button, Dialog, IconButton, cx } from '../ui';

/* ───────────── Toast ───────────── */

const TOAST_ICON: Record<Tone, LucideIcon> = {
  success: CheckCircle2,
  danger: XOctagon,
  warning: Hand,
  running: CircleDot,
  paused: PauseCircle,
  info: Info,
  neutral: Info,
};

function ToastItem({ toast }: { toast: Toast }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const remaining = useRef(toast.ttl);

  // 自动消失；鼠标悬停或键盘聚焦时暂停，离开后按剩余时间继续。
  useEffect(() => {
    if (toast.ttl <= 0 || paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => actions.dismissToast(toast.id), Math.max(remaining.current, 800));
    return () => {
      window.clearTimeout(timer);
      remaining.current -= Date.now() - startedAt;
    };
  }, [paused, toast.id, toast.ttl]);

  const celebrate = toast.tone === 'success' && toast.title === '任务完成';
  const Icon = TOAST_ICON[toast.tone];
  const action = toast.action;

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
  };

  return (
    <div
      className={cx('toast', `toast--${toast.tone}`, celebrate && 'toast--celebrate')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    >
      {celebrate
        ? <WingMark size={24} glow className="toast__mark" />
        : <Icon className="toast__icon" size={18} aria-hidden />}
      <div className="toast__body">
        <p className="toast__title">{toast.title}</p>
        {toast.body && <p className="toast__text">{toast.body}</p>}
        {action && (
          <div className="toast__actions">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { actions.run(action.command); actions.dismissToast(toast.id); }}
            >
              {action.label}
            </Button>
          </div>
        )}
      </div>
      <IconButton icon={X} size="sm" label="关闭通知" onClick={() => actions.dismissToast(toast.id)} />
    </div>
  );
}

/** The workspace composer sits at the bottom of the main column, exactly where the stack lands. Measure it and
 *  set `--toast-lift` on the host so the toasts stack above the input and Send button instead of covering them. */
function useLiftAboveComposer(hostRef: { current: HTMLElement | null }, active: boolean, view: string) {
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !active) return;
    let observed: Element | null = null;
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => measure());
    function measure() {
      if (!host) return;
      host.style.setProperty('--toast-lift', '0px'); // measure the resting position
      const composer = document.querySelector<HTMLElement>('.ws-composer');
      if (composer !== observed) {
        if (observed) ro?.unobserve(observed);
        if (composer) ro?.observe(composer);
        observed = composer;
      }
      if (!composer) return;
      const c = composer.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      const overlapsX = h.right > c.left && h.left < c.right;
      if (c.height === 0 || !overlapsX || h.bottom <= c.top) return;
      // Keep the whole stack on screen even when the viewport is short.
      const lift = Math.min(h.bottom - c.top + 8, Math.max(0, h.top - 8));
      host.style.setProperty('--toast-lift', `${Math.ceil(lift)}px`);
    }
    measure();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
      host.style.removeProperty('--toast-lift');
    };
  }, [hostRef, active, view]);
}

export function ToastHost() {
  const toasts = useApp((s) => s.toasts);
  const view = useApp((s) => s.view);
  const hostRef = useRef<HTMLElement>(null);
  const shown = toasts.length > 0;
  // `toasts.length` is a dependency of the measurement: a taller stack has a different top edge.
  useLiftAboveComposer(hostRef, shown, `${view}:${toasts.length}`);
  if (!shown) return null;
  return (
    <section className="toast-host" aria-label="通知" ref={hostRef}>
      {toasts.map((t) => <ToastItem key={t.id} toast={t} />)}
    </section>
  );
}

/* ───────────── Dialogs ───────────── */

function CancelRunDialog({ runId }: { runId: string }) {
  const title = useApp((s) => { const r = s.runs[runId]; return r ? s.tasks[r.taskId]?.title : undefined; });
  const attempt = useApp((s) => s.runs[runId]?.attempt);
  const missing = title === undefined;
  useEffect(() => { if (missing) actions.closeDialog(); }, [missing]);
  if (missing) return null;
  return (
    <Dialog
      title="取消这次运行？"
      icon={TriangleAlert}
      tone="danger"
      onClose={actions.closeDialog}
      footer={(
        <>
          <Button variant="secondary" data-autofocus onClick={actions.closeDialog}>继续运行</Button>
          <Button variant="danger" icon={Ban} onClick={actions.confirmDialog}>取消运行</Button>
        </>
      )}
    >
      <p className="shell-dialog-subject">「{title}」· 运行 #{attempt}</p>
      <p>正在执行的步骤会停止，未执行的步骤会标记为「未执行」。已生成的产物会保留，之后可以重试。</p>
    </Dialog>
  );
}

function DeleteTaskDialog({ taskId }: { taskId: string }) {
  const title = useApp((s) => s.tasks[taskId]?.title);
  const runCount = useApp((s) => s.tasks[taskId]?.runIds.length ?? 0);
  const hasOpen = useApp((s) => !!s.tasks[taskId]?.runIds.some((id) => { const r = s.runs[id]; return !!r && isOpenRun(r.status); }));
  const missing = title === undefined;
  useEffect(() => { if (missing) actions.closeDialog(); }, [missing]);
  if (missing) return null;
  return (
    <Dialog
      title="删除这个任务？"
      icon={Trash2}
      tone="danger"
      onClose={actions.closeDialog}
      footer={(
        <>
          <Button variant="secondary" data-autofocus onClick={actions.closeDialog}>取消</Button>
          <Button variant="danger" icon={Trash2} onClick={actions.confirmDialog}>删除任务</Button>
        </>
      )}
    >
      <p className="shell-dialog-subject">「{title}」</p>
      <p>
        任务及其 {runCount} 条运行记录会被删除，无法撤销。
        {hasOpen && '其中有进行中的运行，会一并停止。'}
      </p>
    </Dialog>
  );
}

function ResetDemoDialog() {
  return (
    <Dialog
      title="重置演示数据？"
      icon={RotateCcw}
      tone="warning"
      onClose={actions.closeDialog}
      footer={(
        <>
          <Button variant="secondary" data-autofocus onClick={actions.closeDialog}>取消</Button>
          <Button variant="danger" icon={RotateCcw} onClick={actions.confirmDialog}>重置</Button>
        </>
      )}
    >
      <p>当前任务和运行记录会被清空，恢复为 3 个示例任务；设置会保留。</p>
    </Dialog>
  );
}

export function DialogHost() {
  const dialog = useApp((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'cancel-run': return <CancelRunDialog key={dialog.runId} runId={dialog.runId} />;
    case 'delete-task': return <DeleteTaskDialog key={dialog.taskId} taskId={dialog.taskId} />;
    case 'reset-demo': return <ResetDemoDialog />;
  }
}

/* ───────────── Live region ───────────── */

export function LiveRegion() {
  const announcement = useApp((s) => s.announcement);
  // 每来一条新播报就翻转一次零宽后缀，这样连续两条相同的文字也会被重新读出。
  // 在渲染期间调整 state 是 React 推荐的「随 props 变化而重置」写法，不会产生多余的 DOM 更新。
  const [seen, setSeen] = useState({ at: announcement.at, flip: false });
  if (seen.at !== announcement.at) setSeen({ at: announcement.at, flip: !seen.flip });
  const text = announcement.text ? `${announcement.text}${seen.flip ? '​' : ''}` : '';
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{text}</div>;
}
