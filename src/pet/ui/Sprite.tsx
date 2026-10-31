/* The figure. Frames are public/pet/<firefly|sam>/<pose>.png; until those exist (or when one is missing)
   a drawn stand-in fills in, so the pet works before the art does. */
import { memo, useEffect, useState } from 'react';
import type { VisualMode } from '../../lib/types';

export type PetPose = 'idle' | 'blink' | 'talk' | 'think' | 'watch' | 'happy' | 'sleep';
export const POSES: PetPose[] = ['idle', 'blink', 'talk', 'think', 'watch', 'happy', 'sleep'];

const url = (mode: VisualMode, pose: PetPose) => `./pet/${mode}/${pose}.png`;

/** Which frames of a mode exist. `null` while they are being checked. */
function useFrames(mode: VisualMode): Set<PetPose> | null {
  const [found, setFound] = useState<{ mode: VisualMode; poses: Set<PetPose> } | null>(null);
  useEffect(() => {
    let live = true;
    const poses = new Set<PetPose>();
    let left = POSES.length;
    for (const pose of POSES) {
      const img = new Image();
      const done = (ok: boolean) => {
        if (ok) poses.add(pose);
        if (--left === 0 && live) setFound({ mode, poses });
      };
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = url(mode, pose);
    }
    return () => { live = false; };
  }, [mode]);
  return found && found.mode === mode ? found.poses : null;
}

/** The nearest frame that exists: a missing pose falls back to idle. */
const resolve = (have: Set<PetPose>, pose: PetPose): PetPose => (have.has(pose) ? pose : 'idle');

export const Sprite = memo(function Sprite({ mode, pose }: { mode: VisualMode; pose: PetPose }) {
  const have = useFrames(mode);
  if (!have) return null;
  if (!have.has('idle')) return <Placeholder mode={mode} pose={pose} />;
  const shown = resolve(have, pose);
  // Every frame stays mounted and only one is visible: swapping `src` would flash while it decodes.
  return (
    <div className="pet-frames">
      {POSES.filter((p) => have.has(p)).map((p) => (
        <img key={p} className="pet-frame" src={url(mode, p)} alt="" draggable={false} data-on={p === shown ? '' : undefined} />
      ))}
    </div>
  );
});

/* ───────────── the stand-in ───────────── */

function Placeholder({ mode, pose }: { mode: VisualMode; pose: PetPose }) {
  return (
    <svg className="pet-placeholder" viewBox="0 0 220 280" role="img" aria-label={mode === 'sam' ? '萨姆' : '流萤'}>
      {mode === 'sam' ? <Sam pose={pose} /> : <Firefly pose={pose} />}
      {pose === 'think' && <g fill="currentColor" className="pet-ph-dots"><circle cx="170" cy="46" r="4" /><circle cx="184" cy="34" r="5" /><circle cx="200" cy="20" r="6" /></g>}
      {pose === 'sleep' && <text x="168" y="52" className="pet-ph-z">z</text>}
    </svg>
  );
}

const closed = (pose: PetPose) => pose === 'blink' || pose === 'sleep';

