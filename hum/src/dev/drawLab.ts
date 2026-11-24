/**
 * Dev helper (served at /draw.html by `npm run dev`, not part of the build): draws pen drawings
 * (src/draw) on a sheet, to look at the pen itself. A headless browser drives it:
 *
 *   __draw.sheet(cells, { cols, w, h, bg })   cells: { drawing, hand, progress, boil, seed, colour, inks, label }
 *                                             → a PNG data url
 *   __draw.cost(drawings, w, h, hand, n)      → ms per redraw of all of them, over n redraws
 *   __draw.faults(drawing)                    → what the local checks say
 */
import { cleanDrawing, drawingFaults, type HandId } from '../draw/format';
import { drawDrawing, seedOf, type Inks } from '../draw/pen';

interface Cell {
  drawing: unknown;
  hand?: HandId;
  progress?: number;
  boil?: number;
  seed?: number;
  colour?: boolean;
  inks?: Inks;
  label?: string;
}

const INKS: Inks = { ink: '#1c1a17', a: '#e2553a', b: '#f0b84a', c: '#b9cfc6' };

function sheet(cells: Cell[], o: { cols?: number; w?: number; h?: number; bg?: string } = {}): string {
  const cols = o.cols ?? 3;
  const w = o.w ?? 600;
  const h = o.h ?? 600;
  const c = document.createElement('canvas');
  c.width = cols * w;
  c.height = Math.ceil(cells.length / cols) * h;
  const g = c.getContext('2d')!;
  g.fillStyle = o.bg ?? '#f3ede0';
  g.fillRect(0, 0, c.width, c.height);
  cells.forEach((x, i) => {
    const d = cleanDrawing(x.drawing);
    const X = (i % cols) * w;
    const Y = Math.floor(i / cols) * h;
    if (d) drawDrawing(g, d, { seed: x.seed ?? seedOf(x.label ?? String(i)), hand: x.hand ?? 'pen', boil: x.boil ?? 0, progress: x.progress ?? 1, box: { x: X + w * 0.08, y: Y + h * 0.08, w: w * 0.84, h: h * 0.84 }, inks: x.inks ?? INKS, colour: x.colour ?? true });
    if (x.label) {
      g.fillStyle = '#888';
      g.font = '14px sans-serif';
      g.fillText(x.label, X + 10, Y + h - 10);
    }
  });
  return c.toDataURL('image/png');
}

function cost(drawings: unknown[], w: number, h: number, hand: HandId, n: number): number {
  const ds = drawings.map(cleanDrawing).filter((d) => !!d);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const run = (k: number) => {
    g.clearRect(0, 0, w, h);
    ds.forEach((d, i) => drawDrawing(g, d!, { seed: i + 1, hand, boil: k, progress: 1, box: { x: 0, y: 0, w, h }, inks: INKS, colour: true }));
  };
  for (let k = 0; k < 6; k++) run(k);
  g.getImageData(0, 0, 1, 1);
  const t = performance.now();
  for (let k = 0; k < n; k++) {
    run(k);
    g.getImageData(0, 0, 1, 1);
  }
  return (performance.now() - t) / n;
}

const faults = (d: unknown) => {
  const c = cleanDrawing(d);
  return c ? drawingFaults(c) : ['unusable'];
};

(window as unknown as Record<string, unknown>).__draw = { sheet, cost, faults };
