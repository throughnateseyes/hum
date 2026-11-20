import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl';
import { createFullscreenQuad, makeRenderTarget } from '../../core/sceneHelpers';
import type { FrameContext, ParamDef, SceneDef } from '../../core/types';
import { bool, num, str } from '../../core/uniforms';
import { approach, makeMaterial, stepDt, syncMaterial } from '../three/common';
import { DropTimer, TONEMAP_LIB, linColor } from './volume';

/**
 * Laminar: glass rods of water arcing over a dark reflecting pool. Water moving so smoothly it reads
 * as still: a laminar fountain, done physically.
 *
 *   - every jet is a stream of water parcels, each on its own parabola from the nozzle. The valve's
 *     launch velocity and on/off state go into a short history (a texture), so the rod is the locus
 *     of parcels launched at different moments: raise the pressure and the new arc grows out of the
 *     nozzle while the old one is still landing; shut the valve and the cut-off piece flies on along
 *     the arc as a glass bolt with rounded ends
 *   - the rod is drawn as an analytic impostor: a ribbon facing the camera, and per pixel a real
 *     ray / cylinder (or end-cap sphere) intersection, Fresnel reflection of the surroundings, Snell
 *     refraction in and out (total internal reflection included), so the world behind shows through
 *     it upside down and squeezed, the way it does through a glass rod
 *   - "moving but still": the surface is near perfect, but its imperfections ride with the water.
 *     Rayleigh-Plateau ripples grow with flight time (the Smoothness param sets how fast; at low
 *     values the rod pinches into drops before it lands), the nozzle's slight wobble travels out
 *     along the arc, and trapped bubbles slide through it, catching the light
 *   - the jets are lit from inside the nozzle, like fibre optic: the light travels in the stream,
 *     leaks where it is disturbed and bursts out at the splash
 *   - the pool is a GPU wave equation: the plunge points stir it, bolts land with a plop, droplets
 *     fall back; it mirrors the sky, the lamps and the jets (planar reflection) over a black floor
 *   - three places: a dusk garden, a plaza at night, a clean studio
 *
 * Music: quiet parts are one still rod. As the song grows, jets join one per beat and the arcs climb
 * with the build. The beat before a known drop cuts every jet (glass bolts in the air, then
 * nothing), the drop fires them all at once as a volley of bolts and they come back high and steady.
 * In loud parts some jets pulse on the kick or snare, each hit a new bolt. Phrases in the verse cut
 * a jet cleanly and relaunch it.
 *
 * Palette roles: bg = sky / backdrop, fg = light (lamps, highlights), accent = the jets' inner
 * light, accent2 = warm lamps, horizon glow and the second jet colour, muted = foliage and stone.
 */

