/* 下拉菜单: the app's own select. A chip (or a form field) that opens a floating list drawn in the
   Firefly / SAM style — grouped options with a title, a second line and a right-hand note, a check on
   the current one, a filter box when the list is long. It replaces native <select> menus, which
   Windows draws as white boxes with unreadable group headers.

   Accessibility: the trigger is a button with aria-haspopup="listbox"; the open list is a listbox
   driven by aria-activedescendant (focus stays in the filter box or on the list). Arrow keys, Home /
   End, PageUp / PageDown, Enter / Space, Escape and Tab work as in a native select, and typing jumps
   to the first match when there is no filter box. */
import { Check, ChevronDown, Search, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './index';

export interface MenuOption<T extends string = string> {
  value: T;
  /** Main line, e.g. 「Claude Sonnet 5.5」. */
  label: string;
  /** Second line, e.g. the model id or a short description. */
  sub?: string;
  /** Small text on the right, e.g. 「1M 上下文」. */
  meta?: string;
  disabled?: boolean;
  icon?: LucideIcon;
}
export interface MenuGroup<T extends string = string> {
  /** Group title; omit for an untitled group. */
  label?: string;
  /** Small text next to the title. */
  hint?: string;
  options: Array<MenuOption<T>>;
}

export interface MenuSelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the control (also the filter box's label). */
  label: string;
  options?: Array<MenuOption<T>>;
  groups?: Array<MenuGroup<T>>;
  /** 'chip': a small pill for the message box; 'field': a full-width form control. */
  variant?: 'chip' | 'field';
  icon?: LucideIcon;
  /** Text on the closed control; defaults to the selected option's label. */
  display?: ReactNode;
  /** Shown on the closed control when nothing matches `value`. */
  placeholder?: string;
  title?: string;
  disabled?: boolean;
  /** Filter box: 'auto' shows it from 10 options up. */
  search?: boolean | 'auto';
  /** Extra content under the list (e.g. a link to settings). */
  footer?: ReactNode;
  className?: string;
  id?: string;
  /** Minimum width of the open list in px. */
  minWidth?: number;
}

const MARGIN = 8;
const GAP = 6;

export function MenuSelect<T extends string>({
  value, onChange, label, options, groups, variant = 'chip', icon: Icon, display, placeholder, title, disabled, search = 'auto', footer, className, id, minWidth = 240,
}: MenuSelectProps<T>) {
  const all = useMemo<Array<MenuGroup<T>>>(() => groups ?? [{ options: options ?? [] }], [groups, options]);
  const flat = useMemo(() => all.flatMap((g) => g.options), [all]);
  const current = flat.find((o) => o.value === value);
  const showSearch = search === true || (search === 'auto' && flat.length >= 10);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: '', at: 0 });
  /** The highlight follows the keyboard into view; a hovering pointer must not scroll the list, or the
      list would slide under a resting cursor and keep changing what is under it. */
  const follow = useRef(false);
  const base = useId();
  const listId = `${base}-list`;
  const optId = (i: number) => `${base}-o${i}`;

  // What the open list shows (filtered), as groups and as one flat run for keyboard moves.
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q
    ? all.map((g) => ({ ...g, options: g.options.filter((o) => `${o.label} ${o.sub ?? ''} ${o.meta ?? ''} ${g.label ?? ''}`.toLowerCase().includes(q)) })).filter((g) => g.options.length)
    : all), [all, q]);
  const shownFlat = useMemo(() => shown.flatMap((g) => g.options), [shown]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setQuery('');
    if (refocus) trigger.current?.focus();
  }, []);

  const openMenu = () => {
    if (disabled) return;
    const i = flat.findIndex((o) => o.value === value);
    follow.current = true;
    setActive(i >= 0 ? i : flat.findIndex((o) => !o.disabled));
    setOpen(true);
  };

  // Place the list under the control, or above it when there is more room there; keep it on screen.
  const place = useCallback(() => {
    const t = trigger.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    const down = below >= 320 || below >= above;
    const width = Math.max(r.width, minWidth);
    const popW = pop.current?.offsetWidth ?? width;
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - popW - MARGIN));
    setPos({
      left,
      minWidth: width,
      maxHeight: Math.max(160, down ? below : above),
      ...(down ? { top: r.bottom + GAP } : { bottom: window.innerHeight - r.top + GAP }),
    });
  }, [minWidth]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // Second pass once the list has its real width.
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    (showSearch ? input.current : list.current)?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || trigger.current?.contains(t)) return;
      close(false);
    };
    const onMove = (e: Event) => { if (!pop.current?.contains(e.target as Node)) place(); };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, showSearch, close, place]);

  // Filtering resets the highlight to the first match.
  useEffect(() => { if (open && q) { follow.current = true; setActive(shownFlat.findIndex((o) => !o.disabled)); } }, [q, open, shownFlat]);

  // Keep a keyboard-moved highlight in view, scrolling only the list itself.
  useEffect(() => {
    if (!open || active < 0 || !follow.current) return;
    const el = document.getElementById(optId(active));
    const box = list.current;
    if (!el || !box) return;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top + 4) box.scrollTop -= b.top + 4 - r.top;
    else if (r.bottom > b.bottom - 4) box.scrollTop += r.bottom - (b.bottom - 4);
  }, [active, open, shownFlat]);

  /** Tab out of the open list: hand focus back to the control first, so the browser moves on from there. */
  const leave = () => {
    trigger.current?.focus({ preventScroll: true });
    close(false);
  };

  const pick = (o: MenuOption<T> | undefined) => {
    if (!o || o.disabled) return;
    close();
    if (o.value !== value) onChange(o.value);
  };

  const move = (from: number, step: number) => {
    const n = shownFlat.length;
    if (!n) return -1;
    let i = from;
    for (let k = 0; k < n; k++) {
      i = Math.max(0, Math.min(n - 1, i + step));
      if (!shownFlat[i].disabled) return i;
      if ((step > 0 && i === n - 1) || (step < 0 && i === 0)) break;
    }
    return from;
  };

  const onListKey = (e: KeyboardEvent) => {
    follow.current = true;
    // The footer (e.g. 「管理模型接入」) is reached with Tab and works like any button.
    const inFoot = !!(e.target as HTMLElement).closest?.('.mselect-pop__foot');
    if (inFoot) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); (showSearch ? input.current : list.current)?.focus(); }
      else if (e.key === 'Tab') leave();
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      const first = pop.current?.querySelector<HTMLElement>('.mselect-pop__foot button, .mselect-pop__foot a[href]');
      if (first) { e.preventDefault(); first.focus(); return; }
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((a) => move(a, 1)); return;
      case 'ArrowUp': e.preventDefault(); setActive((a) => move(a < 0 ? shownFlat.length : a, -1)); return;
      case 'PageDown': e.preventDefault(); setActive((a) => move(a, 6)); return;
      case 'PageUp': e.preventDefault(); setActive((a) => move(a, -6)); return;
      case 'Home': if (showSearch) return; e.preventDefault(); setActive(move(-1, 1)); return;
      case 'End': if (showSearch) return; e.preventDefault(); setActive(move(shownFlat.length, -1)); return;
      case 'Enter': e.preventDefault(); pick(shownFlat[active]); return;
      case ' ': if (showSearch) return; e.preventDefault(); pick(shownFlat[active]); return;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); return;
      case 'Tab': leave(); return;
      default:
        // Type to jump (no filter box).
        if (!showSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now();
          typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key.toLowerCase(), at: now };
          const hit = shownFlat.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text));
          if (hit >= 0) setActive(hit);
        }
    }
  };

  const onTriggerKey = (e: KeyboardEvent) => {
    if (open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenu(); }
  };

  const shownText = display ?? current?.label ?? placeholder ?? '';
  let index = -1;

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        className={cx(variant === 'chip' ? 'pchip mselect-chip' : 'mselect-field', open && 'is-open', disabled && 'is-disabled', className)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}：${typeof shownText === 'string' ? shownText : current?.label ?? ''}`}
        title={title}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKey}
      >
        {Icon && <Icon size={variant === 'chip' ? 13 : 15} aria-hidden className="mselect__icon" />}
        <span className="mselect__text">{shownText}</span>
        <ChevronDown size={variant === 'chip' ? 12 : 14} aria-hidden className="mselect__chev" />
      </button>
      {open && createPortal(
        <div ref={pop} className="mselect-pop" style={pos} onKeyDown={onListKey}>
          {showSearch && (
            <div className="mselect-pop__search">
              <Search size={13} aria-hidden />
              <input
                ref={input}
                type="text"
                value={query}
                placeholder="搜索…"
                aria-label={`在「${label}」中搜索`}
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={active >= 0 ? optId(active) : undefined}
                aria-autocomplete="list"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          <div
            ref={list}
            id={listId}
            className="mselect-pop__list"
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            aria-activedescendant={!showSearch && active >= 0 ? optId(active) : undefined}
          >
            {shownFlat.length === 0 && <p className="mselect-pop__empty">没有匹配的选项</p>}
            {shown.map((g, gi) => (
              <div key={`${g.label ?? ''}-${gi}`} role="group" aria-label={g.label} className="mselect-group">
                {g.label && (
                  <p className="mselect-group__label" aria-hidden>
                    <span>{g.label}</span>
                    {g.hint && <small>{g.hint}</small>}
                  </p>
                )}
                {g.options.map((o) => {
                  index += 1;
                  const i = index;
                  const selected = o.value === value;
                  const OIcon = o.icon;
                  return (
                    <div
                      key={o.value}
                      id={optId(i)}
                      role="option"
                      aria-selected={selected}
                      aria-disabled={o.disabled || undefined}
                      className={cx('mselect-opt', selected && 'is-selected', i === active && 'is-active', o.disabled && 'is-disabled')}
                      onPointerMove={() => { follow.current = false; if (!o.disabled && active !== i) setActive(i); }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(o)}
                    >
                      <span className="mselect-opt__check" aria-hidden>{selected ? <Check size={14} /> : OIcon ? <OIcon size={14} /> : null}</span>
                      <span className="mselect-opt__text">
                        <span className="mselect-opt__label">{o.label}</span>
                        {o.sub && <span className="mselect-opt__sub">{o.sub}</span>}
                      </span>
                      {o.meta && <span className="mselect-opt__meta">{o.meta}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {footer && <div className="mselect-pop__foot">{footer}</div>}
        </div>,
        document.body,
      )}
    </>
  );
}
