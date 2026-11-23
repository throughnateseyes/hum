/**
 * What every footage style is built on (the styles themselves are in src/shot/styles).
 *
 * A style draws one shot's graphics: a few flat shapes and lines of type, pinned to the frame and
 * placed on its grid (grid.ts). It can also cut windows: shapes drawn into a mask, where the footage
 * shows with a different treatment (or a different crop) from the rest of the frame. Each frame the
 * style places everything from song time alone and fills in the Bed: how the footage is drawn in
 * each of the three regions (the frame, mask red, mask green).
 *
 * The motion every style shares (timing.ts below): graphics arrive within 0.2 s of the shot starting,
 * hold, move once on a bar line with a quick eased slide, and hold again; a shot that speeds up into
 * its cut hands over with one move in its last beat.
 */
import * as THREE from 'three';
import type { Grid } from './grid';
import type { Scheme } from './palette';
import { clamp01, easeInExpo, easeOutExpo, smooth } from './time';

export const FOV = 35;
/** the camera's distance from the plane in focus */
export const CAM_Z = 6;

/** half the height and width of the picture on the plane in focus, in world units */
export function frameSize(aspect: number): { halfW: number; halfH: number } {
  const halfH = CAM_Z * Math.tan(((FOV / 2) * Math.PI) / 180);
  return { halfW: halfH * aspect, halfH };
}

/** how the footage is drawn in a region (see the shader in footage.ts) */
export const TONE = {
  /** the clip as it is */
  clean: 0,
  /** a smooth print from ink to paper */
  mono: 1,
  /** a smooth print from ink to the accent */
  duo: 2,
  /** three flat bands: ink, a mid tone, paper */
  flat: 3,
  paper: 4,
  ink: 5,
  accent: 6,
  /** two flat bands: ink and paper */
  print: 7,
} as const;

/** what the look's Colour setting asks of the footage */
export type Colour = 'clean' | 'tinted' | 'flat';
export const toneOf = (c: Colour): number => (c === 'flat' ? TONE.flat : c === 'tinted' ? TONE.mono : TONE.clean);

/** how the footage is drawn this frame, region by region: 0 the frame, 1 mask red, 2 mask green */
export interface Bed {
  tone: number[];
  /** each region's box in the frame (0..1 from the bottom-left): x, y, width, height */
  rect: THREE.Vector4[];
  /** push-in on top of the crop (1 = none) */
  zoom: number[];
}

export interface Labels {
  /** the song's title */
  title: string;
  /** the part, e.g. CHORUS */
  part: string;
  /** where the part starts in the song, e.g. 0:32 */
  time: string;
  /** e.g. 120 BPM */
  tempo: string;
}

export interface StyleContext {
  halfW: number;
  halfH: number;
  /** picture size in px */
  width: number;
  height: number;
  grid: Grid;
  scheme: Scheme;
  /** seconds per felt beat */
  beat: number;
  /** the shot's stretch of the song (s) */
  start: number;
  end: number;
  /** where the part this shot belongs to starts (bar numbers count from there) */
  partStart: number;
  /** a whole number for this shot's arrangement: the seed and the shot, so rules can pick from lists */
  layout: number;
  /** dice for anything finer; the same every run */
  rnd(): number;
  /** the words to set (the song's title, one word each), and this shot's own */
  words: string[];
  word: string;
  labels: Labels;
  /** the tone the look's Colour setting asks for */
  tone: number;
  colour: Colour;
  /** how loud the part is, 0..1 */
  energy: number;
  /** how the shot arrives and leaves (see Shot in sequence.ts), and the frames it holds still on a hit (s) */
  arrive: 'hit' | 'cold';
  leave: 'ramp' | 'settle' | 'cut';
  freeze: number;
}

export interface StyleFrame {
  /** song time (s) */
  t: number;
  /** the focus point (0..1 from the bottom-left of the frame) */
  focusU: number;
  focusV: number;
}

export interface StyleShot {
  /** drawn over the footage */
  object: THREE.Object3D;
  /** drawn into the mask (MASK_A red, MASK_B green), or null when the style cuts no windows */
  mask: THREE.Object3D | null;
  /** place everything for this frame, and say how the footage is drawn under it */
  update(f: StyleFrame, bed: Bed): void;
  dispose(): void;
}

