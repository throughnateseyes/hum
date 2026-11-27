import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FINISHES, type FinishId } from '../core/direction';
import { activeFinish, setFinish } from '../state/direction';
import { useStudio } from '../state/store';

type Pick = 'auto' | FinishId;

/** a small mark for each finish, drawn in the ink colour, so the tiles read at a glance */
const MARKS: Record<Pick, ReactNode> = {
  auto: <path d="M10 3.5l1.4 3.6 3.6 1.4-3.6 1.4L10 13.5l-1.4-3.6L5 8.5l3.6-1.4zM4.5 13l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z" fill="currentColor" stroke="none" />,
  clean: <rect x="4" y="4" width="12" height="12" rx="2" />,
  hand: <path d="M3.5 12.5c1.6-4 3.2-6 4.6-5.6 1.6.5-.9 5.4.8 5.9 1.5.4 2.6-4.6 4.3-4.3 1.2.2 1 2.6 3.3 2.5" />,
  film: (
    <>
      <rect x="3.5" y="4" width="13" height="12" rx="1.5" />
      <path d="M6.5 4v12M13.5 4v12M3.5 7.5h3M3.5 12.5h3M13.5 7.5h3M13.5 12.5h3" />
    </>
  ),
  riso: (
    <>
      <circle cx="8" cy="10" r="4.2" />
      <circle cx="12" cy="10" r="4.2" strokeDasharray="1.6 1.4" />
    </>
  ),
  ink: <path d="M10 3.5c2.5 3.4 4.5 6 4.5 8.3a4.5 4.5 0 01-9 0c0-2.3 2-4.9 4.5-8.3z" />,
  tape: (
    <>
      <rect x="3" y="5" width="14" height="10" rx="1.5" />
      <circle cx="7.5" cy="10" r="1.6" />
      <circle cx="12.5" cy="10" r="1.6" />
      <path d="M6 15l1.2-2h5.6L14 15" />
    </>
  ),
};

const TILES: { v: Pick; label: string; tip: string }[] = [
  { v: 'auto', label: 'Auto', tip: 'Each video picks the finish that fits the song.' },
  ...(['clean', 'hand', 'film', 'riso', 'ink', 'tape'] as FinishId[]).map((id) => {
    const f = FINISHES.find((x) => x.id === id)!;
    return { v: f.id as Pick, label: f.name, tip: f.tip };
  }),
];

export const finishTip = (v: Pick) => TILES.find((t) => t.v === v)?.tip ?? '';

/**
 * The finishes as tiles. Resting on one tries it on the video playing (state finishPreview, which
 * activeFinish reads); moving off puts the picked one back; a click keeps it. The tile under the pointer is
 * reported (onTry) so the line under the tiles can say what it is.
 */
export function FinishTiles({ onTry }: { onTry: (v: Pick | null) => void }) {
  const finish = useStudio((s) => s.finish);
  const busy = useStudio((s) => !!s.clip);
  const wait = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [tried, setTried] = useState<Pick | null>(null);
  const clear = () => {
    clearTimeout(wait.current);
    setTried(null);
    onTry(null);
    if (useStudio.getState().finishPreview !== null) useStudio.getState().set({ finishPreview: null });
  };
  // a pointer passing over tries nothing on; resting a moment does
  const rest = (v: Pick) => {
    clearTimeout(wait.current);
    onTry(v);
    // the one already drawing has nothing to show (Hand-drawn on a look that keeps clean does: it tries it on)
    const s = useStudio.getState();
    if (v === finish && (v === 'auto' || activeFinish({ ...s, finishPreview: null }) === v)) {
      setTried(null);
      if (useStudio.getState().finishPreview !== null) useStudio.getState().set({ finishPreview: null });
      return;
    }
    wait.current = setTimeout(() => {
      setTried(v);
      useStudio.getState().set({ finishPreview: v });
    }, 150);
  };
  // whatever was tried on goes when the tiles do (another tab, a render starting)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => clear, []);
  useEffect(() => {
    if (busy) clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  return (
    <div className="fin-tiles" role="radiogroup" aria-label="Finish" onMouseLeave={clear}>
      {TILES.map((t) => {
        const on = finish === t.v;
        return (
          <button
            key={t.v}
            type="button"
            role="radio"
            aria-checked={on}
            className={`fin-tile ${on ? 'on' : ''} ${tried === t.v ? 'trying' : ''}`}
            disabled={busy}
            onMouseEnter={() => rest(t.v)}
            onFocus={(e) => e.currentTarget.matches(':focus-visible') && rest(t.v)}
            onBlur={clear}
            onClick={() => {
              clearTimeout(wait.current);
              setFinish(t.v);
              setTried(null);
              useStudio.getState().set({ finishPreview: null });
            }}
          >
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {MARKS[t.v]}
            </svg>
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
