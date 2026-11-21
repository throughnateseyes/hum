import * as THREE from 'three';
import type { FrameContext, ParamDef, SceneDef } from '../../core/types';
import { num } from '../../core/uniforms';
import { TONEMAP_LIB } from '../nature/volume';
import { BACKDROP_VERT, makeBackdrop, makeMaterial, stepDt, syncMaterial } from '../three/common';
import { GLASS_LIB } from './lib';

/**
 * Shatter: a leaded window that breaks on the drop and builds itself again as a new window.
 *
 *   - each window is real pieces of glass (a mesh per pattern, one polygon per pane): irregular
 *     cathedral panes, a rose of rings, angled strips or a Mondrian of rectangles, cycling
 *   - every pane carries its own copper-foil rim, so a flying piece still reads as cut glass. Glass is
 *     shaded for real as it turns: light from behind tinted by the thickness it passes through (more
 *     at a slant), Fresnel reflection of the room and a key light that glints off tumbling shards
 *   - behind the window is the light itself, seen only through the cracks and the gaps
 *
 * Music: whole, the window breathes: kicks push a scatter of panes forward and light them, and every
 * new section re-colours it with panes turning over in a wave. A build makes it tremble and the
 * cracks between panes open and glow. The drop bursts it outward from the point of impact into a
 * slow-motion cloud of tumbling shards that kicks keep nudging, and when the part ends the pieces of
 * a new window fly in from behind the viewer and land one by one, each with a flash.
 */

const params: ParamDef[] = [
  { id: 'panes', label: 'Panes', group: 'Shape', type: 'number', min: 30, max: 220, step: 1, default: 110, hint: 'Roughly how many pieces of glass in a window' },
  { id: 'lead', label: 'Foil', group: 'Shape', type: 'number', min: 0.3, max: 2.5, step: 0.01, default: 1, hint: 'Width of the dark rim round each piece' },
  { id: 'force', label: 'Burst', group: 'Reactivity', type: 'number', min: 0.2, max: 2, step: 0.01, default: 1, hint: 'How hard the drop throws the pieces' },
  { id: 'hold', label: 'Float', group: 'Motion', type: 'number', min: 2, max: 20, step: 0.1, default: 9, hint: 'Longest the pieces float before a new window gathers (seconds; a new part gathers it sooner)' },
  { id: 'pop', label: 'Kick pop', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1 },
  { id: 'exposure', label: 'Exposure', group: 'Color', type: 'number', min: 0.4, max: 2, step: 0.01, default: 1 },
];

/* ───────────────────────── patterns (CPU) ───────────────────────── */

interface Poly {
  pts: number[];
  t: number;
}

type Rnd = () => number;
const mulberry = (seed: number): Rnd => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** keep the side of a polygon where nx*x + ny*y <= d (Sutherland–Hodgman, one plane) */
function clip(pts: number[], nx: number, ny: number, d: number): number[] {
  const out: number[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i += 2) {
    const ax = pts[i];
    const ay = pts[i + 1];
    const j = (i + 2) % n;
    const bx = pts[j];
    const by = pts[j + 1];
    const da = nx * ax + ny * ay - d;
    const db = nx * bx + ny * by - d;
    if (da <= 0) out.push(ax, ay);
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return out;
}
const clipRect = (pts: number[], hw: number, hh: number) => clip(clip(clip(clip(pts, 1, 0, hw), -1, 0, hw), 0, 1, hh), 0, -1, hh);
const rect = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1];

/** the window's design: a composition value 0..1 per pane */
function composer(rnd: Rnd, hw: number, hh: number) {
  const mode = Math.floor(rnd() * 3);
  const cx = (rnd() - 0.5) * hw;
  const cy = (rnd() - 0.5) * hh;
  const a = rnd() * Math.PI * 2;
  const R = Math.hypot(hw, hh);
  return (x: number, y: number) => {
    if (mode === 0) return Math.min(1, Math.hypot(x - cx, y - cy) / R);
    if (mode === 1) return Math.min(1, Math.max(0, ((x * Math.cos(a) + y * Math.sin(a)) / R) * 0.9 + 0.5));
    const ang = Math.atan2(y - cy, x - cx) / (Math.PI * 2) + 0.5;
    return Math.min(1, 0.5 * Math.abs(((ang * 3) % 1) - 0.5) * 2 + 0.5 * (Math.hypot(x - cx, y - cy) / R));
  };
}

