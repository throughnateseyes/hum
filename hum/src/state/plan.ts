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
import { lookStyle } from '../core/styles';
import type { AudioFrame, Lyrics, Preset, TrackAnalysis, TrackDrop, TrackSection } from '../core/types';
import { PRESETS } from '../presets';
import { live } from './live';
import { useStudio, type Pace } from './store';
import type { PlanTransition, TransitionId } from '../core/transitionList';
import { moodOf, pickTransition, resolveTransition, type PickContext, type TransitionSpec } from './transitionPick';
import { affinityIn, contextFor, EXPLORE, planSignature, recentPlans, rememberPlan, record, rng, setTransitionProbe, tasteSummary } from './taste';
import { describeLyricPlan, localLyricPlan, mergeLyricPlan, vocalDensity, type LyricPart, type LyricPlan, type TypeFamily } from './lyricPlan';
import { profileFor } from '../render/lyricProfiles';

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

const validPlan = (plan: VideoPlan | null, a: TrackAnalysis | null): plan is VideoPlan =>
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
    pops[i] = Math.max(pops[i] ?? 0, d.strength >= 0.75 ? 3 : 2);
    if (i === keep || !looks[i] || looks[i] !== looks[i - 1]) continue;
    const pick = dropLook(looks, a, i, looks[i - 1]);
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
function dropLook(looks: (string | null)[], a: TrackAnalysis, i: number, avoid: string | null): Preset | undefined {
  const prev = findLook(avoid);
  const ok = (p: Preset | undefined): p is Preset => !!p && p.id !== avoid && !p.sceneId.startsWith('board-');
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
  // 2. the most intense look the analysis suggested, preferably on another scene
  const suggested = a.suggestedPresets.map((id) => findLook(id)).filter(ok);
  const pool = suggested.length ? suggested : allLooks().filter(ok);
  return [...pool].sort((x, y) => Number(differentScene(y)) - Number(differentScene(x)) || intensity(y) - intensity(x))[0];
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
  on: 'section' | 'interlude' | 'phrase' | 'hit' | 'drop' | 'vocal' | 'lyric';
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
  const drive = clamp01(0.6 * sec.energy + 0.4 * busyness(a, sec));
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
 * Looks that sit well next to `mainId` in one section, best first: shared tags, what the analysis
 * suggested for this song, the same style family, a similar intensity, and preferably another scene so
 * the change shows.
 * Looks that are other sections' main looks rank lower so the parts stay distinct. Never boards.
 */
export function relatedLooks(mainId: string, a: TrackAnalysis, mains: (string | null)[] = [], bias?: (id: string) => number): string[] {
  const m = findLook(mainId);
  if (!m) return [];
  const sug = a.suggestedPresets;
  const others = new Set(mains.filter((id): id is string => !!id && id !== mainId));
  return allLooks()
    .filter((p) => p.id !== mainId && !p.sceneId.startsWith('board-') && (!p.custom || sug.includes(p.id)))
    .map((p) => {
      const r = sug.indexOf(p.id);
      const overlap = p.tags.filter((t) => m.tags.includes(t)).length;
      const family = lookStyle(p) === lookStyle(m) ? 0.8 : 0;
      const score = overlap + family + (r >= 0 ? 1.6 - r * 0.08 : 0) - 0.35 * Math.abs(intensity(p) - intensity(m)) + (p.sceneId !== m.sceneId ? 0.3 : 0) - (others.has(p.id) ? 0.6 : 0) + (bias ? bias(p.id) : 0);
      return { id: p.id, score };
    })
    .sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1))
    .slice(0, 6)
    .map((x) => x.id);
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
  for (const id of [...(given ?? []), ...relatedLooks(main, a, plan.looks)]) {
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
        if (rise > 0.2 && rise >= prevRise && rise >= nextRise && ec[j + w] > sec.energy) events.push({ t: snapBeat(j * dt), on: 'hit', pri: 3 });
        prevRise = rise;
      }
    }
    // a new lyric line after a pause
    const lines = lyrics?.lines ?? [];
    for (let k = 0; k < lines.length; k++) {
      const t = lines[k].t;
      if (t > s0 && t < s1 && (k === 0 || t - lines[k - 1].end >= bar * 0.75)) events.push({ t: snapBeat(t), on: 'lyric', pri: 2 });
    }
    // the phrase grid, nudged onto a lyric line when one starts nearby
    for (let t = s0 + P.shotLen; t < s1 - 0.5; t += P.shotLen) {
      const line = lines.find((l) => Math.abs(l.t - t) < Math.min(bar * 0.5, P.shotLen * 0.25));
      events.push({ t: line ? snapBeat(line.t) : t, on: line ? 'lyric' : 'phrase', pri: 1 });
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
        const t = sec.start + Math.round((prev + (c.t - prev) / n - sec.start) / beat) * beat;
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
  out.forEach((sh, k) => {
    const room = Math.min(sh.t - (out[k - 1]?.t ?? -1e9), (out[k + 1]?.t ?? a.duration) - sh.t);
    const picked = pickTransition(a, { ...sh.pick!, seed: k * 7.31 + Math.round(a.duration), prev, room });
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
    if (nl && nl.id !== s.presetId) live.stage?.prewarm(nl.sceneId);
  }
  if (hold) {
    if (hold.plan === s.plan && t >= hold.from - 0.5 && t < hold.until) return;
    hold = null;
  }
  const look = findLook(sh.lookId);
  if (!look || look.id === s.presetId) return;
  const since = t - (sh.t - early(sh, k));
  // a shot reached by seeking or pausing gets a short crossfade instead of its own transition
  if (live.stage) live.stage.nextTransition = f.playing && since < 0.35 ? resolved(sh, k) : { id: 'crossfade', ms: f.playing ? 400 : 250, seed: k };
  s.applyPreset(look);
}

/** how long a board interlude plays at the top of a section: 4 bars, at most ~45% of the section */
export function interludeLength(sec: TrackSection, bpm: number): number {
  const bars4 = (16 * 60) / Math.max(40, bpm || 120);
  return Math.max(2.5, Math.min(bars4, (sec.end - sec.start) * 0.45));
}

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
  if (planned) {
    const i = sectionIndexAt(a!.sections, t);
    const v = s.plan!.pops?.[i];
    return typeof v === 'number' ? Math.max(0, Math.min(3, Math.round(v))) : POPS_BY_LABEL[a!.sections[i].label];
  }
  if (s.popups !== 'always') return 0;
  if (!a?.sections.length) return 1;
  const sec = a.sections[sectionIndexAt(a.sections, t)];
  return Math.max(1, POPS_BY_LABEL[sec.label]);
}

