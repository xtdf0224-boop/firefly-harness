/* The chat panel's plain logic, apart from React so scripts/pet-check.ts can test it: the log (the desktop keeps the real
   one, electron/pet/index.cjs, and sends it here as PetChatMsg), what a key in the composer means, and what the header
   says she is doing. */
import type { PetChatEntry, PetChatMsg } from '../contracts';

/** The log keeps this many messages (the desktop keeps the same number). */
export const CHAT_MAX = 60;
/** What the user may type in one message. */
export const CHAT_INPUT_MAX = 500;

/** The log after one message from the desktop: the whole log, a message added (or grown under its id), or one taken back. */
export function applyChat(log: PetChatEntry[], m: PetChatMsg): PetChatEntry[] {
  if (m.op === 'reset') return m.entries.slice(-CHAT_MAX);
  if (m.op === 'drop') return log.some((e) => e.id === m.id) ? log.filter((e) => e.id !== m.id) : log;
  const i = log.findIndex((e) => e.id === m.entry.id);
  if (i >= 0) {
    const next = log.slice();
    next[i] = m.entry;
    return next;
  }
  const next = [...log, m.entry];
  return next.length > CHAT_MAX ? next.slice(-CHAT_MAX) : next;
}

/** What a key press in the composer means. While an IME is composing, Enter picks a candidate and Esc cancels it: neither is ours. */
export function composerKey(e: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }): 'send' | 'close' | null {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.key === 'Escape') return 'close';
  if (e.key === 'Enter' && !e.shiftKey) return 'send';
  return null;
}

/** What the header says: she is still thinking (the "let me think" line), writing her reply, or neither. */
export function chatActivity(log: PetChatEntry[]): 'think' | 'typing' | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.who === 'her' && e.streaming) return e.mood === 'think' ? 'think' : 'typing';
  }
  return null;
}

/** A message in full: her long answers carry the whole text (with its line breaks) in `more`. */
export const fullText = (e: PetChatEntry) => e.more || e.text;

/** Her avatar only on the first of several messages of hers in a row. */
export const startsRun = (log: PetChatEntry[], i: number) => i === 0 || log[i - 1].who !== log[i].who;

/** The log is scrolled (close enough) to its end: new messages keep it there. */
export const atEnd = (scrollTop: number, scrollHeight: number, clientHeight: number) => scrollHeight - scrollTop - clientHeight < 24;
