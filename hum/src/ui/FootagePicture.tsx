/**
 * The Part tab's Picture group, for parts whose look is a footage look: what this shot does with the
 * person's clips and photos, for this shot only (store.partShot, through state/partEdit.ts setPartsShot).
 *
 *   Style           Auto (follow the look) or one of the footage styles
 *   Shuffle         another arrangement of the same style, for this shot; Previous steps back once
 *   Clip or photo   which of the person's media plays here (MediaPicker.tsx)
 *   Treatment       how the picture itself is broken down (folded away)
 *   Framing         where the picture is centred and how far it is pushed in (Framing.tsx, folded away)
 *
 * Shots without a choice of their own follow the look's settings (Fine-tune this look → Parameters),
 * so the look stays the default and each shot can still be changed on its own. With several parts
 * picked, every change goes to all of them, and a choice that differs between them shows none lit.
 */
import { useState } from 'react';
import type { PartShot, Preset, TrackAnalysis } from '../core/types';
import { getScene } from '../scenes';
import { setPartsShot } from '../state/partEdit';
import { useStudio } from '../state/store';
import { Seg } from './controls';
import { Framing } from './Framing';
import { lookParam, useMedia } from './footageMedia';
import { MediaPicker } from './MediaPicker';

/** the treatments, with a line each; the footage scene's own `treatment` setting wins when it has one */
const TREATMENTS: { v: string; label: string; tip: string }[] = [
  { v: 'none', label: 'None', tip: 'The picture as it is.' },
  { v: 'mosh', label: 'Mosh', tip: 'The picture melts in soft blocks that drag along with the motion.' },
  { v: 'sort', label: 'Sort', tip: 'Rows of the picture smear into long streaks of its own colours.' },
  { v: 'cells', label: 'Cells', tip: 'Rebuilt in tiny text cells: blocks, digits and marks in a few colours.' },
  { v: 'readout', label: 'Readout', tip: 'Coarse pixels with numbered boxes and captions, like an analysis screen.' },
  { v: 'collage', label: 'Collage', tip: 'Cut-out pieces of your pictures layered over one big one.' },
];

/** the treatment choices: read from the footage scene when it defines them, so the two can't drift */
function treatmentOptions(look: Preset): { v: string; label: string; tip: string }[] {
  const def = getScene(look.sceneId)?.params.find((d) => d.id === 'treatment');
  if (def?.type !== 'select' || !def.options.length) return TREATMENTS;
  return def.options.map((o) => ({ v: o.value, label: o.label, tip: TREATMENTS.find((t) => t.v === o.value)?.tip ?? def.hint ?? '' }));
}

const MIXED = '__mixed';

/** the same value in every part, or MIXED */
function common<T>(vals: T[]): T | typeof MIXED {
  const j = vals.map((v) => JSON.stringify(v ?? null));
  return j.every((x) => x === j[0]) ? vals[0] : MIXED;
}

/** the arrangement each part had before its last shuffle (null: it followed the look), per cut of the song */
const seedsBefore = new WeakMap<TrackAnalysis, Map<number, number | null>>();

/** which folded rows are open; kept while the panel moves between parts */
const openRows = { treat: false, frame: false };

/** each picked part's own record (null: none) */
function useShots(parts: number[]): (PartShot | null)[] {
  const n = useStudio((s) => s.analysis?.sections.length ?? -1);
  const partShot = useStudio((s) => s.partShot);
  return parts.map((j) => (partShot?.length === n ? (partShot[j] ?? null) : null));
}

