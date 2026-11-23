/**
 * The Part tab of the right panel: everything about the part (or parts) picked on the timeline, or
 * the part that is playing when nothing is picked; with no video plan, a line about the look on screen.
 *
 *   name, time, length     Play this part, Reset, Undo
 *   Look                   its picture and name, and its other takes (versions)
 *   Swap the look          the looks that fit this part best, More looks… with a search (PartSheet.tsx)
 *   Hand-drawn             As the video / On / Off, for these parts only
 *   Pop-ups                Auto / Off / Few / Lots
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
import { onUndoChange, playPart, resetParts, setPartsHand, setPartsLook, setPartsLyric, setPartsPops, setPartsWords, undoLabel, undoPartEdit } from '../state/partEdit';
import { findLook, listNames, makeVideo, partEdits, popsOf, sectionIndexAt, sectionNames, validPlan } from '../state/plan';
import { useStudio } from '../state/store';
import { audioEngine } from '../audio/engine';
import { Play } from './Icons';
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
  const look = findLook(presetId);
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

function PartBody({ a, parts, picked }: { a: TrackAnalysis; parts: number[]; picked: boolean }) {
  const plan = useStudio((s) => s.plan)!;
  const lyrics = useStudio((s) => s.lyrics);
  const lyricStyle = useStudio((s) => s.lyricStyle);
  const popups = useStudio((s) => s.popups);
  const partPops = useStudio((s) => s.partPops);
  const partHand = useStudio((s) => s.partHand);
  const partWords = useStudio((s) => s.partWords);
  const videoFinish = useStudio((s) => activeFinish(s));
  const busy = useStudio((s) => !!s.clip);
  const undoText = useSyncExternalStore(onUndoChange, undoLabel);
  const n = a.sections.length;
  const one = parts.length === 1;
  const i = parts[0];
  const names = sectionNames(a.sections);
  const name = one ? names[i] : `${parts.length} parts selected`;
  const partList = listNames(parts.map((j) => names[j]));
  const { look, fam } = useRankedLooks(a, i, 'all');
  const edits = partEdits(plan, a, partPops, partHand, partWords);
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

  const changedWhat = one && edits[i] ? [edits[i]!.look && 'look', edits[i]!.lyric && 'lyrics', edits[i]!.pops && 'pop-ups', edits[i]!.hand && 'hand-drawn', edits[i]!.words && 'words'].filter(Boolean).join(', ') : '';
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
            {one ? `${fmtTime(a.sections[i].start)}–${fmtTime(a.sections[i].end)} · ${Math.round(len)} s` : `${partList} · ${Math.round(len)} s in all`}
            {!picked && ' · playing now'}
          </span>
        </div>
      </div>

      <div className="pp-actions">
        <button className="btn sm" onClick={() => playPart(i)} disabled={busy} title={`Jump to ${names[i]} and play it`}>
          <Play width={11} height={11} />
          {one ? 'Play this part' : `Play from ${names[i]}`}
        </button>
        {anyEdit && (
          <button className="btn sm ghost" onClick={() => resetParts(parts)} disabled={busy} title={one ? 'Put back what the plan picked for this part' : 'Put back what the plan picked for these parts'}>
            {one ? 'Reset this part' : 'Reset these parts'}
          </button>
        )}
        {undoText && (
          <button className="btn sm ghost" onClick={undoPartEdit} disabled={busy} title={`Undo ${undoText}`}>
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
        {sameLook !== 'mixed' && fam && fam.takes.length > 1 && (
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

      <SwapList a={a} i={i} name={one ? names[i] : partList} busy={busy} onPick={(p) => setPartsLook(parts, p.id)} headingId={`${headingId}-swap`} bestFor={one ? 'this part' : names[i]} />

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
