/**
 * A shot's colours, taken from its footage.
 *
 * A clip carries a palette read from three of its frames (ClipPalette in core/types.ts: colours from
 * its two strongest hues, and the brightness levels that split it into bands). schemeFor() turns that
 * into what the footage looks actually draw with: paper, ink and one accent.
 */
import { hexToLch, lchToHex } from '../core/songPalette';
import type { ClipPalette } from '../core/types';
import { tonesFromPixels } from './inks';

/** a shot's colours: the same shape a clip carries (core/types.ts) */
export type ShotPalette = ClipPalette;

const turn = (h: number) => ((h % 360) + 360) % 360;
const apart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

export function paletteFromHues(h1: number, h2: number): ShotPalette {
  const flat = (h: number, l: number, c: number) => lchToHex({ l, c, h: turn(h) });
  return {
    flats: [flat(h1, 0.8, 0.13), flat(h2, 0.86, 0.12), flat(h1 + 38, 0.9, 0.11), flat(h2 - 34, 0.84, 0.12), flat(h1 + 180, 0.88, 0.1)],
    ink: flat(h2, 0.27, 0.09),
    paper: flat(h1, 0.975, 0.012),
    cuts: [0.2, 0.4, 0.6, 0.8],
  };
}

export const DEFAULT_PALETTE: ShotPalette = paletteFromHues(250, 30);

/**
 * A shot's colours as a designer would set them: a paper, an ink and one accent (plus a second accent
 * that is used for at most one small thing). The footage is printed in ink and paper; the accent is kept
 * for the graphics, so it always reads.
 *
 * Picked, not generated: six hand-set schemes, and a clip gets the one whose accent sits nearest its own
 * strongest colour, so the graphics belong to the picture without turning muddy.
 */
export interface Scheme {
  name: string;
  paper: string;
  ink: string;
  accent: string;
  second: string;
  /** what type on the accent is set in: ink, or paper when the accent is dark */
  onAccent: string;
  /** the mid band of the flat print: between ink and paper, leaning to the accent's hue */
  mid: string;
  /** two brightness levels (0..1) that split this clip into three equal bands */
  cuts: [number, number];
}

const SCHEMES: Omit<Scheme, 'cuts' | 'onAccent' | 'mid'>[] = [
  { name: 'signal', paper: '#f3efe6', ink: '#17130f', accent: '#ff4d1f', second: '#2f4bff' },
  { name: 'sun', paper: '#f7f1e1', ink: '#1c1813', accent: '#ffc21f', second: '#e8402a' },
  { name: 'acid', paper: '#f1f2ea', ink: '#121410', accent: '#c4ef3b', second: '#5a3cff' },
  { name: 'mint', paper: '#edf3ef', ink: '#0d1f1b', accent: '#22c495', second: '#ff6a3d' },
  { name: 'cobalt', paper: '#eef0f3', ink: '#0e1330', accent: '#3350ff', second: '#ffb21f' },
  { name: 'rose', paper: '#fbf0ee', ink: '#24100f', accent: '#ff5d88', second: '#ffcf3a' },
];

const mixHex = (a: string, b: string, k: number) => {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - k) + ((pb >> s) & 255) * k);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
};

/** the scheme for a clip, from the palette taken from its frames */
export function schemeFor(p: ShotPalette): Scheme {
  const hue = hexToLch(p.flats[0]).h;
  let best = SCHEMES[0];
  let gap = 999;
  for (const s of SCHEMES) {
    const d = apart(hexToLch(s.accent).h, hue);
    if (d < gap) {
      gap = d;
      best = s;
    }
  }
  const dark = hexToLch(best.accent).l < 0.62;
  const c = p.cuts;
  return {
    ...best,
    onAccent: dark ? best.paper : best.ink,
    mid: mixHex(mixHex(best.ink, best.paper, 0.55), best.accent, 0.12),
    cuts: [(c[0] + c[1]) / 2, (c[2] + c[3]) / 2],
  };
}

/** `data` is RGBA pixels of a small copy of one frame */
export function paletteFromPixels(data: Uint8ClampedArray): ShotPalette {
  // how much of each hue the frame holds, counting vivid pixels for more than grey ones
  const bins = new Float32Array(36);
  const luma: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    luma.push((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255);
    const hex = ((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]).toString(16).padStart(6, '0');
    const { l, c, h } = hexToLch(hex);
    if (c < 0.03 || l < 0.12 || l > 0.97) continue;
    bins[Math.floor(turn(h) / 10) % 36] += c;
  }
  const soft = Float32Array.from(bins, (_, i) => bins[i] * 0.5 + (bins[(i + 35) % 36] + bins[(i + 1) % 36]) * 0.25);
  let i1 = 0;
  for (let i = 1; i < 36; i++) if (soft[i] > soft[i1]) i1 = i;
  // the bands follow the clip's own brightness, a fifth of the picture each, so a dim clip and a
  // bright one both break into five
  luma.sort((x, y) => x - y);
  const cuts = [0.2, 0.4, 0.6, 0.8].map((f) => luma[Math.floor(f * (luma.length - 1))] ?? f);
  for (let i = 1; i < 4; i++) cuts[i] = Math.max(cuts[i], cuts[i - 1] + 0.02);
  const tones = tonesFromPixels(data);
  if (soft[i1] <= 0) return { ...DEFAULT_PALETTE, cuts, tones };
  const h1 = i1 * 10 + 5;
  // the second colour has to be a different one: at least 50 degrees round the wheel
  let i2 = -1;
  for (let i = 0; i < 36; i++) if (apart(i * 10 + 5, h1) >= 50 && (i2 < 0 || soft[i] > soft[i2])) i2 = i;
  const h2 = i2 >= 0 && soft[i2] > soft[i1] * 0.12 ? i2 * 10 + 5 : h1 + 150;
  return { ...paletteFromHues(h1, h2), cuts, tones };
}