function voronoi(rnd: Rnd, hw: number, hh: number, n: number): Poly[] {
  const cols = Math.max(2, Math.round(Math.sqrt((n * hw) / hh)));
  const rows = Math.max(2, Math.round(n / cols));
  const sx = (2 * hw) / cols;
  const sy = (2 * hh) / rows;
  const seeds: number[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) seeds.push(-hw + (i + 0.5 + (rnd() - 0.5) * 0.85) * sx, -hh + (j + 0.5 + (rnd() - 0.5) * 0.85) * sy);
  const reach = 3.2 * Math.max(sx, sy);
  const comp = composer(rnd, hw, hh);
  const out: Poly[] = [];
  for (let i = 0; i < seeds.length; i += 2) {
    const px = seeds[i];
    const py = seeds[i + 1];
    let pts = rect(-hw, -hh, hw, hh);
    for (let j = 0; j < seeds.length && pts.length >= 6; j += 2) {
      if (j === i) continue;
      const qx = seeds[j];
      const qy = seeds[j + 1];
      if (Math.abs(qx - px) > reach || Math.abs(qy - py) > reach) continue;
      pts = clip(pts, qx - px, qy - py, (qx * qx + qy * qy - px * px - py * py) / 2);
    }
    if (pts.length >= 6) out.push({ pts, t: comp(px, py) });
  }
  return out;
}

function rose(rnd: Rnd, hw: number, hh: number, n: number): Poly[] {
  const out: Poly[] = [];
  const R = Math.hypot(hw, hh) * 1.02;
  const r0 = Math.min(hw, hh) * 0.12;
  const rings = Math.max(4, Math.round(Math.sqrt(n) * 0.75));
  const g = Math.pow(R / r0, 1 / rings);
  // the oculus
  const oc: number[] = [];
  for (let k = 0; k < 14; k++) oc.push(Math.cos((k / 14) * Math.PI * 2) * r0, Math.sin((k / 14) * Math.PI * 2) * r0);
  out.push({ pts: oc, t: 0.05 });
  const toff = rnd() * 0.3;
  for (let k = 0; k < rings; k++) {
    const ra = r0 * Math.pow(g, k);
    const rb = ra * g;
    const segs = Math.max(6, Math.round((Math.PI * 2 * (ra + rb) * 0.5) / ((rb - ra) * (0.9 + rnd() * 0.8))));
    const off = rnd() * Math.PI * 2;
    const ringT = Math.min(1, k / (rings - 1)) * 0.85 + toff;
    for (let s = 0; s < segs; s++) {
      const a0 = off + (s / segs) * Math.PI * 2;
      const a1 = off + ((s + 1) / segs) * Math.PI * 2;
      const pts: number[] = [];
      for (let m = 0; m <= 2; m++) {
        const a = a0 + ((a1 - a0) * m) / 2;
        pts.push(Math.cos(a) * ra, Math.sin(a) * ra);
      }
      for (let m = 2; m >= 0; m--) {
        const a = a0 + ((a1 - a0) * m) / 2;
        pts.push(Math.cos(a) * rb, Math.sin(a) * rb);
      }
      const c = clipRect(pts, hw, hh);
      if (c.length >= 6) out.push({ pts: c, t: Math.min(1, ringT + (s % 2) * 0.12) });
    }
  }
  return out;
}

