/**
 * Song map + video plan.
 *
 * The analysis splits a song into sections (intro, verse, chorus, build, drop…) and groups the ones
 * that sound alike. A plan gives each section a main look plus a few related looks to rotate through;
 * while "Follow song map" is on, the stage cuts each section into shots (on phrase lines and on things
 * happening in the music, faster when it's loud and busy, see `planShots`), each change with a
 * transition picked to fit the moment (`transitionPick.ts`): long dissolves in calm parts, hard cuts on drops. Every real drop (strength ≥ 0.5) is guaranteed a hard cut to a
 * different look, whoever made the plan. Picking a look while the plan plays puts it into the current section (and into the
 * sections that sound the same), so editing is just: play to a part, pick a look.
 */
import { audioEngine } from '../audio/engine';
import { textBetween } from '../audio/lyrics';
import { harmonize } from '../core/songPalette';
import { lookStyle } from '../core/styles';
import type { AudioFrame, Lyrics, Preset, TrackAnalysis, TrackDrop, TrackSection } from '../core/types';
import { PRESETS } from '../presets';
import { familyIdOf, familyOf, fitScore, neighbourScore, rememberTake, takeFit, takeName } from '../presets/fit';
import { live } from './live';
import { useStudio, type Pace } from './store';
import type { PlanTransition, TransitionId } from '../core/transitionList';
import { moodOf, pickTransition, resolveTransition, type PickContext, type TransitionSpec } from './transitionPick';
import { affinityIn, contextFor, EXPLORE, planSignature, recentPlans, rememberPlan, record, rng, setTransitionProbe, tasteSummary } from './taste';
import { describeLyricPlan, localLyricPlan, mergeLyricPlan, vocalDensity, type LyricPart, type LyricPlan, type TypeFamily } from './lyricPlan';
import { profileFor } from '../render/lyricProfiles';
import type { Direction } from '../core/direction';
import { localDirection, moodDirection, preferredTransitions } from './direction';
import { planKey, savedPlan, savePlan, watchPlan } from './planCache';
import { inMood, moodById, moodFilter, type MoodId } from '../presets/moods';
import type { LyricMedium } from './lyricPlan';

export interface VideoPlan {
  title: string;
  note: string;
  /** preset id per section index */
  looks: (string | null)[];
  /** one short reason per section (Claude plans only) */
  why: string[];
  source: 'claude' | 'local';
  via?: 'api' | 'subscription';
  /** analysis this plan belongs to (sections must match) */
  duration: number;
  /** pop-up windows per section: 0 none … 3 lots (missing → picked from the section's label) */
  pops?: number[];
  /** a board look shown for the first few bars of a section, before its own look (null = none) */
  interludes?: (string | null)[];
  /** extra looks each section rotates through besides its main look (null/missing → picked automatically) */
  rotate?: (string[] | null)[];
  /** bars per shot for each section (null/missing → from the music; the Pace setting scales it) */
  shotBars?: (number | null)[];
  /** how each section arrives and how its shots change (null/missing → picked from the music); strong drops always cut */
  transitions?: (PlanTransition | null)[];
  /** lyric video: how the words appear in each section, its type family and seed (missing → made up per song, see lyricPlan.ts) */
  lyricPlan?: LyricPlan;
  /** the video's Direction: one finish and one transition set for the whole video, plus a type hint (core/direction.ts) */
  direction?: Direction;
  /** the mood the video was planned in (presets/moods.ts): every look the planner picks comes from its world */
  mood?: MoodId;
  /**
   * What the planner chose for each part, kept when the plan is made. A part whose look, pop-ups or
   * lyric style now differ was changed by the person (the part sheet, a drag, a Director edit): those
   * changes survive a re-plan, show on the song map, and "Reset this part" puts the planner's pick back.
   */
  base?: PlanBase;
}

export interface PlanBase {
  looks: (string | null)[];
  rotate: (string[] | null)[];
  /** each part's lyric medium (null: no words there, or no lyric plan) */
  lyric: (LyricMedium | null)[];
}

export const LABEL_NAME: Record<TrackSection['label'], string> = {
  intro: 'Intro',
  verse: 'Verse',
  chorus: 'Chorus',
  bridge: 'Bridge',
  build: 'Build',
  drop: 'Drop',
  break: 'Break',
  outro: 'Outro',
};

/** "Verse 2", "Chorus 1"… numbered only when a label appears more than once */
export function sectionNames(sections: TrackSection[]): string[] {
  const total: Record<string, number> = {};
  for (const s of sections) total[s.label] = (total[s.label] ?? 0) + 1;
  const seen: Record<string, number> = {};
  return sections.map((s) => {
    seen[s.label] = (seen[s.label] ?? 0) + 1;
    return total[s.label] > 1 ? `${LABEL_NAME[s.label]} ${seen[s.label]}` : LABEL_NAME[s.label];
  });
}

export function allLooks(): Preset[] {
  return [...useStudio.getState().customPresets, ...PRESETS];
}
export function findLook(id: string | null | undefined): Preset | undefined {
  return id ? allLooks().find((p) => p.id === id) : undefined;
}

export function sectionIndexAt(sections: TrackSection[], t: number): number {
  for (let i = sections.length - 1; i >= 0; i--) if (t >= sections[i].start) return i;
  return 0;
}

/** the plan belongs to this analysis (one look slot per section, the same length) */
export const validPlan = (plan: VideoPlan | null, a: TrackAnalysis | null): plan is VideoPlan =>
  !!plan && !!a && plan.looks.length === a.sections.length && Math.abs(plan.duration - a.duration) < 0.5;

/* ───────────────────────── drops ───────────────────────── */

/** a drop at least this big always gets a hard cut to a new look */
export const STRONG_DROP = 0.5;

/** every drop with its size (older analyses without sizes count every drop as full size) */
export function dropsOf(a: TrackAnalysis): TrackDrop[] {
  return a.dropInfo ?? a.drops.map((t) => ({ t, strength: 1, why: '' }));
}

const dropCache = new WeakMap<TrackAnalysis, (TrackDrop | null)[]>();
/** the drop each section starts on (null when it doesn't start on one) */
export function sectionDrops(a: TrackAnalysis): (TrackDrop | null)[] {
  let v = dropCache.get(a);
  if (!v) {
    const ds = dropsOf(a);
    v = a.sections.map((sec) => ds.find((d) => Math.abs(d.t - sec.start) < 0.06) ?? null);
    dropCache.set(a, v);
  }
  return v;
}

/** section i starts on a drop big enough that the look must change there */
export function strongDropAt(a: TrackAnalysis, i: number): boolean {
  const d = sectionDrops(a)[i];
  return !!d && d.strength >= STRONG_DROP && i > 0;
}

/**
 * Make sure every strong drop changes the look: if the section that starts on it has the same look
 * as the one before, give it the plan's drop look (or the most intense suitable look) instead. Board
 * interludes never sit on a drop, and bigger drops get busier pop-ups. `keep` is a section the
 * person just set by hand, which is left alone.
 */
export function ensureDropCuts(plan: VideoPlan, a: TrackAnalysis, keep = -1): VideoPlan {
  if (plan.looks.length !== a.sections.length) return plan;
  const looks = [...plan.looks];
  const pops = plan.pops ? [...plan.pops] : a.sections.map((x) => POPS_BY_LABEL[x.label]);
  const interludes = plan.interludes ? [...plan.interludes] : a.sections.map(() => null);
  const why = a.sections.map((_, i) => plan.why[i] ?? '');
  const rotate = a.sections.map((_, i) => plan.rotate?.[i] ?? null);
  const sd = sectionDrops(a);
  let changed = false;
  for (let i = 1; i < a.sections.length; i++) {
    const d = sd[i];
    if (!d || d.strength < STRONG_DROP) continue;
    if (interludes[i]) {
      interludes[i] = null;
      changed = true;
    }
    // (pop-ups the person set by hand live in store.partPops and win over this)
    pops[i] = Math.max(pops[i] ?? 0, d.strength >= 0.75 ? 3 : 2);
    if (i === keep || !looks[i] || looks[i] !== looks[i - 1]) continue;
    const pick = dropLook(looks, a, i, looks[i - 1], moodFilter(plan.mood));
    if (!pick) continue;
    looks[i] = pick.id;
    rotate[i] = null;
    why[i] = why[i] ? `${why[i]} — switched at the drop` : `New look for the drop (${d.why || 'the bass comes back'})`;
    changed = true;
  }
  const popsChanged = !plan.pops || pops.some((v, i) => v !== plan.pops![i]);
  if (!changed && !popsChanged) return plan;
  return { ...plan, looks, pops, interludes, why, rotate };
}

