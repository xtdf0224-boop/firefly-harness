/* Shared primitives. Every region builds from these so 流萤 / 萨姆 modes and status semantics stay
   consistent. Styles live in styles/components.css. */
import { Check, Copy, Cpu, X, type LucideIcon } from 'lucide-react';
import {
  useCallback, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type KeyboardEvent, type ReactNode,
} from 'react';
import { focusMainHeading } from '../../lib/focus';
import type { StatusMeta } from '../../lib/status';
import type { Agent, AgentActivity, Tone } from '../../lib/types';
import { AGENT_ACTIVITY } from '../../lib/status';
import { actions } from '../../state/actions';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');
export { cx };

/* ───────────── Panel ───────────── */

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  as?: 'section' | 'aside' | 'div' | 'article';
  /** Small HUD caption above the title (e.g. "PLAN"); mono uppercase in 萨姆 mode. */
  label?: string;
  title?: ReactNode;
  icon?: LucideIcon;
  /** Right side of the header. */
  actions?: ReactNode;
  /** Draws the mint→green energy line under the header. */
  energy?: boolean;
  /** Breathing glow for live work. */
  live?: boolean;
  /** Visual emphasis for state: warning (awaiting), danger (failed). */
  tone?: 'warning' | 'danger' | 'success';
  bodyClassName?: string;
  /** Remove body padding (lists that run edge to edge). */
  flush?: boolean;
}

export function Panel({ as: Tag = 'section', label, title, icon: Icon, actions: right, energy, live, tone, className, bodyClassName, flush, children, ...rest }: PanelProps) {
  const headingId = useId();
  const hasHeader = !!(title || label || right);
  return (
    <Tag
      className={cx('panel', live && 'is-breathing', tone && `panel--${tone}`, className)}
      aria-labelledby={title ? headingId : undefined}
      {...rest}
    >
      {hasHeader && (
        <header className={cx('panel__header', energy && 'panel__header--energy')}>
          <div className="panel__heading">
            {Icon && <Icon className="panel__icon" size={16} aria-hidden />}
            <div className="panel__titles">
              {label && <span className="label panel__label">{label}</span>}
              {title && <h2 className="panel__title" id={headingId}>{title}</h2>}
            </div>
          </div>
          {right && <div className="panel__actions">{right}</div>}
        </header>
      )}
      <div className={cx('panel__body', flush && 'panel__body--flush', bodyClassName)}>{children}</div>
    </Tag>
  );
}

/* ───────────── Buttons ───────────── */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning' | 'success';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  /** Keyboard hint shown after the label, e.g. "Ctrl ↵". */
  kbd?: string;
  busy?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', icon: Icon, iconRight: IconRight, kbd, busy, className, children, type = 'button', disabled, ...rest }: ButtonProps) {
  const iconSize = size === 'sm' ? 14 : size === 'lg' ? 18 : 16;
  return (
    <button type={type} className={cx('btn', `btn--${variant}`, `btn--${size}`, busy && 'is-busy', className)} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {Icon && <Icon size={iconSize} aria-hidden className={busy ? 'spin' : undefined} />}
      {children != null && <span className="btn__label">{children}</span>}
      {kbd && <Kbd>{kbd}</Kbd>}
      {IconRight && <IconRight size={iconSize} aria-hidden />}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  /** Required: used as aria-label and tooltip. */
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary';
  pressed?: boolean;
}

