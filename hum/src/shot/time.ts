/**
 * A shot's clock (prototype, see src/dev/shot.ts).
 *
 * A shot is a stretch of the song built around one hit (the drop): it waits, speeds up into the hit,
 * freezes for a few frames, bursts, and settles. Everything here is a pure function of song time, so
 * the same shot can be scrubbed, replayed and (later) rendered frame by frame.
 *
 *   scoreFromAnalysis()  where the shot sits in the song and which drum hits fall inside it
 *   buildCurve()         the speed ramp: how fast the footage runs at each moment, and which footage
 *                        frame that adds up to
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
/** the wind-up: the last beats before the hit, where the footage speeds up */
export const RAMP_BEATS = 4;

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

export function scoreFromAnalysis(a: TrackAnalysis, at?: number): ShotScore {
  // the beat as it's felt: fast tempos count in half time, slow ones in double
  let beat = 60 / (a.bpm || 120);
  while (beat < 0.38) beat *= 2;
  while (beat > 0.9) beat /= 2;

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

export interface TimeCurve {
  /** how fast the picture runs at song time t (1 = real time). Drives blur and the look of speed. */
  speed(t: number): number;
  /** the rate to play the clip at: speed, scaled down when the clip is too short for the shot */
  rate(t: number): number;
  /** which second of the clip is on screen at song time t */
  footage(t: number): number;
  /** the frames held still on the hit (s) */
  freeze: number;
  /** the hit cuts to the clip mirrored, because there wasn't enough clip to cut somewhere new */
  flip: boolean;
}

const HOLD = 0.3;
const PEAK = 3.4;
const STEP = 1 / 240;

/** seconds since the latest time in a sorted list at or before t (large when none) */
export function since(times: number[], t: number): number {
  let found = -1;
  for (let i = 0; i < times.length && times[i] <= t; i++) found = i;
  return found < 0 ? 99 : t - times[found];
}

export function buildCurve(score: ShotScore, clipDuration: number): TimeCurve {
  const { start, hit, end, beat, kicks } = score;
  const freeze = Math.min(0.14, beat * 0.3);

  const speed = (t: number): number => {
    const u = (t - hit) / beat;
    if (u < -RAMP_BEATS) return HOLD;
    if (u < 0) return HOLD + (PEAK - HOLD) * easeInCubic((u + RAMP_BEATS) / RAMP_BEATS);
    const tau = t - hit - freeze;
    if (tau < 0) return 0;
    // the burst off the hit, a small push on every kick, and a slow-down into the end
    const burst = 1 + 2.4 * Math.exp(-tau / (beat * 3));
    const pulse = 0.45 * Math.exp(-since(kicks, t) / (beat * 0.22));
    return (burst + pulse) * (1 - 0.7 * smooth(end - beat * 2, end, t));
  };

  // add the speed up on each side of the hit: the footage second for every moment of the shot
  const nA = Math.ceil((hit - start) / STEP);
  const nB = Math.ceil((end - hit) / STEP);
  const a = new Float32Array(nA + 1);
  const b = new Float32Array(nB + 1);
  for (let i = 0; i < nA; i++) a[i + 1] = a[i] + speed(start + (i + 0.5) * STEP) * STEP;
  for (let i = 0; i < nB; i++) b[i + 1] = b[i] + speed(hit + (i + 0.5) * STEP) * STEP;
  const needA = a[nA];
  const needB = b[nB];

  // lay both sides inside the clip: with room to spare the hit cuts ahead to a new moment; a clip that
  // is too short runs slower so it lasts, and the hit cuts to its mirror image instead
  const usable = Math.max(0.5, clipDuration - 0.25);
  const k = Math.min(1, usable / (needA + needB));
  const spare = usable - (needA + needB) * k;
  const gap = Math.min(spare, Math.max(1, usable * 0.25));
  const a0 = 0.05;
  const b0 = a0 + needA * k + gap;
  const read = (tab: Float32Array, x: number) => {
    const i = Math.min(tab.length - 2, Math.max(0, Math.floor(x)));
    return tab[i] + (tab[i + 1] - tab[i]) * clamp01(x - i);
  };

  return {
    speed,
    rate: (t) => speed(t) * k,
    footage: (t) => (t < hit ? a0 + read(a, (Math.max(start, t) - start) / STEP) * k : b0 + read(b, (Math.min(end, t) - hit) / STEP) * k),
    freeze,
    flip: gap < 0.75,
  };
}
