/** 75_000 → "1:15"; 3_725_000 → "1:02:05". */
export function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Human duration for tool calls: 820 ms / 4.2 s / 1 分 12 秒. */
export function duration(ms?: number) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m} 分 ${s} 秒` : `${m} 分`;
}

/** 12_345 → "12.3k"; 1_250_000 → "1.25M". */
export function tokens(n: number) {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1).replace(/\.?0+$/, '')}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

export function percent(part: number, whole: number) {
  return whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0;
}

export function timeOfDay(at: number) {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function shortDateTime(at: number) {
  return new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "刚刚 / 3 分钟前 / 2 小时前 / 10月16日 14:02". */
export function relative(at: number, now = Date.now()) {
  const diff = now - at;
  if (diff < 45_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return shortDateTime(at);
}

export function json(value: unknown) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function bytes(text: string) {
  const n = new TextEncoder().encode(text).length;
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