/** Style, then Shuffle / Previous with the arrangement number: for these parts only */
export function ShotStyle({ parts, look, busy }: { parts: number[]; look: Preset; busy: boolean }) {
  const a = useStudio((s) => s.analysis);
  const tweak = useStudio((s) => s.tweaks[look.id]);
  const shots = useShots(parts);
  const [, redraw] = useState(0);
  const styleDef = getScene(look.sceneId)?.params.find((d) => d.id === 'style');
  const styles = styleDef?.type === 'select' ? styleDef.options : [];
  const lookStyle = String(lookParam(look, tweak, 'style') ?? 'auto');
  const lookSeed = Math.max(1, Math.round(Number(lookParam(look, tweak, 'seed') ?? 1)));
  const style = common(shots.map((r) => r?.style ?? 'auto'));
  const seeds = shots.map((r) => r?.seed ?? null);
  const seed = common(seeds.map((v) => v ?? lookSeed));
  const before = a ? (seedsBefore.get(a) ?? new Map<number, number | null>()) : new Map<number, number | null>();
  if (a && !seedsBefore.has(a)) seedsBefore.set(a, before);
  const canStepBack = parts.some((j) => before.has(j));
  const lookStyleName = styles.find((o) => o.value === lookStyle)?.label ?? lookStyle;

  const shuffle = () => {
    const cur = seed === MIXED ? -1 : seed;
    let next = cur;
    while (next === cur) next = 1 + Math.floor(Math.random() * 999);
    parts.forEach((j, k) => before.set(j, seeds[k]));
    setPartsShot(parts, { seed: next });
    redraw((x) => x + 1);
  };
  const previous = () => {
    // each part goes back to its own arrangement before the last shuffle (or to the look's)
    for (const j of parts) {
      if (!before.has(j)) continue;
      const v = before.get(j) ?? null;
      before.delete(j);
      setPartsShot([j], { seed: v ?? undefined });
    }
    redraw((x) => x + 1);
  };

  return (
    <>
      {styles.length > 0 && (
        <Seg
          value={style}
          options={styles.map((o) => ({
            v: o.value,
            label: o.label,
            tip: o.value === 'auto' ? (lookStyle === 'auto' ? 'Follow the look: a style picked for each shot' : `Follow the look: ${lookStyleName}`) : `${o.label} in this shot only`,
          }))}
          cols={4}
          disabled={busy}
          label="Footage style for this shot"
          onChange={(v) => setPartsShot(parts, { style: v === 'auto' ? undefined : v })}
        />
      )}
      <div className="pp-foot-row">
        <button className="btn sm" disabled={busy} onClick={shuffle} title="Lay the same style out another way in this shot. The other shots stay as they are.">
          <ShuffleIcon />
          Shuffle
        </button>
        <button className="btn sm ghost" disabled={busy || !canStepBack} onClick={previous} title="Go back to the arrangement before the last shuffle">
          Previous
        </button>
        <span className="pp-foot-n" title="Which arrangement is playing (1 to 999)">
          {seed === MIXED ? 'Mixed' : `No. ${seed}`}
        </span>
      </div>
    </>
  );
}

