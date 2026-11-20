import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl';
import { createFullscreenQuad, makeRenderTarget } from '../../core/sceneHelpers';
import type { FrameContext, ParamDef, SceneDef, TrackAnalysis, TrackNote } from '../../core/types';
import { num } from '../../core/uniforms';
import { quality } from '../../render/quality';
import { approach, makeMaterial, stepDt, syncMaterial } from '../three/common';
import { TONEMAP_LIB } from './volume';

/**
 * Fountain Show: a choreographed water show on a long lake, watched from a terrace above the water.
 *
 * How the picture is made
 *   - ~131k water particles simulated on the GPU (two float textures, position + birth time and
 *     velocity + state, one MRT pass a frame). Every particle belongs to a nozzle and is re-born from
 *     it on a schedule: steady jets on a rolling cycle (a sub-frame offset keeps the stream evenly
 *     spaced), shooters and chasers in bursts when they are fired. Flight is ballistic with drag and a
 *     wind that grows with height; a share of the droplets turn to mist near the top of their arc (high
 *     drag, almost weightless, stirred by turbulence) and hang and drift downwind; droplets that come
 *     down splash once on the lake.
 *   - Nozzles are clusters of fine streams fanned round an axis (the needles of a real nozzle head),
 *     each with a slow waver and pressure flutter, so no two jets are alike.
 *   - Droplets are drawn as motion-blurred streaks (a 1/30 s shutter), additive, lit by the underwater
 *     light of their own nozzle: brightest at the base and fading up the stream. Mist is drawn as soft
 *     sprites into a small buffer. The same particles mirrored in the water make the reflection buffer,
 *     which the lake samples through its ripples.
 *   - The lake: analytic waves filtered to the pixel footprint, Fresnel, the sky and far shore in the
 *     reflection; dappled projector light and a ring of white froth round every working nozzle.
 *   - The far shore is a tree line with lamps, a city skyline glows behind it at night; by day the same
 *     shore is a sunny park (Time of day).
 *   - HDR throughout, a two-level bloom, ACES, grain. The camera is a person at the rail: a little
 *     handheld drift and breath, looking up as the water climbs, and a slow change of place between
 *     parts of the song.
 *
 * The show (how the music is mapped, see Show below)
 *   - kicks fire the tall shooters (a chase along the row, pairs from the centre, alternating sides);
 *     the drop fires every shooter at once, staggered from the middle, with the whole array at full
 *     height: the money shot. The last instant before a known drop everything cuts (the inhale).
 *   - hats run chases along the front row of small jets; snares pulse the long jets, and in a build
 *     they machine-gun the front row in alternating halves.
 *   - verses and pads: the long jets lean and wave side to side in tempo ("oarsmen"), in unison,
 *     mirrored, crossing or as a wave travelling along the row; choruses fan them out like a peacock;
 *     sustained passages can swirl the fan heads.
 *   - builds raise the heights bar by bar and open the row from the centre outwards.
 *   - quiet parts sink to low bubblers round a centre crown; with a melody known, the long jets play it
 *     like keys, low notes on the left, high on the right.
 *   - harmonic tension lifts every height; a chord coming home lets everything settle for a moment;
 *     a key lift adds height and light.
 *   - every part of the song gets its own formation and lighting scheme (sections that sound alike get
 *     the same one), and section changes cut on the downbeat.
 *
 * Palette roles (night): bg = night sky and deep water, fg = white water light, accent and accent2 =
 * the two underwater light colours, muted = the city glow and haze. By day: bg = sky, fg = sunlight
 * and white water, muted = the trees, accent / accent2 = flowers and the warm and cool tints of the water.
 */

