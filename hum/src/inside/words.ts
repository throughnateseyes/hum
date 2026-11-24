/**
 * Words set as flat shapes: every letter drawn once, large, in Archivo, whose width stretches, so a short
 * word is set wide and a long one narrow until it fills the space it has. A word is one plane one cap
 * height tall with its corner at the origin.
 */
import * as THREE from 'three';

const PX = 320;
const WIDTHS: [CanvasFontStretch, number][] = [
  ['ultra-condensed', 62],
  ['condensed', 75],
  ['semi-condensed', 87.5],
  ['normal', 100],
  ['semi-expanded', 112.5],
  ['expanded', 125],
];

export interface Set {
  texture: THREE.CanvasTexture;
  /** width / cap height */
  ratio: number;
  /** where each letter ends, 0..1 across */
  edges: number[];
  /** room drawn round the letters, in cap heights (accents and tails) */
  bleed: number;
}

const kept = new Map<string, Set>();
const KEEP = 60;

function measure(g: CanvasRenderingContext2D, text: string, stretch: CanvasFontStretch, weight: number) {
  g.font = `${weight} ${PX}px "Archivo Variable", "Inter Variable", sans-serif`;
  g.fontStretch = stretch;
  if ('letterSpacing' in g) g.letterSpacing = stretch === 'expanded' || stretch === 'semi-expanded' ? '0px' : `${PX * 0.004}px`;
  return g.measureText(text);
}

export type Stretch = CanvasFontStretch;

/** the width of the face in which `text` comes out nearest `want` (width / cap height), and its ratio there */
export function chooseWidth(text: string, want: number, weight = 900): { stretch: Stretch; ratio: number } {
  const g = scratch();
  let best = { stretch: WIDTHS[3][0], ratio: 1 };
  let gap = 1e9;
  for (const [stretch] of WIDTHS) {
    const cap = measure(g, 'H', stretch, weight).actualBoundingBoxAscent;
    const m = measure(g, text, stretch, weight);
    const ratio = (m.actualBoundingBoxRight + m.actualBoundingBoxLeft) / cap;
    const d = Math.abs(Math.log(ratio / want));
    if (d < gap) {
      gap = d;
      best = { stretch, ratio };
    }
  }
  return best;
}

/** how far the pen moves over `text`, in cap heights (for setting words side by side) */
export function advance(text: string, stretch: Stretch, weight = 900): number {
  const g = scratch();
  const cap = measure(g, 'H', stretch, weight).actualBoundingBoxAscent;
  return measure(g, text, stretch, weight).width / cap;
}

let shared: CanvasRenderingContext2D | null = null;
const scratch = () => (shared ??= document.createElement('canvas').getContext('2d')!);

/** the word drawn in one width of the face */
export function setWord(text: string, stretch: Stretch, weight = 900): Set {
  const key = `${text}|${stretch}|${weight}`;
  const had = kept.get(key);
  if (had) {
    kept.delete(key);
    kept.set(key, had);
    return had;
  }
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d')!;
  const cap = measure(g, 'H', stretch, weight).actualBoundingBoxAscent;
  const m = measure(g, text, stretch, weight);
  const bleedPx = Math.ceil(cap * 0.3);
  const left = m.actualBoundingBoxLeft;
  const width = Math.ceil(m.actualBoundingBoxRight + left);
  canvas.width = Math.max(4, width + bleedPx * 2);
  canvas.height = Math.ceil(cap) + bleedPx * 2;
  measure(g, text, stretch, weight);
  g.fillStyle = '#fff';
  g.textBaseline = 'alphabetic';
  g.fillText(text, bleedPx + left, bleedPx + cap);
  const edges = Array.from(text, (_, i) => Math.min(1, measure(g, text.slice(0, i + 1), stretch, weight).width / Math.max(1, m.width)));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 16;
  const made: Set = { texture, ratio: width / cap, edges, bleed: bleedPx / cap };
  kept.set(key, made);
  while (kept.size > KEEP) {
    const [k, old] = kept.entries().next().value as [string, Set];
    kept.delete(k);
    old.texture.dispose();
  }
  return made;
}
