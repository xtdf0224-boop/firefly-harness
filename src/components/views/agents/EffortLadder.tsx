/* 推理强度 as a ladder of rungs (出力): a radiogroup with a roving tabindex. Arrow keys move and select,
   Home / End jump. The first rung is 默认 (let the model decide). */
import { useRef, type KeyboardEvent } from 'react';
import { EFFORT_HINT, EFFORT_LABEL, type Effort } from '../../../lib/effort';
import { cx } from '../../ui';

export function EffortLadder({ levels, value, onChange, labelledBy }: { levels: Effort[]; value?: Effort; onChange: (v: Effort | undefined) => void; labelledBy: string }) {
  const rungs = useRef<Array<HTMLButtonElement | null>>([]);
  const list: Array<{ v: Effort | undefined; label: string; hint?: string }> = [
    { v: undefined, label: '默认', hint: '用模型自己的默认强度' },
    ...levels.map((v) => ({ v, label: EFFORT_LABEL[v], hint: EFFORT_HINT[v] })),
  ];
  const at = Math.max(0, list.findIndex((o) => o.v === (value && levels.includes(value) ? value : undefined)));

  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    const next = step ? at + step : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1;
    if (next < 0 || next >= list.length) return;
    e.preventDefault();
    onChange(list[next].v);
    rungs.current[next]?.focus();
  };

  const hint = list[at].v ? list[at].hint : undefined;
  return (
    <>
      <div className="effort-ladder" role="radiogroup" aria-labelledby={labelledBy} style={{ ['--n' as string]: list.length }} onKeyDown={onKey}>
        {list.map((o, i) => (
          <button key={o.v ?? 'default'} ref={(el) => { rungs.current[i] = el; }} type="button" role="radio" aria-checked={i === at} tabIndex={i === at ? 0 : -1}
            className={cx('effort-rung', i === at && 'is-on', i > 0 && i <= at && 'is-lit')} title={o.hint} onClick={() => onChange(o.v)}>
            <span className="effort-rung__bar" style={{ ['--lv' as string]: i }} aria-hidden />
            <span className="effort-rung__t">{o.label}</span>
          </button>
        ))}
      </div>
      {hint && <p className="agents-hint">{hint}</p>}
    </>
  );
}
