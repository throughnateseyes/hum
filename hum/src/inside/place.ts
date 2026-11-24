/**
 * The place a clip shows, as numbers the pictures and the layout share: where its camera is at a clip
 * second, what is in front of a point, and how a point in the place lands in the frame.
 *
 *   crop    which part of the clip the frame shows (the clip covers the frame, round the focus point)
 *   lens()  the projection for one frame: the clip's own vanishing point, tilt and lens, then the way
 *           the background has slid since the shot began, then the crop. Anything drawn through it sits
 *           in the picture the way the things in it do
 */
import * as THREE from 'three';
import { EYE, type ClipScene, type Slide, type View } from '../depth/types';

export interface Crop {
  /** centre of what shows, and its size, in clip uv; a negative width is a mirrored picture */
  u: number;
  v: number;
  w: number;
  h: number;
}

export function cropOf(clipAspect: number, aspect: number, focus: { x: number; y: number }, zoom: number, flip: boolean): Crop {
  const wide = clipAspect > aspect;
  const w = (wide ? aspect / clipAspect : 1) / zoom;
  const h = (wide ? 1 : clipAspect / aspect) / zoom;
  const u = Math.min(1 - w / 2, Math.max(w / 2, focus.x));
  const v = Math.min(1 - h / 2, Math.max(h / 2, focus.y));
  return { u: flip ? 1 - u : u, v, w: flip ? -w : w, h };
}

/** where clip second t falls among the samples: two neighbours and how far between them */
export function at(s: ClipScene, t: number): { i: number; j: number; k: number } {
  const n = s.times.length;
  if (n < 2 || t <= s.times[0]) return { i: 0, j: 0, k: 0 };
  if (t >= s.times[n - 1]) return { i: n - 1, j: n - 1, k: 0 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (s.times[m] <= t) lo = m;
    else hi = m;
  }
  return { i: lo, j: hi, k: (t - s.times[lo]) / Math.max(1e-6, s.times[hi] - s.times[lo]) };
}

const mix = (a: number, b: number, k: number) => a + (b - a) * k;

export function viewAt(s: ClipScene, t: number): View {
  const { i, j, k } = at(s, t);
  const a = s.views[i] ?? { u: 0.5, v: 0.5, roll: 0 };
  const b = s.views[j] ?? a;
  return { u: mix(a.u, b.u, k), v: mix(a.v, b.v, k), roll: mix(a.roll, b.roll, k) };
}

export function slideAt(s: ClipScene, t: number): Slide {
  const { i, j, k } = at(s, t);
  const a = s.slides[i] ?? { x: 0, y: 0, scale: 1, turn: 0 };
  const b = s.slides[j] ?? a;
  return { x: mix(a.x, b.x, k), y: mix(a.y, b.y, k), scale: mix(a.scale, b.scale, k), turn: mix(a.turn, b.turn, k) };
}

export function aheadAt(s: ClipScene, t: number): number {
  const { i, j, k } = at(s, t);
  return mix(s.ahead[i] ?? 0, s.ahead[j] ?? s.ahead[i] ?? 0, k);
}

/** the map nearest clip second t that has been read, if one is close enough */
export function mapAt(s: ClipScene, t: number): Uint8Array | null {
  const { i, j, k } = at(s, t);
  const first = k < 0.5 ? i : j;
  for (let d = 0; d < 4; d++) {
    if (s.maps[first + d]) return s.maps[first + d];
    if (s.maps[first - d]) return s.maps[first - d];
  }
  return null;
}

/** a 2D similarity as [a, b, x, y]: (px, py) → (a px - b py + x, b px + a py + y) */
type Sim = [number, number, number, number];
const simOf = (s: Slide): Sim => [s.scale * Math.cos(s.turn), s.scale * Math.sin(s.turn), s.x, s.y];
const mul = (m: Sim, n: Sim): Sim => [m[0] * n[0] - m[1] * n[1], m[0] * n[1] + m[1] * n[0], m[0] * n[2] - m[1] * n[3] + m[2], m[1] * n[2] + m[0] * n[3] + m[3]];
const inv = (m: Sim): Sim => {
  const d = m[0] * m[0] + m[1] * m[1] || 1;
  const a = m[0] / d;
  const b = -m[1] / d;
  return [a, b, -(a * m[2] - b * m[3]), -(b * m[2] + a * m[3])];
};

export interface Lens {
  matrix: THREE.Matrix4;
  /** how far ahead of where the shot began the camera is */
  ahead: number;
  /** the vanishing point in the frame, 0..1 from the bottom-left */
  vp: { x: number; y: number };
}