/** the look a drop should cut to when the plan left it on the look before */
function dropLook(looks: (string | null)[], a: TrackAnalysis, i: number, avoid: string | null, allow?: (p: Preset) => boolean): Preset | undefined {
  const prev = findLook(avoid);
  const ok = (p: Preset | undefined): p is Preset => !!p && p.id !== avoid && !p.sceneId.startsWith('board-') && (!allow || allow(p));
  const differentScene = (p: Preset) => !prev || p.sceneId !== prev.sceneId;
  const sd = sectionDrops(a);
  // 1. a look this plan already uses on another strong drop, then on another drop or chorus
  const used = (pred: (j: number) => boolean) =>
    looks
      .map((id, j) => (j !== i && pred(j) ? findLook(id) : undefined))
      .filter(ok)
      .sort((x, y) => Number(differentScene(y)) - Number(differentScene(x)))[0];
  const fromPlan =
    used((j) => (sd[j]?.strength ?? 0) >= STRONG_DROP) ?? used((j) => a.sections[j].label === 'drop' || a.sections[j].label === 'chorus');
  if (fromPlan) return fromPlan;
  // 2. the look the analysis suggested that best suits a drop (by its family's fit), preferably from
  //    another family than the look before, so the hit shows
  const suggested = a.suggestedPresets.map((id) => findLook(id)).filter(ok);
  const pool = suggested.length ? suggested : allLooks().filter(ok);
  const e = partEnergy(a, i);
  const score = (p: Preset) => fitScore(p, 'drop', e) + (prev ? 0.5 * neighbourScore(p, prev) : 0) + (prev && familyIdOf(p) === familyIdOf(prev) ? -2 : 0);
  return [...pool].sort((x, y) => Number(differentScene(y)) - Number(differentScene(x)) || score(y) - score(x))[0];
}

/* ───────────────────────── shots ───────────────────────── */

/**
 * A plan gives each section a main look; the sequencer cuts each section into shots so the picture
 * keeps moving. Shots fall on phrase lines (every 1/2/4/8 bars: shorter when the part is loud and
 * busy, longer when it's calm, and never longer than about ten seconds at the normal pace), and extra
 * cuts land where something happens: the kick or bass coming back, a vocal coming in, a new lyric
 * line, a smaller drop or a big hit. A section rotates through 2–4 related looks, so it still reads as
 * one part with one mood. Every strong drop is still a hard cut to the section's own main look.
 */
export interface Shot {
  /** seconds */
  t: number;
  lookId: string;
  /** how this shot arrives (length in beats, so it follows the tempo) */
  tr: TransitionSpec;
  /** lands on a drop big enough that it always cuts, whatever the Transition setting */
  strongDrop?: boolean;
  /** what the transition picker knew about this shot (filled in once all shot times are known) */
  pick?: Omit<PickContext, 'seed' | 'prev' | 'room'>;
  section: number;
  /** what the cut lands on */
  on: 'section' | 'interlude' | 'phrase' | 'hit' | 'drop' | 'vocal' | 'lyric' | 'resolve';
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round2 = (v: number) => Math.round(v * 100) / 100;
const countIn = (xs: number[], s0: number, s1: number) => {
  let n = 0;
  for (const x of xs) if (x >= s0 && x < s1) n++;
  return n;
};

/** how busy a section sounds, 0 sparse … 1 dense (drum hits and bass notes per second) */
function busyness(a: TrackAnalysis, sec: TrackSection): number {
  const L = a.layers;
  if (!L) return a.mood.density;
  const len = Math.max(1, sec.end - sec.start);
  const hits = countIn(L.kick, sec.start, sec.end) + countIn(L.snare, sec.start, sec.end) + 0.6 * countIn(L.hat, sec.start, sec.end);
  const notes = L.bass.filter((n) => n.t >= sec.start && n.t < sec.end).length + 0.5 * L.lead.filter((n) => n.t >= sec.start && n.t < sec.end).length;
  return clamp01((hits / len - 0.8) / 6 + notes / len / 8);
}

/* ───────────────────────── harmony ───────────────────────── */

/** the nearest chord change to t within `within` seconds (t itself when there is none) */
export function snapToChord(t: number, changes: number[], within: number): number {
  let best = t;
  let d = within;
  for (const c of changes) {
    const e = Math.abs(c - t);
    if (e <= d) {
      d = e;
      best = c;
    }
    if (c > t + within) break;
  }
  return best;
}

/**
 * Section i plays an earlier part again, turned up (a second chorus louder than the first), or sits
 * in a key the song lifted into: either way it should feel bigger, so it cuts a little faster.
 */
export function turnedUp(a: TrackAnalysis, i: number): number {
  const h = a.harmony?.sections[i];
  if (!h) return 0;
  let v = h.lift ? 0.1 : 0;
  if (h.repeatOf !== undefined && a.sections[i].energy >= a.sections[h.repeatOf].energy - 0.02) v += 0.06;
  return v;
}

const PACE_MUL: Record<Pace, number> = { slow: 1.6, song: 1, fast: 0.6 };
const PACE_CAP: Record<Pace, number> = { slow: 16, song: 10, fast: 6 };
const LABEL_MUL: Record<TrackSection['label'], number> = { intro: 1.15, verse: 1, chorus: 0.85, bridge: 1, build: 0.9, drop: 0.8, break: 1.15, outro: 1.15 };

interface SectionPacing {
  /** seconds per phrase shot */
  shotLen: number;
  bars: number;
  /** the longest any one look may hold */
  cap: number;
  /** no two cuts closer than this */
  minGap: number;
  /** 0 calm … 1 loud and busy */
  drive: number;
}

/** how fast section i should cut, from its energy, busyness, tempo, label, the song's mood and the Pace setting */
export function sectionPacing(plan: VideoPlan, a: TrackAnalysis, i: number, pace: Pace): SectionPacing {
  const sec = a.sections[i];
  const bar = 240 / Math.max(50, Math.min(200, a.bpm || 120));
  const mood = moodOf(a);
  const drive = clamp01(0.6 * sec.energy + 0.4 * busyness(a, sec) + turnedUp(a, i));
  const cap = PACE_CAP[pace];
  let bars: number;
  const given = plan.shotBars?.[i];
  if (given) {
    bars = given * (pace === 'slow' ? 2 : pace === 'fast' ? 0.5 : 1);
  } else {
    const target = (9 - 6 * drive) * LABEL_MUL[sec.label] * (mood === 'soft' ? 1.25 : mood === 'hard' ? 0.85 : 1) * PACE_MUL[pace];
    bars = [1, 2, 4, 8, 16].reduce((best, b) => (Math.abs(Math.log((b * bar) / target)) < Math.abs(Math.log((best * bar) / target)) ? b : best), 4);
  }
  bars = Math.max(1, Math.min(16, bars));
  while (bars > 1 && bars * bar > cap + 0.01) bars /= 2;
  const shotLen = bars * bar;
  return {
    shotLen,
    bars,
    cap: Math.max(cap, shotLen),
    minGap: Math.max(1.5, (pace === 'slow' ? 0.8 : 0.5) * shotLen),
    drive,
  };
}

/** how many looks a section rotates through: 2 when calm, up to 4 when loud */
function poolSize(drive: number, pace: Pace, given?: number): number {
  const base = given ? given : drive < 0.35 ? 2 : drive < 0.6 ? 3 : 4;
  return Math.max(2, Math.min(4, base + (pace === 'slow' ? -1 : pace === 'fast' ? 1 : 0)));
}

/**
 * Looks that sit well next to `mainId` in one section, best first: curated pairs (and never a clash),
 * shared tags, what the analysis suggested for this song, the same style family, a similar energy, and
 * how well each suits the part (`part`: its label and energy) by its family's fit. Other takes of the
 * main look's own family rank low: with Song colours on they look almost alike, so the cut wouldn't show.
 * Looks that are other sections' main looks rank lower so the parts stay distinct. Never boards.
 * `allow` keeps the picks inside a mood's world (presets/moods.ts).
 */
export function relatedLooks(
  mainId: string,
  a: TrackAnalysis,
  mains: (string | null)[] = [],
  bias?: (id: string) => number,
  part?: { label: TrackSection['label']; energy: number },
  allow?: (p: Preset) => boolean,
): string[] {
  const m = findLook(mainId);
  if (!m) return [];
  const sug = a.suggestedPresets;
  const others = new Set(mains.filter((id): id is string => !!id && id !== mainId));
  // other parts' main families too: a take of the next part's family here would blur the change
  const otherFams = new Set([...others].map((id) => findLook(id)).filter((p): p is Preset => !!p).map(familyIdOf));
  otherFams.delete(familyIdOf(m));
  const mE = energyMid(m);
  return allLooks()
    .filter((p) => p.id !== mainId && !p.sceneId.startsWith('board-') && (!p.custom || sug.includes(p.id)) && (!allow || allow(p)))
    .map((p) => {
      const r = sug.indexOf(p.id);
      const overlap = Math.min(5, p.tags.filter((t) => m.tags.includes(t)).length) * 0.5;
      const style = lookStyle(p) === lookStyle(m) ? 0.5 : 0;
      const f = part ? fitScore(p, part.label, part.energy) : 0;
      const fit = (f > 0 ? 0.7 : 1.4) * f;
      const score =
        overlap + style + 1.1 * neighbourScore(p, m) + fit + (r >= 0 ? 1.6 - r * 0.08 : 0) - 2 * Math.abs(energyMid(p) - mE) - (others.has(p.id) || otherFams.has(familyIdOf(p)) ? 0.6 : 0) + (bias ? bias(p.id) : 0);
      return { id: p.id, score };
    })
    .sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1))
    .slice(0, 6)
    .map((x) => x.id);
}

