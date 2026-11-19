import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl';
import { buildSceneFragment, createFullscreenQuad } from '../../core/sceneHelpers';
import type { AudioFrame, ParamDef, SceneDef, SceneInit, SceneInstance } from '../../core/types';
import { createBaseUniforms, num, updateBaseUniforms, updateParamUniforms } from '../../core/uniforms';
import { Spring, approach, stepDt } from '../three/common';
import { HM_LIB } from './lib';

/**
 * Soft Orbs: a few milky, glowing bodies strung along a diagonal on black, like notes on a line or
 * a mobile turning slowly in a dark room. Weightless, playful, tender.
 *
 * Each orb is a voice. Its size is that voice's level, so the row of orbs is the mix:
 *   kick   the big one; every hit squashes it and it rebounds like a soft body
 *   bass   a pill that stretches with the low end
 *   mid    the vocal disc; it swells with the voice and its rim lights up while someone sings
 *   snare  pops on the backbeat and makes the whole mobile shiver
 *   hats   tiny satellites that orbit the bigger orbs and blink
 *   the rest follow lowMid, highMid, air and five slices of the spectrum, and only appear as the
 *   song gets louder (energy decides how many orbs there are, how big and how fast)
 *
 * All motion lives in JS (springs and integrated positions) and reaches the shader as uniform
 * arrays; the shader is one pass of capsule distances joined with a smooth-min, so orbs that meet
 * merge like liquid and part again. Behind every body sit three echoes of itself: at rest they hide
 * (a faint cool rim), when it moves fast they fan out as a translucent stack, and when it is hit
 * they swell into coloured rings and fall back to white.
 *
 * Build: the orbs are drawn toward one point on the line, lengthening into pills. Drop: they
 * collide into one great orb that flashes and bursts into many, rims blazing.
 *
 * Palette roles: bg = the dark room, fg = the milky body, accent = the hot outer rim,
 * accent2 = the thin inner rim and (mixed with accent) the satellites, muted = the pale echo
 * stacks, the cool edge of each body and its shaded side.
 */

const N = 12;
const SATS = 3;