export function IconButton({ icon: Icon, label, size = 'md', variant = 'ghost', pressed, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button type={type} className={cx('icon-btn', `icon-btn--${size}`, `icon-btn--${variant}`, pressed && 'is-pressed', className)}
      aria-label={label} title={label} aria-pressed={pressed} {...rest}>
      <Icon size={size === 'sm' ? 14 : 16} aria-hidden />
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/* ───────────── Status ───────────── */

export interface StatusChipProps {
  meta: StatusMeta;
  size?: 'sm' | 'md' | 'lg';
  /** Override label text (e.g. 未执行 for pending steps of a finished run). */
  label?: string;
  /** Show the breathing glow when the status is live. Default true. */
  glow?: boolean;
  className?: string;
  title?: string;
}

/** Icon + text, toned. Never colour alone. */
export function StatusChip({ meta, size = 'md', label, glow = true, className, title }: StatusChipProps) {
  const Icon = meta.icon;
  const live = meta.live && glow;
  return (
    <span className={cx('chip', `chip--${meta.tone}`, `chip--${size}`, live && 'chip--live', className)} title={title}>
      <Icon size={size === 'sm' ? 12 : size === 'lg' ? 16 : 14} aria-hidden className={cx('chip__icon', live && meta.spin && 'spin')} />
      <span>{label ?? meta.label}</span>
    </span>
  );
}

/** Small round count / tag badge. */
export function Badge({ tone = 'neutral', children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return <span className={cx('badge', `badge--${tone}`, className)} title={title}>{children}</span>;
}

/** Tone dot with a text alternative — for compact lists where a full chip is too heavy. */
export function ToneDot({ tone, live, label }: { tone: Tone; live?: boolean; label: string }) {
  return <span className={cx('tone-dot', `tone-dot--${tone}`, live && 'tone-dot--live')} role="img" aria-label={label} title={label} />;
}

/** Which model runs this task / run. */
export function EngineTag({ label, compact, className }: { label: string; compact?: boolean; className?: string }) {
  return (
    <span className={cx('engine-tag', compact && 'engine-tag--compact', className)} title={`使用的模型：${label}`}>
      <Cpu size={11} aria-hidden />
      <span className="truncate">{compact ? label.split(' · ')[0] : label}</span>
    </span>
  );
}

/* ───────────── Tabs ───────────── */

export interface TabItem<T extends string> { id: T; label: string; icon?: LucideIcon; count?: number; tone?: Tone; badgeLabel?: string }

/** Accessible tab list (arrow keys move, Home/End jump). Render the panel with tabPanelProps(). */
export function Tabs<T extends string>({ items, value, onChange, idBase, label, className, size = 'md' }: {
  items: TabItem<T>[]; value: T; onChange: (id: T) => void; idBase: string; label: string; className?: string; size?: 'sm' | 'md';
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={cx('tabs', `tabs--${size}`, className)} onKeyDown={onKey}>
      {items.map((t, i) => {
        const selected = t.id === value;
        const Icon = t.icon;
        return (
          <button key={t.id} ref={(el) => { refs.current[i] = el; }} role="tab" type="button" id={`${idBase}-tab-${t.id}`}
            aria-selected={selected} aria-controls={`${idBase}-panel-${t.id}`} tabIndex={selected ? 0 : -1}
            className={cx('tab', selected && 'is-selected')} onClick={() => onChange(t.id)}>
            {Icon && <Icon size={14} aria-hidden />}
            <span>{t.label}</span>
            {t.count != null && t.count > 0 && <Badge tone={t.tone ?? 'neutral'} title={t.badgeLabel}>{t.count}{t.badgeLabel && <span className="sr-only">{t.badgeLabel}</span>}</Badge>}
          </button>
        );
      })}
    </div>
  );
}

export function tabPanelProps(idBase: string, id: string) {
  return { role: 'tabpanel' as const, id: `${idBase}-panel-${id}`, 'aria-labelledby': `${idBase}-tab-${id}`, tabIndex: 0 };
}

/* ───────────── Segmented (radio group) & Switch ───────────── */

export function Segmented<T extends string>({ options, value, onChange, label, size = 'md', className }: {
  options: Array<{ value: T; label: string; icon?: LucideIcon; hint?: string }>; value: T; onChange: (v: T) => void; label: string; size?: 'sm' | 'md'; className?: string;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cx('segmented', `segmented--${size}`, className)}>
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <label key={o.value} className={cx('segmented__opt', o.value === value && 'is-selected')} title={o.hint}>
            <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} className="sr-only" />
            {Icon && <Icon size={14} aria-hidden />}
            <span>{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div className={cx('switch-row', disabled && 'is-disabled')}>
      <div className="switch-row__text">
        <label htmlFor={id} className="switch-row__label">{label}</label>
        {description && <p className="switch-row__desc" id={`${id}-d`}>{description}</p>}
      </div>
      <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={description ? `${id}-d` : undefined}
        className={cx('switch', checked && 'is-on')} onClick={() => onChange(!checked)} disabled={disabled}>
        <span className="switch__thumb" aria-hidden />
        <span className="switch__state" aria-hidden>{checked ? '开' : '关'}</span>
      </button>
    </div>
  );
}

/* ───────────── Slider ───────────── */

/** Labelled range input with a live value readout; the filled part of the track is an energy line. */
export function Slider({ label, value, onChange, min = 0, max = 100, step = 1, format = (v) => `${v}%`, description, disabled, ends }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number;
  format?: (v: number) => string; description?: string; disabled?: boolean;
  /** Words under the two ends of the track, e.g. ['朦胧', '清晰']. */
  ends?: [string, string];
}) {
  const id = useId();
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className={cx('slider', disabled && 'is-disabled')}>
      <div className="slider__head">
        <label htmlFor={id} className="slider__label">{label}</label>
        <output htmlFor={id} className="slider__value">{format(value)}</output>
      </div>
      {description && <p className="slider__desc" id={`${id}-d`}>{description}</p>}
      <input
        id={id}
        type="range"
        className="slider__input"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-describedby={description ? `${id}-d` : undefined}
        aria-valuetext={format(value)}
        style={{ ['--fill' as string]: `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {ends && <div className="slider__ends" aria-hidden><span>{ends[0]}</span><span>{ends[1]}</span></div>}
    </div>
  );
}

/* ───────────── Meter & Sparkline ───────────── */

/** Segmented armour-plate meter. */
export function Meter({ value, max, label, tone = 'running', segments = 24, valueText }: { value: number; max: number; label: string; tone?: Tone; segments?: number; valueText?: string }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const lit = Math.round(ratio * segments);
  return (
    <div className={cx('meter', `meter--${tone}`)} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={valueText}>
      {Array.from({ length: segments }, (_, i) => <span key={i} className={cx('meter__seg', i < lit && 'is-lit')} />)}
    </div>
  );
}

export function Sparkline({ values, label, width = 120, height = 28 }: { values: number[]; label: string; width?: number; height?: number }) {
  if (values.length < 2) return <svg width={width} height={height} role="img" aria-label={`${label}：数据不足`} className="sparkline" />;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (width - 4) + 2).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`);
  const area = `M2,${height - 1} L${pts.join(' L')} L${width - 2},${height - 1} Z`;
  const gid = `spark-${label.length}-${values.length}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="sparkline">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--mint)" stopOpacity="0.32" />
          <stop offset="1" stopColor="var(--mint)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <polyline points={pts.join(' ')} fill="none" stroke="var(--mint)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1].split(',')[0]} cy={pts[pts.length - 1].split(',')[1]} r="2.4" fill="var(--firefly)" />
    </svg>
  );
}

/* ───────────── Code ───────────── */

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      window.setTimeout(() => setDone(false), 1600);
    } catch {
      actions.toast({ tone: 'warning', title: '复制失败', body: '没有权限访问剪贴板。' });
    }
  }, [text]);
  return (
    <button type="button" className="copy-btn" onClick={copy} aria-label={done ? '已复制' : label} title={done ? '已复制' : label}>
      {done ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      <span>{done ? '已复制' : label}</span>
    </button>
  );
}

/** Monospace block with a header (language / caption), copy button and diff colouring. */
export function CodeBlock({ code, language, caption, maxHeight = 320, wrap, className }: {
  code: string; language?: string; caption?: ReactNode; maxHeight?: number | 'none'; wrap?: boolean; className?: string;
}) {
  const isDiff = language === 'diff';
  const lines = code.split('\n');
  return (
    <figure className={cx('code', wrap && 'code--wrap', className)}>
      <figcaption className="code__bar">
        <span className="code__lang">{caption ?? language ?? 'text'}</span>
        <span className="code__tools"><CopyButton text={code} /></span>
      </figcaption>
      <pre className="code__pre" style={{ maxHeight: maxHeight === 'none' ? undefined : maxHeight }} tabIndex={0}>
        <code>
          {isDiff
            ? lines.map((line, i) => (
                <span key={i} className={cx('code__line', line.startsWith('+') && !line.startsWith('+++') && 'is-add', line.startsWith('-') && !line.startsWith('---') && 'is-del', line.startsWith('@@') && 'is-hunk')}>
                  {line || ' '}{'\n'}
                </span>
              ))
            : code}
        </code>
      </pre>
    </figure>
  );
}

/* ───────────── Empty state ───────────── */

export function EmptyState({ icon: Icon, title, body, actions: buttons, compact, className }: { icon?: LucideIcon; title: string; body?: ReactNode; actions?: ReactNode; compact?: boolean; className?: string }) {
  return (
    <div className={cx('empty', compact && 'empty--compact', className)}>
      <div className="empty__mark" aria-hidden>
        <span className="empty__ember" />
        {Icon && <Icon size={compact ? 18 : 22} />}
      </div>
      <p className="empty__title">{title}</p>
      {body && <div className="empty__body">{body}</div>}
      {buttons && <div className="empty__actions">{buttons}</div>}
    </div>
  );
}

/* ───────────── Agent avatar ───────────── */

/** Faceted (diamond) avatar with the agent's glyph; a dot shows activity with a text alternative. */
export function AgentAvatar({ agent, activity, size = 'md' }: { agent: Pick<Agent, 'glyph' | 'hue' | 'name'>; activity?: AgentActivity; size?: 'sm' | 'md' | 'lg' }) {
  const meta = activity ? AGENT_ACTIVITY[activity] : undefined;
  return (
    <span className={cx('avatar', `avatar--${agent.hue}`, `avatar--${size}`, meta?.live && 'avatar--live')} aria-hidden={!meta} role={meta ? 'img' : undefined}
      aria-label={meta ? `${agent.name}：${meta.label}` : undefined}>
      <span className="avatar__facet" aria-hidden />
      <span className="avatar__glyph" aria-hidden>{agent.glyph}</span>
      {meta && <span className={cx('avatar__dot', `tone-dot--${meta.tone}`)} aria-hidden />}
    </span>
  );
}

/* ───────────── Dialog ───────────── */

/** Modal dialog: focus moves in, Tab is trapped, Esc closes, focus returns on close. */
export function Dialog({ title, children, onClose, footer, tone, icon: Icon, labelledBy }: {
  title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; tone?: 'danger' | 'warning'; icon?: LucideIcon; labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])') ?? []).filter((el) => !el.hasAttribute('disabled'));
    (node?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0])?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // Give focus back to the trigger. If it is gone (deleted row, swapped buttons), land on the page
      // heading instead of letting focus fall to <body>.
      if (prev && prev !== document.body && prev.isConnected) prev.focus?.();
      else if (prev && prev !== document.body) focusMainHeading();
    };
  }, [onClose]);
  return (
    <div className="dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={cx('dialog', tone && `dialog--${tone}`)} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? titleId}>
        <header className="dialog__header">
          {Icon && <Icon size={18} aria-hidden className="dialog__icon" />}
          <h2 id={titleId} className="dialog__title">{title}</h2>
          <IconButton icon={X} label="关闭" size="sm" onClick={onClose} />
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__footer">{footer}</footer>}
      </div>
    </div>
  );
}
