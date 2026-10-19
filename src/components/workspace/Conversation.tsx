/* 对话: the task's messages grouped by run, a live "typing" row while a run is working, and the
   composer. The simulator answers with a canned reply, which the composer says up front. */
import { ArrowDown, CircleCheck, ListChecks, OctagonX, Reply, Send, StickyNote, type LucideIcon } from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { timeOfDay } from '../../lib/format';
import { useReducedMotion } from '../../lib/hooks';
import type { Agent, Message } from '../../lib/types';
import { actions } from '../../state/actions';
import { shallow, useApp } from '../../state/store';
import { AgentAvatar, Button, SimTag } from '../ui';
import { useFocusRequest } from './shared';

const NO_MESSAGES: Message[] = [];
const NO_RUNS: string[] = [];

const KIND: Record<NonNullable<Message['kind']>, { label: string; icon: LucideIcon; tone: 'neutral' | 'info' | 'success' | 'danger' }> = {
  plan: { label: '计划', icon: ListChecks, tone: 'info' },
  note: { label: '备注', icon: StickyNote, tone: 'neutral' },
  summary: { label: '总结', icon: CircleCheck, tone: 'success' },
  error: { label: '错误', icon: OctagonX, tone: 'danger' },
  reply: { label: '回复', icon: Reply, tone: 'neutral' },
};

interface Group { key: string; runId?: string; messages: Message[] }

export interface ConversationProps {
  taskId: string;
  /** The run being viewed (highlighted divider). */
  runId?: string;
  /** The latest run (the typing row follows it while it is running). */
  latestId?: string;
  /** The tab is showing. The panel stays mounted when hidden so the draft and scroll position survive. */
  active: boolean;
}

export function Conversation({ taskId, runId, latestId, active }: ConversationProps) {
  const messages = useApp((s) => s.tasks[taskId]?.messages ?? NO_MESSAGES);
  const agents = useApp((s) => s.agents);
  // "runId|attempt|startedAt" per run, so dividers can say "运行 #n · 14:02:11" without a render per tick.
  const runInfo = useApp((s) => s.tasks[taskId]?.runIds.map((id) => {
    const r = s.runs[id];
    return `${id}|${r?.attempt ?? 0}|${r?.startedAt ?? r?.createdAt ?? 0}`;
  }) ?? NO_RUNS, shallow);
  const live = useApp((s) => {
    const r = latestId ? s.runs[latestId] : undefined;
    return r && r.status === 'running' && r.live ? { agentId: r.live.agentId, text: r.live.text } : undefined;
  }, shallow);
  const reduced = useReducedMotion();

  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const runById = useMemo(() => new Map(runInfo.map((item) => {
    const [id, attempt, startedAt] = item.split('|');
    return [id, { attempt: Number(attempt), startedAt: Number(startedAt) }] as const;
  })), [runInfo]);

  const groups = useMemo(() => {
    const out: Group[] = [];
    for (const m of messages) {
      const last = out[out.length - 1];
      if (last && last.runId === m.runId) last.messages.push(m);
      else out.push({ key: `${m.runId ?? 'start'}-${m.id}`, runId: m.runId, messages: [m] });
    }
    return out;
  }, [messages]);

  const toBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? 'smooth' : 'auto' });
  }, [reduced]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    lastTop.current = el.scrollTop;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stick.current = near;
    setAway(!near);
  };

  // Follow new messages and the typing row unless the user has scrolled up.
  const liveKey = live ? `${live.agentId}:${live.text}` : '';
  useLayoutEffect(() => { if (stick.current) toBottom(); }, [messages.length, liveKey, toBottom]);

  // Coming back to the tab: a hidden element loses its scroll offset, so restore it.
  useLayoutEffect(() => {
    if (!active) return;
    const el = scrollRef.current;
    if (!el) return;
    if (stick.current) toBottom();
    else el.scrollTop = lastTop.current;
  }, [active, toBottom]);

  // Keep the view pinned to the bottom when the area resizes (composer grows, window changes).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (stick.current && el.clientHeight > 0) toBottom(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);

  /** Resume following the bottom (the layout effect scrolls once the new content has rendered). */
  const follow = () => {
    stick.current = true;
    setAway(false);
  };
  const jump = () => {
    follow();
    toBottom(true);
  };

  const liveAgent = live ? agentById.get(live.agentId) : undefined;

  return (
    <div className="ws-conv">
      <div className="ws-conv__stage">
        <div ref={scrollRef} className="ws-conv__scroll" onScroll={onScroll} role="region" aria-label="对话记录" tabIndex={0}>
          <div className="ws-conv__log" role="log" aria-label="对话消息">
            {messages.length === 0 && <p className="ws-conv__empty">还没有消息。</p>}
            {groups.map((g) => {
              const info = g.runId ? runById.get(g.runId) : undefined;
              return (
                <div key={g.key} className="ws-conv__group">
                  {info && (
                    <div className="ws-conv__divider" data-viewing={g.runId === runId && runById.size > 1 ? 'true' : undefined}>
                      <span>运行 #{info.attempt}</span>
                      {info.startedAt > 0 && <time dateTime={new Date(info.startedAt).toISOString()}>{timeOfDay(info.startedAt)}</time>}
                      {g.runId === runId && runById.size > 1 && <span className="ws-conv__viewing">当前查看</span>}
                    </div>
                  )}
                  {g.messages.map((m) => <MessageItem key={m.id} message={m} agent={m.agentId ? agentById.get(m.agentId) : undefined} />)}
                </div>
              );
            })}
          </div>
          {live && (
            <div className="ws-typing">
              {liveAgent && <AgentAvatar agent={liveAgent} size="sm" activity="thinking" />}
              <span className="ws-typing__text">{liveAgent ? `${liveAgent.name}：` : ''}{live.text}</span>
              <span className="ws-typing__dots" aria-hidden><i /><i /><i /></span>
            </div>
          )}
        </div>
        {away && (
          <Button className="ws-conv__jump" size="sm" icon={ArrowDown} onClick={jump}>跳到最新</Button>
        )}
      </div>
      <Composer taskId={taskId} onSent={follow} />
    </div>
  );
}

