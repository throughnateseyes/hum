/**
 * Draws the picture between two frames of a clip (optical flow, in fragment shaders; no model).
 *
 *   match(a, b)          works out where every part of frame a went in frame b, and back again. Both
 *                        frames are shrunk to a ladder of small pictures; at the smallest every point
 *                        is looked for over a wide range, and each larger one keeps the best of what its
 *                        neighbours found and sharpens it. It is done once per pair of frames.
 *   between(a, b, k)     the picture a share k of the way from a to b. For every point of it the passes
 *                        ask which motion goes through there at that moment (the ones found near it are
 *                        tried, and the one the two frames agree on best is kept), pull both frames
 *                        along it, and mix them: the nearer frame more, and a frame in which that spot is
 *                        hidden behind something not at all. Where no motion fits, the two frames are
 *                        softly mixed as they are. If the frames as a whole don't belong together (a cut
 *                        inside the clip) the nearer one is shown.
 *
 * Both directions live in one texture (rg: a to b, ba: b to a), so each step of the ladder is one draw.
 * Motion is counted in pixels of the largest small picture (px0).
 */
import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../core/glsl';

/** the longest side of the largest small picture the motion is worked out on */
export const FLOW_SIDE = 512;
/** for a clip with very many frames a second: there is little motion between two, and little time to work it out */
const FLOW_SIDE_FAST = 288;
/** steps of the ladder at most (each half the size of the last) */
const LEVELS = 6;

const HEAD = /* glsl */ `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
`;

const COPY = `${HEAD} uniform sampler2D tMap; void main() { gl_FragColor = vec4(texture2D(tMap, vUv).rgb, 1.0); }`;

/** both frames, small: brightness and a little colour of a in rg, of b in ba */
const SHRINK = /* glsl */ `${HEAD}
uniform sampler2D tA, tB;
uniform vec2 uStep;
vec2 feat(vec3 c) { return vec2(dot(c, vec3(0.299, 0.587, 0.114)), (c.r - c.b) * 0.35); }
void main() {
  vec3 a = vec3(0.0), b = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 o = (vec2(float(i), float(j)) - 1.5) * 0.36 * uStep;
    a += texture2D(tA, vUv + o).rgb;
    b += texture2D(tB, vUv + o).rgb;
  }
  gl_FragColor = vec4(feat(a / 16.0), feat(b / 16.0));
}
`;

const HALVE = /* glsl */ `${HEAD}
uniform sampler2D tP;
uniform vec2 uStep;
void main() {
  vec4 s = vec4(0.0);
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) s += texture2D(tP, vUv + (vec2(float(i), float(j)) - 0.5) * 1.5 * uStep);
  gl_FragColor = s * 0.25;
}
`;

/** what is matched: each frame with the brightness round each point mostly taken out (a light that changes is not motion) */
const DETAIL = /* glsl */ `${HEAD}
uniform sampler2D tP;
uniform vec2 uTexel;
void main() {
  vec4 s = vec4(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) s += texture2D(tP, vUv + vec2(float(i), float(j)) * 1.7 * uTexel);
  gl_FragColor = texture2D(tP, vUv) - s / 9.0 * 0.75;
}
`;

/** one frame's detail, its slope across and up, and its colour detail */
const SLOPE = /* glsl */ `${HEAD}
uniform sampler2D tD;
uniform vec2 uTexel;
uniform float uDir;
vec2 at(vec2 o) { vec4 c = texture2D(tD, vUv + o * uTexel); return uDir < 0.5 ? c.rg : c.ba; }
void main() {
  vec2 c = at(vec2(0.0));
  float x = at(vec2(1.0, 0.0)).x - at(vec2(-1.0, 0.0)).x;
  float y = at(vec2(0.0, 1.0)).x - at(vec2(0.0, -1.0)).x;
  gl_FragColor = vec4(c.x, x * 0.5, y * 0.5, c.y);
}
`;

const PATCH = /* glsl */ `
uniform sampler2D tD;
uniform vec2 uTexel, uPx0;
vec2 pick(vec4 c, int dir) { return dir == 0 ? c.rg : c.ba; }
float outside(vec2 uv) { vec2 d = max(-uv, uv - 1.0); return max(0.0, max(d.x, d.y)); }
// how unlike the patch here and the patch a motion away are (thirteen points of a five by five square)
float costOf(vec2 uv, vec2 f, int dir) {
  vec2 q = uv + f * uPx0;
  float s = 0.0;
  for (int k = 0; k < 13; k++) {
    int n = k * 2;
    vec2 o = vec2(float(n - (n / 5) * 5) - 2.0, float(n / 5) - 2.0) * uTexel;
    vec2 d = pick(texture2D(tD, q + o), 1 - dir) - pick(texture2D(tD, uv + o), dir);
    s += abs(d.x) + abs(d.y);
  }
  // of two fits as good as each other the shorter motion is the likely one (stripes, railings, rows of lamps)
  return s / 13.0 + outside(q) * 4.0 + length(f) * 0.0001;
}
`;

