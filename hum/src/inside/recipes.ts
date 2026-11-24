/**
 * What an inside shot is made of, by the moment it plays (src/moments): how much of the picture turns to
 * flat colour and how often that colour changes, where the words go, and what else is in the place. The
 * quiet moments hold nearly everything back, so the loud ones land.
 */
import type { MomentId } from '../moments';

/** where a word can stand: behind the farthest things, between layers, along a side wall, on the ground */
export type PutId = 'far' | 'between' | 'wall' | 'ground';
export const PUT_IDS: PutId[] = ['far', 'between', 'wall', 'ground'];

export type ExtraId = 'lines' | 'rays' | 'posts' | 'ribbons' | 'streaks';
export const EXTRA_IDS: ExtraId[] = ['lines', 'rays', 'posts', 'ribbons', 'streaks'];

/** what turns to flat colour: nothing, what is far off, everything but what is close, the close things themselves, everything */
export type PaintId = 'none' | 'far' | 'deep' | 'figure' | 'all';
export const PAINT_IDS: PaintId[] = ['none', 'far', 'deep', 'figure', 'all'];

export interface InsideRecipe {
  paint: PaintId[];
  /** beats between colour changes (0: one colour for the shot) */
  step: number;
  /** tint the ground too */
  ground: boolean;
  put: PutId[];
  with: ExtraId[];
  /** how far the bare picture is held back, 0..1 */
  grade: number;
  /** the picture jumps on kicks, 0..1 */
  jump: number;
  /** the last beat goes black but for one small word, when the shot runs into a hit */
  black?: boolean;
}

export const INSIDE: Record<MomentId, InsideRecipe> = {
  hush: { paint: ['none'], step: 0, ground: false, put: ['far', 'between'], with: [], grade: 0.85, jump: 0 },
  ache: { paint: ['none'], step: 0, ground: false, put: ['far', 'between', 'wall'], with: [], grade: 0.65, jump: 0 },
  held: { paint: ['none'], step: 0, ground: false, put: ['far', 'between'], with: ['lines'], grade: 0.8, jump: 0, black: true },
  aftermath: { paint: ['none'], step: 0, ground: false, put: ['far', 'ground'], with: [], grade: 0.6, jump: 0 },
  float: { paint: ['far'], step: 16, ground: false, put: ['far', 'between'], with: ['ribbons'], grade: 0.1, jump: 0 },
  glow: { paint: ['far', 'deep'], step: 8, ground: false, put: ['far', 'wall'], with: ['rays'], grade: 0, jump: 0.15 },
  drift: { paint: ['far', 'none'], step: 8, ground: false, put: ['wall', 'ground', 'between', 'far'], with: ['ribbons'], grade: 0.15, jump: 0.1 },
  reveal: { paint: ['deep', 'far'], step: 0, ground: false, put: ['between', 'far'], with: ['lines'], grade: 0.3, jump: 0.2 },
  lift: { paint: ['far', 'deep'], step: 4, ground: false, put: ['wall', 'between', 'far'], with: ['posts', 'streaks'], grade: 0, jump: 0.4 },
  release: { paint: ['deep', 'far'], step: 2, ground: true, put: ['wall', 'far', 'between', 'ground'], with: ['ribbons', 'posts', 'rays', 'streaks'], grade: 0, jump: 0.8 },
  rush: { paint: ['deep', 'figure'], step: 2, ground: true, put: ['ground', 'wall', 'between'], with: ['streaks', 'ribbons'], grade: 0, jump: 0.7 },
  fury: { paint: ['figure', 'all', 'deep'], step: 1, ground: true, put: ['far', 'between', 'wall'], with: ['rays', 'streaks', 'posts'], grade: 0, jump: 1 },
};

/** the recipe for a shot with no moment, from how loud its part is */
export const insideFor = (moment: MomentId | undefined, energy: number): InsideRecipe => INSIDE[moment ?? (energy < 0.25 ? 'hush' : energy < 0.45 ? 'drift' : energy < 0.65 ? 'lift' : 'release')];
