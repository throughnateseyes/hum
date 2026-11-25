/**
 * Moments put to work on a plan: how fast its footage sections cut and how they change, and, when
 * nobody (Claude) has chosen the shots, what every footage part shows.
 *
 * Everything here comes from the song, the plan and the notes on the person's media, so the same
 * inputs always give the same video. A part that Claude or the person chose for is never touched.
 */
import type { MediaNotes, PartShot, Preset, TrackAnalysis } from '../core/types';
import type { PlanTransition } from '../core/transitionList';
import type { Curves, SongFeeling } from '../feeling';
import { INSIDE_PALETTES } from '../inside/palettes';
import { RECIPES, momentOfPart, rank, type MomentId } from '../moments';
import { MOTION_IDS, MOTION_SERVES } from '../shot/motion';
import { useStudio } from '../state/store';
import { treatmentOn } from '../shot/graphics';
import { TREATMENT_IDS, TREATMENT_SERVES, type TreatmentId } from '../shot/treatments';
import { parentsOf } from '../state/planCache';
import type { VideoPlan } from '../state/plan';
import { playsClips } from './footage';
import { notesOf, ownMedia } from './media';

const hash = (...n: number[]) => {
  let h = 2166136261;
  for (const x of n) h = Math.imul(h ^ (x + 0x9e37), 16777619) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
};

/**
 * The plan with its sections' moments, and, in its footage sections, the cutting and the changes the
 * moment asks for wherever the planner didn't choose them itself. A strong drop still always cuts.
 */
export function withMoments(plan: VideoPlan, a: TrackAnalysis, moments: (MomentId | null)[], lookOf: (id: string) => Preset | undefined, feeling?: SongFeeling): VideoPlan {
  const footage = plan.looks.map((id) => !!id && playsClips(lookOf(id)));
  if (!footage.some(Boolean)) return plan;
  const seed = Math.round(a.duration * 10);
  const shotBars = plan.looks.map((_, i) => plan.shotBars?.[i] ?? (footage[i] && moments[i] ? RECIPES[moments[i]!].bars : null));
  const transitions = plan.looks.map((_, i): PlanTransition | null => {
    const had = plan.transitions?.[i] ?? null;
    const m = moments[i];
    if (!m || !footage[i]) return had;
    const r = RECIPES[m];
    // the best of the list twice as often as the rest
    const pick = <T,>(list: T[], k: number): T => list[Math.max(0, (hash(seed, i, k) % (list.length + 1)) - 1)];
    return { ...had, into: had?.into ?? pick(r.into, 1), within: had?.within ?? pick(r.within, 2) };
  });
  // a new footage video stands its words in the footage, in one set of colours (videos made before have none, and keep their looks)
  const paint = plan.paint ?? INSIDE_PALETTES[hash(seed, 7) % INSIDE_PALETTES.length].id;
  return { ...plan, paint, ...(feeling ? { feeling } : {}), moments: plan.looks.map((_, i) => moments[i] ?? null), shotBars, transitions };
}

/** how well a picture suits a moment, from what Claude saw in it */
export function fitsMoment(n: MediaNotes, m: MomentId): number {
  const [lo, hi] = RECIPES[m].energy;
  const still = n.kind === 'photo';
  let s = -2 * Math.max(0, lo - 0.15 - n.energy, n.energy - hi - 0.1);
  s -= Math.abs((lo + hi) / 2 - n.energy) * 0.5;
  // a photo can't run or jump
  if (still && (m === 'rush' || m === 'fury' || m === 'release' || m === 'lift')) s -= 0.8;
  if (still && (m === 'hush' || m === 'ache' || m === 'held' || m === 'aftermath')) s += 0.2;
  if (n.measure.shake > 0.5 && (m === 'hush' || m === 'ache' || m === 'float' || m === 'glow')) s -= 0.5;
  // a first sight wants something to show; a hush wants an empty frame
  if (m === 'reveal' && n.size === 'wide') s += 0.35;
  if (m === 'ache' && n.faces) s += 0.5;
  if (n.text) s -= 0.2;
  return s;
}

