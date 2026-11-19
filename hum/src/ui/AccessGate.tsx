import { useEffect, useRef, useState } from 'react';
import { dismissGate, submitCode, useAccessGate } from '../director/access';
import { Code, X } from './Icons';

const REPO = 'https://github.com/throughnateseyes/hum';

/**
 * Asks for an access code when an AI action needs one (then that action retries), or explains that
 * AI is off on this site. Either way it shows how to run Hum yourself with your own Claude.
 * State and the call path live in director/access.ts; the server stays the real check.
 */
export function AccessGate() {
  const open = useAccessGate((s) => s.open);
  const mode = useAccessGate((s) => s.mode);
  const error = useAccessGate((s) => s.error);
  const pending = useAccessGate((s) => s.pending);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  // remember where focus was, and put it back when the gate closes
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    setCode('');
    setBusy(false);
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

  // a wrong code: select it so typing replaces it
  useEffect(() => {
    if (error) field.current?.select();
  }, [error]);

  if (!open) return null;

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    await submitCode(code);
    setBusy(false);
  };

  // keys typed inside the dialog stay out of the app's shortcuts (Esc and Tab are handled above)
  const onKeyDown = (e: React.KeyboardEvent) => e.stopPropagation();

  const off = mode === 'off';
  return (
    <div className="gate-scrim" onMouseDown={(e) => e.target === e.currentTarget && dismissGate()} onKeyDown={onKeyDown}>
      <div className="gate" role="dialog" aria-modal="true" aria-labelledby="gate-title" aria-describedby="gate-desc" ref={box} tabIndex={-1}>
        <button className="btn icon sm ghost gate-x" onClick={dismissGate} aria-label="Close">
          <X width={14} height={14} />
        </button>

        {off ? (
          <>
            <h2 id="gate-title">AI is off on this site</h2>
            <p id="gate-desc" className="gate-lede">
              Everything else still works here: the looks, the offline video planner, recording. To have Claude plan videos and write looks, run Hum on your own computer.
            </p>
          </>
        ) : (
          <>
            <h2 id="gate-title">Enter your access code</h2>
            <p id="gate-desc" className="gate-lede">
              The AI director on this site is invite-only. {pending ? 'If you were given a code, put it in and your request will carry on.' : 'If you were given a code, put it in here.'}
            </p>
            <form className="gate-form" onSubmit={unlock}>
              <input
                ref={field}
                className="txt"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Access code"
                aria-label="Access code"
                aria-invalid={!!error}
                aria-describedby={error ? 'gate-err' : undefined}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <button className="btn primary" type="submit" disabled={busy}>
                {busy ? 'Checking…' : 'Unlock'}
              </button>
            </form>
            {error && (
              <p id="gate-err" className="gate-err" role="alert">
                {error}
              </p>
            )}
            <button className="gate-skip" type="button" onClick={dismissGate}>
              {pending ? 'Continue without AI' : 'Cancel'}
            </button>
          </>
        )}

        <section className={`gate-diy ${off ? 'solo' : ''}`} aria-labelledby="gate-diy-title">
          <h3 id="gate-diy-title">Run Hum yourself</h3>
          <ol>
            <li>Clone the repo from GitHub.</li>
            <li>
              In <code>hum/</code>, run <code>npm install</code>, then <code>npm run dev</code>.
            </li>
            <li>
              Be signed in to the Claude CLI (<code>claude</code>). The AI then runs on your own Claude account, with no API key needed.
            </li>
          </ol>
          <a className="btn gate-gh" href={REPO} target="_blank" rel="noopener noreferrer">
            <Code width={14} height={14} />
            Hum on GitHub
          </a>
        </section>
      </div>
    </div>
  );
}
