/**
 * Undo and redo for everything a person edits about the video: the looks' tweaks (state/tweaks.ts),
 * the plan (swapped looks, splits and combines, lyrics), the per-part settings (hand-drawn, pop-ups,
 * words, a footage part's picture), the picture of a look playing on its own (soloShot) and the Video tab's settings (finish and its hand-drawn settings, pace, pop-ups, transition,
 * song colours, impact, lyrics style).
 *
 * Nothing else has to call this: it follows the store. When an edited field changes, a checkpoint is
 * taken once things have been still for STEP_MS, so a slider drag is one step. A step is a snapshot of
 * those fields; the store never mutates its values, so a snapshot only holds references (the plan is
 * shared between steps, never copied). Undo puts the previous snapshot back in one store change.
 *
 * What is NOT an edit, and never makes a step:
 *   - playback. The look on screen (presetId, sceneParams, effects…) is not tracked at all: a step
 *     holds the tweak table, and after an undo the look on screen is rebuilt from preset + tweaks. A
 *     take that carries its own hand-drawn settings changes `hand` while applyPreset runs: that is
 *     folded in silently (store.isApplyingLook).
 *   - a new song: loading one clears the history (its saved plan, parts and tweaks just arrive).
 *   - a plan appearing where there was none (a song's first video, one brought back by a reload).
 *   - the plan changing on its own: Claude's background plan taking over, a lyric plan for lyrics that
 *     arrived later. A plan change counts only when the person just did something (a click, a key, a
 *     drop within GESTURE_MS), Make / Remake video just finished, or the Director chat is answering
 *     them. Otherwise it is folded in silently.
 *
 * Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z and Cmd/Ctrl+Y redo, anywhere but in a text field (where the
 * browser's own undo keeps working).
 */
import type { Placed } from '../arrange/types';
import { audioEngine } from '../audio/engine';
import { finishName, isFinishId } from '../core/direction';
import { TRANSITIONS } from '../core/transitionList';
import type { PartShot, TrackAnalysis } from '../core/types';
import { STYLE_NAMES } from '../shot/styles';
import { findLook, partNames, sectionNames, type VideoPlan } from './plan';
import { duringRecut, keepPlan, originalOf } from './planCache';
import { isApplyingLook, isSoloQuiet, useStudio, type StudioState } from './store';
import { tweakParts, type LookTweak } from './tweaks';

/** changes closer together than this are one step */
const STEP_MS = 400;
const MAX_STEPS = 100;
/** a plan change this soon after a click, key or drop is the person's */
const GESTURE_MS = 1500;
/** a plan put on this soon after Make / Remake video finished planning is that remake */
const PLANNED_MS = 3000;

/** the fields a step keeps */
const FIELDS = [
  'tweaks',
  'plan',
  'analysis',
  'partHand',
  'partPops',
  'partWords',
  'partShot',
  'soloShot',
  'finish',
  'finishPicked',
  'hand',
  'pace',
  'popups',
  'windowKind',
  'transition',
  'transitionBeats',
  'songColors',
  'impact',
  'lyricStyle',
  'lyricStylePicked',
  'lyricFont',
  'drawTrash',
  'drawParts',
  'placed',
  'drawOverlay',
  'smoothSlow',
  'graphicsOff',
  'inkColors',
] as const satisfies readonly (keyof StudioState)[];
type Field = (typeof FIELDS)[number];
/** fields that also change on their own (a plan arriving, a re-cut): only counted with intent */
const PLAN_FIELDS = new Set<Field>(['plan', 'analysis', 'partHand', 'partPops', 'partWords', 'partShot']);

type Values = Pick<StudioState, Field>;
interface Step extends Values {
  /** what changed to make this step, in a few plain words ("swapped Drop to Tunnel Vision") */
  label: string;
}

function take(s: StudioState): Values {
  const v = {} as Record<Field, unknown>;
  for (const f of FIELDS) v[f] = s[f];
  return v as Values;
}

function same(a: Values, b: Values): boolean {
  return FIELDS.every((f) => a[f] === b[f]);
}

/** which song the history is about: a different one starts it over */
function songOf(s: StudioState): { name: string; a: TrackAnalysis | null } {
  return { name: s.track?.name ?? '', a: s.analysis ? originalOf(s.analysis) : null };
}

let past: Step[] = [];
let future: Step[] = [];
/** the state as of the last step (or the start) */
let present: Step | null = null;
/** the tracked values at the last store change seen, to tell which fields a change touched */
let seen: Values | null = null;
let song: { name: string; a: TrackAnalysis | null } = { name: '', a: null };
/** an edit is waiting for things to go still */
let pending = 0;
/** an undo or redo is being put back: not an edit */
let restoring = false;

