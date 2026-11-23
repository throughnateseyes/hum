/**
 * Changing parts of the video by hand (the Part tab, src/ui/PartPanel.tsx, the timeline and its menu,
 * src/ui/Timeline.tsx, and on phones the part sheet, src/ui/PartSheet.tsx): a part's look, its version
 * (another take of the same family), its lyric style, its pop-ups, whether it is hand-drawn and the
 * words a text look shows in it. Every change can take several parts at once (the parts picked on the
 * timeline), and the parts themselves can be split and combined.
 *
 * Looks and lyric styles land in the plan itself, so the sequencer, scrubbing and renders read them
 * like any other plan, and the timeline shows them at once. Pop-up levels, hand-drawn and words go to
 * the store (partPops, partHand, partWords), outside the plan, so they outlast re-plans; they are kept
 * per song in planCache.ts. The plan's `base` (what the planner chose) tells a changed part from a
 * planned one: a re-plan keeps the changes (plan.ts keepEdits), "Reset this part" puts the planner's
 * pick back, and Undo steps back through the last few changes (splits and combines included). A plan
 * changed here is saved for the song (planCache.keepPlan), whoever planned it.
 *
 * Split and combine re-cut the song's parts (analysis.sections) and re-index every per-part setting in
 * the same step (plan.ts recutParts); the plan keeps the new part lines as `bounds`, so a re-plan, the
 * plan cache and a reload all find them again.
 */
import { audioEngine } from '../audio/engine';
import type { TrackAnalysis } from '../core/types';
import { rememberTake } from '../presets/fit';
import { localLyricPlan, type LyricMedium } from './lyricPlan';
import { assignLook, ensureDropCuts, findLook, listNames, partEdits, partNames, recutParts, releaseHold, sectionIndexAt, snapToBeat, validPlan, withBase, type Recut, type VideoPlan } from './plan';
import { replacementFor, shotEdits } from './flatPlan';
import { boundsOf, duringRecut, keepPlan, originalOf } from './planCache';
import { isScrubbing } from './scrub';
import { useStudio } from './store';
import { noteHandPick, record } from './taste';

/** everything a change here can touch, as it was before the change (same song only) */
interface Snapshot {
  plan: VideoPlan | null;
  analysis: TrackAnalysis;
  partPops: (number | null)[] | null;
  partHand: (boolean | null)[] | null;
  partWords: (string | null)[] | null;
  selectedParts: number[];
  what: string;
}
const undo: Snapshot[] = [];
const UNDO_MAX = 20;
function pushUndo(what: string) {
  const s = useStudio.getState();
  if (!s.analysis) return;
  undo.push({ plan: s.plan, analysis: s.analysis, partPops: s.partPops, partHand: s.partHand, partWords: s.partWords, selectedParts: s.selectedParts, what });
  if (undo.length > UNDO_MAX) undo.shift();
}
const undoSubs = new Set<() => void>();
const changed = () => undoSubs.forEach((f) => f());

export function onUndoChange(f: () => void): () => void {
  undoSubs.add(f);
  return () => undoSubs.delete(f);
}

/** what Undo would take back (null when there's nothing for this song) */
export function undoLabel(): string | null {
  const a = useStudio.getState().analysis;
  const top = undo[undo.length - 1];
  return top && a && originalOf(top.analysis) === originalOf(a) ? top.what : null;
}

/** the playing plan for this song, with a base to tell changes by (null without one) */
function current(): { plan: VideoPlan; a: TrackAnalysis } | null {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a || !validPlan(s.plan, a)) return null;
  return { plan: withBase(s.plan, a), a };
}

/** the parts that exist, in order, without repeats */
function partsIn(is: number[], a: TrackAnalysis): number[] {
  return [...new Set(is)].filter((i) => Number.isInteger(i) && i >= 0 && i < a.sections.length).sort((x, y) => x - y);
}

