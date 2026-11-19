/**
 * Shared machinery for the realistic nature looks (three.js):
 *
 *   - a tileable 3D Perlin-Worley noise volume, baked once per renderer on the GPU into a
 *     WebGL3DRenderTarget (R = perlin-worley, GBA = worley fbm at 2×, 4×, 8× frequency)
 *   - GLSL for volumetric clouds (Nubis-style density, Beer + powder + dual-lobe phase,
 *     a short light march toward the sun), a simple physical-ish sky, ACES tonemapping
 *   - VolumePipeline: march at reduced resolution into a half-float target, then a full-res
 *     composite pass (soft upsample, tonemap, grade, grain) into the scene's target
 *
 * Colour management is off app-wide, so palette colours arrive as sRGB values: the march works
 * in linear light (`ntLin`) and the composite converts back.
 */
import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl';
import { createFullscreenQuad, makeRenderTarget } from '../../core/sceneHelpers';
import type { FrameContext, ParamDef, SceneInit } from '../../core/types';
import { makeMaterial, syncMaterial } from '../three/common';

/* ───────────────────────── 3D noise volume ───────────────────────── */

const NOISE_SIZE = 96;

const NOISE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uZ;

vec3 nh33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
// tileable worley (1 at feature points), period in cells
float nWorley(vec3 p, float per) {
  vec3 id = floor(p);
  vec3 f = fract(p);
  float md = 1.0;
  for (int k = -1; k <= 1; k++)
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec3 o = vec3(float(i), float(j), float(k));
    vec3 r = o + nh33(mod(id + o, per)) - f;
    md = min(md, dot(r, r));
  }
  return 1.0 - sqrt(md);
}
float nG(vec3 i, vec3 f, vec3 o, float per) {
  return dot(nh33(mod(i + o, per)) * 2.0 - 1.0, f - o);
}
// tileable gradient noise, ~-1..1
float nGrad(vec3 p, float per) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = mix(nG(i, f, vec3(0, 0, 0), per), nG(i, f, vec3(1, 0, 0), per), u.x);
  float b = mix(nG(i, f, vec3(0, 1, 0), per), nG(i, f, vec3(1, 1, 0), per), u.x);
  float c = mix(nG(i, f, vec3(0, 0, 1), per), nG(i, f, vec3(1, 0, 1), per), u.x);
  float d = mix(nG(i, f, vec3(0, 1, 1), per), nG(i, f, vec3(1, 1, 1), per), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z) * 1.6;
}
float nPerlinFbm(vec3 p, float freq) {
  float s = 0.0;
  float a = 1.0;
  float norm = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * nGrad(p * freq, freq);
    norm += a;
    a *= 0.5;
    freq *= 2.0;
  }
  return s / norm;
}
float nWorleyFbm(vec3 p, float f) {
  return nWorley(p * f, f) * 0.625 + nWorley(p * f * 2.0, f * 2.0) * 0.25 + nWorley(p * f * 4.0, f * 4.0) * 0.125;
}
void main() {
  vec3 p = vec3(vUv, uZ);
  float perlin = clamp(0.5 + nPerlinFbm(p, 4.0) * 1.5, 0.0, 1.0);
  float w0 = nWorleyFbm(p, 4.0);
  // perlin-worley: perlin whose low end is dilated by worley (billowy, connected blobs), stretched to 0..1
  float pw = clamp((perlin - (w0 - 1.0)) / (2.0 - w0), 0.0, 1.0);
  pw = clamp((pw - 0.42) / 0.5, 0.0, 1.0);
  gl_FragColor = vec4(pw, nWorleyFbm(p, 4.0 * 2.0), nWorleyFbm(p, 4.0 * 4.0), nWorleyFbm(p, 4.0 * 8.0));
}
`;

const noiseCache = new WeakMap<THREE.WebGLRenderer, THREE.WebGL3DRenderTarget>();

/** The shared cloud noise volume for this renderer (baked on first use, ~1 frame). */
export function getCloudNoise(renderer: THREE.WebGLRenderer): THREE.Data3DTexture {
  const hit = noiseCache.get(renderer);
  if (hit) return hit.texture as THREE.Data3DTexture;
  const rt = new THREE.WebGL3DRenderTarget(NOISE_SIZE, NOISE_SIZE, NOISE_SIZE, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  const tex = rt.texture as THREE.Data3DTexture;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uZ: { value: 0 } },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: NOISE_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const quad = createFullscreenQuad(mat);
  const prev = renderer.getRenderTarget();
  for (let z = 0; z < NOISE_SIZE; z++) {
    mat.uniforms.uZ.value = (z + 0.5) / NOISE_SIZE;
    renderer.setRenderTarget(rt, z);
    renderer.render(quad.scene, quad.camera);
  }
  renderer.setRenderTarget(prev);
  mat.dispose();
  quad.dispose();
  noiseCache.set(renderer, rt);
  return tex;
}

/* ───────────────────────── GLSL ───────────────────────── */

/** Linear-light helpers, phase functions, sky and camera rays. Needs the Hum prelude. */
export const VOL_LIB = /* glsl */ `
uniform vec3 uCamPos;
uniform mat3 uCamBasis;
uniform vec2 uTanHalf;
uniform vec3 uSunDir;
uniform float uFrame;
uniform vec2 uPixOffset;
uniform vec2 uLowSize;

