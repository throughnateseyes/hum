import * as THREE from 'three';
import { createPhotoClock, defineThreeScene } from '../../core/sceneHelpers';
import { num, str } from '../../core/uniforms';
import type { PhotoAsset, SceneDef } from '../../core/types';

const N = 160_000;
const FOV = 35;
const CAM_Z = 5;
const SAMPLE_SIDE = 512;
const NSHOCK = 4;
/** seconds a kick shockwave stays alive */
const SHOCK_LIFE = 1.6;

interface Sampled {
  /** u, v (0..1, v up), luminance, 0 — per point */
  a: Float32Array;
  /** r, g, b — per point */
  c: Float32Array;
}

function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stratified-jitter sampling of the photo into N points, in a per-photo shuffled order
 * (so morphing between two photos sends every grain somewhere new, and drawing a prefix
 * of the buffer is still an even subset).
 */
function samplePhoto(photo: PhotoAsset): Sampled {
  const ar = photo.width / Math.max(1, photo.height);
  const sw = Math.max(1, ar >= 1 ? SAMPLE_SIDE : Math.round(SAMPLE_SIDE * ar));
  const sh = Math.max(1, ar >= 1 ? Math.round(SAMPLE_SIDE / ar) : SAMPLE_SIDE);
  const cv = document.createElement('canvas');
  cv.width = sw;
  cv.height = sh;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(photo.image, 0, 0, sw, sh);
  const data = ctx.getImageData(0, 0, sw, sh).data;

  const gy = Math.max(1, Math.round(Math.sqrt(N / ar)));
  const gx = Math.max(1, Math.ceil(N / gy));
  const total = gx * gy;
  const rand = mulberry32(hashString(photo.id));
  const order = new Uint32Array(total);
  for (let i = 0; i < total; i++) order[i] = i;
  for (let i = 0; i < N; i++) {
    const j = i + Math.floor(rand() * (total - i));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }

  const a = new Float32Array(N * 4);
  const c = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) {
    const cell = order[k];
    const cx = cell % gx;
    const cy = (cell / gx) | 0;
    const u = (cx + rand()) / gx;
    const vTop = (cy + rand()) / gy;
    const px = Math.min(sw - 1, (u * sw) | 0);
    const py = Math.min(sh - 1, (vTop * sh) | 0);
    const o = (py * sw + px) * 4;
    const r = data[o] / 255;
    const g = data[o + 1] / 255;
    const b = data[o + 2] / 255;
    a[k * 4] = u;
    a[k * 4 + 1] = 1 - vTop;
    a[k * 4 + 2] = r * 0.2126 + g * 0.7152 + b * 0.0722;
    a[k * 4 + 3] = 0;
    c[k * 3] = r;
    c[k * 3 + 1] = g;
    c[k * 3 + 2] = b;
  }
  return { a, c };
}