function strips(rnd: Rnd, hw: number, hh: number, n: number): Poly[] {
  const out: Poly[] = [];
  const ang = (rnd() - 0.5) * 0.9;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const R = Math.hypot(hw, hh);
  const w = (2 * R) / Math.max(6, Math.round(Math.sqrt(n) * 1.3));
  const comp = composer(rnd, hw, hh);
  for (let u = -R; u < R; ) {
    const sw = w * (0.6 + rnd() * 0.8);
    const slant = (rnd() - 0.5) * 0.9;
    for (let v = -R - rnd() * w * 3; v < R; ) {
      const L = w * (1.5 + rnd() * 4.5);
      // a parallelogram in strip space, cut on the slant
      const q = [u, v, u + sw, v + sw * slant, u + sw, v + L + sw * slant, u, v + L];
      const pts: number[] = [];
      for (let i = 0; i < 8; i += 2) pts.push(q[i] * ca - q[i + 1] * sa, q[i] * sa + q[i + 1] * ca);
      const c = clipRect(pts, hw, hh);
      if (c.length >= 6) {
        const mx = (u + sw / 2) * ca - (v + L / 2) * sa;
        const my = (u + sw / 2) * sa + (v + L / 2) * ca;
        out.push({ pts: c, t: comp(mx, my) * 0.7 + rnd() * 0.25 });
      }
      v += L;
    }
    u += sw;
  }
  return out;
}

function mondrian(rnd: Rnd, hw: number, hh: number, n: number): Poly[] {
  const out: Poly[] = [];
  const comp = composer(rnd, hw, hh);
  const minS = Math.sqrt((4 * hw * hh) / n) * 1.1;
  const split = (x0: number, y0: number, x1: number, y1: number, depth: number) => {
    const w = x1 - x0;
    const h = y1 - y0;
    if (depth > 12 || (Math.max(w, h) < minS * (0.7 + rnd() * 0.8) && depth > 1)) {
      // now and then a rectangle cut on its diagonal
      if (rnd() < 0.12) {
        out.push({ pts: [x0, y0, x1, y0, x1, y1], t: comp(x0 + w * 0.6, y0 + h * 0.4) });
        out.push({ pts: [x0, y0, x1, y1, x0, y1], t: Math.min(1, comp(x0 + w * 0.4, y0 + h * 0.6) + 0.3) });
      } else out.push({ pts: rect(x0, y0, x1, y1), t: comp((x0 + x1) / 2, (y0 + y1) / 2) });
      return;
    }
    const t = 0.25 + rnd() * 0.5;
    if (w > h * (0.6 + rnd() * 0.8)) {
      const s = x0 + w * t;
      split(x0, y0, s, y1, depth + 1);
      split(s, y0, x1, y1, depth + 1);
    } else {
      const s = y0 + h * t;
      split(x0, y0, x1, s, depth + 1);
      split(x0, s, x1, y1, depth + 1);
    }
  };
  split(-hw, -hh, hw, hh, 0);
  return out;
}

const KINDS = [voronoi, rose, strips, mondrian];