/** keep the best of what a point and its neighbours found one step smaller; at the smallest, look widely */
const SEARCH = /* glsl */ `${HEAD}
${PATCH}
uniform sampler2D tPrior;
uniform vec2 uPriorStep;
uniform float uWide, uLevelPx;
vec2 best(int dir) {
  vec2 f = uWide > 0.5 ? vec2(0.0) : pick(texture2D(tPrior, vUv), dir);
  float c = costOf(vUv, f, dir);
  if (uWide > 0.5) {
    for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
      vec2 g = vec2(float(i), float(j)) * uLevelPx;
      float k = costOf(vUv, g, dir) + length(vec2(float(i), float(j))) * 0.0015;
      if (k < c) { c = k; f = g; }
    }
  } else {
    for (int i = 0; i < 8; i++) {
      vec2 o = i < 4 ? vec2(float(i - (i / 2) * 2) * 2.0 - 1.0, float(i / 2) * 2.0 - 1.0) : (i < 6 ? vec2(float(i - 4) * 2.0 - 1.0, 0.0) : vec2(0.0, float(i - 6) * 2.0 - 1.0)) * 2.0;
      vec2 g = pick(texture2D(tPrior, vUv + o * uPriorStep), dir);
      float k = costOf(vUv, g, dir) + 0.0008;
      if (k < c) { c = k; f = g; }
    }
    // standing still is always worth trying: signs and buildings behind a moving crowd
    float z = costOf(vUv, vec2(0.0), dir) + 0.0012;
    if (z < c) f = vec2(0.0);
  }
  return f;
}
void main() { gl_FragColor = vec4(best(0), best(1)); }
`;

/** sharpen each point's motion to a fraction of a pixel (a few weighted Lucas-Kanade steps) */
const REFINE = /* glsl */ `${HEAD}
${PATCH}
uniform sampler2D tFlow, tSa, tSb;
uniform float uLevelPx;
vec2 sharpen(int dir) {
  vec2 f0 = pick(texture2D(tFlow, vUv), dir);
  vec4 me = dir == 0 ? texture2D(tSa, vUv) : texture2D(tSb, vUv);
  vec2 f = f0;
  for (int it = 0; it < 3; it++) {
    vec2 q = vUv + f * uPx0;
    // held a little to where it started, so flat surfaces keep their neighbours' motion
    const float lam = 0.012;
    float a = lam, b = 0.0, c = lam;
    vec2 r = (f - f0) / uLevelPx * lam;
    for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
      vec2 o = vec2(float(i), float(j)) * uTexel;
      vec4 t = dir == 0 ? texture2D(tSa, vUv + o) : texture2D(tSb, vUv + o);
      float d = pick(texture2D(tD, q + o), 1 - dir).x - t.x;
      // a point that fits badly, or that looks like something else than the middle, counts less
      float w = exp(-float(i * i + j * j) * 0.12 - abs(t.x - me.x) * 5.0 - abs(t.w - me.w) * 5.0) / (abs(d) + 0.02);
      a += w * t.y * t.y;
      b += w * t.y * t.z;
      c += w * t.z * t.z;
      r += w * d * t.yz;
    }
    float det = max(1e-7, a * c - b * b);
    f += clamp(-vec2(c * r.x - b * r.y, a * r.y - b * r.x) / det, -1.0, 1.0) * uLevelPx;
  }
  f = f0 + clamp(f - f0, -2.0 * uLevelPx, 2.0 * uLevelPx);
  return costOf(vUv, f, dir) < costOf(vUv, f0, dir) ? f : f0;
}
void main() { gl_FragColor = vec4(sharpen(0), sharpen(1)); }
`;

/** throw out odd ones: each point takes the neighbour's motion its alike neighbours agree on most */
const MEDIAN = /* glsl */ `${HEAD}
uniform sampler2D tFlow, tP;
uniform vec2 uTexel;
void main() {
  vec4 f[9];
  vec4 p[9];
  int n = 0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 o = vec2(float(i), float(j)) * uTexel; f[n] = texture2D(tFlow, vUv + o); p[n] = texture2D(tP, vUv + o); n++; }
  vec4 outF = f[4];
  for (int dir = 0; dir < 2; dir++) {
    float bestS = 1e9;
    vec2 bestF = vec2(0.0);
    for (int i = 0; i < 9; i++) {
      vec2 fi = dir == 0 ? f[i].rg : f[i].ba;
      float s = 0.0;
      for (int k = 0; k < 9; k++) {
        vec2 fk = dir == 0 ? f[k].rg : f[k].ba;
        vec2 dp = dir == 0 ? p[k].rg - p[4].rg : p[k].ba - p[4].ba;
        s += exp(-(abs(dp.x) + abs(dp.y)) * 8.0) * length(fi - fk);
      }
      if (i == 4) s *= 0.92;
      if (s < bestS) { bestS = s; bestF = fi; }
    }
    if (dir == 0) outF.rg = bestF; else outF.ba = bestF;
  }
  gl_FragColor = outF;
}
`;

