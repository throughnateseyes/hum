import * as THREE from 'three';
import { notePlate } from './lyricSpace';
import type { Palette } from '../core/types';

/**
 * Legibility guard for lyrics.
 *
 * Every other frame the finished picture is shrunk into a tiny 96×54 buffer and read back: everything
 * the words will sit on, scene windows and pop-ups included (only the lyrics themselves come after).
 * From that we know, for any box on screen, how bright the picture is there, how much it varies and
 * how busy (edgy) it is. `judge` then picks the lightest backing (none, a soft shadow, a keyline,
 * a halo, a full-width scrim, a paper strip) and the ink that clears a contrast target against
 * the pixels actually under the text, and `Guard` eases between its choices so nothing flickers when
 * the scene changes under a line.
 *
 * The keyline (`soft`) is drawn as a title designer would: a thin line round each letter in the plate's colour
 * and a tight glow of it, hugging the words, so a line that crosses from black to white keeps its edge
 * on both and nothing behind it turns grey.
 *
 * The halo is the designed answer for words that sit over a pop-up window or a very busy picture: a
 * fuzzy, feathered cloud in a palette colour that inverts against the ink, hugging the words (not a
 * box), so an overlap reads as meant rather than as letters lost behind a window.
 */

export type RGB = [number, number, number];
export type Backing = 'none' | 'shadow' | 'soft' | 'halo' | 'band' | 'paper';
/** normalized box, y from the top */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const LADDER: Backing[] = ['none', 'shadow', 'soft', 'band'];
/** how much of the picture under the text each backing covers (in sRGB space, like canvas blending) */
export const COVER: Record<Backing, number> = { none: 0, shadow: 0.2, soft: 0.8, halo: 0.84, band: 0.86, paper: 1 };
/** how heavy each backing is (a verdict only steps down to a lighter one after the picture has stayed calm) */
const LEVEL: Record<Backing, number> = { none: 0, shadow: 1, soft: 2, halo: 2.5, band: 3, paper: 4 };

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
  private readonly lumas = new Float32Array(PROBE_W * PROBE_H);
  private readonly Ls = new Float32Array(PROBE_W * PROBE_H);
  /** bumps every time a new frame has been read (or, where reading waits for the GPU, can be) */
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
  /** a frame being read back is from before a cut: drop it when it comes in */
  private stale = false;
  /** read back without waiting a frame where the browser allows it (off in the dev harness: it steps faster than real time) */
  readAsync = true;

  /**
   * Where reading back means waiting for the GPU to draw everything it was given (a render), it isn't read
   * until the words ask about it: a frame with no words on it doesn't wait.
   */
  private unread: THREE.WebGLRenderer | null = null;

  get luma() {
    if (this.unread) this.pull();
    return this.lumas;
  }

  get L() {
    if (this.unread) this.pull();
    return this.Ls;
  }

  private pull() {
    const r = this.unread!;
    this.unread = null;
    r.readRenderTargetPixels(this.rt, 0, 0, PROBE_W, PROBE_H, this.buf);
    this.ingest();
  }

  /** shrink `tex` into the probe every `every` frames and read it back (asynchronously where possible) */
  sample(r: THREE.WebGLRenderer, tex: THREE.Texture, blit: (t: THREE.Texture, target: THREE.WebGLRenderTarget | null) => void, every = 2) {
    if (this.busy || this.n++ % every) return;
    blit(tex, this.rt);
    this.readBack(r);
  }

  /**
   * The same from what is on the screen right now (the canvas' drawing buffer, w×h): one scaled
   * framebuffer blit straight into the probe, so reading the frame with its windows and pop-ups on
   * costs no more than reading a texture did.
   */
  sampleScreen(r: THREE.WebGLRenderer, w: number, h: number, every = 2) {
    if (this.busy || this.n++ % every) return;
    const gl = r.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) return;
    r.setRenderTarget(this.rt);
    const fb = (r.properties.get(this.rt) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer;
    if (!fb) return;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, PROBE_W, PROBE_H, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    // three believes the probe's target is bound (setRenderTarget above): make that true for reads too
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    this.readBack(r);
  }

  /** the picture just changed at once (a cut): read the next frame, and drop any still coming from before it */
  refresh() {
    this.n = 0;
    this.stale = this.busy;
    this.unread = null;
  }

  private readBack(r: THREE.WebGLRenderer) {
    const ar = r as THREE.WebGLRenderer & { readRenderTargetPixelsAsync?: (...a: unknown[]) => Promise<unknown> };
    if (this.readAsync && ar.readRenderTargetPixelsAsync) {
      this.busy = true;
      ar.readRenderTargetPixelsAsync(this.rt, 0, 0, PROBE_W, PROBE_H, this.buf)
        .then(() => {
          if (this.stale) return;
          this.ingest();
          this.version++;
        })
        .catch(() => {
          this.readAsync = false;
        })
        .finally(() => {
          this.busy = false;
          this.stale = false;
        });
    } else {
      this.unread = r;
      this.version++;
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
        this.lumas[i] = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        this.Ls[i] = 0.2126 * lin(R) + 0.7152 * lin(G) + 0.0722 * lin(B);
      }
    }
  }

  dispose() {
    this.unread = null;
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
  const { luma, L } = p;
  const Ls: number[] = [];
  let sum = 0;
  let sumY = 0;
  let sumY2 = 0;
  let edge = 0;
  let ne = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * PROBE_W + x;
      const v = luma[i];
      Ls.push(L[i]);
      sum += L[i];
      sumY += v;
      sumY2 += v * v;
      if (x + 1 < x1) {
        edge += Math.abs(v - luma[i + 1]);
        ne++;
      }
      if (y + 1 < y1) {
        edge += Math.abs(v - luma[i + PROBE_W]);
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

/** share of the cells in `r` where `ink` (drawn at `alpha`) falls under `target` contrast once `plate` covers `cover` of the picture */
export function badShare(p: Pick<FrameProbe, 'luma'>, r: Rect, inkL: number, plate: RGB, cover: number, target: number, edge = 0, alpha = 1): number {
  const { x0, x1, y0, y1 } = cells(r);
  const { luma } = p;
  const pY = (0.2126 * plate[0] + 0.7152 * plate[1] + 0.0722 * plate[2]) / 255;
  // busy pictures need more contrast to read; backings calm them down
  const need = target * (1 + Math.min(1.2, edge * (1 - cover) * 9));
  const inkY = alpha < 1 ? srgb(inkL) : 0;
  let bad = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = luma[y * PROBE_W + x] * (1 - cover) + pY * cover;
      const L = alpha < 1 ? lin(v * (1 - alpha) + inkY * alpha) : inkL;
      if (ratio(L, lin(v)) < need) bad++;
      n++;
    }
  }
  return bad / Math.max(1, n);
}