const VERT = /* glsl */ `
attribute vec4 aA;
attribute vec3 aColA;
attribute vec4 aB;
attribute vec3 aColB;
uniform float uTime, uMorph, uScatter, uDust, uSlice, uSliceSeed, uBands, uDepth;
uniform float uBass, uKick, uDrift, uSize, uScale, uInk, uColorMode, uGlow;
uniform float uErode, uTension, uBuild, uLevel;
uniform vec4 uShock[${NSHOCK}]; // xy = origin (world units), z = age (s), w = strength (0 = off)
uniform sampler2D uSpec, uWave;
uniform vec2 uHalfA, uHalfB, uView;
uniform vec3 uAccent, uFg;
varying vec3 vCol;
varying float vAlpha;

float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
vec3 flow(vec3 p, float t) {
  return vec3(
    sin(p.y * 3.1 + t * 0.71 + sin(p.z * 2.3 + t * 0.30) * 1.5),
    sin(p.z * 2.9 + t * 0.63 + sin(p.x * 2.1 - t * 0.20) * 1.5),
    sin(p.x * 2.7 + t * 0.52 + sin(p.y * 1.9 + t * 0.40) * 1.5));
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

void main() {
  vec3 seed = position; // three random numbers 0..1 per point

  // staggered morph A → B
  float mm = clamp((uMorph - seed.x * 0.35) / 0.65, 0.0, 1.0);
  mm = mm * mm * (3.0 - 2.0 * mm);
  vec2 pa = (aA.xy - 0.5) * 2.0 * uHalfA;
  vec2 pb = (aB.xy - 0.5) * 2.0 * uHalfB;
  vec3 pos = vec3(mix(pa, pb, mm), 0.0);
  float lum = mix(aA.z, aB.z, mm);
  vec3 col = mix(aColA, aColB, mm);
  float w = mix(lum, 1.0 - lum, uInk); // visual weight: bright grains glow on dark, dark grains print on paper

  // where this grain sits on screen (0..1), before anything moves it
  float su = clamp(pos.x / (2.0 * uView.x) + 0.5, 0.0, 1.0);
  float sv = clamp(pos.y / (2.0 * uView.y) + 0.5, 0.0, 1.0);

  // glitch scanlines: horizontal bands slide sideways on snare
  vec2 half_ = mix(uHalfA, uHalfB, mm);
  float v01 = clamp(pos.y / (2.0 * half_.y) + 0.5, 0.0, 1.0);
  float band = floor(v01 * uBands);
  float slideOn = step(0.5, h11(band * 1.37 + uSliceSeed * 17.0));
  float off = h11(band * 3.71 + uSliceSeed * 5.3) - 0.5;
  pos.x += off * slideOn * uSlice * 1.2 * half_.x;

  // build-up tension: grains collapse onto a coarsening grid (the photo pixelates), separate in
  // depth and tremble; all of it lets go when the build releases into the drop
  float tq = smoothstep(0.12, 1.0, uBuild * uTension);
  float cell = mix(0.014, 0.085, tq);
  vec2 snapped = (floor(pos.xy / cell) + 0.5) * cell;
  pos.xy = mix(pos.xy, snapped, tq * 0.82);
  pos.z += (seed.z - 0.5) * 0.8 * tq;
  float tf = floor(uTime * 24.0);
  pos.xy += (vec2(h11(seed.x * 91.7 + tf), h11(seed.y * 57.3 + tf * 1.31)) - 0.5) * 0.03 * tq * tq;

  // bass relief (bright parts lift toward the camera) + kick pulse from the centre
  float r = length(pos.xy);
  pos.z += (lum - 0.4) * uDepth * (0.12 + uBass * 1.2);
  pos.z += uKick * uDepth * 0.45 * exp(-r * 0.9) * (0.6 + 0.4 * seed.y);

  // kick shockwaves: each kick bursts grains out of an impact point and sends a ring outward
  // that shoves the photo sideways and toward the camera as it passes
  float ring = 0.0;
  for (int i = 0; i < ${NSHOCK}; i++) {
    vec4 s = uShock[i];
    if (s.w <= 0.0) continue;
    vec2 dv = pos.xy - s.xy;
    float d = length(dv) + 1e-4;
    vec2 dir = dv / d;
    float x = d - s.z * 3.2;
    float env = exp(-x * x * 14.0) * exp(-s.z * 2.6) * s.w;
    float core = exp(-d * d * 3.0) * exp(-s.z * 9.0) * s.w;
    pos.xy += dir * (env * 0.16 + core * 0.4 * seed.y);
    pos.z += env * 0.55 * (0.4 + seed.y) + core * 1.1 * (seed.z - 0.15);
    ring += env;
  }

  // spectrum skyline: the photo evaporates from the top edge wherever its column's frequency
  // is loud (lows on the left), the front wobbling with the live waveform; quiet → intact photo
  float sp = texture2D(uSpec, vec2(0.02 + su * 0.8, 0.5)).r;
  float wv = texture2D(uWave, vec2(su, 0.5)).r * 2.0 - 1.0;
  float eat = (sp * 1.1 + uBuild * uTension * 0.3) * uErode;
  float front = 1.0 - eat * 0.75 - wv * 0.06 * uErode * clamp(uLevel * 2.0, 0.0, 1.0);
  float jit = (h11(seed.x * 71.3 + seed.y * 13.1) - 0.5) * 0.09;
  float gone = smoothstep(front - 0.015, front + 0.05, sv + jit) * smoothstep(0.0, 0.04, eat);
  vec3 sw = flow(vec3(pos.xy * 2.0, seed.z * 4.0), uTime * 0.6);
  float lift = 0.06 + 0.6 * max(sv + jit - front, 0.0) + 0.25 * seed.y;
  pos += vec3(sw.x * 0.12, lift + abs(sw.y) * 0.08, sw.z * 0.2) * gone;

  // idle shimmer
  pos += flow(pos * 1.3 + seed * 2.0, uTime * 0.5) * 0.006 * (0.3 + uDrift * 2.0);

  // dust: drop blows the image outward into a swirling cloud, morph swirls it in between photos;
  // grains come home in seed order as it decays
  float scatter = uDust + sin(clamp(uMorph, 0.0, 1.0) * 3.14159265) * uScatter;
  vec3 rnd = seed - 0.5 + vec3(1e-3, 2e-3, 3e-3);
  vec3 dir = normalize(vec3(pos.xy * 0.6, 0.0) + rnd * vec3(1.0, 1.0, 1.6));
  float sc = scatter * (0.35 + seed.z);
  pos.xy = rot(sc * 0.7 * (seed.y - 0.35)) * pos.xy;
  pos += (flow(seed * 6.0 + pos * 0.4, uTime * 0.35) * 0.55 + dir * 1.25) * sc;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = uSize * uScale * (0.25 + 1.1 * w) * (1.0 + uKick * 0.35 + min(ring, 1.5) * 0.7);
  size *= 1.0 - min(scatter, 1.0) * 0.35 * seed.y;
  size *= 1.0 - gone * 0.35;
  gl_PointSize = max(size * (${CAM_Z.toFixed(1)} / max(-mv.z, 0.1)), 0.5);

  vec3 duo = mix(
    mix(uAccent, uFg, smoothstep(0.3, 1.0, lum)),
    mix(uFg, uAccent, smoothstep(0.0, 0.75, lum)),
    uInk);
  vec3 c = col * mix(1.0, 0.88, uInk);
  if (uColorMode > 0.5 && uColorMode < 1.5) c = duo;
  else if (uColorMode > 1.5) c = uFg;
  vCol = c;
  vAlpha = (0.12 + 0.88 * w) * uGlow * (1.0 - min(scatter, 1.0) * 0.3);
  vAlpha *= (1.0 - gone * 0.55) * (1.0 + min(ring, 1.0) * 0.35) * (1.0 - tq * 0.6);
}
`;

