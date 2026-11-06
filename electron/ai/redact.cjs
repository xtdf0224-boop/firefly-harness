'use strict';

/** Hide the active credential in complete event fields, including nested tool results. */
function scrub(value, secret) {
  if (typeof value === 'string') return value.split(secret).join('••••');
  if (Array.isArray(value)) return value.map((v) => scrub(v, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secret)]));
  return value;
}

/** Text and thinking arrive in fragments. Keep only a suffix that could begin the key until the
 *  next fragment decides it, so no fragment of a complete key reaches the renderer before redaction.
 *  Other events can pass immediately, including approvals that the running agent is waiting for. */
function redactedEmitter(emit, secret) {
  if (!secret) return emit;
  const pending = new Map();
  const flush = (type) => {
    const event = pending.get(type);
    pending.delete(type);
    if (event) emit(event);
  };
  return (event) => {
    const clean = scrub(event, secret);
    if ((event.type === 'text' || event.type === 'thinking') && typeof event.text === 'string') {
      const text = scrub((pending.get(event.type)?.text || '') + event.text, secret);
      let held = Math.min(secret.length - 1, text.length);
      while (held && !secret.startsWith(text.slice(-held))) held--;
      pending.delete(event.type);
      if (held) pending.set(event.type, { ...clean, text: text.slice(-held) });
      const ready = text.slice(0, text.length - held);
      if (ready) emit({ ...clean, text: ready });
      return;
    }
    if (event.type === 'text-break' || event.type === 'done' || event.type === 'error') {
      for (const type of pending.keys()) flush(type);
    }
    emit(clean);
  };
}

module.exports = { redactedEmitter };
