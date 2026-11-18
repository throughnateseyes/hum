/**
 * Instrument boards — shared kit: module contract, ink (palette), text, math, noise,
 * history buffers and a synthetic "demo signal" so boards look alive before a track plays.
 */
import type { AudioFrame, FrameContext, LayerId, Palette } from '../../core/types';

/* ───────────────────────── Contracts ───────────────────────── */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type RGB = [number, number, number];

/** Everything static drawing needs (cached per resize / palette / layout change). */
export interface SF {
  /** scale: min(width, height) / 1080 */
  s: number;
  /** integer hairline width in px */
  hl: number;
  /** line-weight param (1 = default) */
  lw: number;
  ink: Ink;
  labels: boolean;
  w: number;
  h: number;
}

/** Per-frame board context handed to every module. */
export interface BF extends SF {
  f: FrameContext;
  /** the audio to read: real frame, or the synthetic demo signal before anything played */
  a: AudioFrame;
  /** history buffers should advance (playing, or demo signal) */
  live: boolean;
  /** true while running on the synthetic demo signal */
  idle: boolean;
  t: number;
  dt: number;
  /** history scroll-speed multiplier */
  speed: number;
}

/** A panel instrument. State lives in the factory closure; `draw(ctx, rect, frame)` runs every frame. */
export interface Module {
  label?: string;
  meta?: string;
  /** false → no border / label strip (headers, footers) */
  chrome?: boolean;
  /** true → content fills the whole panel inside the border; the module draws its own label */
  bleed?: boolean;
  /** clip drawing to the content rect */
  clip?: boolean;
  drawStatic?(ctx: CanvasRenderingContext2D, r: Rect, sf: SF): void;
  draw(ctx: CanvasRenderingContext2D, r: Rect, bf: BF): void;
}

/* ───────────────────────── Fonts / math ───────────────────────── */

export const MONO = "'IBM Plex Mono', ui-monospace, monospace";
export const SANS = "'Inter Variable', Inter, sans-serif";
export const TAU = Math.PI * 2;

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const fract = (v: number) => v - Math.floor(v);
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** frame-rate independent exponential smoothing */
export const damp = (cur: number, target: number, k: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-k * dt));
export const pad2 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');
export const pad3 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(3, '0');
export const fmtTime = (sec: number) => `${pad2(sec / 60)}:${pad2(sec % 60)}`;
/** 0.42 → ".42", 1 → "1.0" */
export const fmt2 = (v: number) => {
  const c = clamp01(v);
  return c >= 0.995 ? '1.0' : c.toFixed(2).slice(1);
};

/** snap a coordinate so a stroke of width `lw` lands on whole pixels */
export const crisp = (v: number, lw: number) => (Math.round(lw) % 2 ? Math.floor(v) + 0.5 : Math.round(v));

export function setFont(ctx: CanvasRenderingContext2D, px: number, weight = 500, family = MONO, track = 0.06) {
  const p = Math.max(6, px);
  ctx.font = `${weight} ${p.toFixed(1)}px ${family}`;
  ctx.letterSpacing = `${(p * track).toFixed(2)}px`;
}

