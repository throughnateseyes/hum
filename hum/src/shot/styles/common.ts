/** Pieces more than one footage style uses: small type on the grid's corners, and field colours. */
import type * as THREE from 'three';
import { TONE, type StyleContext } from '../kit';
import { MONO_FONT, placeLine, typeLine, type TypeLine } from '../type';

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

/** a line of small type set on one corner of the grid's margins (cap line on the top margin, baseline on the bottom one) */
export function cornerLine(group: THREE.Object3D, ctx: StyleContext, text: string, color: string, where: Corner, row = 0): TypeLine {
  const g = ctx.grid;
  const line = typeLine(text.toUpperCase(), color, MONO_FONT, 64);
  const lead = g.tiny * 1.7;
  const y = where[0] === 't' ? g.y1 - g.tiny - row * lead : g.y0 + row * lead;
  placeLine(line, where[1] === 'l' ? g.x0 : g.x1, y, g.tiny, where[1] === 'l' ? 'left' : 'right');
  group.add(line.mesh);
  return line;
}

/**
 * For styles that put the footage inside a shape on a flat field: the field's tone and colour, the
 * footage's tone inside, and the colour small type on the field is set in. Clean footage sits on
 * paper, ink or the accent (by the arrangement); treated footage is printed in ink and paper and sits
 * on the accent, so the two never blend into each other.
 */
export function fieldFor(ctx: StyleContext): { field: number; inside: number; hex: string; text: string } {
  const s = ctx.scheme;
  if (ctx.colour !== 'clean') return { field: TONE.accent, inside: ctx.colour === 'flat' ? TONE.print : TONE.mono, hex: s.accent, text: s.onAccent };
  const pick = (ctx.layout >> 2) % 3;
  if (pick === 1) return { field: TONE.ink, inside: TONE.clean, hex: s.ink, text: s.paper };
  if (pick === 2) return { field: TONE.accent, inside: TONE.clean, hex: s.accent, text: s.onAccent };
  return { field: TONE.paper, inside: TONE.clean, hex: s.paper, text: s.ink };
}

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lumOf = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
};
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * The ink for type set straight on the footage, and what goes round it where the picture needs it
 * (typeLine's over()). The style's own pick stands when it reads on four fifths of the clip's picture;
 * else whichever of it, paper and ink reads on the most of it, so a title on a bright sky is set dark
 * rather than propped up. Judged on the clip's own brightness bands: the same for the whole shot.
 */
export function inkOver(ctx: StyleContext, pick: string): { ink: string; around: string } {
  const c = ctx.cuts;
  const shown = [c[0] * 0.6, (c[0] + c[1]) / 2, (c[1] + c[2]) / 2, (c[2] + c[3]) / 2, (c[3] + 1) / 2].map(lin);
  const reads = (hex: string) => shown.filter((L) => contrast(lumOf(hex), L) >= 3.2).length;
  const { paper, ink } = ctx.scheme;
  let best = pick;
  if (reads(pick) < 4) for (const x of [paper, ink]) if (reads(x) > reads(best)) best = x;
  const L = lumOf(best);
  return { ink: best, around: contrast(L, lumOf(paper)) > contrast(L, lumOf(ink)) ? paper : ink };
}

/** the contrast type over the picture must clear: small, and large */
export const SMALL = 4.5;
export const LARGE = 3;

/** a pick from a list by the shot's arrangement, skipping `shift` bits so separate choices don't move together */
export const choose = <T>(ctx: StyleContext, list: readonly T[], shift = 0): T => list[(ctx.layout >> shift) % list.length];
