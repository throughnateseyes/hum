import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl';
import { createFullscreenQuad, makeRenderTarget } from '../../core/sceneHelpers';
import type { ParamDef, SceneDef } from '../../core/types';
import { num } from '../../core/uniforms';
import { approach, makeMaterial, stepDt, syncMaterial } from '../three/common';
import { DropTimer, TONEMAP_LIB, linColor } from './volume';

/**
 * Still Water: a calm pool seen from straight above, done physically:
 *
 *   - a GPU wave-equation height field (ping-pong): stones on the kick and raindrops are impulses,
 *     so rings spread, reflect and interfere for real
 *   - caustics from the actual surface: a dense grid is refracted through the water onto the
 *     floor and drawn additively, brightness = how much each patch of light got squeezed
 *   - Snell refraction onto a procedural pebble bed, depth absorption, Fresnel sky reflection,
 *     sun glints, and a few floating leaves that cast shadows on the floor
 *
 * Palette roles: bg = water colour, fg = light (glints, foam, caustics), accent = shallow aqua,
 * accent2 = the leaves, muted = deep shadow.
 */

const params: ParamDef[] = [
  { id: 'depth', label: 'Depth', group: 'Shape', type: 'number', min: 0.08, max: 0.6, step: 0.01, default: 0.22 },
  { id: 'clarity', label: 'Clarity', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.65 },
  { id: 'leaves', label: 'Leaves', group: 'Shape', type: 'number', min: 0, max: 6, step: 1, default: 4 },
  { id: 'stones', label: 'Kick stones', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Each kick drops a stone that sends rings across the pool' },
  { id: 'every', label: 'Stone spacing', group: 'Reactivity', type: 'number', min: 0.1, max: 2, step: 0.01, default: 0.45, hint: 'Shortest time between stones (seconds)' },
  { id: 'rain', label: 'Quiet rain', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Rain falls in quiet, sad parts' },
  { id: 'wind', label: 'Breeze', group: 'Motion', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.5, hint: 'Gentle ripples that keep the caustics moving' },
  { id: 'caustics', label: 'Caustics', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
  { id: 'grain', label: 'Film grain', group: 'Color', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.02 },
];

const SIM_LONG = 320;
const CAUSTIC_LONG = 640;
const MAX_DROPS = 8;
const SLOTS = 6;
const MAX_LEAVES = 6;

/* ── simulation ── */

const SIM_STEP = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSim;
uniform vec2 uTexel;
uniform float uDamp;
uniform vec4 uDrops[${MAX_DROPS}];
uniform vec2 uWorld;
void main() {
  vec4 info = texture2D(tSim, vUv);
  // wave equation: pull toward the neighbours' average, keep the velocity, damp a little
  float avg = (texture2D(tSim, vUv + vec2(uTexel.x, 0.0)).r + texture2D(tSim, vUv - vec2(uTexel.x, 0.0)).r
             + texture2D(tSim, vUv + vec2(0.0, uTexel.y)).r + texture2D(tSim, vUv - vec2(0.0, uTexel.y)).r) * 0.25;
  info.g += (avg - info.r) * 2.0;
  info.g *= uDamp;
  info.r += info.g;
  info.r *= 0.9995;
  // impulses: stones and raindrops (x, y in world, radius, strength)
  vec2 w = (vUv - 0.5) * uWorld;
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    vec4 d = uDrops[i];
    if (d.w == 0.0) continue;
    float r = length(w - d.xy) / d.z;
    if (r < 1.0) info.r -= (0.5 + 0.5 * cos(r * 3.14159265)) * d.w;
  }
  gl_FragColor = info;
}
`;

/** Gentle wind ripples (analytic), shared by the caustics pass and the final shader. */
const GENTLE = /* glsl */ `
uniform float uWindT, uWindAmp;
float swGentle(vec2 p) {
  float t = uWindT;
  float h = sin(dot(p, vec2(52.0, 21.0)) + t * 2.3) * 0.5;
  h += sin(dot(p, vec2(-30.0, 61.0)) + t * 1.9) * 0.45;
  h += sin(dot(p, vec2(77.0, -38.0)) - t * 2.9) * 0.3;
  h += sin(dot(p, vec2(17.0, -90.0)) + t * 3.3) * 0.22;
  h += (vnoise(p * 45.0 + vec2(t * 0.5, -t * 0.4)) - 0.5) * 1.0;
  return h * uWindAmp;
}
`;

const SURFACE = /* glsl */ `
uniform sampler2D tSim;
uniform vec2 uSimTexel;
uniform vec2 uWorld;
uniform float uHScale;
// surface normal (z up) at world position w
vec3 swNormal(vec2 w) {
  vec2 uv = w / uWorld + 0.5;
  float hx = texture2D(tSim, uv + vec2(uSimTexel.x, 0.0)).r - texture2D(tSim, uv - vec2(uSimTexel.x, 0.0)).r;
  float hy = texture2D(tSim, uv + vec2(0.0, uSimTexel.y)).r - texture2D(tSim, uv - vec2(0.0, uSimTexel.y)).r;
  vec2 cell = uSimTexel * uWorld * 2.0;
  vec2 g = vec2(hx / cell.x, hy / cell.y) * uHScale;
  float e = 0.0015;
  g += vec2(swGentle(w + vec2(e, 0.0)) - swGentle(w - vec2(e, 0.0)), swGentle(w + vec2(0.0, e)) - swGentle(w - vec2(0.0, e))) / (2.0 * e);
  return normalize(vec3(-g, 1.0));
}
`;

/* ── caustics: refract a dense grid onto the floor ── */

const CAUSTIC_VERT = /* glsl */ `
uniform vec3 uSun;
uniform float uDepth;
varying vec2 vOld;
varying vec2 vNew;
${GENTLE}
${SURFACE}
void main() {
  vec2 w = position.xy * 0.5 * uWorld;
  vec3 n = swNormal(w);
  vec3 L = -uSun;
  vec3 rFlat = refract(L, vec3(0.0, 0.0, 1.0), 1.0 / 1.333);
  vec3 r = refract(L, n, 1.0 / 1.333);
  vOld = w + rFlat.xy * (uDepth / -rFlat.z);
  vNew = w + r.xy * (uDepth / -r.z);
  gl_Position = vec4(vNew / (0.5 * uWorld), 0.0, 1.0);
}
`;

const CAUSTIC_FRAG = /* glsl */ `
varying vec2 vOld;
varying vec2 vNew;
void main() {
  float oldA = length(dFdx(vOld)) * length(dFdy(vOld));
  float newA = length(dFdx(vNew)) * length(dFdy(vNew));
  float k = oldA / max(newA, 1e-9);
  gl_FragColor = vec4(vec3(k), 1.0);
}
`;

/* ── final image ── */

const FINAL = /* glsl */ `
uniform sampler2D tCaust;
uniform vec3 uSun;
uniform float uDepth, uClarity, uCaustK, uGrain, uExposure;
uniform vec3 uWater, uShallow, uLight, uLeafCol, uDeep, uSky;
uniform vec4 uLeaves[${MAX_LEAVES}];
uniform vec4 uSplash[${SLOTS}];
${GENTLE}
${SURFACE}
${TONEMAP_LIB}

vec3 swLin(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }

// one layer of pebbles: round-ish stones of varied size with sand showing between them
// returns rgb albedo in .rgb and stone coverage in .a; n = dome normal
vec4 swPebbles(vec2 p, float sc, float seed, out vec3 n) {
  vec2 q = p * sc;
  vec2 id = floor(q);
  vec2 f = fract(q);
  float best = 9.0;
  vec2 bc = vec2(0.0);
  vec2 bid = vec2(0.0);
  float br = 0.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 h = hash22(id + o + seed);
    float rad = 0.3 + 0.22 * hash21(id + o + seed * 1.3);
    vec2 c = o + 0.5 + (h - 0.5) * 0.45 - f;
    vec2 cs = rot2(h.x * 6.2832) * c * vec2(1.0, 1.0 + 0.5 * h.y);
    float d = length(cs) / rad;
    if (d < best) { best = d; bc = cs / rad; bid = id + o; br = rad; }
  }
  float cover = 1.0 - smoothstep(0.88, 1.0, best);
  n = normalize(vec3(bc * 1.3, sqrt(max(1.0 - best * best, 0.05)) * 1.1));
  float h1 = hash21(bid * 1.7 + seed);
  float h2 = hash21(bid * 3.1 + 7.0 + seed);
  vec3 stone = mix(vec3(0.40, 0.39, 0.36), vec3(0.47, 0.38, 0.29), h1);
  stone = mix(stone, vec3(0.66, 0.64, 0.58), step(0.84, h2));
  stone = mix(stone, vec3(0.20, 0.20, 0.19), step(h2, 0.14));
  stone *= 0.8 + 0.4 * (vnoise(p * sc * 9.0 + h1 * 13.0) * 0.6 + vnoise(p * sc * 30.0) * 0.4);
  return vec4(stone, cover);
}

vec3 swStones(vec2 p, out float ao) {
  vec3 L = normalize(vec3(uSun.xy, 1.0));
  vec3 sand = vec3(0.47, 0.42, 0.33) * (0.82 + 0.3 * vnoise(p * 300.0) + 0.15 * vnoise(p * 40.0));
  vec3 n1, n2;
  vec4 small = swPebbles(p, 26.0, 3.0, n2);
  vec4 big = swPebbles(p, 11.0, 0.0, n1);
  vec3 col = sand * 0.9;
  ao = 0.75;
  col = mix(col, small.rgb * (0.45 + 0.7 * max(dot(n2, L), 0.0)), small.a);
  ao = mix(ao, 0.9, small.a);
  // the big stones sit on top; a dark contact rim where they meet the bed
  float rim = smoothstep(0.0, 0.35, big.a) * (1.0 - big.a);
  col *= 1.0 - rim * 0.6;
  col = mix(col, big.rgb * (0.4 + 0.75 * max(dot(n1, L), 0.0)), big.a);
  ao = mix(ao, 1.0, big.a);
  return col;
}

// a leaf: pointed ellipse along x with a midrib, in leaf space (x -1..1)
float swLeafMask(vec2 l) {
  float w = 0.42 * sqrt(max(1.0 - l.x * l.x, 0.0)) * (1.0 - 0.25 * l.x);
  return (1.0 - smoothstep(-0.03, 0.03, abs(l.y) - w)) * step(abs(l.x), 1.0);
}
// x = coverage of any leaf, y..z = leaf-space position of the top one, w = its index
vec4 swLeaves(vec2 p, float grow) {
  vec4 best = vec4(0.0);
  for (int i = 0; i < ${MAX_LEAVES}; i++) {
    vec4 L = uLeaves[i];
    if (L.w <= 0.0) continue;
    vec2 d = rot2(-L.z) * (p - L.xy) / (L.w * grow);
    float m = swLeafMask(d);
    // a short stem
    m = max(m, (1.0 - smoothstep(0.0, 0.025, abs(d.y))) * step(-1.35, d.x) * step(d.x, -0.95));
    if (m > best.x) best = vec4(m, d, float(i));
  }
  return best;
}

vec3 swSkyRefl(vec3 r) {
  // overcast-bright sky with the dark edge of trees around the pool
  float up = clamp(r.z, 0.0, 1.0);
  vec3 sky = uSky * (0.6 + 0.6 * up);
  float trees = smoothstep(0.55, 0.85, length(r.xy)) * (0.6 + 0.4 * vnoise(r.xy * 9.0));
  return mix(sky, uDeep * 0.4, trees);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = (vUv - 0.5) * uWorld;
  vec3 n = swNormal(p);
  vec3 v = vec3(0.0, 0.0, -1.0);

  // refraction onto the floor
  vec3 r = refract(v, n, 1.0 / 1.333);
  float path = uDepth / max(-r.z, 0.2);
  vec2 fp = p + r.xy * path;
  float ao;
  vec3 floorAlb = swStones(fp, ao);
  vec2 cuv = fp / uWorld + 0.5;
  float caust = texture2D(tCaust, cuv).r;
  // leaves shade the floor (their shadow falls along the sun)
  vec2 sh = fp + uSun.xy / max(uSun.z, 0.3) * uDepth * 0.75;
  float shadow = 1.0 - swLeaves(sh, 1.08).x * 0.75;
  vec3 sunL = uLight * 3.2;
  vec3 floorLit = floorAlb * (sunL * mix(1.0, caust, uCaustK) * shadow * ao + uSky * 0.12 * ao);
  // the water swallows red first: absorption along the path, plus in-scattered water colour
  vec3 sigma = -log(clamp(uShallow, 0.02, 0.98)) * mix(5.0, 1.2, uClarity);
  vec3 Tw = exp(-sigma * path * 4.0);
  vec3 under = floorLit * Tw + uWater * 0.7 * (1.0 - Tw);

  // reflection + sun glints
  vec3 rr = reflect(v, n);
  float cosi = clamp(dot(n, -v), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
  vec3 col = mix(under, swSkyRefl(rr), clamp(fres * 1.6, 0.0, 1.0));
  vec3 hlf = normalize(uSun - v);
  float spec = pow(max(dot(n, hlf), 0.0), 900.0);
  col += uLight * spec * 14.0;

  // splash: a brief crown of foam where a stone went in
  for (int i = 0; i < ${SLOTS}; i++) {
    vec4 S = uSplash[i];
    if (S.w <= 0.0 || S.z > 0.8) continue;
    float age = S.z;
    float d = length(p - S.xy);
    float rad = 0.006 + age * 0.05 * S.w;
    float ring = exp(-pow((d - rad) / (0.003 + age * 0.006), 2.0)) * smoothstep(0.35, 0.75, vnoise(vec2(atan(p.y - S.y, p.x - S.x) * 6.0, age * 2.0)));
    float bub = smoothstep(0.72, 0.8, vnoise((p - S.xy) * 220.0 + S.w * 9.0)) * (1.0 - smoothstep(0.0, rad * 0.9, d));
    col = mix(col, uLight * 1.1, clamp((ring * 0.55 + bub * 0.4) * pow(1.0 - age / 0.8, 2.0) * min(S.w, 1.0), 0.0, 1.0));
  }

  // floating leaves (on the surface, so not refracted); they ride the ripples a touch
  vec4 lf = swLeaves(p + n.xy * 0.004, 1.0);
  if (lf.x > 0.001) {
    vec2 l = lf.yz;
    float idx = lf.w;
    vec3 lc = uLeafCol * (0.75 + 0.5 * hash11(idx * 3.7));
    lc = mix(lc, lc * vec3(1.15, 0.8, 0.55), hash11(idx * 9.1));
    float vein = 1.0 - smoothstep(0.0, 0.03, abs(l.y)) * step(-1.0, l.x) * 0.35;
    float side = abs(sin(atan(l.y, l.x + 1.2) * 9.0));
    float veins = 1.0 - (1.0 - smoothstep(0.0, 0.08, side)) * 0.12;
    float tex = 0.85 + 0.3 * vnoise(l * 18.0 + idx);
    float edgeDark = smoothstep(0.75, 1.0, length(l * vec2(1.0, 2.2)));
    vec3 leaf = lc * vein * veins * tex * (1.0 - edgeDark * 0.35) * (uLight * 2.2 + uSky * 0.3);
    // wet sheen
    leaf += uLight * pow(max(dot(normalize(vec3(n.xy * 3.0, 1.0)), hlf), 0.0), 60.0) * 0.4;
    col = mix(col, leaf, lf.x);
  }

  vec3 outc = ntToDisplay(col, uExposure);
  outc += (hash21(fc + fract(uTime * 7.31) * 517.0) - 0.5) * uGrain;
  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}
`;

interface Leaf {
  x: number;
  y: number;
  a: number;
  s: number;
  vx: number;
  vy: number;
  va: number;
}

export const stillWater: SceneDef = {
  id: 'still-water',
  name: 'Still Water',
  description:
    'A realistic calm pool seen from straight above: pebbles under clear water, caustic light playing on the bottom, a few floating leaves. Each kick drops a stone whose rings spread, bounce and cross for real (a wave simulation), the drop lands a big one, and rain falls on the water in quiet, sad parts.',
  category: 'form',
  style: 'world',
  tags: ['calm', 'sad', 'melancholic', 'tender', 'ambient', 'minimal', 'acoustic', 'piano', 'lofi', 'nature', 'organic', 'realistic', 'spacious'],
  params,
  modulations: [],
  create(init) {
    const { renderer, shared } = init;
    const nearest = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    let simA: THREE.WebGLRenderTarget | null = null;
    let simB: THREE.WebGLRenderTarget | null = null;
    let caustRT: THREE.WebGLRenderTarget | null = null;
    const world = new THREE.Vector2(16 / 9, 1);

    const drops = Array.from({ length: MAX_DROPS }, () => new THREE.Vector4());
    const simMat = new THREE.ShaderMaterial({
      uniforms: {
        tSim: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uDamp: { value: 0.996 },
        uDrops: { value: drops },
        uWorld: { value: world },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: SIM_STEP,
      depthTest: false,
      depthWrite: false,
    });
    const simQuad = createFullscreenQuad(simMat);

    const sun = new THREE.Vector3(0.28, 0.18, 0.94).normalize();
    const surfaceUniforms = {
      tSim: { value: null as THREE.Texture | null },
      uSimTexel: { value: new THREE.Vector2() },
      uWorld: { value: world },
      uHScale: { value: 0.02 },
      uWindT: { value: 0 },
      uWindAmp: { value: 0.0015 },
      uSun: { value: sun },
      uDepth: { value: 0.22 },
    };
    const caustMat = makeMaterial({
      params,
      shared,
      vertex: CAUSTIC_VERT,
      fragment: CAUSTIC_FRAG,
      extra: surfaceUniforms,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const caustGeo = new THREE.PlaneGeometry(2.3, 2.3, 380, 380);
    const caustMesh = new THREE.Mesh(caustGeo, caustMat);
    caustMesh.frustumCulled = false;
    const caustScene = new THREE.Scene();
    caustScene.add(caustMesh);
    const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const leafU = Array.from({ length: MAX_LEAVES }, () => new THREE.Vector4());
    const splashU = Array.from({ length: SLOTS }, () => new THREE.Vector4());
    const finalMat = makeMaterial({
      params,
      shared,
      vertex: /* glsl */ `void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragment: FINAL,
      extra: {
        ...surfaceUniforms,
        tCaust: { value: null },
        uClarity: { value: 0.65 },
        uCaustK: { value: 1 },
        uGrain: { value: 0.02 },
        uExposure: { value: 1 },
        uWater: { value: new THREE.Vector3() },
        uShallow: { value: new THREE.Vector3() },
        uLight: { value: new THREE.Vector3() },
        uLeafCol: { value: new THREE.Vector3() },
        uDeep: { value: new THREE.Vector3() },
        uSky: { value: new THREE.Vector3() },
        uLeaves: { value: leafU },
        uSplash: { value: splashU },
      },
      depthTest: false,
      depthWrite: false,
    });
    const finalQuad = createFullscreenQuad(finalMat);

    const drop = new DropTimer();
    let windT = 0;
    let sinceStone = 100;
    let rainS = 0;
    let slot = 0;
    const splash = Array.from({ length: SLOTS }, () => ({ x: 0, y: 0, age: 100, s: 0 }));
    const pending: THREE.Vector4[] = [];
    let seed = 1;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const leaves: Leaf[] = Array.from({ length: MAX_LEAVES }, () => ({
      x: (rnd() - 0.5) * 1.4,
      y: (rnd() - 0.5) * 0.8,
      a: rnd() * Math.PI * 2,
      s: 0.035 + rnd() * 0.025,
      vx: (rnd() - 0.5) * 0.004 + 0.003,
      vy: (rnd() - 0.5) * 0.003,
      va: (rnd() - 0.5) * 0.05,
    }));
    const tmpC = new THREE.Color();

    const ensure = (aspect: number) => {
      const sw = aspect >= 1 ? SIM_LONG : Math.round(SIM_LONG * aspect);
      const sh = aspect >= 1 ? Math.round(SIM_LONG / aspect) : SIM_LONG;
      if (simA && simA.width === sw && simA.height === sh) return;
      simA?.dispose();
      simB?.dispose();
      caustRT?.dispose();
      simA = makeRenderTarget(sw, sh, nearest);
      simB = makeRenderTarget(sw, sh, nearest);
      // clear the new sim to a flat surface
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(simA);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.setRenderTarget(simB);
      renderer.clear();
      renderer.setRenderTarget(prev);
      const cw = aspect >= 1 ? CAUSTIC_LONG : Math.round(CAUSTIC_LONG * aspect);
      const ch = aspect >= 1 ? Math.round(CAUSTIC_LONG / aspect) : CAUSTIC_LONG;
      caustRT = makeRenderTarget(cw, ch, { type: THREE.HalfFloatType, depthBuffer: false });
      world.set(aspect, 1);
    };

    const addDrop = (x: number, y: number, r: number, s: number) => {
      if (pending.length < MAX_DROPS) pending.push(new THREE.Vector4(x, y, r, s));
    };

    return {
      render(frame, target) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        const pal = frame.palette.c;
        ensure(frame.aspect);
        drop.step(frame);

        // stones on the kick (spaced), a big one on the drop
        sinceStone += dt;
        const stoneK = num(p, 'stones', 1);
        const hw = world.x * 0.45;
        const hh = world.y * 0.42;
        const fire = (big: boolean) => {
          const x = big ? (rnd() - 0.5) * 0.2 : (rnd() * 2 - 1) * hw;
          const y = big ? (rnd() - 0.5) * 0.2 : (rnd() * 2 - 1) * hh;
          const s = big ? 2.2 : 0.6 + 0.6 * a.kick;
          addDrop(x, y, big ? 0.045 : 0.018 + 0.01 * a.kick, (big ? 0.09 : 0.045) * s * Math.max(stoneK, 0.0001) * (stoneK > 0 ? 1 : 0));
          const sp = splash[slot];
          slot = (slot + 1) % SLOTS;
          sp.x = x;
          sp.y = y;
          sp.age = 0;
          sp.s = big ? 1.6 : 0.6 + 0.5 * a.kick;
        };
        if (stoneK > 0 && drop.since === 0) fire(true);
        else if (stoneK > 0 && a.kickHit && sinceStone >= num(p, 'every', 0.45)) {
          sinceStone = 0;
          fire(false);
        }
        for (const sp of splash) sp.age += dt;

        // rain in quiet (and sad) parts while the song plays
        const mood = frame.analysis?.mood;
        const sad = mood ? 1.25 - mood.valence * 0.6 : 1;
        const quiet = 1 - THREE.MathUtils.smoothstep(a.energy, 0.12, 0.5);
        rainS = approach(rainS, a.playing ? quiet * sad * num(p, 'rain', 1) : 0, 0.8, dt);
        const nRain = rainS * 26 * dt; // drops per frame
        let k = Math.floor(nRain) + (rnd() < nRain % 1 ? 1 : 0);
        while (k-- > 0) addDrop((rnd() * 2 - 1) * world.x * 0.52, (rnd() * 2 - 1) * 0.52, 0.006 + rnd() * 0.004, 0.006 + rnd() * 0.008);

        // simulate (two steps per frame); impulses go in on the first
        const su = simMat.uniforms;
        (su.uTexel.value as THREE.Vector2).set(1 / simA!.width, 1 / simA!.height);
        for (let s = 0; s < 2; s++) {
          for (let i = 0; i < MAX_DROPS; i++) {
            const d = s === 0 ? pending[i] : undefined;
            if (d) drops[i].copy(d);
            else drops[i].set(0, 0, 1, 0);
          }
          su.tSim.value = simA!.texture;
          simQuad.render(renderer, simB!);
          const t = simA;
          simA = simB;
          simB = t;
        }
        pending.length = 0;

        // shared surface uniforms
        windT += dt * (0.6 + 0.4 * a.mid) * (0.5 + num(p, 'wind', 0.5));
        surfaceUniforms.tSim.value = simA!.texture;
        surfaceUniforms.uSimTexel.value.set(1 / simA!.width, 1 / simA!.height);
        surfaceUniforms.uWindT.value = windT;
        // the shared weather: gusts roughen the pool, and tension (which starts before a known drop) more so
        surfaceUniforms.uWindAmp.value = 0.0016 * num(p, 'wind', 0.5) * (0.8 + 0.5 * frame.feel.gust + 1.5 * Math.min(1, Math.max(a.build, frame.feel.tension)));
        surfaceUniforms.uHScale.value = 1.0;
        surfaceUniforms.uDepth.value = num(p, 'depth', 0.22);

        // caustics
        syncMaterial(caustMat, frame, params);
        renderer.setRenderTarget(caustRT);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
        renderer.render(caustScene, orthoCam);

        // leaves drift; the rings nudge them
        const nLeaves = Math.round(num(p, 'leaves', 4));
        for (let i = 0; i < MAX_LEAVES; i++) {
          const L = leaves[i];
          L.x += L.vx * dt * (1 + rainS);
          L.y += L.vy * dt;
          L.a += L.va * dt;
          if (L.x > world.x * 0.6) L.x = -world.x * 0.6;
          if (L.x < -world.x * 0.6) L.x = world.x * 0.6;
          if (L.y > 0.6) L.y = -0.6;
          if (L.y < -0.6) L.y = 0.6;
          leafU[i].set(L.x, L.y, L.a, i < nLeaves ? L.s : 0);
        }
        for (let i = 0; i < SLOTS; i++) splashU[i].set(splash[i].x, splash[i].y, splash[i].age, splash[i].s);

        syncMaterial(finalMat, frame, params);
        const f = finalMat.uniforms;
        f.tCaust.value = caustRT!.texture;
        f.uClarity.value = num(p, 'clarity', 0.65);
        f.uCaustK.value = num(p, 'caustics', 1) * (1 + 0.4 * drop.env);
        f.uGrain.value = num(p, 'grain', 0.02);
        f.uExposure.value = 0.76 * (1 - 0.15 * rainS);
        linColor(pal.bg, f.uWater.value as THREE.Vector3);
        tmpC.copy(pal.accent).lerp(pal.bg, 0.1);
        linColor(tmpC, f.uShallow.value as THREE.Vector3);
        linColor(pal.fg, f.uLight.value as THREE.Vector3).multiplyScalar(1 - 0.35 * rainS);
        linColor(pal.accent2, f.uLeafCol.value as THREE.Vector3);
        linColor(pal.muted, f.uDeep.value as THREE.Vector3);
        tmpC.copy(pal.fg).lerp(pal.accent, 0.3);
        linColor(tmpC, f.uSky.value as THREE.Vector3);
        finalQuad.render(renderer, target);
      },
      dispose() {
        simA?.dispose();
        simB?.dispose();
        caustRT?.dispose();
        simMat.dispose();
        simQuad.dispose();
        caustMat.dispose();
        caustGeo.dispose();
        finalMat.dispose();
        finalQuad.dispose();
      },
    };
  },
};
