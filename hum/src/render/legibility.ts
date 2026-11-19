import * as THREE from 'three';
import type { Palette } from '../core/types';

/**
 * Legibility guard for lyrics.
 *
 * Every other frame the finished picture (before pop-ups and lyrics) is shrunk into a tiny 96×54
 * buffer and read back. From that we know, for any box on screen, how bright the picture is there,
 * how much it varies and how busy (edgy) it is. `judge` then picks the lightest backing (none, a
 * soft shadow, a feathered scrim, a full-width scrim, a paper strip) and the ink that clears a contrast target
 * against the pixels actually under the text, and `Guard` eases between its choices so nothing
 * flickers when the scene changes under a line.
 */

export type RGB = [number, number, number];
export type Backing = 'none' | 'shadow' | 'soft' | 'band' | 'paper';
/** normalized box, y from the top */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const LADDER: Backing[] = ['none', 'shadow', 'soft', 'band'];
/** how much of the picture under the text each backing covers (in sRGB space, like canvas blending) */
const COVER: Record<Backing, number> = { none: 0, shadow: 0.3, soft: 0.62, band: 0.86, paper: 1 };

export const PROBE_W = 96;
export const PROBE_H = 54;

/** sRGB 0..1 → linear */
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
/** relative luminance of an sRGB colour (0..255) */
export function lumOf(c: RGB): number {
  return 0.2126 * lin(c[0] / 255) + 0.7152 * lin(c[1] / 255) + 0.0722 * lin(c[2] / 255);
}
/** WCAG contrast ratio between two relative luminances */
export const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

