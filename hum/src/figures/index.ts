/**
 * Line figures: pictures of them, outside their own scene.
 *
 *   paintFigure(g, figure, o)   one on a 2D canvas, on a clear ground, part built (the shelf, the words' drawing)
 *   figureRatio(figure)         its width over its height
 *   figureProof(figure)         the JPEG Claude is shown on the fix round
 *
 * The figures themselves are drawings of kind 'figure' (src/draw): made, kept, deleted and locked there.
 */
import * as THREE from 'three';
import { getPalette, resolvePalette } from '../core/palettes';
import type { Palette } from '../core/types';
import { FigureRenderer, fitCamera, reachOf, type Camera, type FrameBox } from './engine';
import type { Figure } from './format';
import { buildFigure, type BuiltFigure } from './geometry';
import { Drive } from './motion';

interface Still {
  width: number;
  height: number;
  palette: Palette;
  /** 0 at rest … 1 with every motion at its far end */
  open: number;
  floor: number;
  weight: number;
  /** how much of it is built */
  build: number;
  /** nothing behind it: only the figure is painted */
  clear: boolean;
}

/** one small renderer for stills, let go a little after the last one */
let lab: { gl: THREE.WebGLRenderer; engine: FigureRenderer; canvas: HTMLCanvasElement } | null = null;
let labTimer = 0;
const dropLab = () => {
  lab?.engine.dispose();
  lab?.gl.dispose();
  lab?.gl.forceContextLoss();
  lab = null;
};

const builts = new WeakMap<Figure, BuiltFigure>();
const built = (f: Figure) => {
  let b = builts.get(f);
  if (!b) builts.set(f, (b = buildFigure(f)));
  return b;
};

const WHOLE: FrameBox = { x0: -0.9, x1: 0.9, y0: -0.9, y1: 0.9 };
const camOf = (b: BuiltFigure, aspect: number, open: number): Camera =>
  fitCamera({ az: 45, el: 30, target: b.mid, dist: 600, lens: 6.2, ox: 0, oy: 0 }, aspect, reachOf(b, [Drive.fixed(open, open * 0.12)], 1), WHOLE, [45]);

/** the figure, drawn twice as large as asked so a small picture keeps its fine lines */
function still(f: Figure, o: Still): HTMLCanvasElement {
  // the browser took the picture's memory back: start again
  if (lab?.gl.getContext().isContextLost()) dropLab();
  if (!lab) {
    const canvas = document.createElement('canvas');
    const gl = new THREE.WebGLRenderer({ canvas, alpha: true, preserveDrawingBuffer: true });
    gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    lab = { gl, engine: new FigureRenderer(), canvas };
  }
  clearTimeout(labTimer);
  labTimer = window.setTimeout(dropLab, 20_000);
  const { gl, engine, canvas } = lab;
  const w = o.width * 2;
  const h = o.height * 2;
  if (canvas.width !== w || canvas.height !== h) {
    gl.setPixelRatio(1);
    gl.setSize(w, h, false);
  }
  const b = built(f);
  const span = Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], 40);
  engine.draw(
    gl,
    null,
    w,
    h,
    camOf(b, o.width / o.height, o.open),
    [{ figure: b, at: [0, 0, 0], scale: 1, drive: Drive.fixed(o.open, o.open * 0.12), build: o.build, strength: 1, lit: true }],
    { weight: o.weight, shade: 0.22, motion: 1, floor: o.floor, grid: span / 9, reach: span * 1.3, floorZ: b.lo[2], floorAt: [b.mid[0], b.mid[1]], clear: o.clear },
    resolvePalette(o.palette),
  );
  return canvas;
}

const ratios = new WeakMap<Figure, number>();
/** the shape of the space it takes on screen at rest, as width over height */
export function figureRatio(f: Figure): number {
  let r = ratios.get(f);
  if (r === undefined) {
    const b = built(f);
    const dx = b.hi[0] - b.lo[0];
    const dy = b.hi[1] - b.lo[1];
    const dz = b.hi[2] - b.lo[2];
    const s = Math.SQRT1_2;
    r = Math.min(2.4, Math.max(0.42, ((dx + dy) * s) / Math.max(1, (dx + dy) * s * 0.5 + dz * 0.866)));
    ratios.set(f, r);
  }
  return r;
}

