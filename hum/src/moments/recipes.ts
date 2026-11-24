/**
 * What each moment does to a footage shot: data, and two small pure functions of where the shot is.
 *
 *   speed     how fast the picture runs (1 = real time), before the kick and the cut are added
 *   camera    how far the picture is pushed in (1 fits the frame) and how far it has slid sideways,
 *             from -1 to 1 (a share of the room the push leaves, so the picture never runs off its edge)
 *
 * The exact timing (which second, which frame) is always worked out from these here; Claude only ever
 * names a moment. Everything is a pure function of song time.
 */
import type { LyricMedium } from '../state/lyricPlan';
import type { TransitionId } from '../core/transitionList';
import type { MomentId } from './list';

/** where a shot is: 0..1 through it, and seconds since it started and until it ends */
export interface ShotAt {
  u: number;
  tau: number;
  left: number;
  beat: number;
}

export interface Recipe {
  /** the moments its section's later parts turn to, so a long section has a shape */
  next: MomentId[];
  /** the energy of the parts it suits, 0..1 */
  energy: [number, number];
  /** bars between cuts (the Pace setting still scales it) */
  bars: 1 | 2 | 4 | 8;
  speed: (s: ShotAt) => number;
  /** how hard the picture jumps on a kick, the burst when the shot lands on a hit, and the speed it reaches into a hit */
  kick: number;
  burst: number;
  peak: number;
  camera: (s: ShotAt) => { zoom: number; x: number };
  /** how the part arrives, and how its shots change, best first */
  into: TransitionId[];
  within: TransitionId[];
  /** how lyrics sit on it, best first */
  lyric: LyricMedium[];
}

const ease = (u: number) => u * u * (3 - 2 * u);
const out = (u: number) => 1 - (1 - u) * (1 - u) * (1 - u);
const mix = (a: number, b: number, u: number) => a + (b - a) * u;

