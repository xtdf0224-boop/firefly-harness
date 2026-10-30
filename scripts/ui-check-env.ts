/* Imported first by ui-check.ts: gives the state modules a desktop bridge (they read it once, when they load).
   test() is steered by the check through `bridgeCalls`. */
export const bridgeCalls: { test: () => Promise<unknown> } = { test: async () => ({ ok: true, text: 'OK', ms: 1200 }) };

const bridge = { onEvent() {}, test: () => bridgeCalls.test(), detect: async () => ({ found: false }), info: async () => ({}) };
Object.defineProperty(globalThis, 'window', { value: { fireflyDesktop: bridge, addEventListener() {}, removeEventListener() {} }, configurable: true });
