/* Imported first by driver-check.ts: gives the state modules a desktop bridge (they read it once, when they load).
   Starting a stream and hearing its events are steered by the check through `hooks`. */
export type Handler = (ev: { id: string; type: string; [key: string]: unknown }) => void;
export const hooks: { handlers: Handler[]; start: (spec: never) => Promise<string> } = { handlers: [], start: async () => 'none' };

const bridge = {
  onEvent(fn: Handler) { hooks.handlers.push(fn); return () => {}; },
  start: (spec: never) => hooks.start(spec),
  detect: async () => ({ found: false }),
  info: async () => ({}),
  answer: async () => true,
  input: async () => true,
  stop: async () => true,
};
Object.defineProperty(globalThis, 'window', { value: { fireflyDesktop: bridge, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval }, configurable: true });

const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } },
});
