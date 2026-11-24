/**
 * A drawing as the app keeps it: what it is of, where in the song it belongs, the hand it is drawn in,
 * and the drawing itself (`data`, whose shape depends on `kind`, see kinds.ts).
 */
import type { HandId } from './format';

/** one look for a song's whole set */
export interface DrawStyle {
  hand: HandId;
  /** flat patches of colour under the ink */
  colour: boolean;
  /** how this hand draws, in a sentence (goes back to Claude with every drawing of the set) */
  manner: string;
}

export type DrawShape = 'tall' | 'wide' | 'square';

/** what to draw, before it is drawn */
export interface DrawIdea {
  name: string;
  why: string;
  brief: string;
  wide: DrawShape;
  /** the kind of drawing that would suit it best ('pen', 'figure'); drawn with the pen when nothing here makes that kind */
  suits?: string;
  /** sung words that bring it up, lower case */
  words: string[];
  /** lyric lines it belongs to, as compared by lineKey */
  lines: string[];
  /** stretches of the song where it is the main picture (s) */
  parts: { start: number; end: number }[];
}

export interface DrawingAsset extends DrawIdea {
  id: string;
  /** which kind of drawing `data` is ('pen'); kinds this version doesn't know are left alone */
  kind: string;
  /** the songs it is used in, by name */
  songs: string[];
  style: DrawStyle;
  /** the pen's own dice: the same drawing wobbles the same way every time */
  seed: number;
  data: unknown;
  added: number;
  /** the drawing this one replaced (redrawn with a note) */
  from?: string;
}

/**
 * What one stretch of the song does with drawings: `ids` the drawings its Sketchbook look shows (missing:
 * dealt from the song's), `off` no drawing beside its words. Kept by time, so cutting or joining parts
 * leaves the rest alone.
 */
export interface DrawPart {
  from: number;
  to: number;
  ids?: string[];
  off?: boolean;
}

/** lyric lines are compared by their letters only, so a comma or a capital doesn't lose a drawing */
export const lineKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}' ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
