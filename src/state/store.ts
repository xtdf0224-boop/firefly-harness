/* A small external store: immutable snapshots made with immer, read through useApp(selector).
   Immer keeps untouched subtrees by reference, so a component that selects `run.plan` re-renders
   only when the plan changes, even though the engine commits run time five times a second. */
import { produce, setAutoFreeze, type Draft } from 'immer';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { AppState } from '../lib/types';

setAutoFreeze(true);

type Listener = () => void;
let state: AppState;
const listeners = new Set<Listener>();
let afterUpdate: ((next: AppState, prev: AppState) => void) | undefined;

export const store = {
  get: () => state,
  init(initial: AppState, onUpdate?: (next: AppState, prev: AppState) => void) {
    state = initial;
    afterUpdate = onUpdate;
  },
  update(recipe: (draft: Draft<AppState>) => void) {
    const prev = state;
    const next = produce(state, recipe);
    if (next === prev) return;
    state = next;
    afterUpdate?.(next, prev);
    listeners.forEach((l) => l());
  },
  /** Swap in a whole new state (used by 重置演示数据). */
  replace(next: AppState) {
    const prev = state;
    state = next;
    afterUpdate?.(next, prev);
    listeners.forEach((l) => l());
  },
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

/** Select a slice of app state. Pass `shallow` when the selector builds a new array/object. */
export function useApp<T>(selector: (s: AppState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const cache = useRef<{ has: boolean; state?: AppState; selector?: (s: AppState) => T; value?: T }>({ has: false });
  const getSnapshot = useCallback(() => {
    const s = store.get();
    const c = cache.current;
    if (c.has && c.state === s && c.selector === selector) return c.value as T;
    const value = selector(s);
    c.state = s;
    c.selector = selector;
    if (c.has && equal(c.value as T, value)) return c.value as T;
    c.has = true;
    c.value = value;
    return value;
  }, [selector, equal]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** Shallow equality for arrays and plain objects (one level deep, by reference). */
export function shallow<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

let seq = 0;
/** Unique id: prefix + time + counter, safe across reloads of persisted state. */
export function uid(prefix: string) {
  seq = (seq + 1) % 1_679_616;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36).padStart(4, '0')}`;
}
