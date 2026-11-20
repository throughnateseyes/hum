import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl';
import { createFullscreenQuad, makeRenderTarget } from '../../core/sceneHelpers';
import type { ParamDef, SceneDef } from '../../core/types';
import { num } from '../../core/uniforms';
import { quality } from '../../render/quality';
import { approach, makeMaterial, stepDt, syncMaterial } from '../three/common';
import { DropTimer, TONEMAP_LIB, linColor, tempoRate } from '../nature/volume';

/**
 * Golden Avenue: walking slowly down an avenue of ginkgo trees in full autumn gold, painted.
 *
 *   - a real 3D avenue: two rows of trees each side receding to a glowing vanishing point, the
 *     camera walking down the path (the trees repeat every ten pairs, far enough apart that the
 *     wrap never shows; the ground pattern is unbounded so it never repeats at all)
 *   - the canopy is ~60k painted dabs (camera-facing brush marks with ragged edges, bristle
 *     streaks and pale stipple, alpha-to-coverage on an MSAA buffer), lit from the light at the
 *     end of the avenue so the inner, upper and far dabs glow and the deep ones go amber
 *   - trunks and limbs as instanced tapered cylinders with knobbly painted silhouettes and
 *     vertical bark strokes, warm bounce from the leaf carpet on their lower halves
 *   - the ground is a carpet of leaves drawn as three layers of cell-noise dabs (big colour
 *     blotches, stipple, and near the camera whole ginkgo fans), a lit path down the middle,
 *     amber shade under the trees, dappled light pools
 *   - up to 2,600 falling ginkgo leaves, simulated on the CPU (drag toward the wind, flutter,
 *     tumble, landing), drawn as sorted instanced sprites with depth of field: the near ones are
 *     big soft out-of-focus blobs of light, the far ones small and crisp
 *   - post: HDR bloom (dual-filter chain), a warm glow down the avenue, a slight brush wobble of
 *     the whole picture and canvas tooth, ACES
 *
 * Audio: quiet parts are still air and a few slow leaves; a build lifts the breeze, loosens more
 * leaves and quickens the walk; the drop is a gust that tears a storm of leaves off the ground
 * and out of the trees toward the camera; breakdowns slow the air until the leaves hang almost
 * suspended; kicks shake a few leaves loose and pulse the light; the highs glint on the leaves.
 *
 * Palette roles: bg = the light (haze at the end of the avenue, highlights), accent = the gold
 * leaves, accent2 = the amber of shade and depth, fg = bark and shadow, muted = the path.
 */
