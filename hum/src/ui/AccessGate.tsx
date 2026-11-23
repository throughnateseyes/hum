import { useEffect, useRef } from 'react';
import { dismissGate, useAccessGate } from '../director/access';
import { AccessSection, OFF_NOTE } from './AccessSection';
import { X } from './Icons';

/**
 * Asks for an access code when an AI action needs one (then that action retries), or explains that
 * AI is off on this site and how to run Hum yourself. It is the start screen's island again, over the
 * same veiled stage, with the same access section (AccessSection), so the two never drift apart.
 * State and the call path live in director/access.ts; the server stays the real check.
 */
export function AccessGate() {
  const open = useAccessGate((s) => s.open);
  const mode = useAccessGate((s) => s.mode);
  const pending = useAccessGate((s) => s.pending);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  // remember where focus was, and put it back when the gate closes
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus?.();
  }, [open]);

  // focus starts in the field, or the dialog itself when there's no field (AI off). Runs again when
  // the contents change (a code check that finds AI off swaps the field away), so focus never falls
  // out to the page.
  useEffect(() => {
    if (!open) return;
    (field.current ?? box.current)?.focus();
  }, [open, mode]);

  // Esc and the Tab trap work wherever focus is, so a window listener (capture: before the app's own)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const el = box.current;
      if (!el) return;
      const inside = el.contains(document.activeElement);
      if (e.key === 'Escape') {
        // the info note is open: its own listener closes it, and the overlay stays
        if (document.querySelector('.acc-pop')) return;
        e.preventDefault();
        e.stopPropagation();
        dismissGate();
      } else if (e.key === 'Tab') {
        const items = [...el.querySelectorAll<HTMLElement>('input, button, a[href]')].filter((x) => !x.hasAttribute('disabled'));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const at = document.activeElement;
        if (!inside || (e.shiftKey && (at === first || at === el)) || (!e.shiftKey && at === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      } else if (!inside) {
        // focus somewhere outside the dialog: keep the app's shortcuts (space = play…) from firing
        e.stopPropagation();
        el.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!open) return null;

  // keys typed inside the dialog stay out of the app's shortcuts (Esc and Tab are handled above)
  const onKeyDown = (e: React.KeyboardEvent) => e.stopPropagation();

  const off = mode === 'off';
  return (
    <div className="gate-scrim" onMouseDown={(e) => e.target === e.currentTarget && dismissGate()} onKeyDown={onKeyDown}>
      <div className="welcome wl-gate" role="dialog" aria-modal="true" aria-labelledby="gate-title" aria-describedby="gate-desc" ref={box} tabIndex={-1}>
        <button className="btn icon sm ghost gate-x" onClick={dismissGate} aria-label="Close">
          <X width={14} height={14} />
        </button>
        <h2 className="wl-title" id="gate-title">
          {off ? 'Claude is off on this site' : 'Let Claude direct your video'}
        </h2>
        <p className="wl-lede" id="gate-desc">
          {off
            ? OFF_NOTE
            : pending
              ? 'Put in your access code and your video carries on from here, directed by Claude.'
              : 'Put in your access code. It stays saved in this browser.'}
        </p>
        <AccessSection inGate fieldRef={field} />
        <button className="gate-skip" type="button" onClick={dismissGate}>
          {off ? 'Close' : pending ? 'Continue without AI' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