let lastGesture = -1e9;
let plannedAt = -1e9;
let wasPlanning = false;

const now = () => performance.now();

/** did the person just ask for a change to the plan? */
function intent(s: StudioState): boolean {
  const t = now();
  if (t - lastGesture < GESTURE_MS || t - plannedAt < PLANNED_MS) return true;
  // the Director chat: the person asked, and the answer is on its way (or just came)
  const last = s.chat[s.chat.length - 1];
  const before = s.chat[s.chat.length - 2];
  if (last?.role === 'user' && Date.now() - last.at < 120_000) return true;
  return last?.role === 'director' && before?.role === 'user' && Date.now() - last.at < 2000;
}

function startOver(s: StudioState) {
  clearTimeout(pending);
  pending = 0;
  past = [];
  future = [];
  present = { ...take(s), label: '' };
  seen = take(s);
  song = songOf(s);
  changed();
}

/** the change made next is one the person asked for a moment ago (an answer from Claude arriving): it makes a step */
export function askedFor() {
  if (pending) checkpoint();
  plannedAt = now();
}

/** what is on now is where history starts (a project was opened: none of it is an edit) */
export function forgetHistory() {
  startOver(useStudio.getState());
}

function follow() {
  if (restoring) return;
  const s = useStudio.getState();
  if (wasPlanning && !s.planning) plannedAt = now();
  wasPlanning = s.planning;
  const sg = songOf(s);
  if (!present || !seen || sg.name !== song.name || sg.a !== song.a) return startOver(s);
  const cur = take(s);
  let edited = false;
  for (const f of FIELDS) {
    if (cur[f] === seen[f]) continue;
    const folded =
      // a take's own hand-drawn settings coming on with it (playback)
      (f === 'hand' && isApplyingLook()) ||
      // the look's own picture cleared because another scene came on, or brought back after a reload
      (f === 'soloShot' && isSoloQuiet()) ||
      // a song's first video (or one brought back), and the plan changing on its own
      (PLAN_FIELDS.has(f) && (!seen.plan || !intent(s)));
    if (folded) (present as Record<Field, unknown>)[f] = cur[f];
    else edited = true;
  }
  seen = cur;
  if (!edited) return;
  clearTimeout(pending);
  pending = window.setTimeout(checkpoint, STEP_MS);
  changed();
}

/** make the waiting edit a step now */
function checkpoint() {
  clearTimeout(pending);
  pending = 0;
  if (!present) return;
  const s = useStudio.getState();
  const next = take(s);
  if (same(present, next)) return changed();
  past.push(present);
  if (past.length > MAX_STEPS) past.shift();
  present = { ...next, label: describe(present, next) };
  future = [];
  changed();
}

/** put a step's values back in one store change; the look on screen is rebuilt from preset + tweaks */
function restore(to: Values) {
  const s = useStudio.getState();
  const patch: Partial<StudioState> = {};
  for (const f of FIELDS) if (s[f] !== to[f]) (patch as Record<Field, unknown>)[f] = to[f];
  if (!Object.keys(patch).length) return;
  const n = (to.analysis ?? s.analysis)?.sections.length ?? 0;
  if ('plan' in patch || 'analysis' in patch) {
    patch.selectedParts = s.selectedParts.filter((i) => i < n);
    if (to.plan) Object.assign(patch, { planOn: true, autoPilot: false });
  }
  const lookChanged = 'tweaks' in patch && !!s.presetId && s.tweaks[s.presetId] !== to.tweaks[s.presetId];
  restoring = true;
  try {
    if ('analysis' in patch && to.analysis) {
      // a split or combine taken back: the old parts come back with everything indexed by them
      duringRecut(() => {
        audioEngine.setAnalysis(to.analysis);
        s.set(patch);
      });
    } else s.set(patch);
    if (to.plan && 'plan' in patch) keepPlan(to.plan);
    if (lookChanged) useStudio.getState().reapplyLook();
  } finally {
    restoring = false;
  }
  seen = take(useStudio.getState());
}

export function undo() {
  if (pending) checkpoint();
  const prev = past.pop();
  if (!prev || !present) return;
  const label = present.label;
  future.push(present);
  present = prev;
  restore(prev);
  changed();
  useStudio.getState().flash(`Undone: ${label}`);
}

export function redo() {
  if (pending) checkpoint();
  const next = future.pop();
  if (!next || !present) return;
  past.push(present);
  present = next;
  restore(next);
  changed();
  useStudio.getState().flash(`Redone: ${next.label}`);
}