/**
 * Where the lyrics are, for pop-ups and scene windows to keep clear of (normalized boxes): the line on
 * screen now, and where the next one is likely to land when it's due within a couple of seconds.
 */
export interface KeepOut {
  now: Rect | null;
  next: Rect | null;
}
export const NO_KEEP_OUT: KeepOut = { now: null, next: null };

/** share of box `r` that the boxes in `over` cover (overlaps between them counted once, on a coarse grid) */
export function coveredShare(r: Rect, over: readonly Rect[]): number {
  if (!over.length || r.x1 <= r.x0 || r.y1 <= r.y0) return 0;
  const N = 12;
  let hit = 0;
  for (let j = 0; j < N; j++) {
    const y = r.y0 + ((j + 0.5) / N) * (r.y1 - r.y0);
    for (let i = 0; i < N; i++) {
      const x = r.x0 + ((i + 0.5) / N) * (r.x1 - r.x0);
      if (over.some((o) => x >= o.x0 && x <= o.x1 && y >= o.y0 && y <= o.y1)) hit++;
    }
  }
  return hit / (N * N);
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
  /** how opaque words not sung yet may be drawn and still clear the target (0.5..1) */
  quiet: number;
  /** the darkest and lightest tenth of what is under the words once the backing covers it (relative luminance) */
  lo: number;
  hi: number;
  /** how busy the picture is there (RegionStats.edge) */
  edge: number;
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
  /** the ink on screen now: kept while it reads, rather than the words changing colour under the eye */
  hold?: RGB;
}

