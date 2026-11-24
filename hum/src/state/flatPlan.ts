/**
 * One look per part.
 *
 * The planner (offline or Claude) plans per section of the song: a main look and a rotation of related
 * looks, cut into shots by plan.ts buildShots. Before a plan plays it is flattened: every shot becomes
 * a part of its own with exactly one look, at exactly the times it was cut, so the timeline shows each
 * shot as a block that can be changed, skipped (X) or liked (K) on its own, and nothing is re-dealt
 * behind the person's back.
 *
 * How it is stored: a flat plan is an ordinary VideoPlan whose parts are the shots. Its `bounds` are
 * every shot's start (the song cut there, planCache.cutAnalysis, with each part taking the label,
 * group and energy of its section), `looks[i]` is the shot's look, `rotate` is empty, there are no
 * interludes (an interlude is a part of its own), and `transitions[i].into` is the exact transition
 * the shot arrived with (a section's first shot its arrival, the later ones its "within" transition).
 * `flat.src` keeps the planner's plan, so a new Pace (or lyrics arriving for an offline plan) cuts it
 * again, and `liked` marks the parts the person liked. Pop-ups, hand-drawn, lyric style, words and the
 * footage picture (store.partShot) of a section go to each of its shots.
 *
 * Every way a plan goes on comes through putOn (startPlan, a remake, a saved plan from the cache or
 * from before a reload, Claude's plan swapped in by one-tap start, a map started from one look), so a
 * plan never plays unflattened. A remake that keeps changes carries them by time (carryEdits).
 */
import { audioEngine } from '../audio/engine';
import type { Lyrics, Preset, TrackAnalysis } from '../core/types';
import { duringRecut, boundsOf, cutAnalysis, originalOf } from './planCache';
import {
  findLook,
  partEdits,
  planBase,
  planShots,
  plannerWorld,
  recutParts,
  relatedLooks,
  releaseHold,
  sectionIndexAt,
  validPlan,
  withBase,
  type Shot,
  type VideoPlan,
} from './plan';
import { momentShots } from '../director/footageShots';
import { cueAt, shotsFromCues, type ShotCue } from '../shot/partShots';
import { useStudio, type Pace } from './store';
import { affinityIn, contextFor, onKeep, record } from './taste';
import type { LyricPlan } from './lyricPlan';

const round3 = (t: number) => Math.round(t * 1000) / 1000;

/* ───────── flattening ───────── */

/**
 * The plan with each shot made a part of its own (one look each, the cut times and transitions
 * unchanged), and the song cut at those parts. `a` is any cut of the song; the plan's own `bounds`
 * say which parts it was made for. A plan that is already flat comes back as it is. Null when the plan
 * doesn't fit the song.
 */
export function flattenPlan(plan: VideoPlan, a: TrackAnalysis, pace: Pace, lyrics: Lyrics | null): { plan: VideoPlan; analysis: TrackAnalysis } | null {
  const aP = cutAnalysis(a, plan.bounds);
  if (!aP || plan.looks.length !== aP.sections.length || Math.abs(plan.duration - aP.duration) >= 0.5) return null;
  if (plan.flat) return { plan: withBase(plan, aP), analysis: aP };
  const p = withBase(plan, aP);
  const shots = planShots(p, aP, pace, lyrics);
  // where parts start: every shot, and every section without a look (it stays one empty part)
  const starts: { t: number; shot: Shot | null }[] = shots.map((sh) => ({ t: round3(sh.t), shot: sh }));
  aP.sections.forEach((sec, i) => {
    if (!p.looks[i]) starts.push({ t: round3(sec.start), shot: null });
  });
  starts.sort((x, y) => x.t - y.t);
  const parts: typeof starts = [];
  for (const x of starts) {
    const last = parts[parts.length - 1];
    if (last && x.t - last.t <= 0.05) parts[parts.length - 1] = x; // two cuts at one moment: the later one plays
    else parts.push(x);
  }
  if (!parts.length) return null;
  parts[0] = { ...parts[0], t: round3(aP.sections[0].start) };
  const bounds = parts.map((x) => x.t);
  const r = recutParts({ analysis: aP, plan: p, partPops: null, partHand: null, partWords: null }, bounds);
  if (!r?.plan) return null;
  const cut = r.analysis;
  const fp = r.plan;
  const from = r.from;
  const looks = parts.map((x) => x.shot?.lookId ?? null);
  const base = p.base!;
  // a section the person had already changed (a plan made before flattening) stays marked as changed
  const baseLooks = looks.map((id, k) => (base.looks[from[k]] !== p.looks[from[k]] ? base.looks[from[k]] : id));
  const flat: VideoPlan = {
    ...fp,
    looks,
    rotate: looks.map(() => null),
    transitions: parts.map((x) => (x.shot ? { into: x.shot.tr.id, beats: x.shot.tr.beats } : null)),
    lyricPlan: fp.lyricPlan ? momentsOnce(fp.lyricPlan, p.lyricPlan!, aP, cut, from, lyrics) : undefined,
    base: { looks: baseLooks, rotate: looks.map(() => null), lyric: fp.base?.lyric ?? planBase(fp, cut).lyric },
    flat: { src: p, pace },
    // what each footage part shows: the director's choices, or what its moment asks for
    ...(p.cues ? { shots: shotsFromCues(p.cues, bounds) } : p.moments ? { shots: momentShots(p, cut, looks, findLook) } : {}),
  };
  if (p.cues) underCues(flat, p.cues, bounds);
  // the cues stay with the planner's plan, where a new Pace finds them
  delete flat.cues;
  delete flat.interludes;
  delete flat.shotBars;
  if (!flat.lyricPlan) delete flat.lyricPlan;
  return { plan: flat, analysis: cut };
}

