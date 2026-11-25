/**
 * Inks: the colours the drawn and printed finishes (Hand-drawn, Riso, Ink wash) draw with, and where they
 * come from. They can be the look's own, the clip's on screen (so they change with the cut), one set
 * mixed from every clip, hand-picked palettes dealt to the parts (a chorus that comes back comes back in
 * its colours), or five colours the person sets.
 *
 * A clip's own colours are read from its frames as tones: what is really in the picture, most of it
 * first. inksFrom() turns tones into something to print with. The hues are the clip's; how light each
 * ink is is ours, spaced from a dark line to a pale paper, because the finish sorts the picture into
 * inks by how light it is: two inks of one lightness would lose the drawing, and words set in one would
 * vanish on the other.
 *
 * Pure colour maths: no store, no three.js.
 */
import { hexToLch, lchToHex, type Lch } from '../core/songPalette';
import type { ClipPalette, Palette } from '../core/types';

export type InkMode = 'look' | 'clips' | 'video' | 'sets' | 'own';
export type InkSet = Pick<Palette, 'bg' | 'fg' | 'accent' | 'accent2' | 'muted'>;
export interface InkColors {
  mode: InkMode;
  /** 'sets': palette ids, dealt to the parts in this order */
  sets: string[];
  /** 'own' */
  own: InkSet;
  /** 'clips' and 'video': what the inks are printed on */
  paper: 'light' | 'dark';
  /** 'clips' and 'video': how far quiet parts fade and loud ones glow, 0..1 */
  feel: number;
}
export const INK_ROLES = ['bg', 'fg', 'accent', 'accent2', 'muted'] as const satisfies readonly (keyof InkSet)[];
export const INK_DEFAULT: InkColors = {
  mode: 'clips',
  sets: ['clay', 'cobalt', 'blush'],
  own: { bg: '#f2f0ea', fg: '#16161a', accent: '#2f4bff', accent2: '#9db4ff', muted: '#c9c6bd' },
  paper: 'light',
  feel: 0.5,
};
const MODES: InkMode[] = ['look', 'clips', 'video', 'sets', 'own'];
const HEX = /^#[0-9a-f]{6}$/i;

/** saved ink colours, with anything that doesn't hold put right */
export function cleanInks(v: unknown): InkColors | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const own = (o.own ?? {}) as Record<string, unknown>;
  return {
    mode: MODES.includes(o.mode as InkMode) ? (o.mode as InkMode) : INK_DEFAULT.mode,
    sets: Array.isArray(o.sets) ? o.sets.filter((x): x is string => typeof x === 'string' && x.length <= 40).slice(0, 8) : INK_DEFAULT.sets,
    own: Object.fromEntries(INK_ROLES.map((k) => [k, typeof own[k] === 'string' && HEX.test(own[k] as string) ? own[k] : INK_DEFAULT.own[k]])) as unknown as InkSet,
    paper: o.paper === 'dark' ? 'dark' : 'light',
    feel: typeof o.feel === 'number' && Number.isFinite(o.feel) ? Math.min(1, Math.max(0, o.feel)) : INK_DEFAULT.feel,
  };
}

/* ───────── tones: what is in a picture ───────── */

const ab = (c: Lch): [number, number, number] => [c.l, c.c * Math.cos((c.h * Math.PI) / 180) * 2.2, c.c * Math.sin((c.h * Math.PI) / 180) * 2.2];
const gap2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/**
 * Up to six colours of a small copy of a picture (RGBA pixels), most of it first. A small vivid thing (a
 * lantern in a night street) counts for more than its size, because it is what one remembers.
 */