/** the middle of a look's energy range (its take's, from its family's fit) */
const energyMid = (p: Preset) => {
  const [lo, hi] = takeFit(p).energy;
  return (lo + hi) / 2;
};

/**
 * The energy a part asks of its look: the section's own (which is relative to the song), pulled toward
 * how intense the whole song is, and a little more when it starts on a drop.
 */
export function partEnergy(a: TrackAnalysis, i: number): number {
  const sec = a.sections[i];
  const d = sectionDrops(a)[i];
  return clamp01(0.55 * sec.energy + 0.45 * (a.mood?.arousal ?? 0.5) + (d ? 0.15 * d.strength : 0));
}

/** the looks section i rotates through, main look first */
function poolFor(plan: VideoPlan, a: TrackAnalysis, i: number, pace: Pace, drive: number): string[] {
  const main = plan.looks[i];
  if (!main) return [];
  const given = plan.rotate?.[i] ?? null;
  const want = poolSize(drive, pace, given ? given.length + 1 : undefined);
  // the look the next part starts on stays out, so every section change (and every drop) shows
  const next = plan.looks[i + 1];
  // taste memory: looks the person skipped in this kind of part don't come back in its rotation
  const aff = affinityIn(contextFor(a.sections[i].label));
  const ok = (id: string) => id !== main && id !== next && !!findLook(id) && !findLook(id)!.sceneId.startsWith('board-') && aff(id) > -0.4;
  const extras: string[] = [];
  for (const id of [...(given ?? []), ...relatedLooks(main, a, plan.looks, undefined, { label: a.sections[i].label, energy: partEnergy(a, i) }, moodFilter(plan.mood))]) {
    if (extras.length >= want - 1) break;
    if (ok(id) && !extras.includes(id)) extras.push(id);
  }
  return [main, ...extras];
}

const shotCache = new WeakMap<VideoPlan, { a: TrackAnalysis; pace: Pace; lyrics: Lyrics | null; shots: Shot[] }>();

/** every shot of the plan in time order (cached per plan, analysis, pace and lyrics) */
export function planShots(plan: VideoPlan, a: TrackAnalysis, pace: Pace = 'song', lyrics: Lyrics | null = null): Shot[] {
  const hit = shotCache.get(plan);
  if (hit && hit.a === a && hit.pace === pace && hit.lyrics === lyrics) return hit.shots;
  const shots = buildShots(plan, a, pace, lyrics?.synced ? lyrics : null);
  shotCache.set(plan, { a, pace, lyrics, shots });
  return shots;
}

function buildShots(plan: VideoPlan, a: TrackAnalysis, pace: Pace, lyrics: Lyrics | null): Shot[] {
  const secs = a.sections;
  const out: Shot[] = [];
  const beat = 60 / Math.max(50, Math.min(200, a.bpm || 120));
  const L = a.layers;
  const kicks = L?.kick ?? [];
  const sd = sectionDrops(a);
  // chord changes: phrase cuts slide onto one when it's within a beat, so the picture turns with the harmony
  const chordChanges = a.harmony?.changes ?? [];
  const resolutions = a.harmony?.resolutions ?? [];
  // the look on screen and when it came on, so a look carried over from the last section still counts
  let lastLook = '';
  let lastChange = 0;
  const track = (from: number) => {
    for (let k = from; k < out.length; k++) {
      if (out[k].lookId !== lastLook) {
        lastLook = out[k].lookId;
        lastChange = out[k].t;
      }
    }
  };
  for (let i = 0; i < secs.length; i++) {
    const sec = secs[i];
    const main = plan.looks[i];
    if (!main) continue;
    const first = out.length;
    const P = sectionPacing(plan, a, i, pace);
    const pool = poolFor(plan, a, i, pace, P.drive);
    // when the main look is already on screen from the section before, the new part opens on the
    // next look in its rotation instead, so the section change still shows
    const shift = lastLook === main && !plan.interludes?.[i] && pool.length > 1 ? 1 : 0;
    const heldBefore = lastLook === main && !shift && !plan.interludes?.[i] ? sec.start - lastChange : 0;
    const here = { label: sec.label, energy: sec.energy };
    const strong = strongDropAt(a, i);
    const into: Shot['pick'] = { on: 'section', ...here, first: i === 0, strongDrop: strong, drop: sd[i]?.strength ?? 0 };
    // a board interlude takes the first bars, then the section's own look comes in
    let s0 = sec.start;
    const inter = plan.interludes?.[i];
    if (inter && findLook(inter)) {
      out.push({ t: sec.start, lookId: inter, tr: CUT, section: i, on: 'interlude', pick: { ...into, on: 'interlude' } });
      s0 = sec.start + interludeLength(sec, a.bpm);
      out.push({ t: s0, lookId: main, tr: CUT, section: i, on: 'section', pick: { on: 'phrase', ...here, fromInterlude: true } });
    } else out.push({ t: sec.start, lookId: pool[shift], tr: CUT, section: i, on: 'section', strongDrop: strong, pick: into });
    const s1 = sec.end;
    if (pool.length < 2 || (s1 - s0 < P.minGap * 2 && heldBefore + s1 - s0 <= P.cap)) {
      track(first);
      continue;
    }

    // things that happen inside the section
    const snapBeat = (t: number) => {
      const k = kicks.find((x) => Math.abs(x - t) < 0.15);
      if (k !== undefined) return k;
      const g = sec.start + Math.round((t - sec.start) / beat) * beat;
      return Math.abs(g - t) <= 0.3 ? g : t;
    };
    const events: { t: number; on: Shot['on']; pri: number; drop?: number }[] = [];
    const bar = 4 * beat;
    if (L) {
      // the kick or the bass coming back after two bars or more away
      for (let k = 0; k < kicks.length; k++) {
        const t = kicks[k];
        if (t > s0 && t < s1 && (k === 0 || t - kicks[k - 1] >= 2 * bar)) events.push({ t, on: 'hit', pri: 3 });
      }
      let lastEnd = -1e9;
      for (const n of L.bass) {
        if (n.t > s0 && n.t < s1 && n.t - lastEnd >= 2 * bar) events.push({ t: n.t, on: 'hit', pri: 3 });
        lastEnd = Math.max(lastEnd, n.end);
      }
      for (const [v0] of L.vocal) if (v0 > s0 && v0 < s1) events.push({ t: snapBeat(v0), on: 'vocal', pri: 2 });
    }
    // smaller drops inside the section
    for (const d of dropsOf(a)) if (d.t > s0 + 0.1 && d.t < s1 && !sd.includes(d)) events.push({ t: d.t, on: 'drop', pri: 3, drop: d.strength });
    // sudden jumps in loudness (a big hit or a new layer)
    const ec = a.energyCurve;
    if (ec?.length) {
      const dt = a.duration / ec.length;
      const w = Math.max(1, Math.round(0.5 / dt));
      let prevRise = 0;
      for (let j = Math.ceil(s0 / dt) + w; j < Math.floor(s1 / dt) - w; j++) {
        const rise = ec[j + w] - ec[j - w];
        const nextRise = ec[j + 1 + w] - ec[j + 1 - w];
        // the loudness curve is coarse, so a new layer is placed by the chord change it comes in with when there's one close
        if (rise > 0.2 && rise >= prevRise && rise >= nextRise && ec[j + w] > sec.energy) {
          const at = snapToChord(j * dt, chordChanges, 1.5 * beat);
          events.push({ t: at === j * dt ? snapBeat(at) : at, on: 'hit', pri: 3 });
        }
        prevRise = rise;
      }
    }
    // a new lyric line after a pause
    const lines = lyrics?.lines ?? [];
    for (let k = 0; k < lines.length; k++) {
      const t = lines[k].t;
      if (t > s0 && t < s1 && (k === 0 || t - lines[k - 1].end >= bar * 0.75)) events.push({ t: snapBeat(t), on: 'lyric', pri: 2 });
    }
    // where the harmony comes home: a natural place for the picture to change or settle
    for (const r of resolutions) if (r.t > s0 && r.t < s1 && r.strength >= 0.5) events.push({ t: r.t, on: 'resolve', pri: 2 });
    // the phrase grid, nudged onto a lyric line when one starts nearby, else onto a chord change
    for (let t = s0 + P.shotLen; t < s1 - 0.5; t += P.shotLen) {
      const line = lines.find((l) => Math.abs(l.t - t) < Math.min(bar * 0.5, P.shotLen * 0.25));
      events.push({ t: line ? snapBeat(line.t) : snapToChord(t, chordChanges, beat), on: line ? 'lyric' : 'phrase', pri: 1 });
    }
    // keep the most meaningful cuts that are far enough apart
    events.sort((x, y) => y.pri - x.pri || x.t - y.t);
    const cuts: { t: number; on: Shot['on']; drop?: number }[] = [];
    const endGap = Math.max(1.2, P.minGap * 0.75);
    for (const e of events) {
      if (e.t - s0 < P.minGap || s1 - e.t < endGap) continue;
      if (cuts.some((c) => Math.abs(c.t - e.t) < P.minGap)) continue;
      cuts.push(e);
    }
    cuts.sort((x, y) => x.t - y.t);
    // no look holds longer than the cap (counting time it was already on before this section)
    const filled: { t: number; on: Shot['on']; drop?: number }[] = [];
    let prev = s0;
    let budget = Math.max(P.minGap, P.cap - heldBefore);
    for (const c of [...cuts, { t: s1, on: 'section' as const }]) {
      while (c.t - prev > budget) {
        const n = Math.ceil((c.t - prev) / budget);
        const t = snapToChord(sec.start + Math.round((prev + (c.t - prev) / n - sec.start) / beat) * beat, chordChanges, beat);
        if (t - prev < 1 || c.t - t < 1) break;
        filled.push({ t, on: 'phrase' });
        prev = t;
        budget = P.cap;
      }
      if (c.t < s1) filled.push(c);
      prev = c.t;
      budget = P.cap;
    }
    filled.forEach((c, k) => {
      const strongDrop = (c.drop ?? 0) >= STRONG_DROP;
      out.push({
        t: c.t,
        lookId: pool[(k + 1 + shift) % pool.length],
        tr: CUT,
        strongDrop,
        section: i,
        on: c.on,
        pick: { on: c.on, ...here, drop: c.drop ?? 0, strongDrop },
      });
    });
    track(first);
  }
  // transitions, now that every shot's neighbours are known: picked from the music, or the plan's own
  // choice for that section; strong drops always cut
  let prev: TransitionId | undefined;
  const prefer = preferredTransitions(plan);
  out.forEach((sh, k) => {
    const room = Math.min(sh.t - (out[k - 1]?.t ?? -1e9), (out[k + 1]?.t ?? a.duration) - sh.t);
    const picked = pickTransition(a, { ...sh.pick!, seed: k * 7.31 + Math.round(a.duration), prev, room, prefer });
    const own = plan.transitions?.[sh.section];
    const ownId = sh.on === 'section' || sh.on === 'interlude' ? own?.into : own?.within;
    if (ownId && !sh.strongDrop && k > 0) {
      const beats = ownId === 'cut' ? 0 : (own?.beats ?? (picked.beats || 1));
      sh.tr = { id: ownId, beats: Math.min(beats, Math.max(0.25, (room * 0.6) / beat)) };
    } else sh.tr = picked;
    prev = sh.tr.id;
  });
  return out;
}

