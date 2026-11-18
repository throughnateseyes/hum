import type { Palette } from '../core/types';
import { hash, hex, lum, mix, rgba } from '../scenes/board/kit';
import type { RGB } from '../scenes/board/kit';

/**
 * Newspaper-cutout lyrics: a ransom note. Each word (or, for some short words, each letter) is
 * its own clipping: a different typeface, weight and case, on a little paper scrap of a different
 * tone, a bit crooked and off the line. Everything is seeded by the line and word, so a line looks
 * the same on every frame and every replay. Ink is chosen per scrap for contrast against its own
 * paper, so it stays readable over any scene, light or dark.
 */

interface Piece {
  text: string;
  font: string;
  paper: RGB;
  ink: RGB;
  /** scrap size (before the row scale) and where the text sits in it */
  w: number;
  h: number;
  asc: number;
  padX: number;
  rot: number;
  dy: number;
  /** jitter for the four corners: x0,y0, x1,y1, x2,y2, x3,y3 (fractions of the font size) */
  jag: number[];
  /** faint lines of "newsprint" behind the letters */
  print: boolean;
  size: number;
}

interface WordCut {
  pieces: Piece[];
  w: number;
  h: number;
}

export interface CutoutLayout {
  /** per word: where its scraps go, already scaled to fit */
  words: { x: number; y: number; cut: WordCut }[];
  scale: number;
}

/** canvas font for a family index: [style, weight, family] */
const FACES: [string, number, string][] = [
  ['normal', 900, '"Arial Black", "Helvetica Neue", Arial, sans-serif'],
  ['italic', 700, 'Georgia, "Times New Roman", serif'],
  ['normal', 400, '"Times New Roman", Times, serif'],
  ['normal', 400, 'Impact, Haettenschweiler, "Arial Narrow", sans-serif'],
  ['normal', 700, '"Courier New", Courier, monospace'],
  ['normal', 600, '"American Typewriter", "Courier New", serif'],
  ['normal', 800, 'Inter, -apple-system, system-ui, sans-serif'],
  ['normal', 700, 'Didot, "Bodoni 72", "Bodoni MT", Georgia, serif'],
  ['normal', 700, 'Futura, "Trebuchet MS", sans-serif'],
  ['normal', 700, 'Rockwell, "Roboto Slab", Georgia, serif'],
  ['italic', 900, '"Helvetica Neue", Arial, sans-serif'],
];

const BLACK: RGB = [22, 20, 18];
const WHITE: RGB = [250, 248, 242];
const RED: RGB = [196, 32, 38];