/** "Verse 1", "Drop, shot 2 and Drop, shot 3", "3 parts" */
function partsName(is: number[], a: TrackAnalysis): string {
  const names = partNames(a);
  return is.length > 3 ? `${is.length} parts` : listNames(is.map((i) => names[i]));
}

/** put a changed plan on (the timeline follows it from now on) and save it for the song */
function commit(next: VideoPlan, what: string) {
  pushUndo(what);
  const s = useStudio.getState();
  s.set({ plan: next, planOn: true, autoPilot: false });
  keepPlan(next);
  changed();
}

/** one value per part, with `v` in parts `is` (null when no part has one left) */
function withValue<T>(arr: (T | null)[] | null, n: number, is: number[], v: T | null): (T | null)[] | null {
  const next = arr && arr.length === n ? [...arr] : Array.from({ length: n }, () => null as T | null);
  for (const i of is) next[i] = v;
  return next.some((x) => x !== null) ? next : null;
}

/* ───────── looks ───────── */

/** parts `is` play this look (a new look or another take of their own); no plan yet → a timeline starts from it */
export function setPartsLook(is: number[], id: string) {
  const s = useStudio.getState();
  const a = s.analysis;
  const look = findLook(id);
  if (!a || !look) return;
  const parts = partsIn(is, a);
  if (!parts.length) return;
  noteHandPick(look, 'place', a.sections[parts[0]].label);
  rememberTake(look);
  const cur = current();
  if (!cur) {
    // like dropping a look on a part: the map starts here and the empty parts take it too
    assignLook(parts[0], id, false);
    const now = useStudio.getState();
    if (now.plan) {
      const plan = withBase(now.plan, a);
      now.set({ plan });
      keepPlan(plan);
    }
    if (parts.length > 1) setPartsLook(parts.slice(1), id);
    return;
  }
  const { plan } = cur;
  const todo = parts.filter((i) => plan.looks[i] !== id);
  if (!todo.length) return;
  const looks = [...plan.looks];
  const rotate = a.sections.map((_, j) => plan.rotate?.[j] ?? null);
  const liked = plan.liked ? [...plan.liked] : undefined;
  for (const i of todo) {
    looks[i] = id;
    // a new main look gets a fresh rotation around it (the planner's own pick gets its own rotation back)
    rotate[i] = plan.base?.looks[i] === id ? plan.base.rotate[i] : null;
    // a like was for the look that was there
    if (liked) liked[i] = false;
  }
  // the parts you set stay as you set them; strong drops elsewhere still get their cut
  const next = ensureDropCuts({ ...plan, looks, rotate, ...(liked ? { liked } : {}) }, a, parts);
  releaseHold();
  const name = partsName(todo, a);
  commit(next, `${name}: ${look.name}`);
  s.flash(`${name} now ${todo.length > 1 ? 'use' : 'uses'} “${look.name}”`);
}

/** part i plays this look */
export function setPartLook(i: number, id: string) {
  setPartsLook([i], id);
}

/* ───────── lyrics ───────── */

/** how parts `is` show their lyrics (the lyric plan's medium for them; parts with no words are left alone) */
export function setPartsLyric(is: number[], medium: LyricMedium) {
  const s = useStudio.getState();
  const cur = current();
  const lyr = s.lyrics;
  if (!cur || !lyr?.synced || !lyr.lines.length) return;
  const { plan, a } = cur;
  let base = plan.base!;
  let lp = plan.lyricPlan;
  if (!lp) {
    // a plan made before the lyrics arrived: make its lyric plan now, as the base the change is told by
    lp = localLyricPlan(a, lyr, (Math.random() * 2 ** 31) | 0);
    base = { ...base, lyric: lp.parts.map((p) => p?.medium ?? null) };
  }
  const parts = [...lp.parts];
  const todo = partsIn(is, a).filter((i) => parts[i] && parts[i]!.medium !== medium);
  if (!todo.length) return;
  for (const i of todo) parts[i] = { ...parts[i]!, medium, why: 'your pick' };
  const next = { ...plan, base, lyricPlan: { ...lp, parts } };
  const name = partsName(todo, a);
  commit(next, `${name} lyrics`);
  // the per-part styles only show while lyrics are on Auto
  if (s.lyricStyle !== 'auto') {
    s.set({ lyricStyle: 'auto', lyricStylePicked: true });
    s.flash(`Lyrics switched to Auto so ${name} can have ${todo.length > 1 ? 'their' : 'its'} own style`);
  }
}