/** the reasons and the way the words appear that came with the director's shots, put on the flat plan's parts */
function underCues(flat: VideoPlan, cues: ShotCue[], bounds: number[]) {
  const at = bounds.map((b) => cueAt(cues, b));
  flat.why = flat.why.map((w, k) => at[k]?.why || w);
  const lp = flat.lyricPlan;
  if (!lp) return;
  const changes = (k: number) => !!at[k]?.lyric && !!lp.parts[k] && lp.parts[k]!.medium !== 'own' && lp.parts[k]!.medium !== at[k]!.lyric;
  flat.lyricPlan = { ...lp, parts: lp.parts.map((part, k) => (changes(k) ? { ...part!, medium: at[k]!.lyric!, moment: null, why: 'planned by Claude' } : part)) };
  // the planner's choice, so it is the base a change by hand is told by
  if (flat.base) flat.base = { ...flat.base, lyric: flat.base.lyric.map((m, k) => (changes(k) ? at[k]!.lyric! : m)) };
}

/**
 * A section's one-off lyric moment (the giant word on the drop's first line, the burst on a chorus
 * line) belongs to one line, so after flattening only the shot that line falls in keeps it; the
 * section's other shots keep its medium without the moment.
 */
function momentsOnce(lp: LyricPlan, src: LyricPlan, aP: TrackAnalysis, cut: TrackAnalysis, from: number[], lyrics: Lyrics | null): LyricPlan {
  const lines = lyrics?.synced ? lyrics.lines : [];
  const parts = lp.parts.map((part, k) => {
    const j = from[k];
    const m = src.parts[j]?.moment;
    if (!part || !m) return part;
    const sec = aP.sections[j];
    const inSec = lines.map((l, li) => ({ l, li })).filter(({ l }) => l.t >= sec.start && l.t < sec.end);
    if (!inSec.length) return { ...part, moment: null };
    const count = inSec.length;
    const at = m === 'giant' ? 0 : count > 2 ? 1 + (lp.seed % Math.min(3, count - 1)) : 0;
    const t = inSec[Math.min(at, count - 1)].l.t;
    const own = cut.sections[k];
    return t >= own.start && t < own.end ? part : { ...part, moment: null };
  });
  return { ...lp, parts };
}

/* ───────── carrying changes to a new plan ───────── */

/**
 * Carry the person's changes in the playing flat plan `prev` over to a new flat plan `next` (a remake
 * that keeps changes, or the same plan cut again at a new Pace). A part whose look or lyric style the
 * person changed, or that they liked, keeps its look (and style, and like) over the same stretch of the
 * song: when a part of the new plan starts within a beat of where it started (and ends within a beat
 * of where it ended) those lines are used as they are; otherwise the new plan is cut at the old
 * part's start and end, and any cut of the new plan inside that stretch goes, so the kept part plays
 * as one block again. Everything else comes from the new plan. Pop-ups, hand-drawn and words are
 * carried by time for every part (carryByTime). `kept` counts the parts carried.
 */
