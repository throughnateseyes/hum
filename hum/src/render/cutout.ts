import type { Palette } from '../core/types';
import { hash, hex, lum, mix, rgba } from '../scenes/board/kit';
import type { RGB } from '../scenes/board/kit';
import { FACES } from './lyricFonts';

/**
 * Collage lyrics: each word clipped from a printed page and laid down as it's sung. Meant as a
 * one-off moment (a big drop), so it is built to look like real paste-up rather than a ransom note:
 *
 *   - a small, consistent set of printed faces (a headline serif, a magazine italic, a heavy
 *     grotesk, condensed capitals), whole words only, never a different font per letter
 *   - three or four paper stocks (newsprint, white, black, one tone from the look) with grain and
 *     fibres, scissor-cut sides and one torn edge that shows the paper's white core
 *   - placed deliberately on a shared baseline, barely tilted, each scrap settling flat with its
 *     shadow tightening as it lands
 *
 * Everything is seeded by the line and word, so a line looks the same on every frame and replay.
 */

interface Clip {
  family: string;
  stretch?: CanvasFontStretch;
  weight: number;
  italic: boolean;
  case: 'asis' | 'lower' | 'upper';
  track: number;
}

/** a newspaper headline serif, a magazine italic, a heavy grotesk, condensed capitals */
const CLIPS: Clip[] = [
  { family: FACES.fraunces, weight: 800, italic: false, case: 'asis', track: -0.02 },
  { family: FACES.instrument, weight: 400, italic: true, case: 'lower', track: 0 },
  { family: FACES.tight, weight: 800, italic: false, case: 'lower', track: -0.03 },
  { family: FACES.archivo, stretch: 'condensed', weight: 700, italic: false, case: 'upper', track: 0.02 },
];

const INK: RGB = [24, 22, 20];
const WHITE: RGB = [249, 247, 241];
const NEWS: RGB = [233, 228, 212];

interface Piece {
  text: string;
  font: string;
  stretch: CanvasFontStretch;
  track: number;
  paper: RGB;
  ink: RGB;
  dark: boolean;
  w: number;
  h: number;
  asc: number;
  padX: number;
  rot: number;
  dy: number;
  /** which edge is torn: 0 top, 1 bottom */
  torn: number;
  /** small corner offsets for the scissor cuts (fractions of the font size) */
  cut: number[];
  seed: number;
  size: number;
}

export interface CutoutLayout {
  words: { x: number; y: number; t: number; p: Piece }[];
  scale: number;
}

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