export const RECIPES: Record<MomentId, Recipe> = {
  ache: {
    next: ['float', 'ache'],
    energy: [0.1, 0.5],
    bars: 4,
    speed: ({ u }) => mix(0.5, 0.22, ease(u)),
    kick: 0,
    burst: 0.5,
    peak: 1.2,
    camera: ({ u }) => ({ zoom: mix(1.02, 1.16, u), x: 0 }),
    into: ['crossfade', 'luma', 'fade-bg'],
    within: ['crossfade', 'luma'],
    lyric: ['sparse', 'subtitle'],
  },
  hush: {
    next: ['hush'],
    energy: [0, 0.3],
    bars: 8,
    speed: () => 0.28,
    kick: 0,
    burst: 0,
    peak: 0.6,
    camera: ({ u }) => ({ zoom: mix(1.03, 1.06, u), x: 0 }),
    into: ['fade-black', 'crossfade', 'fade-bg'],
    within: ['crossfade'],
    lyric: ['sparse', 'subtitle'],
  },
  held: {
    next: ['held'],
    energy: [0.15, 0.8],
    bars: 2,
    // runs down over the shot and all but stops by its end
    speed: ({ u }) => mix(0.7, 0.04, out(u)),
    kick: 0,
    burst: 0,
    peak: 0.04,
    camera: ({ u }) => ({ zoom: mix(1.04, 1.22, u * u), x: 0 }),
    into: ['cut', 'crossfade'],
    within: ['cut'],
    lyric: ['sparse', 'subtitle'],
  },
  lift: {
    next: ['lift', 'rush'],
    energy: [0.3, 0.8],
    bars: 2,
    speed: ({ u }) => mix(0.45, 1.5, u * u),
    kick: 0.15,
    burst: 1,
    peak: 3.2,
    camera: ({ u }) => ({ zoom: mix(1.2, 1.02, ease(u)), x: 0 }),
    into: ['luma', 'crossfade', 'wipe'],
    within: ['cut', 'luma'],
    lyric: ['sparse', 'big'],
  },
  rush: {
    next: ['rush', 'drift'],
    energy: [0.5, 1],
    bars: 1,
    speed: () => 1.15,
    kick: 0.6,
    burst: 1.6,
    peak: 3.4,
    camera: ({ u }) => ({ zoom: mix(1.04, 1.12, u), x: 0 }),
    into: ['cut', 'push'],
    within: ['cut', 'push'],
    lyric: ['subtitle', 'big'],
  },
  release: {
    next: ['rush', 'glow', 'release'],
    energy: [0.5, 1],
    bars: 2,
    // the burst itself is the hit's; after it the picture rides at an easy full speed
    speed: ({ tau, beat }) => mix(1.2, 0.8, Math.min(1, tau / (beat * 8))),
    kick: 0.35,
    burst: 2.4,
    peak: 3.4,
    camera: ({ tau, beat }) => ({ zoom: mix(1.24, 1.02, out(Math.min(1, tau / (beat * 4)))), x: 0 }),
    into: ['cut', 'push'],
    within: ['cut', 'push'],
    lyric: ['big', 'subtitle'],
  },
  float: {
    next: ['drift', 'float'],
    energy: [0.1, 0.55],
    bars: 4,
    speed: () => 0.45,
    kick: 0,
    burst: 0.4,
    peak: 1,
    camera: ({ u }) => ({ zoom: 1.12, x: mix(-0.8, 0.8, ease(u)) }),
    into: ['luma', 'crossfade', 'ripple'],
    within: ['crossfade', 'luma'],
    lyric: ['subtitle', 'sparse'],
  },
  fury: {
    next: ['rush', 'fury'],
    energy: [0.7, 1],
    bars: 1,
    speed: () => 1.4,
    kick: 1.1,
    burst: 3,
    peak: 3.8,
    camera: ({ tau, beat }) => ({ zoom: 1.08 + 0.1 * Math.exp(-((tau / beat) % 1) * 5), x: 0 }),
    into: ['cut'],
    within: ['cut'],
    lyric: ['big', 'subtitle'],
  },
  glow: {
    next: ['release', 'drift'],
    energy: [0.35, 0.8],
    bars: 4,
    speed: () => 0.6,
    kick: 0.1,
    burst: 1,
    peak: 1.8,
    camera: ({ u }) => ({ zoom: mix(1, 1.09, u), x: 0 }),
    into: ['luma', 'crossfade'],
    within: ['luma', 'crossfade'],
    lyric: ['big', 'subtitle'],
  },
  drift: {
    next: ['reveal', 'float'],
    energy: [0.2, 0.65],
    bars: 4,
    speed: () => 0.8,
    kick: 0,
    burst: 0.8,
    peak: 2.4,
    camera: ({ u }) => ({ zoom: 1.08, x: mix(0.7, -0.7, u) }),
    into: ['cut', 'crossfade'],
    within: ['cut', 'crossfade'],
    lyric: ['subtitle', 'sparse'],
  },
  reveal: {
    next: ['drift', 'float'],
    energy: [0.1, 0.9],
    bars: 4,
    speed: ({ u }) => mix(0.35, 0.8, ease(u)),
    kick: 0,
    burst: 1.4,
    peak: 2.4,
    camera: ({ u }) => ({ zoom: mix(1.45, 1, ease(Math.min(1, u * 1.15))), x: 0 }),
    into: ['cut', 'iris', 'luma'],
    within: ['cut', 'crossfade'],
    lyric: ['sparse', 'subtitle'],
  },
  aftermath: {
    next: ['float', 'aftermath'],
    energy: [0, 0.6],
    bars: 8,
    speed: ({ u }) => mix(0.9, 0.12, out(u)),
    kick: 0,
    burst: 0.6,
    peak: 0.6,
    camera: ({ u }) => ({ zoom: mix(1.1, 1.01, out(u)), x: 0 }),
    into: ['crossfade', 'fade-bg', 'fade-black'],
    within: ['crossfade'],
    lyric: ['sparse', 'subtitle'],
  },
};

/** the camera where a shot is; a shot with no moment stands as it is */
export const cameraOf = (m: MomentId | undefined, s: ShotAt) => (m ? RECIPES[m].camera(s) : { zoom: 1, x: 0 });