export function setPartLyric(i: number, medium: LyricMedium) {
  setPartsLyric([i], medium);
}

/* ───────── pop-ups, hand-drawn, words (kept in the store, outside the plan) ───────── */

/** a per-part store setting changed: one Undo step, the plan switched on so it shows */
function setStored<K extends 'partPops' | 'partHand' | 'partWords'>(key: K, is: number[], v: NonNullable<ReturnType<typeof useStudio.getState>[K]>[number], what: string, flash?: string) {
  const s = useStudio.getState();
  const cur = current();
  if (!cur) return;
  const parts = partsIn(is, cur.a);
  const n = cur.a.sections.length;
  const arr = s[key] as unknown[] | null;
  if (!parts.length || parts.every((i) => (arr?.length === n ? (arr[i] ?? null) : null) === v)) return;
  pushUndo(`${partsName(parts, cur.a)} ${what}`);
  s.set({ [key]: withValue(arr, n, parts, v) } as Partial<ReturnType<typeof useStudio.getState>>);
  if (!useStudio.getState().planOn) useStudio.getState().set({ planOn: true, autoPilot: false });
  if (flash) s.flash(flash.replace('$', partsName(parts, cur.a)));
  changed();
}

/**
 * parts `is`' pop-ups: 0 off, 1 a few, 3 lots, null back to the planner's (store.partPops, outside the
 * plan, so it outlasts re-plans, and saved for the song)
 */
export function setPartsPops(is: number[], level: number | null) {
  const v = level === null || !Number.isFinite(level) ? null : Math.max(0, Math.min(3, Math.round(level)));
  setStored('partPops', is, v, 'pop-ups');
}

export function setPartPopsLevel(i: number, level: number | null) {
  setPartsPops([i], level);
}

/** parts `is` drawn by hand (true), kept clean of it (false), or as the whole video is set (null) */
export function setPartsHand(is: number[], v: boolean | null) {
  setStored('partHand', is, v, 'hand-drawn', v === null ? '$: hand-drawn as the video' : v ? '$: hand-drawn on' : '$: hand-drawn off');
}

/** the words a text look shows in parts `is` ('' or null: its own words again) */
export function setPartsWords(is: number[], text: string | null) {
  const v = text?.replace(/\s+/g, ' ').trim().slice(0, 120) || null;
  setStored('partWords', is, v, 'words');
}

/* ───────── reset and undo ───────── */

/** put the planner's own picks back into parts `is` (looks, lyrics, pop-ups, hand-drawn and words) */
export function resetParts(is: number[]) {
  const s = useStudio.getState();
  const cur = current();
  if (!cur) return;
  const { plan, a } = cur;
  const parts = partsIn(is, a);
  if (!parts.length) return;
  const b = plan.base!;
  const looks = [...plan.looks];
  const rotate = a.sections.map((_, j) => plan.rotate?.[j] ?? null);
  let lyricPlan = plan.lyricPlan;
  const liked = plan.liked ? plan.liked.map((v, j) => v && !parts.includes(j)) : undefined;
  for (const i of parts) {
    if (!b.looks[i] || findLook(b.looks[i])) {
      looks[i] = b.looks[i];
      rotate[i] = b.rotate[i];
    }
    const was = b.lyric[i];
    if (lyricPlan?.parts[i] && was) {
      const lp = [...lyricPlan.parts];
      lp[i] = { ...lp[i]!, medium: was, why: '' };
      lyricPlan = { ...lyricPlan, parts: lp };
    }
  }
  let next = ensureDropCuts({ ...plan, looks, rotate, ...(lyricPlan ? { lyricPlan } : {}), ...(liked ? { liked } : {}) }, a, parts);
  // pop-ups, hand-drawn and words go back too (one Undo step with the rest)
  const n = a.sections.length;
  const partPops = withValue(s.partPops, n, parts, null);
  const partHand = withValue(s.partHand, n, parts, null);
  const partWords = withValue(s.partWords, n, parts, null);
  // the plan's "kept your changes" line goes once nothing is changed any more
  if (partEdits(next, a, partPops, partHand, partWords).every((e) => !e)) next = { ...next, note: next.note.replace(/ Kept your changes to [^.]*\.$/, '') };
  const name = partsName(parts, a);
  commit(next, `reset ${name}`);
  s.set({ partPops, partHand, partWords });
  s.flash(`${name} ${parts.length > 1 ? 'are' : 'is'} back to the plan`);
}

