/* 左侧导航：品牌与模型接入入口、新建任务、主导航、最近任务、视觉模式切换与收起。
   紧凑态（手动收起，或视口 < 960px）只显示图标；< 640px 时变成顶部横条（见 shell.css）。 */
import {
  Bot, Circle, Cpu, Eye, History, ListTodo, MessageCircle, PanelLeftClose, PanelLeftOpen, PanelRight, Plus, Settings, Shield, Sparkles, Wrench, type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useMedia } from '../../lib/hooks';
import { RUN_STATUS, type StatusMeta } from '../../lib/status';
import type { ViewId, VisualMode } from '../../lib/types';
import { actions } from '../../state/actions';
import { engineChoices } from '../../state/models';
import { openRuns, pendingApprovals, taskStatus } from '../../state/selectors';
import { shallow, useApp } from '../../state/store';
import { WingMark } from '../decor/WingMark';
import { Badge, Button, IconButton, Segmented, cx } from '../ui';
import { COMPACT_QUERY, DRAWER_QUERY } from './queries';

interface NavEntry { view: ViewId; label: string; icon: LucideIcon; key: string }

const NAV_ENTRIES: NavEntry[] = [
  { view: 'tasks',    label: '任务列表',   icon: ListTodo, key: '2' },
  { view: 'agents',   label: 'Agent',      icon: Bot,      key: '3' },
  { view: 'tools',    label: '工具与技能', icon: Wrench,     key: '4' },
  { view: 'models',   label: '模型接入',   icon: Cpu,      key: '5' },
  { view: 'history',  label: '运行历史',   icon: History,  key: '6' },
  { view: 'settings', label: '设置',       icon: Settings, key: '7' },
];

const MODE_OPTIONS: Array<{ value: VisualMode; label: string; icon: LucideIcon; hint: string }> = [
  { value: 'firefly', label: '流萤', icon: Sparkles, hint: '柔和安静' },
  { value: 'sam',     label: '萨姆', icon: Shield,   hint: '强化装甲线条与执行状态' },
];

/** A task that has not been started has no run, so it has no entry in RUN_STATUS. */
const DRAFT_META: StatusMeta = { label: '未开始', tone: 'neutral', icon: Circle };
const CHAT_META: StatusMeta = { label: '闲聊', tone: 'info', icon: MessageCircle };

function NavItem({ entry, active, note, badge }: { entry: NavEntry; active: boolean; note?: string; badge?: ReactNode }) {
  const Icon = entry.icon;
  return (
    <li>
      <button
        type="button"
        className="side-nav__item"
        aria-current={active ? 'page' : undefined}
        title={`${entry.label} (Alt+${entry.key})${note ? ` · ${note}` : ''}`}
        onClick={() => actions.navigate(entry.view)}
      >
        <Icon size={18} aria-hidden />
        <span className="side-nav__label">{entry.label}</span>
        {badge}
      </button>
    </li>
  );
}

function RecentTask({ id }: { id: string }) {
  const title = useApp((s) => s.tasks[id]?.title);
  const status = useApp((s) => { const t = s.tasks[id]; return t ? taskStatus(s, t) : undefined; });
  const chat = useApp((s) => s.tasks[id]?.kind === 'chat');
  const current = useApp((s) => s.view === 'task' && s.selectedTaskId === id);
  if (!title || !status) return null;
  const meta = chat ? CHAT_META : status === 'draft' ? DRAFT_META : RUN_STATUS[status];
  const Icon = meta.icon;
  // The status is the icon's shape (running / paused / awaiting / done / failed / cancelled all differ),
  // not just its colour; the label is read out after the title.
  return (
    <li>
      <button
        type="button"
        className="side-nav__recent-item"
        aria-current={current ? 'true' : undefined}
        title={`${title} · ${meta.label}`}
        onClick={() => actions.openTask(id)}
      >
        <span className={cx('side-nav__status-icon', meta.live && 'is-live')} data-tone={meta.tone} aria-hidden="true">
          <Icon size={14} aria-hidden />
        </span>
        <span className="truncate">{title}<span className="sr-only">，{meta.label}</span></span>
      </button>
    </li>
  );
}

function RecentTasks({ ids }: { ids: string[] }) {
  return (
    <section className="side-nav__recent" aria-labelledby="side-nav-recent-title">
      <h2 className="label side-nav__recent-title" id="side-nav-recent-title">最近任务</h2>
      {ids.length > 0
        ? <ul className="side-nav__recent-list">{ids.map((id) => <RecentTask key={id} id={id} />)}</ul>
        : <p className="side-nav__recent-empty">还没有任务</p>}
    </section>
  );
}

