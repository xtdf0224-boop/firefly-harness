/* Small pieces shared by the formation chart, the tool matrix and the loadout drawer. */
import { useId } from 'react';
import { PERSONA } from '../../../lib/persona';
import type { VisualMode } from '../../../lib/types';
import { cx } from '../../ui';
import { asset, PV_CREDIT, type Member } from './crew';

/** The agent's avatar as a light: her Q sprite for the chart (pose follows its state), else its glyph.
    The sprite is only cropped and scaled down (640 px source, shown at 96–140 px); nothing is applied to it. */
export function CrewOrb({ m, mode, pet, size = 'md' }: { m: Member; mode: VisualMode; pet?: boolean; size?: 'xs' | 'md' | 'lg' }) {
  return (
    <span className={cx('crew-orb', `crew-orb--${m.agent.hue}`, `crew-orb--${size}`, pet && 'crew-orb--pet')} data-state={m.trail} aria-hidden>
      <span className="crew-orb__halo" />
      <span className="crew-orb__body">
        {pet
          ? <img className="crew-orb__pet" src={asset(`pet/${mode}/${m.pose}.png`)} alt="" width={640} height={640} draggable={false} decoding="async" />
          : <span className="crew-orb__glyph">{m.agent.glyph}</span>}
      </span>
      {(pet || size === 'lg') && m.stat.errors > 0 && <span className="crew-orb__err">{m.stat.errors}</span>}
    </span>
  );
}

/** 步骤 / 调用 / 出错 on one line; the error cell turns red (and says so) when it is above zero. */
export function CrewStats({ stat, className }: { stat: { steps: number; calls: number; errors: number }; className?: string }) {
  return (
    <span className={cx('crew-stats', className)}>
      <span><b>{stat.steps}</b>步骤</span>
      <span><b>{stat.calls}</b>调用</span>
      <span className={cx(stat.errors > 0 && 'is-err')}><b>{stat.errors}</b>出错{stat.errors > 0 && <span className="sr-only">（有出错）</span>}</span>
    </span>
  );
}

/** The PV credit chip on the art, in the boot screen's wording. One line when there is room; where it must wrap,
    it breaks only before 「© HoYoverse」. The text content is the full credit either way. */
export function PvCredit({ className }: { className?: string }) {
  const i = PV_CREDIT.indexOf('©');
  return <p className={cx('pv-credit', className)} title={PV_CREDIT}><span className="pv-credit__t">{PV_CREDIT.slice(0, i)}</span><span className="pv-credit__t">{PV_CREDIT.slice(i)}</span></p>;
}

/** The official PV still, avif first then webp, as the boot screen loads it (1920×1080 on disk; shown at about 0.5× or less). */
export function PvStill({ mode, alt = '', className }: { mode: VisualMode; alt?: string; className?: string }) {
  const src = asset(`boot/${mode}-hold`);
  return (
    <picture>
      <source type="image/avif" srcSet={`${src}.avif`} />
      <img className={className} src={`${src}.webp`} alt={alt} width={1920} height={1080} draggable={false} decoding="async" />
    </picture>
  );
}

export const pvAlt = (mode: VisualMode) => `${PERSONA[mode].name}（官方 PV 定格）`;

/** The 光翼 emblem (流萤) or visor plate (萨姆) that every trail leaves from: drawn here, not a game asset. */
export function LeadMark({ mode }: { mode: VisualMode }) {
  const id = useId().replace(/[^\w-]/g, '');
  if (mode === 'sam') {
    return (
      <svg viewBox="0 0 64 64" className="lead-mark__svg" aria-hidden>
        <polygon points="32,3 57,17 57,47 32,61 7,47 7,17" className="sam-plate" />
        <polygon points="32,10 51,21 51,43 32,54 13,43 13,21" className="sam-plate2" />
        <path d="M17 30 L32 24 L47 30 L42 36 L32 33 L22 36 Z" className="sam-visor" />
        <path d="M32 40 L36 46 L32 50 L28 46 Z" className="sam-gem" />
      </svg>
    );
  }
  const wing = (
    <g className="ff-wing">
      <polygon points="29,38 28.4,28.6 24.6,19.4" opacity=".55" />
      <polygon points="29,38 24.6,19.4 17.6,11.8 4.5,5" opacity=".38" />
      <polygon points="29,38 4.5,5 8.7,16.3" opacity=".24" />
      <polygon points="29,38 8.7,16.3 2.8,16.8" opacity=".3" />
      <polygon points="29,38 2.8,16.8 9.1,25.5" opacity=".18" />
      <polygon points="29,38 9.1,25.5 5.5,28" opacity=".22" />
      <polygon points="29,38 5.5,28 13,34.2" opacity=".13" />
      <polygon points="29,38 13,34.2 12.5,38.5 20.5,43.5" opacity=".1" />
      <path d="M29,38 L28.4,28.6 L24.6,19.4 L17.6,11.8 L4.5,5 L8.7,16.3 L2.8,16.8 L9.1,25.5 L5.5,28 L13,34.2 L12.5,38.5 L20.5,43.5 Z" className="ff-edge" />
    </g>
  );
  return (
    <svg viewBox="0 0 64 64" className="lead-mark__svg" aria-hidden style={{ ['--wg' as string]: `url(#${id}-wg)` }}>
      <defs>
        <linearGradient id={`${id}-wg`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8af0db" /><stop offset="1" stopColor="#b5f26b" /></linearGradient>
        <radialGradient id={`${id}-core`} cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="#f4ffe0" /><stop offset=".45" stopColor="#b5f26b" /><stop offset="1" stopColor="#b5f26b" stopOpacity="0" /></radialGradient>
      </defs>
      {wing}
      <g transform="matrix(-1 0 0 1 64 0)">{wing}</g>
      <circle cx="32" cy="38" r="9" fill={`url(#${id}-core)`} />
    </svg>
  );
}