/**
 * What every footage part does when Claude hasn't chosen its shots: its moment, now and then a
 * treatment or a motion that serves it, and, for media Claude has seen, the picture that suits it best
 * (never the one just shown), starting on one of its good seconds. Without notes the pictures are dealt
 * as ever. `parts` is the song cut at the plan's parts.
 */
export function momentShots(plan: VideoPlan, parts: TrackAnalysis, looks: (string | null)[], lookOf: (id: string) => Preset | undefined, feel: Curves | null = null): (PartShot | null)[] {
  const parents = parentsOf(parts);
  const media = ownMedia();
  const seen = media.flatMap((m) => notesOf(m.id) ?? []);
  const used = new Map<string, number>();
  const startsUsed = new Map<string, Set<number>>();
  let last = '';
  let lastTreat: TreatmentId = 'none';
  return parts.sections.map((sec, i) => {
    const look = looks[i] ? lookOf(looks[i]!) : undefined;
    const sm = plan.moments?.[parents[i]];
    if (!sm || !playsClips(look)) {
      last = '';
      return null;
    }
    let k = 0;
    while (i - k > 0 && parents[i - k - 1] === parents[i]) k++;
    const lastOf = i === parts.sections.length - 1 || parents[i + 1] !== parents[i];
    const m = momentOfPart(sm, { start: sec.start, end: sec.end, k, last: lastOf }, parts, feel);
    const shot: PartShot = { moment: m };
    const h = hash(sec.group, parents[i], Math.round(sec.start * 100));
    const own = String(look?.sceneParams?.treatment ?? 'none');
    // most parts stand their words in the footage; the rest are the footage with something else done to it, or nothing
    const ownStyle = String(look?.sceneParams?.style ?? 'auto');
    const inside = !!plan.paint && (own === 'none' || own === 'auto') && (ownStyle === 'auto' || ownStyle === 'inside' || ownStyle === 'caption') && (k === 0 || (h >>> 4) % 10 < 7);
    if (inside) shot.style = 'inside';
    if (!inside && (own === 'none' || own === 'auto')) {
      const list = rank(TREATMENT_SERVES, m, TREATMENT_IDS).filter((t) => treatmentOn(t, useStudio.getState().graphicsOff) && (t !== 'collage' || media.length >= 3) && (t !== 'trace' || media.length >= 2));
      // the plain picture most of the time: a treatment is for the moments that want one
      const strong = list.filter((t) => t !== 'none' && (TREATMENT_SERVES[t][m] ?? 0) >= 2 && t !== lastTreat);
      const pick = strong.length && h % 5 < (m === 'fury' ? 3 : 2) ? strong[h % strong.length] : 'none';
      shot.treatment = pick;
      lastTreat = pick;
    }
    if (inside) {
      shot.treatment = 'none';
      lastTreat = 'none';
    }
    if (!inside && String(look?.sceneParams?.motion ?? 'play') === 'play') {
      const list = rank(MOTION_SERVES, m, MOTION_IDS).filter((x) => x !== 'play' && (MOTION_SERVES[x][m] ?? 0) >= 2);
      if (list.length && (h >>> 8) % 4 === 0) shot.motion = list[(h >>> 12) % list.length];
    }
    if (seen.length) {
      const score = (n: MediaNotes) => fitsMoment(n, m) - (n.id === last ? 3 : 0) - 0.35 * (used.get(n.id) ?? 0);
      const n = [...seen].sort((x, y) => score(y) - score(x))[0];
      shot.media = [n.id];
      shot.focusX = n.focusX;
      shot.focusY = n.focusY;
      const taken = startsUsed.get(n.id) ?? new Set<number>();
      startsUsed.set(n.id, taken);
      const k = n.ins.findIndex((_, j) => !taken.has(j));
      if (k >= 0) {
        taken.add(k);
        shot.from = n.ins[k].at;
      }
      used.set(n.id, (used.get(n.id) ?? 0) + 1);
      last = n.id;
    }
    return shot;
  });
}
