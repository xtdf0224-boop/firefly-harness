/* 闲聊 task page: a header with who you are talking to (流萤 or 萨姆, her little status, the model)
   and the conversation filling the rest. Lifelike touches: she says hello when a new chat opens
   empty, and in a quiet chat she may speak up on her own — at most twice in a row. Both need a model
   that can answer, so they wait for one. */
import { ArrowLeft, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { useNow } from '../../lib/hooks';
import { mood, PERSONA } from '../../lib/persona';
import { actions } from '../../state/actions';
import { isReplying, reply } from '../../state/live';
import { shallow, store, useApp } from '../../state/store';
import { AgentAvatar, EngineTag, IconButton } from '../ui';
import { Conversation } from './Conversation';
import { useTaskEngine } from './shared';

const QUIET_MS = 8 * 60_000;
const MAX_UNANSWERED = 3; // her reply + up to two things said on her own

export function ChatWorkspace({ taskId }: { taskId: string }) {
  const task = useApp((s) => {
    const t = s.tasks[taskId];
    return t ? { title: t.title, engine: t.engine?.label, empty: t.messages.length === 0 } : undefined;
  }, shallow);
  const st = useApp((s) => ({ mode: s.settings.mode, persona: s.settings.persona, moodOn: s.settings.lifeMood, greet: s.settings.lifeGreeting, nudge: s.settings.lifeNudge }), shallow);
  const typing = useApp((s) => s.tasks[taskId]?.messages.some((m) => m.streaming) ?? false);
  const ready = useTaskEngine(taskId).state === 'ready';
  const now = useNow(60_000);
  const p = PERSONA[st.mode];
  const who = st.persona ? p : { name: '编排 Agent', glyph: '编' };

  // A brand-new empty chat: she says hello first.
  useEffect(() => {
    if (!task?.empty || !st.greet || !ready) return;
    const t = window.setTimeout(() => {
      if (store.get().tasks[taskId]?.messages.length === 0) void reply(taskId, { greet: true });
    }, 900);
    return () => window.clearTimeout(t);
  }, [taskId, task?.empty, st.greet, ready]);

  // Quiet for a while: she may say something on her own.
  useEffect(() => {
    if (!st.nudge || !ready) return;
    const timer = window.setInterval(() => {
      const t = store.get().tasks[taskId];
      if (!t || !t.messages.length || document.visibilityState !== 'visible' || isReplying(taskId)) return;
      const last = t.messages[t.messages.length - 1];
      if (Date.now() - last.at < QUIET_MS || !t.messages.some((m) => m.role === 'user')) return;
      let unanswered = 0;
      for (let i = t.messages.length - 1; i >= 0 && t.messages[i].role !== 'user'; i--) if (t.messages[i].role === 'agent') unanswered++;
      if (unanswered >= MAX_UNANSWERED) return;
      void reply(taskId, { nudge: true });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [taskId, st.nudge, ready]);

  if (!task) return null;
  const status = typing ? mood(st.mode, 'typing') : st.moodOn && st.persona ? mood(st.mode, 'idle', new Date(now)) : '在线';

  return (
    <div className="workspace chat-ws" data-run="chat">
      <section className="panel chat-ws__header" aria-label="闲聊概览">
        <IconButton icon={ArrowLeft} label="返回任务列表" onClick={() => actions.navigate('tasks')} />
        <AgentAvatar agent={{ glyph: who.glyph, hue: 'mint', name: who.name }} size="lg" activity={typing ? 'thinking' : 'idle'} />
        <div className="chat-ws__who">
          <h1 className="chat-ws__title">{task.title}</h1>
          <p className="chat-ws__status"><strong>{who.name}</strong><span aria-hidden> · </span><span>{status}</span></p>
        </div>
        <div className="chat-ws__tools">
          {task.engine && <EngineTag label={task.engine} />}
          <IconButton icon={Trash2} label="删除这段闲聊" onClick={() => actions.requestDeleteTask(taskId)} />
        </div>
      </section>
      <section className="panel ws-main chat-ws__main" aria-label="闲聊">
        <div className="ws-main__panel">
          <Conversation taskId={taskId} active chat />
        </div>
      </section>
    </div>
  );
}
