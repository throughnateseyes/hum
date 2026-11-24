/**
 * Moments: what a part of the song feels like, and what that does to the footage in it.
 *
 *   list.ts      the twelve moments, one line each (Claude chooses from these)
 *   recipes.ts   each one's speed, camera, cutting and transitions (worked out by code, never by Claude)
 *   momentFor    the moment a section asks for, from the song alone (what a video without Claude uses)
 *   rank         the templates that serve a moment, best first
 *
 * Templates say which moments they serve, where they are declared (`SERVES` in src/shot/styles,
 * treatments and motion.ts): 3 made for it, 2 good, 1 now and then. A new template joins by tagging
 * itself; nothing here lists them.
 */
import type { TrackAnalysis, TrackSection } from '../core/types';
import { MOMENT_IDS, type MomentId } from './list';
import { RECIPES } from './recipes';

export * from './list';
export * from './recipes';

/** how well a template serves each moment (a missing one: not at all) */
export type Serves = Partial<Record<MomentId, 1 | 2 | 3>>;

/** the templates that serve a moment, best first (ties keep the order they are declared in) */
export function rank<T extends string>(serves: Record<T, Serves>, m: MomentId, ids: readonly T[]): T[] {
  return ids.filter((id) => serves[id][m]).sort((x, y) => (serves[y][m] ?? 0) - (serves[x][m] ?? 0));
}

/* ───────── the moment a section asks for ───────── */

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const STRONG = 0.35;

/** the drop that lands at time t, if one does (0..1 strong) */
export function dropAt(a: TrackAnalysis, t: number): number {
  const d = a.dropInfo?.length ? a.dropInfo.find((x) => Math.abs(x.t - t) < 0.4) : a.drops.some((x) => Math.abs(x - t) < 0.4) ? { strength: 1 } : undefined;
  return d?.strength ?? 0;
}

/** how the loudness changes across a section: -1 falls away .. 1 builds all the way */
function slope(a: TrackAnalysis, sec: TrackSection): number {
  const c = a.energyCurve;
  if (!c?.length || !a.duration) return 0;
  const at = (t: number) => Math.max(0, Math.min(c.length - 1, Math.round((t / a.duration) * c.length)));
  const i0 = at(sec.start);
  const i1 = at(sec.end);
  const n = i1 - i0;
  if (n < 6) return 0;
  const third = Math.floor(n / 3);
  let first = 0;
  let last = 0;
  for (let i = 0; i < third; i++) {
    first += c[i0 + i];
    last += c[i1 - 1 - i];
  }
  return Math.max(-1, Math.min(1, ((last - first) / third) * 2.2));
}

/** the harmony's pull over a section, 0 at home .. 1 (0.4 when it isn't known) */
function pull(a: TrackAnalysis, sec: TrackSection): number {
  const c = a.harmony?.tension;
  if (!c?.length || !a.duration) return 0.4;
  let s = 0;
  let n = 0;
  for (let i = Math.floor((sec.start / a.duration) * c.length); i < (sec.end / a.duration) * c.length && i < c.length; i++) {
    s += c[i];
    n++;
  }
  return n ? s / n : 0.4;
}

