/* 待确认操作卡片：金色边 + 手形风险提示。状态面板里用紧凑版（预览折叠），工作区里用完整版。 */
import { Check, ChevronDown, ChevronRight, ShieldAlert, X } from 'lucide-react';
import { useId, useState, type MouseEvent } from 'react';
import { relative } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { APPROVAL_STATUS, RISK } from '../../lib/status';
import type { Approval } from '../../lib/types';
import { actions } from '../../state/actions';
import { useApp } from '../../state/store';
import { AgentAvatar, Badge, Button, CodeBlock, StatusChip, cx } from '../ui';

export interface ApprovalCardProps {
  approval: Approval;
  /** Compact: preview collapsed behind a toggle (status panel). Full: preview shown (workspace). */
  compact?: boolean;
  /** Show which task it belongs to (status panel lists approvals across tasks). */
  showTask?: boolean;
}

const PREVIEW_CAPTION: Record<Approval['previewKind'], string> = {
  command: '命令',
  diff: '差异预览',
  request: '请求参数',
};

const isShown = (el: HTMLElement) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

/** Deciding removes the card (and the button that had focus) from the DOM, which would drop focus to <body>.
 *  Move it to somewhere stable in the same region instead: the next pending card (the card itself, not its
 *  buttons, so a stray Enter can never approve a different operation), else the approvals section of the
 *  status panel, else the page heading. `card` is the card that was just decided and `region` the landmark
 *  that held it; both are read before the decision, because afterwards the card is detached. */
function restoreFocusAfterDecision(card: Element | null, region: Element | null, approvalId: string) {
  const attempt = (): boolean => {
    if (card?.isConnected) return false; // React has not removed it yet
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active)) return true; // something else already took focus
    const pendingCards = Array.from(document.querySelectorAll<HTMLElement>('.approval-card[data-status="pending"]'))
      .filter((el) => el.dataset.approvalId !== approvalId && region?.contains(el) && isShown(el));
    const target = pendingCards[0]
      ?? (region?.matches('aside') ? region.querySelector<HTMLElement>('.status-panel__section--approvals') : null)
      ?? region?.querySelector<HTMLElement>('h1')
      ?? (region instanceof HTMLElement ? region : null);
    if (!target || !target.isConnected) return true;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus();
    return document.activeElement === target;
  };
  // Timers, not rAF: they still fire when the tab is throttled. The first try lands right after React commits.
  let done = false;
  for (const delay of [0, 60, 200]) window.setTimeout(() => { if (!done) done = attempt(); }, delay);
}

export function ApprovalCard({ approval, compact = false, showTask = false }: ApprovalCardProps) {
  const agent = useApp((s) => s.agents.find((a) => a.id === approval.agentId));
  const toolName = useApp((s) => s.tools.find((t) => t.id === approval.tool)?.name ?? approval.tool);
  const taskTitle = useApp((s) => (showTask ? s.tasks[approval.taskId]?.title : undefined));
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const previewId = `${baseId}-preview`;

  const pending = approval.status === 'pending';
  const risk = RISK[approval.risk];
  const status = APPROVAL_STATUS[approval.status];
  const HeadIcon = pending ? ShieldAlert : status.icon;
  const previewVisible = !compact || open;

  const decide = (decision: 'approve' | 'reject', e: MouseEvent<HTMLButtonElement>) => {
    const region = e.currentTarget.closest('aside, main');
    actions.decideApproval(approval.id, decision);
    restoreFocusAfterDecision(e.currentTarget.closest('.approval-card'), region, approval.id);
  };

  return (
    <article
      className={cx('approval-card', compact && 'approval-card--compact', !pending && 'is-decided')}
      data-status={approval.status}
      data-approval-id={approval.id}
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className="approval-card__head">
        <HeadIcon className="approval-card__icon" size={16} aria-hidden />
        <h3 className="approval-card__title" id={titleId}>{approval.title}</h3>
      </header>

      <div className="approval-card__meta">
        {agent && <AgentAvatar agent={agent} size="sm" />}
        <span className="approval-card__who truncate">{agent?.name ?? approval.agentId} · {toolName}</span>
        <Badge tone={risk.tone}>{risk.label}</Badge>
        <time className="approval-card__time" dateTime={new Date(approval.createdAt).toISOString()}>{relative(approval.createdAt, now)}</time>
      </div>

      <p className="approval-card__reason">{approval.reason}</p>

      {showTask && taskTitle && (
        <p className="approval-card__task">
          <span>任务：</span>
          <button type="button" className="shell-link" title={taskTitle} onClick={() => actions.openTask(approval.taskId)}>{taskTitle}</button>
        </p>
      )}

      {compact && (
        <button
          type="button"
          className="approval-card__toggle"
          aria-expanded={open}
          aria-controls={previewId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          <span>{open ? '收起详情' : '查看详情'}</span>
        </button>
      )}
      <div className="approval-card__preview" id={previewId} hidden={!previewVisible}>
        <CodeBlock
          code={approval.preview}
          language={approval.previewKind === 'diff' ? 'diff' : 'text'}
          caption={PREVIEW_CAPTION[approval.previewKind]}
          maxHeight={220}
          wrap={approval.previewKind !== 'diff'}
        />
      </div>

      {pending ? (
        <div className="approval-card__actions">
          <Button
            variant="success"
            size={compact ? 'sm' : 'md'}
            icon={Check}
            data-approve
            aria-label={`批准「${approval.title}」`}
            onClick={(e) => decide('approve', e)}
          >
            批准
          </Button>
          <Button
            variant="danger"
            size={compact ? 'sm' : 'md'}
            icon={X}
            aria-label={`拒绝「${approval.title}」`}
            onClick={(e) => decide('reject', e)}
          >
            拒绝
          </Button>
        </div>
      ) : (
        <div className="approval-card__decided">
          <StatusChip meta={status} size="sm" />
          {approval.decidedAt != null && <span className="approval-card__time">{relative(approval.decidedAt, now)}</span>}
        </div>
      )}
    </article>
  );
}
