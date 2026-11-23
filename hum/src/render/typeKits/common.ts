import type { AudioFrame, Palette, TrackAnalysis } from '../../core/types';
import type { Inks, Placed, TypeLayout } from '../lyricAuto';

/**
 * What every kit shares: how a word arrives (the same timing the clean lyrics use, so every kit
 * lands on the voice the same way), small colour helpers, the song facts the secondary lines print,
 * and scratch canvases for the effects that need compositing (stripe cuts, tinted copies).
 * Everything here is a pure function of song time.
 */

export type RGB = [number, number, number];

/** what a kit gets to draw a laid-out line */
export interface KitLine {
  g: CanvasRenderingContext2D;
  L: TypeLayout;
  /** song time (the layer's clock, LEAD early like the clean lyrics) */
  t: number;
  alpha: number;
  inks: Inks;
  /** the guard picked light ink: the words sit on a dark ground */
  light: boolean;
  pal: Palette;
  audio: AudioFrame;
  drop: boolean;
  W: number;
  H: number;
  /** which medium this line is (for the medium-specific forms: the LED plate, the stretched band) */
  medium: 'subtitle' | 'big' | 'sparse';
  facts: SongFacts;
  /** this line's dice (fixed per line) */
  seed: number;
  /** when the showing started (song time): for things that draw on as a line arrives */
  start: number;
}

/* ───────────────────────── colour ───────────────────────── */

