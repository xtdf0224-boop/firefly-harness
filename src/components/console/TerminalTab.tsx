/* 终端输出 tab: the simulated terminal of a run. Nothing here is a real shell. */
import { Check, SquareTerminal } from 'lucide-react';
import { memo, useMemo, type ReactNode } from 'react';
import { timeOfDay } from '../../lib/format';
import type { DataSource, TerminalLine } from '../../lib/types';
import { useApp } from '../../state/store';
import { CopyButton, EmptyState, SimTag } from '../ui';
import { useFollowScroll, useRemembered } from './consoleHooks';

const EMPTY_LINES: TerminalLine[] = [];

export function TerminalTab({ runId }: { runId?: string }) {
  const lines = useApp((s) => (runId ? s.runs[runId]?.terminal : undefined)) ?? EMPTY_LINES;
  const running = useApp((s) => (runId ? s.runs[runId]?.status === 'running' : false));
  const source = useApp((s): DataSource => (runId ? s.runs[runId]?.source : undefined) ?? 'simulated');

  const [showTime, setShowTime] = useRemembered('term.time', false);
  const scroll = useFollowScroll<HTMLDivElement>(lines.length);
  const text = useMemo(() => lines.map((l) => l.text).join('\n'), [lines]);

  return (
    <>
      <div className="console__toolbar">
        <SimTag source={source} />
        <span className="console__note">模拟终端：没有执行任何真实命令</span>
        <div className="console__toolbar-end">
          <Toggle pressed={showTime} onToggle={() => setShowTime(!showTime)}>显示时间</Toggle>
          <Toggle pressed={scroll.following} onToggle={() => scroll.setFollowing(!scroll.following)}>自动跟随</Toggle>
          {lines.length > 0 && <CopyButton text={text} label="复制全部" />}
        </div>
      </div>

      <div className="console__pane">
        <div ref={scroll.ref} className="term" role="log" aria-live="off" aria-label="终端输出（模拟）" tabIndex={0}
          onScroll={scroll.onScroll} onClickCapture={scroll.onClickCapture}>
          {lines.length > 0 ? (
            <>
              <ol className="term__lines">
                {lines.map((line) => <TermLineRow key={line.id} line={line} showTime={showTime} />)}
              </ol>
              {running && <div className="term__cursor-row" aria-hidden><span className="term__cursor" /></div>}
            </>
          ) : (
            <EmptyState compact icon={SquareTerminal} title={runId ? '还没有终端输出' : '还没有运行'}
              body={runId ? undefined : '开始一个任务后，模拟终端的输出会显示在这里。'} />
          )}
        </div>
      </div>
    </>
  );
}

const TermLineRow = memo(function TermLineRow({ line, showTime }: { line: TerminalLine; showTime: boolean }) {
  return (
    <li className={`term__line term__line--${line.stream}`}>
      {showTime && <time className="term__time" dateTime={new Date(line.at).toISOString()}>{timeOfDay(line.at)}</time>}
      {/* A shape marker, so stderr is not told apart by colour alone. */}
      <span className="term__gutter" aria-hidden>{line.stream === 'stderr' ? '!' : ''}</span>
      <span className="term__text">
        {line.stream === 'stderr' && <span className="sr-only">错误输出：</span>}
        {line.text || ' '}
      </span>
    </li>
  );
});

/** Checkbox-like toggle button: the tick tells the state, not just the colour. */
function Toggle({ pressed, onToggle, children }: { pressed: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button type="button" className="console-toggle" aria-pressed={pressed} onClick={onToggle}>
      <span className="console-toggle__box" aria-hidden>{pressed && <Check size={11} strokeWidth={3} />}</span>
      {children}
    </button>
  );
}
