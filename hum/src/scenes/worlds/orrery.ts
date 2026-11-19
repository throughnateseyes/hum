import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { ParamDef } from '../../core/types';
import { BACKDROP_VERT, approach, beatsPerSecond, isLightPalette, makeBackdrop, makeMaterial, Spring, stepDt, syncMaterial } from '../three/common';

/*
 * Orrery: something vast turns in the sky, and it is looking at you. The feeling is sacred awe, the
 * "be not afraid" kind: being seen by a thing far too big to understand, dread and love at once, the
 * swell in a song that is too big for your chest.
 *
 * The picture:
 * - A backdrop quad paints a bright, overexposed sky of layered `tfbm` clouds lit from the shared
 *   `feel.light`, with rays pouring from behind the object, and the burst ring of light on a drop.
 * - Five armillary bands (lathed rounded-rectangle profiles, matte rose-gold) turn like clockwork,
 *   each on its own tempo-locked clock (one turn per bar, per two bars, per phrase…). Kicks tick
 *   them forward like an escapement, bass adds a slow precession wobble.
 * - Every band is studded with small eyes in metal bezels (one instanced quad per eye, shaded as a
 *   dome with an iris that can look anywhere). Hats, snares and kicks each send a blink rippling
 *   round their own band, starting at the point nearest you.
 * - At the heart one great eye, half wrapped in torn paper lids. The low end dilates its pupil, the
 *   mids shimmer its iris fibres, its gaze drifts, and at each phrase it looks straight at you.
 * - A front quad lays the cloud sea over the bottom of the frame (calm, for the lyrics), a few veils
 *   of cloud across the object when it is quiet, and a rock ledge with one tiny, still witness.
 *
 * The arc: quiet = rings nearly still and sunk in cloud, the eyes asleep, the great eye half-lidded.
 * Chorus = everything turning, the cloud parted, light pouring. Tension swings the rings into one
 * plane like a halo, spinning faster, every small eye turning to the centre, the clouds darkening
 * and drawing in. The drop opens the great eye wide, throws the rings onto wild new axes and bursts
 * a ring of light through the cloud; the release keeps the glow while they spin down.
 *
 * Palette roles: bg = bright cloud white (and the paper, the sclera), muted = cloud shadow and rock,
 * fg = the dark of pupils and the figure, accent = rose-gold metal, accent2 = iris blue.
 * Dark palettes work too: the clouds are then lit by the accent, like a gilded night.
 *
 * Nothing multiplies time by an audio level: every turn, shimmer and drift is integrated in update().
 */

const MAX_RINGS = 5;
const RING_R = [1.52, 1.29, 1.07, 0.87, 0.69]; // band centre radius
const BAND_W = 0.085; // radial thickness
const BAND_HH = 0.118; // half height (along the ring's axis)
const EYE_R = 0.108; // eye + bezel radius
const EYE_GAP = 0.25; // spacing round a band
const GREAT_R = 0.5;
const SPIN_BARS = [4, 2, 8, 1, 16]; // bars per turn of a band about its own axis (the eyes travel)
const TUMBLE_BARS = [16, 8, 32, 6, 12]; // bars per turn about a diameter
const R_EXT = 1.66; // object extent incl. eyes

