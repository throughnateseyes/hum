/**
 * Neurones — a luminous branching organism on black: from one dense root, hair-fine curving
 * branches fan out, fork again and again and end in hundreds of small round nodes (a neuron, a
 * sea fan, a firework frozen mid-burst). It is for wonder: a thought, or a feeling, spreading.
 *
 * The tree is grown once with a seeded PRNG (recursive forking, each fork splitting its "tip
 * budget" and its angular sector between the children) and every vertex stores a growth
 * coordinate g: 0 at the root, 1 at the furthest tip, continuous along every path. Everything the
 * music does is a function of g:
 *   - the growth front (how far out the branches are drawn) follows the song's energy;
 *   - kicks launch a pulse at g = 0 that runs out to the tips, snares fire one family only;
 *   - a build sends faster and faster pulses back INTO the root while the tips dim;
 *   - a drop fires the whole network and sprouts a second organism in the opposite corner.
 * Branches are screen-space ribbons (hair-fine at any resolution), nodes are round point sprites.
 *
 * Palette roles: bg = the dark; fg = the white-hot pulse, growing tips and node flashes (also one
 * pale branch family); accent and accent2 = the two main branch families; muted = the deep colour
 * near the roots. The other families are mixes: accent2+muted, accent+muted.
 */
import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { ParamDef } from '../../core/types';
import { approach, beatsPerSecond, GLSL_RIBBON, isLightPalette, makeMaterial, setAdaptiveBlending, Spring, stepDt, syncMaterial } from './common';

/** pulses alive at once (kicks, snares, build, heartbeat) */
const NP = 10;
/** sample spacing along a branch, in organism units (the long sprays reach about 1) */
const DS = 0.021;
/** growth-front value at which everything is drawn */
const FULL = 1.06;
const FOV = 30;

