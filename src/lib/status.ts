/* One table per status family: Chinese label, tone (colour) and icon. Every status in the UI is
   rendered with icon + text, so colour is never the only signal. */
import {
  Ban, CheckCircle2, Circle, CircleDot, CircleSlash, Clock3, Hand, Loader, PauseCircle, ShieldAlert, SkipForward,
  XOctagon, type LucideIcon,
} from 'lucide-react';
import type {
  AgentActivity, ApprovalStatus, Risk, RunStatus, StepStatus, Tone, ToolCallStatus, ToolPermission,
} from './types';

export interface StatusMeta {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  /** Breathing glow while active. */
  live?: boolean;
  /** The icon rotates while live (loader); static under reduced motion. */
  spin?: boolean;
}

export const RUN_STATUS: Record<RunStatus, StatusMeta> = {
  queued:    { label: '排队中',   tone: 'neutral', icon: Clock3 },
  running:   { label: '运行中',   tone: 'running', icon: CircleDot, live: true },
  paused:    { label: '已暂停',   tone: 'paused',  icon: PauseCircle },
  awaiting:  { label: '等待确认', tone: 'warning', icon: Hand },
  completed: { label: '已完成',   tone: 'success', icon: CheckCircle2 },
  failed:    { label: '执行失败', tone: 'danger',  icon: XOctagon },
  cancelled: { label: '已取消',   tone: 'neutral', icon: Ban },
};

export const STEP_STATUS: Record<StepStatus, StatusMeta> = {
  pending:   { label: '待执行',   tone: 'neutral', icon: Circle },
  running:   { label: '执行中',   tone: 'running', icon: CircleDot, live: true },
  awaiting:  { label: '等待确认', tone: 'warning', icon: Hand },
  done:      { label: '已完成',   tone: 'success', icon: CheckCircle2 },
  failed:    { label: '失败',     tone: 'danger',  icon: XOctagon },
  skipped:   { label: '已跳过',   tone: 'neutral', icon: SkipForward },
  cancelled: { label: '未执行',   tone: 'neutral', icon: CircleSlash },
};

export const TOOL_STATUS: Record<ToolCallStatus, StatusMeta> = {
  running:   { label: '调用中',   tone: 'running', icon: Loader, live: true, spin: true },
  awaiting:  { label: '等待确认', tone: 'warning', icon: Hand },
  ok:        { label: '成功',     tone: 'success', icon: CheckCircle2 },
  error:     { label: '出错',     tone: 'danger',  icon: XOctagon },
  denied:    { label: '已拒绝',   tone: 'neutral', icon: Ban },
  cancelled: { label: '已中止',   tone: 'neutral', icon: CircleSlash },
};

export const APPROVAL_STATUS: Record<ApprovalStatus, StatusMeta> = {
  pending:  { label: '待确认', tone: 'warning', icon: ShieldAlert },
  approved: { label: '已批准', tone: 'success', icon: CheckCircle2 },
  rejected: { label: '已拒绝', tone: 'danger',  icon: Ban },
  expired:  { label: '已失效', tone: 'neutral', icon: CircleSlash },
};

export const AGENT_ACTIVITY: Record<AgentActivity, StatusMeta> = {
  idle:     { label: '空闲',     tone: 'neutral', icon: Circle },
  thinking: { label: '思考中',   tone: 'running', icon: CircleDot, live: true },
  tool:     { label: '调用工具', tone: 'running', icon: Loader, live: true, spin: true },
  waiting:  { label: '等待确认', tone: 'warning', icon: Hand },
  paused:   { label: '已暂停',   tone: 'paused',  icon: PauseCircle },
};

export const RISK: Record<Risk, { label: string; tone: Tone }> = {
  low:    { label: '低风险', tone: 'success' },
  medium: { label: '中风险', tone: 'warning' },
  high:   { label: '高风险', tone: 'danger' },
};

export const PERMISSION: Record<ToolPermission, { label: string; hint: string }> = {
  auto:    { label: '自动执行', hint: 'Agent 可直接调用' },
  confirm: { label: '需要确认', hint: '每次调用前征求你的同意' },
  off:     { label: '已禁用',   hint: 'Agent 不能调用' },
};

/** Runs that still occupy an agent (shown as “active” in nav and status panel). */
export const OPEN_RUN: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'paused', 'awaiting']);
export const isOpenRun = (status: RunStatus) => OPEN_RUN.has(status);