/* ───────────────────────── picks while a plan is on ───────────────────────── */

/**
 * Use a look. With the song map on, it also goes into the section that's playing and into every
 * section that sounds the same and shared that section's look.
 */
export function pickLook(p: Preset) {
  const s = useStudio.getState();
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
  s.applyPreset(p);
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

const LOUD = ['heavy', 'aggressive', 'intense', 'dubstep', 'glitch', 'euphoric', 'energetic', 'driving', 'techno', 'trance'];
const SOFT = ['calm', 'minimal', 'sad', 'dreamy', 'ambient', 'tender', 'spacious', 'slow', 'melancholic', 'piano'];
const intensity = (p: Preset) => p.tags.filter((t) => LOUD.includes(t)).length - p.tags.filter((t) => SOFT.includes(t)).length;

/**
 * A plan without Claude: three looks from the track's suggestions — a calm one for intros, breaks and
 * outros, a main one for verses and builds, a peak one for choruses and drops — with a fourth for a
 * bridge. Sections that sound alike always share a look.
 */
export function localPlan(a: TrackAnalysis, opts: { seed?: number } = {}): VideoPlan {
  // the curated looks first, then the person's own, then everything else
  const suggested = a.suggestedPresets.map((id) => findLook(id)).filter((p): p is Preset => !!p);
  const ranked = [...suggested.filter((p) => !p.custom), ...suggested.filter((p) => p.custom)];
  for (const p of PRESETS) if (!ranked.includes(p)) ranked.push(p);
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
  const boards = allLooks().filter((p) => !p.custom && p.sceneId.startsWith('board-') && !used.has(p.id));
  const boardPick = boards.find((p) => suggested.includes(p)) ?? boards[Math.floor(a.duration) % Math.max(1, boards.length)];
  let at = a.sections.findIndex((s, i) => i > 0 && (s.label === 'bridge' || s.label === 'break'));
  if (at < 0) at = a.sections.findIndex((s, i) => s.label === 'verse' && a.sections.slice(0, i).some((x) => x.label === 'verse'));
  // short songs: open the first build (or the first verse after the intro) with it instead
  if (at < 0) at = a.sections.findIndex((s, i) => i > 0 && (s.label === 'build' || s.label === 'verse'));
  if (boardPick && at > 0 && a.sections.length >= 4) interludes[at] = boardPick.id;
  // each part rotates through related looks: 2 in calm parts, up to 4 in loud busy ones (sections
  // that share a main look share the rotation, so a returning chorus looks like itself)
  const pools = new Map<string, string[]>();
  const rotate = looks.map((id, i) => {
    const want = poolSize(sectionPacing({ looks } as VideoPlan, a, i, 'song').drive, 'song') - 1;
    const key = `${id}|${want}`;
    if (!pools.has(key)) pools.set(key, relatedLooks(id, a, looks, bias(a.sections[i].label)).slice(0, want));
    return pools.get(key)!;
  });
  const names = sectionNames(a.sections);
  return ensureDropCuts({
    title: 'Song map',
    note: `Calm sections lean on “${calm.name}”, the body on “${main.name}”, and the big moments on “${peak.name}”, each rotating through a few related looks in time with the music. Parts that sound alike share their looks.${
      boardPick && interludes[at] ? ` ${names[at]} opens with “${boardPick.name}” for a few bars, and little windows pop up on the big moments.` : ''
    }`,
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
 */
export async function makeVideo(wish = '') {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a || s.planning) return;
  s.set({ planning: true });
  const { requestPlan } = await import('../director/client');
  const { getScene } = await import('../scenes');
  const looks = allLooks().filter((p) => getScene(p.sceneId));
  const lyr = s.lyrics;
  const offline = freshLocalPlan(a);
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
        looks: looks.map((p) => ({ id: p.id, name: p.name, description: p.description, tags: p.tags, category: getScene(p.sceneId)?.category ?? '', style: lookStyle(p) })),
        // taste memory: a short anonymous summary (look ids, tags, counts) and the last plan's looks
        ...(() => {
          const taste = tasteSummary(a);
          return taste ? { taste } : {};
        })(),
        // lyric video: how overlay lyrics fit each look, and how wordy each section is
        ...lyricRequest(a, lyr, looks, getScene, lyricSeed),
      },
      // the saved access code is sent by the client; a missing or wrong one opens the access gate,
      // which retries this request once it's unlocked (closing it keeps the offline plan)
    );
    if (r.ok) claudeLyric = r.lyric;
    if (r.ok) {
      plan = ensureDropCuts({
        title: r.title,
        note: r.note,
        looks: r.looks.map((id, i) => id ?? offline.looks[i]),
        why: r.why,
        source: 'claude',
        via: r.via,
        duration: a.duration,
        pops: r.pops.map((v, i) => v ?? offline.pops?.[i] ?? 1),
        interludes: r.interludes,
        // Claude's rotation where it gave one, else picked around its main look
        rotate: r.rotate,
        shotBars: r.shotBars,
        transitions: r.transitions,
      }, a);
    } else reason = r.reason;
  } catch (e) {
    reason = String(e);
  }
  plan = withLyricPlan(plan, a, lyr, claudeLyric, getScene, lyricSeed);
  // the song may have changed while Claude was thinking
  const now = useStudio.getState();
  if (now.analysis !== a) {
    now.set({ planning: false });
    return;
  }
  rememberPlan(a, planSignature(plan));
  now.set({ plan, planOn: true, autoPilot: false, planning: false });
  now.pushChat({
    role: 'director',
    mode: 'plan',
    title: plan.title,
    text: plan.source === 'claude' ? plan.note : `${reason ? `${reason} ` : ''}${plan.note}`.trim(),
    source: plan.source,
    via: plan.via,
  });
  audioEngine.seek(0);
  void audioEngine.play().catch(() => {});
}