/* ───────────── one message ───────────── */

const MessageItem = memo(function MessageItem({ message: m, agent }: { message: Message; agent?: Agent }) {
  // The message belongs to a run: inside a sample run it is sample data, not "simulated" (Message
  // only carries a boolean). Messages with no run keep the simulator default.
  const runSource = useApp((s) => (m.runId ? s.runs[m.runId]?.source : undefined));
  const time = <time className="ws-msg__time" dateTime={new Date(m.at).toISOString()}>{timeOfDay(m.at)}</time>;

  if (m.role === 'system') {
    return <p className="ws-msg ws-msg--system">{m.text}{time}</p>;
  }

  if (m.role === 'user') {
    return (
      <article className="ws-msg ws-msg--user" aria-label="你的消息">
        <header className="ws-msg__head"><span className="ws-msg__name">你</span>{time}</header>
        <div className="ws-msg__bubble">{m.text}</div>
      </article>
    );
  }

  const kind = m.kind ? KIND[m.kind] : undefined;
  const KindIcon = kind?.icon;
  const name = agent?.name ?? 'Agent';
  return (
    <article className="ws-msg ws-msg--agent" data-kind={m.kind} aria-label={`${name}的消息`}>
      {agent ? <AgentAvatar agent={agent} /> : <span className="avatar" aria-hidden />}
      <div className="ws-msg__col">
        <header className="ws-msg__head">
          <span className="ws-msg__name">{name}</span>
          {kind && KindIcon && <span className={`ws-kind ws-kind--${kind.tone}`}><KindIcon size={11} aria-hidden />{kind.label}</span>}
          {m.simulated && <SimTag source={runSource ?? 'simulated'} compact />}
          {time}
        </header>
        <div className="ws-msg__bubble">{m.text}</div>
      </div>
    </article>
  );
});

/* ───────────── composer ───────────── */

function Composer({ taskId, onSent }: { taskId: string; onSent: () => void }) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const empty = text.trim().length === 0;

  const fit = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 22;
    const pad = el.offsetHeight - el.clientHeight; // borders
    const max = line * 6 + Number.parseFloat(getComputedStyle(el).paddingTop) * 2 + pad;
    el.style.height = `${Math.min(el.scrollHeight + pad, max)}px`;
    el.style.overflowY = el.scrollHeight + pad > max ? 'auto' : 'hidden';
  }, []);

  useLayoutEffect(fit, [text, fit]);

  useFocusRequest('composer', () => {
    // The panel may still be hidden in this commit; focus after the tab switch has rendered.
    requestAnimationFrame(() => inputRef.current?.focus());
  });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (empty) return;
    actions.sendMessage(taskId, text);
    setText('');
    onSent();
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form className="ws-composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="ws-composer-input">补充说明或调整要求</label>
      <textarea
        id="ws-composer-input" ref={inputRef} className="textarea ws-composer__input" rows={1} value={text}
        placeholder="补充说明或调整要求…" onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
      />
      <div className="ws-composer__bar">
        <p className="ws-composer__hint">演示模式：会收到模拟回复<SimTag /></p>
        <Button type="submit" variant="primary" icon={Send} kbd="Ctrl ↵" disabled={empty}>发送</Button>
      </div>
    </form>
  );
}
