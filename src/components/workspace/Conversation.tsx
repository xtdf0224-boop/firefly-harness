/* 对话, laid out the way chat harnesses do it (Claude / ChatGPT / DeepSeek / Cyrene):
   - 闲聊: one centered column; your messages are bubbles on the right, hers are plain text with her
     name on top, a folded 思考过程 when the model shares one, and 复制 / 重新生成 under the reply.
   - 工作: messages grouped by run with the agents' tool calls threaded in between, in time order.
   The message box is docked at the bottom; while she is writing, its button stops the reply. */
import { ArrowDown, Brain, CircleCheck, Copy, Check, ListChecks, OctagonX, RefreshCw, Reply, StickyNote, type LucideIcon } from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { desktop } from '../../lib/desktop';
import { duration, timeOfDay } from '../../lib/format';
import { useReducedMotion } from '../../lib/hooks';
import { PERSONA } from '../../lib/persona';
import { isOpenRun, TOOL_STATUS } from '../../lib/status';
import type { Agent, AppState, Message, ToolCall } from '../../lib/types';
import { actions } from '../../state/actions';
import { regenerate, stopReply } from '../../state/live';
import { engineFromChoice } from '../../state/models';
import { shallow, useApp } from '../../state/store';
import { AgentAvatar, Button, EngineTag, cx } from '../ui';
import { Markdown } from './Markdown';
import { ModelChips, type ModelPick } from './ModelChips';
import { ModelNotice } from './ModelNotice';
import { PromptBox } from './PromptBox';
import { useFocusRequest, useTaskEngine } from './shared';

const NO_MESSAGES: Message[] = [];
const NO_RUNS: string[] = [];
const NO_CALLS: ToolCall[] = [];

const KIND: Record<NonNullable<Message['kind']>, { label: string; icon: LucideIcon; tone: 'neutral' | 'info' | 'success' | 'danger' }> = {
  plan: { label: '计划', icon: ListChecks, tone: 'info' },
  note: { label: '备注', icon: StickyNote, tone: 'neutral' },
  summary: { label: '总结', icon: CircleCheck, tone: 'success' },
  error: { label: '错误', icon: OctagonX, tone: 'danger' },
  reply: { label: '回复', icon: Reply, tone: 'neutral' },
};

type Item = { t: 'msg'; at: number; m: Message } | { t: 'call'; at: number; c: ToolCall };
interface Group { key: string; runId?: string; items: Item[] }

export interface ConversationProps {
  taskId: string;
  /** The run being viewed (highlighted divider). */
  runId?: string;
  /** The latest run (the typing row follows it while it is running). */
  latestId?: string;
  /** The tab is showing. The panel stays mounted when hidden so the draft and scroll position survive. */
  active: boolean;
  /** 闲聊 layout. */
  chat?: boolean;
}

/** All tool calls of the task's runs, oldest first (work tasks only). */
function selectCalls(taskId: string, chat?: boolean) {
  return (s: AppState) => {
    if (chat) return NO_CALLS;
    const t = s.tasks[taskId];
    if (!t) return NO_CALLS;
    const out: ToolCall[] = [];
    for (const id of t.runIds) out.push(...(s.runs[id]?.toolCalls ?? NO_CALLS));
    return out.length ? out : NO_CALLS;
  };
}

