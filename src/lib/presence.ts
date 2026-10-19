/* When did the user last have the workbench open? Lets 流萤 say 「你回来啦」 after a long absence.
   Best effort: blocked storage just means no welcome-back line. */
const KEY = 'firefly-harness/last-seen';

function read(): number {
  try { return Number(localStorage.getItem(KEY)) || 0; } catch { return 0; }
}
function write() {
  try { localStorage.setItem(KEY, String(Date.now())); } catch { /* ignore */ }
}

const last = read();
/** ms since the previous session ended (0 on the very first launch). Fixed for this session. */
export const awayMs = last ? Math.max(0, Date.now() - last) : 0;

write();
if (typeof window !== 'undefined') {
  window.setInterval(write, 60_000);
  window.addEventListener('pagehide', write);
}