const CUT: TransitionSpec = { id: 'cut', beats: 0 };

/** index of the last shot starting at or before t */
export function shotIndexAt(shots: Shot[], t: number): number {
  let lo = 0;
  let hi = shots.length - 1;
  if (hi < 0 || t < shots[0].t) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (shots[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/* ───────────────────────── sequencer (runs every frame) ───────────────────────── */

/** transitions start up to half their length early, so they're halfway through on the beat */
const LEAD_S = 1.6;
/** hard cuts fire a frame early so the new look is on screen when the hit lands */
const CUT_EARLY_S = 0.02;

/** a look picked by hand stays on screen until the next shot, instead of being rotated away at once */
let hold: { plan: VideoPlan; from: number; until: number } | null = null;

export function planTick(f: AudioFrame) {
  const s = useStudio.getState();
  if (!s.planOn || audioEngine.kind !== 'file' || !validPlan(s.plan, s.analysis)) return;
  const shots = planShots(s.plan!, s.analysis!, s.pace, s.lyrics);
  if (!shots.length) return;
  const t = f.time;
  const bpm = s.analysis!.bpm;
  const resolved = (sh: Shot, k: number) => resolveTransition(sh.tr, { strongDrop: sh.strongDrop, bpm, seed: k * 7.31 + 1 });
  const early = (sh: Shot, k: number) => {
    if (!f.playing) return 0;
    const r = resolved(sh, k);
    return r.id === 'cut' ? CUT_EARLY_S : Math.min(LEAD_S, r.ms / 2000);
  };
  let k = shotIndexAt(shots, t + LEAD_S);
  while (k > 0 && shots[k].t - early(shots[k], k) > t) k--;
  const sh = shots[k];
  // get the next shot's scene ready a moment before it starts
  const next = shots[k + 1];
  if (next && f.playing && next.t - t < 2.5) {
    const nl = findLook(next.lookId);
    if (nl && nl.id !== s.presetId) live.stage?.prewarm(nl.sceneId, nl.effects);
  }
  if (hold) {
    if (hold.plan === s.plan && t >= hold.from - 0.5 && t < hold.until) return;
    hold = null;
  }
  const look = findLook(sh.lookId);
  const tint = tintState();
  if (!look || (look.id === s.presetId && tint === lastTint)) return;
  const recolour = look.id === s.presetId;
  lastTint = tint;
  const since = t - (sh.t - early(sh, k));
  // a shot reached by seeking or pausing gets a short crossfade instead of its own transition
  if (live.stage) live.stage.nextTransition = recolour ? { id: 'crossfade', ms: 600, seed: k } : f.playing && since < 0.35 ? resolved(sh, k) : { id: 'crossfade', ms: f.playing ? 400 : 250, seed: k };
  s.applyPreset(songTinted(look));
}

/**
 * The sequencer's own memory (a look held after a hand pick, the colours last put on screen), so a
 * render can start it fresh and put it back afterwards.
 */
export function planSequencerState(): { hold: typeof hold; lastTint: string } {
  return { hold, lastTint };
}
export function restorePlanSequencer(st: { hold: typeof hold; lastTint: string }) {
  hold = st.hold;
  lastTint = st.lastTint;
}

/** how long a board interlude plays at the top of a section: 4 bars, at most ~45% of the section */
export function interludeLength(sec: TrackSection, bpm: number): number {
  const bars4 = (16 * 60) / Math.max(40, bpm || 120);
  return Math.max(2.5, Math.min(bars4, (sec.end - sec.start) * 0.45));
}

/* ───────────────────────── song colours ───────────────────────── */

/**
 * The look a video's colours come from: the one on screen for most of the song (choruses and drops
 * count double, since that's what people remember). Null when there's no plan to follow.
 */
export function keyLookOf(plan: VideoPlan | null, a: TrackAnalysis | null): Preset | undefined {
  if (!plan || !a || !validPlan(plan, a)) return undefined;
  const time = new Map<string, number>();
  a.sections.forEach((sec, i) => {
    const id = plan.looks[i];
    if (!id) return;
    const w = sec.label === 'chorus' || sec.label === 'drop' ? 2 : 1;
    time.set(id, (time.get(id) ?? 0) + w * (sec.end - sec.start));
  });
  let best: string | null = null;
  for (const [id, t] of time) if (!best || t > time.get(best)!) best = id;
  return findLook(best);
}

const tinted = new Map<string, Preset>();

/**
 * A look with its colours pulled toward the video's main look (the Song colours setting). The main
 * look itself, and every look when the setting is off or no plan is playing, comes back unchanged.
 */
export function songTinted(p: Preset): Preset {
  const s = useStudio.getState();
  if (s.songColors === 'off' || !s.planOn) return p;
  const key = keyLookOf(s.plan, s.analysis);
  if (!key || key.id === p.id) return p;
  const strength = s.songColors === 'match' ? 1 : 0.55;
  const k = `${p.id}|${key.id}|${strength}|${p.palette.bg}${p.palette.accent}${key.palette.accent}${key.palette.accent2}`;
  let out = tinted.get(k);
  if (!out) {
    if (tinted.size > 200) tinted.clear();
    out = { ...p, palette: { ...harmonize(p.palette, key.palette, strength), id: p.palette.id, name: p.palette.name } };
    tinted.set(k, out);
  }
  return out;
}

/** which colours were last put on screen, so changing the setting recolours the look that's showing */
let lastTint = '';
const tintState = () => {
  const s = useStudio.getState();
  return `${s.songColors}|${s.songColors === 'off' ? '' : (keyLookOf(s.plan, s.analysis)?.id ?? '')}`;
};

/* ───────────────────────── pop-up windows ───────────────────────── */

/** pop-ups per section label when the plan doesn't say */
const POPS_BY_LABEL: Record<TrackSection['label'], number> = { intro: 1, verse: 1, chorus: 2, bridge: 1, build: 2, drop: 3, break: 1, outro: 0 };

/**
 * How busy the pop-up layer should be right now: 0 none … 3 lots. "In videos" follows the playing
 * video plan (its per-section marks, or the section's label); "Always" keeps a few coming anyway.
 */
export function popLevelAt(t: number): number {
  const s = useStudio.getState();
  if (s.popups === 'off') return 0;
  const a = s.analysis;
  const planned = s.planOn && audioEngine.kind === 'file' && validPlan(s.plan, a);
  if (planned) return partPopsAt(sectionIndexAt(a!.sections, t)).level;
  if (s.popups !== 'always') return 0;
  if (!a?.sections.length) return 1;
  const i = sectionIndexAt(a.sections, t);
  const mine = s.partPops?.[i];
  return typeof mine === 'number' ? mine : Math.max(1, POPS_BY_LABEL[a.sections[i].label]);
}

/**
 * Part i's pop-up level now (0 none … 3 lots) and whether it's the person's own (store.partPops,
 * set with setPartPops) rather than the planner's. 0 turns off the instrument pop-ups and the scene
 * windows both, since both read popLevelAt.
 */
export function partPopsAt(i: number): { level: number; mine: boolean } {
  const s = useStudio.getState();
  const o = s.partPops?.[i];
  if (typeof o === 'number') return { level: Math.max(0, Math.min(3, Math.round(o))), mine: true };
  const a = s.analysis;
  if (!a?.sections[i]) return { level: 1, mine: false };
  return { level: validPlan(s.plan, a) ? popsOf(s.plan!, a, i) : POPS_BY_LABEL[a.sections[i].label], mine: false };
}

/* ───────────────────────── picks while a plan is on ───────────────────────── */

/**
 * Use a look. With the song map on, it also goes into the section that's playing and into every
 * section that sounds the same and shared that section's look.
 */
export function pickLook(p: Preset) {
  const s = useStudio.getState();
  // the family's card plays this take next time
  rememberTake(p);
  if (s.planOn && validPlan(s.plan, s.analysis)) {
    const t = audioEngine.currentTime;
    const i = sectionIndexAt(s.analysis!.sections, t);
    assignLook(i, p.id, true);
    // keep the pick on screen until the next shot rather than rotating away from it at once
    const now = useStudio.getState();
    if (now.plan) {
      const shots = planShots(now.plan, now.analysis!, now.pace, now.lyrics);
      const k = shotIndexAt(shots, t);
      hold = { plan: now.plan, from: t, until: shots[k + 1]?.t ?? Infinity };
    }
  }
  s.applyPreset(songTinted(p));
}

/** Put a look into section i (and its look-alikes when `spread`). */
export function assignLook(i: number, presetId: string, spread = true) {
  const s = useStudio.getState();
  if (!s.analysis) return;
  const secs = s.analysis.sections;
  const plan: VideoPlan = validPlan(s.plan, s.analysis)
    ? { ...s.plan!, looks: [...s.plan!.looks], rotate: secs.map((_, j) => s.plan!.rotate?.[j] ?? null) }
    : { title: 'Your song map', note: '', looks: secs.map(() => null), why: [], source: 'local', duration: s.analysis.duration };
  const old = plan.looks[i];
  plan.looks[i] = presetId;
  // a section with a new main look gets a fresh rotation around it
  if (plan.rotate) plan.rotate[i] = null;
  let also = 0;
  if (spread) {
    secs.forEach((sec, j) => {
      if (j !== i && sec.group === secs[i].group && plan.looks[j] === old) {
        plan.looks[j] = presetId;
        if (plan.rotate) plan.rotate[j] = null;
        also++;
      }
    });
  }
  // fill empty sections so the song map always has something to follow
  for (let j = 0; j < plan.looks.length; j++) if (!plan.looks[j]) plan.looks[j] = presetId;
  // the section you picked stays as you set it; strong drops elsewhere still get their cut
  s.set({ plan: ensureDropCuts(plan, s.analysis, i), planOn: true, autoPilot: false });
  const names = sectionNames(secs);
  const look = findLook(presetId);
  s.flash(`${names[i]}${also ? ` and ${also} like it now use` : ' now uses'} “${look?.name ?? 'this look'}”`);
}

/** A scene isn't a saved look, so picking one pauses the song map rather than fighting it. */
export function pickScene(id: string) {
  const s = useStudio.getState();
  if (s.planOn) {
    s.set({ planOn: false });
    s.flash('Song map paused while you try a scene. Turn “Follow” back on to resume.');
  }
  s.setScene(id);
}

/* ───────────────────────── offline planner ───────────────────────── */

/**
 * A plan without Claude: a calm look for intros, breaks and outros, a main one for verses and builds,
 * a peak one for choruses and drops, and a fourth for a bridge. Each is chosen for the parts it plays
 * by its family's fit (roles, energy, motion; presets/fit.ts) and for sitting well with the ones
 * already chosen (curated pairs, never a clash, never two takes of one family), as well as for the
 * song's mood. Sections that sound alike always share a look. With a `mood` (presets/moods.ts) every
 * look, rotation and interlude comes from that mood's world, and the direction is the mood's.
 */
export function localPlan(a: TrackAnalysis, opts: { seed?: number; mood?: MoodId } = {}): VideoPlan {
  const mood = moodById(opts.mood);
  const moodOk = moodFilter(opts.mood);
  // a mood whose looks are all missing (it can't happen with the built-in table) plans without it
  const allow = moodOk && PRESETS.some((p) => moodOk(p) && !p.sceneId.startsWith('board-')) ? moodOk : undefined;
  const ok = (p: Preset) => !allow || allow(p);
  // the curated looks first, then the person's own, then everything else
  const suggested = a.suggestedPresets.map((id) => findLook(id)).filter((p): p is Preset => !!p && ok(p));
  const ranked = [...suggested.filter((p) => !p.custom), ...suggested.filter((p) => p.custom)];
  for (const p of PRESETS) if (!ranked.includes(p) && ok(p)) ranked.push(p);
  // taste memory + a seed: which looks play each role (see the taste block below)
  const { main, peak, calm, bridge, bias } = tastefulRoles(ranked, suggested, a, opts.seed);
  const byLabel: Record<TrackSection['label'], Preset> = {
    intro: calm,
    outro: calm,
    break: calm,
    verse: main,
    build: main,
    chorus: peak,
    drop: peak,
    bridge,
  };
  const groupLook = new Map<number, string>();
  const looks = a.sections.map((s) => {
    const id = groupLook.get(s.group) ?? byLabel[s.label].id;
    if (!groupLook.has(s.group)) groupLook.set(s.group, id);
    return id;
  });
  const pops = a.sections.map((s) => POPS_BY_LABEL[s.label]);
  // one busy instrument-board interlude: at the top of the bridge or break (else the second verse)
  const interludes: (string | null)[] = a.sections.map(() => null);
  const used = new Set(looks);
  let at = a.sections.findIndex((s, i) => i > 0 && (s.label === 'bridge' || s.label === 'break'));
  if (at < 0) at = a.sections.findIndex((s, i) => s.label === 'verse' && a.sections.slice(0, i).some((x) => x.label === 'verse'));
  // short songs: open the first build (or the first verse after the intro) with it instead
  if (at < 0) at = a.sections.findIndex((s, i) => i > 0 && (s.label === 'build' || s.label === 'verse'));
  // the board that suits that part best (its fit, and sitting well with the part's own look)
  const boards = allLooks().filter((p) => !p.custom && p.sceneId.startsWith('board-') && !used.has(p.id) && ok(p));
  const host = at > 0 ? findLook(looks[at]) : undefined;
  const boardScore = (p: Preset) =>
    (suggested.includes(p) ? 1 : 0) + (at > 0 ? fitScore(p, a.sections[at].label, partEnergy(a, at)) : 0) + (host ? 0.5 * neighbourScore(p, host) : 0) + ((Math.floor(a.duration) + boards.indexOf(p)) % 5) * 0.05;
  const boardPick = [...boards].sort((x, y) => boardScore(y) - boardScore(x))[0];
  if (boardPick && at > 0 && a.sections.length >= 4) interludes[at] = boardPick.id;
  // each part rotates through related looks: 2 in calm parts, up to 4 in loud busy ones (sections
  // that share a main look share the rotation, so a returning chorus looks like itself)
  const pools = new Map<string, string[]>();
  const rotate = looks.map((id, i) => {
    const want = poolSize(sectionPacing({ looks } as VideoPlan, a, i, 'song').drive, 'song') - 1;
    const key = `${id}|${want}`;
    if (!pools.has(key)) pools.set(key, relatedLooks(id, a, looks, bias(a.sections[i].label), { label: a.sections[i].label, energy: partEnergy(a, i) }, allow).slice(0, want));
    return pools.get(key)!;
  });
  const names = sectionNames(a.sections);
  // one direction for the whole video: a finish and a motion vocabulary that fit its looks and the song
  const direction = mood && allow ? moodDirection(a, mood, looks.map((id) => findLook(id))) : localDirection(a, looks.map((id) => findLook(id)), opts.seed ?? Math.round(a.duration * 7));
  // say only what the song uses ("the big moments" on a song without any would be a promise it can't keep)
  const usedRoles = new Set(looks);
  const lean = [
    usedRoles.has(calm.id) ? `calm parts lean on “${familyOf(calm).name}”` : '',
    usedRoles.has(main.id) ? `the body on “${familyOf(main).name}”` : '',
    usedRoles.has(peak.id) ? `the big moments on “${familyOf(peak).name}”` : '',
    usedRoles.has(bridge.id) && bridge.id !== main.id ? `the bridge on “${familyOf(bridge).name}”` : '',
  ].filter(Boolean);
  const leanText = lean.length ? `${lean.join(', ').replace(/^./, (c) => c.toUpperCase())}, each picked for the part it plays and rotating through a few looks that sit with it.` : '';
  return ensureDropCuts({
    title: mood && allow ? `${mood.name} song map` : 'Song map',
    ...(mood && allow ? { mood: mood.id } : {}),
    note: `${leanText} Parts that sound alike share their looks.${
      boardPick && interludes[at] ? ` ${names[at]} opens with “${boardPick.name}” for a few bars, and little windows pop up on the big moments.` : ''
    } ${direction.why ?? ''}`.trim(),
    direction,
    looks,
    why: [],
    source: 'local',
    duration: a.duration,
    pops,
    interludes,
    rotate,
  }, a);
}

/* ───────────────────────── one-click video ───────────────────────── */

/**
 * Plan a video for the loaded song: Claude picks a look per section (offline plan if Claude isn't
 * reachable), then the song restarts from the top with the song map on.
 *
 * `mood` plans inside one mood's world (presets/moods.ts); a remake (`fresh`) without one keeps the
 * playing plan's mood, and null plans without any. Parts the person changed by hand in the playing
 * plan keep their changes unless `keepEdits` is false.
 */
export async function makeVideo(wish = '', opts: { fresh?: boolean; mood?: MoodId | null; keepEdits?: boolean } = {}) {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a || s.planning) return;
  const prev = validPlan(s.plan, a) ? s.plan : null;
  const moodId = opts.mood === undefined ? (opts.fresh ? prev?.mood : undefined) : (opts.mood ?? undefined);
  const mood = moodById(moodId);
  // cost: a song that already has a plan from Claude plays it again without a new request
  // ("Remake video", a mood and typed wishes always ask again), see planCache.ts
  const cacheKey = s.track ? planKey(s.track.name, a, s.lyrics) : null;
  if (cacheKey && !wish.trim() && !opts.fresh && !mood) {
    const saved = savedPlan(cacheKey, a, (id) => !!findLook(id));
    if (saved) {
      startPlan(saved, a, `Your saved video for this song (no new request). Remake video asks Claude for a fresh take. ${saved.note}`.trim());
      watchPlan(cacheKey, saved, a);
      return;
    }
  }
  s.set({ planning: true });
  const { requestPlan } = await import('../director/client');
  const { familyPayload, shortlistLooks } = await import('../director/shortlist');
  const { getScene } = await import('../scenes');
  const lyr = s.lyrics;
  const taste = tasteSummary(a);
  // cost: the looks that suit this song (the full list when there's a wish), see shortlist.ts
  // cost: the families that suit this song (all of them when there's a wish), each family on one
  // compressed line with its takes and its fit (see shortlist.ts and server/planPrompt.ts)
  // a mood sends only its own world's looks, so the plan can't leave it
  const { looks, families } = familyPayload(
    shortlistLooks(
      allLooks().filter((p) => getScene(p.sceneId) && inMood(p, mood)),
      a,
      { wish, keep: taste ? [...taste.liked.map((x) => x.id), ...taste.avoid] : [], categoryOf: (p) => getScene(p.sceneId)?.category ?? '' },
    ),
    a,
  );
  const offline = freshLocalPlan(a, mood?.id);
  let plan: VideoPlan = offline;
  let reason = '';
  let claudeLyric: { family: TypeFamily | null; parts: (LyricPart | null)[] } | null = null;
  const lyricSeed = (Math.random() * 2 ** 31) | 0;
  try {
    const r = await requestPlan(
      {
        wish,
        track: { summary: a.summary, bpm: a.bpm, mood: a.mood, tags: a.tags },
        ...(a.character ? { character: a.character } : {}),
        sections: a.sections.map((x, i) => {
          const d = sectionDrops(a)[i];
          return {
            label: x.label,
            group: x.group,
            start: x.start,
            end: x.end,
            energy: x.energy,
            busy: round2(busyness(a, x)),
            ...(d ? { drop: { strength: d.strength, why: d.why } } : {}),
            ...(lyr?.synced ? { lyrics: textBetween(lyr.lines, x.start, x.end) } : {}),
          };
        }),
        ...(lyr && !lyr.synced && lyr.plain ? { lyrics: lyr.plain.slice(0, 1500) } : {}),
        looks: looks.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          tags: p.tags,
          category: getScene(p.sceneId)?.category ?? '',
          style: lookStyle(p),
          family: familyIdOf(p),
          take: takeName(p),
          ...(p.custom ? { custom: true } : {}),
        })),
        families,
        // taste memory: a short anonymous summary (look ids, tags, counts) and the last plan's looks
        ...(taste ? { taste } : {}),
        // lyric video: how overlay lyrics fit each look, and how wordy each section is
        ...lyricRequest(a, lyr, looks, getScene, lyricSeed),
        // the mood's world and its direction (the look list above already holds only its looks)
        ...(mood ? { mood: { name: mood.name, world: mood.world, finish: moodDirection(a, mood, []).finish, transitions: mood.transitions } } : {}),
      },
      // the saved access code is sent by the client; a missing or wrong one opens the access gate,
      // which retries this request once it's unlocked (closing it keeps the offline plan)
    );
    if (r.ok) claudeLyric = r.lyric;
    if (r.ok) {
      // inside a mood, anything from outside its world (there shouldn't be any) gives way to the offline pick
      const fits = (id: string | null | undefined): id is string => !!id && (!mood || inMood(findLook(id) ?? { id, family: undefined }, mood));
      const picked = r.looks.map((id, i) => (fits(id) ? id : offline.looks[i]));
      plan = ensureDropCuts({
        title: r.title,
        note: r.note,
        looks: picked,
        why: r.why,
        source: 'claude',
        via: r.via,
        duration: a.duration,
        pops: r.pops.map((v, i) => v ?? offline.pops?.[i] ?? 1),
        interludes: mood ? r.interludes.map((id) => (fits(id) ? id : null)) : r.interludes,
        // Claude's rotation where it gave one, else picked around its main look
        rotate: mood ? r.rotate.map((ids) => (ids ? ids.filter(fits) : null)) : r.rotate,
        shotBars: r.shotBars,
        transitions: r.transitions,
        // the mood's direction (with Claude's type hint); else Claude's, else one picked offline around Claude's looks
        direction: mood
          ? moodDirection(a, mood, picked.map((id) => findLook(id)), r.direction?.type)
          : (r.direction ?? localDirection(a, r.looks.map((id, i) => findLook(id ?? offline.looks[i])), lyricSeed)),
        ...(mood ? { mood: mood.id } : {}),
      }, a);
    } else reason = r.reason;
  } catch (e) {
    reason = String(e);
  }
  plan = withBase(withLyricPlan(plan, a, lyr, claudeLyric, getScene, lyricSeed), a);
  // the song may have changed while Claude was thinking
  const now = useStudio.getState();
  if (now.analysis !== a) {
    now.set({ planning: false });
    return;
  }
  // the parts the person changed by hand keep their changes (the new plan's own picks stay as its base,
  // so they still read as changed, and "Reset this part" gives the new plan's pick)
  const before = validPlan(now.plan, a) ? now.plan : prev;
  if (before && opts.keepEdits !== false) {
    const k = keepEdits(plan, before, a);
    plan = k.plan;
    if (k.kept.length) {
      const names = sectionNames(a.sections);
      plan = { ...plan, note: `${plan.note} Kept your changes to ${listNames(k.kept.map((i) => names[i]))}.` };
    }
  } else if (opts.keepEdits === false && now.partPops) now.set({ partPops: null }); // "Start fresh": the pop-up overrides go too
  if (cacheKey && plan.source === 'claude') {
    savePlan(cacheKey, plan);
    watchPlan(cacheKey, plan, a);
  }
  now.set({ planning: false });
  startPlan(plan, a, plan.source === 'claude' ? plan.note : `${reason ? `${reason} ` : ''}${plan.note}`.trim());
}