const params: ParamDef[] = [
  { id: 'count', label: 'Orbs', group: 'Shape', type: 'number', min: 3, max: N, step: 1, default: N, hint: 'The most that can appear when the song is at full energy' },
  { id: 'size', label: 'Size', group: 'Shape', type: 'number', min: 0.5, max: 1.6, step: 0.01, default: 1 },
  { id: 'tilt', label: 'Line tilt', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.75, hint: '0 is a level row, 1 runs corner to corner' },
  { id: 'merge', label: 'Merge', group: 'Shape', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.7, hint: 'How readily orbs that meet flow into each other' },
  { id: 'speed', label: 'Travel', group: 'Motion', type: 'number', min: 0, max: 2.5, step: 0.01, default: 1 },
  { id: 'stretch', label: 'Stretch', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Fast orbs lengthen into pills and leave a stack of echoes' },
  { id: 'bounce', label: 'Bounce', group: 'Reactivity', type: 'number', min: 0, max: 1.6, step: 0.01, default: 1, hint: 'How hard hits squash, pop and shove the orbs, and how far the drop throws them' },
  { id: 'rims', label: 'Colour rims', group: 'Color', type: 'number', min: 0, max: 1.4, step: 0.01, default: 1, hint: 'Coloured rings ignite on hits and with energy, then fade back to white' },
  { id: 'glow', label: 'Glow', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
  { id: 'grain', label: 'Grain', group: 'Color', type: 'number', min: 0, max: 0.12, step: 0.002, default: 0.028 },
];

const fragment = /* glsl */ `
${HM_LIB}
#define SO_N ${N}
#define SO_S ${SATS}
uniform vec4 uOrbA[SO_N];   // xy centre (short side of the frame = 1), z radius, w half-length of the pill's spine
uniform vec4 uOrbB[SO_N];   // xy travel axis, z squash (scale along the axis; 1/z across it), w rim heat 0..1
uniform vec4 uOrbC[SO_N];   // x echo step (signed, along the axis), y rim hue 0..1, z cool tint 0..1, w opacity
uniform vec4 uSatA[SO_S];   // xy centre, z radius, w blink 0..1
uniform vec2 uSatB[SO_S];   // x hue 0..1, y opacity
uniform float uFlash;       // drop flash, 1 → 0
uniform float uMergeK;      // smooth-min radius

// Pill along x: spine half-length hl, radius r.
float soCap(vec2 l, float hl, float r) {
  l.x -= clamp(l.x, -hl, hl);
  return length(l) - r;
}

// smooth-min that carries a colour (rgb) and an opacity (a) along with the distance
void soJoin(inout float d, inout vec4 c, float d2, vec4 c2, float k) {
  float h = clamp(0.5 + 0.5 * (d - d2) / k, 0.0, 1.0);
  d = mix(d, d2, h) - k * h * (1.0 - h);
  c = mix(c, c2, h);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float mn = min(uResolution.x, uResolution.y);
  vec2 p = (fc - 0.5 * uResolution) / mn;
  float px = 1.0 / mn;
  float gScale = 1.0 + 2.6 * uFlash;

  // four merged fields: the bodies (0) and their three echoes (1 nearest … 3 farthest)
  float d0 = 1000.0, d1 = 1000.0, d2 = 1000.0, d3 = 1000.0;
  vec4 c0 = vec4(uFg, 0.0);
  vec4 c1 = vec4(uMuted, 0.0);
  vec4 c2 = c1;
  vec4 c3 = c1;
  vec2 n0 = vec2(0.0);
  float kB = max(uMergeK, 0.0005);
  float kE = kB * 0.6;

  for (int i = 0; i < SO_N; i++) {
    vec4 A = uOrbA[i];
    if (A.z < 0.0004) continue;
    vec4 B = uOrbB[i];
    vec4 C = uOrbC[i];
    vec2 q = p - A.xy;
    float reach = A.z * 1.6 + A.w + 3.0 * abs(C.x) + kB + 0.26 * gScale;
    if (dot(q, q) > reach * reach) continue;

    vec2 sc = vec2(1.0 / B.z, B.z);
    float unsc = min(B.z, 1.0 / B.z);
    vec2 l = vec2(dot(q, B.xy), dot(q, vec2(-B.y, B.x))) * sc;
    float heat = B.w;
    float hot = clamp(heat * 1.7, 0.0, 1.0);

    // the body: milky, a little cooler toward its skin. nb is 0 on the spine and 1 at the skin:
    // a cheap dome normal for the shading
    vec2 lb = l;
    lb.x -= clamp(lb.x, -A.w, A.w);
    float db = (length(lb) - A.z) * unsc;
    vec2 nb = (B.xy * lb.x + vec2(-B.y, B.x) * lb.y) / A.z;
    vec4 cb = vec4(mix(uFg, uMuted, 0.16 + 0.5 * C.z), C.w);
    float h = clamp(0.5 + 0.5 * (d0 - db) / kB, 0.0, 1.0);
    d0 = mix(d0, db, h) - kB * h * (1.0 - h);
    c0 = mix(c0, cb, h);
    n0 = mix(n0, nb, h);

    // the echoes: pale and translucent when cool, swelling into coloured rings with heat
    vec3 ring1 = mix(uAccent2, uAccent, C.y);
    vec3 ring2 = mix(uAccent, uAccent2, C.y);
    vec3 ring3 = mix(ring2, uMuted, 0.5);
    vec3 cool = uMuted;
    float st = C.x * sc.x;
    float e1 = soCap(l + vec2(st, 0.0), A.w, A.z * (1.014 + 0.075 * heat)) * unsc;
    float e2 = soCap(l + vec2(st * 2.0, 0.0), A.w, A.z * (1.014 + 0.185 * heat)) * unsc;
    float e3 = soCap(l + vec2(st * 3.0, 0.0), A.w, A.z * (1.014 + 0.265 * heat)) * unsc;
    soJoin(d1, c1, e1, vec4(mix(mix(cool, uFg, 0.25), ring1, hot), C.w * mix(0.62, 1.0, hot)), kE);
    soJoin(d2, c2, e2, vec4(mix(cool, ring2, hot), C.w * mix(0.44, 1.0, hot)), kE);
    soJoin(d3, c3, e3, vec4(mix(mix(cool, uAccent, 0.18), ring3, hot), C.w * mix(0.3, 0.9, hot)), kE);
  }

  vec3 col = uBg;
  float soft = 0.0032 + px;

  // glow: a tight halo and a wide faint one, falling to nothing so the dark stays dark.
  // It takes the colour of whatever is nearest (blended, so there are no seams in the light).
  vec4 w = vec4(d0 + (1.0 - c0.a) * 0.06, d1 + (1.0 - c1.a) * 0.04, d2 + (1.0 - c2.a) * 0.04, d3 + (1.0 - c3.a) * 0.04);
  float gd = min(min(w.x, w.y), min(w.z, w.w));
  vec4 ww = exp(-(w - gd) / (0.02 * gScale));
  vec3 gc = (mix(c0.rgb, uFg, 0.5) * ww.x + c1.rgb * ww.y + c2.rgb * ww.z + c3.rgb * ww.w) / (ww.x + ww.y + ww.z + ww.w);
  float go = max(gd, 0.0);
  float halo = 0.5 * exp(-go / (0.011 * gScale)) + (0.13 + 0.25 * uFlash) * exp(-go / (0.06 * gScale));
  col = mix(col, gc, clamp(halo * u_glow, 0.0, 1.0));

  // echoes, back to front
  col = mix(col, c3.rgb, c3.a * (1.0 - smoothstep(-soft, soft, d3)));
  col = mix(col, c2.rgb, c2.a * (1.0 - smoothstep(-soft, soft, d2)));
  col = mix(col, c1.rgb, c1.a * (1.0 - smoothstep(-soft, soft, d1)));

  // the bodies: lit from the upper left, brighter in the core, cooler and darker toward the far side
  float a0 = 1.0 - smoothstep(-soft, soft, d0);
  float edge = clamp(length(n0), 0.0, 1.0);
  float nz = sqrt(1.0 - edge * edge);
  float lam = dot(n0, vec2(-0.56, 0.83));
  vec3 body = mix(c0.rgb, uFg, smoothstep(0.05, 0.8, nz));
  vec3 shadeCol = mix(uMuted, uBg, 0.4);
  body = mix(body, shadeCol, 0.4 * smoothstep(0.3, 1.0, edge) * (0.5 - 0.5 * lam));
  body = mix(body, uFg, clamp(uFlash * 1.2, 0.0, 1.0));
  col = mix(col, body, a0 * c0.a);

  // hat satellites ride the rims, on top
  for (int j = 0; j < SO_S; j++) {
    vec4 S = uSatA[j];
    if (S.z < 0.0004) continue;
    float ds = length(p - S.xy) - S.z;
    vec3 sHot = mix(uAccent2, uAccent, uSatB[j].x);
    float sa = uSatB[j].y;
    col = mix(col, sHot, sa * 0.5 * exp(-max(ds, 0.0) / 0.009) * u_glow * (0.25 + S.w));
    col = mix(col, mix(sHot, uFg, 0.25 * S.w), sa * (1.0 - smoothstep(-soft, soft, ds)));
  }

  // a touch of grain, mostly where there is light
  float lit = clamp(length(col - uBg) * 3.0, 0.0, 1.0);
  col += hmGrain(fc, uTime) * u_grain * (0.3 + 0.7 * lit);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── the cast ───────────────────────── */

type Role = 'kick' | 'bass' | 'mid' | 'snare' | 'lowMid' | 'highMid' | 'air' | 'spec';

interface OrbCfg {
  role: Role;
  /** radius at full level, as a fraction of the frame's short side */
  base: number;
  /** song energy above which this orb exists */
  thr: number;
  /** roamers only: their own speed along the line (short sides per second, signed); 0 = sits in the row */
  cruise: number;
  /** how far it strays across the line */
  amp: number;
  /** 0 milky … 1 pale (toward muted) */
  tint: number;
  /** which rim colour sits innermost: 0 accent2, 1 accent */
  hue: number;
  /** keeps a stack of echoes even when slow */
  ghost: number;
  /** spectrum position 0..1 for the 'spec' orbs */
  bin: number;
}

const CAST: OrbCfg[] = [
  { role: 'kick', base: 0.165, thr: 0.3, cruise: 0, amp: 0.014, tint: 0, hue: 0, ghost: 0, bin: 0 },
  { role: 'bass', base: 0.078, thr: 0, cruise: 0, amp: 0.03, tint: 0.6, hue: 1, ghost: 0, bin: 0 },
  { role: 'mid', base: 0.108, thr: 0, cruise: 0, amp: 0.05, tint: 0.1, hue: 0, ghost: 0, bin: 0 },
  { role: 'snare', base: 0.064, thr: 0.32, cruise: 0, amp: 0.045, tint: 0.3, hue: 1, ghost: 0, bin: 0 },
  { role: 'lowMid', base: 0.054, thr: 0, cruise: 0, amp: 0.06, tint: 0.75, hue: 0.5, ghost: 0.55, bin: 0 },
  { role: 'highMid', base: 0.04, thr: 0.4, cruise: -0.05, amp: 0.07, tint: 0.45, hue: 1, ghost: 0, bin: 0 },
  { role: 'air', base: 0.032, thr: 0.1, cruise: 0, amp: 0.08, tint: 0.85, hue: 0, ghost: 0, bin: 0 },
  { role: 'spec', base: 0.05, thr: 0.62, cruise: 0.062, amp: 0.085, tint: 0.2, hue: 1, ghost: 0.4, bin: 0.3 },
  { role: 'spec', base: 0.034, thr: 0.68, cruise: 0, amp: 0.1, tint: 0.65, hue: 0.5, ghost: 0, bin: 0.48 },
  { role: 'spec', base: 0.062, thr: 0.74, cruise: 0, amp: 0.06, tint: 0.05, hue: 0, ghost: 0, bin: 0.12 },
  { role: 'spec', base: 0.028, thr: 0.8, cruise: -0.07, amp: 0.11, tint: 0.9, hue: 1, ghost: 0.35, bin: 0.72 },
  { role: 'spec', base: 0.042, thr: 0.86, cruise: 0, amp: 0.09, tint: 0.5, hue: 0.5, ghost: 0, bin: 0.6 },
];

/**
 * The row: these orbs share the line in this order, each with a seat as wide as it is. Seats open
 * and close as orbs come and go, and each orb wanders around its seat, so neighbours meet and part.
 * The cast members not listed here (cruise ≠ 0) roam the whole line on their own, passing everyone.
 */
const ROW = [2, 4, 0, 9, 1, 8, 3, 6, 11];

/** how far a full build draws the row in toward the gather point */
const GATHER = 0.5;

/** which orb each hat satellite circles */
const SAT_HOST = [2, 0, 9];

interface Orb {
  seat: number; // row orbs: centre of its seat, before the row's drift
  wander: number; // row orbs: how far it may stray from its seat
  roam: number; // roamers: own position along the line
  off: number; // thrown off its place by a drop; eases back
  imp: number; // speed of that throw, decays
  nudge: Spring; // shove along the line from the kick orb next door
  cross: Spring; // quick sideways shiver
  scat: number; // slow sideways scatter after a drop
  scatT: number;
  dodge: number; // sideways step so two orbs graze and merge instead of one swallowing the other
  level: Spring;
  squash: Spring;
  pres: number;
  presE: number;
  hit: number;
  freq: number;
  phase: number;
  lvl: number;
  r0: number; // radius before stretching
  s: number; // where it is along the line this frame
  sE: number; // the same, after a build has drawn it in
  cB: number; // where it is across the line before dodging
  x: number;
  y: number;
  vs: number;
  vc: number;
  lean: number;
  hasPrev: boolean;
  hl: number;
  r: number;
  rAlong: number;
  rAcross: number;
  ax: number;
  ay: number;
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

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** wrap x into [-len/2, len/2) */
const wrap = (x: number, len: number) => ((((x + len / 2) % len) + len) % len) - len / 2;

function bandAt(a: AudioFrame, x: number) {
  const n = a.spectrum.length;
  if (n < 3) return 0;
  const i = Math.min(n - 2, Math.max(1, Math.round(x * (n - 1))));
  return ((a.spectrum[i - 1] + a.spectrum[i] + a.spectrum[i + 1]) / 3) * (1 + 1.4 * x);
}

function levelOf(role: Role, a: AudioFrame, kickF: number, snareF: number, bin: number) {
  switch (role) {
    case 'kick':
      return kickF;
    case 'bass':
      return Math.max(a.sub, a.bass) * 1.2;
    case 'mid':
      return a.mid * 1.3;
    case 'snare':
      return snareF;
    case 'lowMid':
      return a.lowMid * 1.25;
    case 'highMid':
      return a.highMid * 1.3;
    case 'air':
      return a.air * 1.4;
    default:
      return bandAt(a, bin) * 1.5;
  }
}

function create(init: SceneInit): SceneInstance {
  const orbA = new Float32Array(N * 4);
  const orbB = new Float32Array(N * 4);
  const orbC = new Float32Array(N * 4);
  const satA = new Float32Array(SATS * 4);
  const satB = new Float32Array(SATS * 2);
  for (let i = 0; i < N; i++) {
    orbB[i * 4] = 1; // a valid axis and squash before the first frame
    orbB[i * 4 + 2] = 1;
  }
  const uniforms = {
    ...createBaseUniforms(init.shared, params),
    uOrbA: { value: orbA },
    uOrbB: { value: orbB },
    uOrbC: { value: orbC },
    uSatA: { value: satA },
    uSatB: { value: satB },
    uFlash: { value: 0 },
    uMergeK: { value: 0.03 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: buildSceneFragment(fragment, params),
    depthTest: false,
    depthWrite: false,
  });
  const quad = createFullscreenQuad(material);

  const rnd = mulberry32(8128);
  const orbs: Orb[] = CAST.map(() => ({
    seat: 0,
    wander: 0,
    roam: (rnd() - 0.5) * 2,
    off: 0,
    imp: 0,
    nudge: new Spring(34, 6.5),
    cross: new Spring(64, 7),
    scat: 0,
    scatT: 0,
    dodge: 0,
    level: new Spring(130, 11, 0.3),
    squash: new Spring(190, 9),
    pres: 0,
    presE: 0,
    hit: 0,
    freq: 0.16 + 0.22 * rnd(),
    phase: rnd() * Math.PI * 2,
    lvl: 0,
    r0: 0,
    s: 0,
    sE: 0,
    cB: 0,
    x: 0,
    y: 0,
    vs: 0,
    vc: 0,
    lean: 0,
    hasPrev: false,
    hl: 0,
    r: 0,
    rAlong: 0,
    rAcross: 0,
    ax: 1,
    ay: 0,
  }));
  const push = new Float32Array(N);
  const satAng = [0.6, 3.4, 1.9];
  const satDir = [1, -0.8, 1.25];
  const satBlink = [0, 0, 0];
  const satHue = [0.3, 0.42, 0.18];

  let started = false;
  let energy = 0;
  let clock = 0;
  let drift = 0.22; // where the row has drifted to along the line
  let surge = 0;
  let kickF = 0;
  let snareF = 0;
  let hatF = 0;
  let kickEnv = 0;
  let satP = 0;
  let satNext = 0;
  let dropPrev = 0;
  let sinceDrop = 100;
  let imploding = false;
  let implode = 0;
  let gather = 0;
  let crossK = 1;

  return {
    render(frame, target) {
      const a = frame.audio;
      const dt = stepDt(frame);
      const P = frame.params;
      const count = Math.round(Math.min(N, Math.max(1, num(P, 'count', N))));
      const size = Math.max(0.1, num(P, 'size', 1));
      const tilt = clamp01(num(P, 'tilt', 0.75));
      const merge = Math.max(0, num(P, 'merge', 0.7));
      const speed = Math.max(0, num(P, 'speed', 1));
      const stretch = Math.max(0, num(P, 'stretch', 1));
      const bounce = Math.max(0, num(P, 'bounce', 1));
      const rims = Math.max(0, num(P, 'rims', 1));

      // the line: from the upper left to the lower right, composed from the frame's shape
      const short = Math.max(1, Math.min(frame.width, frame.height));
      const hx = frame.width / short / 2;
      const hy = frame.height / short / 2;
      const yExt = tilt * Math.min(hy, hx * 0.9);
      const len = Math.hypot(hx, yExt);
      const ux = hx / len;
      const uy = -yExt / len;
      const nx = -uy;
      const ny = ux;
      const tExit = Math.min(hx / Math.max(ux, 1e-3), hy / Math.max(Math.abs(uy), 1e-3));
      // the line is a loop: what leaves one end comes back at the other, out of sight
      const loop = 2 * (tExit + 0.36 * Math.max(0.6, size) + 0.04);
      // tall frames have a short line with room either side of it: smaller orbs that stray further
      const room = Math.min(1.7, Math.max(1, hy / ux / 0.54));
      const fit = Math.sqrt(Math.min(1, Math.max(0.6, loop / 2.7)));
      const gatherAt = 0.06 * tExit;

      const fresh = !started;
      if (fresh) {
        started = true;
        energy = a.energy;
        dropPrev = a.drop;
      }
      energy = approach(energy, a.energy, 1.3, dt);
      const e = energy;
      clock += dt * (0.5 + 1.2 * e) * (0.4 + 0.6 * speed);

      // the drums as slow followers, so their orbs have a size between hits
      if (a.kickHit) kickF = Math.max(kickF, 0.5 + 0.5 * Math.min(1, a.kick * 1.15));
      else kickF *= Math.exp(-dt / 1.5);
      if (a.snareHit) snareF = Math.max(snareF, 0.5 + 0.5 * Math.min(1, a.snare * 1.15));
      else snareF *= Math.exp(-dt / 1.1);
      if (a.hatHit) hatF = Math.max(hatF, 0.6 + 0.4 * Math.min(1, a.hat * 1.3));
      else hatF *= Math.exp(-dt / 0.9);
      kickEnv = a.kickHit ? 1 : kickEnv * Math.exp(-dt * 5);

      // drop: everything implodes into the kick orb for a moment, then is thrown back out
      const dropNow = a.drop > 0.6 && dropPrev <= 0.6;
      dropPrev = a.drop;
      if (dropNow) {
        sinceDrop = 0;
        imploding = true;
      } else sinceDrop = Math.min(sinceDrop + dt, 100);
      gather = approach(gather, sinceDrop < 3 ? 0 : Math.pow(clamp01(Math.max(a.build, frame.feel.tension)), 1.5), 3, dt);
      if (imploding) implode = approach(implode, 1, 38, dt);
      const throwK = 0.45 + 0.55 * Math.min(1.6, bounce);
      const burst = imploding && sinceDrop >= 0.13;
      const gTot = Math.max(GATHER * gather, implode);
      const blaze = sinceDrop < 9 ? Math.exp(-sinceDrop * 0.45) : 0;
      const great = sinceDrop < 5 ? (1 - Math.exp(-sinceDrop * 40)) * Math.exp(-sinceDrop * 2.4) : 0;

      // hits
      const kStr = Math.min(1, 0.45 + 0.6 * a.kick) * bounce;
      const sStr = Math.min(1, 0.45 + 0.6 * a.snare) * bounce;
      if (a.kickHit) {
        const k = orbs[0];
        k.squash.vel += 4 * kStr;
        k.level.vel += 2.2 * kStr;
        k.hit = 1;
        surge += 0.03 * kStr; // the whole row surges a little on the beat
        for (let i = 1; i < N; i++) {
          // orbs next to the kick orb are shoved aside and spring back
          const o = orbs[i];
          const dist = wrap(o.s - k.s, loop);
          if (Math.abs(dist) < 0.5) o.nudge.vel += Math.sign(dist || 1) * 0.6 * (1 - Math.abs(dist) / 0.5) * kStr;
        }
      }
      if (a.snareHit) {
        const sn = orbs[3];
        sn.level.vel += 3.2 * sStr;
        sn.squash.vel -= 3.4 * sStr;
        sn.hit = 1;
        // the whole mobile shivers; harder as a build winds up
        for (let i = 0; i < N; i++) orbs[i].cross.vel += (i % 2 === 0 ? 1 : -1) * (0.14 + 0.2 * gather) * sStr * (i === 0 ? 0.35 : 1);
      }
      if (a.hatHit) {
        satBlink[satNext] = 1;
        satNext = (satNext + 1) % SATS;
        orbs[6].hit = 1;
      }

      const cruiseK = speed * (0.35 + 1.6 * e) * (1 - smooth(0, 0.35, gTot));
      surge *= Math.exp(-dt * 2.6);
      drift = wrap(drift + (0.026 * cruiseK + surge * (0.4 + 0.6 * speed)) * dt, loop);
      const energyHeat = smooth(0.58, 0.9, e);
      const voiceGate = smooth(0.25, 0.5, e);
      const sizeK = size * fit * (0.84 + 0.32 * e);

      // who is here: energy decides who is in the room; drums bring their own orb; a drop brings everyone
      for (let i = 0; i < N; i++) {
        const cfg = CAST[i];
        const o = orbs[i];
        const active =
          i < count && (e > cfg.thr || (cfg.role === 'kick' && kickF > 0.2) || (cfg.role === 'snare' && snareF > 0.2) || sinceDrop < 6);
        o.pres = fresh ? (active ? 1 : 0) : approach(o.pres, active ? 1 : 0, active ? 3.2 : 1.3, dt);
        if (i === 0 && imploding) o.pres = Math.max(o.pres, implode);
        o.presE = o.pres * o.pres * (3 - 2 * o.pres);
      }

      // seats along the row: each as wide as its orb, the slack shared out between them
      let total = 0;
      for (const i of ROW) total += orbs[i].presE * (2 * CAST[i].base * sizeK + 0.08);
      const slack = loop / Math.max(total, 0.05);
      let cum = 0;
      for (const i of ROW) {
        const o = orbs[i];
        const wd = o.presE * (2 * CAST[i].base * sizeK + 0.08) * slack;
        o.seat = cum + wd / 2 - loop / 2;
        o.wander = Math.min(0.3, 0.42 * wd);
        cum += wd;
      }

      // pass 1: how big, and where along the line
      for (let i = 0; i < N; i++) {
        const cfg = CAST[i];
        const o = orbs[i];
        o.lvl = Math.max(0, o.level.step(Math.min(1.15, levelOf(cfg.role, a, kickF, snareF, cfg.bin)), dt));

        o.imp *= Math.exp(-dt * 2.3);
        o.off = (o.off + o.imp * dt) * Math.exp(-dt * 0.45);
        let place: number;
        if (cfg.cruise !== 0) {
          o.roam = wrap(o.roam + cfg.cruise * cruiseK * dt, loop);
          place = o.roam;
        } else place = drift + o.seat + o.wander * Math.sin(clock * o.freq + o.phase);
        const s = wrap(place + o.off + o.nudge.step(0, dt), loop);
        if (Math.abs(s - o.s) > loop * 0.4) o.hasPrev = false; // went round the loop
        o.s = s;

        let r0 = cfg.base * sizeK * o.presE * (0.56 + 0.44 * o.lvl) * (1 - (i === 0 ? 0.15 : 0.4) * gather);
        if (i === 0) r0 *= 1 + 1.05 * great * throwK;
        // while everything is being drawn together, orbs near the ends fade rather than jump across
        // (the kick orb is excused during the implosion: it is the great orb, wherever it was)
        if (gTot > 0.001) r0 *= 1 - Math.min(1, gTot * 8) * smooth(loop / 2 - 0.32, loop / 2 - 0.06, Math.abs(s)) * (i === 0 ? 1 - implode : 1);
        o.r0 = r0;

        o.scatT *= Math.exp(-dt * 0.55);
        o.scat = approach(o.scat, o.scatT, 5, dt);
        o.cB = cfg.amp * room * (0.7 + 0.8 * e) * Math.sin(clock * o.freq * 0.83 + o.phase * 1.7) * crossK + o.scat;
        o.sE = gatherAt + (s - gatherAt) * (1 - gTot);
        push[i] = 0;
      }

      if (burst) {
        // keep everything where it has collapsed to, then throw it outward
        for (let i = 0; i < N; i++) {
          const o = orbs[i];
          o.off += o.sE - o.s;
          o.s = o.sE;
          o.imp = i === 0 ? 0.08 : (i % 2 === 0 ? 1 : -1) * (0.45 + 0.9 * rnd()) * throwK;
          o.scatT = i === 0 ? 0 : (i % 4 < 2 ? 1 : -1) * (0.05 + 0.15 * rnd()) * room * throwK;
          o.cross.value = 0;
          o.cross.vel = 0;
          o.nudge.vel = 0;
          o.dodge = 0;
          o.hit = 1;
        }
        imploding = false;
        implode = 0;
        gather = 0;
        crossK = 0;
      }
      crossK = approach(crossK, 1, 0.9, dt);
      // (after a burst the positions are already collapsed, so nothing more to draw in this frame)
      const pull = burst ? 0 : gTot;
      const line = burst ? 1 : Math.max(gather, implode); // how strictly everything sits on the line

      // two orbs passing each other step aside just enough to graze and merge, the lighter one more
      for (let i = 0; i < N; i++) {
        const oi = orbs[i];
        if (oi.r0 < 0.002) continue;
        for (let j = i + 1; j < N; j++) {
          const oj = orbs[j];
          if (oj.r0 < 0.002) continue;
          const reach = (oi.r0 + oj.r0) * 0.93;
          const gap = Math.max(0, Math.abs(oj.sE - oi.sE) - oi.hl - oj.hl);
          if (gap >= reach) continue;
          const dc = oj.cB - oi.cB;
          const want = Math.sqrt(reach * reach - gap * gap) - Math.abs(dc);
          if (want <= 0) continue;
          const sgn = Math.abs(dc) > 1e-3 ? Math.sign(dc) : (i + j) % 2 === 0 ? 1 : -1;
          const mi = oi.r0 * oi.r0;
          const mj = oj.r0 * oj.r0;
          push[i] -= (sgn * want * mj) / (mi + mj);
          push[j] += (sgn * want * mi) / (mi + mj);
        }
      }

      // pass 2: place, stretch, heat
      for (let i = 0; i < N; i++) {
        const cfg = CAST[i];
        const o = orbs[i];
        const r0 = o.r0;
        o.dodge = approach(o.dodge, push[i], 5, dt);
        const c = (o.cB + o.dodge) * (1 - line) + o.cross.step(0, dt) * (1 - implode);
        const sE = burst ? o.s : gatherAt + (o.s - gatherAt) * (1 - pull);
        const x = ux * sE + nx * c;
        const y = uy * sE + ny * c;
        if (o.hasPrev && dt > 1e-4) {
          const dx = (x - o.x) / dt;
          const dy = (y - o.y) / dt;
          o.vs = approach(o.vs, dx * ux + dy * uy, 14, dt);
          o.vc = approach(o.vc, dx * nx + dy * ny, 14, dt);
        } else if (!o.hasPrev) {
          o.vs = 0;
          o.vc = 0;
        }
        o.x = x;
        o.y = y;
        o.hasPrev = true;

        // fast orbs lengthen into pills (and thin a little, like liquid); bass has a pill of its own;
        // a build pulls everything long and taut. The kick orb stays round: it is the one they fall into.
        const sp = Math.abs(o.vs);
        let hl = Math.min(sp * 0.42 * stretch, (i === 0 ? 0.25 : 1.1) * r0) * (1 - implode) + gather * (i === 0 ? 0.4 : 1.8) * r0 * (1 - implode);
        if (cfg.role === 'bass') hl += r0 * 1.1 * Math.min(1, o.lvl) * (1 - implode);
        const r = r0 / Math.sqrt(1 + (0.55 * hl) / Math.max(r0, 1e-4));
        const dir = sp > 0.004 ? Math.sign(o.vs) : 1;
        o.lean = approach(o.lean, Math.max(-0.22, Math.min(0.22, o.vc / (sp + 0.15))) * (1 - line), 6, dt);
        const ca = Math.cos(o.lean);
        const sa = Math.sin(o.lean);
        o.ax = ux * ca - uy * sa;
        o.ay = ux * sa + uy * ca;

        // soft-body squash, plus a slow breath so nothing is ever quite still
        const q = Math.max(-0.5, Math.min(0.5, o.squash.step(0, dt))) + 0.03 * Math.sin(clock * 1.7 + o.phase * 3);
        const sq = Math.exp(q);

        // rim heat: earned by hits, the voice and energy; white otherwise
        o.hit *= Math.exp(-dt * 4.2);
        let heat = 0;
        if (cfg.role === 'kick' || cfg.role === 'snare') heat = o.hit * (0.45 + 0.55 * e);
        else if (cfg.role === 'mid') heat = clamp01((a.mid - 0.28) * 2.2) * voiceGate;
        else heat = Math.max(energyHeat * (0.2 + 0.55 * Math.min(1, o.lvl) + 0.25 * kickEnv), cfg.role === 'air' ? o.hit * 0.6 * voiceGate : 0);
        heat = Math.min(1.2, Math.max(heat, blaze, 0.4 * gather * gather * gather) * rims);

        // echoes: fan out behind a fast orb; a ghost keeps its stack; heat sets the rings a little off-centre
        const trail =
          dir * Math.min(sp * 0.36 * stretch, 0.85 * r0) * (1 - implode) + cfg.ghost * 0.55 * r * (0.75 + 0.25 * Math.sin(clock * 0.6 + o.phase)) + heat * 0.03 * r;

        o.hl = hl;
        o.r = r;
        o.rAlong = r * sq + hl;
        o.rAcross = r / sq;

        const j = i * 4;
        orbA[j] = x;
        orbA[j + 1] = y;
        orbA[j + 2] = r;
        orbA[j + 3] = hl;
        orbB[j] = o.ax;
        orbB[j + 1] = o.ay;
        orbB[j + 2] = sq;
        orbB[j + 3] = heat;
        orbC[j] = trail;
        orbC[j + 1] = cfg.hue;
        orbC[j + 2] = cfg.tint;
        orbC[j + 3] = smooth(0, 0.45, o.pres);
      }

      // hat satellites: each rides the rim of its host and blinks in turn
      satP = approach(satP, hatF > 0.08 || e > 0.62 ? 1 : 0, 2.5, dt);
      for (let j = 0; j < SATS; j++) {
        const host = orbs[SAT_HOST[j]];
        satAng[j] = (satAng[j] + dt * satDir[j] * (0.4 + 2.2 * hatF + 0.8 * e) * (0.5 + 0.5 * speed)) % (Math.PI * 2);
        satBlink[j] *= Math.exp(-dt * 8);
        const sn = Math.sin(satAng[j]);
        const cs = Math.cos(satAng[j]);
        const vis = satP * host.presE * (1 - Math.max(gather, implode));
        const sr = Math.min(0.036, Math.max(0.014, host.r * 0.26)) * size * (0.75 + 0.45 * satBlink[j]) * smooth(0, 0.6, vis);
        const oa = host.rAlong + sr * 0.25;
        const ob = host.rAcross + sr * 0.25;
        const k = j * 4;
        satA[k] = host.x + host.ax * oa * cs - host.ay * ob * sn;
        satA[k + 1] = host.y + host.ay * oa * cs + host.ax * ob * sn;
        satA[k + 2] = sr;
        satA[k + 3] = satBlink[j];
        satB[j * 2] = satHue[j];
        satB[j * 2 + 1] = vis * (0.75 + 0.25 * satBlink[j]);
      }

      updateBaseUniforms(uniforms, frame);
      updateParamUniforms(uniforms, params, P);
      uniforms.uFlash.value = sinceDrop < 3 ? Math.exp(-sinceDrop * 3.2) : 0;
      uniforms.uMergeK.value = merge * 0.05 * (1 + 0.4 * gather);
      quad.render(frame.renderer, target);
    },
    dispose() {
      material.dispose();
      quad.dispose();
    },
  };
}

export const softOrbs: SceneDef = {
  id: 'soft-orbs',
  name: 'Soft Orbs',
  description:
    'A few milky, glowing orbs and pills strung along a diagonal on black, drifting like a mobile in a dark room. Each one is a voice in the mix and its size is that voice: the kick orb squashes and rebounds on every hit, bass stretches into a pill, the vocal disc swells and its rim lights up, hats are tiny orbiting satellites. Orbs that meet merge like liquid; a build draws them all to one point and the drop bursts them back out with their rims blazing.',
  category: 'field',
  style: 'light',
  tags: ['minimal', 'playful', 'tender', 'dreamy', 'calm', 'spacious', 'bouncy', 'pop', 'indie', 'electronic', 'dark', 'graphic'],
  params,
  modulations: [
    { source: 'sway', param: 'tilt', amount: 0.05 },
    { source: 'sub', param: 'merge', amount: 0.15 },
    { source: 'energy', param: 'glow', amount: 0.15 },
  ],
  create,
};
