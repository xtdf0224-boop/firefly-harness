import { Blocks, Cpu, RefreshCw, Server, Timer, Unplug, type LucideIcon } from 'lucide-react';
import { CONNECTION_STATUS } from '../../../lib/status';
import { duration, relative } from '../../../lib/format';
import { useNow } from '../../../lib/hooks';
import type { Connection } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { Button, SimTag, StatusChip, cx } from '../../ui';

const KIND: Record<Connection['kind'], { icon: LucideIcon; label: string }> = {
  model: { icon: Cpu, label: '模型' },
  mcp: { icon: Blocks, label: 'MCP 服务' },
  runtime: { icon: Server, label: '运行时' },
};

/** One connection: status, latency, last change, and the actions that make sense for its state. */
export function ConnectionCard({ conn }: { conn: Connection }) {
  const down = conn.status === 'disconnected';
  const now = useNow(down ? 1000 : 20_000);
  const meta = CONNECTION_STATUS[conn.status];
  const kind = KIND[conn.kind];
  const Icon = kind.icon;
  const secs = conn.retryAt != null ? Math.max(0, Math.ceil((conn.retryAt - now) / 1000)) : undefined;

  return (
    <li className={cx('tools-conn', `is-${conn.status}`)}>
      <div className="tools-conn__head">
        <span className="tools-conn__icon" aria-hidden><Icon size={18} /></span>
        <div className="tools-conn__id">
          <p className="label">{kind.label}</p>
          <h3 className="tools-conn__name">{conn.name}</h3>
        </div>
        <StatusChip meta={meta} />
      </div>

      <p className="tools-conn__endpoint">
        <code title={conn.endpoint}>{conn.endpoint}</code>
        <SimTag source={conn.simulated ? 'simulated' : 'live'} />
      </p>

      <dl className="tools-conn__meta">
        <div><dt>延迟</dt><dd>{conn.latencyMs != null ? duration(conn.latencyMs) : '—'}</dd></div>
        <div><dt>最近变化</dt><dd>{relative(conn.lastChangeAt, now)}</dd></div>
      </dl>

      {conn.detail && <p className="tools-conn__detail">{conn.detail}</p>}

      {down && (
        <p className="tools-conn__retry" role="timer">
          <Timer size={14} aria-hidden />
          {secs == null ? '等待自动重连' : secs > 0 ? `${secs} 秒后自动重连` : '即将自动重连…'}
        </p>
      )}

      {conn.status !== 'reconnecting' && (
        <div className="tools-conn__actions">
          {conn.status !== 'connected' && (
            <Button size="sm" variant={down ? 'primary' : 'secondary'} icon={RefreshCw} onClick={() => actions.reconnect(conn.id)}>重连</Button>
          )}
          {conn.status === 'connected' && (
            <>
              <Button size="sm" variant="ghost" icon={Unplug} onClick={() => actions.simulateDisconnect(conn.id)}>模拟断开</Button>
              <SimTag compact />
            </>
          )}
        </div>
      )}
    </li>
  );
}