/** the stocks for this look: newsprint and white mostly, some black, one tone of the look's accent */
function stocks(p: Palette): { c: RGB; w: number }[] {
  const tone = mix(hex(p.accent), WHITE, 0.12);
  const list: { c: RGB; w: number }[] = [
    { c: NEWS, w: 3 },
    { c: WHITE, w: 2.2 },
    { c: INK, w: 1.4 },
  ];
  if (contrast(tone, INK) >= 4.5 || contrast(tone, WHITE) >= 4.5) list.push({ c: tone, w: 1.1 });
  return list;
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

function caseOf(s: string, c: Clip['case']) {
  return c === 'upper' ? s.toUpperCase() : c === 'lower' ? s.toLowerCase() : s;
}

let grain: HTMLCanvasElement | null = null;
/** paper grain and fibres, made once and laid over every light scrap */
function grainTile(): HTMLCanvasElement {
  if (grain) return grain;
  const c = document.createElement('canvas');
  c.width = c.height = 192;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 192, 192);
  const img = g.getImageData(0, 0, 192, 192);
  for (let i = 0; i < 192 * 192; i++) {
    const n = hash(i, 3, 9);
    const v = 255 - Math.floor(n * n * n * 46);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v - 2;
    img.data[i * 4 + 2] = v - 6;
  }
  g.putImageData(img, 0, 0);
  // fibres: short faint strokes
  g.strokeStyle = 'rgba(120,105,80,0.10)';
  g.lineWidth = 0.7;
  for (let k = 0; k < 70; k++) {
    const x = hash(k, 1, 4) * 192;
    const y = hash(k, 2, 4) * 192;
    const a = hash(k, 3, 4) * Math.PI;
    const l = 4 + hash(k, 4, 4) * 12;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + 2, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  grain = c;
  return c;
}

function makePiece(g: CanvasRenderingContext2D, word: string, size: number, seed: number, pal: Palette, clipIdx: number): Piece {
  const R = (k: number) => hash(seed, k, 77);
  const clip = CLIPS[clipIdx];
  // Instrument Serif is small on its body: set it up a size so the scraps match
  const sz = size * (clip.case === 'upper' ? 0.9 : clip.family === FACES.instrument ? 1.22 : 1) * (0.94 + R(2) * 0.12);
  const font = `${clip.italic ? 'italic ' : ''}${clip.weight} ${sz.toFixed(1)}px ${clip.family}`;
  const text = caseOf(word, clip.case);
  g.font = font;
  g.fontStretch = clip.stretch ?? 'normal';
  g.letterSpacing = `${(sz * clip.track).toFixed(2)}px`;
  const m = g.measureText(text);
  g.letterSpacing = '0px';
  g.fontStretch = 'normal';
  const asc = Math.max(m.actualBoundingBoxAscent || sz * 0.72, sz * 0.55);
  const desc = Math.max(m.actualBoundingBoxDescent || 0, sz * 0.06);
  // the plate rule (render/lyricSpace.ts): at least 0.35 of a cap height above and below the ink and
  // 0.5 at each end (a cap is about 0.7 of the size)
  const padX = sz * (0.42 + R(3) * 0.1);
  const padY = sz * (0.3 + R(4) * 0.08);
  const paper = pick(stocks(pal), R(5));
  const dark = lum(paper) < 0.35;
  let ink: RGB = dark ? WHITE : INK;
  // now and then the headline is printed in the look's accent, when it reads on the stock
  const ac = hex(pal.accent);
  if (!dark && R(6) < 0.25 && contrast(ac, paper) >= 4.5) ink = ac;
  const cut: number[] = [];
  for (let k = 0; k < 8; k++) cut.push((R(10 + k) - 0.5) * 0.05);
  return {
    text,
    font,
    stretch: clip.stretch ?? 'normal',
    track: sz * clip.track,
    paper,
    ink,
    dark,
    w: m.width - sz * clip.track + padX * 2,
    h: asc + desc + padY * 2,
    asc: asc + padY,
    padX,
    rot: (R(7) - 0.5) * 0.05,
    dy: (R(8) - 0.5) * sz * 0.06,
    torn: R(9) < 0.5 ? 0 : 1,
    cut,
    seed,
    size: sz,
  };
}

/** lay a line out once: one scrap per word, on shared baselines, scaled to fit the box */
export function buildCutout(
  g: CanvasRenderingContext2D,
  words: { text: string; t: number }[],
  lineIdx: number,
  W: number,
  H: number,
  pal: Palette,
  o: { box?: { x0: number; y0: number; x1: number; y1: number }; scale?: number; burst?: boolean; align?: 'left' | 'center' } = {},
): CutoutLayout {
  const base = Math.min(H, W) * 0.085 * (o.scale ?? 1);
  const box = o.box ?? { x0: W * 0.07, y0: H * 0.4, x1: W * 0.93, y1: H * 0.86 };
  let prevClip = -1;
  const pieces: Piece[] = words.map((w, i) => {
    const seed = lineIdx * 257 + i * 31 + 7;
    let ci = Math.floor(hash(seed, 1, 5) * CLIPS.length) % CLIPS.length;
    if (ci === prevClip) ci = (ci + 1 + Math.floor(hash(seed, 2, 5) * (CLIPS.length - 1))) % CLIPS.length;
    prevClip = ci;
    const p = makePiece(g, w.text.replace(/\s+/g, ''), base, seed * 13, pal, ci);
    if (o.burst) p.rot *= 2;
    return p;
  });
  const gap = base * 0.14;
  const maxW = box.x1 - box.x0;
  const maxH = box.y1 - box.y0;
  let scale = 1;
  for (let tries = 0; tries < 10; tries++) {
    const rows: number[][] = [[]];
    let x = 0;
    pieces.forEach((p, i) => {
      const pw = p.w * scale;
      const row = rows[rows.length - 1];
      if (row.length && x + gap * scale + pw > maxW) {
        rows.push([i]);
        x = pw;
      } else {
        row.push(i);
        x += (row.length > 1 ? gap * scale : 0) + pw;
      }
    });
    const rowH = rows.map((r) => Math.max(...r.map((i) => pieces[i].h)) * scale);
    const lead = base * 0.1 * scale;
    const totalH = rowH.reduce((a, b) => a + b, 0) + lead * (rows.length - 1);
    const widest = Math.max(...pieces.map((p) => p.w * scale));
    if ((rows.length > 3 || totalH > maxH || widest > maxW) && tries < 9) {
      scale *= 0.88;
      continue;
    }
    const out: CutoutLayout['words'] = [];
    let y = box.y1 - totalH;
    rows.forEach((row, ri) => {
      const rw = row.reduce((a, i) => a + pieces[i].w * scale, 0) + gap * scale * (row.length - 1);
      // a little indent on alternate rows, like pasted-up lines
      let rx = (o.align === 'left' ? box.x0 + (ri % 2) * base * 0.5 * scale : box.x0 + (maxW - rw) / 2);
      for (const i of row) {
        out.push({ x: rx, y: y + rowH[ri] / 2, t: words[i].t, p: pieces[i] });
        rx += pieces[i].w * scale + gap * scale;
      }
      y += rowH[ri] + lead;
    });
    return { words: out, scale };
  }
  return { words: [], scale };
}

/** the scrap's outline: scissor-cut sides, one torn edge */
function outline(g: CanvasRenderingContext2D, p: Piece) {
  const s = p.size;
  const x0 = -p.w / 2;
  const y0 = -p.h / 2;
  const x1 = p.w / 2;
  const y1 = p.h / 2;
  const c = p.cut.map((v) => v * s);
  const tornY = p.torn === 0 ? y0 : y1;
  const steps = Math.max(8, Math.round(p.w / (s * 0.07)));
  const rnd = (k: number) => hash(p.seed, k + 100, 13) - 0.5;
  g.beginPath();
  g.moveTo(x0 + c[0], y0 + c[1]);
  if (p.torn === 0) for (let i = 1; i < steps; i++) g.lineTo(x0 + ((x1 - x0) * i) / steps, tornY + rnd(i) * s * 0.06);
  g.lineTo(x1 + c[2], y0 + c[3]);
  g.lineTo(x1 + c[4], y1 + c[5]);
  if (p.torn === 1) for (let i = steps - 1; i > 0; i--) g.lineTo(x0 + ((x1 - x0) * i) / steps, tornY + rnd(i) * s * 0.06);
  g.lineTo(x0 + c[6], y1 + c[7]);
  g.closePath();
}

/** is a scrap still settling at time t? */
export function cutoutMoving(L: CutoutLayout, t: number): boolean {
  return L.words.some((w) => t >= w.t - 0.02 && t < w.t + LAND + 0.03);
}

const LAND = 0.16;

/** draw the scraps sung by time t; each lands flat with its shadow tightening */
export function drawCutout(g: CanvasRenderingContext2D, L: CutoutLayout, t: number, alpha: number) {
  const tile = grainTile();
  const pat = g.createPattern(tile, 'repeat');
  g.save();
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  for (const { x, y, t: wt, p } of L.words) {
    const age = t - wt;
    if (age < 0) continue;
    const k = Math.min(1, age / LAND);
    const e = 1 - (1 - k) ** 3;
    const lift = 1 - e;
    const sc = L.scale * (1 + 0.035 * lift);
    g.save();
    g.translate(x + (p.w * L.scale) / 2, y + p.dy * L.scale - lift * p.size * 0.12 * L.scale);
    g.rotate(p.rot);
    g.scale(sc, sc);
    g.globalAlpha = alpha * Math.min(1, age / 0.05);
    // shadow on the picture: wide and soft while it's in the air, tight once it's down
    g.save();
    g.shadowColor = `rgba(0,0,0,${(0.34 - 0.12 * lift) * alpha})`;
    g.shadowBlur = p.size * (0.06 + 0.3 * lift) * L.scale;
    g.shadowOffsetY = p.size * (0.03 + 0.12 * lift) * L.scale;
    outline(g, p);
    g.fillStyle = rgba(p.paper);
    g.fill();
    g.restore();
    // the paper: grain and fibres on light stock, a faint sheen on black
    g.save();
    outline(g, p);
    g.clip();
    if (!p.dark && pat) {
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = pat;
      g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      g.globalCompositeOperation = 'source-over';
    } else {
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * 0.45);
    }
    // the torn edge shows the paper's white core
    const tornY = p.torn === 0 ? -p.h / 2 : p.h / 2;
    g.strokeStyle = rgba(p.dark ? [236, 232, 222] : [255, 254, 250], p.dark ? 0.85 : 0.9);
    g.lineWidth = p.size * 0.05;
    g.beginPath();
    const steps = Math.max(8, Math.round(p.w / (p.size * 0.07)));
    for (let i = 0; i <= steps; i++) g.lineTo(-p.w / 2 + (p.w * i) / steps, tornY + (hash(p.seed, i + 100, 13) - 0.5) * p.size * 0.06);
    g.stroke();
    g.restore();
    g.font = p.font;
    g.fontStretch = p.stretch;
    g.letterSpacing = `${p.track.toFixed(2)}px`;
    g.fillStyle = rgba(p.ink);
    g.fillText(p.text, -p.w / 2 + p.padX, -p.h / 2 + p.asc);
    g.letterSpacing = '0px';
    g.fontStretch = 'normal';
    g.restore();
  }
  g.restore();
}