/* ───────────────────────── taste memory ───────────────────────── */
/*
 * What the person keeps and skips (`taste.ts`) steers the offline planner: each role (calm, body,
 * peak, bridge) is scored by the analysis' suggestions, by intensity, by learned affinity in that kind
 * of part, and by a little seeded noise, so every "Make a video" is a fresh take. About one role in
 * five ignores taste on purpose and picks something new. A plan that matches one of the song's last
 * few plans is re-rolled.
 */

const ROLE_LABEL = { calm: 'intro', main: 'verse', peak: 'chorus', bridge: 'bridge' } as const;
const ROLE_LABELS: Record<keyof typeof ROLE_LABEL, TrackSection['label'][]> = {
  calm: ['intro', 'break', 'outro'],
  main: ['verse', 'build'],
  peak: ['chorus', 'drop'],
  bridge: ['bridge'],
};

function tastefulRoles(ranked: Preset[], suggested: Preset[], a: TrackAnalysis, seed?: number) {
  const roll = seed === undefined ? () => 0.5 : rng(seed);
  const noise = seed === undefined ? 0 : 0.7;
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
  const level = (p: Preset) => Math.max(-3, Math.min(3, intensity(p)));
  const fit = { calm: (p: Preset) => -0.4 * level(p), main: () => 0, peak: (p: Preset) => 0.4 * level(p), bridge: () => 0.1 };
  const taken: Preset[] = [];
  const choose = (role: keyof typeof ROLE_LABEL): Preset => {
    const aff = scorer(role);
    const free = pool.filter((p) => !taken.includes(p));
    // a look the person keeps skipping in this kind of part stays out of it
    const wanted = free.filter((p) => aff(p.id) > -0.75);
    const list = wanted.length ? wanted : free.length ? free : pool;
    let pick: Preset | undefined;
    // exploration: now and then something outside the usual picks that the person hasn't turned down
    if (seed !== undefined && roll() < EXPLORE) {
      const fresh = list.filter((p) => aff(p.id) > -0.25 && Math.abs(fit[role](p)) < 1.4);
      pick = fresh[Math.floor(roll() * fresh.length)];
    }
    pick ??= [...list]
      .map((p) => {
        // the stronger the person's feeling about a look here, the less the defaults matter
        const t = aff(p.id);
        const k = Math.abs(t);
        return { p, s: base(p) * (1 - 0.4 * k) + fit[role](p) * (1 - 0.7 * k) + 3 * t + noise * (roll() - 0.5) };
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
export function freshLocalPlan(a: TrackAnalysis): VideoPlan {
  const recent = recentPlans(a);
  const seen = new Set(recent);
  // the main looks of the last two plans, so a new take changes more than its rotation
  const mains = (sig: string) => sig.split(',').map((x) => x.split('+')[0]).join(',');
  const lastMains = new Set(recent.slice(-2).map(mains));
  const seed0 = (Math.random() * 2 ** 31) >>> 0;
  let fallback: VideoPlan | null = null;
  for (let k = 0; k < 12; k++) {
    const plan = localPlan(a, { seed: seed0 + k * 7919 });
    const sig = planSignature(plan);
    if (seen.has(sig)) continue;
    if (!lastMains.has(mains(sig))) return plan;
    fallback ??= plan;
  }
  return fallback ?? localPlan(a, { seed: seed0 });
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
    const pool = relatedLooks(id, a!, looks, (x) => 1.5 * aff(x)).filter((x) => x !== id && x !== looks[i + 1]);
    const next = pool[0];
    if (!next) return false;
    // its rotation is picked around the new look, without the skipped one
    const want = Math.max(1, (plan.rotate?.[i] ?? []).length || 2);
    const rot = relatedLooks(next, a!, looks, (x) => 1.5 * aff(x)).filter((x) => x !== id && x !== next).slice(0, want);
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
    const extra = relatedLooks(looks[i]!, a!, looks, (x) => 1.5 * aff(x)).find((x) => x !== id && !cur.includes(x) && x !== looks[i + 1]);
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
