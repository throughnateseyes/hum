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
import { onlyIn } from '../arrange/types';
import { audioEngine } from '../audio/engine';
import type { Lyrics, Preset, TrackAnalysis } from '../core/types';
import { duringRecut, boundsOf, cutAnalysis, originalOf } from './planCache';
import {
  findLook,
  partEdits,
  planBase,
  planShots,
  popsOf,
  recutParts,
  relatedLooks,
  releaseHold,
  sectionIndexAt,
  validPlan,
  withBase,
  worldOf,
  type Shot,
  type VideoPlan,
} from './plan';
import { curvesFor } from '../director/feeling';
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
  // only the person's footage was asked for: whatever the planning let through, no other look fills a part
  const only = p.mix === 'only' ? worldOf(p) : undefined;
  const stand = only ? p.looks.find((id) => !!id && !!findLook(id) && only(findLook(id)!)) : undefined;
  const looks = parts.map((x) => {
    const id = x.shot?.lookId ?? null;
    const look = id && stand ? findLook(id) : undefined;
    return look && !only!(look) ? stand! : id;
  });
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
    ...(p.cues && !(p.dealt && p.moments) ? { shots: shotsFromCues(p.cues, bounds) } : p.moments ? { shots: momentShots(p, cut, looks, findLook, curvesFor(p, a, lyrics)) } : {}),
  };
  // Hum's own cues were worked out for the parts as they were cut then
  if (p.cues && p.dealt && flat.shots) flat.shots = flat.shots.map((sh, k) => p.cues!.find((c) => Math.abs(c.at - bounds[k]) < 0.06 && Math.abs(c.end - (bounds[k + 1] ?? cut.duration)) < 0.3)?.shot ?? sh);
  if (p.cues && !p.dealt) underCues(flat, p.cues, bounds);
  // the cues stay with the planner's plan, where a new Pace finds them
  delete flat.cues;
  delete flat.dealt;
  // (and so does what the words feel like)
  delete flat.feeling;
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
 *
 * A part marked Keep (plan.kept) comes across whole: its exact start and end (a line of the new plan
 * within a beat of one moves onto it), its look, shot, drawing, pop-up level, transition and words. What
 * the whole video has one of and shows in it (the paint, the finish, the type and the dice of the words)
 * stays too.
 */