/** put a plan on, say so in the chat and play the song from the top */
function startPlan(plan: VideoPlan, a: TrackAnalysis, text: string) {
  const now = useStudio.getState();
  plan = withBase(plan, a);
  rememberPlan(a, planSignature(plan));
  now.set({ plan, planOn: true, autoPilot: false });
  now.pushChat({ role: 'director', mode: 'plan', title: plan.title, text, source: plan.source, via: plan.via });
  audioEngine.seek(0);
  void audioEngine.play().catch(() => {});
}

/** "Verse 1", "Verse 1 and Chorus", "Verse 1, Chorus and Drop" */
export function listNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/* ───────────────────────── changes by hand (the part sheet) ───────────────────────── */

/** the pop-up level of section i (0..3): the plan's mark, else the section label's */
export function popsOf(plan: VideoPlan, a: TrackAnalysis, i: number): number {
  const v = plan.pops?.[i];
  return typeof v === 'number' ? Math.max(0, Math.min(3, Math.round(v))) : POPS_BY_LABEL[a.sections[i].label];
}

/** what the plan says for every part now, as the base later changes are told by */
export function planBase(plan: VideoPlan, a: TrackAnalysis): PlanBase {
  return {
    looks: [...plan.looks],
    rotate: a.sections.map((_, i) => (plan.rotate?.[i] ? [...plan.rotate[i]!] : null)),
    lyric: a.sections.map((_, i) => plan.lyricPlan?.parts[i]?.medium ?? null),
  };
}

