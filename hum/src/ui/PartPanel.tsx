/**
 * The Part tab of the right panel: everything about the part (or parts) picked on the timeline, or
 * the part that is playing when nothing is picked; with no video plan, a line about the look on screen.
 *
 *   name, time, length     which section and shot it is
 *   Picture                first, for a part whose look shows the person's clips or photos (footage and
 *                          photo looks): which one plays, as large thumbnails, then (footage) its style,
 *                          Shuffle, motion, treatment and framing, for this shot alone (FootagePicture.tsx)
 *   Quick picks            the five looks that fit this part best, as pictures: one click (or 1–5) swaps
 *   actions                Play this part, Like, Reset, Undo (the app's one history, state/history.ts)
 *   Look                   its picture and name, and its other takes (versions)
 *   More looks             the full Swap the look list, with moods and a search (PartSheet.tsx), folded away
 *   Hand-drawn             As the video / On / Off, for these parts only
 *   Pop-ups                Auto / Off / Few / Lots, and Shuffle for a different deal of them (popSeed.ts)
 *   Lyrics                 the lyric styles (lyricPlan.ts MEDIUM_CHOICES), parts with words sung only
 *   Words                  what a look that writes text shows here (flip cards, boards, type looks)
 *
 * With several parts picked every control applies to all of them, and a control whose value differs
 * between them shows no choice lit ("Mixed"). The changes go through state/partEdit.ts, like the
 * phone's part sheet; the panel engineer mounts "Fine-tune this look" under this.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { finishName } from '../core/direction';
import type { TrackAnalysis } from '../core/types';
import { takeName } from '../presets/fit';
import { profileFor } from '../render/lyricProfiles';
import { getScene } from '../scenes';
import { sceneShowsWords } from '../scenes/three/songInfo';
import { activeFinish } from '../state/direction';
import { onFrame } from '../state/live';
import { MEDIUM_CHOICES, vocalDensity, type LyricMedium } from '../state/lyricPlan';
import { historyLabels, onHistoryChange, undo } from '../state/history';
import { likePart, playPart, resetParts, setPartsHand, setPartsLook, setPartsLyric, setPartsPops, setPartsWords } from '../state/partEdit';
import { findLook, listNames, makeVideo, partEdits, partNames, popsOf, sectionIndexAt, sectionNames, validPlan } from '../state/plan';
import { parentsOf } from '../state/planCache';
import { reshufflePops } from '../state/popSeed';
import type { ParamValue, Preset } from '../core/types';
import { setQuickPicks } from './shotActions';
import type { LookTweak } from '../state/tweaks';
import { useStudio } from '../state/store';
import { audioEngine } from '../audio/engine';
import { Play } from './Icons';
import { FootagePicture, ShuffleIcon } from './FootagePicture';
import { lookParam, pictureKind, scrollToPicture, usePartsTarget, useSoloTarget } from './footageMedia';
import { Thumb } from './Library';
import { SwapList, useRankedLooks } from './PartSheet';
import { fmtTime, lookBg } from './song';
import './partSheet.css';

const POP_LEVELS: { label: string; v: number | null; tip: string }[] = [
  { label: 'Auto', v: null, tip: 'As many as the plan gives this part' },
  { label: 'Off', v: 0, tip: 'No pop-ups or windows in this part' },
  { label: 'Few', v: 1, tip: 'A window pops up now and then' },
  { label: 'Lots', v: 3, tip: 'Windows pop in on the beats and on the drop' },
];
const HAND: { label: string; v: boolean | null; tip: string }[] = [
  { label: 'As the video', v: null, tip: 'Hand-drawn when the whole video is' },
  { label: 'On', v: true, tip: 'This part is drawn by hand, whatever the video does' },
  { label: 'Off', v: false, tip: 'This part stays clean of the hand-drawn finish' },
];

/** the same value in every part, or 'mixed' */
function common<T>(vals: T[]): T | 'mixed' {
  return vals.every((v) => v === vals[0]) ? vals[0] : 'mixed';
}

