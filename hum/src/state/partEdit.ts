/**
 * Changing parts of the video by hand (the Part tab, src/ui/PartPanel.tsx, the timeline and its menu,
 * src/ui/Timeline.tsx, and on phones the part sheet, src/ui/PartSheet.tsx): a part's look, its version
 * (another take of the same family), its lyric style, its pop-ups, whether it is hand-drawn and the
 * words a text look shows in it. Every change can take several parts at once (the parts picked on the
 * timeline), and the parts themselves can be split and combined.
 *
 * Looks and lyric styles land in the plan itself, so the sequencer, scrubbing and renders read them
 * like any other plan, and the timeline shows them at once. Pop-up levels, hand-drawn, words and a
 * footage part's own picture (style, arrangement, treatment, media, framing) go to the store
 * (partPops, partHand, partWords, partShot), outside the plan, so they outlast re-plans; they are kept
 * per song in planCache.ts. The plan's `base` (what the planner chose) tells a changed part from a
 * planned one: a re-plan keeps the changes (plan.ts keepEdits), "Reset this part" puts the planner's
 * pick back. Undo is the app's one history (state/history.ts), which follows the store, so nothing here
 * has to record a step. A plan changed here is saved for the song (planCache.keepPlan), whoever planned it.
 *
 * Split and combine re-cut the song's parts (analysis.sections) and re-index every per-part setting in
 * the same step (plan.ts recutParts); the plan keeps the new part lines as `bounds`, so a re-plan, the
 * plan cache and a reload all find them again.
 */