/** the lightest backing + ink that keeps text in box `r` readable */
export function judge(p: FrameProbe, r: Rect, o: JudgeOpts): Verdict {
  const st = regionStats(p, r);
  const slack = o.slack ?? 0.06;
  const held = (ink: RGB) => !!o.hold && lumOf(ink) > 0.4 === lumOf(o.hold) > 0.4;
  let best: Verdict | null = null;
  for (let li = 0; li < o.ladder.length; li++) {
    const backing = o.ladder[li];
    // of the inks that read with this backing, the one that leans on it least (the preferred one, unless
    // another is clearly better off on the bare picture)
    let pass: { v: Verdict; bare: number } | null = null;
    for (const ink of o.inks) {
      const plate = backing === 'paper' ? PAPER : backing === 'halo' ? haloFor(ink, o.pal, st, (c) => badShare(p, r, lumOf(ink), c, COVER.halo, o.target, st.edge), slack) : plateFor(ink, o.pal);
      if (backing === 'paper' && lumOf(ink) > 0.4) continue;
      const bad = badShare(p, r, lumOf(ink), plate, COVER[backing], o.target, st.edge);
      const v: Verdict = { ink, plate, backing, level: LEVEL[backing], bad, quiet: 1, lo: 0, hi: 1, edge: st.edge };
      if (bad <= slack) {
        const bare = backing === 'none' || backing === 'paper' ? 0 : badShare(p, r, lumOf(ink), plate, 0, o.target);
        // (an ink already on screen is left for another only when that is a lot better off)
        const less = !pass ? 0 : held(pass.v.ink) ? 0.28 : held(ink) ? -0.28 : 0.12;
        if (!pass || bare < pass.bare - less) pass = { v, bare };
      }
      if (!best || bad < best.bad - 0.02) best = v;
    }
    if (pass && o.hold && !held(pass.v.ink) && li + 1 < o.ladder.length && LEVEL[o.ladder[li + 1]] - LEVEL[backing] <= 1) {
      // the same ink with one step more behind it beats the words changing colour mid-line
      const stay = judge(p, r, { ...o, hold: undefined, inks: o.inks.filter(held), ladder: [o.ladder[li + 1]] });
      if (stay.bad <= slack) return stay;
    }
    if (pass) return ground(p, r, pass.v, st, o.target);
  }
  return ground(p, r, best ?? { ink: NEAR_WHITE, plate: NEAR_BLACK, backing: 'band', level: 3, bad: 1, quiet: 1, lo: 0, hi: 1, edge: st.edge }, st, o.target);
}

/** how faint the words not sung yet may be, faintest first */
const QUIET = [0.5, 0.58, 0.66, 0.74, 0.82, 0.9];

/** fill in what is under the words behind a verdict's backing, and how faint its unsung words may be */
function ground(p: Pick<FrameProbe, 'luma'>, r: Rect, v: Verdict, st: RegionStats, target: number): Verdict {
  const cover = COVER[v.backing];
  const at = (L: number) => lin(srgb(L) * (1 - cover) + srgb(lumOf(v.plate)) * cover);
  v.lo = Math.min(at(st.lo), at(st.hi));
  v.hi = Math.max(at(st.lo), at(st.hi));
  const inkL = lumOf(v.ink);
  for (const q of QUIET)
    if (badShare(p, r, inkL, v.plate, cover, target * 1.12, 0, q) <= Math.max(0.06, v.bad)) {
      v.quiet = q;
      break;
    }
  return v;
}

