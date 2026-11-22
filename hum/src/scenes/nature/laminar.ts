import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl';
import { createFullscreenQuad, makeRenderTarget } from '../../core/sceneHelpers';
import type { FrameContext, ParamDef, SceneDef } from '../../core/types';
import { bool, num, str } from '../../core/uniforms';
import { approach, makeMaterial, stepDt, syncMaterial } from '../three/common';
import { quality } from '../../render/quality';
import { DropTimer, TONEMAP_LIB, linColor } from './volume';

/**
 * Laminar: glass rods of water arcing over a dark reflecting pool. Water moving so smoothly it reads
 * as still: a laminar fountain, done physically.
 *
 *   - every jet is a stream of water parcels, each on its own parabola from the nozzle. The valve's
 *     launch velocity and on/off state go into a short history (a texture), so the rod is the locus
 *     of parcels launched at different moments: raise the pressure and the new arc grows out of the
 *     nozzle while the old one is still landing; shut the valve and the cut-off piece flies on along
 *     the arc as a glass bolt with rounded ends; turn the nozzle and the stream bends as it sweeps
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
 *     fall back, loud kicks shiver it; it mirrors the sky, the lights and the jets (planar
 *     reflection) over a black floor
 *   - behind it, a world full of out-of-focus lights: lanterns in the garden, string lights over the
 *     plaza, streetlights down a city street with traffic drifting along it. They are bokeh discs
 *     (a wide lens focused on the fountain), they breathe with the song, twinkle on the hats, dim as
 *     the song winds up and flare on the drop, and the pool and the rods reflect them
 *   - four places: a dusk garden, a plaza at night, a city street at night, a clean studio
 *
 * Music: a choreographer, not a loop. Each phrase (16 beats, or a new part of the song) it picks a
 * new pattern, seeded by the song so the same song plays the same show:
 *   weave · duet       quiet parts: two or three long arcs crossing, slowly turning, now and then a
 *                      stream cut and relaunched, a small jet hopping on the odd note
 *   leapfrog           bolts hop from nozzle to nozzle around the pool, one per beat (or per hat)
 *   call               jets on the left answer jets on the right: kick, snare, kick, snare
 *   criss              pairs of streams crossing in X's; loud parts chop them on the kick
 *   cascade            a row of nozzles firing one after another on every bar
 *   scatter            nozzles everywhere, each hat a bolt in a new direction
 *   fan                a peacock of streams opening from one spot, breathing on the kick
 *   rise               the build: jets gather, climb, thin and tremble, the lights dim; the beat
 *                      before the drop cuts everything, the drop fires a volley of bolts
 * Hops are gated by the sound itself: a bolt stays open while its kick / snare / hat / note rings,
 * so staccato hits throw short beads and held notes long rods. Loudness drives the glow, the splash
 * and how much the pool churns.
 *
 * Palette roles: bg = sky / backdrop, fg = light (lamps, highlights), accent = the jets' inner
 * light and the cool lights, accent2 = warm lamps, horizon glow and the second jet colour, muted =
 * foliage and stone.
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
      { value: 'city', label: 'City night' },
      { value: 'studio', label: 'Studio' },
    ],
  },
  { id: 'jets', label: 'Jets', group: 'Shape', type: 'number', min: 2, max: 10, step: 1, default: 8, hint: 'Most jets at once (quiet parts keep to two or three)' },
  { id: 'order', label: 'Smoothness', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.86, hint: 'Glass-smooth laminar flow (1) or rippling, breaking, turbulent water (0)' },
  { id: 'arc', label: 'Arc height', group: 'Shape', type: 'number', min: 0.5, max: 1.6, step: 0.01, default: 1 },
  { id: 'thickness', label: 'Thickness', group: 'Shape', type: 'number', min: 0.6, max: 1.8, step: 0.01, default: 1 },
  { id: 'glow', label: 'Inner light', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Light from the nozzle travels inside the stream like fibre optic' },
  { id: 'pair', label: 'Two-colour jets', group: 'Color', type: 'bool', default: false, hint: 'Every other jet is lit with the second accent' },
  { id: 'bokeh', label: 'Background lights', group: 'Color', type: 'number', min: 0, max: 1.6, step: 0.01, default: 1, hint: 'Out-of-focus lanterns, string lights and streetlights behind the fountain' },
  { id: 'surprise', label: 'Surprise', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'A new pattern every phrase, jets hopping on the beat in new directions (1), or calm steady arcs (0)' },
  { id: 'cuts', label: 'Beat cuts', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'Jets cut into flying glass bolts on kicks, snares, hats and drops' },
  { id: 'builds', label: 'Build response', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Jets gather, climb and tremble as the song winds up' },
  { id: 'roughen', label: 'Loud roughens', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, hint: 'Loud parts and drops stir the flow out of perfect order' },
  { id: 'speed', label: 'Speed', group: 'Motion', type: 'number', min: 0.3, max: 1, step: 0.01, default: 0.7, hint: '1 = real time; lower is slow motion' },
  { id: 'drift', label: 'Camera drift', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
  { id: 'grain', label: 'Film grain', group: 'Color', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.022 },
];

const J = 10; // jet slots
const J_LITE = 6; // jet slots when the quality governor is easing off
const RINGS = 320; // ribbon rings along each jet
const HIST = 192; // launch history samples per jet
const DELTA = 1 / 60; // seconds of sim time between history samples
const MAX_SEG = 6; // pieces of water in flight per jet
const PER = 260; // splash particles per jet
const MAX_DROPS = 24;
const SIM_W = 384;
const SIM_H = 320;
const SIM_MIN = new THREE.Vector2(-4, -3.4);
const SIM_SIZE = new THREE.Vector2(8, 6.8);
const POOL_FAR = 3.2; // far edge of the pool (z = -POOL_FAR)
const G = 9.81;
const TAU = Math.PI * 2;

/* the city street: two rows of streetlamps receding from z = STREET_Z0, every STREET_S metres */
const STREET_X = 4.2;
const STREET_Y = 3.0;
const STREET_Z0 = -19;
const STREET_S = 8;
const STREET_N = 11;

/* ───────────────────────── GLSL ───────────────────────── */

/** The surroundings as a function of a ray: sky, trees, hedge, lanterns (dusk); towers, park and
 *  string lights (night); a street of lamps and traffic between towers (city); a cyclorama and
 *  softboxes (studio). Parallax-correct: rays start where they start. */