/** the plan with a base (a plan made before bases existed takes what it has now) */
export function withBase(plan: VideoPlan, a: TrackAnalysis): VideoPlan {
  return plan.base && plan.base.looks.length === plan.looks.length ? plan : { ...plan, base: planBase(plan, a) };
}

export interface PartEdit {
  look: boolean;
  pops: boolean;
  lyric: boolean;
}

/**
 * What the person changed in each part (null where the part is as planned): looks and lyric styles
 * against the plan's base, pop-ups from the overrides in store.partPops (pass them in from a
 * component that subscribes to them, so it redraws when they change).
 */
export function partEdits(plan: VideoPlan | null, a: TrackAnalysis | null, partPops: (number | null)[] | null = useStudio.getState().partPops): (PartEdit | null)[] {
  if (!plan || !a || !validPlan(plan, a)) return [];
  const b = plan.base && plan.base.looks.length === plan.looks.length ? plan.base : null;
  return a.sections.map((_, i) => {
    const e = {
      look: !!b && plan.looks[i] !== b.looks[i],
      pops: typeof partPops?.[i] === 'number',
      lyric: !!b && !!plan.lyricPlan?.parts[i] && plan.lyricPlan.parts[i]!.medium !== b.lyric[i],
    };
    return e.look || e.pops || e.lyric ? e : null;
  });
}