/** even the motion out within surfaces that look alike and move alike */
const SMOOTH = /* glsl */ `${HEAD}
uniform sampler2D tFlow, tP;
uniform vec2 uTexel;

void main() {
  vec4 f0 = texture2D(tFlow, vUv);
  vec4 p0 = texture2D(tP, vUv);
  vec4 sum = f0;
  vec2 w = vec2(1.0);
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    if (i == 0 && j == 0) continue;
    vec2 o = vec2(float(i), float(j)) * uTexel;
    vec4 f = texture2D(tFlow, vUv + o);
    vec4 d = abs(texture2D(tP, vUv + o) - p0);
    vec2 dl = vec2(d.x + d.y, d.z + d.w);
    vec2 df = vec2(length(f.rg - f0.rg), length(f.ba - f0.ba));
    vec2 k = exp(-dl * 14.0 - df * df * 0.5 - float(i * i + j * j) * 0.15);
    sum += f * k.xxyy;
    w += k;
  }
  gl_FragColor = sum / w.xxyy;
}
`;

/** how far the two directions disagree (r: at a's points, g: at b's); over the whole picture, how well it fits (b) and agrees (a), for spotting a cut */
const TRUST = /* glsl */ `${HEAD}
uniform sampler2D tFlow, tP;
uniform vec2 uPx0;
void main() {
  vec4 f = texture2D(tFlow, vUv);
  vec2 qa = vUv + f.rg * uPx0;
  vec2 qb = vUv + f.ba * uPx0;
  float ea = length(f.rg + texture2D(tFlow, qa).ba);
  float eb = length(f.ba + texture2D(tFlow, qb).rg);
  vec4 p = texture2D(tP, vUv);
  float da = dot(abs(p.rg - texture2D(tP, qa).ba), vec2(1.0));
  float db = dot(abs(p.ba - texture2D(tP, qb).rg), vec2(1.0));
  float tol = 1.0 + 0.08 * (length(f.rg) + length(f.ba)) * 0.5;
  float fit = (1.0 - smoothstep(0.05, 0.16, da)) * 0.5 + (1.0 - smoothstep(0.05, 0.16, db)) * 0.5;
  float agree = 0.5 * exp(-ea * ea / (tol * tol * 4.0)) + 0.5 * exp(-eb * eb / (tol * tol * 4.0));
  gl_FragColor = vec4(ea / tol, eb / tol, fit, agree);
}
`;

/**
 * A point only one frame can see (something covers it in the other) found no true match. It takes the
 * motion of the points near it that did and look like it: what is being covered moves with the rest of itself.
 */
const FILL = /* glsl */ `${HEAD}
uniform sampler2D tFlow, tP, tTrust;
uniform vec2 uTexel;
vec2 pick(vec4 c, int dir) { return dir == 0 ? c.rg : c.ba; }
vec2 fill(int dir, vec2 own, float bad) {
  vec2 me = pick(texture2D(tP, vUv), dir);
  vec2 best = own;
  float top = 0.0;
  for (int r = 0; r < 5; r++) {
    float s = r == 0 ? 2.0 : r == 1 ? 4.5 : r == 2 ? 8.0 : r == 3 ? 14.0 : 24.0;
    for (int i = 0; i < 12; i++) {
      float an = (float(i) + 0.5 * float(r)) * 0.5235988;
      vec2 q = vUv + vec2(cos(an), sin(an)) * s * uTexel;
      vec4 t = texture2D(tTrust, q);
      float e = dir == 0 ? t.r : t.g;
      vec2 d = abs(pick(texture2D(tP, q), dir) - me);
      float w = exp(-e * e) * exp(-(d.x + d.y) * 9.0) / (4.0 + s);
      if (w > top) { top = w; best = pick(texture2D(tFlow, q), dir); }
    }
  }
  vec2 sum = vec2(0.0);
  float n = 0.0;
  for (int r = 0; r < 5; r++) {
    float s = r == 0 ? 2.0 : r == 1 ? 4.5 : r == 2 ? 8.0 : r == 3 ? 14.0 : 24.0;
    for (int i = 0; i < 12; i++) {
      float an = (float(i) + 0.5 * float(r)) * 0.5235988;
      vec2 q = vUv + vec2(cos(an), sin(an)) * s * uTexel;
      vec4 t = texture2D(tTrust, q);
      float e = dir == 0 ? t.r : t.g;
      vec2 d = abs(pick(texture2D(tP, q), dir) - me);
      vec2 f = pick(texture2D(tFlow, q), dir);
      float w = exp(-e * e) * exp(-(d.x + d.y) * 9.0) / (4.0 + s) * exp(-dot(f - best, f - best) * 0.4);
      sum += f * w;
      n += w;
    }
  }
  if (n < 1e-5) return own;
  return mix(own, sum / n, bad);
}
void main() {
  vec4 f = texture2D(tFlow, vUv);
  vec4 t = texture2D(tTrust, vUv);
  vec2 bad = smoothstep(vec2(1.0), vec2(2.0), t.rg);
  if (bad.x > 0.01) f.rg = fill(0, f.rg, bad.x);
  if (bad.y > 0.01) f.ba = fill(1, f.ba, bad.y);
  gl_FragColor = f;
}
`;