const params: ParamDef[] = [
  { id: 'size', label: 'Size', group: 'Shape', type: 'number', min: 0.7, max: 1.2, step: 0.01, default: 1 },
  { id: 'rings', label: 'Rings', group: 'Shape', type: 'number', min: 3, max: 5, step: 1, default: 5 },
  { id: 'turn', label: 'Turn speed', group: 'Motion', type: 'number', min: 0.25, max: 2, step: 0.01, default: 1, hint: 'Multiplies every band clock (they stay locked to the tempo)' },
  { id: 'tick', label: 'Kick tick', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Each kick ticks the bands forward like an escapement' },
  { id: 'blink', label: 'Blink ripples', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8, hint: 'Hats, snares and kicks ripple blinks round their own band' },
  { id: 'halo', label: 'Build halo', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.85, hint: 'Tension swings the bands into one plane and turns every eye to the centre' },
  { id: 'burst', label: 'Drop burst', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8, hint: 'The drop flings the bands onto new axes and bursts light through the cloud' },
  { id: 'cloud', label: 'Cloud', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55 },
  { id: 'glow', label: 'Light rays', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
  { id: 'sheen', label: 'Metal sheen', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45, hint: 'Matte rose-gold → polished' },
];

/* shared metal + haze shading for the bands and the bezels / lids of the small eyes */
const GLSL_METAL = /* glsl */ `
uniform vec3 uMetal, uMetalShade, uMetalHi, uSkyCol, uGroundCol, uHazeCol, uKey;
uniform float uHaze, uSheen, uSeaY;
vec3 orMetal(vec3 n, vec3 wp, float ao) {
  vec3 V = normalize(cameraPosition - wp);
  float w = 0.65;
  float diff = clamp((dot(n, uKey) + w) / (1.0 + w), 0.0, 1.0);
  diff = diff * diff * (3.0 - 2.0 * diff);
  vec3 col = mix(uMetalShade, uMetal, diff);
  col *= mix(0.86, 1.04, 0.5 + 0.5 * n.y);
  // satin metal: tinted reflection of a bright sky over a darker cloud floor
  vec3 R = reflect(-V, n);
  vec3 env = mix(uGroundCol, uSkyCol, smoothstep(-0.35, 0.55, R.y));
  col = mix(col, uMetal * env * 1.25, 0.18 + 0.3 * uSheen);
  vec3 H = normalize(uKey + V);
  float nh = max(dot(n, H), 0.0);
  col += uMetalHi * (pow(nh, 18.0) * (0.12 + 0.35 * uSheen) + pow(nh, 160.0) * uSheen * 0.9);
  col *= ao;
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  col = mix(col, uSkyCol, fres * 0.45); // overexposed rim from the white world
  return col;
}
vec3 orHaze(vec3 col, vec3 wp) {
  float h = uHaze + (1.0 - uHaze) * 0.85 * smoothstep(uSeaY + 0.15, uSeaY - 0.55, wp.y);
  return mix(col, uHazeCol, clamp(h, 0.0, 1.0));
}
`;

const RING_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
varying vec3 vL;
void main() {
  vL = position;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const RING_FRAG = /* glsl */ `
${GLSL_METAL}
uniform float uR;
varying vec3 vN;
varying vec3 vW;
varying vec3 vL;
void main() {
  vec3 n = normalize(vN);
  float rr = length(vL.xz);
  float yy = vL.y / ${BAND_HH.toFixed(4)};
  // engraved grooves along the outer face, graduation ticks on the flat faces
  float outer = smoothstep(uR + ${(BAND_W * 0.3).toFixed(4)}, uR + ${(BAND_W * 0.46).toFixed(4)}, rr);
  float gy = abs(abs(yy) - 0.9);
  float groove = outer * (1.0 - smoothstep(0.0, fwidth(yy) * 1.2 + 0.035, gy));
  float side = smoothstep(0.9, 0.99, abs(yy)) * (1.0 - outer);
  float ang = atan(vL.z, vL.x);
  float tk = abs(fract(ang * 72.0 / TAU) - 0.5);
  float tw = fwidth(ang * 72.0 / TAU) + 0.04;
  float major = step(0.5, fract(ang * 8.0 / TAU + 0.02)) ;
  float tick = side * (1.0 - smoothstep(0.5 - tw * (1.0 + major), 0.5 - tw * 0.3, tk)) * smoothstep(uR + 0.02, uR - 0.012, rr);
  float ao = 1.0 - groove * 0.4 - tick * 0.3;
  vec3 col = orMetal(n, vW, ao);
  col = orHaze(col, vW);
  col += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

const EYE_VERT = /* glsl */ `
attribute vec4 aEye; // ring, angle, seed, tint
uniform mat4 uRingM[${MAX_RINGS}];
uniform float uRipT[${MAX_RINGS}];
uniform float uRipA[${MAX_RINGS}];
uniform float uRings, uInward, uBlinkAmt, uIdleT, uSmallOpen;
uniform vec3 uCenter;
varying vec2 vQ;
varying vec3 vN;
varying vec3 vT;
varying vec3 vB;
varying vec3 vW;
varying vec3 vG;
varying float vBlink;
varying float vTint;
void main() {
  int ri = int(aEye.x + 0.5);
  if (aEye.x > uRings - 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  mat4 M = uRingM[ri];
  float R = 0.0;
  ${RING_R.map((r, i) => `if (ri == ${i}) R = ${r.toFixed(4)};`).join('\n  ')}
  float a = aEye.y;
  vec3 rad = vec3(cos(a), 0.0, sin(a));
  vec3 tan = vec3(sin(a), 0.0, -cos(a)); // so the quad faces outward
  vec3 ax = vec3(0.0, 1.0, 0.0);
  vec3 c = rad * (R + ${(BAND_W * 0.5 + 0.004).toFixed(4)});
  vec3 lp = c + (tan * position.x + ax * position.y) * ${(EYE_R * 2).toFixed(4)};
  vec4 w = M * vec4(lp, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(M) * rad);
  vT = normalize(mat3(M) * tan);
  vB = normalize(mat3(M) * ax);
  vQ = position.xy * 2.0;
  vec3 wc = (M * vec4(c, 1.0)).xyz;
  vec3 toCam = normalize(cameraPosition - wc);
  vec3 toC = normalize(uCenter - wc);
  vec3 g = normalize(mix(mix(vN, toCam, 0.65), toC, uInward));
  // keep at least part of the iris on the visible dome
  g = normalize(g + vN * max(0.0, 0.45 - dot(g, vN)));
  vG = g;
  // blink: a ripple round the band from the start point, plus slow idle blinks
  float d = abs(mod(a - uRipA[ri] + PI, TAU) - PI);
  float tt = uRipT[ri] - d / 8.0;
  float rip = exp(-pow((tt - 0.08) / 0.06, 2.0));
  float P = 3.0 + aEye.z * 6.0;
  float ph = fract(uIdleT / P + aEye.z * 7.31);
  float idle = exp(-pow((ph - 0.5) / 0.018, 2.0));
  vBlink = clamp(max(rip * uBlinkAmt, idle), 0.0, 1.0);
  vTint = aEye.w;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const EYE_FRAG = /* glsl */ `
${GLSL_METAL}
uniform vec3 uSclera, uIrisA, uIrisB, uPupilCol;
uniform float uSmallOpen;
varying vec2 vQ;
varying vec3 vN;
varying vec3 vT;
varying vec3 vB;
varying vec3 vW;
varying vec3 vG;
varying float vBlink;
varying float vTint;
void main() {
  vec2 q = vQ;
  float r = length(q);
  if (r > 1.0) discard;
  vec3 N = normalize(vN);
  vec3 T = normalize(vT);
  vec3 B = normalize(vB);
  float px = fwidth(r) * 1.5;
  float er = 0.74;
  vec3 col;
  if (r > er) {
    // bezel: a rounded metal collar, a dark seat where it meets the eye
    float s = (r - er) / (1.0 - er);
    vec3 n = normalize(N + (T * q.x + B * q.y) / max(r, 1e-3) * (s - 0.45) * 1.6);
    col = orMetal(n, vW, mix(0.55, 1.0, smoothstep(0.0, 0.3, s)));
  } else {
    vec2 e = q / er;
    float e2 = min(dot(e, e), 1.0);
    vec3 n = normalize(N * sqrt(1.0 - e2) + T * e.x + B * e.y);
    vec3 V = normalize(cameraPosition - vW);
    // eyeball
    float c = dot(n, normalize(vG));
    float irisM = smoothstep(0.80, 0.80 + 0.04, c);
    float pupM = smoothstep(0.955, 0.965, c);
    vec3 iris = mix(uIrisA, uIrisB, vTint);
    iris = mix(iris * 0.45, iris, smoothstep(0.80, 0.9, c));
    vec3 eye = mix(uSclera * mix(0.78, 1.0, 0.5 + 0.5 * dot(n, uKey)), iris, irisM);
    eye = mix(eye, uPupilCol, pupM);
    float sp = pow(max(dot(reflect(-V, n), uKey), 0.0), 60.0);
    eye += uSclera * sp * 0.8;
    // metal lids close along the band's axis
    float open = uSmallOpen * (1.0 - vBlink);
    float edge = open * sqrt(max(1.0 - e.x * e.x, 0.0));
    float lid = smoothstep(edge - px * 2.0, edge + px * 2.0, abs(e.y));
    vec3 ln = normalize(N * 0.7 + B * sign(e.y) * 0.5 + T * e.x * 0.4);
    vec3 lc = orMetal(ln, vW, 0.92 - 0.35 * (1.0 - smoothstep(0.0, 0.25, abs(abs(e.y) - edge))));
    col = mix(eye * (1.0 - 0.35 * exp(-abs(abs(e.y) - edge) * 14.0)), lc, lid);
  }
  col = orHaze(col, vW);
  gl_FragColor = vec4(col, 1.0);
}
`;

const GREAT_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vO;
varying vec3 vW;
void main() {
  vO = normalize(position);
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const GREAT_FRAG = /* glsl */ `
${GLSL_METAL}
uniform vec3 uGaze, uSclera, uIrisA, uIrisB, uPupilCol, uPaper, uPaperShade;
uniform float uOpen, uPupil, uShim, uLowOpen;
varying vec3 vN;
varying vec3 vO;
varying vec3 vW;
void main() {
  vec3 n = normalize(vN);
  vec3 o = normalize(vO);
  vec3 V = normalize(cameraPosition - vW);
  vec3 g = normalize(uGaze);
  float diff = clamp((dot(n, uKey) + 0.6) / 1.6, 0.0, 1.0);

  // eyeball
  float c = dot(n, g);
  vec3 qv = n - g * c;
  float r = length(qv) * step(0.0, c) + step(c, 0.0) * 2.0;
  vec3 t1 = normalize(cross(g, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
  vec3 t2 = cross(g, t1);
  vec2 dir = vec2(dot(qv, t1), dot(qv, t2)) / max(r, 1e-4);
  float IR = 0.42;
  float aa = fwidth(r) * 1.5;
  float fib = tnoise(dir * 18.0 + vec2(r * 3.0 - uShim * 0.4, uShim * 0.15));
  float fib2 = tnoise(dir * 41.0 + vec2(r * 6.0, uShim * 0.3));
  float rn = r / IR;
  vec3 iris = mix(uIrisB, uIrisA, smoothstep(0.25, 0.95, rn));
  iris *= 0.72 + 0.5 * fib + 0.22 * fib2;
  // collarette and a dark limbal ring
  iris = mix(iris, mix(uIrisA, uMetal, 0.35) * 1.15, exp(-pow((rn - uPupil / IR * 1.55) / 0.08, 2.0)) * 0.6);
  iris *= 1.0 - 0.75 * smoothstep(0.78, 1.0, rn);
  vec3 sclera = uSclera * mix(0.74, 1.02, diff);
  // faint warm veins toward the edges
  float vein = smoothstep(0.62, 0.9, tnoise(vec2(atan(o.x, o.z) * 9.0, o.y * 9.0))) * smoothstep(0.55, 1.4, r);
  sclera = mix(sclera, uMetal, vein * 0.12);
  vec3 col = mix(sclera, iris * mix(0.85, 1.05, diff), 1.0 - smoothstep(IR - aa, IR + aa, r));
  col = mix(col, uPupilCol, 1.0 - smoothstep(uPupil - aa, uPupil + aa, r));
  // wet cornea: a sharp window highlight and the sky across the top
  vec3 Rf = reflect(-V, n);
  col += uSclera * (pow(max(dot(Rf, uKey), 0.0), 220.0) * 1.4 + pow(max(dot(Rf, uKey), 0.0), 14.0) * 0.08);
  col = mix(col, uSkyCol, pow(1.0 - max(dot(n, V), 0.0), 3.0) * 0.2);

  // torn paper lids, fixed to the head while the eyeball turns under them
  float az = atan(o.x, o.z);
  float tearU = (tnoise(vec2(az * 2.6, 3.0)) - 0.5) * 0.2 + (tnoise(vec2(az * 13.0, 7.0)) - 0.5) * 0.07;
  float tearL = (tnoise(vec2(az * 2.4, 11.0)) - 0.5) * 0.18 + (tnoise(vec2(az * 12.0, 19.0)) - 0.5) * 0.06;
  float yU = mix(-0.04, 0.95, uOpen) + tearU;
  float yL = -mix(0.06, 0.82, uLowOpen) + tearL;
  float pa = fwidth(o.y) * 1.5;
  float up = smoothstep(yU - pa, yU + pa, o.y);
  float lo = 1.0 - smoothstep(yL - pa, yL + pa, o.y);
  // the paper casts a soft shadow onto the eye just under its torn edge
  float sh = exp(-max(yU - o.y, 0.0) / 0.07) * 0.45 + exp(-max(o.y - yL, 0.0) / 0.05) * 0.25;
  col *= 1.0 - sh;
  float crease = tfbm(vec2(az * 3.0, o.y * 5.0), 3);
  float fibre = tnoise(o.xy * 90.0 + o.z * 31.0);
  vec3 paper = mix(uPaperShade, uPaper, clamp(diff + crease * 0.25, 0.0, 1.0));
  paper *= 0.95 + 0.08 * fibre;
  float edgeU = exp(-max(o.y - yU, 0.0) / 0.012);
  float edgeL = exp(-max(yL - o.y, 0.0) / 0.012);
  paper = mix(paper, uPaper * 1.04, max(edgeU * up, edgeL * lo) * 0.5); // the torn fibres catch the light
  col = mix(col, paper, clamp(up + lo, 0.0, 1.0));
  col = orHaze(col, vW);
  col += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

/* the sky behind everything */
const BG_FRAG = /* glsl */ `
uniform vec3 uSkyTop, uSkyLow, uCloudLit, uCloudShade, uGlow, uDark;
uniform vec2 uSun, uLdir, uPar;
uniform vec3 uObj; // object centre (aspect units) and radius
uniform float uCover, uDarkAmt, uRays, uBurstT, uBurstA, uRel, uOpenSky, uWind, uDraw, uT;
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  vec3 col = mix(uSkyLow, uSkyTop, smoothstep(-0.1, 0.55, p.y));
  float sd = length(p - uSun);
  col += uGlow * (exp(-sd * 1.6) * 0.3 + exp(-sd * 7.0) * 0.35);

  vec2 dp = p - uObj.xy;
  float dl = length(dp);
  vec2 dir = dp / max(dl, 1e-4);
  float R = uObj.z;
  // light pouring from behind the object
  float ray = tnoise(dir * 6.0 + vec2(uT * 0.02, 0.0)) * tnoise(dir * 13.0 - vec2(0.0, uT * 0.03));
  float rays = ray * ray * 3.0 * smoothstep(R * 0.2, R * 0.9, dl) * exp(-max(dl - R, 0.0) * 2.2);
  float halo = exp(-max(dl - R * 0.4, 0.0) * 3.0);
  float glowAmt = uRays + uRel * 0.6;
  col += uGlow * (rays * 0.55 + halo * 0.3) * glowAmt;

  // burst ring on the drop
  float br = R * 0.9 + uBurstT * 1.5;
  float bw = 0.03 + uBurstT * 0.12;
  float ring = exp(-pow((dl - br) / bw, 2.0)) * uBurstA;
  float inside = (1.0 - smoothstep(br - bw, br + bw, dl)) * uBurstA;

  // clouds: three layers, far to near, a little parallax each
  float clear = uOpenSky * exp(-pow(max(dl - R * 0.5, 0.0) / (R * 1.4), 2.0)) + inside * 0.7;
  vec2 toO = uObj.xy - p;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float sc = 1.5 + fi * 0.8;
    vec2 q = p * sc + vec2(uWind * (0.025 + 0.02 * fi), 0.0) + vec2(fi * 13.7, fi * 7.1) + uPar * (0.25 + 0.35 * fi);
    q += toO * uDraw * (0.4 + 0.3 * fi) * sc;
    float nz = tfbm(q, 5) * 0.5 + 0.5;
    float cov = uCover * 0.75 + 0.42 * smoothstep(0.1, -0.4, p.y) - clear * (1.0 - fi * 0.2) + uDraw * 0.25 + ring * 0.5;
    float d = smoothstep(1.0 - cov, 1.0 - cov + 0.13, nz);
    float n2 = tfbm(q + uLdir * 0.09, 4) * 0.5 + 0.5;
    float lit = clamp(0.5 + (nz - n2) * 7.0, 0.0, 1.0);
    // billows: brighter as you climb into the body of the cloud from its edge
    lit = mix(lit * 0.75, lit, smoothstep(1.0 - cov, 1.0 - cov + 0.3, nz));
    lit = mix(lit, 1.0, 0.25 * smoothstep(-0.3, 0.4, p.y));
    vec3 cc = mix(uCloudShade, uCloudLit, lit);
    // cloud edges near the object catch its light
    cc += uGlow * (1.0 - d) * 0.0 + uGlow * halo * glowAmt * 0.25 * lit;
    col = mix(col, cc, d * (0.6 + 0.18 * fi));
  }
  col += uGlow * ring * 1.6;
  col = mix(col, uDark, uDarkAmt * (0.5 + 0.5 * smoothstep(0.0, 0.8, dl)) * (1.0 - inside * 0.85));
  col += uGlow * ring * 0.8 * uDarkAmt;
  col += (hash21(gl_FragCoord.xy + fract(uT) * 100.0) - 0.5) / 160.0;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* the cloud sea, the veils over the object, the ledge and the witness */
const FRONT_FRAG = /* glsl */ `
uniform vec3 uCloudLit, uCloudShade, uRock, uRockLit, uFigure, uDark, uGlow;
uniform vec2 uLdir, uLedge, uPar;
uniform vec3 uObj;
uniform float uSeaTop, uVeil, uWind, uDarkAmt, uArms, uFig, uT;
vec4 over(vec4 acc, vec3 c, float a) {
  return vec4(c * a + acc.rgb * (1.0 - a), a + acc.a * (1.0 - a));
}
float capsule(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float px = 1.0 / uResolution.y;
  vec4 acc = vec4(0.0);
  vec3 shade = mix(uCloudShade, uDark, uDarkAmt * 0.6);

  // veils drifting across the object when the song is quiet
  vec2 dp = p - uObj.xy;
  float vr = length(dp * vec2(0.8, 1.4)) / max(uObj.z, 0.05);
  float vmask = exp(-vr * vr * 0.7) * smoothstep(0.35, -0.2, dp.y / max(uObj.z, 0.05)) ;
  vec2 vq = p * vec2(1.4, 3.2) + vec2(uWind * 0.06, 0.0) + uPar * 1.2 + 31.0;
  float vn = tfbm(vq, 4) * 0.5 + 0.5;
  float va = smoothstep(0.42, 0.72, vn) * uVeil * vmask;
  acc = over(acc, mix(shade, uCloudLit, 0.75 + 0.25 * vn), va * 0.85);

  // the ledge: a crag poking out of the sea
  vec2 lp = p - uLedge;
  float s = uFig;
  float edgeN = (tnoise(vec2(lp.x * 140.0, 3.0)) - 0.5) * 0.006;
  float width = s * 1.1 + max(-lp.y, 0.0) * 0.42 + (tnoise(vec2(lp.y * 60.0, 9.0)) - 0.5) * 0.025;
  float rockD = max(max(lp.y - edgeN - s * 0.02 * sin(lp.x * 90.0), abs(lp.x + s * 0.5 + lp.y * 0.3) - width), -lp.y - 0.25);
  float ra = 1.0 - smoothstep(-px, px, rockD);
  float facet = tnoise(lp * vec2(50.0, 26.0)) + 0.5 * tnoise(lp * 120.0);
  float rlit = clamp(0.35 + dot(normalize(vec2(lp.x + s * 0.5, 0.25)), uLdir) * 0.5 + (facet - 0.75) * 0.6, 0.0, 1.0);
  vec3 rock = mix(uRock, uRockLit, rlit);
  rock = mix(rock, uCloudLit, smoothstep(-0.05, -0.16, lp.y) * 0.6); // aerial fade into the sea
  acc = over(acc, rock, ra);

  // the cloud sea
  float top = uSeaTop + tfbm(vec2(p.x * 1.3 + uWind * 0.04, 2.0) + uPar.x * 1.5, 4) * 0.05;
  vec2 sq = p * vec2(2.2, 4.5) + vec2(uWind * 0.05, 0.0) + uPar * 1.6;
  float bill = tfbm(sq, 5);
  float bill2 = tfbm(sq + uLdir * 0.12, 5);
  float sa = 1.0 - smoothstep(top - 0.06, top + 0.03 + bill * 0.04, p.y);
  float slit = clamp(0.6 + (bill - bill2) * 3.5 + 0.25 * smoothstep(top - 0.25, top, p.y), 0.0, 1.0);
  acc = over(acc, mix(shade, uCloudLit, slit), sa);

  // the witness: tiny, still, looking up
  vec2 f = lp / s;
  float d = length(f - vec2(0.0, 0.88)) - 0.11;              // head
  d = min(d, capsule(f, vec2(0.0, 0.42), vec2(0.0, 0.7), 0.11)); // body
  d = min(d, capsule(f, vec2(-0.05, 0.02), vec2(-0.04, 0.42), 0.055));
  d = min(d, capsule(f, vec2(0.05, 0.02), vec2(0.04, 0.42), 0.055));
  // a long coat flaring a little
  d = min(d, max(abs(f.x) - (0.1 + (0.62 - f.y) * 0.18), abs(f.y - 0.4) - 0.24));
  vec2 sh = vec2(0.0, 0.7);
  vec2 hL = mix(vec2(-0.14, 0.3), vec2(-0.42, 1.18), uArms);
  vec2 hR = mix(vec2(0.14, 0.3), vec2(0.42, 1.18), uArms);
  d = min(d, capsule(f, sh + vec2(-0.08, 0.0), hL, 0.045));
  d = min(d, capsule(f, sh + vec2(0.08, 0.0), hR, 0.045));
  float fa = 1.0 - smoothstep(-px / s, px / s, d);
  acc = over(acc, uFigure, fa);

  // one wisp in front of the rock's foot
  float wn = tfbm(p * vec2(3.0, 9.0) + vec2(uWind * 0.08, 5.0), 4) * 0.5 + 0.5;
  float wa = smoothstep(0.45, 0.75, wn) * smoothstep(-0.02, -0.07, lp.y) * (1.0 - smoothstep(top - 0.02, top + 0.06, p.y) * 0.0) * exp(-abs(lp.x) * 6.0);
  acc = over(acc, mix(shade, uCloudLit, 0.8), wa * 0.8);

  gl_FragColor = vec4(acc.a > 1e-4 ? acc.rgb / acc.a : vec3(0.0), acc.a);
}
`;

/** a small seeded generator so the layout is the same every time */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a band: rounded-rectangle profile lathed round Y (axis = local Y, eyes on the outer face) */
function bandGeometry(R: number) {
  const pts: THREE.Vector2[] = [];
  const x0 = R - BAND_W / 2;
  const x1 = R + BAND_W / 2;
  const y0 = -BAND_HH;
  const y1 = BAND_HH;
  const rc = 0.018;
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    for (let i = 0; i <= 4; i++) {
      const a = a0 + ((a1 - a0) * i) / 4;
      pts.push(new THREE.Vector2(cx + Math.cos(a) * rc, cy + Math.sin(a) * rc));
    }
  };
  // clockwise in (x, y) so the lathe's normals face outward: bottom → outer → top → inner → bottom
  pts.push(new THREE.Vector2(R, y0));
  arc(x1 - rc, y0 + rc, -Math.PI / 2, 0);
  arc(x1 - rc, y1 - rc, 0, Math.PI / 2);
  arc(x0 + rc, y1 - rc, Math.PI / 2, Math.PI);
  arc(x0 + rc, y0 + rc, Math.PI, Math.PI * 1.5);
  pts.push(new THREE.Vector2(R, y0));
  return new THREE.LatheGeometry(pts, 200);
}

export const orrery = defineThreeScene({
  id: 'orrery',
  name: 'Orrery',
  description:
    'A colossal armillary of rose-gold rings studded with small eyes turns over a bright sea of cloud, a great paper-lidded eye at its heart and one tiny figure on a ledge below. The rings keep the tempo like clockwork and tick on the kick, blinks ripple round them on hats and snares, the great eye dilates with the bass; a build swings the rings into a halo and the drop throws them apart in a burst of light.',
  category: 'form',
  style: 'world',
  tags: ['cinematic', 'dreamy', 'spacious', 'euphoric', 'uplifting', 'ambient', 'experimental', 'psychedelic', 'calm', 'intense', 'slow'],
  light: true,
  params,
  modulations: [
    { source: 'energy', param: 'glow', amount: 0.2 },
    { source: 'air', param: 'blink', amount: 0.15 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, init.width / Math.max(1, init.height), 0.1, 80);
    const tanH = Math.tan(THREE.MathUtils.degToRad(16));

    /* uniforms shared by every metal surface (one object, assigned into each material) */
    const metalU = {
      uMetal: { value: new THREE.Color() },
      uMetalShade: { value: new THREE.Color() },
      uMetalHi: { value: new THREE.Color() },
      uSkyCol: { value: new THREE.Color() },
      uGroundCol: { value: new THREE.Color() },
      uHazeCol: { value: new THREE.Color() },
      uKey: { value: new THREE.Vector3(0, 1, 0) },
      uHaze: { value: 0 },
      uSheen: { value: 0.4 },
      uSeaY: { value: -2 },
    };
    const eyeCols = {
      uSclera: { value: new THREE.Color() },
      uIrisA: { value: new THREE.Color() },
      uIrisB: { value: new THREE.Color() },
      uPupilCol: { value: new THREE.Color() },
    };

    const group = new THREE.Group();
    scene.add(group);

    /* bands */
    const ringMats: THREE.ShaderMaterial[] = [];
    const rings: THREE.Mesh[] = [];
    for (let i = 0; i < MAX_RINGS; i++) {
      const m = makeMaterial({
        params,
        shared: init.shared,
        vertex: RING_VERT,
        fragment: RING_FRAG,
        extra: { ...metalU, uR: { value: RING_R[i] } },
      });
      const mesh = new THREE.Mesh(bandGeometry(RING_R[i]), m);
      mesh.frustumCulled = false;
      group.add(mesh);
      rings.push(mesh);
      ringMats.push(m);
    }

    /* small eyes: one instanced quad each */
    const rnd = mulberry(0x0e7e5);
    const eyeData: number[] = [];
    for (let i = 0; i < MAX_RINGS; i++) {
      const n = Math.round((Math.PI * 2 * RING_R[i]) / EYE_GAP);
      for (let k = 0; k < n; k++) {
        const t = rnd();
        eyeData.push(i, (k / n) * Math.PI * 2, rnd(), t * t);
      }
    }
    const eyeCount = eyeData.length / 4;
    const quad = new THREE.PlaneGeometry(1, 1);
    const eyeGeo = new THREE.InstancedBufferGeometry();
    eyeGeo.index = quad.index;
    eyeGeo.setAttribute('position', quad.getAttribute('position'));
    eyeGeo.setAttribute('aEye', new THREE.InstancedBufferAttribute(new Float32Array(eyeData), 4));
    eyeGeo.instanceCount = eyeCount;
    const ringM = Array.from({ length: MAX_RINGS }, () => new THREE.Matrix4());
    const ripT = new Array<number>(MAX_RINGS).fill(99);
    const ripA = new Array<number>(MAX_RINGS).fill(0);
    const eyeMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: EYE_VERT,
      fragment: EYE_FRAG,
      extra: {
        ...metalU,
        ...eyeCols,
        uRingM: { value: ringM },
        uRipT: { value: ripT },
        uRipA: { value: ripA },
        uRings: { value: 5 },
        uInward: { value: 0 },
        uBlinkAmt: { value: 0.8 },
        uIdleT: { value: 0 },
        uSmallOpen: { value: 0.5 },
        uCenter: { value: new THREE.Vector3() },
      },
    });
    const eyes = new THREE.Mesh(eyeGeo, eyeMat);
    eyes.frustumCulled = false;
    scene.add(eyes);

    /* the great eye */
    const greatMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: GREAT_VERT,
      fragment: GREAT_FRAG,
      extra: {
        ...metalU,
        ...eyeCols,
        uGaze: { value: new THREE.Vector3(0, 0, 1) },
        uPaper: { value: new THREE.Color() },
        uPaperShade: { value: new THREE.Color() },
        uOpen: { value: 0.3 },
        uLowOpen: { value: 0.3 },
        uPupil: { value: 0.15 },
        uShim: { value: 0 },
      },
    });
    const great = new THREE.Mesh(new THREE.SphereGeometry(GREAT_R, 96, 64), greatMat);
    group.add(great);

    /* sky and front */
    const bgMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: BACKDROP_VERT,
      fragment: BG_FRAG,
      extra: {
        uSkyTop: { value: new THREE.Color() },
        uSkyLow: { value: new THREE.Color() },
        uCloudLit: { value: new THREE.Color() },
        uCloudShade: { value: new THREE.Color() },
        uGlow: { value: new THREE.Color() },
        uDark: { value: new THREE.Color() },
        uSun: { value: new THREE.Vector2() },
        uLdir: { value: new THREE.Vector2() },
        uPar: { value: new THREE.Vector2() },
        uObj: { value: new THREE.Vector3() },
        uCover: { value: 0.5 },
        uDarkAmt: { value: 0 },
        uRays: { value: 0 },
        uBurstT: { value: 9 },
        uBurstA: { value: 0 },
        uRel: { value: 0 },
        uOpenSky: { value: 0 },
        uWind: { value: 0 },
        uDraw: { value: 0 },
        uT: { value: 0 },
      },
    });
    scene.add(makeBackdrop(bgMat));
    const frontMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: BACKDROP_VERT,
      fragment: FRONT_FRAG,
      transparent: true,
      extra: {
        uCloudLit: bgMat.uniforms.uCloudLit,
        uCloudShade: bgMat.uniforms.uCloudShade,
        uDark: bgMat.uniforms.uDark,
        uGlow: bgMat.uniforms.uGlow,
        uLdir: bgMat.uniforms.uLdir,
        uPar: bgMat.uniforms.uPar,
        uObj: bgMat.uniforms.uObj,
        uWind: bgMat.uniforms.uWind,
        uDarkAmt: bgMat.uniforms.uDarkAmt,
        uT: bgMat.uniforms.uT,
        uRock: { value: new THREE.Color() },
        uRockLit: { value: new THREE.Color() },
        uFigure: { value: new THREE.Color() },
        uLedge: { value: new THREE.Vector2() },
        uSeaTop: { value: -0.3 },
        uVeil: { value: 0 },
        uArms: { value: 0 },
        uFig: { value: 0.03 },
      },
    });
    const front = makeBackdrop(frontMat);
    front.renderOrder = 10;
    scene.add(front);

    /* state */
    const spin = new Float64Array(MAX_RINGS).map(() => rnd());
    const tumble = new Float64Array(MAX_RINGS).map(() => rnd());
    const axX: Spring[] = [];
    const axZ: Spring[] = [];
    const tgtX: number[] = [];
    const tgtZ: number[] = [];
    for (let i = 0; i < MAX_RINGS; i++) {
      tgtX.push((rnd() * 2 - 1) * 1.3);
      tgtZ.push((rnd() * 2 - 1) * 1.1);
      axX.push(new Spring(9, 3.2, tgtX[i]));
      axZ.push(new Spring(9, 3.2, tgtZ[i]));
    }
    const tickS = new Spring(260, 15);
    let tickTarget = 0;
    const scaleS = new Spring(40, 5, 1);
    const bassS = new Spring(10, 5);
    const openS = new Spring(28, 8, 0.2);
    const pupilS = new Spring(60, 10, 0.14);
    const gaze = new THREE.Vector3(0, -0.2, 1);
    const gazeT = new THREE.Vector3(0, -0.2, 1);
    let nextSaccade = 0;
    let lookAtYou = 0;
    let lastPhrase = -1;
    let lastSection = -99;
    let awake = 0.2;
    let precess = 0;
    let shim = 0;
    let halo = 0;
    let inward = 0;
    let lastSince = 99;
    let burstT = 9;
    let spinBoost = 0;
    let greatBlink = 0;
    let nextBlink = 4;
    let wind = 0;
    let darkS = 0;
    let first = true;

    const qBase = new THREE.Quaternion();
    const qT = new THREE.Quaternion();
    const qS = new THREE.Quaternion();
    const qW = new THREE.Quaternion();
    const qFree = new THREE.Quaternion();
    const qHalo = new THREE.Quaternion();
    const qHaloBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.05, 0, 0));
    const eul = new THREE.Euler();
    const X = new THREE.Vector3(1, 0, 0);
    const Y = new THREE.Vector3(0, 1, 0);
    const wobAxis = new THREE.Vector3();
    const tmpV = new THREE.Vector3();
    const camLocal = new THREE.Vector3();
    const inv = new THREE.Matrix4();
    const c1 = new THREE.Color();
    const WHITE = new THREE.Color(1, 1, 1);
    const BLACK = new THREE.Color(0, 0, 0);

    return {
      scene,
      camera,
      update(frame) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const f = frame.feel;
        const p = frame.params;
        const pal = frame.palette.c;
        const light = isLightPalette(frame.palette);
        for (const m of ringMats) syncMaterial(m, frame, params);
        syncMaterial(eyeMat, frame, params);
        syncMaterial(greatMat, frame, params);
        syncMaterial(bgMat, frame, params);
        syncMaterial(frontMat, frame, params);

        /* big state from the shared feel */
        awake = first ? f.intensity : approach(awake, f.intensity, 1.1, dt);
        const tension = f.tension * num(p, 'halo', 0.85);
        const burst = num(p, 'burst', 0.8);
        const rel = f.release * burst;
        const haloT = THREE.MathUtils.smoothstep(f.tension, 0.12, 0.65) * Math.min(1, num(p, 'halo', 0.85) * 1.15);
        halo = approach(halo, haloT, haloT > halo ? 2.2 : 6, dt);
        inward = approach(inward, Math.min(1, tension * 1.4), 3, dt);
        const dropHit = f.sinceDrop < lastSince - 0.5 && f.sinceDrop < 0.3;
        lastSince = f.sinceDrop;
        first = false;

        /* layout from the aspect: the object fills the upper two thirds in portrait, the centre in landscape */
        const asp = frame.aspect;
        const size = num(p, 'size', 1);
        const fit = Math.min(0.7, 0.8 * asp, 0.24 + 0.34 * asp);
        const k = THREE.MathUtils.clamp(0.08 + (1.2 - asp) * 0.4, 0.08, 0.24);
        const dist = R_EXT / (tanH * fit);
        const hh = dist * tanH;
        const sway = Math.sin(frame.time * 0.05) * 0.12;
        camera.position.set(sway, 0, dist);
        camera.lookAt(sway * 0.6, 0, 0);
        const sink = (1 - Math.min(1, awake * 1.4)) * 0.42 + halo * -0.08;
        group.position.set(0, k * hh - sink + Math.sin(frame.time * 0.31) * 0.03, 0);
        group.scale.setScalar(size);
        const seaTop = asp >= 1 ? -0.27 : -0.27 - (1 - asp) * 0.12;

        /* clocks: integrated, so speed changes never jump */
        const bps = beatsPerSecond(frame);
        const turn = num(p, 'turn', 1);
        spinBoost = dropHit ? 3.5 * burst : approach(spinBoost, 0, 0.45, dt);
        const m = (0.04 + 0.96 * Math.pow(awake, 1.4) + tension * 1.4 + spinBoost) * turn;
        if (a.kickHit) tickTarget += 1;
        tickS.step(tickTarget, dt);
        const tick = tickS.value * num(p, 'tick', 0.6);
        bassS.step(a.bass + a.sub * 0.5, dt);
        precess += dt * (0.3 + 0.4 * awake);
        const ringCount = Math.round(num(p, 'rings', 5));

        if (dropHit) {
          for (let i = 0; i < MAX_RINGS; i++) {
            tgtX[i] = (rnd() * 2 - 1) * 1.6;
            tgtZ[i] = (rnd() * 2 - 1) * 1.4;
            axX[i].vel += (rnd() * 2 - 1) * 6 * burst;
            axZ[i].vel += (rnd() * 2 - 1) * 6 * burst;
          }
          scaleS.vel += 1.6 * burst;
          burstT = 0;
        }
        burstT = Math.min(9, burstT + dt);
        scaleS.step(1 + halo * -0.06, dt);

        for (let i = 0; i < MAX_RINGS; i++) {
          const ring = rings[i];
          ring.visible = i < ringCount;
          const dir = i % 2 ? -1 : 1;
          spin[i] += (dt * bps * m) / (4 * SPIN_BARS[i]) * dir;
          tumble[i] += (dt * bps * m) / (4 * TUMBLE_BARS[i]) * (i % 3 ? 1 : -1);
          const sAng = (spin[i] + (tick / 60) * dir) * Math.PI * 2;
          const tAng = (tumble[i] + tick / 110) * Math.PI * 2;
          axX[i].step(tgtX[i], dt);
          axZ[i].step(tgtZ[i], dt);
          eul.set(axX[i].value, 0, axZ[i].value);
          qBase.setFromEuler(eul);
          qT.setFromAxisAngle(X, tAng);
          qS.setFromAxisAngle(Y, sAng);
          wobAxis.set(Math.cos(precess + i * 1.3), 0, Math.sin(precess + i * 1.3));
          qW.setFromAxisAngle(wobAxis, Math.max(0, bassS.value) * 0.16 * Math.sin(precess * 1.7 + i));
          qFree.copy(qW).multiply(qBase).multiply(qT).multiply(qS);
          qHalo.copy(qHaloBase).multiply(qS);
          ring.quaternion.copy(qFree).slerp(qHalo, halo);
          ring.scale.setScalar(scaleS.value * (1 + halo * 0.025 * (MAX_RINGS - i)));
        }
        group.updateMatrixWorld(true);
        for (let i = 0; i < MAX_RINGS; i++) ringM[i].copy(rings[i].matrixWorld);

        /* blink ripples: hats → outer band, snare → second (and fourth), kick → third. They start nearest you */
        for (let i = 0; i < MAX_RINGS; i++) ripT[i] = Math.min(99, ripT[i] + dt);
        const trigger = (i: number) => {
          inv.copy(rings[i].matrixWorld).invert();
          camLocal.copy(camera.position).applyMatrix4(inv);
          ripA[i] = Math.atan2(camLocal.z, camLocal.x);
          ripT[i] = 0;
        };
        if (a.hatHit && ripT[0] > 0.4) trigger(0);
        if (a.snareHit) {
          trigger(1);
          if (ripT[3] > 0.6) trigger(3);
        }
        if (a.kickHit) trigger(2);
        if (dropHit) for (let i = 0; i < MAX_RINGS; i++) trigger(i);
        const eu = eyeMat.uniforms;
        eu.uRings.value = ringCount;
        eu.uInward.value = inward;
        eu.uBlinkAmt.value = num(p, 'blink', 0.8);
        eu.uIdleT.value = frame.time;
        eu.uSmallOpen.value = THREE.MathUtils.clamp(0.08 + awake * 1.1 + rel * 0.3 + tension * 0.3, 0, 1);
        (eu.uCenter.value as THREE.Vector3).copy(group.position);

        /* the great eye: gaze drifts in saccades; at each phrase (and section) it looks straight at you */
        const phrase = Math.floor(a.beatCount / 32);
        if ((phrase !== lastPhrase && lastPhrase >= 0) || (f.sectionIndex !== lastSection && lastSection > -99)) lookAtYou = 3.2;
        lastPhrase = phrase;
        lastSection = f.sectionIndex;
        if (dropHit) lookAtYou = 4;
        lookAtYou = Math.max(0, lookAtYou - dt);
        nextSaccade -= dt;
        if (lookAtYou > 0 || tension > 0.5) {
          tmpV.copy(camera.position).sub(group.position).normalize();
          gazeT.copy(tmpV);
        } else if (nextSaccade <= 0) {
          nextSaccade = 0.8 + rnd() * 2.4;
          // wander, and now and then look down at the witness
          if (rnd() < 0.25) gazeT.set(0.15, -0.75, 0.65);
          else gazeT.set((rnd() * 2 - 1) * 0.6, (rnd() * 2 - 1) * 0.35 - 0.05, 1);
        }
        gazeT.normalize();
        gaze.lerp(gazeT, 1 - Math.exp(-dt * 14)).normalize();
        great.rotation.z = Math.sin(frame.time * 0.11) * 0.06;
        (greatMat.uniforms.uGaze.value as THREE.Vector3).copy(gaze).applyQuaternion(qW.copy(great.quaternion).invert());
        nextBlink -= dt;
        if (nextBlink <= 0) {
          greatBlink = 1;
          nextBlink = 4 + rnd() * 7;
        }
        greatBlink = approach(greatBlink, 0, 9, dt);
        let openT = 0.1 + 0.68 * Math.pow(awake, 1.2);
        openT = THREE.MathUtils.lerp(openT, 0.36, Math.min(1, tension) * 0.75);
        openT += rel * 0.45;
        openT *= 1 - Math.min(1, greatBlink * 1.6) * 0.9;
        openS.step(openT, dt);
        const op = Math.max(0, openS.value);
        const gu = greatMat.uniforms;
        gu.uOpen.value = op;
        gu.uLowOpen.value = Math.min(1, op * 0.85 + 0.04);
        pupilS.step(0.1 + a.bass * 0.07 + a.sub * 0.06 + rel * 0.07 - tension * 0.035 + (1 - awake) * 0.03, dt);
        gu.uPupil.value = THREE.MathUtils.clamp(pupilS.value, 0.06, 0.3);
        shim += dt * (0.2 + a.mid * 2.2 + a.highMid * 0.8);
        gu.uShim.value = shim % 1000;

        /* light: from the shared sky */
        const L = f.light;
        const lx = Math.cos(L);
        const ly = Math.sin(L);
        (metalU.uKey.value as THREE.Vector3).set(lx * 0.8, 0.35 + ly * 0.7, 0.55).normalize();
        metalU.uSheen.value = num(p, 'sheen', 0.45);
        const dusk = Math.min(1, Math.abs(f.day - 0.5) * 2.2); // 0 noon … 1 dawn/dusk
        const warmth = f.warmth;

        // metal: rose-gold accent, warmed or cooled by the song's warmth
        const mc = metalU.uMetal.value;
        mc.copy(pal.accent).lerp(light ? pal.bg : pal.accent, 0.12).lerp(pal.muted, (1 - warmth) * 0.18);
        metalU.uMetalShade.value.copy(mc).multiplyScalar(light ? 0.5 : 0.35).lerp(pal.fg, 0.08);
        metalU.uMetalHi.value.copy(pal.bg).lerp(WHITE, 0.4).lerp(pal.accent, 0.25).multiplyScalar(1 + a.kick * 0.5); // a glint on each tick
        const tens = Math.min(1, tension);
        if (light) {
          c1.copy(pal.bg).lerp(WHITE, 0.35);
          metalU.uSkyCol.value.copy(c1);
          metalU.uGroundCol.value.copy(pal.bg).lerp(pal.muted, 0.6);
        } else {
          metalU.uSkyCol.value.copy(pal.muted).lerp(pal.accent, 0.35);
          metalU.uGroundCol.value.copy(pal.bg);
        }

        // sky + cloud colours
        const bu = bgMat.uniforms;
        const skyTop = bu.uSkyTop.value as THREE.Color;
        const skyLow = bu.uSkyLow.value as THREE.Color;
        const cLit = bu.uCloudLit.value as THREE.Color;
        const cShade = bu.uCloudShade.value as THREE.Color;
        const glow = bu.uGlow.value as THREE.Color;
        const dark = bu.uDark.value as THREE.Color;
        if (light) {
          skyLow.copy(pal.bg).lerp(WHITE, 0.25);
          skyTop.copy(pal.bg).lerp(pal.accent2, 0.16 + 0.1 * (1 - dusk)).lerp(pal.muted, 0.08);
          cLit.copy(pal.bg).lerp(WHITE, 0.55).lerp(pal.accent, dusk * 0.08);
          cShade.copy(pal.bg).lerp(pal.muted, 0.6).lerp(pal.accent2, 0.06);
          glow.copy(pal.bg).lerp(WHITE, 0.6).lerp(pal.accent, 0.2 + dusk * 0.25).multiplyScalar(0.4);
          dark.copy(pal.muted).lerp(pal.fg, 0.35);
        } else {
          skyLow.copy(pal.bg).lerp(pal.muted, 0.35).lerp(pal.accent, 0.08 + dusk * 0.06);
          skyTop.copy(pal.bg).multiplyScalar(0.85);
          cLit.copy(pal.muted).lerp(pal.accent, 0.35).lerp(pal.bg, 0.1);
          cShade.copy(pal.bg).lerp(pal.muted, 0.35);
          glow.copy(pal.accent).lerp(pal.accent2, 0.3).multiplyScalar(0.6);
          dark.copy(pal.bg).lerp(BLACK, 0.4);
        }
        metalU.uHazeCol.value.copy(cLit).lerp(skyLow, 0.5);
        metalU.uHaze.value = 0.08 + (1 - awake) * 0.22 + tens * 0.05;
        // the sea's top edge in world units, so bands dipping into it fade
        metalU.uSeaY.value = seaTop * 2 * hh;

        // eyes and paper
        eyeCols.uSclera.value.copy(pal.bg).lerp(WHITE, light ? 0.3 : 0.0);
        if (!light) eyeCols.uSclera.value.copy(pal.accent).lerp(WHITE, 0.5).lerp(pal.muted, 0.2);
        eyeCols.uIrisA.value.copy(pal.accent2).lerp(light ? pal.bg : pal.accent, 0.25);
        eyeCols.uIrisB.value.copy(pal.accent2).lerp(pal.accent, 0.35).lerp(pal.fg, 0.15);
        eyeCols.uPupilCol.value.copy(pal.fg).lerp(BLACK, 0.3);
        (gu.uPaper.value as THREE.Color).copy(light ? pal.bg : pal.muted).lerp(pal.muted, light ? 0.3 : 0).lerp(pal.accent, 0.14);
        (gu.uPaperShade.value as THREE.Color).copy(gu.uPaper.value as THREE.Color).lerp(pal.muted, 0.45).multiplyScalar(0.85);

        // object on screen (aspect units) for the rays, the parting and the burst
        tmpV.copy(group.position).project(camera);
        const ox = tmpV.x * 0.5 * asp;
        const oy = tmpV.y * 0.5;
        const orad = ((R_EXT * size) / hh) * 0.5;
        (bu.uObj.value as THREE.Vector3).set(ox, oy, orad);
        (bu.uSun.value as THREE.Vector2).set(lx * 0.75 * Math.max(asp, 0.8), 0.32 + ly * 0.3);
        (bu.uLdir.value as THREE.Vector2).set(lx, ly).normalize();
        (bu.uPar.value as THREE.Vector2).set(-sway * 0.4, Math.sin(frame.time * 0.07) * 0.02);
        const cloudP = num(p, 'cloud', 0.55);
        bu.uCover.value = cloudP * (0.75 + (1 - awake) * 0.35) + tens * 0.12;
        bu.uOpenSky.value = Math.pow(awake, 1.5) * 0.32 + rel * 0.3;
        darkS = tens > darkS ? approach(darkS, tens, 4, dt) : approach(darkS, tens, 1.1, dt);
        bu.uDarkAmt.value = darkS * 0.55;
        bu.uDraw.value = tens * 0.35;
        bu.uRays.value = num(p, 'glow', 0.6) * (0.15 + Math.pow(awake, 1.6) * 0.9 + tens * 0.2);
        bu.uRel.value = rel;
        bu.uBurstT.value = burstT;
        bu.uBurstA.value = burst * Math.exp(-burstT * 0.9) * Math.min(1, burstT * 20);
        wind = f.windPhase;
        bu.uWind.value = wind;
        bu.uT.value = frame.time % 1000;

        // front: sea, veils, ledge, witness
        const fu = frontMat.uniforms;
        fu.uSeaTop.value = seaTop;
        fu.uVeil.value = (1 - Math.min(1, awake * 1.5)) * cloudP * 1.4 + tens * 0.2;
        const lxScr = asp >= 1 ? 0.26 * asp : 0.14 * asp;
        (fu.uLedge.value as THREE.Vector2).set(lxScr, seaTop + 0.075);
        fu.uFig.value = asp >= 1 ? 0.032 : 0.032 - (1 - asp) * 0.02;
        fu.uArms.value = THREE.MathUtils.clamp(rel * 1.6 - 0.2, 0, 1);
        // the witness is a dark silhouette in the white world, a figure caught in the glow at night
        if (light) {
          (fu.uRock.value as THREE.Color).copy(pal.muted).lerp(pal.fg, 0.62);
          (fu.uRockLit.value as THREE.Color).copy(pal.muted).lerp(pal.bg, 0.35);
          (fu.uFigure.value as THREE.Color).copy(pal.fg);
        } else {
          (fu.uRock.value as THREE.Color).copy(pal.bg).lerp(pal.fg, 0.4);
          (fu.uRockLit.value as THREE.Color).copy(pal.bg).lerp(pal.muted, 0.6).lerp(pal.accent, 0.12);
          (fu.uFigure.value as THREE.Color).copy(pal.accent).lerp(WHITE, 0.25);
        }
      },
      dispose() {
        quad.dispose();
      },
    };
  },
});
