/**
 * The Picture group of the Part tab (and of the Look tab when a look plays on its own): which of the
 * person's clips and photos plays, and what happens to it. For one shot, several picked shots, or the
 * look on screen, through one "target" (store.partShot through setPartsShot, or store.soloShot through
 * setSoloShot).
 *
 *   Picture         large thumbnails, first thing under the part's name: one click uses that one,
 *                   "Add another" (or Cmd-click) puts several in, with a line on what several do
 *   Landing         what in the clip lands on the song, when something does, and a way to let it just play
 *   Style           footage looks: Auto (follow the look) or one of the footage styles
 *   Shuffle         another arrangement of the same style; Previous steps back once
 *   Motion          footage looks, when the scene has it: what a clip does in time
 *   Graphics        footage looks: whether anything may cover the picture here (shot/graphics.ts)
 *   Treatment       footage looks: how the picture itself is broken down (a row that opens)
 *   Framing         footage looks: where the picture is centred and how far it is pushed in (a row that opens)
 *
 * Photo looks (photo dissolve, mosh, mosaic, ripple, the boards) get the Picture row only, photos only:
 * the stage hands them just the photos chosen (render/stage.ts), so one stays on screen and several
 * rotate among themselves. They have no Framing: their shaders fit the photo themselves, and framing
 * them would mean changing every one of those shaders.
 *
 * Option lists and their lines come from the footage scene's own settings (style, treatment, motion),
 * so a style or treatment added there shows up here by itself.
 */
import { useState } from 'react';
import type { ParamDef, PartShot, TrackAnalysis } from '../core/types';
import { getScene } from '../scenes';
import { FORM_IDS, FORMS, isForm } from '../inside/formIds';
import { offIn, styleOn, treatmentOn } from '../shot/graphics';
import { activeFinish } from '../state/direction';
import { inked } from '../state/inks';
import { setPartsShot } from '../state/partEdit';
import { useStudio } from '../state/store';
import { Section, Seg } from './controls';
import { Framing } from './Framing';
import { canShow, pictureKind, useMedia, type PictureKind, type ShotTarget } from './footageMedia';
import { useLandings, type Landing } from './landings';
import { MediaPicker } from './MediaPicker';
import { seeIn } from './seeTry';
import { inkName, PartInks } from './InkColours';
import { fmtTime } from './song';

/** a line for each treatment the scene doesn't describe itself */
const TREATMENT_TIPS: Record<string, string> = {
  auto: 'A treatment picked for each shot from the song.',
  none: 'The picture as it is.',
  mosh: 'The picture melts in soft blocks that drag along with the motion.',
  sort: 'Rows of the picture smear into long streaks of its own colours.',
  cells: 'Rebuilt in tiny text cells: blocks, digits and marks in a few colours.',
  readout: 'Coarse pixels with numbered boxes and captions, like an analysis screen.',
  collage: 'Cut-out pieces of your pictures layered over one big one.',
  trace: 'Your pictures layered and tracked with moving lines, like a screen being scanned.',
};
const MOTION_TIPS: Record<string, string> = {
  play: 'The clip plays as it is.',
  stutter: 'The clip catches and repeats on the beat.',
  echo: 'Earlier frames trail behind the clip.',
  reverse: 'The clip plays backwards.',
  slices: 'The clip is cut in bands, each a moment apart.',
};

/** a select setting of a scene, its choices and a line for each */
function selectOptions(sceneId: string, id: string, tips: Record<string, string>): { v: string; label: string; tip: string }[] {
  const def = getScene(sceneId)?.params.find((d) => d.id === id) as ParamDef | undefined;
  if (def?.type !== 'select') return [];
  return def.options.map((o) => ({ v: o.value, label: o.label, tip: (o as { hint?: string }).hint ?? tips[o.value] ?? def.hint ?? '' }));
}

const MIXED = '__mixed';

/** try a change on the shot while the pointer rests on it (Seg tryOn), going to the part when the song is elsewhere */
function tryOnShot(t: ShotTarget, patch: Partial<PartShot>) {
  t.set(patch);
  if (!t.solo) seeIn(Number(t.key.split(',')[0]));
}