/** one window as a mesh: a fan of triangles per pane, everything a pane needs on its vertices */
function buildGeometry(polys: Poly[], rnd: Rnd) {
  let nTri = 0;
  for (const p of polys) nTri += p.pts.length / 2;
  const pos = new Float32Array(nTri * 9);
  const cen = new Float32Array(nTri * 9);
  const dice = new Float32Array(nTri * 12);
  const edge = new Float32Array(nTri * 3);
  let v = 0;
  for (const p of polys) {
    const m = p.pts.length / 2;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < m; i++) {
      cx += p.pts[i * 2];
      cy += p.pts[i * 2 + 1];
    }
    cx /= m;
    cy /= m;
    // inradius: nearest edge to the centre
    let inr = 1e9;
    for (let i = 0; i < m; i++) {
      const ax = p.pts[i * 2] - cx;
      const ay = p.pts[i * 2 + 1] - cy;
      const bx = p.pts[((i + 1) % m) * 2] - cx;
      const by = p.pts[((i + 1) % m) * 2 + 1] - cy;
      const ex = bx - ax;
      const ey = by - ay;
      const L = Math.hypot(ex, ey);
      if (L > 1e-6) inr = Math.min(inr, Math.abs(ax * ey - ay * ex) / L);
    }
    inr = Math.max(inr, 1e-3);
    const d = [p.t, rnd(), rnd(), rnd()];
    for (let i = 0; i < m; i++) {
      const tri = [cx, cy, 1, p.pts[i * 2], p.pts[i * 2 + 1], 0, p.pts[((i + 1) % m) * 2], p.pts[((i + 1) % m) * 2 + 1], 0];
      for (let k = 0; k < 3; k++) {
        pos[v * 3] = tri[k * 3] - cx;
        pos[v * 3 + 1] = tri[k * 3 + 1] - cy;
        pos[v * 3 + 2] = 0;
        cen[v * 3] = cx;
        cen[v * 3 + 1] = cy;
        cen[v * 3 + 2] = inr;
        dice.set(d, v * 4);
        edge[v] = tri[k * 3 + 2];
        v++;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aCenter', new THREE.BufferAttribute(cen, 3));
  g.setAttribute('aDice', new THREE.BufferAttribute(dice, 4));
  g.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
  return g;
}

/* ───────────────────────── shaders ───────────────────────── */

const SHARD_VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec4 aDice;
attribute float aEdge;
uniform float uMode, uT, uGap, uKickE, uKc, uFlip, uCamZ, uForce, uSpread;
uniform vec2 uImpact, uFlipO;
varying vec3 vN, vW;
varying vec2 vLocal;
varying float vEdge, vInr, vFlash, vSide;
varying vec4 vDice;

mat3 rotAxis(vec3 a, float ang) {
  float c = cos(ang), s = sin(ang), t = 1.0 - c;
  return mat3(t * a.x * a.x + c, t * a.x * a.y + s * a.z, t * a.x * a.z - s * a.y,
              t * a.x * a.y - s * a.z, t * a.y * a.y + c, t * a.y * a.z + s * a.x,
              t * a.x * a.z + s * a.y, t * a.y * a.z - s * a.x, t * a.z * a.z + c);
}

void main() {
  vec2 c = aCenter.xy;
  vec4 h = aDice;
  vec3 local = position * (1.0 - uGap);
  vec3 pos = vec3(c, 0.0);
  mat3 R = mat3(1.0);
  float flash = 0.0;
  float side = 0.0;
  vec3 axis = normalize(vec3(h.y - 0.5, h.z - 0.5, (h.w - 0.5) * 0.6) + 0.001);
  if (uMode > 1.5) {
    // gathering: pieces fly in from behind the viewer and land one by one
    float delay = length(c) * 0.35 + h.y * 0.9;
    float k = clamp((uT - delay) / 1.2, 0.0, 1.0);
    float e = 1.0 - pow(1.0 - k, 3.0);
    vec3 start = vec3(c * (1.4 + h.z) + (h.yw - 0.5) * 2.5, uCamZ + 0.5 + h.w * 2.0);
    pos = mix(start, pos, e);
    R = rotAxis(axis, (1.0 - e) * (5.0 + 7.0 * h.w));
    float landed = uT - delay - 1.2;
    flash = landed > 0.0 ? exp(-landed * 4.0) : 0.0;
  } else if (uMode > 0.5) {
    // burst: thrown out from the impact, slowing into a floating cloud
    vec2 d = c - uImpact;
    float dist = length(d);
    float tt = max(uT - dist * 0.1, 0.0);
    vec2 dir = d / max(dist, 1e-3);
    // (a narrow frame throws them less far sideways, so a phone still sees the cloud)
    vec3 vel = vec3(dir * uSpread * (0.35 + 0.7 * h.y) / (0.5 + dist * 0.45), 0.3 + 1.6 * h.z * h.z) * uForce;
    float s = (1.0 - exp(-tt * 1.3)) / 1.3;
    pos += vel * s * 1.5 + vec3(h.y - 0.5, h.w - 0.5, 0.1) * tt * 0.06;
    pos += vec3(dir, 0.3) * uKickE * 0.08 * (0.5 + h.y);
    R = rotAxis(axis, (5.0 + 8.0 * h.w) * s * uForce + tt * (0.25 + 0.6 * h.y) + uKickE * 0.15);
    flash = uT > dist * 0.1 ? 0.55 * exp(-tt * 3.5) : 0.0;
  } else {
    // whole: re-colour flips in a wave, kicks pop panes forward
    float fd = length(c - uFlipO);
    float fp = clamp((uFlip * 5.0 - fd) / 0.6, 0.0, 1.0);
    // a full turn: the back shows half way, the pane comes round in its new colour
    R = rotAxis(vec3(0.0, 1.0, 0.0), fp * TAU);
    side = step(0.5, fp);
    float pop = step(fract(h.z * 13.7 + uKc * 0.618), 0.1) * uKickE;
    pos.z += pop * 0.08;
    flash = pop * 0.5 + (fp > 0.0 && fp < 1.0 ? 0.4 : 0.0);
    pos.xy += (vec2(hash11(h.y * 91.0 + floor(uTime * 30.0)), hash11(h.z * 37.0 + floor(uTime * 30.0))) - 0.5) * uGap * 0.04;
  }
  vec3 wp = pos + R * local;
  vN = R * vec3(0.0, 0.0, 1.0);
  vW = wp;
  vLocal = position.xy;
  vEdge = aEdge;
  vInr = aCenter.z;
  vFlash = flash;
  vSide = side;
  vDice = h;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const SHARD_FRAG = /* glsl */ `
${GLASS_LIB}
${TONEMAP_LIB}
uniform vec3 uCamPos, uKey;
uniform vec2 uSun;
uniform float uGlow, uLeadW, uExposure, uSeedC, uSeedN;
varying vec3 vN, vW;
varying vec2 vLocal;
varying float vEdge, vInr, vFlash, vSide;
varying vec4 vDice;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vW);
  if (dot(N, V) < 0.0) N = -N;
  float cosv = max(dot(N, V), 0.0);
  vec4 h = vDice;
  float seed = vSide > 0.5 ? uSeedN : uSeedC;
  float t = fract(h.x + seed * 0.137) ;
  t = seed < 1.5 ? h.x : t;
  vec3 hh = fract(h.yzw + seed * vec3(0.31, 0.53, 0.71));
  vec3 ink = gPaneInk(t, hh.x, hh.y, hh.z, 0.35);
  if (fract(hh.x * 31.7) < 0.1) ink = mix(vec3(0.92), uFg, 0.35);
  vec3 tint = gLin(ink);
  float kind = floor(hh.z * 5.0);
  vec3 S = gSurface(vLocal * 1.4 + hh.x * 10.0, kind, hh.x);
  // the light behind, seen through the turned glass
  vec3 tr = refract(-V, N, 0.67);
  vec2 behind = vW.xy + tr.xy * 1.2 + S.xy * 4.0;
  vec3 B = gLin(uFg) * uGlow * (0.4 + 1.3 * exp(-length(behind - uSun) * 0.9));
  // the world outside, soft through the glass: dark boughs, bright sky between
  B *= 1.0 - 0.55 * smoothstep(-0.1, 0.45, tfbm(behind * 0.55 + 3.0, 4) - behind.y * 0.12);
  float F = 0.04 + 0.96 * pow(1.0 - cosv, 5.0);
  float thick = (0.8 + 0.5 * hh.y + 0.3 * S.z) * (0.7 + 0.6 * tnoise(vLocal * 2.0 + hh.y * 30.0));
  vec3 col = B * pow(tint, vec3(thick / max(cosv, 0.3))) * (1.0 - F);
  vec3 Rr = reflect(-V, N);
  float spec = pow(max(dot(Rr, uKey), 0.0), 50.0);
  col += gLin(uFg) * (spec * 2.5 + F * 0.12);
  // copper foil rim
  float e = vEdge * vInr;
  float aa = fwidth(e) * 1.2;
  float lead = 1.0 - smoothstep(uLeadW - aa, uLeadW + aa, e);
  vec3 leadCol = gLin(uBg) * 0.06 + vec3(0.006) + gLin(uFg) * spec * 0.6;
  leadCol += col * 0.2 * smoothstep(uLeadW * 0.5, uLeadW, e);
  col = mix(col, leadCol, lead);
  col += gLin(uFg) * vFlash * 1.6 * (1.0 - lead * 0.6);
  gl_FragColor = vec4(clamp(ntToDisplay(col, uExposure), 0.0, 1.0), 1.0);
}
`;

const BACK_FRAG = /* glsl */ `
${TONEMAP_LIB}
uniform float uBack, uExposure;
uniform vec2 uSunUv;
void main() {
  vec2 p = (vUv - uSunUv) * vec2(uAspect, 1.0);
  float d = length(p);
  float a = atan(p.y, p.x);
  float rays = 0.6 + 0.4 * tnoise(vec2(a * 6.0, uTime * 0.2));
  vec3 lf = uFg * uFg;
  vec3 col = lf * (exp(-d * 2.2) * 2.2 * rays + exp(-d * 9.0) * 6.0) * uBack;
  // a dim room the floating shards glow in: dust in the light, a cool haze
  col += (uAccent * uAccent) * 0.05 * (0.6 + 0.4 * tnoise(vUv * 3.0 + uTime * 0.05));
  col += lf * 0.05 * smoothstep(0.7, 1.0, tnoise(vUv * vec2(uAspect, 1.0) * 40.0 + uTime * 0.3)) * exp(-d * 1.5);
  col += uBg * uBg * 0.25;
  gl_FragColor = vec4(clamp(ntToDisplay(col, uExposure), 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── scene ───────────────────────── */

const FOV = 38;
const CAM_Z = 6;

export const glassShatter: SceneDef = {
  id: 'glass-shatter',
  name: 'Shatter',
  description:
    'A leaded window of real glass pieces that breaks on the drop: it trembles through the build with light glowing in the opening cracks, bursts outward into a slow-motion cloud of tumbling, glinting shards on the drop, and when the part ends the pieces of a new window (cathedral panes, a rose, strips or a Mondrian) fly in from behind the viewer and land one by one. Whole, kicks pop panes forward and each new section re-colours it in a wave of turning panes.',
  category: 'form',
  style: 'light',
  tags: ['epic', 'cinematic', 'intense', 'euphoric', 'dramatic', 'edm', 'dubstep', 'rock', 'anthemic', 'colourful', 'dynamic', 'energetic', 'explosive'],
  params,
  modulations: [],
  handInks: 4,
  create(init) {
    const { shared } = init;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, init.width / init.height, 0.05, 60);
    camera.position.set(0, 0, CAM_Z);

    const backMat = makeMaterial({ params, shared, vertex: BACKDROP_VERT, fragment: BACK_FRAG, extra: { uBack: { value: 0.3 }, uExposure: { value: 1 }, uSunUv: { value: new THREE.Vector2(0.5, 0.55) } } });
    scene.add(makeBackdrop(backMat));

    const sun = new THREE.Vector2(0, 0.3);
    const key = new THREE.Vector3(0.4, 0.6, 0.7).normalize();
    const mkShardMat = () =>
      makeMaterial({
        params,
        shared,
        vertex: SHARD_VERT,
        fragment: SHARD_FRAG,
        side: THREE.DoubleSide,
        extra: {
          uMode: { value: 0 },
          uT: { value: 0 },
          uGap: { value: 0 },
          uKickE: { value: 0 },
          uKc: { value: 0 },
          uFlip: { value: 1 },
          uFlipO: { value: new THREE.Vector2() },
          uImpact: { value: new THREE.Vector2() },
          uCamZ: { value: CAM_Z },
          uForce: { value: 1 },
          uSpread: { value: 1 },
          uCamPos: { value: camera.position },
          uKey: { value: key },
          uSun: { value: sun },
          uGlow: { value: 1 },
          uLeadW: { value: 0.012 },
          uExposure: { value: 1 },
          uSeedC: { value: 1 },
          uSeedN: { value: 1 },
        },
      });

    interface Win {
      mesh: THREE.Mesh;
      mat: THREE.ShaderMaterial;
      seed: number;
    }
    let kindIdx = 0;
    let winSeed = 1;
    let built = { hw: 0, hh: 0, n: 0 };
    const extents = (aspect: number) => {
      const hh = Math.tan(((FOV / 2) * Math.PI) / 180) * CAM_Z * 1.03;
      return { hw: hh * aspect, hh };
    };
    const makeWin = (aspect: number, n: number): Win => {
      const { hw, hh } = extents(aspect);
      const rnd = mulberry(winSeed * 7919 + kindIdx * 104729);
      const polys = KINDS[kindIdx % KINDS.length](rnd, hw, hh, n);
      const mat = mkShardMat();
      const mesh = new THREE.Mesh(buildGeometry(polys, rnd), mat);
      mesh.frustumCulled = false;
      scene.add(mesh);
      built = { hw, hh, n };
      return { mesh, mat, seed: 1 };
    };
    const dropWin = (w: Win | null) => {
      if (!w) return;
      scene.remove(w.mesh);
      w.mesh.geometry.dispose();
      w.mat.dispose();
    };

    let cur: Win | null = null;
    let next: Win | null = null;
    let state: 'whole' | 'burst' | 'gather' = 'whole';
    let stateT = 0;
    let gatherT = 0;
    let prevSince = 99;
    let prevSec = -2;
    let kickE = 0;
    let kc = 0;
    let gap = 0;
    let flip = 1;
    let colorSeed = 1;
    const impact = new THREE.Vector2();
    const flipO = new THREE.Vector2();
    let glow = 0.8;

    const songSeed = (f: FrameContext) => Math.floor(((f.analysis?.duration ?? 61.7) * 13.37 + (f.analysis?.bpm ?? 117) * 3.1) % 997) + 1;

    return {
      render(frame, target) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const feel = frame.feel;
        const p = frame.params;
        const n = Math.round(num(p, 'panes', 110));
        if (Math.abs(camera.aspect - frame.aspect) > 1e-4) {
          camera.aspect = frame.aspect;
          camera.updateProjectionMatrix();
        }
        if (!cur) winSeed = songSeed(frame);
        // a new size of frame or pane count: rebuild what is whole
        const ext = extents(frame.aspect);
        if (!cur || (state === 'whole' && (Math.abs(ext.hw - built.hw) > 1e-3 || n !== built.n))) {
          dropWin(cur);
          cur = makeWin(frame.aspect, n);
        }

        // triggers
        const dropped = feel.sinceDrop < prevSince - 0.05 && feel.sinceDrop < 0.6;
        prevSince = feel.sinceDrop;
        const newSec = feel.sectionIndex !== prevSec && prevSec !== -2 && feel.sectionIndex >= 0;
        prevSec = feel.sectionIndex;
        stateT += dt;

        if (dropped && state !== 'burst') {
          // burst whatever is whole (a window still gathering bursts too)
          if (state === 'gather' && next) {
            dropWin(cur);
            cur = next;
            next = null;
          }
          state = 'burst';
          stateT = 0;
          impact.set((Math.sin(winSeed * 3.7) * 0.4) * ext.hw, (Math.cos(winSeed * 1.3) * 0.3) * ext.hh);
        } else if (state === 'burst' && ((newSec && stateT > 3) || stateT > num(p, 'hold', 9))) {
          state = 'gather';
          gatherT = 0;
          kindIdx++;
          winSeed = (winSeed * 31 + 7) % 997;
          next = makeWin(frame.aspect, n);
        } else if (state === 'gather') {
          gatherT += dt;
          if (gatherT > 4.2) {
            dropWin(cur);
            cur = next;
            next = null;
            state = 'whole';
            stateT = 0;
          }
        } else if (state === 'whole' && newSec && !dropped) {
          // a quiet new part: the panes turn over to new colours
          flip = 0;
          flipO.set((Math.sin(stateT * 7.1 + colorSeed) * 0.5) * ext.hw, (Math.cos(stateT * 3.3) * 0.5) * ext.hh);
        }
        if (flip < 1) {
          flip = Math.min(1, flip + dt / 2.4);
          if (flip >= 1) colorSeed = (colorSeed % 50) + 1.7;
        }

        if (a.kickHit) {
          kc = (kc + 1) % 997;
          kickE = 1;
        }
        kickE *= Math.exp(-dt * 6);
        gap += ((state === 'whole' ? Math.min(1, feel.tension) * 0.06 : 0) - gap) * (1 - Math.exp(-dt * 6));
        glow += (0.45 + 0.75 * feel.intensity + 0.25 * a.level + 0.4 * feel.release - glow) * (1 - Math.exp(-dt * 2.5));

        // the sun moves with the shared day; the camera drifts a little and leans in on a burst
        sun.set(Math.cos(feel.light) * ext.hw * 0.6, -0.2 + Math.sin(feel.light) * ext.hh * 0.6);
        const push = state === 'burst' ? 0.6 * (1 - Math.exp(-stateT * 0.8)) : 0;
        camera.position.set(Math.sin(frame.time * 0.13) * 0.12, Math.cos(frame.time * 0.11) * 0.08, CAM_Z - push);
        camera.lookAt(0, 0, 0);

        const exposure = num(p, 'exposure', 1) * (0.9 + 0.2 * feel.intensity);
        const flood = Math.exp(-feel.sinceDrop * 1.4) * (feel.sinceDrop < 20 ? 1 : 0);
        const sync = (w: Win | null, mode: number, t: number) => {
          if (!w) return;
          syncMaterial(w.mat, frame, params);
          const u = w.mat.uniforms;
          u.uMode.value = mode;
          u.uT.value = t;
          u.uGap.value = gap;
          u.uKickE.value = kickE * num(p, 'pop', 1);
          u.uKc.value = kc;
          u.uFlip.value = mode === 0 ? flip : 1;
          (u.uFlipO.value as THREE.Vector2).copy(flipO);
          (u.uImpact.value as THREE.Vector2).copy(impact);
          u.uForce.value = num(p, 'force', 1);
          u.uSpread.value = Math.min(1, Math.max(0.45, Math.min(ext.hw, ext.hh) / ext.hh));
          u.uGlow.value = glow * (1 + flood * 0.7);
          u.uLeadW.value = 0.026 * num(p, 'lead', 1) * (ext.hh / 2.1);
          u.uExposure.value = exposure;
          u.uSeedC.value = colorSeed;
          u.uSeedN.value = flip < 1 ? (colorSeed % 50) + 1.7 : colorSeed;
        };
        sync(cur, state === 'whole' ? 0 : 1, state === 'whole' ? 0 : stateT);
        sync(next, 2, gatherT);

        syncMaterial(backMat, frame, params);
        const bu = backMat.uniforms;
        // behind the glass: the light floods through the burst, then settles to a glow the shards float in
        bu.uBack.value = glow * (state === 'whole' ? 0.6 + 1.6 * feel.tension : 0.1) + flood * 1.1;
        bu.uExposure.value = exposure;
        (bu.uSunUv.value as THREE.Vector2).set(0.5 + sun.x / (2 * ext.hw), 0.5 + sun.y / (2 * ext.hh));

        frame.renderer.setRenderTarget(target);
        frame.renderer.render(scene, camera);
      },
      dispose() {
        dropWin(cur);
        dropWin(next);
        backMat.dispose();
        scene.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose?.();
        });
      },
    };
  },
};