export function resetPart(i: number) {
  resetParts([i]);
}

/** take back the last change made here (a split or combine puts the old parts back too) */
export function undoPartEdit() {
  const s = useStudio.getState();
  const top = undo[undo.length - 1];
  if (!top || !s.analysis || originalOf(top.analysis) !== originalOf(s.analysis)) return;
  undo.pop();
  duringRecut(() => {
    if (top.analysis !== s.analysis) audioEngine.setAnalysis(top.analysis);
    s.set({
      analysis: top.analysis,
      plan: top.plan,
      partPops: top.partPops,
      partHand: top.partHand,
      partWords: top.partWords,
      selectedParts: top.selectedParts,
      ...(top.plan ? { planOn: true, autoPilot: false } : {}),
    });
  });
  if (top.plan) keepPlan(top.plan);
  s.flash(`Undid ${top.what}`);
  changed();
}

/* ───────── split and combine ───────── */

/** a part shorter than this can't be made by a split */
export const MIN_PART_S = 1;

/** put a re-cut on: the new parts, the re-indexed plan and settings, in one store change and one Undo step */
function applyRecut(r: Recut, what: string, selected: number[]) {
  const s = useStudio.getState();
  pushUndo(what);
  duringRecut(() => {
    audioEngine.setAnalysis(r.analysis);
    s.set({ analysis: r.analysis, plan: r.plan, partPops: r.partPops, partHand: r.partHand, partWords: r.partWords, selectedParts: selected, planOn: true, autoPilot: false });
  });
  if (r.plan) keepPlan(r.plan);
  changed();
}

/**
 * Where a split at song time t would land: on the nearest beat, inside a part, at least MIN_PART_S from
 * its edges. `why` says what's wrong when it can't.
 */
export function splitPoint(t: number): { t: number; i: number; ok: boolean; why?: string } {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a?.sections.length) return { t, i: -1, ok: false, why: 'No parts yet' };
  const at = snapToBeat(a, t);
  const i = sectionIndexAt(a.sections, at);
  const sec = a.sections[i];
  if (!validPlan(s.plan, a)) return { t: at, i, ok: false, why: 'Make a video first' };
  if (at - sec.start < MIN_PART_S || sec.end - at < MIN_PART_S) return { t: at, i, ok: false, why: 'Too close to the edge of the part' };
  return { t: at, i, ok: true };
}

/** split the part playing at song time t in two, on the nearest beat; both halves keep its settings */
export function splitPartAt(t: number): boolean {
  const s = useStudio.getState();
  const a = s.analysis;
  const p = splitPoint(t);
  if (!a || !p.ok) {
    if (p.why) s.flash(`Can’t split here: ${p.why.toLowerCase()}`);
    return false;
  }
  const bounds = [...boundsOf(a), Math.round(p.t * 1000) / 1000].sort((x, y) => x - y);
  const r = recutParts(s, bounds);
  if (!r) return false;
  const name = partNames(a)[p.i];
  applyRecut(r, `split ${name}`, [p.i, p.i + 1]);
  s.flash(`${name} split at ${clock(p.t)}. Both halves keep its look and settings.`);
  return true;
}

