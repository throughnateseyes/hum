import * as THREE from 'three';
import type { FrameContext, ParamDef, SceneDef, TrackAnalysis } from '../../core/types';
import { num, str } from '../../core/uniforms';
import { BACKDROP_VERT, makeBackdrop, makeMaterial, stepDt, syncMaterial } from '../three/common';

/*
 * Garden: an illustrated garden that the song grows. Flat, bold, hand-made flora in layers: stems
 * that grow and curl, leaves that unfurl, buds that swell, flowers that burst open, berries, sprays
 * and tendrils, with vein lines, dot fills and doodles that draw themselves on.
 *
 * The song is the gardener, and every part of it does something different:
 *   intro      bare ground, a few sprouts with closed buds
 *   verse      stems grow and curl in surges at each phrase, so leaves unfurl on the phrase
 *   chorus     most of it is up; the first flowers open
 *   build      growth hurries, buds swell and tremble, tendrils reach and curl tight, colour holds its breath
 *   drop       everything blooms at once, rippling out from the middle: petals burst open past full and
 *              settle, colour pops, and doodle stars, spirals and sparkles flash on around the blooms
 *   break      slow sway in the wind, petals drifting down, flowers half-closing
 *   outro      it closes up and wilts gently: heads droop, colour fades, the last petals fall
 * Kicks pop the open flowers (half of them on one kick, half on the next), hats twinkle the dot fills,
 * the lead line curls the tendrils (and harmonic tension winds them tighter), the shared wind sways
 * the stems. How grown the garden is depends on where you are in the song, not on how long the look
 * has been on screen, so a video that cuts to it in a chorus finds it in flower.
 *
 * Styles (one look, three treatments; the presets "Botanical / Coral / Doodle Garden"):
 *   botanical  flat bold shapes on a dark ground, two-tone leaves with pale veins, dot-filled petals
 *   coral      blue and white coral and anemone forms on a warm painted ground: rim-shaded fills,
 *              contour stripes, sunburst wheels with zigzag linework, curling tendrils, red scribbles
 *   doodle     glowing marker linework on a dark ground: double-stroke outlines with a soft glow,
 *              faint fills with screen-tone dots, stars and spirals scribbled around it all
 *
 * How it is drawn: every plant is a stem described by a few numbers (base, angle, curvature, tip
 * curl, length) in a small float texture, plus its live state (how grown, how open, kick pop, bend).
 * Vertex shaders integrate the stem's angle along its length, so the stem ribbon, its leaves and its
 * flower all ride the same curve as it grows, sways and droops. Leaves and flowers are instanced
 * quads shaded with signed distance shapes in their own frame (petals by polar repetition, leaf
 * outlines, veins, dot grids), warped by a noise that changes ten times a second so outlines boil
 * like hand animation. Three depth layers, back to front, each fading a little into the ground
 * colour and sliding a little with the depth drift. Doodles are pre-built ribbon strokes whose drawn
 * stretch (tail..head) is animated. Everything blends premultiplied in painter's order.
 *
 * Palette roles: bg = the ground, fg = white petals, pale lines and dots, accent = the main bloom
 * colour, accent2 = the second bloom colour and the marigold centres, muted = foliage. Further inks
 * are mixed from those (an orange between the accents, a pink, a lime, a deep leaf, a vivid tint of
 * the ground for ferns and berries), so Song colours and finishes carry through.
 */

/* ───────────────────────── params ───────────────────────── */

type Variant = 'botanical' | 'coral' | 'doodle';

