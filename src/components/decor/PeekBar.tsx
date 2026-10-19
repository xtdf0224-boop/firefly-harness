/* 赏图: the whole interface fades out so the wallpaper can be seen in full; this bar is the only control
   left on screen. Esc, Alt+W or the button brings the workbench back (focus returns where it was). */
import { useEffect, useRef } from 'react';
import { actions } from '../../state/actions';
import { useApp } from '../../state/store';
import { Kbd } from '../ui';
import { wallpaperFor } from './wallpapers';

export function PeekBar() {
  const mode = useApp((s) => s.settings.mode);
  const w = wallpaperFor(mode);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    back.current?.focus();
    return () => prev?.focus?.();
  }, []);
  return (
    <div className="peek-bar" role="region" aria-label="赏图">
      <span className="peek-bar__title">{w.title}</span>
      <a className="peek-bar__credit" href={w.credit.url} target="_blank" rel="noopener noreferrer">
        {w.credit.label}<span className="sr-only">（在新窗口打开）</span>
      </a>
      <button ref={back} type="button" className="btn btn--secondary btn--sm peek-bar__back" onClick={() => actions.togglePeek(false)}>
        <span className="btn__label">返回工作台</span>
        <Kbd>Esc</Kbd>
      </button>
    </div>
  );
}
