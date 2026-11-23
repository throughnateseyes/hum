/**
 * What every treatment shares: the frame it is handed, the GLSL it is written with, and the small
 * strict palette the ones that recolour the picture (Cells, Readout) draw in.
 *
 * A treatment reads the bed: the frame as the style printed it, with alpha saying where the picture
 * shows (1) and where the style laid a flat field (0). It breaks down the picture and leaves the
 * fields as they are, so the style's shapes still read; the style's type is drawn over it afterwards.
 */
import * as THREE from 'three';
import { hexToLch, lchToHex } from '../../core/songPalette';
import type { Colour, Labels } from '../kit';
import type { Scheme, ShotPalette } from '../palette';

export interface TreatFrame {
  /** song time, and seconds since the shot started */
  t: number;
  tau: number;
  /** seconds per felt beat */
  beat: number;
  shotStart: number;
  shotEnd: number;
  /** where the part starts (bars count from there) */
  partStart: number;
  /** the shot's arrangement number: every rule that needs a choice takes it from here */
  layout: number;
  kicks: number[];
  snares: number[];
  hats: number[];
  /** how loud the song is at t, 0..1 */
  loud: number;
  scheme: Scheme;
  palette: ShotPalette;
  colour: Colour;
  /** white-out to the paper, 0..1 (a hit) */
  flash: number;
  labels: Labels;
  /** the focus point, 0..1 from the bottom-left */
  focus: { x: number; y: number };
  /** the shot's speed (1 real time) at t */
  speed: number;
}

/** whole hits at or before t in a sorted list, and seconds since the latest (large when none) */
export function hitsBefore(times: number[], t: number, from = -1e9): { n: number; since: number } {
  let n = 0;
  let last = -1;
  for (let i = 0; i < times.length && times[i] <= t; i++) {
    if (times[i] < from) continue;
    n++;
    last = times[i];
  }
  return { n, since: last < 0 ? 99 : t - last };
}

/** a whole number from a few, mixed so neighbouring inputs give unrelated outputs */
export function mix32(...xs: number[]): number {
  let h = 2166136261 >>> 0;
  for (const x of xs) {
    h = Math.imul(h ^ (Math.floor(x) >>> 0), 16777619) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  }
  return (h ^ (h >>> 16)) >>> 0;
}
export const unit = (...xs: number[]) => mix32(...xs) / 4294967296;

export const clock = (t: number, tenths = false) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${tenths ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0')}`;
};

/** the song's bar at t, counted from 1 at the part's start */
export const barOf = (f: TreatFrame, t = f.t) => Math.floor((t - f.partStart) / (f.beat * 4) + 1e-4) + 1;

/* ───────── the strict palette ───────── */

export interface Strict {
  /** the dark field */
  field: THREE.Color;
  /** light grey and white, for the body of the picture */
  grey: THREE.Color;
  white: THREE.Color;
  /** up to three flat colours (flat colour uses only `a`) */
  a: THREE.Color;
  b: THREE.Color;
  c: THREE.Color;
  /** how many of a, b, c are in use */
  hues: number;
}

const strictCache = new Map<string, Strict>();
const vivid = (h: number, l: number, c: number) => new THREE.Color(lchToHex({ l, c, h: ((h % 360) + 360) % 360 }));

/**
 * Four or five flat colours for a shot. Clean: taken from the picture's own two strongest hues, made
 * vivid. Tinted: the shot's scheme (its accent and second). Flat: grey, white and the accent only.
 */
export function strictFor(scheme: Scheme, palette: ShotPalette, colour: Colour): Strict {
  const key = `${scheme.name}|${palette.flats.join(',')}|${colour}`;
  const had = strictCache.get(key);
  if (had) return had;
  const field = new THREE.Color('#0b0b0d');
  let out: Strict;
  if (colour === 'clean') {
    const h1 = hexToLch(palette.flats[0]).h;
    const h2 = hexToLch(palette.flats[1]).h;
    out = { field, grey: new THREE.Color('#a3a3a6'), white: new THREE.Color('#f2f2f0'), a: vivid(h1, 0.82, 0.19), b: vivid(h2, 0.62, 0.24), c: vivid(h1 + 140, 0.74, 0.2), hues: 3 };
  } else {
    const ink = hexToLch(scheme.ink);
    const a = new THREE.Color(scheme.accent);
    const b = new THREE.Color(scheme.second);
    const c = vivid(hexToLch(scheme.accent).h + 150, 0.75, 0.19);
    out = { field: vivid(ink.h, 0.1, 0.02), grey: new THREE.Color(scheme.mid).lerp(new THREE.Color('#a6a6a6'), 0.6), white: new THREE.Color(scheme.paper), a, b, c, hues: colour === 'flat' ? 1 : 3 };
  }
  strictCache.set(key, out);
  return out;
}

/* ───────── GLSL ───────── */

export const HEAD_GLSL = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tBed;
uniform vec2 uRes;
uniform float uFlash;
uniform vec3 uPaper;
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float hash1(float x) { return hash(vec2(x, x * 0.7123 + 1.13)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec4 bed(vec2 uv) { return texture2D(tBed, uv); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

/** the end of every treatment: the fields the style laid stay as they were, then the white-out */
export const TAIL_GLSL = /* glsl */ `
vec4 finish(vec3 treated, vec4 b) {
  return vec4(mix(mix(b.rgb, treated, b.a), uPaper, uFlash), 1.0);
}
`;

export function headUniforms() {
  return {
    tBed: { value: null as THREE.Texture | null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uFlash: { value: 0 },
    uPaper: { value: new THREE.Color('#ffffff') },
  };
}

export function makeMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

/** one full-frame quad per material, drawn with an orthographic camera */
export class Quad {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: THREE.Mesh;
  constructor() {
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  draw(renderer: THREE.WebGLRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget | null) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }
  dispose() {
    this.mesh.geometry.dispose();
  }
}