/** How well each moment suits section i (higher is better), from what Hum heard alone */
export function momentScores(i: number, a: TrackAnalysis): Record<MomentId, number> {
  const sec = a.sections[i];
  const prev = a.sections[i - 1];
  const next = a.sections[i + 1];
  const e = sec.energy;
  const rise = prev ? e - prev.energy : 0;
  const lands = i > 0 ? dropAt(a, sec.start) : 0;
  const leads = next ? dropAt(a, next.start) || (next.label === 'drop' ? 0.6 : 0) : 0;
  const up = slope(a, sec);
  const tense = pull(a, sec);
  const bright = a.mood?.valence ?? 0.5;
  const dense = a.mood?.density ?? 0.5;
  const peak = sec.label === 'chorus' || sec.label === 'drop';
  const first = i === 0;
  const last = i === a.sections.length - 1;
  const after = !!prev && (prev.label === 'drop' || prev.label === 'chorus' || dropAt(a, prev.start) >= STRONG);
  const is = (...l: TrackSection['label'][]) => (l.includes(sec.label) ? 1 : 0);
  const out = {} as Record<MomentId, number>;
  for (const m of MOMENT_IDS) {
    const [lo, hi] = RECIPES[m].energy;
    // inside its energies it costs nothing, outside it costs more the further away
    out[m] = -3 * Math.max(0, lo - e, e - hi);
  }
  out.ache += 0.5 * is('verse', 'bridge', 'break') + 0.9 * (1 - bright) + 0.8 * (tense - 0.4) - 0.6 * dense;
  out.hush += 0.9 * is('intro', 'break') + 1.1 * clamp01(0.3 - e) * 3 - (leads ? 0.4 : 0) - 0.4 * is('verse');
  out.held += (leads >= STRONG ? 1.15 : leads ? 0.5 : -1) + 0.5 * is('break') - 0.9 * Math.max(0, up);
  out.lift += 1.1 * is('build') + 1.1 * Math.max(0, up) + (leads ? 0.35 : 0);
  out.rush += 0.8 * dense + 0.7 * clamp01(e - 0.45) + 0.4 * is('verse', 'build') + 0.4 * is('chorus') - 0.5 * lands;
  out.release += (lands >= STRONG ? 1.3 : 0) + 0.75 * is('chorus', 'drop') + 0.9 * Math.max(0, rise) - 0.2 * (1 - bright);
  out.float += 0.7 * is('bridge', 'break') + 0.5 * bright + 0.5 * (1 - dense) - 0.4 * is('chorus', 'drop');
  out.fury += 1.0 * is('drop') + 1.4 * clamp01(e - 0.7) * 2 + 0.6 * (1 - bright) * dense - (peak ? 0 : 0.5);
  out.glow += 0.8 * is('chorus') + 0.7 * bright - 0.5 * dense + (after && !peak ? 0.1 : 0);
  out.drift += 0.95 * is('verse') + 0.2 * is('bridge') + 0.15 * bright;
  out.reveal += (first ? 0.75 : 0) + (i === 1 && is('verse') ? 0.3 : 0) + 0.5 * is('bridge') + (lands ? 0.1 : 0) - (last ? 1 : 0);
  out.aftermath += (last ? 1.2 : 0) + 0.8 * is('outro') + (after && rise < -0.1 ? 0.9 : 0) + 0.4 * Math.max(0, -up) - (first ? 2 : 0);
  return out;
}

/** the moment each section of the song asks for: sections that sound alike share one, neighbours differ */
export function momentsFor(a: TrackAnalysis): MomentId[] {
  const out: MomentId[] = [];
  const byGroup = new Map<number, MomentId>();
  a.sections.forEach((sec, i) => {
    const s = momentScores(i, a);
    const order = [...MOMENT_IDS].sort((x, y) => s[y] - s[x]);
    const had = byGroup.get(sec.group);
    // a section that comes back is itself again, unless it now does another job (it clearly suits another)
    const pick = had && s[had] > s[order[0]] - 0.5 && had !== out[i - 1] ? had : (order.find((m) => m !== out[i - 1]) ?? order[0]);
    if (!had) byGroup.set(sec.group, pick);
    out.push(pick);
  });
  return out;
}

/** the moment section i asks for */
export const momentFor = (i: number, a: TrackAnalysis): MomentId => momentsFor(a)[i] ?? 'drift';

/**
 * The moment of one part inside its section (`k`: which of its parts it is). Every other part is the
 * section's own, the ones between turn to its companions; the last part before a strong drop holds
 * its breath when it is short, and a part that lands on a drop of its own releases.
 */
export function momentOfPart(section: MomentId, part: { start: number; end: number; k: number; last: boolean }, a: TrackAnalysis): MomentId {
  const beat = 60 / Math.max(50, Math.min(200, a.bpm || 120));
  if (part.k > 0 && dropAt(a, part.start) >= STRONG) return 'release';
  if (part.last && dropAt(a, part.end) >= STRONG && part.end - part.start <= beat * 10 && section !== 'fury') return 'held';
  const next = RECIPES[section].next;
  return part.k % 2 ? next[Math.floor(part.k / 2) % next.length] : section;
}
