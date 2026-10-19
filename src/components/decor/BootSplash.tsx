/* 开机动画 — modelled on Honkai: Star Rail's version launch screen, hand-made for this workbench.
   1. 短片: a few seconds cut from the official Firefly PV「壳中萤火」 (流萤 mode: meteors over the dawn
      city → her smile; 萨姆 mode: armour plates locking → SAM spreading its light-wings).
   2. 标题画面: the clip's last frame holds and slowly pushes in, fireflies drift up, the mark and title
      sit top-left, 「点击进入」 breathes at the bottom with the version and 演示模式 line.
   3. 进入: click / Enter / any key → a light sweep and the workbench floats up.
   Skip during the clip jumps to the title screen. Settings › 外观 picks 点击进入 or 自动进入, or turns it off.
   Reduced motion, or a clip that fails to load, goes straight to a still title screen. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../../lib/hooks';
import { openRuns, pendingApprovals } from '../../state/selectors';
import { shallow, useApp } from '../../state/store';
import { PROVIDERS, readiness } from '../../lib/providers';
import { cx, Kbd } from '../ui';
import { WingMark } from './WingMark';

type Phase = 'film' | 'title' | 'enter';
const ENTER_MS = 900;
const AUTO_ENTER_MS = 1800;
const LOAD_TIMEOUT_MS = 2500;

const CLIP = {
  firefly: { video: 'boot/firefly.mp4', hold: 'boot/firefly-hold', caption: '流萤' },
  sam: { video: 'boot/sam.mp4', hold: 'boot/sam-hold', caption: '萨姆' },
} as const;

/** Fireflies rising over the title screen (positions fixed so every launch looks the same). */
const EMBERS = Array.from({ length: 18 }, (_, i) => ({
  left: (i * 37 + 11) % 100,
  delay: (i * 0.73) % 6,
  dur: 7 + ((i * 1.9) % 5),
  size: 3 + (i % 4),
  drift: ((i % 5) - 2) * 18,
}));

