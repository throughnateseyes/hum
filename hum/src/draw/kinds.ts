/**
 * The kinds of drawing there are, in one table: how to check one that comes from storage, how big it is,
 * how long it takes to draw, and how to paint it. Everything that shows a drawing (the Sketchbook looks,
 * the drawings beside the words, the shelf's thumbnails) goes through here, so another kind can be added
 * with one entry. A saved drawing of a kind that isn't in the table is ignored and left where it is.
 */
import { figureRatio, paintFigure } from '../figures';
import { validateFigure, type Figure } from '../figures/format';
import { cleanDrawing, type Drawing } from './format';
import { drawDrawing, drawSeconds, prepare, type DrawOpts } from './pen';

export type PaintOpts = DrawOpts;

export interface DrawKind {
  /** a saved drawing made safe, or null when it can't be used */
  clean: (raw: unknown) => unknown;
  /** its own width and height, in any unit (only their ratio matters) */
  size: (data: unknown) => { w: number; h: number };
  /** how long it takes to draw itself on (s) */
  seconds: (data: unknown) => number;
  /** paint it at `progress` into `box`. The same options must always give the same picture. */
  paint: (g: CanvasRenderingContext2D, data: unknown, o: PaintOpts) => void;
}

const pen: DrawKind = {
  clean: cleanDrawing,
  size: (d) => {
    const b = prepare(d as Drawing).bounds;
    return { w: Math.max(40, b.x1 - b.x0), h: Math.max(40, b.y1 - b.y0) };
  },
  seconds: (d) => drawSeconds(d as Drawing),
  paint: (g, d, o) => drawDrawing(g, d as Drawing, o),
};

/** line figures (src/figures): solid, so they take the paper's colour; they go together part by part */
const figure: DrawKind = {
  clean: (raw) => validateFigure(raw)?.figure ?? null,
  size: (d) => ({ w: figureRatio(d as Figure), h: 1 }),
  seconds: (d) => Math.min(3.4, 1.2 + (d as Figure).solids.length * 0.05),
  paint: (g, d, o) =>
    paintFigure(g, d as Figure, { box: o.box, progress: o.progress, ink: o.inks.ink, accent: o.inks.a, paper: o.paper ?? '#faf7f0', scale: o.tooth, fat: o.fat, halo: o.halo }),
};

export const DRAW_KINDS: Record<string, DrawKind> = { pen, figure };

export const kindOf = (kind: string): DrawKind | null => (Object.hasOwn(DRAW_KINDS, kind) ? DRAW_KINDS[kind] : null);
