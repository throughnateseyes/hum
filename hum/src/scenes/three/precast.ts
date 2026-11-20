/**
 * Precast: a Brutalist facade as a rhythmic field of identical concrete cells.
 *
 * Hundreds of the same precast module, perfectly regular, shot like architectural photography: a
 * flat elevation tracked sideways, the corner of two wings from a low angle, or a curving facade
 * receding in perspective. Every cell is a real recess, ray traced analytically in one full-screen
 * pass: the opening on the face (a rounded square, a square coffer, a slot), a reveal that tapers
 * back to the glass, the sill and the glass itself. The light rakes across from `feel.light`, and the
 * shadow it casts inside each cell is the picture's main graphic element.
 *
 * How the music moves it (the pattern is the instrument):
 *   the song's day     the sun sweeps across the facade (`feel.light`), so every cell's shadow turns
 *                      and grows or shrinks together
 *   spectrum bands     each column's glass sits deeper or further forward with its band, so the
 *                      shadows lengthen and shorten across the facade like a slow equaliser
 *   kick               a wave runs through the grid: the glass slams back and lights as it passes
 *   snare              a scatter of windows flicks its lights on or off
 *   hats               glints in the glass
 *   build              the sun drops lower (shadows lengthen), the camera dolly-zooms so the grid
 *                      compresses, the tracking speeds up and the lights go out row by row
 *   drop               the facade flips state: the light cuts in from the other side, every window
 *                      lights at once, and (if Morph is on) the cells turn into the next module
 *                      (porthole → coffer → slot → sawtooth)
 *   chorus             faster tracking, more windows lit, bigger kick waves; a calm part holds still
 *
 * Colours: concrete tones run along a ramp through the palette's non-accent roles sorted by
 * lightness (so a light palette and a night palette both work), the sky is `bg`, lit windows are
 * `accent`. Under the hand-drawn finish each tone lands on its own ink.
 */
import * as THREE from 'three';
import { FULLSCREEN_VERT, GLSL_COMMON, GLSL_HEADER, paramUniformDecls } from '../../core/glsl';
import { createFullscreenQuad } from '../../core/sceneHelpers';
import { createBaseUniforms, num, str, bool, updateBaseUniforms, updateParamUniforms } from '../../core/uniforms';
import type { ParamDef, SceneDef } from '../../core/types';

const MODULES = ['porthole', 'coffer', 'sawtooth', 'slot'] as const;
type ModuleId = (typeof MODULES)[number];

/** each module: opening (share of the cell), corner round, taper (glass / face size), depth (cells), relief, mullions */
const MODULE_SHAPE: Record<ModuleId, [number, number, number, number, number, number, number]> = {
  //            openX openY round taper depth relief mullion
  porthole: [0.7, 0.7, 0.62, 0.8, 0.46, 0.0, 0.0],
  coffer: [0.9, 0.9, 0.03, 0.42, 0.78, 0.0, 1.0],
  slot: [0.3, 0.84, 1.0, 0.86, 0.7, 0.0, 0.5],
  sawtooth: [0.52, 0.5, 0.04, 0.92, 0.34, 1.0, 1.0],
};

const FRAMINGS = ['front', 'corner', 'curve', 'tower', 'oblique'] as const;