export function tonesFromPixels(data: Uint8ClampedArray): string[] {
  // one bin per 16 levels a channel
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const e = bins.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += data[i];
    e.g += data[i + 1];
    e.b += data[i + 2];
    bins.set(k, e);
  }
  const pts = [...bins.values()].map((e) => {
    const hex = ((Math.round(e.r / e.n) << 16) | (Math.round(e.g / e.n) << 8) | Math.round(e.b / e.n)).toString(16).padStart(6, '0');
    const lch = hexToLch(hex);
    return { p: ab(lch), w: e.n * (1 + 10 * lch.c) };
  });
  if (!pts.length) return [];
  // start from the heaviest, then each time the heaviest far thing (no chance in it: the same picture, the same tones)
  const centres = [pts.reduce((a, b) => (b.w > a.w ? b : a)).p];
  while (centres.length < Math.min(6, pts.length)) {
    let best = pts[0];
    let score = -1;
    for (const q of pts) {
      const s = Math.sqrt(q.w) * Math.min(...centres.map((c) => gap2(c, q.p)));
      if (s > score) {
        score = s;
        best = q;
      }
    }
    if (score < 1e-4) break;
    centres.push(best.p);
  }
  let weight: number[] = [];
  for (let it = 0; it < 8; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (const q of pts) {
      let k = 0;
      for (let j = 1; j < centres.length; j++) if (gap2(centres[j], q.p) < gap2(centres[k], q.p)) k = j;
      for (let d = 0; d < 3; d++) sum[k][d] += q.p[d] * q.w;
      sum[k][3] += q.w;
    }
    weight = sum.map((s) => s[3]);
    for (let j = 0; j < centres.length; j++) if (sum[j][3] > 0) centres[j] = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
  }
  return centres
    .map((p, j) => ({ w: weight[j], hex: lchToHex({ l: p[0], c: Math.hypot(p[1], p[2]) / 2.2, h: ((Math.atan2(p[2], p[1]) * 180) / Math.PI + 360) % 360 }) }))
    .filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w)
    .map((x) => x.hex);
}

/** clips added before their tones were read: read since (from the library still), kept by their palette */
const late = new WeakMap<ClipPalette, string[]>();
export const lateTones = (p: ClipPalette, tones: string[]) => void late.set(p, tones);
export const hasTones = (p: ClipPalette) => !!p.tones?.length || late.has(p);
export const tonesOf = (p: ClipPalette): string[] => (p.tones?.length ? p.tones : (late.get(p) ?? p.flats));

/* ───────── from tones to inks ───────── */

const apart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** -1..1: does a hue sit naturally light (yellow) or deep (blue, violet)? */
const airy = (h: number) => Math.cos(((h - 105) * Math.PI) / 180);

/**
 * Five inks from a picture's tones. `glow` is -1 (faded) .. 1 (vivid): how the song feels there.
 */
export function inksFrom(tones: string[], paper: 'light' | 'dark', glow = 0): InkSet {
  const cols = tones.map(hexToLch);
  // the hues worth an ink: the strongest first, each clearly another colour
  const hues: Lch[] = [];
  for (const { lch } of cols.map((lch, i) => ({ lch, s: lch.c / (1 + i * 0.22) })).sort((a, b) => b.s - a.s)) {
    if (lch.c < 0.03 || hues.length === 3) continue;
    if (hues.every((x) => apart(x.h, lch.h) >= 26)) hues.push(lch);
  }
  // a picture of one colour keeps to it: its neighbour round the wheel is the second ink
  if (hues.length === 1) hues.push({ ...hues[0], h: (hues[0].h + (airy(hues[0].h + 35) > airy(hues[0].h - 35) ? 35 : 325)) % 360, c: hues[0].c * 0.85 });
  const grey = !hues.length;
  if (grey) hues.push({ l: 0.5, c: 0, h: 80 }, { l: 0.5, c: 0, h: 80 });
  const [h1, h2, h3 = h1] = hues;
  // greys stay greys; a colour prints stronger than it films
  const chroma = (src: Lch, lo: number, hi: number) => (grey ? 0.006 : clamp(src.c * 1.3, lo, hi) * (glow < 0 ? 1 + glow * 0.5 : 1 + glow * 0.28));
  const ground = cols.find((c) => c.c >= 0.015) ?? h1;
  const deep = cols.filter((c) => c.c >= 0.015).sort((a, b) => a.l - b.l)[0] ?? h1;
  const gc = grey ? 0.004 : 0.02;
  // the lighter of the two accents is the one whose hue is naturally light, so nothing turns to mud
  const up = airy(h1.h) > airy(h2.h) + 0.15;
  const set = paper === 'light' ? { bg: 0.955 + Math.min(0, glow) * 0.025, fg: 0.23, lo: 0.52, hi: 0.76, mid: 0.4 } : { bg: 0.19, fg: 0.95, lo: 0.6, hi: 0.8, mid: 0.4 };
  return {
    bg: lchToHex({ l: set.bg, c: paper === 'light' ? gc : gc * 1.6, h: ground.h }),
    fg: lchToHex({ l: set.fg, c: paper === 'light' ? (grey ? 0.006 : 0.05) : gc, h: paper === 'light' ? deep.h : ground.h }),
    accent: lchToHex({ l: up ? set.hi : set.lo, c: chroma(h1, 0.1, 0.21), h: h1.h }),
    accent2: lchToHex({ l: up ? set.lo : set.hi, c: chroma(h2, 0.08, 0.18), h: h2.h }),
    muted: lchToHex({ l: set.mid, c: chroma(h3, 0.06, 0.14), h: h3.h }),
  };
}