import { audioEngine } from '../audio/engine';
import type { PartShot, PhotoAsset, TrackAnalysis } from '../core/types';
import { rememberTake } from '../presets/fit';
import { shotOfPart } from '../shot/partShots';
import { localLyricPlan, type LyricMedium } from './lyricPlan';
import { assignLook, ensureDropCuts, findLook, listNames, partEdits, partNames, recutParts, releaseHold, sectionIndexAt, snapToBeat, validPlan, withBase, type Recut, type VideoPlan } from './plan';
import { replacementFor, shotEdits } from './flatPlan';
import { boundsOf, duringRecut, keepPlan } from './planCache';
import { isScrubbing } from './scrub';
import { recallSoloShot, rememberSoloShot } from './saved';
import { isSoloQuiet, setSoloShotQuietly, useStudio, type StudioState } from './store';
import { noteHandPick, record } from './taste';

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
function commit(next: VideoPlan) {
  const s = useStudio.getState();
  s.set({ plan: next, planOn: true, autoPilot: false });
  keepPlan(next);
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
  commit(next);
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
  commit(next);
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

/** a per-part store setting changed (one Undo step, state/history.ts), the plan switched on so it shows */
function setStored<K extends 'partPops' | 'partHand' | 'partWords'>(key: K, is: number[], v: NonNullable<ReturnType<typeof useStudio.getState>[K]>[number], flash?: string) {
  const s = useStudio.getState();
  const cur = current();
  if (!cur) return;
  const parts = partsIn(is, cur.a);
  const n = cur.a.sections.length;
  const arr = s[key] as unknown[] | null;
  if (!parts.length || parts.every((i) => (arr?.length === n ? (arr[i] ?? null) : null) === v)) return;
  s.set({ [key]: withValue(arr, n, parts, v) } as Partial<ReturnType<typeof useStudio.getState>>);
  if (!useStudio.getState().planOn) useStudio.getState().set({ planOn: true, autoPilot: false });
  if (flash) s.flash(flash.replace('$', partsName(parts, cur.a)));
}

/**
 * parts `is`' pop-ups: 0 off, 1 a few, 3 lots, null back to the planner's (store.partPops, outside the
 * plan, so it outlasts re-plans, and saved for the song)
 */
export function setPartsPops(is: number[], level: number | null) {
  const v = level === null || !Number.isFinite(level) ? null : Math.max(0, Math.min(3, Math.round(level)));
  setStored('partPops', is, v);
}

export function setPartPopsLevel(i: number, level: number | null) {
  setPartsPops([i], level);
}

/** parts `is` drawn by hand (true), kept clean of it (false), or as the whole video is set (null) */
export function setPartsHand(is: number[], v: boolean | null) {
  setStored('partHand', is, v, v === null ? '$: hand-drawn as the video' : v ? '$: hand-drawn on' : '$: hand-drawn off');
}

/** the words a text look shows in parts `is` ('' or null: its own words again) */
export function setPartsWords(is: number[], text: string | null) {
  const v = text?.replace(/\s+/g, ' ').trim().slice(0, 120) || null;
  setStored('partWords', is, v);
}

/* ───────── a footage part's own picture (store.partShot) ───────── */

const SHOT_KEYS = ['style', 'seed', 'treatment', 'motion', 'media', 'focusX', 'focusY', 'zoom', 'from', 'moment', 'say'] as const satisfies readonly (keyof PartShot)[];

/** a record with only the fields that say something, in one order, or null when none is left */
function tidyShot(r: PartShot): PartShot | null {
  const out: Record<string, unknown> = {};
  for (const k of SHOT_KEYS) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    if (k === 'style' && v === 'auto') continue;
    if (k === 'media' && (!Array.isArray(v) || !v.length)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? (out as PartShot) : null;
}

/**
 * Change parts `is`' own picture: the fields in `patch` are set (a field given as undefined goes back
 * to the look's), the rest of each part's record stays as it was; null clears the record. One Undo
 * step (state/history.ts names it), saved for the song (planCache.ts). Only the parts named change:
 * the footage look's own settings, and every other part playing it, are left alone.
 */
export function setPartsShot(is: number[], patch: Partial<PartShot> | null) {
  const s = useStudio.getState();
  const cur = current();
  if (!cur) return;
  const parts = partsIn(is, cur.a);
  const n = cur.a.sections.length;
  if (!parts.length) return;
  const next = s.partShot?.length === n ? [...s.partShot] : Array.from({ length: n }, () => null as PartShot | null);
  let changed = false;
  for (const i of parts) {
    const v = patch === null ? null : tidyShot({ ...(next[i] ?? {}), ...patch });
    if (JSON.stringify(next[i] ?? null) === JSON.stringify(v)) continue;
    next[i] = v;
    changed = true;
  }
  if (!changed) return;
  s.set({ partShot: next.some((x) => x !== null) ? next : null });
  if (!useStudio.getState().planOn) useStudio.getState().set({ planOn: true, autoPilot: false });
}

/** part i's own picture record (null: it follows its look) */
export function partShotOf(i: number, s = useStudio.getState()): PartShot | null {
  const n = s.analysis?.sections.length ?? -1;
  return s.partShot?.length === n ? (s.partShot[i] ?? null) : null;
}

/* ───────── the picture of a look playing on its own (store.soloShot) ───────── */

/** a video plan is what plays (not one look on its own) */
export function planPlaying(s = useStudio.getState()): boolean {
  return s.planOn && !!s.analysis && validPlan(s.plan, s.analysis);
}

/** the scene the look's own picture was chosen for: another scene on screen clears it */
let soloScene = '';
/**
 * A record brought back by a reload waits for its scene to come on screen before another scene may
 * clear it: while the page starts, the song's looks come and go before the person has seen anything.
 */
let soloArmed = true;

/**
 * Change the picture of the look playing on its own (no video plan): the same fields as a part's,
 * kept for that look's scene. One Undo step (history.ts), saved for the next load (saved.ts).
 */
export function setSoloShot(patch: Partial<PartShot> | null) {
  const s = useStudio.getState();
  const v = patch === null ? null : tidyShot({ ...(s.soloShot ?? {}), ...patch });
  if (JSON.stringify(s.soloShot ?? null) === JSON.stringify(v)) return;
  soloScene = s.sceneId;
  soloArmed = true;
  s.set({ soloShot: v });
  rememberSoloShot(s.sceneId, v);
}

// the look's own picture belongs to its scene: a look of another scene coming on screen (while no plan
// plays) clears it. Bookkeeping, not an edit, so it makes no Undo step. Brought back on a reload.
{
  const saved = recallSoloShot();
  if (saved) {
    soloScene = saved.sceneId;
    soloArmed = false;
    setSoloShotQuietly(saved.shot);
  }
  useStudio.subscribe((s, prev) => {
    if (s.soloShot !== prev.soloShot && s.soloShot && !isSoloQuiet()) {
      // an undo bringing a record back: it belongs to what's on screen now
      soloScene = s.sceneId;
      soloArmed = true;
      rememberSoloShot(s.sceneId, s.soloShot);
    } else if (s.soloShot !== prev.soloShot && !s.soloShot) rememberSoloShot('', null);
    if (s.sceneId === soloScene) soloArmed = true;
    if (!s.soloShot || !s.sceneId || s.sceneId === soloScene || !soloArmed) return;
    if (s.sceneId === prev.sceneId && s.planOn === prev.planOn && s.plan === prev.plan) return;
    if (planPlaying(s)) return;
    setSoloShotQuietly(null);
    rememberSoloShot('', null);
  });
}

/**
 * The photos a photo look should show at song time `t`, when the person chose some: the playing part's
 * own (store.partShot) while a plan plays, else the look's own (store.soloShot); in the order chosen.
 * Null when nothing is chosen (or none of the chosen ones is a photo still in the library), so the
 * stage gives the look every photo as before.
 */
export function chosenPhotosAt(s: StudioState, t: number): PhotoAsset[] | null {
  let ids: string[] | undefined;
  if (planPlaying(s)) {
    const i = sectionIndexAt(s.analysis!.sections, t);
    ids = shotOfPart(i, s)?.media;
  } else ids = s.sceneId === soloScene ? s.soloShot?.media : undefined;
  if (!ids?.length) return null;
  const out = ids.map((id) => s.photos.find((p) => p.id === id)).filter((p) => !!p);
  return out.length ? out : null;
}

/** a per-part setting re-indexed by a re-cut: each new part takes the old part it came from */
function carryFrom<T>(arr: (T | null)[] | null, from: number[], n0: number): (T | null)[] | null {
  if (!arr || arr.length !== n0) return null;
  const out = from.map((j) => arr[j] ?? null);
  return out.some((v) => v !== null) ? out : null;
}

/* ───────── reset ───────── */

/** put the planner's own picks back into parts `is` (looks, lyrics, pop-ups, hand-drawn, words and picture) */
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
  const partShot = withValue(s.partShot, n, parts, null);
  // the plan's "kept your changes" line goes once nothing is changed any more
  if (partEdits(next, a, partPops, partHand, partWords, partShot).every((e) => !e)) next = { ...next, note: next.note.replace(/ Kept your changes to [^.]*\.$/, '') };
  const name = partsName(parts, a);
  commit(next);
  s.set({ partPops, partHand, partWords, partShot });
  s.flash(`${name} ${parts.length > 1 ? 'are' : 'is'} back to the plan`);
}

export function resetPart(i: number) {
  resetParts([i]);
}

/* ───────── split and combine ───────── */

/** a part shorter than this can't be made by a split */
export const MIN_PART_S = 1;

/** put a re-cut on: the new parts, the re-indexed plan and settings, in one store change and one Undo step */
function applyRecut(r: Recut, selected: number[]) {
  const s = useStudio.getState();
  // plan.ts recutParts re-indexes the plan and the older per-part settings; the picture records follow
  // the same `from` (a split gives both halves the record, a combine keeps the first part's)
  const partShot = carryFrom(s.partShot, r.from, s.analysis?.sections.length ?? -1);
  duringRecut(() => {
    audioEngine.setAnalysis(r.analysis);
    s.set({ analysis: r.analysis, plan: r.plan, partPops: r.partPops, partHand: r.partHand, partWords: r.partWords, partShot, selectedParts: selected, planOn: true, autoPilot: false });
  });
  if (r.plan) keepPlan(r.plan);
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
  applyRecut(r, [p.i, p.i + 1]);
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
  applyRecut(r, [run[0]]);
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
  commit({ ...plan, looks, ...(liked ? { liked } : {}) });
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
  commit(next);
  return true;
}

shotEdits.skip = skipPart;
shotEdits.like = likePart;