// this fragment's pixel in the full march buffer (the march renders a quarter of it per frame)
vec2 ntPix() { return floor(gl_FragCoord.xy) * 2.0 + uPixOffset + 0.5; }
vec2 ntUv() { return ntPix() / uLowSize; }

vec3 ntLin(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
float ntRemap(float v, float lo, float hi) { return clamp((v - lo) / max(hi - lo, 1e-4), 0.0, 1.0); }
// Henyey-Greenstein, normalised so isotropic = 1
float ntHG(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5);
}
// interleaved gradient noise (Jimenez), rotated per frame: low-discrepancy march jitter
float ntIGN(vec2 fc) {
  fc += 5.588238 * floor(mod(uFrame, 64.0) / 4.0);
  return fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))));
}
vec3 ntRay(vec2 uv) {
  vec2 ndc = uv * 2.0 - 1.0;
  return normalize(uCamBasis * vec3(ndc.x * uTanHalf.x, ndc.y * uTanHalf.y, -1.0));
}
`;

/**
 * Volumetric cloud slab. Declare before use:
 *   uniform sampler3D uNoise; uniforms below. Density units ~ per km at uExtinct.
 */
export const CLOUD_LIB = /* glsl */ `
uniform sampler3D uNoise;
uniform vec3 uWind;
uniform float uDetailT;
uniform vec2 uMs; // multiple scattering: x = how much softer than Beer, y = its strength

struct Slab {
  float lo;
  float hi;
  float coverage;
  float density;
  float baseScale;
  float detailScale;
  float weatherScale;
  float erosion;
  float topRound;
};

float ntCloud(vec3 p, Slab s, bool detail) {
  float h = (p.y - s.lo) / (s.hi - s.lo);
  if (h <= 0.0 || h >= 1.0) return 0.0;
  vec3 q = p + uWind;
  // weather: coverage drifts across the sky in big patches
  float wth = texture(uNoise, vec3(q.xz * s.weatherScale, 0.37)).r;
  float cov = clamp(s.coverage + (wth - 0.6) * 1.3, 0.0, 1.0);
  // cumulus profile: quick flat base, rounded tops that reach higher where coverage is high
  float prof = smoothstep(0.0, 0.18, h) * (1.0 - smoothstep(mix(0.25, 0.75, cov) * s.topRound, 1.0, h));
  vec4 n = texture(uNoise, q * s.baseScale);
  float wf = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float base = ntRemap(n.r, wf - 1.0, 1.0) * prof;
  float d = ntRemap(base, mix(0.85, 0.4, cov), 1.0);
  if (detail && d > 0.0) {
    vec4 dn = texture(uNoise, q * s.detailScale + vec3(0.0, uDetailT, 0.0));
    float dw = dn.g * 0.625 + dn.b * 0.25 + dn.a * 0.125;
    // wispy at the base, billowy cauliflower at the top
    float ero = mix(1.0 - dw, dw, clamp(h * 3.0, 0.0, 1.0));
    d = ntRemap(d, ero * s.erosion, 1.0);
  }
  return d * s.density;
}

