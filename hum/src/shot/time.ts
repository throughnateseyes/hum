/**
 * A shot's clock (prototype, see src/dev/shot.ts).
 *
 * A shot is a stretch of the song built around one hit (the drop): it waits, speeds up into the hit,
 * freezes for a few frames, bursts, and settles. Everything here is a pure function of song time, so
 * the same shot can be scrubbed, replayed and (later) rendered frame by frame.
 *
 *   scoreFromAnalysis()  where the hit sits in the song, the felt beat, and the drum hits round it
 *   the easing helpers, since() and dice() that everything in src/shot/ animates with
 *
 * The run of shots built round the hit, and each shot's speed curve, are in sequence.ts.
 */
import type { TrackAnalysis } from '../core/types';

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeInCubic = (x: number) => x * x * x;
export const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
export const easeOutExpo = (x: number) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));
export const easeInExpo = (x: number) => (x <= 0 ? 0 : 2 ** (10 * x - 10));
/** lands past the mark and settles back */
export const easeOutBack = (x: number, over = 1.7) => 1 + (over + 1) * (x - 1) ** 3 + over * (x - 1) ** 2;

/** the same every run: shapes and lanes are dealt from this, never from Math.random */
export function dice(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ShotScore {
  /** song time (s) the shot opens, the hit, and the end */
  start: number;
  hit: number;
  end: number;
  /** seconds per felt beat */
  beat: number;
  /** drum hits inside the shot (s) */
  kicks: number[];
  snares: number[];
}

/** beats of waiting and winding up before the hit, and of picture after it */
export const LEAD_BEATS = 8;
export const TAIL_BEATS = 16;

/** the moment the shot is built around: the song's biggest drop, else its sharpest rise in energy */
function pickHit(a: TrackAnalysis): number {
  const info = a.dropInfo?.length ? [...a.dropInfo].sort((x, y) => y.strength - x.strength)[0] : null;
  if (info) return info.t;
  if (a.drops.length) return a.drops[0];
  const e = a.energyCurve;
  const step = a.duration / e.length;
  const span = Math.max(1, Math.round(2 / step));
  let best = Math.floor(e.length / 3);
  let rise = -1;
  for (let i = span; i < e.length - span; i++) {
    const d = e[i + span] - e[i - span];
    if (d > rise) {
      rise = d;
      best = i;
    }
  }
  return best * step;
}

/** hits inside [from, to], dropping any that crowd the one before */
function within(times: number[] | undefined, from: number, to: number, gap: number): number[] {
  const out: number[] = [];
  for (const t of times ?? []) {
    if (t < from - 0.02 || t > to) continue;
    if (out.length && t - out[out.length - 1] < gap) continue;
    out.push(t);
  }
  return out;
}

/** seconds per beat as it's felt: fast tempos count in half time, slow ones in double */
export function feltBeat(bpm: number): number {
  let beat = 60 / (bpm || 120);
  while (beat < 0.38) beat *= 2;
  while (beat > 0.9) beat /= 2;
  return beat;
}

export function scoreFromAnalysis(a: TrackAnalysis, at?: number): ShotScore {
  const beat = feltBeat(a.bpm);

  const lead = LEAD_BEATS * beat;
  const tail = TAIL_BEATS * beat;
  const hit = Math.min(Math.max(at ?? pickHit(a), lead), Math.max(lead, a.duration - tail));
  const start = hit - lead;
  const end = Math.min(a.duration, hit + tail);

  let kicks = within(a.layers?.kick, hit, end, beat * 0.45);
  // a song with no kick in the picture still wants a pulse: fall back to the beat grid
  if (kicks.length < 4) kicks = Array.from({ length: Math.floor((end - hit) / beat) }, (_, i) => hit + i * beat);
  let snares = within(a.layers?.snare, hit, end, beat * 0.45);
  if (snares.length < 2) snares = Array.from({ length: Math.floor((end - hit) / (beat * 2)) }, (_, i) => hit + beat + i * beat * 2);
  return { start, hit, end, beat, kicks, snares };
}

/** seconds since the latest time in a sorted list at or before t (large when none) */
export function since(times: number[], t: number): number {
  let found = -1;
  for (let i = 0; i < times.length && times[i] <= t; i++) found = i;
  return found < 0 ? 99 : t - times[found];
}
