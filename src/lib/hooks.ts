import { useEffect, useState } from 'react';
import { useApp } from '../state/store';

/** Current time, refreshed every `ms` (for live clocks). Stops when `active` is false. */
export function useNow(ms = 1000, active = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, active]);
  return now;
}

function systemReduced() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** True when motion should be reduced: Settings override, else the OS preference. */
export function useReducedMotion() {
  const pref = useApp((s) => s.settings.motion);
  const [system, setSystem] = useState(systemReduced);
  useEffect(() => {
    let mq: MediaQueryList | undefined;
    try { mq = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { return; }
    const on = () => setSystem(mq!.matches);
    mq.addEventListener('change', on);
    return () => mq!.removeEventListener('change', on);
  }, []);
  return pref === 'reduced' || (pref === 'system' && system);
}

/** Page visibility, so canvases can stop drawing in background tabs. */
export function usePageVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/** Media query match (e.g. '(max-width: 1279px)'). */
export function useMedia(query: string) {
  const [match, setMatch] = useState(() => { try { return window.matchMedia(query).matches; } catch { return false; } });
  useEffect(() => {
    let mq: MediaQueryList | undefined;
    try { mq = window.matchMedia(query); } catch { return; }
    const on = () => setMatch(mq!.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq!.removeEventListener('change', on);
  }, [query]);
  return match;
}
