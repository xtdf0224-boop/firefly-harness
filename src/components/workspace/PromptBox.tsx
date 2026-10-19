/* The one message box, in the spirit of Claude / ChatGPT / DeepSeek / Cyrene: a rounded box with the
   text on top and a row of small chips underneath (mode, model, folder, permissions), and a round
   send button that turns into a stop button while she is replying. Centered on the home page,
   docked under the conversation elsewhere. Enter sends, Shift+Enter breaks the line. */
import { ArrowUp, Square } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { cx } from '../ui';

/** Spark flight paths (dx, dy, delay): up and a little to either side. */
const SPARKS: Array<[number, number, number]> = [[-18, -46, 0], [6, -64, 40], [22, -40, 90], [-6, -78, 140], [30, -70, 60], [-30, -58, 110]];

export interface PromptBoxProps {
  variant: 'home' | 'docked';
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  label: string;
  /** Chips on the left of the bottom row. */
  chips?: ReactNode;
  /** Small line under the box. */
  hint?: ReactNode;
  /** A reply is being written: the send button becomes 停止. */
  busy?: boolean;
  onStop?: () => void;
  /** Send is allowed with an empty box (e.g. a chat may start empty). */
  allowEmpty?: boolean;
  sending?: boolean;
  /** Why nothing can be sent right now (e.g. no model is set up). Typing still works; the reason is the send button's tooltip. */
  blocked?: string;
  invalid?: boolean;
  describedBy?: string;
  inputRef?: Ref<HTMLTextAreaElement>;
  minRows?: number;
  maxRows?: number;
  id?: string;
}

export function PromptBox({
  variant, value, onChange, onSubmit, placeholder, label, chips, hint, busy, onStop, allowEmpty, sending, blocked, invalid, describedBy, inputRef,
  minRows = variant === 'home' ? 3 : 1, maxRows = 8, id,
}: PromptBoxProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback((el: HTMLTextAreaElement | null) => {
    own.current = el;
    if (typeof inputRef === 'function') inputRef(el);
    else if (inputRef && typeof inputRef === 'object') (inputRef as { current: HTMLTextAreaElement | null }).current = el;
  }, [inputRef]);

  // Grow with the text between minRows and maxRows.
  useLayoutEffect(() => {
    const el = own.current;
    if (!el) return;
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const line = Number.parseFloat(cs.lineHeight) || 22;
    const pad = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
    const min = line * minRows + pad;
    const max = line * maxRows + pad;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, min), max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value, minRows, maxRows]);

  const empty = !value.trim();
  const canSend = !sending && !blocked && (allowEmpty || !empty);
  // A few fireflies lift off the send button each time something is sent.
  const [sparks, setSparks] = useState(0);
  const send = () => {
    if (!canSend) return;
    setSparks(Date.now());
    onSubmit();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    send();
  };

  return (
    <div className={cx('pbox', `pbox--${variant}`, invalid && 'is-invalid', busy && 'is-busy')}>
      <div className="pbox__box" onClick={(e) => { if (e.target === e.currentTarget) own.current?.focus(); }}>
        <label className="sr-only" htmlFor={id}>{label}</label>
        <textarea
          id={id}
          ref={setRef}
          className="pbox__input"
          rows={minRows}
          value={value}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="pbox__bar">
          <div className="pbox__chips">{chips}</div>
          {busy && onStop ? (
            <button type="button" className="pbox__send is-stop" aria-label="停止回复" title="停止回复" onClick={onStop}>
              <Square size={13} aria-hidden fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="pbox__send" aria-label={`${label}：发送`} title={blocked ?? '发送（Enter）'} disabled={!canSend} onClick={send}>
              <ArrowUp size={18} aria-hidden />
            </button>
          )}
        </div>
        {sparks > 0 && (
          <span className="pbox__sparks" key={sparks} aria-hidden>
            {SPARKS.map((p, i) => <i key={i} style={{ ['--x' as string]: `${p[0]}px`, ['--y' as string]: `${p[1]}px`, ['--d' as string]: `${p[2]}ms` }} />)}
          </span>
        )}
      </div>
      {hint && <p className="pbox__hint">{hint}</p>}
    </div>
  );
}