export function Conversation({ taskId, runId, latestId, active, chat }: ConversationProps) {
  const messages = useApp((s) => s.tasks[taskId]?.messages ?? NO_MESSAGES);
  const callsSel = useMemo(() => selectCalls(taskId, chat), [taskId, chat]);
  const calls = useApp(callsSel, shallow);
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

  const lastAgentId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return undefined;
      if (messages[i].role === 'agent') return messages[i].id;
    }
    return undefined;
  }, [messages]);

  const groups = useMemo(() => {
    const items: Item[] = [
      ...messages.map((m): Item => ({ t: 'msg', at: m.at, m })),
      ...calls.map((c): Item => ({ t: 'call', at: c.startedAt, c })),
    ];
    // Stable time order: a tool call started in the same millisecond as a message goes after it.
    items.sort((a, b) => a.at - b.at || (a.t === b.t ? 0 : a.t === 'msg' ? -1 : 1));
    const out: Group[] = [];
    for (const it of items) {
      const rid = it.t === 'msg' ? it.m.runId : it.c.runId;
      const last = out[out.length - 1];
      if (last && last.runId === rid) last.items.push(it);
      else out.push({ key: `${rid ?? 'start'}-${it.t === 'msg' ? it.m.id : it.c.id}`, runId: rid, items: [it] });
    }
    return out;
  }, [messages, calls]);

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

  // Follow new messages, tool calls, a growing reply and the typing row unless the user has scrolled up.
  const liveKey = live ? `${live.agentId}:${live.text}` : '';
  const tail = messages.length ? messages[messages.length - 1].text.length + (messages[messages.length - 1].thinking?.length ?? 0) : 0;
  useLayoutEffect(() => { if (stick.current) toBottom(); }, [messages.length, calls.length, liveKey, tail, toBottom]);

  useLayoutEffect(() => {
    if (!active) return;
    const el = scrollRef.current;
    if (!el) return;
    if (stick.current) toBottom();
    else el.scrollTop = lastTop.current;
  }, [active, toBottom]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (stick.current && el.clientHeight > 0) toBottom(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);

  const follow = () => { stick.current = true; setAway(false); };
  const jump = () => { follow(); toBottom(true); };
  const liveAgent = live ? agentById.get(live.agentId) : undefined;

  return (
    <div className={cx('ws-conv', chat && 'ws-conv--chat')}>
      <div className="ws-conv__stage">
        <div ref={scrollRef} className="ws-conv__scroll" onScroll={onScroll} role="region" aria-label="对话记录" tabIndex={0}>
          <div className="ws-conv__log" role="log" aria-label="对话消息">
            {messages.length === 0 && calls.length === 0 && <p className="ws-conv__empty">{chat ? '还没有消息，打个招呼吧。' : '还没有消息。'}</p>}
            {groups.map((g) => {
              const info = g.runId ? runById.get(g.runId) : undefined;
              return (
                <div key={g.key} className="ws-conv__group">
                  {info && !chat && (
                    <div className="ws-conv__divider" data-viewing={g.runId === runId && runById.size > 1 ? 'true' : undefined}>
                      <span>运行 #{info.attempt}</span>
                      {info.startedAt > 0 && <time dateTime={new Date(info.startedAt).toISOString()}>{timeOfDay(info.startedAt)}</time>}
                      {g.runId === runId && runById.size > 1 && <span className="ws-conv__viewing">当前查看</span>}
                    </div>
                  )}
                  {g.items.map((it) => (it.t === 'msg'
                    ? <MessageItem key={it.m.id} message={it.m} agent={it.m.agentId ? agentById.get(it.m.agentId) : undefined} flat={!!chat} last={it.m.id === lastAgentId} taskId={taskId} />
                    : <InlineTool key={it.c.id} call={it.c} />))}
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
        {away && <Button className="ws-conv__jump" size="sm" icon={ArrowDown} onClick={jump}>跳到最新</Button>}
      </div>
      <Composer taskId={taskId} onSent={follow} chat={!!chat} />
    </div>
  );
}

/* ───────────── one message ───────────── */

const MessageItem = memo(function MessageItem({ message: m, agent: base, flat, last, taskId }: { message: Message; agent?: Agent; flat: boolean; last: boolean; taskId: string }) {
  // The voice that spoke keeps its name, even after switching modes or turning the persona off.
  const agent = base && m.persona ? { ...base, name: PERSONA[m.persona].name, glyph: PERSONA[m.persona].glyph } : base;
  const time = <time className="ws-msg__time" dateTime={new Date(m.at).toISOString()}>{timeOfDay(m.at)}</time>;

  if (m.role === 'system') return <p className="ws-msg ws-msg--system">{m.text}{time}</p>;

  if (m.role === 'user') {
    return (
      <article className="ws-msg ws-msg--user" aria-label="你的消息">
        {!flat && <header className="ws-msg__head"><span className="ws-msg__name">你</span>{time}</header>}
        <div className="ws-msg__bubble">{m.text}</div>
      </article>
    );
  }

  const kind = m.kind ? KIND[m.kind] : undefined;
  const KindIcon = kind?.icon;
  const name = agent?.name ?? 'Agent';
  const waiting = m.streaming && !m.text;
  return (
    <article className={cx('ws-msg ws-msg--agent', flat && 'ws-msg--flat')} data-kind={m.kind} aria-label={`${name}的消息`}>
      {agent ? <AgentAvatar agent={agent} /> : <span className="avatar" aria-hidden />}
      <div className="ws-msg__col">
        <header className="ws-msg__head">
          <span className="ws-msg__name">{name}</span>
          {kind && KindIcon && <span className={`ws-kind ws-kind--${kind.tone}`}><KindIcon size={11} aria-hidden />{kind.label}</span>}
          {time}
        </header>
        {m.thinking && <Thinking text={m.thinking} live={!!m.streaming && !m.text} voice={m.persona} />}
        {waiting && !m.thinking ? (
          <div className="ws-msg__bubble ws-msg__bubble--typing" aria-label={`${name}正在输入`}>
            <span className="ws-typing__dots" aria-hidden><i /><i /><i /></span>
          </div>
        ) : waiting ? null : (
          <div className={cx('ws-msg__bubble ws-msg__bubble--md', m.streaming && 'is-streaming')} aria-busy={m.streaming || undefined}>
            <Markdown source={m.text} headingLevel={4} className="ws-msg__md" />
          </div>
        )}
        {m.streaming && m.activity && (
          <p className="ws-msg__activity" role="status">
            <span className="ws-typing__dots" aria-hidden><i /><i /><i /></span>{m.activity}
          </p>
        )}
        {flat && !m.streaming && m.text && <MessageActions text={m.text} canRetry={last} taskId={taskId} />}
      </div>
    </article>
  );
});

/** Folded reasoning (as DeepSeek / Kimi show it), labelled in her voice. */
function Thinking({ text, live, voice }: { text: string; live: boolean; voice?: Message['persona'] }) {
  const n = Array.from(text).length;
  const label = voice === 'firefly' ? (live ? '流萤在想…' : `流萤想了想 · ${n} 字`)
    : voice === 'sam' ? (live ? '萨姆：演算中' : `演算记录 · ${n} 字`)
      : (live ? '正在思考…' : `思考过程 · ${n} 字`);
  return (
    <details className="ws-think" open={live || undefined}>
      <summary><Brain size={13} aria-hidden />{label}</summary>
      <div className="ws-think__body">{text}</div>
    </details>
  );
}

function MessageActions({ text, canRetry, taskId }: { text: string; canRetry: boolean; taskId: string }) {
  const [copied, setCopied] = useState(false);
  const busy = useApp((s) => s.tasks[taskId]?.messages.some((m) => m.streaming) ?? false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="ws-msg__actions">
      <button type="button" className="ws-act" onClick={() => void copy()} aria-label={copied ? '已复制' : '复制这条回复'} title="复制">
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
      {canRetry && (
        <button type="button" className="ws-act" disabled={busy} onClick={() => regenerate(taskId)} aria-label="重新生成这条回复" title="重新生成">
          <RefreshCw size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

/* ───────────── a tool call in the transcript ───────────── */

const InlineTool = memo(function InlineTool({ call }: { call: ToolCall }) {
  const def = useApp((s) => s.tools.find((t) => t.id === call.tool));
  const meta = TOOL_STATUS[call.status];
  const Icon = meta.icon;
  const out = call.error?.message && !call.output ? call.error.message : call.output;
  return (
    <details className={cx('ws-tool', `ws-tool--${meta.tone}`)}>
      <summary>
        <span className={cx('ws-tool__icon', meta.spin && 'is-spin')} data-tone={meta.tone} title={meta.label}><Icon size={13} aria-hidden /></span>
        <span className="ws-tool__name">{call.toolName ?? def?.name ?? call.tool}</span>
        <span className="ws-tool__title">{call.title}</span>
        <span className="ws-tool__meta">{meta.label}{call.durationMs != null ? ` · ${duration(call.durationMs)}` : ''}</span>
      </summary>
      <pre className="ws-tool__out">{out || (call.status === 'running' ? '执行中…' : '（没有输出）')}</pre>
    </details>
  );
});

/* ───────────── composer ───────────── */

function Composer({ taskId, onSent, chat }: { taskId: string; onSent: () => void; chat: boolean }) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { engine, choices, state } = useTaskEngine(taskId);
  const runOpen = useApp((s) => {
    const t = s.tasks[taskId];
    const r = t?.runIds.length ? s.runs[t.runIds[t.runIds.length - 1]] : undefined;
    return !!r && isOpenRun(r.status);
  });
  const hasRun = useApp((s) => (s.tasks[taskId]?.runIds.length ?? 0) > 0);
  const replying = useApp((s) => s.tasks[taskId]?.messages.some((m) => m.streaming) ?? false);
  const persona = useApp((s) => (s.settings.persona ? PERSONA[s.settings.mode].name : '编排 Agent'));

  useFocusRequest('composer', () => requestAnimationFrame(() => inputRef.current?.focus()));

  const submit = () => {
    if (!text.trim()) return;
    actions.sendMessage(taskId, text);
    setText('');
    onSent();
    inputRef.current?.focus();
  };

  // 闲聊 can switch model and effort mid-conversation; the next reply uses them.
  const currentKey = engine ? `${engine.provider}:${engine.auth}` : '';
  const switchTo = async (p: ModelPick) => {
    const c = choices.find((x) => x.key === p.key);
    if (!c) return;
    if (engine && p.key === currentKey && c.driver === engine.driver && p.model === engine.model && p.effort === engine.effort) return;
    const cwd = c.auth === 'cli' ? (engine?.cwd ?? await desktop?.workspaceFolder(`chat-${Date.now().toString(36)}`)) : undefined;
    actions.setTaskEngine(taskId, engineFromChoice(c, { cwd, model: p.model, effort: p.effort }));
  };

  const chips = chat
    ? <ModelChips pick={{ key: currentKey, model: engine?.model ?? '', effort: engine?.effort, driver: engine?.driver }} onPick={(p) => void switchTo(p)} />
    : engine && <EngineTag label={engine.label} />;

  // A reply needs a model; supplements to a work task are only stored until it runs, so they never wait for one.
  const blocked = chat && state !== 'ready' ? (choices.length ? '先选一个能用的模型' : '先到「模型接入」接入一个模型') : undefined;
  const hint = chat
    ? 'Enter 发送，Shift + Enter 换行'
    : runOpen ? '补充说明会交给正在执行的 Agent' : hasRun ? `可以追问结果（${persona}会回答，但不会再动文件）` : '开始运行时，这些补充会一起交给 Agent';

  return (
    <div className={cx('ws-composer-wrap', chat && 'ws-composer-wrap--chat')}>
      {chat && <ModelNotice taskId={taskId} chat />}
      <PromptBox
        variant="docked"
        id={`ws-composer-${taskId}`}
        value={text}
        onChange={setText}
        onSubmit={submit}
        inputRef={inputRef}
        label={chat ? `发给${persona}的消息` : '补充说明或调整要求'}
        placeholder={chat ? `和${persona}说点什么…` : '补充说明或调整要求…'}
        chips={chips}
        hint={hint}
        blocked={blocked}
        busy={chat && replying}
        onStop={() => stopReply(taskId)}
      />
    </div>
  );
}