export function carryEdits(next: { plan: VideoPlan; analysis: TrackAnalysis }, prev: { plan: VideoPlan; analysis: TrackAnalysis }): { plan: VideoPlan; analysis: TrackAnalysis; kept: number } {
  const pa = prev.analysis;
  if (!validPlan(prev.plan, pa) || originalOf(pa) !== originalOf(next.analysis)) return { ...next, kept: 0 };
  const pp = withBase(prev.plan, pa);
  const edits = partEdits(pp, pa, null, null, null, undefined, null);
  const liked = pp.liked ?? [];
  const keep = pa.sections
    .map((sec, k) => ({ k, sec, whole: !!pp.kept?.[k], look: !!edits[k]?.look || !!liked[k], lyric: !!edits[k]?.lyric, liked: !!liked[k] }))
    .filter((x) => x.whole || x.look || x.lyric || x.liked);
  if (!keep.length) return { ...next, kept: 0 };
  const beat = 60 / Math.max(50, Math.min(200, next.analysis.bpm || 120));
  const end = next.analysis.duration;
  next = ontoLines(next, keep.filter((x) => x.whole).flatMap((x) => [x.sec.start, x.sec.end]), beat);
  const na = next.analysis;
  const nb = boundsOf(na);
  const near = (t: number) => nb.filter((b) => Math.abs(b - t) <= beat + 1e-3).sort((x, y) => Math.abs(x - t) - Math.abs(y - t))[0];
  const spans = keep
    .map((x) => {
      if (x.whole) return { x, s0: x.k === 0 ? nb[0] : round3(x.sec.start), e0: x.sec.end >= end - 0.01 ? end : round3(x.sec.end) };
      const s0 = x.k === 0 ? nb[0] : (near(x.sec.start) ?? round3(x.sec.start));
      const e0 = x.sec.end >= end - 0.01 ? end : (near(x.sec.end) ?? round3(x.sec.end));
      return { x, s0, e0 };
    })
    .filter((sp) => sp.x.whole || sp.e0 - sp.s0 >= 0.5);
  const inside = (b: number) => spans.some((sp) => b > sp.s0 + 1e-3 && b < sp.e0 - 1e-3);
  // (a line of another kept change never goes inside a part kept whole)
  const barred = (b: number) => spans.some((sp) => sp.x.whole && b > sp.s0 + 1e-3 && b < sp.e0 - 1e-3);
  const set = new Set(nb.filter((b) => !inside(b)));
  for (const sp of spans) {
    if (!barred(sp.s0)) set.add(sp.s0);
    if (sp.e0 < end - 0.01 && !barred(sp.e0)) set.add(sp.e0);
  }
  const bounds: number[] = [];
  // two lines at one moment: a kept part's own is the one that stays
  const fixed = new Set(spans.flatMap((sp) => (sp.x.whole ? [sp.s0, sp.e0] : [])));
  for (const b of [...set].sort((x, y) => x - y)) {
    if (!bounds.length || b - bounds[bounds.length - 1] > 0.051) bounds.push(b);
    else if (fixed.has(b) && bounds.length > 1) bounds[bounds.length - 1] = b;
  }
  const r = recutParts({ analysis: na, plan: next.plan, partPops: null, partHand: null, partWords: null }, bounds);
  if (!r?.plan) return { ...next, kept: 0 };
  const plan = r.plan;
  const whole = spans.some((sp) => sp.x.whole);
  // a line that moved onto a kept part's edge: the parts round it take the director's choice for them again
  if (whole) recue(plan, bounds, end);
  const looks = [...plan.looks];
  const likedNext = plan.looks.map((_, k) => !!plan.liked?.[k]);
  const lp = plan.lyricPlan ? { ...plan.lyricPlan, parts: [...plan.lyricPlan.parts] } : undefined;
  const shots = plan.shots || pp.shots ? plan.looks.map((_, k) => plan.shots?.[k] ?? null) : null;
  const n = plan.looks.length;
  const why = plan.looks.map((_, k) => plan.why[k] ?? '');
  const pops = r.analysis.sections.map((_, k) => popsOf(plan, r.analysis, k));
  const transitions = plan.looks.map((_, k) => plan.transitions?.[k] ?? null);
  const moments = plan.looks.map((_, k) => plan.moments?.[k] ?? null);
  const keptNext = new Array<boolean>(n).fill(false);
  const base = plan.base && { looks: [...plan.base.looks], rotate: [...plan.base.rotate], lyric: [...plan.base.lyric] };
  let kept = 0;
  for (const sp of spans) {
    // the new part that starts where the kept one does
    let k = 0;
    for (let j = 0; j < bounds.length; j++) if (Math.abs(bounds[j] - sp.s0) < Math.abs(bounds[k] - sp.s0)) k = j;
    const { x } = sp;
    if (x.whole) {
      const j = x.k;
      looks[k] = pp.looks[j];
      if (shots) shots[k] = pp.shots?.[j] ?? null;
      why[k] = pp.why[j] ?? '';
      pops[k] = popsOf(pp, pa, j);
      transitions[k] = pp.transitions?.[j] ?? null;
      moments[k] = pp.moments?.[j] ?? null;
      if (lp && pp.lyricPlan) lp.parts[k] = pp.lyricPlan.parts[j] ? { ...pp.lyricPlan.parts[j]!, at: pp.lyricPlan.parts[j]!.at ?? j } : null;
      // what was planned there stays what a change by hand is told by
      if (base && pp.base) {
        base.looks[k] = pp.base.looks[j] ?? null;
        base.rotate[k] = pp.base.rotate[j] ?? null;
        base.lyric[k] = pp.base.lyric[j] ?? null;
      }
      if (x.liked) likedNext[k] = true;
      keptNext[k] = true;
      kept++;
      continue;
    }
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
    plan: {
      ...plan,
      looks,
      ...(shots ? { shots } : {}),
      ...(lp ? { lyricPlan: whole && pp.lyricPlan ? { ...lp, seed: pp.lyricPlan.seed, family: pp.lyricPlan.family, motion: pp.lyricPlan.motion } : lp } : {}),
      ...(likedNext.some(Boolean) ? { liked: likedNext } : {}),
      ...(whole
        ? {
            kept: keptNext,
            why,
            pops,
            transitions,
            ...(plan.moments || pp.moments ? { moments } : {}),
            ...(base ? { base } : {}),
            ...(pp.paint ? { paint: pp.paint } : {}),
            ...(pp.direction ? { direction: { ...(plan.direction ?? pp.direction), finish: pp.direction.finish } } : {}),
          }
        : {}),
    },
    analysis: r.analysis,
    kept,
  };
}

