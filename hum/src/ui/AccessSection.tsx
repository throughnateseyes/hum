/**
 * The access code section, shared by the start screen (its bottom section) and the access overlay
 * (AccessGate), so the two always look and read the same.
 *
 * What it shows follows the server's answer (director/access.ts): a site that wants a code and has
 * none saved gets the field; a saved code gets one calm line with "Change code"; a site with no code
 * needed (running Hum yourself) gets one quiet line; a site with AI off explains how to run Hum
 * yourself. Without a code Hum still makes videos with its built-in director, and the copy says so.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { NATE_TWITTER_URL, submitCode, useAccessGate } from '../director/access';
import { Code, Info, Sparkle } from './Icons';

export const REPO = 'https://github.com/throughnateseyes/hum';

export const OFF_NOTE = 'Hum still makes videos here with its built-in director. To have Claude direct them, run Hum on your own computer:';

const WHAT_IT_DOES =
  'With a code, Claude directs the video for your song: it reads the song’s emotion and structure, picks a look for every part, and times the cuts and speed ramps to it. Without one, Hum still makes a video with its built-in director.';

/**
 * `inGate`: inside the overlay, which always shows the field (or the AI-off note), since it was opened
 * to enter a code. On the start screen the section picks its view from the server's answer.
 */
export function AccessSection({ inGate = false, fieldRef }: { inGate?: boolean; fieldRef?: RefObject<HTMLInputElement | null> }) {
  const need = useAccessGate((s) => s.need);
  const mode = useAccessGate((s) => s.mode);
  const saved = useAccessGate((s) => s.saved);
  // "Change code" on the start screen swaps the calm line for the field, right where it was
  const [changing, setChanging] = useState(false);

  if (inGate) return mode === 'off' ? <OffNote inGate /> : <CodeForm fieldRef={fieldRef} />;
  if (need === 'off') return <OffNote />;
  if (changing) return <CodeForm onDone={() => setChanging(false)} autoFocus />;
  if (saved) {
    return (
      <div className="wl-access acc-line">
        <Sparkle width={13} height={13} aria-hidden />
        <span>Claude is directing your videos.</span>
        <button type="button" className="acc-quiet" onClick={() => setChanging(true)}>
          Change code
        </button>
      </div>
    );
  }
  if (need === 'code') return <CodeForm />;
  if (need === 'open') {
    return (
      <div className="wl-access acc-line">
        <Sparkle width={13} height={13} aria-hidden />
        <span>Claude is directing your videos. No code needed here.</span>
      </div>
    );
  }
  // still asking the server: nothing yet, rather than a field that might vanish
  return null;
}

/** the label with its info button, the field and Unlock, the error, and who to ask for a code */
function CodeForm({ fieldRef, onDone, autoFocus }: { fieldRef?: RefObject<HTMLInputElement | null>; onDone?: () => void; autoFocus?: boolean }) {
  const error = useAccessGate((s) => s.error);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const own = useRef<HTMLInputElement>(null);
  const field = fieldRef ?? own;
  const id = useId();

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus, field]);

  // a wrong code: select it so typing replaces it
  useEffect(() => {
    if (error) field.current?.select();
  }, [error, field]);

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const ok = await submitCode(code);
    setBusy(false);
    if (ok) {
      setCode('');
      onDone?.();
    }
  };

  const typed = code.trim().length > 0;
  return (
    // keys typed here stay out of the app's shortcuts (space plays, and so on)
    <div className="wl-access" onKeyDown={(e) => e.stopPropagation()}>
      <div className="acc-head">
        <label className="acc-label" htmlFor={`${id}-code`}>
          Access code
        </label>
        <InfoButton />
      </div>
      <form className="acc-form" onSubmit={unlock}>
        <input
          ref={field}
          id={`${id}-code`}
          className="txt"
          type="text"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (error) useAccessGate.setState({ error: '' });
          }}
          placeholder="Paste your code"
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        {/* secondary until there's something to unlock with: "Choose a song" stays the one primary button */}
        <button className={`btn ${typed ? 'primary' : ''}`} type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
      {error && (
        <p id={`${id}-err`} className="acc-err" role="alert">
          {error}
        </p>
      )}
      <p className="acc-ask">
        Don’t have a code?{' '}
        {NATE_TWITTER_URL ? (
          <>
            Ask Nate on{' '}
            <a href={NATE_TWITTER_URL} target="_blank" rel="noopener noreferrer">
              Twitter
            </a>
            .
          </>
        ) : (
          'Ask Nate for one.'
        )}
        {onDone && (
          <>
            {' '}
            <button type="button" className="acc-quiet" onClick={onDone}>
              Keep the saved code
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/** the small "i" beside the label: a short note on what a code is for, opened by click or keyboard */
function InfoButton() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  // Esc, a click anywhere else, a scroll or a resize closes it. Window listeners in the capture phase,
  // registered after the overlay's own, so the overlay can leave Esc to this note while it's open.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // the note floats over the page (in a portal, since the island scrolls and the overlay's blur would
  // trap a fixed box): above the button when there's room, under it otherwise, kept inside the window
  useLayoutEffect(() => {
    const b = btn.current?.getBoundingClientRect();
    const el = pop.current;
    if (!open || !b || !el) return;
    const width = Math.min(300, window.innerWidth - 24);
    el.style.width = `${width}px`;
    const h = el.offsetHeight;
    const top = b.top - h - 8 >= 12 ? b.top - h - 8 : b.bottom + 8;
    el.style.left = `${Math.max(12, Math.min(b.left - 10, window.innerWidth - width - 12))}px`;
    el.style.top = `${top}px`;
    el.style.visibility = 'visible';
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="acc-info-btn"
        aria-label="What a code is for"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Info width={14} height={14} aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            className="acc-pop"
            id={id}
            role="note"
            // placed by the layout effect above, before the first paint
            style={{ left: 0, top: 0, visibility: 'hidden' }}
          >
            {WHAT_IT_DOES}
          </div>,
          document.body,
        )}
    </>
  );
}

/** AI is off on this site: Hum still works, and here is how to have Claude direct it yourself */
function OffNote({ inGate = false }: { inGate?: boolean }) {
  // the start screen keeps it to two lines and a link; the overlay (whose heading and lede already
  // say the first part) has room for the steps
  if (!inGate) {
    return (
      <div className="wl-access acc-off">
        <p className="acc-label">Claude is off on this site</p>
        <p className="acc-note">
          Hum still makes videos here with its built-in director. To have Claude direct them,{' '}
          <a href={REPO} target="_blank" rel="noopener noreferrer">
            run Hum yourself
          </a>
          .
        </p>
      </div>
    );
  }
  return (
    <div className="wl-access acc-off">
      <ol className="acc-steps">
        <li>Clone the repo from GitHub.</li>
        <li>
          In <code>hum/</code>, run <code>npm install</code>, then <code>npm run dev</code>.
        </li>
        <li>
          Be signed in to the Claude CLI (<code>claude</code>). Claude then runs on your own account, with no API key needed.
        </li>
      </ol>
      <a className="btn acc-gh" href={REPO} target="_blank" rel="noopener noreferrer">
        <Code width={14} height={14} aria-hidden />
        Hum on GitHub
      </a>
    </div>
  );
}
