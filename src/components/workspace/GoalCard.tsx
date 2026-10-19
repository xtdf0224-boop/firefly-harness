/* "当前目标": the task's goal (clamped to 3 lines with a toggle), plus when it was created, who
   works on it and which model runs it. */
import { ChevronDown } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { relative } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import type { Agent } from '../../lib/types';
import { shallow, useApp } from '../../state/store';
import { AgentAvatar, cx } from '../ui';

export function GoalCard({ taskId }: { taskId: string }) {
  const task = useApp((s) => {
    const t = s.tasks[taskId];
    return t ? { goal: t.goal, createdAt: t.createdAt, agentIds: t.agentIds, engine: t.engine?.label, cwd: t.engine?.cwd, access: t.engine?.access } : undefined;
  }, shallow);
  const agents = useApp((s) => s.agents);
  const now = useNow(30_000);
  const textId = useId();
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const goal = task?.goal ?? '';

  // Detect whether the clamped text is cut off; re-measure when the width changes.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const measure = () => { if (!expanded) setOverflowing(el.scrollHeight - el.clientHeight > 1); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [goal, expanded]);

  if (!task) return null;
  const members = task.agentIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
  const names = members.map((a) => a.name).join('、');

  return (
    <section className="panel ws-goal" aria-label="当前目标">
      <div className="ws-goal__head">
        <span className="label">当前目标</span>
        <ul className="ws-goal__meta" role="list">
          <li>{relative(task.createdAt, now)}创建</li>
          <li className="ws-goal__agents" title={names}>
            <span className="ws-goal__stack" aria-hidden>
              {members.map((a) => <AgentAvatar key={a.id} agent={a} size="sm" />)}
            </span>
            <span>{members.length} 个 Agent<span className="sr-only">：{names}</span></span>
          </li>
          {task.engine && <li className="ws-goal__engine" title={task.cwd ? `工作文件夹：${task.cwd}` : undefined}>{task.engine}{task.access === 'read' ? ' · 只读' : ''}</li>}
        </ul>
      </div>
      <p id={textId} ref={textRef} className={cx('ws-goal__text', !expanded && 'is-clamped')}>{goal}</p>
      {(overflowing || expanded) && (
        <button type="button" className="ws-goal__toggle" aria-expanded={expanded} aria-controls={textId} onClick={() => setExpanded((v) => !v)}>
          <ChevronDown size={14} aria-hidden />
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </section>
  );
}