const MEAN = /* glsl */ `${HEAD}
uniform sampler2D tMap;
void main() {
  vec4 s = vec4(0.0);
  for (int j = 0; j < 12; j++) for (int i = 0; i < 16; i++) s += texture2D(tMap, (vec2(float(i), float(j)) + 0.5) / vec2(16.0, 12.0));
  gl_FragColor = s / 192.0;
}
`;

/**
 * The motion through each point at moment k, on the small picture. Every motion found near the point
 * (by either frame) is tried: followed back to a and on to b, do both frames show the same thing there,
 * and did they find that motion themselves?  rg: the motion (a to b), ba: how far a and b can be trusted here.
 */
const MOMENT = /* glsl */ `${HEAD}
uniform sampler2D tFlow, tP;
uniform vec2 uPx0;
uniform float uK;
vec2 bestV;
float bestC;
vec2 bestW;
void tryV(vec2 v, float extra) {
  vec2 pa = vUv - v * uK * uPx0;
  vec2 pb = vUv + v * (1.0 - uK) * uPx0;
  vec4 fa = texture2D(tFlow, pa);
  vec4 fb = texture2D(tFlow, pb);
  vec2 ia = texture2D(tP, pa).rg;
  vec2 ib = texture2D(tP, pb).ba;
  float tol = 1.0 + 0.06 * length(v);
  float ea = length(fa.rg - v) / tol;
  float eb = length(fb.ba + v) / tol;
  float wa = exp(-ea * ea);
  float wb = exp(-eb * eb);
  vec2 oa = max(-pa, pa - 1.0), ob = max(-pb, pb - 1.0);
  if (max(oa.x, oa.y) > 0.0) wa *= 0.02;
  if (max(ob.x, ob.y) > 0.0) wb *= 0.02;
  float diff = dot(abs(ia - ib), vec2(1.0));
  // seen in both frames: they have to look alike. Seen in one only: allowed, at a price.
  float both = min(wa, wb);
  float one = max(wa, wb);
  float c = diff * (0.35 + 0.65 * both) + (1.0 - one) * 0.6 + (1.0 - both) * 0.1 + extra;
  if (c < bestC) { bestC = c; bestV = v; bestW = vec2(wa, wb); }
}
void main() {
  bestC = 1e9; bestV = vec2(0.0); bestW = vec2(0.0);
  vec4 f0 = texture2D(tFlow, vUv);
  // the motions found here, and where those motions came from
  tryV(f0.rg, 0.0);
  tryV(-f0.ba, 0.0);
  vec2 v = f0.rg;
  for (int i = 0; i < 3; i++) v = texture2D(tFlow, vUv - v * uK * uPx0).rg;
  tryV(v, 0.0);
  v = -f0.ba;
  for (int i = 0; i < 3; i++) v = -texture2D(tFlow, vUv + v * (1.0 - uK) * uPx0).ba;
  tryV(v, 0.0);
  // and the ones round about: something fast may be passing through from a way off
  for (int r = 0; r < 4; r++) {
    float s = r == 0 ? 2.0 : r == 1 ? 5.0 : r == 2 ? 11.0 : 24.0;
    for (int i = 0; i < 8; i++) {
      float an = (float(i) + 0.5 * float(r)) * 0.7853982;
      vec2 o = vec2(cos(an), sin(an)) * s * uPx0;
      vec4 f = texture2D(tFlow, vUv + o);
      tryV(f.rg, 0.003);
      tryV(-f.ba, 0.003);
    }
  }
  gl_FragColor = vec4(bestV, bestW);
}
`;

/** odd ones out of the motion at a moment, on the same footing */
const MOMENT_MEDIAN = /* glsl */ `${HEAD}
uniform sampler2D tFlow;
uniform vec2 uTexel;
void main() {
  vec4 f[9];
  int n = 0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { f[n] = texture2D(tFlow, vUv + vec2(float(i), float(j)) * uTexel); n++; }
  float bestS = 1e9;
  int at = 4;
  for (int i = 0; i < 9; i++) {
    float s = 0.0;
    for (int k = 0; k < 9; k++) s += length(f[i].rg - f[k].rg) * (0.15 + max(f[k].b, f[k].a));
    if (i == 4) s *= 0.9;
    if (s < bestS) { bestS = s; at = i; }
  }
  gl_FragColor = f[at];
}
`;

