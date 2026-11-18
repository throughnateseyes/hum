/**
 * Shared helpers for the 3D form scenes (src/scenes/three/*).
 */
import * as THREE from 'three';
import { GLSL_COMMON, GLSL_HEADER, paramUniformDecls } from '../../core/glsl';
import { createBaseUniforms, updateBaseUniforms, updateParamUniforms, type UniformMap } from '../../core/uniforms';
import type { FrameContext, ParamDef, ResolvedPalette, SharedResources } from '../../core/types';

/** Header + param uniforms + common library, usable in BOTH vertex and fragment shaders. */
export function prelude(params: ParamDef[]) {
  return `${GLSL_HEADER}\n${paramUniformDecls(params)}\n${GLSL_COMMON}\n`;
}

/**
 * Screen-space ribbon extrusion for hairline strokes. Given the clip-space position of a point
 * and of its previous / next neighbours, offsets it sideways by `side * widthPx / 2` device px.
 * Needs uResolution + uAspect (from the header).
 */
export const GLSL_RIBBON = /* glsl */ `
vec4 ribbonExtrude(vec4 cPrev, vec4 c0, vec4 cNext, float side, float widthPx) {
  vec2 a = cPrev.xy / max(cPrev.w, 1e-4);
  vec2 b = cNext.xy / max(cNext.w, 1e-4);
  vec2 d = b - a;
  d.x *= uAspect;
  float l = length(d);
  d = l > 1e-6 ? d / l : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  n.x /= uAspect;
  c0.xy += n * side * (widthPx / uResolution.y) * c0.w;
  return c0;
}
`;

export interface MaterialOpts extends THREE.ShaderMaterialParameters {
  params: ParamDef[];
  shared: SharedResources;
  vertex: string;
  fragment: string;
  extra?: UniformMap;
}

/** ShaderMaterial with Hum's base uniforms (audio, palette, params) + the GLSL prelude on both stages. */
export function makeMaterial(o: MaterialOpts) {
  const { params, shared, vertex, fragment, extra, ...rest } = o;
  const pre = prelude(params);
  return new THREE.ShaderMaterial({
    ...rest,
    uniforms: { ...createBaseUniforms(shared, params), ...(extra ?? {}) },
    vertexShader: pre + vertex,
    fragmentShader: pre + fragment,
  });
}

/** Push audio / palette / params into a material made with makeMaterial. */
export function syncMaterial(m: THREE.ShaderMaterial, frame: FrameContext, params: ParamDef[]) {
  updateBaseUniforms(m.uniforms, frame);
  updateParamUniforms(m.uniforms, params, frame.params);
}

export function isLightPalette(p: ResolvedPalette) {
  const c = p.c.bg;
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722 > 0.5;
}

/** Additive glow on dark palettes, normal alpha blending on light ones. */
export function setAdaptiveBlending(m: THREE.Material, light: boolean) {
  const b = light ? THREE.NormalBlending : THREE.AdditiveBlending;
  if (m.blending !== b) m.blending = b;
}

/** Clamped frame delta, safe for springs. */
export function stepDt(frame: FrameContext) {
  return Math.min(Math.max(frame.dt, 0), 1 / 20);
}

/** Damped spring for springy, non-jittery motion. */
export class Spring {
  value: number;
  vel = 0;
  k: number;
  d: number;
  constructor(k = 60, d = 12, v0 = 0) {
    this.k = k;
    this.d = d;
    this.value = v0;
  }
  step(target: number, dt: number) {
    const a = this.k * (target - this.value) - this.d * this.vel;
    this.vel += a * dt;
    this.value += this.vel * dt;
    return this.value;
  }
}

/** Exponential smoothing toward a target (rate ≈ 1/seconds). */
export function approach(current: number, target: number, rate: number, dt: number) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Tempo clock: beats/sec from the audio frame, slowed while paused. */
export function beatsPerSecond(frame: FrameContext) {
  const bps = frame.audio.bpm > 0 ? frame.audio.bpm / 60 : 1.8;
  return bps * (frame.audio.playing ? 1 : 0.35);
}

/**
 * Full-screen backdrop mesh drawn behind everything (renderOrder -1, no depth).
 * The fragment receives vUv; vertex is fixed.
 */
export function makeBackdrop(material: THREE.ShaderMaterial) {
  const geo = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  material.depthTest = false;
  material.depthWrite = false;
  return mesh;
}

export const BACKDROP_VERT = /* glsl */ `
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Packs procedural per-vertex data into the position attribute (three needs one to draw). */
export function dataGeometry(data: Float32Array, index: number[] | Uint32Array) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data, 3));
  g.setIndex(index instanceof Uint32Array ? new THREE.BufferAttribute(index, 1) : index);
  return g;
}

/** Float data texture, nearest-filtered, no colour management. */
export function floatTexture(data: Float32Array, w: number, h: number, format: THREE.PixelFormat = THREE.RedFormat) {
  const t = new THREE.DataTexture(data, w, h, format, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