const FRAG = /* glsl */ `
varying vec3 vCol;
varying float vAlpha;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d = length(q);
  float a = smoothstep(0.5, 0.12, d) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol, a);
}
`;

const COLOR_MODES = ['photo', 'duotone', 'mono'];

export const photoDissolve: SceneDef = defineThreeScene({
  id: 'photo-dissolve',
  name: 'Point Dissolve',
  description:
    'Your photo rebuilt from 160k glowing grains (ink dots on light palettes). Every kick bursts grains out of an impact point and sends a shockwave rolling across the picture; the top edge evaporates into rising dust in the shape of the live spectrum; snares slide horizontal slices sideways; build-ups pixelate the photo and pull it apart in depth; a drop blows it into a swirling cloud that re-forms grain by grain. Quiet passages leave the photo intact. Photos morph every 16 beats.',
  category: 'photo',
  usesPhotos: true,
  tags: ['dreamy', 'ethereal', 'cinematic', 'glitch', 'spacious', 'nostalgic'],
  params: [
    { id: 'density', label: 'Points', type: 'number', min: 0.15, max: 1, step: 0.01, default: 0.85, group: 'Shape' },
    { id: 'pointSize', label: 'Point size', type: 'number', min: 0.5, max: 4, step: 0.05, default: 1.6, group: 'Shape' },
    { id: 'glow', label: 'Glow', type: 'number', min: 0.1, max: 1.5, step: 0.01, default: 0.8, group: 'Shape' },
    {
      id: 'color',
      label: 'Colour',
      type: 'select',
      options: [
        { value: 'photo', label: 'Photo' },
        { value: 'duotone', label: 'Palette duotone' },
        { value: 'mono', label: 'Mono' },
      ],
      default: 'photo',
      group: 'Color',
    },
    { id: 'slices', label: 'Slice glitch', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, group: 'Motion', hint: 'How far bands slide on snares' },
    { id: 'bands', label: 'Slice bands', type: 'number', min: 4, max: 90, step: 1, default: 28, group: 'Motion' },
    { id: 'depth', label: 'Bass depth', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, group: 'Motion' },
    { id: 'dust', label: 'Drop dust', type: 'number', min: 0, max: 1, step: 0.01, default: 0.75, group: 'Motion', hint: 'How hard a drop scatters the image' },
    { id: 'drift', label: 'Idle drift', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, group: 'Motion' },
    { id: 'shock', label: 'Kick shockwave', type: 'number', min: 0, max: 1, step: 0.01, default: 0.75, group: 'Reactivity', hint: 'Kicks burst grains from an impact point and roll a ring across the photo' },
    { id: 'erode', label: 'Spectrum erosion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, group: 'Reactivity', hint: 'The top edge evaporates in the shape of the spectrum' },
    { id: 'tension', label: 'Build tension', type: 'number', min: 0, max: 1, step: 0.01, default: 0.65, group: 'Reactivity', hint: 'Build-ups pixelate the photo and pull it apart' },
  ],
  modulations: [
    { source: 'air', param: 'pointSize', amount: 0.08 },
    { source: 'build', param: 'drift', amount: 0.5 },
    { source: 'energy', param: 'glow', amount: 0.15 },
    { source: 'snare', param: 'slices', amount: 0.2 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const bg = new THREE.Color();
    scene.background = bg;
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
    camera.position.set(0, 0, CAM_Z);

    const geo = new THREE.BufferGeometry();
    const seeds = new Float32Array(N * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    geo.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
    const mk = (size: number) => new THREE.BufferAttribute(new Float32Array(N * size), size).setUsage(THREE.DynamicDrawUsage);
    const aA = mk(4);
    const aColA = mk(3);
    const aB = mk(4);
    const aColB = mk(3);
    geo.setAttribute('aA', aA);
    geo.setAttribute('aColA', aColA);
    geo.setAttribute('aB', aB);
    geo.setAttribute('aColB', aColB);

    const uniforms = {
      uTime: { value: 0 },
      uMorph: { value: 0 },
      uScatter: { value: 0.25 },
      uDust: { value: 0 },
      uSlice: { value: 0 },
      uSliceSeed: { value: 0 },
      uBands: { value: 28 },
      uDepth: { value: 0.5 },
      uBass: { value: 0 },
      uKick: { value: 0 },
      uDrift: { value: 0.35 },
      uSize: { value: 1.6 },
      uScale: { value: 1 },
      uInk: { value: 0 },
      uColorMode: { value: 0 },
      uGlow: { value: 0.8 },
      uHalfA: { value: new THREE.Vector2(1, 1) },
      uHalfB: { value: new THREE.Vector2(1, 1) },
      uAccent: { value: new THREE.Color() },
      uFg: { value: new THREE.Color() },
      uView: { value: new THREE.Vector2(1, 1) },
      uErode: { value: 0.5 },
      uTension: { value: 0.65 },
      uBuild: { value: 0 },
      uLevel: { value: 0 },
      uShock: { value: Array.from({ length: NSHOCK }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uSpec: { value: init.shared.spectrumTex as THREE.Texture },
      uWave: { value: init.shared.waveformTex as THREE.Texture },
    };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    scene.add(points);

    const cache = new Map<string, Sampled>();
    const getSample = (p: PhotoAsset) => {
      let s = cache.get(p.id);
      if (!s) {
        s = samplePhoto(p);
        cache.set(p.id, s);
      }
      return s;
    };
    const clock = createPhotoClock();
    let pairKey = '';
    let dust = 0;
    let bass = 0;
    let sliceSeed = 0;
    // kick shockwave ring buffer: origin (world units), birth time, strength
    const shocks = Array.from({ length: NSHOCK }, () => ({ x: 0, y: 0, t: -100, s: 0 }));
    let shockHead = 0;
    const viewHalfH = CAM_Z * Math.tan(((FOV / 2) * Math.PI) / 180);

    const coverHalf = (out: THREE.Vector2, p: PhotoAsset, aspect: number) => {
      const ta = p.width / Math.max(1, p.height);
      const vw = viewHalfH * aspect;
      if (aspect > ta) out.set(vw, vw / ta);
      else out.set(viewHalfH * ta, viewHalfH);
      out.multiplyScalar(1.02);
    };

    return {
      scene,
      camera,
      update(frame) {
        const a = frame.audio;
        const p = frame.params;
        const dt = Math.min(frame.dt, 0.1);
        const pal = frame.palette.c;
        bg.copy(pal.bg);
        const light = pal.bg.r * 0.2126 + pal.bg.g * 0.7152 + pal.bg.b * 0.0722 > 0.5;
        material.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
        uniforms.uInk.value = light ? 1 : 0;
        uniforms.uAccent.value.copy(pal.accent);
        uniforms.uFg.value.copy(pal.fg);

        // photo pair + morph
        const pc = clock(frame);
        const n = frame.photos.length;
        const idx = Math.floor(pc);
        const pA = frame.photos[idx % n];
        const pB = frame.photos[(idx + 1) % n];
        const key = `${pA.id}|${pB.id}`;
        if (key !== pairKey) {
          const sA = getSample(pA);
          const sB = getSample(pB);
          (aA.array as Float32Array).set(sA.a);
          (aColA.array as Float32Array).set(sA.c);
          (aB.array as Float32Array).set(sB.a);
          (aColB.array as Float32Array).set(sB.c);
          aA.needsUpdate = aColA.needsUpdate = aB.needsUpdate = aColB.needsUpdate = true;
          pairKey = key;
          if (cache.size > n + 1) {
            const live = new Set(frame.photos.map((x) => x.id));
            for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
          }
        }
        const f = pc - idx;
        const ms = Math.min(1, Math.max(0, (f - 0.72) / 0.28));
        uniforms.uMorph.value = ms * ms * (3 - 2 * ms);
        coverHalf(uniforms.uHalfA.value, pA, frame.aspect);
        coverHalf(uniforms.uHalfB.value, pB, frame.aspect);

        // audio smoothing
        const dustTarget = a.drop * num(p, 'dust', 0.75) * 1.6;
        dust += (dustTarget - dust) * (dustTarget > dust ? 1 - Math.exp(-dt * 20) : 1 - Math.exp(-dt * 0.8));
        bass += (a.bass - bass) * (1 - Math.exp(-dt * 12));
        if (a.snareHit) sliceSeed = (sliceSeed + 1) % 977;

        // kicks: a new shockwave from a random point in the middle of the frame
        const vw = viewHalfH * frame.aspect;
        uniforms.uView.value.set(vw, viewHalfH);
        if (a.kickHit) {
          const sh = shocks[shockHead];
          sh.x = (Math.random() * 2 - 1) * vw * 0.45;
          sh.y = (Math.random() * 2 - 1) * viewHalfH * 0.45;
          sh.t = frame.time;
          sh.s = 0.55 + 0.6 * Math.min(1, a.kick);
          shockHead = (shockHead + 1) % NSHOCK;
        }
        const shockAmt = num(p, 'shock', 0.75);
        for (let i = 0; i < NSHOCK; i++) {
          const sh = shocks[i];
          const age = frame.time - sh.t;
          const live = age >= 0 && age < SHOCK_LIFE ? sh.s * shockAmt : 0;
          uniforms.uShock.value[i].set(sh.x, sh.y, Math.max(0, age), live);
        }

        const drift = num(p, 'drift', 0.35);
        uniforms.uTime.value = frame.time;
        uniforms.uDust.value = dust;
        uniforms.uScatter.value = 0.2 + drift * 0.3;
        uniforms.uSlice.value = (a.snare * 0.9 + a.drop * 0.3) * num(p, 'slices', 0.55);
        uniforms.uSliceSeed.value = sliceSeed;
        uniforms.uBands.value = Math.max(1, Math.round(num(p, 'bands', 28)));
        uniforms.uDepth.value = num(p, 'depth', 0.5);
        uniforms.uBass.value = bass;
        uniforms.uKick.value = a.kick;
        uniforms.uDrift.value = drift;
        uniforms.uErode.value = num(p, 'erode', 0.5);
        uniforms.uTension.value = num(p, 'tension', 0.65);
        uniforms.uBuild.value = a.build;
        uniforms.uLevel.value = a.level;
        uniforms.uSize.value = num(p, 'pointSize', 1.6);
        uniforms.uScale.value = (frame.height / 1080) * 1.5;
        uniforms.uGlow.value = num(p, 'glow', 0.8);
        uniforms.uColorMode.value = Math.max(0, COLOR_MODES.indexOf(str(p, 'color', 'photo')));
        const density = Math.min(1, Math.max(0.05, num(p, 'density', 0.85)));
        geo.setDrawRange(0, Math.floor(N * density));

        // slow camera orbit gives the bass relief some parallax
        const t = frame.time;
        camera.position.set(
          Math.sin(t * 0.11) * 0.35 * drift + a.sway * 0.12,
          Math.cos(t * 0.083) * 0.18 * drift,
          CAM_Z + dust * 0.6,
        );
        camera.lookAt(0, 0, 0);
      },
      dispose() {
        cache.clear();
      },
    };
  },
});
