/**
 * The transitions a look change can use (no three.js here, so the server can read the list too).
 * The shader for each lives in `src/render/transitions.ts`; the picker in `src/state/transitionPick.ts`.
 */
export const TRANSITION_IDS = [
  'cut',
  'crossfade',
  'fade-bg',
  'fade-black',
  'luma',
  'noise',
  'burn',
  'ink',
  'wipe',
  'iris',
  'ripple',
  'mosaic',
  'glyph',
  'push',
  'slit',
] as const;

export type TransitionId = (typeof TRANSITION_IDS)[number];

export interface TransitionInfo {
  id: TransitionId;
  name: string;
  /** one line for tooltips and the AI director */
  blurb: string;
  /** advances a little on each kick while it plays */
  breathes?: boolean;
}

export const TRANSITIONS: TransitionInfo[] = [
  { id: 'cut', name: 'Cut', blurb: 'a hard cut on the beat (kept for drops)' },
  { id: 'crossfade', name: 'Crossfade', blurb: 'a smooth eased crossfade' },
  { id: 'fade-bg', name: 'Fade', blurb: 'dips through the palette background colour' },
  { id: 'fade-black', name: 'Fade black', blurb: 'dips through black' },
  { id: 'luma', name: 'Light dissolve', blurb: 'the bright parts of the new look arrive first', breathes: true },
  { id: 'noise', name: 'Dissolve', blurb: 'a grainy cloud dissolve', breathes: true },
  { id: 'burn', name: 'Film burn', blurb: 'a glowing film burn eats through the picture', breathes: true },
  { id: 'ink', name: 'Ink', blurb: 'ink blots spread and open onto the new look', breathes: true },
  { id: 'wipe', name: 'Wipe', blurb: 'a soft directional wipe with a feathered edge' },
  { id: 'iris', name: 'Iris', blurb: 'a soft circle opens from the middle' },
  { id: 'ripple', name: 'Ripple', blurb: 'a water ripple spreads the new look outward' },
  { id: 'mosaic', name: 'Mosaic', blurb: 'pixelates, swaps block by block, then sharpens', breathes: true },
  { id: 'glyph', name: 'Glyphs', blurb: 'cells flicker through glyphs as they switch', breathes: true },
  { id: 'push', name: 'Zoom push', blurb: 'a fast zoom-blur push into the new look' },
  { id: 'slit', name: 'Slit-scan', blurb: 'bands slide past each other in a shuffled order' },
];

export const isTransitionId = (v: unknown): v is TransitionId => typeof v === 'string' && (TRANSITION_IDS as readonly string[]).includes(v);

/** transition lengths offered, in beats */
export const TRANSITION_BEATS = [0.5, 1, 2, 4, 8] as const;

/** a plan's transition choice for one section */
export interface PlanTransition {
  /** into the section */
  into?: TransitionId;
  /** between the shots inside it */
  within?: TransitionId;
  /** length in beats */
  beats?: number;
}

/** a plan transition from the AI or storage, with anything unknown dropped */
export function cleanPlanTransition(v: unknown): PlanTransition | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const t: PlanTransition = {};
  if (isTransitionId(o.into)) t.into = o.into;
  if (isTransitionId(o.within)) t.within = o.within;
  if (typeof o.beats === 'number' && [0.5, 1, 2, 4, 8].includes(o.beats)) t.beats = o.beats;
  return t.into || t.within || t.beats ? t : null;
}
