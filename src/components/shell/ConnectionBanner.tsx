/* 主区域顶部的连接横幅：断开（含倒计时）、重连中、恢复后仍有运行暂停。 */
import { CheckCircle2, Play, RefreshCw, Unplug, X } from 'lucide-react';
import { useState } from 'react';
import { useNow } from '../../lib/hooks';
import type { AppState, Connection } from '../../lib/types';
import { actions } from '../../state/actions';
import { gateway } from '../../state/selectors';
import { shallow, useApp } from '../../state/store';
import { Button, IconButton } from '../ui';

const isDown = (c: Connection) => c.status === 'disconnected' || c.status === 'reconnecting';

/** 断开的连接，模型网关优先。 */
function downConnection(s: AppState): Connection | undefined {
  const gw = gateway(s);
  return gw && isDown(gw) ? gw : s.connections.find(isDown);
}

export function ConnectionBanner() {
  const down = useApp(downConnection);
  const gw = useApp(gateway);
  const pausedIds = useApp((s) => Object.values(s.runs).filter((r) => r.status === 'paused' && r.pauseReason === 'disconnected').map((r) => r.id), shallow);
  const now = useNow(1000, down?.status === 'disconnected');
  // 「连接已恢复」被关闭时记下当时的 lastChangeAt；之后再断开、再恢复会得到更大的值，横幅重新出现。
  const [dismissedAt, setDismissedAt] = useState(0);

  if (down) {
    const pauses = down.kind === 'model';
    // Only mention the pause when something was actually paused (a gateway drop with no open run pauses nothing).
    const pausedAny = pauses && pausedIds.length > 0;
    if (down.status === 'disconnected') {
      // now 可能还停在断开之前的某一刻（计时器刚被启用），用 lastChangeAt 兜底，避免首帧倒计时过大。
      const seconds = down.retryAt != null ? Math.max(0, Math.ceil((down.retryAt - Math.max(now, down.lastChangeAt)) / 1000)) : undefined;
      const attempt = down.attempts + 1;
      return (
        <div className="conn-banner" key="down">
          <div className="callout callout--danger" role="alert">
            <Unplug className="callout__icon" size={18} aria-hidden />
            <div className="callout__body">
              <p className="callout__title">{down.name}连接已断开（模拟）</p>
              <p className="callout__text">
                {pausedAny && <>已自动暂停 {pausedIds.length} 个运行</>}
                {down.retryAt != null ? (
                  <>
                    <span aria-hidden="true">{pausedAny ? ' · ' : ''}{seconds ? `${seconds} 秒后自动重连` : '即将自动重连'}（第 {attempt} 次尝试）</span>
                    <span className="sr-only">{pausedAny ? '，' : ''}稍后将自动重连（第 {attempt} 次尝试）</span>
                  </>
                ) : (
                  <>{pausedAny ? ' · ' : ''}不会自动重连，请点「立即重连」</>
                )}
              </p>
            </div>
            <div className="callout__actions">
              <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => actions.reconnect(down.id)}>立即重连</Button>
              <Button size="sm" variant="ghost" onClick={() => actions.navigate('tools')}>查看连接</Button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="conn-banner" key="reconnecting">
        <div className="callout callout--info" role="status">
          <RefreshCw className="callout__icon spin" size={18} aria-hidden />
          <div className="callout__body">
            <p className="callout__title">正在重连{down.name}…</p>
            <p className="callout__text">
              第 {down.attempts} 次尝试（模拟）{pauses && pausedIds.length > 0 ? ` · ${pausedIds.length} 个运行保持暂停，连接恢复后可继续` : ''}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (gw && gw.status === 'connected' && pausedIds.length > 0 && gw.lastChangeAt > dismissedAt) {
    return (
      <div className="conn-banner" key="recovered">
        <div className="callout callout--success" role="status">
          <CheckCircle2 className="callout__icon" size={18} aria-hidden />
          <div className="callout__body">
            <p className="callout__title">连接已恢复 · {pausedIds.length} 个运行仍暂停</p>
            <p className="callout__text">{gw.name}已重新连接（模拟）。确认没有问题后，继续这些运行。</p>
          </div>
          <div className="callout__actions">
            <Button size="sm" variant="success" icon={Play} onClick={() => pausedIds.forEach((id) => actions.resumeRun(id))}>继续运行</Button>
            <IconButton icon={X} size="sm" label="关闭提示" onClick={() => setDismissedAt(gw.lastChangeAt)} />
          </div>
        </div>
      </div>
    );
  }

  return null;
}