const params: ParamDef[] = [
  { id: 'leaves', label: 'Leaves in the air', group: 'Shape', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
  { id: 'canopy', label: 'Canopy fullness', group: 'Shape', type: 'number', min: 0.6, max: 1.4, step: 0.01, default: 1, hint: 'Size of the painted dabs in the trees' },
  { id: 'birch', label: 'Birch bark', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0, hint: 'Pale birch trunks with dark marks instead of dark bark' },
  { id: 'walk', label: 'Walk', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How fast the camera walks down the avenue (follows the tempo)' },
  { id: 'gust', label: 'Drop gust', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'The drop tears a storm of leaves off the ground toward you' },
  { id: 'shake', label: 'Kick shake', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Kicks shake leaves loose and pulse the light' },
  { id: 'glint', label: 'High glints', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Hats and air glint on the leaves' },
  { id: 'hang', label: 'Breakdown hang', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'In breakdowns the air slows until the leaves hang suspended' },
  { id: 'haze', label: 'Haze', group: 'Color', type: 'number', min: 0.3, max: 2, step: 0.01, default: 1, hint: 'How soon the avenue melts into the light' },
  { id: 'glow', label: 'Glow', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Bloom and the light down the avenue' },
  { id: 'focus', label: 'Depth of field', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How soft the leaves close to the lens are' },
  { id: 'paint', label: 'Brush texture', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8 },
  { id: 'grain', label: 'Grain', group: 'Color', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.02 },
];

const EYE = 1.62;
const ROW_X = 4.5;
const ROW2_X = 9.6;
const ROW3_X = 15.5;
const PAIRS = 10;
const SPACING = 5.4;
/** the avenue repeats every PERIOD metres */
const PERIOD = PAIRS * SPACING;
/** the ground pattern's own wrap (unnoticeable: once every ~16 minutes of walking) */
const BIG = PERIOD * 20;
const MAX_LEAVES = 4000;
/** share of canopy dabs drawn when the quality governor draws the look smaller than the output */
const LOD_KEEP = 0.62;

/* ───────────────────────── GLSL ───────────────────────── */

const WORLD = /* glsl */ `
uniform float uSwayT, uSwayAmp, uShiver;
uniform vec2 uGustXZ;
uniform vec3 uHaze, uGlowCol, uLightDir;
uniform float uFogK;
// wind in the trees: grows with height, so trunks stand and crowns move
vec3 gaSway(vec3 p) {
  float h = clamp((p.y - 2.2) / 6.5, 0.0, 1.4);
  h *= h;
  float ph = p.z * 0.13 + p.x * 0.07;
  vec3 d = vec3(sin(uSwayT * 0.9 + ph) + 0.45 * sin(uSwayT * 2.3 + ph * 2.7),
                0.25 * sin(uSwayT * 1.3 + ph * 1.7),
                0.4 * sin(uSwayT * 0.6 + ph + 1.0)) * uSwayAmp;
  d.xz += uGustXZ;
  return d * h;
}
// the haze: a gold mid-tone that only turns to cream light in a tight core down the avenue, so the
// distance steps through values (and the hand-drawn finish's inks) instead of washing out in one sheet
vec3 gaHaze(vec3 dir) {
  float m = max(dot(dir, uLightDir), 0.0);
  return mix(uHaze, uGlowCol, clamp(pow(m, 60.0) * 0.85 + pow(m, 9.0) * 0.3, 0.0, 1.0));
}
float gaFogF(float dist) { return 1.0 - exp(-dist * uFogK); }
// ginkgo leaf in leaf units (about -1..1): a fan on a short stalk with the notch in the middle
float gaGinkgo(vec2 q, out float th, out float rr) {
  vec2 v = q - vec2(0.0, -0.78);
  rr = length(v);
  th = atan(v.x, v.y);
  float R = 1.32 * (1.0 - 0.2 * exp(-th * th * 110.0)) * (0.955 + 0.045 * cos(th * 13.0));
  float blade = max(rr - R, (abs(th) - 0.98) * max(rr, 0.15));
  float stem = max(abs(q.x + 0.02 * q.y) - 0.035, abs(q.y + 0.9) - 0.13);
  return min(blade, stem);
}
`;

const SKY_FRAG = /* glsl */ `
uniform mat4 uInvViewProj;
${WORLD}
void main() {
  vec4 w = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(w.xyz / w.w - cameraPosition);
  vec3 col = gaHaze(dir);
  // above, the light is softer and a touch deeper
  col = mix(col, col * vec3(0.92, 0.86, 0.72), smoothstep(0.1, 0.8, dir.y) * 0.5);
  gl_FragColor = vec4(col, 1.0);
}
`;

const DAB_VERT = /* glsl */ `
attribute vec4 aDab;   // centre xyz, size
attribute vec4 aInfo;  // light 0..1, seed, sway phase, far row
uniform float uDabScale, uSunI, uGlint, uTwinkleT;
uniform vec3 uLeafLit, uLeafDeep, uLight;
varying vec2 vQ;
varying vec3 vCol;
varying float vSeed;
varying float vSpark;
${WORLD}
void main() {
  vec3 p = aDab.xyz;
  p += gaSway(p);
  // a kick shivers the crowns: each dab jumps a little its own way
  float h = clamp((p.y - 2.5) / 6.0, 0.0, 1.0);
  p += (vec3(fract(aInfo.y * 31.7), fract(aInfo.y * 57.3), fract(aInfo.y * 77.1)) - 0.5) * uShiver * h * 0.16;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float seed = aInfo.y;
  float ratio = 0.5 + 0.5 * fract(seed * 7.31);
  vec2 c = position.xy * 2.0;
  vec2 q = rot2(seed * 6.2832) * (position.xy * vec2(1.0, ratio));
  mv.xy += q * aDab.w * uDabScale;
  gl_Position = projectionMatrix * mv;
  vQ = c;
  vSeed = seed;

  // colour: amber in the depths, gold where the light gets in, pale lemon on the brightest edges
  vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
  vec3 d = wp - cameraPosition;
  float dist = length(d);
  vec3 dir = d / dist;
  float lit = aInfo.x;
  float r = fract(seed * 13.7);
  vec3 col = mix(uLeafDeep, uLeafLit, smoothstep(0.05, 0.62, lit));
  col = mix(col, uLight, smoothstep(0.68, 1.05, lit) * (0.35 + 0.5 * r));
  col *= 0.84 + 0.32 * fract(seed * 29.1);
  float fl = fract(seed * 41.3);
  col = mix(col, uLeafDeep * 1.1, step(0.88, fl) * 0.7);
  col = mix(col, uLight, step(fl, 0.06) * 0.6);
  // light through the leaves: dabs in front of the light at the end of the avenue glow
  float back = pow(max(dot(dir, uLightDir), 0.0), 5.0);
  col *= uSunI * (0.78 + 0.5 * lit + 0.9 * back);
  // highs glint: a few dabs flash
  float tw = step(0.9, fract(seed * 91.3)) * (0.5 + 0.5 * sin(uTwinkleT * (3.0 + 5.0 * fract(seed * 5.1)) + seed * 40.0));
  col += uLight * tw * uGlint * 1.4;
  float fog = gaFogF(dist * (1.0 + 0.4 * aInfo.w));
  vCol = mix(col, gaHaze(dir), fog);
  vSpark = (1.0 - fog) * (0.25 + 0.75 * lit);
}
`;

const DAB_FRAG = /* glsl */ `
uniform vec3 uLight;
uniform float uGlint;
varying vec2 vQ;
varying vec3 vCol;
varying float vSeed;
varying float vSpark;
${WORLD}
void main() {
  // a ragged brush dab, or (one in three) a whole ginkgo fan
  float n = tnoise(vQ * 1.9 + vSeed * 97.0);
  float e;
  if (fract(vSeed * 3.31) < 0.34) {
    float th, rr;
    e = gaGinkgo(vQ * 1.12 + vec2(0.0, 0.12), th, rr) + (n - 0.5) * 0.18;
  } else {
    e = length(vQ) + (n - 0.5) * 0.62 - 0.78;
  }
  float aa = fwidth(e) * 1.1 + 1e-4;
  float a = 1.0 - smoothstep(-aa, aa, e);
  if (a < 0.02) discard;
  // loaded brush: lighter on one side, bristle streaks across
  float side = dot(vQ, vec2(0.5, 0.86));
  float bristle = tnoise(vec2(vQ.x * 7.0 + vSeed * 31.0, vQ.y * 1.3 + vSeed * 11.0));
  vec3 col = vCol * (0.92 + 0.12 * side + 0.2 * (bristle - 0.5));
  // pale stipple riding on the dab
  vec2 sc = vQ * 4.5 + vSeed * 17.0;
  vec2 sid = floor(sc);
  float sh = hash21(sid);
  float rad = 0.07 + 0.14 * fract(sh * 7.7);
  float dot0 = 1.0 - smoothstep(rad, rad + 0.12, length(fract(sc) - 0.5 - (hash22(sid) - 0.5) * 0.5));
  col = mix(col, uLight * (1.2 + 0.8 * uGlint), step(0.91, sh) * dot0 * vSpark * 0.75);
  gl_FragColor = vec4(col, a);
}
`;

const BARK_VERT = /* glsl */ `
attribute vec4 aA;   // start xyz, radius
attribute vec4 aB;   // end xyz, radius
attribute vec4 aS;   // seed, trunk (root flare), arc, far row
varying vec3 vN;
varying vec3 vW;
varying vec2 vBark;
varying float vFar;
${WORLD}
void main() {
  float t = position.y + 0.5;
  vec3 A = aA.xyz;
  vec3 ax = aB.xyz - A;
  float len = length(ax);
  vec3 w = ax / len;
  vec3 u = normalize(cross(w, abs(w.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 v = cross(w, u);
  vec2 c = position.xz;
  float ang = atan(c.y, c.x);
  float r = mix(aA.w, aB.w, t);
  r *= 1.0 + aS.y * 0.8 * exp(-t * len * 1.6);
  // knobbly, hand-painted silhouette
  r *= 0.88 + 0.24 * tnoise(vec2(ang * 0.8 + aS.x * 50.0, t * len * 0.7 + aS.x * 9.0));
  vec3 n = u * c.x + v * c.y;
  vec3 p = A + ax * t + n * r;
  p.y += sin(t * 3.14159) * aS.z;
  p += gaSway(p);
  vN = normalize(mat3(modelMatrix) * n);
  vW = (modelMatrix * vec4(p, 1.0)).xyz;
  vBark = vec2(ang, t * len + aS.x * 7.0);
  vFar = aS.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;

const BARK_FRAG = /* glsl */ `
uniform vec3 uBark, uBirch, uBounce, uLight;
uniform float uBirchK, uSunI;
varying vec3 vN;
varying vec3 vW;
varying vec2 vBark;
varying float vFar;
${WORLD}
void main() {
  vec3 n = normalize(vN);
  vec3 d = vW - cameraPosition;
  float dist = length(d);
  vec3 dir = d / dist;
  // vertical bark strokes
  float s1 = tnoise(vec2(vBark.x * 1.6, vBark.y * 0.35));
  float s2 = tnoise(vec2(vBark.x * 3.0 + 3.0, vBark.y * 0.8));
  float strokes = smoothstep(0.35, 0.75, s1 * 0.7 + s2 * 0.3);
  vec3 bark = uBark * (0.6 + 0.55 * strokes);
  // birch: pale bark with dark horizontal marks
  // lenticels: short dark dashes across the trunk, and darker scars low down
  float marks = smoothstep(0.7, 0.76, tnoise(vec2(vBark.x * 1.1 + 11.0, vBark.y * 7.5)) * (0.75 + 0.35 * tnoise(vec2(vBark.x * 3.0, vBark.y * 0.6))));
  marks = max(marks, smoothstep(0.62, 0.7, tnoise(vec2(vBark.x * 1.4 + 5.0, vBark.y * 1.4))) * (1.0 - smoothstep(0.5, 2.5, vW.y)));
  vec3 birch = mix(uBirch * (0.85 + 0.25 * s2), uBark * 0.8, marks);
  vec3 alb = mix(bark, birch, uBirchK);
  // light: sky fill from above, warm bounce from the leaf carpet low down, a rim on the side facing the light
  float lowK = 1.0 - smoothstep(0.0, 4.5, vW.y);
  float up = n.y * 0.5 + 0.5;
  // the side facing the path and the light is blocked in light, the far side in shade
  vec3 toL = normalize(vec3(-sign(vW.x) * 0.7, 0.35, -1.0));
  float lit = smoothstep(0.1, 0.6, dot(n, toL) + (s2 - 0.5) * 0.3);
  float rim = pow(1.0 - abs(dot(n, dir)), 3.0) * max(dot(n, uLightDir), 0.0);
  vec3 lightC = uLight * (0.22 + 0.42 * lit + 0.12 * up) + uBounce * (0.2 + 0.6 * lowK) * (0.5 + 0.5 * lit) + uLight * rim * 1.2;
  vec3 col = alb * lightC * uSunI;
  // birches: the lit side goes paper white and the far side a step down, so pale trunks hold their shape
  // against the pale winter haze (and print as two inks, not one)
  col *= 1.0 + uBirchK * (0.45 * lit - 0.2);
  // flecks of gold: light through the canopy landing on the bark in small dabs
  float fleck = smoothstep(0.83, 0.88, tnoise(vec2(vBark.x * 5.0 + 31.0, vBark.y * 4.5)));
  col = mix(col, uBounce * uSunI * 0.8, fleck * lit * 0.45 * (1.0 - uBirchK * 0.6));
  col = mix(col, gaHaze(dir), gaFogF(dist * (1.0 + 0.4 * vFar)));
  gl_FragColor = vec4(col, 1.0);
}
`;

const GROUND_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vW = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;

const GROUND_FRAG = /* glsl */ `
uniform float uZOff, uDapT, uSunI, uGlint, uTwinkleT;
uniform vec2 uSkitA, uSkitB;
uniform vec3 uPath, uEdge, uLeafLit, uLeafDeep, uLight;
varying vec3 vW;
${WORLD}
vec3 gaPick(float h) {
  vec3 c = mix(uLeafLit, uLeafDeep, smoothstep(0.55, 0.95, h));
  return mix(c, uLight, smoothstep(0.2, 0.0, h) * 0.85);
}
// one layer of leaves: x = colour pick, y = coverage
vec2 gaCells(vec2 p, float cell, float seed, float px, bool fan) {
  float blur = px / cell;
  if (blur > 0.6) return vec2(0.5, 0.0);
  vec2 q = p / cell;
  vec2 id = floor(q);
  vec2 f = fract(q);
  float best = -1.0;
  vec2 res = vec2(0.5, 0.0);
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 cid = id + o + seed;
    vec2 h = hash22(cid);
    float rad = fan ? 0.42 + 0.22 * hash21(cid + 7.1) : 0.5 + 0.35 * hash21(cid + 7.1);
    vec2 lq = rot2(h.x * 6.2832) * (f - o - 0.2 - 0.6 * h) / rad;
    float d;
    if (fan) {
      float th, rr;
      d = gaGinkgo(lq * 1.15, th, rr);
    } else {
      d = length(lq) - 0.9 + (tnoise(lq * 1.6 + h * 50.0) - 0.5) * 0.55;
    }
    float aa = blur / rad * 1.6 + 0.02;
    float a = 1.0 - smoothstep(-aa, aa, d);
    float pri = hash21(cid + 3.3);
    if (a > 0.02 && pri > best) { best = pri; res = vec2(h.y, a); }
  }
  res.y *= 1.0 - smoothstep(0.3, 0.6, blur);
  return res;
}
void main() {
  vec3 d = vW - cameraPosition;
  float dist = length(d);
  vec3 dir = d / dist;
  vec2 g = vec2(vW.x, vW.z - uZOff);
  float px = length(fwidth(g));
  float ax = abs(g.x);
  // the path is lit, the ground under the trees in amber shade
  float edgeN = (tnoise(g * vec2(0.35, 0.12)) - 0.5) * 2.2;
  float under = smoothstep(2.4, 5.0, ax + edgeN);
  float outside = smoothstep(7.0, 9.5, ax + edgeN);
  vec3 col = mix(uPath, uEdge, under * (1.0 - 0.45 * outside));
  // big blotches of colour, then leaves, then (close by) whole ginkgo fans
  vec2 l1 = gaCells(g + uSkitA * 0.3, 0.9, 1.0, px, false);
  col = mix(col, mix(col, gaPick(l1.x), 0.55), l1.y);
  vec2 l2 = gaCells(g + uSkitA, 0.3, 7.0, px, false);
  col = mix(col, gaPick(l2.x) * mix(1.0, 0.82, under), l2.y * 0.9);
  vec2 l3 = gaCells(g + uSkitB, 0.17, 13.0, px, true);
  col = mix(col, gaPick(l3.x * 0.8) * mix(1.05, 0.85, under), l3.y);
  // light pools where the canopy opens, drifting slowly with the wind
  float dap = smoothstep(0.48, 0.78, tnoise(g * vec2(0.2, 0.09) + vec2(uDapT * 0.05, uDapT * 0.02)));
  float light = mix(0.78, 1.18, dap) * mix(1.0, 0.72, under);
  // highs glint on the carpet
  float tw = step(0.93, l3.x) * l3.y * (0.5 + 0.5 * sin(uTwinkleT * 4.0 + l3.x * 300.0));
  col = col * light * uSunI + uLight * tw * uGlint * 0.8;
  col = mix(col, gaHaze(dir), gaFogF(dist * (1.0 + dist * 0.012)));
  gl_FragColor = vec4(col, 1.0);
}
`;

const LEAF_VERT = /* glsl */ `
attribute vec4 aP;   // camera-relative xyz, size
attribute vec4 aR;   // yaw, pitch, roll, alpha
attribute vec4 aC;   // seed, from the ground, 0, 0
uniform vec3 uCamPos;
uniform float uFocal, uFocus, uDofK, uSunI, uGlint, uTwinkleT;
uniform vec3 uLeafLit, uLeafDeep, uLight;
varying vec2 vLeaf;
varying float vBlur;
varying float vAlpha;
varying vec3 vCol;
varying float vSeed;
${WORLD}
void main() {
  float size = aP.w;
  // x and z ride with the camera, y is height above the ground
  vec3 wc = vec3(uCamPos.x, 0.0, uCamPos.z) + aP.xyz;
  vec4 vc = viewMatrix * vec4(wc, 1.0);
  float z = max(-vc.z, 0.05);
  // depth of field: circle of confusion in pixels, then in leaf units; mostly in front of focus
  float inv = 1.0 / z - 1.0 / uFocus;
  float coc = uDofK * (inv > 0.0 ? inv : inv * 0.12);
  float unitPx = uFocal * size * 0.5 / z;
  float b = clamp(coc / max(unitPx, 0.5), 0.0, 1.6);
  float m = 1.0 + b;
  // painted sprites: in the air a leaf faces you, spinning in its plane and fluttering (it narrows
  // as it turns but never goes edge on); on the ground it lies flat
  vec3 toCam = normalize(cameraPosition - wc);
  vec3 right, upv, n;
  float sx = 1.0, sy = 1.0;
  if (aC.z > 0.5) {
    right = vec3(cos(aR.x), 0.0, sin(aR.x));
    upv = vec3(-sin(aR.x), 0.0, cos(aR.x));
    n = vec3(0.0, 1.0, 0.0);
  } else {
    vec3 r0 = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
    vec3 u0 = cross(toCam, r0);
    float f1 = sin(aR.x) * 1.2;
    float f2 = sin(aR.y) * 0.9;
    sx = max(abs(cos(f1)), 0.18);
    sy = max(abs(cos(f2)), 0.3);
    float cr = cos(aR.z), sr = sin(aR.z);
    right = r0 * cr + u0 * sr;
    upv = -r0 * sr + u0 * cr;
    n = normalize(toCam * cos(f1) * cos(f2) + right * sin(f1) + upv * sin(f2));
  }
  vec2 lq = vec2(position.x * 2.2, position.y * 2.0) * m;
  vec3 wp = wc + (right * lq.x * sx + upv * lq.y * sy) * size * 0.5;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vLeaf = lq;
  vBlur = b;
  vSeed = aC.x;

  vec3 dir = normalize(wc - cameraPosition);
  float face = abs(dot(n, dir));
  float r = fract(aC.x * 13.7);
  // the drifting leaves are the brightest things in the picture: lemon gold, lit through
  // a mixed fall: mostly gold, some pale and lit right through, some deep (so the storm reads in any
  // finish, not just as gold on gold)
  vec3 col = mix(uLeafLit, uLight, 0.08 + 0.55 * smoothstep(0.62, 0.9, r));
  col = mix(col, mix(uLeafLit, uLeafDeep, 0.7), (aC.y * 0.4 + step(0.76, fract(aC.x * 7.7)) * 0.8) * 0.8);
  float trans = pow(max(dot(dir, uLightDir), 0.0), 3.0);
  float top = max(n.y * sign(dot(n, -dir) + 1e-4), 0.0);
  col *= uSunI * (1.15 + 0.45 * face + 0.6 * trans + 0.3 * top);
  // highs glint when the blade turns to the light
  vec3 hv = normalize(uLightDir - dir);
  float spec = pow(abs(dot(n, hv)), 40.0);
  float flick = 0.6 + 0.4 * sin(uTwinkleT * 6.0 + aC.x * 80.0);
  col += uLight * spec * uGlint * flick * 2.2;
  // out of focus leaves bloom into soft discs of light
  col = mix(col, mix(uLeafLit, uLight, 0.45) * uSunI * 1.25, clamp(b * 0.4, 0.0, 0.55));
  float fog = gaFogF(z);
  vCol = mix(col, gaHaze(dir), fog);
  vAlpha = aR.w / (1.0 + 0.7 * b * b) * smoothstep(0.7, 1.6, z);
}
`;

const LEAF_FRAG = /* glsl */ `
varying vec2 vLeaf;
varying float vBlur;
varying float vAlpha;
varying vec3 vCol;
varying float vSeed;
${WORLD}
void main() {
  float th, rr;
  float d = gaGinkgo(vLeaf, th, rr);
  float w = vBlur * 1.1 + fwidth(d) * 0.9 + 1e-3;
  float a = 1.0 - smoothstep(-w, w, d);
  if (a * vAlpha < 0.004) discard;
  // radiating veins and a deeper base, fading out as the leaf blurs
  float vein = 0.5 + 0.5 * cos(th * 46.0 + vSeed * 20.0);
  float crisp = 1.0 - smoothstep(0.2, 1.0, vBlur);
  vec3 col = vCol * (1.0 - crisp * (0.08 * vein + 0.16 * (1.0 - smoothstep(0.1, 0.9, rr))));
  // a painted edge: a touch deeper just inside the outline, so a leaf reads against gold
  col *= 1.0 - crisp * 0.3 * smoothstep(-0.16, -0.02, d);
  gl_FragColor = vec4(col, a * vAlpha);
}
`;

/* post */

const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThr;
void main() {
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(min(c * smoothstep(uThr, uThr * 2.2, l), vec3(40.0)), 1.0);
}
`;

const DOWN_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}
`;

const UP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tAdd;
uniform vec2 uTexel;
void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + uTexel * vec2(-2.0, 0.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(2.0, 0.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.0, -2.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.0, 2.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb * 2.0;
  gl_FragColor = vec4(c / 12.0 + texture2D(tAdd, vUv).rgb, 1.0);
}
`;

const COMP_FRAG = /* glsl */ `
uniform sampler2D tScene, tBloom;
uniform vec2 uVP;
uniform float uBloomK, uGlowK, uExposure, uGrain, uPaint, uSat;
uniform vec3 uGlowTint, uShade;
${TONEMAP_LIB}
void main() {
  vec2 res = uResolution;
  // the brush: the whole picture wobbles a pixel or two, slowly, so edges read painted
  vec4 nz = tnoise4(gl_FragCoord.xy / 7.0 + vec2(uTime * 0.21, uTime * 0.13));
  vec4 nz2 = tnoise4(gl_FragCoord.xy / 23.0 + 40.0);
  vec2 off = ((nz.xy - 0.5) * 1.6 + (nz2.zw - 0.5) * 2.4) * uPaint / res;
  // strokes: the picture is smeared a few pixels along a slowly turning flow, like a loaded brush
  float ang = tnoise(gl_FragCoord.xy / 34.0 + 11.0) * 12.566 + (nz.z - 0.5) * 1.2;
  vec2 sd = vec2(cos(ang), sin(ang)) * 1.7 * uPaint / res;
  vec2 uv = vUv + off;
  vec3 col = texture2D(tScene, uv).rgb * 0.3;
  col += (texture2D(tScene, uv + sd).rgb + texture2D(tScene, uv - sd).rgb) * 0.2;
  col += (texture2D(tScene, uv + sd * 2.2).rgb + texture2D(tScene, uv - sd * 2.2).rgb) * 0.15;
  col += texture2D(tBloom, vUv).rgb * uBloomK;
  // warm light down the avenue
  vec2 dv = (vUv - uVP) * vec2(uAspect, 1.0);
  float r2 = dot(dv, dv);
  col += uGlowTint * (exp(-r2 * 7.0) * 0.07 + exp(-r2 * 60.0) * 0.34) * uGlowK;
  vec3 o = ntToDisplay(col, uExposure);
  float l = dot(o, vec3(0.2126, 0.7152, 0.0722));
  o = mix(vec3(l), o, uSat);
  // a soft warm vignette
  vec2 vq = vUv - 0.5;
  float vig = smoothstep(0.35, 0.95, length(vq * vec2(1.0, 1.15)));
  o = mix(o, o * uShade * 0.8, vig * 0.5);
  // canvas tooth
  float tooth = tnoise(gl_FragCoord.xy * 0.45) * 0.6 + tnoise(gl_FragCoord.xy * 0.11 + 9.0) * 0.4;
  float weave = sin(gl_FragCoord.x * 1.7) * sin(gl_FragCoord.y * 1.7);
  o *= 1.0 + ((tooth - 0.5) * 0.09 + weave * 0.012) * uPaint;
  o += (hash21(gl_FragCoord.xy + fract(uTime * 7.31) * 517.0) - 0.5) * uGrain;
  gl_FragColor = vec4(clamp(o, 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── avenue generation ───────────────────────── */

interface Avenue {
  dab: Float32Array;
  dabInfo: Float32Array;
  nDabs: number;
  /** the first run of dabs: enough to paint every crown coarsely (see LOD_KEEP) */
  nCoarse: number;
  segA: Float32Array;
  segB: Float32Array;
  segS: Float32Array;
  nSegs: number;
}

function buildAvenue(seed: number): Avenue {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const range = (a: number, b: number) => a + (b - a) * rnd();

  // one period of trees, generated once and repeated down the avenue
  interface Tree {
    dabs: number[]; // x y z size light seed phase far
    segs: number[]; // ax ay az ar bx by bz br seed trunk arc far
  }
  const trees: Tree[] = [];
  const u = new THREE.Vector3();

  /** row 0 lines the path, row 1 stands behind it, row 2 is the far edge of the grove (mostly haze) */
  const ROWS = [
    { sc: [0.92, 1.12], lean: 0.7, top: 7.8, trunk: 0.26, cx: 2.0, cy: 6.0, R: [3.4, 2.5, 3.1], clumps: 11, dabs: 2400, size: 1 },
    { sc: [0.85, 1.0], lean: 0.3, top: 7.0, trunk: 0.22, cx: 0.9, cy: 5.5, R: [3.3, 2.7, 3.2], clumps: 8, dabs: 1100, size: 1.2 },
    { sc: [0.9, 1.05], lean: 0.1, top: 7.2, trunk: 0.22, cx: 0.3, cy: 5.6, R: [3.6, 3.0, 3.4], clumps: 6, dabs: 600, size: 1.55 },
  ];
  const makeTree = (tx: number, tz: number, side: number, row: number): Tree => {
    const t: Tree = { dabs: [], segs: [] };
    const R = ROWS[row];
    const far = row > 0;
    const sc = range(R.sc[0], R.sc[1]);
    const fr = row;
    const topX = tx - side * R.lean;
    const topY = R.top * sc;
    const trunkR = R.trunk * sc;
    t.segs.push(tx, -0.4, tz, trunkR, topX, topY, tz + range(-0.3, 0.3), trunkR * 0.32, rnd(), 1, 0, fr);
    // the crown: clumps leaning in over the path so the two sides meet overhead
    const cx = tx - side * R.cx * sc;
    const cy = R.cy * sc;
    const Rx = R.R[0] * sc;
    const Ry = R.R[1] * sc;
    const Rz = R.R[2] * sc;
    const nClumps = R.clumps;
    const total = R.dabs;
    for (let k = 0; k < nClumps; k++) {
      let ox: number, oy: number, oz: number, cr: number;
      if (!far && k === 0) {
        // a low drooping clump over the inner edge of the path
        ox = -side * range(0.7, 1.1) * Rx * 0.7;
        oy = -range(0.9, 1.2) * Ry;
        oz = range(-0.6, 0.6) * Rz;
        cr = range(1.0, 1.35) * sc;
      } else {
        ox = (range(-1, 1) - side * 0.35) * Rx * 0.62;
        oy = range(-0.55, 0.85) * Ry * 0.65;
        oz = range(-1, 1) * Rz * 0.62;
        cr = range(1.1, 1.85) * sc;
      }
      const ccx = cx + ox;
      const ccy = cy + oy;
      const ccz = tz + oz;
      // a limb from the trunk out to the clump (stops short so it shows between the dabs)
      const at = range(0.36, 0.66);
      const sx = tx + (topX - tx) * at;
      const sy = -0.4 + (topY + 0.4) * at;
      const r0 = trunkR * range(0.32, 0.45);
      const mx = sx + (ccx - sx) * 0.45 + range(-0.3, 0.3);
      const my = sy + (ccy - sy) * 0.45 + range(0.2, 0.7);
      const mz = tz + (ccz - tz) * 0.45 + range(-0.3, 0.3);
      t.segs.push(sx, sy, tz, r0, mx, my, mz, r0 * 0.62, rnd(), 0, range(0, 0.15), fr);
      t.segs.push(mx, my, mz, r0 * 0.62, sx + (ccx - sx) * 0.8, sy + (ccy - sy) * 0.8, tz + (ccz - tz) * 0.8, r0 * 0.18, rnd(), 0, range(0.05, 0.25), fr);
      t.segs.push(mx, my, mz, r0 * 0.26, mx + (ccx + range(-1, 1) * cr * 0.6 - mx) * 0.75, my + (ccy + range(-0.2, 0.8) * cr - my) * 0.75, mz + (ccz + range(-1, 1) * cr * 0.6 - mz) * 0.75, r0 * 0.06, rnd(), 0, range(0, 0.2), fr);
      const n = Math.round(total / nClumps);
      for (let i = 0; i < n; i++) {
        u.set(range(-1, 1), range(-1, 1), range(-1, 1));
        if (u.lengthSq() > 1 || u.lengthSq() < 0.01) {
          i--;
          continue;
        }
        u.normalize();
        const rr = cr * (0.5 + 0.5 * Math.sqrt(rnd()));
        const px = ccx + u.x * rr;
        const py = ccy + u.y * rr * 0.82;
        const pz = ccz + u.z * rr;
        if (py < 2.3) continue;
        // light reaching this dab: the top, the inner side and the side facing down the avenue are lit,
        // the inside of the crown is shade
        const shell = rr / cr;
        const inward = -side * u.x;
        const dc = Math.hypot((px - cx) / Rx, (py - cy) / Ry, (pz - tz) / Rz);
        let lit = 0.28 + 0.3 * u.y + 0.16 * inward + 0.18 * shell + 0.1 * -u.z - 0.3 * Math.max(0, 0.9 - dc) + range(-0.18, 0.18);
        if (rnd() < 0.08) lit += 0.35;
        lit = THREE.MathUtils.clamp(lit, 0, 1.1);
        t.dabs.push(px, py, pz, range(0.34, 0.64) * R.size, lit, rnd(), rnd(), fr);
      }
    }
    return t;
  };

  for (let k = 0; k < PAIRS; k++) {
    for (const side of [-1, 1]) {
      const z = -k * SPACING + range(-0.7, 0.7) + (side > 0 ? 0.4 : 0);
      trees.push(makeTree(side * (ROW_X + range(-0.25, 0.35)), z, side, 0));
      trees.push(makeTree(side * (ROW2_X + range(-0.5, 0.6)), z - SPACING * 0.5 + range(-0.6, 0.6), side, 1));
      if (k % 2 === 0) trees.push(makeTree(side * (ROW3_X + range(-1, 1)), z - SPACING * range(0.3, 1.7), side, 2));
    }
  }

  // repeat down the avenue; behind the camera only what can be seen
  const fract = (v: number) => v - Math.floor(v);
  const dab: number[] = [];
  const info: number[] = [];
  const segA: number[] = [];
  const segB: number[] = [];
  const segS: number[] = [];
  for (let p = -1; p <= 3; p++) {
    const dz = -p * PERIOD;
    for (const t of trees) {
      if (t.segs[2] + dz > 12) continue;
      for (let i = 0; i < t.dabs.length; i += 8) {
        // far down the avenue (even with the camera at the end of its period) the canopy is a few px
        // across in the haze: fewer, bigger dabs paint it the same for a fraction of the cost
        const near = Math.max(0, -(t.dabs[i + 2] + dz) - PERIOD);
        const keep = near < 35 ? 1 : Math.max(0.4, 35 / near);
        if (keep < 1 && fract(Math.sin(i * 12.9898 + p * 78.233) * 43758.5453) > keep) continue;
        dab.push(t.dabs[i], t.dabs[i + 1], t.dabs[i + 2] + dz, t.dabs[i + 3] / Math.sqrt(keep));
        info.push(t.dabs[i + 4], t.dabs[i + 5], t.dabs[i + 6], t.dabs[i + 7]);
      }
      for (let i = 0; i < t.segs.length; i += 12) {
        segA.push(t.segs[i], t.segs[i + 1], t.segs[i + 2] + dz, t.segs[i + 3]);
        segB.push(t.segs[i + 4], t.segs[i + 5], t.segs[i + 6] + dz, t.segs[i + 7]);
        segS.push(t.segs[i + 8], t.segs[i + 9], t.segs[i + 10], t.segs[i + 11]);
      }
    }
  }
  // near dabs first: the GPU can skip what they hide. Two runs: a share of the dabs (picked by their
  // spare random) first, then the rest, so on the quality governor's lower rungs drawing only the first run
  // still paints every crown, just more coarsely
  const nDabs = dab.length / 4;
  const near = (a: number, b: number) => dab[b * 4 + 2] - dab[a * 4 + 2];
  const all = Array.from({ length: nDabs }, (_, i) => i);
  const first = all.filter((i) => info[i * 4 + 2] < LOD_KEEP).sort(near);
  const order = first.concat(all.filter((i) => info[i * 4 + 2] >= LOD_KEEP).sort(near));
  const D = new Float32Array(nDabs * 4);
  const I = new Float32Array(nDabs * 4);
  order.forEach((src, dst) => {
    for (let c = 0; c < 4; c++) {
      D[dst * 4 + c] = dab[src * 4 + c];
      I[dst * 4 + c] = info[src * 4 + c];
    }
  });
  return { dab: D, dabInfo: I, nDabs, nCoarse: first.length, segA: new Float32Array(segA), segB: new Float32Array(segB), segS: new Float32Array(segS), nSegs: segA.length / 4 };
}

/* ───────────────────────── scene ───────────────────────── */

export const goldenAvenue: SceneDef = {
  id: 'golden-avenue',
  name: 'Golden Avenue',
  description:
    'A painted avenue of ginkgo trees in full autumn gold, walked slowly toward the light at its end: the canopy and the leaf carpet are masses of brush dabs and stipple, and ginkgo leaves drift past at every depth, big and soft near the lens, small and crisp far away. Quiet parts are still air and a few slow leaves, a build lifts the breeze and quickens the walk, the drop is a gust that tears a storm of leaves off the ground toward you, breakdowns leave them hanging in the air, kicks shake a few loose and pulse the light, and the highs glint on the leaves. The glowing end of the avenue and the lit path keep lyrics readable.',
  category: 'form',
  style: 'world',
  tags: ['nostalgic', 'warm', 'tender', 'hopeful', 'dreamy', 'romantic', 'uplifting', 'emotional', 'cinematic', 'calm', 'acoustic', 'indie', 'folk', 'pop', 'piano', 'nature', 'organic', 'bright', 'soft'],
  light: true,
  // printed, the haze steps cream → pale gold (muted) → gold → orange → bark down the avenue; three inks
  // already read, the fourth adds the pale-gold step between the light and the haze
  handInks: 4,
  params,
  modulations: [],
  create(init) {
    const { shared } = init;
    const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.05, 600);
    const lightDir = new THREE.Vector3(0, 0.16, -1).normalize();

    const worldU = {
      uSwayT: { value: 0 },
      uSwayAmp: { value: 0.05 },
      uShiver: { value: 0 },
      uGustXZ: { value: new THREE.Vector2() },
      uHaze: { value: new THREE.Vector3(1, 0.9, 0.6) },
      uGlowCol: { value: new THREE.Vector3(2, 1.8, 1.2) },
      uLightDir: { value: lightDir },
      uFogK: { value: 0.012 },
      uSunI: { value: 1 },
      uGlint: { value: 0 },
      uTwinkleT: { value: 0 },
      uLight: { value: new THREE.Vector3(1, 0.95, 0.8) },
      uLeafLit: { value: new THREE.Vector3() },
      uLeafDeep: { value: new THREE.Vector3() },
    };

    // sky behind everything
    const skyMat = makeMaterial({
      params,
      shared,
      vertex: /* glsl */ `void main() { vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }`,
      fragment: SKY_FRAG,
      extra: { ...worldU, uInvViewProj: { value: new THREE.Matrix4() } },
      depthWrite: false,
      depthTest: false,
    });
    const skyMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), skyMat);
    skyMesh.frustumCulled = false;
    skyMesh.renderOrder = -10;

    // ground
    const groundMat = makeMaterial({
      params,
      shared,
      vertex: GROUND_VERT,
      fragment: GROUND_FRAG,
      extra: {
        ...worldU,
        uZOff: { value: 0 },
        uDapT: { value: 0 },
        uSkitA: { value: new THREE.Vector2() },
        uSkitB: { value: new THREE.Vector2() },
        uPath: { value: new THREE.Vector3() },
        uEdge: { value: new THREE.Vector3() },
      },
    });
    const groundGeo = new THREE.PlaneGeometry(200, 320);
    groundGeo.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.frustumCulled = false;
    ground.renderOrder = 0;

    // trees
    const av = buildAvenue(20251119);
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 10, 6, true);
    const segGeo = new THREE.InstancedBufferGeometry();
    segGeo.index = cyl.index;
    segGeo.setAttribute('position', cyl.getAttribute('position'));
    segGeo.setAttribute('uv', cyl.getAttribute('uv'));
    segGeo.setAttribute('aA', new THREE.InstancedBufferAttribute(av.segA, 4));
    segGeo.setAttribute('aB', new THREE.InstancedBufferAttribute(av.segB, 4));
    segGeo.setAttribute('aS', new THREE.InstancedBufferAttribute(av.segS, 4));
    segGeo.instanceCount = av.nSegs;
    const barkMat = makeMaterial({
      params,
      shared,
      vertex: BARK_VERT,
      fragment: BARK_FRAG,
      extra: { ...worldU, uBark: { value: new THREE.Vector3() }, uBirch: { value: new THREE.Vector3() }, uBounce: { value: new THREE.Vector3() }, uBirchK: { value: 0 } },
      side: THREE.DoubleSide,
    });
    const bark = new THREE.Mesh(segGeo, barkMat);
    bark.frustumCulled = false;
    bark.renderOrder = 1;

    const quad = new THREE.PlaneGeometry(1, 1);
    const dabGeo = new THREE.InstancedBufferGeometry();
    dabGeo.index = quad.index;
    dabGeo.setAttribute('position', quad.getAttribute('position'));
    dabGeo.setAttribute('uv', quad.getAttribute('uv'));
    dabGeo.setAttribute('aDab', new THREE.InstancedBufferAttribute(av.dab, 4));
    dabGeo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(av.dabInfo, 4));
    dabGeo.instanceCount = av.nDabs;
    const dabMat = makeMaterial({
      params,
      shared,
      vertex: DAB_VERT,
      fragment: DAB_FRAG,
      extra: { ...worldU, uDabScale: { value: 1 } },
      side: THREE.DoubleSide,
    });
    dabMat.alphaToCoverage = true;
    const dabs = new THREE.Mesh(dabGeo, dabMat);
    dabs.frustumCulled = false;
    dabs.renderOrder = 2;

    // falling leaves
    const lP = new Float32Array(MAX_LEAVES * 4);
    const lR = new Float32Array(MAX_LEAVES * 4);
    const lC = new Float32Array(MAX_LEAVES * 4);
    const leafGeo = new THREE.InstancedBufferGeometry();
    leafGeo.index = quad.index;
    leafGeo.setAttribute('position', quad.getAttribute('position'));
    leafGeo.setAttribute('uv', quad.getAttribute('uv'));
    const aP = new THREE.InstancedBufferAttribute(lP, 4).setUsage(THREE.DynamicDrawUsage);
    const aR = new THREE.InstancedBufferAttribute(lR, 4).setUsage(THREE.DynamicDrawUsage);
    const aC = new THREE.InstancedBufferAttribute(lC, 4).setUsage(THREE.DynamicDrawUsage);
    leafGeo.setAttribute('aP', aP);
    leafGeo.setAttribute('aR', aR);
    leafGeo.setAttribute('aC', aC);
    leafGeo.instanceCount = 0;
    const leafMat = makeMaterial({
      params,
      shared,
      vertex: LEAF_VERT,
      fragment: LEAF_FRAG,
      extra: {
        ...worldU,
        uCamPos: { value: new THREE.Vector3() },
        uFocal: { value: 700 },
        uFocus: { value: 9 },
        uDofK: { value: 50 },
      },
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    });
    const leafMesh = new THREE.Mesh(leafGeo, leafMat);
    leafMesh.frustumCulled = false;
    leafMesh.renderOrder = 5;

    const scene = new THREE.Scene();
    scene.add(skyMesh, ground, bark, dabs, leafMesh);

    // leaf state (camera-relative metres)
    const L = {
      x: new Float32Array(MAX_LEAVES),
      y: new Float32Array(MAX_LEAVES),
      z: new Float32Array(MAX_LEAVES),
      vx: new Float32Array(MAX_LEAVES),
      vy: new Float32Array(MAX_LEAVES),
      vz: new Float32Array(MAX_LEAVES),
      a0: new Float32Array(MAX_LEAVES),
      a1: new Float32Array(MAX_LEAVES),
      a2: new Float32Array(MAX_LEAVES),
      s0: new Float32Array(MAX_LEAVES),
      s1: new Float32Array(MAX_LEAVES),
      s2: new Float32Array(MAX_LEAVES),
      size: new Float32Array(MAX_LEAVES),
      seed: new Float32Array(MAX_LEAVES),
      ph: new Float32Array(MAX_LEAVES),
      fr: new Float32Array(MAX_LEAVES),
      age: new Float32Array(MAX_LEAVES),
      life: new Float32Array(MAX_LEAVES),
      ground: new Uint8Array(MAX_LEAVES),
      state: new Uint8Array(MAX_LEAVES), // 0 free, 1 in the air, 2 on the ground
    };
    const free: number[] = [];
    for (let i = MAX_LEAVES - 1; i >= 0; i--) free.push(i);
    let seedS = 7;
    const rnd = () => {
      seedS = (seedS * 16807) % 2147483647;
      return seedS / 2147483647;
    };
    const spawn = (x: number, y: number, z: number, vx: number, vy: number, vz: number, fromGround: boolean) => {
      const i = free.pop();
      if (i === undefined) return;
      L.x[i] = x;
      L.y[i] = y;
      L.z[i] = z;
      L.vx[i] = vx;
      L.vy[i] = vy;
      L.vz[i] = vz;
      L.a0[i] = rnd() * 6.283;
      L.a1[i] = fromGround ? -1.5 + (rnd() - 0.5) * 0.6 : rnd() * 6.283;
      L.a2[i] = rnd() * 6.283;
      L.s0[i] = (rnd() < 0.5 ? -1 : 1) * (1.6 + rnd() * 3);
      L.s1[i] = (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 1.6);
      L.s2[i] = (rnd() - 0.5) * 2.2;
      L.size[i] = 0.17 + rnd() * 0.12;
      L.seed[i] = rnd();
      L.ph[i] = rnd() * 6.283;
      L.fr[i] = 0.8 + rnd() * 0.9;
      L.age[i] = 0;
      L.life[i] = 5 + rnd() * 5;
      L.ground[i] = fromGround ? 1 : 0;
      L.state[i] = 1;
    };
    /**
     * A leaf loosened from the canopy, placed by where it will be seen: a random spot in the frame
     * at a distance from zNear to zFar (fading in as it comes into the light), or just above the top
     * of the frame so it falls in.
     */
    const fromCanopy = (zNear: number, zFar: number, aboveFrame = rnd() < 0.35) => {
      const z = zNear + (zFar - zNear) * Math.pow(rnd(), 2.1);
      const halfH = z * view.tanHalf;
      const x = (rnd() * 2 - 1) * halfH * view.aspect * 1.15;
      const yc = EYE + z * view.tanPitch;
      const y = Math.min(9.5, Math.max(0.35, aboveFrame ? yc + halfH + 0.15 + rnd() * 0.9 : yc + (rnd() * 2 - 1.15) * halfH));
      spawn(x, y, -z, (rnd() - 0.5) * 0.4, -0.2, (rnd() - 0.5) * 0.4, false);
    };
    /** a leaf torn off the carpet by the gust */
    const fromGround = (g: number) => {
      const z = -(1.5 + Math.pow(rnd(), 1.7) * 32);
      const x = (rnd() - 0.5) * 14;
      spawn(x, 0.03, z, windX * 2 + (rnd() - 0.5) * 3, (1.5 + rnd() * 4.5) * g, (2.5 + rnd() * 5) * g, true);
    };

    // post
    let sceneRT: THREE.WebGLRenderTarget | null = null;
    const blm: THREE.WebGLRenderTarget[] = []; // down chain: 1/2, 1/4, 1/8, 1/16
    const blu: THREE.WebGLRenderTarget[] = []; // up chain: 1/8, 1/4, 1/2
    const brightMat = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThr: { value: 1 } }, vertexShader: FULLSCREEN_VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false });
    const downMat = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, vertexShader: FULLSCREEN_VERT, fragmentShader: DOWN_FRAG, depthTest: false, depthWrite: false });
    const upMat = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() } }, vertexShader: FULLSCREEN_VERT, fragmentShader: UP_FRAG, depthTest: false, depthWrite: false });
    const compMat = makeMaterial({
      params,
      shared,
      vertex: /* glsl */ `void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragment: COMP_FRAG,
      extra: {
        tScene: { value: null },
        tBloom: { value: null },
        uVP: { value: new THREE.Vector2(0.5, 0.5) },
        uBloomK: { value: 0.5 },
        uGlowK: { value: 1 },
        uExposure: { value: 1 },
        uGrain: { value: 0.02 },
        uPaint: { value: 0.8 },
        uSat: { value: 1.05 },
        uGlowTint: { value: new THREE.Vector3() },
        uShade: { value: new THREE.Vector3() },
      },
      depthTest: false,
      depthWrite: false,
    });
    const brightQuad = createFullscreenQuad(brightMat);
    const downQuad = createFullscreenQuad(downMat);
    const upQuad = createFullscreenQuad(upMat);
    const compQuad = createFullscreenQuad(compMat);

    const drop = new DropTimer();
    let walk = 0;
    let walkSpeed = 0.5;
    let swayT = 0;
    let swayAmp = 0.05;
    let twinkleT = 0;
    let dapT = 0;
    let hang = 0;
    let breeze = 0.1;
    let kickS = 0;
    let shiver = 0;
    let glintS = 0;
    let windX = 1;
    let spawnAcc = 0;
    let gustAcc = 0;
    let camX = 0;
    let lift = 0;
    const view = { tanHalf: 0.55, tanPitch: 0.08, aspect: 16 / 9 };
    const skitA = new THREE.Vector2();
    const skitB = new THREE.Vector2();
    const gustXZ = new THREE.Vector2();
    const order: number[] = [];
    const vp = new THREE.Vector3();
    const col = new THREE.Color();
    const col2 = new THREE.Color();
    const invVP = new THREE.Matrix4();

    return {
      render(frame, target) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        const pal = frame.palette.c;
        const feel = frame.feel;
        drop.step(frame);
        const gustK = num(p, 'gust', 1);
        const gEnv = drop.env * gustK;
        // the very start of the gust: strongest lift in the first second
        const gHit = drop.since < 2.5 ? Math.exp(-drop.since * 1.1) * gustK : 0;
        const tension = Math.min(1, Math.max(0, a.build, feel.tension));
        const intensity = feel.intensity;

        // breakdowns: the air slows until the leaves hang (live input: quiet stretches after a drop, a little)
        const isBreak = feel.section === 'break' ? 1 : feel.section === null && feel.sinceDrop < 60 ? 0.5 * (1 - THREE.MathUtils.smoothstep(a.energy, 0.1, 0.4)) : 0;
        hang = approach(hang, isBreak * (1 - 0.6 * gEnv) * num(p, 'hang', 1), isBreak > hang ? 0.7 : 1.6, dt);
        const timeK = 1 - 0.86 * hang;
        breeze = approach(breeze, Math.min(1, 0.06 + 0.3 * intensity + 0.75 * tension + 0.3 * feel.gust) * (1 - 0.75 * hang), 1.2, dt);
        windX = approach(windX, feel.windX >= 0 ? 1 : -1, 0.3, dt);

        // kicks: a shiver through the crowns, a soft pulse of light, a few leaves shaken loose
        const shakeK = num(p, 'shake', 1);
        kickS = Math.max(kickS * Math.exp(-dt * 6), a.kick * shakeK);
        shiver = approach(shiver, a.kick * shakeK * (1 - 0.7 * hang), 18, dt);
        glintS = approach(glintS, (0.15 + 1.2 * a.air + 0.9 * a.hat + 0.3 * a.highMid) * num(p, 'glint', 1) * (1 - 0.4 * hang), 12, dt);

        // the walk: slow, quickens a touch with a build, carried forward by the gust, near still in a breakdown
        const rate = tempoRate(frame);
        const walkT = num(p, 'walk', 1) * (0.42 + 0.18 * rate + 0.35 * tension + 0.15 * intensity + 0.5 * gEnv) * (1 - 0.65 * hang) * (a.playing ? 1 : 0.4);
        walkSpeed = approach(walkSpeed, walkT, 0.8, dt);
        walk = (walk + walkSpeed * dt) % BIG;
        const camZ = -(walk % PERIOD);

        // camera: eye height, a gentle meander, a footstep on each beat, looking up into the gust
        const camXNew = 0.35 * Math.sin(frame.time * 0.045) + 0.15 * Math.sin(frame.time * 0.11 + 1.3);
        const dCamX = camXNew - camX;
        camX = camXNew;
        const bob = 0.018 * Math.abs(Math.sin(a.beatPhase * Math.PI)) * Math.min(1, walkSpeed / 0.6) * (1 - hang);
        lift = approach(lift, gEnv, 1.5, dt);
        camera.position.set(camX, EYE + bob + 0.15 * lift, camZ);
        const yaw = 0.035 * Math.sin(frame.time * 0.06 + 0.4) - camX * 0.04;
        const pitch = 0.1 + 0.06 * lift;
        camera.rotation.set(pitch, yaw, 0.004 * Math.sin(frame.time * 0.09), 'YXZ');
        // tall frames widen the view so the avenue still fits
        const tanY0 = Math.tan((58 * Math.PI) / 360);
        const tanX0 = Math.tan((46 * Math.PI) / 360);
        const ty = Math.max(tanY0, tanX0 / Math.max(frame.aspect, 0.1));
        camera.fov = (Math.atan(Math.min(ty, 1.4)) * 360) / Math.PI;
        camera.aspect = frame.aspect;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        view.tanHalf = Math.tan((camera.fov * Math.PI) / 360);
        view.tanPitch = Math.tan(pitch);
        view.aspect = frame.aspect;

        // wind in the crowns
        swayAmp = approach(swayAmp, 0.04 + 0.22 * breeze + 0.15 * a.mid * (1 - hang) + 0.5 * gEnv, 2.5, dt);
        swayT += dt * timeK * (0.4 + 0.9 * breeze + 1.5 * gEnv) * rate;
        gustXZ.set(windX * (0.25 * breeze + 0.9 * gEnv), 0.35 * gEnv);
        twinkleT += dt * (0.4 + glintS);
        dapT += dt * timeK * (0.3 + breeze);
        // leaves skitter along the carpet when the air moves
        skitA.x += dt * timeK * windX * (0.04 * breeze + 0.6 * gEnv);
        skitA.y += dt * timeK * (0.02 * breeze + 0.9 * gEnv);
        skitB.x += dt * timeK * windX * (0.08 * breeze + 1.1 * gEnv);
        skitB.y += dt * timeK * (0.04 * breeze + 1.6 * gEnv);

        /* ── leaves ── */
        const simDt = dt * timeK;
        const density = num(p, 'leaves', 1);
        // loosened from the canopy: a few in quiet parts, more as the music grows, many in a build and after the drop
        const perSec = density * (2.5 + 16 * intensity * intensity + 40 * tension + 50 * feel.release * intensity) * (1 - 0.45 * hang) * (a.playing ? 1 : 0.5);
        spawnAcc += perSec * dt;
        while (spawnAcc >= 1) {
          spawnAcc -= 1;
          fromCanopy(1.2, 50);
        }
        if (a.kickHit && shakeK > 0) {
          const n = Math.round(density * shakeK * (1 + 4 * a.kick) * (1 - 0.8 * hang));
          for (let k = 0; k < n; k++) fromCanopy(2.5, 14, true);
        }
        // the gust: a storm torn off the ground and out of the trees, toward you
        if (gHit > 0.02 && density > 0) {
          gustAcc += dt * gHit * 2600 * Math.min(density, 1.5);
          while (gustAcc >= 1) {
            gustAcc -= 1;
            const r = rnd();
            if (r < 0.6) fromGround(0.6 + 0.6 * gHit);
            else fromCanopy(1.2, 24, false);
          }
        }
        const wX = windX * (0.15 + 1.4 * breeze + 3.2 * gEnv);
        const wY = 0.2 * breeze + 2.6 * gHit;
        const wZ = 0.25 * breeze + 4.5 * gEnv;
        const turb = 0.35 + 0.9 * breeze + 2.2 * gEnv;
        const drag = 1 - Math.exp(-2.4 * simDt);
        const camDz = walkSpeed * dt;
        order.length = 0;
        for (let i = 0; i < MAX_LEAVES; i++) {
          const st = L.state[i];
          if (st === 0) continue;
          L.age[i] += simDt;
          L.z[i] += camDz;
          L.x[i] -= dCamX;
          if (st === 1) {
            L.ph[i] += simDt * L.fr[i] * (1.8 + turb);
            const ph = L.ph[i];
            // a falling leaf glides side to side, dropping faster when it turns edge on
            const edge = Math.abs(Math.sin(Math.sin(L.a0[i]) * 1.2));
            const tx = wX + Math.sin(ph) * turb * 0.9;
            const ty = wY - (0.45 + 0.5 * edge) + Math.cos(ph * 2) * 0.25 * turb;
            const tz = wZ + Math.cos(ph * 0.7 + L.seed[i] * 9) * turb * 0.5;
            L.vx[i] += (tx - L.vx[i]) * drag;
            L.vy[i] += (ty - L.vy[i]) * drag;
            L.vz[i] += (tz - L.vz[i]) * drag;
            L.x[i] += L.vx[i] * simDt;
            L.y[i] += L.vy[i] * simDt;
            L.z[i] += L.vz[i] * simDt;
            const spin = 1 + turb * 0.8;
            L.a0[i] += L.s0[i] * simDt * spin;
            L.a1[i] += L.s1[i] * simDt * spin;
            L.a2[i] += L.s2[i] * simDt * spin;
            if (L.y[i] <= 0.025 && L.vy[i] < 0) {
              // landed: lie flat on the carpet for a while
              L.state[i] = 2;
              L.y[i] = 0.025;
              L.a0[i] = rnd() * 6.283;
              L.age[i] = 0;
            }
          } else if (gHit > 0.3 && rnd() < dt * 3) {
            // the gust lifts what has settled
            L.state[i] = 1;
            L.vy[i] = 2 + rnd() * 3;
            L.vz[i] = 3 + rnd() * 5;
          }
          const gone = L.z[i] > -0.6 || L.z[i] < -75 || Math.abs(L.x[i]) > 16 || L.y[i] > 16 || (L.state[i] === 2 && L.age[i] > L.life[i]);
          if (gone) {
            L.state[i] = 0;
            free.push(i);
            continue;
          }
          order.push(i);
        }
        // far to near, so the soft near ones lie over the rest
        order.sort((i, j) => L.z[i] - L.z[j]);
        for (let k = 0; k < order.length; k++) {
          const i = order[k];
          const o = k * 4;
          lP[o] = L.x[i];
          lP[o + 1] = L.y[i];
          lP[o + 2] = L.z[i];
          lP[o + 3] = L.size[i];
          lR[o] = L.a0[i];
          lR[o + 1] = L.a1[i];
          lR[o + 2] = L.a2[i];
          // fade in when loosened, out when resting
          const fin = Math.min(1, L.age[i] * 1.4 + (L.ground[i] ? 1 : 0));
          lR[o + 3] = L.state[i] === 2 ? Math.min(1, (L.life[i] - L.age[i]) / 1.5) : fin;
          lC[o] = L.seed[i];
          lC[o + 1] = L.ground[i];
          lC[o + 2] = L.state[i] === 2 ? 1 : 0;
        }
        leafGeo.instanceCount = order.length;
        aP.needsUpdate = aR.needsUpdate = aC.needsUpdate = true;

        /* ── colour and light (linear) ── */
        const sunI = 1.0 * (1 + 0.1 * kickS + 0.07 * gEnv + 0.1 * tension) * (1 - 0.1 * hang);
        linColor(pal.bg, worldU.uLight.value);
        // the haze sits a value step below the light: gold for the ginkgo avenue (leaning to the second
        // accent, since darkened yellow reads olive), the cool muted grey for birches, so white trunks stand
        // out against it instead of melting into a straw-coloured field
        const birchK = num(p, 'birch', 0);
        col.copy(pal.bg).lerp(pal.accent, 0.55).lerp(pal.accent2, 0.14);
        col2.copy(pal.bg).lerp(pal.muted, 0.85).lerp(pal.accent2, 0.14);
        col.lerp(col2, birchK);
        linColor(col, worldU.uHaze.value).multiplyScalar((0.84 - 0.14 * birchK) * sunI);
        linColor(pal.bg, worldU.uGlowCol.value).multiplyScalar(2.1 * sunI);
        linColor(pal.accent, worldU.uLeafLit.value);
        col.copy(pal.accent2).lerp(pal.fg, 0.12);
        linColor(col, worldU.uLeafDeep.value);
        worldU.uSunI.value = sunI;
        worldU.uFogK.value = 0.0062 * num(p, 'haze', 1) * (1 + 0.25 * hang);
        worldU.uSwayT.value = swayT;
        worldU.uSwayAmp.value = swayAmp;
        worldU.uShiver.value = shiver;
        worldU.uGustXZ.value.copy(gustXZ);
        worldU.uGlint.value = glintS;
        worldU.uTwinkleT.value = twinkleT;

        const gu = groundMat.uniforms;
        gu.uZOff.value = Math.floor(walk / PERIOD) * PERIOD;
        gu.uDapT.value = dapT;
        (gu.uSkitA.value as THREE.Vector2).copy(skitA);
        (gu.uSkitB.value as THREE.Vector2).copy(skitB);
        col.copy(pal.muted).lerp(pal.accent, 0.35);
        linColor(col, gu.uPath.value as THREE.Vector3);
        col.copy(pal.accent2).lerp(pal.fg, 0.06);
        linColor(col, gu.uEdge.value as THREE.Vector3);
        ground.position.set(camX, 0, camZ - 150);

        const bu = barkMat.uniforms;
        linColor(pal.fg, bu.uBark.value as THREE.Vector3);
        col.copy(pal.bg).lerp(pal.muted, 0.2);
        linColor(col, bu.uBirch.value as THREE.Vector3);
        col.copy(pal.accent).lerp(pal.accent2, 0.35);
        linColor(col, bu.uBounce.value as THREE.Vector3);
        bu.uBirchK.value = birchK;
        // lower quality rungs (the look drawn smaller than the output): fewer, slightly bigger dabs
        const coarse = quality.current().sceneScale < 1;
        dabGeo.instanceCount = coarse ? av.nCoarse : av.nDabs;
        dabMat.uniforms.uDabScale.value = num(p, 'canopy', 1) * (coarse ? 1.15 : 1);

        const lu = leafMat.uniforms;
        (lu.uCamPos.value as THREE.Vector3).copy(camera.position);
        const focal = frame.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
        lu.uFocal.value = focal;
        lu.uFocus.value = 9;
        lu.uDofK.value = 0.06 * frame.height * num(p, 'focus', 1);

        invVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
        (skyMat.uniforms.uInvViewProj.value as THREE.Matrix4).copy(invVP);
        syncMaterial(skyMat, frame, params);
        syncMaterial(groundMat, frame, params);
        syncMaterial(barkMat, frame, params);
        syncMaterial(dabMat, frame, params);
        syncMaterial(leafMat, frame, params);

        /* ── draw ── */
        const w = frame.width;
        const h = frame.height;
        if (!sceneRT || sceneRT.width !== w || sceneRT.height !== h) {
          sceneRT?.dispose();
          for (const t of blm) t.dispose();
          for (const t of blu) t.dispose();
          blm.length = blu.length = 0;
          sceneRT = makeRenderTarget(w, h, { samples: 4, depthBuffer: true });
          for (let k = 1; k <= 4; k++) blm.push(makeRenderTarget(Math.max(2, Math.round(w / 2 ** k)), Math.max(2, Math.round(h / 2 ** k))));
          for (let k = 3; k >= 1; k--) blu.push(makeRenderTarget(Math.max(2, Math.round(w / 2 ** k)), Math.max(2, Math.round(h / 2 ** k))));
        }
        const r = frame.renderer;
        r.setRenderTarget(sceneRT);
        r.setClearColor(0x000000, 1);
        r.clear();
        r.render(scene, camera);

        // bloom
        const glowK = num(p, 'glow', 1);
        brightMat.uniforms.tSrc.value = sceneRT.texture;
        (brightMat.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
        brightMat.uniforms.uThr.value = 0.75;
        brightQuad.render(r, blm[0]);
        for (let k = 1; k < 4; k++) {
          downMat.uniforms.tSrc.value = blm[k - 1].texture;
          (downMat.uniforms.uTexel.value as THREE.Vector2).set(1 / blm[k - 1].width, 1 / blm[k - 1].height);
          downQuad.render(r, blm[k]);
        }
        let src = blm[3];
        for (let k = 0; k < 3; k++) {
          upMat.uniforms.tSrc.value = src.texture;
          upMat.uniforms.tAdd.value = blm[2 - k].texture;
          (upMat.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
          upQuad.render(r, blu[k]);
          src = blu[k];
        }

        // where the light at the end of the avenue sits on screen
        vp.copy(lightDir).multiplyScalar(400).add(camera.position).project(camera);
        const cu = compMat.uniforms;
        cu.tScene.value = sceneRT.texture;
        cu.tBloom.value = blu[2].texture;
        (cu.uVP.value as THREE.Vector2).set(vp.x * 0.5 + 0.5, vp.y * 0.5 + 0.5);
        cu.uBloomK.value = glowK * 0.16 * (1 + 0.5 * kickS + 0.2 * gEnv);
        cu.uGlowK.value = glowK * (1 + 0.25 * kickS + 0.15 * gEnv + 0.3 * tension);
        linColor(pal.bg, cu.uGlowTint.value as THREE.Vector3).multiplyScalar(sunI);
        col.copy(pal.accent2).lerp(pal.fg, 0.25);
        (cu.uShade.value as THREE.Vector3).set(col.r, col.g, col.b).divideScalar(Math.max(col.r, col.g, col.b, 0.01));
        cu.uExposure.value = 0.92 * (1 + 0.05 * kickS + 0.04 * gEnv);
        cu.uGrain.value = num(p, 'grain', 0.02);
        cu.uPaint.value = num(p, 'paint', 0.8);
        cu.uSat.value = 1.18;
        syncMaterial(compMat, frame, params);
        compQuad.render(r, target);
      },
      dispose() {
        sceneRT?.dispose();
        for (const t of blm) t.dispose();
        for (const t of blu) t.dispose();
        skyMesh.geometry.dispose();
        groundGeo.dispose();
        cyl.dispose();
        segGeo.dispose();
        quad.dispose();
        dabGeo.dispose();
        leafGeo.dispose();
        for (const m of [skyMat, groundMat, barkMat, dabMat, leafMat, brightMat, downMat, upMat, compMat]) m.dispose();
        brightQuad.dispose();
        downQuad.dispose();
        upQuad.dispose();
        compQuad.dispose();
      },
    };
  },
};