/*
 * March [t0, t1] through a slab. Returns rgb = in-scattered light (linear), a = transmittance.
 * sunCol is the sun's radiance, ambTop/ambBot the sky light at the top / base of the slab.
 */
vec4 ntMarch(vec3 ro, vec3 rd, float t0, float t1, Slab s, vec3 sunCol, vec3 ambTop, vec3 ambBot,
             float extinct, float jitter, int steps, out float tHit) {
  float dt = (t1 - t0) / float(steps);
  float t = t0 + dt * jitter;
  float T = 1.0;
  vec3 L = vec3(0.0);
  float mu = dot(rd, uSunDir);
  // forward lobe for silver linings, a little back-scatter
  float phase = mix(ntHG(mu, 0.72), ntHG(mu, -0.18), 0.4);
  float lstep0 = (s.hi - s.lo) * 0.06;
  tHit = -1.0;
  for (int i = 0; i < 96; i++) {
    if (i >= steps || t > t1) break;
    vec3 p = ro + rd * t;
    // cheap probe first: clear air is crossed in long strides
    float d0 = ntCloud(p, s, false);
    if (d0 <= 0.001) {
      t += dt * 2.2;
      continue;
    }
    float d = ntCloud(p, s, true);
    if (d > 0.002) {
      if (tHit < 0.0) tHit = t;
      // light march toward the sun
      float ld = 0.0;
      float ls = lstep0;
      vec3 lp = p;
      for (int j = 0; j < 4; j++) {
        lp += uSunDir * ls;
        ld += ntCloud(lp, s, false) * ls;
        ls *= 2.0;
      }
      float beer = exp(-ld * extinct * 0.6);
      // cheap multiple scattering: a softer, dimmer second Beer term
      float ms = max(beer, exp(-ld * extinct * uMs.x) * uMs.y);
      float powder = 1.0 - exp(-d * extinct * 0.12);
      float h = clamp((p.y - s.lo) / (s.hi - s.lo), 0.0, 1.0);
      vec3 amb = mix(ambBot, ambTop, h);
      vec3 S = sunCol * ms * phase * mix(0.6, 1.0, powder) + amb;
      float sig = d * extinct;
      float Ts = exp(-sig * dt);
      L += T * S * (1.0 - Ts);
      T *= Ts;
      if (T < 0.04) break;
    }
    t += dt;
  }
  return vec4(L, T);
}
`;

/** ACES (Narkowicz fit) + display gamma. */
export const TONEMAP_LIB = /* glsl */ `
vec3 ntAces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 ntToDisplay(vec3 lin, float exposure) {
  return pow(ntAces(lin * exposure), vec3(1.0 / 2.2));
}
`;

/* ───────────────────────── Pipeline ───────────────────────── */

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uSrcSize;
uniform float uExposure, uGrain, uTime, uSat, uLift;
uniform vec3 uTint;
${TONEMAP_LIB}
float ch21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main() {
  vec2 px = 1.0 / uSrcSize;
  // soft tent upsample: hides the march jitter without smearing edges much
  vec3 c = texture2D(tSrc, vUv).rgb * 0.4;
  c += texture2D(tSrc, vUv + vec2(px.x, px.y) * 0.75).rgb * 0.15;
  c += texture2D(tSrc, vUv + vec2(-px.x, px.y) * 0.75).rgb * 0.15;
  c += texture2D(tSrc, vUv + vec2(px.x, -px.y) * 0.75).rgb * 0.15;
  c += texture2D(tSrc, vUv + vec2(-px.x, -px.y) * 0.75).rgb * 0.15;
  vec3 col = ntToDisplay(c * uTint, uExposure);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  col = col * (1.0 - uLift) + uLift;
  col += (ch21(gl_FragCoord.xy + fract(uTime * 7.31) * 517.0) - 0.5) * uGrain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const RESOLVE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tHist;
uniform sampler2D tNew;
uniform vec2 uPixOffset;
uniform float uReset;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = p / 2;
  vec4 fresh = texelFetch(tNew, q, 0);
  bool mine = (p.x - q.x * 2) == int(uPixOffset.x) && (p.y - q.y * 2) == int(uPixOffset.y);
  vec4 hist = texelFetch(tHist, p, 0);
  if (uReset > 0.5) gl_FragColor = fresh;
  // the pixels marched this frame blend with what they showed before (averages the jitter);
  // the rest keep their last value for up to 3 frames
  else gl_FragColor = mine ? mix(hist, fresh, 0.55) : hist;
}
`;