/**
 * Carry the parts changed by hand in `prev` over to a new plan `next` for the same song. Pop-up
 * overrides need no carrying: they live in store.partPops, outside the plan, and outlast re-plans.
 * `kept` lists every changed part, pop-ups included, for the "Kept your changes" note.
 */
export function keepEdits(next: VideoPlan, prev: VideoPlan, a: TrackAnalysis): { plan: VideoPlan; kept: number[] } {
  const edits = partEdits(prev, a);
  const kept = edits.map((e, i) => (e ? i : -1)).filter((i) => i >= 0);
  if (!kept.length) return { plan: next, kept };
  const base = withBase(next, a).base!;
  const looks = [...next.looks];
  const rotate = a.sections.map((_, i) => next.rotate?.[i] ?? null);
  const lp = next.lyricPlan ? { ...next.lyricPlan, parts: [...next.lyricPlan.parts] } : undefined;
  for (const i of kept) {
    const e = edits[i]!;
    if (e.look && prev.looks[i] && findLook(prev.looks[i])) {
      looks[i] = prev.looks[i];
      rotate[i] = prev.rotate?.[i] ?? null;
    }
    const was = prev.lyricPlan?.parts[i];
    if (e.lyric && lp && was && lp.parts[i]) lp.parts[i] = { ...lp.parts[i]!, medium: was.medium, why: was.why };
  }
  return { plan: { ...next, looks, rotate, ...(lp ? { lyricPlan: lp } : {}), base }, kept };
}

/** the mood of the plan playing now (scene windows keep to it too) */
export function playingMood(): MoodId | undefined {
  const s = useStudio.getState();
  return s.planOn && validPlan(s.plan, s.analysis) ? s.plan!.mood : undefined;
}

/* ───────────────────────── taste memory ───────────────────────── */
/*
 * What the person keeps and skips (`taste.ts`) steers the offline planner: each role (calm, body,
 * peak, bridge) is scored by the analysis' suggestions, by its family's fit, by learned affinity in that kind
 * of part, and by a little seeded noise, so every "Make a video" is a fresh take. About one role in
 * five ignores taste on purpose and picks something new. A plan that matches one of the song's last
 * few plans is re-rolled.
 */

const ROLE_LABEL = { calm: 'intro', main: 'verse', peak: 'chorus', bridge: 'bridge' } as const;
/** song tags that make it a loud or a soft song, and look tags whose feeling argues with each */
const LOUD_SONG = ['heavy', 'aggressive', 'intense', 'dubstep', 'techno', 'trance', 'energetic', 'driving'];
const SOFT_SONG = ['calm', 'sad', 'tender', 'ambient', 'piano', 'melancholic', 'slow', 'acoustic'];
const SOFT_FEEL = ['sad', 'tender', 'romantic', 'melancholic', 'piano', 'acoustic'];
const LOUD_FEEL = ['aggressive', 'heavy', 'dubstep', 'intense', 'glitch', 'techno'];
const ROLE_LABELS: Record<keyof typeof ROLE_LABEL, TrackSection['label'][]> = {
  calm: ['intro', 'break', 'outro'],
  main: ['verse', 'build'],
  peak: ['chorus', 'drop'],
  bridge: ['bridge'],
};

function tastefulRoles(ranked: Preset[], suggested: Preset[], a: TrackAnalysis, seed?: number) {
  const roll = seed === undefined ? () => 0.5 : rng(seed);
  const noise = seed === undefined ? 0 : 0.9;
  const pool = ranked.filter((p) => !p.sceneId.startsWith('board-'));
  const base = (p: Preset) => {
    const r = suggested.indexOf(p);
    return r >= 0 ? 2.2 - r * 0.18 : pool.indexOf(p) < 8 ? 0.4 : 0;
  };
  // the song's labels for each role that actually appear, for context
  const labelsIn = new Set(a.sections.map((x) => x.label));
  const scorer = (role: keyof typeof ROLE_LABEL) => {
    const lab = ROLE_LABELS[role].find((l) => labelsIn.has(l)) ?? ROLE_LABEL[role];
    return affinityIn(contextFor(lab));
  };
  // how well a look's tags match the song's own words, for looks past the analysis' few suggestions
  const words = new Set([...a.tags, ...(a.character ? [a.character.mood, ...a.character.genre.split(/\s+/)] : [])].map((t) => t.toLowerCase()));
  const moodMatch = (p: Preset) => p.tags.filter((t) => words.has(t.toLowerCase())).length / Math.sqrt(Math.max(1, p.tags.length));
  // …and how much its feeling argues with the song's (a mournful look on a dubstep track, a rave look on a lullaby)
  const loudSong = a.tags.some((t) => LOUD_SONG.includes(t));
  const softSong = a.tags.some((t) => SOFT_SONG.includes(t));
  const against = loudSong && !softSong ? SOFT_FEEL : softSong && !loudSong ? LOUD_FEEL : [];
  const moodClash = (p: Preset) => Math.min(3, p.tags.filter((t) => against.includes(t)).length);
  // fit: how well a look suits the sections this role actually plays here (their labels and energy),
  // by its family's curated fit; a role the song doesn't use is judged on its usual part
  const fitMemo = new Map<string, number>();
  const fit = (role: keyof typeof ROLE_LABEL, p: Preset): number => {
    const key = `${role}|${p.id}`;
    let v = fitMemo.get(key);
    if (v === undefined) {
      const secs = a.sections.map((s, i) => ({ s, i })).filter(({ s }) => ROLE_LABELS[role].includes(s.label));
      v = secs.length ? secs.reduce((sum, { s, i }) => sum + fitScore(p, s.label, partEnergy(a, i)), 0) / secs.length : fitScore(p, ROLE_LABEL[role]);
      fitMemo.set(key, v);
    }
    return v;
  };
  const taken: Preset[] = [];
  // neighbours: the looks of one video should belong together (curated pairs up, clashes down), and two
  // takes of one family in different parts would read as the same look (Song colours makes them alike)
  const together = (p: Preset) => taken.reduce((s, q) => s + (familyIdOf(p) === familyIdOf(q) ? -1.5 : 0.6 * neighbourScore(p, q)), 0);
  const choose = (role: keyof typeof ROLE_LABEL): Preset => {
    const aff = scorer(role);
    const free = pool.filter((p) => !taken.includes(p));
    // a look the person keeps skipping in this kind of part stays out of it
    const wanted = free.filter((p) => aff(p.id) > -0.75);
    const list = wanted.length ? wanted : free.length ? free : pool;
    let pick: Preset | undefined;
    // exploration: now and then something outside the usual picks that the person hasn't turned down,
    // still one that suits the part and sits with the looks already chosen
    if (seed !== undefined && roll() < EXPLORE) {
      const fresh = list.filter((p) => aff(p.id) > -0.25 && fit(role, p) > 0.3 && together(p) > -0.4 && moodMatch(p) > 0);
      pick = fresh[Math.floor(roll() * fresh.length)];
    }
    pick ??= [...list]
      .map((p) => {
        // the stronger the person's feeling about a look here, the less the defaults matter
        const t = aff(p.id);
        const k = Math.abs(t);
        // a poor fit counts more than a good one helps: a drop look on a quiet intro is worse than a plain one
        const f = fit(role, p);
        const fitTerm = (f > 0 ? 1.3 : 2.2) * f * (1 - 0.5 * k);
        return { p, s: base(p) * (1 - 0.4 * k) + 0.6 * moodMatch(p) - 0.45 * moodClash(p) + fitTerm + together(p) + 3 * t + noise * (roll() - 0.5) };
      })
      .sort((x, y) => y.s - x.s)[0]?.p;
    pick ??= pool[0] ?? ranked[0];
    taken.push(pick);
    return pick;
  };
  // the role the person feels most strongly about picks first, so a look liked on drops lands on the drop
  const strength = (role: keyof typeof ROLE_LABEL) => {
    const aff = scorer(role);
    return Math.max(0, ...pool.map((p) => aff(p.id)));
  };
  const order = (['main', 'peak', 'calm', 'bridge'] as const).map((r, i) => ({ r, s: strength(r) - i * 0.01 })).sort((x, y) => y.s - x.s);
  const got = {} as Record<keyof typeof ROLE_LABEL, Preset>;
  for (const { r } of order) got[r] = choose(r);
  const { main, peak, calm, bridge } = got;
  /** rotation bias for a section label: taste plus a little noise */
  const bias = (label: TrackSection['label']) => {
    const aff = affinityIn(contextFor(label));
    const r = seed === undefined ? null : rng(seed * 31 + label.length);
    return (id: string) => 1.2 * aff(id) + (r ? 0.8 * (r() - 0.5) : 0);
  };
  return { main, peak, calm, bridge, bias };
}