export function hexRGB(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const css = (c: RGB, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a.toFixed(3)})`;

/** the shrunken frame: sRGB luma and linear luminance per cell, row 0 at the top */
export class FrameProbe {
  readonly luma = new Float32Array(PROBE_W * PROBE_H);
  readonly L = new Float32Array(PROBE_W * PROBE_H);
  /** bumps every time a new frame has been read */
  version = 0;
  private rt = new THREE.WebGLRenderTarget(PROBE_W, PROBE_H, {
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  private buf = new Uint8Array(PROBE_W * PROBE_H * 4);
  private n = 0;
  private busy = false;
  /** read back without waiting a frame where the browser allows it (off in the dev harness: it steps faster than real time) */
  readAsync = true;

  /** shrink `tex` into the probe every `every` frames and read it back (asynchronously where possible) */
  sample(r: THREE.WebGLRenderer, tex: THREE.Texture, blit: (t: THREE.Texture, target: THREE.WebGLRenderTarget | null) => void, every = 2) {
    if (this.busy || this.n++ % every) return;
    blit(tex, this.rt);
    const ar = r as THREE.WebGLRenderer & { readRenderTargetPixelsAsync?: (...a: unknown[]) => Promise<unknown> };
    if (this.readAsync && ar.readRenderTargetPixelsAsync) {
      this.busy = true;
      ar.readRenderTargetPixelsAsync(this.rt, 0, 0, PROBE_W, PROBE_H, this.buf)
        .then(() => this.ingest())
        .catch(() => {
          this.readAsync = false;
        })
        .finally(() => {
          this.busy = false;
        });
    } else {
      r.readRenderTargetPixels(this.rt, 0, 0, PROBE_W, PROBE_H, this.buf);
      this.ingest();
    }
  }

  private ingest() {
    const b = this.buf;
    for (let y = 0; y < PROBE_H; y++) {
      // GL rows run bottom-up
      const src = (PROBE_H - 1 - y) * PROBE_W;
      for (let x = 0; x < PROBE_W; x++) {
        const k = (src + x) * 4;
        const R = b[k] / 255;
        const G = b[k + 1] / 255;
        const B = b[k + 2] / 255;
        const i = y * PROBE_W + x;
        this.luma[i] = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        this.L[i] = 0.2126 * lin(R) + 0.7152 * lin(G) + 0.0722 * lin(B);
      }
    }
    this.version++;
  }

  dispose() {
    this.rt.dispose();
  }
}

export interface RegionStats {
  /** mean relative luminance */
  mean: number;
  /** 10th / 90th percentile luminance */
  lo: number;
  hi: number;
  /** spread of sRGB luma */
  sd: number;
  /** busyness: mean neighbour difference of sRGB luma (calm ≈ 0.01, busy ≥ 0.06) */
  edge: number;
}

function cells(r: Rect) {
  const x0 = Math.max(0, Math.floor(r.x0 * PROBE_W));
  const x1 = Math.min(PROBE_W, Math.ceil(r.x1 * PROBE_W));
  const y0 = Math.max(0, Math.floor(r.y0 * PROBE_H));
  const y1 = Math.min(PROBE_H, Math.ceil(r.y1 * PROBE_H));
  return { x0, x1: Math.max(x0 + 1, x1), y0, y1: Math.max(y0 + 1, y1) };
}

export function regionStats(p: Pick<FrameProbe, 'luma' | 'L'>, r: Rect): RegionStats {
  const { x0, x1, y0, y1 } = cells(r);
  const Ls: number[] = [];
  let sum = 0;
  let sumY = 0;
  let sumY2 = 0;
  let edge = 0;
  let ne = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * PROBE_W + x;
      const v = p.luma[i];
      Ls.push(p.L[i]);
      sum += p.L[i];
      sumY += v;
      sumY2 += v * v;
      if (x + 1 < x1) {
        edge += Math.abs(v - p.luma[i + 1]);
        ne++;
      }
      if (y + 1 < y1) {
        edge += Math.abs(v - p.luma[i + PROBE_W]);
        ne++;
      }
    }
  }
  const n = Math.max(1, Ls.length);
  Ls.sort((a, b) => a - b);
  const mY = sumY / n;
  return {
    mean: sum / n,
    lo: Ls[Math.floor(n * 0.1)] ?? 0,
    hi: Ls[Math.min(n - 1, Math.floor(n * 0.9))] ?? 0,
    sd: Math.sqrt(Math.max(0, sumY2 / n - mY * mY)),
    edge: edge / Math.max(1, ne),
  };
}

/** share of the cells in `r` where `ink` falls under `target` contrast once `plate` covers `cover` of the picture */
export function badShare(p: Pick<FrameProbe, 'luma'>, r: Rect, inkL: number, plate: RGB, cover: number, target: number, edge = 0): number {
  const { x0, x1, y0, y1 } = cells(r);
  const pY = (0.2126 * plate[0] + 0.7152 * plate[1] + 0.0722 * plate[2]) / 255;
  // busy pictures need more contrast to read; backings calm them down
  const need = target * (1 + Math.min(1.2, edge * (1 - cover) * 9));
  let bad = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = p.luma[y * PROBE_W + x] * (1 - cover) + pY * cover;
      if (ratio(inkL, lin(v)) < need) bad++;
      n++;
    }
  }
  return bad / Math.max(1, n);
}

export const NEAR_WHITE: RGB = [248, 245, 238];
export const NEAR_BLACK: RGB = [16, 15, 13];
export const PAPER: RGB = [242, 237, 224];

export interface Verdict {
  ink: RGB;
  plate: RGB;
  backing: Backing;
  /** index in the ladder used (paper counts as the top) */
  level: number;
  /** share of the box that still misses the target */
  bad: number;
}

/** the plate that goes behind an ink: the scene's background when it contrasts enough, else near-black / paper */
export function plateFor(ink: RGB, pal: Palette): RGB {
  const bg = hexRGB(pal.bg);
  const light = lumOf(ink) > 0.4;
  const bl = lumOf(bg);
  if (light) return bl < 0.06 ? bg : NEAR_BLACK;
  return bl > 0.6 ? bg : PAPER;
}

export interface JudgeOpts {
  /** inks to try, preferred first (the look's own ink before the neutral ones) */
  inks: RGB[];
  /** contrast ratio to clear: 4.5 for small text, 3 for big */
  target: number;
  /** backings allowed, lightest first */
  ladder: Backing[];
  pal: Palette;
  /** share of the box allowed to miss (default 6%) */
  slack?: number;
}

/** the lightest backing + ink that keeps text in box `r` readable */
export function judge(p: FrameProbe, r: Rect, o: JudgeOpts): Verdict {
  const st = regionStats(p, r);
  const slack = o.slack ?? 0.06;
  let best: Verdict | null = null;
  for (let li = 0; li < o.ladder.length; li++) {
    const backing = o.ladder[li];
    for (const ink of o.inks) {
      const plate = backing === 'paper' ? PAPER : plateFor(ink, o.pal);
      if (backing === 'paper' && lumOf(ink) > 0.4) continue;
      const bad = badShare(p, r, lumOf(ink), plate, COVER[backing], o.target, st.edge);
      const v: Verdict = { ink, plate, backing, level: backing === 'paper' ? LADDER.length : LADDER.indexOf(backing), bad };
      if (bad <= slack) return v;
      if (!best || bad < best.bad - 0.02) best = v;
    }
  }
  return best ?? { ink: NEAR_WHITE, plate: NEAR_BLACK, backing: 'band', level: 3, bad: 1 };
}

/** inks to try for a palette: the look's own text colour, then whichever neutral sits opposite the picture */
export function inksFor(pal: Palette, st?: RegionStats): RGB[] {
  const fg = hexRGB(pal.fg);
  const neutrals: RGB[] = !st || st.mean < 0.25 ? [NEAR_WHITE, NEAR_BLACK] : [NEAR_BLACK, NEAR_WHITE];
  return [fg, ...neutrals];
}

/* ───────────────────────── smoothing ───────────────────────── */

/** how strongly each backing shows right now (0..1); the layer draws all of them blended */
export interface BackingMix {
  shadow: number;
  soft: number;
  band: number;
  paper: number;
}

const TARGET_MIX: Record<Backing, BackingMix> = {
  none: { shadow: 0.25, soft: 0, band: 0, paper: 0 },
  shadow: { shadow: 1, soft: 0, band: 0, paper: 0 },
  soft: { shadow: 0.55, soft: 1, band: 0, paper: 0 },
  band: { shadow: 0.35, soft: 0, band: 1, paper: 0 },
  paper: { shadow: 0, soft: 0, band: 0, paper: 1 },
};

const mixRGB = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/**
 * Eases toward the latest verdict: stronger backings come in fast (≈0.15 s), lighter ones only after
 * the picture has stayed calmer for a while and then slowly, and the ink flips (light ↔ dark) only
 * when the other ink has won for a moment, crossfading under a raised backing. Nothing snaps.
 */
export class Guard {
  ink: RGB = [...NEAR_WHITE];
  plate: RGB = [...NEAR_BLACK];
  mix: BackingMix = { shadow: 0.25, soft: 0, band: 0, paper: 0 };
  level = 0;
  backing: Backing = 'none';
  private want: Verdict | null = null;
  private wantSince = 0;
  private inkFlipSince = -1;
  private fresh = true;
  /** until when a cut just happened (ink may change fast: the picture itself just changed) */
  private joltUntil = 0;

  /** the look under the text just changed (a cut): let the ink and backing follow quickly */
  jolt(now: number) {
    this.joltUntil = now + 0.7;
  }

  /** jump straight to a verdict (a new line, nothing on screen yet) */
  reset(v: Verdict) {
    this.ink = [...v.ink];
    this.plate = [...v.plate];
    this.mix = { ...TARGET_MIX[v.backing] };
    this.level = v.level;
    this.backing = v.backing;
    this.want = v;
    this.fresh = false;
  }

  /** feed a new verdict (time in seconds) */
  propose(v: Verdict, now: number) {
    if (this.fresh) return this.reset(v);
    if (!this.want || this.want.backing !== v.backing || lumOf(this.want.ink) > 0.4 !== lumOf(v.ink) > 0.4) this.wantSince = now;
    this.want = v;
    const up = v.level > this.level;
    const held = now - this.wantSince;
    if (up || (v.level < this.level && held > (now < this.joltUntil ? 0.2 : 0.9))) {
      this.level = v.level;
      this.backing = v.backing;
    }
    const flip = lumOf(v.ink) > 0.4 !== lumOf(this.ink) > 0.4;
    if (flip) {
      if (this.inkFlipSince < 0) this.inkFlipSince = now;
    } else this.inkFlipSince = -1;
  }

  /** advance the easing by dt seconds */
  step(dt: number, now: number) {
    if (!this.want) return;
    const tgt = TARGET_MIX[this.backing];
    for (const k of Object.keys(tgt) as (keyof BackingMix)[]) {
      const d = tgt[k] - this.mix[k];
      const rate = d > 0 ? (now < this.joltUntil ? 12 : 7) : now < this.joltUntil ? 4 : 1.6;
      this.mix[k] += d * Math.min(1, dt * rate);
    }
    const flipping = this.inkFlipSince >= 0;
    const jolted = now < this.joltUntil;
    const flipReady = flipping && now - this.inkFlipSince > (jolted ? 0.08 : 0.45);
    if (!flipping || flipReady) {
      const k = Math.min(1, dt * (jolted ? 14 : flipReady ? 4 : 6));
      this.ink = mixRGB(this.ink, this.want.ink, k);
      this.plate = mixRGB(this.plate, this.want.plate, k);
    }
    // while the ink crosses mid-grey, hold a soft plate under it so the swap itself stays readable
    if (flipReady) this.mix.soft = Math.max(this.mix.soft, 0.7);
  }

  /** a key that changes when the drawn result would visibly change */
  key() {
    const q = (v: number) => Math.round(v * 24);
    return `${q(this.mix.shadow)}${q(this.mix.soft)}${q(this.mix.band)}${q(this.mix.paper)}|${this.ink.map((c) => c >> 3).join(',')}|${this.plate.map((c) => c >> 3).join(',')}`;
  }
}

/* ───────────────────────── drawing the backings ───────────────────────── */

/** draw the plates/bands behind text rows (pixel boxes); shadows are applied by the caller per glyph */
export function drawBacking(g: CanvasRenderingContext2D, rows: { x: number; y: number; w: number; h: number }[], gd: Guard, size: number, W: number, alpha: number, seed = 1) {
  if (!rows.length || alpha <= 0.01) return;
  const m = gd.mix;
  g.save();
  if (m.soft > 0.02) {
    // a soft scrim: the picture darkens (or lightens) behind the block with no edge to see. Drawn as
    // the blurred shadow of a box parked off-canvas, so only the feathered shadow lands here.
    const x0 = Math.min(...rows.map((r) => r.x)) - size * 0.6;
    const y0 = Math.min(...rows.map((r) => r.y)) - size * 0.45;
    const x1 = Math.max(...rows.map((r) => r.x + r.w)) + size * 0.6;
    const y1 = Math.max(...rows.map((r) => r.y + r.h)) + size * 0.45;
    const off = W * 4;
    g.shadowColor = css(gd.plate, 0.66 * m.soft * alpha);
    g.shadowBlur = size * 1.1;
    g.shadowOffsetX = off;
    g.fillStyle = '#000';
    g.fillRect(x0 - off, y0, x1 - x0, y1 - y0);
    g.shadowBlur = 0;
    g.shadowOffsetX = 0;
    g.shadowColor = 'transparent';
  }
  if (m.band > 0.02) {
    // a full-width scrim: a gradient across the frame, solid behind the rows, fading out above and below
    const top = Math.min(...rows.map((r) => r.y)) - size * 0.4;
    const bot = Math.max(...rows.map((r) => r.y + r.h)) + size * 0.4;
    const fe = size * 1.6;
    const a = 0.86 * m.band * alpha;
    const grd = g.createLinearGradient(0, top - fe, 0, bot + fe);
    const span = bot - top + fe * 2;
    grd.addColorStop(0, css(gd.plate, 0));
    grd.addColorStop(fe / span, css(gd.plate, a));
    grd.addColorStop(1 - fe / span, css(gd.plate, a));
    grd.addColorStop(1, css(gd.plate, 0));
    g.fillStyle = grd;
    g.fillRect(0, top - fe, W, span);
  }
  if (m.paper > 0.02) {
    // a torn strip of paper per row, a little crooked
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      const px = size * 0.5;
      const py = size * 0.26;
      const rnd = (j: number) => {
        const s = Math.sin((seed * 97 + k * 31 + j * 17) * 12.9898) * 43758.5453;
        return s - Math.floor(s);
      };
      g.save();
      g.translate(r.x + r.w / 2, r.y + r.h / 2);
      g.rotate((rnd(0) - 0.5) * 0.05);
      const w = r.w + px * 2;
      const h = r.h + py * 2;
      g.beginPath();
      const steps = Math.max(6, Math.round(w / (size * 0.5)));
      for (let i = 0; i <= steps; i++) g.lineTo(-w / 2 + (w * i) / steps, -h / 2 + (rnd(i + 1) - 0.5) * size * 0.12);
      for (let i = steps; i >= 0; i--) g.lineTo(-w / 2 + (w * i) / steps, h / 2 + (rnd(i + 40) - 0.5) * size * 0.12);
      g.closePath();
      g.shadowColor = `rgba(0,0,0,${(0.3 * m.paper * alpha).toFixed(3)})`;
      g.shadowBlur = size * 0.3;
      g.shadowOffsetY = size * 0.08;
      g.fillStyle = css(PAPER, m.paper * alpha);
      g.fill();
      g.restore();
    }
  }
  g.restore();
}

/** soft shadow for glyphs in the plate colour (call before fillText) */
export function applyShadow(g: CanvasRenderingContext2D, gd: Guard, size: number, alpha: number) {
  const a = Math.min(1, gd.mix.shadow) * alpha;
  if (a < 0.02) {
    g.shadowBlur = 0;
    g.shadowColor = 'transparent';
    return;
  }
  // wide and low rather than a tight dark halo round each letter
  g.shadowColor = css(gd.plate, 0.8 * a);
  g.shadowBlur = size * 0.5;
}

/** a colour that reads on the plate/picture: the accent when it clears `target`, else the ink */
export function accentOr(accent: RGB, ink: RGB, bgL: number, target = 3): RGB {
  return ratio(lumOf(accent), bgL) >= target ? accent : ink;
}

/** effective background luminance under the text, once the guard's backing covers it */
export function coveredL(st: RegionStats, gd: Guard): number {
  const c = Math.max(gd.mix.soft * COVER.soft, gd.mix.band * COVER.band, gd.mix.paper);
  const pl = lumOf(gd.plate);
  return st.mean * (1 - c) + pl * c;
}