const PHASES: [number, number][] = [
  [0, 0],
  [1, 1],
  [1, 0],
  [0, 1],
];

export interface VolumeOpts {
  init: SceneInit;
  params: ParamDef[];
  /** the march fragment (helpers + main), after the Hum prelude + VOL_LIB (+ CLOUD_LIB if `clouds`) */
  fragment: string;
  clouds?: boolean;
  extra?: Record<string, THREE.IUniform>;
}

/**
 * Renders `fragment` at `scale` × the target size into a half-float buffer (linear HDR), a
 * quarter of its pixels per frame (2×2 interleave, folded into a history buffer: the cameras
 * here hold still), then composites to the target. Fragments use ntUv()/ntPix(), not vUv. The camera is a real THREE.PerspectiveCamera: aim it with
 * `camera` (position / lookAt), and the shader's rays follow it.
 */
export class VolumePipeline {
  readonly camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 1000);
  readonly march: THREE.ShaderMaterial;
  readonly composite: THREE.ShaderMaterial;
  private resolve: THREE.ShaderMaterial;
  private marchQuad;
  private compQuad;
  private resolveQuad;
  private rt: THREE.WebGLRenderTarget | null = null;
  private histA: THREE.WebGLRenderTarget | null = null;
  private histB: THREE.WebGLRenderTarget | null = null;
  private reset = true;
  private params: ParamDef[];
  private frameNo = 0;
  scale = 0.42;

  constructor(o: VolumeOpts) {
    this.params = o.params;
    const uniforms: Record<string, THREE.IUniform> = {
      uCamPos: { value: new THREE.Vector3() },
      uCamBasis: { value: new THREE.Matrix3() },
      uTanHalf: { value: new THREE.Vector2(1, 1) },
      uSunDir: { value: new THREE.Vector3(0, 0.3, -1).normalize() },
      uFrame: { value: 0 },
      uPixOffset: { value: new THREE.Vector2() },
      uLowSize: { value: new THREE.Vector2(1, 1) },
      ...(o.extra ?? {}),
    };
    if (o.clouds) {
      uniforms.uNoise = { value: getCloudNoise(o.init.renderer) };
      uniforms.uWind = { value: new THREE.Vector3() };
      uniforms.uDetailT = { value: 0 };
      uniforms.uMs = { value: new THREE.Vector2(0.12, 0.7) };
    }
    this.march = makeMaterial({
      params: o.params,
      shared: o.init.shared,
      vertex: /* glsl */ `void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragment: `${VOL_LIB}\n${o.clouds ? CLOUD_LIB : ''}\n${o.fragment}`,
      extra: uniforms,
      depthTest: false,
      depthWrite: false,
    });
    this.composite = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null },
        uSrcSize: { value: new THREE.Vector2(1, 1) },
        uExposure: { value: 1 },
        uGrain: { value: 0.03 },
        uTime: { value: 0 },
        uSat: { value: 1 },
        uLift: { value: 0 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.resolve = new THREE.ShaderMaterial({
      uniforms: { tHist: { value: null }, tNew: { value: null }, uPixOffset: { value: new THREE.Vector2() }, uReset: { value: 1 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: RESOLVE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.marchQuad = createFullscreenQuad(this.march);
    this.compQuad = createFullscreenQuad(this.composite);
    this.resolveQuad = createFullscreenQuad(this.resolve);
  }

  /** Fit the camera to the frame: vertical fov grows on tall frames so the width never gets too narrow. */
  fitCamera(aspect: number, fovY: number, minFovX: number) {
    const tanY = Math.tan((fovY * Math.PI) / 360);
    const needY = Math.tan((minFovX * Math.PI) / 360) / Math.max(aspect, 0.1);
    const ty = Math.min(Math.max(tanY, needY), Math.tan((100 * Math.PI) / 360));
    this.camera.fov = (Math.atan(ty) * 360) / Math.PI;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    return this.camera.fov;
  }

  render(frame: FrameContext, target: THREE.WebGLRenderTarget) {
    const w = Math.max(2, Math.round(frame.width * this.scale));
    const h = Math.max(2, Math.round(frame.height * this.scale));
    const qw = Math.ceil(w / 2);
    const qh = Math.ceil(h / 2);
    if (!this.histA || this.histA.width !== w || this.histA.height !== h) {
      this.rt?.dispose();
      this.histA?.dispose();
      this.histB?.dispose();
      const nearest = { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
      this.rt = makeRenderTarget(qw, qh, nearest);
      this.histA = makeRenderTarget(w, h, { type: THREE.HalfFloatType });
      this.histB = makeRenderTarget(w, h, { type: THREE.HalfFloatType });
      this.reset = true;
    }
    const phase = PHASES[this.frameNo % 4];
    syncMaterial(this.march, frame, this.params);
    const u = this.march.uniforms;
    (u.uResolution.value as THREE.Vector2).set(w, h);
    (u.uLowSize.value as THREE.Vector2).set(w, h);
    (u.uPixOffset.value as THREE.Vector2).set(phase[0], phase[1]);
    const cam = this.camera;
    cam.updateMatrixWorld();
    (u.uCamPos.value as THREE.Vector3).copy(cam.position);
    (u.uCamBasis.value as THREE.Matrix3).setFromMatrix4(cam.matrixWorld);
    const ty = Math.tan((cam.fov * Math.PI) / 360);
    (u.uTanHalf.value as THREE.Vector2).set(ty * cam.aspect, ty);
    u.uFrame.value = this.frameNo % 64;
    this.frameNo++;
    this.marchQuad.render(frame.renderer, this.rt!);

    // fold the quarter into the full-size history
    const r = this.resolve.uniforms;
    r.tHist.value = this.histA!.texture;
    r.tNew.value = this.rt!.texture;
    (r.uPixOffset.value as THREE.Vector2).set(phase[0], phase[1]);
    r.uReset.value = this.reset ? 1 : 0;
    this.resolveQuad.render(frame.renderer, this.histB!);
    this.reset = false;
    const tmp = this.histA;
    this.histA = this.histB;
    this.histB = tmp;

    const c = this.composite.uniforms;
    c.tSrc.value = this.histA!.texture;
    (c.uSrcSize.value as THREE.Vector2).set(w, h);
    c.uTime.value = frame.time;
    this.compQuad.render(frame.renderer, target);
  }

  dispose() {
    this.march.dispose();
    this.composite.dispose();
    this.resolve.dispose();
    this.marchQuad.dispose();
    this.compQuad.dispose();
    this.resolveQuad.dispose();
    this.rt?.dispose();
    this.histA?.dispose();
    this.histB?.dispose();
  }
}

/** sRGB hex colour (THREE.Color with colour management off) → linear Vector3 */
export function linColor(c: THREE.Color, out = new THREE.Vector3()) {
  return out.set(Math.pow(c.r, 2.2), Math.pow(c.g, 2.2), Math.pow(c.b, 2.2));
}

/** Direction from elevation / azimuth in degrees (azimuth 0 = straight ahead, −Z; positive = right). */
export function dirFromAngles(elevDeg: number, azDeg: number, out = new THREE.Vector3()) {
  const e = (elevDeg * Math.PI) / 180;
  const a = (azDeg * Math.PI) / 180;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
}

/** Seconds since the drop fired, tracked across frames. */
export class DropTimer {
  since = 100;
  private prev = 0;
  step(frame: FrameContext) {
    const d = frame.audio.drop;
    if (d > 0.6 && this.prev <= 0.6) this.since = 0;
    else this.since = Math.min(this.since + Math.max(frame.dt, 0), 100);
    this.prev = d;
    return this.since;
  }
  /** 0 → 1 in ~0.4 s, then a slow ~5 s fall */
  get env() {
    const s = this.since;
    return Math.min(1, Math.max(0, (1 - Math.exp(-s * 7)) * Math.exp(-s * 0.32) * 1.15));
  }
}

export function tempoRate(frame: FrameContext) {
  return frame.audio.bpm > 0 ? Math.min(1.6, Math.max(0.6, frame.audio.bpm / 120)) : 1;
}