/** the plan's lines moved onto these times where one is within a beat, each line once and never past another */
function ontoLines(next: { plan: VideoPlan; analysis: TrackAnalysis }, times: number[], beat: number): { plan: VideoPlan; analysis: TrackAnalysis } {
  const was = boundsOf(next.analysis);
  const nb = [...was];
  const used = new Set<number>([0]);
  for (const t of [...new Set(times.map(round3))].sort((x, y) => x - y)) {
    let j = -1;
    for (let k = 1; k < nb.length; k++) if (Math.abs(nb[k] - t) <= beat + 1e-3 && (j < 0 || Math.abs(nb[k] - t) < Math.abs(nb[j] - t))) j = k;
    if (j < 0 || used.has(j) || t <= nb[j - 1] + 0.06 || t >= (nb[j + 1] ?? next.analysis.duration) - 0.06) continue;
    nb[j] = t;
    used.add(j);
  }
  if (nb.every((b, k) => b === was[k])) return next;
  const cut = cutAnalysis(next.analysis, nb);
  if (!cut || cut.sections.length !== was.length) return next;
  // what lands in a part lands at the same moment of the song
  const shots = next.plan.shots?.map((s, k) => {
    const d = nb[k] - was[k];
    if (!s || !d || s.on === undefined) return s;
    if (s.on - d >= 0) return { ...s, on: s.on - d };
    const { hit: _h, on: _o, ramp: _r, ...rest } = s;
    return rest;
  });
  const plan = { ...next.plan, ...(shots ? { shots } : {}), bounds: boundsOf(cut) };
  if (originalOf(cut) === cut) delete (plan as VideoPlan).bounds;
  return { plan, analysis: cut };
}

/** the director's choices made for parts that start exactly here, dealt again (after lines were moved) */
function recue(plan: VideoPlan, bounds: number[], end: number) {
  const src = plan.flat?.src;
  if (!src?.cues || !plan.shots) return;
  const exact = bounds.map((b, k) => src.cues!.find((c) => Math.abs(c.at - b) < 0.06 && (!src.dealt || Math.abs(c.end - (bounds[k + 1] ?? end)) < 0.3)));
  plan.shots = plan.shots.map((s, k) => exact[k]?.shot ?? s);
  if (!src.dealt) underCues(plan, src.cues, bounds);
}

/** the plan with only its kept parts to carry: what a remake that starts fresh still leaves alone (null: none is kept) */
export function keptOnly(plan: VideoPlan | null | undefined, a: TrackAnalysis | null): VideoPlan | null {
  if (!plan?.flat || !a || !validPlan(plan, a) || !plan.kept?.some(Boolean)) return null;
  return { ...plan, base: planBase(plan, a), liked: undefined };
}

/** the stretches of the song that are kept */
export const keptSpans = (plan: VideoPlan | null | undefined, a: TrackAnalysis | null) => (plan && a ? a.sections.filter((_, i) => plan.kept?.[i]).map((s) => ({ start: s.start, end: s.end })) : []);

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
 *   freshPops  the pop-up levels set by hand go, and what was placed by hand (a remake that starts fresh),
 *              but for the parts marked Keep, which come across whatever was asked
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
  const keep = opts.keep ?? (opts.restore ? null : keptOnly(s.plan, prevA));
  if (keep && prevA && validPlan(keep, prevA) && keep.flat) out = carryEdits(f, { plan: keep, analysis: prevA });
  const sameSong = !!prevA && originalOf(prevA) === originalOf(out.analysis);
  const moved = sameSong && !opts.restore && prevA !== out.analysis;
  // a fresh start: the pop-ups set by hand go, outside the parts that are kept
  const held = out.plan.kept;
  const fresh = (pops: (number | null)[] | null) => {
    const p = held && pops?.length === held.length ? pops.map((v, i) => (held[i] ? v : null)) : null;
    return p?.some((v) => v !== null) ? p : null;
  };
  const patch = {
    analysis: out.analysis,
    plan: out.plan,
    planOn: true,
    autoPilot: false,
    ...(prevA !== out.analysis ? { selectedParts: [] as number[] } : {}),
    ...(moved
      ? {
          partPops: opts.freshPops ? fresh(carryByTime(s.partPops, prevA, out.analysis)) : carryByTime(s.partPops, prevA, out.analysis),
          partHand: carryByTime(s.partHand, prevA, out.analysis),
          partWords: carryByTime(s.partWords, prevA, out.analysis),
          // a section's own picture goes to each of its shots, and only when it had one
          partShot: carryByTime(s.partShot, prevA, out.analysis),
        }
      : opts.freshPops
        ? { partPops: fresh(sameSong ? s.partPops : null) }
        : {}),
    ...(opts.freshPops ? { placed: onlyIn(s.placed, sameSong ? keptSpans(out.plan, out.analysis) : []) } : {}),
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
  const ranked = relatedLooks(id, a, plan.looks, (x) => 1.5 * aff(x), undefined, worldOf(plan));
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