function Firefly({ pose }: { pose: PetPose }) {
  const shut = closed(pose);
  const happy = pose === 'happy';
  const open = pose === 'talk';
  const wide = pose === 'watch';
  return (
    <g>
      <defs>
        <linearGradient id="ph-hair" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stopColor="#d4d8e3" /><stop offset="1" stopColor="#67c3c4" /></linearGradient>
        <linearGradient id="ph-dress" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b6ecd6" /><stop offset="1" stopColor="#6ec7b3" /></linearGradient>
        <linearGradient id="ph-eye" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#6f66dc" /><stop offset="1" stopColor="#c6a3ff" /></linearGradient>
      </defs>
      <ellipse cx="110" cy="266" rx="50" ry="8" fill="rgba(0,0,0,.2)" />
      <path d="M44 120 Q30 190 52 214 Q66 200 70 150 Z M176 120 Q190 190 168 214 Q154 200 150 150 Z" fill="url(#ph-hair)" />
      <rect x="88" y="238" width="16" height="22" rx="7" fill="#2b3347" />
      <rect x="116" y="238" width="16" height="22" rx="7" fill="#2b3347" />
      <ellipse cx="96" cy="262" rx="12" ry="6" fill="#f2efe6" />
      <ellipse cx="124" cy="262" rx="12" ry="6" fill="#f2efe6" />
      <path d="M84 176 L136 176 L148 240 L72 240 Z" fill="url(#ph-dress)" />
      <path d="M84 176 L110 196 L136 176 L128 170 L92 170 Z" fill="#f4f4f7" />
      <path d="M96 188 L110 202 L124 188" fill="none" stroke="#e8b44a" strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="72" cy="198" rx="10" ry="18" fill="#f4f4f7" transform="rotate(14 72 198)" />
      <ellipse cx="148" cy="198" rx="10" ry="18" fill="#f4f4f7" transform="rotate(-14 148 198)" />
      <circle cx="66" cy="218" r="7" fill="#fbe9de" />
      <circle cx="154" cy="218" r="7" fill="#fbe9de" />
      <ellipse cx="110" cy="104" rx="70" ry="70" fill="url(#ph-hair)" />
      <circle cx="110" cy="112" r="54" fill="#fbe9de" />
      <path d="M52 108 Q56 52 110 50 Q164 52 168 108 Q150 82 110 84 Q70 82 52 108 Z" fill="#d6dae5" />
      <path d="M54 96 Q110 70 166 96 L166 104 Q110 80 54 104 Z" fill="#2a2e3d" />
      <path d="M104 52 Q96 34 112 30 Q122 28 118 40" fill="none" stroke="#cfd3de" strokeWidth="5" strokeLinecap="round" />
      <ellipse cx="162" cy="76" rx="13" ry="7" fill="#e9f5b6" stroke="#b6d677" strokeWidth="2" transform="rotate(-35 162 76)" />
      <path d="M150 90 L168 96 L152 104 Z" fill="#2a2e3d" />
      {shut || happy ? (
        <g fill="none" stroke="#3a3350" strokeWidth="3.5" strokeLinecap="round">
          <path d={happy ? 'M80 122 Q90 110 100 122' : 'M80 118 Q90 126 100 118'} />
          <path d={happy ? 'M120 122 Q130 110 140 122' : 'M120 118 Q130 126 140 118'} />
        </g>
      ) : (
        <g>
          <ellipse cx="90" cy="118" rx={wide ? 11 : 9} ry={wide ? 14 : 12} fill="url(#ph-eye)" />
          <ellipse cx="130" cy="118" rx={wide ? 11 : 9} ry={wide ? 14 : 12} fill="url(#ph-eye)" />
          <circle cx={pose === 'think' ? 94 : 87} cy={pose === 'think' ? 111 : 113} r="3.5" fill="#fff" />
          <circle cx={pose === 'think' ? 134 : 127} cy={pose === 'think' ? 111 : 113} r="3.5" fill="#fff" />
        </g>
      )}
      <ellipse cx="74" cy="134" rx="9" ry="5" fill="rgba(255,120,130,.33)" />
      <ellipse cx="146" cy="134" rx="9" ry="5" fill="rgba(255,120,130,.33)" />
      {open ? <ellipse cx="110" cy="142" rx="6" ry="7" fill="#b45a68" /> : <path d={happy ? 'M101 138 Q110 148 119 138' : 'M104 140 Q110 144 116 140'} fill="none" stroke="#a5525f" strokeWidth="3" strokeLinecap="round" />}
    </g>
  );
}

function Sam({ pose }: { pose: PetPose }) {
  const shut = closed(pose);
  const happy = pose === 'happy';
  const open = pose === 'talk';
  const dim = pose === 'sleep';
  return (
    <g>
      <defs>
        <linearGradient id="ph-armor" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#b7bdf5" /><stop offset="1" stopColor="#6f78d6" /></linearGradient>
        <radialGradient id="ph-core"><stop offset="0" stopColor="#e6ffff" /><stop offset="1" stopColor="#35d6ee" /></radialGradient>
      </defs>
      <ellipse cx="110" cy="266" rx="54" ry="8" fill="rgba(0,0,0,.22)" />
      <path d="M78 246 L92 246 L96 266 L72 266 Z M128 246 L142 246 L148 266 L124 266 Z" fill="#5b63b8" />
      <path d="M86 150 L134 150 L142 248 L78 248 Z" fill="url(#ph-armor)" />
      <path d="M96 156 L124 156 L130 206 L90 206 Z" fill="#8f98ea" opacity=".6" />
      <circle cx="110" cy="182" r="11" fill="url(#ph-core)" opacity={dim ? 0.35 : 1} />
      <path d="M58 140 L92 134 L96 168 L66 176 Z M162 140 L128 134 L124 168 L154 176 Z" fill="#9aa3f0" stroke="#5d66c4" strokeWidth="2" />
      <path d="M62 176 L82 172 L80 222 L58 222 Z M158 176 L138 172 L140 222 L162 222 Z" fill="#7c86e2" />
      <circle cx="68" cy="228" r="9" fill="#5b63b8" />
      <circle cx="152" cy="228" r="9" fill="#5b63b8" />
      <path d="M64 96 L52 40 L84 70 L96 22 L110 62 L124 22 L136 70 L168 40 L156 96 L170 124 L110 160 L50 124 Z" fill="url(#ph-armor)" stroke="#5d66c4" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M72 100 L148 100 L142 134 L110 148 L78 134 Z" fill="#2c3070" />
      <g fill="none" stroke="#5cf0ff" strokeWidth="5" strokeLinecap="round" opacity={dim ? 0.3 : 1}>
        {shut ? <path d="M82 118 L138 118" strokeWidth="2.5" /> : happy ? <path d="M82 124 Q96 108 110 124 Q124 108 138 124" /> : <path d="M82 118 L138 118" />}
        {open && <path d="M96 132 L124 132" strokeWidth="4" />}
      </g>
      <circle cx="110" cy="76" r="8" fill="url(#ph-core)" opacity={dim ? 0.35 : 1} />
    </g>
  );
}