export function text(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  px: number,
  color: string,
  align: CanvasTextAlign = 'left',
  weight = 500,
  baseline: CanvasTextBaseline = 'middle',
) {
  setFont(ctx, px, weight);
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

/** label size used across panels */
export const labelPx = (s: number) => Math.max(7, 11.5 * s);

/* ───────────────────────── Color / ink ───────────────────────── */

const hexCache = new Map<string, RGB>();
export function hex(s: string): RGB {
  let c = hexCache.get(s);
  if (c) return c;
  let h = (s || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h.slice(0, 6), 16);
  c = Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [128, 128, 128];
  hexCache.set(s, c);
  return c;
}
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const rgba = (c: RGB, a = 1) =>
  `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a <= 0 ? 0 : a >= 1 ? 1 : a.toFixed(3)})`;
export const lum = (c: RGB) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

export interface Ink {
  bg: RGB;
  fg: RGB;
  /** accent, blended toward fg by the accent-intensity param */
  ac: RGB;
  ac2: RGB;
  mu: RGB;
  /** panel border hairline colour */
  line: RGB;
  /** a light ink for text over photos */
  paper: RGB;
  light: boolean;
  key: string;
}

let inkCacheKey = '';
let inkCache: Ink | null = null;
export function makeInk(p: Palette, accentAmt: number): Ink {
  const a = clamp01(accentAmt);
  const key = `${p.bg}${p.fg}${p.accent}${p.accent2}${p.muted}${a.toFixed(2)}`;
  if (inkCache && key === inkCacheKey) return inkCache;
  const bg = hex(p.bg);
  const fg = hex(p.fg);
  const mu = hex(p.muted);
  const light = lum(bg) > 0.5;
  const ink: Ink = {
    bg,
    fg,
    mu,
    ac: mix(fg, hex(p.accent), a),
    ac2: mix(mix(fg, bg, 0.45), hex(p.accent2), a),
    line: mix(bg, fg, light ? 0.3 : 0.38),
    paper: mix(light ? bg : fg, [255, 255, 255], 0.35),
    light,
    key,
  };
  inkCacheKey = key;
  inkCache = ink;
  return ink;
}

/* ───────────────────────── Noise ───────────────────────── */

function h3(i: number, j: number, k: number) {
  let n = (i * 374761393 + j * 668265263 + k * 1274126177) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return ((n & 0xffff) / 65535) * 2 - 1;
}
/** smooth value noise, roughly -1..1 */
export function noise3(x: number, y: number, z: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  let u = x - xi;
  let v = y - yi;
  let w = z - zi;
  u = u * u * (3 - 2 * u);
  v = v * v * (3 - 2 * v);
  w = w * w * (3 - 2 * w);
  const a = lerp(h3(xi, yi, zi), h3(xi + 1, yi, zi), u);
  const b = lerp(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), u);
  const c = lerp(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), u);
  const d = lerp(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), u);
  return lerp(lerp(a, b, v), lerp(c, d, v), w);
}
/** deterministic 0..1 hash */
export function hash(a: number, b = 0, c = 0) {
  return (h3(a | 0, b | 0, c | 0) + 1) * 0.5;
}

/* ───────────────────────── History ───────────────────────── */

export class Ring {
  readonly n: number;
  buf: Float32Array;
  head = 0;
  constructor(n: number) {
    this.n = n;
    this.buf = new Float32Array(n);
  }
  push(v: number) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.n;
  }
  /** k = 0 → oldest, n-1 → newest */
  at(k: number) {
    return this.buf[(this.head + k) % this.n];
  }
}

/** fixed-rate tick accumulator: returns how many samples to push this frame (max 4) */
export function makeTicker() {
  let acc = 0;
  return (dt: number, rate: number) => {
    acc += dt * rate;
    const k = Math.floor(acc);
    acc -= k;
    return Math.min(k, 4);
  };
}

/** spectrum bin (0..127, log 20 Hz–20 kHz) ↔ frequency */
export const binHz = (i: number) => 20 * Math.pow(1000, i / 127);
export const hzBin = (f: number) => (127 * Math.log(f / 20)) / Math.log(1000);
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/* ───────────────────────── Photos ───────────────────────── */

