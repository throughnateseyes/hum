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

/** a pick from a list by the shot's arrangement, skipping `shift` bits so separate choices don't move together */
export const choose = <T>(ctx: StyleContext, list: readonly T[], shift = 0): T => list[(ctx.layout >> shift) % list.length];