const params: ParamDef[] = [
  { id: 'height', label: 'Jet height', group: 'Shape', type: 'number', min: 0.4, max: 1.4, step: 0.01, default: 1 },
  {
    id: 'smoothness',
    label: 'Smoothness',
    group: 'Shape',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.6,
    hint: 'High: crisp, glassy jets moving in tight unison. Low: wild, wind-torn spray, every jet with a mind of its own',
  },
  { id: 'mist', label: 'Mist', group: 'Shape', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1 },
  { id: 'day', label: 'Time of day', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0, hint: '0 = night with underwater lights, 1 = a sunny afternoon in the park' },
  { id: 'shooters', label: 'Kick shooters', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Kicks fire the tall shooters; the drop fires them all at once' },
  { id: 'chasers', label: 'Hat chasers', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Hi-hats run chases along the front row of small jets' },
  { id: 'sway', label: 'Oarsmen sway', group: 'Motion', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'How far the long jets lean as they wave in tempo' },
  { id: 'wind', label: 'Wind', group: 'Motion', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.6 },
  { id: 'handheld', label: 'Handheld camera', group: 'Motion', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1 },
  { id: 'colour', label: 'Light colour', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.75, hint: '0 = white water, 1 = the full colour of the underwater lights' },
  { id: 'dapple', label: 'Dappled light', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Projected spots of coloured light on the water round each nozzle' },
  { id: 'city', label: 'Skyline glow', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1 },
  { id: 'grain', label: 'Film grain', group: 'Color', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.025 },
];

/* ───────────────────────── layout ───────────────────────── */

const SIM_W = 512;
const SIM_H = 256;
const ROW_N = 24;
const ROW_P = 2560;
const MINI_N = 48;
const MINI_P = 512;
const SHOT_N = 10;
const SLOTS = 5;
const SHOT_P = 576;
const CROWN_P = SIM_W * SIM_H - (ROW_N * ROW_P + MINI_N * MINI_P + SHOT_N * SLOTS * SHOT_P);
const ROW0 = 0;
const MINI0 = ROW0 + ROW_N;
const CROWN = MINI0 + MINI_N;
const SHOT0 = CROWN + 1;
const SLOT0 = SHOT0 + SHOT_N;
const NOZ_W = SLOT0 + SHOT_N * (SLOTS - 1);
/** nozzles that are real places on the lake (the extra shooter slots share their shooter's spot) */
const PHYS = SLOT0;
const NOZ_ROWS = 6;
const G = 9.81;
const CAM_Y = 5;
const SHORE = 420;
/** particle lives (s): longest flight + time for the mist to hang */
const LIFE = { row: 6.2, mini: 3.2, shot: 9.5, crown: 4.6 };
/** a share of particles live longer: only they can turn to mist and hang in the air */
const LONG_SHARE = 0.3;
const LONG_K = 1.7;

const rowX = (i: number) => -64 + (128 * i) / (ROW_N - 1);
const rowZ = (x: number) => -76 - 18 * (x / 64) ** 2;
const miniX = (j: number) => -54 + (108 * j) / (MINI_N - 1);
const miniZ = (x: number) => -56 - 12 * (x / 54) ** 2;
const shotX = (s: number) => -56 + (112 * s) / (SHOT_N - 1);
const CROWN_Z = -66;
/** by day the small jets ring the aerator's foot at this radius (m) */
const RING_R = 2.6;
const slotIndex = (s: number, j: number) => (j === 0 ? SHOT0 + s : SLOT0 + s * (SLOTS - 1) + (j - 1));

/* ───────────────────────── GLSL: simulation ───────────────────────── */

const HASH = /* glsl */ `
uint fsPcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float fsRnd(uint a) { return float(fsPcg(a)) * (1.0 / 4294967295.0); }
`;

const SIM_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tPos, tVel, tInfo, tNoz;
uniform float uT, uDt, uInit, uTurb;
uniform vec3 uWind;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
${HASH}
vec4 NZ(int n, int r) { return texelFetch(tNoz, ivec2(n, r), 0); }
float fsVn(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); uint a = uint(int(mod(i, 1048576.0))); return mix(fsRnd(a * 2654435761u), fsRnd((a + 1u) * 2654435761u), f); }
vec3 fsFlow(vec3 p, float t) {
  return vec3(sin(p.y * 1.7 + t * 0.9 + sin(p.z * 1.3 + t * 0.4)) + 0.5 * sin(p.z * 2.9 - t * 1.3),
              0.6 * sin(p.x * 1.9 + t * 0.7 + sin(p.y * 1.1)),
              sin(p.x * 1.5 - t * 0.8 + sin(p.y * 2.1 - t * 0.5)) + 0.5 * sin(p.y * 3.1 + t * 1.1));
}
const vec3 GV = vec3(0.0, -${G.toFixed(2)}, 0.0);
const vec4 DEADP = vec4(0.0, -1000.0, 0.0, 0.0);
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  uint id = uint(ij.y * ${SIM_W} + ij.x);
  vec4 P = texelFetch(tPos, ij, 0);
  vec4 V = texelFetch(tVel, ij, 0);
  if (uInit > 0.5) { P = vec4(0.0, -1000.0, 0.0, -1e4); V = vec4(0.0, 0.0, 0.0, -1.0); }
  vec4 I = texelFetch(tInfo, ij, 0);
  int n = int(I.x + 0.5);
  float L = I.y;
  float r = fract(I.z);
  bool longC = I.z > 1.5;
  float sd = I.w;
  vec4 n0 = NZ(n, 0);
  vec4 n2 = NZ(n, 2);
  vec4 n3 = NZ(n, 3);
  float tb = P.w;
  float st = V.w;

  /* is it time for this particle to leave the nozzle again? */
  bool born = false;
  float te = 0.0;
  float cyc = 0.0;
  if (n0.w < 0.5) {
    float ph = sd * L;
    cyc = floor((uT - ph) / L);
    te = ph + cyc * L;
    born = te > tb + 1e-3;
  } else {
    te = n2.w + r * n3.x;
    cyc = floor(n2.w * 13.0);
    born = uT >= te && tb < te - 1e-3 && uT - te < 1.0;
  }
  if (born) {
    vec4 n1 = NZ(n, 1);
    vec4 n5 = NZ(n, 5);
    uint s = fsPcg(id * 9781u + uint(int(mod(cyc, 65536.0))) * 6271u);
    float ra = fsRnd(s), rb = fsRnd(s + 1u), rc = fsRnd(s + 2u), rd = fsRnd(s + 3u);
    float re = fsRnd(s + 4u), rf = fsRnd(s + 5u), rg = fsRnd(s + 6u);
    float thin = n0.w < 0.5 ? r : rg;
    bool alive = thin < n2.x && n1.w > 0.4;
    tb = te;
    if (!alive) {
      oPos = vec4(DEADP.xyz, tb);
      oVel = vec4(0.0, 0.0, 0.0, -1.0);
      return;
    }
    vec3 axis = normalize(n1.xyz + vec3(0.0, 1e-4, 0.0));
    float K = max(n3.w, 1.0);
    // a crown (many needles) keeps a third of its water for the tall centre plume
    bool centre = K > 6.5 && ra < 0.34;
    float k = K > 6.5 ? floor(clamp((ra - 0.34) / 0.66, 0.0, 0.999) * K) : floor(ra * K);
    vec3 dir = axis;
    float spd = n1.w;
    if (K > 1.5) {
      float phi = (k / K) * 6.2831853 + n5.x;
      vec3 up = abs(axis.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 t1 = normalize(cross(axis, up));
      vec3 t2 = cross(axis, t1);
      float f = centre ? 0.0 : n3.z * (0.85 + 0.3 * fract(k * 0.618));
      dir = normalize(axis * cos(f) + (t1 * cos(phi) + t2 * sin(phi)) * sin(f));
      if (!centre) spd *= n5.y;
    }
    float spread = n2.y;
    vec3 jit = vec3(rb - 0.5, rc - 0.5, rd - 0.5) * 2.0;
    // each stream wobbles slowly (droplets leaving close together share it, so the stream stays a
    // continuous wavy strand), with a little independent scatter; a few droplets stray wide
    float wseed = float(n) * 17.13 + k * 5.71;
    float wf = te * (2.2 + 1.5 * fract(wseed * 0.37));
    vec3 wob = vec3(fsVn(wf + wseed), fsVn(wf * 1.13 + wseed + 31.0), fsVn(wf * 0.91 + wseed + 57.0)) * 2.0 - 1.0;
    float press = fsVn(te * 1.7 + wseed + 91.0) * 2.0 - 1.0;
    float stray = re < 0.08 ? 4.0 : 1.0;
    vec3 v0 = dir * spd * (1.0 + press * 0.035 * (0.3 + spread) + (rf - 0.5) * 0.012) + (wob * 0.9 + jit * 0.3 * stray) * spread;
    // an aerated (foam) jet comes out wide and churning
    v0 += jit * n3.y * spd * 0.4;
    float role = longC && fsRnd(s + 7u) < n2.z / ${LONG_SHARE.toFixed(2)} ? 1.0 : 0.0;
    // a shooter's throat is wide; a chaser's is a pencil
    vec3 p0 = n0.xyz + jit * vec3(0.3, 0.0, 0.3) * (n0.w > 0.5 ? (n3.y > 0.1 ? 2.2 : 0.2) : 1.0);
    // shooters throw a skirt of spray round their foot
    if (n0.w > 0.5 && fsRnd(s + 8u) < n5.z) {
      vec2 rr = normalize(vec2(rb - 0.5, rc - 0.5) + 1e-4);
      float pw = clamp(n1.w / 35.0, 0.3, 1.2);
      v0 = vec3(rr.x * (3.0 + 9.0 * rd), 2.0 + 10.0 * re, rr.y * (3.0 + 9.0 * rd)) * pw;
      role = 0.0;
    }
    p0.y = 0.1;
    float a = uT - te;
    vec3 p = p0 + v0 * a + 0.5 * GV * a * a;
    vec3 v = v0 + GV * a;
    float apex = max(v0.y / ${G.toFixed(2)}, 0.08);
    st = role > 0.5 ? 1000.0 + apex : apex;
    if (p.y < 0.0) {
      oPos = vec4(DEADP.xyz, tb);
      oVel = vec4(0.0, 0.0, 0.0, -1.0);
    } else {
      oPos = vec4(p, tb);
      oVel = vec4(v, st);
    }
    return;
  }

  /* dead particles wait for their next turn */
  if (st > -1.5 && st < -0.5) {
    oPos = P;
    oVel = V;
    return;
  }
  float age = uT - tb;
  if (age > L) {
    oPos = vec4(DEADP.xyz, tb);
    oVel = vec4(0.0, 0.0, 0.0, -1.0);
    return;
  }
  vec3 p = P.xyz;
  vec3 v = V.xyz;
  float rs = fsRnd(id * 31u + 7u);
  // the wind grows with height
  float wh = clamp(log(1.0 + max(p.y, 0.0)) / log(40.0), 0.15, 1.35);
  float k = 0.02 + 0.05 * rs;
  vec3 g = GV;
  float m = 0.0;
  if (st > 999.0) {
    float apex = st - 1000.0;
    m = smoothstep(apex * 0.35, apex * 0.9 + 0.25, age);
    k = mix(k, 0.7 + 1.5 * rs, m);
    g *= mix(1.0, 0.03 + 0.06 * rs, m);
  } else if (st < -1.5) {
    k = 0.5;
  }
  vec3 fl = fsFlow(p * 0.12 + rs * 3.0, uT) * uTurb * (0.2 + 2.2 * m);
  v += (g + (uWind * wh - v) * k + fl) * uDt;
  p += v * uDt;
  if (p.y < 0.0 && v.y < 0.0) {
    uint q = fsPcg(id * 13u + uint(uT * 60.0));
    if (st >= 0.0 && m < 0.5 && fsRnd(q) < 0.5) {
      // a splash: the droplet bounces off the lake as a little spray
      vec2 rr = vec2(fsRnd(q + 1u) - 0.5, fsRnd(q + 2u) - 0.5);
      v = vec3(v.x * 0.12 + rr.x * 2.4, abs(v.y) * (0.05 + 0.2 * fsRnd(q + 3u)), v.z * 0.12 + rr.y * 2.4);
      p.y = 0.02;
      st = -2.0;
      tb = uT - (L - 1.3);
    } else {
      oPos = vec4(DEADP.xyz, tb);
      oVel = vec4(0.0, 0.0, 0.0, -1.0);
      return;
    }
  }
  oPos = vec4(p, tb);
  oVel = vec4(v, st);
}
`;

/* ───────────────────────── GLSL: drawing the water ───────────────────────── */

const PARTICLE_COMMON = /* glsl */ `
precision highp sampler2D;
uniform sampler2D tPos, tVel, tInfo, tNoz;
uniform float uT, uGain, uMirror, uFocal, uDay;
uniform vec2 uRes;
uniform vec3 uAmb, uSunCol, uSunDir, uSkyAmb;
attribute vec2 aRef;
vec4 NZ(int n, int r) { return texelFetch(tNoz, ivec2(n, r), 0); }
// light reaching a droplet from its own nozzle's lamps (from below: strongest at the base)
vec3 fsLight(int n, vec3 p, float soft) {
  vec4 Lr = NZ(n, 4);
  vec4 b = NZ(n, 0);
  float h = max(p.y, 0.0);
  vec2 dxz = p.xz - b.xz;
  float R = max(Lr.w, 2.0) * soft;
  float e = 1.0 / (1.0 + (h * h + 0.4 * dot(dxz, dxz)) / (R * R));
  vec3 night = Lr.rgb * e + uAmb;
  // by day: sunlight, brighter looking toward the sun through the spray
  vec3 vd = normalize(p - cameraPosition);
  float fwd = pow(max(dot(vd, uSunDir), 0.0), 3.0);
  vec3 day = uSunCol * (0.32 + 0.9 * fwd) + uSkyAmb * 0.5;
  return mix(night, day, uDay);
}
// age, mistiness and splash state of a particle
void fsState(vec4 P, vec4 V, float L, out float age, out float m, out float splash) {
  age = uT - P.w;
  m = 0.0;
  splash = 0.0;
  if (V.w > 999.0) {
    float apex = V.w - 1000.0;
    m = smoothstep(apex * 0.35, apex * 0.9 + 0.25, age);
  } else if (V.w < -1.5) {
    splash = 1.0 - clamp((age - (L - 1.3)) / 1.3, 0.0, 1.0);
  }
}
`;

const STREAK_VERT = /* glsl */ `
${PARTICLE_COMMON}
uniform float uShutter;
varying vec3 vCol;
varying vec2 vQ;
varying float vEnd;
void main() {
  vCol = vec3(0.0);
  vQ = vec2(0.0);
  vEnd = 1.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  ivec2 ij = ivec2(aRef);
  vec4 V = texelFetch(tVel, ij, 0);
  if (V.w > -1.5 && V.w < -0.5) return;
  vec4 P = texelFetch(tPos, ij, 0);
  vec4 I = texelFetch(tInfo, ij, 0);
  int n = int(I.x + 0.5);
  float L = I.y;
  float age, m, splash;
  fsState(P, V, L, age, m, splash);
  float sw = 1.0 - m;
  if (sw < 0.03) return;
  vec3 head = P.xyz;
  // the rising core is a glassy rope: its droplets smear longer, so they join up into one strand
  float apexT0 = V.w > 999.0 ? V.w - 1000.0 : max(V.w, 0.1);
  float core = V.w < -1.5 ? 0.0 : 1.0 - smoothstep(0.15, 0.6, age / max(apexT0, 0.1));
  vec3 tail = P.xyz - V.xyz * uShutter * (1.0 + 2.2 * core);
  if (uMirror > 0.5) { head.y = -head.y; tail.y = -tail.y; }
  vec4 ch = projectionMatrix * viewMatrix * vec4(head, 1.0);
  vec4 ct = projectionMatrix * viewMatrix * vec4(tail, 1.0);
  if (ch.w < 0.5 || ct.w < 0.5) return;
  vec2 sh = ch.xy / ch.w * 0.5 * uRes;
  vec2 stl = ct.xy / ct.w * 0.5 * uRes;
  vec2 d = stl - sh;
  float len = length(d);
  vec2 dir = len > 1e-3 ? d / len : vec2(0.0, 1.0);
  vec2 nr = vec2(-dir.y, dir.x);
  // a droplet's blur: tight in the rising stream, wider once it breaks up past the top of its arc
  float apexT = V.w > 999.0 ? V.w - 1000.0 : max(V.w, 0.1);
  float brk = V.w < -1.5 ? 1.0 : smoothstep(0.55, 1.3, age / max(apexT, 0.1));
  float size = mix(0.1, 0.2, fract(I.w * 13.7)) * mix(1.0, 1.8, brk) * (1.0 + 1.5 * m);
  float wpx = size * uFocal / ch.w;
  float w = max(wpx, 1.2);
  float along = position.x;
  vec2 pos = mix(sh, stl, along) + dir * (along * 2.0 - 1.0) * w * 0.5 + nr * position.y * w * 0.5;
  gl_Position = vec4(pos / (0.5 * uRes), 0.0, 1.0);
  vQ = vec2(along * 2.0 - 1.0, position.y);
  vEnd = w / (len + w);
  float fade = smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(L * 0.85, L, age));
  if (V.w < -1.5) fade = splash * splash;
  vec3 lc = fsLight(n, P.xyz, 1.0);
  // the droplet's light is spread over its smear (energy kept, so long fast streaks are fainter)
  vCol = lc * uGain * (1.44 / ((max(len, 4.0) + w) * w)) * sw * fade * (1.0 - 0.8 * splash * (1.0 - 0.6 * uDay)) * (1.0 - 0.55 * brk) * (1.0 + 0.5 * core);
}
`;

const STREAK_FRAG = /* glsl */ `
varying vec3 vCol;
varying vec2 vQ;
varying float vEnd;
void main() {
  float across = exp(-vQ.y * vQ.y * 2.6);
  float ends = 1.0 - smoothstep(1.0 - vEnd, 1.0, abs(vQ.x));
  gl_FragColor = vec4(vCol * across * ends, 1.0);
}
`;

const MIST_VERT = /* glsl */ `
${PARTICLE_COMMON}
uniform float uMistSize;
varying vec3 vCol;
varying vec2 vQ;
void main() {
  vCol = vec3(0.0);
  vQ = vec2(0.0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  ivec2 ij = ivec2(aRef);
  vec4 V = texelFetch(tVel, ij, 0);
  if (V.w > -1.5 && V.w < -0.5) return;
  vec4 P = texelFetch(tPos, ij, 0);
  vec4 I = texelFetch(tInfo, ij, 0);
  int n = int(I.x + 0.5);
  float L = I.y;
  float age, m, splash;
  fsState(P, V, L, age, m, splash);
  float mw = max(m, splash * 0.12);
  if (V.w > 999.0) mw *= 1.0 - smoothstep(0.6, 2.0, age - (V.w - 1000.0) * 0.9);
  if (mw < 0.02) return;
  vec3 c = P.xyz;
  if (uMirror > 0.5) c.y = -c.y;
  vec4 cc = projectionMatrix * viewMatrix * vec4(c, 1.0);
  if (cc.w < 0.5) return;
  float grow = clamp((age - 0.5) / 5.0, 0.0, 1.0);
  float sz = (0.6 + 2.4 * m * (0.5 + fract(I.w * 7.3)) * (0.4 + grow) + splash * 0.8) * uMistSize;
  float px = clamp(sz * uFocal / cc.w, 1.5, 40.0);
  vec2 off = vec2(position.x * 2.0 - 1.0, position.y) * px;
  gl_Position = cc + vec4(off / (0.5 * uRes) * cc.w, 0.0, 0.0);
  vQ = vec2(position.x * 2.0 - 1.0, position.y);
  float fade = (1.0 - smoothstep(L * 0.55, L, age)) * smoothstep(0.0, 0.3, age);
  vec3 lc = fsLight(n, P.xyz, 0.9);
  // spread the same light over a bigger sprite (a little less than energy-conserving, mist glows)
  vCol = lc * uGain * mw * fade / (1.0 + px * px * 0.004);
}
`;

const MIST_FRAG = /* glsl */ `
varying vec3 vCol;
varying vec2 vQ;
void main() {
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 3.2) * (1.0 - r2);
  gl_FragColor = vec4(vCol * a, 1.0);
}
`;

/* light pools: the projector light dappled on the water round each nozzle, and its froth ring */
const POOL_VERT = /* glsl */ `
precision highp sampler2D;
uniform sampler2D tNoz;
uniform float uT;
attribute float aN;
varying vec2 vQ;
varying vec3 vLight;
varying float vAct, vSeed, vRing, vR;
vec4 NZ(int n, int r) { return texelFetch(tNoz, ivec2(n, r), 0); }
void main() {
  int n = int(aN + 0.5);
  vec4 b = NZ(n, 0);
  vec4 n1 = NZ(n, 1);
  vec4 n2 = NZ(n, 2);
  vec4 Lr = NZ(n, 4);
  float H = n1.w * n1.w / (2.0 * ${G.toFixed(2)});
  float R = 3.6 + 0.12 * min(Lr.w, 40.0);
  vR = R;
  vec3 wp = vec3(b.x + position.x * R, 0.03, b.z + position.y * R);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vQ = position.xy;
  vLight = Lr.rgb;
  vAct = clamp(n2.x, 0.0, 1.0) * smoothstep(0.4, 3.0, n1.w) * (1.0 - NZ(n, 5).w);
  vSeed = aN;
  vRing = (1.2 + 0.08 * min(H, 30.0)) / R;
}
`;

const POOL_FRAG = /* glsl */ `
float fsSq(float x) { return x * x; }
uniform float uT, uDay, uDapple;
uniform vec3 uC1, uC2, uC3, uSunCol, uFoam;
varying vec2 vQ;
varying vec3 vLight;
varying float vAct, vSeed, vRing, vR;
void main() {
  float r = length(vQ);
  if (r > 1.0) discard;
  // dapples: a jittered cell pattern turning slowly, wobbling with the ripples
  vec2 q = rot2(uT * 0.05 + vSeed) * vQ * 2.8;
  q += 0.25 * vec2(sin(q.y * 1.7 + uT * 1.3), cos(q.x * 1.9 - uT * 1.1));
  vec2 id = floor(q);
  vec2 f = fract(q);
  float best = 9.0;
  vec2 bid = vec2(0.0);
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 h = hash22(id + o + vSeed * 3.1);
    vec2 c = o + 0.5 + 0.38 * sin(uT * (0.5 + h) + h * 6.28) - f;
    float d = dot(c, c);
    if (d < best) { best = d; bid = id + o; }
  }
  float hh = hash21(bid + vSeed);
  float blob = (1.0 - smoothstep(0.05, 0.26, best)) * step(0.25, hh);
  vec3 tint = hh < 0.53 ? uC1 : hh < 0.76 ? uC2 : uC3;
  vec3 lc = mix(vLight, tint * (0.3 + dot(vLight, vec3(0.33))), 0.65);
  float fall = exp(-r * r * 2.2);
  vec3 col = vLight * (exp(-r * r * 30.0) * 0.12 + exp(-r * r * 6.0) * 0.025); // the hot spot over the lamps
  col += vLight * fall * 0.01;
  col += lc * blob * fall * 0.14 * uDapple;
  col *= (1.0 - uDay) * vAct;
  // froth: a ring of white water churned up at the jet's foot
  float rr = r / max(vRing, 0.02);
  float ring = exp(-fsSq((rr - 0.9) / 0.4)) + 0.3 * exp(-rr * rr * 3.0);
  float n1 = tnoise(vQ * vR * 1.3 + vec2(uT * 1.7, -uT * 1.3) + vSeed * 7.0);
  float n2 = tnoise(vQ * vR * 3.1 - vec2(uT * 2.3, uT * 0.9) + vSeed * 3.0);
  float froth = ring * smoothstep(0.45, 0.95, n1 * 0.65 + n2 * 0.5) * vAct;
  vec3 fc = mix(vLight * 0.8 + uFoam * 0.05, uSunCol * 0.55 + uFoam * 0.2, uDay);
  col += fc * froth * mix(0.14, 0.1, uDay);
  gl_FragColor = vec4(col, 1.0);
}
`;

/* sky, far shore, city and the lake (one full-screen pass, linear HDR) */
const BG_FRAG = /* glsl */ `
precision highp sampler2D;
float fsSq(float x) { return x * x; }
uniform vec3 uCamPos;
uniform mat3 uCamBasis;
uniform vec2 uTanHalf;
uniform sampler2D tRefl;
uniform float uDay, uCity, uChop, uWaveT, uPix, uReflGain, uShore;
uniform vec3 uSkyLo, uSkyHi, uCityGlow, uSunDir, uSunCol, uFoliage, uWaterCol, uShowGlow, uLampCol;

