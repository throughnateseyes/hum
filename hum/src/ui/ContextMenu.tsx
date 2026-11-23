/**
 * A right-click menu: plain rows, each with a short hint of what it does and its keyboard shortcut when
 * there is one, separators, a quiet title row, ticks for the current choice, and one level of submenus.
 * It opens where the pointer is (kept inside the window), takes the keyboard (arrows move, → opens a
 * submenu, ← closes it, Enter picks, Esc closes) and closes on a pick, a click outside, Esc, scrolling
 * or the window losing focus. Used by the timeline (Timeline.tsx); nothing in it is timeline-specific.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './timeline.css';

export type MenuItem =
  | {
      kind?: 'item';
      label: string;
      /** what it does, in a few plain words */
      hint?: string;
      /** its keyboard shortcut ('⌘J', 'C') */
      shortcut?: string;
      disabled?: boolean;
      /** a choice in a set: true ticked, false not; undefined for plain actions */
      checked?: boolean;
      onSelect?: () => void;
      submenu?: MenuItem[];
    }
  | { kind: 'sep' }
  | { kind: 'label'; label: string };

/** ⌘ on a Mac, Ctrl elsewhere, for showing shortcuts */
export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

export function ContextMenu({ x, y, items, label, onClose }: { x: number; y: number; items: MenuItem[]; label: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // keep it inside the window: open up and to the left when there's no room below or to the right
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = x + r.width + 8 > window.innerWidth ? Math.max(8, x - r.width) : x;
    const top = y + r.height + 8 > window.innerHeight ? Math.max(8, y - r.height) : y;
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const away = () => onClose();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', away);
    window.addEventListener('resize', away);
    window.addEventListener('wheel', away, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('resize', away);
      window.removeEventListener('wheel', away);
    };
  }, [onClose]);

  // the keyboard starts on the first row it can use
  useEffect(() => {
    if (pos) box.current?.querySelector<HTMLElement>('.cm-item:not([disabled])')?.focus({ preventScroll: true });
  }, [pos]);

  return createPortal(
    <div
      ref={box}
      className="cm"
      style={pos ? { left: pos.left, top: pos.top } : { left: x, top: y, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuList items={items} label={label} onClose={onClose} />
    </div>,
    document.body,
  );
}

function MenuList({ items, label, onClose, onBack }: { items: MenuItem[]; label: string; onClose: () => void; onBack?: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const rows = () => [...(list.current?.querySelectorAll<HTMLElement>(':scope > .cm-row > .cm-item:not([disabled])') ?? [])];
  const onKey = (e: React.KeyboardEvent) => {
    const own = rows();
    const at = own.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return; // the key belongs to a submenu inside
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const n = own.length;
      own[(at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]?.focus();
    } else if (e.key === 'ArrowLeft' && onBack) {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      own[e.key === 'Home' ? 0 : own.length - 1]?.focus();
    }
  };

  return (
    <div ref={list} className="cm-list" role="menu" aria-label={label} onKeyDown={onKey}>
      {items.map((it, k) => {
        if (it.kind === 'sep') return <div key={k} className="cm-sep" role="separator" />;
        if (it.kind === 'label') {
          return (
            <div key={k} className="cm-label" role="presentation">
              {it.label}
            </div>
          );
        }
        const sub = it.submenu;
        const choice = it.checked !== undefined;
        return (
          <div key={k} className="cm-row" onPointerEnter={() => setOpen(sub && !it.disabled ? k : null)} onPointerLeave={() => sub && setOpen((o) => (o === k ? null : o))}>
            <button
              className={`cm-item ${open === k ? 'open' : ''}`}
              role={choice ? 'menuitemradio' : 'menuitem'}
              aria-checked={choice ? it.checked : undefined}
              aria-haspopup={sub ? 'menu' : undefined}
              aria-expanded={sub ? open === k : undefined}
              disabled={it.disabled}
              onClick={() => {
                if (sub) {
                  setOpen(open === k ? null : k);
                  return;
                }
                onClose();
                it.onSelect?.();
              }}
              onKeyDown={(e) => {
                if (sub && e.key === 'ArrowRight') {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(k);
                  requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`.cm-row:nth-child(${k + 1}) .cm-sub .cm-item:not([disabled])`)?.focus());
                }
              }}
            >
              <span className="cm-tick" aria-hidden>
                {it.checked ? <Tick /> : null}
              </span>
              <span className="cm-text">
                <span className="cm-l">{it.label}</span>
                {it.hint && <span className="cm-h">{it.hint}</span>}
              </span>
              {it.shortcut && <kbd className="cm-k">{it.shortcut}</kbd>}
              {sub && <span className="cm-more" aria-hidden>›</span>}
            </button>
            {sub && open === k && (
              <div className="cm-sub">
                <MenuList
                  items={sub}
                  label={it.label}
                  onClose={onClose}
                  onBack={() => {
                    setOpen(null);
                    list.current?.querySelector<HTMLElement>(`.cm-row:nth-child(${k + 1}) > .cm-item`)?.focus();
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Tick() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