/** the part playing now, updated when the song moves into another part */
function usePlayingPart(a: TrackAnalysis | null): number {
  const [i, setI] = useState(() => (a ? sectionIndexAt(a.sections, audioEngine.currentTime) : 0));
  useEffect(() => {
    if (!a) return;
    return onFrame(() => {
      const j = sectionIndexAt(a.sections, audioEngine.currentTime);
      setI((prev) => (prev === j ? prev : j));
    });
  }, [a]);
  return i;
}

export function PartPanel() {
  const analysis = useStudio((s) => s.analysis);
  const plan = useStudio((s) => s.plan);
  const selected = useStudio((s) => s.selectedParts);
  const playing = usePlayingPart(analysis);
  if (!analysis || !analysis.sections.length || !validPlan(plan, analysis)) return <NoPlan a={analysis} />;
  const picked = selected.filter((i) => i >= 0 && i < analysis.sections.length).sort((x, y) => x - y);
  const parts = picked.length ? picked : [Math.min(playing, analysis.sections.length - 1)];
  return <PartBody key={parts.join(',')} a={analysis} parts={parts} picked={picked.length > 0} />;
}

/** no video plan: what's on screen, and how to get parts */
function NoPlan({ a }: { a: TrackAnalysis | null }) {
  const presetId = useStudio((s) => s.presetId);
  const planning = useStudio((s) => s.planning);
  const busy = useStudio((s) => !!s.clip);
  const sceneId = useStudio((s) => s.sceneId);
  const look = findLook(presetId);
  const kind = pictureKind(sceneId);
  return (
    <div className="pp pp-noplan">
      {look && (
        <div className="pp-head">
          <span className="pp-pic" style={lookBg(look)} aria-hidden />
          <div className="pp-title">
            <h2>{look.name}</h2>
            <span className="pp-sub">The look on screen</span>
          </div>
        </div>
      )}
      {kind && <SoloPicture busy={busy} />}
      <p className="pp-note">
        {a?.sections.length
          ? 'Make a video to give every part of the song its own look. Then pick a part on the timeline to change it here.'
          : 'Load a song and its parts show up on the timeline. Pick one to change it here.'}
      </p>
      {!!a?.sections.length && (
        <button className="btn sm primary" disabled={planning || busy} onClick={() => void makeVideo('')}>
          {planning ? 'Planning…' : 'Make a video'}
        </button>
      )}
    </div>
  );
}

/** the Picture group for the look playing on its own (store.soloShot) */
function SoloPicture({ busy }: { busy: boolean }) {
  const t = useSoloTarget();
  return <FootagePicture t={t} busy={busy} headingId="pp-solo" />;
}

/** the Picture group for parts of the plan */
function PartsPicture({ parts, look, busy, headingId }: { parts: number[]; look: Preset; busy: boolean; headingId: string }) {
  const t = usePartsTarget(parts, look);
  useEffect(() => {
    requestAnimationFrame(scrollToPicture);
  }, []);
  return <FootagePicture t={t} busy={busy} headingId={headingId} />;
}