/* ───────── for buttons ───────── */

export interface HistoryLabels {
  /** what Undo takes back, or null when there's nothing */
  undo: string | null;
  redo: string | null;
}
let labels: HistoryLabels = { undo: null, redo: null };
const subs = new Set<() => void>();

function changed() {
  let u: string | null = null;
  if (pending && present) u = describe(present, take(useStudio.getState()));
  else if (past.length && present) u = present.label;
  const r = future.length ? future[future.length - 1].label : null;
  if (u === labels.undo && r === labels.redo) return;
  labels = { undo: u, redo: r };
  subs.forEach((f) => f());
}

/** for useSyncExternalStore: call `f` whenever what Undo / Redo would do changes */
export function onHistoryChange(f: () => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

/** how many steps there are to undo and redo (for checks and the Part panel) */
export function historyDepth(): { undo: number; redo: number } {
  return { undo: past.length + (pending ? 1 : 0), redo: future.length };
}

/** what Undo and Redo would do now (the same object until that changes) */
export function historyLabels(): HistoryLabels {
  return labels;
}

/* ───────── labels: what changed between two snapshots ───────── */

const PACE: Record<string, string> = { slow: 'Slow', song: 'Normal', fast: 'Fast' };
const POPUPS: Record<string, string> = { off: 'Off', video: 'In videos', always: 'Always' };
const COLOURS: Record<string, string> = { off: 'Off', blend: 'Blend', match: 'Match' };
const LYRICS: Record<string, string> = { auto: 'Auto', subtitle: 'Subtitles', big: 'Big', cutout: 'Collage', off: 'Off' };

/** "Verse 1", "Verse 1 and Chorus", "3 parts" */
function partList(is: number[], names: string[]): string {
  if (is.length > 2) return `${is.length} parts`;
  return is.map((i) => names[i] ?? 'a part').join(' and ');
}

/** indices where two per-part arrays differ */
function diffAt<T>(a: (T | null)[] | null, b: (T | null)[] | null, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) if ((a?.[i] ?? null) !== (b?.[i] ?? null)) out.push(i);
  return out;
}

/** parts whose footage picture record differs (records are replaced, never mutated, but compare by value) */
function diffShots(a: (PartShot | null)[] | null, b: (PartShot | null)[] | null, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (JSON.stringify(a?.[i] ?? null) !== JSON.stringify(b?.[i] ?? null)) out.push(i);
  return out;
}

const TREATMENTS: Record<string, string> = { none: 'None', mosh: 'Mosh', sort: 'Sort', cells: 'Cells', readout: 'Readout', collage: 'Collage', trace: 'Trace' };

/** what changed in one part's picture: "style Poster", "shuffled", "picture changed", "framing" */
function shotLabel(was: PartShot | null, is: PartShot | null): string {
  if (!is) return 'picture back to the look';
  const w = was ?? {};
  const what: string[] = [];
  if (w.style !== is.style) what.push(`style ${is.style ? (STYLE_NAMES[is.style as keyof typeof STYLE_NAMES] ?? is.style) : 'Auto'}`);
  if (w.seed !== is.seed) what.push(is.seed ? `arrangement ${is.seed}` : 'arrangement as the look');
  if (w.treatment !== is.treatment) what.push(`treatment ${is.treatment ? (TREATMENTS[is.treatment] ?? is.treatment) : 'as the look'}`);
  if (w.motion !== is.motion) what.push(`motion ${is.motion ?? 'as the look'}`);
  if (JSON.stringify(w.media ?? null) !== JSON.stringify(is.media ?? null)) what.push(is.media?.length ? 'picture changed' : 'picture automatic');
  if (w.focusX !== is.focusX || w.focusY !== is.focusY || w.zoom !== is.zoom) what.push('framing');
  if (JSON.stringify(w.drawn ?? null) !== JSON.stringify(is.drawn ?? null) || ('drawn' in w) !== ('drawn' in is)) what.push(is.drawn ? 'drawing placed' : 'drawing taken out');
  return what.length ? what.join(', ') : 'picture changed';
}

function tweakLabel(id: string, was: LookTweak | undefined, is: LookTweak | undefined): string {
  const name = findLook(id)?.name ?? 'the look';
  if (!is) return `reset ${name} to the original`;
  const pa = tweakParts(was);
  const pb = tweakParts(is);
  const j = (x: unknown) => JSON.stringify(x ?? null);
  const what: string[] = [];
  if (pa.params !== pb.params || j(was?.sceneParams) !== j(is.sceneParams)) what.push('sliders');
  if (pa.fx !== pb.fx || j(was?.effects) !== j(is.effects)) what.push('effects');
  if (pa.colours !== pb.colours || j(was?.palette) !== j(is.palette)) what.push('colours');
  if (pa.sound !== pb.sound || j(was?.modulations) !== j(is.modulations)) what.push('sound links');
  return `${name}: ${what.length ? what.join(' and ') : 'fine-tuned'}`;
}