/** linear → sRGB 0..1 */
const srgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/**
 * A colour's nearest shade, hue kept, that clears `target` against everything from luminance `lo` to
 * `hi` (what lies under the words). `ok` is false when no shade does: the picture is both dark and
 * light there, so the words need something of their own behind them.
 */
export function inkOn(c: RGB, lo: number, hi: number, target: number): { ink: RGB; ok: boolean } {
  const clears = (x: RGB) => {
    const L = lumOf(x);
    return (L > hi && ratio(L, hi) >= target) || (L < lo && ratio(L, lo) >= target);
  };
  if (clears(c)) return { ink: c, ok: true };
  const up = ratio(1, hi) >= target * 1.04;
  const down = ratio(lo, 0) >= target * 1.04;
  // the end nearer to the colour first, when both are open
  const ends: RGB[] = lumOf(c) > (lo + hi) / 2 ? [[255, 255, 255], [0, 0, 0]] : [[0, 0, 0], [255, 255, 255]];
  for (const end of ends) {
    if (end[0] ? !up : !down) continue;
    for (let k = 0.08; k < 1.001; k += 0.08) {
      const x = mixRGB(c, end, k);
      if (clears(x)) return { ink: x, ok: true };
    }
  }
  return { ink: ratio(1, hi) > ratio(lo, 0) ? mixRGB(c, [255, 255, 255], 0.85) : mixRGB(c, [0, 0, 0], 0.85), ok: false };
}

const sat = (c: RGB) => (Math.max(...c) - Math.min(...c)) / 255;

/**
 * The halo's colour: a palette role (accent, accent2, muted, bg, fg, so it stays one of the hand-drawn
 * finish's inks) that inverts against the ink and stands apart from what's under the words. Each role
 * is tried over the real pixels under the words (`bad`: the share that would still miss the target
 * with that halo); coloured roles win over neutrals when they clear it. When none does, the best one
 * is pushed towards the dark or light end until it does.
 */
export function haloFor(ink: RGB, pal: Palette, st: RegionStats | undefined, bad: (plate: RGB) => number, slack = 0.06): RGB {
  const inkL = lumOf(ink);
  const under = st ? st.mean : 0.5;
  let best: { c: RGB; score: number; ok: boolean } | null = null;
  const roles: [string, number][] = [
    [pal.accent, 1],
    [pal.accent2, 0.8],
    [pal.muted, 0.2],
    [pal.bg, 0.3],
    [pal.fg, 0],
  ];
  for (const [hex, pref] of roles) {
    const c = hexRGB(hex);
    const L = lumOf(c);
    if (ratio(inkL, L) < 3) continue;
    const b = bad(c);
    // standing apart from the picture under it is what makes the halo read as a shape, not a smudge
    const apart = Math.min(1, Math.abs(Math.sqrt(L) - Math.sqrt(under)) * 2.2);
    const score = (b <= slack ? 10 : -b * 10) + pref + sat(c) * 1.5 + apart;
    if (!best || score > best.score) best = { c, score, ok: b <= slack };
  }
  if (best?.ok) return best.c;
  const from = best?.c ?? hexRGB(inkL > 0.4 ? pal.bg : pal.fg);
  const to = inkL > 0.4 ? NEAR_BLACK : PAPER;
  let c = from;
  for (let k = 0.15; k <= 1.001 && bad(c) > slack; k += 0.15) c = mixRGB(from, to, k);
  return c;
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
  halo: number;
  band: number;
  paper: number;
}

const TARGET_MIX: Record<Backing, BackingMix> = {
  none: { shadow: 0.25, soft: 0, halo: 0, band: 0, paper: 0 },
  shadow: { shadow: 1, soft: 0, halo: 0, band: 0, paper: 0 },
  soft: { shadow: 0.55, soft: 1, halo: 0, band: 0, paper: 0 },
  halo: { shadow: 0.3, soft: 0, halo: 1, band: 0, paper: 0 },
  band: { shadow: 0.35, soft: 0, halo: 0, band: 1, paper: 0 },
  paper: { shadow: 0, soft: 0, halo: 0, band: 0, paper: 1 },
};