export function hexRGB(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** a CSS colour as RGB: '#rrggbb' or 'rgb(a)(r,g,b…)' (the guard hands its ink over as rgba()) */
export function parseRGB(s: string): RGB {
  if (s.startsWith('#')) return hexRGB(s);
  const n = s.match(/[\d.]+/g)?.map(Number) ?? [];
  return [n[0] ?? 255, n[1] ?? 255, n[2] ?? 255];
}
export const css = (c: RGB, a = 1) => (a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`);
export const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
/** relative luminance (0..1) */
export const lum = (c: RGB) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
/** WCAG contrast ratio */
export const contrast = (a: RGB, b: RGB) => {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

export function toHsl(c: RGB): [number, number, number] {
  const r = c[0] / 255;
  const g = c[1] / 255;
  const b = c[2] / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s, l];
}
export function fromHsl(h: number, s: number, l: number): RGB {
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}

/** the most colourful of the palette's colours, most colourful first (bg and fg last if grey) */
export function huesOf(pal: Palette): RGB[] {
  const all = [pal.accent, pal.accent2, pal.fg, pal.muted, pal.bg].map(hexRGB);
  return all.map((c) => ({ c, s: toHsl(c)[1] * (1 - Math.abs(toHsl(c)[2] - 0.5)) })).sort((a, b) => b.s - a.s).map((x) => x.c);
}

/** push a colour toward a lightness until it reaches `minL` luminance (light) or under `maxL` (dark) */
export function reach(c: RGB, toward: RGB, lumMin: number, lumMax = 1): RGB {
  let out = c;
  for (let k = 0; k < 12 && (lum(out) < lumMin || lum(out) > lumMax); k++) out = mix(out, toward, 0.18);
  return out;
}

/* ───────────────────────── arrival ───────────────────────── */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export { clamp01 };
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const expoOut = (x: number) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));
export { easeOut, expoOut };

/** how long a word takes to arrive, per motion (as lyricAuto) */
const REVEAL = { tender: 0.55, dreamy: 0.7, punchy: 0.16, aggressive: 0.07 } as const;

export interface Arrival {
  /** drawn at all */
  on: boolean;
  /** opacity share */
  op: number;
  /** rise from below the baseline (px) */
  dy: number;
  /** share of the word wiped on, left to right */
  wipe: number;
  /** 0..1, how far through its arrival */
  p: number;
}

/**
 * How a word stands at time t. Captions: the whole line is up quietly and each word comes up to full
 * as it's sung. Display lines: words appear only as they're sung, rising (or wiping, for the giant
 * word) at the song's motion.
 */
export function arrival(L: TypeLayout, w: Placed, t: number): Arrival {
  const age = t - w.t;
  if (L.role === 'caption') {
    const p = age <= 0 ? 0 : easeOut(clamp01(age / Math.min(0.45, Math.max(0.12, w.end - w.t))));
    // unsung words stay readable ahead of the voice (the finishes lift blacks, so not too faint),
    // sung ones go full
    return { on: true, op: 0.65 + 0.35 * p, dy: 0, wipe: 1, p };
  }
  if (age < 0) return { on: false, op: 0, dy: 0, wipe: 0, p: 0 };
  const rd = REVEAL[L.treatment];
  const k = clamp01(age / rd);
  if (w.part === 'giant') return { on: true, op: 1, dy: 0, wipe: expoOut(clamp01(age / 0.32)), p: k };
  if (L.treatment === 'aggressive') return { on: true, op: k > 0 ? 1 : 0, dy: 0, wipe: 1, p: 1 };
  if (L.treatment === 'dreamy') return { on: true, op: easeOut(k), dy: 0, wipe: 1, p: k };
  return { on: true, op: 0.35 + 0.65 * easeOut(k), dy: (1 - expoOut(k)) * w.size * 0.6, wipe: 1, p: k };
}

/** is a kit line still moving at t (so the layer keeps redrawing)? */
export function kitMoving(L: TypeLayout, t: number, extra = 0): boolean {
  for (const w of L.words) {
    const age = t - w.t;
    if (age < -0.05) continue;
    if (age < 0.8 + extra) return true;
  }
  return false;
}

/* ───────────────────────── song facts ───────────────────────── */

export interface SongFacts {
  /** the part's name, e.g. 'Chorus' */
  part: string;
  /** song time as m:ss */
  time: string;
  bpm: number;
  /** which line this is, of how many */
  line: number;
  lines: number;
}

const LABEL: Record<string, string> = { intro: 'Intro', verse: 'Verse', chorus: 'Chorus', bridge: 'Bridge', build: 'Build', drop: 'Drop', break: 'Break', outro: 'Outro' };

export function songFacts(an: TrackAnalysis | null, t: number, line: number, lines: number): SongFacts {
  const sec = an?.sections.find((s) => t >= s.start && t < s.end);
  const m = Math.floor(Math.max(0, t) / 60);
  const s = Math.floor(Math.max(0, t) % 60);
  return { part: sec ? (LABEL[sec.label] ?? sec.label) : 'Song', time: `${m}:${String(s).padStart(2, '0')}`, bpm: Math.round(an?.bpm ?? 0), line, lines };
}

/* ───────────────────────── scratch canvases ───────────────────────── */

const scratch: HTMLCanvasElement[] = [];
/** a cleared scratch canvas at least w×h (kept between frames; index picks one of a few) */
export function scratchCanvas(i: number, w: number, h: number): CanvasRenderingContext2D {
  let c = scratch[i];
  if (!c) scratch[i] = c = document.createElement('canvas');
  if (c.width < w || c.height < h) {
    c.width = Math.max(c.width, Math.ceil(w));
    c.height = Math.max(c.height, Math.ceil(h));
  }
  const g = c.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, Math.ceil(w) + 2, Math.ceil(h) + 2);
  return g;
}

/** a small seeded random (mulberry32) */
export function dice(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** a hash of an integer to 0..1 (for jitter that's a pure function of a frame number) */
export const hash1 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** the bounding box of a line's rows, padded */
export function rowsBox(L: TypeLayout, pad: number): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of L.rows) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** set a word's font (weight, italic, width) on a canvas */
export function wordFont(g: CanvasRenderingContext2D, w: Placed, size = w.size) {
  const v = w.voice;
  g.font = `${w.italic ? 'italic ' : ''}${Math.round(v.weight)} ${size.toFixed(1)}px ${v.family}`;
  g.fontStretch = v.stretch ?? 'normal';
  g.letterSpacing = `${(size * v.track).toFixed(2)}px`;
}

/** a rounded rectangle path */
export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}