function describe(a: Values, b: Values): string {
  const out: string[] = [];
  const an = a.analysis;
  const bn = b.analysis;
  const namesA = an ? sectionNames(an.sections) : [];
  const namesB = bn ? sectionNames(bn.sections) : [];
  const n = bn?.sections.length ?? 0;
  // the parts themselves: a split or a combine
  if (an && bn && an.sections.length !== bn.sections.length) {
    const i = bn.sections.findIndex((sec, k) => Math.abs(sec.end - (an.sections[k]?.end ?? -1)) > 0.001);
    if (bn.sections.length > an.sections.length) out.push(`split ${namesA[Math.max(0, i)] ?? 'a part'}`);
    else {
      const k = Math.max(0, i);
      let last = k;
      while (last < an.sections.length - 1 && Math.abs(an.sections[last].end - bn.sections[k].end) > 0.001) last++;
      out.push(`combined ${namesA[k]} and ${last - k > 1 ? `${last - k} more` : namesA[last]}`);
    }
  } else if (a.plan !== b.plan && a.plan && b.plan) {
    const pa = a.plan;
    const pb = b.plan;
    if (pa.base && pb.base && pa.base.looks !== pb.base.looks) out.push('remade the video');
    else {
      const looks = diffAt(pa.looks, pb.looks, pb.looks.length);
      if (looks.length) {
        const ids = new Set(looks.map((i) => pb.looks[i]));
        const look = ids.size === 1 ? findLook(pb.looks[looks[0]])?.name : null;
        out.push(look ? `swapped ${partList(looks, namesB)} to ${look}` : `swapped the looks in ${partList(looks, namesB)}`);
      } else if (pa.lyricPlan !== pb.lyricPlan && planLabel(pa, pb, bn) === CHANGED) {
        const lp = diffAt(
          pa.lyricPlan?.parts.map((p) => p?.medium ?? null) ?? null,
          pb.lyricPlan?.parts.map((p) => p?.medium ?? null) ?? null,
          n,
        );
        out.push(lp.length ? `lyrics for ${partList(lp, namesB)}` : 'changed the lyrics');
      } else out.push(planLabel(pa, pb, bn));
    }
  }
  if (a.partHand !== b.partHand && an === bn) {
    const is = diffAt(a.partHand, b.partHand, n);
    if (is.length) {
      const v = b.partHand?.[is[0]] ?? null;
      out.push(`Hand-drawn ${v === null ? 'as the video' : v ? 'on' : 'off'} for ${partList(is, namesB)}`);
    }
  }
  if (a.partPops !== b.partPops && an === bn) {
    const is = diffAt(a.partPops, b.partPops, n);
    if (is.length) out.push(`pop-ups for ${partList(is, namesB)}`);
  }
  if (a.partWords !== b.partWords && an === bn) {
    const is = diffAt(a.partWords, b.partWords, n);
    if (is.length) out.push(`words for ${partList(is, namesB)}`);
  }
  if (a.partShot !== b.partShot && an === bn) {
    const is = diffShots(a.partShot, b.partShot, n);
    // by shot ("Drop, shot 2"): a picture is chosen per shot, so the section's name alone is not enough
    if (is.length) out.push(`${partList(is, partNames(bn!))}: ${shotLabel(a.partShot?.[is[0]] ?? null, b.partShot?.[is[0]] ?? null)}`);
  }
  if (a.soloShot !== b.soloShot) out.push(`the look's ${shotLabel(a.soloShot, b.soloShot).replace('picture back to the look', 'picture back to automatic')}`);
  if (a.tweaks !== b.tweaks) {
    const ids = [...new Set([...Object.keys(a.tweaks), ...Object.keys(b.tweaks)])].filter((id) => JSON.stringify(a.tweaks[id] ?? null) !== JSON.stringify(b.tweaks[id] ?? null));
    if (ids.length) out.push(tweakLabel(ids[0], a.tweaks[ids[0]], b.tweaks[ids[0]]));
  }
  if (a.finish !== b.finish) out.push(`Finish: ${b.finish === 'auto' ? 'Auto' : isFinishId(b.finish) ? finishName(b.finish) : b.finish}`);
  // a finish picked turns hand-drawn on or off with it: one change, named once
  else if (a.hand !== b.hand) out.push(a.hand.on !== b.hand.on ? `Hand-drawn ${b.hand.on ? 'on' : 'off'}` : 'hand-drawn settings');
  if (a.pace !== b.pace) out.push(`Pace: ${PACE[b.pace] ?? b.pace}`);
  if (a.popups !== b.popups) out.push(`Pop-ups: ${POPUPS[b.popups] ?? b.popups}`);
  if (a.windowKind !== b.windowKind) out.push('what the windows show');
  if (a.transition !== b.transition) out.push(`Transition: ${b.transition === 'auto' ? 'Auto' : (TRANSITIONS.find((t) => t.id === b.transition)?.name ?? b.transition)}`);
  if (a.transitionBeats !== b.transitionBeats) out.push('transition length');
  if (a.songColors !== b.songColors) out.push(`Song colours: ${COLOURS[b.songColors] ?? b.songColors}`);
  if (a.impact !== b.impact) out.push(`Impact ${Math.round(b.impact * 100)}%`);
  if (a.lyricStyle !== b.lyricStyle && !out.some((x) => x.startsWith('lyrics for'))) out.push(`Lyrics: ${LYRICS[b.lyricStyle] ?? b.lyricStyle}`);
  if (a.lyricFont !== b.lyricFont) out.push('lyrics font');
  if (a.drawTrash !== b.drawTrash) out.push(b.drawTrash.length > a.drawTrash.length ? (b.drawTrash.length - a.drawTrash.length > 1 ? 'deleted drawings' : 'deleted a drawing') : 'brought back a drawing');
  if (a.drawParts !== b.drawParts) out.push('the drawings in a part');
  if (a.placed !== b.placed && a.partPops === b.partPops && !out.length) out.push(placedLabel(a.placed, b.placed));
  if (a.smoothSlow !== b.smoothSlow) out.push(`Smooth slow motion ${b.smoothSlow ? 'on' : 'off'}`);
  if (a.inkColors !== b.inkColors) out.push('ink colours');
  if (a.graphicsOff !== b.graphicsOff) out.push('what may cover the picture');
  if (a.drawOverlay !== b.drawOverlay) out.push(`Drawings beside the words ${b.drawOverlay ? 'on' : 'off'}`);
  if (!out.length) return 'a change';
  return out.length > 2 ? `${out[0]} and ${out.length - 1} more` : out.join(' and ');
}

