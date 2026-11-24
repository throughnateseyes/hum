/**
 * The Sketchbook's lettering: a line set as large as its box allows, broken where it reads best, each word
 * appearing as it is sung. Printed type next to a drawn line, so it stays plain and quiet.
 */
import type { HandId } from '../../draw/format';
import { FACES, lyricFontVersion } from '../../render/lyricFonts';
import type { Box, Split } from './layout';

export interface TypeFace {
  family: string;
  weight: number;
  italic?: boolean;
  /** share of the type size */
  spacing: number;
  leading: number;
}

/** a face that sits well beside each hand */
export const FACE_FOR: Record<HandId, TypeFace> = {
  pen: { family: FACES.instrument, weight: 400, spacing: -0.015, leading: 0.98 },
  brush: { family: FACES.fraunces, weight: 560, spacing: -0.025, leading: 0.98 },
  marker: { family: FACES.tight, weight: 760, spacing: -0.035, leading: 0.96 },
  pencil: { family: FACES.instrument, weight: 400, italic: true, spacing: -0.01, leading: 1 },
};

export interface TimedWord {
  text: string;
  t: number;
}
export interface SetWord extends TimedWord {
  x: number;
  y: number;
}
export interface SetLine {
  size: number;
  words: SetWord[];
  /** ink box, in the same pixels as the box it was set in */
  box: Box;
}

let probe: CanvasRenderingContext2D | null = null;
const ctx = () => (probe ??= document.createElement('canvas').getContext('2d')!);

export function setFace(g: CanvasRenderingContext2D, f: TypeFace, size: number) {
  g.font = `${f.italic ? 'italic ' : ''}${f.weight} ${size}px ${f.family}`;
  g.letterSpacing = `${(f.spacing * size).toFixed(2)}px`;
  g.textBaseline = 'alphabetic';
}

const memo = new Map<string, SetLine | null>();

/**
 * Set words in a box: as large as fits (never above `max`), in at most `maxLines` lines, placed by the
 * split's alignment. Null when there are no words.
 */
export function setLine(words: TimedWord[], box: Box, f: TypeFace, max: number, maxLines: number, align: Split['align'], valign: Split['valign']): SetLine | null {
  if (!words.length || box.w < 8 || box.h < 8) return null;
  const key = `${words.map((w) => `${w.text}@${w.t}`).join(' ')}|${box.x},${box.y},${box.w},${box.h}|${f.family}${f.weight}${f.italic ? 'i' : ''}|${max}|${maxLines}|${align}${valign}|${lyricFontVersion()}`;
  const had = memo.get(key);
  if (had !== undefined) return had;
  if (memo.size > 120) memo.clear();
  const g = ctx();
  // measured once at 100 px, scaled after
  setFace(g, f, 100);
  const widths = words.map((w) => g.measureText(w.text).width / 100);
  const space = (g.measureText('n n').width - g.measureText('nn').width) / 100;
  const m = g.measureText('Hdxgpy');
  const up = m.actualBoundingBoxAscent / 100;
  const down = m.actualBoundingBoxDescent / 100;
  const n = words.length;
  let best: { size: number; breaks: number[] } | null = null;
  for (let lines = 1; lines <= Math.min(maxLines, n); lines++) {
    const breaks = balanced(widths, space, lines);
    const widest = Math.max(...breaks.map((b, k) => run(widths, space, b, breaks[k + 1] ?? n)));
    const tall = (lines - 1) * f.leading + up + down;
    // a little short of the edge: the ink of a letter reaches past its advance
    const size = Math.min(max, (box.w * 0.97) / widest, box.h / tall);
    if (!best || size > best.size * 1.04) best = { size, breaks };
  }
  if (!best) return null;
  const { size, breaks } = best;
  const tall = ((breaks.length - 1) * f.leading + up + down) * size;
  const y0 = valign === 'top' ? box.y : valign === 'bottom' ? box.y + box.h - tall : box.y + (box.h - tall) / 2;
  const out: SetWord[] = [];
  let x0 = Infinity;
  let x1 = -Infinity;
  breaks.forEach((b, k) => {
    const e = breaks[k + 1] ?? n;
    const w = run(widths, space, b, e) * size;
    let x = align === 'left' ? box.x : align === 'right' ? box.x + box.w - w : box.x + (box.w - w) / 2;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x + w);
    for (let i = b; i < e; i++) {
      out.push({ ...words[i], x, y: y0 + (up + k * f.leading) * size });
      x += (widths[i] + space) * size;
    }
  });
  const set: SetLine = { size, words: out, box: { x: x0, y: y0, w: x1 - x0, h: tall } };
  memo.set(key, set);
  return set;
}

const run = (w: number[], space: number, a: number, b: number) => {
  let x = 0;
  for (let i = a; i < b; i++) x += w[i] + (i > a ? space : 0);
  return x;
};

/** where each line starts, so that the widest line is as short as it can be */
function balanced(w: number[], space: number, lines: number): number[] {
  const n = w.length;
  let lo = Math.max(...w);
  let hi = run(w, space, 0, n);
  const breaksAt = (max: number): number[] => {
    const out = [0];
    let x = 0;
    for (let i = 0; i < n; i++) {
      const add = w[i] + (x > 0 ? space : 0);
      if (x + add > max + 1e-6 && x > 0) {
        out.push(i);
        x = w[i];
      } else x += add;
    }
    return out;
  };
  for (let k = 0; k < 22; k++) {
    const mid = (lo + hi) / 2;
    if (breaksAt(mid).length <= lines) hi = mid;
    else lo = mid;
  }
  return breaksAt(hi);
}