/** the whole Picture group, as a section of the Part tab */
export function FootagePicture({ parts, look, busy, headingId }: { parts: number[]; look: Preset; busy: boolean; headingId: string }) {
  const tweak = useStudio((s) => s.tweaks[look.id]);
  const shots = useShots(parts);
  const media = useMedia();
  const [hover, setHover] = useState<string | null>(null);
  const [treatOpen, setTreatOpen] = useState(openRows.treat);
  const [frameOpen, setFrameOpen] = useState(openRows.frame);
  const one = parts.length === 1;
  const owned = shots.some((r) => !!r);

  // treatment: the part's own, or the look's
  const treats = treatmentOptions(look);
  const lookTreat = String(lookParam(look, tweak, 'treatment') ?? 'none');
  const ownTreat = common(shots.map((r) => r?.treatment ?? null));
  const treat = common(shots.map((r) => r?.treatment ?? lookTreat));
  const treatName = treat === MIXED ? 'Mixed' : (treats.find((t) => t.v === treat)?.label ?? treat);
  const treatNote = hover !== null ? (treats.find((t) => t.v === hover)?.tip ?? '') : ownTreat === null ? 'Follows the look.' : ownTreat === MIXED ? 'Different in each part.' : one ? 'Set for this shot.' : 'Set for these shots.';

  // media: the parts' common choice (null: automatic)
  const chosen = common(shots.map((r) => r?.media ?? null));
  const chosenIds = chosen === MIXED || !chosen ? [] : chosen;
  const live = chosenIds.filter((id) => media.some((m) => m.id === id));
  const gone = chosenIds.length > 0 && !live.length;
  const mediaSub = chosen === MIXED ? 'Different in each part' : !chosenIds.length ? 'Automatic' : gone ? 'Not found' : live.length > 1 ? `${live.length} picked` : (media.find((m) => m.id === live[0])?.name ?? '');

  // framing: the part's own, or the look's
  const lookFx = Number(lookParam(look, tweak, 'focusX') ?? 0.5);
  const lookFy = Number(lookParam(look, tweak, 'focusY') ?? 0.55);
  const first = shots[0];
  const framing = { focusX: first?.focusX ?? lookFx, focusY: first?.focusY ?? lookFy, zoom: first?.zoom ?? 1 };
  const framed = shots.some((r) => r?.focusX !== undefined || r?.focusY !== undefined || r?.zoom !== undefined);
  const frameSame = common(shots.map((r) => [r?.focusX, r?.focusY, r?.zoom])) !== MIXED;
  const preview = media.find((m) => m.id === live[0]) ?? media[0];
  const frameSub = !frameSame ? 'Different in each part' : framed ? `${framing.zoom > 1.001 ? `${framing.zoom.toFixed(1)}× · ` : ''}${placeName(framing.focusX, framing.focusY)}` : 'As the look';

  return (
    <section className="pp-sec pp-picture" aria-labelledby={`${headingId}-pic`}>
      <div className="ps-h">
        <h3 id={`${headingId}-pic`}>Picture</h3>
        <span>{owned ? (one ? 'Set for this shot' : 'Set for these shots') : 'As the look'}</span>
      </div>

      <ShotStyle parts={parts} look={look} busy={busy} />

      {media.length ? (
        <div className="pp-sub">
          <div className="pp-sub-h">
            <span>Clip or photo</span>
            <span>{mediaSub}</span>
          </div>
          <MediaPicker media={media} value={chosen === MIXED ? 'mixed' : chosen} disabled={busy} label={`Which clip or photo plays in ${one ? 'this shot' : 'these shots'}`} onChange={(ids) => setPartsShot(parts, { media: ids ?? undefined })} />
          {gone && <p className="pp-note">The picture picked here is no longer in your library. Pick another, or leave it on Automatic.</p>}
        </div>
      ) : (
        <p className="pp-note">No clips or photos yet. Add them in the Library’s Footage and Photos tabs, then pick which one plays here.</p>
      )}

      <div className="pp-fold">
        <button
          className="pp-more"
          aria-expanded={treatOpen}
          onClick={() => {
            openRows.treat = !treatOpen;
            setTreatOpen(!treatOpen);
          }}
        >
          <span className={`pp-caret ${treatOpen ? 'open' : ''}`} aria-hidden>
            ›
          </span>
          Treatment
          <span className="pp-more-h">{treatName}</span>
        </button>
        {treatOpen && (
          <div className="pp-fold-body">
            <Seg value={treat} options={treats} cols={3} disabled={busy} label={`Treatment for ${one ? 'this shot' : 'these shots'}`} onHover={setHover} onChange={(v) => setPartsShot(parts, { treatment: v })} />
            <p className="pp-note pp-hint">
              {treatNote}
              {ownTreat !== null && hover === null && (
                <>
                  {' '}
                  <button type="button" className="pp-link" disabled={busy} onClick={() => setPartsShot(parts, { treatment: undefined })}>
                    Follow the look
                  </button>
                </>
              )}
            </p>
          </div>
        )}
      </div>

      {preview && (
        <div className="pp-fold">
          <button
            className="pp-more"
            aria-expanded={frameOpen}
            onClick={() => {
              openRows.frame = !frameOpen;
              setFrameOpen(!frameOpen);
            }}
          >
            <span className={`pp-caret ${frameOpen ? 'open' : ''}`} aria-hidden>
              ›
            </span>
            Framing
            <span className="pp-more-h">{frameSub}</span>
          </button>
          {frameOpen && (
            <div className="pp-fold-body">
              <Framing item={preview} value={framing} disabled={busy} onChange={(v) => setPartsShot(parts, v)} />
              <p className="pp-note pp-hint">
                {live.length ? 'Drag the dot to where the picture should centre.' : `Shown on ${preview.name}. It applies to whichever picture plays.`}
                {framed && (
                  <>
                    {' '}
                    <button type="button" className="pp-link" disabled={busy} onClick={() => setPartsShot(parts, { focusX: undefined, focusY: undefined, zoom: undefined })}>
                      Reset framing
                    </button>
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      )}

      <p className="pp-note">{one ? 'For this shot only.' : 'For these shots only.'} Shots without their own choice follow the look.</p>
    </section>
  );
}

/** "centred", "top left", "bottom": where the focus point sits, in words */
function placeName(x: number, y: number): string {
  const h = x < 0.35 ? 'left' : x > 0.65 ? 'right' : '';
  const v = y > 0.65 ? 'top' : y < 0.35 ? 'bottom' : '';
  return [v, h].filter(Boolean).join(' ') || 'centred';
}

export function ShuffleIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path d="M2 4h2.5c1.6 0 2.6.8 3.5 2.2l1 1.6c.9 1.4 1.9 2.2 3.5 2.2H14M2 12h2.5c1.2 0 2-.4 2.7-1.2M9.3 5.2C10 4.4 10.8 4 12 4h2M12 2l2 2-2 2M12 8l2 2-2 2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