/** parts kept or let go, a part shown another way, or anything else about the plan */
const CHANGED = 'changed the video';
function planLabel(a: VideoPlan, b: VideoPlan, an: TrackAnalysis | null): string {
  const n = b.looks.length;
  const names = an ? partNames(an) : [];
  const shots = diffShots(a.shots ?? null, b.shots ?? null, n);
  const kept = diffAt(a.kept ?? null, b.kept ?? null, n).filter((i) => !!a.kept?.[i] !== !!b.kept?.[i]);
  if (kept.length) return `${b.kept?.[kept[0]] ? 'kept' : 'let go of'} ${partList(kept, names)}`;
  return shots.length ? `${partList(shots, names)} shown another way` : CHANGED;
}

/** what was placed, moved or taken away by hand */
function placedLabel(a: Placed, b: Placed): string {
  if (a.drawings !== b.drawings) return b.drawings.length > a.drawings.length ? 'placed a drawing' : b.drawings.length < a.drawings.length ? 'took a drawing out' : 'moved a drawing';
  if (a.hidden !== b.hidden) return 'took a drawing out';
  const n = (p: Placed) => p.pops.reduce((k, s) => k + s.wins.length, 0);
  if (a.pops.length === b.pops.length && n(a) !== n(b)) return n(b) > n(a) ? 'added a pop-up' : 'took a pop-up out';
  return 'moved a pop-up';
}

/* ───────── wiring: the store, gestures, the keyboard ───────── */

useStudio.subscribe(follow);
startOver(useStudio.getState());

if (typeof window !== 'undefined') {
  const gesture = () => {
    lastGesture = now();
  };
  for (const ev of ['pointerdown', 'pointerup', 'keydown', 'input', 'change', 'drop'] as const) window.addEventListener(ev, gesture, { capture: true, passive: true });

  /** a field where typing happens: the browser's own undo belongs there */
  const typing = (el: EventTarget | null) => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    const type = (el as HTMLInputElement).type;
    return !['range', 'checkbox', 'radio', 'color', 'button', 'submit', 'file'].includes(type);
  };
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || typing(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (k === 'y' && !e.shiftKey) {
      e.preventDefault();
      redo();
    }
  });
}