/** an offline plan that differs from the song's last few plans */
export function freshLocalPlan(a: TrackAnalysis, mood?: MoodId): VideoPlan {
  const recent = recentPlans(a);
  const seen = new Set(recent);
  // the main looks of the last two plans, so a new take changes more than its rotation
  const mains = (sig: string) => sig.split(',').map((x) => x.split('+')[0]).join(',');
  const lastMains = new Set(recent.slice(-2).map(mains));
  const seed0 = (Math.random() * 2 ** 31) >>> 0;
  let fallback: VideoPlan | null = null;
  for (let k = 0; k < 12; k++) {
    const plan = localPlan(a, { seed: seed0 + k * 7919, mood });
    const sig = planSignature(plan);
    if (seen.has(sig)) continue;
    if (!lastMains.has(mains(sig))) return plan;
    fallback ??= plan;
  }
  return fallback ?? localPlan(a, { seed: seed0, mood });
}

/**
 * Skip the look on screen: remember it, and take it out of the playing part (its rotation, or its main
 * look, for the part and the parts that sound the same) so Hum moves on right away. Returns false when
 * no plan is playing (the caller picks the next look).
 */
export function skipLook(): boolean {
  const s = useStudio.getState();
  const id = s.presetId;
  if (!id) return false;
  record('skip', id);
  const a = s.analysis;
  if (!(s.planOn && audioEngine.kind === 'file' && validPlan(s.plan, a))) return false;
  const i = sectionIndexAt(a!.sections, audioEngine.currentTime);
  const plan = s.plan!;
  const looks = [...plan.looks];
  const rotate = a!.sections.map((_, j) => plan.rotate?.[j] ?? null);
  const interludes = plan.interludes ? [...plan.interludes] : undefined;
  const aff = affinityIn(contextFor(a!.sections[i].label));
  const same = a!.sections.map((x, j) => j === i || (x.group === a!.sections[i].group && looks[j] === looks[i]));
  if (interludes?.[i] === id) interludes[i] = null;
  if (looks[i] === id) {
    // a new main look: the best liked related look that isn't the skipped one
    const pool = relatedLooks(id, a!, looks, (x) => 1.5 * aff(x), undefined, moodFilter(plan.mood)).filter((x) => x !== id && x !== looks[i + 1]);
    const next = pool[0];
    if (!next) return false;
    // its rotation is picked around the new look, without the skipped one
    const want = Math.max(1, (plan.rotate?.[i] ?? []).length || 2);
    const rot = relatedLooks(next, a!, looks, (x) => 1.5 * aff(x), undefined, moodFilter(plan.mood)).filter((x) => x !== id && x !== next).slice(0, want);
    same.forEach((on, j) => {
      if (on && looks[j] === id) {
        looks[j] = next;
        rotate[j] = rot.filter((x) => x !== looks[j + 1]);
      }
    });
  } else {
    // drop it from this part's rotation (and its look-alikes'), with a fresh pick in its place
    const shown = planShots(plan, a!, s.pace, s.lyrics).filter((sh) => sh.section === i).map((sh) => sh.lookId);
    const cur = [...new Set(shown)].filter((x) => x !== looks[i]);
    const extra = relatedLooks(looks[i]!, a!, looks, (x) => 1.5 * aff(x), undefined, moodFilter(plan.mood)).find((x) => x !== id && !cur.includes(x) && x !== looks[i + 1]);
    const nextRot = [...cur.filter((x) => x !== id), ...(extra ? [extra] : [])].slice(0, 3);
    same.forEach((on, j) => {
      if (on) rotate[j] = nextRot.length ? nextRot : null;
    });
  }
  const nextPlan = ensureDropCuts({ ...plan, looks, rotate, ...(interludes ? { interludes } : {}) }, a!, i);
  hold = null;
  s.set({ plan: nextPlan });
  return true;
}

// tell taste which transition the playing shot came in with
setTransitionProbe(() => {
  const s = useStudio.getState();
  if (!s.planOn || audioEngine.kind !== 'file' || !validPlan(s.plan, s.analysis)) return s.transition === 'auto' ? undefined : s.transition;
  const shots = planShots(s.plan!, s.analysis!, s.pace, s.lyrics);
  return shots[shotIndexAt(shots, audioEngine.currentTime)]?.tr.id;
});

/* ───────────────────────── lyric video ───────────────────────── */
/*
 * Every video plan carries a lyric plan (lyricPlan.ts): which medium shows the words in each section
 * (subtitles, big words, cutouts, a word or two, or the look's own lyric components), one type family
 * for the song, and one-off moments. Claude's choices where it made them, the local planner's for the
 * rest; a fresh seed per render, so two videos of one song read differently.
 */

type SceneLookup = (id: string) => { category: string; showsLyrics?: boolean } | undefined;

/** one short line per look: what overlay text suits it, its calm zones, whether it shows the words itself */
function lyricFitLine(p: Preset, getScene: SceneLookup): string {
  const sc = getScene(p.sceneId);
  const prof = profileFor(p.id, sc?.category, !!sc?.showsLyrics);
  if (prof.own === 'carries') return 'carries the words itself (use own)';
  const good = (Object.entries(prof.suits) as [string, number][]).filter(([, v]) => v >= 0.6).map(([k]) => k);
  const poor = (Object.entries(prof.suits) as [string, number][]).filter(([, v]) => v < 0.3).map(([k]) => k);
  return `suits ${good.join('/') || 'subtitle'}${poor.length ? `; poor for ${poor.join('/')}` : ''}; calm ${prof.zones.slice(0, 2).join('/')}${prof.own === 'echoes' ? '; has lyric bits of its own' : ''}`;
}

function lyricRequest(a: TrackAnalysis, lyr: Lyrics | null, looks: Preset[], getScene: SceneLookup, seed: number): { lyricFit?: { id: string; fit: string }[]; wps?: number[]; lyricTake?: TypeFamily } {
  if (!lyr?.synced || !lyr.lines.length) return {};
  return {
    lyricFit: looks.filter((p) => !p.custom || getScene(p.sceneId)).map((p) => ({ id: p.id, fit: lyricFitLine(p, getScene) })),
    wps: a.sections.map((sec) => round2(vocalDensity(lyr.lines, sec).wps)),
    // this render's seeded type family, so Claude's takes vary like the offline planner's
    lyricTake: localLyricPlan(a, lyr, seed).family,
  };
}

function withLyricPlan(plan: VideoPlan, a: TrackAnalysis, lyr: Lyrics | null, claude: { family: TypeFamily | null; parts: (LyricPart | null)[] } | null, getScene: SceneLookup, seed: number): VideoPlan {
  if (!lyr?.synced || !lyr.lines.length) return plan;
  const profiles = plan.looks.map((id) => {
    const p = id ? findLook(id) : undefined;
    const sc = p ? getScene(p.sceneId) : undefined;
    return p ? profileFor(p.id, sc?.category, !!sc?.showsLyrics) : null;
  });
  const lyricPlan = mergeLyricPlan(localLyricPlan(a, lyr, seed, { profiles }), claude);
  return { ...plan, lyricPlan, note: `${plan.note} Lyrics: ${describeLyricPlan(lyricPlan, sectionNames(a.sections))}.` };
}
