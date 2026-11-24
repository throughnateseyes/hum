/**
 * Line figures: what the rest of the app uses.
 *
 *   validateFigure(raw)            check any data that claims to be a figure (format.ts)
 *   listFigures, addFigure, removeFigure, recallFigures, onFigures     what there is (store.ts)
 *   figureThumb(figure, o)         a canvas with the figure on it, for a shelf
 *   figureProof(figure)            the JPEG Claude is shown on the fix round
 *   makeFigure(brief, o)           ask Claude for one, look at it, fix it once, keep it
 *   suitsFigure(brief)             is this a built thing (line figure) or a living one (pen drawing)?
 */
import * as THREE from 'three';
import { postDirector } from '../director/access';
import { getPalette, resolvePalette } from '../core/palettes';
import type { Palette } from '../core/types';
import { FigureRenderer, fitCamera, reachOf, type Camera, type FrameBox } from './engine';
import { validateFigure, type Figure } from './format';
import { buildFigure } from './geometry';
import { Drive } from './motion';
import { addFigure, newFigureId, type SavedFigure } from './store';
import type { FigureBrief } from './suits';

export { validateFigure, type Figure } from './format';
export { addFigure, figureCount, getFigure, listFigures, onFigures, recallFigures, removeFigure, type SavedFigure } from './store';
export { suitsFigure, type FigureBrief } from './suits';

/* ───────── pictures of a figure ───────── */

interface Still {
  width: number;
  height: number;
  palette: Palette;
  /** 0 at rest … 1 with every motion at its far end */
  open: number;
  az: number;
  floor: number;
  weight: number;
}

/** one small renderer for stills, let go a little after the last one */
let lab: { gl: THREE.WebGLRenderer; engine: FigureRenderer; canvas: HTMLCanvasElement } | null = null;
let labTimer = 0;
function still(f: Figure, o: Still): HTMLCanvasElement {
  if (!lab) {
    const canvas = document.createElement('canvas');
    const gl = new THREE.WebGLRenderer({ canvas, alpha: false, preserveDrawingBuffer: true });
    gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    lab = { gl, engine: new FigureRenderer(), canvas };
  }
  clearTimeout(labTimer);
  labTimer = window.setTimeout(() => {
    lab?.engine.dispose();
    lab?.gl.dispose();
    lab?.gl.forceContextLoss();
    lab = null;
  }, 20_000);
  const { gl, engine, canvas } = lab;
  // drawn twice as large and scaled down, so a 160 px thumbnail keeps its fine lines
  gl.setPixelRatio(1);
  gl.setSize(o.width * 2, o.height * 2, false);
  const b = buildFigure(f);
  const box: FrameBox = { x0: -0.84, x1: 0.84, y0: -0.84, y1: 0.84 };
  const base: Camera = { az: o.az, el: 30, target: b.mid, dist: 600, lens: 6.2, ox: 0, oy: 0 };
  const drive = Drive.fixed(o.open, o.open * 0.12);
  const cam = fitCamera(base, o.width / o.height, reachOf(b, [drive], 1), box, [o.az]);
  const span = Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], 40);
  engine.draw(
    gl,
    null,
    o.width * 2,
    o.height * 2,
    cam,
    [{ figure: b, at: [0, 0, 0], scale: 1, drive, build: 1, strength: 1, lit: true }],
    { weight: o.weight, shade: 0.22, motion: 1, floor: o.floor, grid: span / 9, reach: span * 1.3, floorZ: b.lo[2], floorAt: [b.mid[0], b.mid[1]] },
    resolvePalette(o.palette),
  );
  const out = document.createElement('canvas');
  out.width = o.width;
  out.height = o.height;
  const g = out.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, 0, 0, o.width, o.height);
  return out;
}

/** the figure at rest, for a shelf */
export function figureThumb(f: Figure, o: { size?: number; palette?: Palette } = {}): HTMLCanvasElement {
  const size = o.size ?? 200;
  return still(f, { width: size, height: size, palette: o.palette ?? getPalette('ink-on-cream'), open: 0, az: 45, floor: 0, weight: 1080 / size * 1.15 });
}

/** at rest beside every motion at its far end, as plain base64 (what the fix step takes) */
export function figureProof(f: Figure): string {
  const w = 720;
  const h = 720;
  const c = document.createElement('canvas');
  c.width = w * 2;
  c.height = h;
  const g = c.getContext('2d')!;
  const o = { width: w, height: h, palette: getPalette('ink-on-cream'), az: 45, floor: 0.5, weight: 2.6 };
  g.drawImage(still(f, { ...o, open: 0 }), 0, 0);
  g.drawImage(still(f, { ...o, open: 1 }), w, 0);
  for (const q of [0.86, 0.7, 0.5]) {
    const url = c.toDataURL('image/jpeg', q);
    if (url.length < 390_000) return url.slice(url.indexOf(',') + 1);
  }
  return c.toDataURL('image/jpeg', 0.3).split(',')[1];
}

/* ───────── asking Claude ───────── */

export interface MakeOptions {
  signal?: AbortSignal;
  /** nobody pressed a button for this: never open the access window */
  quiet?: boolean;
  /** look at it and correct it once (default true) */
  fix?: boolean;
  song?: string;
  /** keep it on this computer (default true) */
  keep?: boolean;
  onStep?: (step: 'drawing' | 'looking') => void;
}

async function ask(body: Record<string, unknown>, o: MakeOptions): Promise<{ figure: Figure; notes: string[] } | null> {
  const res = await postDirector((accessCode) => ({ ...body, accessCode }), { signal: o.signal, quiet: o.quiet });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { note?: string } | null;
    throw new Error(j?.note || 'Claude couldn’t draw that.');
  }
  const j = (await res.json()) as { figure?: unknown; notes?: unknown };
  const c = validateFigure(j.figure);
  if (!c) return null;
  return { figure: c.figure, notes: Array.isArray(j.notes) ? j.notes.filter((n): n is string => typeof n === 'string') : [] };
}

/** One brief to one kept figure. The fix round is a bonus: if it fails, the first drawing stands. */
export async function makeFigure(brief: FigureBrief, o: MakeOptions = {}): Promise<SavedFigure> {
  o.onStep?.('drawing');
  const first = await ask({ mode: 'figure', brief }, o);
  if (!first) throw new Error('Claude’s drawing couldn’t be used. Try it again.');
  let figure = first.figure;
  if (o.fix !== false) {
    o.onStep?.('looking');
    try {
      const r = await ask({ mode: 'figureFix', brief, figure, notes: first.notes, images: [figureProof(figure)] }, o);
      // a "fix" that lost most of the drawing isn't one
      if (r && r.figure.solids.length >= figure.solids.length * 0.5) figure = r.figure;
    } catch (e) {
      if (o.signal?.aborted) throw e;
    }
  }
  const saved: SavedFigure = { id: newFigureId(), kind: 'figure', object: brief.object, brief: brief.brief ?? '', mood: brief.mood ?? '', figure, made: Date.now(), ...(o.song ? { song: o.song } : {}) };
  addFigure(saved, o.keep !== false);
  return saved;
}