function mixRGB(a: RGB, b: RGB, k: number): RGB {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}


/**
 * Eases toward the latest verdict: stronger backings come in fast (≈0.15 s), lighter ones only after
 * the picture has stayed calmer for a while and then slowly, and the ink flips (light ↔ dark) only
 * when the other ink has won for a moment, crossfading under a raised backing. Nothing snaps.
 */
export class Guard {
  ink: RGB = [...NEAR_WHITE];
  plate: RGB = [...NEAR_BLACK];
  mix: BackingMix = { shadow: 0.25, soft: 0, halo: 0, band: 0, paper: 0 };
  level = 0;
  backing: Backing = 'none';
  /** how opaque unsung words are drawn, and what is under the words (see Verdict), eased like the rest */
  quiet = 1;
  lo = 0;
  hi = 1;
  edge = 0;
  private want: Verdict | null = null;
  private wantSince = 0;
  private inkFlipSince = -1;
  private fresh = true;
  /** until when a cut just happened (ink may change fast: the picture itself just changed) */
  private joltUntil = 0;
  /** the next verdict is the first of a new picture: it is taken outright, so the words change with the cut */
  private cut = false;

  /** the ink that has been on screen over this picture, if any has (see JudgeOpts.hold) */
  get held(): RGB | undefined {
    return this.fresh || this.cut ? undefined : this.ink;
  }

  /** the look under the text just changed (a cut): let the ink and backing follow quickly */
  jolt(now: number) {
    this.joltUntil = now + 0.7;
  }

  /** the picture itself was cut under the words, and the next verdict will be of the new one */
  snap(now: number) {
    this.jolt(now);
    this.cut = true;
  }

  /** jump straight to a verdict (a new line, nothing on screen yet) */
  reset(v: Verdict) {
    this.ink = [...v.ink];
    this.plate = [...v.plate];
    this.mix = { ...TARGET_MIX[v.backing] };
    this.level = v.level;
    this.backing = v.backing;
    this.quiet = v.quiet;
    this.lo = v.lo;
    this.hi = v.hi;
    this.edge = v.edge;
    this.want = v;
    this.fresh = false;
    this.cut = false;
    this.inkFlipSince = -1;
  }

  /** feed a new verdict (time in seconds) */
  propose(v: Verdict, now: number) {
    if (this.fresh || this.cut) return this.reset(v);
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
    const near = Math.min(1, dt * (now < this.joltUntil ? 14 : 4));
    this.quiet += (this.want.quiet - this.quiet) * near;
    this.lo += (this.want.lo - this.lo) * near;
    this.hi += (this.want.hi - this.hi) * near;
    this.edge += (this.want.edge - this.edge) * near;
    const flipping = this.inkFlipSince >= 0;
    const jolted = now < this.joltUntil;
    const flipReady = flipping && now - this.inkFlipSince > (jolted ? 0.08 : 0.45);
    if (!flipping || flipReady) {
      // light to dark goes by way of mid-grey, where nothing reads: that crossing takes two or three frames
      const k = Math.min(1, dt * (flipReady || (jolted && flipping) ? 26 : jolted ? 14 : 6));
      this.ink = mixRGB(this.ink, this.want.ink, k);
      this.plate = mixRGB(this.plate, this.want.plate, k);
    }
    // while the ink crosses mid-grey, hold a soft plate under it so the swap itself stays readable
    if (flipReady) this.mix.soft = Math.max(this.mix.soft, 0.7);
  }

  /** a key that changes when the drawn result would visibly change */
  key() {
    const q = (v: number) => Math.round(v * 24);
    return `${q(this.mix.shadow)}${q(this.mix.soft)}${q(this.mix.halo)}${q(this.mix.band)}${q(this.mix.paper)}|${q(this.quiet)}.${q(this.lo)}.${q(this.hi)}|${this.ink.map((c) => c >> 3).join(',')}|${this.plate.map((c) => c >> 3).join(',')}`;
  }
}

/* ───────────────────────── drawing the backings ───────────────────────── */

