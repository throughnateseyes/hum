/**
 * A video's Direction: the few choices that hold a whole video together, so every part can vary in
 * how big it feels without jumping between styles.
 *
 *   world        the style family the looks come from (styles.ts, picked by the planner)
 *   colours      Song colours (songPalette.ts)
 *   finish       one shared surface over every look: film, riso, ink wash, tape, hand-drawn or clean
 *   motion       a transition set: the family of transitions the video's cuts lean on
 *   type         a hint for the lyric typography (a pairing in plain words, for the lyric planner)
 *
 * No three.js here, so the server (the Claude director) can read the lists too. The GPU side of the
 * finishes lives in `src/render/finishPass.ts`; the offline planner's pick in `src/state/direction.ts`.
 */
import type { TransitionId } from './transitionList';

export const FINISH_IDS = ['clean', 'film', 'riso', 'ink', 'tape', 'hand'] as const;
export type FinishId = (typeof FINISH_IDS)[number];
export const isFinishId = (v: unknown): v is FinishId => typeof v === 'string' && (FINISH_IDS as readonly string[]).includes(v);

export interface FinishInfo {
  id: FinishId;
  name: string;
  /** a short plain-English tip for the picker */
  tip: string;
  /** one line for the AI director (kept short: it's sent with every plan request) */
  ai: string;
}

export const FINISHES: FinishInfo[] = [
  { id: 'clean', name: 'Clean', tip: 'No finish: every look exactly as it is.', ai: 'none, crisp' },
  { id: 'film', name: 'Film', tip: '16mm film: living grain, a gate that sways with the wind, warm glow round the highlights, a flicker on kicks.', ai: '16mm, cinematic, warm' },
  { id: 'riso', name: 'Riso', tip: 'A risograph print: two or three inks from the palette on paper, grainy, slightly out of line, jumping on snares.', ai: 'risograph print, playful, graphic' },
  { id: 'ink', name: 'Ink wash', tip: 'Sumi ink on rice paper: soft washes that bleed into the paper, darker at the edges. Calm and spacious.', ai: 'sumi ink, calm, sparse' },
  { id: 'tape', name: 'Tape', tip: 'An old VHS tape: colour bleeding sideways, lines that jitter on hits, a tracking roll on the drop.', ai: 'VHS, lo-fi, retro' },
  { id: 'hand', name: 'Hand-drawn', tip: 'Wobbly lines and flat inks, like hand animation. Fine-tune it below.', ai: 'hand animation, flat inks' },
];

export const finishName = (id: FinishId) => FINISHES.find((f) => f.id === id)?.name ?? id;

/** the motion vocabulary of a video: which transitions its changes lean on (strong drops still cut) */
export const TRANSITION_SET_IDS = ['soft', 'film', 'graphic', 'organic', 'kinetic', 'glitch'] as const;
export type TransitionSetId = (typeof TRANSITION_SET_IDS)[number];
export const isTransitionSetId = (v: unknown): v is TransitionSetId => typeof v === 'string' && (TRANSITION_SET_IDS as readonly string[]).includes(v);

export const TRANSITION_SETS: Record<TransitionSetId, { name: string; ids: TransitionId[]; ai: string }> = {
  soft: { name: 'Soft', ids: ['crossfade', 'fade-bg', 'luma', 'noise'], ai: 'dissolves and fades' },
  film: { name: 'Film', ids: ['burn', 'fade-black', 'luma', 'crossfade', 'push'], ai: 'film burns, fades to black, pushes' },
  graphic: { name: 'Graphic', ids: ['wipe', 'iris', 'slit', 'mosaic', 'ink'], ai: 'wipes, irises, slit-scans' },
  organic: { name: 'Organic', ids: ['ink', 'ripple', 'luma', 'fade-bg', 'noise'], ai: 'ink blots, ripples, light dissolves' },
  kinetic: { name: 'Kinetic', ids: ['cut', 'push', 'slit', 'wipe'], ai: 'hard cuts and fast pushes' },
  glitch: { name: 'Glitch', ids: ['mosaic', 'glyph', 'slit', 'noise', 'cut'], ai: 'mosaics, glyphs, digital swaps' },
};

/** the transition set that suits a finish best (used when only a finish is known) */
export const FINISH_MOTION: Record<FinishId, TransitionSetId> = {
  clean: 'kinetic',
  film: 'film',
  riso: 'graphic',
  ink: 'organic',
  tape: 'glitch',
  hand: 'graphic',
};

export interface Direction {
  finish: FinishId;
  transitions: TransitionSetId;
  /** a type pairing in plain words, e.g. "serif display, grotesk caption" (for the lyric planner; optional) */
  type?: string;
  /** one short line on why, shown in the plan note */
  why?: string;
}

/** a direction from the AI or storage, with anything unknown dropped (null when there's no usable finish) */
export function cleanDirection(v: unknown): Direction | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isFinishId(o.finish)) return null;
  const d: Direction = { finish: o.finish, transitions: isTransitionSetId(o.transitions) ? o.transitions : FINISH_MOTION[o.finish] };
  if (typeof o.type === 'string' && o.type.trim()) d.type = o.type.trim().slice(0, 60);
  if (typeof o.why === 'string' && o.why.trim()) d.why = o.why.trim().slice(0, 120);
  return d;
}

/** the compact rule the Claude director gets (a few dozen tokens) */
export const DIRECTION_RULE = `## Direction
Commit the video to one direction: parts vary in intensity, not style (looks from one or two related style families). Set direction once:
- finish, one surface over every look: ${FINISHES.map((f) => `${f.id} (${f.ai})`).join('; ')}.
- transitions, the motion vocabulary: ${TRANSITION_SET_IDS.map((id) => `${id} (${TRANSITION_SETS[id].ai})`).join('; ')}.
- type: optional lyric type pairing, a few words.`;