float fsShoreE() { return -atan(uCamPos.y / uShore); }

// towers far behind the trees: in angle space, in two layers
float fsTower(float az, float wdt, float seed, float scale, out vec2 cell) {
  float k = az / wdt;
  float i = floor(k);
  cell = vec2(i, fract(k));
  float h = hash11(i * 1.371 + seed);
  float cluster = exp(-fsSq((az - 0.22) / 0.42)) + 0.25 * exp(-fsSq((az + 0.75) / 0.25));
  float top = (0.004 + 0.05 * pow(h, 3.0)) * scale * (0.15 + cluster);
  // a setback near the top of the taller ones
  float edge = abs(cell.y - 0.5);
  top -= step(0.32, edge) * top * 0.18 * step(0.6, h);
  // gaps between blocks
  top *= step(0.08, cell.y) * step(cell.y, 0.94) * step(0.18, hash11(i * 7.13 + seed));
  return top;
}

vec3 fsCity(float az, float e, out float cov) {
  cov = 0.0;
  vec3 col = vec3(0.0);
  float base = fsShoreE() + 0.003;
  for (int L = 0; L < 2; L++) {
    float wdt = L == 0 ? 0.0065 : 0.011;
    vec2 cell;
    float top = base + fsTower(az, wdt, float(L) * 17.0, L == 0 ? 0.8 : 1.15, cell);
    if (e < top && e > base - 0.01) {
      cov = 1.0;
      float hz = L == 0 ? 0.55 : 0.3;
      vec3 c = mix(uSkyLo * 0.25, uCityGlow * 0.6 + uSkyLo * 0.4, hz);
      // windows: lit at random, a few warm, a few cool
      vec2 wq = vec2(cell.y * 7.0, (e - base) / 0.0011);
      vec2 wid = floor(wq) + cell.x * 11.0;
      float lit = step(0.72, hash21(wid + floor(uTime * 0.02 + hash11(cell.x) * 5.0)));
      vec2 wf = fract(wq);
      float win = smoothstep(0.15, 0.3, wf.x) * smoothstep(0.85, 0.7, wf.x) * smoothstep(0.2, 0.35, wf.y) * smoothstep(0.8, 0.65, wf.y);
      vec3 wc = mix(vec3(1.0, 0.72, 0.42), vec3(0.75, 0.85, 1.0), step(0.75, hash21(wid * 1.7)));
      c += wc * lit * win * (L == 0 ? 0.35 : 0.6) * uCity;
      // red warning lights on the tallest, blinking
      float tall = step(0.03, top - base);
      float beacon = exp(-fsSq((cell.y - 0.5) / 0.08) - fsSq((e - top + 0.0008) / 0.0006));
      c += vec3(1.0, 0.08, 0.04) * beacon * tall * step(0.5, fract(uTime * 0.8 + hash11(cell.x))) * 3.0 * uCity;
      col = c * (1.0 - uDay * 0.6) + uSkyLo * uDay * 0.75;
      break;
    }
  }
  return col;
}

// the far shore: trees of every size and spacing (a willow or two among them), lamps along a path at
// its foot. Each tree is a trunk and a lumpy crown with a ragged leafy edge; a willow's crown hangs in
// strands down to the water.
vec3 fsShore(float az, float e, inout float cov) {
  float base = fsShoreE();
  float tall = 1.0 + 8.0 * uDay;
  float sc = 0.0068 * tall;
  float x = az * mix(70.0, 19.0, uDay);
  float k = floor(x);
  float crowns = 0.0;
  float shade = 0.0;
  float isWillow = 0.0;
  float trunk = 0.0;
  for (int j = -2; j <= 2; j++) {
    float c = k + float(j);
    if (hash11(c * 8.11) < 0.16) continue;
    float h = hash11(c * 3.17);
    float size = 0.45 + 1.1 * h * h + 0.35 * hash11(c * 4.4);
    float cx = c + 0.5 + (hash11(c * 1.9) - 0.5) * 0.95;
    float willow = step(0.88, hash11(c * 5.3));
    // broad round crowns that overlap their neighbours, the odd tall narrow one (a poplar)
    float poplar = step(0.9, hash11(c * 12.3)) * (1.0 - willow);
    float hw = size * (0.75 + 0.55 * hash11(c * 2.7)) * (1.0 + 0.5 * willow) * (1.0 - 0.35 * poplar);
    float ch = size * (0.7 + 0.45 * hash11(c * 6.1)) * (1.0 + 0.35 * poplar);
    float trunkH = (0.05 + 0.1 * hash11(c * 9.7)) * ch;
    float dx = (x - cx) / hw;
    // the trunk, a little off true
    float tx = x - cx - 0.08 * hw * (e - base) / sc;
    if (abs(tx) < 0.02 + 0.02 * size && e < base + sc * (trunkH + 0.3 * ch)) trunk = 1.0;
    if (abs(dx) > 1.25) continue;
    // a lumpy top made of a few lobes, and a ragged leafy edge
    float lobes = 0.8 + 0.12 * cos(dx * (4.0 + 4.0 * hash11(c * 7.7)) + c * 1.3) + 0.12 * tnoise(vec2(x * 2.3, c));
    float top = base + sc * (trunkH + ch * pow(max(0.0, 1.0 - dx * dx), 0.4) * lobes);
    float bottom = base + sc * trunkH * (1.0 - 0.9 * willow) * (0.8 + 0.4 * tnoise(vec2(x * 3.1, c * 2.0)));
    float rag = (tnoise(vec2(x * 6.0, (e - base) / sc * 3.0)) * 0.7 + tnoise(vec2(x * 17.0, (e - base) / sc * 9.0)) * 0.3 - 0.5) * 0.16 * sc * ch;
    float edgeW = 0.04 * sc;
    float inside = smoothstep(-edgeW, edgeW, top + rag - e) * smoothstep(-edgeW, edgeW, e - bottom - rag * 0.6);
    if (willow > 0.5) {
      // hanging strands below the dome, thinning toward the water
      float dome = base + sc * (trunkH + 0.45 * ch);
      float strand = tnoise(vec2(x * 38.0, 0.0)) + tnoise(vec2(x * 81.0, 1.7)) * 0.5;
      float hang = clamp((dome - e) / max(dome - bottom, 1e-5), 0.0, 1.0);
      inside *= e > dome ? 1.0 : step(0.55 + 0.6 * hang, strand + 0.25);
    }
    if (inside > crowns) {
      crowns = inside;
      shade = clamp((e - bottom) / max(top - bottom, 1e-5), 0.0, 1.0);
      isWillow = willow;
    }
  }
  trunk *= 1.0 - crowns;
  trunk *= step(base - 0.0005, e);
  // a softer, paler canopy further back fills the gaps
  float back = base + (0.0035 + 0.0035 * tnoise(vec2(az * 22.0, 3.0)) + 0.002 * tnoise(vec2(az * 90.0, 7.0))) * tall;
  float far = step(e, back) * step(base - 0.001, e) * (1.0 - crowns) * (1.0 - trunk);
  float t = max(max(crowns, far), trunk);
  vec3 col = vec3(0.0);
  if (t > 0.0) {
    // by day: sunlit tops, deep shade below, clumps of leaves; by night: near-black, city light on the tops
    float leaf = tnoise(vec2(x * 9.0, (e - base) / sc * 7.0)) * 0.6 + tnoise(vec2(x * 23.0, (e - base) / sc * 17.0)) * 0.4;
    vec3 fol = uFoliage * mix(vec3(1.0), vec3(1.2, 1.25, 0.75), isWillow);
    vec3 dayC = fol * (0.1 + 0.6 * pow(shade, 1.4)) * (0.45 + 0.9 * leaf) * uSunCol * 0.5;
    vec3 nightC = uSkyLo * 0.06 + uCityGlow * 0.05 * shade;
    vec3 farC = mix(uSkyLo * 0.035, mix(uFoliage * uSunCol * 0.32 * (0.7 + 0.5 * leaf), uSkyLo * 0.8, 0.3), uDay);
    vec3 trunkC = mix(uSkyLo * 0.03, uFoliage * 0.06 + vec3(0.02, 0.015, 0.01), uDay);
    col = mix(nightC, dayC, uDay);
    col = mix(col, farC, far);
    col = mix(col, trunkC, trunk);
    cov = max(cov, t);
  }
  // lamps along the shore path (night)
  float lx = az * 34.0;
  float li = floor(lx);
  float lf = fract(lx) - 0.5;
  float lamp = exp(-(lf * lf) / 0.0006 - fsSq((e - base - 0.0012) / 0.00045)) * step(0.35, hash11(li * 2.3));
  col += uLampCol * lamp * 6.0 * (1.0 - uDay);
  cov = max(cov, min(lamp * 4.0, 1.0) * (1.0 - uDay));
  return col;
}