const params: ParamDef[] = [
  {
    id: 'style',
    label: 'Style',
    group: 'Shape',
    type: 'select',
    options: [
      { value: 'botanical', label: 'Botanical (flat, bold)' },
      { value: 'coral', label: 'Coral (psychedelic linework)' },
      { value: 'doodle', label: 'Doodle (glowing marker)' },
    ],
    default: 'botanical',
  },
  { id: 'density', label: 'Lushness', group: 'Shape', type: 'number', min: 0.5, max: 1.6, step: 0.01, default: 1, hint: 'How many plants share the ground' },
  { id: 'pace', label: 'Growth pace', group: 'Motion', type: 'number', min: 0.4, max: 2, step: 0.01, default: 1, hint: 'How early in the song the garden fills in' },
  { id: 'sway', label: 'Sway', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'The shared wind bends the stems' },
  { id: 'parallax', label: 'Depth drift', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'The layers slide past each other a little' },
  { id: 'bloom', label: 'Drop bloom', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'How hard the petals burst open on the drop' },
  { id: 'pop', label: 'Kick pop', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Open flowers pulse on the kick' },
  { id: 'twinkle', label: 'Dot twinkle', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Hats twinkle the dot fills' },
  { id: 'curl', label: 'Tendril curl', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Tendrils curl with the melody' },
  { id: 'doodles', label: 'Doodles', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Stars, spirals and squiggles that draw themselves on' },
  { id: 'petals', label: 'Falling petals', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Petals drift down in breaks and as it wilts' },
  { id: 'wobble', label: 'Hand wobble', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Outlines boil like hand animation' },
  { id: 'grain', label: 'Paper', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Painted ground and paper grain' },
];

/* ───────────────────────── kinds and inks ───────────────────────── */

// leaf kinds < 10, flower kinds >= 10 (the shader branches on these)
const K = {
  OVATE: 0,
  LANCE: 1,
  HEART: 2,
  FROND: 3,
  BLOB: 4,
  SPIKE: 5,
  ROUND: 6,
  DAISY: 10,
  TULIP: 11,
  STAR: 12,
  CONE: 13,
  BERRY: 14,
  SPRAY: 15,
  ANEMONE: 16,
  BURST: 17,
  CUTE: 18,
  PETAL: 20,
} as const;

// leaf shapes: width / length
const LEAF_AR: Record<number, number> = { 0: 0.46, 1: 0.24, 2: 0.95, 3: 0.62, 4: 0.8, 5: 0.13, 6: 0.86 };

// inks, mixed from the palette every frame (see inkMix)
const I = { BG: 0, FG: 1, AC: 2, AC2: 3, MU: 4, ORANGE: 5, PINK: 6, LIME: 7, DEEP: 8, VIVID: 9, PALE: 10, DARK: 11 } as const;
const N_INK = 12;

/** the treatment each style gives the shapes */
const TREAT: Record<Variant, { fill: number; tint: number; line: number; core: number; glow: number; rim: number; contour: number; halftone: number; pad: number; dGlow: number }> = {
  botanical: { fill: 1, tint: 1, line: 0, core: 0, glow: 0, rim: 0.12, contour: 0, halftone: 0, pad: 0, dGlow: 0.35 },
  coral: { fill: 1, tint: 1, line: 0.5, core: 0, glow: 0, rim: 0.9, contour: 1, halftone: 0, pad: 0.03, dGlow: 0 },
  doodle: { fill: 0.94, tint: 0.3, line: 1, core: 1, glow: 1, rim: 0, contour: 0, halftone: 1, pad: 0.32, dGlow: 1 },
};

const MAX_DOODLES = 64;

/* ───────────────────────── GLSL ───────────────────────── */

const LIB = /* glsl */ `
uniform sampler2D uPlants;
uniform float uPlantW;
uniform float uCurlMod;
uniform vec2 uPar;
uniform float uBoil, uWobble, uPad;
uniform vec3 uInk[${N_INK}];

vec4 gRow(float id, float r) { return texture2D(uPlants, vec2((id + 0.5) / uPlantW, (r + 0.5) / 4.0)); }

struct Stem { vec2 base; float a0; float L; float k; float curl; float w; float fid; float layer; float seed; float g; float gL; float open; float pop; float bend; };

Stem gRaw(float id) {
  vec4 r0 = gRow(id, 0.0);
  vec4 r1 = gRow(id, 1.0);
  vec4 r2 = gRow(id, 2.0);
  vec4 r3 = gRow(id, 3.0);
  Stem s;
  s.base = r0.xy; s.a0 = r0.z; s.L = r0.w;
  s.k = r1.x; s.curl = r1.y; s.w = r1.z;
  s.fid = r2.y; s.layer = r2.z; s.seed = r2.w;
  s.g = r3.x; s.gL = r3.x * r0.w; s.open = r3.y; s.pop = r3.z; s.bend = r3.w;
  return s;
}

// the stem's heading at arc length d: base angle, steady curvature, the wind's bend (more toward the
// tip), a curl at the tip (tendrils) and, while it grows, a fiddlehead curl that unrolls as it matures
float gAng(Stem s, float d) {
  float u = d / s.L;
  float u2 = u * u;
  float a = s.a0 + s.k * d + s.bend * u2 + s.curl * uCurlMod * u2 * u2;
  float tip = clamp(d / max(s.gL, 1e-4), 0.0, 1.0);
  float t2 = tip * tip;
  a += s.fid * sqrt(max(1.0 - s.g, 0.0)) * t2 * t2 * t2 * 3.0;
  return a;
}

vec2 gPoint(Stem s, float d, out float ang) {
  vec2 p = s.base;
  float ds = d / 12.0;
  for (int i = 0; i < 12; i++) {
    float a = gAng(s, (float(i) + 0.5) * ds);
    p += vec2(cos(a), sin(a)) * ds;
  }
  ang = gAng(s, d);
  return p;
}

// a stem, hung from its parent's stem when it is a branch
Stem gStem(float id) {
  Stem s = gRaw(id);
  float par = gRow(id, 1.0).w;
  if (par >= 0.0) {
    Stem ps = gRaw(par);
    float pa;
    s.base = gPoint(ps, gRow(id, 2.0).x * ps.L, pa);
    s.a0 += pa;
  }
  return s;
}

// world (x across in screen heights, y up from the bottom) to clip, with the layer's depth drift
vec4 gClip(vec2 p, float layer) {
  p += uPar * (0.3 + 0.35 * layer);
  return vec4(p.x / (0.5 * uAspect), p.y * 2.0 - 1.0, 0.0, 1.0);
}
`;

/* stems and tendrils: one ribbon per plant, the visible stretch is its grown length */
const STEM_VERT = /* glsl */ `
${LIB}
attribute vec4 aInfo; // ink, seed, -, -
varying float vSide;
varying float vInk;
varying float vFade;
varying float vU;
void main() {
  float t = position.x;
  float side = position.y;
  Stem s = gStem(position.z);
  vInk = aInfo.x;
  if (s.g < 0.002) { gl_Position = vec4(3.0, 3.0, 0.0, 1.0); vSide = 0.0; vFade = 0.0; vU = 0.0; return; }
  float d = t * s.gL;
  float ang;
  vec2 p = gPoint(s, d, ang);
  vec2 n = vec2(-sin(ang), cos(ang));
  float u = d / s.L;
  float w = s.w * mix(1.0, 0.45, u) * (0.45 + 0.55 * smoothstep(0.0, 0.4, s.g));
  w *= mix(1.0, 0.35, smoothstep(0.82, 1.0, t));
  // pressure: the line swells and thins a little, differently in every drawing
  w *= 0.82 + 0.36 * tnoise(vec2(d * 26.0 + s.seed * 31.0, uBoil * 1.7));
  w = max(w, 1.4 / uResolution.y);
  float pad = 1.0 + uPad * 2.5;
  p += n * side * w * 0.5 * pad;
  p += n * (tnoise(vec2(d * 9.0 + s.seed * 13.0, uBoil * 0.9 + 4.0)) - 0.5) * 0.004 * uWobble;
  vSide = side * pad;
  vU = u;
  vFade = s.layer < 0.5 ? 0.3 : (s.layer < 1.5 ? 0.1 : 0.0);
  gl_Position = gClip(p, s.layer);
}
`;

const LINE_FRAG_LIB = /* glsl */ `
uniform vec3 uInk[${N_INK}];
uniform float uFill, uLine, uCore, uGlow, uGrain, uLineMode;
uniform vec3 uLineC, uCoreC, uGlowC, uRimC;
// a stroke across v (|v| = 1 at its edge): plain ink, a rim-lit tube (coral) or a glowing marker line
vec4 strokeCol(float v, vec3 ink, float pad) {
  float av = abs(v);
  float px = fwidth(v) * 0.9 + 1e-4;
  float body = 1.0 - smoothstep(1.0 - px, 1.0 + px, av);
  vec4 acc = vec4(0.0);
  if (uLineMode > 1.5) {
    // marker: a soft glow, a coloured stroke and a pale core
    float g = exp(-max(av - 1.0, 0.0) / max(pad - 1.0, 0.05) * 2.6) * uGlow * 0.45;
    acc = vec4(uGlowC * g, g);
    vec3 c = mix(uLineC, uCoreC, (1.0 - smoothstep(0.42 - px, 0.42 + px, av)) * uCore);
    acc = vec4(c * body + acc.rgb * (1.0 - body), body + acc.a * (1.0 - body));
  } else if (uLineMode > 0.5) {
    // tube: the ink darkens toward its edges and catches a pale highlight on one side
    vec3 c = mix(ink, ink * 0.62, smoothstep(0.35, 1.0, av));
    float hl = (1.0 - smoothstep(0.12, 0.26, abs(v + 0.42))) * 0.85;
    c = mix(c, uInk[1], hl);
    acc = vec4(c * body, body);
  } else {
    acc = vec4(ink * body, body);
  }
  return acc;
}
`;

const STEM_FRAG = /* glsl */ `
${LINE_FRAG_LIB}
uniform float uPad;
varying float vSide;
varying float vInk;
varying float vFade;
varying float vU;
void main() {
  vec3 ink = uInk[int(vInk + 0.5)];
  vec4 c = strokeCol(vSide, ink, 1.0 + uPad * 2.5);
  c.rgb = mix(c.rgb, uInk[0] * c.a, vFade);
  c.rgb += (hash21(gl_FragCoord.xy) - 0.5) * 0.03 * uGrain * c.a;
  if (c.a < 0.002) discard;
  gl_FragColor = c;
}
`;

/* leaves and flowers: instanced quads hung on the stems */
const SPRITE_VERT = /* glsl */ `
${LIB}
attribute vec4 aA; // plant, at (fraction of the stem; -1 = its growing tip), angle off the stem, size
attribute vec4 aB; // kind, ink fill, ink detail, ink centre
attribute vec4 aC; // seed, -, side, leaf width ratio
uniform float uSwell, uTremble;
varying vec2 vQ;
varying vec4 vK;   // kind, open, form, seed
varying vec4 vI;   // inks + layer fade
varying vec4 vX;   // ratio / stem heading, side, bud size, -
void main() {
  Stem s = gStem(aA.x);
  float kind = aB.x;
  vI = vec4(aB.yzw, s.layer < 0.5 ? 0.3 : (s.layer < 1.5 ? 0.1 : 0.0));
  float d = aA.y < -0.5 ? s.gL : aA.y * s.L;
  float ang;
  vec2 p = gPoint(s, d, ang);
  vec2 c = position.xy;
  float size = aA.w;
  float m = 0.1 + uPad;
  vec2 wp;
  if (kind < 9.5) {
    // a leaf unfurls once the stem has grown past it: it swings out, lengthens, then opens out flat
    float lag = 0.04 + 0.45 * size;
    float form = clamp((s.gL - d) / lag, 0.0, 1.0);
    form = form * form * (3.0 - 2.0 * form);
    if (form < 0.01 || s.g < 0.002) { gl_Position = vec4(3.0, 3.0, 0.0, 1.0); return; }
    float ar = aC.w;
    float rot = ang + aA.z * mix(0.15, 1.0, form);
    vec2 axis = vec2(cos(rot), sin(rot));
    vec2 across = vec2(-axis.y, axis.x) * aC.z;
    vec2 L = vec2(c.x * (0.5 * ar + m), mix(-m, 1.0 + m, c.y * 0.5 + 0.5));
    float len = size * form;
    float wS = 0.12 + 0.88 * form * form;
    wp = p + axis * L.y * len + across * L.x * len * wS;
    vQ = L;
    vK = vec4(kind, 1.0, form, aC.x);
    vX = vec4(ar, aC.z, 0.0, 0.0);
  } else {
    if (s.g < 0.03) { gl_Position = vec4(3.0, 3.0, 0.0, 1.0); return; }
    float o = s.open;
    float bud = (0.32 + 0.68 * smoothstep(0.45, 1.0, s.g)) * (1.0 + 0.38 * uSwell);
    float side = kind > 10.5 && kind < 11.5 || kind > 12.5 && kind < 13.5 ? 1.0 : 0.0;
    // side-view flowers follow the stem; face-on ones mostly look at you, tilted a little with it
    float up = ang - 1.5708;
    float rot = side > 0.5 ? up : up * 0.3 + (aC.x - 0.5) * 0.5;
    rot += uTremble * sin(uTime * 37.0 + aC.x * 40.0) * 0.07;
    float ext = max(bud * 1.05, 0.25 + 0.95 * clamp(o, 0.0, 1.35)) + m + side * 0.55;
    float scl = size * (1.0 + 0.16 * s.pop) * smoothstep(0.03, 0.12, s.g);
    vec2 xa = vec2(cos(rot), sin(rot));
    vec2 ya = vec2(-xa.y, xa.x);
    vQ = c * ext;
    wp = p + (xa * vQ.x + ya * vQ.y) * scl;
    vK = vec4(kind, o, 1.0, aC.x);
    vX = vec4(ang - (rot + 1.5708), 0.0, bud, 0.0);
  }
  gl_Position = gClip(wp, s.layer);
}
`;

/* petals drifting down: stateless, each falls on its own loop */
const PETAL_VERT = /* glsl */ `
${LIB}
attribute vec4 aA; // x seed, phase, speed, size
attribute vec4 aB; // kind, ink fill, ink detail, seed
uniform float uDrift, uDriftT;
varying vec2 vQ;
varying vec4 vK;
varying vec4 vI;
varying vec4 vX;
void main() {
  float sd = aB.w;
  float on = step(hash11(sd * 91.7), uDrift);
  float fall = fract(aA.y + uDriftT * aA.z);
  vec2 p = vec2((aA.x - 0.5) * (uAspect + 0.3), 1.1 - fall * 1.25);
  p.x += uFeelWind.x * fall * 0.3 + sin(uDriftT * aA.z * 7.0 + sd * 20.0) * 0.035;
  float rot = uDriftT * (1.2 + 2.5 * sd) * (sd > 0.5 ? 1.0 : -1.0) + sd * 6.28;
  float flip = 0.35 + 0.65 * abs(sin(uDriftT * (1.5 + sd * 2.0) + sd * 9.0));
  vec2 c = position.xy * 1.15;
  vec2 xa = vec2(cos(rot), sin(rot));
  vec2 ya = vec2(-xa.y, xa.x);
  float scl = aA.w * on * smoothstep(0.0, 0.08, fall) * smoothstep(1.0, 0.85, fall);
  vec2 wp = p + (xa * c.x * flip + ya * c.y) * scl;
  vQ = c;
  vK = vec4(aB.x, 1.0, 1.0, sd);
  vI = vec4(aB.yz, aB.z, 0.05);
  vX = vec4(0.0);
  gl_Position = scl > 0.0 ? gClip(wp, 2.0) : vec4(3.0, 3.0, 0.0, 1.0);
}
`;

const SPRITE_FRAG = /* glsl */ `
uniform vec3 uInk[${N_INK}];
uniform float uFill, uTint, uLine, uCore, uGlow, uRim, uContour, uHalftone, uGrain;
uniform vec3 uLineC, uCoreC, uGlowC, uRimC;
uniform float uHatN, uHatEnv, uTwinkle, uBoil, uWobble;
varying vec2 vQ;
varying vec4 vK;
varying vec4 vI;
varying vec4 vX;

float gPx;
float gSeed;
vec3 INK(float i) { return uInk[int(i + 0.5)]; }
vec2 rotv(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
void over(inout vec4 acc, vec3 c, float a) { a = clamp(a, 0.0, 1.0); acc.rgb = c * a + acc.rgb * (1.0 - a); acc.a = a + acc.a * (1.0 - a); }
float fillM(float d) { return 1.0 - smoothstep(-gPx, gPx, d); }
float lineM(float d, float w) { return 1.0 - smoothstep(w - gPx, w + gPx, abs(d)); }
float sdEl(vec2 p, vec2 r) { float k0 = length(p / r); float k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / max(k1, 1e-5); }
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float tri(float x) { return abs(fract(x) - 0.5) * 2.0; }

// petal-local coordinates under n-fold polar repetition: x out along the petal, y across it
vec2 polar(vec2 q, float n, float rot, out float id) {
  float a = atan(q.y, q.x) - rot;
  float sec = TAU / n;
  id = floor(a / sec + 0.5);
  float la = a - id * sec;
  float r = length(q);
  return vec2(r * cos(la), r * sin(la));
}

// hats light a few dots at a time
float twk(vec2 cid) { return step(0.72, hash21(cid * 0.731 + vec2(uHatN * 3.17, gSeed * 9.1))) * uHatEnv * uTwinkle; }

// nearest dot of a jittered grid (cells 1/f wide), as a distance in local units
float dots(vec2 q, float f, float r, out vec2 cid) {
  vec2 p = q * f;
  vec2 c = floor(p);
  vec2 o = fract(p) - 0.5 - (hash22(c + gSeed * 7.0) - 0.5) * 0.3;
  cid = c;
  return (length(o) - r * (0.78 + 0.44 * hash21(c * 1.7 + 2.3))) / f;
}

// a filled shape in the current treatment: glow under it, rim shading toward its edge, outline over it
void shape(inout vec4 acc, float d, vec3 fill) {
  float cov = fillM(d);
  if (uGlow > 0.0) over(acc, uGlowC, uGlow * 0.42 * exp(-max(d, 0.0) * 18.0) * (1.0 - cov));
  vec3 rimC = luma(fill) > 0.55 ? uRimC : fill * 0.6;
  vec3 c = mix(fill, rimC, uRim * smoothstep(-0.16, 0.0, d) * 0.85);
  c = mix(uInk[0], c, uTint);
  over(acc, c, cov * uFill);
  if (uHalftone > 0.0) {
    // screen-tone dots, denser toward the edge
    vec2 g = gl_FragCoord.xy / max(uResolution.y / 190.0, 1.0);
    vec2 f = fract(g) - 0.5;
    float r = 0.18 + 0.2 * smoothstep(-0.25, 0.0, d);
    over(acc, mix(fill, uCoreC, 0.2), (1.0 - smoothstep(r - 0.12, r + 0.12, length(f))) * cov * uHalftone * 0.5);
  }
  if (uLine > 0.0) {
    float w = 0.024 * uLine;
    over(acc, uLineC, lineM(d + w * 0.6, w));
    if (uCore > 0.0) over(acc, uCoreC, lineM(d + w * 0.6, w * 0.45) * uCore);
  }
}
// inner marks (veins, stripes, dots): in the marker style they are drawn with the pale core ink
void mark(inout vec4 acc, float m, vec3 c) { over(acc, mix(c, uCoreC, uCore * 0.8), m); }

/* ── leaves (y from the stem to the tip, x across, in units of the leaf's length) ── */
void leaf(inout vec4 acc, vec2 q, float kind, float ar, vec3 cF, vec3 cD) {
  float y = q.y;
  float ax = abs(q.x);
  float yy = clamp(y, 0.0, 1.0);
  float two = step(0.45, hash11(gSeed * 3.7)) * (1.0 - uCore);
  vec3 cH = mix(cF, cF * 0.78, two * step(q.x, 0.0));
  if (kind < 0.5 || kind > 0.5 && kind < 1.5) {
    // ovate / lance: a blade with a midrib and side veins (lance: two rows of dots instead)
    bool lance = kind > 0.5;
    float w = 0.5 * ar * pow(max(sin(PI * pow(yy, lance ? 0.9 : 0.72)), 0.0), lance ? 1.1 : 0.8);
    float d = max(ax - w, max(-y, y - 1.0)) * 0.85;
    shape(acc, d, cH);
    float inside = fillM(d + 0.02);
    float mid = lineM(q.x, 0.012 * (1.0 - 0.7 * yy)) * step(0.0, y) * step(y, 0.93);
    if (!lance) {
      float sv = (fract((y - ax * 1.3) * 6.5 + 0.5) - 0.5) / 6.5 * 0.6;
      float side = lineM(sv, 0.006) * step(0.06, y) * step(y, 0.86) * fillM(d + 0.035) * step(0.012, ax);
      mark(acc, max(mid, side) * inside, cD);
    } else {
      vec2 cid;
      float dd = dots(vec2(ax - w * 0.5, y) * vec2(1.0, 0.5), 14.0, 0.26, cid);
      float tw = twk(cid);
      mark(acc, max(mid, fillM(dd - tw * 0.012) * fillM(d + 0.03) * step(0.015, ax)), mix(cD, uInk[1], tw));
    }
  } else if (kind < 2.5) {
    // heart: a notch at the stem, veins fanning from it
    vec2 p = vec2(q.x / (ar * 0.85), 1.05 - y);
    p.x = abs(p.x);
    float dh;
    if (p.y + p.x > 1.0) dh = length(p - vec2(0.25, 0.75)) - 0.35355;
    else { vec2 a = p - vec2(0.0, 1.0); vec2 b = p - 0.5 * max(p.x + p.y, 0.0); dh = sqrt(min(dot(a, a), dot(b, b))) * sign(p.x - p.y); }
    float d = dh * ar * 0.8;
    shape(acc, d, cH);
    vec2 b = q - vec2(0.0, 0.06);
    float a = atan(b.x, b.y);
    float la = (fract(a / 0.55 + 0.5) - 0.5) * 0.55;
    float fan = length(b) * abs(sin(la));
    float v = lineM(fan, 0.008) * step(0.05, length(b)) * fillM(d + 0.05);
    float net = lineM((fract(length(b) * 7.0 - abs(a) * 0.3) - 0.5) / 7.0, 0.0045) * fillM(d + 0.07) * 0.8;
    mark(acc, max(max(v, net), lineM(q.x, 0.012) * step(0.0, y) * fillM(d + 0.03)), cD);
  } else if (kind < 3.5) {
    // frond: a rib with alternate leaflets
    float n = 8.0;
    float sgn = q.x < 0.0 ? 1.0 : 0.0;
    float d = 1e3;
    float vein = 1e3;
    for (int k = 0; k < 2; k++) {
      float j = floor(y * n - 0.5 * sgn) + float(k);
      float yc = (j + 0.5 + 0.5 * sgn) / n;
      if (yc < 0.04 || yc > 1.0) continue;
      float len = ar * 0.5 * pow(sin(PI * clamp(yc, 0.0, 1.0)), 0.6) * (1.05 - 0.4 * yc);
      vec2 b = vec2(ax, y - yc);
      b = rotv(b, -0.6);
      float e = sdEl(b - vec2(len * 0.5, 0.0), vec2(len * 0.5 + 0.004, 0.42 / n));
      d = min(d, e);
      vein = min(vein, abs(b.y) + step(len * 0.85, b.x) + step(b.x, 0.0));
    }
    float rib = ax - 0.014 * (1.0 - 0.6 * yy);
    rib = max(rib, max(-y, y - 0.98));
    d = min(d, rib);
    shape(acc, d, cF);
    mark(acc, lineM(vein, 0.005) * fillM(d + 0.012), cD);
  } else if (kind < 4.5) {
    // coral blob: a lobed body with contour stripes inside
    vec2 b = vec2(q.x / (ar * 0.5), (y - 0.5) / 0.5);
    float a = atan(b.y, b.x);
    float r = 1.0 + 0.07 * sin(a * 8.0 + gSeed * 30.0) + 0.05 * sin(a * 13.0 - gSeed * 11.0) + 0.12 * sin(a * 2.0 + gSeed * 5.0);
    float d = (length(b) - 0.86 * r) * 0.42 * min(ar, 1.0);
    shape(acc, d, cF);
    float st = (fract(-d * 13.0) - 0.5) / 13.0;
    mark(acc, lineM(st, 0.006) * fillM(d + 0.035) * uContour, cD);
    vec2 cid;
    float dd = dots(q, 16.0, 0.22, cid);
    float tw = twk(cid);
    mark(acc, fillM(dd - tw * 0.01) * fillM(d + 0.12) * (1.0 - uContour * 0.6) * step(0.5, hash11(gSeed * 5.1)), mix(cD, uInk[1], tw));
  } else if (kind < 5.5) {
    // spike / grass blade
    float w = 0.5 * ar * pow(max(1.0 - yy, 0.0), 0.75) * smoothstep(-0.02, 0.06, y);
    float d = max(ax - w, max(-y, y - 1.0)) * 0.9;
    shape(acc, d, cF);
    mark(acc, lineM(q.x, 0.005) * step(0.05, y) * step(y, 0.8) * fillM(d + 0.01), cD);
  } else {
    // round pad, dot-filled
    vec2 b = vec2(q.x, y - 0.5 * ar);
    float d = length(b) - 0.48 * ar;
    d = min(d, max(ax - 0.012, max(-y, y - 0.2)));
    shape(acc, d, cH);
    vec2 cid;
    float dd = dots(b, 18.0, 0.24, cid);
    float tw = twk(cid);
    mark(acc, fillM(dd - tw * 0.01) * fillM(d + 0.04), mix(cD, uInk[1], tw));
  }
}

/* ── buds: a closed egg with a seam, held in sepals ── */
void bud(inout vec4 acc, vec2 q, float bs, vec3 cP, vec3 cD) {
  vec2 b = q / max(bs, 0.05);
  float d = sdEl(b - vec2(0.0, 0.46), vec2(0.3, 0.46)) + max(b.y - 0.5, 0.0) * 0.22;
  d *= bs;
  vec3 leafC = uInk[8];
  // sepals
  float s1 = sdEl(rotv(b - vec2(-0.1, 0.12), 0.55) - vec2(0.0, 0.12), vec2(0.07, 0.2)) * bs;
  float s2 = sdEl(rotv(b - vec2(0.1, 0.12), -0.55) - vec2(0.0, 0.12), vec2(0.07, 0.2)) * bs;
  shape(acc, d, cP * 0.92);
  mark(acc, lineM((b.x - 0.12 * sin(b.y * 3.5)) * bs, 0.006) * fillM(d + 0.02 * bs) * step(0.25, b.y), cD);
  shape(acc, min(s1, s2), leafC);
}

/* ── flowers (radius 1 at full bloom) ── */
void flower(inout vec4 acc, vec2 q, float kind, vec3 cP, vec3 cD, vec3 cC) {
  float r = length(q);
  if (kind < 10.5) {
    // daisy: many thin petals with a line down each, a dotted marigold centre
    float n = 13.0 + floor(hash11(gSeed * 2.1) * 7.0);
    float pid;
    vec2 pl = polar(q, n, gSeed * 6.28, pid);
    float len = 0.78 * (0.86 + 0.26 * hash11(pid + gSeed * 13.0));
    float dP = sdEl(pl - vec2(0.2 + len * 0.5, 0.0), vec2(len * 0.5, 0.1));
    shape(acc, dP, cP);
    mark(acc, lineM(pl.y, 0.009) * step(0.34, pl.x) * step(pl.x, 0.15 + len * 0.85) * fillM(dP + 0.01), cD);
    float dC = r - 0.27;
    shape(acc, dC, cC);
    vec2 cid;
    float dd = dots(q + gSeed, 15.0, 0.3, cid);
    float tw = twk(cid);
    mark(acc, fillM(dd - tw * 0.012) * fillM(dC + 0.035), mix(cD, uInk[1], tw));
    mark(acc, lineM(dC + 0.01, 0.008), cD * 0.85);
  } else if (kind < 11.5) {
    // tulip, side on (stem tip at 0, cup centred at y = 0.55): three dotted petals that fan open
    vec2 b = q - vec2(0.0, 0.55);
    float o = clamp(vK.y, 0.0, 1.3);
    float spread = 0.22 + 0.42 * o;
    float dBack = sdEl(b - vec2(0.0, 0.05), vec2(0.36, 0.56));
    shape(acc, dBack, cP * 0.72);
    vec2 bl = rotv(b - vec2(0.0, -0.48), spread) + vec2(0.0, -0.5);
    vec2 br = rotv(b - vec2(0.0, -0.48), -spread) + vec2(0.0, -0.5);
    float dl = sdEl(bl - vec2(-0.03, 0.47), vec2(0.3, 0.55)) + max(bl.y - 0.6, 0.0) * 0.3;
    float dr = sdEl(br - vec2(0.03, 0.47), vec2(0.3, 0.55)) + max(br.y - 0.6, 0.0) * 0.3;
    vec2 cid;
    float dd = dots(b + gSeed, 11.0, 0.28, cid);
    float tw = twk(cid);
    // stamens peek out of the open cup
    float st = min(sdSeg(b, vec2(0.0, -0.3), vec2(-0.12, 0.42)), sdSeg(b, vec2(0.0, -0.3), vec2(0.12, 0.45)));
    float dSt = min(st - 0.018, min(length(b - vec2(-0.12, 0.42)), length(b - vec2(0.12, 0.45))) - 0.06);
    shape(acc, dSt + (1.0 - smoothstep(0.3, 0.8, o)) * 0.5, cC);
    shape(acc, dl, cP);
    mark(acc, fillM(dd - tw * 0.01) * fillM(dl + 0.05), mix(cD, uInk[1], tw));
    shape(acc, dr, cP * 0.88);
    mark(acc, fillM(dd - tw * 0.01) * fillM(dr + 0.05), mix(cD, uInk[1], tw));
  } else if (kind < 12.5) {
    // star flower: two layers of pointed petals and a centre
    float n = 6.0 + floor(hash11(gSeed * 4.3) * 3.0);
    float pid;
    vec2 pl = polar(q, n, gSeed * 6.28, pid);
    float dP = (abs(pl.y) - max(0.95 - pl.x, 0.0) * 0.42) * 0.85;
    dP = max(dP, pl.x - 0.95);
    shape(acc, dP, cP);
    mark(acc, lineM(pl.y, 0.008) * step(0.25, pl.x) * step(pl.x, 0.72) * fillM(dP + 0.02), cD);
    vec2 pl2 = polar(q, n, gSeed * 6.28 + PI / n, pid);
    float dQ = max((abs(pl2.y) - max(0.6 - pl2.x, 0.0) * 0.5) * 0.85, pl2.x - 0.6);
    shape(acc, dQ, cD);
    float dC = r - 0.2;
    shape(acc, dC, cC);
    vec2 cid;
    float dd = dots(q, 22.0, 0.3, cid);
    float tw = twk(cid);
    mark(acc, fillM(dd - tw * 0.01) * fillM(dC + 0.03), mix(cP, uInk[1], tw));
  } else if (kind < 13.5) {
    // cone flower, side on: a dotted dome over a fan of petals that hang down closed and spread as it opens
    vec2 b = q - vec2(0.0, 0.5);
    float o = clamp(vK.y, 0.0, 1.3);
    float halfSpan = mix(0.4, 1.5, smoothstep(0.0, 1.0, o));
    float n = 9.0;
    float sec = 2.0 * halfSpan / (n - 1.0);
    float a = atan(b.y, b.x) + 1.5708;
    a = a > PI ? a - TAU : a;
    float j0 = floor((a + halfSpan) / sec + 0.5);
    float dP = 1e3;
    float pv = 1e3;
    for (int k = -1; k <= 1; k++) {
      float j = clamp(j0 + float(k), 0.0, n - 1.0);
      float pa = -halfSpan + j * sec;
      vec2 pl = rotv(b, -(pa - 1.5708));
      float len = 0.62 * (0.9 + 0.2 * hash11(j + gSeed * 7.0));
      float e = sdEl(pl - vec2(0.16 + len * 0.5, 0.0), vec2(len * 0.5, 0.095));
      if (e < dP) { dP = e; pv = abs(pl.y) + step(pl.x, 0.3) + step(0.16 + len * 0.85, pl.x); }
    }
    shape(acc, dP, cC);
    mark(acc, lineM(pv, 0.008) * fillM(dP + 0.01), cD * 0.9);
    float dDome = sdEl(b - vec2(0.0, 0.1), vec2(0.34, 0.3));
    dDome = max(dDome, -(b.y + 0.02));
    shape(acc, dDome, cP);
    vec2 cid;
    float dd = dots(b + gSeed, 13.0, 0.32, cid);
    float tw = twk(cid);
    mark(acc, fillM(dd - tw * 0.012) * fillM(dDome + 0.03), mix(cD, uInk[1], tw));
  } else if (kind < 14.5) {
    // berries on short stalks; in the coral style they are bubbles (rings with a glint)
    float o = clamp(vK.y, 0.0, 1.3);
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      vec2 h = hash22(vec2(fi * 3.1, gSeed * 17.0));
      float a = fi * 2.4 + gSeed * 6.0;
      vec2 c = fi < 0.5 ? vec2(0.0, 0.12) : vec2(cos(a), sin(a) * 0.85 + 0.15) * (0.32 + 0.38 * h.x);
      float rr = (0.17 + 0.09 * h.y) * (0.45 + 0.55 * o);
      mark(acc, lineM(sdSeg(q, vec2(0.0, -0.25), c), 0.012) * (1.0 - fillM(length(q - c) - rr)), uInk[8]);
      float d = length(q - c) - rr;
      shape(acc, d, cP);
      if (uContour > 0.5) mark(acc, fillM(d + 0.06) * 0.85, uInk[0]);
      mark(acc, fillM(length(q - c - vec2(-0.35, 0.35) * rr) - rr * 0.28), cD);
      mark(acc, fillM(length(q - c - vec2(0.3, -0.3) * rr) - rr * 0.12) * (1.0 - uContour), cC);
    }
  } else if (kind < 15.5) {
    // spray: a loose head of small five-petalled florets
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      vec2 h = hash22(vec2(fi * 5.3, gSeed * 13.0));
      float a = fi * 2.2 + gSeed * 5.0;
      vec2 c = fi < 0.5 ? vec2(0.0) : vec2(cos(a), sin(a)) * (0.42 + 0.3 * h.x);
      float fr = 0.3 + 0.08 * h.y;
      vec2 b = (q - c) / fr;
      float pid;
      vec2 pl = polar(b, 5.0, h.x * 6.28, pid);
      float d = sdEl(pl - vec2(0.55, 0.0), vec2(0.45, 0.32)) * fr;
      shape(acc, d, cP);
      shape(acc, (length(b) - 0.24) * fr, cC);
      vec2 cid = vec2(fi, 0.0);
      mark(acc, fillM((length(b) - 0.1) * fr) * (0.4 + twk(cid)), cD);
    }
  } else if (kind < 16.5) {
    // anemone: tentacles with round tips around a ringed, dotted centre
    float n = 15.0 + floor(hash11(gSeed * 2.7) * 6.0);
    float pid;
    vec2 pl = polar(q, n, gSeed * 6.28, pid);
    float wob = 0.06 * sin(pid * 2.3 + uTime * 1.5 + gSeed * 10.0);
    pl.y -= wob * pl.x;
    float len = 0.72 + 0.12 * hash11(pid + gSeed);
    float dT = max(abs(pl.y) - 0.055, max(0.25 - pl.x, pl.x - len));
    float dB = length(pl - vec2(len, 0.0)) - 0.11;
    shape(acc, dT, cP);
    shape(acc, dB, cD);
    mark(acc, fillM(length(pl - vec2(len + 0.02, 0.03)) - 0.035), uInk[1]);
    float dC = r - 0.36;
    shape(acc, dC, cC);
    float ring = (fract(-dC * 16.0) - 0.5) / 16.0;
    mark(acc, lineM(ring, 0.006) * fillM(dC + 0.03), cP);
    vec2 cid;
    float dd = dots(q, 24.0, 0.3, cid);
    float tw = twk(cid);
    mark(acc, fillM(dd - tw * 0.008) * fillM(r - 0.12), mix(cD, uInk[1], tw));
  } else if (kind < 17.5) {
    // sunburst wheel: a spiky disc, radiating lines, a zigzag ring, a white eye
    float a = atan(q.y, q.x);
    float n = 22.0;
    float dO = r - (0.86 + 0.08 * tri(a / TAU * n + gSeed));
    shape(acc, dO, cP);
    float pid;
    vec2 pl = polar(q, n, gSeed, pid);
    mark(acc, lineM(pl.y, 0.009) * step(0.42, pl.x) * step(pl.x, 0.8), cD);
    float zr = 0.6 + 0.045 * (tri(a / TAU * 30.0 + uTime * 0.05) - 0.5);
    mark(acc, lineM(r - zr, 0.012), cD);
    float dI = r - 0.34;
    shape(acc, dI, cC);
    float zz = r - (0.25 + 0.03 * tri(a / TAU * 16.0));
    mark(acc, lineM(zz, 0.01), cD);
    vec2 cid;
    float dd = dots(q, 20.0, 0.3, cid);
    float tw = twk(cid);
    mark(acc, fillM(dd - tw * 0.01) * fillM(r - 0.17), mix(cD, uInk[1], tw));
  } else {
    // cartoon flower: round petals and a round face
    float pid;
    vec2 pl = polar(q, 5.0 + floor(hash11(gSeed) * 2.0), gSeed * 6.28, pid);
    float dP = length(pl - vec2(0.56, 0.0)) - 0.38;
    shape(acc, dP, cP);
    float dC = r - 0.3;
    shape(acc, dC, cC);
    vec2 cid;
    float dd = dots(q, 16.0, 0.28, cid);
    float tw = twk(cid);
    mark(acc, fillM(dd - tw * 0.01) * fillM(dC + 0.04) * (0.5 + tw), cD);
  }
}

void main() {
  float kind = vK.x;
  gSeed = vK.w;
  // the hand: every drawing traces the shapes a little differently
  vec2 q = vQ + (tnoise4(vQ * 2.4 + gSeed * 19.0 + uBoil * 5.3).xy - 0.5) * 0.055 * uWobble;
  gPx = length(fwidth(vQ)) * 0.75 + 1e-5;
  vec3 cP = INK(vI.x);
  vec3 cD = INK(vI.y);
  vec3 cC = INK(vI.z);
  vec4 acc = vec4(0.0);
  if (kind < 9.5) {
    leaf(acc, q, kind, vX.x, cP, cD);
  } else if (kind > 19.5) {
    // a fallen petal, tumbling
    float d = sdEl(q, vec2(0.42, 1.0));
    shape(acc, d, cP);
    mark(acc, lineM(q.x, 0.04) * step(-0.6, q.y) * step(q.y, 0.6), cD);
  } else {
    float o = vK.y;
    float bs = vX.z;
    float bm = smoothstep(0.08, 0.42, o);
    vec4 aB = vec4(0.0);
    vec4 aF = vec4(0.0);
    if (bm < 0.999) bud(aB, rotv(q, -vX.x), bs, cP, cD);
    if (bm > 0.001) {
      float os = 0.25 + 0.75 * max(o, 0.0);
      gPx /= os;
      flower(aF, q / os, kind, cP, cD, cC);
      gPx *= os;
    }
    acc = mix(aB, aF, bm);
  }
  // further back, the plants sink into the ground colour
  acc.rgb = mix(acc.rgb, uInk[0] * acc.a, vI.w);
  acc.rgb += (hash21(gl_FragCoord.xy + fract(uBoil * 0.37) * 91.0) - 0.5) * 0.035 * uGrain * acc.a;
  if (acc.a < 0.002) discard;
  gl_FragColor = acc;
}
`;

/* doodles: strokes drawn on and erased along their length */
const DOODLE_VERT = /* glsl */ `
${LIB}
attribute vec4 aD;   // t along the doodle, side, doodle index, width
attribute vec4 aN;   // normal xy, centre xy
attribute float aInkD;
uniform vec4 uDood[${MAX_DOODLES}];
varying float vT;
varying float vSide;
varying vec4 vDs;
varying float vInk;
void main() {
  vec4 ds = uDood[int(aD.z + 0.5)];
  vDs = ds;
  vT = aD.x;
  vInk = aInkD;
  if (ds.z < 0.002 || ds.x <= ds.y) { gl_Position = vec4(3.0, 3.0, 0.0, 1.0); vSide = 0.0; return; }
  float pad = 1.0 + uPad * 3.0;
  float j = (tnoise(vec2(aD.x * 14.0 + aD.z * 7.3, uBoil * 2.1)) - 0.5) * 0.006 * uWobble;
  vec2 p = aN.zw + position.xy * ds.w + aN.xy * (aD.y * aD.w * 0.5 * pad + j);
  vSide = aD.y * pad;
  gl_Position = gClip(p, 1.4);
}
`;

const DOODLE_FRAG = /* glsl */ `
${LINE_FRAG_LIB}
uniform float uPad;
varying float vT;
varying float vSide;
varying vec4 vDs;
varying float vInk;
void main() {
  float ft = fwidth(vT) * 1.2 + 1e-4;
  float on = smoothstep(vDs.y - ft, vDs.y + ft, vT) * (1.0 - smoothstep(vDs.x - ft, vDs.x + ft, vT));
  vec4 c = strokeCol(vSide, uInk[int(vInk + 0.5)], 1.0 + uPad * 3.0);
  c *= on * vDs.z;
  if (c.a < 0.002) discard;
  gl_FragColor = c;
}
`;

/* the ground: painted, grained, a low mound along the bottom, a pool of light in the doodle style */
const BG_FRAG = /* glsl */ `
uniform vec3 uInk[${N_INK}];
uniform vec3 uGroundC, uLightC;
uniform float uLightK, uGrainK, uPaint, uHatN, uHatEnv, uTwinkle, uBoil;
uniform vec2 uPar;
void main() {
  vec2 w = vec2((vUv.x - 0.5) * uAspect, vUv.y);
  float px = 1.0 / uResolution.y;
  vec3 c = uInk[0];
  // painted ground: broad mottling, and in the coral style long brush streaks
  float m = tfbm(w * 2.3 + 3.1, 4);
  c *= 1.0 + 0.08 * m * uGrainK;
  float br = tnoise(vec2(w.x * 2.2 + w.y * 1.3, w.y * 34.0 - w.x * 6.0)) - 0.5;
  c *= 1.0 + 0.09 * br * uPaint * uGrainK;
  c = mix(c, mix(uInk[0], uInk[3], 0.25), smoothstep(0.2, 0.75, tnoise(w * 1.6 + 7.0)) * 0.25 * uPaint);
  // light pooled behind the garden
  vec2 lc = w - vec2(0.0, 0.42);
  c += uLightC * uLightK * exp(-dot(lc, lc) * 3.2);
  // the mound the garden grows from
  float gx = w.x + uPar.x * 0.3;
  float gy = 0.085 + 0.022 * sin(gx * 3.1 + 1.2) + 0.012 * sin(gx * 7.7 + 0.3);
  float gd = w.y - gy;
  float g = 1.0 - smoothstep(-px, px, gd);
  c = mix(c, uGroundC, g);
  // stipple on the mound and specks in the air
  vec2 sp = w * vec2(90.0, 90.0);
  vec2 cell = floor(sp);
  vec2 o = fract(sp) - 0.5 - (hash22(cell) - 0.5) * 0.6;
  float h = hash21(cell * 1.3 + 4.1);
  float tw = step(0.8, hash21(cell + uHatN * 1.7)) * uHatEnv * uTwinkle;
  float dotR = mix(0.0, 0.22, step(h, mix(0.012, 0.28, g) * (1.0 - smoothstep(0.0, 0.07, -gd) * 0.6)));
  float dm = 1.0 - smoothstep(dotR - 0.12, dotR + 0.12, length(o));
  c = mix(c, mix(mix(uInk[0], uInk[1], 0.35), uInk[3], tw), dm * mix(0.45, 0.8, g) * (0.6 + tw));
  // paper grain
  c += (hash21(gl_FragCoord.xy + fract(uBoil * 0.13) * 57.0) - 0.5) * 0.04 * uGrainK;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── generation ───────────────────────── */

interface Plant {
  layer: number;
  parent: number;
  pt: number;
  bx: number;
  by: number;
  a0: number;
  L: number;
  k: number;
  curl: number;
  w: number;
  fid: number;
  seed: number;
  rank: number;
  lag: number;
  tendril: boolean;
  ink: number;
  flower: boolean;
  flowerTh: number;
  delay: number;
  droop: number;
  /* live */
  g: number;
  open: number;
  ov: number;
}

interface Sprite {
  plant: number;
  at: number;
  ang: number;
  size: number;
  kind: number;
  inks: [number, number, number];
  seed: number;
  side: number;
  ar: number;
}

interface Doodle {
  lines: [number, number][][];
  cx: number;
  cy: number;
  width: number;
  ink: number;
  drop: boolean;
  delay: number;
  hold: number;
  speed: number;
  offset: number;
  /* live */
  head: number;
  tail: number;
  alpha: number;
}

interface Garden {
  plants: Plant[];
  leaves: Sprite[][];
  flowers: Sprite[][];
  doodles: Doodle[];
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const hashN = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** CPU twin of the shader's stem walk, fully grown and still (used to place doodles near flowers) */
function stemTip(plants: Plant[], i: number, frac = 1): { x: number; y: number; a: number } {
  const p = plants[i];
  let bx = p.bx;
  let by = p.by;
  let a0 = p.a0;
  if (p.parent >= 0) {
    const q = stemTip(plants, p.parent, p.pt);
    bx = q.x;
    by = q.y;
    a0 += q.a;
  }
  const d = p.L * frac;
  const ang = (s: number) => {
    const u = s / p.L;
    return a0 + p.k * s + p.curl * u * u * u * u;
  };
  let x = bx;
  let y = by;
  const ds = d / 12;
  for (let k = 0; k < 12; k++) {
    const a = ang((k + 0.5) * ds);
    x += Math.cos(a) * ds;
    y += Math.sin(a) * ds;
  }
  return { x, y, a: ang(d) };
}

type Choice<T> = [T, number][];
function pick<T>(r: () => number, opts: Choice<T>): T {
  let tot = 0;
  for (const o of opts) tot += o[1];
  let x = r() * tot;
  for (const o of opts) {
    x -= o[1];
    if (x <= 0) return o[0];
  }
  return opts[opts.length - 1][0];
}

/** what each style plants */
const FLORA: Record<
  Variant,
  {
    leaves: Choice<number>;
    flowers: Choice<number>;
    stemInk: Choice<number>;
    leafInk: (r: () => number, kind: number) => [number, number];
    flowerInk: (r: () => number, kind: number) => [number, number, number];
    tendrils: number;
  }
> = {
  botanical: {
    leaves: [
      [K.OVATE, 4],
      [K.LANCE, 2],
      [K.HEART, 2],
      [K.FROND, 2],
      [K.ROUND, 1],
      [K.SPIKE, 1],
    ],
    flowers: [
      [K.DAISY, 3],
      [K.TULIP, 2],
      [K.STAR, 2],
      [K.CONE, 2],
      [K.BERRY, 2],
      [K.SPRAY, 2],
    ],
    stemInk: [
      [I.DEEP, 3],
      [I.MU, 2],
      [I.LIME, 1],
    ],
    leafInk: (r, kind) => {
      if (kind === K.FROND) return pick(r, [[[I.VIVID, I.PALE], 2], [[I.MU, I.LIME], 2], [[I.LIME, I.DEEP], 1]]);
      if (kind === K.ROUND) return pick(r, [[[I.LIME, I.AC], 2], [[I.MU, I.AC2], 1]]);
      if (kind === K.SPIKE) return pick(r, [[[I.DEEP, I.LIME], 1], [[I.MU, I.LIME], 1]]);
      return pick(r, [[[I.MU, I.LIME], 4], [[I.LIME, I.DEEP], 2], [[I.DEEP, I.LIME], 2], [[I.MU, I.FG], 1]]);
    },
    flowerInk: (r, kind) => {
      switch (kind) {
        case K.DAISY:
          return pick(r, [[[I.FG, I.AC, I.AC2], 3], [[I.FG, I.VIVID, I.ORANGE], 2], [[I.PINK, I.AC, I.AC2], 1]]);
        case K.TULIP:
          return pick(r, [[[I.AC, I.FG, I.AC2], 3], [[I.PINK, I.AC, I.AC2], 2], [[I.ORANGE, I.FG, I.AC], 1]]);
        case K.STAR:
          return pick(r, [[[I.AC2, I.AC, I.FG], 2], [[I.PINK, I.AC, I.AC2], 2], [[I.VIVID, I.FG, I.AC2], 2]]);
        case K.CONE:
          return pick(r, [[[I.ORANGE, I.AC2, I.FG], 2], [[I.AC2, I.AC, I.PINK], 2]]);
        case K.BERRY:
          return pick(r, [[[I.VIVID, I.FG, I.DARK], 3], [[I.AC, I.FG, I.DARK], 2], [[I.PINK, I.FG, I.DARK], 1]]);
        default:
          return pick(r, [[[I.FG, I.AC2, I.AC2], 2], [[I.VIVID, I.FG, I.AC2], 2], [[I.AC2, I.AC, I.AC], 1]]);
      }
    },
    tendrils: 0.25,
  },
  coral: {
    leaves: [
      [K.BLOB, 5],
      [K.FROND, 2],
      [K.SPIKE, 2],
      [K.LANCE, 1],
    ],
    flowers: [
      [K.ANEMONE, 3],
      [K.BURST, 3],
      [K.BERRY, 2],
      [K.STAR, 1],
    ],
    stemInk: [[I.AC, 1]],
    leafInk: (r, kind) => {
      if (kind === K.SPIKE) return [I.AC, I.FG];
      if (kind === K.FROND) return pick(r, [[[I.FG, I.AC], 2], [[I.MU, I.AC], 1]]);
      return pick(r, [[[I.FG, I.AC], 4], [[I.MU, I.AC], 1]]);
    },
    flowerInk: (r, kind) => {
      switch (kind) {
        case K.ANEMONE:
          return pick(r, [[[I.AC, I.FG, I.PALE], 2], [[I.MU, I.AC, I.FG], 1]]);
        case K.BURST:
          return pick(r, [[[I.PALE, I.AC2, I.FG], 3], [[I.FG, I.AC2, I.PALE], 1]]);
        case K.BERRY:
          return [I.FG, I.FG, I.AC];
        default:
          return pick(r, [[[I.MU, I.AC, I.FG], 1], [[I.FG, I.AC, I.AC2], 1]]);
      }
    },
    tendrils: 0.5,
  },
  doodle: {
    leaves: [
      [K.OVATE, 4],
      [K.LANCE, 2],
      [K.HEART, 2],
      [K.SPIKE, 1],
      [K.FROND, 1],
    ],
    flowers: [
      [K.CUTE, 4],
      [K.STAR, 2],
      [K.DAISY, 2],
      [K.SPRAY, 1],
    ],
    stemInk: [[I.MU, 1]],
    leafInk: (r) => pick(r, [[[I.MU, I.FG], 2], [[I.LIME, I.FG], 1]]),
    flowerInk: (r) => pick(r, [[[I.AC2, I.FG, I.AC], 2], [[I.AC, I.FG, I.AC2], 2], [[I.FG, I.AC, I.AC2], 1]]),
    tendrils: 0.35,
  },
};

const DOODLE_SHAPES: Record<Variant, { drop: Choice<string>; ambient: Choice<string>; ambientN: number; size: [number, number] }> = {
  botanical: {
    drop: [
      ['star', 3],
      ['sparkle', 3],
      ['spiral', 2],
      ['ring', 1],
      ['loops', 1],
    ],
    ambient: [
      ['sparkle', 2],
      ['ring', 1],
    ],
    ambientN: 6,
    size: [0.014, 0.024],
  },
  coral: {
    drop: [
      ['spiral', 3],
      ['ring', 2],
      ['zigzag', 2],
      ['squiggle', 2],
    ],
    ambient: [
      ['zigzag', 4],
      ['squiggle', 3],
      ['ring', 1],
      ['spiral', 1],
    ],
    ambientN: 16,
    size: [0.04, 0.085],
  },
  doodle: {
    drop: [
      ['star', 3],
      ['spiral', 3],
      ['sparkle', 2],
      ['squiggle', 1],
    ],
    ambient: [
      ['star', 3],
      ['spiral', 3],
      ['squiggle', 2],
      ['zigzag', 1],
      ['loops', 2],
      ['sparkle', 1],
    ],
    ambientN: 22,
    size: [0.035, 0.075],
  },
};

function doodleLines(kind: string, r: () => number): [number, number][][] {
  const out: [number, number][][] = [];
  const line: [number, number][] = [];
  const N = 72;
  switch (kind) {
    case 'star': {
      const corners: [number, number][] = [];
      const rot = (r() - 0.5) * 0.5;
      for (let i = 0; i <= 10; i++) {
        const a = Math.PI / 2 + rot + (i * Math.PI) / 5;
        const rr = i % 2 ? 0.42 : 1;
        corners.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
      for (let i = 0; i < 10; i++) {
        const [x0, y0] = corners[i];
        const [x1, y1] = corners[i + 1];
        for (let k = 0; k < 7; k++) line.push([x0 + ((x1 - x0) * k) / 7, y0 + ((y1 - y0) * k) / 7]);
      }
      line.push(corners[10]);
      out.push(line);
      break;
    }
    case 'spiral': {
      const turns = 2.2 + r() * 0.8;
      const dir = r() < 0.5 ? 1 : -1;
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        const a = dir * u * turns * Math.PI * 2;
        const rr = 1 - 0.9 * u;
        line.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
      out.push(line);
      break;
    }
    case 'squiggle': {
      const f = 2 + r() * 1.5;
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        line.push([u * 2 - 1, 0.3 * Math.sin(u * Math.PI * 2 * f)]);
      }
      out.push(line);
      break;
    }
    case 'zigzag': {
      const n = 7 + Math.floor(r() * 4);
      for (let i = 0; i <= n; i++) {
        const x0 = (i / n) * 2 - 1;
        const y0 = i % 2 ? 0.3 : -0.3;
        if (i < n) {
          const x1 = ((i + 1) / n) * 2 - 1;
          const y1 = (i + 1) % 2 ? 0.3 : -0.3;
          for (let k = 0; k < 5; k++) line.push([x0 + ((x1 - x0) * k) / 5, y0 + ((y1 - y0) * k) / 5]);
        } else line.push([x0, y0]);
      }
      out.push(line);
      break;
    }
    case 'loops': {
      const n = 4;
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        const a = u * Math.PI * 2 * n;
        line.push([u * 2 - 1 - 0.18 * Math.sin(a), 0.32 * -Math.cos(a)]);
      }
      out.push(line);
      break;
    }
    case 'ring': {
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2.08;
        line.push([Math.cos(a), Math.sin(a)]);
      }
      out.push(line);
      break;
    }
    default: {
      // sparkle: a long cross and a short one
      const seg = (x0: number, y0: number, x1: number, y1: number) => {
        const l: [number, number][] = [];
        for (let k = 0; k <= 8; k++) l.push([x0 + ((x1 - x0) * k) / 8, y0 + ((y1 - y0) * k) / 8]);
        out.push(l);
      };
      seg(0, -1, 0, 1);
      seg(-1, 0, 1, 0);
      seg(-0.4, -0.4, 0.4, 0.4);
      seg(-0.4, 0.4, 0.4, -0.4);
    }
  }
  // a hand never draws it twice the same: a slow wander over every line
  const o1 = r() * 50;
  const o2 = r() * 50;
  for (const l of out)
    for (const p of l) {
      p[0] += 0.07 * Math.sin(p[1] * 2.3 + o1) + 0.03 * Math.sin(p[0] * 5.1 + o2);
      p[1] += 0.07 * Math.sin(p[0] * 2.1 + o2) + 0.03 * Math.sin(p[1] * 4.7 + o1);
    }
  return out;
}

function buildGarden(aspect: number, variant: Variant, density: number): Garden {
  const r = rng(0x9a2d3 + Math.round(aspect * 100) * 7 + (variant === 'coral' ? 101 : variant === 'doodle' ? 202 : 0));
  const range = (a: number, b: number) => a + (b - a) * r();
  const F = FLORA[variant];
  const plants: Plant[] = [];
  const leaves: Sprite[][] = [[], [], []];
  const flowers: Sprite[][] = [[], [], []];
  const half = aspect / 2;

  const addPlant = (p: Partial<Plant> & Pick2): number => {
    plants.push({
      parent: -1,
      pt: 0,
      bx: 0,
      by: 0,
      k: 0,
      curl: 0,
      fid: 0,
      lag: 0,
      tendril: false,
      flower: false,
      flowerTh: r(),
      delay: 0,
      droop: r() < 0.5 ? -1 : 1,
      g: 0,
      open: 0,
      ov: 0,
      seed: r(),
      ...p,
    } as Plant);
    return plants.length - 1;
  };
  type Pick2 = { layer: number; a0: number; L: number; w: number; rank: number; ink: number };

  const leafSprite = (plant: number, layer: number, at: number, side: number, scale: number, kind?: number) => {
    const kd = kind ?? pick(r, F.leaves);
    const inks = F.leafInk(r, kd);
    const big = kd === K.HEART || kd === K.ROUND ? 0.75 : kd === K.FROND ? 1.25 : kd === K.SPIKE ? 1.2 : kd === K.BLOB ? 1.45 : 1;
    leaves[layer].push({ plant, at, ang: side * range(0.55, 1.15), size: scale * range(0.075, 0.12) * big, kind: kd, inks: [inks[0], inks[1], inks[1]], seed: r(), side, ar: LEAF_AR[kd] * range(0.9, 1.1) });
  };
  const flowerSprite = (plant: number, layer: number, scale: number, kind?: number) => {
    const kd = kind ?? pick(r, F.flowers);
    const inks = F.flowerInk(r, kd);
    const sz = kd === K.BERRY || kd === K.SPRAY ? 0.85 : kd === K.TULIP || kd === K.CONE ? 0.8 : 1;
    flowers[layer].push({ plant, at: -1, ang: 0, size: scale * range(0.055, 0.095) * sz, kind: kd, inks, seed: r(), side: 1, ar: 1 });
    plants[plant].flower = true;
  };

  /** a stem with leaves, maybe branches, a flower or a tendril tip */
  const grow = (layer: number, bx: number, by: number, a0: number, L: number, scale: number, rank: number, opts: { edge?: boolean } = {}) => {
    const leafy = opts.edge || r() < 0.18;
    const ink = pick(r, F.stemInk);
    const id = addPlant({ layer, bx, by, a0, L, k: range(-0.9, 0.9), w: (0.005 + 0.006 * layer) * (scale > 1 ? 1.2 : 1), rank, ink, fid: r() < 0.5 ? range(0.6, 1.4) * (r() < 0.5 ? -1 : 1) : 0 });
    // leaves up the stem, alternating, and a rosette at the foot of the near ones
    const nl = Math.max(1, Math.round((L / (0.075 * scale)) * range(0.5, 0.85) * (leafy ? 1.5 : 1) * (variant === 'coral' ? 0.6 : variant === 'doodle' ? 0.75 : 1)));
    let side = r() < 0.5 ? -1 : 1;
    const leafKind = r() < 0.6 ? pick(r, F.leaves) : undefined;
    for (let j = 0; j < nl; j++) {
      const at = 0.1 + (0.72 * (j + range(0.2, 0.8))) / nl;
      leafSprite(id, layer, at, side, scale * (leafy ? 1.3 : 1) * (1.1 - 0.4 * at), leafKind);
      side = -side;
    }
    if (layer > 0 && r() < 0.6) {
      const rk = r() < 0.5 ? leafKind : undefined;
      leafSprite(id, layer, 0.02, -1, scale * 1.35, rk);
      leafSprite(id, layer, 0.03, 1, scale * 1.25, rk);
    }
    if (!leafy || r() < 0.4) flowerSprite(id, layer, scale);
    // branches: a side flower, berries or a curling tendril
    const nb = r() < 0.7 ? 1 + (r() < 0.4 ? 1 : 0) : 0;
    for (let b = 0; b < nb; b++) {
      const bs = r() < 0.5 ? -1 : 1;
      const tendril = r() < F.tendrils;
      const cl = L * range(0.3, 0.55);
      const cid = addPlant({
        layer,
        parent: id,
        pt: range(0.4, 0.8),
        a0: bs * range(0.45, 0.95),
        L: cl,
        k: bs * range(0.3, 1.6),
        w: plants[id].w * (tendril ? 0.45 : 0.7),
        rank,
        lag: range(0, 0.15),
        ink: plants[id].ink,
        tendril,
        curl: tendril ? bs * range(6, 11) : 0,
        fid: tendril ? bs * range(1, 2) : 0,
      });
      if (tendril) {
        if (r() < 0.6) leafSprite(cid, layer, 0.3, -bs, scale * 0.7);
      } else {
        leafSprite(cid, layer, 0.4, bs, scale * 0.75);
        flowerSprite(cid, layer, scale * 0.8, r() < 0.45 ? (variant === 'doodle' ? K.CUTE : K.BERRY) : undefined);
      }
    }
    return id;
  };

  // back: tall, thin, many; mid: the body of the garden; front: big leaves and a few big heads
  const dens = density * (variant === 'doodle' ? 0.72 : variant === 'coral' ? 0.85 : 1);
  const layers = [
    { n: clamp(6.5 * aspect, 4, 14) * dens, y: [0.06, 0.12], L: [0.55, 0.95], scale: 0.95, rank: 0.25 },
    { n: clamp(5 * aspect, 3, 11) * dens, y: [-0.03, 0.04], L: [0.38, 0.72], scale: 1.3, rank: 0.1 },
    { n: clamp(2.6 * aspect, 2, 6) * dens, y: [-0.16, -0.08], L: [0.26, 0.48], scale: 1.75, rank: 0.0 },
  ];
  const sprouts: number[] = [];
  layers.forEach((cfg, layer) => {
    const n = Math.max(2, Math.round(cfg.n));
    for (let i = 0; i < n; i++) {
      const x = -half * 1.02 + ((i + range(0.15, 0.85)) / n) * aspect * 1.02;
      const lean = -x * 0.25 + range(-0.22, 0.22);
      const rank = clamp(cfg.rank + r() * (1 - cfg.rank) * 0.95, 0, 1);
      const id = grow(layer, x, range(cfg.y[0], cfg.y[1]), Math.PI / 2 + lean, range(cfg.L[0], cfg.L[1]), cfg.scale, rank);
      if (layer > 0 && Math.abs(x) < half * 0.75) sprouts.push(id);
    }
  });
  // edge plants reaching in from the sides, front layer
  const ne = aspect > 1.2 ? 2 : 1;
  for (const sd of [-1, 1]) {
    for (let e = 0; e < ne; e++) {
      const y = range(0.08, 0.5);
      const a = sd < 0 ? range(0.25, 0.85) : Math.PI - range(0.25, 0.85);
      grow(2, sd * (half + 0.04), y, a, range(0.24, 0.4), 1.6, range(0.15, 0.9), { edge: true });
    }
  }
  // the intro's few sprouts: near the middle, first to come up
  sprouts.sort((a, b) => Math.abs(plants[a].bx) - Math.abs(plants[b].bx));
  for (let i = 0; i < Math.min(4, sprouts.length); i++) plants[sprouts[i]].rank = i * 0.015;
  // the drop ripples out from the middle; flowers that open early are the early growers
  for (const p of plants) {
    const tip = p.parent < 0 ? { x: p.bx, y: p.by + p.L * 0.8 } : { x: plants[p.parent].bx, y: 0.5 };
    p.delay = 0.03 + 0.38 * clamp(Math.hypot(tip.x / Math.max(half, 0.4), (tip.y - 0.45) * 1.4), 0, 1.2) + r() * 0.08;
    p.flowerTh = clamp(0.15 + 0.75 * p.rank + (r() - 0.5) * 0.3, 0.05, 0.98);
  }

  // doodles: a set around the flowers that flashes on at the drop, and a set that comes and goes
  const DS = DOODLE_SHAPES[variant];
  const doodles: Doodle[] = [];
  const dInk = (): number =>
    variant === 'coral' ? pick(r, [[I.AC2, 3], [I.FG, 2], [I.AC, 1]]) : variant === 'botanical' ? pick(r, [[I.AC2, 2], [I.FG, 2], [I.PALE, 1]]) : I.FG;
  const fl = flowers.flat().filter((s) => plants[s.plant].layer > 0 || r() < 0.3);
  const nDrop = Math.min(Math.round(16 * Math.min(aspect, 1.9)), fl.length * 2, 34);
  for (let i = 0; i < nDrop; i++) {
    const f = fl[Math.floor(r() * fl.length)];
    const t = stemTip(plants, f.plant);
    const a = r() * Math.PI * 2;
    const dist = f.size * range(1.5, 2.6) + 0.015;
    const shape = pick(r, DS.drop);
    const sz = (shape === 'sparkle' ? 0.7 : 1) * range(0.022, 0.04) * (variant === 'doodle' ? 1.4 : 1);
    const cx = t.x + Math.cos(a) * dist;
    const cy = clamp(t.y + Math.sin(a) * dist, 0.12, 0.96);
    doodles.push(makeDoodle(shape, cx, cy, sz, true));
  }
  for (let i = 0; i < DS.ambientN * Math.min(aspect, 1.9) && doodles.length < MAX_DOODLES; i++) {
    const shape = pick(r, DS.ambient);
    const cx = range(-half * 0.95, half * 0.95);
    const cy = range(0.18, 0.95);
    doodles.push(makeDoodle(shape, cx, cy, range(DS.size[0], DS.size[1]), false));
  }
  function makeDoodle(shape: string, cx: number, cy: number, size: number, drop: boolean): Doodle {
    const rot = r() * Math.PI * 2;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const lines = doodleLines(shape, r).map((l) => l.map(([x, y]) => [(c * x - s * y) * size, (s * x + c * y) * size] as [number, number]));
    return {
      lines,
      cx,
      cy,
      width: (variant === 'doodle' ? 0.0046 : variant === 'coral' ? 0.004 : 0.0038) * range(0.85, 1.2),
      ink: dInk(),
      drop,
      delay: 0.05 + r() * 0.7,
      hold: range(6, 14),
      speed: range(1.4, 2.4),
      offset: r(),
      head: 0,
      tail: 0,
      alpha: 1,
    };
  }

  return { plants, leaves, flowers, doodles };
}

/* ───────────────────────── geometry ───────────────────────── */

const STEM_SEGS = 28;

function stemGeometry(plants: Plant[], layer: number) {
  const pos: number[] = [];
  const info: number[] = [];
  const idx: number[] = [];
  plants.forEach((p, id) => {
    if (p.layer !== layer) return;
    const base = pos.length / 3;
    for (let i = 0; i <= STEM_SEGS; i++) {
      const t = i / STEM_SEGS;
      for (const side of [-1, 1]) {
        pos.push(t, side, id);
        info.push(p.ink, p.seed, p.tendril ? 1 : 0, 0);
      }
    }
    for (let i = 0; i < STEM_SEGS; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
  g.setIndex(idx);
  return g;
}

function quadBase() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  return g;
}

function spriteGeometry(list: Sprite[]) {
  const g = quadBase();
  const A = new Float32Array(list.length * 4);
  const B = new Float32Array(list.length * 4);
  const C = new Float32Array(list.length * 4);
  list.forEach((s, i) => {
    A.set([s.plant, s.at, s.ang, s.size], i * 4);
    B.set([s.kind, s.inks[0], s.inks[1], s.inks[2]], i * 4);
    C.set([s.seed, 0, s.side, s.ar], i * 4);
  });
  g.setAttribute('aA', new THREE.InstancedBufferAttribute(A, 4));
  g.setAttribute('aB', new THREE.InstancedBufferAttribute(B, 4));
  g.setAttribute('aC', new THREE.InstancedBufferAttribute(C, 4));
  g.instanceCount = list.length;
  return g;
}

const N_PETALS = 70;
function petalGeometry(variant: Variant) {
  const r = rng(77);
  const g = quadBase();
  const A = new Float32Array(N_PETALS * 4);
  const B = new Float32Array(N_PETALS * 4);
  const inks: [number, number][] =
    variant === 'coral'
      ? [
          [I.FG, I.AC],
          [I.PALE, I.AC2],
        ]
      : variant === 'doodle'
        ? [
            [I.AC2, I.FG],
            [I.AC, I.FG],
          ]
        : [
            [I.FG, I.AC],
            [I.AC, I.FG],
            [I.AC2, I.AC],
            [I.PINK, I.FG],
          ];
  for (let i = 0; i < N_PETALS; i++) {
    const ink = inks[Math.floor(r() * inks.length)];
    A.set([r(), r(), 0.05 + r() * 0.07, 0.008 + r() * 0.01], i * 4);
    B.set([K.PETAL, ink[0], ink[1], r()], i * 4);
  }
  g.setAttribute('aA', new THREE.InstancedBufferAttribute(A, 4));
  g.setAttribute('aB', new THREE.InstancedBufferAttribute(B, 4));
  g.instanceCount = N_PETALS;
  return g;
}

function doodleGeometry(doodles: Doodle[]) {
  const pos: number[] = [];
  const aD: number[] = [];
  const aN: number[] = [];
  const ink: number[] = [];
  const idx: number[] = [];
  doodles.forEach((d, di) => {
    let total = 0;
    for (const l of d.lines) for (let i = 1; i < l.length; i++) total += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
    let run = 0;
    for (const l of d.lines) {
      const base = pos.length / 3;
      for (let i = 0; i < l.length; i++) {
        if (i > 0) run += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
        const a = l[Math.max(0, i - 1)];
        const b = l[Math.min(l.length - 1, i + 1)];
        let nx = -(b[1] - a[1]);
        let ny = b[0] - a[0];
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl;
        ny /= nl;
        for (const side of [-1, 1]) {
          pos.push(l[i][0], l[i][1], 0);
          aD.push(run / Math.max(total, 1e-6), side, di, d.width);
          aN.push(nx, ny, d.cx, d.cy);
          ink.push(d.ink);
        }
      }
      for (let i = 0; i < l.length - 1; i++) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aD', new THREE.Float32BufferAttribute(aD, 4));
  g.setAttribute('aN', new THREE.Float32BufferAttribute(aN, 4));
  g.setAttribute('aInkD', new THREE.Float32BufferAttribute(ink, 1));
  g.setIndex(idx);
  return g;
}

/* ───────────────────────── the song as gardener ───────────────────────── */

interface SongState {
  grow: number;
  bloom: number;
  wilt: number;
  drift: number;
  slow: number;
}

/** where the garden should be at this point of the song (from the analysis, so it's the same however you got here) */
function songState(an: TrackAnalysis, t: number, intensity: number, pace: number): SongState {
  let g = 0;
  let climaxed = false;
  let cur = an.sections[0];
  let curFrac = 0;
  for (const s of an.sections) {
    if (s.start > t) break;
    const frac = clamp((t - s.start) / Math.max(0.01, s.end - s.start), 0, 1);
    cur = s;
    curFrac = frac;
    switch (s.label) {
      case 'intro':
        g += 0.12 * frac;
        break;
      case 'verse':
        g += 0.42 * frac;
        break;
      case 'chorus':
        g += 0.36 * frac;
        climaxed = climaxed || frac > 0.5;
        break;
      case 'bridge':
        g += 0.12 * frac;
        break;
      case 'build':
        g += 0.34 * Math.pow(frac, 1.5);
        break;
      case 'drop':
        g = 1;
        climaxed = true;
        break;
      default:
        break;
    }
  }
  const ahead = an.drops.some((d) => d > t + 0.05) || an.sections.some((s) => s.start > t && (s.label === 'drop' || s.label === 'chorus'));
  if (!climaxed && ahead) g = Math.min(g, 0.84);
  g = clamp(1 - Math.pow(1 - clamp(g, 0, 1), pace), 0, 1);

  let bloom = 0;
  let wilt = 0;
  let drift = 0;
  let slow = 0;
  switch (cur.label) {
    case 'intro':
      bloom = climaxed ? 0.3 : 0;
      break;
    case 'verse':
      bloom = climaxed ? 0.38 : 0.06 + 0.22 * curFrac;
      break;
    case 'chorus':
      bloom = 0.55 + 0.45 * clamp(intensity * 1.2, 0, 1);
      break;
    case 'bridge':
      bloom = 0.4;
      slow = 0.5;
      break;
    case 'build':
      bloom = climaxed ? 0.3 : 0.2;
      break;
    case 'drop':
      bloom = 1;
      drift = 0.25;
      break;
    case 'break':
      bloom = 0.72;
      drift = 0.75;
      slow = 1;
      break;
    case 'outro':
      bloom = 0.65 * (1 - curFrac);
      wilt = sstep(0.05, 0.85, curFrac);
      drift = 0.4 + 0.5 * wilt;
      slow = 0.6;
      break;
  }
  return { grow: g, bloom, wilt, drift, slow };
}

/** the lead line's pitch at time t, 0..1 over about three octaves (−1 when nothing is sounding) */
function leadPitch(an: TrackAnalysis | null, t: number, cache: { i: number }): number {
  const notes = an?.layers?.lead;
  if (!notes?.length) return -1;
  let i = Math.min(cache.i, notes.length - 1);
  if (notes[i].t > t) i = 0;
  while (i < notes.length - 1 && notes[i + 1].t <= t) i++;
  cache.i = i;
  const n = notes[i];
  return t >= n.t && t < n.end ? clamp((n.midi - 52) / 36, 0, 1) : -1;
}

/* ───────────────────────── palette inks ───────────────────────── */

const _c = new THREE.Color();
function vivid(bg: THREE.Color, fallback: THREE.Color, out: THREE.Color) {
  const l = bg.r * 0.2126 + bg.g * 0.7152 + bg.b * 0.0722;
  const cr = bg.r - l;
  const cg = bg.g - l;
  const cb = bg.b - l;
  const m = Math.max(Math.abs(cr), Math.abs(cg), Math.abs(cb));
  if (m < 0.025) return out.copy(fallback);
  const k = 0.36 / m;
  const base = l > 0.5 ? 0.42 : 0.58;
  return out.setRGB(clamp(base + cr * k, 0, 1), clamp(base + cg * k, 0, 1), clamp(base + cb * k, 0, 1));
}

/* ───────────────────────── scene ───────────────────────── */

export const garden: SceneDef = {
  id: 'garden',
  name: 'Garden',
  description:
    'An illustrated garden the song grows: flat bold flowers, two-tone leaves with vein lines, berries, dot-filled petals and curling tendrils, layered in depth. The intro is bare ground with a few buds; verses grow and curl the stems in surges so leaves unfurl on each phrase; a build hurries the growth, swells the buds and sends tendrils reaching; the drop bursts everything into bloom at once with a pop of colour while doodle stars, spirals and sparkles draw themselves on around the flowers; the break sways slowly with petals drifting down, and the outro closes up and wilts. Kicks pop the open flowers, hats twinkle the dot fills, the melody curls the tendrils. Three styles: Botanical (bold flat flora on a dark ground), Coral (blue and white coral forms with squiggle linework on warm orange) and Doodle (glowing marker linework on dark green).',
  category: 'form',
  style: 'world',
  tags: ['playful', 'joyful', 'hopeful', 'quirky', 'warm', 'psychedelic', 'tender', 'happy', 'uplifting', 'organic', 'nature', 'graphic', 'tactile', 'indie', 'pop', 'folk', 'acoustic', 'dreamy', 'whimsical'],
  params,
  modulations: [],
  create(init) {
    const { shared } = init;
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const scene = new THREE.Scene();

    const inks = Array.from({ length: N_INK }, () => new THREE.Color());
    let plantTex: THREE.DataTexture | null = null;
    let plantData = new Float32Array(4);
    const lib = () => ({
      uPlants: { value: null as THREE.Texture | null },
      uPlantW: { value: 64 },
      uCurlMod: { value: 1 },
      uPar: { value: new THREE.Vector2() },
      uBoil: { value: 0 },
      uWobble: { value: 1 },
      uPad: { value: 0 },
      uInk: { value: inks },
      uFill: { value: 1 },
      uTint: { value: 1 },
      uLine: { value: 0 },
      uCore: { value: 0 },
      uGlow: { value: 0 },
      uRim: { value: 0 },
      uContour: { value: 0 },
      uHalftone: { value: 0 },
      uGrain: { value: 1 },
      uLineMode: { value: 0 },
      uLineC: { value: new THREE.Color() },
      uCoreC: { value: new THREE.Color() },
      uGlowC: { value: new THREE.Color() },
      uRimC: { value: new THREE.Color() },
      uHatN: { value: 0 },
      uHatEnv: { value: 0 },
      uTwinkle: { value: 1 },
      uSwell: { value: 0 },
      uTremble: { value: 0 },
      uDrift: { value: 0 },
      uDriftT: { value: 0 },
    });
    const blend = { transparent: true, depthTest: false, depthWrite: false, premultipliedAlpha: true, blending: THREE.NormalBlending, side: THREE.DoubleSide };
    const stemMat = makeMaterial({ params, shared, vertex: STEM_VERT, fragment: STEM_FRAG, extra: lib(), ...blend });
    const spriteMat = makeMaterial({ params, shared, vertex: SPRITE_VERT, fragment: SPRITE_FRAG, extra: lib(), ...blend });
    const petalMat = makeMaterial({ params, shared, vertex: PETAL_VERT, fragment: SPRITE_FRAG, extra: lib(), ...blend });
    const doodleMat = makeMaterial({ params, shared, vertex: DOODLE_VERT, fragment: DOODLE_FRAG, extra: { ...lib(), uDood: { value: Array.from({ length: MAX_DOODLES }, () => new THREE.Vector4()) } }, ...blend });
    const bgMat = makeMaterial({
      params,
      shared,
      vertex: BACKDROP_VERT,
      fragment: BG_FRAG,
      extra: {
        uInk: { value: inks },
        uGroundC: { value: new THREE.Color() },
        uLightC: { value: new THREE.Color() },
        uLightK: { value: 0 },
        uGrainK: { value: 1 },
        uPaint: { value: 0 },
        uHatN: { value: 0 },
        uHatEnv: { value: 0 },
        uTwinkle: { value: 1 },
        uBoil: { value: 0 },
        uPar: { value: new THREE.Vector2() },
      },
    });
    const bg = makeBackdrop(bgMat);
    scene.add(bg);
    const mats = [stemMat, spriteMat, petalMat, doodleMat];

    let G: Garden | null = null;
    let meshes: THREE.Mesh[] = [];
    let builtKey = '';
    let variant: Variant = 'botanical';

    const build = (aspect: number, v: Variant, density: number) => {
      for (const m of meshes) {
        scene.remove(m);
        m.geometry.dispose();
      }
      meshes = [];
      G = buildGarden(aspect, v, density);
      variant = v;
      const n = G.plants.length;
      let w = 64;
      while (w < n) w *= 2;
      plantData = new Float32Array(w * 4 * 4);
      G.plants.forEach((p, i) => {
        const o0 = i * 4;
        const o1 = (w + i) * 4;
        const o2 = (2 * w + i) * 4;
        plantData.set([p.bx, p.by, p.a0, p.L], o0);
        plantData.set([p.k, p.curl, p.w, p.parent], o1);
        plantData.set([p.pt, p.fid, p.layer, p.seed], o2);
      });
      plantTex?.dispose();
      plantTex = new THREE.DataTexture(plantData, w, 4, THREE.RGBAFormat, THREE.FloatType);
      plantTex.minFilter = plantTex.magFilter = THREE.NearestFilter;
      plantTex.colorSpace = THREE.NoColorSpace;
      plantTex.generateMipmaps = false;
      plantTex.needsUpdate = true;
      for (const m of mats) {
        m.uniforms.uPlants.value = plantTex;
        m.uniforms.uPlantW.value = w;
      }
      let order = 0;
      const add = (geo: THREE.BufferGeometry, mat: THREE.ShaderMaterial) => {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = order++;
        scene.add(mesh);
        meshes.push(mesh);
      };
      for (let l = 0; l < 3; l++) {
        add(stemGeometry(G.plants, l), stemMat);
        add(spriteGeometry(G.leaves[l]), spriteMat);
        add(spriteGeometry(G.flowers[l]), spriteMat);
        if (l === 1) add(doodleGeometry(G.doodles), doodleMat);
      }
      add(petalGeometry(v), petalMat);
      first = true;
    };

    /* live state */
    let first = true;
    let lastT = -1;
    let grow = 0;
    let bloom = 0;
    let wilt = 0;
    let drift = 0;
    let driftT = 0;
    let slow = 0;
    let swell = 0;
    let curl = 1;
    let spurt = 0;
    let life = 0.08;
    let boil = 0;
    let boilClock = 0;
    let hatN = 0;
    let kickN = 0;
    let envA = 0;
    let envB = 0;
    const popA = { x: 0, v: 0 };
    const popB = { x: 0, v: 0 };
    let lastBeat = -1;
    let lastSection = -2;
    let flash = 0;
    let sat = 1;
    const lead = { i: 0 };
    const par = new THREE.Vector2();
    let parT = 0;

    const spring = (s: { x: number; v: number }, target: number, w: number, z: number, dt: number) => {
      const h = dt / 3;
      for (let i = 0; i < 3; i++) {
        s.v += (w * w * (target - s.x) - 2 * z * w * s.v) * h;
        s.x += s.v * h;
      }
      return s.x;
    };

    return {
      render(frame: FrameContext, target) {
        const dt = stepDt(frame);
        const p = frame.params;
        const a = frame.audio;
        const fe = frame.feel;
        const v = (['botanical', 'coral', 'doodle'].includes(str(p, 'style', 'botanical')) ? str(p, 'style', 'botanical') : 'botanical') as Variant;
        const density = num(p, 'density', 1);
        const key = `${frame.aspect.toFixed(2)}|${v}|${density.toFixed(2)}`;
        if (key !== builtKey) {
          build(frame.aspect, v, density);
          builtKey = key;
        }
        const gd = G!;
        const T = TREAT[variant];

        // a jump (a seek, a cut into the middle of the song, a new song): take the state as it should be
        const jumped = first || lastT < 0 || Math.abs(a.time - lastT) > 1.5;
        lastT = a.time;

        /* where the song has got to */
        const an = frame.analysis;
        const pace = num(p, 'pace', 1);
        let st: SongState;
        if (an?.sections.length && a.duration > 0) st = songState(an, a.time, fe.intensity, pace);
        else {
          // live: the garden grows with how much music it has heard, and blooms when it is loud
          life = clamp(life + dt * (0.004 + 0.02 * fe.intensity) * pace, 0, 1);
          st = { grow: life, bloom: sstep(0.35, 0.8, fe.intensity), wilt: 0, drift: 0.2 * (1 - fe.intensity), slow: 1 - sstep(0.2, 0.5, fe.intensity) };
        }
        // phrases: growth comes in surges, so leaves unfurl on the phrase
        if (a.beat && a.beatCount !== lastBeat && a.beatCount % 16 === 0) spurt = 1;
        if (fe.sectionIndex !== lastSection) {
          if (lastSection > -2) spurt = 1;
          lastSection = fe.sectionIndex;
        }
        lastBeat = a.beatCount;
        spurt *= Math.exp(-dt * 0.9);
        const sinceDrop = fe.sinceDrop;
        const dropping = sinceDrop < 0.6;
        if (jumped) {
          grow = st.grow;
          bloom = st.bloom;
          wilt = st.wilt;
          drift = st.drift;
          slow = st.slow;
        } else {
          const rate = dropping ? 8 : (0.12 + 1.4 * spurt) * (1 + 2.5 * fe.tension);
          grow += (Math.max(grow, st.grow) - grow) * (1 - Math.exp(-rate * dt));
          if (st.grow < grow - 0.2) grow += (st.grow - grow) * (1 - Math.exp(-0.3 * dt));
          bloom += (st.bloom - bloom) * (1 - Math.exp(-(dropping ? 20 : 0.8) * dt));
          wilt += (st.wilt - wilt) * (1 - Math.exp(-0.5 * dt));
          drift += (st.drift - drift) * (1 - Math.exp(-0.6 * dt));
          slow += (st.slow - slow) * (1 - Math.exp(-0.5 * dt));
        }
        swell += (fe.tension - swell) * (1 - Math.exp(-(fe.tension > swell ? 3 : 10) * dt));
        // the last breath before a known drop: buds held tight
        const inhale = fe.toDrop < 1.2 ? 1 - fe.toDrop / 1.2 : 0;

        // the melody curls the tendrils; harmonic tension winds them tighter
        const lp = leadPitch(an, a.time, lead);
        const mel = lp >= 0 ? lp : clamp(a.mid * 1.3, 0, 1);
        const curlT = (0.55 + 0.75 * mel + 0.35 * fe.harmony + 0.4 * fe.tension) * num(p, 'curl', 1);
        curl += (curlT - curl) * (1 - Math.exp(-(jumped ? 99 : 2.2) * dt));

        // kicks: half the flowers pop on one kick, half on the next
        const popK = num(p, 'pop', 1);
        if (a.kickHit) {
          kickN++;
          const k = (0.55 + 0.45 * Math.min(1, a.kick)) * popK;
          if (kickN % 2) envA = k;
          else envB = k;
        }
        envA *= Math.exp(-dt / 0.11);
        envB *= Math.exp(-dt / 0.11);
        spring(popA, envA, 26, 0.42, dt);
        spring(popB, envB, 26, 0.42, dt);
        if (a.hatHit) hatN = (hatN + 1) % 997;

        // a new drawing ten times a second, and on every kick and snare so hits land
        boilClock += dt;
        if (boilClock > 0.1 || a.kickHit || a.snareHit) {
          boilClock = 0;
          boil = (boil + 1) % 997;
        }

        /* every plant */
        const plants = gd.plants;
        const w = plantData.length / 16;
        const swayK = num(p, 'sway', 1);
        const bloomK = num(p, 'bloom', 1);
        const gust = fe.gust;
        for (let i = 0; i < plants.length; i++) {
          const pl = plants[i];
          let g: number;
          if (pl.parent < 0) g = clamp(Math.max((grow - pl.rank * 0.62) / 0.38, pl.rank < 0.05 ? grow / 0.07 - pl.rank * 12 : 0), 0, 1);
          else {
            const pg = plants[pl.parent].g;
            g = clamp(((pg - pl.pt) / (1 - pl.pt)) * 1.3 - pl.lag, 0, 1);
          }
          // tendrils hold back, then reach in builds and on the drop
          if (pl.tendril) g = Math.min(g, 0.55 + 0.45 * Math.max(sstep(0.1, 0.8, fe.tension), fe.release, 0.35 * fe.intensity));
          pl.g = g;
          // open: the flower's own spring
          let tgt = 0;
          if (pl.flower) {
            const grown = sstep(0.82, 1, g);
            tgt = bloom >= pl.flowerTh ? 1 : 0;
            if (sinceDrop < 3) tgt = sinceDrop >= pl.delay ? 1 : 0;
            if (inhale > 0.3) tgt = 0;
            tgt *= grown;
            if (wilt > 0) tgt = Math.min(tgt, 1 - 0.85 * wilt);
          }
          if (jumped) {
            pl.open = tgt;
            pl.ov = 0;
          } else {
            const burst = sinceDrop < 3 && tgt > 0.5;
            const om = burst ? 16 : 5;
            const z = burst ? 0.55 - 0.3 * clamp(bloomK, 0, 1.5) * 0.6 : 0.85;
            const h = dt / 3;
            for (let k = 0; k < 3; k++) {
              pl.ov += (om * om * (tgt - pl.open) - 2 * z * om * pl.ov) * h;
              pl.open += pl.ov * h;
            }
          }
          const pop = (i % 2 ? popA.x : popB.x) * clamp(pl.open, 0, 1);
          // the wind: a travelling sway, a lean downwind, a slow rock in the quiet, a shiver on the mids
          const lay = 0.55 + 0.25 * pl.layer;
          const ph = fe.windPhase * 1.7 + pl.bx * 2.2 + pl.seed * 6.28;
          let bend = swayK * lay * (0.05 + 0.3 * gust) * Math.sin(ph);
          bend -= swayK * fe.windX * gust * 0.14 * lay;
          bend += swayK * slow * 0.22 * Math.sin(frame.time * 0.55 + pl.seed * 6.28);
          bend += swayK * 0.04 * a.mid * Math.sin(frame.time * 6.5 + pl.seed * 40);
          bend += wilt * pl.droop * (0.6 + 0.5 * pl.seed) * (pl.parent < 0 ? 1 : 0.6);
          const o3 = (3 * w + i) * 4;
          plantData[o3] = g;
          plantData[o3 + 1] = pl.open;
          plantData[o3 + 2] = pop;
          plantData[o3 + 3] = bend;
        }
        plantTex!.needsUpdate = true;
        first = false;

        /* doodles */
        const dK = num(p, 'doodles', 1);
        const du = doodleMat.uniforms.uDood.value as THREE.Vector4[];
        const beatPos = a.bpm > 0 ? a.beatCount : frame.time * 2;
        const amb =
          dK *
          (variant === 'doodle' ? (0.2 + 0.6 * fe.intensity) * (0.4 + 0.6 * grow) : variant === 'coral' ? (0.12 + 0.5 * grow) * (0.6 + 0.4 * fe.intensity) : 0.12 * fe.intensity) *
          (0.25 + 0.75 * grow) *
          (1 - 0.6 * wilt);
        gd.doodles.forEach((d, i) => {
          let want: boolean;
          if (d.drop) {
            const hold = d.hold * (variant === 'doodle' ? 1.6 : 1) * dK;
            want = dK > 0.02 && sinceDrop >= d.delay && sinceDrop < d.delay + hold;
            if (!want && fe.section === 'chorus' && !an?.drops.length) want = hashN(i * 7.1 + Math.floor((beatPos + d.offset * 16) / 8)) < 0.35 * fe.intensity * dK;
          } else want = hashN(i * 13.1 + Math.floor((beatPos + d.offset * 16) / 8) * 7.7) < amb;
          const fast = sinceDrop < 2 ? 2.2 : 1;
          if (jumped) {
            d.head = want ? 1 : 0;
            d.tail = 0;
          } else if (want) {
            if (d.tail > 0) {
              d.tail = Math.min(d.head, d.tail + dt * 1.6);
              if (d.tail >= d.head - 1e-4) d.head = d.tail = 0;
            } else d.head = Math.min(1, d.head + dt * d.speed * fast);
          } else if (d.head > 0) {
            d.tail = Math.min(d.head, d.tail + dt * 1.3);
            if (d.tail >= d.head - 1e-4) d.head = d.tail = 0;
          }
          // a little pop as they land
          const sc = 1 + 0.25 * Math.exp(-sinceDrop * 3) * (d.drop ? 1 : 0) + 0.08 * (i % 2 ? popA.x : popB.x);
          du[i].set(d.head, d.tail, d.head > 0 ? 1 : 0, sc);
        });
        for (let i = gd.doodles.length; i < MAX_DOODLES; i++) du[i].set(0, 0, 0, 1);

        /* colour: held back early, a pop on the drop, fading as it wilts */
        const satT = clamp(0.84 + 0.16 * fe.intensity + 0.32 * fe.release - 0.12 * swell - 0.45 * wilt, 0.35, 1.35);
        sat += (satT - sat) * (1 - Math.exp(-(sinceDrop < 0.5 ? 25 : 1.5) * dt));
        if (jumped) sat = satT;
        flash = Math.exp(-sinceDrop * 3.5) * Math.min(1, bloomK);
        const pc = frame.palette.c;
        inks[I.BG].copy(pc.bg);
        inks[I.FG].copy(pc.fg);
        inks[I.AC].copy(pc.accent);
        inks[I.AC2].copy(pc.accent2);
        inks[I.MU].copy(pc.muted);
        inks[I.ORANGE].copy(pc.accent).lerp(pc.accent2, 0.5);
        inks[I.PINK].copy(pc.accent).lerp(pc.fg, 0.48);
        inks[I.LIME].copy(pc.muted).lerp(pc.accent2, 0.36).multiplyScalar(1.22);
        inks[I.DEEP].copy(pc.muted).lerp(pc.bg, 0.48);
        vivid(pc.bg, _c.copy(pc.accent).lerp(pc.fg, 0.4), inks[I.VIVID]);
        inks[I.PALE].copy(pc.accent2).lerp(pc.fg, 0.5);
        const bgL = pc.bg.r * 0.2126 + pc.bg.g * 0.7152 + pc.bg.b * 0.0722;
        inks[I.DARK].copy(pc.bg).multiplyScalar(bgL > 0.5 ? 0.35 : 0.55);
        for (let i = 1; i < N_INK; i++) {
          const c = inks[i];
          const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
          c.setRGB(clamp(l + (c.r - l) * sat, 0, 1), clamp(l + (c.g - l) * sat, 0, 1), clamp(l + (c.b - l) * sat, 0, 1));
        }
        // the ground darkens a touch while it winds up, and flushes with colour on the drop
        inks[I.BG].multiplyScalar(1 - 0.18 * swell * (bgL > 0.5 ? 0.5 : 1)).lerp(inks[I.VIVID], 0.05 * flash);

        /* treatment, wind and depth drift into the shaders */
        const parK = num(p, 'parallax', 1);
        parT += dt * (0.5 + 0.8 * fe.intensity);
        par.set((0.018 * Math.sin(parT * 0.11) + 0.012 * fe.windX * gust) * parK, 0.006 * Math.sin(parT * 0.083) * parK);
        const twinkle = num(p, 'twinkle', 1);
        const wob = num(p, 'wobble', 1);
        const grain = num(p, 'grain', 1);
        driftT += dt * (0.6 + 0.5 * gust);
        for (const m of mats) {
          const u = m.uniforms;
          syncMaterial(m, frame, params);
          u.uCurlMod.value = curl;
          (u.uPar.value as THREE.Vector2).copy(par);
          u.uBoil.value = boil;
          u.uWobble.value = wob;
          u.uPad.value = T.pad;
          u.uFill.value = T.fill;
          u.uTint.value = T.tint;
          u.uLine.value = T.line;
          u.uCore.value = T.core;
          u.uGlow.value = T.glow * (0.8 + 0.3 * fe.intensity + 0.4 * flash);
          u.uRim.value = T.rim;
          u.uContour.value = T.contour;
          u.uHalftone.value = T.halftone;
          u.uGrain.value = grain;
          u.uHatN.value = hatN;
          u.uHatEnv.value = a.hat;
          u.uTwinkle.value = twinkle;
          u.uSwell.value = swell * (1 - inhale * 0.3) + inhale * 0.4;
          u.uTremble.value = swell * swell + inhale;
          u.uDrift.value = clamp(drift * num(p, 'petals', 1), 0, 1);
          u.uDriftT.value = driftT;
          (u.uLineC.value as THREE.Color).copy(variant === 'doodle' ? inks[I.AC] : inks[I.AC]);
          (u.uCoreC.value as THREE.Color).copy(inks[I.FG]);
          (u.uGlowC.value as THREE.Color).copy(inks[I.AC]);
          (u.uRimC.value as THREE.Color).copy(inks[I.AC]);
          u.uLineMode.value = variant === 'doodle' ? 2 : variant === 'coral' ? 1 : 0;
        }
        // doodle strokes: marker lines in the doodle style, a soft glowing ink line in the others
        const du2 = doodleMat.uniforms;
        du2.uLineMode.value = variant === 'doodle' ? 2 : variant === 'botanical' ? 2 : 0;
        du2.uPad.value = variant === 'doodle' ? T.pad : variant === 'botanical' ? 0.25 : 0;
        du2.uGlow.value = T.dGlow * (0.8 + 0.6 * flash);
        if (variant === 'botanical') {
          (du2.uLineC.value as THREE.Color).copy(inks[I.AC2]);
          (du2.uCoreC.value as THREE.Color).copy(inks[I.FG]);
          (du2.uGlowC.value as THREE.Color).copy(inks[I.AC2]);
          du2.uCore.value = 1;
        }

        const bu = bgMat.uniforms;
        syncMaterial(bgMat, frame, params);
        (bu.uGroundC.value as THREE.Color).copy(inks[I.BG]).lerp(inks[variant === 'coral' ? I.AC2 : I.MU], variant === 'coral' ? 0.16 : 0.2).multiplyScalar(variant === 'doodle' ? 0.8 : 0.92);
        (bu.uLightC.value as THREE.Color).copy(variant === 'doodle' ? inks[I.AC] : inks[I.AC2]);
        bu.uLightK.value = (variant === 'doodle' ? 0.16 : variant === 'botanical' ? 0.05 : 0.04) * (0.6 + 0.5 * fe.intensity + 0.3 * a.bass + 0.4 * flash) * (1 - 0.5 * wilt);
        bu.uGrainK.value = grain;
        bu.uPaint.value = variant === 'coral' ? 1 : 0.35;
        bu.uHatN.value = hatN;
        bu.uHatEnv.value = a.hat;
        bu.uTwinkle.value = twinkle;
        bu.uBoil.value = boil;
        (bu.uPar.value as THREE.Vector2).copy(par);

        frame.renderer.setRenderTarget(target);
        frame.renderer.render(scene, camera);
      },
      dispose() {
        for (const m of meshes) m.geometry.dispose();
        bg.geometry.dispose();
        plantTex?.dispose();
        for (const m of [...mats, bgMat]) m.dispose();
      },
    };
  },
};
