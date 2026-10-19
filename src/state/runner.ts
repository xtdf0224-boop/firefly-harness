/* The run clock: one tick every 200 ms while a run is going, so run and step times count only the
   time spent running. Browsers throttle background tabs, so each tick uses the real elapsed time
   (capped) rather than assuming 200 ms. */
import { needsTick, tick, TICK_MS } from './engine';
import { store } from './store';

let handle: number | undefined;
let last = 0;

export function startEngine() {
  if (handle !== undefined) return;
  last = performance.now();
  handle = window.setInterval(() => {
    const nowPerf = performance.now();
    const dt = Math.min(2000, nowPerf - last);
    last = nowPerf;
    if (!needsTick(store.get())) return;
    store.update((d) => tick(d, Date.now(), dt));
  }, TICK_MS);
}

export function stopEngine() {
  if (handle !== undefined) window.clearInterval(handle);
  handle = undefined;
}