// eShore: the elevation at which to look up the far shore (the direct one, or for a ray bounced off
// the water, where on the trees it lands, so the reflection hangs from the shore line)
vec3 fsSky(vec3 rd, float eShore) {
  float e = asin(clamp(rd.y, -1.0, 1.0));
  float az = atan(rd.x, -rd.z);
  vec3 col = mix(uSkyLo, uSkyHi, smoothstep(0.0, 0.55, e));
  float cityMask = exp(-fsSq((az - 0.22) / 0.5));
  col += uCityGlow * (0.3 + cityMask) * exp(-max(e, 0.0) * 10.0) * uCity * (1.0 - uDay);
  float sd = max(dot(rd, uSunDir), 0.0);
  col += uSunCol * (pow(sd, 8.0) * 0.12 + pow(sd, 900.0) * 4.0) * uDay;
  // a few stars where the city glow lets them through
  vec2 sq = vec2(az * 260.0, e * 260.0);
  vec2 si = floor(sq);
  float sh = hash21(si);
  float star = step(0.997, sh) * exp(-dot(fract(sq) - 0.5, fract(sq) - 0.5) * 30.0) * smoothstep(0.05, 0.3, e);
  col += vec3(0.9, 0.95, 1.0) * star * (0.6 + 0.4 * sin(uTime * 3.0 + sh * 60.0)) * 0.22 * (1.0 - uDay) * (1.0 - cityMask * 0.8);
  // faint thin cloud by day
  float cl = tfbm(vec2(az * 3.0, e * 9.0) + vec2(uTime * 0.004, 0.0), 4);
  col = mix(col, uSunCol * 0.42, smoothstep(0.1, 0.6, cl) * 0.5 * uDay * smoothstep(0.02, 0.2, e));
  float cov;
  vec3 city = fsCity(az, eShore, cov);
  col = mix(col, city, cov * (1.0 - uDay));
  float sc = 0.0;
  vec3 shore = fsShore(az, eShore, sc);
  col = mix(col, shore, sc);
  return col;
}