/** WCAG contrast ratio */
function contrast(a: RGB, b: RGB) {
  const L = (c: RGB) => {
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const la = L(a);
  const lb = L(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** paper scraps for this palette: newsprint and magazine stock, plus the scene's own colours */
function papers(p: Palette): { c: RGB; w: number }[] {
  const ac = hex(p.accent);
  const ac2 = hex(p.accent2);
  const fg = hex(p.fg);
  const bg = hex(p.bg);
  return [
    { c: [236, 231, 216], w: 3 }, // newsprint
    { c: [251, 250, 246], w: 2 }, // white stock
    { c: [240, 222, 160], w: 1 }, // yellowed
    { c: BLACK, w: 2 },
    { c: [198, 162, 112], w: 1 }, // kraft
    { c: mix(ac, WHITE, 0.08), w: 2 },
    { c: mix(ac2, WHITE, 0.12), w: 1 },
    // the scene's ink as paper, so the note belongs to the look
    { c: lum(bg) > 0.5 ? mix(fg, BLACK, 0.1) : mix(fg, WHITE, 0.1), w: 1 },
  ];
}

function pick<T>(list: { c: T; w: number }[], r: number): T {
  const total = list.reduce((a, x) => a + x.w, 0);
  let acc = r * total;
  for (const x of list) {
    acc -= x.w;
    if (acc < 0) return x.c;
  }
  return list[list.length - 1].c;
}

/** an ink that reads on this paper: the accent or red when they contrast enough, else black/white */
function inkFor(paper: RGB, accent: RGB, r: number): RGB {
  const options: RGB[] = r < 0.25 ? [accent, RED] : r < 0.4 ? [RED, accent] : [];
  for (const c of options) if (contrast(c, paper) >= 4.5 && Math.abs(lum(c) - lum(paper)) > 0.25) return c;
  return contrast(BLACK, paper) >= contrast(WHITE, paper) ? BLACK : WHITE;
}

function casing(s: string, r: number) {
  if (r < 0.45) return s.toUpperCase();
  if (r < 0.68) return s.toLowerCase();
  return s;
}

function makePiece(g: CanvasRenderingContext2D, text: string, size: number, seed: number, pal: Palette, letter: boolean): Piece {
  const R = (k: number) => hash(seed, k, 77);
  const [style, weight, family] = FACES[Math.floor(R(1) * FACES.length) % FACES.length];
  const sz = size * (letter ? 0.92 + R(2) * 0.42 : 0.82 + R(2) * 0.36);
  const font = `${style} ${weight} ${sz.toFixed(1)}px ${family}`;
  g.font = font;
  const m = g.measureText(text);
  const asc = Math.max(m.actualBoundingBoxAscent || sz * 0.72, sz * 0.5);
  const desc = Math.max(m.actualBoundingBoxDescent || 0, sz * 0.04);
  const padX = sz * (letter ? 0.1 + R(3) * 0.12 : 0.12 + R(3) * 0.16);
  const padY = sz * (0.08 + R(4) * 0.12);
  const paper = pick(papers(pal), R(5));
  const jag: number[] = [];
  for (let k = 0; k < 8; k++) jag.push((R(10 + k) - 0.5) * 0.09);
  return {
    text,
    font,
    paper,
    ink: inkFor(paper, hex(pal.accent), R(6)),
    w: m.width + padX * 2,
    h: asc + desc + padY * 2,
    asc: asc + padY,
    padX,
    rot: (R(7) - 0.5) * (letter ? 0.36 : 0.16),
    dy: (R(8) - 0.5) * sz * 0.16,
    jag,
    print: R(9) < 0.3,
    size: sz,
  };
}

/** lay a line out once: scraps per word, wrapped and scaled to fit the frame */
export function buildCutout(
  g: CanvasRenderingContext2D,
  words: string[],
  lineIdx: number,
  W: number,
  H: number,
  pal: Palette,
  o: { box?: { x0: number; y0: number; x1: number; y1: number }; scale?: number; burst?: boolean } = {},
): CutoutLayout {
  const base = Math.min(H * 0.1, W * 0.07) * (o.scale ?? 1);
  const box = o.box ?? { x0: W * 0.07, y0: H * 0.14, x1: W * 0.93, y1: H * 0.86 };
  const cuts: WordCut[] = words.map((word, i) => {
    const seed = lineIdx * 257 + i * 31 + 7;
    const R = (k: number) => hash(seed, k, 5);
    const clean = word.replace(/\s+/g, '');
    const letters = clean.length >= 2 && clean.length <= 6 && R(1) < 0.34;
    const pieces: Piece[] = letters
      ? [...clean].map((ch, k) => makePiece(g, R(20 + k) < 0.55 ? ch.toUpperCase() : ch.toLowerCase(), base, seed * 13 + k + 1, pal, true))
      : [makePiece(g, casing(clean, R(2)), base, seed * 13, pal, false)];
    const gap = base * 0.03;
    // a burst throws the clippings down harder: more tilt, more scatter
    if (o.burst)
      for (const p of pieces) {
        p.rot *= 2.4;
        p.dy *= 2.6;
      }
    return { pieces, w: pieces.reduce((a, p) => a + p.w, 0) + gap * (pieces.length - 1), h: Math.max(...pieces.map((p) => p.h)) };
  });

  const space = base * (o.burst ? 0.5 : 0.36);
  const maxW = box.x1 - box.x0;
  const maxH = box.y1 - box.y0;
  let scale = 1;
  for (let tries = 0; tries < 8; tries++) {
    const rows: number[][] = [[]];
    let x = 0;
    cuts.forEach((c, i) => {
      const cw = c.w * scale;
      const row = rows[rows.length - 1];
      if (row.length && x + space * scale + cw > maxW) {
        rows.push([i]);
        x = cw;
      } else {
        row.push(i);
        x += (row.length > 1 ? space * scale : 0) + cw;
      }
    });
    const rowH = rows.map((r) => Math.max(...r.map((i) => cuts[i].h)) * scale);
    const lead = base * 0.14 * scale;
    const totalH = rowH.reduce((a, b) => a + b, 0) + lead * (rows.length - 1);
    const widest = Math.max(...cuts.map((c) => c.w * scale));
    if ((rows.length > 4 || totalH > maxH || widest > maxW) && tries < 7) {
      scale *= 0.86;
      continue;
    }
    const out: CutoutLayout['words'] = [];
    let y = box.y0 + (maxH - totalH) / 2;
    rows.forEach((row, ri) => {
      const rw = row.reduce((a, i) => a + cuts[i].w * scale, 0) + space * scale * (row.length - 1);
      let rx = box.x0 + (maxW - rw) / 2;
      for (const i of row) {
        out.push({ x: rx, y: y + rowH[ri] / 2, cut: cuts[i] });
        rx += cuts[i].w * scale + space * scale;
      }
      y += rowH[ri] + lead;
    });
    return { words: out, scale };
  }
  return { words: [], scale };
}

function scrap(g: CanvasRenderingContext2D, p: Piece, j: number) {
  const s = p.size;
  const x0 = -p.w / 2;
  const y0 = -p.h / 2;
  g.beginPath();
  g.moveTo(x0 + p.jag[0] * s * j, y0 + p.jag[1] * s * j);
  g.lineTo(x0 + p.w + p.jag[2] * s * j, y0 + p.jag[3] * s * j);
  g.lineTo(x0 + p.w + p.jag[4] * s * j, y0 + p.h + p.jag[5] * s * j);
  g.lineTo(x0 + p.jag[6] * s * j, y0 + p.h + p.jag[7] * s * j);
  g.closePath();
}

/** draw the sung words of a laid-out line; the newest one slaps down (pop 1 → 0) */
export function drawCutout(g: CanvasRenderingContext2D, L: CutoutLayout, sung: number, pop: number, alpha: number) {
  g.save();
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const n = Math.min(sung, L.words.length);
  for (let wi = 0; wi < n; wi++) {
    const { x, y, cut } = L.words[wi];
    const newest = wi === n - 1;
    const k = L.scale * (newest ? 1 + 0.28 * pop : 1);
    let px = x + (newest ? cut.w * L.scale * 0.5 * (1 - (1 + 0.28 * pop)) : 0);
    const gap = cut.pieces.length > 1 ? (cut.w - cut.pieces.reduce((a, p) => a + p.w, 0)) / (cut.pieces.length - 1) : 0;
    for (const p of cut.pieces) {
      const cx = px + (p.w * k) / 2;
      const cy = y + p.dy * L.scale;
      g.save();
      g.translate(cx, cy);
      g.rotate(p.rot + (newest ? pop * 0.12 : 0));
      g.scale(k, k);
      g.globalAlpha = alpha;
      // lift off the picture with a soft offset shadow
      g.save();
      g.translate(p.size * 0.05, p.size * 0.08);
      scrap(g, p, 1);
      g.fillStyle = 'rgba(0,0,0,0.32)';
      g.fill();
      g.restore();
      scrap(g, p, 1);
      g.fillStyle = rgba(p.paper);
      g.fill();
      if (p.print) {
        // faint text lines from the page it was cut out of
        g.save();
        g.clip();
        g.fillStyle = rgba(p.ink, 0.07);
        const lh = p.size * 0.16;
        for (let ly = -p.h / 2 + lh * 0.6; ly < p.h / 2; ly += lh) g.fillRect(-p.w / 2, ly, p.w, lh * 0.38);
        g.restore();
      }
      g.font = p.font;
      g.fillStyle = rgba(p.ink);
      g.fillText(p.text, -p.w / 2 + p.padX, -p.h / 2 + p.asc);
      g.restore();
      px += (p.w + gap) * k;
    }
  }
  g.restore();
}
