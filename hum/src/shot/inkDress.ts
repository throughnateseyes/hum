/**
 * The footage's graphics in the inks of a drawn or printed finish (shot/inks.ts). The finish prints in
 * four or five colours and nothing else: a band or a word in any other colour comes out as a speckle of
 * the two inks nearest it. Drawn in the inks from the start, it prints solid.
 */
import { hexToLch } from '../core/songPalette';
import type { InsidePalette } from '../inside/palettes';
import type { InkSet } from './inks';
import { schemeFor, type Scheme, type ShotPalette } from './palette';

/** how well two colours part by lightness (Oklab's, where equal steps look equal) */
const part = (a: string, b: string) => Math.abs(hexToLch(a).l - hexToLch(b).l);
const best = (on: string, ...from: string[]) => from.reduce((a, b) => (part(b, on) > part(a, on) ? b : a));

export function inkScheme(k: InkSet, p: ShotPalette): Scheme {
  const light = hexToLch(k.bg).l >= hexToLch(k.fg).l;
  const [paper, ink] = light ? [k.bg, k.fg] : [k.fg, k.bg];
  // small type on the accent is ink where that reads: no other ink lies between the two, so its edges stay clean
  return { name: 'inks', paper, ink, accent: k.accent, second: k.accent2, onAccent: part(k.accent, ink) >= 0.3 ? ink : best(k.accent, paper, ink), mid: k.accent2, cuts: schemeFor(p).cuts };
}

export function inkInside(k: InkSet): InsidePalette {
  const light = hexToLch(k.bg).l >= hexToLch(k.fg).l;
  const [paper, ink] = light ? [k.bg, k.fg] : [k.fg, k.bg];
  // a word takes a colour where one parts well from its field; else the ink or the paper, whichever does
  const word = (field: string, colour: string) => (part(field, colour) >= 0.36 ? colour : best(field, paper, ink));
  return {
    id: 'inks',
    name: 'Inks',
    ink,
    paper,
    steps: [
      { field: k.accent2, light: paper, word: word(k.accent2, k.accent) },
      { field: k.accent, light: k.accent2, word: word(k.accent, paper) },
      { field: paper, light: paper, word: word(paper, k.accent) },
      { field: ink, light: k.accent, word: word(ink, k.accent2) },
    ],
    accents: [k.accent, paper, k.accent2],
  };
}