// ripples, filtered to the pixel's footprint so the distance doesn't shimmer
vec3 fsWaterN(vec2 p, float foot, float chop) {
  vec2 g = vec2(0.0);
  float lam = 5.0;
  float ang = 0.4;
  for (int i = 0; i < 8; i++) {
    vec2 d = vec2(cos(ang), sin(ang));
    float k = 6.2831853 / lam;
    float w = sqrt(${G.toFixed(2)} * k);
    // the crests wander (a warped phase), so far off they don't line up into regular bands
    float ph = dot(d, p) * k - w * uWaveT + float(i) * 1.7 + 3.0 * tnoise(p * (0.6 / lam) + float(i) * 3.1);
    float fade = 1.0 - smoothstep(0.25, 0.7, foot / lam);
    float slope = 0.04 * mix(1.0, 0.5, uDay) * (1.0 + chop * (i > 2 ? 3.0 : 1.0)) * (0.6 + 0.8 * tnoise(p * 0.02 + float(i) * 7.0));
    g += d * cos(ph) * slope * fade;
    lam *= 0.6;
    ang += 2.13;
  }
  float nf = 1.0 - smoothstep(0.2, 1.2, foot / 0.8);
  g += (vec2(tnoise(p * 1.3 + uWaveT * 0.4), tnoise(p * 1.3 + 37.0 - uWaveT * 0.35)) - 0.5) * 0.12 * nf * (1.0 + chop * 2.0);
  return normalize(vec3(-g.x, 1.0, -g.y));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 rd = normalize(uCamBasis * vec3(ndc.x * uTanHalf.x, ndc.y * uTanHalf.y, -1.0));
  vec3 col;
  float e = asin(clamp(rd.y, -1.0, 1.0));
  if (e > fsShoreE()) {
    col = fsSky(rd, e);
  } else {
    float t = -uCamPos.y / min(rd.y, -1e-4);
    vec3 hp = uCamPos + rd * t;
    float foot = t * uPix / max(-rd.y, 0.02);
    // the water round the fountains is churned
    float near = exp(-fsSq((hp.z + 74.0) / 26.0)) * smoothstep(90.0, 55.0, abs(hp.x));
    vec3 n = fsWaterN(hp.xz, foot, uChop * near);
    vec3 rr = reflect(rd, n);
    rr.y = max(rr.y, 0.002);
    float cosi = clamp(dot(-rd, n), 0.0, 1.0);
    float F = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
    vec3 rn = normalize(rr);
    // the bounced ray climbs from this spot on the water: the height it reaches at the far bank, seen from the eye
    float hitH = max(uShore - t, 0.0) * rn.y / max(length(rn.xz), 1e-3);
    vec3 refl = fsSky(rn, fsShoreE() + atan(hitH / uShore));
    // the jets mirrored: sampled through the ripples and smeared down a little, like light on a lake
    vec2 dist = vec2(n.x, n.z) * vec2(0.35, 0.9) * clamp(30.0 / t, 0.15, 1.5) * 0.12;
    vec3 jets = vec3(0.0);
    jets += texture2D(tRefl, uv + dist).rgb * 0.4;
    jets += texture2D(tRefl, uv + dist * 1.6 + vec2(0.0, -0.006)).rgb * 0.3;
    jets += texture2D(tRefl, uv + dist * 0.5 + vec2(0.0, 0.006)).rgb * 0.3;
    vec3 body = uWaterCol * mix(0.05, 0.5, uDay) + uShowGlow * 0.02 * near;
    col = body * (1.0 - F) + (refl + jets * uReflGain) * F;
    // a low haze over the water, lit by the show
    float haze = 1.0 - exp(-t / 900.0);
    col = mix(col, uSkyLo * 0.9, haze * 0.6);
  }
  // the show lights the mist hanging over the lake
  float glowBand = exp(-fsSq((e - 0.02) / 0.09));
  col += uShowGlow * glowBand * 0.05;
  gl_FragColor = vec4(col, 1.0);
}
`;

/* bloom + tonemap */
const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tA, tB;
uniform vec2 uTexel;
uniform float uMistGain, uLow;
void main() {
  vec3 c = vec3(0.0);
  for (int j = -1; j <= 1; j += 2)
  for (int i = -1; i <= 1; i += 2) {
    vec2 o = vec2(float(i), float(j)) * uTexel;
    c += texture2D(tA, vUv + o).rgb + texture2D(tB, vUv + o).rgb * uMistGain;
  }
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  c *= smoothstep(0.5, 2.5, l) * 0.8 + uLow * smoothstep(0.1, 1.0, l);
  gl_FragColor = vec4(c, 1.0);
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
uniform sampler2D tHdr, tMist, tBloomA, tBloomB;
uniform vec2 uMistTexel;
uniform float uExposure, uGrain, uTime, uMistGain, uBloom, uAspect;
uniform vec3 uLift;
${TONEMAP_LIB}
float ch21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main() {
  vec3 c = texture2D(tHdr, vUv).rgb;
  vec3 m = texture2D(tMist, vUv).rgb * 0.4;
  m += (texture2D(tMist, vUv + vec2(uMistTexel.x, 0.0)).rgb + texture2D(tMist, vUv - vec2(uMistTexel.x, 0.0)).rgb
      + texture2D(tMist, vUv + vec2(0.0, uMistTexel.y)).rgb + texture2D(tMist, vUv - vec2(0.0, uMistTexel.y)).rgb) * 0.15;
  c += m * uMistGain;
  c += (texture2D(tBloomA, vUv).rgb * 0.55 + texture2D(tBloomB, vUv).rgb * 0.7) * uBloom;
  c += uLift;
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  c *= 1.0 - 0.32 * smoothstep(0.35, 1.1, length(q));
  vec3 col = ntToDisplay(c, uExposure);
  col += (ch21(gl_FragCoord.xy + fract(uTime * 7.31) * 517.0) - 0.5) * uGrain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── the show (CPU) ───────────────────────── */

type Form = 'rest' | 'sway' | 'wave' | 'fan' | 'build' | 'drop' | 'cross' | 'swirl';
type MiniMode = 'bubble' | 'curtain' | 'chase' | 'machine' | 'full';
type ShotMode = 'off' | 'kick' | 'pairs' | 'alt';

/** small deterministic hash 0..1 */
const hsh = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const speedFor = (h: number) => Math.sqrt(2 * G * Math.max(h, 0)) * 1.04;

interface Plan {
  form: Form;
  mini: MiniMode;
  shot: ShotMode;
  /** sway pattern (0 unison, 1 mirror, 2 alternate, 3 travelling) */
  pattern: number;
  /** lighting scheme */
  scheme: number;
  /** a camera framing */
  frame: number;
  seed: number;
}

/** what the analysis says about the part of the song we're in */
function planFor(frame: FrameContext, a: TrackAnalysis | null): Plan {
  const f = frame.feel;
  const au = frame.audio;
  const label = f.section;
  const secs = a?.sections;
  const sec = secs && f.sectionIndex >= 0 ? secs[f.sectionIndex] : null;
  // sections that sound alike share a seed, so a returning chorus returns to its formation
  const seed = sec ? sec.group * 7.31 + (label?.length ?? 0) : Math.floor(au.beatCount / 32) * 3.7;
  const r = hsh(seed);
  const r2 = hsh(seed + 1.7);
  const e = sec ? 0.5 * sec.energy + 0.5 * f.intensity : f.intensity;
  let form: Form;
  if (!label) {
    form = f.sinceDrop < 4 ? 'drop' : f.tension > 0.45 ? 'build' : e < 0.3 ? 'rest' : e > 0.72 ? 'fan' : r < 0.5 ? 'sway' : 'wave';
  } else if (label === 'build') form = 'build';
  else if (label === 'drop') form = f.sinceDrop < 3.5 ? 'drop' : r < 0.55 ? 'fan' : 'wave';
  else if (label === 'chorus') form = f.sinceDrop < 3 ? 'drop' : r < 0.45 ? 'fan' : r < 0.75 ? 'wave' : 'swirl';
  else if (label === 'verse') form = e < 0.28 ? 'rest' : r < 0.5 ? 'sway' : r < 0.8 ? 'wave' : 'cross';
  else if (label === 'bridge') form = e < 0.3 ? 'rest' : r < 0.5 ? 'cross' : 'swirl';
  else form = e < 0.42 ? 'rest' : r < 0.5 ? 'sway' : 'wave';
  if (f.sinceDrop < 3 && form !== 'build') form = 'drop';
  const loud = e > 0.55;
  const mini: MiniMode = form === 'rest' ? 'bubble' : form === 'build' ? 'machine' : form === 'drop' ? 'full' : au.hat > 0.05 || loud ? 'chase' : 'curtain';
  const shot: ShotMode = form === 'rest' || form === 'build' ? 'off' : form === 'drop' || form === 'fan' ? (r2 < 0.5 ? 'pairs' : 'kick') : e > 0.4 ? (r2 < 0.5 ? 'alt' : 'kick') : 'off';
  return { form, mini, shot, pattern: Math.floor(r2 * 4), scheme: Math.floor(hsh(seed + 4.1) * 5), frame: Math.floor(hsh(seed + 9.3) * 4), seed };
}

/* ───────────────────────── scene ───────────────────────── */

export const fountainShow: SceneDef = {
  id: 'fountain-show',
  name: 'Fountain Show',
  description:
    'A choreographed fountain show on a long lake at night, watched from a terrace: rows of jets made of fine needle streams that shoot, sway, swirl and burst to the song, mist hanging in the underwater light, dappled colour on the water and a city glowing behind the trees. Kicks fire tall shooters, hats run chases along the small jets, pads make the long jets wave side to side in tempo, builds raise the row bar by bar, the drop fires the whole array at once, and quiet parts sink to low bubblers round a centre crown. Also by day as a sunny park pond.',
  category: 'form',
  style: 'world',
  tags: ['euphoric', 'cinematic', 'epic', 'uplifting', 'celebratory', 'anthemic', 'romantic', 'energetic', 'dynamic', 'pop', 'edm', 'nature', 'realistic', 'spacious'],
  params,
  handInks: 4,
  modulations: [],
  create(init) {
    const { renderer, shared } = init;

    /* ── particle simulation ── */
    const simOpts = { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, count: 2 } as const;
    let simA = new THREE.WebGLRenderTarget(SIM_W, SIM_H, simOpts);
    let simB = new THREE.WebGLRenderTarget(SIM_W, SIM_H, simOpts);

    // per particle constants: nozzle, life, rank (thinning / burst stagger), seed (cycle phase, size)
    const info = new Float32Array(SIM_W * SIM_H * 4);
    {
      let p = 0;
      const put = (n: number, count: number, life: number) => {
        for (let k = 0; k < count; k++, p++) {
          const long = hsh(p * 2.71 + 0.3) < LONG_SHARE;
          info[p * 4] = n;
          info[p * 4 + 1] = life * (0.92 + 0.16 * hsh(p * 0.37 + 1.3)) * (long ? LONG_K : 1);
          info[p * 4 + 2] = long ? 2 : 0;
          info[p * 4 + 3] = hsh(p * 1.17 + 9.1);
        }
      };
      for (let i = 0; i < ROW_N; i++) put(ROW0 + i, ROW_P, LIFE.row);
      for (let j = 0; j < MINI_N; j++) put(MINI0 + j, MINI_P, LIFE.mini);
      for (let s = 0; s < SHOT_N; s++) for (let j = 0; j < SLOTS; j++) put(slotIndex(s, j), SHOT_P, LIFE.shot);
      put(CROWN, CROWN_P, LIFE.crown);
      // ranks shuffled within each nozzle so thinning takes droplets from every stream
      for (let i = 0; i < SIM_W * SIM_H; i++) info[i * 4 + 2] += hsh(i * 0.731 + 5.5);
    }
    const infoTex = new THREE.DataTexture(info, SIM_W, SIM_H, THREE.RGBAFormat, THREE.FloatType);
    infoTex.minFilter = infoTex.magFilter = THREE.NearestFilter;
    infoTex.needsUpdate = true;

    const tab = new Float32Array(NOZ_W * NOZ_ROWS * 4);
    const nozTex = new THREE.DataTexture(tab, NOZ_W, NOZ_ROWS, THREE.RGBAFormat, THREE.FloatType);
    nozTex.minFilter = nozTex.magFilter = THREE.NearestFilter;
    const put = (n: number, row: number, a: number, b: number, c: number, d: number) => {
      const o = (row * NOZ_W + n) * 4;
      tab[o] = a;
      tab[o + 1] = b;
      tab[o + 2] = c;
      tab[o + 3] = d;
    };
    const get = (n: number, row: number, k: number) => tab[(row * NOZ_W + n) * 4 + k];

    const simMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tPos: { value: null },
        tVel: { value: null },
        tInfo: { value: infoTex },
        tNoz: { value: nozTex },
        uT: { value: 0 },
        uDt: { value: 0 },
        uInit: { value: 1 },
        uTurb: { value: 0.5 },
        uWind: { value: new THREE.Vector3() },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: SIM_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const simQuad = createFullscreenQuad(simMat);

    /* ── particle drawing ── */
    const N = SIM_W * SIM_H;
    const refs = new Float32Array(N * 2);
    {
      // shuffled, so drawing the first part of the list is an even sample of every jet
      const order = new Uint32Array(N);
      for (let i = 0; i < N; i++) order[i] = i;
      let sd = 0x2f6b;
      for (let i = N - 1; i > 0; i--) {
        sd = (sd * 1103515245 + 12345) >>> 0;
        const j = sd % (i + 1);
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
      }
      for (let k = 0; k < N; k++) {
        refs[k * 2] = order[k] % SIM_W;
        refs[k * 2 + 1] = Math.floor(order[k] / SIM_W);
      }
    }
    const quadGeo = () => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      return g;
    };
    const pGeo = quadGeo();
    pGeo.setAttribute('aRef', new THREE.InstancedBufferAttribute(refs, 2));
    pGeo.instanceCount = N;

    const pu = {
      tPos: { value: null as THREE.Texture | null },
      tVel: { value: null as THREE.Texture | null },
      tInfo: { value: infoTex },
      tNoz: { value: nozTex },
      uT: { value: 0 },
      uFocal: { value: 1000 },
      uDay: { value: 0 },
      uAmb: { value: new THREE.Vector3() },
      uSunCol: { value: new THREE.Vector3(1, 1, 1) },
      uSunDir: { value: new THREE.Vector3(0.5, 0.4, -0.7).normalize() },
      uSkyAmb: { value: new THREE.Vector3() },
    };
    const additive = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, depthTest: false, depthWrite: false, transparent: true } as const;
    const streakMat = (mirror: boolean) =>
      new THREE.ShaderMaterial({
        uniforms: { ...pu, uGain: { value: 1 }, uMirror: { value: mirror ? 1 : 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uShutter: { value: 1 / 30 } },
        vertexShader: STREAK_VERT,
        fragmentShader: STREAK_FRAG,
        ...additive,
      });
    const mistMat = (mirror: boolean) =>
      new THREE.ShaderMaterial({
        uniforms: { ...pu, uGain: { value: 1 }, uMirror: { value: mirror ? 1 : 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uMistSize: { value: 1 } },
        vertexShader: MIST_VERT,
        fragmentShader: MIST_FRAG,
        ...additive,
      });
    const streakM = streakMat(false);
    const streakR = streakMat(true);
    const mistM = mistMat(false);
    const mistR = mistMat(true);
    const mkMesh = (m: THREE.ShaderMaterial) => {
      const mesh = new THREE.Mesh(pGeo, m);
      mesh.frustumCulled = false;
      return mesh;
    };
    const streakMesh = mkMesh(streakM);
    const streakReflMesh = mkMesh(streakR);
    const mistMesh = mkMesh(mistM);
    const mistReflMesh = mkMesh(mistR);

    /* light pools */
    const poolGeo = new THREE.InstancedBufferGeometry();
    poolGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    poolGeo.setIndex([0, 1, 2, 0, 2, 3]);
    poolGeo.setAttribute('aN', new THREE.InstancedBufferAttribute(new Float32Array(Array.from({ length: PHYS }, (_, i) => i)), 1));
    poolGeo.instanceCount = PHYS;
    const poolMat = makeMaterial({
      params,
      shared,
      vertex: POOL_VERT,
      fragment: POOL_FRAG,
      extra: {
        tNoz: { value: nozTex },
        uT: { value: 0 },
        uDay: { value: 0 },
        uDapple: { value: 1 },
        uC1: { value: new THREE.Vector3() },
        uC2: { value: new THREE.Vector3() },
        uC3: { value: new THREE.Vector3() },
        uSunCol: { value: new THREE.Vector3() },
        uFoam: { value: new THREE.Vector3() },
      },
      ...additive,
      // the quads lie flat on the lake, seen from above: both faces
      side: THREE.DoubleSide,
    });
    const poolMesh = new THREE.Mesh(poolGeo, poolMat);
    poolMesh.frustumCulled = false;

    const mainScene = new THREE.Scene();
    poolMesh.renderOrder = 0;
    streakMesh.renderOrder = 1;
    mainScene.add(poolMesh, streakMesh);
    const mistScene = new THREE.Scene();
    mistScene.add(mistMesh);
    const reflScene = new THREE.Scene();
    reflScene.add(streakReflMesh, mistReflMesh);

    /* background */
    const bgMat = makeMaterial({
      params,
      shared,
      vertex: /* glsl */ `void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragment: BG_FRAG,
      extra: {
        uCamPos: { value: new THREE.Vector3() },
        uCamBasis: { value: new THREE.Matrix3() },
        uTanHalf: { value: new THREE.Vector2(1, 1) },
        tRefl: { value: null },
        uDay: { value: 0 },
        uCity: { value: 1 },
        uChop: { value: 0 },
        uWaveT: { value: 0 },
        uPix: { value: 0.001 },
        uReflGain: { value: 1 },
        uShore: { value: SHORE },
        uSkyLo: { value: new THREE.Vector3() },
        uSkyHi: { value: new THREE.Vector3() },
        uCityGlow: { value: new THREE.Vector3() },
        uSunDir: { value: pu.uSunDir.value },
        uSunCol: { value: new THREE.Vector3() },
        uFoliage: { value: new THREE.Vector3() },
        uWaterCol: { value: new THREE.Vector3() },
        uShowGlow: { value: new THREE.Vector3() },
        uLampCol: { value: new THREE.Vector3() },
      },
      depthTest: false,
      depthWrite: false,
    });
    const bgQuad = createFullscreenQuad(bgMat);

    /* post */
    const brightMat = new THREE.ShaderMaterial({
      uniforms: { tA: { value: null }, tB: { value: null }, uTexel: { value: new THREE.Vector2() }, uMistGain: { value: 1 }, uLow: { value: 0.2 } },
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
        tHdr: { value: null },
        tMist: { value: null },
        tBloomA: { value: null },
        tBloomB: { value: null },
        uMistTexel: { value: new THREE.Vector2() },
        uExposure: { value: 1 },
        uGrain: { value: 0.025 },
        uTime: { value: 0 },
        uMistGain: { value: 1 },
        uBloom: { value: 1 },
        uAspect: { value: 1 },
        uLift: { value: new THREE.Vector3() },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMP_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const brightQuad = createFullscreenQuad(brightMat);
    const blurQuad = createFullscreenQuad(blurMat);
    const compQuad = createFullscreenQuad(compMat);

    let hdrRT: THREE.WebGLRenderTarget | null = null;
    let mistRT: THREE.WebGLRenderTarget | null = null;
    let reflRT: THREE.WebGLRenderTarget | null = null;
    let bA: THREE.WebGLRenderTarget | null = null;
    let bA2: THREE.WebGLRenderTarget | null = null;
    let bB: THREE.WebGLRenderTarget | null = null;
    let bB2: THREE.WebGLRenderTarget | null = null;
    const ensure = (w: number, h: number) => {
      if (hdrRT && hdrRT.width === w && hdrRT.height === h) return;
      for (const rt of [hdrRT, mistRT, reflRT, bA, bA2, bB, bB2]) rt?.dispose();
      const o = { type: THREE.HalfFloatType, depthBuffer: false };
      hdrRT = makeRenderTarget(w, h, o);
      mistRT = makeRenderTarget(Math.ceil(w * 0.34), Math.ceil(h * 0.34), o);
      reflRT = makeRenderTarget(Math.ceil(w * 0.5), Math.ceil(h * 0.5), o);
      bA = makeRenderTarget(Math.ceil(w / 4), Math.ceil(h / 4), o);
      bA2 = makeRenderTarget(Math.ceil(w / 4), Math.ceil(h / 4), o);
      bB = makeRenderTarget(Math.ceil(w / 12), Math.ceil(h / 12), o);
      bB2 = makeRenderTarget(Math.ceil(w / 12), Math.ceil(h / 12), o);
    };

    const camera = new THREE.PerspectiveCamera(36, 16 / 9, 1, 6000);

    /* ── show state ── */
    const rowH = new Float32Array(ROW_N);
    const rowTilt = new Float32Array(ROW_N);
    const rowRate = new Float32Array(ROW_N);
    const rowLight = new Float32Array(ROW_N * 3);
    const miniH = new Float32Array(MINI_N);
    const miniRate = new Float32Array(MINI_N);
    const miniLight = new Float32Array(MINI_N * 3);
    const shotLast = new Float32Array(SHOT_N).fill(-100);
    const shotSlot = new Uint8Array(SHOT_N);
    const shotPow = new Float32Array(SHOT_N);
    const melody = new Float32Array(ROW_N);
    let crownH = 2;
    let t = 0;
    let beats = 0;
    let kickEnv = 0;
    let snareEnv = 0;
    let settle = 0;
    let hatPtr = 0;
    let hatDir = 1;
    let shotPtr = 0;
    let pairPtr = 0;
    let snareSide = 0;
    let prevSince = 99;
    let shake = 0;
    let waveT = 0;
    let lastRes = -1;
    let leadNotes: TrackNote[] = [];
    let leadLo = 60;
    let leadHi = 84;
    let leadFor: TrackAnalysis | null = null;
    let first = true;
    let camX = 0;
    let camYaw = 0;
    let camFov = 0;
    let camPitch = 0;
    // 0 = up at the rail, 1 = down on the water's edge close to the jets (quiet parts)
    let camNear = 0;
    let lookH = 10;
    let avgH = 10;
    let glowR = 0;
    let glowG = 0;
    let glowB = 0;
    const tmpC = new THREE.Color();
    const lin = (c: THREE.Color) => [Math.pow(c.r, 2.2), Math.pow(c.g, 2.2), Math.pow(c.b, 2.2)];

    // fixed places. Night: the long show on the lake. Park (by day): one aerator in a pond, the small
    // jets in a ring round its foot as the low crown, the shooters as surges up its middle.
    let parkLayout: boolean | null = null;
    const layout = (park: boolean) => {
      parkLayout = park;
      for (let i = 0; i < ROW_N; i++) {
        const x = rowX(i);
        put(ROW0 + i, 0, x, 0, rowZ(x), 0);
      }
      for (let j = 0; j < MINI_N; j++) {
        const a = (j / MINI_N) * Math.PI * 2;
        const x = park ? Math.sin(a) * RING_R : miniX(j);
        put(MINI0 + j, 0, x, 0, park ? CROWN_Z + Math.cos(a) * RING_R : miniZ(x), 0);
        put(MINI0 + j, 5, 0, 1, 0, park ? 0.85 : 0.8);
      }
      put(CROWN, 0, 0, 0, CROWN_Z, 0);
      for (let s = 0; s < SHOT_N; s++) {
        const x = shotX(s) + (s === 4 ? 3 : s === 5 ? -3 : 0);
        for (let j = 0; j < SLOTS; j++) put(slotIndex(s, j), 0, park ? 0 : x, 0, park ? CROWN_Z : rowZ(x) - 5, 1);
      }
    };
    layout(false);

    const fireShooter = (s: number, at: number, h: number, pulse: number, smoothK: number) => {
      const j = shotSlot[s] % SLOTS;
      shotSlot[s]++;
      const n = slotIndex(s, j);
      const lean = (hsh(at * 3.1 + s) - 0.5) * 0.06 * (1.6 - smoothK);
      put(n, 1, lean, 1, (hsh(at * 1.3 + s * 2) - 0.5) * 0.04, speedFor(h));
      put(n, 2, 1, 0.3 + 0.9 * (1 - smoothK), 0.55, at);
      put(n, 3, pulse, 0.12, 0, 1);
      put(n, 5, 0, 1, 0.06, 0);
      shotLast[s] = at;
      shotPow[s] = Math.min(1.4, h / 60);
    };
    const fireMini = (j: number, at: number, h: number) => {
      const n = MINI0 + j;
      put(n, 0, get(n, 0, 0), 0, get(n, 0, 2), 1);
      put(n, 1, 0, 1, 0, speedFor(h));
      put(n, 2, 1, get(n, 2, 1), 0.08, at);
      put(n, 3, 0.14, 0, 0, 1);
      miniH[j] = Math.max(miniH[j], h);
    };

    /** which lead notes sound now → a height boost per row nozzle (the melody played like keys) */
    const melodyAt = (time: number, a: TrackAnalysis | null) => {
      if (a !== leadFor) {
        leadFor = a;
        leadNotes = (a?.layers?.lead ?? []).slice().sort((x, y) => x.t - y.t);
        if (leadNotes.length) {
          const ps = leadNotes.map((n) => n.midi).sort((x, y) => x - y);
          leadLo = ps[Math.floor(ps.length * 0.05)];
          leadHi = Math.max(leadLo + 7, ps[Math.floor(ps.length * 0.95)]);
        }
      }
      melody.fill(0);
      if (!leadNotes.length) return false;
      let lo = 0;
      let hi = leadNotes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (leadNotes[mid].t <= time) lo = mid + 1;
        else hi = mid;
      }
      let any = false;
      for (let k = lo - 1; k >= 0 && k > lo - 24; k--) {
        const nt = leadNotes[k];
        const tail = time - nt.end;
        if (tail > 0.7) continue;
        const env = (tail <= 0 ? 1 : Math.exp(-tail * 4)) * (0.5 + 0.5 * Math.min(1, nt.v * 1.5));
        const u = -0.85 + 1.7 * clamp01((nt.midi - leadLo) / (leadHi - leadLo));
        for (let i = 0; i < ROW_N; i++) {
          const ui = (i / (ROW_N - 1)) * 2 - 1;
          const w = Math.exp(-(((ui - u) / 0.08) ** 2));
          if (w > 0.01) melody[i] = Math.max(melody[i], w * env);
        }
        any = true;
      }
      return any;
    };

    return {
      render(frame, target) {
        const dt = stepDt(frame);
        const au = frame.audio;
        const f = frame.feel;
        const p = frame.params;
        const pal = frame.palette.c;
        const ana = frame.analysis;
        t = frame.time;
        const hK = num(p, 'height', 1) * (1 + 0.12 * f.lift) * (1 + 0.18 * f.harmony);
        const smoothK = num(p, 'smoothness', 0.6);
        const wildK = 1 - smoothK;
        const swayK = num(p, 'sway', 1);
        const day = num(p, 'day', 0);
        const colourK = num(p, 'colour', 0.75);
        const park = day > 0.5;
        if (park !== parkLayout) layout(park);

        /* tempo clock: the song's beat while it plays, a slow drift while paused */
        if (au.playing && au.bpm > 0) beats = au.beatCount + au.beatPhase;
        else beats += dt * 0.6;

        const plan = planFor(frame, ana);

        /* envelopes */
        kickEnv = au.kickHit ? 1 : kickEnv * Math.exp(-dt * 7);
        snareEnv = au.snareHit ? 1 : snareEnv * Math.exp(-dt * 9);
        const H = ana?.harmony;
        if (H) {
          for (const r of H.resolutions) if (lastRes < r.t && au.time >= r.t && au.time - r.t < 0.3) settle = Math.max(settle, r.strength);
          lastRes = au.time;
        }
        settle *= Math.exp(-dt * 0.8);
        const e = f.intensity;
        const ten = f.tension;
        // the inhale: everything cuts in the last instant before a known drop
        const inhale = f.toDrop < 0.32 && f.toDrop > 0;
        // a section change lands on the downbeat with a breath just before it
        const breath = f.toSection < 0.22 ? 0.45 : 1;
        const settleK = 1 - 0.22 * settle;

        /* ── the long row ── */
        const melodyOn = plan.form === 'rest' && melodyAt(au.time, ana);
        const bar = beats / 4;
        const pat = plan.pattern;
        const dropT = f.sinceDrop;
        // verses often play only every other jet: fewer, clearer strands
        const sparse = hsh(plan.seed + 2.2) < 0.65;
        let tgtSum = 0;
        for (let i = 0; i < ROW_N; i++) {
          const u = (i / (ROW_N - 1)) * 2 - 1;
          // a little humanised lag per jet (wild shows are sloppier)
          const lag = (hsh(i * 3.3) - 0.5) * 0.18 * wildK + (hsh(i * 2.9) - 0.5) * 0.12;
          const b = beats - lag;
          // no two jets quite the same height
          const hv = 1 + (hsh(i * 5.1 + 0.7) - 0.5) * 0.22;
          const sway = (ph: number, per: number) => Math.sin((Math.PI * 2 * b) / per + ph);
          let h = 0;
          let tilt = 0;
          let rate = 1;
          let fan = 0;
          let K = 1;
          let rot = 0;
          let aer = 0;
          switch (plan.form) {
            case 'rest': {
              h = (3.5 + 6 * e) * (0.85 + 0.15 * sway(u * 2.2, 8));
              tilt = 0.09 * swayK * sway(u * Math.PI, 8);
              rate = 0.8;
              aer = 0.25;
              if (melodyOn) h += melody[i] * (5 + 11 * e);
              break;
            }
            case 'sway': {
              const ph = pat === 0 ? 0 : pat === 1 ? (u < 0 ? Math.PI : 0) : pat === 2 ? (i % 2) * Math.PI : u * Math.PI;
              h = (10 + 16 * e) * (1 + 0.18 * kickEnv) * hv;
              tilt = 0.24 * swayK * sway(ph, 8);
              if (sparse && i % 2) rate = 0;
              break;
            }
            case 'wave': {
              const dir = Math.floor(bar / 2) % 2 ? 1 : -1;
              const w = Math.sin(Math.PI * 2 * (b / 4) - u * 2.6 * dir);
              h = (8 + 24 * e) * (0.32 + 0.68 * (0.5 + 0.5 * w)) * (1 + 0.15 * kickEnv) * hv;
              tilt = 0.16 * swayK * Math.cos(Math.PI * 2 * (b / 4) - u * 2.6 * dir) * dir;
              break;
            }
            case 'fan': {
              h = (22 + 18 * e) * (1 + 0.25 * snareEnv) * hv;
              tilt = u * 0.5 + 0.12 * swayK * sway(0, 2);
              K = 3;
              fan = 0.05;
              break;
            }
            case 'cross': {
              h = (12 + 14 * e) * (1 + 0.2 * snareEnv) * hv;
              tilt = (i % 2 ? 1 : -1) * 0.36 * swayK * sway(0, 8);
              if (sparse && i % 4 > 1) rate = 0;
              break;
            }
            case 'swirl': {
              h = (12 + 16 * e) * (1 + 0.15 * kickEnv) * hv;
              K = 6;
              fan = 0.2 + 0.08 * Math.sin(b * Math.PI * 0.5);
              rot = b * Math.PI * 0.5 * (i % 2 ? 1 : -1) + i;
              tilt = 0.08 * swayK * sway(u * 2, 8);
              break;
            }
            case 'build': {
              const prog = clamp01(Math.max(au.build, ten, f.sectionT));
              const reach = 0.12 + 0.88 * prog;
              const on = 1 - smooth(reach - 0.06, reach + 0.04, Math.abs(u));
              const step = Math.ceil(prog * 8) / 8;
              h = (6 + 36 * step) * on;
              rate = on > 0.05 ? 1 : 0;
              tilt = 0.04 * Math.sin(b * Math.PI * 4 + i * 1.7) * prog * swayK;
              break;
            }
            case 'drop': {
              const open = smooth(0.4, 2.2, dropT);
              h = 46 * (1 - 0.25 * open) * (1 + 0.2 * kickEnv);
              tilt = u * 0.6 * open;
              break;
            }
          }
          h *= hK * breath * settleK;
          tilt *= 1 - 0.5 * settle;
          if (inhale || park) rate = 0;
          // the jets fade up over half a second after a change of formation (they're on valves)
          rowH[i] = approach(rowH[i], h, h > rowH[i] ? 7 : 3, dt);
          rowTilt[i] = approach(rowTilt[i], tilt, 9, dt);
          rowRate[i] = approach(rowRate[i], rate, rate > rowRate[i] ? 20 : 30, dt);
          tgtSum += rowH[i];
          // waver: a slow wander and a quick pressure flutter, more when wild
          const wv = (Math.sin(t * 0.9 + i * 7.1) + Math.sin(t * 2.3 + i * 3.3)) * 0.5 * (0.006 + 0.05 * wildK);
          const flutter = 1 + (Math.sin(t * 11 + i * 5.7) * 0.5 + Math.sin(t * 17.3 + i * 2.1) * 0.5) * (0.004 + 0.03 * wildK);
          const n = ROW0 + i;
          const tl = rowTilt[i] + wv;
          put(n, 1, Math.sin(tl), Math.cos(tl), (Math.sin(t * 0.7 + i) * 0.5) * (0.01 + 0.05 * wildK), speedFor(rowH[i]) * flutter);
          put(n, 2, rowRate[i], 0.04 + 0.3 * wildK + 0.006 * rowH[i] * wildK, (0.03 + 0.06 * wildK) * num(p, 'mist', 1), 0);
          put(n, 3, 0, aer, fan, K);
          put(n, 5, rot, 0.92, 0, 0);
        }
        avgH = tgtSum / ROW_N;

        /* ── the front row of small jets ── */
        const chaseK = num(p, 'chasers', 1);
        if (!park && plan.mini === 'chase' && au.hatHit && chaseK > 0) {
          const hgt = (3.5 + 5 * au.hat * (0.5 + e)) * hK * chaseK;
          const step = 1 + Math.floor(e * 2);
          for (let k = 0; k < step; k++) {
            hatPtr += hatDir;
            if (hatPtr >= MINI_N || hatPtr < 0) {
              hatDir = -hatDir;
              hatPtr += 2 * hatDir;
            }
            fireMini(hatPtr, t, hgt);
            if (plan.pattern % 2) fireMini(MINI_N - 1 - hatPtr, t, hgt);
          }
        }
        if (plan.mini === 'machine' && au.snareHit) snareSide ^= 1;
        for (let j = 0; j < MINI_N; j++) {
          const n = MINI0 + j;
          const u = (j / (MINI_N - 1)) * 2 - 1;
          if (park) {
            // the aerator's low crown: a ring of jets leaning outward, pulsing on the beat
            const a = (j / MINI_N) * Math.PI * 2;
            const lean = 0.5 + 0.08 * Math.sin(t * 0.7 + j * 1.3) * wildK;
            const hr = (2.4 + 2.6 * e + 1.2 * ten) * (1 + 0.4 * kickEnv) * hK * breath * (0.92 + 0.16 * hsh(j * 3.7));
            miniH[j] = approach(miniH[j], inhale ? 0 : hr, 10, dt);
            put(n, 0, get(n, 0, 0), 0, get(n, 0, 2), 0);
            put(n, 1, Math.sin(a) * Math.sin(lean), Math.cos(lean), Math.cos(a) * Math.sin(lean), speedFor(miniH[j]));
            put(n, 2, inhale ? 0 : 1, 0.12 + 0.3 * wildK, 0.1 * num(p, 'mist', 1), 0);
            put(n, 3, 0, 0.18, 0, 1);
            put(n, 5, 0, 1, 0, 0.85);
            continue;
          }
          if (plan.mini === 'chase') {
            miniH[j] *= Math.exp(-dt * 3);
            // the chasers keep their own fired state (burst); only spread and mist here
            put(n, 2, get(n, 2, 0), 0.06 + 0.3 * wildK, 0.06, get(n, 2, 3));
            continue;
          }
          let h = 0;
          let rate = 1;
          let aer = 0;
          if (plan.mini === 'bubble') {
            h = (0.9 + 0.5 * Math.sin(t * 1.3 + j * 0.9) * 0.3 + 0.6 * e) * (Math.abs(u) < 0.5 ? 1 : 0.6);
            aer = 1;
            rate = 0.9;
          } else if (plan.mini === 'curtain') {
            h = (2.4 + 2 * e) * (0.8 + 0.2 * Math.sin(Math.PI * 2 * (beats / 4) - u * 4));
          } else if (plan.mini === 'machine') {
            const prog = clamp01(Math.max(au.build, ten));
            h = (2 + 6 * prog) * (1 + 0.5 * snareEnv);
            rate = j % 2 === snareSide ? 1 : 0.1;
          } else {
            h = (7 + 3 * e) * (1 + 0.3 * kickEnv);
          }
          h *= hK * breath;
          if (inhale) rate = 0;
          miniH[j] = approach(miniH[j], h, h > miniH[j] ? 9 : 4, dt);
          miniRate[j] = approach(miniRate[j], rate, 25, dt);
          const wv = Math.sin(t * 1.1 + j * 4.7) * (0.01 + 0.06 * wildK);
          put(n, 0, get(n, 0, 0), 0, get(n, 0, 2), 0);
          put(n, 1, wv, 1, Math.sin(t * 0.8 + j) * 0.02 * wildK, speedFor(miniH[j]));
          put(n, 2, miniRate[j], 0.05 + 0.3 * wildK + aer * 0.4, aer > 0 ? 0.2 : 0.02, 0);
          put(n, 3, 0, aer, 0, 1);
          // (row 5 w: how much dimmer this nozzle's light pool is; the small jets stand close together)
          put(n, 5, 0, 1, 0, 0.8);
        }

        /* ── the centre crown: a tall plume with a low fan of needles round it ── */
        const crownWant = park
          ? (8 + 12 * e + 8 * ten + 10 * Math.exp(-f.sinceDrop * 0.4)) * (1 + 0.12 * kickEnv) * hK * breath
          : (plan.form === 'rest' ? 7 + 9 * e : plan.form === 'drop' ? 26 : plan.form === 'build' ? 8 + 20 * clamp01(Math.max(au.build, ten)) : 10 + 10 * e) * hK * breath;
        crownH = approach(crownH, inhale ? 0 : crownWant, 3, dt);
        put(CROWN, 1, 0, 1, 0, speedFor(crownH));
        put(CROWN, 2, inhale ? 0 : 1, 0.25 + 0.6 * wildK, (park ? 0.3 : 0.15) * num(p, 'mist', 1), 0);
        put(CROWN, 3, 0, park ? 0.16 : 0.1, park ? 0.42 : 0.75, 26);
        put(CROWN, 5, t * 0.05, park ? 0.62 + 0.1 * kickEnv : 0.55, 0, 0);

        /* ── shooters ── */
        const shootK = num(p, 'shooters', 1);
        const dropNow = f.sinceDrop < 0.1 && prevSince >= 0.1;
        prevSince = f.sinceDrop;
        if (dropNow && shootK > 0) {
          // the money shot: every shooter at once, staggered out from the middle
          for (let s = 0; s < SHOT_N; s++) {
            const us = Math.abs((s / (SHOT_N - 1)) * 2 - 1);
            fireShooter(s, t + us * 0.12 + hsh(s + t) * 0.03 * wildK, (park ? 26 + 8 * hsh(s * 1.7) : 78 + 12 * hsh(s * 1.7)) * hK * Math.min(shootK, 1.2), 1.1, smoothK);
          }
          shake = 1;
        } else if (au.kickHit && (park || plan.shot !== 'off') && shootK > 0 && e > 0.3 && !inhale) {
          const hgt = park ? crownH * (1.25 + 0.4 * Math.min(1, au.kick)) * shootK : (30 + 48 * Math.min(1, au.kick) * (0.4 + 0.6 * e)) * hK * shootK;
          const ready = (s: number) => t - shotLast[s] > 1.9;
          if (plan.shot === 'pairs') {
            // pairs stepping out from the centre
            for (let k = 0; k < 5; k++) {
              const s = 4 - ((pairPtr + k) % 5);
              const s2 = SHOT_N - 1 - s;
              if (ready(s) && ready(s2)) {
                fireShooter(s, t, hgt, 0.75, smoothK);
                fireShooter(s2, t, hgt, 0.75, smoothK);
                pairPtr = (pairPtr + k + 1) % 5;
                break;
              }
            }
          } else {
            for (let k = 0; k < SHOT_N; k++) {
              const idx = (shotPtr + k) % SHOT_N;
              // 'alt' jumps between the two sides, 'kick' chases along the row
              const s = plan.shot === 'alt' ? (idx % 2 ? SHOT_N - 1 - (idx >> 1) : idx >> 1) : idx;
              if (ready(s)) {
                fireShooter(s, t, hgt, 0.75, smoothK);
                shotPtr = idx + 1;
                break;
              }
            }
          }
        }
        shake = approach(shake, 0, 2.5, dt);

        /* ── light ── */
        const fg = lin(pal.fg);
        const c1 = lin(pal.accent);
        const c2 = lin(pal.accent2);
        const scheme = plan.form === 'rest' ? (plan.scheme % 2 ? 1 : 4) : plan.scheme;
        const flash = Math.exp(-Math.max(0, f.sinceDrop) * 2.5);
        const swapBar = Math.floor(bar) % 2;
        const schemeCol = (u: number, i: number, out: number[]) => {
          let c: number[];
          switch (scheme) {
            case 0:
              c = fg;
              break;
            case 1:
              c = c1;
              break;
            case 2:
              c = (u < 0) !== !!swapBar ? c1 : c2;
              break;
            case 3:
              c = (i + swapBar) % 2 ? c1 : c2;
              break;
            default: {
              const k = 0.5 + 0.5 * u;
              out[0] = c1[0] + (c2[0] - c1[0]) * k;
              out[1] = c1[1] + (c2[1] - c1[1]) * k;
              out[2] = c1[2] + (c2[2] - c1[2]) * k;
              c = out;
            }
          }
          const w = colourK * (1 - 0.7 * flash);
          out[0] = fg[0] + (c[0] - fg[0]) * w;
          out[1] = fg[1] + (c[1] - fg[1]) * w;
          out[2] = fg[2] + (c[2] - fg[2]) * w;
        };
        const lc = [0, 0, 0];
        // overall level: brighter in big parts and on the drop; scaled so a lit core reads white-hot
        const level = (0.55 + 0.6 * e + 0.6 * flash + 0.25 * ten) * (1 - 0.15 * settle) * (plan.form === 'rest' ? 1.6 : 1);
        glowR = glowG = glowB = 0;
        for (let i = 0; i < ROW_N; i++) {
          const u = (i / (ROW_N - 1)) * 2 - 1;
          schemeCol(u, i, lc);
          const act = rowRate[i] * smooth(0.5, 4, rowH[i]);
          const I = 3.2 * level * act * (melodyOn ? 0.5 + 0.9 * melody[i] : 1);
          for (let k = 0; k < 3; k++) rowLight[i * 3 + k] = approach(rowLight[i * 3 + k], lc[k] * I, 8, dt);
          put(ROW0 + i, 4, rowLight[i * 3], rowLight[i * 3 + 1], rowLight[i * 3 + 2], Math.max(3.5, rowH[i] * 0.45));
          glowR += rowLight[i * 3];
          glowG += rowLight[i * 3 + 1];
          glowB += rowLight[i * 3 + 2];
        }
        for (let j = 0; j < MINI_N; j++) {
          const u = (j / (MINI_N - 1)) * 2 - 1;
          schemeCol(-u, j + 1, lc);
          const n = MINI0 + j;
          const fired = get(n, 0, 3) > 0.5 ? Math.exp(-Math.max(0, t - get(n, 2, 3)) * 1.5) : miniRate[j] * smooth(0.3, 2, miniH[j]);
          const I = 2.6 * level * fired;
          for (let k = 0; k < 3; k++) miniLight[j * 3 + k] = approach(miniLight[j * 3 + k], lc[k] * I, 14, dt);
          put(n, 4, miniLight[j * 3], miniLight[j * 3 + 1], miniLight[j * 3 + 2], Math.max(2.5, miniH[j] * 0.5));
        }
        schemeCol(0, 1, lc);
        {
          // the crown carries ten times a row jet's water: dim each droplet to match
          const I = 1.2 * level * smooth(1, 6, crownH);
          put(CROWN, 4, fg[0] * 0.3 * I + lc[0] * 0.7 * I, fg[1] * 0.3 * I + lc[1] * 0.7 * I, fg[2] * 0.3 * I + lc[2] * 0.7 * I, Math.max(3.5, crownH * 0.45));
        }
        for (let s = 0; s < SHOT_N; s++) {
          const u = (s / (SHOT_N - 1)) * 2 - 1;
          schemeCol(u, s, lc);
          const since = t - shotLast[s];
          const fl = since >= 0 ? Math.exp(-since * 0.45) : 0;
          const I = 5 * fl * (0.6 + 0.4 * shotPow[s]) * (0.7 + 0.5 * e);
          // shooters burn whiter than the rest
          const r0 = (fg[0] * 0.5 + lc[0] * 0.5) * I;
          const g0 = (fg[1] * 0.5 + lc[1] * 0.5) * I;
          const b0 = (fg[2] * 0.5 + lc[2] * 0.5) * I;
          for (let j = 0; j < SLOTS; j++) put(slotIndex(s, j), 4, r0, g0, b0, 16 + 12 * shotPow[s]);
          glowR += r0 * 2;
          glowG += g0 * 2;
          glowB += b0 * 2;
        }
        nozTex.needsUpdate = true;

        /* ── simulate ── */
        const windK = num(p, 'wind', 0.6) * (0.6 + 0.8 * wildK);
        const ws = (1.2 + 5 * f.gust) * windK;
        const su = simMat.uniforms;
        su.uT.value = t;
        su.uDt.value = dt;
        su.uInit.value = first ? 1 : 0;
        su.uTurb.value = (0.25 + 1.6 * wildK) * (0.6 + 0.6 * f.gust);
        (su.uWind.value as THREE.Vector3).set(f.windX * ws, 0, -0.35 * f.windY * ws - 0.3 * ws);
        su.tPos.value = simA.textures[0];
        su.tVel.value = simA.textures[1];
        simQuad.render(renderer, simB);
        const sw = simA;
        simA = simB;
        simB = sw;
        first = false;

        /* ── camera: a person at the rail ── */
        const W = frame.width;
        const Hh = frame.height;
        ensure(W, Hh);
        const aspect = W / Math.max(1, Hh);
        const frames = [
          { x: 0, yaw: 0, fov: 0 },
          { x: -16, yaw: 0.07, fov: -2 },
          { x: 14, yaw: -0.06, fov: -1 },
          { x: 5, yaw: -0.02, fov: -5 },
        ];
        const fr = frames[plan.frame % frames.length];
        const wideFor = plan.form === 'drop' || plan.form === 'fan' ? 8 : plan.form === 'rest' ? 3 : plan.form === 'build' ? -3 + 4 * clamp01(ten) : 0;
        const fovY0 = 37 + fr.fov + wideFor;
        // portrait: keep enough of the width
        const tanY = Math.max(Math.tan((fovY0 * Math.PI) / 360), Math.tan((44 * Math.PI) / 360) / Math.max(aspect, 0.1));
        const fovY = (Math.atan(tanY) * 360) / Math.PI;
        const camRate = first ? 100 : 0.35;
        camX = approach(camX, fr.x, camRate, dt);
        camYaw = approach(camYaw, fr.yaw, camRate, dt);
        camFov = camFov === 0 ? fovY : approach(camFov, fovY, 0.5, dt);
        // the eye follows the water up as it climbs
        lookH = approach(lookH, Math.max(avgH, crownH * 0.6), 0.9, dt);
        const horizonAt = 0.3;
        const basePitch = Math.atan(Math.tan((camFov * Math.PI) / 360) * (1 - 2 * horizonAt));
        // (the foot of the show, its glow and its reflection, stays in frame even when the water climbs)
        // quiet parts walk down to the water's edge, close enough to see the coloured light on the lake
        camNear = first ? (plan.form === 'rest' ? 1 : 0) : approach(camNear, plan.form === 'rest' ? 1 : 0, 0.45, dt);
        const nearE = camNear * camNear * (3 - 2 * camNear);
        const camZ = park ? -38 : -30 * nearE;
        const camY = park ? 2.4 : CAM_Y - 1.8 * nearE;
        const pitchT = basePitch + Math.min(Math.atan(lookH / (80 + camZ)) * 0.3, 0.12) - Math.atan(camY / (75 + camZ)) * 0.5;
        camPitch = camPitch === 0 ? pitchT : approach(camPitch, pitchT, 0.8, dt);
        const hh = num(p, 'handheld', 1);
        const tt = t;
        const nx = (Math.sin(tt * 0.31) + Math.sin(tt * 0.73 + 1.3) * 0.6 + Math.sin(tt * 1.71 + 0.4) * 0.25) * 0.0032 * hh;
        const ny = (Math.sin(tt * 0.27 + 2.1) + Math.sin(tt * 0.61 + 0.7) * 0.6 + Math.sin(tt * 1.53 + 2.4) * 0.25) * 0.0026 * hh;
        const breathY = Math.sin(tt * 1.4) * 0.0012 * hh;
        const roll = (Math.sin(tt * 0.23 + 0.5) + Math.sin(tt * 0.57) * 0.5) * 0.003 * hh;
        const sh = shake * shake * hh;
        camera.fov = camFov;
        camera.aspect = aspect;
        camera.near = 1;
        camera.far = 6000;
        camera.updateProjectionMatrix();
        camera.position.set(camX * (park ? 0.25 : 1 - 0.6 * nearE) + Math.sin(tt * 0.19) * 0.25 * hh, camY + Math.sin(tt * 0.37) * 0.05 * hh, camZ);
        camera.rotation.order = 'YXZ';
        camera.rotation.set(
          camPitch + ny + breathY + Math.sin(tt * 37) * 0.002 * sh,
          camYaw * (park ? 0.4 : 1) - camX * 0.0025 + nx + Math.sin(tt * 31) * 0.002 * sh,
          roll,
        );
        camera.updateMatrixWorld();
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        const focal = Hh / 2 / Math.tan((camFov * Math.PI) / 360);

        /* ── uniforms ── */
        const dayK = day;
        pu.tPos.value = simA.textures[0];
        pu.tVel.value = simA.textures[1];
        pu.uT.value = t;
        pu.uDay.value = dayK;
        const gl = 1 / (ROW_N * 3.2);
        glowR *= gl;
        glowG *= gl;
        glowB *= gl;
        pu.uAmb.value.set(glowR * 0.04 + 0.004, glowG * 0.04 + 0.004, glowB * 0.04 + 0.005);
        const sunC = lin(tmpC.copy(pal.fg).lerp(pal.accent2, 0.15));
        pu.uSunCol.value.set(sunC[0] * 2.2, sunC[1] * 2.2, sunC[2] * 2.2);
        const skyC = lin(pal.bg);
        pu.uSkyAmb.value.set(skyC[0], skyC[1], skyC[2]);
        // a sun high on the right, a little behind the fountains
        pu.uSunDir.value.set(0.42, 0.78, -0.46).normalize();

        // sub-pixel quality: draw fewer droplets (each brighter) when the governor is easing off
        const qs = quality.current().sceneScale;
        const frac = qs >= 0.99 ? 1 : qs >= 0.66 ? 0.75 : 0.6;
        const streakGain = 0.55 / frac;
        pGeo.instanceCount = Math.floor(N * frac);
        for (const m of [streakM, streakR]) {
          (m.uniforms.uRes.value as THREE.Vector2).set(m === streakM ? W : reflRT!.width, m === streakM ? Hh : reflRT!.height);
          m.uniforms.uShutter.value = (1 / 30) * (0.8 + 0.4 * smoothK);
        }
        streakM.uniforms.uGain.value = streakGain * (1 + 2.4 * dayK);
        streakR.uniforms.uGain.value = streakGain * 0.8;
        const mistK = num(p, 'mist', 1);
        for (const m of [mistM, mistR]) {
          (m.uniforms.uRes.value as THREE.Vector2).set(m === mistM ? mistRT!.width : reflRT!.width, m === mistM ? mistRT!.height : reflRT!.height);
          m.uniforms.uMistSize.value = 0.8 + 0.5 * wildK;
          m.uniforms.uGain.value = 0.0045 * mistK * (1 - 0.25 * dayK);
        }

        /* reflection: the particles mirrored in the lake (fewer of them, at half size) */
        pu.uFocal.value = focal * 0.5;
        const reflFrac = 0.45;
        pGeo.instanceCount = Math.floor(N * frac * reflFrac);
        streakR.uniforms.uGain.value = (streakGain * 0.8) / reflFrac;
        mistR.uniforms.uGain.value = (0.0045 * mistK) / reflFrac;
        renderer.setRenderTarget(reflRT);
        renderer.setClearColor(0x000000, 1);
        renderer.clear(true, false, false);
        renderer.render(reflScene, camera);

        /* background + lake */
        syncMaterial(bgMat, frame, params);
        const bu = bgMat.uniforms;
        (bu.uResolution.value as THREE.Vector2).set(W, Hh);
        (bu.uCamPos.value as THREE.Vector3).copy(camera.position);
        (bu.uCamBasis.value as THREE.Matrix3).setFromMatrix4(camera.matrixWorld);
        const ty = Math.tan((camFov * Math.PI) / 360);
        (bu.uTanHalf.value as THREE.Vector2).set(ty * aspect, ty);
        bu.tRefl.value = reflRT!.texture;
        bu.uDay.value = dayK;
        bu.uCity.value = num(p, 'city', 1);
        waveT += dt * (0.7 + 0.5 * f.gust);
        bu.uWaveT.value = waveT;
        bu.uChop.value = clamp01(0.2 + 0.6 * e + 0.5 * flash + 0.3 * wildK) * (1 - 0.6 * dayK);
        // a park pond: the far bank is near
        bu.uShore.value = SHORE + (150 - SHORE) * dayK;
        bu.uPix.value = (2 * ty) / Hh;
        bu.uReflGain.value = 1;
        const bgLin = lin(pal.bg);
        const mutedLin = lin(pal.muted);
        const fgLin = lin(pal.fg);
        // night sky: the palette's night colour, glowing toward the city; day: palette sky, paler at the horizon
        const nightLo = [bgLin[0] * 1.1 + mutedLin[0] * 0.1, bgLin[1] * 1.1 + mutedLin[1] * 0.1, bgLin[2] * 1.1 + mutedLin[2] * 0.1];
        const nightHi = [bgLin[0] * 0.3, bgLin[1] * 0.3, bgLin[2] * 0.4];
        const dayLo = [bgLin[0] * 0.75 + fgLin[0] * 0.22, bgLin[1] * 0.75 + fgLin[1] * 0.22, bgLin[2] * 0.75 + fgLin[2] * 0.22];
        const dayHi = [bgLin[0] * 0.55, bgLin[1] * 0.65, bgLin[2] * 0.85];
        const mix3 = (a: number[], b: number[], k: number) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
        const lo = mix3(nightLo, dayLo, dayK);
        const hi = mix3(nightHi, dayHi, dayK);
        (bu.uSkyLo.value as THREE.Vector3).set(lo[0], lo[1], lo[2]);
        (bu.uSkyHi.value as THREE.Vector3).set(hi[0], hi[1], hi[2]);
        (bu.uCityGlow.value as THREE.Vector3).set(mutedLin[0] * 0.45, mutedLin[1] * 0.45, mutedLin[2] * 0.45);
        (bu.uSunCol.value as THREE.Vector3).copy(pu.uSunCol.value);
        (bu.uFoliage.value as THREE.Vector3).set(mutedLin[0], mutedLin[1], mutedLin[2]);
        const wc = mix3(bgLin, mutedLin, 0.5);
        (bu.uWaterCol.value as THREE.Vector3).set(wc[0], wc[1], wc[2]);
        (bu.uShowGlow.value as THREE.Vector3).set(glowR, glowG, glowB);
        const lamp = lin(tmpC.setRGB(1, 0.72, 0.42).lerp(pal.accent2, 0.25));
        (bu.uLampCol.value as THREE.Vector3).set(lamp[0], lamp[1], lamp[2]);
        bgQuad.render(renderer, hdrRT);

        /* pools + streaks */
        pu.uFocal.value = focal;
        pGeo.instanceCount = Math.floor(N * frac);
        streakM.uniforms.uGain.value = streakGain * (1 + 2.4 * dayK);
        syncMaterial(poolMat, frame, params);
        const pl = poolMat.uniforms;
        pl.uT.value = t;
        pl.uDay.value = dayK;
        pl.uDapple.value = num(p, 'dapple', 1);
        (pl.uC1.value as THREE.Vector3).set(c1[0] * 2, c1[1] * 2, c1[2] * 2);
        (pl.uC2.value as THREE.Vector3).set(c2[0] * 2, c2[1] * 2, c2[2] * 2);
        (pl.uC3.value as THREE.Vector3).set(fg[0] * 1.5, fg[1] * 1.5, fg[2] * 1.5);
        (pl.uSunCol.value as THREE.Vector3).copy(pu.uSunCol.value);
        (pl.uFoam.value as THREE.Vector3).set(fg[0], fg[1], fg[2]);
        renderer.setRenderTarget(hdrRT);
        const ac = renderer.autoClear;
        renderer.autoClear = false;
        renderer.render(mainScene, camera);
        renderer.autoClear = ac;

        /* mist */
        pu.uFocal.value = focal * (mistRT!.height / Hh);
        mistM.uniforms.uGain.value = 0.0045 * mistK * (1 - 0.25 * dayK);
        renderer.setRenderTarget(mistRT);
        renderer.setClearColor(0x000000, 1);
        renderer.clear(true, false, false);
        renderer.render(mistScene, camera);

        /* bloom */
        const bm = brightMat.uniforms;
        bm.tA.value = hdrRT!.texture;
        bm.tB.value = mistRT!.texture;
        (bm.uTexel.value as THREE.Vector2).set(1 / W, 1 / Hh);
        bm.uMistGain.value = 1;
        // by day the whole sky is bright: only the sparkle blooms, not a veil over everything
        bm.uLow.value = 0.2 * (1 - dayK);
        brightQuad.render(renderer, bA);
        const blur = (src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget, x: number, y: number) => {
          blurMat.uniforms.tSrc.value = src.texture;
          (blurMat.uniforms.uDir.value as THREE.Vector2).set(x / src.width, y / src.height);
          blurQuad.render(renderer, dst);
        };
        blur(bA!, bA2!, 1, 0);
        blur(bA2!, bA!, 0, 1);
        blur(bA!, bB!, 1.5, 0);
        blur(bB!, bB2!, 0, 1.5);
        blur(bB2!, bB!, 1.5, 0);
        blur(bB!, bB2!, 0, 1.5);

        const cu = compMat.uniforms;
        cu.tHdr.value = hdrRT!.texture;
        cu.tMist.value = mistRT!.texture;
        cu.tBloomA.value = bA!.texture;
        cu.tBloomB.value = bB2!.texture;
        (cu.uMistTexel.value as THREE.Vector2).set(1 / mistRT!.width, 1 / mistRT!.height);
        cu.uExposure.value = 1 - 0.15 * dayK;
        cu.uGrain.value = num(p, 'grain', 0.025);
        cu.uTime.value = t;
        cu.uMistGain.value = 1;
        cu.uBloom.value = 1 - 0.6 * dayK;
        cu.uAspect.value = aspect;
        (cu.uLift.value as THREE.Vector3).set(mutedLin[0] * 0.004, mutedLin[1] * 0.004, mutedLin[2] * 0.005);
        compQuad.render(renderer, target);
      },
      dispose() {
        simA.dispose();
        simB.dispose();
        infoTex.dispose();
        nozTex.dispose();
        simMat.dispose();
        simQuad.dispose();
        pGeo.dispose();
        poolGeo.dispose();
        for (const m of [streakM, streakR, mistM, mistR, poolMat, bgMat, brightMat, blurMat, compMat]) m.dispose();
        for (const q of [bgQuad, brightQuad, blurQuad, compQuad]) q.dispose();
        for (const rt of [hdrRT, mistRT, reflRT, bA, bA2, bB, bB2]) rt?.dispose();
      },
    };
  },
};
