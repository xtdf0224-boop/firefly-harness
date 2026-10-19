/* Small hooks shared by the console tabs. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Preferences that should survive switching tabs or collapsing the console (not a page reload). */
const memory = new Map<string, unknown>();

export function useRemembered<T>(key: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => (memory.has(key) ? (memory.get(key) as T) : initial));
  const set = useCallback((next: T) => {
    memory.set(key, next);
    setValue(next);
  }, [key]);
  return [value, set];
}

const NEAR_BOTTOM = 32;

/** Sticky-bottom scrolling for a log-like list.
 *  Follows new content while the reader is at the bottom; once they scroll up it stops, and
 *  `following` turns false so the UI can offer a jump back. `changeKey` is anything that changes
 *  when content is added (usually the list length). The scroller element must always be rendered. */
export function useFollowScroll<T extends HTMLElement = HTMLDivElement>(changeKey: unknown) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  const [following, setFollowingState] = useState(true);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM;
    pinned.current = atBottom;
    setFollowingState(atBottom);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [changeKey]);

  // Stay pinned when the console is resized.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (pinned.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const setFollowing = useCallback((value: boolean) => {
    pinned.current = value;
    setFollowingState(value);
    const el = ref.current;
    if (value && el) el.scrollTop = el.scrollHeight;
  }, []);

  const jump = useCallback(() => setFollowing(true), [setFollowing]);

  // Expanding an item can push the bottom away from under the reader: stop pinning for the click,
  // then re-measure once layout has settled (it re-pins if they are still at the bottom).
  const onClickCapture = useCallback(() => {
    pinned.current = false;
    requestAnimationFrame(() => requestAnimationFrame(measure));
  }, [measure]);

  return { ref, following, setFollowing, jump, onScroll: measure, onClickCapture };
}

/** A polite status message for a filtered list, spoken only after the reader changes a filter or
 *  the search. A live region bound to the data would re-announce on every streamed event, so the
 *  text is rebuilt (debounced) from `describe` only when `trigger` changes, never when data arrives. */
export function useSpokenResult(trigger: string, describe: () => string) {
  const [spoken, setSpoken] = useState('');
  const latest = useRef(describe);
  latest.current = describe;
  const seen = useRef(trigger);
  useEffect(() => {
    if (seen.current === trigger) return;
    seen.current = trigger;
    const id = window.setTimeout(() => setSpoken(latest.current()), 600);
    return () => window.clearTimeout(id);
  }, [trigger]);
  return spoken;
}