/** the same value in every shot, or MIXED */
function common<T>(vals: T[]): T | typeof MIXED {
  const j = vals.map((v) => JSON.stringify(v ?? null));
  return j.every((x) => x === j[0]) ? vals[0] : MIXED;
}

/** the arrangement each target had before its last shuffle (null: it followed the look), per cut of the song */
const seedsBefore = new WeakMap<TrackAnalysis, Map<string, (number | null)[]>>();
const soloBefore = new Map<string, (number | null)[]>();

/** Style, then Shuffle / Previous with the arrangement number */
export function ShotStyle({ t, busy }: { t: ShotTarget; busy: boolean }) {
  const a = useStudio((s) => s.analysis);
  const [, redraw] = useState(0);
  const styles = selectOptions(t.sceneId, 'style', {});
  const lookStyle = String(t.lookValue('style') ?? 'auto');
  const lookSeed = Math.max(1, Math.round(Number(t.lookValue('seed') ?? 1)));
  const style = common(t.shots.map((r) => r?.style ?? 'auto'));
  const seeds = t.shots.map((r) => r?.seed ?? null);
  const seed = common(seeds.map((v) => v ?? lookSeed));
  let before = soloBefore;
  if (!t.solo && a) {
    before = seedsBefore.get(a) ?? new Map();
    if (!seedsBefore.has(a)) seedsBefore.set(a, before);
  }
  const canStepBack = before.has(t.key);
  const lookStyleName = styles.find((o) => o.v === lookStyle)?.label ?? lookStyle;

  const shuffle = () => {
    const cur = seed === MIXED ? -1 : seed;
    let next = cur;
    while (next === cur) next = 1 + Math.floor(Math.random() * 999);
    before.set(t.key, seeds);
    t.set({ seed: next });
    redraw((x) => x + 1);
  };
  const previous = () => {
    const was = before.get(t.key);
    if (!was) return;
    before.delete(t.key);
    // every shot goes back to its own arrangement before the last shuffle (or to the look's)
    const same = was.every((v) => v === was[0]);
    if (same) t.set({ seed: was[0] ?? undefined });
    else if (!t.solo) t.key.split(',').forEach((j, k) => setPartsShot([Number(j)], { seed: was[k] ?? undefined }));
    redraw((x) => x + 1);
  };

  return (
    <>
      {styles.length > 0 && (
        <Seg
          value={style}
          options={styles.map((o) => ({
            v: o.v,
            label: o.label,
            tip: o.v === 'auto' ? (lookStyle === 'auto' ? 'Follow the look: a style picked for each shot' : `Follow the look: ${lookStyleName}`) : `${o.label} in ${t.scope} only`,
          }))}
          cols={4}
          disabled={busy}
          label={`Footage style for ${t.scope}`}
          onChange={(v) => t.set({ style: v === 'auto' ? undefined : v })}
          tryOn={(v) => tryOnShot(t, { style: v === 'auto' ? undefined : v })}
        />
      )}
      <div className="pp-foot-row">
        <button className="btn sm" disabled={busy} onClick={shuffle} title={`Lay the same style out another way in ${t.scope}.${t.solo ? '' : ' The other shots stay as they are.'}`}>
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

const LANDS_ON: Record<Landing['on'], string> = { drop: 'on the drop', cut: 'right on the cut', out: 'right before the next cut', word: 'on a word', beat: 'on the beat' };
const LANDS_HOW: Record<Landing['ramp'], string> = {
  land: 'The clip rushes up to it and all but stops on it.',
  sink: 'The clip eases into it and hangs there.',
  burst: 'The clip hangs back and bursts off it.',
  ride: 'The clip runs through it at its own speed.',
};

/** what in the part's clip lands on the song, with a way to let the clip just play */
function LandingLine({ t, busy }: { t: ShotTarget; busy: boolean }) {
  const part = Number(t.key);
  const mine = useLandings().filter((l) => l.part === part);
  const hand = t.shots[0];
  if (!mine.length) {
    // what was landed, put aside by hand
    const aside = t.planned[0]?.hit !== undefined && hand?.from !== undefined && (!hand.media?.length || hand.media[0] === t.planned[0]?.media?.[0]);
    if (!aside) return null;
    return (
      <p className="pp-note">
        {'The clip just plays here. '}
        <button type="button" className="pp-link" disabled={busy} onClick={() => t.set({ from: undefined })}>
          Land it on the song again
        </button>
      </p>
    );
  }
  const l = mine[0];
  return (
    <p className="pp-note" title={`${l.second.toFixed(1)} s into the clip, at ${fmtTime(l.at)} of the song`}>
      {`${l.what ? `${l.what[0].toUpperCase()}${l.what.slice(1)}, ` : 'Lands '}${LANDS_ON[l.on]} at ${fmtTime(l.at)}. ${LANDS_HOW[l.ramp]} `}
      <button type="button" className="pp-link" disabled={busy} onClick={() => t.set({ from: Math.round(l.from * 100) / 100 })}>
        Let it just play
      </button>
    </p>
  );
}

/** what several pictures do in one shot, for the style and treatment it plays */
function severalLine(kind: PictureKind, style: string, treat: string): string {
  if (kind === 'photos') return 'Several photos: the look moves from one to the next as the song plays.';
  if (treat === 'collage') return 'Several pictures: Collage layers pieces of the others over the first.';
  if (treat === 'trace') return 'Several pictures: Trace layers them and runs lines across them.';
  if (style === 'split') return 'Several pictures: Split shows the first two side by side.';
  return 'Several pictures: the shot moves through them in order.';
}

/**
 * The Picture group. For a photo look only the picture row; for a footage look the style, shuffle,
 * motion, treatment and framing too. `id` lets the timeline's "Change picture…" scroll to it.
 */
export function FootagePicture({ t, busy, headingId }: { t: ShotTarget; busy: boolean; headingId: string }) {
  const all = useMedia();
  const kind = pictureKind(t.sceneId);
  const media = all.filter((m) => canShow(kind, m));
  const [hover, setHover] = useState<string | null>(null);
  const finish = useStudio(activeFinish);
  const footage = kind === 'footage';
  const shots = t.shots;
  const planned = t.planned.some(Boolean);
  const asLook = planned ? 'As planned' : 'As the look';

  // media: the shots' common choice (null: automatic)
  const chosen = common(shots.map((r) => r?.media ?? null));
  const chosenIds = chosen === MIXED || !chosen ? [] : chosen;
  const live = chosenIds.filter((id) => media.some((m) => m.id === id));
  const gone = chosenIds.length > 0 && !live.length;

  // treatment: the shot's own, or the look's
  const treats = selectOptions(t.sceneId, 'treatment', TREATMENT_TIPS);
  const lookTreat = String(t.lookValue('treatment') ?? 'none');
  const ownTreat = common(shots.map((r) => r?.treatment ?? null));
  const treat = common(shots.map((r) => r?.treatment ?? lookTreat));
  const treatName = treat === MIXED ? 'Mixed' : (treats.find((o) => o.v === treat)?.label ?? treat);
  const treatNote = hover !== null ? (treats.find((o) => o.v === hover)?.tip ?? '') : ownTreat === null ? (planned ? 'As planned.' : 'Follows the look.') : ownTreat === MIXED ? 'Different in each part.' : `Set for ${t.scope}.`;

  const inks = common(shots.map((r) => r?.inks ?? null));
  const form = common(shots.map((r) => r?.form ?? null));
  const graphics = common(shots.map((r) => r?.graphics ?? null));

  // a style or treatment picked for these shots that their graphics don't allow
  const graphicsOff = useStudio((s) => s.graphicsOff);
  const blocked = shots.flatMap((r) => {
    const off = offIn(r, graphicsOff);
    return [r?.style && !styleOn(r.style, off) ? r.style : '', r?.treatment && !treatmentOn(r.treatment, off) ? r.treatment : ''].filter(Boolean);
  })[0];
  const hidden = blocked ? blocked[0].toUpperCase() + blocked.slice(1) : '';

  // motion: the scene's own setting, when it has one (clips only)
  const motions = selectOptions(t.sceneId, 'motion', MOTION_TIPS);
  const lookMotion = String(t.lookValue('motion') ?? motions[0]?.v ?? 'play');
  const motion = common(shots.map((r) => r?.motion ?? lookMotion));
  const hasClip = live.length ? live.some((id) => media.find((m) => m.id === id)?.kind === 'clip') : media.some((m) => m.kind === 'clip');

  // what several pictures do here
  const style = String(common(shots.map((r) => r?.style ?? t.lookValue('style') ?? 'auto')));
  const several = severalLine(kind, style, String(treat));

  // framing: the shot's own, or the look's
  const lookFx = Number(t.lookValue('focusX') ?? 0.5);
  const lookFy = Number(t.lookValue('focusY') ?? 0.55);
  const first = shots[0];
  const framing = { focusX: first?.focusX ?? lookFx, focusY: first?.focusY ?? lookFy, zoom: first?.zoom ?? t.planned[0]?.zoom ?? 1 };
  const framed = shots.some((r) => r?.focusX !== undefined || r?.focusY !== undefined || r?.zoom !== undefined);
  const frameSame = common(shots.map((r) => [r?.focusX, r?.focusY, r?.zoom])) !== MIXED;
  // with nothing picked by hand, the director's picture (Claude's, or the offline plan's), when it chose one
  const directed = t.planned.length === 1 ? media.find((m) => m.id === t.planned[0]?.media?.[0]) : undefined;
  const preview = media.find((m) => m.id === live[0]) ?? directed ?? media[0];
  const frameSub = !frameSame ? 'Different in each part' : framed ? `${framing.zoom > 1.001 ? `${framing.zoom.toFixed(1)}× · ` : ''}${placeName(framing.focusX, framing.focusY)}` : asLook;

  const sub = chosen === MIXED ? 'Different in each part' : !chosenIds.length ? (directed ? `Automatic: ${directed.name}` : 'Automatic') : gone ? 'Not found' : live.length > 1 ? `${live.length} ${footage ? 'pictures' : 'photos'}` : 'Your pick';

  return (
    <section className="pp-sec pp-picture" id="pp-picture" aria-labelledby={`${headingId}-pic`}>
      <div className="ps-h">
        <h3 id={`${headingId}-pic`}>Picture</h3>
        <span>{sub}</span>
      </div>

      {media.length ? (
        <MediaPicker media={media} value={chosen === MIXED ? 'mixed' : chosen} disabled={busy} scope={t.scope} several={several} photosOnly={!footage} onChange={(ids) => t.set({ media: ids ?? undefined })} />
      ) : (
        <p className="pp-note">{footage ? 'No clips or photos yet. Add them in the Library’s Footage and Photos tabs, then pick which one plays here.' : 'No photos yet. Add them in the Library’s Photos tab, then pick which one this look shows.'}</p>
      )}
      {footage && !t.solo && t.shots.length === 1 && <LandingLine t={t} busy={busy} />}
      {gone && <p className="pp-note">The picture picked here is no longer in your library. Pick another, or go back to Automatic.</p>}

      {footage && (
        <>
          <div className="pp-sub-h pp-gap">
            <span>Style</span>
            <span>{shots.some((r) => r?.style || r?.seed) ? `Set for ${t.scope}` : asLook}</span>
          </div>
          <ShotStyle t={t} busy={busy} />
          {hidden && (
            <p className="pp-note pp-hint">
              {hidden} is off here, so the clip plays clean.{' '}
              <button type="button" className="pp-link" disabled={busy} onClick={() => t.set({ graphics: 'on' })}>
                Allow it here
              </button>
            </p>
          )}

          {motions.length > 0 && hasClip && (
            <>
              <div className="pp-sub-h pp-gap">
                <span>Motion</span>
                <span>{motion === MIXED ? 'Mixed' : shots.some((r) => r?.motion) ? `Set for ${t.scope}` : asLook}</span>
              </div>
              <Seg value={motion} options={motions} cols={Math.min(5, motions.length)} disabled={busy} label={`What the clip does in ${t.scope}`} onChange={(v) => t.set({ motion: v })} tryOn={(v) => tryOnShot(t, { motion: v })} />
            </>
          )}

          <div className="pp-sub-h pp-gap">
            <span>Graphics over it</span>
            <span>{graphics === MIXED ? 'Mixed' : graphics === 'off' ? 'Off here' : graphics === 'on' ? 'All on here' : 'As the video'}</span>
          </div>
          <Seg
            value={graphics === MIXED ? MIXED : (graphics ?? 'video')}
            options={[
              { v: 'video', label: 'As the video', tip: 'What the Video tab’s Graphics allow' },
              { v: 'on', label: 'On', tip: 'Anything may go over the picture here' },
              { v: 'off', label: 'Off', tip: 'The clip alone: no shapes, effects or lyric panels here' },
            ]}
            cols={3}
            disabled={busy}
            label={`Graphics over ${t.scope}`}
            onChange={(v) => t.set({ graphics: v === 'on' || v === 'off' ? v : undefined })}
            tryOn={(v) => tryOnShot(t, { graphics: v === 'on' || v === 'off' ? v : undefined })}
          />

          {(style === 'inside' || style === 'auto' || style === MIXED) && (
            <>
              <div className="pp-sub-h pp-gap">
                <span>3D form</span>
                <span>{form === MIXED ? 'Mixed' : form === 'none' ? 'None here' : isForm(form) ? `${FORMS[form].label} here` : 'By the song'}</span>
              </div>
              <Seg
                value={form === MIXED ? MIXED : (form ?? 'song')}
                options={[
                  { v: 'song', label: 'By the song', tip: 'Hum puts one in the big moments, where the picture has room' },
                  { v: 'none', label: 'None', tip: 'No form in this shot' },
                  ...FORM_IDS.map((id) => ({ v: id as string, label: FORMS[id].label, tip: FORMS[id].tip })),
                ]}
                cols={3}
                disabled={busy || graphics === 'off'}
                label={`3D form in ${t.scope}`}
                onChange={(v) => t.set({ form: v === 'song' ? undefined : v })}
                tryOn={(v) => tryOnShot(t, { form: v === 'song' ? undefined : v })}
              />
              {style !== 'inside' && isForm(form) && <p className="pp-note pp-hint">Forms stand in Inside shots. Pick the Inside style to see it.</p>}
            </>
          )}

          {inked(finish) && (
            <Section id="pic.inks" title="Colours" value={inks === MIXED ? 'Mixed' : inkName(inks)} collapsible defaultOpen={false}>
              <PartInks value={inks === MIXED ? 'mixed' : inks} disabled={busy} onChange={(v) => t.set({ inks: v })} />
            </Section>
          )}

          <Section id="pic.treat" title="Treatment" value={treatName} collapsible defaultOpen={false}>
            <Seg value={treat} options={treats} cols={3} disabled={busy} label={`Treatment for ${t.scope}`} onHover={setHover} onChange={(v) => t.set({ treatment: v })} tryOn={(v) => tryOnShot(t, { treatment: v })} />
            <p className="pp-note pp-hint">
              {treatNote}
              {ownTreat !== null && hover === null && (
                <>
                  {' '}
                  <button type="button" className="pp-link" disabled={busy} onClick={() => t.set({ treatment: undefined })}>
                    {planned ? 'As planned' : 'Follow the look'}
                  </button>
                </>
              )}
            </p>
          </Section>

          {preview && (
            <Section id="pic.frame" title="Framing" value={frameSub} collapsible defaultOpen={false}>
              <Framing item={preview} value={framing} disabled={busy} onChange={(v) => t.set(v)} />
              <p className="pp-note pp-hint">
                {live.length ? 'Drag the dot to where the picture should centre.' : `Shown on ${preview.name}. It applies to whichever picture plays.`}
                {framed && (
                  <>
                    {' '}
                    <button type="button" className="pp-link" disabled={busy} onClick={() => t.set({ focusX: undefined, focusY: undefined, zoom: undefined })}>
                      Reset framing
                    </button>
                  </>
                )}
              </p>
            </Section>
          )}
        </>
      )}

      <p className="pp-note">{t.solo ? 'For this look while it plays on its own.' : `For ${t.scope} only. Shots without their own choice follow the ${planned ? 'plan' : 'look'}.`}</p>
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