const ENV = /* glsl */ `
uniform float uSetting;
uniform vec3 uSkyTop, uSkyHor, uSkyGlow, uFoliage, uLampCol, uStone, uKeyCol, uWinCol;
uniform vec4 uLamps[8];
uniform float uEnvT, uFocus, uAperture;
uniform vec4 uBok;        // x gain, y sparkle seed, z sparkle amount, w drop flare
uniform float uBokAp, uBokLite;
uniform vec3 uBokWarm, uBokCool, uBokRed, uBokWhite;

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

/* ── bokeh: lights far out of focus, as soft discs with a faint bright rim ── */

// how bright light number id is now: its own slow breath, a twinkle when the hats pick it, the flare
float lmTw(float id) {
  float h = hash11(id * 0.731 + 4.1);
  float br = 0.7 + 0.3 * sin(uEnvT * (0.3 + 0.8 * h) + h * 40.0);
  float sp = step(hash11(id * 1.37 + uBok.y), 0.16) * uBok.z;
  return uBok.x * (br + sp * 1.6) + uBok.w;
}
// one light at L seen along the ray: its disc (and, for a lamp in the haze, a glow around it)
float lmDisc(vec3 ro, vec3 rd, vec3 L, float b, float haze, float sz) {
  vec3 toL = L - ro;
  float tl = dot(toL, rd);
  if (tl <= 0.3) return 0.0;
  float d = length(toL - rd * tl);
  float rc = max(uBokAp * sz * lmSharp * abs(tl - uFocus) / uFocus, 0.0035 * tl);
  float x = d / rc;
  float disc = smoothstep(1.0, 0.84, x) * (0.7 + 0.3 * smoothstep(0.25, 0.93, x));
  return b / (1.0 + tl * tl * 0.0008) * (disc + haze * exp(-x * 0.8) * 0.07);
}
// lights scattered on a ring (radius R around c): lanterns among trees, windows across a city
vec3 lmRing(vec3 ro, vec3 rd, vec2 c, float R, float y0, float y1, float cells, float dens, float warm, float seed) {
  float t = lmCyl(ro, rd, c, R);
  if (t <= 0.0) return vec3(0.0);
  vec3 p = ro + rd * t;
  float s = atan(p.x - c.x, -(p.z - c.y)) / TAU * cells;
  float i0 = floor(s);
  vec3 acc = vec3(0.0);
  for (int k = -1; k <= 1; k++) {
    float ci = i0 + float(k);
    for (int q = 0; q < 2; q++) {
      float iq = ci + float(q) * 0.5 + seed * 1000.0;
      if (hash11(iq * 0.917 + seed) > dens) continue;
      float az = (ci + 0.1 + 0.8 * hash11(iq * 1.71 + seed)) / cells * TAU;
      vec3 L = vec3(c.x + R * sin(az), mix(y0, y1, hash11(iq * 2.37 + seed)), c.y - R * cos(az));
      float h = hash11(iq * 4.7 + seed);
      vec3 cl = h < warm ? uBokWarm : (h < warm + (1.0 - warm) * 0.8 ? uBokCool : uBokWhite);
      // most are faint, a few burn: the way lights scatter through trees or across a city
      float hb = hash11(iq * 3.11 + seed);
      acc += cl * lmDisc(ro, rd, L, (0.12 + 0.95 * hb * hb * hb) * lmTw(iq), 0.0, 0.55 + 0.7 * hash11(iq * 5.3 + seed));
    }
  }
  return acc;
}
// a row of lights along -z from P0, every S metres (n of them), moved along by 'travel' metres
vec3 lmRow(vec3 ro, vec3 rd, vec3 P0, float S, float n, float travel, vec3 cl, float b, float haze, float dens, float seed) {
  // closest approach of the ray to the row's line
  vec3 w0 = ro - P0;
  float bb = -rd.z;
  float dd = dot(rd, w0);
  float den = max(1.0 - bb * bb, 1e-4);
  float sl = (-w0.z - bb * dd) / den;
  float off = mod(travel, S);
  float base = floor(travel / S);
  float k0 = floor((sl - off) / S + 0.5);
  vec3 acc = vec3(0.0);
  for (int q = -2; q <= 2; q++) {
    float k = k0 + float(q);
    if (k < 0.0 || k >= n) continue;
    float id = k - base + seed * 100.0;
    if (hash11(id * 0.61 + seed) > dens) continue;
    vec3 L = P0 + vec3(0.0, 0.0, -(S * k + off));
    // the far ones fade into the haze, so a row reads as dots running away, not as a bar
    acc += cl * lmDisc(ro, rd, L, b * lmTw(id) * exp(-(S * k + off) * 0.035), haze, 0.75);
  }
  return acc;
}
// a strand of string lights at depth z, sagging between poles every 'span' metres
vec3 lmStrand(vec3 ro, vec3 rd, float z, float y, float sag, float span, float bulb, float x0, float x1, float seed) {
  if (abs(rd.z) < 1e-4) return vec3(0.0);
  float t = (z - ro.z) / rd.z;
  if (t <= 0.0) return vec3(0.0);
  float px = ro.x + rd.x * t;
  float k0 = floor(px / bulb + 0.5);
  vec3 acc = vec3(0.0);
  for (int q = -1; q <= 1; q++) {
    float k = k0 + float(q);
    float x = k * bulb;
    if (x < x0 || x > x1) continue;
    float u = fract((x - x0) / span) * 2.0 - 1.0;
    vec3 L = vec3(x, y - sag * (1.0 - u * u), z);
    float h = hash11(k * 1.3 + seed);
    vec3 cl = h < 0.78 ? uBokWarm : (h < 0.9 ? uBokCool : uBokRed);
    acc += cl * lmDisc(ro, rd, L, 0.42 * lmTw(k + seed * 7.0), 0.0, 0.5);
  }
  return acc;
}

// a ring of towers at radius R around (0, cz), with a gap for a street (|x| < gap)
vec3 lmTowers(vec3 ro, vec3 rd, vec3 col, vec3 sky, float R, float cz, float hmin, float hvar, float gap, float haze, float litT, float winK) {
  float tb = lmCyl(ro, rd, vec2(0.0, cz), R);
  if (tb <= 0.0) return col;
  vec3 p = ro + rd * tb;
  float az = atan(p.x, -(p.z - cz));
  float s = az * R / 7.0;
  float cell = floor(s);
  float fx = fract(s);
  float tall = hash11(cell * 1.37 + 3.0 + R);
  float hb = hmin + hvar * tall * tall * hash11(cell * 0.71 + 9.0 + R) + 3.0 * hash11(cell + R);
  float gp = step(0.08, fx) * step(fx, 0.92 - 0.3 * hash11(cell * 5.3));
  float coc = lmCoc(tb);
  float m = (1.0 - smoothstep(hb - coc, hb + coc, p.y)) * smoothstep(0.0, 0.08, gp + (1.0 - step(0.5, hash11(cell * 2.9))));
  if (gap > 0.0) m *= smoothstep(gap, gap + coc + 0.4, abs(p.x));
  vec3 facade = uFoliage * 0.12 + sky * 0.12;
  vec2 g = vec2(fx * 7.0, p.y / 1.4);
  vec2 gi = floor(g);
  vec2 gf = fract(g);
  float hf = hash21(gi + cell * 17.0);
  float lit = step(litT - 0.1 * hash11(gi.y + cell), hf) * step(gi.y + 1.0, hb / 1.4 - 0.5);
  float ww = min(coc * 0.6, 0.2);
  float win = smoothstep(0.28 + ww, 0.28 - ww, abs(gf.x - 0.5)) * smoothstep(0.26 + ww, 0.26 - ww, abs(gf.y - 0.5));
  vec3 wc = mix(uWinCol, uKeyCol * 1.6, step(0.7, hash21(gi * 1.7 + cell)));
  facade += wc * lit * win * (0.25 + 0.6 * hash21(gi * 3.1 + cell)) * 0.7 * winK * (0.7 + 0.3 * min(uBok.x, 1.5));
  facade = mix(facade, sky * 0.9, haze);
  return mix(col, facade, m);
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
  // lanterns and fairy lights hung in the trees, far out of focus
  bool bok = uBok.x + uBok.w > 0.001;
  if (bok) {
    col += lmRing(ro, rd, vec2(0.0, -1.0), 15.0, 1.6, 4.2, 100.0, 0.24, 0.85, 1.0);
    if (uBokLite < 0.5) col += lmRing(ro, rd, vec2(0.0, -1.0), 11.5, 1.5, 3.4, 90.0, 0.2, 0.9, 2.0);
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
  // a strand of lights strung along in front of the hedge
  if (bok && uBokLite < 0.5) col += lmStrand(ro, rd, -6.6, 1.95, 0.3, 3.4, 0.8, -7.0, 7.0, 3.0);
  return lmLamps(ro, rd, col);
}

vec3 lmNight(vec3 ro, vec3 rd) {
  vec3 sky = lmSky(rd);
  vec3 col = sky;
  // a city far off: towers of varied height, a few windows still lit, the city's lights low between them
  col = lmTowers(ro, rd, col, sky, 42.0, -2.0, 5.0, 16.0, 0.0, 0.0, 0.8, 1.0);
  bool bok = uBok.x + uBok.w > 0.001;
  if (bok) col += lmRing(ro, rd, vec2(0.0, -2.0), 30.0, 0.6, 4.5, 120.0, 0.28, 0.55, 4.0) * 0.7;
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
  if (bok) {
    // lamps along the park paths, and string lights over the plaza
    col += lmRing(ro, rd, vec2(0.0, -1.0), 11.0, 0.9, 3.2, 100.0, 0.22, 0.8, 5.0);
    col += lmStrand(ro, rd, -7.4, 2.75, 0.5, 4.6, 0.95, -8.0, 8.0, 6.0);
    if (uBokLite < 0.5) col += lmStrand(ro, rd, -5.0, 2.25, 0.35, 3.8, 0.85, -6.0, 6.0, 7.0);
  }
  return lmLamps(ro, rd, col);
}

vec3 lmCity(vec3 ro, vec3 rd) {
  vec3 sky = lmSky(rd);
  vec3 col = sky;
  bool bok = uBok.x + uBok.w > 0.001;
  // the far city in haze, at the end of the street
  col = lmTowers(ro, rd, col, sky, 75.0, -2.0, 8.0, 24.0, 0.0, 0.35, 0.8, 0.5);
  if (bok) col += lmRing(ro, rd, vec2(0.0, -2.0), 50.0, 0.4, 7.0, 110.0, 0.2, 0.5, 8.0) * 0.5;
  // towers either side of the street
  col = lmTowers(ro, rd, col, sky, 32.0, -2.0, 8.0, 20.0, 6.2, 0.0, 0.86, 0.35);
  if (bok) {
    // shop fronts and windows low down, out of focus
    col += lmRing(ro, rd, vec2(0.0, -2.0), 20.0, 0.5, 3.5, 110.0, 0.18, 0.6, 9.0) * 0.7;
    // streetlamps both sides, receding to the vanishing point
    col += lmRow(ro, rd, vec3(-${STREET_X.toFixed(2)}, ${STREET_Y.toFixed(2)}, ${STREET_Z0.toFixed(1)}), ${STREET_S.toFixed(1)}, ${STREET_N.toFixed(1)}, 0.0, uLampCol * 0.06, 0.7, 0.45, 1.0, 10.0);
    col += lmRow(ro, rd, vec3(${STREET_X.toFixed(2)}, ${STREET_Y.toFixed(2)}, ${STREET_Z0.toFixed(1)}), ${STREET_S.toFixed(1)}, ${STREET_N.toFixed(1)}, 0.0, uLampCol * 0.06, 0.7, 0.45, 1.0, 11.0);
    // traffic: tail lights going away, headlights coming
    col += lmRow(ro, rd, vec3(1.1, 0.55, -12.0), 7.0, 12.0, uEnvT * 6.0, uBokRed, 0.9, 0.3, 0.55, 12.0);
    if (uBokLite < 0.5) col += lmRow(ro, rd, vec3(-1.1, 0.6, -12.0), 9.0, 10.0, -uEnvT * 5.0, uBokWhite, 0.8, 0.5, 0.45, 13.0);
    // string lights across the street, over the plaza
    col += lmStrand(ro, rd, -8.5, 3.4, 0.55, 5.0, 0.95, -6.0, 6.0, 14.0);
    if (uBokLite < 0.5) col += lmStrand(ro, rd, -14.0, 4.0, 0.6, 6.0, 1.0, -5.5, 5.5, 15.0);
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

// anything above the water: the setting's surroundings (0 dusk, 1 night, 2 city, 3 studio)
vec3 lmUp(vec3 ro, vec3 rd) {
  if (uSetting < 0.5) return lmDusk(ro, rd);
  if (uSetting < 1.5) return lmNight(ro, rd);
  if (uSetting < 2.5) return lmCity(ro, rd);
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
uniform float uNowK, uHistN, uDelta, uNoiseNow, uWob, uTrem;
uniform vec3 uGrav;
uniform vec4 uNoz[${J}];      // nozzle xyz, w = radius
uniform vec4 uSeg[${(J * MAX_SEG) / 2}];  // ${MAX_SEG} pieces of water per jet as (head, tail) in flight time; tail < 0 = still attached
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
  // every nozzle is a little different: its own wobble, plus a slow wander of its own
  float wk = 0.55 + 0.9 * fract(sin(float(j) * 12.9898) * 43758.5453);
  float w1 = tnoise(vec2(L * 1.7, float(j) * 13.1)) - 0.5 + 0.8 * (tnoise(vec2(L * 0.31 + 17.0, float(j) * 4.3)) - 0.5);
  float w2 = tnoise(vec2(L * 2.3 + 51.0, float(j) * 7.7)) - 0.5;
  v += (side * w1 + vec3(0.0, w2 * 0.6, 0.0)) * uWob * wk * length(v);
  // held breath before a drop: a fine fast tremble at the nozzle, carried out along the arc
  if (uTrem > 0.0) {
    float t1 = tnoise(vec2(L * 15.0, float(j) * 3.7 + 90.0)) - 0.5;
    float t2 = tnoise(vec2(L * 19.0 + 33.0, float(j) * 5.1)) - 0.5;
    v += (side * t1 + vec3(0.0, t2, 0.0)) * uTrem * length(v);
  }
  return uNoz[j].xyz + v * u + 0.5 * uGrav * u * u;
}
// signed distance (in flight time) to the nearest end of a piece of water; >0 inside one
float lmSeg(int j, float u, out float uEnd, out float glow) {
  float best = -1e9;
  uEnd = -10.0;
  glow = 0.0;
  for (int k = 0; k < ${MAX_SEG}; k++) {
    vec4 s = uSeg[j * ${MAX_SEG / 2} + k / 2];
    vec2 ht = (k & 1) == 0 ? s.xy : s.zw;
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
varying float vR, vRb, vU, vSpeed, vDrds, vJet, vA;
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
  float v0 = length(lmVel(j, u));
  // continuity: the stream fattens where it slows at the top of the arc and slims as it falls
  // again; and it leaves the nozzle through a small swelling (the meniscus at the orifice)
  float cont = clamp(sqrt(v0 / max(spd, 0.05)), 0.8, 1.45);
  float bulge = 1.0 + 0.6 * exp(-u * v0 / (2.4 * r0));
  float rb = r0 * cont * bulge;
  // Rayleigh-Plateau: varicose ripples (wavelength ~9 radii) that grow with flight time
  float L = uNoiseNow - u;
  float fL = v0 / (9.0 * r0);
  float amp = Jp.z * exp(Jp.y * u) * (0.35 + 1.3 * tnoise(vec2(L * 1.3, float(j) * 5.0 + 20.0)));
  amp = min(amp, 1.5);
  float ph = TAU * fL * L + 3.0 * tnoise(vec2(L * 0.9, float(j) * 3.0 + 60.0));
  float r = rb * max(0.0, 1.0 + amp * sin(ph));
  float drds = -rb * amp * cos(ph) * TAU * fL / max(spd, 0.1);
  float uEnd, glow;
  float d = lmSeg(j, u, uEnd, glow) * spd;
  float margin = rb * 1.8 + 3.0 * du * spd;
  float wid = (Jp.w > 0.5 && d > -margin) ? rb * (1.0 + amp) * 1.2 : 0.0;
  vec3 toC = c - cameraPosition;
  float dist = length(toC);
  if (wid > 0.0) wid += 1.5 * uPxK * dist;
  vec3 sideV = normalize(cross(tg, toC / dist));
  vec3 wp = c + sideV * position.y * wid;
  vWorld = wp;
  vC = c;
  vT = tg;
  vR = r;
  vRb = rb;
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
varying float vR, vRb, vU, vSpeed, vDrds, vJet, vA;
uniform float uCoreFade, uSpecK;

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
  float rc = vRb * 1.05;
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
  float thick = clamp(path / (2.0 * max(r, rc * 0.5)), 0.0, 1.0);
  float scat = uScatter + 1.6 * min(vA, 1.0) + abs(m1) * micro * 4.0;
  // guided light shows as a thin hot core, brightest just out of the nozzle and fading along the
  // arc; surface flaws, the TIR rims and the broken ends of a bolt let some out. The rest of the
  // rod stays clear glass
  float nearN = exp(-max(uf, 0.0) * uCoreFade);
  float ax = dAx / max(r, 1e-4);
  float core = exp(-ax * ax * 14.0) * (0.6 + 0.4 * nearN);
  col += gc * (core * (0.02 + 0.9 * nearN) + scat * thick * 0.12 + trapped * 0.02 + (capped ? 0.35 * thick : 0.0));

  // the lamps: sharp glints off the surface (strongest at grazing angles, so lamps behind the jets
  // draw bright rims) and lamps seen straight through the rod, focused to a hot point by the lens
  vec3 spec = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    vec4 Lm = uLamps[i];
    if (Lm.w <= 0.0) continue;
    vec3 Ld = normalize(Lm.xyz - P);
    vec3 hv = normalize(Ld - rd);
    float ndh = max(dot(n, hv), 0.0);
    float Fh = min(0.02 + 0.98 * pow(1.0 - max(dot(Ld, hv), 0.0), 5.0), 0.35);
    // (the pool's half-size reflection only gets the soft lobe: sharp glints would alias into beads)
    spec += Lm.w * Fh * (uReflPass > 0.5 ? pow(ndh, 50.0) * 0.25 : pow(ndh, 420.0) * 3.0 + pow(ndh, 50.0) * 0.06);
    spec += Lm.w * pow(max(dot(rd3, Ld), 0.0), 900.0) * 0.35 * (1.0 - trapped);
  }
  col += uLampCol * spec * uSpecK;

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
  float len = max(abs(vQ.x) - 1.0, 0.0);
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
        float tH = uSetting < 1.5 ? lmCyl(ro, rd, vec2(0.0, -1.0), uSetting < 0.5 ? 8.6 : 15.0) : uSetting < 2.5 ? lmCyl(ro, rd, vec2(0.0, -2.0), 32.0) : lmCyl(ro, rd, vec2(0.0, -1.5), 7.0);
        // the city's street runs on between the towers, to the horizon
        if (uSetting > 1.5 && uSetting < 2.5 && abs(ro.x + rd.x * tH) < 6.2) tH = -1.0;
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
          } else if (uSetting > 1.5 && uSetting < 2.5) {
            // wet asphalt: the streetlamps pool on it and it mirrors the street, the reflections
            // smeared into long streaks; far off it fades into the haze
            for (int s = 0; s < 2; s++) {
              float sx = s == 0 ? -${STREET_X.toFixed(2)} : ${STREET_X.toFixed(2)};
              float k = clamp(floor((${STREET_Z0.toFixed(1)} - q.z) / ${STREET_S.toFixed(1)} + 0.5), 0.0, ${(STREET_N - 1).toFixed(1)});
              vec3 d = q - vec3(sx, ${STREET_Y.toFixed(2)}, ${STREET_Z0.toFixed(1)} - k * ${STREET_S.toFixed(1)});
              lit += uLampCol * uBok.x * 0.025 / (dot(d, d) + 0.6);
            }
            col = g * lit * mix(0.45, 2.0, coping);
            vec3 nn = normalize(vec3((tnoise(q.xz * vec2(4.0, 1.0)) - 0.5) * 0.05, 1.0, (tnoise(q.xz * vec2(2.0, 0.22) + 9.0) - 0.5) * 0.4));
            col += lmUp(q, reflect(rd, nn)) * 0.4;
            col = mix(col, uSkyHor * 0.7, 1.0 - exp(-t2 * 0.012));
          }
          if (uSetting > 2.5) col = uSkyTop * (0.22 + 0.2 * smoothstep(-4.0, -7.5, q.z)) + lmPoolLight(q.xz) * 0.02;
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

type Trig = 'kick' | 'snare' | 'hat' | 'onset' | 'beat' | 'bar' | 'chain' | 'none';
type Kind = 'weave' | 'duet' | 'leapfrog' | 'call' | 'criss' | 'cascade' | 'scatter' | 'fan' | 'rise';
type Tier = 'quiet' | 'mid' | 'build' | 'peak';
type Rng = () => number;

/** one jet's part in a pattern: where its nozzle stands, where it aims and how high */
interface Spec {
  x: number;
  z: number;
  yaw: number;
  R: number;
  H: number;
  /** fires bolts when its trigger sounds (else a steady stream) */
  hop: boolean;
  trig: Trig;
  group: number;
  /** a steady stream turns slowly from side to side */
  sweepA: number;
  sweepW: number;
  sweepP: number;
}
/** a piece of water in flight */
interface Seg {
  on: number;
  off: number;
  /** flight time to the water of its head and of its tail */
  uOn: number;
  uOff: number;
  /** where its head lands */
  lx: number;
  lz: number;
}
interface Jet {
  /** taking part in the current pattern */
  active: boolean;
  hop: boolean;
  trig: Trig;
  group: number;
  open: boolean;
  segs: Seg[];
  noz: THREE.Vector3;
  /** the aim the valve fires with now… */
  yaw: number;
  R: number;
  H: number;
  /** …and the one a steady stream is turning towards */
  yawT: number;
  RT: number;
  HT: number;
  sweepA: number;
  sweepW: number;
  sweepP: number;
  /** a new place to stand once all its water has landed */
  pend: Spec | null;
  closeAt: number; // clock time to close (or -1)
  openAt: number; // clock time to (re)open a steady stream (or -1)
  fireAt: number; // clock time to fire a bolt (or -1)
  fireSrc: Trig;
  /** a bolt is held open while the sound that fired it rings */
  gate: Trig | null;
  gatePeak: number;
  gateMin: number;
  gateMax: number;
  vel: THREE.Vector3;
  prevVel: THREE.Vector3;
  uL: number; // flight time to the water
  flux: number;
  foam: number;
  burst: number;
  crownAt: number; // sim time of the last bolt landing
  crownS: number;
  light: number;
  land: THREE.Vector2;
  dir: THREE.Vector2;
}

const SETTINGS = ['dusk', 'night', 'city', 'studio'];

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
  // the nearest streetlamps of the street's two rows (the rest are drawn as bokeh only)
  city: [
    [-STREET_X, STREET_Y, -7, 1.0],
    [STREET_X, STREET_Y, -7, 1.0],
    [-STREET_X, STREET_Y, -13, 0.9],
    [STREET_X, STREET_Y, -13, 0.9],
    [-7.5, 2.6, -3.5, 0.6],
    [7.5, 2.6, -3.5, 0.6],
    [-3.5, 3.0, 7.0, 0.8],
    [5.0, 3.4, 6.0, 0.6],
  ],
  studio: [],
};

/* seeded randomness: the same song always plays the same show */
function rngOf(seed: number): Rng {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = THREE.MathUtils.clamp;
/** half the width of pool the camera sees at depth z, less a margin (the same in portrait) */
const halfW = (z: number) => 0.42 * (3.5 - z) - 0.15;
const angleTo = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** a jet from nozzle (nx, nz) to landing (lx, lz) with apex H, kept inside the pool and the frame */
function spec(nx: number, nz: number, lx: number, lz: number, H: number, o: Partial<Spec> = {}): Spec {
  nz = clamp(nz, -2.9, 0.35);
  nx = clamp(nx, -halfW(nz), halfW(nz));
  lz = clamp(lz, -3.0, 0.7);
  lx = clamp(lx, -halfW(lz) - 0.3, halfW(lz) + 0.3);
  const R = Math.max(0.4, Math.hypot(lx - nx, lz - nz));
  return { x: nx, z: nz, yaw: Math.atan2(lz - nz, lx - nx), R, H, hop: false, trig: 'none', group: 0, sweepA: 0, sweepW: 0.3, sweepP: 0, ...o };
}

/** the patterns: each lays out n jets */
const PATTERNS: Record<Kind, (r: Rng, n: number, hops: boolean) => Spec[]> = {
  // long arcs crossing over the middle from both sides, turning slowly out of step; a small jet in
  // front hops on the odd note
  weave(r, n, hops) {
    const out: Spec[] = [];
    const s0 = r() < 0.5 ? -1 : 1;
    const steady = hops && n >= 3 ? n - 1 : n;
    // never a mirrored pair: one arc across the pool, one coming at us from the back, one going away
    // on a diagonal, each at its own depth and height, in a shuffled order
    const shapes = r() < 0.5 ? [0, 1, 2] : [1, 0, 2];
    for (let k = 0; k < steady; k++) {
      const side = k % 2 ? -s0 : s0;
      const o = { sweepA: 0.14 + 0.26 * r(), sweepW: 0.22 + 0.3 * r(), sweepP: r() * TAU };
      const shape = shapes[k % 3];
      if (shape === 0) {
        const nz = -0.5 - r() * 1.0;
        out.push(spec(side * (1.0 + r() * 0.8), nz, -side * (0.3 + r() * 1.0), nz - 0.3 - r() * 0.8, 0.4 + r() * 0.35, o));
      } else if (shape === 1) {
        const nx = side * (0.2 + r() * 0.9);
        const nz = -2.2 - r() * 0.6;
        out.push(spec(nx, nz, nx - side * (0.6 + r() * 0.8), nz + 1.4 + r() * 0.8, 0.55 + r() * 0.4, o));
      } else {
        const nz = -0.2 - r() * 0.6;
        const nx = side * (0.3 + r() * 0.8);
        out.push(spec(nx, nz, nx + side * (0.5 + r() * 0.7), nz - 1.3 - r() * 0.9, 0.35 + r() * 0.4, o));
      }
    }
    while (out.length < n) {
      const x = (r() - 0.5) * 1.6;
      const z = -0.2 - r() * 0.8;
      const yaw = r() * TAU;
      out.push(spec(x, z, x + Math.cos(yaw), z + Math.sin(yaw), 0.3 + r() * 0.25, { hop: true, trig: 'onset' }));
    }
    return out;
  },
  // a high arc and a low one crossing each other, small jets hopping in front of them
  duet(r, n, hops) {
    const s = r() < 0.5 ? -1 : 1;
    // a tall one sailing across from the back, a low one running away from us under it
    const bx = s * (0.3 + r() * 0.6);
    const out = [
      spec(-1.7 * s, -2.4 - r() * 0.4, 1.2 * s, -0.6 - r() * 0.5, 0.75 + r() * 0.25, { sweepA: 0.08, sweepW: 0.18, sweepP: r() * TAU }),
      spec(bx, -0.2 - r() * 0.3, bx + s * (0.4 + r() * 0.6), -2.0 - r() * 0.6, 0.4 + r() * 0.2, { sweepA: 0.2, sweepW: 0.27, sweepP: r() * TAU }),
    ];
    for (let k = 2; k < n; k++) {
      const x = (k % 2 ? -1 : 1) * (0.3 + r() * 0.8);
      const z = -0.1 - r() * 0.9;
      const yaw = Math.PI / 2 + (r() - 0.5) * 2.4 + (r() < 0.4 ? Math.PI : 0);
      out.push(spec(x, z, x + Math.cos(yaw) * 0.9, z + Math.sin(yaw) * 0.9, 0.32 + r() * 0.3, hops ? { hop: true, trig: 'beat' } : { sweepA: 0.3, sweepW: 0.5, sweepP: r() * TAU }));
    }
    return out;
  },
  // bolts leaping from nozzle to nozzle: round a ring, or zig-zagging across with one long leap back
  leapfrog(r, n) {
    const sites: [number, number][] = [];
    if (r() < 0.6) {
      const cx = (r() - 0.5) * 0.6;
      const cz = -1.45 - r() * 0.35;
      const rx = 1.35 + r() * 0.55;
      const rz = 0.75 + r() * 0.3;
      const ph = r() * TAU;
      const dn = r() < 0.5 ? 1 : -1;
      for (let k = 0; k < n; k++) {
        const a = ph + (dn * k * TAU) / n + (r() - 0.5) * 0.3;
        sites.push([cx + rx * Math.cos(a), cz + rz * Math.sin(a)]);
      }
    } else {
      const zc = -1.0 - r() * 1.2;
      const amp = 0.35 + r() * 0.35;
      const w = halfW(zc) * 0.85;
      const dn = r() < 0.5 ? 1 : -1;
      for (let k = 0; k < n; k++) {
        const f = n > 1 ? k / (n - 1) : 0.5;
        sites.push([dn * (-w + 2 * w * f), zc + (k % 2 ? amp : -amp)]);
      }
    }
    return sites.map(([x, z], k) => {
      const [x2, z2] = sites[(k + 1) % n];
      const R = Math.hypot(x2 - x, z2 - z);
      return spec(x, z, x + (x2 - x) * 0.9, z + (z2 - z) * 0.9, 0.2 + 0.28 * R * (0.8 + 0.4 * r()), { hop: true, trig: 'chain' });
    });
  },
  // jets on the left answer jets on the right, across the pool: the kick, then the snare
  call(r, n) {
    const out: Spec[] = [];
    const nl = Math.ceil(n / 2);
    const flip = r() < 0.5 ? 1 : -1;
    for (let k = 0; k < n; k++) {
      const g = k < nl ? 0 : 1;
      const m = g === 0 ? k : k - nl;
      const cnt = g === 0 ? nl : n - nl;
      const side = (g === 0 ? -1 : 1) * flip;
      const nz = -0.3 - ((m + 0.2 + 0.6 * r()) / cnt) * 2.5;
      out.push(spec(side * (1.0 + r() * 0.9), nz, -side * (0.2 + r() * 1.4), -0.3 - r() * 2.5, 0.45 + r() * 0.5, { hop: true, trig: g === 0 ? 'kick' : 'snare', group: g }));
    }
    return out;
  },
  // pairs of streams crossing in X's at different depths and heights, one tall one in the middle
  criss(r, n) {
    const out: Spec[] = [];
    const pairs = Math.max(1, Math.floor(n / 2));
    for (let p = 0; p < pairs; p++) {
      const z = -0.45 - ((p + 0.5) / pairs) * 2.2 + (r() - 0.5) * 0.3;
      const a = 0.8 + r() * 1.0;
      const dz = (r() - 0.5) * 0.9;
      const H = 0.42 + 0.3 * (p % 2) + r() * 0.15;
      out.push(spec(-a, z, a * 0.85, z + dz, H, { group: p % 2, sweepA: 0.05, sweepW: 0.2, sweepP: r() * TAU }));
      out.push(spec(a, z + dz, -a * 0.85, z, H + 0.18, { group: (p + 1) % 2, sweepA: 0.05, sweepW: 0.23, sweepP: r() * TAU }));
    }
    if (out.length < n) {
      const x = (r() - 0.5) * 0.6;
      out.push(spec(x, -1.5, x + 0.35, -1.3, 1.0 + r() * 0.25, { sweepA: 0.6, sweepW: 0.35, sweepP: r() * TAU, group: 2 }));
    }
    return out.slice(0, n);
  },
  // a row of nozzles all aimed one way, firing one after another down the row
  cascade(r, n) {
    const z0 = -0.9 - r() * 1.4;
    const slope = (r() - 0.5) * 0.5;
    const w = halfW(z0) * 0.82;
    const pick = r();
    const yaw = pick < 0.4 ? Math.PI / 2 + (r() - 0.5) * 1.0 : pick < 0.75 ? -Math.PI / 2 + (r() - 0.5) * 0.9 : (r() < 0.5 ? 0 : Math.PI) + (r() - 0.5) * 0.6;
    const R = 0.9 + r() * 0.8;
    const H0 = 0.4 + r() * 0.3;
    const wave = r() < 0.5;
    const out: Spec[] = [];
    for (let k = 0; k < n; k++) {
      const f = n > 1 ? k / (n - 1) : 0.5;
      const x = -w + 2 * w * f;
      const z = z0 + slope * x;
      const H = wave ? H0 * (0.65 + 0.7 * f) : H0 * (0.9 + 0.25 * Math.sin(f * Math.PI));
      out.push(spec(x, z, x + Math.cos(yaw) * R, z + Math.sin(yaw) * R, H, { hop: true, trig: 'bar' }));
    }
    return out;
  },
  // nozzles all over the pool, every hat a bolt in a new direction
  scatter(r, n) {
    const out: Spec[] = [];
    for (let k = 0; k < n; k++) {
      const z = -0.2 - r() * 2.6;
      const x = (r() * 2 - 1) * halfW(z) * 0.9;
      const yaw = r() * TAU;
      const R = 0.7 + r() * 1.1;
      out.push(spec(x, z, x + Math.cos(yaw) * R, z + Math.sin(yaw) * R, 0.35 + r() * 0.55, { hop: true, trig: 'hat' }));
    }
    return out;
  },
  // a peacock: streams opening from one spot, the middle ones tallest, breathing on the kick
  fan(r, n) {
    const cx = (r() - 0.5) * 0.8;
    const cz = -1.5 - r() * 0.6;
    const yc = r() < 0.6 ? Math.PI / 2 : -Math.PI / 2;
    const spread = 2.3 + r() * 0.9;
    const out: Spec[] = [];
    for (let k = 0; k < n; k++) {
      const f = n > 1 ? k / (n - 1) - 0.5 : 0;
      const yaw = yc + f * spread;
      const nx = cx + Math.cos(yaw) * 0.18;
      const nz = cz + Math.sin(yaw) * 0.18;
      const R = 1.3 + r() * 0.5 - 0.3 * Math.abs(f);
      out.push(spec(nx, nz, nx + Math.cos(yaw) * R, nz + Math.sin(yaw) * R, 0.7 + r() * 0.3 + 0.35 * (0.5 - Math.abs(f)), { group: k % 2, sweepA: 0.07, sweepW: 0.3, sweepP: r() * TAU }));
    }
    return out;
  },
  // the build: streams from both sides converging on the middle, joining one by one; small jets in
  // front chatter on the snare roll
  rise(r, n, hops) {
    const out: Spec[] = [];
    let m = 0;
    for (let k = 0; k < n; k++) {
      if (hops && (k === 2 || k === 5)) {
        const x = (k === 2 ? -1 : 1) * (0.35 + r() * 0.4);
        const z = -0.05 - r() * 0.4;
        out.push(spec(x, z, -x * 0.6, z - 1.0 - r() * 0.5, 0.35 + r() * 0.2, { hop: true, trig: 'snare' }));
        continue;
      }
      const side = m % 2 ? 1 : -1;
      const row = Math.floor(m / 2);
      const nz = -0.7 - row * 0.6 - r() * 0.2;
      const nx = side * (halfW(nz) * 0.85 - row * 0.15);
      out.push(spec(nx, nz, -side * (0.1 + 0.3 * r()), nz - 0.4 + r() * 0.3, 0.45 + 0.07 * row + r() * 0.1, { sweepA: 0.06, sweepW: 0.4, sweepP: r() * TAU }));
      m++;
    }
    return out;
  },
};
/** which patterns suit each part of the song */
const OPTIONS: Record<Tier, Kind[]> = {
  quiet: ['weave', 'duet'],
  mid: ['leapfrog', 'call', 'criss', 'cascade', 'weave', 'duet', 'scatter'],
  build: ['rise'],
  peak: ['scatter', 'fan', 'criss', 'leapfrog', 'cascade', 'call'],
};
/** the patterns made of steady streams (all that is left with Surprise or Beat cuts turned down) */
const CALM: Kind[] = ['weave', 'duet', 'criss', 'fan', 'rise'];
/** bolt lengths (flight seconds of water, before loudness) for each kind of hit: [shortest, longest] */
const BOLT: Record<Trig, [number, number]> = {
  hat: [0.07, 0.2],
  snare: [0.08, 0.22],
  kick: [0.1, 0.3],
  onset: [0.1, 0.4],
  beat: [0.12, 0.32],
  bar: [0.18, 0.42],
  chain: [0.15, 0.36],
  none: [0.22, 0.42],
};

export const laminar: SceneDef = {
  id: 'laminar',
  name: 'Laminar',
  description:
    'Laminar fountain jets arcing over a dark reflecting pool in a dusk garden, a night plaza, a city street or a studio: water so smooth it looks like glass rods, refracting the world upside down and lit from inside like fibre optic. A choreographer picks a new pattern every phrase: arcs crossing and turning in the quiet, bolts leaping nozzle to nozzle, left answering right, cascades and scattered hops on the hats, a peacock fan on the drop. Builds gather the jets, thin them and make them tremble while the lights dim; the drop fires a volley. Out-of-focus streetlights and lanterns breathe with the song and shine in the pool.',
  category: 'form',
  style: 'world',
  tags: ['calm', 'dreamy', 'tender', 'romantic', 'cinematic', 'spacious', 'ambient', 'hypnotic', 'euphoric', 'uplifting', 'emotional', 'playful', 'nature', 'organic', 'realistic', 'city', 'night'],
  params,
  modulations: [],
  /* the hedge, sky and pool each need their own ink: with three they all print as one flat navy */
  handInks: 4,
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

    const jets: Jet[] = Array.from({ length: J }, (_, i) => ({
      active: false,
      hop: false,
      trig: 'none' as Trig,
      group: 0,
      open: false,
      segs: [],
      noz: new THREE.Vector3((i - J / 2) * 0.4, 0, -1.5),
      yaw: 0,
      R: 1,
      H: 0.5,
      yawT: 0,
      RT: 1,
      HT: 0.5,
      sweepA: 0,
      sweepW: 0.3,
      sweepP: 0,
      pend: null,
      closeAt: -1,
      openAt: -1,
      fireAt: -1,
      fireSrc: 'beat' as Trig,
      gate: null,
      gatePeak: 0,
      gateMin: 0,
      gateMax: 0,
      vel: new THREE.Vector3(),
      prevVel: new THREE.Vector3(),
      uL: 0.5,
      flux: 0,
      foam: 0,
      burst: 0,
      crownAt: -100,
      crownS: 0,
      light: 0,
      land: new THREE.Vector2(0, -1.5),
      dir: new THREE.Vector2(1, 0),
    }));
    /* uniforms shared by the jet / splash / world shaders */
    const nozU = Array.from({ length: J }, () => new THREE.Vector4());
    const segU = Array.from({ length: (J * MAX_SEG) / 2 }, () => new THREE.Vector4(-10, -5, -10, -5));
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
      uTrem: { value: 0 },
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
      uBok: { value: new THREE.Vector4() },
      uBokAp: { value: 0.1 },
      uBokLite: { value: 0 },
      uBokWarm: { value: new THREE.Vector3() },
      uBokCool: { value: new THREE.Vector3() },
      uBokRed: { value: new THREE.Vector3() },
      uBokWhite: { value: new THREE.Vector3() },
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
        uCoreFade: { value: 5 },
        uSpecK: { value: 0.1 },
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
    const prand = rngOf(7);
    for (let j = 0; j < J; j++)
      for (let i = 0; i < PER; i++) {
        const k = (j * PER + i) * 4;
        const kind = i < PER * 0.45 ? 0 : i < PER * 0.8 ? 1 : 2;
        aP.set([j, kind, prand(), prand()], k);
        aQ.set([prand(), prand(), prand(), prand()], k);
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
    let started = false;
    let preDrop = false;
    let rough = 0;
    let dropBoost = 0;
    let kickEnv = 0;
    let lampG = 1;
    let bokG = 1;
    let sparkSeed = 0;
    let sparkAmt = 0;
    let seedBase = 7;
    let fakeBeat = 0; // a stand-in beat clock when nothing is playing
    let fakeCount = 0;
    const heard = { kick: -99, snare: -99, hat: -99, onset: -99 };
    const tmpC = new THREE.Color();
    const tmpV = new THREE.Vector3();
    let rnd: Rng = rngOf(99);

    /** the pattern playing now */
    const pat = {
      kind: 'rise' as Kind,
      tier: 'quiet' as Tier,
      key: -1,
      specs: [] as Spec[],
      /** how many of the specs have jets (a build adds them one by one) */
      live: 0,
      /** whose turn it is in a chain */
      ci: 0,
      trig: 'beat' as Trig,
      /** loud enough to chop steady streams on the kick */
      pulse: false,
      /** how often a quiet part's small jets answer a note */
      prob: 1,
      cutAt: 0,
      kickN: 0,
      dirn: 1,
      /** a pattern change waiting (after the drop's volley), clock time */
      at: -1,
      tierSeen: 'quiet' as Tier,
      tierAt: 0,
    };

    /* valves */
    const openJet = (j: Jet) => {
      if (j.open) return;
      j.open = true;
      const uOn = (2 * j.vel.y) / G;
      j.segs.push({ on: simT, off: Infinity, uOn, uOff: uOn, lx: j.noz.x + j.vel.x * uOn, lz: j.noz.z + j.vel.z * uOn });
      if (j.segs.length > MAX_SEG) j.segs.shift();
    };
    const closeJet = (j: Jet) => {
      if (!j.open) return;
      j.open = false;
      j.gate = null;
      const s = j.segs[j.segs.length - 1];
      if (s) {
        s.off = simT;
        s.uOff = (2 * j.vel.y) / G;
      }
    };

    /* velocity for an arc of reach R and apex height H, aimed along yaw */
    const launchVel = (j: Jet, out: THREE.Vector3) => {
      const R = Math.max(0.3, j.R);
      const H = Math.max(0.12, j.H);
      const alpha = Math.atan((4 * H) / R);
      const v = Math.sqrt((G * R) / Math.sin(2 * alpha));
      const c = Math.cos(alpha) * v;
      return out.set(Math.cos(j.yaw) * c, v * Math.sin(alpha), Math.sin(j.yaw) * c);
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

    /* ── the choreographer ── */

    // the arc height everything is scaled by now (song size, build, the drop's boost)
    let hScale = 1;

    /** take up a part where the jet already stands */
    const adopt = (j: Jet, s: Spec, delay: number) => {
      j.pend = null;
      j.active = true;
      j.hop = s.hop;
      j.trig = s.trig;
      j.group = s.group;
      j.yawT = s.yaw;
      j.RT = s.R;
      j.HT = s.H;
      j.sweepA = s.sweepA;
      j.sweepW = s.sweepW;
      j.sweepP = s.sweepP;
      j.fireAt = -1;
      if (s.hop) {
        j.openAt = -1;
        j.closeAt = -1;
        if (j.open && !j.gate) closeJet(j);
      } else if (!j.open && !preDrop) j.openAt = clock + delay;
    };
    /** move the nozzle (only ever with no water of its own in the air) */
    const relocate = (j: Jet, s: Spec) => {
      j.noz.set(s.x, 0, s.z);
      j.yaw = s.yaw + s.sweepA * Math.sin(clock * s.sweepW + s.sweepP);
      j.R = s.R;
      j.H = Math.min(1.9, s.H * hScale);
      j.light *= 0.3;
      adopt(j, s, 0.05 + rnd() * 0.35);
      launchVel(j, j.vel);
      j.prevVel.copy(j.vel);
      j.dir.set(Math.cos(j.yaw), Math.sin(j.yaw));
    };
    const assign = (j: Jet, s: Spec, delay: number) => {
      j.active = true;
      if (Math.hypot(j.noz.x - s.x, j.noz.z - s.z) < 0.1) return adopt(j, s, delay);
      j.pend = s;
      j.fireAt = -1;
      j.openAt = -1;
      j.closeAt = -1;
      closeJet(j);
      if (j.segs.length === 0) relocate(j, s);
    };
    const retire = (j: Jet) => {
      j.active = false;
      j.pend = null;
      j.fireAt = -1;
      j.openAt = -1;
      j.closeAt = -1;
      closeJet(j);
    };

    const applyPattern = (kind: Kind, tier: Tier, n: number, r: Rng, hops: boolean, cap: number) => {
      pat.kind = kind;
      pat.tier = tier;
      pat.specs = PATTERNS[kind](r, n, hops);
      pat.ci = Math.floor(r() * 8);
      pat.dirn = r() < 0.5 ? 1 : -1;
      pat.trig = tier === 'peak' ? (r() < 0.65 ? 'hat' : 'onset') : r() < 0.6 ? 'beat' : 'onset';
      pat.pulse = tier === 'peak' || (tier === 'mid' && r() < 0.4);
      pat.prob = tier === 'quiet' ? 0.4 : 1;
      pat.cutAt = clock + 2 + 3 * r();
      pat.live = kind === 'rise' ? Math.min(3, pat.specs.length) : pat.specs.length;
      for (let i = 0; i < J; i++) {
        if (i < pat.live && i < cap) assign(jets[i], pat.specs[i], 0.05 + r() * 0.3);
        else retire(jets[i]);
      }
    };

    const pickPattern = (tier: Tier, key: number, maxJ: number, cap: number, surprise: number, cuts: number, beats: boolean) => {
      const r = rngOf(seedBase * 7919 + key * 104729 + (tier === 'peak' ? 31 : tier === 'build' ? 17 : tier === 'mid' ? 5 : 1));
      const hops = cuts > 0.15 && surprise > 0.15 && beats;
      let opts = OPTIONS[tier];
      if (!hops || surprise < 0.35) opts = opts.filter((k) => CALM.includes(k));
      if (!opts.length) opts = ['weave'];
      const choices = opts.length > 1 ? opts.filter((k) => k !== pat.kind) : opts;
      const kind = choices[Math.floor(r() * choices.length)];
      const busy = kind === 'leapfrog' || kind === 'call' || kind === 'cascade' || kind === 'scatter';
      let n: number;
      if (tier === 'quiet') n = 2 + (r() < 0.6 ? 1 : 0);
      else if (tier === 'mid') n = 3 + Math.floor(r() * 3) + (busy ? 1 : 0);
      else if (tier === 'build') n = maxJ;
      else n = maxJ - (r() < 0.3 ? 1 : 0);
      n = Math.max(2, Math.min(n, maxJ, cap));
      applyPattern(kind, tier, n, r, hops, cap);
      pat.key = key;
    };

    /** which part of the song this is, for the choreography */
    const tierOf = (frame: FrameContext, I: number, tension: number): Tier => {
      const f = frame.feel;
      const sec = f.section;
      if (sec === 'drop' || f.release > 0.35 || ((!frame.analysis || sec === 'chorus') && I > 0.72)) return 'peak';
      if (sec === 'build' || tension > 0.4) return 'build';
      if (I < 0.3 || ((sec === 'intro' || sec === 'break' || sec === 'outro') && I < 0.42)) return 'quiet';
      return 'mid';
    };
    /** a new part of the song, or a new 16-beat phrase within it */
    const phraseKey = (frame: FrameContext) => {
      const a = frame.audio;
      const beats = a.playing && a.bpm > 0 ? Math.floor((a.time * a.bpm) / 60 + 0.25) : Math.floor(clock / 8) * 16;
      return (frame.feel.sectionIndex + 1) * 4096 + Math.floor(beats / 16);
    };

    /* triggers: the sound a jet listens for, falling back on the beat when that sound is absent */
    let ev = { beat: false, beatCount: 0, kick: false, snare: false, hat: false, onset: false };
    const recent = (k: keyof typeof heard) => clock - heard[k] < 2.5;
    const hit = (t: Trig): Trig | null => {
      switch (t) {
        case 'kick':
          return ev.kick ? 'kick' : !recent('kick') && ev.beat && ev.beatCount % 2 === 0 ? 'beat' : null;
        case 'snare':
          return ev.snare ? 'snare' : !recent('snare') && ev.beat && ev.beatCount % 2 === 1 ? 'beat' : null;
        case 'hat':
          return ev.hat ? 'hat' : recent('hat') ? null : hit('onset');
        case 'onset':
          return ev.onset ? 'onset' : !recent('onset') && ev.beat ? 'beat' : null;
        case 'beat':
        case 'chain':
          return ev.beat ? 'beat' : null;
        case 'bar':
          return ev.beat && ev.beatCount % 4 === 0 ? 'beat' : null;
        default:
          return null;
      }
    };

    let I = 0;
    let tension = 0;
    let surprise = 0.7;
    let tscale = 0.7;
    const gateEnv = (a: FrameContext['audio'], src: Trig) => (src === 'kick' ? a.kick : src === 'snare' ? a.snare : src === 'hat' ? a.hat : a.level);
    let curAudio: FrameContext['audio'] | null = null;

    /** a bolt from a hopping jet: a fresh aim (a little different every time), held while its sound rings */
    const fire = (j: Jet, src: Trig, key: Trig, len: number, jit: number) => {
      if (!j.active || j.pend || preDrop || !curAudio) return false;
      if (j.segs.length >= MAX_SEG) return false;
      j.yaw = j.yawT + (rnd() * 2 - 1) * jit * (0.3 + 0.7 * surprise);
      j.R = j.RT * (1 + (rnd() - 0.5) * 0.35 * surprise);
      j.H = Math.min(1.9, j.HT * hScale * (0.9 + 0.3 * rnd() * surprise));
      launchVel(j, j.vel);
      j.prevVel.copy(j.vel);
      j.dir.set(Math.cos(j.yaw), Math.sin(j.yaw));
      if (j.open) closeJet(j);
      openJet(j);
      const [lo, hi] = BOLT[key];
      const k = (len * (0.75 + 0.6 * I)) / tscale;
      j.gate = src;
      j.gatePeak = gateEnv(curAudio, src);
      j.gateMin = clock + lo * k;
      j.gateMax = clock + hi * k;
      j.closeAt = -1;
      return true;
    };
    /** a steady stream chopped: a short gap runs out along the arc */
    const chop = (j: Jet) => {
      if (!j.open || j.hop || j.segs.length >= MAX_SEG) return;
      closeJet(j);
      j.openAt = clock + (0.09 + 0.08 * rnd()) / tscale;
    };
    const liveJets = () => jets.filter((j) => j.active && !j.pend);

    const drive = (cuts: number, builds: number, beatS: number, toDrop: number) => {
      const live = liveJets();
      if (!live.length) return;
      const hops = live.filter((j) => j.hop);
      const fireK = 0.4 + 0.6 * cuts;
      switch (pat.kind) {
        case 'weave':
        case 'duet': {
          for (const j of hops) {
            const src = hit(j.trig);
            if (src && rnd() < pat.prob * fireK) fire(j, src, src, 1.2, 0.9);
          }
          // now and then a stream is cut and relaunched (on a note when there is one, else on a timer)
          const o = hit('onset');
          if (cuts > 0.2 && ((o && rnd() < 0.08 * surprise) || clock > pat.cutAt)) {
            const st = live.filter((j) => !j.hop && j.open && j.segs.length < MAX_SEG);
            if (st.length) {
              const j = st[Math.floor(rnd() * st.length)];
              closeJet(j);
              j.openAt = clock + beatS * (0.5 + rnd());
            }
            pat.cutAt = clock + (3 + 4 * rnd()) / (0.5 + surprise);
          }
          break;
        }
        case 'leapfrog': {
          const src = hit(pat.trig);
          if (src && hops.length && rnd() < 0.5 + 0.5 * fireK) {
            const j = hops[pat.ci % hops.length];
            fire(j, src, 'chain', 1, 0.12);
            // with enough nozzles, two bolts chase each other round
            if (hops.length >= 4) fire(hops[(pat.ci + (hops.length >> 1)) % hops.length], src, 'chain', 0.9, 0.12);
            pat.ci++;
          }
          // loud: the kick throws a second bolt from across the ring
          if (pat.tier === 'peak' && ev.kick && hops.length > 2) fire(hops[(pat.ci + Math.floor(hops.length / 2)) % hops.length], 'kick', 'kick', 1.1, 0.25);
          break;
        }
        case 'call': {
          for (let g = 0; g < 2; g++) {
            const src = hit(g === 0 ? 'kick' : 'snare');
            if (!src || rnd() > fireK + 0.2) continue;
            let m = 0;
            for (const j of hops)
              if (j.group === g) {
                j.fireAt = clock + m * (0.02 + 0.04 * rnd());
                j.fireSrc = src;
                m++;
              }
          }
          break;
        }
        case 'criss':
        case 'fan': {
          if (pat.pulse && cuts > 0.2) {
            const src = hit('kick');
            if (src) {
              const g = pat.kickN++ % 2;
              for (const j of live) if (j.group === g) chop(j);
            }
          }
          break;
        }
        case 'cascade': {
          const src = pat.tier === 'peak' ? (ev.beat && ev.beatCount % 2 === 0 ? 'beat' : null) : hit('bar');
          if (src && hops.length) {
            if (rnd() < 0.7) pat.dirn = -pat.dirn;
            const st = (0.045 + 0.06 * rnd()) / Math.max(0.5, tscale);
            hops.forEach((j, k) => {
              j.fireAt = clock + (pat.dirn > 0 ? k : hops.length - 1 - k) * st;
              j.fireSrc = 'bar';
            });
          }
          // loud: stray hops on the hats between the waves
          const h = pat.tier === 'peak' ? hit('hat') : null;
          if (h && hops.length && rnd() < 0.3 * surprise * fireK) fire(hops[Math.floor(rnd() * hops.length)], h, 'hat', 1, 1.2);
          break;
        }
        case 'scatter': {
          const src = hit('hat');
          if (src && rnd() < (0.45 + 0.45 * surprise) * fireK) {
            const shut = hops.filter((j) => !j.open);
            const pool = shut.length ? shut : hops;
            fire(pool[Math.floor(rnd() * pool.length)], src, 'hat', 1.5, Math.PI);
          }
          // and on the beat a longer one, somewhere else
          if (ev.beat && rnd() < 0.7 * fireK) {
            const j = hops[Math.floor(rnd() * hops.length)];
            if (j) fire(j, 'beat', 'beat', 1.2, Math.PI);
          }
          if (ev.kick)
            for (let q = 0; q < 2; q++) {
              const j = hops[Math.floor(rnd() * hops.length)];
              if (j) fire(j, 'kick', 'kick', 1.3, Math.PI);
            }
          break;
        }
        case 'rise': {
          // jets join as the song winds up; all of them are in before the drop
          const want = toDrop < 2.5 ? pat.specs.length : clamp(2 + Math.round(tension * builds * (pat.specs.length - 2)), 2, pat.specs.length);
          if ((ev.beat || toDrop < 2.5) && pat.live < want) {
            assign(jets[pat.live], pat.specs[pat.live], 0.03);
            pat.live++;
          }
          const src = hit('snare');
          if (src && hops.length) {
            fire(hops[pat.ci % hops.length], src, 'snare', 0.9, 0.5);
            pat.ci++;
          }
          break;
        }
      }
    };

    /** the first frame: set the opening pattern up already flowing, so the look never starts empty */
    const start = (frame: FrameContext, maxJ: number, cap: number, cuts: number) => {
      started = true;
      const an = frame.analysis;
      seedBase = (an ? Math.round(an.duration * 1000 + an.bpm * 7) : 7) + 131 * Math.max(0, SETTINGS.indexOf(str(frame.params, 'setting', 'dusk')));
      rnd = rngOf(seedBase + 1);
      hScale = num(frame.params, 'arc', 1);
      const key = phraseKey(frame);
      const tier = frame.audio.playing ? tierOf(frame, I, tension) : 'quiet';
      pickPattern(tier, key, maxJ, cap, surprise, cuts, true);
      for (const j of jets) {
        if (j.pend) relocate(j, j.pend);
        if (j.active && !j.hop) {
          j.openAt = -1;
          j.open = true;
          j.segs = [{ on: -10, off: Infinity, uOn: (2 * j.vel.y) / G, uOff: 0, lx: 0, lz: 0 }];
        }
        j.prevVel.copy(j.vel);
        j.light = j.active ? 1 : 0;
      }
      for (let k = -HIST; k <= 1; k++) writeSample(k);
      lastK = 0;
    };

    return {
      render(frame, target) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        const pal = frame.palette.c;
        const setting = Math.max(0, SETTINGS.indexOf(str(p, 'setting', 'dusk')));
        const night = setting === 1 || setting === 2;
        const studio = setting === 3;
        tscale = num(p, 'speed', 0.7);
        const sdt = dt * tscale;
        I = frame.analysis ? frame.feel.intensity : Math.min(1, a.energy * 1.3);
        tension = Math.min(1, Math.max(a.build, frame.feel.tension));
        surprise = num(p, 'surprise', 0.7);
        const cuts = num(p, 'cuts', 1);
        const builds = num(p, 'builds', 1);
        const lite = quality.current().sceneScale < 1;
        const cap = lite ? J_LITE : J;
        const maxJ = Math.min(cap, Math.round(num(p, 'jets', 8)));
        const beatS = 60 / Math.max(60, a.bpm || 120);
        if (!started) start(frame, maxJ, cap, cuts);
        clock += dt;
        simT += sdt;
        envT += sdt;
        drop.step(frame);
        const dEnv = drop.env;
        kickEnv = Math.max(kickEnv * Math.exp(-dt * 8), a.kick);
        curAudio = a;

        /* ── what the song is doing ── */
        const playing = a.playing && a.bpm > 0;
        if (!playing && clock - fakeBeat > 0.75) {
          fakeBeat = clock;
          fakeCount++;
        }
        ev = {
          beat: playing ? a.beat : clock === fakeBeat,
          beatCount: playing ? a.beatCount : fakeCount,
          kick: a.playing && a.kickHit,
          snare: a.playing && a.snareHit,
          hat: a.playing && a.hatHit,
          onset: a.playing && a.onset,
        };
        if (ev.kick) heard.kick = clock;
        if (ev.snare) heard.snare = clock;
        if (ev.hat) heard.hat = clock;
        if (ev.onset) heard.onset = clock;
        const arc = num(p, 'arc', 1);
        dropBoost = Math.max(0, dropBoost - dt * 0.12);
        hScale = arc * (0.86 + 0.22 * I + 0.32 * tension * builds + 0.3 * dropBoost * builds);

        /* ── the drop: hold, cut, volley ── */
        const toDrop = frame.feel.toDrop;
        // the beat before a known drop: everything cut, the lights down, a breath held
        if (cuts > 0.05 && a.playing && toDrop > 0.02 && toDrop < 0.55 && !preDrop && drop.since > 1) {
          preDrop = true;
          for (const j of jets) {
            closeJet(j);
            j.openAt = -1;
            j.closeAt = -1;
            j.fireAt = -1;
          }
        }
        if (preDrop && toDrop > 1.5) preDrop = false; // the drop never came (seek, or a miss)
        // the drop: a volley of bolts from every jet, then a new pattern two beats later
        if (drop.since === 0) {
          preDrop = false;
          dropBoost = 1;
          hScale = arc * (0.86 + 0.22 * I + 0.32 * tension * builds + 0.3 * builds);
          for (const j of jets) {
            if (!j.active || j.pend) continue;
            if (j.hop) fire(j, 'none', 'none', 1.4, 0.25);
            else {
              j.H = Math.min(1.9, j.HT * hScale * 1.1);
              launchVel(j, j.vel);
              j.prevVel.copy(j.vel);
              closeJet(j);
              openJet(j);
              j.closeAt = clock + (cuts > 0.05 ? 0.32 / tscale : 1e9);
              j.openAt = clock + beatS * 2;
            }
          }
          for (let q = 0; q < 8; q++) addDrop((rnd() - 0.5) * 4.5, -0.2 - rnd() * 2.8, 0.16, 0.02);
          pat.at = clock + beatS * 2;
        }

        /* ── a new pattern each phrase ── */
        const tierNow = a.playing ? tierOf(frame, I, tension) : pat.tier;
        if (tierNow !== pat.tierSeen) {
          pat.tierSeen = tierNow;
          pat.tierAt = clock;
        }
        const key = phraseKey(frame);
        const waiting = pat.at > 0 && clock < pat.at;
        const due = pat.at > 0 && clock >= pat.at;
        const tierShift = tierNow !== pat.tier && clock - pat.tierAt > 0.8;
        if (!preDrop && !waiting && (due || (a.playing && (key !== pat.key || tierShift)))) {
          pat.at = -1;
          pickPattern(tierNow, key, maxJ, cap, surprise, cuts, playing);
        }
        // the quality governor easing off: hand back the slots it cannot afford
        for (let i = cap; i < J; i++) if (jets[i].active) retire(jets[i]);

        if (!preDrop) drive(cuts, builds, beatS, toDrop);

        /* ── timers, gates, moves ── */
        for (const j of jets) {
          if (j.fireAt > 0 && clock >= j.fireAt) {
            j.fireAt = -1;
            fire(j, j.fireSrc, pat.kind === 'cascade' ? 'bar' : j.fireSrc, 1, 0.15);
          }
          if (j.gate && j.open) {
            const env = gateEnv(a, j.gate);
            j.gatePeak = Math.max(j.gatePeak, env);
            const thr = j.gate === 'kick' || j.gate === 'snare' || j.gate === 'hat' ? 0.4 : 0.82;
            if (clock >= j.gateMax || (clock >= j.gateMin && env < j.gatePeak * thr)) closeJet(j);
          }
          if (j.closeAt > 0 && clock >= j.closeAt) {
            j.closeAt = -1;
            closeJet(j);
          }
          if (j.openAt > 0 && clock >= j.openAt) {
            j.openAt = -1;
            if (j.active && !j.hop && !j.pend && !preDrop) openJet(j);
          }
          if (j.pend && !j.open && j.segs.length === 0) relocate(j, j.pend);
          // a steady stream that is somehow shut (a cut whose relaunch got lost) comes back
          if (j.active && !j.hop && !j.pend && !j.open && j.openAt < 0 && j.closeAt < 0 && !preDrop) j.openAt = clock + 0.4;
        }

        /* ── steady streams: turn, breathe, climb with the song ── */
        // sweeps freeze as the song winds up: a held breath
        const hold = 1 - 0.85 * Math.min(1, tension * builds);
        for (let ji = 0; ji < J; ji++) {
          const j = jets[ji];
          if (j.hop) continue;
          const sw = j.sweepA * hold * (0.6 + 0.8 * surprise) * Math.sin(clock * j.sweepW + j.sweepP);
          j.yaw += angleTo(j.yaw, j.yawT + sw) * (1 - Math.exp(-1.2 * dt));
          j.R = approach(j.R, j.RT, 1.2, dt);
          // each jet breathes on its own slow pressure swell, so no two arcs move in step
          const breathe = 1 + 0.07 * Math.sin(clock * (0.17 + 0.05 * ji) + ji * 1.9) + 0.03 * Math.sin(clock * (0.61 + 0.13 * ji) + ji * 4.1);
          j.H = approach(j.H, Math.min(j.HT * hScale * breathe, 1.9), 1.6, dt);
          launchVel(j, j.vel);
          j.dir.set(Math.cos(j.yaw), Math.sin(j.yaw));
        }

        /* ── order: smoothness, roughened by loud parts and drops ── */
        const order = num(p, 'order', 0.86);
        rough = approach(rough, num(p, 'roughen', 0.35) * (Math.max(0, I - 0.5) * 0.6 + dEnv * 0.45 + a.flux * 0.1), 3, dt);
        const ord = clamp(order - rough, 0, 1);
        const quiet = 1 - THREE.MathUtils.smoothstep(I, 0.15, 0.45);

        /* ── landing: flux, foam, bolt arrivals ── */
        for (let ji = 0; ji < J; ji++) {
          const j = jets[ji];
          const uL = landingTime(ji);
          j.uL = uL;
          let flowing = false;
          let arrived: Seg | null = null;
          let passing: Seg | null = null;
          for (const s of j.segs) {
            const h = simT - s.on;
            if (h >= s.uOn && (s.off === Infinity || simT - s.off <= s.uOff)) {
              flowing = true;
              passing = s;
            }
            if (h - sdt < s.uOn && h >= s.uOn) arrived = s;
          }
          j.flux = flowing ? 1 : 0;
          if (passing && passing.off === Infinity) {
            histVelAt(ji, uL, tmpV);
            j.land.set(j.noz.x + tmpV.x * uL, j.noz.z + tmpV.z * uL);
          } else if (passing) j.land.set(passing.lx, passing.lz);
          j.foam = approach(j.foam, j.flux, j.flux > j.foam ? 10 : 2.2, dt);
          // a piece of water's head reaching the pool: a plop and a crown of droplets
          j.burst = Math.max(j.burst - dt * 4, arrived ? 1 : 0);
          if (arrived) {
            j.land.set(arrived.lx, arrived.lz);
            j.crownAt = simT;
            j.crownS = 0.75 + 0.5 * rnd() + 0.3 * I;
            addDrop(arrived.lx, arrived.lz, 0.07, 0.03 * (1.4 - ord * 0.5) * (0.8 + 0.5 * I));
          }
          // prune landed pieces
          j.segs = j.segs.filter((s) => s.off === Infinity || simT - s.off < s.uOff + 0.1);
        }

        /* ── history ── */
        const nowK = Math.floor(simT / DELTA);
        if (nowK - lastK > HIST) lastK = nowK - HIST;
        const t0 = simT - sdt;
        for (let k = lastK + 1; k <= nowK; k++) writeSample(k, sdt > 0 ? clamp((k * DELTA - t0) / sdt, 0, 1) : 1);
        writeSample(nowK + 1); // provisional, so the newest stretch interpolates against now
        lastK = nowK;
        for (const j of jets) j.prevVel.copy(j.vel);
        histTex.needsUpdate = true;

        /* ── per-jet uniforms ── */
        const thick = num(p, 'thickness', 1);
        const glow = num(p, 'glow', 1);
        const pair = bool(p, 'pair', false);
        // winding up thins the streams; the drop and loud parts fill them out again
        const thin = clamp(1 - 0.42 * tension * builds, 0.55, 1) * (1 + 0.14 * dEnv + 0.06 * I);
        // at night a few jets in a quiet passage carry the whole picture, so they burn brighter than
        // each of the many in a chorus; bright sounds run them hotter
        const lift = night ? 1.5 - 0.6 * I : 0.7 + 0.3 * I;
        const lightLvl = glow * (night ? 0.9 : studio ? 0.45 : 0.5) * (lift + 0.3 * dEnv + 0.12 * kickEnv) * (0.85 + 0.3 * a.brightness);
        for (let ji = 0; ji < J; ji++) {
          const j = jets[ji];
          nozU[ji].set(j.noz.x, j.noz.y, j.noz.z, 0.016 * thick * thin * (1 + 0.08 * ((ji * 0.37) % 1)));
          let uDraw = j.uL;
          for (let k = 0; k < MAX_SEG; k++) {
            const s = j.segs[k];
            if (s) uDraw = Math.max(uDraw, s.uOn, s.uOff);
            const head = s ? simT - s.on : -10;
            const tail = s ? (s.off === Infinity ? -1 : simT - s.off) : -5;
            const v = segU[ji * (MAX_SEG / 2) + (k >> 1)];
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
          jetU[ji].set(Math.min(uDraw, 2.3) + 0.08, growth, seedA, visible ? 1 : 0);
          j.light = approach(j.light, j.active && !j.pend ? 1 : 0, j.pend ? 6 : 2, dt);
          // no two lamps in the nozzles are quite the same colour
          tmpC.copy(pair && ji % 2 === 1 ? pal.accent2 : pal.accent).lerp(pal.fg, Math.min(0.7, 0.08 + 0.3 * ((ji * 0.618) % 1) + 0.2 * a.brightness));
          linColor(tmpC, glowU[ji]).multiplyScalar(lightLvl * j.light * 1.6);
          landU[ji].set(j.land.x, j.land.y, j.foam, j.burst);
          nozLU[ji].set(j.noz.x, j.noz.z, j.light * (j.open ? 1 : 0.5), j.open ? 1 : 0);
          landDirU[ji].set(j.dir.x, j.dir.y, simT - j.crownAt, simT - j.crownAt < 2 ? 0.8 : 0);
          crownU[ji].set(j.land.x, j.land.y, j.crownS, 0);
        }
        jetLib.uNowK.value = (simT / DELTA) % HIST;
        jetLib.uNoiseNow.value = simT % 256;
        jetLib.uWob.value = (0.0035 + 0.03 * (1 - ord) * (1 - ord)) * (1 - 0.4 * quiet);
        // the held breath: a tremble that grows through the wind-up and is gone the moment it drops
        jetLib.uTrem.value = 0.022 * Math.pow(Math.min(1, tension * builds), 1.6) * (preDrop ? 1.4 : 1);
        jetLib.uGlowFade.value = 2.2;
        spGeo.instanceCount = cap * PER;

        /* ── pool ── */
        const splash = Math.min(1.3, 0.25 + 0.75 * (1 - ord) + 0.3 * I + 0.35 * dEnv);
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
        // a loud kick shivers the whole pool
        if (ev.kick && I > 0.45) for (let q = 0; q < 2; q++) addDrop((rnd() - 0.5) * 4.4, -0.3 - rnd() * 2.6, 0.12, 0.004 * I * (1 + dEnv));
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

        /* ── the lights: breathing with the song, dimmed by the wind-up, flaring on the drop ── */
        const lightsUp = preDrop ? 0.28 : clamp((0.8 + 0.35 * I) * (1 - 0.5 * Math.min(1, tension * builds)) + 1.0 * dEnv, 0.2, 2.4);
        lampG = approach(lampG, lightsUp, preDrop ? 7 : dEnv > 0.05 ? 6 : 2.5, dt);
        bokG = approach(bokG, lightsUp + 0.18 * kickEnv * I, preDrop ? 7 : 4, dt);
        if (ev.hat || (ev.onset && !recent('hat'))) {
          sparkSeed = Math.floor(rnd() * 997);
          sparkAmt = Math.max(sparkAmt, (0.3 + 0.5 * a.brightness) * (0.4 + 0.6 * surprise));
        }
        sparkAmt *= Math.exp(-dt * 7);
        const bokeh = studio ? 0 : num(p, 'bokeh', 1);
        envU.uBok.value.set(bokeh * bokG, sparkSeed, sparkAmt, bokeh * 0.45 * dEnv);
        envU.uBokLite.value = lite ? 1 : 0;
        envU.uBokAp.value = night ? 0.085 : 0.075;
        envU.uAperture.value = night ? 0.07 : setting === 0 ? 0.06 : 0.05;

        /* ── camera ── */
        const drift = num(p, 'drift', 0.4);
        const tanY0 = Math.tan((30 * Math.PI) / 360);
        // on a tall screen, fit the pool a little tighter (halfW keeps every jet inside 0.42 of depth,
        // under the 46-degree fit) and tilt up less, so the water fills the frame instead of the sky
        const tall = clamp((1 - frame.aspect) / 0.45, 0, 1);
        const needY = Math.tan(((54 - 8 * tall) * Math.PI) / 360) / Math.max(frame.aspect, 0.1);
        const ty = Math.min(Math.max(tanY0, needY), Math.tan((96 * Math.PI) / 360));
        const fov = (Math.atan(ty) * 360) / Math.PI;
        camera.fov = fov;
        camera.aspect = frame.aspect;
        camera.position.set(Math.sin(clock * 0.045) * 0.22 * drift, 0.36 + Math.sin(clock * 0.07) * 0.03 * drift, 3.5 - 0.12 * tension * builds);
        const lookY = 0.42 + (ty - tanY0) * (0.9 - 0.45 * tall);
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
          if (l) lampU[i].set(l[0], l[1], l[2], l[3] * lampG);
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
        } else if (setting === 2) {
          // the city: a sodium glow low in the sky, lamps a touch warmer and brighter
          linColor(pal.bg, envU.uSkyTop.value).multiplyScalar(0.55);
          tmpC.copy(pal.bg).lerp(pal.accent2, 0.14);
          linColor(tmpC, envU.uSkyHor.value).multiplyScalar(0.9);
          linColor(pal.accent2, envU.uSkyGlow.value).multiplyScalar(0.16);
          linColor(pal.muted, envU.uFoliage.value).multiplyScalar(0.35);
          tmpC.copy(pal.fg).lerp(pal.accent2, 0.45);
          linColor(tmpC, envU.uLampCol.value).multiplyScalar(18);
          tmpC.copy(pal.muted).lerp(pal.fg, 0.15);
          linColor(tmpC, envU.uStone.value).multiplyScalar(0.45);
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
        // the out-of-focus lights: mostly warm, some cool, a few red (tail lights, a coloured bulb)
        const bk = setting === 0 ? 0.9 : setting === 1 ? 1.1 : 1.25;
        tmpC.copy(pal.fg).lerp(pal.accent2, 0.55);
        linColor(tmpC, envU.uBokWarm.value).multiplyScalar(bk);
        tmpC.copy(pal.accent).lerp(pal.fg, 0.3);
        linColor(tmpC, envU.uBokCool.value).multiplyScalar(bk * 0.8);
        tmpC.set('#ff3a2a').lerp(pal.accent2, 0.25);
        linColor(tmpC, envU.uBokRed.value).multiplyScalar(bk);
        tmpC.copy(pal.fg).lerp(pal.accent, 0.12);
        linColor(tmpC, envU.uBokWhite.value).multiplyScalar(bk);

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
        ju.uAtt.value = night ? 0.35 : 0.55;
        // at night the guided light carries further along the arc
        ju.uCoreFade.value = night ? 3.5 : 5;
        // dusk has no dark sky for the rods to stand out against: they read by their glints
        ju.uSpecK.value = setting === 0 ? 0.15 : 0.1;
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
        // loud parts churn the surface, every kick a shiver
        wu.uCalm.value = (0.00025 + 0.0006 * (1 - ord) + 0.0005 * frame.feel.gust + 0.0005 * I * I + 0.0006 * kickEnv * I) * (1 - 0.5 * quiet);
        wu.uRough.value = 1 - ord;
        wu.uReflWarp.value = 0.1;
        tmpC.copy(pal.fg);
        linColor(tmpC, wu.uFoamCol.value as THREE.Vector3).multiplyScalar(studio ? 0.9 : 0.35);
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
        bu.uThr.value = studio ? 1.6 : 0.9;
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
        // the wind-up darkens the picture a little, the drop opens it up
        cu.uExposure.value = (night ? 1.0 : studio ? 0.85 : 1.05) * (1 + 0.12 * dEnv - 0.08 * Math.min(1, tension * builds) - (preDrop ? 0.06 : 0));
        cu.uBloomK.value = (studio ? 0.35 : 0.7) * (1 + 0.45 * dEnv + 0.15 * I);
        cu.uGrain.value = num(p, 'grain', 0.022);
        cu.uTime.value = frame.time;
        cu.uVig.value = studio ? 0.2 : 0.35;
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
