/* Imported first by driver-check.ts: gives the state modules a desktop bridge (they read it once, when they load).
   Starting a stream and hearing its events are steered by the check through `hooks`. The bridge also records what the
   page said to a stream (answers to questions, added words, stops): apitools-check.ts reads those. */
export type Handler = (ev: { id: string; type: string; [key: string]: unknown }) => void;
export const hooks: {
  handlers: Handler[];
  start: (spec: never) => Promise<string>;
  /** Every spec the page started a stream with, in order (the check clears it between scenarios). */
  starts: unknown[];
  answers: Array<{ id: string; requestId: string; decision: string; input?: Record<string, unknown> }>;
  inputs: Array<{ id: string; text: string }>;
  stops: Array<{ id: string; how?: string }>;
  /** What `input()` resolves to: false when the loop is over and nobody will read the words. */
  inputResult: boolean;
  /** Called when the page answers a question, so a fake stream waiting for it can go on. */
  onAnswer?: (id: string, requestId: string, decision: string) => void;
} = { handlers: [], start: async () => 'none', starts: [], answers: [], inputs: [], stops: [], inputResult: true };

const bridge = {
  onEvent(fn: Handler) { hooks.handlers.push(fn); return () => {}; },
  start: (spec: never) => hooks.start(spec),
  detect: async () => ({ found: false }),
  info: async () => ({}),
  answer: async (id: string, requestId: string, decision: string, input?: Record<string, unknown>) => {
    hooks.answers.push({ id, requestId, decision, input });
    hooks.onAnswer?.(id, requestId, decision);
    return true;
  },
  input: async (id: string, text: string) => { hooks.inputs.push({ id, text }); return hooks.inputResult; },
  stop: async (id: string, how?: string) => { hooks.stops.push({ id, how }); return true; },
};
Object.defineProperty(globalThis, 'window', { value: { fireflyDesktop: bridge, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval }, configurable: true });

const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } },
});