/** 品牌行右侧的入口：已接入几个，或提醒还没有接入。两种情况都直接跳到「模型接入」。 */
function ModelsChip() {
  const choices = useApp((s) => engineChoices(s.models).map((c) => c.label), shallow);
  const count = choices.length;
  const names = choices.length > 4 ? `${choices.slice(0, 4).join('、')} 等` : choices.join('、');
  return (
    <button
      type="button"
      className={cx('side-nav__models', count === 0 && 'is-empty')}
      title={count > 0 ? `已接入 ${count} 个：${names}` : '还没有接入模型，点这里去接入'}
      onClick={() => actions.navigate('models')}
    >
      <Cpu size={12} aria-hidden />
      {/* In the icon rail only the short part is drawn; the rest stays in the accessible name. */}
      {count > 0
        ? <span className="side-nav__models-text">{count}<span className="side-nav__models-more"> 个模型接入</span></span>
        : <span className="side-nav__models-text">未接入<span className="side-nav__models-more">模型</span></span>}
    </button>
  );
}

export function SideNav() {
  const view = useApp((s) => s.view);
  const collapsed = useApp((s) => s.navCollapsed);
  const mode = useApp((s) => s.settings.mode);
  const wallpaperOn = useApp((s) => s.settings.wallpaper);
  const openCount = useApp((s) => openRuns(s).length);
  const recentIds = useApp((s) => s.taskOrder.slice(0, 5), shallow);
  const pending = useApp((s) => pendingApprovals(s).length);
  const narrow = useMedia(COMPACT_QUERY);
  // Below 1280px the status panel is a drawer; every view needs a way to open it, not just the workspace header.
  const drawerMode = useMedia(DRAWER_QUERY);
  const compact = collapsed || narrow;

  const nextMode: VisualMode = mode === 'sam' ? 'firefly' : 'sam';

  return (
    <nav className="side-nav panel" aria-label="主导航" data-compact={compact ? 'true' : 'false'}>
      <div className="side-nav__top">
        <div className="side-nav__brandrow">
          <div className="side-nav__brand">
            <WingMark size={28} glow />
            <div className="side-nav__brandtext">
              <span className="side-nav__name">萤火</span>
              <span className="label side-nav__sub">Agent 工作台</span>
            </div>
          </div>
          <ModelsChip />
        </div>
        <Button
          variant="primary"
          icon={Plus}
          className="side-nav__cta"
          title="新建闲聊或工作 (Alt+1)"
          aria-current={view === 'new' ? 'page' : undefined}
          onClick={() => actions.navigate('new')}
        >
          新建
        </Button>
      </div>

      <div className="side-nav__scroll">
        <ul className="side-nav__list">
          {NAV_ENTRIES.map((entry) => {
            if (entry.view === 'tasks') {
              return (
                <NavItem
                  key={entry.view}
                  entry={entry}
                  active={view === 'tasks' || view === 'task'}
                  note={openCount > 0 ? `${openCount} 个进行中` : undefined}
                  badge={openCount > 0 && <Badge tone="running" className="side-nav__badge">{openCount}<span className="sr-only"> 个进行中</span></Badge>}
                />
              );
            }
            return <NavItem key={entry.view} entry={entry} active={view === entry.view} />;
          })}
        </ul>
        {!compact && <RecentTasks ids={recentIds} />}
      </div>

      <div className="side-nav__footer">
        {drawerMode && (
          <button
            type="button"
            className="side-nav__item side-nav__status-btn"
            aria-haspopup="dialog"
            title={pending > 0 ? `打开状态面板（${pending} 项待确认）` : '打开状态面板'}
            aria-label={pending > 0 ? `打开状态面板（${pending} 项待确认）` : '打开状态面板'}
            onClick={() => actions.toggleStatusDrawer(true)}
          >
            <PanelRight size={18} aria-hidden />
            <span className="side-nav__label" aria-hidden>状态</span>
            {pending > 0 && <Badge tone="warning" className="side-nav__badge"><span aria-hidden>{pending}</span></Badge>}
          </button>
        )}
        {compact ? (
          <IconButton
            className="side-nav__mode-btn"
            variant="secondary"
            icon={mode === 'sam' ? Sparkles : Shield}
            label={mode === 'sam' ? '切换到流萤模式' : '切换到萨姆模式'}
            onClick={() => actions.setSetting('mode', nextMode)}
          />
        ) : (
          <div className="side-nav__mode">
            <span className="label" aria-hidden>视觉模式</span>
            <Segmented size="sm" label="视觉模式" options={MODE_OPTIONS} value={mode} onChange={(v) => actions.setSetting('mode', v)} />
          </div>
        )}
        {wallpaperOn && (
          <IconButton
            className="side-nav__peek"
            icon={Eye}
            label="赏图：淡出界面，完整看壁纸（Alt+W）"
            onClick={() => actions.togglePeek(true)}
          />
        )}
        {!narrow && (
          <IconButton
            className="side-nav__collapse"
            icon={collapsed ? PanelLeftOpen : PanelLeftClose}
            label={collapsed ? '展开导航' : '收起导航'}
            onClick={() => actions.toggleNav()}
          />
        )}
      </div>
    </nav>
  );
}