export function carryEdits(next: { plan: VideoPlan; analysis: TrackAnalysis }, prev: { plan: VideoPlan; analysis: TrackAnalysis }): { plan: VideoPlan; analysis: TrackAnalysis; kept: number } {
  const pa = prev.analysis;
  if (!validPlan(prev.plan, pa) || originalOf(pa) !== originalOf(next.analysis)) return { ...next, kept: 0 };
  const pp = withBase(prev.plan, pa);
  const edits = partEdits(pp, pa, null, null, null);
  const liked = pp.liked ?? [];
  const keep = pa.sections
    .map((sec, k) => ({ k, sec, look: !!edits[k]?.look || !!liked[k], lyric: !!edits[k]?.lyric, liked: !!liked[k] }))
    .filter((x) => x.look || x.lyric || x.liked);
  if (!keep.length) return { ...next, kept: 0 };
  const na = next.analysis;
  const end = na.duration;
  const beat = 60 / Math.max(50, Math.min(200, na.bpm || 120));
  const nb = boundsOf(na);
  const near = (t: number) => nb.find((b) => Math.abs(b - t) <= beat + 1e-3);
  const spans = keep
    .map((x) => {
      const s0 = x.k === 0 ? nb[0] : (near(x.sec.start) ?? round3(x.sec.start));
      const e0 = x.sec.end >= end - 0.01 ? end : (near(x.sec.end) ?? round3(x.sec.end));
      return { x, s0, e0 };
    })
    .filter((sp) => sp.e0 - sp.s0 >= 0.5);
  const inside = (b: number) => spans.some((sp) => b > sp.s0 + 1e-3 && b < sp.e0 - 1e-3);
  const set = new Set(nb.filter((b) => !inside(b)));
  for (const sp of spans) {
    set.add(sp.s0);
    if (sp.e0 < end - 0.01) set.add(sp.e0);
  }
  const bounds: number[] = [];
  for (const b of [...set].sort((x, y) => x - y)) if (!bounds.length || b - bounds[bounds.length - 1] > 0.05) bounds.push(b);
  const r = recutParts({ analysis: na, plan: next.plan, partPops: null, partHand: null, partWords: null }, bounds);
  if (!r?.plan) return { ...next, kept: 0 };
  const plan = r.plan;
  const looks = [...plan.looks];
  const likedNext = plan.looks.map((_, k) => !!plan.liked?.[k]);
  const lp = plan.lyricPlan ? { ...plan.lyricPlan, parts: [...plan.lyricPlan.parts] } : undefined;
  const shots = plan.shots || pp.shots ? plan.looks.map((_, k) => plan.shots?.[k] ?? null) : null;
  let kept = 0;
  for (const sp of spans) {
    // the new part that starts where the kept one does
    let k = 0;
    for (let j = 0; j < bounds.length; j++) if (Math.abs(bounds[j] - sp.s0) < Math.abs(bounds[k] - sp.s0)) k = j;
    const { x } = sp;
    if (x.look && pp.looks[x.k] && findLook(pp.looks[x.k])) {
      looks[k] = pp.looks[x.k];
      // a kept look keeps the picture it had, not the new plan's
      if (shots) shots[k] = pp.shots?.[x.k] ?? null;
    }
    const was = pp.lyricPlan?.parts[x.k];
    if (x.lyric && lp && was && lp.parts[k]) lp.parts[k] = { ...lp.parts[k]!, medium: was.medium, why: was.why };
    if (x.liked) likedNext[k] = true;
    kept++;
  }
  return {
    plan: { ...plan, looks, ...(shots ? { shots } : {}), ...(lp ? { lyricPlan: lp } : {}), ...(likedNext.some(Boolean) ? { liked: likedNext } : {}) },
    analysis: r.analysis,
    kept,
  };
}

/** a per-part setting moved to new parts by time: each new part takes the old part it starts in */
export function carryByTime<T>(arr: (T | null)[] | null, from: TrackAnalysis, to: TrackAnalysis): (T | null)[] | null {
  if (!arr || arr.length !== from.sections.length) return null;
  const out = to.sections.map((sec) => arr[sectionIndexAt(from.sections, sec.start + 0.001)] ?? null);
  return out.some((v) => v !== null) ? out : null;
}

/* ───────── putting a plan on ───────── */

/**
 * Put a plan on as the playing plan: flattened (one look per part), with the song cut at its parts
 * and every per-part setting moved to them, in one store change. Doesn't touch the song's position.
 *
 *   keep       the plan playing before: its changes are carried across (carryEdits)
 *   freshPops  the pop-up levels set by hand go (a remake that starts fresh)
 *   restore    a saved plan coming back (the cache, a reload): its per-part settings are the ones saved
 *              with it (planCache brings them back), so the ones in the store aren't moved onto it
 *
 * Returns the plan as it plays and how many changed parts it carried.
 */
