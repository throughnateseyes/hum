/**
 * A shot's colours, taken from its footage (prototype, see src/dev/shot.ts).
 *
 * Five flat pastels that replace bands of the picture, a dark ink for type and lines, and a paper
 * white. The hues come from the clip itself (its two strongest colours and their neighbours), so every
 * clip gets a palette of its own that still sits in the picture.
 */
import { hexToLch, lchToHex } from '../core/songPalette';

export interface ShotPalette {
  /** five flat colours, one per brightness band from shadows to highlights */
  flats: string[];
  ink: string;
  paper: string;
  /** four brightness levels (0..1) that split this clip's picture into five equal bands */
  cuts: number[];
}

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
  if (soft[i1] <= 0) return { ...DEFAULT_PALETTE, cuts };
  const h1 = i1 * 10 + 5;
  // the second colour has to be a different one: at least 50 degrees round the wheel
  let i2 = -1;
  for (let i = 0; i < 36; i++) if (apart(i * 10 + 5, h1) >= 50 && (i2 < 0 || soft[i] > soft[i2])) i2 = i;
  const h2 = i2 >= 0 && soft[i2] > soft[i1] * 0.12 ? i2 * 10 + 5 : h1 + 150;
  return { ...paletteFromHues(h1, h2), cuts };
}
