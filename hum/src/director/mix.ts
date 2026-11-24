/**
 * The mix: how much of a video is the person's own clips and photos, and how much is Hum's looks.
 *
 *   only    every part plays their footage, and nothing else fills a frame
 *   most    footage carries it, with a part or two cutting away (what Hum did before there was a choice)
 *   mixed   about half the song's time each
 *   hum     Hum's looks carry it, and footage comes in where it counts most
 *
 * The planners are told what is wanted, but the deal is kept here, by code: `dealMix` takes which sections
 * a planner gave to footage and moves the fewest it has to. The choice is kept on the plan it made.
 */
import type { TrackAnalysis } from '../core/types';
import type { MomentId } from '../moments';

export const MIX_IDS = ['only', 'most', 'mixed', 'hum'] as const;
export type Mix = (typeof MIX_IDS)[number];

export const isMix = (v: unknown): v is Mix => typeof v === 'string' && (MIX_IDS as readonly string[]).includes(v);

/** how much of the song's time footage may have, least and most (`most` is the planner's own judgement) */
const SHARE: Record<'mixed' | 'hum', [number, number]> = { mixed: [0.4, 0.62], hum: [0.12, 0.34] };

/** how much a moment asks for a real picture rather than a graphic one, 0..1 */
const REAL: Record<MomentId, number> = { ache: 0.95, reveal: 0.85, aftermath: 0.7, drift: 0.65, glow: 0.6, held: 0.55, release: 0.6, rush: 0.4, hush: 0.35, lift: 0.3, fury: 0.2, float: 0.25 };

/**
 * For each section, whether footage plays it. `wanted` is what a planner chose (missing: the moments
 * decide). Null: nothing is enforced.
 */
export function dealMix(a: TrackAnalysis, mix: Mix, moments: (MomentId | null)[], wanted?: boolean[]): boolean[] | null {
  const secs = a.sections;
  if (mix === 'most' || !secs.length) return null;
  if (mix === 'only' || secs.length === 1) return secs.map(() => true);
  const [lo, hi] = SHARE[mix];
  const len = secs.map((s) => Math.max(0, s.end - s.start));
  const total = len.reduce((s, x) => s + x, 0) || 1;
  const own = secs.map((_, i) => REAL[moments[i] ?? 'drift']);
  // sections that sound alike lean the same way, so a chorus is the same kind of picture each time
  const lean = secs.map((s, i) => {
    const alike = secs.flatMap((x, j) => (x.group === s.group ? [own[j]] : []));
    return 0.65 * (alike.reduce((t, x) => t + x, 0) / alike.length) + 0.35 * own[i];
  });
  const given = wanted?.length === secs.length ? wanted : null;
  // what a deal costs: footage outside its share of the time, then sections on the wrong side of their
  // lean, then every section taken from where the planner put it
  const cost = (on: boolean[]) => {
    let share = 0;
    let wrong = 0;
    on.forEach((x, i) => {
      const w = len[i] / total;
      if (x) share += w;
      wrong += w * (x ? 1 - lean[i] : lean[i]) + (given && given[i] !== x ? 0.7 * w : 0);
    });
    const all = on.every(Boolean) || !on.some(Boolean) ? 50 : 0;
    return 12 * Math.max(0, lo - share, share - hi) + wrong + all;
  };
  let out = given ? [...given] : secs.map(() => false);
  let best = cost(out);
  // turn one section, or two at once, as long as it helps
  for (let round = 0; round < 60; round++) {
    let next: boolean[] | null = null;
    for (let i = 0; i < secs.length; i++)
      for (let j = i; j < secs.length; j++) {
        const on = out.map((x, k) => (k === i || k === j ? !x : x));
        const c = cost(on);
        if (c < best - 1e-9) {
          best = c;
          next = on;
        }
      }
    if (!next) break;
    out = next;
  }
  return out;
}