export function putOn(plan: VideoPlan, a: TrackAnalysis, opts: { keep?: VideoPlan | null; freshPops?: boolean; restore?: boolean } = {}): { plan: VideoPlan; kept: number } {
  const s = useStudio.getState();
  const f = flattenPlan(plan, a, s.pace, s.lyrics);
  if (!f) {
    // a plan that doesn't fit the song (it can't be flattened): on as it is, the way it used to go on
    const p = withBase(plan, a);
    s.set({ plan: p, planOn: true, autoPilot: false });
    return { plan: p, kept: 0 };
  }
  let out = { ...f, kept: 0 };
  const prevA = s.analysis;
  if (opts.keep && prevA && validPlan(opts.keep, prevA) && opts.keep.flat) out = carryEdits(f, { plan: opts.keep, analysis: prevA });
  const sameSong = !!prevA && originalOf(prevA) === originalOf(out.analysis);
  const moved = sameSong && !opts.restore && prevA !== out.analysis;
  const patch = {
    analysis: out.analysis,
    plan: out.plan,
    planOn: true,
    autoPilot: false,
    ...(prevA !== out.analysis ? { selectedParts: [] as number[] } : {}),
    ...(moved
      ? {
          partPops: opts.freshPops ? null : carryByTime(s.partPops, prevA, out.analysis),
          partHand: carryByTime(s.partHand, prevA, out.analysis),
          partWords: carryByTime(s.partWords, prevA, out.analysis),
          // a section's own picture goes to each of its shots, and only when it had one
          partShot: carryByTime(s.partShot, prevA, out.analysis),
        }
      : opts.freshPops
        ? { partPops: null }
        : {}),
  };
  const apply = () => {
    if (audioEngine.analysis !== out.analysis) audioEngine.setAnalysis(out.analysis);
    s.set(patch);
  };
  // a move of per-part settings is saved as it is (planCache), never read back from what was saved
  if (moved) duringRecut(apply);
  else apply();
  releaseHold();
  return { plan: out.plan, kept: out.kept };
}

/** cut the playing plan again from the planner's plan (a new Pace), keeping the person's changes */
function reflow() {
  const s = useStudio.getState();
  const p = s.plan;
  const a = s.analysis;
  if (!p?.flat || !a || !validPlan(p, a) || p.flat.pace === s.pace) return;
  putOn(p.flat.src, a, { keep: p });
}

// the Pace setting cuts the shots faster or slower: a flat plan is cut again at the new pace
useStudio.subscribe((s, prev) => {
  if (s.pace !== prev.pace) reflow();
});

/* ───────── skip and like, per shot ───────── */

/** the part playing now, when a flat plan plays */
export function playingPart(): number {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a || !validPlan(s.plan, a) || audioEngine.kind !== 'file') return -1;
  return sectionIndexAt(a.sections, audioEngine.currentTime);
}

/**
 * The look that should replace part i's when it's skipped: the best related look for the moment (the
 * skip logic the planner always used: related to the skipped look, steered by taste), never the
 * skipped look, never its neighbours' (so the cut still shows), nor one taste says the person skips here.
 */
export function replacementFor(plan: VideoPlan, a: TrackAnalysis, i: number): Preset | undefined {
  const id = plan.looks[i];
  if (!id) return undefined;
  const aff = affinityIn(contextFor(a.sections[i].label));
  const avoid = new Set([id, plan.looks[i - 1], plan.looks[i + 1]].filter((x): x is string => !!x));
  const ranked = relatedLooks(id, a, plan.looks, (x) => 1.5 * aff(x), undefined, plannerWorld(plan.mood));
  const pick = ranked.find((x) => !avoid.has(x) && aff(x) > -0.4) ?? ranked.find((x) => x !== id);
  return findLook(pick);
}

/** hooks partEdit.ts fills in (it owns Undo and saving), so plan.ts can reach them without a loop */
export const shotEdits: {
  skip: (i: number) => { from: Preset; to: Preset } | null;
  like: (i: number, on: boolean) => boolean;
} = { skip: () => null, like: () => false };

/** skip the shot playing now: only its part gets a new look (null when there's nothing to skip) */
export function skipPlayingPart(): { from: Preset; to: Preset } | null {
  const i = playingPart();
  return i < 0 ? null : shotEdits.skip(i);
}

/** like the shot playing now (again: take the like back). Null when no flat plan plays. */
export function likePlayingPart(): { look: Preset; liked: boolean } | null {
  const s = useStudio.getState();
  const i = playingPart();
  const look = i >= 0 ? findLook(s.plan!.looks[i]) : undefined;
  if (!look || !s.plan?.flat) return null;
  const on = !s.plan.liked?.[i];
  // a like is also a Keep in taste
  if (on) record('keep', look.id, s.analysis!.sections[i].label);
  shotEdits.like(i, on);
  return { look, liked: on };
}

// a Keep from anywhere (the heart on the stage) likes the shot playing, when it's that shot's look
onKeep((id) => {
  const i = playingPart();
  if (i >= 0 && useStudio.getState().plan?.flat && useStudio.getState().plan!.looks[i] === id) shotEdits.like(i, true);
});
