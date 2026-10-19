/* 萤火浏览器 on 工具与连接: the window agents drive when a work task has 浏览器 on. Open it to log in
   to sites first; clear its data to log out of everything. */
import { Eraser, Globe, MousePointerClick, ShieldOff } from 'lucide-react';
import { desktop } from '../../../lib/desktop';
import { actions } from '../../../state/actions';
import { useApp } from '../../../state/store';
import { Button, Panel } from '../../ui';

export function BrowserPanel() {
  const desktopOk = useApp((s) => s.models.desktop);
  return (
    <Panel label="浏览器" title="浏览器控制" icon={Globe} energy className="browser-panel">
      <p className="skills-panel__lead">
        新建「工作」时打开输入框下的 <strong>浏览器</strong> 标签，命令行 Agent（Claude Code、Codex、Kimi / Qwen / MiniMax Code）就能操作「萤火浏览器」窗口：打开网页、读取内容、点击、输入、截图。窗口和工作台分开，你能看到它在做什么，也可以随时自己操作。
      </p>
      <ul className="browser-panel__points">
        <li><MousePointerClick size={14} aria-hidden />「浏览网页」（读取当前页面、滚动、截图）默认自动执行，「操作网页」（打开网址、点击、输入）默认先征求确认——在下方「工具」里可以改。Codex 不能逐项确认，会直接执行。</li>
        <li><Globe size={14} aria-hidden />需要登录的网站，先在萤火浏览器里自己登录；它的 Cookie 和登录状态只属于这个窗口。Agent 不会替你输入密码或付款，页面快照也不会带出密码框和验证码的内容。</li>
        <li><ShieldOff size={14} aria-hidden />萤火浏览器不会打开本机或内网地址（localhost、127.0.0.1、192.168.x.x 等），网页里的请求和跳转也一样。</li>
      </ul>
      {desktopOk ? (
        <div className="skills-panel__actions">
          <Button size="sm" variant="secondary" icon={Globe} onClick={() => void desktop?.browser?.open()}>打开萤火浏览器</Button>
          <Button size="sm" variant="ghost" icon={Eraser} onClick={async () => {
            if (!window.confirm('清除萤火浏览器的全部 Cookie、登录状态和缓存？')) return;
            await desktop?.browser?.clear();
            actions.toast({ tone: 'info', title: '已清除浏览数据', body: '萤火浏览器里的登录状态都已退出。' });
          }}>清除浏览数据</Button>
        </div>
      ) : <p className="skills-panel__muted">浏览器控制需要桌面版。</p>}
    </Panel>
  );
}