/** the point the finish pushes the picture in about */
export const pushCentre = (l: Lens) => ({ x: Math.min(1.2, Math.max(-0.2, l.vp.x)), y: Math.min(1.2, Math.max(-0.2, l.vp.y)) });

const NO_VIEW: View = { u: 0.5, v: 0.5, roll: 0 };

/** does the place move past the camera (driving, walking ahead), rather than slide or shake? */
export const goesAhead = (s: ClipScene | null) => !!s && s.camera === 'ahead' && s.sure.ahead > 0.35;

/**
 * The projection for clip second `t` in a shot that began on second `from`. The camera is at height
 * EYE, at z = -ahead, looking down -z.
 */
export function lens(s: ClipScene | null, clipAspect: number, t: number, from: number, crop: Crop): Lens {
  const moving = goesAhead(s);
  const view = s ? viewAt(s, moving ? t : from) : NO_VIEW;
  const focal = s?.focal ?? 1.25;
  let sim: Sim = [1, 0, 0, 0];
  if (s && !moving && s.times.length > 1) sim = mul(simOf(slideAt(s, t)), inv(simOf(slideAt(s, from))));
  // picture (frame heights) → frame (-1..1)
  const kx = 2 / (clipAspect * crop.w);
  const ky = 2 / crop.h;
  const tx = (0.5 - crop.u) * (2 / crop.w);
  const ty = (0.5 - crop.v) * ky;
  const vx = (view.u - 0.5) * clipAspect;
  const vy = view.v - 0.5;
  const c = Math.cos(view.roll) * focal;
  const r = Math.sin(view.roll) * focal;
  // p = V + R(X, Y)/w, then q = sim p, then frame = k q + t. Rows are x_clip, y_clip (over w = -Z)
  const [a, b, sx, sy] = sim;
  const qx = [a * c - b * r, -a * r - b * c, a * vx - b * vy + sx];
  const qy = [b * c + a * r, -b * r + a * c, b * vx + a * vy + sy];
  const near = 0.15;
  const far = 1e6;
  const m = new THREE.Matrix4();
  // w = -Z, so a term in w is minus that term in Z
  m.set(kx * qx[0], kx * qx[1], -(kx * qx[2] + tx), 0, ky * qy[0], ky * qy[1], -(ky * qy[2] + ty), 0, 0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near), 0, 0, -1, 0);
  const fx = kx * (a * vx - b * vy + sx) + tx;
  const fy = ky * (b * vx + a * vy + sy) + ty;
  return { matrix: m, ahead: moving && s ? aheadAt(s, t) - aheadAt(s, from) : 0, vp: { x: fx * 0.5 + 0.5, y: fy * 0.5 + 0.5 } };
}

/** a world point in the frame (0..1 from the bottom-left) and how far ahead it is */
export function project(l: Lens, x: number, y: number, z: number): { x: number; y: number; w: number } {
  const e = l.matrix.elements;
  const Y = y - EYE;
  const Z = z + l.ahead;
  const w = -Z;
  return { x: ((e[0] * x + e[4] * Y + e[8] * Z) / w) * 0.5 + 0.5, y: ((e[1] * x + e[5] * Y + e[9] * Z) / w) * 0.5 + 0.5, w };
}

/** the world point at distance `w` that lands on frame point (fx, fy) */
export function unproject(l: Lens, fx: number, fy: number, w: number): { x: number; y: number; z: number } {
  const e = l.matrix.elements;
  const nx = (fx * 2 - 1) * w + e[8] * w;
  const ny = (fy * 2 - 1) * w + e[9] * w;
  const d = e[0] * e[5] - e[4] * e[1] || 1e-9;
  return { x: (nx * e[5] - e[4] * ny) / d, y: (e[0] * ny - e[1] * nx) / d + EYE, z: -w - l.ahead };
}

/** nearness of the picture at a frame point (0 when unknown) */
export function nearnessAt(s: ClipScene, map: Uint8Array, crop: Crop, fx: number, fy: number): number {
  const u = crop.u + (fx - 0.5) * crop.w;
  const v = crop.v + (fy - 0.5) * crop.h;
  const x = Math.min(s.width - 1, Math.max(0, Math.floor(u * s.width)));
  const y = Math.min(s.height - 1, Math.max(0, Math.floor(v * s.height)));
  const b = map[y * s.width + x] / 255;
  return b * b;
}

/** is something in the picture in front of a point `w` away? (the shader's own rule, see shaders.ts) */
export const hides = (s: ClipScene, n: number, w: number) => n > s.zScale / w + Math.max(0.0025, (0.06 * s.zScale) / w);
