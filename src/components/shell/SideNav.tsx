/* 左侧导航：品牌与演示模式标记、新建任务、主导航、最近任务、视觉模式切换与收起。
   紧凑态（手动收起，或视口 < 960px）只显示图标；< 640px 时变成顶部横条（见 shell.css）。 */
import {
  Bot, Circle, Eye, FlaskConical, History, ListTodo, PanelLeftClose, PanelLeftOpen, PanelRight, Plug, Plus, Settings, Shield, Sparkles, type LucideIcon,
} from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMedia } from '../../lib/hooks';
import { RUN_STATUS, type StatusMeta } from '../../lib/status';
import type { ViewId, VisualMode } from '../../lib/types';
import { actions } from '../../state/actions';
import { openRuns, pendingApprovals, taskStatus } from '../../state/selectors';
import { shallow, useApp } from '../../state/store';
import { WingMark } from '../decor/WingMark';
import { Badge, Button, Dialog, IconButton, Segmented, cx } from '../ui';
import { COMPACT_QUERY, DRAWER_QUERY } from './queries';

interface NavEntry { view: ViewId; label: string; icon: LucideIcon; key: string }

const NAV_ENTRIES: NavEntry[] = [
  { view: 'tasks',    label: '任务列表',   icon: ListTodo, key: '2' },
  { view: 'agents',   label: 'Agent',      icon: Bot,      key: '3' },
  { view: 'tools',    label: '工具与连接', icon: Plug,     key: '4' },
  { view: 'history',  label: '运行历史',   icon: History,  key: '5' },
  { view: 'settings', label: '设置',       icon: Settings, key: '6' },
];

const MODE_OPTIONS: Array<{ value: VisualMode; label: string; icon: LucideIcon; hint: string }> = [
  { value: 'firefly', label: '流萤', icon: Sparkles, hint: '柔和安静' },
  { value: 'sam',     label: '萨姆', icon: Shield,   hint: '强化装甲线条与执行状态' },
];

/** A task that has not been started has no run, so it has no entry in RUN_STATUS. */
const DRAFT_META: StatusMeta = { label: '未开始', tone: 'neutral', icon: Circle };

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
  const current = useApp((s) => s.view === 'task' && s.selectedTaskId === id);
  if (!title || !status) return null;
  const meta = status === 'draft' ? DRAFT_META : RUN_STATUS[status];
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

/** 演示模式说明。渲染到 body：面板自带 backdrop-filter，会把 position: fixed 的遮罩限制在导航栏内。 */
function DemoDialog({ onClose }: { onClose: () => void }) {
  return createPortal(
    <Dialog
      title="演示模式"
      icon={FlaskConical}
      tone="warning"
      onClose={onClose}
      footer={(
        <>
          <Button variant="secondary" data-autofocus onClick={onClose}>知道了</Button>
          <Button variant="primary" icon={Settings} onClick={() => { onClose(); actions.navigate('settings'); }}>前往演示控制</Button>
        </>
      )}
    >
      <p>当前没有连接真实后端，任务由浏览器内的模拟器执行。</p>
      <ul className="shell-dialog-list">
        <li>Agent 回复、工具调用、终端输出、Token 统计与连接状态都是模拟数据。</li>
        <li>示例任务标记为「示例数据」。</li>
        <li>接入真实后端的方法见 README。</li>
      </ul>
    </Dialog>,
    document.body,
  );
}

export function SideNav() {
  const view = useApp((s) => s.view);
  const collapsed = useApp((s) => s.navCollapsed);
  const mode = useApp((s) => s.settings.mode);
  const wallpaperOn = useApp((s) => s.settings.wallpaper);
  const openCount = useApp((s) => openRuns(s).length);
  const connIssue = useApp((s) => s.connections.some((c) => c.status === 'disconnected' || c.status === 'reconnecting'));
  const recentIds = useApp((s) => s.taskOrder.slice(0, 5), shallow);
  const pending = useApp((s) => pendingApprovals(s).length);
  const narrow = useMedia(COMPACT_QUERY);
  // Below 1280px the status panel is a drawer; every view needs a way to open it, not just the workspace header.
  const drawerMode = useMedia(DRAWER_QUERY);
  const compact = collapsed || narrow;
  const [demoOpen, setDemoOpen] = useState(false);
  const closeDemo = useCallback(() => setDemoOpen(false), []);

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
          <button
            type="button"
            className="side-nav__demo"
            aria-haspopup="dialog"
            title="演示模式：当前使用的是模拟数据"
            onClick={() => setDemoOpen(true)}
          >
            <FlaskConical size={12} aria-hidden />
            {/* In the icon rail only 「演示」 is drawn; 「模式」 stays in the accessible name. */}
            <span className="side-nav__demo-text">演示<span className="side-nav__demo-more">模式</span></span>
          </button>
        </div>
        <Button
          variant="primary"
          icon={Plus}
          className="side-nav__cta"
          title="新建任务 (Alt+1)"
          aria-current={view === 'new' ? 'page' : undefined}
          onClick={() => actions.navigate('new')}
        >
          新建任务
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
            if (entry.view === 'tools') {
              return (
                <NavItem
                  key={entry.view}
                  entry={entry}
                  active={view === 'tools'}
                  note={connIssue ? '有连接断开' : undefined}
                  badge={connIssue && <Badge tone="danger" className="side-nav__badge"><span aria-hidden>!</span><span className="sr-only">有连接断开</span></Badge>}
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

      {demoOpen && <DemoDialog onClose={closeDemo} />}
    </nav>
  );
}
