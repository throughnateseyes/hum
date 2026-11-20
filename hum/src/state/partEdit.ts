/**
 * Changing one part of the video by hand (the part sheet, src/ui/PartSheet.tsx): its look, its
 * version (another take of the same family), its lyric style and its pop-ups.
 *
 * Every change lands in the plan itself, so the sequencer, scrubbing and renders read it like any
 * other plan, and the song map shows it at once. The plan's `base` (what the planner chose) tells a
 * changed part from a planned one: a re-plan keeps the changes (plan.ts keepEdits), "Reset this part"
 * puts the planner's pick back, and Undo steps back through the last few changes. A plan changed
 * here is saved for the song (planCache.keepPlan), whoever planned it.
 */
import { audioEngine } from '../audio/engine';
import type { TrackAnalysis } from '../core/types';
import { rememberTake } from '../presets/fit';
import { localLyricPlan, type LyricMedium } from './lyricPlan';
import { assignLook, ensureDropCuts, findLook, partEdits, sectionNames, validPlan, withBase, type VideoPlan } from './plan';
import { keepPlan } from './planCache';
import { isScrubbing } from './scrub';
import { useStudio } from './store';
import { noteHandPick } from './taste';

/** the plans before the last few changes made here (same song only) */
const undo: { plan: VideoPlan; analysis: TrackAnalysis; what: string }[] = [];
const UNDO_MAX = 20;
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
  return top && top.analysis === a ? top.what : null;
}

/** the playing plan for this song, with a base to tell changes by (null without one) */
function current(): { plan: VideoPlan; a: TrackAnalysis } | null {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a || !validPlan(s.plan, a)) return null;
  return { plan: withBase(s.plan, a), a };
}

/** put a changed plan on (the song map follows it from now on) and save it for the song */
function commit(before: VideoPlan, a: TrackAnalysis, next: VideoPlan, what: string) {
  undo.push({ plan: before, analysis: a, what });
  if (undo.length > UNDO_MAX) undo.shift();
  const s = useStudio.getState();
  s.set({ plan: next, planOn: true, autoPilot: false });
  keepPlan(next);
  changed();
}

/** part i plays this look (a new look or another take of its own); no plan yet → a song map starts from it */
export function setPartLook(i: number, id: string) {
  const s = useStudio.getState();
  const a = s.analysis;
  const look = findLook(id);
  if (!a || !look || i < 0 || i >= a.sections.length) return;
  noteHandPick(look, 'place', a.sections[i].label);
  rememberTake(look);
  const cur = current();
  if (!cur) {
    // like dropping a look on a part: the map starts here and the empty parts take it too
    assignLook(i, id, false);
    const now = useStudio.getState();
    if (now.plan) {
      const plan = withBase(now.plan, a);
      now.set({ plan });
      keepPlan(plan);
    }
    return;
  }
  const { plan } = cur;
  if (plan.looks[i] === id) return;
  const looks = [...plan.looks];
  looks[i] = id;
  const rotate = a.sections.map((_, j) => plan.rotate?.[j] ?? null);
  // a new main look gets a fresh rotation around it (the planner's own pick gets its own rotation back)
  rotate[i] = plan.base?.looks[i] === id ? plan.base.rotate[i] : null;
  const next = ensureDropCuts({ ...plan, looks, rotate }, a, i);
  const name = sectionNames(a.sections)[i];
  commit(s.plan!, a, next, `${name}: ${look.name}`);
  s.flash(`${name} now uses “${look.name}”`);
}

/** how part i shows its lyrics (the lyric plan's medium for that part) */
export function setPartLyric(i: number, medium: LyricMedium) {
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
  const part = lp.parts[i];
  if (!part || part.medium === medium) return;
  const parts = [...lp.parts];
  parts[i] = { ...part, medium, why: 'your pick' };
  const next = { ...plan, base, lyricPlan: { ...lp, parts } };
  const name = sectionNames(a.sections)[i];
  commit(s.plan!, a, next, `${name} lyrics`);
  // the per-part styles only show while lyrics are on Auto
  if (s.lyricStyle !== 'auto') {
    s.set({ lyricStyle: 'auto', lyricStylePicked: true });
    s.flash(`Lyrics switched to Auto so ${name} can have its own style`);
  }
}

/** part i's pop-up windows: 0 off, 1 a few, 3 lots (through the store's setPartPops, so it saves) */
export function setPartPopsLevel(i: number, level: number) {
  const s = useStudio.getState();
  const cur = current();
  if (!cur) return;
  const before = s.plan!;
  // the base goes on first, so the change reads as a change
  if (before !== cur.plan) s.set({ plan: cur.plan });
  s.setPartPops(i, level);
  const after = useStudio.getState().plan;
  if (after && after !== cur.plan) {
    undo.push({ plan: before, analysis: cur.a, what: `${sectionNames(cur.a.sections)[i]} pop-ups` });
    if (undo.length > UNDO_MAX) undo.shift();
    if (!useStudio.getState().planOn) useStudio.getState().set({ planOn: true, autoPilot: false });
    changed();
  }
}

/** put the planner's own picks back into part i */
export function resetPart(i: number) {
  const s = useStudio.getState();
  const cur = current();
  if (!cur) return;
  const { plan, a } = cur;
  const b = plan.base!;
  const looks = [...plan.looks];
  const rotate = a.sections.map((_, j) => plan.rotate?.[j] ?? null);
  if (!b.looks[i] || findLook(b.looks[i])) {
    looks[i] = b.looks[i];
    rotate[i] = b.rotate[i];
  }
  const pops = a.sections.map((_, j) => plan.pops?.[j] ?? b.pops[j]);
  pops[i] = b.pops[i];
  let lyricPlan = plan.lyricPlan;
  const was = b.lyric[i];
  if (lyricPlan?.parts[i] && was) {
    const parts = [...lyricPlan.parts];
    parts[i] = { ...parts[i]!, medium: was, why: '' };
    lyricPlan = { ...lyricPlan, parts };
  }
  let next = ensureDropCuts({ ...plan, looks, rotate, pops, ...(lyricPlan ? { lyricPlan } : {}) }, a, i);
  // the plan's "kept your changes" line goes once nothing is changed any more
  if (partEdits(next, a).every((e) => !e)) next = { ...next, note: next.note.replace(/ Kept your changes to [^.]*\.$/, '') };
  const name = sectionNames(a.sections)[i];
  commit(s.plan!, a, next, `reset ${name}`);
  s.flash(`${name} is back to the plan`);
}

/** take back the last change made here */
export function undoPartEdit() {
  const s = useStudio.getState();
  const top = undo[undo.length - 1];
  if (!top || top.analysis !== s.analysis) return;
  undo.pop();
  s.set({ plan: top.plan, planOn: true, autoPilot: false });
  keepPlan(top.plan);
  s.flash(`Undid ${top.what}`);
  changed();
}

/** jump to part i and play it (the song map on, so it plays as planned) */
export function playPart(i: number) {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a || audioEngine.kind !== 'file' || isScrubbing() || s.clip) return;
  const sec = a.sections[i];
  if (!sec) return;
  if (validPlan(s.plan, a) && !s.planOn) s.set({ planOn: true, autoPilot: false });
  audioEngine.seek(sec.start + 0.01);
  void audioEngine.play().catch(() => {});
}
