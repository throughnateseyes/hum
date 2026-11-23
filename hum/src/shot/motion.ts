/**
 * Motion: what a video clip does in time, beyond playing through its stretch (a photo ignores it).
 *
 *   play     the clip runs along the shot's speed curve (sequence.ts), as it always has
 *   stutter  a beat-repeat: on a hit the clip jumps back and replays the last beat, half-beat or
 *            quarter-beat a few times, then plays on from where it would have been. Which hits, and
 *            how long a repeat, come from the part's drums: dense hats repeat quarters, a backbeat
 *            halves, a plain kick whole beats; a shot that speeds into its cut ends on a roll (a beat,
 *            then halves, then quarters)
 *   echo     the last few frames trail behind the picture as fading ghosts (ring.ts)
 *   reverse  the clip runs backwards through its stretch; the next shot on the clip carries on
 *            forwards from the far end, so the clip is never shown twice the same way round
 *   slices   the frame cut into strips, each a fraction of a second later than the last (ring.ts),
 *            the spread breathing with the loudness and the kicks
 *
 * Stutter and reverse only move which second of the clip is on screen, so they are a remapping of the
 * shot's curve (one clip frame per picture frame). Echo and slices need several frames of the clip at
 * once: they draw from a ring of the clip's own frames, filled by song time (ring.ts).
 *
 * All of it is a pure function of song time.
 */
import type { Sequence, Shot, ShotCurve } from './sequence';
import { unit } from './treatments/common';

export const MOTION_IDS = ['play', 'stutter', 'echo', 'reverse', 'slices'] as const;
export type MotionId = (typeof MOTION_IDS)[number];

export const MOTION_NAMES: Record<MotionId, string> = {
  play: 'Play',
  stutter: 'Stutter',
  echo: 'Echo',
  reverse: 'Reverse',
  slices: 'Slices',
};

export const MOTION_HINT = 'What a video clip does in time: plays, repeats the last beat on hits (Stutter), trails ghosts of its last frames (Echo), runs backwards (Reverse), or shows strips of itself a moment apart (Slices). Photos ignore it.';

export const isMotion = (s: string | undefined): s is MotionId => !!s && (MOTION_IDS as readonly string[]).includes(s);

/** the motions that draw from a ring of the clip's recent frames */
export const usesRing = (m: MotionId | undefined) => m === 'echo' || m === 'slices';

/** one beat-repeat: from `at`, the stretch of `len` seconds before it plays again until `until` */
export interface Repeat {
  at: number;
  len: number;
  until: number;
}

/** the hits a stuttering shot repeats on, worked out from the part's drums */
export function stutterRepeats(shot: Shot, seq: Sequence): Repeat[] {
  const beat = seq.beat;
  const bar = beat * 4;
  const beats = Math.max(1, (shot.end - shot.start) / beat);
  const hats = (seq.hats ?? []).filter((h) => h >= shot.start && h < shot.end).length;
  const dense = hats / beats >= 1.8;
  const backbeat = seq.snares.some((s) => s >= shot.start && s < shot.end);
  const loud = seq.energy > 0.6;
  const out: Repeat[] = [];
  const first = Math.ceil((shot.start - seq.partStart) / bar - 1e-4);
  // a roll into the cut: the shot's last three beats, when it speeds up into it
  const rollFrom = shot.leave === 'ramp' && shot.end - shot.start > beat * 6 ? shot.end - beat * 3 : Infinity;
  for (let k = first; ; k++) {
    const b0 = seq.partStart + k * bar;
    if (b0 >= shot.end || b0 >= rollFrom) break;
    // quiet parts stutter every other bar
    if (!loud && k % 2 === 0) continue;
    // the hit: the last snare in the bar's second half, else its fourth beat
    const sn = seq.snares.filter((s) => s >= b0 + beat * 1.9 && s < b0 + bar - beat * 0.4);
    const at = sn.length ? sn[sn.length - 1] : b0 + beat * 3;
    const r = unit(shot.layout, k, 31);
    const len = dense ? (r < 0.6 ? beat / 4 : beat / 2) : backbeat ? (r < 0.6 ? beat / 2 : beat) : beat;
    // a whole-beat repeat plays twice; the shorter ones fill one beat
    const until = Math.min(at + (len >= beat - 1e-3 ? beat * 2 : beat), shot.end - 0.02, rollFrom, b0 + bar + beat);
    if (at - len < shot.start + beat * 0.5 || until <= at + len * 0.5) continue;
    out.push({ at, len, until });
  }
  if (rollFrom < shot.end) {
    out.push({ at: rollFrom, len: beat, until: rollFrom + beat });
    out.push({ at: rollFrom + beat, len: beat / 2, until: rollFrom + beat * 2 });
    out.push({ at: rollFrom + beat * 2, len: beat / 4, until: shot.end - 0.01 });
  }
  return out;
}

export interface MotionCurve extends ShotCurve {
  /** seconds since the clip last jumped (a repeat starting again), large when it hasn't */
  jolt(t: number): number;
}

/**
 * The shot's curve with its motion laid over it. Stutter and reverse change which second of the clip is
 * on screen; the others keep the curve as it is (echo and slices are drawn from the ring).
 */
export function withMotion(curve: ShotCurve, shot: Shot, seq: Sequence, motion: MotionId): MotionCurve {
  if (motion === 'reverse') {
    const a = curve.footage(shot.start);
    const b = curve.footage(shot.end);
    return { ...curve, footage: (t) => a + b - curve.footage(t), rate: (t) => -curve.rate(t), jolt: () => 99 };
  }
  if (motion === 'stutter') {
    const reps = stutterRepeats(shot, seq);
    const find = (t: number) => {
      for (const r of reps) if (t >= r.at && t < r.until) return r;
      return null;
    };
    /** song time whose clip second is on screen at t */
    const source = (t: number) => {
      const r = find(t);
      if (!r) return t;
      const into = (t - r.at) % r.len;
      return Math.max(shot.start, r.at - r.len + into);
    };
    return {
      ...curve,
      footage: (t) => curve.footage(source(t)),
      rate: (t) => curve.rate(source(t)),
      jolt: (t) => {
        const r = find(t);
        if (r) return (t - r.at) % r.len;
        // just after a repeat lets go, the jump forward counts too
        let since = 99;
        for (const x of reps) if (t >= x.until) since = Math.min(since, t - x.until);
        return since;
      },
    };
  }
  return { ...curve, jolt: () => 99 };
}
