/* 终端输出 tab: what the run's agents ran and printed (command-line agents, and API models through the workbench's tools), plus the workbench's own notes. */
import { Check, SquareTerminal } from 'lucide-react';
import { memo, useMemo, type ReactNode } from 'react';
import { timeOfDay } from '../../lib/format';
import type { TerminalLine } from '../../lib/types';
import { canAct } from '../../state/live';
import { useApp } from '../../state/store';
import { CopyButton, EmptyState } from '../ui';
import { useFollowScroll, useRemembered } from './consoleHooks';

const EMPTY_LINES: TerminalLine[] = [];

/** How the run's models work: a command-line agent runs commands, an API model does through the workbench's tools when the task has a folder, otherwise it only talks. */
const NOTE = {
  cli: '命令行 Agent 执行的命令与输出',
  both: '命令行 Agent 和 API 模型执行的命令与输出',
  tools: 'API 模型用萤火的工具执行的命令与输出',
  api: '这个任务没有工作文件夹，API 模型只思考和写作，不会执行命令；这里只显示系统消息',
  noTools: '这个服务地址不支持工具调用，这次 API 模型只思考和写作，不会执行命令；这里只显示系统消息',
};

export function TerminalTab({ runId }: { runId?: string }) {
  const lines = useApp((s) => (runId ? s.runs[runId]?.terminal : undefined)) ?? EMPTY_LINES;
  const running = useApp((s) => (runId ? s.runs[runId]?.status === 'running' : false));
  const way = useApp((s): keyof typeof NOTE | undefined => {
    const run = runId ? s.runs[runId] : undefined;
    if (!run) return undefined;
    const engines = [s.tasks[run.taskId]?.engine, ...Object.values(run.agentEngines ?? {})];
    const cli = engines.some((e) => e?.auth === 'cli');
    // A run that fell back to think-and-write (the address has no tool calls) runs no commands through the workbench.
    const tools = !run.noTools && engines.some((e) => e?.auth === 'api' && canAct(e, 'work'));
    const api = engines.some((e) => e?.auth === 'api');
    return cli && tools ? 'both' : cli ? 'cli' : tools ? 'tools' : api ? (run.noTools ? 'noTools' : 'api') : undefined;
  });

  const [showTime, setShowTime] = useRemembered('term.time', false);
  const scroll = useFollowScroll<HTMLDivElement>(lines[lines.length - 1]?.id);
  const text = useMemo(() => lines.map((l) => l.text).join('\n'), [lines]);

  return (
    <>
      <div className="console__toolbar">
        {way && <span className="console__note">{NOTE[way]}</span>}
        <div className="console__toolbar-end">
          <Toggle pressed={showTime} onToggle={() => setShowTime(!showTime)}>显示时间</Toggle>
          <Toggle pressed={scroll.following} onToggle={() => scroll.setFollowing(!scroll.following)}>自动跟随</Toggle>
          {lines.length > 0 && <CopyButton text={text} label="复制全部" />}
        </div>
      </div>

      <div className="console__pane">
        <div ref={scroll.ref} className="term" role="log" aria-live="off" aria-label="终端输出" tabIndex={0}
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
              body={runId ? undefined : '开始一个任务后，命令输出会显示在这里。'} />
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
