import { CheckCircle2, Circle, CircleDot } from 'lucide-react';
import { useId, useRef, type KeyboardEvent } from 'react';
import type { VisualMode } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { useApp } from '../../../state/store';
import { cx } from '../../ui';

const MODES: Array<{ id: VisualMode; name: string; desc: string }> = [
  { id: 'firefly', name: '流萤', desc: '柔和安静：圆角、半透明、萤火漂浮' },
  { id: 'sam', name: '萨姆', desc: '装甲强化：斜切边角、能量线更亮、执行状态更醒目' },
];

const SEGMENTS = 16;
const LIT = 10;

/** A miniature of a panel, a status chip and a meter. Styled per data-preview-mode, so each card shows
 *  its own look no matter which mode the app is currently in. Decorative: the card text names it. */
function ModePreview() {
  return (
    <span className="settings-pv" aria-hidden="true">
      <span className="settings-pv__panel">
        <span className="settings-pv__row">
          <span className="settings-pv__label">步骤 3 / 5</span>
          <span className="settings-pv__chip"><CircleDot size={11} aria-hidden />运行中</span>
        </span>
        <span className="settings-pv__meter">
          {Array.from({ length: SEGMENTS }, (_, i) => <span key={i} className={cx('settings-pv__seg', i < LIT && 'is-lit')} />)}
        </span>
      </span>
    </span>
  );
}

/** Radio group of two preview cards. Arrow keys move and select, like native radios. */
export function ModePicker() {
  const mode = useApp((s) => s.settings.mode);
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (i: number, focus = false) => {
    actions.setSetting('mode', MODES[i].id);
    if (focus) refs.current[i]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = MODES.findIndex((m) => m.id === mode);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % MODES.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + MODES.length) % MODES.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = MODES.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(next, true);
  };

  return (
    <div className="settings-item">
      <p className="settings-row__title" id={`${base}-title`}>视觉模式</p>
      <p className="settings-row__desc">切换只改变外观，不改变布局和功能。</p>
      <div className="settings-modes" role="radiogroup" aria-labelledby={`${base}-title`} onKeyDown={onKeyDown}>
        {MODES.map((m, i) => {
          const checked = m.id === mode;
          return (
            <button
              key={m.id}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-labelledby={`${base}-n-${m.id}`}
              aria-describedby={`${base}-d-${m.id}`}
              tabIndex={checked ? 0 : -1}
              data-preview-mode={m.id}
              className="settings-mode"
              onClick={() => select(i)}
            >
              <ModePreview />
              <span className="settings-mode__text">
                <span className="settings-mode__top">
                  <span className="settings-mode__name" id={`${base}-n-${m.id}`}>{m.name}</span>
                  <span className="settings-mode__state">
                    {checked ? <><CheckCircle2 size={14} aria-hidden />使用中</> : <Circle size={14} aria-hidden />}
                  </span>
                </span>
                <span className="settings-mode__desc" id={`${base}-d-${m.id}`}>{m.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