export interface FigurePaint {
  box: { x: number; y: number; w: number; h: number };
  /** how much is built, 0..1 */
  progress: number;
  ink: string;
  accent: string;
  /** what its faces are made of */
  paper: string;
  /** device pixels per unit of the context */
  scale?: number;
  fat?: number;
  halo?: { colour: string; width: number };
}

/** finished pictures, newest last: a figure that is all there is drawn once, not once a frame */
const done = new Map<string, HTMLCanvasElement>();
const KEEP = 24;
const ids = new WeakMap<Figure, number>();
let idNo = 0;
const idOf = (f: Figure) => {
  let n = ids.get(f);
  if (!n) ids.set(f, (n = ++idNo));
  return n;
};

/** one figure on a 2D canvas. The same options always give the same picture. */
export function paintFigure(g: CanvasRenderingContext2D, f: Figure, o: FigurePaint) {
  if (o.progress <= 0) return;
  const r = figureRatio(f);
  let w = o.box.w;
  let h = w / r;
  if (h > o.box.h) {
    h = o.box.h;
    w = h * r;
  }
  const scale = o.scale ?? 1;
  const pw = Math.min(1400, Math.max(16, Math.round(w * scale)));
  const ph = Math.max(16, Math.round(pw / r));
  const whole = o.progress >= 1;
  const key = `${idOf(f)}|${pw}x${ph}|${o.ink}${o.accent}${o.paper}|${o.fat ?? 1}`;
  let pic = whole ? done.get(key) : undefined;
  if (!pic) {
    const palette: Palette = { ...getPalette('ink-on-cream'), bg: o.paper, fg: o.ink, accent: o.accent };
    // a line of about 2.4 px at 1080, never thinner than one that reads on a small tile
    const short = Math.min(pw, ph);
    const px = Math.max(0.9, short / 300) * (o.fat ?? 1);
    const src = still(f, { width: pw, height: ph, palette, open: 0, floor: 0, weight: (px * 1080) / short, build: Math.min(1, o.progress), clear: true });
    pic = document.createElement('canvas');
    pic.width = pw;
    pic.height = ph;
    const c = pic.getContext('2d')!;
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, 0, 0, pw, ph);
    if (whole) {
      done.set(key, pic);
      if (done.size > KEEP) done.delete(done.keys().next().value!);
    }
  }
  const x = o.box.x + (o.box.w - w) / 2;
  const y = o.box.y + (o.box.h - h) / 2;
  if (o.halo) {
    const edge = document.createElement('canvas');
    edge.width = pw;
    edge.height = ph;
    const c = edge.getContext('2d')!;
    c.drawImage(pic, 0, 0);
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = o.halo.colour;
    c.fillRect(0, 0, pw, ph);
    const d = (o.halo.width / 1000) * Math.max(w, h);
    for (let i = 0; i < 16; i++) g.drawImage(edge, x + Math.cos((i * Math.PI) / 8) * d, y + Math.sin((i * Math.PI) / 8) * d, w, h);
  }
  g.drawImage(pic, x, y, w, h);
}

/** at rest beside every motion at its far end, as plain base64 (what the fix step takes) */
export function figureProof(f: Figure): string {
  const w = 720;
  const h = 720;
  const c = document.createElement('canvas');
  c.width = w * 2;
  c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  const o = { width: w, height: h, palette: getPalette('ink-on-cream'), floor: 0.5, weight: 2.6, build: 1, clear: false };
  g.drawImage(still(f, { ...o, open: 0 }), 0, 0, w, h);
  g.drawImage(still(f, { ...o, open: 1 }), w, 0, w, h);
  for (const q of [0.86, 0.7, 0.5]) {
    const url = c.toDataURL('image/jpeg', q);
    if (url.length < 390_000) return url.slice(url.indexOf(',') + 1);
  }
  return c.toDataURL('image/jpeg', 0.3).split(',')[1];
}
