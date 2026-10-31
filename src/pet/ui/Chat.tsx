/* The chat panel above her figure: who she is and what she is doing, everything said lately (the desktop keeps the log,
   so it is all here again after the panel or her window closes), and a box to type in. Only what it is given is shown;
   opening, closing and the keyboard are the desktop's (electron/pet/window.cjs). */
import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { VisualMode } from '../../lib/types';
import type { PetChatEntry } from '../contracts';
import { CHAT_INPUT_MAX, atEnd, chatActivity, composerKey, fullText, startsRun } from './chatLog';

const WORDS: Record<VisualMode, { name: string; idle: string; think: string; typing: string; empty: string; placeholder: string }> = {
  firefly: { name: '流萤', idle: '在这里哦', think: '在想…', typing: '正在输入…', empty: '还没有聊过呢。想说什么都可以哦。', placeholder: '想聊点什么呢？' },
  sam: { name: '萨姆', idle: '在线', think: '解析中', typing: '回传中', empty: '通信频道已建立。等待输入。', placeholder: '下达指令…' },
};

const clock = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

interface Props {
  mode: VisualMode;
  log: PetChatEntry[];
  draft: string;
  setDraft(v: string): void;
  /** The window holds the keyboard right now. */
  keys: boolean;
  /** Bumped each time the desktop opens the panel (again): the caret goes back into the box. */
  opened: number;
  onSend(text: string): void;
  onClose(): void;
  /** A click into the panel while another window has the keyboard. */
  onTakeKeys(): void;
}

export function ChatPanel({ mode, log, draft, setDraft, keys, opened, onSend, onClose, onTakeKeys }: Props) {
  const w = WORDS[mode];
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** Follow the newest message unless the user has scrolled up to read. */
  const stick = useRef(true);
  const [behind, setBehind] = useState(false);
  const doing = chatActivity(log);

  // The caret goes into the box each time the desktop opens the panel (it has just made the window take the keyboard).
  useEffect(() => { box.current?.focus(); }, [opened]);
  // …and when a click back into the panel takes the keyboard again, unless the click was on something that wants it
  // itself (the box, a button) or on a message's text (to select it): a click on the header, an avatar or the log must
  // not leave the typing going nowhere.
  const caretBack = useRef(false);
  useEffect(() => {
    if (!keys || !caretBack.current) return;
    caretBack.current = false;
    if (!window.getSelection()?.isCollapsed) return;
    box.current?.focus();
  }, [keys]);
  const pressed = (e: PointerEvent<HTMLElement>) => {
    if (document.hasFocus()) return;
    caretBack.current = !(e.target as Element).closest?.('textarea, input, button, .pet-msg__text');
    onTakeKeys();
  };

  // Esc closes the panel wherever the keyboard is in the window (not while an IME is composing: there it cancels the candidate).
  useEffect(() => {
    const down = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || composerKey(e) !== 'close') return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [onClose]);

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setBehind(true);
  }, [log]);

  const scrolled = () => {
    const el = list.current;
    if (!el) return;
    stick.current = atEnd(el.scrollTop, el.scrollHeight, el.clientHeight);
    if (stick.current) setBehind(false);
  };
  const toEnd = () => {
    const el = list.current;
    stick.current = true;
    setBehind(false);
    if (el) el.scrollTop = el.scrollHeight;
  };

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const v = draft.trim();
    if (!v) return;
    toEnd();
    onSend(v);
    setDraft('');
    box.current?.focus();
  };
  const boxKeys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composerKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }) !== 'send') return;
    e.preventDefault();
    send();
  };

  return (
    <section className="pet-chat" data-hit data-keys={keys ? '' : undefined} aria-label={`和${w.name}聊天`}
      onPointerDown={pressed}>
      <header className="pet-chat__head">
        <Avatar mode={mode} />
        <div className="pet-chat__who">
          <strong className="pet-chat__name">{w.name}</strong>
          <span className="pet-chat__state" data-doing={doing ?? undefined}>
            {doing === 'think' ? w.think : doing === 'typing' ? w.typing : w.idle}
          </span>
        </div>
        <button type="button" className="pet-chat__close" aria-label="关闭聊天框" title="关闭（Esc）" onClick={onClose}>×</button>
      </header>
      <div className="pet-chat__body">
        <div ref={list} className="pet-chat__log" role="log" aria-live="polite" aria-label="聊天记录" aria-busy={doing ? true : undefined}
          tabIndex={0} onScroll={scrolled}>
          {log.length === 0 && <p className="pet-chat__empty">{w.empty}</p>}
          {log.map((e, i) => <Message key={e.id} entry={e} mode={mode} first={startsRun(log, i)} />)}
        </div>
        {/* On the log, not the panel: a draft of several lines makes the composer taller. */}
        {behind && <button type="button" className="pet-chat__new" onClick={toEnd}>新消息 ↓</button>}
      </div>
      <form className="pet-chat__composer" onSubmit={send}>
        <textarea ref={box} className="pet-chat__input" rows={1} value={draft} maxLength={CHAT_INPUT_MAX} spellCheck={false}
          aria-label={`对${w.name}说的话`} placeholder={w.placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={boxKeys} />
        {draft.length > CHAT_INPUT_MAX - 100 && <span className="pet-chat__count" aria-live="polite">{draft.length}/{CHAT_INPUT_MAX}</span>}
        <button type="submit" className="pet-chat__send" aria-label="发送" title="发送（Enter）" disabled={!draft.trim()}><SendIcon /></button>
      </form>
    </section>
  );
}

const Message = memo(function Message({ entry: e, mode, first }: { entry: PetChatEntry; mode: VisualMode; first: boolean }) {
  const thinking = e.who === 'her' && e.streaming && e.mood === 'think';
  return (
    <div className="pet-msg" data-who={e.who} data-first={first ? '' : undefined} data-streaming={e.streaming && !thinking ? '' : undefined}
      data-think={thinking ? '' : undefined}>
      {e.who === 'her' && (first ? <Avatar mode={mode} /> : <span className="pet-msg__gap" />)}
      <p className="pet-msg__text" title={clock(e.at)}>
        {e.voice && <span className="pet-msg__voice" title="语音"><MicIcon /></span>}
        {fullText(e)}
        {thinking && <span className="pet-dots" aria-hidden><i /><i /><i /></span>}
      </p>
    </div>
  );
});

/** Her face, cropped from her own idle sprite (the crop per mode is in pet.css). */
function Avatar({ mode }: { mode: VisualMode }) {
  return <span className="pet-avatar" aria-hidden style={{ backgroundImage: `url(./pet/${mode}/idle.png)` }} />;
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  );
}
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
