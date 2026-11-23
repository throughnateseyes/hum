/**
 * Which of the person's clips and photos a footage part shows (store.partShot[i].media), as a compact
 * row of thumbnails in the Part tab's Picture group (FootagePicture.tsx).
 *
 *   click            this one only
 *   Cmd/Ctrl-click   add it (or take it out again): for styles and treatments that use several
 *   Automatic        the part's media dealt by the look, as before
 *
 * A long library wraps to two rows with "Show all" for the rest, so the panel stays short.
 */
import { useState } from 'react';
import type { MediaItem } from './footageMedia';

/** tiles shown before "Show all": with Automatic, two rows in the panel */
const FOLDED = 9;

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/**
 * The row of thumbnails. `value` is the parts' common media (null: automatic, 'mixed': they differ).
 * `onChange(null)` goes back to automatic.
 */
export function MediaPicker({ media, value, onChange, disabled, label }: { media: MediaItem[]; value: string[] | null | 'mixed'; onChange: (ids: string[] | null) => void; disabled?: boolean; label: string }) {
  const [all, setAll] = useState(false);
  const chosen = value === 'mixed' || !value ? [] : value.filter((id) => media.some((m) => m.id === id));
  // a picked tile past the fold stays in view
  const lastPicked = Math.max(-1, ...chosen.map((id) => media.findIndex((m) => m.id === id)));
  const fold = Math.max(FOLDED, lastPicked + 1);
  const shown = all ? media : media.slice(0, fold);
  const pick = (id: string, add: boolean) => {
    if (!add) return onChange([id]);
    const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
    onChange(next.length ? next : null);
  };
  return (
    <div className="mp" role="group" aria-label={label}>
      <div className="mp-row">
        <button
          type="button"
          className={`mp-auto ${value === null ? 'on' : ''}`}
          aria-pressed={value === null}
          disabled={disabled}
          onClick={() => onChange(null)}
          title="Let the look deal your clips and photos to this part"
        >
          Automatic
        </button>
        {shown.map((m) => {
          const k = chosen.indexOf(m.id);
          const on = k >= 0;
          return (
            <button
              key={m.id}
              type="button"
              className={`mp-tile ${on ? 'on' : ''}`}
              aria-pressed={on}
              aria-label={`${m.name}, ${m.kind}${on ? ', in use' : ''}`}
              disabled={disabled}
              title={`${m.name} (${m.kind === 'clip' ? `clip, ${clock(m.duration ?? 0)}` : 'photo'}). Click to use only this. ⌘-click to add it.`}
              onClick={(e) => pick(m.id, e.metaKey || e.ctrlKey)}
            >
              {m.thumb ? <img src={m.thumb} alt="" draggable={false} /> : <span className="mp-blank" />}
              {m.kind === 'clip' && <i className="mp-kind" aria-hidden />}
              {on && <b className="mp-tick">{chosen.length > 1 ? k + 1 : <Tick />}</b>}
            </button>
          );
        })}
      </div>
      {media.length > fold && (
        <button type="button" className="pp-link" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${media.length}`}
        </button>
      )}
    </div>
  );
}

function Tick() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
      <path d="M2 5.2l2 2L8 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
