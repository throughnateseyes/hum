import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl';
import { buildSceneFragment, createFullscreenQuad } from '../../core/sceneHelpers';
import type { FrameContext, ParamDef, ResolvedPalette, SceneDef, SceneInit, SceneInstance } from '../../core/types';
import { createBaseUniforms, num, updateBaseUniforms, updateParamUniforms } from '../../core/uniforms';
import { Spring, approach, stepDt } from '../three/common';
import { HM_LIB } from '../shader/lib';

/**
 * Overprint: a mid-century geometric poster that recomposes itself to the song. Big circles, half
 * circles and split discs stacked along a spine, crossed by diagonal bands and one dark sliver,
 * printed in a few flat inks that overprint each other where they meet (the overlaps darken like
 * transparent inks), with thin keylines and speckled print grain over everything.
 *
 * Every layout comes from a small grammar, so it never repeats exactly but always looks composed:
 * one dominant diagonal that every band follows, a spine of two to four overlapping circles along the
 * frame's long side (so 9:16 and 16:9 both fill), a hero disc in the hot or dark ink near a thirds
 * point with the sliver pointing at it, a pale band through the hero, a wide band that splits the
 * paper into two tones. Eight candidates are drawn and scored (visual weight balanced just below the
 * centre, about two thirds of the paper inked, the hero on a third, nothing lost off the edge) and the
 * best is used.
 *
 * Shapes move like a motion designer would move them: each is tweened with a small anticipation and
 * an overshoot, along a slight arc, staggered outward from the hero; new shapes pop in from nothing
 * and old ones duck out. The music decides when and how much:
 *   a new part of the song recomposes the poster (a returning chorus gets its poster back), and every
 *     eight bars it recomposes again; every four bars a few shapes rearrange
 *   chord changes make small moves: a disc slides along the spine, a half disc turns or flips, two
 *     discs trade inks, a band shifts (at most every couple of beats, smaller when it is quiet)
 *   harmonic tension (and a build) pushes the whole poster off balance: it leans round the hero, the
 *     discs pull apart along the diagonal and the cuts turn; when the harmony resolves it snaps back
 *     into place with a small click of overshoot
 *   kicks pulse one disc (a quick swell that rings once), snares nudge the sliver along its axis
 *   in the beat before a known drop the poster draws in; the drop recomposes it boldly, bigger, faster,
 *     with a stronger overshoot
 *   quiet parts hold almost still, with a slow drift
 *
 * Palette roles: bg = paper · fg = the dark ink (navy), keylines and grain · accent = the main ink
 * (teal) · accent2 = the hot ink (pink) · muted = the pale ink (mint) and the second paper tone. Pale
 * pink and pale teal are let down from accent2 and accent with the paper. On a dark palette the inks
 * overprint by lightening instead of darkening, like a screen print on black stock.
 */

const SLOTS = 10;
const GROUND = 0;
const DISC0 = 1; // discs live in slots 1..6 (a split disc takes two)
const DISCS = 6;
const PALE = 7;
const THIN = 8;
const SLIVER = 9;

const INK = { fg: 0, accent: 1, accent2: 2, muted: 3, paleHot: 4, paleMain: 5, paper2: 6 } as const;