export interface Cover {
  sc: number;
  ox: number;
  oy: number;
  iw: number;
  ih: number;
}
export function cover(iw: number, ih: number, r: Rect, zoom = 1, fx = 0.5, fy = 0.5): Cover {
  const sc = Math.max(r.w / iw, r.h / ih) * zoom;
  return { sc, ox: r.x + (r.w - iw * sc) * fx, oy: r.y + (r.h - ih * sc) * fy, iw, ih };
}
/** draw the dest rect (dx,dy,dw,dh) of a cover-fitted image; offX/offY shift the source (in dest px) */
export function blitCover(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  c: Cover,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  offX = 0,
  offY = 0,
  srcW?: number,
) {
  const sw = srcW ?? dw / c.sc;
  const sh = dh / c.sc;
  if (sw <= 0 || sh <= 0 || sw > c.iw || sh > c.ih) return;
  const sx = clamp((dx + offX - c.ox) / c.sc, 0, c.iw - sw);
  const sy = clamp((dy + offY - c.oy) / c.sc, 0, c.ih - sh);
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

/* ───────────────────────── Demo signal ───────────────────────── */

/**
 * A soft synthetic groove (92 bpm) used until the first real playback, so a freshly opened
 * board already breathes: kicks on the beat, snares on 2/4, hats on eighths, drifting formants.
 */
export function createIdleAudio(): (t: number) => AudioFrame {
  const spectrum = new Float32Array(128);
  const waveform = new Float32Array(512);
  const layers = {} as Record<LayerId, number>;
  let lastBeat = -1;
  let lastHalf = -1;
  const f: AudioFrame = {
    playing: false,
    time: 0,
    duration: 0,
    level: 0,
    sub: 0,
    bass: 0,
    lowMid: 0,
    mid: 0,
    highMid: 0,
    air: 0,
    kick: 0,
    snare: 0,
    hat: 0,
    energy: 0,
    brightness: 0,
    flux: 0,
    beatPhase: 0,
    build: 0,
    drop: 0,
    sway: 0,
    onset: false,
    beat: false,
    kickHit: false,
    snareHit: false,
    hatHit: false,
    beatCount: 0,
    bpm: 92,
    spectrum,
    waveform,
    layers,
  };
  return (t: number) => {
    const b = (t * f.bpm) / 60;
    const bc = Math.floor(b);
    const ph = b - bc;
    const half = Math.floor(b * 2);
    const e8 = b * 2 - half;
    const newBeat = bc !== lastBeat;
    const newHalf = half !== lastHalf;
    const primed = lastBeat >= 0;
    lastBeat = bc;
    lastHalf = half;
    const kick = Math.exp(-ph * 5) * 0.6;
    const snare = bc % 2 === 1 ? Math.exp(-ph * 7) * 0.45 : 0;
    const hat = Math.exp(-e8 * 9) * 0.3;
    const drift = noise3(t * 0.15, 3.1, 0.7);
    f.kick = kick;
    f.snare = snare;
    f.hat = hat;
    f.sub = 0.18 + kick * 0.45;
    f.bass = 0.22 + kick * 0.35 + drift * 0.05;
    f.lowMid = 0.25 + 0.08 * noise3(t * 0.4, 1.2, 0);
    f.mid = 0.3 + 0.12 * noise3(t * 0.5, 2.7, 0) + snare * 0.2;
    f.highMid = 0.22 + snare * 0.3 + 0.06 * noise3(t * 0.7, 5.3, 0);
    f.air = 0.14 + hat * 0.5;
    f.level = 0.3 + kick * 0.25;
    f.energy = 0.36 + 0.1 * drift;
    f.brightness = 0.45 + 0.1 * noise3(t * 0.2, 8.1, 0);
    f.flux = 0.2 + kick * 0.3;
    f.beatPhase = ph;
    f.build = 0;
    f.drop = 0;
    f.sway = Math.sin((b * Math.PI) / 2);
    f.beat = primed && newBeat;
    f.kickHit = f.beat;
    f.snareHit = f.beat && bc % 2 === 1;
    f.hatHit = primed && newHalf;
    f.onset = f.kickHit || f.snareHit || f.hatHit;
    f.beatCount = bc;
    const f1 = 0.36 + 0.05 * Math.sin(t * 0.41);
    const f2 = 0.62 + 0.04 * Math.sin(t * 0.29 + 1);
    for (let i = 0; i < 128; i++) {
      const x = i / 127;
      let v = 0.5 * Math.pow(1 - x, 1.5) + 0.06;
      v += 0.24 * Math.exp(-(((x - f1) / 0.05) ** 2)) + 0.16 * Math.exp(-(((x - f2) / 0.045) ** 2));
      v += 0.1 * noise3(i * 0.35, t * 1.6, 0);
      v += kick * 0.45 * Math.exp(-x * 9) + hat * 0.35 * smoothstep(0.7, 1, x) + snare * 0.25 * Math.exp(-(((x - 0.55) / 0.15) ** 2));
      spectrum[i] = clamp01(v * 0.8);
    }
    for (let i = 0; i < 512; i++) {
      waveform[i] =
        Math.sin(i * 0.049 + t * 3) * (0.25 + kick * 0.4) + Math.sin(i * 0.23 + t * 7.3) * 0.1 + Math.sin(i * 0.71 - t * 2) * hat * 0.2;
    }
    for (const k of Object.keys(f) as (keyof AudioFrame)[]) {
      const v = f[k];
      if (typeof v === 'number') (layers as Record<string, number>)[k] = v;
    }
    return f;
  };
}