function PartBody({ a, parts, picked }: { a: TrackAnalysis; parts: number[]; picked: boolean }) {
  const plan = useStudio((s) => s.plan)!;
  const lyrics = useStudio((s) => s.lyrics);
  const lyricStyle = useStudio((s) => s.lyricStyle);
  const popups = useStudio((s) => s.popups);
  const partPops = useStudio((s) => s.partPops);
  const partHand = useStudio((s) => s.partHand);
  const partWords = useStudio((s) => s.partWords);
  const partShot = useStudio((s) => s.partShot);
  const videoFinish = useStudio((s) => activeFinish(s));
  const busy = useStudio((s) => !!s.clip);
  // the app's one undo (state/history.ts): the same step Cmd+Z and the transport's arrow take back
  const undoText = useSyncExternalStore(onHistoryChange, historyLabels).undo;
  const n = a.sections.length;
  const one = parts.length === 1;
  const i = parts[0];
  const names = partNames(a);
  const name = one ? sectionNames(a.sections)[i] : `${parts.length} parts selected`;
  const partList = listNames(parts.map((j) => names[j]));
  const { look, fam, ranked } = useRankedLooks(a, i, 'all');
  const [moreOpen, setMoreOpen] = useState(false);
  // which shot of its section this part is (one look per part: flatPlan.ts)
  const parents = parentsOf(a);
  const siblings = parents.map((p, k) => (p === parents[i] ? k : -1)).filter((k) => k >= 0);
  const shotNo = siblings.indexOf(i) + 1;
  const liked = one && !!plan.liked?.[i];
  const quick = one ? ranked.slice(0, 5).map((r) => r.take) : [];
  const quickKey = quick.map((p) => p.id).join(',');
  // the number keys 1–5 put these in while a part is picked (App.tsx)
  useEffect(() => {
    setQuickPicks(quick.length ? { parts, looks: quick } : null);
    return () => setQuickPicks(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickKey, parts.join(',')]);
  const edits = partEdits(plan, a, partPops, partHand, partWords, partShot);
  const anyEdit = parts.some((j) => edits[j]);
  const len = parts.reduce((t, j) => t + a.sections[j].end - a.sections[j].start, 0);

  // looks
  const lookIds = parts.map((j) => plan.looks[j] ?? null);
  const sameLook = common(lookIds);
  const looksHere = [...new Set(lookIds)].map((id) => findLook(id)).filter((p) => !!p);

  // hand-drawn, pop-ups, words: the person's own values (null: as planned)
  const hand = common(parts.map((j) => (partHand?.length === n ? (partHand[j] ?? null) : null)));
  const pops = common(parts.map((j) => (partPops?.length === n && typeof partPops[j] === 'number' ? Math.min(3, partPops[j]!) : null)).map((v) => (v === 2 ? 3 : v)));
  const planned = common(parts.map((j) => popsOf(plan, a, j)));
  const words = common(parts.map((j) => (partWords?.length === n ? (partWords[j] ?? '') : '')));

  // lyrics: only parts with words sung in them
  const synced = !!lyrics?.synced && lyrics.lines.length > 0;
  const sungParts = synced ? parts.filter((j) => vocalDensity(lyrics!.lines, a.sections[j]).lines > 0) : [];
  const medium = sungParts.length ? common(sungParts.map((j) => plan.lyricPlan?.parts[j]?.medium ?? null)) : null;
  const ownOk = sungParts.every((j) => {
    const p = findLook(plan.looks[j]);
    const sc = p ? getScene(p.sceneId) : undefined;
    return !!p && profileFor(p.id, sc?.category, !!sc?.showsLyrics).own !== 'none';
  });

  // the Words field: every part's look writes text of its own
  const wordy = parts.every((j) => sceneShowsWords(findLook(plan.looks[j])?.sceneId));

  const changedWhat = one ? [edits[i]?.look && 'look', edits[i]?.lyric && 'lyrics', edits[i]?.shot && 'picture', edits[i]?.pops && 'pop-ups', edits[i]?.hand && 'hand-drawn', edits[i]?.words && 'words'].filter(Boolean).join(', ') : '';
  // the Picture group: every picked part plays a look that shows the person's clips or photos. Its
  // defaults come from the first one; with footage and photo looks picked together, a photo look's,
  // so only what every one of them can show is offered.
  const partLooks = parts.map((j) => findLook(plan.looks[j]));
  const kinds = partLooks.map((p) => pictureKind(p?.sceneId));
  const picLook = kinds.every((k) => !!k) ? (partLooks[kinds.indexOf('photos')] ?? partLooks[0]) : undefined;
  const headingId = `pp-${parts.join('-')}`;

  return (
    <div className="pp">
      <div className="pp-head">
        <span className={`pp-pic ${one ? '' : 'stack'}`} style={look && sameLook !== 'mixed' ? lookBg(look) : undefined} aria-hidden>
          {sameLook === 'mixed' && looksHere.slice(0, 3).map((p) => <i key={p.id} style={lookBg(p)} />)}
        </span>
        <div className="pp-title">
          <h2>{name}</h2>
          <span className="pp-sub">
            {one ? `${siblings.length > 1 ? `Shot ${shotNo} of ${siblings.length} · ` : ''}${fmtTime(a.sections[i].start)}–${fmtTime(a.sections[i].end)} · ${Math.round(len)} s` : `${partList} · ${Math.round(len)} s in all`}
            {!picked && ' · playing now'}
          </span>
        </div>
      </div>

      {picLook && <PartsPicture parts={parts} look={picLook} busy={busy} headingId={headingId} />}

      {quick.length > 0 && <QuickPicks looks={quick} busy={busy} onPick={(p) => setPartsLook(parts, p.id)} />}

      <div className="pp-actions">
        <button className="btn sm" onClick={() => playPart(i)} disabled={busy} title={`Jump to ${names[i]} and play it`}>
          <Play width={11} height={11} />
          {one ? 'Play this part' : `Play from ${names[i]}`}
        </button>
        {one && plan.flat && look && (
          <button
            className={`btn sm ghost pp-like ${liked ? 'on' : ''}`}
            aria-pressed={liked}
            onClick={() => likePart(i, !liked)}
            disabled={busy}
            title={liked ? 'Liked: a skip next to it or a remake leaves it alone. Click to take the like back.' : 'Like this look here: a skip next to it or a remake leaves it alone (K while it plays)'}
          >
            <HeartIcon filled={liked} />
            {liked ? 'Liked' : 'Like'}
          </button>
        )}
        {anyEdit && (
          <button className="btn sm ghost" onClick={() => resetParts(parts)} disabled={busy} title={one ? 'Put back what the plan picked for this part' : 'Put back what the plan picked for these parts'}>
            {one ? 'Reset this part' : 'Reset these parts'}
          </button>
        )}
        {undoText && (
          <button className="btn sm ghost" onClick={undo} disabled={busy} title={`Undo ${undoText} (⌘Z)`}>
            Undo
          </button>
        )}
      </div>
      {changedWhat && <p className="pp-note">You changed the {changedWhat} here. A new plan keeps it.</p>}
      {!picked && <p className="pp-note">Click a part on the timeline to pick it. ⌘-click picks more than one.</p>}
      {busy && <p className="pp-note">A render is running: changes wait until it’s done.</p>}

      <section className="pp-sec" aria-labelledby={`${headingId}-look`}>
        <div className="ps-h">
          <h3 id={`${headingId}-look`}>Look</h3>
          {sameLook === 'mixed' && <span>Different in each part</span>}
        </div>
        {sameLook !== 'mixed' && look ? (
          <div className="pp-look">
            <span className="ps-thumb">
              <Thumb p={look} />
            </span>
            <span className="ps-lt">
              <b>{fam && fam.takes.length > 1 ? `${fam.name} · ${takeName(look)}` : look.name}</b>
              <span>{look.description}</span>
            </span>
          </div>
        ) : sameLook === 'mixed' ? (
          <p className="pp-note">{looksHere.map((p) => p.name).join(', ')}</p>
        ) : (
          <p className="pp-note">No look yet.</p>
        )}
        {sameLook !== 'mixed' && fam && fam.takes.length > 1 && !(look && isFootage(look)) && (
          <div className="ps-takes" role="group" aria-label={`Versions of ${fam.name}`}>
            {fam.takes.map((p) => (
              <button key={p.id} className={`ps-take ${p.id === look?.id ? 'on' : ''}`} aria-pressed={p.id === look?.id} disabled={busy} title={`${takeName(p)}: ${p.description}`} onClick={() => setPartsLook(parts, p.id)}>
                <span className="ps-thumb">
                  <Thumb p={p} />
                </span>
                <span className="ps-tn">{takeName(p)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="pp-sec pp-morewrap">
        <button className="pp-more" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
          <span className={`pp-caret ${moreOpen ? 'open' : ''}`} aria-hidden>
            ›
          </span>
          {moreOpen ? 'Fewer looks' : one ? 'More looks' : 'Swap the look'}
          {!moreOpen && <span className="pp-more-h">Every look, by how well it fits, with moods and a search</span>}
        </button>
        {moreOpen && <SwapList a={a} i={i} name={one ? names[i] : partList} busy={busy} onPick={(p) => setPartsLook(parts, p.id)} headingId={`${headingId}-swap`} bestFor={one ? 'this part' : names[i]} />}
      </div>

      <section className="pp-sec" aria-labelledby={`${headingId}-hand`}>
        <div className="ps-h">
          <h3 id={`${headingId}-hand`}>Hand-drawn</h3>
          <span>{hand === 'mixed' ? 'Mixed' : `The video is ${finishName(videoFinish).toLowerCase()}`}</span>
        </div>
        <div className="seg full" role="group" aria-label={`Hand-drawn in ${one ? names[i] : 'these parts'}`}>
          {HAND.map((o) => {
            const on = hand === o.v;
            return (
              <button key={o.label} className={on ? 'on' : ''} aria-pressed={on} disabled={busy} title={o.tip} onClick={() => setPartsHand(parts, o.v)}>
                {o.label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="pp-sec" aria-labelledby={`${headingId}-pop`}>
        <div className="ps-h">
          <h3 id={`${headingId}-pop`}>Pop-ups</h3>
          <span>{pops === 'mixed' ? 'Mixed' : planned === 'mixed' ? 'Auto differs by part' : `Auto here is ${planned === 0 ? 'none' : planned === 1 ? 'a few' : 'lots'}`}</span>
          <button
            className="btn sm ghost pp-shuffle"
            disabled={busy || popups === 'off'}
            onClick={() => reshufflePops(parts)}
            title={`Deal ${one ? 'this part' : 'these parts'} a different set of pop-ups. They stay the same every time it plays until you shuffle again.`}
          >
            <ShuffleIcon />
            Shuffle
          </button>
        </div>
        <div className="seg full" role="group" aria-label={`Pop-up windows in ${one ? names[i] : 'these parts'}`}>
          {POP_LEVELS.map((o) => {
            const on = pops === o.v;
            return (
              <button key={o.label} className={on ? 'on' : ''} aria-pressed={on} disabled={busy} title={o.tip} onClick={() => setPartsPops(parts, o.v)}>
                {o.label}
              </button>
            );
          })}
        </div>
        {popups === 'off' && <p className="pp-note">Pop-ups are switched off for the whole video (Video tab).</p>}
      </section>

      {synced && (
        <section className="pp-sec" aria-labelledby={`${headingId}-lyr`}>
          <div className="ps-h">
            <h3 id={`${headingId}-lyr`}>Lyrics</h3>
            {!sungParts.length ? <span>No words here</span> : medium === 'mixed' ? <span>Mixed</span> : !one && sungParts.length < parts.length ? <span>Parts with words only</span> : null}
          </div>
          {sungParts.length ? (
            <div className="seg grid2" role="group" aria-label={`How the lyrics show in ${one ? names[i] : 'these parts'}`}>
              {MEDIUM_CHOICES.filter((o) => o.m !== 'own' || ownOk || medium === 'own').map((o) => (
                <button key={o.m} className={medium === o.m ? 'on' : ''} aria-pressed={medium === o.m} disabled={busy} title={o.tip} onClick={() => setPartsLyric(sungParts, o.m as LyricMedium)}>
                  {o.label}
                </button>
              ))}
            </div>
          ) : (
            <p className="pp-note">No words are sung in {one ? 'this part' : 'these parts'}.</p>
          )}
          {sungParts.length > 0 && lyricStyle !== 'auto' && <p className="pp-note">Lyrics are set for the whole song right now. Picking a style here switches them to Auto.</p>}
        </section>
      )}

      {wordy && <WordsField key={`${parts.join(',')}|${words}`} parts={parts} value={words} disabled={busy} />}
    </div>
  );
}

/** a look built on the person's clips (the footage looks): styles and Shuffle stand in for takes */
function isFootage(p: Preset): boolean {
  return !!getScene(p.sceneId)?.usesClips;
}

/**
 * Change one of a look's scene settings for this video. The look on screen goes through setSceneParam
 * like any slider; a look that isn't on screen gets the same change in its tweak (state/tweaks.ts), which
 * is what setSceneParam would have kept. Either way it is one Undo step, and every part playing the look
 * shows it.
 */
function setLookParam(p: Preset, k: string, v: ParamValue) {
  const s = useStudio.getState();
  if (s.presetId === p.id) return s.setSceneParam(k, v);
  const orig = p.sceneParams?.[k] ?? getScene(p.sceneId)?.params.find((d) => d.id === k)?.default;
  const t = s.tweaks[p.id];
  const sceneParams = { ...t?.sceneParams };
  if (v === orig) delete sceneParams[k];
  else sceneParams[k] = v;
  const next: LookTweak = { ...t, sceneParams };
  if (!Object.keys(sceneParams).length) delete next.sceneParams;
  const tweaks = { ...s.tweaks };
  if (Object.keys(next).length) tweaks[p.id] = next;
  else delete tweaks[p.id];
  s.set({ tweaks });
}

/** the arrangements a footage look had before its last shuffles, by look id (Previous steps back) */
const seedsBefore = new Map<string, number[]>();

/**
 * A footage look's styles (Auto first) and Shuffle, which deals a new arrangement of the same style
 * (the `seed` setting), with Previous to go back one. Given `parts`, they are those parts' own
 * (store.partShot, FootagePicture.tsx ShotStyle) and no other shot changes. Without, as the phone's part
 * sheet still calls it, they are the look's, like any fine-tuning, so every part playing it changes.
 */
export function FootageControls({ look, busy, parts }: { look: Preset; busy: boolean; parts?: number[] }) {
  if (parts?.length) return <PartsFootage parts={parts} look={look} busy={busy} />;
  return <LookFootageControls look={look} busy={busy} />;
}

/** a footage part's own picture and style, as the phone's part sheet shows them */
function PartsFootage({ look, busy, parts }: { look: Preset; busy: boolean; parts: number[] }) {
  const t = usePartsTarget(parts, look);
  return <FootagePicture t={t} busy={busy} headingId={`ps-${parts.join('-')}`} />;
}

function LookFootageControls({ look, busy }: { look: Preset; busy: boolean }) {
  const tweak = useStudio((s) => s.tweaks[look.id]);
  const [, redraw] = useState(0);
  const styleDef = getScene(look.sceneId)?.params.find((d) => d.id === 'style');
  const styles = styleDef?.type === 'select' ? styleDef.options : [];
  const style = String(lookParam(look, tweak, 'style') ?? 'auto');
  const seed = Number(lookParam(look, tweak, 'seed') ?? 1);
  const before = seedsBefore.get(look.id) ?? [];
  const shuffle = () => {
    let next = seed;
    while (next === seed) next = 1 + Math.floor(Math.random() * 999);
    seedsBefore.set(look.id, [...before, seed].slice(-5));
    setLookParam(look, 'seed', next);
    redraw((n) => n + 1);
  };
  const previous = () => {
    const prev = before[before.length - 1];
    if (prev === undefined) return;
    seedsBefore.set(look.id, before.slice(0, -1));
    setLookParam(look, 'seed', prev);
    redraw((n) => n + 1);
  };
  return (
    <div className="pp-foot">
      {styles.length > 0 && (
        <div className="seg grid pp-styles" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }} role="group" aria-label="Footage style">
          {styles.map((o) => (
            <button
              key={o.value}
              className={style === o.value ? 'on' : ''}
              aria-pressed={style === o.value}
              disabled={busy}
              title={o.value === 'auto' ? 'A style picked for each part of the song' : `${o.label} in every part`}
              onClick={() => setLookParam(look, 'style', o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      <div className="pp-foot-row">
        <button className="btn sm" disabled={busy} onClick={shuffle} title="Lay the same style out another way">
          <ShuffleIcon />
          Shuffle
        </button>
        <button className="btn sm ghost" disabled={busy || !before.length} onClick={previous} title="Go back to the arrangement before the last shuffle">
          Previous
        </button>
        <span className="pp-foot-n" title="Which arrangement is playing (1 to 999)">
          No. {seed}
        </span>
      </div>
      <p className="pp-note">Style and Shuffle change every part that plays this look.</p>
    </div>
  );
}

/** the words a text look shows in these parts: saved when you press Enter or leave the field */
function WordsField({ parts, value, disabled }: { parts: number[]; value: string | 'mixed'; disabled: boolean }) {
  const [text, setText] = useState(value === 'mixed' ? '' : value);
  const save = () => {
    if (value !== 'mixed' && text.trim() === value) return;
    if (value === 'mixed' && !text.trim()) return;
    setPartsWords(parts, text);
  };
  return (
    <section className="pp-sec">
      <div className="ps-h">
        <h3>
          <label htmlFor="pp-words">Words</label>
        </h3>
        <span>{value === 'mixed' ? 'Different in each part' : value ? 'Yours' : 'From the song'}</span>
      </div>
      <div className="pp-words">
        <input
          id="pp-words"
          className="txt"
          type="text"
          maxLength={120}
          value={text}
          disabled={disabled}
          placeholder={value === 'mixed' ? 'Type to use the same words in all of them' : 'The lyrics or the song’s name'}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setText(value === 'mixed' ? '' : value);
              requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
            }
          }}
        />
        {(value === 'mixed' || value) && (
          <button className="btn sm ghost" disabled={disabled} onClick={() => setPartsWords(parts, null)} title="Go back to the words the look picks itself">
            Clear
          </button>
        )}
      </div>
      <p className="pp-note">This look writes words of its own. What you type here is what it shows in {parts.length > 1 ? 'these parts' : 'this part'}.</p>
    </section>
  );
}

/** the five looks that fit the part best, as pictures in a row: one click swaps (1–5 on the keyboard) */
function QuickPicks({ looks, busy, onPick }: { looks: Preset[]; busy: boolean; onPick: (p: Preset) => void }) {
  return (
    <section className="pp-quick" aria-label="Quick picks: looks that fit this part">
      <div className="ps-h">
        <h3>Quick picks</h3>
        <span>Click or press 1–5 to swap</span>
      </div>
      <div className="pp-qrow">
        {looks.map((p, k) => (
          <button key={p.id} className="pp-q" disabled={busy} onClick={() => onPick(p)} title={`${p.name}: ${p.description} (${k + 1})`} aria-label={`Use ${p.name} (${k + 1})`}>
            <span className="pp-qpic">
              <Thumb p={p} />
              <kbd>{k + 1}</kbd>
            </span>
            <span className="pp-qn">{p.name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M12 20s-7-4.4-9.2-8.7C1.3 8.2 3 4.8 6.4 4.4c2-.2 3.6.9 4.6 2.5 1-1.6 2.6-2.7 4.6-2.5 3.4.4 5.1 3.8 3.6 6.9C19 15.6 12 20 12 20z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