export type StyleFactory = (ctx: StyleContext) => StyleShot;

/* ───────── timing ───────── */

/** seconds the graphics take to arrive */
export const IN = 0.2;
/** seconds a move on a bar line takes */
export const MOVE = 0.3;

export const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/** 0 → 1 as the graphics arrive: within IN seconds of the shot starting (after a hit's frozen frames) */
export const arrival = (ctx: StyleContext, t: number, delay = 0) => easeOutExpo(clamp01((t - ctx.start - ctx.freeze - delay) / IN));

/**
 * The moves on bar lines inside a shot: how many bar lines t has passed (n), and how far through the
 * slide after the latest one (e, eased, 1 when still). No move starts in the last beat before a cut.
 */
export function barStep(ctx: StyleContext, t: number, beats = 4): { n: number; e: number } {
  const len = beats * ctx.beat;
  const last = Math.floor((ctx.end - ctx.beat * 0.9 - ctx.start) / len);
  const n = Math.max(0, Math.min(last, Math.floor((t - ctx.start) / len)));
  if (n === 0) return { n: 0, e: 1 };
  return { n, e: easeInOutCubic(clamp01((t - ctx.start - n * len) / MOVE)) };
}

/** whole beats since the shot started (0 on its first beat) */
export const beatIndex = (ctx: StyleContext, t: number) => Math.max(0, Math.floor((t - ctx.start + 0.001) / ctx.beat));

/** 0 → 1 over the shot's last beat (at most half a second) when it speeds up into its cut */
export function handOver(ctx: StyleContext, t: number): number {
  if (ctx.leave !== 'ramp') return 0;
  const len = Math.min(ctx.beat, 0.5);
  return easeInExpo(clamp01((t - (ctx.end - len)) / len));
}

/** 0 → 1 over the last two beats of the song's last shot, as its graphics leave */
export const settling = (ctx: StyleContext, t: number) => (ctx.leave === 'settle' ? smooth(ctx.end - ctx.beat * 2.2, ctx.end - ctx.beat * 0.6, t) : 0);

export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/* ───────── flat shapes ───────── */

const PLANE = new THREE.PlaneGeometry(1, 1);
const DISC = new THREE.CircleGeometry(0.5, 160);

/** the colours shapes are drawn in, in the mask */
export const MASK_A = '#ff0000';
export const MASK_B = '#00ff00';

/** one flat rectangle or disc, pinned to the frame */
export class Flat {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor(parent: THREE.Object3D, color: THREE.ColorRepresentation, shape: 'rect' | 'disc' = 'rect', order = 3) {
    this.mat = new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(shape === 'disc' ? DISC : PLANE, this.mat);
    this.mesh.renderOrder = order;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** a rectangle between two corners (any order) */
  rect(xa: number, ya: number, xb: number, yb: number) {
    const w = Math.abs(xb - xa);
    const h = Math.abs(yb - ya);
    this.mesh.visible = w > 1e-4 && h > 1e-4;
    this.mesh.position.set((xa + xb) / 2, (ya + yb) / 2, 0);
    this.mesh.scale.set(Math.max(w, 1e-4), Math.max(h, 1e-4), 1);
  }

  disc(x: number, y: number, r: number) {
    this.mesh.visible = r > 1e-4;
    this.mesh.position.set(x, y, 0);
    this.mesh.scale.set(Math.max(2 * r, 1e-4), Math.max(2 * r, 1e-4), 1);
  }

  color(c: THREE.ColorRepresentation) {
    this.mat.color.set(c);
  }

  hide() {
    this.mesh.visible = false;
  }

  dispose() {
    this.mat.dispose();
  }
}

/** frees every material under `group` (geometries here are shared and kept) */
export function disposeGroup(group: THREE.Object3D) {
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m) for (const mat of Array.isArray(m) ? m : [m]) mat.dispose();
  });
}

/** world units on the plane in focus → 0..1 across the frame */
export const toU = (g: Grid, x: number) => (x + g.halfW) / (2 * g.halfW);
export const toV = (g: Grid, y: number) => (y + g.halfH) / (2 * g.halfH);