export function BootSplash({ onDone, onLeave }: { onDone: () => void; onLeave?: () => void }) {
  const mode = useApp((s) => s.settings.mode);
  const autoEnter = useApp((s) => s.settings.bootEnter === 'auto');
  const stats = useApp((s) => ({ tasks: s.taskOrder.length, open: openRuns(s).length, pending: pendingApprovals(s).length }), shallow);
  const liveCount = useApp((s) => PROVIDERS.filter((p) => readiness(p, s.models.providers[p.id], s.models.providers[p.id].auth).ready).length);
  const reduced = useReducedMotion();
  const clip = CLIP[mode];
  const base = import.meta.env.BASE_URL;
  const [phase, setPhase] = useState<Phase>(reduced ? 'title' : 'film');
  const video = useRef<HTMLVideoElement>(null);
  const enterBtn = useRef<HTMLButtonElement>(null);
  const skipBtn = useRef<HTMLButtonElement>(null);
  const cb = useRef({ onDone, onLeave });
  cb.current = { onDone, onLeave };

  const toTitle = useCallback(() => setPhase((p) => (p === 'film' ? 'title' : p)), []);
  const enter = useCallback(() => setPhase((p) => (p === 'enter' ? p : 'enter')), []);

  // 短片: play; if it cannot start in time (missing file, codec, slow disk) go straight to the title.
  // The browser may pause a muted clip while the window is hidden or covered: resume it when that
  // happens, and never let the clip hold the screen longer than its length + 2.5 s.
  useEffect(() => {
    if (phase !== 'film') return;
    const v = video.current;
    if (!v) return;
    let started = false;
    let watchdog = 0;
    const arm = (ms: number) => { window.clearTimeout(watchdog); watchdog = window.setTimeout(toTitle, ms); };
    const onPlaying = () => { started = true; };
    const onMeta = () => arm((Number.isFinite(v.duration) ? v.duration * 1000 : 6000) + 2500);
    const onPause = () => { if (!v.ended) v.play().catch(() => undefined); };
    const onVisible = () => { if (document.visibilityState === 'visible' && v.paused && !v.ended) v.play().catch(() => undefined); };
    v.addEventListener('playing', onPlaying);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('pause', onPause);
    document.addEventListener('visibilitychange', onVisible);
    if (v.readyState >= 1) onMeta(); else arm(9000);
    v.play().catch(() => toTitle());
    const t = window.setTimeout(() => { if (!started) toTitle(); }, LOAD_TIMEOUT_MS);
    skipBtn.current?.focus({ preventScroll: true });
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(watchdog);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('pause', onPause);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [phase, toTitle]);

  // 标题画面: focus 「点击进入」; 自动进入 after a moment when chosen.
  useEffect(() => {
    if (phase !== 'title') return;
    enterBtn.current?.focus({ preventScroll: true });
    if (!autoEnter) return;
    const t = window.setTimeout(enter, reduced ? 900 : AUTO_ENTER_MS);
    return () => window.clearTimeout(t);
  }, [phase, autoEnter, enter, reduced]);

  // 进入: let the workbench rise while the splash sweeps away.
  useEffect(() => {
    if (phase !== 'enter') return;
    cb.current.onLeave?.();
    const t = window.setTimeout(() => cb.current.onDone(), reduced ? 0 : ENTER_MS);
    return () => window.clearTimeout(t);
  }, [phase, reduced]);

  // Keys never reach the workbench underneath. During the clip a key skips to the title; on the title
  // any key enters (Tab still moves focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      setPhase((p) => (p === 'film' ? 'title' : 'enter'));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div
      className={cx('boot', `boot--${mode}`, `is-${phase}`)}
      role="dialog"
      aria-modal="true"
      aria-label="开机画面"
      onClick={() => setPhase((p) => (p === 'film' ? 'title' : 'enter'))}
    >
      {/* 1. 短片 */}
      {!reduced && (
        <video
          ref={video}
          className="boot__film"
          src={`${base}${clip.video}`}
          muted
          playsInline
          preload="auto"
          aria-hidden
          onEnded={toTitle}
          onError={toTitle}
        />
      )}

      {/* 2. 标题画面 — the clip's last frame, holding */}
      <picture className="boot__hold" aria-hidden>
        <source type="image/avif" srcSet={`${base}${clip.hold}.avif`} />
        <img src={`${base}${clip.hold}.webp`} alt="" draggable={false} />
      </picture>
      <div className="boot__shade" aria-hidden />
      <div className="boot__embers" aria-hidden>
        {EMBERS.map((e, i) => (
          <span key={i} style={{ left: `${e.left}%`, width: e.size, height: e.size, animationDelay: `${e.delay}s`, animationDuration: `${e.dur}s`, ['--drift' as string]: `${e.drift}px` }} />
        ))}
      </div>
      {mode === 'sam' && <div className="boot__scan" aria-hidden />}

      <div className="boot__logo">
        <WingMark size={64} glow animated={!reduced} />
        <div className="boot__logo-text">
          <span className="boot__name">萤火</span>
          <span className="boot__sub">Agent 工作台</span>
        </div>
      </div>

      <div className="boot__gate">
        <span className="boot__gate-line" aria-hidden />
        <button ref={enterBtn} type="button" className="boot__enter" onClick={(e) => { e.stopPropagation(); enter(); }} tabIndex={phase === 'title' ? 0 : -1}>
          <span className="boot__enter-deco" aria-hidden>◆</span>
          点击进入
          <span className="boot__enter-deco" aria-hidden>◆</span>
        </button>
        <span className="boot__gate-line" aria-hidden />
      </div>

      <p className="boot__meta">
        <span>版本 0.2.0</span>
        <span aria-hidden>·</span>
        <span>{liveCount > 0 ? `已接入 ${liveCount} 个模型` : '演示模式（模拟数据）'}</span>
        <span aria-hidden>·</span>
        <span>{stats.tasks} 个任务{stats.pending ? ` · ${stats.pending} 项待确认` : ''}</span>
      </p>
      <p className="boot__credit">画面：《崩坏：星穹铁道》流萤角色 PV「壳中萤火」© HoYoverse</p>

      {phase === 'film' && (
        <button ref={skipBtn} type="button" className="boot__skip" onClick={(e) => { e.stopPropagation(); toTitle(); }}>
          跳过 <Kbd>任意键</Kbd>
        </button>
      )}
      <span className="boot__sweep" aria-hidden />
      <p className="sr-only" role="status">{phase === 'film' ? '萤火 Agent 工作台正在启动' : phase === 'title' ? '按任意键或点击「点击进入」进入工作台' : ''}</p>
    </div>
  );
}