const params: ParamDef[] = [
  { id: 'module', label: 'Module', group: 'Shape', type: 'select', default: 'porthole', options: MODULES.map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) })) },
  { id: 'morph', label: 'Drop morphs module', group: 'Shape', type: 'bool', default: true, hint: 'Each drop turns every cell into the next module' },
  { id: 'depth', label: 'Depth', group: 'Shape', type: 'number', min: 0.3, max: 1.8, step: 0.01, default: 1, hint: 'How deep each cell is recessed' },
  { id: 'open', label: 'Opening', group: 'Shape', type: 'number', min: 0.6, max: 1.2, step: 0.01, default: 1, hint: 'Window size within the module' },
  { id: 'cellW', label: 'Cell width', group: 'Shape', type: 'number', min: 0.6, max: 1.6, step: 0.01, default: 1 },
  { id: 'framing', label: 'Framing', group: 'Camera', type: 'select', default: 'front', options: FRAMINGS.map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) })) },
  { id: 'zoom', label: 'Zoom', group: 'Camera', type: 'number', min: 0.5, max: 2, step: 0.01, default: 1 },
  { id: 'track', label: 'Tracking', group: 'Camera', type: 'number', min: 0, max: 2, step: 0.01, default: 0.7, hint: 'How fast the camera travels along the facade' },
  { id: 'march', label: 'Mechanical', group: 'Camera', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, hint: 'Track in beat-locked steps instead of a smooth glide' },
  { id: 'sun', label: 'Sunlight', group: 'Light', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8, hint: '0 is an overcast day, 1 hard sun' },
  { id: 'rake', label: 'Sun height', group: 'Light', type: 'number', min: 0.08, max: 0.9, step: 0.01, default: 0.38, hint: 'Low sun rakes long shadows into every cell' },
  { id: 'angle', label: 'Sun angle', group: 'Light', type: 'number', min: -1, max: 1, step: 0.01, default: 0, hint: 'Offset on the song\'s own sun path' },
  { id: 'flip', label: 'Drop flips light', group: 'Light', type: 'bool', default: true },
  { id: 'night', label: 'Night', group: 'Light', type: 'number', min: 0, max: 1, step: 0.01, default: 0, hint: 'Floodlit from below, windows carry the picture' },
  { id: 'lights', label: 'Lit windows', group: 'Light', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25 },
  { id: 'wave', label: 'Kick wave', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8 },
  { id: 'bands', label: 'Spectrum depth', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, hint: 'Each column\'s glass moves with its band' },
  { id: 'flick', label: 'Snare flicks', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
  { id: 'weather', label: 'Weathering', group: 'Style', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, hint: 'Rain streaks under the sills, stained concrete' },
  { id: 'sky', label: 'Grey sky', group: 'Light', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3, hint: 'How far the sky leans from the background colour toward muted' },
  { id: 'exposure', label: 'Exposure', group: 'Light', type: 'number', min: 0.6, max: 1.5, step: 0.01, default: 1 },
  { id: 'trees', label: 'Bare trees', group: 'Style', type: 'number', min: 0, max: 1, step: 0.01, default: 0, hint: 'Winter trees in front of the building, swaying in the song\'s wind' },
  { id: 'haze', label: 'Haze', group: 'Style', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
];

const FRAG = /* glsl */ `
uniform vec3 uCamPos, uCamF, uCamR, uCamU;
uniform float uFocal;
uniform float uFraming;     // 0 front, 1 corner, 2 curve, 3 tower
uniform float uRadius;      // curve radius (cells)
uniform float uTrack;       // facade offset along u (cells)
uniform float uTop;         // roof line (cells)
uniform vec2 uCell;         // cell size (world)
uniform vec3 uSun;          // toward the light, world
uniform float uSunAmt, uSoft, uFloodY;
uniform vec4 uModA, uModA1; // the module turning from / to: openX, openY, round, taper
uniform vec4 uModB, uModB1; // depth, relief, mullion, -
uniform float uMorph, uTurnBase;
uniform vec4 uKickT, uKickA;
uniform float uWaveO, uWaveSpd;
uniform float uSnareN, uSnareAge, uHatN, uHatAge;
uniform float uGlow, uFlash, uRowsOut;
uniform vec3 uR0, uR1, uR2, uR3;
uniform vec4 uTree1, uTree2;   // world anchor (xyz) and height
uniform vec3 uFh, uRh;         // the camera's horizontal forward and right

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
/* a bare winter tree: a trunk and nine orders of forking branches (one fold per order), swaying.
   The per-order turns and scales are worked out once a frame in JS (uTA, uTB, uTK; tree 1 at 0..8, tree 2 at 9..17). */
uniform vec4 uTA[18], uTB[18];
uniform float uTK[18];
float vSeg(vec2 p, float L) { return length(vec2(p.x, p.y - clamp(p.y, 0.0, L))); }
float treeD(vec2 p, int o, float seed, float px) {
  float L = 0.3;
  float w = 0.024;
  p = rot2(0.16 * cos(seed * 2.7)) * p;   // each trunk leans its own way
  float d = vSeg(p, L) - w * (1.3 - p.y);
  float sc = 1.0;
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    p.y -= L;
    // each fork leans a little its own way, and every branch wanders (so no two forks mirror cleanly)
    vec4 A = uTA[o + i];
    p = mat2(A.x, A.y, A.z, A.w) * p;
    p.x += 0.022 * sin(p.y * 8.0 + p.x * 3.0 + seed * 7.0 + fi * 3.3);
    p.x = abs(p.x) - 0.006;
    vec4 B = uTB[o + i];
    p = mat2(B.x, B.y, B.z, B.w) * p;   // the branch leans out from the fold, scaled to the next order
    sc *= uTK[o + i];
    w *= 0.76;
    d = min(d, (vSeg(p, L) - w) * sc);
    if (sc * w < px * 0.22) break;   // twigs finer than a pixel add nothing
  }
  return d;
}
float treeMask(vec3 ro, vec3 rd, vec4 tr, int o, float seed, out float tHit) {
  tHit = 1e9;
  if (tr.w <= 0.0) return 0.0;
  float den = dot(rd, uFh);
  if (den <= 1e-4) return 0.0;
  float t = dot(tr.xyz - ro, uFh) / den;
  if (t <= 0.0) return 0.0;
  vec3 h = ro + rd * t;
  vec2 q = vec2(dot(h - tr.xyz, uRh), h.y - tr.y) / tr.w;
  if (abs(q.x) > 0.95 || q.y < -0.1 || q.y > 1.4) return 0.0;
  float px = t / (uResolution.y * 0.5 * uFocal) / tr.w * 1.4;   // a little over a pixel, in tree units
  float d = treeD(q, o, seed, px);
  tHit = t;
  return 1.0 - smoothstep(-px * 0.5, px, d);
}
uniform vec4 uRP;

vec3 ramp(float s) {
  s = clamp(s, 0.0, 1.0);
  if (s < uRP.y) return mix(uR0, uR1, (s - uRP.x) / max(1e-3, uRP.y - uRP.x));
  if (s < uRP.z) return mix(uR1, uR2, (s - uRP.y) / max(1e-3, uRP.z - uRP.y));
  return mix(uR2, uR3, (s - uRP.z) / max(1e-3, uRP.w - uRP.z));
}

float sdOpen(vec2 p, vec2 hs, float r) {
  float rr = r * min(hs.x, hs.y);
  vec2 d = abs(p) - hs + rr;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - rr;
}

/* the recess: a convex frustum, the opening at the face scaled by 'taper' at the glass */
float recessF(vec3 p, vec2 hs, float r, float taper, float D) {
  float k = mix(1.0, taper, clamp(-p.z / D, 0.0, 1.0));
  return sdOpen(p.xy, hs * k, r);
}

vec3 skyCol(vec3 rd) {
  float h = clamp(rd.y * 1.4 + 0.15, 0.0, 1.0);
  float cl = tfbm(rd.xz / max(0.15, rd.y + 0.2) * 1.6 + vec2(uTime * 0.01, 0.0), 4);
  // the sky leans from the paper toward muted (an overcast day reads grey behind white concrete)
  vec3 top = mix(uBg, uMuted, u_sky);
  vec3 c = mix(mix(uBg, uMuted, 0.25 + 0.6 * u_sky), top, h);
  return mix(c, mix(top, uMuted, 0.5), clamp(cl * 0.6, 0.0, 0.4) * (1.0 - h * 0.5));
}

/* facade hit: t, local frame and facade coords */
float hitFacade(vec3 ro, vec3 rd, out vec3 T, out vec3 N, out vec2 uv) {
  float t = -1.0;
  T = vec3(1.0, 0.0, 0.0); N = vec3(0.0, 0.0, 1.0); uv = vec2(0.0);
  if (uFraming < 0.5 || uFraming > 2.5) {
    if (rd.z < 0.0) {
      t = -ro.z / rd.z;
      vec3 p = ro + rd * t;
      uv = vec2(p.x + uTrack, p.y);
    }
  } else if (uFraming < 1.5) {
    float tA = rd.z < 0.0 ? -ro.z / rd.z : 1e9;
    float tB = rd.x < 0.0 ? -ro.x / rd.x : 1e9;
    vec3 pA = ro + rd * tA, pB = ro + rd * tB;
    bool okA = tA < 1e8 && pA.x < 0.0;
    bool okB = tB < 1e8 && pB.z < 0.0;
    if (okA && (!okB || tA < tB)) { t = tA; uv = vec2(pA.x, pA.y); }
    else if (okB) { t = tB; T = vec3(0.0, 0.0, -1.0); N = vec3(1.0, 0.0, 0.0); uv = vec2(-pB.z, pB.y); }
  } else {
    // a convex cylinder, axis vertical through (0, 0, -R)
    vec2 o = ro.xz - vec2(0.0, -uRadius);
    vec2 d = rd.xz;
    float a = dot(d, d), b = dot(o, d), c = dot(o, o) - uRadius * uRadius;
    float disc = b * b - a * c;
    if (disc > 0.0 && a > 1e-6) {
      t = (-b - sqrt(disc)) / a;
      vec3 p = ro + rd * t;
      vec2 n = normalize(p.xz - vec2(0.0, -uRadius));
      N = vec3(n.x, 0.0, n.y);
      T = vec3(n.y, 0.0, -n.x);
      uv = vec2(atan(n.x, n.y) * uRadius + uTrack, p.y);
    }
  }
  return t;
}

float kickWave(vec2 c) {
  float x = c.x - uTrack + c.y * 0.35;
  float w = 0.0;
  for (int i = 0; i < 4; i++) {
    float front = uWaveO + uWaveSpd * uKickT[i];
    float d = (x - front) / 1.6;
    w += uKickA[i] * exp(-d * d) * exp(-uKickT[i] * 1.2);
  }
  return w;
}

/* shade one point of the facade. uv in world facade coords, dl / ls the view and light directions in
   the facade's local frame (x along u, y up, z out of the wall). Returns the colour; glow written out */
vec3 shadeCell(vec2 uv, vec3 dl, vec3 ls, float flood) {
  vec2 cs = uCell;
  vec2 c = floor(uv / cs);
  vec2 f0 = (fract(uv / cs) - 0.5) * cs;     // world units within the cell, centred
  // the drop's turn: the cells become the next module in a sweep across the facade, each one making a
  // half turn as it goes (everything inside the cell, light included, is worked out in its turned frame)
  float delay = clamp((c.x - uTrack - uWaveO) / max(4.0, -2.0 * uWaveO), 0.0, 1.0) * 0.75 + 0.12 * fract(c.y * 0.31) + 0.13 * hash21(c + 1.7);
  float k = smoothstep(0.0, 1.0, clamp(uMorph * 1.8 - delay * 0.8, 0.0, 1.0));
  vec4 mA = mix(uModA, uModA1, k);
  vec4 mB = mix(uModB, uModB1, k);
  mat2 R = rot2(uTurnBase + PI * k);
  vec2 f = R * f0;
  dl.xy = R * dl.xy;
  ls.xy = R * ls.xy;
  vec2 hs = mA.xy * 0.5 * cs;
  float r = mA.z;
  float taper = mA.w;

  // per-cell motion: the kick wave and this column's band push the glass
  float band = spectrum(0.04 + 0.8 * fract((c.x + 0.5) / 20.0));
  float wv = kickWave(c);
  float D = mB.x * min(cs.x, cs.y) * (1.0 + 0.55 * wv) * (1.0 - u_bands * 0.55 * smoothstep(0.1, 0.9, band));
  D = max(D, 0.06);

  // which windows are lit: a base share, snare flicks, the drop's flood, rows going out in a build
  float hc = hash21(c * vec2(1.13, 2.71) + 3.7);
  float lit = step(hc, uGlow);
  float flickSel = step(hash21(c + vec2(uSnareN * 7.31, uSnareN * 1.7)), 0.09 * u_flick);
  lit = mix(lit, 1.0 - lit, flickSel * step(uSnareAge, 0.9));
  lit = max(lit, uFlash);
  lit *= 1.0 - step(fract(c.y * 0.37 + 0.5) , uRowsOut) * (1.0 - uFlash);
  float glow = lit * (0.75 + 0.25 * hash21(c + 9.1)) + wv * 0.35;

  float dOpen = sdOpen(f, hs, r);
  float amb, direct, alb = 1.0, sky;
  vec3 n;
  float kind = 0.0;       // 0 face, 1 reveal, 2 glass
  float depthFrac = 0.0;
  vec3 hp = vec3(f, 0.0);
  float glassMask = 0.0;
  vec2 gl = vec2(0.0);

  if (dOpen > 0.0) {
    // the face: precast panel, a rounded arris round the opening, the sawtooth relief
    n = vec3(0.0, 0.0, 1.0);
    float rim = 1.0 - smoothstep(0.0, 0.03 * min(cs.x, cs.y), dOpen);
    vec2 g = normalize(vec2(sdOpen(f + vec2(0.003, 0.0), hs, r) - dOpen, sdOpen(f + vec2(0.0, 0.003), hs, r) - dOpen) + 1e-6);
    n.xy += g * rim * 0.45;
    if (mB.y > 0.001) {
      // sculpted relief: a row of shallow pyramids on the spandrels (each straddles the joint between two
      // floors) and asymmetric saw ridges on the piers, so a flip of the light reverses their reading
      float t = 0.8 * mB.y;
      float hb = max(0.02, cs.y * 0.5 - hs.y);
      float inFace = smoothstep(0.0, 0.015, dOpen);
      if (abs(f.y) > hs.y) {
        float py = f.y - sign(f.y) * cs.y * 0.5;
        float ax = abs(f.x) / (cs.x * 0.5), ay = abs(py) / hb;
        if (ax > ay) n.x += sign(f.x) * t * inFace;
        else n.y += sign(py) * t * inFace;
      } else {
        float pw = cs.x * 0.5 - hs.x;
        float sx = clamp((abs(f.x) - hs.x) / max(0.02, pw), 0.0, 1.0);
        n.x += (sx < 0.7 ? 0.45 : -1.1) * t * sign(f.x) * inFace;
      }
    }
    n = normalize(n);
    direct = max(dot(n, ls), 0.0);
    amb = 0.62 + 0.12 * n.y;
    depthFrac = 0.0;
    // panel joints
    vec2 jd = cs * 0.5 - abs(f0);
    float joint = 1.0 - smoothstep(0.004, 0.012, min(jd.x, jd.y));
    alb *= 1.0 - 0.35 * joint;
    // rain streaks below the sill
    float below = -(f0.y + hs.y);
    float sx2 = abs(f0.x) / hs.x;
    float streak = step(0.0, below) * (1.0 - smoothstep(0.6, 1.1, sx2)) * exp(-below * 3.0 / cs.y);
    streak *= 0.45 + 0.55 * tnoise(vec2(uv.x * 46.0, uv.y * 1.6 + c.x));
    alb *= 1.0 - u_weather * 0.32 * streak;
  } else {
    // into the recess
    float tBack = -D / min(dl.z, -1e-3);
    vec3 pb = hp + dl * tBack;
    if (recessF(pb, hs, r, taper, D) < 0.0) {
      kind = 2.0;
      hp = pb;
      n = vec3(0.0, 0.0, 1.0);
    } else {
      float lo = 0.0, hi = tBack;
      for (int i = 0; i < 8; i++) {
        float m = 0.5 * (lo + hi);
        if (recessF(hp + dl * m, hs, r, taper, D) < 0.0) lo = m; else hi = m;
      }
      hp = hp + dl * hi;
      kind = 1.0;
      float e = 0.004;
      float f0 = recessF(hp, hs, r, taper, D);
      n = -normalize(vec3(recessF(hp + vec3(e, 0.0, 0.0), hs, r, taper, D) - f0,
                          recessF(hp + vec3(0.0, e, 0.0), hs, r, taper, D) - f0,
                          recessF(hp + vec3(0.0, 0.0, e), hs, r, taper, D) - f0));
    }
    depthFrac = clamp(-hp.z / D, 0.0, 1.0);
    direct = max(dot(n, ls), 0.0);
    // sky light falls off with depth; floors of the reveal see more sky
    amb = (0.6 - 0.46 * depthFrac) * (0.82 + 0.18 * n.y) * (kind > 1.5 ? 0.75 : 1.0);
    if (kind > 1.5) {
      glassMask = 1.0;
      vec2 ghs = hs * taper;
      gl = hp.xy / ghs;
    }
  }

  // sun: lit if the ray toward the light leaves through the opening (the recess is convex)
  float vis = 1.0;
  if (ls.z <= 0.0) vis = 0.0;
  else if (kind > 0.5) {
    float tz = -hp.z / ls.z;
    vec2 pe = hp.xy + ls.xy * tz;
    float w = uSoft * tz + 0.004;
    vis = smoothstep(w, -w, sdOpen(pe, hs, r));
  }
  direct *= vis * uSunAmt * flood;

  // concrete: a fine grain and pores; deeper in the reveal it gets dirtier
  float grain = tnoise(uv * 23.0) * 0.55 + tnoise(uv * 71.0 + hp.z * 9.0) * 0.45;
  alb *= 0.9 + 0.12 * (grain - 0.5) * 2.0 * (0.5 + u_weather);
  alb *= 1.0 - 0.06 * step(0.83, tnoise(uv * 190.0 + c));
  alb *= 0.96 + 0.06 * (hash21(c * 0.71) - 0.5) * u_weather;
  alb *= 1.0 - 0.18 * depthFrac * u_weather;

  // at night the shade sinks and the floodlit faces climb toward the lightest tone, so the face keeps its structure in print
  float light = 1.37 * u_exposure * alb * (amb * (1.0 - 0.85 * uSunAmt) * (1.0 - 0.84 * uFloodY) + direct * (1.3 + 1.1 * uFloodY));
  float tone = clamp(light, 0.0, 1.0);
  vec3 col = ramp(pow(tone, 0.85));

  // the reveal catches the window's glow near the glass
  col += uAccent * glow * 0.22 * depthFrac * depthFrac * (kind > 0.5 && kind < 1.5 ? 1.0 : 0.0);
  // a lit window spills a little light onto the face round it (most at night)
  if (kind < 0.5) col += uAccent * glow * (0.03 + 0.09 * uFloodY) * exp(-dOpen * 24.0 / min(cs.x, cs.y));

  if (kind > 1.5) {
    // glass: dark, a little sky reflected at grazing angles, the interior glow, mullions
    float fres = pow(1.0 - clamp(-dl.z, 0.0, 1.0), 3.0);
    vec3 g = mix(ramp(0.05), ramp(0.5), fres * 0.25 + 0.06 * (1.0 - uSunAmt));
    // where the sun reaches the pane, the blinds behind it light up: the cell's shadow cuts across it
    g = mix(g, ramp(0.6), clamp(vis * uSunAmt * flood, 0.0, 1.0) * 0.85 * (1.0 - clamp(glow, 0.0, 1.0)));
    float inside = glow * (0.95 + 0.25 * (1.0 - vis));
    vec3 warm = uAccent * (0.92 + 0.12 * (1.0 - abs(gl.y)));
    g = mix(g, warm, clamp(inside, 0.0, 1.0));
    // mullions
    float mw = 0.035;
    float mull = 0.0;
    if (mB.z > 0.75) mull = max(mull, 1.0 - smoothstep(mw, mw * 1.8, abs(gl.x)));
    if (mB.z > 0.75) mull = max(mull, 1.0 - smoothstep(mw, mw * 1.8, abs(gl.y - 0.25)));
    if (mB.z > 0.25 && mB.z < 0.75) mull = max(mull, smoothstep(0.455, 0.475, abs(fract(gl.y * 1.6) - 0.5)));
    g = mix(g, ramp(0.12 + 0.3 * vis * uSunAmt), mull);
    // hat glints
    float gsel = step(hash21(c + vec2(uHatN * 3.17, 5.0)), 0.06);
    float spot = exp(-dot(gl - vec2(0.35, 0.4), gl - vec2(0.35, 0.4)) * 22.0);
    g += uR3 * gsel * spot * exp(-uHatAge * 9.0) * 0.9;
    col = g;
  }
  return col;
}

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0);
  vec3 rd = normalize(p.x * uCamR + p.y * uCamU + uFocal * uCamF);
  vec3 ro = uCamPos;
  vec3 T, N; vec2 uv;
  float t = hitFacade(ro, rd, T, N, uv);
  vec3 col;
  if (t > 0.0 && uv.y < uTop) {
    vec3 B = vec3(0.0, 1.0, 0.0);
    vec3 dl = vec3(dot(rd, T), dot(rd, B), dot(rd, N));
    vec3 ls = normalize(vec3(dot(uSun, T), dot(uSun, B), dot(uSun, N)));
    // floodlight from below at night: brightest near the ground
    float flood = mix(1.0, exp(-max(0.0, uv.y + 2.0) * 0.14) * 1.7, uFloodY);
    // footprint: how many cells one pixel spans
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    float fp = max(length(dx), length(dy)) / min(uCell.x, uCell.y);
    fp = min(fp, 4.0);
    if (fp > 0.07 && fp < 0.2) {
      // middle distance: two samples along the pixel's longer axis are enough
      vec2 ax = length(dx) > length(dy) ? dx : dy;
      col = 0.5 * (shadeCell(uv - ax * 0.25, dl, ls, flood) + shadeCell(uv + ax * 0.25, dl, ls, flood));
    } else if (fp >= 0.2) {
      // far away: average four samples across the pixel
      vec3 acc = vec3(0.0);
      acc += shadeCell(uv + dx * -0.25 + dy * -0.25, dl, ls, flood);
      acc += shadeCell(uv + dx * 0.25 + dy * -0.25, dl, ls, flood);
      acc += shadeCell(uv + dx * -0.25 + dy * 0.25, dl, ls, flood);
      acc += shadeCell(uv + dx * 0.25 + dy * 0.25, dl, ls, flood);
      col = acc * 0.25;
      // beyond resolving: a flat average of the module, so the distance doesn't shimmer
      vec3 flatC = mix(ramp(0.7), ramp(0.3), uModA1.x * uModA1.y * 0.8);
      col = mix(col, mix(col, flatC, 0.6), smoothstep(0.6, 2.0, fp));
    } else {
      col = shadeCell(uv, dl, ls, flood);
    }
    // the roof parapet edge
    float roof = smoothstep(uTop - 0.12, uTop - 0.1, uv.y);
    col = mix(col, ramp(0.35 + 0.4 * max(ls.y, 0.0) * uSunAmt), roof);
    // aerial haze
    float fog = 1.0 - exp(-t * (0.002 + 0.016 * u_haze * u_haze));
    vec3 sky = mix(uBg, uMuted, 0.25 + 0.6 * u_sky);   // the haze takes the sky's low tone (no clouds needed)
    col = mix(col, mix(sky, uBg, 0.4), clamp(fog, 0.0, 0.85));
  } else {
    col = skyCol(rd);
  }
  // bare trees in front of the building
  if (u_trees > 0.001) {
    float th1, th2;
    float m1 = treeMask(ro, rd, uTree1, 0, 1.3, th1);
    float m2 = treeMask(ro, rd, uTree2, 9, 4.1, th2);
    vec3 bark = ramp(0.04);
    if (th2 < t || t <= 0.0 || uv.y >= uTop) col = mix(col, mix(bark, col, 0.25), m2 * u_trees);
    if (th1 < t || t <= 0.0 || uv.y >= uTop) col = mix(col, bark, m1 * u_trees);
  }
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

export const precast: SceneDef = {
  id: 'precast',
  name: 'Precast',
  description:
    'A Brutalist facade as a rhythmic field of identical concrete cells, shot like architectural photography. Raking light casts a shadow inside every recess; the sun sweeps with the song, kicks send waves through the grid, snares flick the windows, and each drop flips the light and turns every cell into the next module.',
  category: 'form',
  style: 'form',
  // concrete needs three greys besides the paper (lit, shade, deep shadow) and the glow its own ink
  handInks: 4,
  tags: ['heavy', 'hypnotic', 'driving', 'minimal', 'mechanical', 'cold', 'graphic', 'cinematic', 'architecture', 'concrete', 'brutalist', 'metal', 'rock', 'techno'],
  params,
  create(init) {
    const extra = {
      uCamPos: { value: new THREE.Vector3() },
      uCamF: { value: new THREE.Vector3(0, 0, -1) },
      uCamR: { value: new THREE.Vector3(1, 0, 0) },
      uCamU: { value: new THREE.Vector3(0, 1, 0) },
      uFocal: { value: 1.8 },
      uFraming: { value: 0 },
      uRadius: { value: 22 },
      uTrack: { value: 0 },
      uTop: { value: 1e4 },
      uCell: { value: new THREE.Vector2(1, 1) },
      uSun: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
      uSunAmt: { value: 0.8 },
      uSoft: { value: 0.02 },
      uFloodY: { value: 0 },
      uModA: { value: new THREE.Vector4() },
      uModB: { value: new THREE.Vector4() },
      uModA1: { value: new THREE.Vector4() },
      uModB1: { value: new THREE.Vector4() },
      uMorph: { value: 1 },
      uTurnBase: { value: 0 },
      uKickT: { value: new THREE.Vector4(9, 9, 9, 9) },
      uKickA: { value: new THREE.Vector4() },
      uWaveO: { value: -14 },
      uWaveSpd: { value: 22 },
      uSnareN: { value: 0 },
      uSnareAge: { value: 9 },
      uHatN: { value: 0 },
      uHatAge: { value: 9 },
      uGlow: { value: 0.25 },
      uFlash: { value: 0 },
      uRowsOut: { value: 0 },
      uR0: { value: new THREE.Color() },
      uR1: { value: new THREE.Color() },
      uR2: { value: new THREE.Color() },
      uR3: { value: new THREE.Color() },
      uRP: { value: new THREE.Vector4(0, 0.33, 0.66, 1) },
      uTree1: { value: new THREE.Vector4(0, 0, 0, 0) },
      uTree2: { value: new THREE.Vector4(0, 0, 0, 0) },
      uTA: { value: Array.from({ length: 18 }, () => new THREE.Vector4(1, 0, 0, 1)) },
      uTB: { value: Array.from({ length: 18 }, () => new THREE.Vector4(1, 0, 0, 1)) },
      uTK: { value: new Array(18).fill(0.74) },
      uFh: { value: new THREE.Vector3(0, 0, -1) },
      uRh: { value: new THREE.Vector3(1, 0, 0) },
    };
    const uniforms = { ...createBaseUniforms(init.shared, params), ...extra };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `${GLSL_HEADER}\n${paramUniformDecls(params)}\n${GLSL_COMMON}\n${FRAG}`,
      depthTest: false,
      depthWrite: false,
    });
    const quad = createFullscreenQuad(material);

    // song state
    let track = 0;
    let prevSince = 99;
    let sinceCounted = 99;
    let drops = 0;
    let modFrom = -1; // module index turning from / to, and how far the turn is
    let modTo = -1;
    let morphT = 1;
    let turns = 0;
    let side = 1; // which side the light comes from (flips on drops)
    let sideEased = 1;
    let flash = 0;
    const kickT = [9, 9, 9, 9];
    const kickA = [0, 0, 0, 0];
    let kickI = 0;
    let snareN = 0;
    let snareAge = 9;
    let hatN = 0;
    let hatAge = 9;
    let tens = 0;
    let orbit = 0;
    let glowE = 0.25;

    const cam = new THREE.Vector3();
    const tgt = new THREE.Vector3();
    const f = new THREE.Vector3();
    const r = new THREE.Vector3();
    const u = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const sorted: THREE.Color[] = [];

    return {
      render(frame, target) {
        const { audio, feel, dt } = frame;
        const p = frame.params;
        updateBaseUniforms(uniforms, frame);
        updateParamUniforms(uniforms, params, p);

        /* drops: flip the light, flood the windows, turn the module */
        // starting (or seeking) past a drop: take up the post-drop state at once, no flash, no turn
        const missed = prevSince >= 98 && feel.sinceDrop >= 1 && feel.sinceDrop < 98;
        // (and the same drop arriving live a moment later doesn't count twice)
        sinceCounted += dt;
        const dropped = feel.sinceDrop < prevSince - 0.5 && feel.sinceDrop < 1 && sinceCounted > 4;
        prevSince = feel.sinceDrop;
        if (dropped || missed) sinceCounted = 0;
        if (dropped || missed) {
          drops++;
          if (dropped) flash = 1;
          if (bool(p, 'flip', true)) side = -side;
          if (missed) sideEased = side;
        }
        flash *= Math.exp(-dt * 1.1);

        /* the module: the chosen one, advanced by the drops when Morph is on */
        const base = Math.max(0, MODULES.indexOf(str(p, 'module', 'porthole') as ModuleId));
        // the drops walk through porthole → coffer → sawtooth (the plain slot only when it's the chosen module)
        const cycle = MODULES[base] === 'slot' ? [3, 0, 1, 2] : [0, 1, 2].map((k) => (base + k) % 3);
        const want = cycle[(bool(p, 'morph', true) ? drops : 0) % cycle.length];
        if (modTo < 0 || (missed && morphT >= 1)) modFrom = modTo = want;
        else if (want !== modTo) {
          // a new turn starts from wherever the cells are now (a turn under way snaps to its end)
          if (morphT < 1) turns++;
          modFrom = modTo;
          modTo = want;
          morphT = 0;
        }
        if (morphT < 1) {
          // the turn sweeps across the facade in about a second
          morphT = Math.min(1, morphT + dt / 1.1);
          if (morphT >= 1) turns++;
        }
        const open = num(p, 'open', 1);
        const depth = num(p, 'depth', 1);
        const A = MODULE_SHAPE[MODULES[modFrom]];
        const Bm = MODULE_SHAPE[MODULES[modTo]];
        uniforms.uModA.value.set(Math.min(0.97, A[0] * open), Math.min(0.97, A[1] * open), A[2], A[3]);
        uniforms.uModB.value.set(A[4] * depth, A[5], A[6], 0);
        uniforms.uModA1.value.set(Math.min(0.97, Bm[0] * open), Math.min(0.97, Bm[1] * open), Bm[2], Bm[3]);
        uniforms.uModB1.value.set(Bm[4] * depth, Bm[5], Bm[6], 0);
        // once a turn is done, from = to; the cells keep the half turns they've made
        uniforms.uMorph.value = morphT;
        uniforms.uTurnBase.value = Math.PI * ((morphT < 1 ? turns : turns - 1) % 2);
        if (morphT >= 1) {
          uniforms.uModA.value.copy(uniforms.uModA1.value);
          uniforms.uModB.value.copy(uniforms.uModB1.value);
        }
        const cellW = num(p, 'cellW', 1);
        uniforms.uCell.value.set(cellW, 1);

        /* hits */
        for (let k = 0; k < 4; k++) kickT[k] += dt;
        if (audio.kickHit) {
          kickT[kickI] = 0;
          kickA[kickI] = num(p, 'wave', 0.8) * (0.55 + 0.6 * feel.intensity + 0.3 * feel.release);
          kickI = (kickI + 1) % 4;
        }
        uniforms.uKickT.value.set(kickT[0], kickT[1], kickT[2], kickT[3]);
        uniforms.uKickA.value.set(kickA[0], kickA[1], kickA[2], kickA[3]);
        snareAge += dt;
        hatAge += dt;
        if (audio.snareHit) {
          snareN = (snareN + 1) % 997;
          snareAge = 0;
        }
        if (audio.hatHit) {
          hatN = (hatN + 1) % 997;
          hatAge = 0;
        }
        uniforms.uSnareN.value = snareN;
        uniforms.uSnareAge.value = snareAge;
        uniforms.uHatN.value = hatN;
        uniforms.uHatAge.value = hatAge;

        /* tension: lights out row by row, the sun drops, the camera compresses */
        tens = ease(tens, feel.tension, 4, dt);
        const night = num(p, 'night', 0);
        const glowTarget = clamp01(num(p, 'lights', 0.25) * (0.55 + 0.9 * feel.intensity) + 0.25 * night * feel.intensity);
        glowE = ease(glowE, glowTarget, 1.5, dt);
        uniforms.uGlow.value = glowE;
        uniforms.uFlash.value = flash;
        uniforms.uRowsOut.value = clamp01(tens * 1.15 - 0.1) * (1 - flash);

        /* tracking: smooth glide or beat-locked steps; faster in big parts */
        const bps = (audio.bpm > 0 ? audio.bpm : 110) / 60;
        const cellsPerBeat = num(p, 'track', 0.7) * (0.12 + 0.55 * feel.intensity + 0.6 * tens + 0.4 * feel.release);
        track += dt * bps * cellsPerBeat;
        const march = num(p, 'march', 0.35);
        const stepped = Math.floor(track) + Math.pow(smooth(clamp01((track % 1) * 2.2 - 1.2)), 1);
        const shown = track + (stepped - track) * march;

        /* camera */
        const framing = Math.max(0, FRAMINGS.indexOf(str(p, 'framing', 'front') as (typeof FRAMINGS)[number]));
        const zoom = num(p, 'zoom', 1);
        // the build dolly-zooms: the lens narrows as the camera backs off, so the grid compresses
        const dz = 1 + 0.9 * tens;
        const asp = frame.aspect;
        const portrait = asp < 1 ? Math.pow(asp, 0.55) : 1;
        let focal = 1.55 * dz * portrait;
        const sway = 0.12 * Math.sin(frame.time * 0.11) + 0.05 * Math.sin(frame.time * 0.037);
        orbit += dt * (0.02 + 0.05 * feel.intensity) * num(p, 'track', 0.7);
        let top = 1e4;
        let radius = 22;
        let trackU = shown;
        let waveO = -14;
        let waveSpd = 20 + 14 * feel.intensity;
        if (framing === 0) {
          // the elevation, nearly square on: a flat field of cells, tracked sideways
          const d = (4.6 / zoom) * dz;
          cam.set(sway * 0.6, 1.0, d);
          tgt.set(0.25 + sway * 0.3, 1.9 + 0.25 * Math.sin(frame.time * 0.07), 0);
          waveO = -d * asp * 0.75;
        } else if (framing === 4) {
          // raking along the facade from low down: the cells recede to a vanishing point
          const d = (5.2 / zoom) * dz;
          cam.set(-0.32 * d + sway, -0.22 * d + 1.0, d);
          tgt.set(0.4, 1.6 + 0.3 * Math.sin(frame.time * 0.07), 0);
          waveO = -d * 1.1;
        } else if (framing === 1) {
          // the corner of two wings, from near the foot looking up: the wings fill the frame, sky above the roof
          top = 12.5;
          const az = Math.PI / 4 + 0.16 * Math.sin(orbit) + sway * 0.3;
          // a longer lens from further back: less distortion, big portholes, the wings across the frame
          const d = (7.2 / zoom) * dz;
          cam.set(Math.sin(az) * d, 0.0, Math.cos(az) * d);
          tgt.set(0, 4.4 + 0.4 * (dz - 1), 0);
          focal *= 1.7;
          trackU = 0;
          waveO = -14;
        } else if (framing === 2) {
          // a curving facade close up, receding round the bend
          top = 11;
          radius = 24;
          const d = (3.2 / zoom) * Math.sqrt(dz);
          cam.set(-1.6, 1.0, d);
          tgt.set(2.6, 4.6 + 0.3 * Math.sin(frame.time * 0.06), -2.2);
          waveO = -5;
          focal *= 0.85 * Math.sqrt(dz);
        } else {
          // tower: straight up the facade from its foot
          const d = 2.2 / zoom;
          cam.set(sway, 0.3, d * dz);
          tgt.set(0.2, 30, 0);
          top = 46;
          waveO = 0;
          focal *= 0.75;
        }
        f.subVectors(tgt, cam).normalize();
        r.crossVectors(f, up).normalize();
        u.crossVectors(r, f);
        // bare trees stand between the camera and the facade
        const fh = uniforms.uFh.value.set(f.x, 0, f.z).normalize();
        const rh = uniforms.uRh.value.set(-fh.z, 0, fh.x);
        const trees = num(p, 'trees', 0);
        const wide = Math.pow(Math.min(1, Math.max(0.3, asp / 1.78)), 0.8); // narrow frames pull the trees in
        // not a matched pair: a nearer tree on the left, a taller one further off to the right
        // [forward, side, height, base] for each, in world units from the camera
        const cd = framing === 2 ? 2.4 : 3.2;
        const tp = framing === 1
          ? [3.6, -2.0, 3.6, -1.5, 5.6, 2.4, 5.2, -1.0]
          : [0.45 * cd, -0.8 * cd, 2.5, -1.5, 1.15 * cd, 1.2 * cd, 4.6, -1.2];
        const on = trees > 0 ? 1 : 0;
        tp[0] *= 1 + 0.7 * (1 - wide); // in a narrow frame the near tree steps back so it doesn't swallow the shot
        uniforms.uTree1.value.set(cam.x + fh.x * tp[0] + rh.x * tp[1] * wide, tp[3], cam.z + fh.z * tp[0] + rh.z * tp[1] * wide, tp[2] * on);
        uniforms.uTree2.value.set(cam.x + fh.x * tp[4] + rh.x * tp[5] * wide, tp[7], cam.z + fh.z * tp[4] + rh.z * tp[5] * wide, tp[6] * on);
        if (on) {
          // each order's fork: a lean that sways with the song's wind, then the branch's own angle and scale
          const TA = uniforms.uTA.value as THREE.Vector4[];
          const TB = uniforms.uTB.value as THREE.Vector4[];
          const TK = uniforms.uTK.value as number[];
          for (let t = 0; t < 2; t++) {
            const seed = t === 0 ? 1.3 : 4.1;
            const sw = (0.02 + 0.07 * feel.gust) * Math.sin(feel.windPhase * 1.3 + seed);
            for (let i = 0; i < 9; i++) {
              const ra = sw * (0.3 + i * 0.22) + 0.24 * Math.sin(seed * 3.1 + i * 2.3);
              const a2 = -(0.3 + 0.2 * Math.sin(seed + i * 1.73));
              const k = 0.74 + 0.06 * Math.sin(seed * 1.7 + i);
              // rot2(a) = mat2(c, -s, s, c), column-major
              TA[t * 9 + i].set(Math.cos(ra), -Math.sin(ra), Math.sin(ra), Math.cos(ra));
              TB[t * 9 + i].set(Math.cos(a2) / k, -Math.sin(a2) / k, Math.sin(a2) / k, Math.cos(a2) / k);
              TK[t * 9 + i] = k;
            }
          }
        }
        uniforms.uCamPos.value.copy(cam);
        uniforms.uCamF.value.copy(f);
        uniforms.uCamR.value.copy(r);
        uniforms.uCamU.value.copy(u);
        uniforms.uFocal.value = focal;
        uniforms.uFraming.value = framing;
        uniforms.uTop.value = top;
        uniforms.uRadius.value = radius;
        uniforms.uTrack.value = trackU;
        uniforms.uWaveO.value = framing === 3 ? waveO : waveO;
        uniforms.uWaveSpd.value = waveSpd;

        /* the light: the song's sun path, mirrored on each drop; low and long in a build */
        sideEased = ease(sideEased, side, 7, dt);
        let a = feel.light + num(p, 'angle', 0) * 1.2; // PI = from the left, 0 = from the right
        a = Math.PI / 2 + (a - Math.PI / 2) * sideEased;
        const rake = num(p, 'rake', 0.38) * (1 - 0.42 * tens) + 0.04;
        const sunAmt = num(p, 'sun', 0.8) * (1 - 0.85 * night);
        let lx = Math.cos(a) * Math.cos(rake);
        let ly = Math.sin(a) * Math.cos(rake);
        let lz = Math.sin(rake);
        if (framing === 1) {
          // the corner: the sun stands off to one side so one wing is lit and the other in shade (never both
          // half lit at noon); it climbs and sinks with the song, low and long in a build, and a drop swaps the wings
          const sd = Math.max(-1, Math.min(1, -Math.cos(a) * 4));
          const psi = Math.PI / 4 + sd * (0.74 + 0.3 * (0.45 - num(p, 'rake', 0.38)));
          const el = (0.3 + 0.28 * Math.sin(a)) * (1 - 0.45 * tens);
          lx = Math.cos(el) * Math.cos(psi);
          ly = Math.sin(el);
          lz = Math.cos(el) * Math.sin(psi);
        }
        if (night > 0.001) {
          // floodlights at the foot of the building, grazing up the facade
          const fa = -Math.PI / 2 + 0.35 * sideEased + num(p, 'angle', 0) * 0.6;
          const fr = 0.3;
          const nx = Math.cos(fa) * Math.cos(fr), ny = Math.sin(fa) * Math.cos(fr), nz = Math.sin(fr);
          lx += (nx - lx) * night;
          ly += (ny - ly) * night;
          lz += (nz - lz) * night;
        }
        uniforms.uSun.value.set(lx, ly, lz).normalize();
        uniforms.uSunAmt.value = sunAmt + night * 0.6;
        uniforms.uFloodY.value = night;
        // overcast light is soft: wide penumbras
        uniforms.uSoft.value = 0.012 + 0.12 * (1 - num(p, 'sun', 0.8));

        /* concrete tones: the palette's non-accent roles, darkest to lightest */
        const c = frame.palette.c;
        sorted.length = 0;
        sorted.push(c.bg, c.fg, c.accent2, c.muted);
        sorted.sort((x, y) => lum(x) - lum(y));
        const L = sorted.map(lum);
        const span = Math.max(1e-3, L[3] - L[0]);
        let p1 = (L[1] - L[0]) / span;
        let p2 = (L[2] - L[0]) / span;
        p1 = Math.min(Math.max(p1, 0.08), 0.84);
        p2 = Math.min(Math.max(p2, p1 + 0.08), 0.92);
        uniforms.uR0.value.copy(sorted[0]);
        uniforms.uR1.value.copy(sorted[1]);
        uniforms.uR2.value.copy(sorted[2]);
        uniforms.uR3.value.copy(sorted[3]);
        uniforms.uRP.value.set(0, p1, p2, 1);

        quad.render(frame.renderer, target);
      },
      dispose() {
        material.dispose();
        quad.dispose();
      },
    };
  },
};