const params: ParamDef[] = [
  { id: 'weight', label: 'Line weight', group: 'Shape', type: 'number', min: 0.5, max: 3, step: 0.05, default: 1.15, hint: 'px at 1080p' },
  { id: 'nodes', label: 'Node size', group: 'Shape', type: 'number', min: 0.3, max: 2.5, step: 0.01, default: 1 },
  { id: 'growth', label: 'Growth range', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.9, hint: 'How much is held back for the loud parts: 0 is always fully grown, 1 shrinks to a small core when it is quiet' },
  { id: 'sway', label: 'Sway', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'Underwater drift of the branches, strongest at the tips; the bass pushes it' },
  { id: 'drift', label: 'Camera drift', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  { id: 'zoom', label: 'Camera follows growth', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.85, hint: 'Moves in close on the small core in quiet parts and pulls back as it grows' },
  { id: 'pulse', label: 'Pulse strength', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Brightness of the signals that kicks and snares send from root to tip' },
  { id: 'speed', label: 'Signal speed', group: 'Reactivity', type: 'number', min: 0.3, max: 2.5, step: 0.01, default: 1, hint: '1 = a pulse runs from the root to the furthest tip in about a beat and a half' },
  { id: 'glow', label: 'Glow', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
  { id: 'variety', label: 'Colour variety', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: '0 draws every branch in the accent colour, 1 gives each family its own' },
];

/* ───────────────────────── Shaders ───────────────────────── */

const SHARED = /* glsl */ `
#define NP ${NP}
uniform vec4 uXf0, uXf1;     // per organism: root x, root y, scale, rotation
uniform vec4 uGrow0, uGrow1; // per organism: growth front, ember front, growing 0..1, tip brightness
uniform vec4 uPulse[NP];     // head position (g), family (-1 = all), strength, tail (negative = running inward)
uniform float uSwayT, uSwayA, uBreath, uFire, uPx, uLight;

// six branch colours out of the palette: accent, accent2, their mixes with the deep colour, a pale one, the deep one
vec3 nrFamily(float i) {
  vec3 c = uAccent;
  if (i > 0.5) c = uAccent2;
  if (i > 1.5) c = mix(uAccent2, uMuted, 0.5) * 1.12;
  if (i > 2.5) c = mix(uFg, uAccent, 0.1) * 0.86;
  if (i > 3.5) c = mix(uAccent, uMuted, 0.5) * 1.1;
  if (i > 4.5) c = uMuted;
  return mix(uAccent, c, u_variety);
}

// brightness of the signals at growth coordinate g: a sharp head with a tail behind it
float nrPulse(float g, float fam, float stretch) {
  float s = 0.0;
  for (int i = 0; i < NP; i++) {
    vec4 P = uPulse[i];
    if (P.z <= 0.0) continue;
    float m = P.y < -0.5 ? 1.0 : 1.0 - step(0.5, abs(P.y - fam));
    float d = (P.x - g) * sign(P.w);
    s += smoothstep(-0.014, 0.0, d) * exp(-max(d, 0.0) / (abs(P.w) * stretch)) * P.z * m;
  }
  return s;
}

// organism space → world: slow underwater sway (stronger toward the tips), breathing, then the layout
vec3 nrPlace(vec3 p, float g, vec4 xf) {
  vec2 q = p.xy * 2.4;
  vec3 d = vec3(
    sin(q.y * 1.3 + uSwayT * 0.9) + 0.5 * sin(q.x * 2.1 - uSwayT * 1.31),
    sin(q.x * 1.1 - uSwayT * 0.7 + 1.7) + 0.5 * sin(q.y * 2.3 + uSwayT * 1.13),
    sin(q.x + q.y + uSwayT * 0.5));
  p += d * uSwayA * g * sqrt(g);
  p.xy *= 1.0 + uBreath * (0.2 + 0.8 * g);
  float c = cos(xf.w), s = sin(xf.w);
  p.xy = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  return vec3(p.xy * xf.z + xf.xy, p.z * xf.z);
}
`;

const LINE_VERT = /* glsl */ `
${SHARED}
${GLSL_RIBBON}
attribute vec3 aPrev;
attribute vec3 aNext;
attribute vec4 aA; // growth coordinate, side, family, colour
attribute vec3 aB; // organism, random, thickness
varying float vG;
varying float vSide;
varying float vW;
varying float vCover;
varying float vFam;
varying vec3 vCol;
varying vec4 vGrow;
void main() {
  float g = aA.x;
  vec4 xf = aB.x < 0.5 ? uXf0 : uXf1;
  vec4 gr = aB.x < 0.5 ? uGrow0 : uGrow1;
  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 c0 = mvp * vec4(nrPlace(position, g, xf), 1.0);
  vec4 cp = mvp * vec4(nrPlace(aPrev, g, xf), 1.0);
  vec4 cn = mvp * vec4(nrPlace(aNext, g, xf), 1.0);
  float pulse = min(nrPulse(g, aA.z, 1.0), 1.4) * u_pulse;
  // the growing tip is drawn first as a bright bead
  float tip = exp(-max(gr.x - g, 0.0) / 0.022) * gr.z;
  float w = u_weight * uPx * aB.z * (1.0 + pulse * 0.9 + tip * 1.7 + uFire * 0.3);
  // nothing beyond the growth front
  w *= 1.0 - step(gr.x + 0.03, g);
  float wpx = max(w, 1.0);
  vCover = min(w, 1.0);
  vW = wpx;
  vSide = aA.y;
  vG = g;
  vFam = aA.z;
  vGrow = gr;
  // deep colour near the root, the family colour further out
  vCol = mix(nrFamily(5.0), nrFamily(aA.w), 0.3 + 0.7 * smoothstep(0.0, 0.3, g));
  gl_Position = ribbonExtrude(cp, c0, cn, aA.y, w > 0.0 ? wpx + 1.0 : 0.0);
}
`;

const LINE_FRAG = /* glsl */ `
${SHARED}
varying float vG;
varying float vSide;
varying float vW;
varying float vCover;
varying float vFam;
varying vec3 vCol;
varying vec4 vGrow;
void main() {
  float dpx = abs(vSide) * (vW + 1.0) * 0.5;
  float a = clamp(vW * 0.5 + 0.5 - dpx, 0.0, 1.0) * vCover;
  a *= 1.0 - smoothstep(vGrow.x - 0.012, vGrow.x, vG);
  if (a < 0.003) discard;
  float tip = exp(-max(vGrow.x - vG, 0.0) / 0.028) * vGrow.z;
  float pulse = nrPulse(vG, vFam, 1.0) * u_pulse;
  // quieter where the trunks crowd together at the root; build-ups dim the outer half
  float base = (0.3 + 0.42 * u_glow) * mix(0.5, 1.0, smoothstep(0.0, 0.28, vG));
  float dim = mix(1.0, vGrow.w, smoothstep(0.1, 0.55, vG));
  base = base * dim + (1.0 - vGrow.w) * 1.4 * (1.0 - smoothstep(0.0, 0.4, vG));
  pulse *= 0.35 + 0.65 * dim;
  float hot = clamp(pulse * 0.75 + tip + uFire * 0.25, 0.0, 1.6);
  if (uLight > 0.5) {
    vec3 col = mix(vCol, uFg, clamp(hot, 0.0, 1.0) * 0.85);
    gl_FragColor = vec4(col, a * clamp(0.45 + base * 0.7 + hot, 0.0, 1.0));
  } else {
    vec3 col = vCol * (base + pulse * 0.8 + uFire * 0.75) + uFg * hot * 0.7;
    gl_FragColor = vec4(col, a);
  }
}
`;

const NODE_VERT = /* glsl */ `
${SHARED}
attribute vec4 aN; // growth coordinate, family, colour, random
attribute vec2 aM; // organism, radius in px at 1080p (negative = the glow at the root)
uniform float uHatN, uHatE, uRoot, uView;
varying vec3 vCol;
varying float vA;
varying float vHot;
varying float vKind;
varying float vAA;
const float GLOW = 3.2;
void main() {
  float g = aN.x;
  vec4 xf = aM.x < 0.5 ? uXf0 : uXf1;
  vec4 gr = aM.x < 0.5 ? uGrow0 : uGrow1;
  vec4 mv = modelViewMatrix * vec4(nrPlace(position, g, xf), 1.0);
  gl_Position = projectionMatrix * mv;
  float sc = uPx * uView * pow(xf.z, 0.6) * 0.82;
  if (aM.y < 0.0) {
    // the root: a soft glow that charges up in a build and thumps on kicks
    vKind = 1.0;
    float on = smoothstep(0.0, 0.12, gr.x);
    gl_PointSize = clamp(-aM.y * sc * 2.0 * (0.8 + uRoot * 1.6), 1.0, 480.0);
    vA = (0.1 + 0.2 * u_glow + uRoot * 0.75) * on;
    vHot = uRoot;
    vCol = mix(nrFamily(5.0), uFg, 0.25 + 0.6 * clamp(uRoot, 0.0, 1.0));
    vAA = 0.0;
    return;
  }
  vKind = 0.0;
  float born = smoothstep(g, g + 0.03, gr.x);
  float fresh = exp(-max(gr.x - g, 0.0) / 0.09) * gr.z * born;
  float pulse = nrPulse(g, aN.y, 2.6) * u_pulse;
  // hats pick a different random handful of nodes every time
  float tw = step(0.86, hash11(aN.w * 91.7 + uHatN * 7.13)) * uHatE;
  float idle = 0.84 + 0.16 * sin(uTime * (0.5 + aN.w * 1.4) + aN.w * 40.0);
  // tips the front has pulled back from linger as embers
  float ember = (1.0 - born) * step(g, gr.y) * (0.3 + 0.2 * sin(uTime * (0.4 + aN.w) + aN.w * 50.0));
  float hot = clamp(pulse + tw * 1.3 + fresh + uFire, 0.0, 2.0) * born;
  float r = aM.y * u_nodes * sc * (born * (1.0 + min(hot, 1.5) * 0.45) + (1.0 - born) * 0.6);
  gl_PointSize = clamp(max(r, 0.8) * 2.0 * GLOW, 3.0, 240.0);
  vAA = 2.0 / gl_PointSize;
  vA = born * idle * mix(1.0, gr.w, smoothstep(0.12, 0.6, g)) + ember;
  vHot = hot;
  vCol = nrFamily(aN.z);
  if (vA < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const NODE_FRAG = /* glsl */ `
${SHARED}
varying vec3 vCol;
varying float vA;
varying float vHot;
varying float vKind;
varying float vAA;
const float GLOW = 3.2;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (vKind > 0.5) {
    float gl = max(exp(-r * r * 5.5) - 0.0041, 0.0);
    if (uLight > 0.5) gl_FragColor = vec4(vCol, gl * vA * 0.14);
    else gl_FragColor = vec4(vCol * gl, vA);
    return;
  }
  float rc = 1.0 / GLOW;
  float disc = 1.0 - smoothstep(rc - vAA, rc + vAA, r);
  float halo = pow(max(1.0 - r, 0.0), 2.4);
  float h = min(vHot, 1.0);
  if (uLight > 0.5) {
    gl_FragColor = vec4(mix(vCol, uFg, h * 0.8), disc * min(vA, 1.0));
  } else {
    vec3 col = vCol * disc + uFg * disc * h * 0.9 + vCol * halo * (0.1 + 0.25 * u_glow + vHot * 0.5 * (0.4 + u_glow));
    gl_FragColor = vec4(col, vA);
  }
  if (gl_FragColor.a * (disc + halo) < 0.003) discard;
}
`;

/* ───────────────────────── Growing the tree ───────────────────────── */

/** one top-level branch family: a fan of branches leaving the root in one direction */
interface Fam {
  angle: number;
  /** angular width of the fan (radians) */
  fan: number;
  /** how far its tips get from the root */
  reach: number;
  tips: number;
  /** colour index of the branches, an alternative some sub-branches take, and the node colour */
  col: number;
  alt: number;
  node: number;
  /** node radius, px at 1080p */
  size: number;
}

// the big organism: long sprays along +x, a dense short halo around the back of the root
const MAIN: Fam[] = [
  { angle: 0.25, fan: 0.34, reach: 1.34, tips: 125, col: 3, alt: 0, node: 0, size: 4.4 },
  { angle: 0.0, fan: 0.32, reach: 1.5, tips: 135, col: 2, alt: 4, node: 1, size: 4.6 },
  { angle: -0.25, fan: 0.34, reach: 1.3, tips: 120, col: 0, alt: 4, node: 3, size: 4.4 },
  { angle: 0.7, fan: 0.36, reach: 0.64, tips: 75, col: 5, alt: 1, node: 1, size: 3.6 },
  { angle: -0.74, fan: 0.36, reach: 0.7, tips: 75, col: 1, alt: 3, node: 0, size: 4.0 },
  { angle: 1.7, fan: 0.75, reach: 0.42, tips: 80, col: 4, alt: 5, node: 2, size: 2.5 },
  { angle: 2.6, fan: 0.8, reach: 0.38, tips: 90, col: 2, alt: 0, node: 3, size: 2.3 },
  { angle: -2.85, fan: 0.8, reach: 0.4, tips: 90, col: 0, alt: 5, node: 1, size: 2.4 },
  { angle: -1.9, fan: 0.75, reach: 0.42, tips: 80, col: 1, alt: 2, node: 2, size: 2.5 },
];
// the second one: a fan to one side and a small tuft behind it
const SECOND: Fam[] = [
  { angle: 0.3, fan: 0.55, reach: 1.0, tips: 95, col: 2, alt: 3, node: 2, size: 3.6 },
  { angle: -0.22, fan: 0.55, reach: 1.08, tips: 105, col: 3, alt: 5, node: 3, size: 3.6 },
  { angle: 0.88, fan: 0.55, reach: 0.8, tips: 65, col: 5, alt: 1, node: 1, size: 3.2 },
  { angle: -0.8, fan: 0.5, reach: 0.86, tips: 65, col: 4, alt: 0, node: 0, size: 3.2 },
  { angle: 3.05, fan: 0.7, reach: 0.5, tips: 60, col: 0, alt: 4, node: 0, size: 2.4 },
];
const NFAM = MAIN.length;

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUPPORT_N = 72;
const EXTENT_N = 16;

interface Organisms {
  pos: Float32Array;
  prev: Float32Array;
  next: Float32Array;
  a: Float32Array;
  b: Float32Array;
  index: Uint32Array;
  nPos: Float32Array;
  nA: Float32Array;
  nM: Float32Array;
  /** per organism: furthest extent in each of SUPPORT_N directions (for fitting it into the frame) */
  support: Float32Array[];
  /** the big one, per growth step: centre x, centre y and radius of what has grown so far */
  extent: Float32Array;
}

let cached: Organisms | null = null;

function buildOrganisms(): Organisms {
  if (cached) return cached;
  const P: number[] = [];
  const PV: number[] = [];
  const NX: number[] = [];
  const A: number[] = [];
  const B: number[] = [];
  const IDX: number[] = [];
  const NPOS: number[] = [];
  const NA: number[] = [];
  const NM: number[] = [];
  const support: Float32Array[] = [];
  const extent = new Float32Array((EXTENT_N + 1) * 3);

  const organism = (ci: number, fams: Fam[], seed: number) => {
    const R = mulberry32(seed);
    const v0 = P.length / 3;
    const n0 = NA.length / 4;
    // the root's glow
    NPOS.push(0, 0, 0);
    NA.push(0, -1, 5, 0);
    NM.push(ci, -64);

    /** one branch as a ribbon; (hx, hy, hz) is the point before its first one, for a smooth join */
    const emit = (pts: number[], n: number, fi: number, col: number, thick: number, hx: number, hy: number, hz: number) => {
      const base = P.length / 3;
      const rnd = R();
      for (let j = 0; j <= n; j++) {
        const o = j * 4;
        const x = pts[o];
        const y = pts[o + 1];
        const z = pts[o + 2];
        const px = j > 0 ? pts[o - 4] : hx;
        const py = j > 0 ? pts[o - 3] : hy;
        const pz = j > 0 ? pts[o - 2] : hz;
        const nx = j < n ? pts[o + 4] : 2 * x - px;
        const ny = j < n ? pts[o + 5] : 2 * y - py;
        const nz = j < n ? pts[o + 6] : 2 * z - pz;
        for (let s = 1; s >= -1; s -= 2) {
          P.push(x, y, z);
          PV.push(px, py, pz);
          NX.push(nx, ny, nz);
          A.push(pts[o + 3], s, fi, col);
          B.push(ci, rnd, thick);
        }
        if (j < n) {
          const k = base + j * 2;
          IDX.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
      }
    };

    const angDiff = (to: number, from: number) => {
      let d = (to - from) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return d;
    };

    /**
     * Grow one branch from (x, y, z) heading th, then fork. `budget` is how many tips this branch
     * must end in, `sector` the angular room its children share, `remaining` the path length left
     * before the family's reach is used up.
     */
    const grow = (
      x: number, y: number, z: number, th: number, g: number, budget: number, target0: number, sector: number,
      fi: number, fam: Fam, col: number, nodeCol: number, depth: number, remaining: number, curv: number, twig: boolean,
    ) => {
      const terminal = budget <= 1;
      let target = target0;
      let len: number;
      if (twig) len = remaining;
      else if (terminal) len = remaining * (0.32 + 0.68 * R());
      else {
        const levels = Math.log(budget) / Math.log(2.7) + 1;
        len = (remaining * (0.55 + 0.8 * R())) / (levels + 1.3);
        if (depth === 0) len *= 0.4;
      }
      len = Math.max(len, 0.03);
      const n = Math.max(2, Math.ceil(len / DS));
      const ds = len / n;
      // branches conduct at slightly different speeds; short families are not finished too early
      const rate = (0.78 + 0.5 * R()) / Math.pow(fam.reach, 0.55);
      // every branch keeps a gentle curl of its own, so strands sweep instead of running straight
      let c = curv * 0.6 + ((R() * 2 - 1) * (terminal ? 1.3 : 0.6)) / fam.reach;
      const tau = 0.09 * fam.reach + 0.02;
      let zs = (R() * 2 - 1) * 0.55;
      const pts: number[] = [x, y, z, g];
      const hx = x - Math.cos(th) * ds;
      const hy = y - Math.sin(th) * ds;
      for (let i = 0; i < n; i++) {
        target += c * ds;
        th += angDiff(target, th) * (1 - Math.exp(-ds / tau));
        c += ((R() - 0.5) * ds * 6) / fam.reach;
        x += Math.cos(th) * ds;
        y += Math.sin(th) * ds;
        zs += (R() - 0.5) * ds * 5 - z * ds * 2;
        z = Math.max(-0.45, Math.min(0.45, z + zs * ds));
        g += ds * rate;
        pts.push(x, y, z, g);
      }
      emit(pts, n, fi, col, twig ? 0.85 : depth < 2 ? 1.3 : depth < 3 ? 1.12 : 1, hx, hy, z);

      // now and then a short side twig with an early node, so even a small core has a few
      if (!terminal && !twig && R() < (depth < 3 ? 0.6 : 0.35)) {
        const j = 1 + Math.floor(R() * (n - 1));
        const o = j * 4;
        const dir = Math.atan2(pts[o + 1] - pts[o - 3], pts[o] - pts[o - 4]);
        const side = R() < 0.5 ? 1 : -1;
        const a = dir + side * (0.45 + 0.5 * R());
        grow(pts[o], pts[o + 1], pts[o + 2], dir + side * 0.15, pts[o + 3], 1, a, 0, fi, fam, col, nodeCol, depth + 1, fam.reach * (0.06 + 0.1 * R()), side * 1.2, true);
      }

      if (terminal) {
        NPOS.push(x, y, z);
        NA.push(g, fi, nodeCol, R());
        NM.push(ci, fam.size * (twig ? 0.72 : 1) * (0.78 + 0.44 * R()));
        return;
      }

      // fork: 2–4 children share the budget and the sector
      const k = budget <= 4 ? budget : R() < 0.5 ? 2 : R() < 0.75 ? 3 : 4;
      const w: number[] = [];
      let sum = 0;
      for (let i = 0; i < k; i++) {
        w.push(0.4 + R());
        sum += w[i];
      }
      const share: number[] = [];
      let used = 0;
      for (let i = 0; i < k; i++) {
        const b = i === k - 1 ? budget - used : Math.max(1, Math.min(budget - used - (k - 1 - i), Math.round((budget * w[i]) / sum)));
        share.push(b);
        used += b;
      }
      // the children take their places across this branch's sector (never closer than a few
      // degrees), and each gets a sector of its own that shrinks more slowly than its share, so the
      // sprays overlap into clumps instead of tiling the fan evenly
      const spreadOut = Math.max(1, (0.15 * k) / Math.max(sector, 1e-3));
      const slots = share.map((b) => ((sector * b) / budget) * spreadOut);
      const total = slots.reduce((s, v) => s + v, 0);
      const widths = share.map((b) => Math.max(sector * Math.pow(b / budget, 0.3) * 0.85, 0.15));
      let at = target - total / 2;
      const rest = remaining - len;
      for (let i = 0; i < k; i++) {
        const centre = at + slots[i] / 2 + (R() - 0.5) * 0.1;
        at += slots[i];
        let cc = col;
        let nc = nodeCol;
        if (depth < 3) {
          const u = R();
          if (u < 0.22) cc = fam.alt;
          else if (u < 0.34) cc = 5;
          else if (u < 0.5) cc = fam.col;
          const v = R();
          if (v < 0.16) nc = fam.alt === 5 ? fam.col : fam.alt;
          else if (v < 0.4) nc = fam.node;
        }
        grow(x, y, z, th, g, share[i], centre, widths[i], fi, fam, cc, nc, depth + 1, rest, c, false);
      }
    };

    fams.forEach((f, fi) => {
      grow(0, 0, (R() - 0.5) * 0.05, f.angle + (R() - 0.5) * 0.3, 0, f.tips, f.angle, f.fan, fi % NFAM, f, f.col, f.node, 0, f.reach, 0, false);
    });

    // normalise the growth coordinate: the furthest tip of this organism sits at 1
    const v1 = P.length / 3;
    const n1 = NA.length / 4;
    let gMax = 1e-6;
    for (let i = v0; i < v1; i++) gMax = Math.max(gMax, A[i * 4]);
    for (let i = v0; i < v1; i++) A[i * 4] /= gMax;
    for (let i = n0; i < n1; i++) NA[i * 4] /= gMax;

    // how far it reaches in every direction
    const sup = new Float32Array(SUPPORT_N);
    for (let i = n0; i < n1; i++) {
      const x = NPOS[i * 3];
      const y = NPOS[i * 3 + 1];
      for (let d = 0; d < SUPPORT_N; d++) {
        const an = (d / SUPPORT_N) * Math.PI * 2;
        sup[d] = Math.max(sup[d], x * Math.cos(an) + y * Math.sin(an));
      }
    }
    support.push(sup);

    // what has grown by each growth step (the camera frames it)
    if (ci === 0) {
      for (let e = 0; e <= EXTENT_N; e++) {
        const f = (e / EXTENT_N) * FULL;
        let x0 = 0;
        let x1 = 0;
        let y0 = 0;
        let y1 = 0;
        for (let i = v0; i < v1; i += 2) {
          if (A[i * 4] > f) continue;
          const x = P[i * 3];
          const y = P[i * 3 + 1];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        extent[e * 3] = (x0 + x1) / 2;
        extent[e * 3 + 1] = (y0 + y1) / 2;
        extent[e * 3 + 2] = Math.max(0.08, Math.max(x1 - x0, y1 - y0) / 2);
      }
    }
  };

  organism(0, MAIN, 20260518);
  organism(1, SECOND, 7741);

  cached = {
    pos: new Float32Array(P),
    prev: new Float32Array(PV),
    next: new Float32Array(NX),
    a: new Float32Array(A),
    b: new Float32Array(B),
    index: new Uint32Array(IDX),
    nPos: new Float32Array(NPOS),
    nA: new Float32Array(NA),
    nM: new Float32Array(NM),
    support,
    extent,
  };
  return cached;
}

/* ───────────────────────── Scene ───────────────────────── */

interface Pulse {
  pos: number;
  fam: number;
  str: number;
  tail: number;
  /** growth units per second; negative runs toward the root */
  vel: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export const neurones = defineThreeScene({
  id: 'neurones',
  name: 'Neurones',
  description:
    'A luminous branching organism on black: hair-fine curving branches fan out from a dense root, fork again and again and end in hundreds of small round nodes. It grows outward with the energy of the song, every kick sends a bright signal from the root to the tips, snares fire one branch family and hats twinkle the nodes. Build-ups pull the light back into the root; the drop fires the whole network and a second organism sprouts beside it.',
  category: 'form',
  style: 'particles',
  tags: ['dreamy', 'organic', 'electronic', 'hypnotic', 'euphoric', 'spacious', 'nature', 'cinematic', 'uplifting', 'psychedelic', 'dark', 'futuristic'],
  params,
  modulations: [
    { source: 'bass', param: 'sway', amount: 0.2 },
    { source: 'energy', param: 'glow', amount: 0.2 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const bg = new THREE.Color();
    scene.background = bg;
    const camera = new THREE.PerspectiveCamera(FOV, init.width / Math.max(1, init.height), 0.1, 60);
    const D0 = 1 / Math.tan((FOV * Math.PI) / 360);

    const org = buildOrganisms();
    const pulseU = Array.from({ length: NP }, () => new THREE.Vector4(0, -1, 0, 0.1));
    const xf0 = new THREE.Vector4(0, 0, 1, 0);
    const xf1 = new THREE.Vector4(0, 0, 1, 0);
    const grow0 = new THREE.Vector4(0, 0, 0, 1);
    const grow1 = new THREE.Vector4(0, 0, 0, 1);
    // both materials read the same vectors
    const sharedUniforms = () => ({
      uXf0: { value: xf0 },
      uXf1: { value: xf1 },
      uGrow0: { value: grow0 },
      uGrow1: { value: grow1 },
      uPulse: { value: pulseU },
      uSwayT: { value: 0 },
      uSwayA: { value: 0 },
      uBreath: { value: 0 },
      uFire: { value: 0 },
      uPx: { value: 1 },
      uLight: { value: 0 },
    });

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(org.pos, 3));
    lineGeo.setAttribute('aPrev', new THREE.BufferAttribute(org.prev, 3));
    lineGeo.setAttribute('aNext', new THREE.BufferAttribute(org.next, 3));
    lineGeo.setAttribute('aA', new THREE.BufferAttribute(org.a, 4));
    lineGeo.setAttribute('aB', new THREE.BufferAttribute(org.b, 3));
    lineGeo.setIndex(new THREE.BufferAttribute(org.index, 1));
    const lineMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: LINE_VERT,
      fragment: LINE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      extra: sharedUniforms(),
    });
    const lines = new THREE.Mesh(lineGeo, lineMat);
    lines.frustumCulled = false;
    lines.renderOrder = 1;

    const nodeGeo = new THREE.BufferGeometry();
    nodeGeo.setAttribute('position', new THREE.BufferAttribute(org.nPos, 3));
    nodeGeo.setAttribute('aN', new THREE.BufferAttribute(org.nA, 4));
    nodeGeo.setAttribute('aM', new THREE.BufferAttribute(org.nM, 2));
    const nodeMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: NODE_VERT,
      fragment: NODE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      extra: { ...sharedUniforms(), uHatN: { value: 0 }, uHatE: { value: 0 }, uRoot: { value: 0 }, uView: { value: 1 } },
    });
    const nodes = new THREE.Points(nodeGeo, nodeMat);
    nodes.frustumCulled = false;
    nodes.renderOrder = 2;
    scene.add(lines, nodes);

    // ── state ──
    const pulses: Pulse[] = Array.from({ length: NP }, () => ({ pos: 0, fam: -1, str: 0, tail: 0.1, vel: 0 }));
    let pulseI = 0;
    const emit = (pos: number, fam: number, str: number, vel: number, tail: number) => {
      const q = pulses[pulseI];
      pulseI = (pulseI + 1) % NP;
      q.pos = pos;
      q.fam = fam;
      q.str = str;
      q.vel = vel;
      q.tail = tail;
    };

    const kick = new Spring(220, 14);
    const breath = new Spring(26, 6);
    let first = true;
    let energy = 0;
    let build = 0;
    let front = 0;
    let front2 = 0;
    let ember = 0;
    let ember2 = 0;
    let growing = 0;
    let growing2 = 0;
    let alive2 = 0;
    let fire = 0;
    let rush = 0;
    let prevDrop = 0;
    let snareN = 0;
    let hatN = 0;
    let hatE = 0;
    let buildPh = 0;
    let quiet = 0;
    let swayT = 0;
    let camT = 0;
    let viewH = 1;
    let viewX = 0;
    let viewY = 0;

    const sup = (ci: number, ang: number) => {
      const s = org.support[ci];
      const t = (((ang / (Math.PI * 2)) % 1) + 1) % 1;
      const f = t * SUPPORT_N;
      const i = Math.floor(f) % SUPPORT_N;
      return lerp(s[i], s[(i + 1) % SUPPORT_N], f - Math.floor(f));
    };
    /** put organism `ci`, turned by `rot`, inside a rectangle, pushed toward (ax, ay) of it */
    const fit = (out: THREE.Vector4, ci: number, rot: number, x0: number, x1: number, y0: number, y1: number, ax: number, ay: number) => {
      const r = sup(ci, -rot);
      const l = sup(ci, Math.PI - rot);
      const u = sup(ci, Math.PI / 2 - rot);
      const d = sup(ci, -Math.PI / 2 - rot);
      const s = Math.min((x1 - x0) / (r + l), (y1 - y0) / (u + d));
      out.set(x0 + (x1 - x0 - (r + l) * s) * ax + l * s, y0 + (y1 - y0 - (u + d) * s) * ay + d * s, s, rot);
    };

    return {
      scene,
      camera,
      update(frame) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        const light = isLightPalette(frame.palette);
        syncMaterial(lineMat, frame, params);
        syncMaterial(nodeMat, frame, params);
        bg.copy(frame.palette.c.bg);
        setAdaptiveBlending(lineMat, light);
        setAdaptiveBlending(nodeMat, light);
        const bps = beatsPerSecond(frame);

        // ── the song's state ──
        energy = first ? a.energy : approach(energy, a.energy, 1.4, dt);
        build = approach(build, Math.max(a.build, frame.feel.tension) * (1 - a.drop), 3, dt);
        kick.step(a.kick, dt);
        breath.step(Math.min(1, a.bass * 0.7 + a.sub * 0.6), dt);
        const dropped = a.drop > 0.6 && prevDrop <= 0.6;
        prevDrop = a.drop;
        const sig = bps * 0.62 * num(p, 'speed', 1);
        if (dropped) {
          // the whole network fires at once and the second organism wakes
          fire = 1;
          rush = 1;
          alive2 = 1;
          breath.vel += 3;
          emit(0, -1, 2, sig * 3, 0.8);
        }
        fire = approach(fire, 0, 2, dt);
        rush = Math.max(0, rush - dt / 1.2);

        // ── growth fronts ──
        const minF = lerp(FULL, 0.2, clamp01(num(p, 'growth', 0.9)));
        let target = lerp(minF, FULL, Math.pow(clamp01((energy - 0.1) / 0.75), 1.15)) * (1 - 0.32 * build);
        if (rush > 0) target = FULL;
        if (first) front = target * 0.6;
        const before = front;
        const gap = target - front;
        front += Math.max(-0.1 * dt, Math.min((0.2 + rush * 3.5) * dt, gap * Math.min(1, dt * 4)));
        growing = approach(growing, clamp01((front - before) / Math.max(dt, 1e-4) / 0.12), 5, dt);
        ember = Math.max(front, ember - dt * 0.03);

        if (energy < 0.42) alive2 = Math.max(0, alive2 - dt * 0.6);
        const target2 = Math.max(alive2, smooth(0.8, 0.92, energy) * (1 - smooth(0.02, 0.2, build))) > 0.5 ? FULL : 0;
        const before2 = front2;
        const gap2 = target2 - front2;
        front2 += Math.max(-0.16 * dt, Math.min(0.85 * dt, gap2 * Math.min(1, dt * 4)));
        growing2 = approach(growing2, clamp01((front2 - before2) / Math.max(dt, 1e-4) / 0.3), 5, dt);
        ember2 = Math.max(front2, ember2 - dt * 0.03);

        // ── signals ──
        quiet += dt;
        // in a build the signals turn round: every hit runs from the tips back INTO the root, so a
        // snare roll becomes light pouring inward faster and faster
        const inward = build > 0.12;
        if (a.kickHit) {
          if (inward) emit(front + 0.02, -1, 1 + 0.5 * build, -sig * (1 + build), -0.06);
          else emit(0, -1, 0.9 + 0.35 * Math.min(1, a.kick), sig, 0.055);
          quiet = 0;
          buildPh = 0;
        }
        if (a.snareHit) {
          // one family at a time, hopping around the organism
          snareN++;
          if (inward) emit(front + 0.02, build > 0.6 ? -1 : (snareN * 4) % NFAM, 0.8 + 0.6 * build, -sig * (1.1 + build), -0.07);
          else emit(0, (snareN * 4) % NFAM, 1.3, sig * 1.4, 0.13);
          quiet = 0;
          buildPh = 0;
        }
        if (a.hatHit) hatN++;
        hatE = a.hat;
        if (inward) {
          // a build with no drums in it still gathers, on its own quickening clock
          buildPh += dt * bps * (1 + build * 5);
          if (buildPh >= 1.5) {
            buildPh = 0.5;
            emit(front + 0.02, -1, 0.55 + 0.7 * build, -sig * (0.9 + build), -0.07);
          }
        } else buildPh = 0;
        if (quiet > 4.4 / Math.max(0.5, bps) + 0.3) {
          // nothing is hitting: a slow heartbeat keeps it alive
          emit(0, -1, 0.6, sig * 0.36, 0.2);
          quiet = 0.3;
        }
        for (let i = 0; i < NP; i++) {
          const q = pulses[i];
          if (q.str > 0) {
            q.pos += q.vel * dt;
            if (q.pos > FULL + Math.abs(q.tail) * 5 || q.pos < -Math.abs(q.tail) * 5) q.str = 0;
          }
          pulseU[i].set(q.pos, q.fam, q.str, q.tail);
        }

        // ── layout from the aspect: the big one up and to the left, the second in the opposite corner ──
        const hw = frame.aspect;
        const m = 0.1;
        const t = clamp01((frame.aspect - 0.62) / (1.6 - 0.62));
        const drift = num(p, 'drift', 0.5);
        camT += dt;
        const turn = Math.sin(camT * 0.09) * 0.05 * drift;
        fit(xf0, 0, lerp(-1.2, 0.3, t) + turn, -hw + m * 1.6, lerp(hw - m, hw * 0.4, t), lerp(-0.36, -1 + m, t), 1 - m, lerp(0.5, 0, t), 1);
        fit(xf1, 1, lerp(2.5, 2.72, t) - turn * 1.4, lerp(-hw * 0.85, hw * 0.34, t), hw - m, -1 + m * 0.8, lerp(-0.3, 0.05, t), 1, 0);
        grow0.set(front, ember, growing, 1 - 0.85 * build);
        grow1.set(front2, ember2, growing2, 1 - 0.85 * build);

        // ── camera: close on the small core when it is quiet, the whole frame once it has grown ──
        const ef = clamp01(front / FULL) * EXTENT_N;
        const ei = Math.min(EXTENT_N - 1, Math.floor(ef));
        const ex = (k: number) => lerp(org.extent[ei * 3 + k], org.extent[ei * 3 + 3 + k], ef - ei);
        const cr = Math.cos(xf0.w);
        const sr = Math.sin(xf0.w);
        const cx = xf0.x + (cr * ex(0) - sr * ex(1)) * xf0.z;
        const cy = xf0.y + (sr * ex(0) + cr * ex(1)) * xf0.z;
        let h = Math.min(1, Math.max(0.36, (1.5 * ex(2) * xf0.z) / Math.min(1, Math.pow(frame.aspect, 0.8))));
        h = lerp(h, 1, smooth(0, 0.3, front2 / FULL));
        const follow = num(p, 'zoom', 0.85) * (1 - smooth(0.6, 1, h));
        // a build leans in a little, the drop falls back
        const hT = lerp(1, h, num(p, 'zoom', 0.85)) * (1 - 0.08 * build);
        const rate = first ? 1e3 : 0.9 + rush * 4;
        viewH = approach(viewH, hT, rate, dt);
        viewX = approach(viewX, cx * follow, rate, dt);
        viewY = approach(viewY, cy * follow, rate, dt);
        const yaw = Math.sin(camT * 0.13) * 0.16 * drift + a.sway * 0.015;
        const pitch = Math.sin(camT * 0.097 + 1.3) * 0.1 * drift;
        const dist = D0 * viewH;
        camera.position.set(viewX + Math.sin(yaw) * Math.cos(pitch) * dist, viewY + Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist);
        camera.lookAt(viewX, viewY, 0);
        camera.rotateZ(Math.sin(camT * 0.071 + 0.6) * 0.035 * drift);

        // ── uniforms ──
        const swayP = num(p, 'sway', 0.5);
        swayT += dt * (0.45 + energy * 0.5);
        const b = Math.max(0, breath.value);
        const px = Math.min(frame.width, frame.height) / 1080;
        for (const mat of [lineMat, nodeMat]) {
          const u = mat.uniforms;
          u.uSwayT.value = swayT % (Math.PI * 2000);
          u.uSwayA.value = swayP * (0.014 + 0.05 * b);
          u.uBreath.value = (0.3 + swayP) * (b * 0.03 + Math.max(0, kick.value) * 0.012);
          u.uFire.value = fire;
          u.uPx.value = px;
          u.uLight.value = light ? 1 : 0;
        }
        const nu = nodeMat.uniforms;
        nu.uHatN.value = hatN % 4096;
        nu.uHatE.value = hatE;
        nu.uRoot.value = Math.min(1.6, build * 1.1 + Math.max(0, kick.value) * 0.35 + fire * 0.9);
        nu.uView.value = Math.pow(1 / Math.max(0.3, viewH), 0.5);
        first = false;
      },
    };
  },
});