/** draw the plates/bands behind text rows (pixel boxes); shadows and keylines are drawn by the caller per word */
export function drawBacking(g: CanvasRenderingContext2D, rows: { x: number; y: number; w: number; h: number }[], gd: Guard, size: number, W: number, alpha: number, seed = 1) {
  if (!rows.length || alpha <= 0.01) return;
  const m = gd.mix;
  g.save();
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
      notePlate(g, { x0: r.x + r.w / 2 - w / 2, y0: r.y + r.h / 2 - h / 2 + size * 0.06, x1: r.x + r.w / 2 + w / 2, y1: r.y + r.h / 2 + h / 2 - size * 0.06 }, size * 0.7, 'paper strip');
    }
  }
  g.restore();
}

/**
 * The halo: a fuzzy cloud in the guard's halo colour hugging the words that are up. `spans` are pixel
 * boxes (one per row, growing as words are sung). Each is drawn twice as the blurred shadow of a box
 * parked off-canvas, a dense body under the letters and a wide feather around it, so there's no
 * edge anywhere: it reads as glow, not as a plate. Two blurred fills per row, whatever the word count.
 */
export function drawHalo(g: CanvasRenderingContext2D, spans: { x: number; y: number; w: number; h: number }[], gd: Guard, size: number, W: number, alpha: number) {
  const k = gd.mix.halo * alpha;
  if (k < 0.02 || !spans.length) return;
  g.save();
  const off = W * 4;
  g.fillStyle = '#000';
  g.shadowOffsetX = off;
  for (const p of [
    { blur: 1.6, padX: 0.5, padY: 0.42, a: 0.55 },
    { blur: 0.6, padX: 0.2, padY: 0.06, a: 0.93 },
  ]) {
    g.shadowBlur = size * p.blur;
    g.shadowColor = css(gd.plate, p.a * k);
    for (const b of spans) {
      if (b.w <= 1) continue;
      g.fillRect(b.x - size * p.padX - off, b.y - size * p.padY, b.w + size * p.padX * 2, b.h + size * p.padY * 2);
    }
  }
  g.restore();
}

/**
 * A word's keyline: its outline in the plate's colour with a tight glow of the same round it, drawn
 * before the word. The outline holds the letters' edge whatever they cross; the glow keeps it from
 * reading as a sticker. Call with the word's font and spacing set.
 */
export function drawKeyline(g: CanvasRenderingContext2D, gd: Guard, text: string, x: number, y: number, size: number) {
  const k = Math.min(1, gd.mix.soft);
  if (k < 0.02) return;
  g.save();
  g.lineJoin = 'round';
  g.miterLimit = 2;
  g.globalAlpha *= k;
  g.strokeStyle = css(gd.plate);
  g.shadowColor = css(gd.plate, 0.9);
  g.shadowBlur = size * 0.34;
  g.lineWidth = Math.max(2.5, (size * KEYLINE) / (1 + size / 150));
  g.strokeText(text, x, y);
  // and inside the letters too, so a word drawn faint (not sung yet) is faint on the plate, not on the picture
  g.shadowColor = 'transparent';
  g.fillStyle = css(gd.plate);
  g.fillText(text, x, y);
  g.restore();
}
/** the keyline's width on small type, half of it outside the letter (em); huge letters take a thinner one */
const KEYLINE = 0.19;

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

/** how much of the picture the backing showing right now covers */
export function coverNow(gd: Guard): number {
  const m = gd.mix;
  return Math.max(m.shadow * COVER.shadow, m.soft * COVER.soft, m.halo * COVER.halo, m.band * COVER.band, m.paper);
}

/** effective background luminance under the text, once the guard's backing covers it */
export function coveredL(st: RegionStats, gd: Guard): number {
  const c = Math.max(gd.mix.soft * COVER.soft, gd.mix.halo * COVER.halo, gd.mix.band * COVER.band, gd.mix.paper);
  const pl = lumOf(gd.plate);
  return st.mean * (1 - c) + pl * c;
}