const params: ParamDef[] = [
  { id: 'scale', label: 'Scale', group: 'Shape', type: 'number', min: 0.6, max: 1.5, step: 0.01, default: 1, hint: 'How big the circles are against the frame' },
  { id: 'overprint', label: 'Overprint', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.75, hint: '0: inks lie on top of each other; 1: overlaps darken like transparent inks' },
  { id: 'keylines', label: 'Keylines', group: 'Shape', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Thin outlines round the shapes and a few construction lines' },
  { id: 'busy', label: 'Moves', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How often chords and phrases move the shapes' },
  { id: 'snap', label: 'Snap', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Anticipation and overshoot in every move' },
  { id: 'lean', label: 'Tension lean', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How far harmonic tension and builds push the poster off balance' },
  { id: 'pulse', label: 'Kick pulse', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
  { id: 'gradient', label: 'Ink gradient', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, hint: 'A soft light-to-dark sweep inside each shape' },
  { id: 'grain', label: 'Print grain', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Speckle and paper tooth' },
];

const fragment = /* glsl */ `
${HM_LIB}
#define OP_N ${SLOTS}
uniform vec4 uA[OP_N];   // xy centre (units: half the short side), z radius / half width, w angle (cut normal / band axis)
uniform vec4 uB[OP_N];   // x kind (0 disc segment, 1 band), y cut offset in radii / band taper, z opacity, w keyline
uniform vec4 uC[OP_N];   // rgb ink, w how much this ink overprints the inks under it (0 = lies flat)
uniform vec4 uLn[3];     // construction lines: xy point, z angle, w strength
uniform vec2 uLight;     // direction the ink gradients brighten toward

void main() {
  vec2 fc = gl_FragCoord.xy;
  float unitPx = 0.5 * min(uResolution.x, uResolution.y);
  float px = 1.0 / unitPx;
  float k1080 = unitPx / 540.0;
  vec2 p = (fc - 0.5 * uResolution) * px;
  bool lightBg = hmIsLight() > 0.5;
  vec3 paper = uBg;
  vec3 paperHi = lightBg ? mix(uBg, vec3(1.0), 0.35) : mix(uBg, uFg, 0.08);

  // ink mottling: solid inks are never perfectly flat on paper
  float mott = tfbm(fc / (k1080 * 140.0), 3);
  vec3 col = paper * (1.0 + 0.025 * mott);

  float key = 0.0;
  float inked = 0.0;   // how much ink is already down here (overprinting only darkens over ink, not paper)
  float lw = max(0.9, 1.15 * k1080);
  for (int i = 0; i < OP_N; i++) {
    vec4 A = uA[i];
    vec4 B = uB[i];
    if (B.z < 0.003 || A.z < 1e-4) continue;
    vec2 q = p - A.xy;
    float d;
    float edge;     // distance to the outline that gets a keyline
    float edge2;    // a secondary outline (the cut of a segment), drawn fainter
    if (B.x < 0.5) {
      float dc = length(q) - A.z;
      vec2 n = vec2(cos(A.w), sin(A.w));
      float dh = B.y * A.z - dot(q, n);
      d = max(dc, dh);
      edge = dh < 0.0 ? abs(dc) : 1e3;
      edge2 = dc < 0.0 ? abs(dh) : 1e3;
    } else {
      vec2 ax = vec2(cos(A.w), sin(A.w));
      float sa = dot(q, ax);
      float t = dot(q, vec2(-ax.y, ax.x));
      float hw = A.z * (1.0 + B.y * sa);
      d = hw > 0.0 ? abs(t) - hw : 1e3;
      edge = hw > 0.0 ? abs(abs(t) - hw) : 1e3;
      edge2 = 1e3;
    }
    float cov = clamp(0.5 - d / px, 0.0, 1.0) * B.z;
    // keylines are drawn even where the shape is faint, so a shape can arrive as a line first
    float kl = clamp(0.5 * lw - edge / px + 0.5, 0.0, 1.0);
    float kl2 = clamp(0.5 * lw - edge2 / px + 0.5, 0.0, 1.0) * 0.45;
    key = max(key, max(kl, kl2) * B.w * min(1.0, B.z * 1.6));
    if (cov <= 0.0) continue;
    // soft light-to-dark sweep across the shape
    float sweep = clamp(dot(q, uLight) / max(A.z, 0.25) * 0.5 + 0.5, 0.0, 1.0);
    vec3 ink = mix(uC[i].rgb * (1.0 - 0.12 * u_gradient), mix(uC[i].rgb, paperHi, 0.4), sweep * u_gradient);
    ink *= 1.0 + 0.03 * mott;
    vec3 over = lightBg ? col * ink * 1.08 : 1.0 - (1.0 - col) * (1.0 - ink);
    vec3 laid = mix(ink, over, u_overprint * uC[i].w * inked);
    col = mix(col, laid, cov);
    if (i > 0) inked = max(inked, cov);
  }

  // construction lines: hairlines running edge to edge along the diagonal
  for (int j = 0; j < 3; j++) {
    vec4 L = uLn[j];
    if (L.w < 0.003) continue;
    vec2 n = vec2(-sin(L.z), cos(L.z));
    float e = abs(dot(p - L.xy, n));
    key = max(key, clamp(0.5 * lw - e / px + 0.5, 0.0, 1.0) * L.w * 0.7);
  }
  vec3 keyInk = lightBg ? mix(col, uFg, 0.55) : mix(col, uFg, 0.4);
  col = mix(col, keyInk, clamp(key * u_keylines, 0.0, 1.0));

  // print grain: dark speckle, a sprinkle of paper-white flecks, and the paper's tooth
  float gs = max(1.0, 2.1 * k1080);
  vec2 g = fc / gs;
  vec2 gi = floor(g);
  vec2 gf = fract(g) - 0.5 - (hash22(gi + 3.7) - 0.5) * 0.5;
  float hsp = hash21(gi + 11.3);
  float lumC = luma(col);
  float dark = step(1.0 - 0.085 * u_grain * (0.5 + 0.7 * lumC), hsp) * smoothstep(0.42, 0.18, length(gf));
  float lite = step(hsp, 0.012 * u_grain) * smoothstep(0.4, 0.15, length(gf));
  vec3 speckInk = lightBg ? uFg : mix(uFg, uBg, 0.2);
  col = mix(col, col * 0.45 + speckInk * 0.15, dark * 0.8);
  col = mix(col, paperHi, lite * 0.6);
  float tooth = tnoise(fc / (k1080 * 1.6)) - 0.5;
  col *= 1.0 + 0.05 * u_grain * tooth;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── layout grammar ───────────────────────── */

interface SlotV {
  x: number;
  y: number;
  s: number;
  a: number;
  k: number;
  op: number;
  line: number;
  ink: number;
  /** 1: lies flat (opaque) · 0: overprints whatever ink is under it */
  flat: number;
}
interface Layout {
  slots: SlotV[];
  hero: number;
  theta: number;
  spine: number;
  lines: { x: number; y: number; a: number; w: number }[];
}

const TAU = Math.PI * 2;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const wrapPi = (a: number) => a - TAU * Math.round(a / TAU);
/** for shapes that look the same turned half a turn (bands, lines, the ground's edge) */
const wrapHalf = (a: number) => a - Math.PI * Math.round(a / Math.PI);
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
type Rng = () => number;
const pick = <T,>(r: Rng, xs: readonly T[]) => xs[Math.floor(r() * xs.length) % xs.length];
const range = (r: Rng, a: number, b: number) => a + (b - a) * r();
const empty = (): SlotV => ({ x: 0, y: 0, s: 0, a: 0, k: -1, op: 0, line: 0, ink: INK.accent, flat: 0 });

/** how heavy an ink reads on the page (for balance) */
const INK_WEIGHT = [1, 0.7, 0.75, 0.35, 0.3, 0.3, 0.12];

function inside(sl: SlotV, kind: number, x: number, y: number) {
  const qx = x - sl.x;
  const qy = y - sl.y;
  if (kind === 0) {
    if (qx * qx + qy * qy > sl.s * sl.s) return false;
    return qx * Math.cos(sl.a) + qy * Math.sin(sl.a) >= sl.k * sl.s;
  }
  const ca = Math.cos(sl.a);
  const sa = Math.sin(sl.a);
  const al = qx * ca + qy * sa;
  const t = -qx * sa + qy * ca;
  const hw = sl.s * (1 + sl.k * al);
  return hw > 0 && Math.abs(t) < hw;
}
// the ground is a half-plane (a huge disc cut through its centre), so it pivots about a point in the frame
const kindOf = (i: number) => (i === GROUND || (i >= DISC0 && i < DISC0 + DISCS) ? 0 : 1);

function draft(r: Rng, ex: number, ey: number, scale: number, bold: boolean): Layout {
  const slots: SlotV[] = Array.from({ length: SLOTS }, empty);
  const portrait = ey > ex * 1.05;
  const landscape = ex > ey * 1.05;
  // one dominant diagonal: every band follows it
  const sgn = r() < 0.5 ? 1 : -1;
  const theta = sgn * (pick(r, [32, 36, 40, 45, 50, 55]) * Math.PI) / 180;
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);
  const nx = -dy;
  const ny = dx;
  // the spine: along the frame's long side, leaning a little
  const spine = (portrait ? Math.PI / 2 : landscape ? 0 : pick(r, [Math.PI / 2, 0, Math.PI / 4 * sgn])) + range(r, -0.22, 0.22);
  const ux = Math.cos(spine);
  const uy = Math.sin(spine);
  const short = Math.min(ex, ey);
  const long = Math.max(ex, ey);
  const nDisc = bold ? pick(r, [3, 3, 4]) : pick(r, [2, 3, 3, 3, 4]);
  const ratios = pick(r, [
    [1, 0.84, 0.7, 0.62],
    [0.86, 1, 0.74, 0.6],
    [1, 0.72, 0.88, 0.58],
    [0.78, 0.92, 1, 0.66],
    [1, 0.9, 0.62, 0.8],
  ]);
  const R = short * range(r, 0.56, 0.7) * scale * (bold ? 1.16 : 1) * (nDisc === 4 ? 0.88 : 1) * (nDisc === 2 ? 1.12 : 1);
  const radii = ratios.slice(0, nDisc).map((k) => k * R);
  // chain them with generous overlaps, then fit the chain to the long side
  const overlap = range(r, 0.6, 0.78);
  const ts: number[] = [0];
  for (let i = 1; i < nDisc; i++) ts.push(ts[i - 1] + (radii[i - 1] + radii[i]) * overlap);
  const span = ts[nDisc - 1] + radii[0] + radii[nDisc - 1];
  const fit = Math.min(1, (long * 2 * 0.98) / span);
  let mean = 0;
  let wsum = 0;
  for (let i = 0; i < nDisc; i++) {
    const w = radii[i] * radii[i];
    mean += ts[i] * w;
    wsum += w;
  }
  mean /= wsum;
  const off = range(r, -0.16, 0.16) * short;
  const along = range(r, -0.1, 0.1) * long;
  const centres = ts.map((t) => {
    const s = (t - mean) * fit + along;
    return { x: ux * s - uy * off, y: uy * s + ux * off };
  });
  for (let i = 0; i < nDisc; i++) radii[i] *= Math.max(0.82, fit);
  // the hero: the most central large disc, in the hot ink (or the dark one)
  let hero = 0;
  let best = -1e9;
  for (let i = 0; i < nDisc; i++) {
    const sc = radii[i] - 0.35 * Math.hypot(centres[i].x, centres[i].y) + 0.15 * r();
    if (sc > best) {
      best = sc;
      hero = i;
    }
  }
  const heroInk = bold || r() < 0.6 ? INK.accent2 : INK.fg;
  const others = heroInk === INK.accent2 ? [INK.accent, INK.fg, INK.accent, INK.muted] : [INK.accent, INK.accent2, INK.accent, INK.muted];
  // discs into slots: whole, split along the diagonal (two inks), or a half
  let slot = DISC0;
  let heroSlot = DISC0;
  let oi = Math.floor(r() * 2);
  for (let i = 0; i < nDisc && slot < DISC0 + DISCS; i++) {
    const c = centres[i];
    const isHero = i === hero;
    const ink = isHero ? heroInk : others[oi++ % others.length];
    const roll = r();
    const cut = theta + (r() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
    if (isHero) heroSlot = slot;
    const flat = isHero ? (r() < 0.7 ? 1 : 0) : r() < 0.4 ? 1 : 0;
    if (roll < 0.36 || slot >= DISC0 + DISCS - 1) {
      slots[slot++] = { x: c.x, y: c.y, s: radii[i], a: cut, k: -1, op: 0.94, line: 0.8, ink, flat };
    } else if (roll < 0.72) {
      // split: the two halves in different inks, cut parallel to the bands
      const k = range(r, -0.25, 0.25);
      const other = ink === INK.fg ? INK.accent : ink === INK.accent ? (r() < 0.5 ? INK.fg : INK.muted) : INK.fg;
      // (the whole disc below and one opaque segment on top, so the cut never shows a seam of paper)
      slots[slot++] = { x: c.x, y: c.y, s: radii[i], a: cut, k: -1, op: 0.94, line: 0.8, ink, flat: 0 };
      slots[slot++] = { x: c.x, y: c.y, s: radii[i], a: cut + Math.PI, k: -k, op: 1, line: 0.8, ink: other, flat: 1 };
    } else {
      // a half disc, its flat side on the diagonal or square to the spine
      const a = r() < 0.6 ? cut : spine + (r() < 0.5 ? 0 : Math.PI);
      slots[slot++] = { x: c.x, y: c.y, s: radii[i], a, k: 0, op: 0.94, line: 0.8, ink, flat };
    }
  }
  const hc = centres[hero];
  const hr = radii[hero];
  // the ground: a wide band that splits the paper into two tones
  const gOff = range(r, 0.15, 0.6) * short * (r() < 0.5 ? 1 : -1);
  slots[GROUND] = { x: nx * gOff, y: ny * gOff, s: 12, a: theta + Math.PI / 2, k: 0, op: 0.85, line: 0.25, ink: INK.paper2, flat: 1 };
  // the pale band, through the hero
  const pOff = range(r, -0.35, 0.35) * hr;
  slots[PALE] = { x: hc.x + nx * pOff, y: hc.y + ny * pOff, s: hr * range(r, 0.32, 0.5), a: theta, k: 0, op: 0.78, line: 0.5, ink: r() < 0.55 ? INK.paleHot : INK.paleMain, flat: 0 };
  // a thin band a disc away
  const tOff = (pOff + (r() < 0.5 ? 1 : -1) * hr * range(r, 0.9, 1.4)) * 1;
  slots[THIN] = { x: hc.x + nx * tOff, y: hc.y + ny * tOff, s: short * range(r, 0.035, 0.07), a: theta, k: 0, op: 0.85, line: 0.6, ink: r() < 0.5 ? INK.accent : INK.paleHot, flat: 0 };
  // the sliver: a dark wedge along the diagonal, its point aimed at the hero
  const dir = r() < 0.5 ? 1 : -1;
  const len = range(r, 1.6, 2.4) * long * 0.6;
  const apexS = -dir * hr * range(r, 0.2, 0.7);
  const sOff = range(r, -0.25, 0.25) * hr;
  // centre a little past the apex so the width there is small; taper so it reaches ~0 at the apex
  const w = short * range(r, 0.07, 0.11);
  slots[SLIVER] = {
    x: hc.x + dx * (apexS + dir * len * 0.5) + nx * sOff,
    y: hc.y + dy * (apexS + dir * len * 0.5) + ny * sOff,
    s: w,
    a: dir > 0 ? theta : theta + Math.PI,
    k: 2 / len,
    op: 0.95,
    line: 0.4,
    ink: heroInk === INK.fg ? INK.accent2 : INK.fg,
    flat: 0.6,
  };
  // construction lines along the diagonal
  const lines = [0, 1, 2].map((j) => {
    const o = (j === 0 ? hr * 1.02 : j === 1 ? -hr * range(r, 0.6, 1.3) : range(r, -1, 1) * short) + pOff;
    return { x: hc.x + nx * o, y: hc.y + ny * o, a: j === 2 && r() < 0.5 ? spine : theta, w: j === 2 ? 0.6 * r() : 0.9 };
  });
  return { slots, hero: heroSlot, theta, spine, lines };
}

/** balance, coverage, the hero on a third, nothing lost off the edge */
function score(L: Layout, ex: number, ey: number) {
  let cov = 0;
  let wx = 0;
  let wy = 0;
  let wt = 0;
  const NX = 18;
  const NY = 18;
  let n = 0;
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const x = ((i + 0.5) / NX * 2 - 1) * ex;
      const y = ((j + 0.5) / NY * 2 - 1) * ey;
      let w = 0;
      let inked = false;
      for (let s = DISC0; s < SLOTS; s++) {
        const sl = L.slots[s];
        if (sl.op < 0.01 || sl.s < 1e-3) continue;
        if (inside(sl, kindOf(s), x, y)) {
          w = Math.max(w, INK_WEIGHT[sl.ink] * sl.op);
          if (s < PALE || s === SLIVER) inked = true;
        }
      }
      if (inked) cov++;
      wx += x * w;
      wy += y * w;
      wt += w;
      n++;
    }
  }
  const cx = wt > 0 ? wx / wt / ex : 0;
  const cy = wt > 0 ? wy / wt / ey : 0;
  const coverage = cov / n;
  const h = L.slots[L.hero];
  const thirds = [
    [-1 / 3, -1 / 3],
    [1 / 3, -1 / 3],
    [-1 / 3, 1 / 3],
    [1 / 3, 1 / 3],
    [0, -1 / 3],
    [0, 1 / 3],
  ];
  let td = 9;
  for (const [tx, ty] of thirds) td = Math.min(td, Math.hypot(h.x / ex - tx, h.y / ey - ty));
  let lost = 0;
  for (let s = DISC0; s < DISC0 + DISCS; s++) {
    const sl = L.slots[s];
    if (sl.op < 0.01) continue;
    const ox = Math.max(0, Math.abs(sl.x) - ex) / sl.s;
    const oy = Math.max(0, Math.abs(sl.y) - ey) / sl.s;
    lost += ox + oy;
  }
  return -2.2 * Math.hypot(cx, cy + 0.06) - 1.6 * Math.abs(coverage - 0.66) - 0.7 * td - 1.5 * lost;
}

function compose(seed: number, ex: number, ey: number, scale: number, bold: boolean): Layout {
  const r = mulberry32(seed);
  let best: Layout | null = null;
  let bestS = -1e9;
  for (let c = 0; c < 8; c++) {
    const L = draft(r, ex, ey, scale, bold);
    const s = score(L, ex, ey);
    if (s > bestS) {
      bestS = s;
      best = L;
    }
  }
  return best!;
}

/* ───────────────────────── motion ───────────────────────── */

/** ease-in-out with "back": a little anticipation at the start, a separate overshoot at the end */
function backInOut(t: number, s: number) {
  const c = s * 1.525;
  return t < 0.5 ? ((2 * t) ** 2 * ((c + 1) * 2 * t - c)) / 2 : ((2 * t - 2) ** 2 * ((c + 1) * (t * 2 - 2) + c) + 2) / 2;
}
function easeMove(t: number, antic: number, over: number) {
  const w = t * t * (3 - 2 * t);
  return backInOut(t, antic) * (1 - w) + backInOut(t, over) * w;
}
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
function easeOutBack(t: number, s: number) {
  const c = s + 1;
  return 1 + c * (t - 1) ** 3 + s * (t - 1) ** 2;
}

interface Tween {
  from: SlotV;
  to: SlotV;
  t0: number;
  dur: number;
  antic: number;
  over: number;
  arc: number;
  inkFrom: THREE.Color;
}

interface Slot {
  cur: SlotV;
  tw: Tween | null;
  pulse: Spring;
  drift: number;
  inkC: THREE.Color;
}

function inkColor(p: ResolvedPalette, ink: number, out: THREE.Color) {
  const c = p.c;
  switch (ink) {
    case INK.fg:
      return out.copy(c.fg);
    case INK.accent:
      return out.copy(c.accent);
    case INK.accent2:
      return out.copy(c.accent2);
    case INK.muted:
      return out.copy(c.muted);
    case INK.paleHot:
      return out.copy(c.accent2).lerp(c.bg, 0.55);
    case INK.paleMain:
      return out.copy(c.accent).lerp(c.bg, 0.5);
    default:
      return out.copy(c.muted).lerp(c.bg, 0.55);
  }
}

function create(init: SceneInit): SceneInstance {
  const A = new Float32Array(SLOTS * 4);
  const B = new Float32Array(SLOTS * 4);
  const C = new Float32Array(SLOTS * 4);
  const Ln = new Float32Array(12);
  const uniforms = {
    ...createBaseUniforms(init.shared, params),
    uA: { value: A },
    uB: { value: B },
    uC: { value: C },
    uLn: { value: Ln },
    uLight: { value: new THREE.Vector2(0.6, 0.8) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: buildSceneFragment(fragment, params),
    depthTest: false,
    depthWrite: false,
  });
  const quad = createFullscreenQuad(material);

  const slots: Slot[] = Array.from({ length: SLOTS }, (_, i) => ({
    cur: empty(),
    tw: null,
    pulse: new Spring(320, 13),
    drift: i * 1.731,
    inkC: new THREE.Color(),
  }));
  const tmpC = new THREE.Color();
  // a split disc is two slots (the whole disc and a segment over it) that must move as one body
  const link = new Int8Array(SLOTS).fill(-1);
  const pv = new Float32Array(SLOTS);
  const relink = () => {
    link.fill(-1);
    if (!layout) return;
    for (let i = DISC0 + 1; i < DISC0 + DISCS; i++) {
      const a = layout.slots[i];
      const b = layout.slots[i - 1];
      if (a.op > 0.01 && b.op > 0.01 && Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4 && Math.abs(a.s - b.s) < 1e-4) link[i] = link[i - 1] >= 0 ? link[i - 1] : i - 1;
    }
  };
  /** partners share their base's timing and arc */
  const syncLinked = () => {
    for (let i = 0; i < SLOTS; i++) {
      const j = link[i];
      const ti = slots[i].tw;
      const tj = j >= 0 ? slots[j].tw : null;
      if (ti && tj) {
        ti.t0 = tj.t0;
        ti.dur = tj.dur;
        ti.arc = tj.arc;
        ti.antic = tj.antic;
        ti.over = tj.over;
      }
    }
  };
  const lines = [0, 1, 2].map(() => ({ x: 0, y: 0, a: 0, w: 0, tx: 0, ty: 0, ta: 0, tw: 0 }));
  let layout: Layout | null = null;
  let clock = 0;
  let ex = 1;
  let ey = 1;
  let lastSection = -2;
  let lastPhrase = -1;
  let lastBeat = -1;
  let prevT = -1;
  let lastMove = -100;
  let moveN = 0;
  let prevDrop = 0;
  let drops = 0;
  let sinceDrop = 100;
  let pulseTurn = 0;
  const lean = new Spring(38, 6.5, 0);
  const sliverNudge = new Spring(90, 9, 0);
  const inhale = new Spring(70, 11, 1);
  let rng = mulberry32(7);

  const beatSec = (f: FrameContext) => 60 / (f.audio.bpm > 30 ? f.audio.bpm : 120);

  /** move every slot to a new layout, staggered outward from the hero */
  const recompose = (L: Layout, f: FrameContext, kind: 'part' | 'phrase' | 'drop' | 'instant') => {
    const beat = beatSec(f);
    const snap = num(f.params, 'snap', 1);
    const prevHero = layout ? slots[layout.hero].cur : L.slots[L.hero];
    layout = L;
    const dur = kind === 'drop' ? Math.max(0.35, 0.9 * beat) : kind === 'phrase' ? Math.min(1.8, Math.max(0.6, 2 * beat)) : Math.min(1.6, Math.max(0.5, 1.5 * beat));
    const stagger = kind === 'drop' ? 0.06 * beat : kind === 'phrase' ? 0.22 * beat : 0.16 * beat;
    const order = L.slots.map((s, i) => ({ i, d: Math.hypot(s.x - prevHero.x, s.y - prevHero.y) + (i === GROUND ? 9 : 0) }));
    order.sort((a, b) => a.d - b.d);
    order.forEach(({ i }, rank) => {
      const to = { ...L.slots[i] };
      if (kind === 'instant') {
        slots[i].cur = to;
        slots[i].tw = null;
        return;
      }
      tweenTo(i, to, clock + rank * stagger, dur, kind === 'drop' ? 2.6 * snap : 1.3 * snap, kind === 'drop' ? 0.9 * snap : 0.7 * snap);
    });
    relink();
    syncLinked();
    L.lines.forEach((l, j) => {
      const o = lines[j];
      o.tx = l.x;
      o.ty = l.y;
      o.ta = l.a;
      o.tw = l.w;
      if (kind === 'instant') {
        o.x = l.x;
        o.y = l.y;
        o.a = l.a;
        o.w = l.w;
      } else o.w = 0; // lines redraw after a recompose
    });
  };

  const tweenTo = (i: number, to: SlotV, t0: number, dur: number, over: number, antic: number) => {
    const s = slots[i];
    const from = { ...s.cur };
    // a slot that was empty appears where it lands; one that leaves shrinks where it is
    if (from.op < 0.01 || from.s < 1e-3) {
      from.x = to.x;
      from.y = to.y;
      from.a = to.a;
      from.k = to.k;
      from.s = 0;
      from.op = 0;
    }
    if (to.op < 0.01 || to.s < 1e-3) {
      to.x = from.x;
      to.y = from.y;
      to.a = from.a;
      to.k = from.k;
      to.s = 0;
      to.op = 0;
    }
    // bands, lines and the ground's edge turn the short way (they look the same half a turn round)
    to.a = from.a + (i === PALE || i === THIN || i === GROUND ? wrapHalf(to.a - from.a) : wrapPi(to.a - from.a));
    if (layout && (i === PALE || i === THIN || i === GROUND)) layout.slots[i].a = to.a;
    s.tw = { from, to, t0, dur, antic, over, arc: (rng() < 0.5 ? -1 : 1) * 0.12, inkFrom: s.inkC.clone() };
  };

  /** a small move on a chord change */
  const minorMove = (f: FrameContext, amount: number) => {
    if (!layout) return;
    const beat = beatSec(f);
    const snap = num(f.params, 'snap', 1);
    const discs: number[] = [];
    for (let i = DISC0; i < DISC0 + DISCS; i++) if (layout.slots[i].op > 0.01) discs.push(i);
    if (!discs.length) return;
    const kind = pick(rng, ['slide', 'turn', 'swap', 'band', 'slide', 'turn', 'grow']);
    const dur = Math.min(1.2, Math.max(0.4, beat));
    const ux = Math.cos(layout.spine);
    const uy = Math.sin(layout.spine);
    const nx = -Math.sin(layout.theta);
    const ny = Math.cos(layout.theta);
    const go = (i: number, to: SlotV, delay = 0) => {
      layout!.slots[i] = to;
      tweenTo(i, { ...to }, clock + delay, dur, 1.1 * snap, 0.6 * snap);
    };
    // a split disc moves as one: find its partner (same centre)
    const partner = (i: number) => discs.find((j) => j !== i && Math.abs(layout!.slots[j].x - layout!.slots[i].x) < 1e-4 && Math.abs(layout!.slots[j].y - layout!.slots[i].y) < 1e-4);
    const i = pick(rng, discs);
    const sl = layout.slots[i];
    const pj = partner(i);
    if (kind === 'slide') {
      const d = (rng() < 0.5 ? -1 : 1) * sl.s * range(rng, 0.12, 0.28) * amount;
      for (const j of pj !== undefined ? [i, pj] : [i]) go(j, { ...layout.slots[j], x: layout.slots[j].x + ux * d, y: layout.slots[j].y + uy * d });
    } else if (kind === 'turn') {
      const d = (rng() < 0.5 ? -1 : 1) * (sl.k > -0.99 ? pick(rng, [Math.PI / 4, Math.PI / 2, Math.PI]) : Math.PI / 2) * Math.min(1, 0.5 + amount);
      for (const j of pj !== undefined ? [i, pj] : [i]) go(j, { ...layout.slots[j], a: layout.slots[j].a + d });
    } else if (kind === 'swap' && discs.length > 1) {
      const j = pick(rng, discs.filter((x) => x !== i));
      const a = layout.slots[i].ink;
      go(i, { ...layout.slots[i], ink: layout.slots[j].ink });
      go(j, { ...layout.slots[j], ink: a }, 0.08 * beat);
    } else if (kind === 'band') {
      const b = pick(rng, [PALE, THIN, PALE]);
      const d = (rng() < 0.5 ? -1 : 1) * range(rng, 0.08, 0.2) * amount;
      const s0 = layout.slots[b];
      go(b, { ...s0, x: s0.x + nx * d, y: s0.y + ny * d });
    } else {
      const k = 1 + (rng() < 0.5 ? -1 : 1) * 0.1 * amount;
      for (const j of pj !== undefined ? [i, pj] : [i]) go(j, { ...layout.slots[j], s: layout.slots[j].s * k });
    }
    relink();
    syncLinked();
  };

  return {
    render(frame, target) {
      const dt = stepDt(frame);
      clock += dt;
      const P = frame.params;
      const a = frame.audio;
      const feel = frame.feel;
      const W = frame.width;
      const H = frame.height;
      const nex = W / Math.min(W, H);
      const ney = H / Math.min(W, H);
      const scale = num(P, 'scale', 1);
      const busy = num(P, 'busy', 1);
      const beat = beatSec(frame);
      const intensity = feel.intensity;
      const songSeed = Math.floor((frame.analysis?.duration ?? 0) * 1000) ^ 0x5bd1;

      // a jump in song time (seek, loop) moves nothing by itself
      const t = a.time;
      const jumped = prevT < 0 || Math.abs(t - prevT) > 1.5;

      // drops
      const dropEdge = a.drop > 0.6 && prevDrop <= 0.6;
      prevDrop = a.drop;
      if (dropEdge && sinceDrop > 2) {
        sinceDrop = 0;
        drops++;
      } else sinceDrop = Math.min(100, sinceDrop + dt);

      const aspectChanged = Math.abs(nex - ex) > 0.02 || Math.abs(ney - ey) > 0.02;
      ex = nex;
      ey = ney;
      const sec = feel.sectionIndex;
      const group = sec >= 0 ? (frame.analysis?.sections[sec]?.group ?? sec) : -1;
      const phraseBeats = 32;
      const phrase = Math.floor(a.beatCount / phraseBeats);
      const half = Math.floor(a.beatCount / (phraseBeats / 2));

      if (!layout || aspectChanged) {
        rng = mulberry32(songSeed + 101 * (group + 3) + 7 * phrase);
        recompose(compose(songSeed + 977 * (group + 3), ex, ey, scale, false), frame, 'instant');
        lastSection = sec;
        lastPhrase = phrase;
        lastBeat = a.beatCount;
      } else if (sinceDrop === 0) {
        // the drop: bold, bigger, faster
        rng = mulberry32(songSeed + 31 * drops + 5);
        recompose(compose(songSeed + 7919 * drops + 3, ex, ey, scale, true), frame, 'drop');
        lastSection = sec;
        lastPhrase = phrase;
        lastMove = clock;
      } else if (sec !== lastSection && !jumped) {
        // a new part: its own poster (a returning chorus gets its poster back)
        const isDrop = feel.section === 'drop' && sinceDrop > 4;
        recompose(compose(songSeed + 977 * (group + 3), ex, ey, scale, isDrop), frame, isDrop ? 'drop' : 'part');
        lastSection = sec;
        lastPhrase = phrase;
        lastMove = clock;
      } else if (phrase !== lastPhrase && !jumped && a.playing) {
        // every eight bars: recompose; the poster for this phrase is fixed by where it is in the part
        const inPart = sec >= 0 ? Math.max(0, phrase - Math.floor((frame.analysis?.sections[sec]?.start ?? 0) / beat / phraseBeats)) : phrase;
        if (busy > 0.05) recompose(compose(songSeed + 977 * (group + 3) + 131 * inPart, ex, ey, scale, feel.section === 'drop'), frame, 'phrase');
        lastPhrase = phrase;
        lastMove = clock;
      } else if (jumped) {
        lastSection = sec;
        lastPhrase = phrase;
      }

      // chord changes (and resolutions) from the harmony; without it, a pseudo-change every two bars
      const H2 = frame.analysis?.harmony;
      let chord = false;
      let resolved = 0;
      if (!jumped && prevT >= 0 && t > prevT) {
        if (H2 && H2.changes.length) {
          for (const c of H2.changes) if (prevT < c && t >= c) chord = true;
          for (const rs of H2.resolutions) if (prevT < rs.t && t >= rs.t) resolved = Math.max(resolved, rs.strength);
        } else if (a.beat && a.beatCount % 8 === 0 && a.beatCount !== lastBeat) chord = true;
      }
      if (a.beat && a.beatCount % 16 === 8 && half !== Math.floor(lastBeat / 16) && busy > 0.05 && clock - lastMove > 2 * beat) {
        // half way through a phrase: a few shapes rearrange
        for (let k = 0; k < 2 + Math.round(intensity * 2); k++) minorMove(frame, 0.8 + 0.4 * intensity);
        lastMove = clock;
      }
      if (a.beat) lastBeat = a.beatCount;
      const gap = (intensity < 0.35 ? 4 : 2) * beat / Math.max(0.2, busy);
      if (chord && busy > 0.05 && clock - lastMove > gap && sinceDrop > 1) {
        minorMove(frame, 0.4 + 0.8 * intensity);
        moveN++;
        lastMove = clock;
      }

      // tension: the poster leans off balance; a resolution snaps it home
      const harm = H2 ? feel.harmony : 0;
      const leanTarget = num(P, 'lean', 1) * clamp01(Math.max(feel.tension, a.build) * 0.9 + 0.55 * harm);
      if (resolved > 0) lean.vel -= (3 + 6 * resolved) * Math.max(0.15, lean.value);
      const leanV = lean.step(leanTarget, dt);
      // the beat before a known drop: draw in
      const inhaleT = feel.toDrop < beat * 1.05 && feel.toDrop > 0 ? 0.88 : 1;
      if (sinceDrop === 0) inhale.vel += 1.5;
      const inh = inhale.step(inhaleT, dt);
      // kicks pulse one disc (the hero, or the next one round on loud parts); snares nudge the sliver
      if (a.kickHit && layout) {
        const discs: number[] = [];
        for (let i = DISC0; i < DISC0 + DISCS; i++) if (layout.slots[i].op > 0.01) discs.push(i);
        const target = intensity > 0.65 && discs.length ? discs[pulseTurn++ % discs.length] : layout.hero;
        slots[target].pulse.vel += 1.6 * Math.max(0.4, a.kick) * num(P, 'pulse', 1) * (0.5 + 0.7 * intensity);
      }
      if (a.snareHit) sliverNudge.vel += (moveN % 2 ? 1 : -1) * 0.9 * (0.4 + 0.6 * intensity);
      const nudge = sliverNudge.step(0, dt);

      // advance tweens, then add the live layers (lean, pulse, drift)
      const hero = layout ? slots[layout.hero].cur : slots[DISC0].cur;
      const hx = hero.x;
      const hy = hero.y;
      const leanAng = 0.11 * leanV * (layout && layout.theta > 0 ? -1 : 1);
      const cl = Math.cos(leanAng);
      const sl = Math.sin(leanAng);
      const th = layout?.theta ?? 0.6;
      const bdx = Math.cos(th);
      const bdy = Math.sin(th);
      const driftAmp = 0.012 * (1 - 0.5 * intensity);
      for (let i = 0; i < SLOTS; i++) {
        pv[i] = slots[i].pulse.step(0, dt);
        slots[i].drift += dt;
      }
      for (let i = 0; i < SLOTS; i++) {
        const s = slots[i];
        const tw = s.tw;
        const src = link[i] >= 0 ? link[i] : i;
        if (tw) {
          const u = clamp01((clock - tw.t0) / tw.dur);
          if (u > 0) {
            const e = easeMove(u, tw.antic * 0.08, tw.over);
            const ec = easeInOut(clamp01(u * 1.3));
            const f = tw.from;
            const to = tw.to;
            const es = f.s < 1e-3 ? easeOutBack(u, 1.4 * tw.over) : to.s < 1e-3 ? 1 - easeOutBack(1 - u, 0.8) : e;
            const mx = f.x + (to.x - f.x) * e;
            const my = f.y + (to.y - f.y) * e;
            // a slight arc rather than a straight line
            const arc = Math.sin(Math.PI * clamp01(u)) * tw.arc;
            s.cur.x = mx - (to.y - f.y) * arc;
            s.cur.y = my + (to.x - f.x) * arc;
            s.cur.s = Math.max(0, f.s + (to.s - f.s) * es);
            s.cur.a = f.a + (to.a - f.a) * e;
            s.cur.k = f.k + (to.k - f.k) * e;
            s.cur.op = f.op + (to.op - f.op) * (f.op < 0.01 ? clamp01(u * 4) : to.op < 0.01 ? clamp01((u - 0.6) / 0.4) : ec);
            s.cur.line = f.line + (to.line - f.line) * ec;
            s.cur.ink = to.ink;
            s.cur.flat = f.flat + (to.flat - f.flat) * ec;
            inkColor(frame.palette, to.ink, tmpC);
            s.inkC.copy(tw.inkFrom).lerp(tmpC, ec);
            if (u >= 1) {
              s.cur = { ...to };
              s.tw = null;
            }
          } else inkColor(frame.palette, s.cur.ink, s.inkC);
        } else inkColor(frame.palette, s.cur.ink, s.inkC);

        // live layers
        const c = s.cur;
        let x = c.x;
        let y = c.y;
        let ang = c.a;
        let size = c.s;
        if (i !== GROUND) {
          // lean: everything turns round the hero, discs part along the diagonal, cuts turn
          const rx = x - hx;
          const ry = y - hy;
          x = hx + rx * cl - ry * sl;
          y = hy + rx * sl + ry * cl;
          ang += leanAng;
          if (kindOf(i) === 0) {
            const side = (src % 2 ? 1 : -1) * 0.1 * leanV;
            x += bdx * side;
            y += bdy * side;
            if (c.k > -0.99) ang += 0.45 * leanV * (src % 2 ? 1 : -1);
          }
          if (i === SLIVER) {
            x += bdx * nudge * 0.05 * Math.sign(Math.cos(ang - th));
            y += bdy * nudge * 0.05 * Math.sign(Math.cos(ang - th));
          }
          // drift
          const dr = slots[src].drift;
          x += driftAmp * Math.sin(dr * 0.31 + src * 2.1);
          y += driftAmp * Math.cos(dr * 0.23 + src * 1.3);
          if (kindOf(i) === 1) ang += 0.012 * Math.sin(dr * 0.17 + i);
          // the inhale before a drop pulls everything toward the centre and in
          x *= inh;
          y *= inh;
          size *= inh * (1 + 0.12 * Math.max(-0.5, pv[src]));
        }
        A[i * 4] = x;
        A[i * 4 + 1] = y;
        A[i * 4 + 2] = size;
        A[i * 4 + 3] = ang;
        B[i * 4] = kindOf(i);
        B[i * 4 + 1] = c.k;
        B[i * 4 + 2] = c.op;
        B[i * 4 + 3] = c.line;
        C[i * 4] = s.inkC.r;
        C[i * 4 + 1] = s.inkC.g;
        C[i * 4 + 2] = s.inkC.b;
        C[i * 4 + 3] = 1 - c.flat;
      }
      // construction lines draw back in after a recompose
      for (let j = 0; j < 3; j++) {
        const l = lines[j];
        l.x = approach(l.x, l.tx, 3, dt);
        l.y = approach(l.y, l.ty, 3, dt);
        l.a = l.a + wrapHalf(l.ta - l.a) * (1 - Math.exp(-3 * dt));
        l.w = approach(l.w, l.tw, 1.2, dt);
        const rx = l.x - hx;
        const ry = l.y - hy;
        Ln[j * 4] = (hx + rx * cl - ry * sl) * inh;
        Ln[j * 4 + 1] = (hy + rx * sl + ry * cl) * inh;
        Ln[j * 4 + 2] = l.a + leanAng;
        Ln[j * 4 + 3] = l.w;
      }
      prevT = t;

      updateBaseUniforms(uniforms, frame);
      updateParamUniforms(uniforms, params, P);
      quad.render(frame.renderer, target);
    },
    dispose() {
      material.dispose();
      quad.dispose();
    },
  };
}

export const overprint: SceneDef = {
  id: 'overprint',
  name: 'Overprint',
  description:
    'A mid-century geometric poster that recomposes itself to the song: big circles, half circles and diagonal bands in a few flat inks that overprint where they overlap, with thin keylines and speckled print grain. Shapes slide, turn and trade colours on chord changes and phrases, harmonic tension leans the poster off balance until a resolution snaps it back, kicks pulse a disc, and the drop recomposes the whole poster boldly. Quiet parts hold almost still.',
  category: 'field',
  style: 'print',
  light: true,
  tags: ['graphic', 'editorial', 'groovy', 'confident', 'indie', 'jazz', 'retro', 'tactile', 'playful', 'upbeat', 'minimal', 'warm'],
  params,
  modulations: [],
  create,
};