/** the motion round about, at a coarse size (rg: motion times weight, b: weight), and how torn it is there (a) */
const ROUGH = /* glsl */ `${HEAD}
uniform sampler2D tFlow;
uniform vec2 uTexel;
void main() {
  vec4 o = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 q = vUv + (vec2(float(i), float(j)) - 1.5) * 2.0 * uTexel;
    vec4 f = texture2D(tFlow, q);
    vec2 dx = texture2D(tFlow, q + vec2(uTexel.x, 0.0)).rg - f.rg;
    vec2 dy = texture2D(tFlow, q + vec2(0.0, uTexel.y)).rg - f.rg;
    float torn = min(1.0, (length(dx) + length(dy)) / 2.0);
    float sure = max(f.b, f.a);
    float w = sure * (1.0 - torn) + 1e-3;
    o += vec4(f.rg * w, w, max(torn, 1.0 - sure));
  }
  gl_FragColor = o / 16.0;
}
`;

const SPREAD = /* glsl */ `${HEAD}
uniform sampler2D tMap;
uniform vec2 uTexel;
void main() {
  vec4 s = vec4(0.0);
  float n = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    float w = exp(-float(i * i + j * j) * 0.35);
    s += texture2D(tMap, vUv + vec2(float(i), float(j)) * uTexel) * w;
    n += w;
  }
  gl_FragColor = s / n;
}
`;

/** pull both frames to the moment and mix them, full size */
const COMPOSE = /* glsl */ `${HEAD}
uniform sampler2D tA, tB, tMoment, tTrust, tLow;
uniform vec2 uPx0, uTexel;
uniform float uK, uPlain;
// a sharp read between pixels (Catmull-Rom in nine taps): a soft one would pulse against the source frames
vec3 sharp(sampler2D tex, vec2 uv) {
  vec2 p = uv / uTexel;
  vec2 c = floor(p - 0.5) + 0.5;
  vec2 f = p - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (c - 1.0) * uTexel, t3 = (c + 2.0) * uTexel, t12 = (c + w2 / w12) * uTexel;
  vec3 s = texture2D(tex, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y)
    + texture2D(tex, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y)
    + texture2D(tex, t12).rgb * (w12.x * w12.y)
    + texture2D(tex, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
    + texture2D(tex, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
  float w = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return clamp(s / w, 0.0, 1.0);
}
void main() {
  vec4 all = texture2D(tTrust, vec2(0.5));
  vec3 a0 = texture2D(tA, vUv).rgb;
  vec3 b0 = texture2D(tB, vUv).rgb;
  if (uPlain > 0.5) { gl_FragColor = vec4(mix(a0, b0, uK), 1.0); return; }
  // a cut inside the clip (two frames that fit nowhere, measured 0.05 and under; the wildest real motion, 0.4)
  if (all.b * all.a < 0.15) { gl_FragColor = vec4(uK < 0.5 ? a0 : b0, 1.0); return; }
  vec4 m = texture2D(tMoment, vUv);
  vec3 a = sharp(tA, vUv - m.rg * uK * uPx0);
  vec3 b = sharp(tB, vUv + m.rg * (1.0 - uK) * uPx0);
  float wa = (1.0 - uK) * (m.b + 1e-3);
  float wb = uK * (m.a + 1e-3);
  vec3 moved = a * wa + b * wb;
  float n = wa + wb;
  moved /= n;
  // where two motions meet, the ones either side are mixed in, so the seam is soft rather than torn
  vec3 sum = moved;
  float sn = 1.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(float(i - (i / 2) * 2) * 2.0 - 1.0, float(i / 2) * 2.0 - 1.0) * 1.5 * uPx0;
    vec4 q = texture2D(tMoment, vUv + o);
    vec2 dv = q.rg - m.rg;
    float far = smoothstep(0.15, 1.0, length(dv));
    if (far < 0.01) continue;
    float qa = (1.0 - uK) * (q.b + 1e-3), qb = uK * (q.a + 1e-3);
    vec3 c = (texture2D(tA, vUv - q.rg * uK * uPx0).rgb * qa + texture2D(tB, vUv + q.rg * (1.0 - uK) * uPx0).rgb * qb) / (qa + qb);
    float w = far * 0.7 * max(q.b, q.a);
    sum += c * w;
    sn += w;
  }
  moved = sum / sn;
  // where no motion fits for a way around, a soft mix that rides along with the picture
  vec4 low = texture2D(tLow, vUv);
  vec2 lv = low.rg / max(1e-4, low.b);
  vec3 soft = mix(texture2D(tA, vUv - lv * uK * uPx0).rgb, texture2D(tB, vUv + lv * (1.0 - uK) * uPx0).rgb, uK);
  float sure = 1.0 - smoothstep(0.28, 0.5, low.a);
  gl_FragColor = vec4(mix(soft, moved, sure), 1.0);
}
`;

const mat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
const v2 = () => ({ value: new THREE.Vector2() });
const tex = () => ({ value: null as THREE.Texture | null });
const half = (w: number, h: number) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });

/** can this renderer draw into half-float targets? */
export function canFlow(r: THREE.WebGLRenderer): boolean {
  return r.extensions.has('EXT_color_buffer_half_float') || r.extensions.has('EXT_color_buffer_float');
}