/** which parts a combine of `is` would join: a run of neighbours (one part alone joins the next one) */
export function combineRun(is: number[]): number[] | null {
  const a = useStudio.getState().analysis;
  if (!a) return null;
  let parts = partsIn(is, a);
  if (parts.length === 1) parts = parts[0] + 1 < a.sections.length ? [parts[0], parts[0] + 1] : [];
  if (parts.length < 2) return null;
  for (let k = 1; k < parts.length; k++) if (parts[k] !== parts[k - 1] + 1) return null;
  return parts;
}

/** join neighbouring parts into one, which keeps the first one's settings */
export function combineParts(is: number[]): boolean {
  const s = useStudio.getState();
  const a = s.analysis;
  const run = combineRun(is);
  if (!a || !validPlan(s.plan, a)) return false;
  if (!run) {
    s.flash(partsIn(is, a).length > 1 ? 'Only parts side by side can be combined' : 'There is no part after this one to combine with');
    return false;
  }
  const drop = new Set(run.slice(1).map((i) => a.sections[i].start));
  const bounds = boundsOf(a).filter((_, k) => !drop.has(a.sections[k].start));
  const r = recutParts(s, bounds);
  if (!r) return false;
  const name = partsName(run, a);
  applyRecut(r, `combine ${name}`, [run[0]]);
  s.flash(`${name} are one part now, with ${partNames(a)[run[0]]}’s look and settings`);
  return true;
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/* ───────── playing ───────── */

/** jump to part i and play it (the video plan on, so it plays as planned) */
export function playPart(i: number) {
  playFrom(useStudio.getState().analysis?.sections[i]?.start ?? -1);
}

/** play the song from time t (the video plan on, so it plays as planned) */
export function playFrom(t: number) {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a || t < 0 || audioEngine.kind !== 'file' || isScrubbing() || s.clip) return;
  if (validPlan(s.plan, a) && !s.planOn) s.set({ planOn: true, autoPilot: false });
  audioEngine.seek(Math.min(a.duration, t + 0.01));
  void audioEngine.play().catch(() => {});
}

/* ───────── skip and like, one shot at a time (one look per part: flatPlan.ts) ───────── */

/**
 * Skip part i's look: remember the dislike (taste) and give only that part the best look for the
 * moment instead (flatPlan.replacementFor). Its neighbours, liked or not, stay as they are. One Undo
 * step; the new look reads as a change by the person, so a remake that keeps changes keeps it.
 */
export function skipPart(i: number): { from: NonNullable<ReturnType<typeof findLook>>; to: NonNullable<ReturnType<typeof findLook>> } | null {
  const cur = current();
  if (!cur || !cur.plan.flat) return null;
  const { plan, a } = cur;
  const from = findLook(plan.looks[i]);
  if (!from) return null;
  record('skip', from.id, a.sections[i].label);
  const to = replacementFor(plan, a, i);
  if (!to) return null;
  const looks = [...plan.looks];
  looks[i] = to.id;
  const liked = plan.liked ? plan.liked.map((v, j) => v && j !== i) : undefined;
  commit({ ...plan, looks, ...(liked ? { liked } : {}) }, `skip ${partNames(a)[i]}`);
  // on screen now, not at the next cut
  releaseHold();
  return { from, to };
}

/** like part i (on) or take the like back: a liked part is kept by a later skip and by a remake */
export function likePart(i: number, on: boolean): boolean {
  const cur = current();
  if (!cur || !cur.plan.flat || i < 0 || i >= cur.a.sections.length) return false;
  const { plan, a } = cur;
  if (!!plan.liked?.[i] === on) return false;
  const liked = a.sections.map((_, j) => (j === i ? on : !!plan.liked?.[j]));
  const next: VideoPlan = { ...plan, liked };
  if (!liked.some(Boolean)) delete next.liked;
  commit(next, `${on ? 'like' : 'unlike'} ${partNames(a)[i]}`);
  return true;
}

shotEdits.skip = skipPart;
shotEdits.like = likePart;
