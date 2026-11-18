/**
 * Aspect-aware grid layout. Each board ships three CSS-grid-like templates (tall 9:16,
 * square 1:1 / 4:5, wide 16:9). Tracks are flex weights (numbers) or fixed px scaled by `s`.
 */
import type { Rect } from './kit';

export type Orient = 'tall' | 'square' | 'wide';
export type Track = number | `${number}px`;
export interface Template {
  cols: Track[];
  rows: Track[];
  /** one string per row, area names separated by spaces ('.' = empty) */
  areas: string[];
}
export type Templates = Record<Orient, Template>;

export function pickOrient(mode: string, aspect: number): Orient {
  if (mode === 'vertical') return 'tall';
  if (mode === 'horizontal') return 'wide';
  if (mode === 'square') return 'square';
  return aspect < 0.7 ? 'tall' : aspect > 1.35 ? 'wide' : 'square';
}

function solveTracks(tracks: Track[], total: number, gap: number, s: number) {
  let fixed = 0;
  let fr = 0;
  for (const t of tracks) {
    if (typeof t === 'number') fr += t;
    else fixed += parseFloat(t) * s;
  }
  const free = Math.max(0, total - fixed - gap * (tracks.length - 1));
  const o: number[] = [];
  const z: number[] = [];
  let acc = 0;
  for (const t of tracks) {
    const size = typeof t === 'number' ? (fr > 0 ? (free * t) / fr : 0) : parseFloat(t) * s;
    o.push(acc);
    z.push(size);
    acc += size + gap;
  }
  return { o, z };
}

/** Returns area rects in first-appearance order (rounded to whole pixels). */
export function solveLayout(t: Template, outer: Rect, gap: number, s: number): Map<string, Rect> {
  const C = solveTracks(t.cols, outer.w, gap, s);
  const R = solveTracks(t.rows, outer.h, gap, s);
  const span = new Map<string, [number, number, number, number]>();
  t.areas.forEach((row, ri) => {
    row
      .trim()
      .split(/\s+/)
      .forEach((name, ci) => {
        if (name === '.') return;
        const b = span.get(name);
        if (!b) span.set(name, [ci, ri, ci, ri]);
        else {
          b[0] = Math.min(b[0], ci);
          b[1] = Math.min(b[1], ri);
          b[2] = Math.max(b[2], ci);
          b[3] = Math.max(b[3], ri);
        }
      });
  });
  const out = new Map<string, Rect>();
  for (const [name, [c0, r0, c1, r1]] of span) {
    const x0 = Math.round(outer.x + C.o[c0]);
    const y0 = Math.round(outer.y + R.o[r0]);
    const x1 = Math.round(outer.x + C.o[c1] + C.z[c1]);
    const y1 = Math.round(outer.y + R.o[r1] + R.z[r1]);
    out.set(name, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}
