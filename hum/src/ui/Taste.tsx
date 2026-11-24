/**
 * Taste memory UI: Keep / Skip on the stage (K / X), and the "Your taste" panel in the Look tab that
 * says in plain words what Hum has learned, with a learning switch and a reset.
 */
import { useEffect, useRef, useState } from 'react';
import { lookShows } from '../director/footage';
import { PRESETS } from '../presets';
import { getScene } from '../scenes';
import { live } from '../state/live';
import { findLook, LABEL_NAME, skipLook } from '../state/plan';
import { useStudio } from '../state/store';
import { labelNow, pickByTaste, record, resetTaste, setLearning, tasteLines, useTaste } from '../state/taste';
import { transitionForNow } from '../state/transitionPick';
import { Section, Toggle } from './controls';
import { X } from './Icons';

const Heart = (p: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M12 20s-7-4.4-9.2-8.7C1.3 8.2 3 4.8 6.4 4.4c2-.2 3.6.9 4.6 2.5 1-1.6 2.6-2.7 4.6-2.5 3.4.4 5.1 3.8 3.6 6.9C19 15.6 12 20 12 20z" />
  </svg>
);

/** remember the look on screen as one the person likes here */
export function keepNow() {
  const s = useStudio.getState();
  const look = findLook(s.presetId);
  if (!look) return;
  const label = labelNow();
  record('keep', look.id, label);
  s.flash(useTaste.getState().on ? `Kept “${look.name}”${label ? ` for ${LABEL_NAME[label].toLowerCase()}s` : ''}` : 'Learning is off (Look tab → Your taste)');
}

/** remember the look on screen as one to avoid here, and move on to another */
export function skipNow() {
  const s = useStudio.getState();
  const look = findLook(s.presetId);
  if (!look) return;
  if (!skipLook()) {
    // no plan playing: pick the next look by taste from the song's suggestions (or everything)
    const suggested = (s.analysis?.suggestedPresets ?? []).map((id) => findLook(id)).filter((p) => !!p);
    const pool = [...suggested, ...PRESETS].filter((p, i, xs) => xs.indexOf(p) === i && p.id !== look.id && !p.sceneId.startsWith('board-') && getScene(p.sceneId) && lookShows(p));
    const next = pickByTaste(pool.slice(0, 14));
    if (next) {
      if (live.stage) live.stage.nextTransition = transitionForNow('auto', null);
      s.applyPreset(next);
    }
  }
  if (!useTaste.getState().on) s.flash('Skipped (learning is off)');
}

/** two small buttons in the corner of the stage, shown on hover */
export function TasteHud() {
  const track = useStudio((s) => s.track);
  const presetId = useStudio((s) => s.presetId);
  const [pulse, setPulse] = useState<'keep' | 'skip' | null>(null);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  if (!track || !presetId) return null;
  const go = (k: 'keep' | 'skip') => {
    if (k === 'keep') keepNow();
    else skipNow();
    setPulse(k);
    clearTimeout(t.current);
    t.current = setTimeout(() => setPulse(null), 500);
  };
  return (
    <div className="taste-hud">
      <button className={`taste-btn keep ${pulse === 'keep' ? 'pulse' : ''}`} title="Keep: more looks like this here (K)" aria-label="Keep this look" onClick={() => go('keep')}>
        <Heart width={14} height={14} />
      </button>
      <button className={`taste-btn skip ${pulse === 'skip' ? 'pulse' : ''}`} title="Skip: show something else, and less of this here (X)" aria-label="Skip this look" onClick={() => go('skip')}>
        <X width={13} height={13} />
      </button>
    </div>
  );
}

/** "Your taste" in the Look tab */
export function TasteGroup() {
  const on = useTaste((s) => s.on);
  const reactions = useTaste((s) => s.reactions);
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const id = setTimeout(() => setSure(false), 3000);
    return () => clearTimeout(id);
  }, [sure]);
  const lines = on ? tasteLines(8) : [];
  const keeps = reactions.filter((r) => r.kind === 'keep').length;
  const skips = reactions.filter((r) => r.kind === 'skip').length;
  const picks = reactions.filter((r) => r.kind === 'pick' || r.kind === 'place').length;
  return (
    <Section
      id="look.taste"
      title="Your taste"
      sub={on ? 'Learns from ♥ Keep (K), ✕ Skip (X) and the looks you pick' : 'Learning is off: picks follow the music only'}
      right={<Toggle on={on} onChange={setLearning} label="Learn my taste" />}
      collapsible
    >
      {on && (
        <>
          {lines.length ? (
            <ul className="taste-lines">
              {lines.map((l) => (
                <li key={l.text} className={l.sign > 0 ? 'up' : 'down'}>
                  <i>{l.sign > 0 ? '♥' : '✕'}</i>
                  {l.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="taste-empty">
              {reactions.length ? 'Still learning: a few more reactions and Hum will start to see a pattern.' : 'Nothing learned yet. While a video plays, press ♥ on looks you love and ✕ on ones you don’t.'}
            </p>
          )}
          <p className="taste-foot">
            {reactions.length ? `${keeps} kept · ${skips} skipped · ${picks} picked by hand. Recent ones count most. ` : ''}
            About one pick in five still explores, and each “Make a video” is a new take.
          </p>
        </>
      )}
      {reactions.length > 0 && (
        <button
          className={`btn sm ${sure ? 'danger' : 'ghost'} taste-reset`}
          onClick={() => {
            if (!sure) return setSure(true);
            resetTaste();
            setSure(false);
            useStudio.getState().flash('Taste memory cleared');
          }}
        >
          {sure ? 'Click again to forget everything' : 'Reset what Hum learned'}
        </button>
      )}
    </Section>
  );
}