const params: ParamDef[] = [
  {
    id: 'setting',
    label: 'Setting',
    group: 'Shape',
    type: 'select',
    default: 'dusk',
    options: [
      { value: 'dusk', label: 'Dusk garden' },
      { value: 'night', label: 'Night plaza' },
      { value: 'studio', label: 'Studio' },
    ],
  },
  { id: 'jets', label: 'Jets', group: 'Shape', type: 'number', min: 1, max: 7, step: 1, default: 5, hint: 'Most jets at once (quiet parts keep to one)' },
  { id: 'order', label: 'Smoothness', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.86, hint: 'Glass-smooth laminar flow (1) or rippling, breaking, turbulent water (0)' },
  { id: 'arc', label: 'Arc height', group: 'Shape', type: 'number', min: 0.5, max: 1.6, step: 0.01, default: 1 },
  { id: 'thickness', label: 'Thickness', group: 'Shape', type: 'number', min: 0.6, max: 1.8, step: 0.01, default: 1 },
  { id: 'glow', label: 'Inner light', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Light from the nozzle travels inside the stream like fibre optic' },
  { id: 'pair', label: 'Two-colour jets', group: 'Color', type: 'bool', default: false, hint: 'Every other jet is lit with the second accent' },
  { id: 'cuts', label: 'Beat cuts', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'Jets cut into flying glass bolts on kicks, phrases and drops' },
  { id: 'builds', label: 'Build response', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'More jets and higher arcs as the song grows' },
  { id: 'roughen', label: 'Loud roughens', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, hint: 'Loud parts and drops stir the flow out of perfect order' },
  { id: 'speed', label: 'Speed', group: 'Motion', type: 'number', min: 0.3, max: 1, step: 0.01, default: 0.7, hint: '1 = real time; lower is slow motion' },
  { id: 'drift', label: 'Camera drift', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
  { id: 'grain', label: 'Film grain', group: 'Color', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.022 },
];

const J = 7; // jet slots
const RINGS = 320; // ribbon rings along each jet
const HIST = 192; // launch history samples per jet
const DELTA = 1 / 60; // seconds of sim time between history samples
const MAX_SEG = 4; // pieces of water in flight per jet
const PER = 260; // splash particles per jet
const MAX_DROPS = 24;
const SIM_W = 384;
const SIM_H = 320;
const SIM_MIN = new THREE.Vector2(-4, -3.4);
const SIM_SIZE = new THREE.Vector2(8, 6.8);
const POOL_FAR = 3.2; // far edge of the pool (z = -POOL_FAR)
const G = 9.81;

/** jet slots: nozzle (x, z) → landing (x, z), base apex height (m) */
const SLOTS: { n: [number, number]; l: [number, number]; h: number }[] = [
  { n: [-0.95, 0.3], l: [0.95, 0.3], h: 0.46 },
  { n: [1.55, -0.55], l: [-0.3, -0.8], h: 0.6 },
  { n: [-1.95, -1.35], l: [0.3, -1.2], h: 0.72 },
  { n: [0.5, -2.35], l: [2.6, -2.0], h: 0.85 },
  { n: [-0.45, -2.15], l: [-2.7, -2.5], h: 0.9 },
  { n: [-1.7, 0.1], l: [-0.55, -1.55], h: 0.52 },
  { n: [1.75, 0.45], l: [0.6, -1.15], h: 0.5 },
];
/** the order jets join in as the song grows */
const ORDER = [0, 1, 2, 5, 6, 3, 4];

/* ───────────────────────── GLSL ───────────────────────── */

/** The surroundings as a function of a ray: sky, trees, hedge, lamps (dusk); towers and windows
 *  (night); a cyclorama and softboxes (studio). Parallax-correct: rays start where they start. */
const ENV = /* glsl */ `
uniform float uSetting;
uniform vec3 uSkyTop, uSkyHor, uSkyGlow, uFoliage, uLampCol, uStone, uKeyCol, uWinCol;
uniform vec4 uLamps[8];
uniform float uEnvT, uFocus, uAperture;

vec3 lmLin(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }

// far root of a vertical cylinder around (c.x, c.y) in xz (we are inside it)
float lmCyl(vec3 ro, vec3 rd, vec2 c, float R) {
  vec2 o = ro.xz - c;
  vec2 d = rd.xz;
  float a = dot(d, d);
  if (a < 1e-6) return -1.0;
  float b = dot(o, d);
  float cc = dot(o, o) - R * R;
  float disc = b * b - a * cc;
  if (disc < 0.0) return -1.0;
  return (-b + sqrt(disc)) / a;
}
// world-space circle of confusion at distance t (a lens focused at uFocus). What a rod reflects or
// refracts is imaged close to the rod, so it is in focus: the rods set lmSharp to 0.
float lmSharp = 1.0;
float lmCoc(float t) { return uAperture * lmSharp * abs(t - uFocus) / uFocus + 0.004; }

vec3 lmSky(vec3 rd) {
  float e = rd.y;
  float az = atan(rd.x, -rd.z);
  vec3 c = mix(uSkyHor, uSkyTop, smoothstep(0.0, 0.32, e));
  float band = exp(-max(e, 0.0) * 16.0) * (0.25 + 0.75 * exp(-pow((az - 0.35) / 0.8, 2.0)));
  c += uSkyGlow * band;
  // thin high cloud, barely there
  c *= 1.0 + 0.1 * tfbm(vec2(az * 2.5 + uEnvT * 0.004, e * 9.0), 3) * smoothstep(0.0, 0.25, e);
  return c;
}

vec3 lmLamps(vec3 ro, vec3 rd, vec3 col) {
  for (int i = 0; i < 8; i++) {
    vec4 L = uLamps[i];
    if (L.w <= 0.0) continue;
    vec3 toL = L.xyz - ro;
    float tl = dot(toL, rd);
    if (tl <= 0.1) continue;
    float d = length(toL - rd * tl);
    float rc = max(lmCoc(tl), 0.025);
    float disc = smoothstep(rc, rc * 0.82, d) * (0.8 + 0.2 * smoothstep(rc * 0.4, rc * 0.95, d));
    float halo = exp(-d * d / (rc * rc * 5.0)) * lmSharp;
    col += uLampCol * L.w * (disc * min(0.000625 / (rc * rc), 0.08) * (lmSharp > 0.5 ? 1.0 : 30.0) + halo * 0.012);
  }
  return col;
}

vec3 lmDusk(vec3 ro, vec3 rd) {
  vec3 sky = lmSky(rd);
  vec3 col = sky;
  // tree line far behind the hedge, hazy
  float tt = lmCyl(ro, rd, vec2(0.0, -1.0), 18.0);
  if (tt > 0.0) {
    vec3 p = ro + rd * tt;
    float az = atan(p.x, -(p.z + 1.0));
    float h = 3.6 + 2.4 * tfbm(vec2(az * 5.0, 3.1), 4) + 1.4 * (tnoise(vec2(az * 1.7, 9.0)) - 0.5);
    float coc = lmCoc(tt) * 1.2;
    h += 0.5 * tfbm(vec2(az * 38.0, p.y * 2.0), 2);
    float m = 1.0 - smoothstep(h - coc, h + coc, p.y);
    vec3 tree = mix(uFoliage * 0.8, sky * 0.7, 0.42);
    col = mix(col, tree, m);
  }
  // clipped hedge
  float th = lmCyl(ro, rd, vec2(0.0, -1.0), 8.6);
  if (th > 0.0) {
    vec3 p = ro + rd * th;
    float az = atan(p.x, -(p.z + 1.0));
    float h = 1.38 + 0.06 * tfbm(vec2(az * 22.0, 1.0), 3);
    float coc = lmCoc(th);
    float m = 1.0 - smoothstep(h - coc, h + coc, p.y);
    float leaf = 0.62 + 0.5 * tfbm(vec2(az * 46.0, p.y * 5.0), 3) * (0.4 + 0.6 * lmSharp);
    vec3 hedge = uFoliage * leaf * (0.65 + 0.6 * smoothstep(h - 0.5, h, p.y)) + uSkyHor * 0.04 * smoothstep(h - 0.15, h, p.y);
    // the lamps light the hedge in soft pools
    for (int i = 0; i < 8; i++) {
      vec4 L = uLamps[i];
      if (L.w <= 0.0) continue;
      vec3 d = p - L.xyz;
      hedge += uLampCol * L.w * leaf * 0.006 / (dot(d, d) + 0.35);
    }
    col = mix(col, hedge, m);
  }
  return lmLamps(ro, rd, col);
}

vec3 lmNight(vec3 ro, vec3 rd) {
  vec3 sky = lmSky(rd);
  vec3 col = sky;
  // a city far off: towers of varied height, a few windows still lit
  float tb = lmCyl(ro, rd, vec2(0.0, -2.0), 42.0);
  if (tb > 0.0) {
    vec3 p = ro + rd * tb;
    float az = atan(p.x, -(p.z + 2.0));
    float s = az * 42.0 / 7.0;
    float cell = floor(s);
    float fx = fract(s);
    float tall = hash11(cell * 1.37 + 3.0);
    float hb = 5.0 + 16.0 * tall * tall * hash11(cell * 0.71 + 9.0) + 3.0 * hash11(cell);
    float gap = step(0.08, fx) * step(fx, 0.92 - 0.3 * hash11(cell * 5.3));
    float coc = lmCoc(tb);
    float m = (1.0 - smoothstep(hb - coc, hb + coc, p.y)) * smoothstep(0.0, 0.08, gap + (1.0 - step(0.5, hash11(cell * 2.9))));
    vec3 facade = uFoliage * 0.12 + sky * 0.12;
    vec2 g = vec2(fx * 7.0, p.y / 1.4);
    vec2 gi = floor(g);
    vec2 gf = fract(g);
    float hf = hash21(gi + cell * 17.0);
    float lit = step(0.8 - 0.1 * hash11(gi.y + cell), hf) * step(gi.y + 1.0, hb / 1.4 - 0.5);
    float ww = min(coc * 0.6, 0.2);
    float win = smoothstep(0.28 + ww, 0.28 - ww, abs(gf.x - 0.5)) * smoothstep(0.26 + ww, 0.26 - ww, abs(gf.y - 0.5));
    vec3 wc = mix(uWinCol, uKeyCol * 1.6, step(0.7, hash21(gi * 1.7 + cell)));
    facade += wc * lit * win * (0.25 + 0.6 * hash21(gi * 3.1 + cell)) * 0.7;
    col = mix(col, facade, m);
  }
  // a park's trees between the plaza and the city
  float tt = lmCyl(ro, rd, vec2(0.0, -1.0), 15.0);
  if (tt > 0.0) {
    vec3 p = ro + rd * tt;
    float az = atan(p.x, -(p.z + 1.0));
    float h = 2.4 + 1.6 * tfbm(vec2(az * 6.0, 7.1), 4) + 1.2 * (tnoise(vec2(az * 2.1, 3.0)) - 0.5);
    float coc = lmCoc(tt);
    float m = 1.0 - smoothstep(h - coc, h + coc, p.y + 0.3 * tfbm(vec2(az * 40.0, p.y), 2));
    col = mix(col, uFoliage * 0.25 + sky * 0.1, m);
  }
  return lmLamps(ro, rd, col);
}

vec3 lmStudio(vec3 ro, vec3 rd) {
  // a seamless cyclorama, brightest behind the fountain, falling off to the sides and up
  float t = lmCyl(ro, rd, vec2(0.0, -1.5), 7.0);
  vec3 p = ro + rd * max(t, 0.0);
  float az = atan(p.x, -(p.z + 1.5));
  float spot = exp(-az * az * 1.6) * (0.55 + 0.45 * exp(-pow((p.y - 0.8) / 2.2, 2.0)));
  vec3 col = uSkyTop * (0.25 + 0.95 * spot) * (1.0 - 0.35 * smoothstep(1.0, 5.0, p.y));
  // softboxes up left and right, off frame: the rods and the water show them
  for (int i = 0; i < 2; i++) {
    float sx = i == 0 ? -1.0 : 1.0;
    vec3 c = vec3(2.6 * sx, 3.2, 0.9);
    vec3 nrm = normalize(vec3(-sx * 0.55, -0.8, -0.2));
    float dn = dot(rd, nrm);
    if (dn < -1e-3) {
      float tq = dot(c - ro, nrm) / dn;
      if (tq > 0.0) {
        vec3 q = ro + rd * tq - c;
        vec3 ax = normalize(cross(nrm, vec3(0.0, 0.0, 1.0)));
        vec3 ay = cross(nrm, ax);
        vec2 qq = vec2(dot(q, ax), dot(q, ay));
        float box = smoothstep(1.0, 0.9, abs(qq.x) / 1.1) * smoothstep(1.0, 0.9, abs(qq.y) / 0.7);
        col += uKeyCol * box * (i == 0 ? 7.0 : 4.0);
      }
    }
  }
  return col;
}

// anything above the water: the setting's surroundings
vec3 lmUp(vec3 ro, vec3 rd) {
  if (uSetting < 0.5) return lmDusk(ro, rd);
  if (uSetting < 1.5) return lmNight(ro, rd);
  return lmStudio(ro, rd);
}
// any direction (used by the rods): rays going down meet dark water that mirrors the sky
vec3 lmAll(vec3 ro, vec3 rd) {
  if (rd.y >= 0.0) return lmUp(ro, rd);
  float t = -ro.y / min(rd.y, -1e-4);
  vec3 p = ro + rd * t;
  vec3 r = vec3(rd.x, -rd.y, rd.z);
  float F = 0.02 + 0.98 * pow(1.0 - clamp(-rd.y, 0.0, 1.0), 5.0);
  return lmUp(p, r) * F + uStone * 0.02;
}
`;

/* ── pool simulation (wave equation, ping-pong), as Still Water ── */

const SIM_STEP = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSim;
uniform vec2 uTexel;
uniform float uDamp;
uniform vec4 uDrops[${MAX_DROPS}];
uniform vec2 uSimMin, uSimSize;
void main() {
  vec4 info = texture2D(tSim, vUv);
  float avg = (texture2D(tSim, vUv + vec2(uTexel.x, 0.0)).r + texture2D(tSim, vUv - vec2(uTexel.x, 0.0)).r
             + texture2D(tSim, vUv + vec2(0.0, uTexel.y)).r + texture2D(tSim, vUv - vec2(0.0, uTexel.y)).r) * 0.25;
  info.g += (avg - info.r) * 2.0;
  info.g *= uDamp;
  info.r += info.g;
  info.r *= 0.9992;
  vec2 w = uSimMin + vUv * uSimSize;
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    vec4 d = uDrops[i];
    if (d.w == 0.0) continue;
    float r = length(w - d.xy) / d.z;
    if (r < 1.0) info.r -= (0.5 + 0.5 * cos(r * 3.14159265)) * d.w;
  }
  // the pool's walls are out of frame: let the edges swallow the rings
  vec2 e = min(vUv, 1.0 - vUv);
  info.rg *= smoothstep(0.0, 0.04, min(e.x, e.y));
  gl_FragColor = info;
}
`;

/* ── shared jet maths (history lookups) ── */

const JET_LIB = /* glsl */ `
uniform sampler2D tHist;
uniform float uNowK, uHistN, uDelta, uNoiseNow, uWob;
uniform vec3 uGrav;
uniform vec4 uNoz[${J}];      // nozzle xyz, w = radius
uniform vec4 uSeg[${J * 2}];  // 4 pieces of water per jet as (head, tail) in flight time; tail < 0 = still attached
uniform vec4 uJet[${J}];      // x = flight time drawn, y = ripple growth, z = ripple seed amplitude, w = visible
uniform float uGlowFade;

vec4 lmHist(int row, float u) {
  float k = mod(uNowK - u / uDelta, uHistN);
  float k0 = floor(k);
  float f = k - k0;
  int x0 = int(k0);
  int x1 = int(mod(k0 + 1.0, uHistN));
  return mix(texelFetch(tHist, ivec2(x0, row), 0), texelFetch(tHist, ivec2(x1, row), 0), f);
}
vec3 lmVel(int j, float u) { return lmHist(j * 2, u).xyz; }
// where the parcel that has flown for u seconds is now
vec3 lmJetPos(int j, float u) {
  vec3 v = lmVel(j, u);
  float L = uNoiseNow - u;
  vec3 side = normalize(vec3(-v.z, 0.0, v.x) + vec3(1e-5, 0.0, 0.0));
  // the nozzle's tiny wobble, carried out along the arc by the water itself
  float w1 = tnoise(vec2(L * 1.7, float(j) * 13.1)) - 0.5;
  float w2 = tnoise(vec2(L * 2.3 + 51.0, float(j) * 7.7)) - 0.5;
  v += (side * w1 + vec3(0.0, w2 * 0.6, 0.0)) * uWob * length(v);
  return uNoz[j].xyz + v * u + 0.5 * uGrav * u * u;
}
// signed distance (in flight time) to the nearest end of a piece of water; >0 inside one
float lmSeg(int j, float u, out float uEnd, out float glow) {
  float best = -1e9;
  uEnd = -10.0;
  glow = 0.0;
  for (int k = 0; k < ${MAX_SEG}; k++) {
    vec4 s = uSeg[j * 2 + k / 2];
    vec2 ht = (k == 0 || k == 2) ? s.xy : s.zw;
    float dh = ht.x - u;
    float dt = ht.y < 0.0 ? 1e3 : u - ht.y;
    float d = min(dh, dt);
    if (d > best) {
      best = d;
      uEnd = dh < dt ? ht.x : ht.y;
      glow = ht.y < 0.0 ? 1.0 : exp(-ht.y * uGlowFade);
    }
  }
  return best;
}
`;

const JET_VERT = /* glsl */ `
attribute float aJet;
uniform float uRings, uPxK;
${JET_LIB}
varying vec3 vWorld, vC, vT;
varying float vR, vU, vSpeed, vDrds, vJet, vA;
void main() {
  int j = int(aJet + 0.5);
  vec4 Jp = uJet[j];
  float du = Jp.x / (uRings - 1.0);
  float u = position.x * Jp.x;
  vec3 c = lmJetPos(j, u);
  float ua = max(u - 0.5 * du, 0.0);
  float ub = ua + du;
  vec3 tg = lmJetPos(j, ub) - lmJetPos(j, ua);
  float spd = length(tg) / du;
  tg = normalize(tg);
  float r0 = uNoz[j].w;
  // Rayleigh-Plateau: varicose ripples (wavelength ~9 radii) that grow with flight time
  float L = uNoiseNow - u;
  float fL = length(lmVel(j, u)) / (9.0 * r0);
  float amp = Jp.z * exp(Jp.y * u) * (0.35 + 1.3 * tnoise(vec2(L * 1.3, float(j) * 5.0 + 20.0)));
  amp = min(amp, 1.5);
  float ph = TAU * fL * L + 3.0 * tnoise(vec2(L * 0.9, float(j) * 3.0 + 60.0));
  float r = r0 * max(0.0, 1.0 + amp * sin(ph));
  float drds = -r0 * amp * cos(ph) * TAU * fL / max(spd, 0.1);
  float uEnd, glow;
  float d = lmSeg(j, u, uEnd, glow) * spd;
  float margin = r0 * 1.8 + 3.0 * du * spd;
  float wid = (Jp.w > 0.5 && d > -margin) ? r0 * (1.0 + amp) * 1.2 : 0.0;
  vec3 toC = c - cameraPosition;
  float dist = length(toC);
  if (wid > 0.0) wid += 1.5 * uPxK * dist;
  vec3 sideV = normalize(cross(tg, toC / dist));
  vec3 wp = c + sideV * position.y * wid;
  vWorld = wp;
  vC = c;
  vT = tg;
  vR = r;
  vU = u;
  vSpeed = max(spd, 0.05);
  vDrds = r > 0.0 ? drds : 0.0;
  vJet = float(j);
  vA = amp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const JET_FRAG = /* glsl */ `
uniform sampler2D tBg;
uniform mat4 uViewProj;
uniform float uReflPass, uPxK, uAtt, uMicro, uBubbles, uScatter;
uniform vec3 uGlowCol[${J}];
uniform vec3 uAbsorb;
${JET_LIB}
${ENV}
varying vec3 vWorld, vC, vT;
varying float vR, vU, vSpeed, vDrds, vJet, vA;

vec3 lmBehind(vec3 P, vec3 d) {
  if (uReflPass > 0.5) return lmAll(P, d);
  float D = d.y < -0.03 ? min(-P.y / d.y, 6.0) : 5.0;
  vec4 cl = uViewProj * vec4(P + d * D, 1.0);
  if (cl.w <= 0.0) return lmAll(P, d);
  vec2 s = cl.xy / cl.w * 0.5 + 0.5;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) return lmAll(P, d);
  return texture2D(tBg, s).rgb;
}

void main() {
  // in focus in the shot; in the pool's (half-size) reflection the glints would only shimmer
  lmSharp = uReflPass > 0.5 ? 1.0 : 0.0;
  int j = int(vJet + 0.5);
  vec3 T = normalize(vT);
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  float pw = uPxK * length(vC - ro);
  float r = vR;
  // ray vs the local cylinder of this stretch of rod
  vec3 oc = ro - vC;
  vec3 dp = rd - T * dot(rd, T);
  vec3 op = oc - T * dot(oc, T);
  float a = max(dot(dp, dp), 1e-8);
  float b = dot(dp, op);
  float cc = dot(op, op) - r * r;
  float tca = -b / a;
  float dAx = length(op + dp * tca);
  float disc = b * b - a * cc;
  float tHit = disc > 0.0 ? (-b - sqrt(disc)) / a : tca;
  vec3 P = ro + rd * tHit;
  float s = dot(P - vC, T);
  float uf = vU + s / vSpeed;
  float uEnd, glow;
  float inside = lmSeg(j, uf, uEnd, glow) * vSpeed;
  float cov;
  vec3 n;
  bool capped = false;
  vec3 ce = vec3(0.0);
  float rc = uNoz[j].w * 1.05;
  if (inside >= 0.0) {
    cov = clamp((r - dAx) / pw + 0.5, 0.0, 1.0);
    if (cov <= 0.0 || r <= 0.0) discard;
    vec3 radial = (P - vC) - T * s;
    n = radial / max(length(radial), 1e-6);
    n = normalize(n - T * vDrds);
  } else {
    if (inside < -rc * 1.6) discard;
    // a rounded end: the head of a launched jet or either end of a bolt
    ce = vC + T * (uEnd - vU) * vSpeed;
    vec3 oe = ro - ce;
    float bb = dot(oe, rd);
    float c2 = dot(oe, oe) - rc * rc;
    float ds = bb * bb - c2;
    float dS = length(oe - rd * bb);
    cov = clamp((rc - dS) / pw + 0.5, 0.0, 1.0);
    if (cov <= 0.0) discard;
    tHit = ds > 0.0 ? -bb - sqrt(ds) : -bb;
    P = ro + rd * tHit;
    n = normalize(P - ce);
    capped = true;
  }
  // under the waterline the rod is in the pool
  if (P.y < 0.0) discard;
  cov *= smoothstep(0.0, 0.01, P.y);

  // micro-ripples that ride with the water (shading only)
  vec3 bx = normalize(-rd - T * dot(-rd, T));
  vec3 by = cross(T, bx);
  float th = atan(dot(n, by), dot(n, bx));
  float Lf = uNoiseNow - uf;
  vec2 q = vec2(Lf * 23.0, th * 1.6 + float(j) * 10.0);
  float m1 = (tnoise(q) - 0.5) * 0.6 + (tnoise(q * vec2(2.37, 1.7) + 3.1) - 0.5) * 0.4;
  float m2 = (tnoise(q * 1.31 + 7.0) - 0.5) * 0.6 + (tnoise(q * vec2(2.9, 2.1) + 11.0) - 0.5) * 0.4;
  float micro = uMicro * (0.35 + min(vA, 1.0) * 3.0);
  n = normalize(n + (T * m1 + cross(T, n) * m2) * micro);

  float cosi = clamp(dot(n, -rd), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
  vec3 refl = lmAll(P, reflect(rd, n));

  // into the water and out the far side
  vec3 rd2 = refract(rd, n, 1.0 / 1.333);
  vec3 P2;
  vec3 n2;
  if (!capped) {
    vec3 dp2 = rd2 - T * dot(rd2, T);
    vec3 op2 = (P - vC) - T * dot(P - vC, T);
    float a2 = max(dot(dp2, dp2), 1e-8);
    float b2 = dot(dp2, op2);
    float c2 = dot(op2, op2) - r * r;
    float t2 = (-b2 + sqrt(max(b2 * b2 - a2 * c2, 0.0))) / a2;
    P2 = P + rd2 * t2;
    vec3 rad2 = (P2 - vC) - T * dot(P2 - vC, T);
    n2 = normalize(rad2 / max(length(rad2), 1e-6) - T * vDrds);
  } else {
    float t2 = -2.0 * dot(rd2, P - ce);
    P2 = P + rd2 * t2;
    n2 = normalize(P2 - ce);
  }
  n2 = normalize(n2 - (T * m1 + cross(T, n2) * m2) * micro * 0.7);
  vec3 rd3 = refract(rd2, -n2, 1.333);
  float trapped = 0.0;
  if (dot(rd3, rd3) < 1e-4) {
    // total internal reflection: the light stays in (the dark, mirror-like rims of a rod)
    rd3 = reflect(rd2, -n2);
    trapped = 1.0;
  }
  float path = length(P2 - P);
  vec3 Tr = exp(-uAbsorb * path);
  vec3 behind = lmBehind(P2, rd3) * (trapped > 0.5 ? 0.55 : 1.0);
  vec3 col = behind * Tr * (1.0 - F) + refl * F;

  // the inner light: guided from the nozzle, leaking where the stream is disturbed
  float att = exp(-max(uf, 0.0) * uAtt);
  vec3 gc = uGlowCol[j] * glow * att;
  float thick = path / (2.0 * max(r, rc * 0.5));
  float scat = uScatter + 1.6 * min(vA, 1.0) + abs(m1) * micro * 4.0;
  // guided light shows as a luminous core; surface flaws and the TIR rims let some out
  col += gc * (0.035 * thick * thick + scat * thick * 0.5 + trapped * 0.05);

  // trapped bubbles, carried along: each catches the inner light as a spark
  float cellL = Lf * 9.0;
  float bub = 0.0;
  for (int k = 0; k < 2; k++) {
    float ci = floor(cellL) - float(k);
    float h = hash11(ci * 1.37 + float(j) * 91.0);
    if (h > uBubbles) continue;
    float Lb = (ci + hash11(ci * 7.1 + float(j))) / 9.0;
    float ub = uNoiseNow - Lb;
    float ang = hash11(ci * 3.3) * TAU;
    float rad = sqrt(hash11(ci * 5.9)) * 0.7 * r;
    vec3 ax1 = normalize(cross(T, vec3(0.0, 1.0, 0.0)) + 1e-4);
    vec3 ax2 = cross(ax1, T);
    vec3 Pb = vC + T * (ub - vU) * vSpeed + (ax1 * cos(ang) + ax2 * sin(ang)) * rad;
    vec3 mid = (P + P2) * 0.5;
    vec3 dlt = Pb - mid;
    float dd = length(dlt - rd * dot(dlt, rd));
    float br = r * (0.12 + 0.18 * hash11(ci * 2.2));
    bub += smoothstep(br, br * 0.2, dd) * step(abs(dot(dlt, rd)), r * 1.2);
  }
  col += (gc * 5.0 + uKeyCol * 0.6) * bub;

  gl_FragColor = vec4(col * cov, cov);
}
`;

/* ── splash: droplets, a crown on each bolt's landing, foam ── */

const SPLASH_VERT = /* glsl */ `
attribute vec4 aP; // jet, kind (0 spray, 1 crown, 2 foam), seed, seed
attribute vec4 aQ; // seeds
uniform float uPxK, uShutter, uSplash;
uniform vec4 uLandDir[${J}]; // dir x, dir z, crown age, crown strength
uniform vec4 uCrown[${J}];   // crown x, z, speed scale, -
uniform vec3 uGlowCol[${J}];
${JET_LIB}
varying vec2 vQ;
varying float vA, vKind;
varying vec3 vCol;
void main() {
  int j = int(aP.x + 0.5);
  float kind = aP.y;
  float life = kind > 1.5 ? mix(0.25, 0.6, aQ.x) : mix(0.3, 0.8, aQ.x);
  float age;
  vec2 at;
  float vis;
  float flux = 0.0;
  if (kind > 0.5 && kind < 1.5) {
    age = uLandDir[j].z;
    at = uCrown[j].xy + (aQ.yz - 0.5) * 0.03;
    vis = step(aP.z, uLandDir[j].w);
    life = 3.0;
    flux = 1.0;
  } else {
    age = mod(uNoiseNow + aP.w * life, life);
    vec4 Ld = lmHist(j * 2 + 1, age);
    at = Ld.xy + (aQ.yz - 0.5) * 0.04;
    flux = Ld.z;
    vis = step(aP.z, Ld.z * uSplash * (kind > 1.5 ? 1.0 : 0.7));
  }
  float ang = aQ.w * TAU;
  vec2 fw = uLandDir[j].xy;
  float up, out_;
  if (kind > 1.5) {
    up = mix(0.05, 0.35, aQ.x);
    out_ = mix(0.05, 0.35, aQ.y);
  } else {
    up = mix(0.5, 2.0, aQ.x * aQ.x) * (kind > 0.5 ? 1.35 * uCrown[j].z : 1.0);
    out_ = mix(0.08, 0.6, aQ.y) * (kind > 0.5 ? 1.6 : 1.0);
  }
  vec3 v0 = vec3(cos(ang) * out_ + fw.x * 0.45 * up, up, sin(ang) * out_ + fw.y * 0.45 * up);
  vec3 p = vec3(at.x, 0.0, at.y) + v0 * age + 0.5 * uGrav * age * age;
  vec3 v = v0 + uGrav * age;
  float size = kind > 1.5 ? mix(0.015, 0.04, aQ.z) * (0.6 + age / life) : mix(0.0025, 0.006, aQ.z);
  float fade = 1.0 - smoothstep(life * 0.6, life, age);
  if (kind > 1.5) p.y = min(p.y, 0.03 + 0.06 * aQ.x);
  if (vis < 0.5 || p.y < -0.005 || age > life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // a camera-facing quad stretched along the motion (the shutter is open for a moment)
  vec3 toC = cameraPosition - p;
  float dist = length(toC);
  vec3 vd = v - toC * dot(v, toC) / (dist * dist);
  float vl = length(vd);
  float streak = kind > 1.5 ? 0.0 : vl * uShutter;
  vec3 ax = vl > 1e-4 ? vd / vl : normalize(cross(toC, vec3(0.0, 1.0, 0.0)));
  vec3 ay = normalize(cross(toC, ax));
  float minS = uPxK * dist * 0.9;
  float sx = max(size, minS) + streak * 0.5;
  float sy = max(size, minS);
  vec3 wp = p + ax * position.x * sx + ay * position.y * sy;
  vQ = vec2(position.x * sx / sy, position.y);
  vKind = kind;
  float sub = size < minS ? (size / minS) * (size / minS) : 1.0;
  vA = fade * sub * (kind > 1.5 ? 0.5 : 1.0) / (1.0 + streak / max(size, minS) * 0.35);
  vCol = uGlowCol[j] * (kind > 1.5 ? 0.9 : 1.6) * (0.4 + 0.6 * flux);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const SPLASH_FRAG = /* glsl */ `
uniform vec3 uKeyCol, uSkyTop;
varying vec2 vQ;
varying float vA, vKind;
varying vec3 vCol;
void main() {
  float hx = max(abs(vQ.x) - (abs(vQ.x) > 1.0 ? 0.0 : 0.0), 0.0);
  float len = max(abs(vQ.x) - 1.0, 0.0);
  float sx = abs(vQ.x) > 1.0 ? 1.0 : 0.0;
  float d = vKind > 1.5 ? length(vQ) : length(vec2(len, vQ.y));
  float a = smoothstep(1.0, vKind > 1.5 ? 0.0 : 0.45, d) * vA;
  if (a < 0.003) discard;
  vec3 c = vCol + uKeyCol * (vKind > 1.5 ? 0.25 : 0.5) + uSkyTop * 0.15;
  gl_FragColor = vec4(c * a, a * (vKind > 1.5 ? 0.6 : 0.35));
}
`;

/* ── the world: surroundings, pool, coping, ground ── */

const WORLD_FRAG = /* glsl */ `
uniform vec3 uCamPos;
uniform mat3 uCamBasis;
uniform vec2 uTanHalf;
uniform sampler2D tSim, tRefl;
uniform vec2 uSimMin, uSimSize, uSimTexel;
uniform float uHScale, uCalm, uRough, uReflWarp;
uniform vec4 uLand[${J}];   // landing x, z, foam, light burst
uniform vec4 uNozL[${J}];   // nozzle x, z, light, jet on
uniform vec3 uGlowCol[${J}];
uniform vec3 uFoamCol, uWaterCol;
${ENV}

vec3 lmRay(vec2 uv) {
  vec2 ndc = uv * 2.0 - 1.0;
  return normalize(uCamBasis * vec3(ndc.x * uTanHalf.x, ndc.y * uTanHalf.y, -1.0));
}

float lmCalmH(vec2 p) {
  float t = uEnvT;
  float h = (tnoise(p * vec2(5.0, 9.0) + vec2(t * 0.25, -t * 0.2)) - 0.5);
  h += (tnoise(p * vec2(13.0, 21.0) - vec2(t * 0.4, t * 0.3)) - 0.5) * 0.45;
  h += sin(dot(p, vec2(17.0, 31.0)) + t * 2.1) * 0.08;
  return h * uCalm;
}
vec3 lmWaterN(vec2 p) {
  vec2 uv = (p - uSimMin) / uSimSize;
  float hx = texture2D(tSim, uv + vec2(uSimTexel.x, 0.0)).r - texture2D(tSim, uv - vec2(uSimTexel.x, 0.0)).r;
  float hz = texture2D(tSim, uv + vec2(0.0, uSimTexel.y)).r - texture2D(tSim, uv - vec2(0.0, uSimTexel.y)).r;
  vec2 cell = uSimTexel * uSimSize * 2.0;
  vec2 g = vec2(hx / cell.x, hz / cell.y) * uHScale;
  float e = 0.01;
  g += vec2(lmCalmH(p + vec2(e, 0.0)) - lmCalmH(p - vec2(e, 0.0)), lmCalmH(p + vec2(0.0, e)) - lmCalmH(p - vec2(0.0, e))) / (2.0 * e);
  return normalize(vec3(-g.x, 1.0, -g.y));
}

vec3 lmStoneTex(vec2 p, float wet) {
  float n = tnoise(p * 9.0) * 0.6 + tnoise(p * 37.0) * 0.4;
  vec3 c = uStone * (0.7 + 0.5 * n);
  return c * mix(1.0, 0.45, wet);
}

// the pool's light: nozzles glowing under the surface, splashes glowing where the light escapes
vec3 lmPoolLight(vec2 p) {
  vec3 L = vec3(0.0);
  for (int j = 0; j < ${J}; j++) {
    vec4 nz = uNozL[j];
    vec4 ld = uLand[j];
    vec3 g = uGlowCol[j];
    float dn = distance(p, nz.xy);
    L += g * nz.z * 0.012 / (dn * dn + 0.012);
    float dl = distance(p, ld.xy);
    L += g * (ld.z * 0.6 + ld.w * 2.0) * 0.02 / (dl * dl + 0.03);
  }
  return L;
}

vec3 lmWater(vec3 ro, vec3 rd, vec3 p) {
  vec3 n = lmWaterN(p.xz);
  vec3 rr = reflect(rd, n);
  rr.y = max(rr.y, 0.003);
  rr = normalize(rr);
  vec3 refl = lmUp(p, rr);
  vec2 suv = vUv + vec2(n.x, n.z) * uReflWarp;
  vec4 jr = texture2D(tRefl, suv);
  refl = refl * (1.0 - jr.a) + jr.rgb;
  float cosi = clamp(dot(n, -rd), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
  // down through the water to a black floor, lit only by the fountain's own light
  vec3 rt = refract(rd, n, 0.75);
  float depth = 0.45;
  float tf = depth / max(-rt.y, 0.08);
  vec3 fp = p + rt * tf;
  vec3 floorC = lmStoneTex(fp.xz * 0.7, 0.8) * 0.18 * (uStone * 0.3 + lmPoolLight(fp.xz) * 0.8);
  vec3 absorb = exp(-tf * vec3(1.6, 0.6, 0.45));
  vec3 under = floorC * absorb + uWaterCol * (1.0 - absorb.g) * 0.1 + lmPoolLight(p.xz) * 0.05 * uWaterCol;
  vec3 col = mix(under, refl, F);

  // the nozzles: a point of light just under the surface
  for (int j = 0; j < ${J}; j++) {
    vec4 nz = uNozL[j];
    float d = distance(p.xz, nz.xy);
    col += uGlowCol[j] * nz.z * (0.5 * exp(-d / 0.022) + 0.05 * exp(-d / 0.12));
  }
  // where the jets plunge: foam, bubbles, and the light let out by the break-up
  for (int j = 0; j < ${J}; j++) {
    vec4 ld = uLand[j];
    float amt = ld.z + ld.w;
    if (amt < 0.005) continue;
    vec2 d = p.xz - ld.xy;
    float r = length(d);
    float R0 = 0.045 + 0.035 * ld.z + 0.08 * uRough + 0.1 * ld.w;
    if (r > R0 * 5.0) continue;
    float n1 = tnoise(d * 42.0 + vec2(0.0, uEnvT * 2.3));
    float n2 = tnoise(d * 110.0 - vec2(uEnvT * 3.1, 0.0));
    float foam = smoothstep(R0, R0 * 0.2, r + (n1 - 0.5) * R0 * 1.1) * (0.55 + 0.7 * n2) * min(amt, 1.2);
    // bubbles drifting outward from the plunge
    vec2 pr = vec2(r * 60.0 - uEnvT * 2.0, atan(d.y, d.x) * 9.0);
    float bub = smoothstep(0.78, 0.9, tnoise(pr * 2.0)) * smoothstep(R0 * 4.5, R0 * 1.2, r) * ld.z;
    vec3 lit = uFoamCol + uGlowCol[j] * 1.4;
    col = mix(col, lit, clamp(foam, 0.0, 1.0) * 0.9);
    col += lit * bub * 0.35;
    col += uGlowCol[j] * (ld.z * 0.5 + ld.w * 1.5) * exp(-r / (R0 * 0.9));
  }
  return col;
}

void main() {
  vec3 ro = uCamPos;
  vec3 rd = lmRay(vUv);
  vec3 col;
  if (rd.y < -1e-4) {
    float t = -ro.y / rd.y;
    vec3 p = ro + rd * t;
    if (p.z > -${POOL_FAR.toFixed(2)}) {
      col = lmWater(ro, rd, p);
    } else {
      // the far coping: a stone face, its top, then the ground up to the setting
      float hC = 0.11;
      float t1 = (-${POOL_FAR.toFixed(2)} - ro.z) / rd.z;
      float y1 = ro.y + rd.y * t1;
      if (y1 <= hC) {
        vec3 q = ro + rd * t1;
        float wet = 1.0 - smoothstep(0.0, 0.04, q.y);
        col = lmStoneTex(q.xy * vec2(1.0, 3.0), wet) * 2.2 * (uSkyHor * 0.5 + uSkyTop * 0.35 + lmPoolLight(vec2(q.x, q.z + 0.2)) * 0.4);
      } else {
        float t2 = (hC - ro.y) / rd.y;
        vec3 q = ro + rd * t2;
        float tH = uSetting < 1.5 ? lmCyl(ro, rd, vec2(0.0, -1.0), uSetting < 0.5 ? 8.6 : 15.0) : lmCyl(ro, rd, vec2(0.0, -1.5), 7.0);
        if (tH > 0.0 && t2 > tH) col = lmUp(ro, rd);
        else {
          float coping = 1.0 - smoothstep(-${(POOL_FAR + 0.42).toFixed(2)}, -${(POOL_FAR + 0.4).toFixed(2)}, -q.z);
          vec3 g = lmStoneTex(q.xz, 0.0);
          // lamp light pools on the ground; the night plaza is wet and mirrors
          vec3 lit = uSkyHor * 0.45 + uSkyTop * 0.4 + lmPoolLight(q.xz) * 0.05;
          for (int i = 0; i < 8; i++) {
            vec4 L = uLamps[i];
            if (L.w <= 0.0) continue;
            vec3 d = q - L.xyz;
            lit += uLampCol * L.w * 0.02 / (dot(d, d) + 0.4);
          }
          col = g * lit * mix(1.0, 2.6, coping);
          // the coping's lit edge
          float edge = smoothstep(0.012, 0.0, abs(q.z + ${POOL_FAR.toFixed(2)}));
          col += uSkyHor * edge * 0.2;
          if (uSetting > 0.5 && uSetting < 1.5) {
            vec3 rr = reflect(rd, normalize(vec3((tnoise(q.xz * 6.0) - 0.5) * 0.06, 1.0, (tnoise(q.xz * 6.0 + 9.0) - 0.5) * 0.06)));
            col += lmUp(q, rr) * 0.22;
          }
          if (uSetting > 1.5) col = uSkyTop * (0.22 + 0.2 * smoothstep(-4.0, -7.5, q.z)) + lmPoolLight(q.xz) * 0.02;
        }
      }
    }
  } else {
    col = lmUp(ro, rd);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ── post: bloom + tonemap + grain ── */

const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThr;
void main() {
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  gl_FragColor = vec4(c * max(l - uThr, 0.0) / max(l, 1e-4), 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uDir;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.227;
  c += (texture2D(tSrc, vUv + uDir * 1.385).rgb + texture2D(tSrc, vUv - uDir * 1.385).rgb) * 0.316;
  c += (texture2D(tSrc, vUv + uDir * 3.231).rgb + texture2D(tSrc, vUv - uDir * 3.231).rgb) * 0.070;
  gl_FragColor = vec4(c, 1.0);
}
`;

const COMP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene, tBloom, tBloom2;
uniform float uExposure, uBloomK, uGrain, uTime, uVig;
${TONEMAP_LIB}
float ch21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  c += (texture2D(tBloom, vUv).rgb * 0.6 + texture2D(tBloom2, vUv).rgb * 0.8) * uBloomK;
  vec2 q = vUv - 0.5;
  c *= 1.0 - uVig * dot(q, q) * 1.6;
  vec3 col = ntToDisplay(c, uExposure);
  col += (ch21(gl_FragCoord.xy + fract(uTime * 7.31) * 517.0) - 0.5) * uGrain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── CPU side ───────────────────────── */

interface Seg {
  on: number;
  off: number;
}
interface Jet {
  /** taking part in the choreography */
  active: boolean;
  open: boolean;
  mode: 'steady' | 'kick' | 'snare';
  segs: Seg[];
  H: number;
  vel: THREE.Vector3;
  prevVel: THREE.Vector3;
  closeAt: number; // clock time to close a pulse (or -1)
  openAt: number; // clock time to (re)open (or -1)
  uL: number; // flight time to the water
  flux: number;
  foam: number;
  burst: number;
  crownAt: number; // sim time of the last bolt landing
  crownS: number;
  light: number;
  land: THREE.Vector2;
  dir: THREE.Vector2;
  noz: THREE.Vector3;
}

const SETTINGS = ['dusk', 'night', 'studio'];

/** lamps per setting: xyz, intensity */
const LAMPS: Record<string, [number, number, number, number][]> = {
  dusk: [
    [-4.6, 0.75, -7.2, 1],
    [-1.4, 0.75, -7.6, 0.9],
    [2.3, 0.75, -7.5, 1],
    [5.4, 0.75, -6.4, 0.85],
    [-7.0, 1.6, -4.5, 0.6],
    [0.6, 2.4, -16.0, 0.5],
    // behind the camera, out of view: they put glints on the rods
    [-3.2, 1.3, 6.5, 0.7],
    [4.5, 2.2, 7.5, 0.5],
  ],
  night: [
    [-5.5, 3.2, -9.0, 1.0],
    [-1.2, 3.2, -11.5, 0.8],
    [3.6, 3.2, -10.0, 1.0],
    [8.0, 3.2, -7.0, 0.8],
    [-9.5, 3.2, -6.0, 0.8],
    [1.2, 0.9, -6.4, 0.35],
    [-3.5, 3.0, 7.0, 0.8],
    [5.0, 3.4, 6.0, 0.6],
  ],
  studio: [],
};

export const laminar: SceneDef = {
  id: 'laminar',
  name: 'Laminar',
  description:
    'Laminar fountain jets arcing over a dark reflecting pool at dusk (or a night plaza, or a studio): water so smooth it looks like glass rods, refracting the world upside down and lit from inside like fibre optic, with tiny ripples and bubbles sliding along to show it is moving. Quiet parts are one still rod; jets join and the arcs climb through a build; the beat before the drop cuts them all into flying glass bolts, the drop fires a volley, and loud parts pulse bolts on the kick. Smoothness sets glassy vs turbulent.',
  category: 'form',
  style: 'world',
  tags: ['calm', 'dreamy', 'tender', 'romantic', 'cinematic', 'spacious', 'ambient', 'minimal', 'hypnotic', 'euphoric', 'uplifting', 'nature', 'organic', 'realistic', 'slow'],
  params,
  modulations: [],
  create(init) {
    const { renderer, shared } = init;

    /* history of each jet's launch velocity (rows 2j) and landing (rows 2j+1) */
    const histData = new Float32Array(HIST * J * 2 * 4);
    const histTex = new THREE.DataTexture(histData, HIST, J * 2, THREE.RGBAFormat, THREE.FloatType);
    histTex.minFilter = THREE.NearestFilter;
    histTex.magFilter = THREE.NearestFilter;
    histTex.generateMipmaps = false;
    histTex.colorSpace = THREE.NoColorSpace;
    histTex.needsUpdate = true;

    const jets: Jet[] = SLOTS.map((s) => {
      const noz = new THREE.Vector3(s.n[0], 0, s.n[1]);
      const land = new THREE.Vector2(s.l[0], s.l[1]);
      const dir = new THREE.Vector2(s.l[0] - s.n[0], s.l[1] - s.n[1]).normalize();
      return { active: false, open: false, mode: 'steady', segs: [], H: s.h, vel: new THREE.Vector3(), prevVel: new THREE.Vector3(), closeAt: -1, openAt: -1, uL: 0.5, flux: 0, foam: 0, burst: 0, crownAt: -100, crownS: 0, light: 0.2, land, dir, noz };
    });

    /* uniforms shared by the jet / splash / world shaders */
    const nozU = Array.from({ length: J }, () => new THREE.Vector4());
    const segU = Array.from({ length: J * 2 }, () => new THREE.Vector4(-10, -5, -10, -5));
    const jetU = Array.from({ length: J }, () => new THREE.Vector4());
    const glowU = Array.from({ length: J }, () => new THREE.Vector3());
    const landU = Array.from({ length: J }, () => new THREE.Vector4());
    const nozLU = Array.from({ length: J }, () => new THREE.Vector4());
    const landDirU = Array.from({ length: J }, () => new THREE.Vector4());
    const crownU = Array.from({ length: J }, () => new THREE.Vector4());
    const lampU = Array.from({ length: 8 }, () => new THREE.Vector4());
    const jetLib = {
      tHist: { value: histTex },
      uNowK: { value: 0 },
      uHistN: { value: HIST },
      uDelta: { value: DELTA },
      uNoiseNow: { value: 0 },
      uWob: { value: 0.005 },
      uGrav: { value: new THREE.Vector3(0, -G, 0) },
      uNoz: { value: nozU },
      uSeg: { value: segU },
      uJet: { value: jetU },
      uGlowFade: { value: 2.5 },
    };
    const envU = {
      uSetting: { value: 0 },
      uSkyTop: { value: new THREE.Vector3() },
      uSkyHor: { value: new THREE.Vector3() },
      uSkyGlow: { value: new THREE.Vector3() },
      uFoliage: { value: new THREE.Vector3() },
      uLampCol: { value: new THREE.Vector3() },
      uStone: { value: new THREE.Vector3() },
      uKeyCol: { value: new THREE.Vector3() },
      uWinCol: { value: new THREE.Vector3() },
      uLamps: { value: lampU },
      uEnvT: { value: 0 },
      uFocus: { value: 3.3 },
      uAperture: { value: 0.05 },
    };

    /* jets: one instanced ribbon per slot, analytic rod per pixel */
    const ringPos = new Float32Array(RINGS * 2 * 3);
    const ringIdx: number[] = [];
    for (let i = 0; i < RINGS; i++) {
      const t = i / (RINGS - 1);
      ringPos.set([t, -1, 0, t, 1, 0], i * 6);
      if (i < RINGS - 1) {
        const a = i * 2;
        ringIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const jetGeo = new THREE.InstancedBufferGeometry();
    jetGeo.setAttribute('position', new THREE.BufferAttribute(ringPos, 3));
    jetGeo.setIndex(ringIdx);
    jetGeo.setAttribute('aJet', new THREE.InstancedBufferAttribute(new Float32Array(Array.from({ length: J }, (_, i) => i)), 1));
    jetGeo.instanceCount = J;
    const jetMat = makeMaterial({
      params,
      shared,
      vertex: JET_VERT,
      fragment: JET_FRAG,
      extra: {
        ...jetLib,
        ...envU,
        tBg: { value: null },
        uViewProj: { value: new THREE.Matrix4() },
        uReflPass: { value: 0 },
        uRings: { value: RINGS },
        uPxK: { value: 0.002 },
        uAtt: { value: 0.6 },
        uMicro: { value: 0.05 },
        uBubbles: { value: 0.2 },
        uScatter: { value: 0.1 },
        uGlowCol: { value: glowU },
        uAbsorb: { value: new THREE.Vector3(0.9, 0.25, 0.18) },
      },
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthTest: true,
      depthWrite: true,
    });
    const jetMesh = new THREE.Mesh(jetGeo, jetMat);
    jetMesh.frustumCulled = false;

    /* splash particles */
    const quad = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    const spGeo = new THREE.InstancedBufferGeometry();
    spGeo.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    spGeo.setIndex([0, 1, 2, 0, 2, 3]);
    const aP = new Float32Array(J * PER * 4);
    const aQ = new Float32Array(J * PER * 4);
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let j = 0; j < J; j++)
      for (let i = 0; i < PER; i++) {
        const k = (j * PER + i) * 4;
        const kind = i < PER * 0.45 ? 0 : i < PER * 0.8 ? 1 : 2;
        aP.set([j, kind, rnd(), rnd()], k);
        aQ.set([rnd(), rnd(), rnd(), rnd()], k);
      }
    spGeo.setAttribute('aP', new THREE.InstancedBufferAttribute(aP, 4));
    spGeo.setAttribute('aQ', new THREE.InstancedBufferAttribute(aQ, 4));
    spGeo.instanceCount = J * PER;
    const spMat = makeMaterial({
      params,
      shared,
      vertex: SPLASH_VERT,
      fragment: SPLASH_FRAG,
      extra: {
        ...jetLib,
        uPxK: { value: 0.002 },
        uShutter: { value: 1 / 90 },
        uSplash: { value: 0.5 },
        uLandDir: { value: landDirU },
        uCrown: { value: crownU },
        uGlowCol: { value: glowU },
        uKeyCol: envU.uKeyCol,
        uSkyTop: envU.uSkyTop,
      },
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthTest: true,
      depthWrite: false,
    });
    const spMesh = new THREE.Mesh(spGeo, spMat);
    spMesh.frustumCulled = false;
    spMesh.renderOrder = 1;

    const fg = new THREE.Scene();
    fg.add(jetMesh, spMesh);

    /* pool simulation */
    const simOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    let simA = makeRenderTarget(SIM_W, SIM_H, simOpts);
    let simB = makeRenderTarget(SIM_W, SIM_H, simOpts);
    {
      const prev = renderer.getRenderTarget();
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(simA);
      renderer.clear();
      renderer.setRenderTarget(simB);
      renderer.clear();
      renderer.setRenderTarget(prev);
    }
    const drops = Array.from({ length: MAX_DROPS }, () => new THREE.Vector4());
    const simMat = new THREE.ShaderMaterial({
      uniforms: {
        tSim: { value: null },
        uTexel: { value: new THREE.Vector2(1 / SIM_W, 1 / SIM_H) },
        uDamp: { value: 0.993 },
        uDrops: { value: drops },
        uSimMin: { value: SIM_MIN },
        uSimSize: { value: SIM_SIZE },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: SIM_STEP,
      depthTest: false,
      depthWrite: false,
    });
    const simQuad = createFullscreenQuad(simMat);
    const pending: THREE.Vector4[] = [];
    const addDrop = (x: number, z: number, r: number, s: number) => {
      if (pending.length < MAX_DROPS) pending.push(new THREE.Vector4(x, z, r, s));
    };

    /* world */
    const worldMat = makeMaterial({
      params,
      shared,
      vertex: /* glsl */ `void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragment: WORLD_FRAG,
      extra: {
        ...envU,
        uCamPos: { value: new THREE.Vector3() },
        uCamBasis: { value: new THREE.Matrix3() },
        uTanHalf: { value: new THREE.Vector2(1, 1) },
        tSim: { value: null },
        tRefl: { value: null },
        uSimMin: { value: SIM_MIN },
        uSimSize: { value: SIM_SIZE },
        uSimTexel: { value: new THREE.Vector2(1 / SIM_W, 1 / SIM_H) },
        uHScale: { value: 1 },
        uCalm: { value: 0.0004 },
        uRough: { value: 0 },
        uReflWarp: { value: 0.12 },
        uLand: { value: landU },
        uNozL: { value: nozLU },
        uGlowCol: { value: glowU },
        uFoamCol: { value: new THREE.Vector3() },
        uWaterCol: { value: new THREE.Vector3() },
      },
      depthTest: false,
      depthWrite: false,
    });
    const worldQuad = createFullscreenQuad(worldMat);

    /* post */
    const brightMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThr: { value: 1 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BRIGHT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const blurMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const compMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        tBloom2: { value: null },
        uExposure: { value: 1 },
        uBloomK: { value: 1 },
        uGrain: { value: 0.02 },
        uTime: { value: 0 },
        uVig: { value: 0.3 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMP_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const brightQuad = createFullscreenQuad(brightMat);
    const blurQuad = createFullscreenQuad(blurMat);
    const compQuad = createFullscreenQuad(compMat);

    let bgRT: THREE.WebGLRenderTarget | null = null;
    let sceneRT: THREE.WebGLRenderTarget | null = null;
    let reflRT: THREE.WebGLRenderTarget | null = null;
    let b1: THREE.WebGLRenderTarget | null = null;
    let b2: THREE.WebGLRenderTarget | null = null;
    let b3: THREE.WebGLRenderTarget | null = null;
    let b4: THREE.WebGLRenderTarget | null = null;

    const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.05, 200);
    const mirrorCam = new THREE.PerspectiveCamera(32, 16 / 9, 0.05, 200);
    mirrorCam.matrixAutoUpdate = false;
    mirrorCam.matrixWorldAutoUpdate = false;
    const flipY = new THREE.Matrix4().makeScale(1, -1, 1);
    const viewProj = new THREE.Matrix4();

    const drop = new DropTimer();
    let clock = 0;
    let simT = 0;
    let lastK = -1; // last history sample written (absolute index)
    let envT = 0;
    let nActive = 0;
    let preDrop = false;
    let lastTick = 0; // clock of the last beat-or-timer tick
    let phrase = 0;
    let rough = 0;
    let dropBoost = 0;
    let kickEnv = 0;
    let lastSection = -2;
    const tmpC = new THREE.Color();
    const tmpV = new THREE.Vector3();

    /* valves */
    const openJet = (j: Jet) => {
      if (j.open) return;
      j.open = true;
      j.segs.push({ on: simT, off: Infinity });
      if (j.segs.length > MAX_SEG) j.segs.shift();
    };
    const closeJet = (j: Jet) => {
      if (!j.open) return;
      j.open = false;
      const s = j.segs[j.segs.length - 1];
      if (s) s.off = simT;
    };

    /* velocity for an arc from the nozzle to the landing point with apex height H */
    const launchVel = (j: Jet, H: number, out: THREE.Vector3) => {
      const R = Math.hypot(j.land.x - j.noz.x, j.land.y - j.noz.z);
      const alpha = Math.atan((4 * H) / R);
      const v = Math.sqrt((G * R) / Math.sin(2 * alpha));
      return out.set(j.dir.x * v * Math.cos(alpha), v * Math.sin(alpha), j.dir.y * v * Math.cos(alpha));
    };

    /* CPU copy of the history lookup (no wobble): where the parcel aloft for u seconds is */
    const histVelAt = (ji: number, u: number, out: THREE.Vector3) => {
      const kAbs = simT / DELTA - u / DELTA;
      let k = kAbs % HIST;
      if (k < 0) k += HIST;
      const k0 = Math.floor(k);
      const f = k - k0;
      const k1 = (k0 + 1) % HIST;
      const row = ji * 2;
      const a = (row * HIST + k0) * 4;
      const b = (row * HIST + k1) * 4;
      return out.set(histData[a] + (histData[b] - histData[a]) * f, histData[a + 1] + (histData[b + 1] - histData[a + 1]) * f, histData[a + 2] + (histData[b + 2] - histData[a + 2]) * f);
    };
    const landingTime = (ji: number) => {
      // first u where the parcel is back at the water
      let prevY = 0;
      for (let u = 0.04; u < 2.2; u += 0.01) {
        histVelAt(ji, u, tmpV);
        const y = tmpV.y * u - 0.5 * G * u * u;
        if (y < 0 && prevY >= 0) {
          const f = prevY / (prevY - y);
          return u - 0.01 + 0.01 * f;
        }
        prevY = y;
      }
      return 1;
    };
    const inWater = (j: Jet, u: number) => j.segs.some((s) => simT - s.on >= u && (s.off === Infinity || simT - s.off <= u));

    // f: where this sample sits between last frame (0) and now (1), so pressure changes stay smooth
    // however many samples one frame writes
    const writeSample = (k: number, f = 1) => {
      const x = ((k % HIST) + HIST) % HIST;
      for (let ji = 0; ji < J; ji++) {
        const j = jets[ji];
        const a = (ji * 2 * HIST + x) * 4;
        tmpV.lerpVectors(j.prevVel, j.vel, f);
        histData[a] = tmpV.x;
        histData[a + 1] = tmpV.y;
        histData[a + 2] = tmpV.z;
        histData[a + 3] = j.open ? 1 : 0;
        const b = ((ji * 2 + 1) * HIST + x) * 4;
        histData[b] = j.land.x;
        histData[b + 1] = j.land.y;
        histData[b + 2] = j.flux;
        histData[b + 3] = j.burst;
      }
    };

    // start: velocities everywhere, the hero jet already flowing
    for (const j of jets) {
      launchVel(j, j.H, j.vel);
      j.prevVel.copy(j.vel);
    }
    for (let k = -HIST; k <= 1; k++) writeSample(k);
    lastK = 0;
    jets[0].active = true;
    jets[0].segs.push({ on: -10, off: Infinity });
    jets[0].open = true;
    nActive = 1;

    const tick = (frame: FrameContext, beat: boolean) => {
      const a = frame.audio;
      const p = frame.params;
      const maxJ = Math.round(num(p, 'jets', 5));
      const I = frame.analysis ? frame.feel.intensity : Math.min(1, a.energy * 1.3);
      const tension = Math.min(1, Math.max(a.build, frame.feel.tension));
      const builds = num(p, 'builds', 1);
      const cuts = num(p, 'cuts', 1);
      const grow = THREE.MathUtils.clamp(((I - 0.22) / 0.6) * builds + tension * 0.35 * builds, 0, 1);
      const want = a.playing ? Math.max(1, Math.min(maxJ, 1 + Math.round((maxJ - 1) * grow))) : Math.max(1, Math.min(maxJ, nActive));
      if (preDrop) return;
      if (nActive < want) {
        const j = jets[ORDER[nActive]];
        j.active = true;
        nActive++;
        if (j.mode === 'steady') openJet(j);
      } else if (nActive > want) {
        nActive--;
        const j = jets[ORDER[nActive]];
        j.active = false;
        j.openAt = -1;
        closeJet(j);
      }
      // a phrase in a verse: cut one jet cleanly, relaunch it a beat later
      if (beat && cuts > 0.3 && a.beatCount % 16 === 0 && I > 0.25 && I < 0.62) {
        const pool = ORDER.slice(0, nActive).filter((i) => jets[i].mode === 'steady');
        if (pool.length) {
          const j = jets[pool[phrase % pool.length]];
          phrase++;
          closeJet(j);
          j.openAt = clock + 60 / Math.max(60, a.bpm || 120);
        }
      }
    };

    return {
      render(frame, target) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        const pal = frame.palette.c;
        const setting = Math.max(0, SETTINGS.indexOf(str(p, 'setting', 'dusk')));
        const tscale = num(p, 'speed', 0.7);
        const sdt = dt * tscale;
        clock += dt;
        simT += sdt;
        envT += sdt;
        drop.step(frame);
        const dEnv = drop.env;
        const I = frame.analysis ? frame.feel.intensity : Math.min(1, a.energy * 1.3);
        const tension = Math.min(1, Math.max(a.build, frame.feel.tension));
        const cuts = num(p, 'cuts', 1);
        const maxJ = Math.round(num(p, 'jets', 5));
        kickEnv = Math.max(kickEnv * Math.exp(-dt * 8), a.kick);

        /* ── choreography ── */
        // modes: loud parts make some jets pulse on the kick / snare (each hit a new bolt)
        const loud = a.playing && cuts > 0.05 && I > 0.58 && tension < 0.45;
        if (frame.feel.sectionIndex !== lastSection) {
          lastSection = frame.feel.sectionIndex;
          phrase++;
        }
        for (let oi = 0; oi < J; oi++) {
          const j = jets[ORDER[oi]];
          let mode: Jet['mode'] = 'steady';
          if (loud && oi > 0) {
            const r = (oi + phrase) % 3;
            mode = r === 0 ? 'kick' : r === 1 && oi > 2 ? 'snare' : 'steady';
            if (cuts < 0.5 && mode === 'snare') mode = 'steady';
          }
          if (mode !== j.mode) {
            j.mode = mode;
            if (mode !== 'steady') closeJet(j);
            else if (j.active && !preDrop) j.openAt = clock;
          }
        }
        // the beat before a known drop: cut everything
        const toDrop = frame.feel.toDrop;
        if (cuts > 0.05 && a.playing && toDrop > 0.02 && toDrop < 0.55 && !preDrop && drop.since > 1) {
          preDrop = true;
          for (const j of jets) {
            closeJet(j);
            j.openAt = -1;
            j.closeAt = -1;
          }
        }
        // the drop: a volley of bolts from every jet, then they come back high and steady
        if (drop.since === 0) {
          preDrop = false;
          nActive = maxJ;
          dropBoost = 1;
          const beatS = 60 / Math.max(60, a.bpm || 120);
          for (let oi = 0; oi < J; oi++) {
            const j = jets[ORDER[oi]];
            j.active = oi < maxJ;
            if (!j.active) continue;
            if (cuts > 0.05) {
              closeJet(j);
              openJet(j);
              j.closeAt = clock + 0.3 / tscale;
              j.openAt = clock + beatS * 2;
            } else openJet(j);
          }
        }
        if (preDrop && toDrop > 1.5) preDrop = false; // the drop never came (seek, or a miss)
        // pulses
        const pulseLen = (0.13 + 0.12 * (1 - cuts)) / tscale;
        for (const j of jets) {
          if (!j.active || preDrop) continue;
          if ((j.mode === 'kick' && a.kickHit) || (j.mode === 'snare' && a.snareHit)) {
            closeJet(j);
            openJet(j);
            j.closeAt = clock + pulseLen;
          }
        }
        // timers
        for (const j of jets) {
          if (j.closeAt > 0 && clock >= j.closeAt) {
            j.closeAt = -1;
            closeJet(j);
          }
          if (j.openAt > 0 && clock >= j.openAt) {
            j.openAt = -1;
            if (j.active && j.mode === 'steady' && !preDrop) openJet(j);
          }
        }
        // jets join / leave one per beat (or every half second without a beat)
        if ((a.playing && a.beat) || clock - lastTick > (a.playing && a.bpm > 0 ? 2 : 0.6)) {
          lastTick = clock;
          tick(frame, a.playing && a.beat);
        }
        // a steady active jet that is somehow shut (after a phrase cut that got lost) comes back
        for (const j of jets) if (j.active && j.mode === 'steady' && !j.open && j.openAt < 0 && j.closeAt < 0 && !preDrop) j.openAt = clock + 0.4;

        /* ── pressure → arc height ── */
        dropBoost = Math.max(0, dropBoost - dt * 0.12);
        const builds = num(p, 'builds', 1);
        const arc = num(p, 'arc', 1);
        for (let ji = 0; ji < J; ji++) {
          const j = jets[ji];
          const target = SLOTS[ji].h * arc * (0.86 + 0.22 * I + 0.32 * tension * builds + 0.3 * dropBoost * builds);
          j.H = approach(j.H, Math.min(target, 1.9), 1.6, dt);
          launchVel(j, j.H, j.vel);
        }

        /* ── order: smoothness, roughened by loud parts and drops ── */
        const order = num(p, 'order', 0.86);
        rough = approach(rough, num(p, 'roughen', 0.35) * (Math.max(0, I - 0.5) * 0.6 + dEnv * 0.45 + a.flux * 0.1), 3, dt);
        const ord = THREE.MathUtils.clamp(order - rough, 0, 1);
        const quiet = 1 - THREE.MathUtils.smoothstep(I, 0.15, 0.45);

        /* ── landing: flux, foam, bolt arrivals ── */
        for (let ji = 0; ji < J; ji++) {
          const j = jets[ji];
          const uL = landingTime(ji);
          const prevUL = j.uL;
          j.uL = uL;
          const flowing = inWater(j, uL);
          j.flux = flowing ? 1 : 0;
          j.foam = approach(j.foam, j.flux, j.flux > j.foam ? 10 : 2.2, dt);
          // a piece of water's head reaching the pool: a plop and a crown of droplets
          let arrived = false;
          for (const s of j.segs) {
            const h = simT - s.on;
            const hp = h - sdt;
            if (hp < prevUL && h >= uL) arrived = true;
          }
          j.burst = Math.max(j.burst - dt * 4, arrived ? 1 : 0);
          if (arrived) {
            j.crownAt = simT;
            j.crownS = 0.75 + 0.5 * rnd();
            addDrop(j.land.x, j.land.y, 0.07, 0.03 * (1.4 - ord * 0.5));
          }
          // prune landed pieces
          j.segs = j.segs.filter((s) => s.off === Infinity || simT - s.off < uL + 0.1);
        }

        /* ── history ── */
        const nowK = Math.floor(simT / DELTA);
        if (nowK - lastK > HIST) lastK = nowK - HIST;
        const t0 = simT - sdt;
        for (let k = lastK + 1; k <= nowK; k++) writeSample(k, sdt > 0 ? THREE.MathUtils.clamp((k * DELTA - t0) / sdt, 0, 1) : 1);
        writeSample(nowK + 1); // provisional, so the newest stretch interpolates against now
        lastK = nowK;
        for (const j of jets) j.prevVel.copy(j.vel);
        histTex.needsUpdate = true;

        /* ── per-jet uniforms ── */
        const thick = num(p, 'thickness', 1);
        const glow = num(p, 'glow', 1);
        const pair = bool(p, 'pair', false);
        const lightLvl = glow * (setting === 1 ? 0.9 : setting === 2 ? 0.45 : 0.5) * (0.7 + 0.3 * I + 0.25 * dEnv + 0.1 * kickEnv);
        for (let ji = 0; ji < J; ji++) {
          const j = jets[ji];
          nozU[ji].set(j.noz.x, j.noz.y, j.noz.z, 0.016 * thick * (1 + 0.08 * ((ji * 0.37) % 1)));
          const segs = j.segs.slice(-MAX_SEG);
          for (let k = 0; k < MAX_SEG; k++) {
            const s = segs[k];
            const head = s ? simT - s.on : -10;
            const tail = s ? (s.off === Infinity ? -1 : simT - s.off) : -5;
            const v = segU[ji * 2 + (k >> 1)];
            if (k % 2 === 0) {
              v.x = head;
              v.y = tail;
            } else {
              v.z = head;
              v.w = tail;
            }
          }
          const visible = j.segs.length > 0;
          // Rayleigh-Plateau: how fast the ripples grow, and how big they start. Smooth flow keeps
          // them invisible; below ~0.3 they pinch the rod into drops before it lands
          const dis = 1 - ord;
          const growth = 0.6 + 9 * dis * dis;
          const seedA = (0.0008 + 0.03 * Math.pow(dis, 1.5)) * (1 - 0.5 * quiet);
          jetU[ji].set(j.uL + 0.08, growth, seedA, visible ? 1 : 0);
          j.light = approach(j.light, j.active ? 1 : 0.12, 2, dt);
          tmpC.copy(pair && ji % 2 === 1 ? pal.accent2 : pal.accent);
          linColor(tmpC, glowU[ji]).multiplyScalar(lightLvl * j.light * 1.6);
          landU[ji].set(j.land.x, j.land.y, j.foam, j.burst);
          nozLU[ji].set(j.noz.x, j.noz.z, j.light * (j.open ? 1 : 0.5), j.open ? 1 : 0);
          landDirU[ji].set(j.dir.x, j.dir.y, simT - j.crownAt, simT - j.crownAt < 2 ? 0.8 : 0);
          crownU[ji].set(j.land.x, j.land.y, j.crownS, 0);
        }
        jetLib.uNowK.value = (simT / DELTA) % HIST;
        jetLib.uNoiseNow.value = simT % 256;
        jetLib.uWob.value = (0.0035 + 0.03 * (1 - ord) * (1 - ord)) * (1 - 0.4 * quiet);
        jetLib.uGlowFade.value = 2.2;

        /* ── pool ── */
        const splash = 0.25 + 0.75 * (1 - ord);
        for (let ji = 0; ji < J; ji++) {
          const j = jets[ji];
          if (j.flux > 0) {
            const n = sdt * 60;
            for (let q = 0; q < Math.ceil(n); q++) {
              addDrop(j.land.x + (rnd() - 0.5) * 0.04, j.land.y + (rnd() - 0.5) * 0.04, 0.05, 0.0035 * (0.6 + splash));
              if (rnd() < splash * 0.8) addDrop(j.land.x + (rnd() - 0.5) * 0.4, j.land.y + (rnd() - 0.5) * 0.4, 0.045, 0.0012);
            }
          }
        }
        const steps = Math.max(1, Math.round(sdt * 100));
        const su = simMat.uniforms;
        for (let s = 0; s < steps; s++) {
          for (let i = 0; i < MAX_DROPS; i++) {
            const d = s === 0 ? pending[i] : undefined;
            if (d) drops[i].copy(d);
            else drops[i].set(0, 0, 1, 0);
          }
          su.tSim.value = simA.texture;
          simQuad.render(renderer, simB);
          const t = simA;
          simA = simB;
          simB = t;
        }
        pending.length = 0;

        /* ── camera ── */
        const drift = num(p, 'drift', 0.4);
        const tanY0 = Math.tan((30 * Math.PI) / 360);
        const needY = Math.tan((54 * Math.PI) / 360) / Math.max(frame.aspect, 0.1);
        const ty = Math.min(Math.max(tanY0, needY), Math.tan((96 * Math.PI) / 360));
        const fov = (Math.atan(ty) * 360) / Math.PI;
        camera.fov = fov;
        camera.aspect = frame.aspect;
        camera.position.set(Math.sin(clock * 0.045) * 0.22 * drift, 0.36 + Math.sin(clock * 0.07) * 0.03 * drift, 3.5 - 0.12 * tension * builds);
        const lookY = 0.42 + (ty - tanY0) * 0.9;
        camera.lookAt(Math.sin(clock * 0.045 + 0.6) * 0.1 * drift, lookY, -0.9);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        mirrorCam.projectionMatrix.copy(camera.projectionMatrix);
        mirrorCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
        mirrorCam.matrixWorld.multiplyMatrices(flipY, camera.matrixWorld);
        mirrorCam.matrixWorldInverse.copy(mirrorCam.matrixWorld).invert();
        viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

        /* ── colours (linear) per setting ── */
        envU.uSetting.value = setting;
        envU.uEnvT.value = envT;
        const L = LAMPS[SETTINGS[setting]];
        for (let i = 0; i < 8; i++) {
          const l = L[i];
          if (l) lampU[i].set(l[0], l[1], l[2], l[3]);
          else lampU[i].set(0, 0, 0, 0);
        }
        if (setting === 0) {
          linColor(pal.bg, envU.uSkyTop.value).multiplyScalar(0.55);
          tmpC.copy(pal.bg).lerp(pal.accent2, 0.42);
          linColor(tmpC, envU.uSkyHor.value).multiplyScalar(1.25);
          linColor(pal.accent2, envU.uSkyGlow.value).multiplyScalar(0.9);
          linColor(pal.muted, envU.uFoliage.value).multiplyScalar(0.14);
          tmpC.copy(pal.fg).lerp(pal.accent2, 0.55);
          linColor(tmpC, envU.uLampCol.value).multiplyScalar(14);
          tmpC.copy(pal.muted).lerp(pal.fg, 0.3);
          linColor(tmpC, envU.uStone.value).multiplyScalar(0.6);
        } else if (setting === 1) {
          linColor(pal.bg, envU.uSkyTop.value).multiplyScalar(0.5);
          tmpC.copy(pal.bg).lerp(pal.accent2, 0.2);
          linColor(tmpC, envU.uSkyHor.value).multiplyScalar(0.8);
          linColor(pal.accent2, envU.uSkyGlow.value).multiplyScalar(0.12);
          linColor(pal.muted, envU.uFoliage.value).multiplyScalar(0.3);
          tmpC.copy(pal.fg).lerp(pal.accent2, 0.35);
          linColor(tmpC, envU.uLampCol.value).multiplyScalar(18);
          tmpC.copy(pal.muted).lerp(pal.fg, 0.2);
          linColor(tmpC, envU.uStone.value).multiplyScalar(0.5);
        } else {
          linColor(pal.bg, envU.uSkyTop.value).multiplyScalar(1.1);
          linColor(pal.bg, envU.uSkyHor.value).multiplyScalar(0.8);
          envU.uSkyGlow.value.set(0, 0, 0);
          linColor(pal.muted, envU.uFoliage.value).multiplyScalar(0.3);
          linColor(pal.fg, envU.uLampCol.value).multiplyScalar(8);
          tmpC.copy(pal.muted).lerp(pal.bg, 0.4);
          linColor(tmpC, envU.uStone.value).multiplyScalar(0.5);
        }
        linColor(pal.fg, envU.uKeyCol.value);
        tmpC.copy(pal.accent2).lerp(pal.fg, 0.4);
        linColor(tmpC, envU.uWinCol.value).multiplyScalar(2.2);
        envU.uFocus.value = camera.position.z - 0.2;

        /* ── targets ── */
        const w = frame.width;
        const h = frame.height;
        if (!bgRT || bgRT.width !== w || bgRT.height !== h) {
          bgRT?.dispose();
          sceneRT?.dispose();
          reflRT?.dispose();
          b1?.dispose();
          b2?.dispose();
          b3?.dispose();
          b4?.dispose();
          bgRT = makeRenderTarget(w, h);
          sceneRT = makeRenderTarget(w, h, { depthBuffer: true });
          reflRT = makeRenderTarget(Math.max(2, w >> 1), Math.max(2, h >> 1), { depthBuffer: true });
          b1 = makeRenderTarget(Math.max(2, w >> 2), Math.max(2, h >> 2));
          b2 = makeRenderTarget(Math.max(2, w >> 2), Math.max(2, h >> 2));
          b3 = makeRenderTarget(Math.max(2, w >> 3), Math.max(2, h >> 3));
          b4 = makeRenderTarget(Math.max(2, w >> 3), Math.max(2, h >> 3));
        }
        const pxK = (2 * Math.tan((fov * Math.PI) / 360)) / h;

        /* ── jet / splash uniforms ── */
        syncMaterial(jetMat, frame, params);
        syncMaterial(spMat, frame, params);
        const ju = jetMat.uniforms;
        ju.tBg.value = bgRT.texture;
        (ju.uViewProj.value as THREE.Matrix4).copy(viewProj);
        ju.uAtt.value = setting === 1 ? 0.35 : 0.55;
        ju.uMicro.value = 0.022 + 0.2 * (1 - ord) * (1 - ord);
        ju.uBubbles.value = Math.min(0.85, 0.12 + 0.35 * a.air + 0.15 * a.hat + 0.45 * (1 - ord));
        ju.uScatter.value = 0.06 + 0.1 * (1 - ord);
        const spu = spMat.uniforms;
        spu.uSplash.value = splash;
        spu.uShutter.value = 1 / 70;

        const r = renderer;
        r.setClearColor(0x000000, 0);

        /* reflection: the jets mirrored in the pool (half size) */
        ju.uReflPass.value = 1;
        ju.uPxK.value = pxK * 2;
        spu.uPxK.value = pxK * 2;
        r.setRenderTarget(reflRT);
        r.clear(true, true, false);
        r.render(fg, mirrorCam);

        /* world */
        syncMaterial(worldMat, frame, params);
        const wu = worldMat.uniforms;
        (wu.uCamPos.value as THREE.Vector3).copy(camera.position);
        (wu.uCamBasis.value as THREE.Matrix3).setFromMatrix4(camera.matrixWorld);
        (wu.uTanHalf.value as THREE.Vector2).set(ty * frame.aspect, ty);
        wu.tSim.value = simA.texture;
        wu.tRefl.value = reflRT!.texture;
        wu.uHScale.value = 1.0;
        wu.uCalm.value = (0.00025 + 0.0006 * (1 - ord) + 0.0005 * frame.feel.gust) * (1 - 0.5 * quiet);
        wu.uRough.value = 1 - ord;
        wu.uReflWarp.value = 0.1;
        tmpC.copy(pal.fg);
        linColor(tmpC, wu.uFoamCol.value as THREE.Vector3).multiplyScalar(setting === 2 ? 0.9 : 0.35);
        tmpC.copy(pal.accent).lerp(pal.bg, 0.5);
        linColor(tmpC, wu.uWaterCol.value as THREE.Vector3);
        worldQuad.render(r, bgRT);

        /* the scene: world, then the rods and the splash over it */
        shared.blit(bgRT.texture, sceneRT);
        ju.uReflPass.value = 0;
        ju.uPxK.value = pxK;
        spu.uPxK.value = pxK;
        r.setRenderTarget(sceneRT);
        r.clear(false, true, false);
        const autoClear = r.autoClear;
        r.autoClear = false;
        r.render(fg, camera);
        r.autoClear = autoClear;

        /* bloom */
        const bu = brightMat.uniforms;
        bu.tSrc.value = sceneRT!.texture;
        (bu.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
        bu.uThr.value = setting === 2 ? 1.6 : 0.9;
        brightQuad.render(r, b1);
        const bl = blurMat.uniforms;
        bl.tSrc.value = b1!.texture;
        (bl.uDir.value as THREE.Vector2).set(1 / b1!.width, 0);
        blurQuad.render(r, b2);
        bl.tSrc.value = b2!.texture;
        (bl.uDir.value as THREE.Vector2).set(0, 1 / b1!.height);
        blurQuad.render(r, b1);
        bl.tSrc.value = b1!.texture;
        (bl.uDir.value as THREE.Vector2).set(2 / b3!.width, 0);
        blurQuad.render(r, b3);
        bl.tSrc.value = b3!.texture;
        (bl.uDir.value as THREE.Vector2).set(0, 2 / b3!.height);
        blurQuad.render(r, b4);

        const cu = compMat.uniforms;
        cu.tScene.value = sceneRT!.texture;
        cu.tBloom.value = b1!.texture;
        cu.tBloom2.value = b4!.texture;
        cu.uExposure.value = (setting === 1 ? 1.0 : setting === 2 ? 0.85 : 1.05) * (1 + 0.08 * dEnv);
        cu.uBloomK.value = setting === 2 ? 0.35 : 0.7;
        cu.uGrain.value = num(p, 'grain', 0.022);
        cu.uTime.value = frame.time;
        cu.uVig.value = setting === 2 ? 0.2 : 0.35;
        compQuad.render(r, target);
      },
      dispose() {
        histTex.dispose();
        jetGeo.dispose();
        jetMat.dispose();
        spGeo.dispose();
        spMat.dispose();
        simA.dispose();
        simB.dispose();
        simMat.dispose();
        simQuad.dispose();
        worldMat.dispose();
        worldQuad.dispose();
        brightMat.dispose();
        blurMat.dispose();
        compMat.dispose();
        brightQuad.dispose();
        blurQuad.dispose();
        compQuad.dispose();
        bgRT?.dispose();
        sceneRT?.dispose();
        reflRT?.dispose();
        b1?.dispose();
        b2?.dispose();
        b3?.dispose();
        b4?.dispose();
      },
    };
  },
};
