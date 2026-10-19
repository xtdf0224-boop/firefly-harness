/* WingMark — the 光翼 emblem: two mirrored, faceted light-wings rising around one firefly core.

   Geometry (viewBox 0 0 64 64, left wing drawn, right wing mirrored):
     · four feather facets fan out of the root beside the core; each facet is split along its
       centre-line into a lighter and a darker triangle, so the wing reads as cut armour plate;
     · the leading facet's inner edge (the "spine") gets a thin silver highlight;
     · strokes use one mint → firefly gradient, fills are low-opacity;
     · the core is a radial gradient (pale green-white → firefly → transparent) with a tiny glint.
   `animated` adds a slow dash of light that runs the wing contour and a gentle core pulse (decor.css;
   static under reduced motion). Gradient ids are unique per instance so many marks can coexist. */
import { useId } from 'react';

export interface WingMarkProps {
  /** Pixel size of the square mark. */
  size?: number;
  /** Soft firefly glow behind the core. */
  glow?: boolean;
  /** Slow energy flow along the wing edges (static under reduced motion). */
  animated?: boolean;
  /** Accessible name; omit for decorative use (then aria-hidden). */
  title?: string;
  className?: string;
}

type Pt = readonly [number, number];
const pts = (list: readonly Pt[]) => list.map((p) => `${p[0]},${p[1]}`).join(' ');

/* ── left-wing geometry ── */
const ROOT: Pt = [29, 38];
const SPINE_1: Pt = [28.4, 28.6];
const SPINE_2: Pt = [24.6, 19.4];
const SPINE_3: Pt = [17.6, 11.8];
const TIP_A: Pt = [4.5, 5];
const TIP_B: Pt = [2.8, 16.8];
const TIP_C: Pt = [5.5, 28];
const TIP_D: Pt = [12.5, 38.5];
const NOTCH_A: Pt = [8.7, 16.3];       // between tips A and B
const NOTCH_B: Pt = [9.1, 25.5];
const NOTCH_C: Pt = [13, 34.2];
const NOTCH_D: Pt = [20.5, 43.5];       // lower root edge

/** Facet plates, all fanning from the root. Each feather is a lighter + a darker triangle (split along
 *  its centre-line); the leading feather gets an extra plate along the spine. */
const PLATES: ReadonlyArray<{ p: readonly Pt[]; o: number }> = [
  { p: [ROOT, SPINE_1, SPINE_2], o: 0.36 },
  { p: [ROOT, SPINE_2, SPINE_3, TIP_A], o: 0.26 },
  { p: [ROOT, TIP_A, NOTCH_A], o: 0.17 },
  { p: [ROOT, NOTCH_A, TIP_B], o: 0.21 },
  { p: [ROOT, TIP_B, NOTCH_B], o: 0.12 },
  { p: [ROOT, NOTCH_B, TIP_C], o: 0.15 },
  { p: [ROOT, TIP_C, NOTCH_C], o: 0.085 },
  { p: [ROOT, NOTCH_C, TIP_D], o: 0.1 },
  { p: [ROOT, TIP_D, NOTCH_D], o: 0.055 },
];
/** Centre-lines between plates (fine ridges, only drawn at larger sizes). */
const RIBS: readonly Pt[] = [SPINE_2, TIP_A, TIP_B, TIP_C, TIP_D];

const CONTOUR = [ROOT, SPINE_1, SPINE_2, SPINE_3, TIP_A, NOTCH_A, TIP_B, NOTCH_B, TIP_C, NOTCH_C, TIP_D, NOTCH_D] as const;
const CONTOUR_D = `M${CONTOUR.map((p) => p.join(',')).join(' L')} Z`;
const SPINE_D = `M${[ROOT, SPINE_1, SPINE_2, SPINE_3, TIP_A].map((p) => p.join(',')).join(' L')}`;

interface WingProps {
  mirror?: boolean;
  gradId: string;
  detail: boolean;
  animated: boolean;
}

function Wing({ mirror, gradId, detail, animated }: WingProps) {
  return (
    <g transform={mirror ? 'matrix(-1 0 0 1 64 0)' : undefined} className="wingmark__wing">
      {PLATES.map((pl, i) => <polygon key={i} points={pts(pl.p)} fill={`url(#${gradId})`} fillOpacity={pl.o} />)}
      {detail && RIBS.map((r, i) => (
        <path key={i} d={`M${ROOT.join(',')} L${r.join(',')}`} className="wingmark__rib" stroke={`url(#${gradId})`} />
      ))}
      <path d={CONTOUR_D} className="wingmark__edge" fill="none" stroke={`url(#${gradId})`} />
      <path d={SPINE_D} className="wingmark__spine" fill="none" />
      {animated && (
        <>
          <path d={CONTOUR_D} className="wingmark__flow wingmark__flow--glow" fill="none" pathLength={100} />
          <path d={CONTOUR_D} className="wingmark__flow" fill="none" pathLength={100} />
        </>
      )}
    </g>
  );
}

/** 光翼 mark: two faceted light-wings around a firefly core. */
export function WingMark({ size = 32, glow = false, animated = false, title, className }: WingMarkProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const gradId = `wm-${uid}-edge`;
  const coreId = `wm-${uid}-core`;
  const haloId = `wm-${uid}-halo`;
  const titleId = `wm-${uid}-title`;
  // Keep the line weight visually steady (≈1–2 screen px) whatever the rendered size.
  const strokePx = Math.min(1.9, Math.max(1, 0.8 + size / 120));
  const sw = +(strokePx * (64 / size)).toFixed(2);
  const detail = size >= 40;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={['wingmark', animated && 'wingmark--animated', className].filter(Boolean).join(' ')}
      style={{ ['--wm-sw' as string]: sw }}
      role={title ? 'img' : undefined}
      aria-labelledby={title ? titleId : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title && <title id={titleId}>{title}</title>}
      <defs>
        <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1="6" y1="4" x2="30" y2="44">
          <stop offset="0" style={{ stopColor: 'var(--mint)' }} />
          <stop offset="1" style={{ stopColor: 'var(--firefly)' }} />
        </linearGradient>
        <radialGradient id={coreId} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" style={{ stopColor: 'var(--text)' }} stopOpacity="1" />
          <stop offset="0.18" style={{ stopColor: 'var(--firefly-glow)' }} stopOpacity="0.98" />
          <stop offset="0.5" style={{ stopColor: 'var(--firefly)' }} stopOpacity="0.5" />
          <stop offset="1" style={{ stopColor: 'var(--firefly)' }} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={haloId} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" style={{ stopColor: 'var(--firefly)' }} stopOpacity="0.4" />
          <stop offset="0.45" style={{ stopColor: 'var(--mint)' }} stopOpacity="0.14" />
          <stop offset="1" style={{ stopColor: 'var(--mint)' }} stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* The art spans y 5–44; shift it down so its visual centre sits in the middle of the square. */}
      <g transform="translate(0 7)">
        {glow && <circle className="wingmark__halo" cx="32" cy="38.8" r="30" fill={`url(#${haloId})`} />}

        <Wing gradId={gradId} detail={detail} animated={animated} />
        <Wing mirror gradId={gradId} detail={detail} animated={animated} />

        <g className="wingmark__core">
          <circle cx="32" cy="38.8" r="10" fill={`url(#${coreId})`} />
          <path className="wingmark__glint" d="M32 33.6 V44 M26.8 38.8 H37.2" />
          <circle cx="32" cy="38.8" r="2.1" className="wingmark__core-dot" />
        </g>
      </g>
    </svg>
  );
}
