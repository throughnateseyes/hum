/**
 * Which of the person's clips and photos a shot shows (store.partShot[i].media, or store.soloShot.media
 * for a look playing on its own), at the top of the Picture group (FootagePicture.tsx).
 *
 *   in use          the chosen pictures, large, in order; "Add another" after them puts one more in
 *   your pictures   every clip and photo as a tile: click to use only that one, Cmd-click (or after
 *                   "Add another") to add it, click a used one with Cmd to take it out
 *   Automatic       the look deals them itself, as before
 *
 * Also the note a drop or a "Use" leaves (MediaNote), with its one-click offer when the look can't show
 * the picture (footageMedia.ts giveMedia).
 */
import { useState } from 'react';
import { hideMediaNote, useMediaNote, type MediaItem } from './footageMedia';

/** tiles shown before "Show all": two rows in the panel */
const FOLDED = 8;

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/**
 * `value` is the shots' common media (null: automatic, 'mixed': they differ). `onChange(null)` goes
 * back to automatic. `several` says what more than one picture does in this shot.
 */
export function MediaPicker({
  media,
  value,
  onChange,
  disabled,
  scope,
  several,
  photosOnly,
}: {
  media: MediaItem[];
  value: string[] | null | 'mixed';
  onChange: (ids: string[] | null) => void;
  disabled?: boolean;
  scope: string;
  several: string;
  photosOnly?: boolean;
}) {
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const chosen = value === 'mixed' || !value ? [] : value.filter((id) => media.some((m) => m.id === id));
  const items = chosen.map((id) => media.find((m) => m.id === id)!);
  const shown = all ? media : media.slice(0, FOLDED);
  const thing = photosOnly ? 'photo' : 'picture';
  const pick = (id: string, add: boolean) => {
    setAdding(false);
    if (!add) return onChange([id]);
    const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
    onChange(next.length ? next : null);
  };
  const drop = (id: string) => {
    const next = chosen.filter((x) => x !== id);
    onChange(next.length ? next : null);
  };
  return (
    <div className="mp" role="group" aria-label={`Which ${thing} plays in ${scope}`}>
      {/* what plays now, large */}
      <div className="mp-now">
        {items.length ? (
          items.map((m, k) => (
            <div key={m.id} className="mp-big on" title={`${m.name}${m.kind === 'clip' ? `, clip, ${clock(m.duration ?? 0)}` : ', photo'}`}>
              {m.thumb ? <img src={m.thumb} alt="" draggable={false} /> : <span className="mp-blank" />}
              {m.kind === 'clip' && <i className="mp-kind" aria-hidden />}
              {items.length > 1 && <b className="mp-tick">{k + 1}</b>}
              <span className="mp-name">{m.name}</span>
              {items.length > 1 && (
                <button type="button" className="mp-x" disabled={disabled} aria-label={`Take ${m.name} out`} title="Take this one out" onClick={() => drop(m.id)}>
                  ×
                </button>
              )}
            </div>
          ))
        ) : (
          <div className={`mp-big auto ${value === null ? 'on' : ''}`} title={`The look deals your ${photosOnly ? 'photos' : 'clips and photos'} itself`}>
            {media[0]?.thumb ? <img src={media[0].thumb} alt="" draggable={false} /> : <span className="mp-blank" />}
            <span className="mp-name">{value === 'mixed' ? 'Different in each part' : 'Automatic'}</span>
          </div>
        )}
        {media.length > chosen.length && (
          <button
            type="button"
            className={`mp-big mp-add ${adding ? 'on' : ''}`}
            disabled={disabled}
            aria-pressed={adding}
            title={adding ? 'Now click a picture below to add it' : `Put another ${thing} in ${scope} (or ⌘-click one below)`}
            onClick={() => setAdding(!adding)}
          >
            <span aria-hidden>+</span>
            {adding ? 'Pick one below' : chosen.length ? 'Add another' : `Pick ${thing}s`}
          </button>
        )}
      </div>
      <p className="pp-note mp-line">
        {adding
          ? `Click a ${thing} to add it. ${several}`
          : chosen.length > 1
            ? several
            : chosen.length
              ? `One ${thing} in ${scope}. Add another to use several.`
              : `Click a ${thing} to use it in ${scope}. ⌘-click to use several.`}
      </p>

      {/* every clip and photo */}
      <div className="mp-row">
        {shown.map((m) => {
          const k = chosen.indexOf(m.id);
          const on = k >= 0;
          return (
            <button
              key={m.id}
              type="button"
              className={`mp-tile ${on ? 'on' : ''} ${adding && !on ? 'adding' : ''}`}
              aria-pressed={on}
              aria-label={`${m.name}, ${m.kind}${on ? ', in use' : ''}`}
              disabled={disabled}
              title={`${m.name} (${m.kind === 'clip' ? `clip, ${clock(m.duration ?? 0)}` : 'photo'}). Click to use only this. ⌘-click to add it.`}
              onClick={(e) => pick(m.id, adding || e.metaKey || e.ctrlKey)}
            >
              {m.thumb ? <img src={m.thumb} alt="" draggable={false} /> : <span className="mp-blank" />}
              {m.kind === 'clip' && <i className="mp-kind" aria-hidden />}
              {on && <b className="mp-tick">{chosen.length > 1 ? k + 1 : <Tick />}</b>}
            </button>
          );
        })}
      </div>
      <div className="mp-foot">
        {media.length > FOLDED && (
          <button type="button" className="pp-link" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${media.length}`}
          </button>
        )}
        {value !== null && (
          <button type="button" className="pp-link" disabled={disabled} onClick={() => onChange(null)} title={`Let the look deal your ${photosOnly ? 'photos' : 'clips and photos'} to ${scope}`}>
            Back to automatic
          </button>
        )}
      </div>
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

/** the short note after a picture is given by a drop or a "Use", with its one-click offer */
export function MediaNote() {
  const note = useMediaNote((s) => s.note);
  if (!note) return null;
  return (
    <div className="media-note" key={note.key} role="status" aria-live="polite">
      <span>{note.text}</span>
      {note.offer && (
        <button
          type="button"
          className="btn sm primary"
          onClick={() => {
            note.offer!.run();
          }}
        >
          {note.offer.label}
        </button>
      )}
      <button type="button" className="btn icon sm ghost" aria-label="Close" onClick={hideMediaNote}>
        ×
      </button>
    </div>
  );
}
