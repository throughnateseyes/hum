/**
 * The palette as inks. The paper is the palette's background; the line is its text colour, or near black
 * or near white when that would not read on the paper. Light paper takes dark ink, dark paper takes light.
 */
import type { Palette } from '../core/types';
import type { Inks } from './pen';

type RGB = [number, number, number];

export function rgbOf(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x888888;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hexOf = (c: RGB) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
export function mixHex(a: string, b: string, k: number): string {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return hexOf([x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k]);
}
export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** the line colour for this paper */
export function inkOn(paper: string, p: Pick<Palette, 'fg'>): string {
  if (contrast(p.fg, paper) >= 5) return p.fg;
  const dark = mixHex(paper, '#0b0a09', 0.94);
  const light = mixHex(paper, '#fffdf8', 0.95);
  return contrast(dark, paper) >= contrast(light, paper) ? dark : light;
}

/**
 * Inks for a drawing on this paper. The patches sit under the line, so a patch too close to the line
 * colour is pulled towards the paper until the line reads on it, and one too close to the paper is left
 * as it is (a whisper).
 */
export function inksOn(paper: string, p: Palette): Inks {
  const ink = inkOn(paper, p);
  const patch = (c: string) => {
    let k = 0;
    while (k < 0.75 && contrast(mixHex(c, paper, k), ink) < 2.6) k += 0.125;
    return mixHex(c, paper, k);
  };
  // the strong patch is the colour that stands out most from the paper
  const stand = (c: string) => {
    const [r, g, b] = rgbOf(c);
    return contrast(c, paper) + (Math.max(r, g, b) - Math.min(r, g, b)) / 60;
  };
  const [a, b] = stand(p.accent) >= stand(p.accent2) ? [p.accent, p.accent2] : [p.accent2, p.accent];
  return { ink, a: patch(a), b: patch(b), c: patch(contrast(p.muted, paper) < 1.12 ? mixHex(paper, a, 0.22) : p.muted) };
}
