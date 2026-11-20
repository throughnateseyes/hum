/**
 * Moods: a one-tap row under the song map that re-plans the whole video inside one world (Brutal,
 * Dreamy, Hacker…; presets/moods.ts). The mood the playing video was planned in is lit; tapping it
 * again makes a fresh take in the same world, Any lets Hum pick the world from the song. When the
 * person has changed parts by hand, it asks whether to keep those changes first.
 *
 * MoodChips is the same set as a small filter (the part sheet's look list).
 */
import { useEffect, useRef, useState } from 'react';
import { MOODS, moodCover, type MoodId } from '../presets/moods';
import { listNames, makeVideo, partEdits, sectionNames, validPlan } from '../state/plan';
import { useStudio } from '../state/store';
import { STATIC_THUMBS } from './Library';
import './partSheet.css';

const cover = (id: MoodId) => {
  const p = moodCover(MOODS.find((m) => m.id === id)!);
  return p ? STATIC_THUMBS[p.id] : undefined;
};

export function MoodRow() {
  const analysis = useStudio((s) => s.analysis);
  const plan = useStudio((s) => s.plan);
  const partPops = useStudio((s) => s.partPops);
  const planning = useStudio((s) => s.planning);
  const busy = useStudio((s) => !!s.clip);
  // the mood waiting on "keep your changes?" (null: Any)
  const [ask, setAsk] = useState<{ mood: MoodId | null } | null>(null);
  const keepBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (ask) keepBtn.current?.focus();
  }, [ask]);
  useEffect(() => setAsk(null), [analysis]);
  if (!analysis?.sections.length) return null;
  const hasPlan = validPlan(plan, analysis);
  const active = hasPlan ? (plan.mood ?? null) : undefined;
  const edited = hasPlan ? partEdits(plan, analysis, partPops).flatMap((e, i) => (e ? [i] : [])) : [];
  const names = sectionNames(analysis.sections);

  const go = (mood: MoodId | null, keepEdits: boolean) => {
    setAsk(null);
    void makeVideo('', { fresh: hasPlan, mood, keepEdits });
  };
  const pick = (mood: MoodId | null) => {
    if (planning || busy) return;
    if (edited.length) setAsk({ mood });
    else go(mood, true);
  };
  const askName = ask ? (ask.mood ? MOODS.find((m) => m.id === ask.mood)!.name : 'Any mood') : '';

  return (
    <div className="moods" role="group" aria-label="Mood for the whole video">
      <span className="moods-l" title="One tap re-plans the whole video inside one world, so every part belongs to the same video.">
        Mood
      </span>
      {ask ? (
        <div className="moods-ask" role="alertdialog" aria-label={`${askName}: keep your changes?`} onKeyDown={(e) => e.key === 'Escape' && setAsk(null)}>
          <span>
            <b>{askName}</b> · keep your changes to {listNames(edited.map((i) => names[i]))}?
          </span>
          <button ref={keepBtn} className="btn sm primary" onClick={() => go(ask.mood, true)} title="Re-plan the rest, keep the parts you changed as you set them">
            Keep them
          </button>
          <button className="btn sm" onClick={() => go(ask.mood, false)} title="Re-plan every part, including the ones you changed">
            Start fresh
          </button>
          <button className="btn sm ghost" onClick={() => setAsk(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="moods-row">
          <button
            className={`mood ${hasPlan && active === null ? 'on' : ''}`}
            aria-pressed={hasPlan && active === null}
            disabled={planning || busy}
            title="No mood: Hum picks one world from the song itself"
            onClick={() => pick(null)}
          >
            Any
          </button>
          {MOODS.map((m) => {
            const on = active === m.id;
            const url = cover(m.id);
            return (
              <button
                key={m.id}
                className={`mood ${on ? 'on' : ''}`}
                aria-pressed={on}
                disabled={planning || busy}
                title={`${m.tip} ${on ? 'Tap again for a fresh take in this mood.' : 'One tap re-plans the whole video in this world.'}`}
                onClick={() => pick(m.id)}
              >
                {url && <img src={url} alt="" />}
                {m.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** the moods as a filter: All, then one chip per mood */
export function MoodChips({ value, onChange, label = 'Filter by mood' }: { value: MoodId | 'all'; onChange: (v: MoodId | 'all') => void; label?: string }) {
  return (
    <div className="mood-chips" role="group" aria-label={label}>
      <button className={`chip ${value === 'all' ? 'on' : ''}`} aria-pressed={value === 'all'} onClick={() => onChange('all')} title="Looks from every world">
        All
      </button>
      {MOODS.map((m) => (
        <button key={m.id} className={`chip ${value === m.id ? 'on' : ''}`} aria-pressed={value === m.id} onClick={() => onChange(m.id)} title={m.tip}>
          {m.name}
        </button>
      ))}
    </div>
  );
}