/** one step of the ladder */
interface Level {
  w: number;
  h: number;
  pair: THREE.WebGLRenderTarget;
  detail: THREE.WebGLRenderTarget;
  slopeA: THREE.WebGLRenderTarget;
  slopeB: THREE.WebGLRenderTarget;
  flow: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
}

/** the motion between two frames, worked out */
interface Match {
  key: string;
  flow: THREE.WebGLRenderTarget;
  pair: THREE.WebGLRenderTarget;
  mean: THREE.WebGLRenderTarget;
  /** what is left to do, in order; empty once it is ready */
  left: (() => void)[];
  used: number;
}

/** everything kept for clips of one shape */
interface Desk {
  w: number;
  h: number;
  levels: Level[];
  trust: THREE.WebGLRenderTarget;
  moment: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  low: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  matches: Match[];
  used: number;
}

/** two frames to work between; `key` names the pair */
export interface Pair {
  key: string;
  a: THREE.Texture;
  b: THREE.Texture;
  /** the frames' size */
  w: number;
  h: number;
  /** a clip with very many frames a second */
  fast: boolean;
}

/** pairs worked out and kept: the one on screen, the next, and the same for the other look in a transition */
const KEPT = 4;
const DESKS = 2;

export class FlowPass {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: THREE.Mesh;
  private readonly m = {
    copy: mat(COPY, { tMap: tex() }),
    shrink: mat(SHRINK, { tA: tex(), tB: tex(), uStep: v2() }),
    halve: mat(HALVE, { tP: tex(), uStep: v2() }),
    detail: mat(DETAIL, { tP: tex(), uTexel: v2() }),
    slope: mat(SLOPE, { tD: tex(), uTexel: v2(), uDir: { value: 0 } }),
    search: mat(SEARCH, { tD: tex(), tPrior: tex(), uTexel: v2(), uPx0: v2(), uPriorStep: v2(), uWide: { value: 0 }, uLevelPx: { value: 1 } }),
    refine: mat(REFINE, { tD: tex(), tSa: tex(), tSb: tex(), tFlow: tex(), uTexel: v2(), uPx0: v2(), uLevelPx: { value: 1 } }),
    median: mat(MEDIAN, { tP: tex(), tFlow: tex(), uTexel: v2() }),
    smooth: mat(SMOOTH, { tP: tex(), tFlow: tex(), uTexel: v2() }),
    trust: mat(TRUST, { tP: tex(), tFlow: tex(), uPx0: v2() }),
    mean: mat(MEAN, { tMap: tex() }),
    fill: mat(FILL, { tP: tex(), tFlow: tex(), tTrust: tex(), uTexel: v2() }),
    moment: mat(MOMENT, { tP: tex(), tFlow: tex(), uPx0: v2(), uK: { value: 0.5 } }),
    momentMedian: mat(MOMENT_MEDIAN, { tFlow: tex(), uTexel: v2() }),
    rough: mat(ROUGH, { tFlow: tex(), uTexel: v2() }),
    spread: mat(SPREAD, { tMap: tex(), uTexel: v2() }),
    compose: mat(COMPOSE, { tA: tex(), tB: tex(), tMoment: tex(), tTrust: tex(), tLow: tex(), uPx0: v2(), uTexel: v2(), uK: { value: 0 }, uPlain: { value: 0 } }),
  };
  private desks: Desk[] = [];
  private outs: { rt: THREE.WebGLRenderTarget; used: number }[] = [];
  /** the pair being worked out a little at a time (the ladder is shared, so only one is ever under way) */
  private busy: { desk: Desk; match: Match } | null = null;
  private clock = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.m.copy);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  private draw(m: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
    this.mesh.material = m;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  /** copy a picture into a target */
  copy(from: THREE.Texture, to: THREE.WebGLRenderTarget) {
    const was = this.renderer.getRenderTarget();
    this.m.copy.uniforms.tMap.value = from;
    this.draw(this.m.copy, to);
    this.renderer.setRenderTarget(was);
  }

  private desk(p: Pair): Desk {
    const k = Math.min(1, (p.fast ? FLOW_SIDE_FAST : FLOW_SIDE) / Math.max(p.w, p.h));
    const w = Math.max(8, Math.round(p.w * k));
    const h = Math.max(8, Math.round(p.h * k));
    const had = this.desks.find((d) => d.w === w && d.h === h);
    if (had) {
      had.used = ++this.clock;
      return had;
    }
    if (this.desks.length >= DESKS) {
      const old = this.desks.reduce((x, y) => (x.used < y.used ? x : y));
      this.desks.splice(this.desks.indexOf(old), 1);
      this.drop(old);
    }
    const levels: Level[] = [];
    for (let l = 0; l < LEVELS; l++) {
      const lw = Math.round(w / 2 ** l);
      const lh = Math.round(h / 2 ** l);
      if (l > 0 && Math.min(lw, lh) < 6) break;
      levels.push({ w: lw, h: lh, pair: half(lw, lh), detail: half(lw, lh), slopeA: half(lw, lh), slopeB: half(lw, lh), flow: [half(lw, lh), half(lw, lh)] });
    }
    const cw = Math.max(4, Math.round(w / 8));
    const ch = Math.max(4, Math.round(h / 8));
    const made: Desk = { w, h, levels, trust: half(w, h), moment: [half(w, h), half(w, h)], low: [half(cw, ch), half(cw, ch)], matches: [], used: ++this.clock };
    this.desks.push(made);
    return made;
  }

  private drop(d: Desk) {
    if (this.busy?.desk === d) this.busy = null;
    for (const l of d.levels) for (const t of [l.pair, l.detail, l.slopeA, l.slopeB, ...l.flow]) t.dispose();
    for (const m of d.matches) for (const t of [m.flow, m.pair, m.mean]) t.dispose();
    for (const t of [d.trust, ...d.moment, ...d.low]) t.dispose();
  }

  /** is this pair's motion worked out? */
  ready(p: Pair): boolean {
    return this.desks.some((d) => d.matches.some((m) => m.key === p.key && !m.left.length));
  }

  private start(p: Pair): { desk: Desk; match: Match } {
    const desk = this.desk(p);
    let match = desk.matches.find((m) => m.key === p.key);
    if (match && (!match.left.length || this.busy?.match === match)) return { desk, match };
    // one at a time: a pair left half way is begun again when it is wanted
    if (this.busy) {
      this.busy.match.key = '';
      this.busy = null;
    }
    if (!match) {
      if (desk.matches.length < KEPT) {
        match = { key: '', flow: half(desk.w, desk.h), pair: half(desk.w, desk.h), mean: half(1, 1), left: [], used: 0 };
        desk.matches.push(match);
      } else match = desk.matches.reduce((x, y) => (x.used < y.used ? x : y));
    }
    match.key = p.key;
    match.used = ++this.clock;
    match.left = this.steps(desk, match, p);
    this.busy = { desk, match };
    return this.busy;
  }

  private run(match: Match, most: number) {
    const was = this.renderer.getRenderTarget();
    for (let i = 0; i < most && match.left.length; i++) match.left.shift()!();
    this.renderer.setRenderTarget(was);
    if (!match.left.length && this.busy?.match === match) this.busy = null;
  }

  /** get a little further with a pair that is coming up (a few frames' work in all) */
  ahead(p: Pair) {
    if (this.ready(p)) return;
    if (this.busy && this.busy.match.key !== p.key) {
      this.run(this.busy.match, 1);
      return;
    }
    this.run(this.start(p).match, 1);
  }

  /** work a pair out now */
  match(p: Pair) {
    const { match } = this.start(p);
    match.used = ++this.clock;
    if (match.left.length) this.run(match, 99);
  }

  /** the work of matching a pair, in pieces of about a frame's spare time each */
  private steps(desk: Desk, match: Match, p: Pair): (() => void)[] {
    const { m } = this;
    const { levels } = desk;
    const px0 = new THREE.Vector2(1 / desk.w, 1 / desk.h);
    const pairOf = (l: number) => (l === 0 ? match.pair : levels[l].pair);
    const set = (mm: THREE.ShaderMaterial, l: number) => {
      const u = mm.uniforms;
      const lv = levels[l];
      if (u.tP) u.tP.value = pairOf(l).texture;
      if (u.tD) u.tD.value = lv.detail.texture;
      if (u.tSa) u.tSa.value = lv.slopeA.texture;
      if (u.tSb) u.tSb.value = lv.slopeB.texture;
      (u.uTexel?.value as THREE.Vector2 | undefined)?.set(1 / lv.w, 1 / lv.h);
      (u.uPx0?.value as THREE.Vector2 | undefined)?.copy(px0);
      if (u.uLevelPx) u.uLevelPx.value = desk.w / lv.w;
    };
    /** one pass over a level's motion: reads flow[from], writes the other */
    const over = (mm: THREE.ShaderMaterial, l: number, from: 0 | 1) => {
      set(mm, l);
      mm.uniforms.tFlow.value = levels[l].flow[from].texture;
      this.draw(mm, levels[l].flow[from === 0 ? 1 : 0]);
    };
    const search = (l: number, again: boolean) => {
      const lv = levels[l];
      const u = m.search.uniforms;
      set(m.search, l);
      const top = l === levels.length - 1 && !again;
      u.uWide.value = top ? 1 : 0;
      const prior = again ? lv : levels[l + 1];
      u.tPrior.value = top ? lv.detail.texture : again ? lv.flow[0].texture : prior.flow[0].texture;
      if (!top) (u.uPriorStep.value as THREE.Vector2).set((again ? 2 : 1) / prior.w, (again ? 2 : 1) / prior.h);
      this.draw(m.search, lv.flow[again ? 1 : 0]);
    };
    const prepare = (l: number) => {
      const lv = levels[l];
      set(m.detail, l);
      this.draw(m.detail, lv.detail);
      set(m.slope, l);
      m.slope.uniforms.uDir.value = 0;
      this.draw(m.slope, lv.slopeA);
      m.slope.uniforms.uDir.value = 1;
      this.draw(m.slope, lv.slopeB);
    };
    const level = (l: number) => {
      prepare(l);
      search(l, false);
      over(m.refine, l, 0);
      over(m.median, l, 1);
      search(l, true);
      over(m.refine, l, 1);
      over(m.median, l, 0);
      over(m.smooth, l, 1);
    };
    return [
      () => {
        const u = m.shrink.uniforms;
        u.tA.value = p.a;
        u.tB.value = p.b;
        (u.uStep.value as THREE.Vector2).copy(px0);
        this.draw(m.shrink, match.pair);
        for (let l = 1; l < levels.length; l++) {
          m.halve.uniforms.tP.value = pairOf(l - 1).texture;
          (m.halve.uniforms.uStep.value as THREE.Vector2).set(1 / levels[l - 1].w, 1 / levels[l - 1].h);
          this.draw(m.halve, levels[l].pair);
        }
        for (let l = levels.length - 1; l >= 2; l--) level(l);
      },
      () => {
        if (levels.length > 1) level(1);
      },
      () => {
        prepare(0);
        search(0, false);
      },
      () => {
        over(m.refine, 0, 0);
        over(m.median, 0, 1);
      },
      () => {
        over(m.smooth, 0, 0);
        over(m.median, 0, 1);
        set(m.trust, 0);
        m.trust.uniforms.tFlow.value = levels[0].flow[0].texture;
        this.draw(m.trust, desk.trust);
        m.mean.uniforms.tMap.value = desk.trust.texture;
        this.draw(m.mean, match.mean);
        set(m.fill, 0);
        m.fill.uniforms.tFlow.value = levels[0].flow[0].texture;
        m.fill.uniforms.tTrust.value = desk.trust.texture;
        this.draw(m.fill, match.flow);
      },
    ];
  }

  /** the picture a share `k` of the way between a pair (`plain`: just the two mixed). Good until the next one is drawn. */
  between(p: Pair, k: number, plain = false): THREE.Texture {
    const was = this.renderer.getRenderTarget();
    const { m } = this;
    const c = m.compose.uniforms;
    if (!plain) {
      const { desk, match } = this.start(p);
      this.match(p);
      const px0 = new THREE.Vector2(1 / desk.w, 1 / desk.h);
      const u = m.moment.uniforms;
      u.tP.value = match.pair.texture;
      u.tFlow.value = match.flow.texture;
      (u.uPx0.value as THREE.Vector2).copy(px0);
      u.uK.value = k;
      this.draw(m.moment, desk.moment[1]);
      m.momentMedian.uniforms.tFlow.value = desk.moment[1].texture;
      (m.momentMedian.uniforms.uTexel.value as THREE.Vector2).copy(px0);
      this.draw(m.momentMedian, desk.moment[0]);
      m.rough.uniforms.tFlow.value = desk.moment[0].texture;
      (m.rough.uniforms.uTexel.value as THREE.Vector2).copy(px0);
      this.draw(m.rough, desk.low[0]);
      m.spread.uniforms.tMap.value = desk.low[0].texture;
      (m.spread.uniforms.uTexel.value as THREE.Vector2).set(1 / desk.low[0].width, 1 / desk.low[0].height);
      this.draw(m.spread, desk.low[1]);
      c.tMoment.value = desk.moment[0].texture;
      c.tTrust.value = match.mean.texture;
      c.tLow.value = desk.low[1].texture;
      (c.uPx0.value as THREE.Vector2).copy(px0);
    }
    c.tA.value = p.a;
    c.tB.value = p.b;
    (c.uTexel.value as THREE.Vector2).set(1 / p.w, 1 / p.h);
    c.uK.value = k;
    c.uPlain.value = plain ? 1 : 0;
    const out = this.outOf(p.w, p.h);
    this.draw(m.compose, out);
    this.renderer.setRenderTarget(was);
    return out.texture;
  }

  private outOf(w: number, h: number): THREE.WebGLRenderTarget {
    let o = this.outs.find((x) => x.rt.width === w && x.rt.height === h);
    if (!o) {
      if (this.outs.length >= DESKS) {
        const old = this.outs.reduce((x, y) => (x.used < y.used ? x : y));
        this.outs.splice(this.outs.indexOf(old), 1);
        old.rt.dispose();
      }
      o = { rt: new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, generateMipmaps: false }), used: 0 };
      this.outs.push(o);
    }
    o.used = ++this.clock;
    return o.rt;
  }

  /** forget what was worked out and let the targets go (the shaders stay) */
  free() {
    for (const d of this.desks) this.drop(d);
    this.desks = [];
    for (const o of this.outs) o.rt.dispose();
    this.outs = [];
    this.busy = null;
  }

  release() {
    this.free();
    for (const x of Object.values(this.m)) x.dispose();
    this.mesh.geometry.dispose();
  }
}
