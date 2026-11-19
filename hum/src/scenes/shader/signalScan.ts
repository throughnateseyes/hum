/**
 * Signal Scan — machine vision in black and white: a line-scan recording of something that was
 * not meant to be seen. The picture IS the sound: every frame the spectrum is written into one
 * row of a small ring buffer (128 bins × 512 moments, kept on the CPU and uploaded as a texture),
 * and the shader prints that record as thousands of tiny dashes in vertical scan columns. New
 * moments enter at the bottom and the record rises, so the ghost shapes on screen are the last
 * few seconds of the song, folded around a wandering centre line.
 *
 * Around it: barcode bars bleed in from the frame edges (the side bars travel with the record and
 * remember each kick; the bottom bars are the live input), thin scratches are drawn by loud highs,
 * and one tracking box with a number readout and a single accent pixel hunts the loudest region.
 *
 * Palette roles: bg = the dark, fg = the marks, muted = tints the dimmest marks,
 * accent = the one tracked pixel, accent2 = the small beat counter under the box.
 */
import * as THREE from 'three';
import { FULLSCREEN_VERT, GLSL_COMMON, GLSL_HEADER, paramUniformDecls } from '../../core/glsl';
import { createFullscreenQuad } from '../../core/sceneHelpers';
import { createBaseUniforms, num, str, updateBaseUniforms, updateParamUniforms } from '../../core/uniforms';
import type { ParamDef, SceneDef } from '../../core/types';
import { HM_LIB } from './lib';

const BINS = 128;
const ROWS = 512;
/** mark pixels per cell: every dash lives in a 4 × 3 cell, one cell row per recorded moment */
const CW = 4;
const CH = 3;
/** half the record's width: at most this share of the scan area's width, or TALL of its height */
const HALF = 0.46;
const TALL = 0.62;
/** moments the left half of the fold runs behind the right one */
const LAG = 21;

const params: ParamDef[] = [
  { id: 'density', label: 'Density', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, hint: 'How much of the signal becomes marks' },
  { id: 'cell', label: 'Mark size', group: 'Shape', type: 'number', min: 0.6, max: 3, step: 0.05, default: 1 },
  { id: 'warp', label: 'Warp', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.65, hint: 'Bends the record into figures; 0 is a straight lab plot' },
  {
    id: 'fold',
    label: 'Fold',
    group: 'Shape',
    type: 'select',
    options: [
      { value: 'edges', label: 'Mirrored, lows outside' },
      { value: 'centre', label: 'Mirrored, lows in the middle' },
      { value: 'plain', label: 'Not mirrored' },
    ],
    default: 'edges',
  },
  { id: 'bars', label: 'Edge bars', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Barcode streaks bleeding in from the frame edges' },
  { id: 'speed', label: 'Scan speed', group: 'Motion', type: 'number', min: 0.2, max: 3, step: 0.01, default: 1, hint: 'How fast the record travels up the frame' },
  { id: 'flare', label: 'Kick flare', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'Kicks shoot the edge bars inward' },
  { id: 'tear', label: 'Snare tear', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Snares make a few columns slip' },
  { id: 'scratch', label: 'Scratches', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Thin vertical lines drawn by loud highs' },
  { id: 'tracker', label: 'Tracking box', group: 'Overlay', type: 'bool', default: true },
];

const fragment = /* glsl */ `
#define SS_ROWS ${ROWS}.0
#define SS_LAG ${LAG}.0
uniform sampler2D tHist;   // BINS x ROWS ring buffer, .r = one bin at one moment
uniform sampler2D tRow;    // 1 x ROWS, per moment: r lows, g highs (slow), b drop streak
uniform float uCount;      // index of the newest moment
uniform float uUnit;       // device px per mark pixel
uniform vec4 uArea;        // scan area in device px: x0, y0, x1, y1
uniform float uState;      // eased energy
uniform float uGrow;       // eased build
uniform float uFlare;      // kick envelope
uniform float uHalf;       // half the record's width, as a share of the scan area
uniform vec2 uSnareFx;     // slip envelope, seed
uniform vec2 uHatFx;       // speck envelope, seed
uniform vec2 uDropFx;      // flash, negative
uniform vec4 uBox;         // tracking box: centre x, y, half width, half height (device px)
uniform vec4 uGhost;       // where the box was before it jumped
uniform vec4 uBoxInfo;     // columns, rows, readout side, ghost on
uniform vec3 uRead;        // bin, level 0..999, beat count

// the fold: the centre line wanders and the width breathes, both fixed to the record (r = moment)
float ssAxis(float r) { return u_warp * (0.05 * sin(r * 0.021 + 1.3) + 0.028 * sin(r * 0.058 + 4.1)); }
float ssSpan(float r) { return 1.0 + u_warp * (0.17 * sin(r * 0.027 + 0.4) + 0.09 * sin(r * 0.071 + 2.2)); }
// columns ride a little higher or lower, so a flat hit becomes an arc
float ssLift(float c, float r) { return u_warp * (5.0 * sin(c * 0.043 + r * 0.011) + 2.5 * sin(c * 0.117 - r * 0.023 + 1.7)); }
float ssBin(float xa, float r, float left) {
  float d = abs(xa - 0.5 - ssAxis(r)) / (uHalf * ssSpan(r) * (1.0 - 0.14 * left));
  return u_fold < 0.5 ? 1.0 - d : (u_fold < 1.5 ? d : xa);
}
// whole number as n digits, 4 glyph px per character
float ssInt(vec2 c, float v, float n) {
  if (c.y < 0.0 || c.y >= 5.0 || c.x < 0.0 || c.x >= n * 4.0) return 0.0;
  float ci = floor(c.x / 4.0);
  return hmDigit(vec2(c.x - ci * 4.0, c.y), mod(floor(v / pow(10.0, n - 1.0 - ci) + 0.0001), 10.0));
}
float ssFrame(vec2 fc, vec4 b, float u) {
  vec2 d = abs(fc + 0.5 - b.xy);
  if (d.x > b.z || d.y > b.w) return 0.0;
  return (d.x > b.z - u || d.y > b.w - u) ? 1.0 : 0.0;
}

void main() {
  vec2 fc = floor(gl_FragCoord.xy);
  vec2 res = uResolution;
  float u = uUnit;
  float shortSide = min(res.x, res.y);
  vec2 aSize = uArea.zw - uArea.xy;
  float tone = 0.0; // 0 nothing · 1 dim · 2 grey · 3 full

  // ── the record: dashes in scan columns ──
  if (fc.x >= uArea.x && fc.x < uArea.z && fc.y >= uArea.y && fc.y < uArea.w) {
    vec2 g = floor((fc - uArea.xy) / u);
    float c = floor(g.x / ${CW}.0);
    float lx = g.x - c * ${CW}.0;

    // snare: a few groups of columns tear loose, slip, and step back into place
    float gw = 2.0 + floor(hash11(uSnareFx.y * 3.7 + 1.0) * 7.0);
    float grp = floor(c / gw);
    float slip = 0.0;
    float torn = 0.0;
    if (hash21(vec2(grp, uSnareFx.y)) < 0.22 * u_tear * (0.35 + uState + uGrow)) {
      torn = uSnareFx.x;
      slip = floor((hash21(vec2(grp + 3.0, uSnareFx.y + 7.0)) - 0.4) * 90.0 * u_tear * torn + 0.5);
    }
    float gy = g.y + slip * ${CH}.0;
    float j = floor(gy / ${CH}.0);
    float ly = gy - j * ${CH}.0;
    float xa = (c + 0.5) * ${CW}.0 * u / aSize.x;
    // the two halves are not a perfect mirror: the left one runs a little behind and narrower
    float r0 = uCount - j;
    float left = (u_fold < 1.5 && xa < 0.5 + ssAxis(r0)) ? 1.0 : 0.0;
    // every scan column is a little out of step with its neighbours, so edges fray vertically
    float colGain = hash11(c * 1.37 + 5.0); // ...and has its own sensitivity
    float fray = floor((hash11(c * 3.1 + 2.0) - 0.5) * 9.0 * u_warp + 0.5);
    float jj = j + floor(ssLift(c, r0) + 0.5) + left * SS_LAG + fray;
    float r = uCount - jj;
    // some columns hold each reading for a few moments and print it as a short vertical run
    float holdN = colGain > 0.78 ? 2.0 + floor(hash11(c * 5.3 + 1.0) * 4.0) : 1.0;
    if (torn > 0.12) holdN = max(holdN, 3.0 + floor(torn * 9.0)); // torn columns smear as they slip
    r = floor(r / holdN) * holdN;

    if (jj >= 0.0 && jj < SS_ROWS - 1.0) {
      float rv = (mod(r, SS_ROWS) + 0.5) / SS_ROWS;
      vec4 row = texture2D(tRow, vec2(0.5, rv));
      float rr = mod(r, 4096.0);
      float f = ssBin(xa, r0, left) + u_warp * 0.06 * snoise(vec2(xa * 4.6, r * 0.013));

      if (f >= 0.0 && f <= 1.0) {
        float v = texture2D(tHist, vec2((floor(f * 127.0 + 0.5) + 0.5) / 128.0, rv)).r;
        float dead = step(colGain, 0.13);
        float lv = v * (0.4 + 0.8 * colGain) * (1.0 - 0.85 * dead) * (0.3 + 1.0 * u_density) * (0.55 + 0.7 * uState + 0.4 * uGrow) * (1.0 + 1.6 * torn);
        float h1 = hash21(vec2(c, rr));
        float h2 = hash21(vec2(c + 71.0, rr + 13.0));
        if (row.b > 0.5) {
          // drop streaks: loud bins run as unbroken lines
          if (lx < 2.0 && v * (0.5 + colGain) > 0.2 + 0.4 * hash11(c * 2.1 + 1.0)) tone = lv > 0.3 ? 3.0 : 2.0;
        } else if (h1 < 0.9 * smoothstep(0.02, 0.6, lv)) {
          float len = holdN > 1.5 ? 1.0 : min(3.0, 1.0 + floor(lv * 4.5 * (0.3 + h2)));
          float tall = (holdN > 1.5 || lv > 0.62) ? 3.0 : (lv > 0.4 ? 2.0 : 1.0);
          bool mark = lx < len && ly < tall;
          // bright parts also print small hollow cells
          if (holdN < 1.5 && lv > 0.45 && h2 > 0.74) mark = lx < 3.0 && (lx == 0.0 || lx == 2.0 || ly == 0.0 || ly == 2.0);
          float tv = lv * (0.6 + 0.8 * h2);
          if (mark) tone = tv > 0.3 ? 3.0 : (tv > 0.12 ? 2.0 : 1.0);
        }
      }

      // scratches: loud highs draw thin lines down a few columns
      float sc = hash11(c * 0.731 + 9.0);
      float air = max(row.g - 0.12, 0.0);
      if (lx == 1.0 && sc < 0.007 + 0.3 * u_scratch * air * sqrt(air) && hash21(vec2(c, floor(rr / 19.0))) > 0.16) {
        tone = max(tone, sc < 0.02 ? 2.0 : 1.0);
      }
    }

    // hats: specks
    vec2 sg = floor(g / 2.0);
    if (hash21(sg + uHatFx.y * 17.0) < uHatFx.x * 0.012 * (0.4 + uState)) tone = 3.0;
  }

  // ── edge bars: blocks of hard barcode streaks bleeding in from outside the frame ──
  vec2 halfRes = res * 0.5;
  float reach = 0.25 + 0.75 * uState; // quiet: short stubs; loud: full length
  if (fc.y >= uArea.y) {
    // left and right: horizontal bars that travel with the record; each moment remembers its lows
    float fy = floor((fc.y - uArea.y) / u);
    float jb = floor(fy / ${CH}.0);
    float low = jb < SS_ROWS - 1.0 ? texture2D(tRow, vec2(0.5, (mod(uCount - jb, SS_ROWS) + 0.5) / SS_ROWS)).r : 0.0;
    float yy = mod(uCount * ${CH}.0 - fy, 12288.0);
    float side = fc.x < halfRes.x ? 0.0 : 1.0;
    float edge = side < 0.5 ? fc.x : res.x - 1.0 - fc.x;
    float blk = floor(yy / 54.0);
    float hb = hash21(vec2(blk, side * 7.0 + 1.0));
    float band = floor(yy / (1.0 + floor(pow(hash21(vec2(blk, side + 3.0)), 1.6) * 6.0)));
    float hband = hash21(vec2(band, side * 5.0 + 2.0));
    float hf = hash21(vec2(band, side + 9.0));
    float kickIn = u_flare * uFlare * (0.45 + 0.55 * uState);
    float live = step(hb, (0.16 + 0.5 * uState + 0.3 * uGrow + 0.5 * kickIn) * u_bars * 1.6);
    float dens = 0.2 + 0.55 * low + 0.25 * uGrow + 0.25 * kickIn;
    float gutter = side < 0.5 ? uArea.x : res.x - uArea.z;
    float base = side < 0.5 ? gutter * (hb * 7.0 < 2.0 ? 0.6 : 1.0) : gutter + shortSide * 0.09 * fract(hb * 13.0);
    float len = base * reach + halfRes.x * (kickIn * (0.05 + 0.3 * hf * hf) + uGrow * (0.14 + 0.34 * fract(hb * 29.0)));
    if (live > 0.5 && hband < dens && edge < floor(len / u) * u) tone = hf > 0.35 ? 3.0 : 2.0;
  }
  {
    // bottom: the live input as a barcode; top: bars that only push in when it is loud
    float gx = floor(fc.x / u);
    float blk = floor(gx / 22.0);
    float hb = hash11(blk * 1.9 + 2.0);
    float band = floor(gx / (1.0 + floor(pow(hb, 1.6) * 6.0)));
    float hband = hash11(band * 1.31 + 0.7);
    float hf = hash11(band * 2.77 + 4.0);
    float xb = ((blk + 0.5) * 22.0 * u - uArea.x) / aSize.x;
    float sp = spectrum(clamp(ssBin(xb, uCount, 0.0), 0.0, 1.0));
    float kickIn = u_flare * uFlare * (0.45 + 0.55 * uState);
    float live = step(fract(hb * 17.0), (0.3 + 0.5 * uState + 0.3 * uGrow + 0.4 * kickIn) * u_bars * 1.6);
    float hBot = uArea.y * (0.25 + 1.1 * sp + 0.2 * hf) * (0.5 + 0.5 * reach)
      + halfRes.y * (kickIn * (0.04 + 0.3 * hf * hf) + uGrow * (0.1 + 0.3 * fract(hb * 29.0)));
    if (live > 0.5 && hband < 0.6 && fc.y < floor(hBot / u) * u) tone = hf > 0.4 ? 3.0 : 2.0;
    float loud = smoothstep(0.5, 0.9, uState);
    float hbt = hash11(blk * 2.3 + 11.0);
    float hTop = halfRes.y * (loud * (0.05 + 0.12 * hbt + kickIn * 0.22 * hf * hf) + uGrow * (0.08 + 0.3 * hbt));
    if (fract(hbt * 17.0) < (0.25 + 0.4 * uState) * u_bars * 1.6 && hash11(band * 1.93 + 8.0) < 0.55 && res.y - 1.0 - fc.y < floor(hTop / u) * u) tone = hf > 0.4 ? 3.0 : 2.0;
  }

  // ── the tracking box ──
  float pixel = 0.0;
  float counter = 0.0;
  if (u_tracker > 0.5) {
    if (uBoxInfo.w > 0.5 && ssFrame(fc, uGhost, u) > 0.5 && mod(floor((fc.x + fc.y) / u), 4.0) < 2.0) tone = max(tone, 1.0);
    vec2 lo = uBox.xy - uBox.zw;
    vec2 q = fc - lo;
    vec2 size = uBox.zw * 2.0;
    // distance in from the outline (negative outside); a one-pixel moat keeps the line readable
    float din = min(min(q.x, q.y), min(size.x - 1.0 - q.x, size.y - 1.0 - q.y));
    if (din >= -2.0 * u && din < 2.0 * u) tone = (din >= 0.0 && din < u) ? 3.0 : 0.0;
    if (din >= u) {
      for (int i = 1; i < 4; i++) {
        float k = float(i);
        if (k < uBoxInfo.x && floor(q.x / u) == floor(k * size.x / uBoxInfo.x / u)) tone = 3.0;
        if (k < uBoxInfo.y && floor(q.y / u) == floor(k * size.y / uBoxInfo.y / u)) tone = 3.0;
      }
    }
    // readout beside the centre: bin index and level, printed as one six-digit number
    float dp = 2.0 * u;
    vec2 tOrg = vec2(uBox.x + (uBoxInfo.z > 0.0 ? 6.0 * u : -6.0 * u - 23.0 * dp), uBox.y - 3.0 * dp);
    vec2 tc = floor((fc - tOrg) / dp);
    if (tc.x >= -1.0 && tc.x < 24.0 && tc.y >= -1.0 && tc.y < 6.0) {
      tone = 0.0;
      if (ssInt(tc, uRead.x, 3.0) + ssInt(tc - vec2(12.0, 0.0), uRead.y, 3.0) > 0.5) tone = 3.0;
    }
    // beat count, small, under the box
    vec2 bOrg = vec2(uBox.x + uBox.z - 15.0 * u, lo.y - 8.0 * u);
    vec2 bc = floor((fc - bOrg) / u);
    if (bc.x >= -1.0 && bc.x < 16.0 && bc.y >= -1.0 && bc.y < 6.0) {
      tone = 0.0;
      counter = ssInt(bc, mod(uRead.z, 10000.0), 4.0);
    }
    vec2 pd = fc - (uBox.xy - vec2(3.0 * u));
    if (pd.x >= 0.0 && pd.y >= 0.0 && pd.x < 6.0 * u && pd.y < 6.0 * u) {
      tone = 0.0;
      if (pd.x >= u && pd.y >= u && pd.x < 5.0 * u && pd.y < 5.0 * u) pixel = 1.0;
    }
  }

  vec3 dim = mix(uMuted, mix(uBg, uFg, 0.4), 0.5);
  vec3 col = tone > 2.5 ? uFg : (tone > 1.5 ? mix(uBg, uFg, 0.56) : (tone > 0.5 ? dim : uBg));

  // drop: one frame-filling streak flash, then a beat of negative
  if (uDropFx.y > 0.5) col = uBg + uFg - col;
  if (uDropFx.x > 0.5) {
    float gx = floor(fc.x / u);
    float w = 1.0 + floor(hash11(floor(gx / 9.0) * 1.7 + 3.0) * 3.0);
    col = hash11(floor(gx / w) * 1.13 + 6.0) < 0.14 ? uBg : uFg;
  }
  col = mix(col, uAccent2, counter);
  col = mix(col, uAccent, pixel);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* the same fold on the CPU, so the tracking box can find on screen what it found in the record */
const axisOf = (r: number, warp: number) => warp * (0.05 * Math.sin(r * 0.021 + 1.3) + 0.028 * Math.sin(r * 0.058 + 4.1));
const spanOf = (r: number, warp: number) => 1 + warp * (0.17 * Math.sin(r * 0.027 + 0.4) + 0.09 * Math.sin(r * 0.071 + 2.2));
const liftOf = (c: number, r: number, warp: number) => warp * (5 * Math.sin(c * 0.043 + r * 0.011) + 2.5 * Math.sin(c * 0.117 - r * 0.023 + 1.7));

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
const cell01 = (x: number, y: number) => {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return v - Math.floor(v);
};
/** smooth 2D value noise, 0..1 */
const drift = (x: number, y: number) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const top = cell01(xi, yi) * (1 - ux) + cell01(xi + 1, yi) * ux;
  const bot = cell01(xi, yi + 1) * (1 - ux) + cell01(xi + 1, yi + 1) * ux;
  return top * (1 - uy) + bot * uy;
};
const ease = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export const signalScan: SceneDef = {
  id: 'signal-scan',
  name: 'Signal Scan',
  description:
    'A line-scan recording of the song in black and white: the last few seconds of the spectrum rise through the frame as ghost shapes made of tiny dashes in vertical scan columns, with barcode bars bleeding in from the edges. Kicks flare the bars, snares tear columns loose, hats scatter specks, and one thin tracking box with a number readout hunts the loudest region. Builds close the bars in and shrink the box onto a point; the drop is a white streak flash, a beat of negative and a wiped record.',
  category: 'field',
  style: 'data',
  tags: ['dark', 'cold', 'glitch', 'experimental', 'minimal', 'electronic', 'techno', 'ambient', 'hypnotic', 'cinematic', 'melancholic', 'futuristic', 'graphic'],
  params,
  modulations: [
    { source: 'air', param: 'scratch', amount: 0.2 },
    { source: 'energy', param: 'bars', amount: 0.15 },
  ],
  create(init) {
    const hist = new Uint8Array(BINS * ROWS);
    const rows = new Uint8Array(ROWS * 4);
    const dataTex = (data: Uint8Array, w: number, format: THREE.PixelFormat) => {
      const t = new THREE.DataTexture(data, w, ROWS, format, THREE.UnsignedByteType);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.NoColorSpace;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    const histTex = dataTex(hist, BINS, THREE.RedFormat);
    const rowTex = dataTex(rows, 1, THREE.RGBAFormat);

    const uniforms = {
      ...createBaseUniforms(init.shared, params),
      tHist: { value: histTex },
      tRow: { value: rowTex },
      uCount: { value: 0 },
      uUnit: { value: 1 },
      uArea: { value: new THREE.Vector4() },
      uState: { value: 0 },
      uGrow: { value: 0 },
      uFlare: { value: 0 },
      uHalf: { value: HALF },
      uSnareFx: { value: new THREE.Vector2() },
      uHatFx: { value: new THREE.Vector2() },
      uDropFx: { value: new THREE.Vector2() },
      uBox: { value: new THREE.Vector4() },
      uGhost: { value: new THREE.Vector4() },
      uBoxInfo: { value: new THREE.Vector4(2, 2, 1, 0) },
      uRead: { value: new THREE.Vector3() },
    };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `${GLSL_HEADER}\n${paramUniformDecls(params)}\n${GLSL_COMMON}\n${HM_LIB}\n${fragment}`,
      depthTest: false,
      depthWrite: false,
    });
    const quad = createFullscreenQuad(material);

    const rng = mulberry32(0x51c4a11);
    const env = new Float32Array(BINS); // each bin's level with a short tail
    const avg = new Float32Array(BINS); // each bin's slow average: what is "normal" for it
    const val = new Float32Array(BINS); // what gets written: the part that stands out
    let count = ROWS; // index of the newest moment (its row in the ring is count % ROWS)
    let acc = 0;
    let started = false;
    let state = 0;
    let grow = 0;
    let flare = 0;
    let snareEnv = 0;
    let snareSeed = 1;
    let hatEnv = 0;
    let hatSeed = 1;
    let airSlow = 0;
    let exposure = 0.5;
    let prevDrop = -1;
    let sinceDrop = 100;
    let sinceJump = 100;
    let beatsHeld = 0;
    let ghostT = 100;
    let sweep = 0;
    /** the box: what it locked onto (bin, moment, column) and how it is drawn */
    const box = { bin: 40, r: -1e6, col: 0, lag: 0, riding: false, x: 0.5, y: 0.5, hw: 0.11, hh: 0.07, nx: 3, ny: 2, level: 0, side: 1 };
    const ghost = new THREE.Vector4();

    // a record nobody has written to yet still has sensor noise in it: sparse ash
    const ash = (row: number) => {
      if (rng() < 0.55) hist[row * BINS + Math.floor(rng() * BINS)] = 50 + Math.floor(rng() * 130);
    };
    for (let i = 0; i < ROWS; i++) ash(i);

    const push = (low: number, air: number, streak: boolean) => {
      count++;
      const row = count % ROWS;
      const o = row * BINS;
      for (let i = 0; i < BINS; i++) hist[o + i] = Math.round(val[i] * 255);
      ash(row);
      rows[row * 4] = Math.round(clamp01(low) * 255);
      rows[row * 4 + 1] = Math.round(clamp01(air) * 255);
      rows[row * 4 + 2] = streak ? 255 : 0;
      rows[row * 4 + 3] = 255;
    };

    /** find the brightest block of the visible record and lock the box onto it */
    const acquire = (vis: number, cols: number, half: number, warp: number, fold: number, energy: number) => {
      const j0 = Math.floor(vis * 0.14);
      const j1 = Math.floor(Math.min(vis, ROWS - 2) * 0.74);
      let best = -1;
      let bestRaw = 0;
      let bb = 0;
      let bj = j0;
      for (let j = j0; j + 8 <= j1; j += 8) {
        for (let b = 0; b + 8 <= BINS; b += 8) {
          let s = 0;
          for (let k = 0; k < 8; k += 2) {
            const o = ((count - j - k) % ROWS) * BINS + b;
            for (let i = 0; i < 8; i++) s += hist[o + i];
          }
          const raw = s / (32 * 255);
          let score = raw * (0.6 + 0.8 * rng()); // not always the very same spot
          if (Math.abs(b + 4 - box.bin) < 14 && Math.abs(count - j - 4 - box.r) < 28) score *= 0.4;
          if (score > best) {
            best = score;
            bestRaw = raw;
            bb = b;
            bj = j;
          }
        }
      }
      // the loudest bin inside that block is the number on the readout
      let peak = bb;
      let pv = -1;
      for (let i = 0; i < 8; i++) {
        let s = 0;
        for (let k = 0; k < 8; k++) s += hist[((count - bj - k) % ROWS) * BINS + bb + i];
        if (s > pv) {
          pv = s;
          peak = bb + i;
        }
      }
      const r = count - bj - 4;
      const f = peak / (BINS - 1);
      let xa = f;
      if (fold < 2) {
        const d = fold < 1 ? 1 - f : f;
        // the left half runs LAG moments behind and a little narrower (see the shader)
        let left = rng() < 0.5;
        const place = () => {
          const at = r + (left ? LAG : 0);
          return 0.5 + axisOf(at, warp) + (left ? -0.86 : 1) * d * half * spanOf(at, warp);
        };
        xa = place();
        if (xa < 0.08 || xa > 0.92) {
          left = !left;
          xa = place();
        }
        box.lag = left ? LAG : 0;
      } else box.lag = 0;
      box.bin = peak;
      box.r = r;
      box.col = Math.floor(clamp01(xa) * cols);
      box.x = clamp01(xa);
      box.level = bestRaw;
      box.riding = bestRaw > 0.035;
      box.hw = 0.065 + 0.085 * rng();
      box.hh = 0.04 + 0.06 * rng();
      box.nx = Math.min(4, 1 + Math.floor(rng() * 2.4 + energy * 1.6));
      box.ny = Math.min(3, 1 + Math.floor(rng() * 1.7 + energy * 0.9));
      sinceJump = 0;
      beatsHeld = 0;
    };

    return {
      render(frame, target) {
        const dt = Math.min(Math.max(frame.dt, 0), 0.1);
        const a = frame.audio;
        const P = frame.params;
        const W = frame.width;
        const H = frame.height;
        const short = Math.min(W, H);
        const warp = num(P, 'warp', 0.65);
        const fold = Math.max(0, ['edges', 'centre', 'plain'].indexOf(str(P, 'fold', 'edges')));

        // layout, in whole mark pixels: a wide gutter on the left, a thin one on the right, bars below
        const u = Math.max(1, Math.floor((short / 540) * num(P, 'cell', 1) + 0.5));
        const snap = (v: number) => Math.round(v / u) * u;
        const x0 = snap(short * 0.085);
        const x1 = W - snap(short * 0.03);
        const y0 = snap(short * 0.075);
        const cols = Math.ceil((x1 - x0) / (CW * u));
        const vis = Math.min(ROWS - 2, Math.ceil((H - y0) / (CH * u)));
        const half = Math.min(HALF, (TALL * (H - y0)) / (x1 - x0));

        // slow state and hit envelopes
        state = ease(state, a.energy, 1.1, dt);
        const wind = Math.max(a.build, frame.feel.tension);
        grow = ease(grow, wind, wind > grow ? 3 : 2, dt);
        flare = Math.max(flare * Math.exp(-dt * 6.5), a.kickHit ? Math.max(0.6, Math.min(1, a.kick)) : 0);
        if (a.snareHit) {
          snareEnv = 1;
          snareSeed = (snareSeed % 997) + 1;
        } else snareEnv *= Math.exp(-dt * 6);
        if (a.hatHit) {
          hatEnv = 1;
          hatSeed = (hatSeed % 997) + 1;
        } else hatEnv *= Math.exp(-dt * 13);
        const highs = Math.max(a.air, a.highMid * 0.8);
        airSlow = ease(airSlow, highs, highs > airSlow ? 8 : 1.5, dt);

        // drop: wipe the record; the flash and the beat of negative are timed from here
        const fired = prevDrop >= 0 && a.drop > 0.6 && prevDrop <= 0.6;
        prevDrop = a.drop;
        sinceDrop = Math.min(100, sinceDrop + dt);
        if (fired) {
          hist.fill(0);
          rows.fill(0);
          sinceDrop = 0;
          grow = 0; // the vise lets go at once
          ghost.copy(uniforms.uBox.value);
          ghostT = 0;
          box.riding = false;
          box.x = 0.5;
          box.y = 0.5;
          box.hw = 0.3;
          box.hh = 0.2;
          box.nx = 4;
          box.ny = 3;
          sinceJump = 0;
          beatsHeld = 0;
        }
        const beatLen = Math.min(0.75, Math.max(0.3, 60 / (a.bpm > 0 ? a.bpm : 120)));

        // what stands out of each bin right now
        const sp = a.spectrum;
        const relK = Math.exp(-dt * 5);
        const avgK = 1 - Math.exp(-dt / 1.4);
        let peak = 0;
        for (let i = 0; i < BINS; i++) {
          const s = sp[i] ?? 0;
          if (!started) avg[i] = s;
          env[i] = Math.max(s, env[i] * relK);
          avg[i] += (s - avg[i]) * avgK;
          if (env[i] > peak) peak = env[i];
        }
        // auto exposure: a quiet passage is still recorded, only fainter (the shader thins it out)
        if (!started) exposure = peak;
        exposure = ease(exposure, peak, peak > exposure ? 5 : 0.35, dt);
        const gain = 1 / Math.min(1, Math.max(0.3, exposure));
        for (let i = 0; i < BINS; i++) val[i] = clamp01(((env[i] - 0.72 * avg[i]) * 2.3 + env[i] * 0.3) * gain);
        if (!started) {
          // a scene can be born mid-song: start with a record already in the frame, made from
          // what is sounding now and broken up into drifts, so the first second is not blank
          for (let k = vis; k > 0; k--) {
            const row = (count - k) % ROWS;
            for (let i = 0; i < BINS; i++) {
              const n = drift(i * 0.11, k * 0.045) * drift(i * 0.31 + 9, k * 0.13 + 4);
              hist[row * BINS + i] = Math.round(clamp01(val[i] * Math.max(0, n * 5 - 0.55)) * 255);
            }
            ash(row);
            rows[row * 4] = Math.round(clamp01(a.kick * drift(3, k * 0.4)) * 255);
            rows[row * 4 + 1] = Math.round(clamp01(Math.max(a.air, a.highMid * 0.8) * 1.2 * drift(7, k * 0.02)) * 255);
          }
          histTex.needsUpdate = true;
          rowTex.needsUpdate = true;
        }
        started = true;

        // write new moments: the scan runs faster when the song is louder, and after a drop it
        // races, refilling the whole frame with streaks within the beat of negative
        const burst = Math.exp(-sinceDrop * 5);
        let rate = (vis / 7) * num(P, 'speed', 1) * (0.3 + 1.45 * state + 0.5 * grow) * (a.playing ? 1 : 0.4);
        rate += vis * 5.4 * burst;
        acc += rate * dt;
        let n = Math.floor(acc);
        acc -= n;
        if (n > 64) n = 64;
        const low = Math.max(a.kick, a.sub * 0.8);
        for (let i = 0; i < n; i++) push(low, airSlow, burst > 0.12);
        if (n > 0) {
          histTex.needsUpdate = true;
          rowTex.needsUpdate = true;
        }

        // the tracking box hunts: every beat or two it jumps to the brightest recent region
        sinceJump += dt;
        ghostT += dt;
        if (a.beat) beatsHeld++;
        const hold = state > 0.62 ? 1 : state > 0.3 ? 2 : 4;
        const homing = grow > 0.1;
        if (!homing && sinceDrop > beatLen * 0.9 && ((a.beat && beatsHeld >= hold) || sinceJump > hold * 1.3 + 0.6)) {
          ghost.copy(uniforms.uBox.value);
          ghostT = 0;
          acquire(vis, cols, half, warp, fold, state);
          if (!box.riding) box.y = 0.3 + 0.45 * rng();
        }
        let bx: number;
        let by: number;
        if (box.riding) {
          const j = count - box.r - box.lag - Math.round(liftOf(box.col, box.r + box.lag, warp));
          bx = x0 + (box.col + 0.5) * CW * u;
          by = y0 + (j + 0.5) * CH * u;
          if (by > y0 + (H - y0) * 0.9) box.riding = false; // rode out of frame: wait for the next jump
          box.y = (by - y0) / (H - y0);
        } else {
          // nothing to lock onto: sweep sideways in slow steps
          sweep += dt;
          const stepX = Math.floor(sweep / 0.22) * 2 * CW * u * (sinceDrop < beatLen ? 0 : 1);
          bx = x0 + box.x * (x1 - x0) + (((stepX / (x1 - x0)) % 0.2) - 0.1) * (x1 - x0);
          by = y0 + box.y * (H - y0);
        }
        let hw = box.hw * short;
        let hh = box.hh * short;
        if (homing) {
          // build: the box stops hunting, closes on one point and shrinks onto it
          const k = clamp01((grow - 0.1) / 0.5);
          const kk = k * k * (3 - 2 * k);
          bx += ((x0 + x1) / 2 - bx) * kk;
          by += (y0 + (H - y0) * 0.5 - by) * kk;
          const shrink = Math.pow(1 - clamp01((grow - 0.1) / 0.85), 1.4);
          hw = Math.max(4 * u, hw * shrink);
          hh = Math.max(4 * u, hh * shrink);
        }
        hw = Math.max(4 * u, snap(hw));
        hh = Math.max(4 * u, snap(hh));
        bx = Math.min(x1 - hw - 2 * u, Math.max(x0 + hw + 2 * u, snap(bx)));
        by = Math.min(H - hh - 2 * u, Math.max(y0 + hh + 10 * u, snap(by)));
        uniforms.uBox.value.set(bx, by, hw, hh);
        uniforms.uGhost.value.copy(ghost);
        uniforms.uBoxInfo.value.set(box.nx, box.ny, bx + 5 * u + 48 * u < x1 ? 1 : -1, ghostT < 0.3 && !homing ? 1 : 0);
        // the readout prints what the box is looking at right now
        const liveJ = Math.round((by - y0) / (CH * u)) - box.lag;
        let liveLevel = 0;
        for (let k = -1; k <= 1; k++) {
          const o = ((count - liveJ - k + ROWS * 4) % ROWS) * BINS;
          for (let i = -7; i <= 7; i++) liveLevel += hist[o + Math.min(BINS - 1, Math.max(0, box.bin + i))] / (45 * 255);
        }
        uniforms.uRead.value.set(box.bin, Math.round(clamp01(box.riding ? liveLevel : box.level) * 999), a.beatCount);

        updateBaseUniforms(uniforms, frame);
        updateParamUniforms(uniforms, params, P);
        uniforms.uCount.value = count;
        uniforms.uUnit.value = u;
        uniforms.uArea.value.set(x0, y0, x1, H);
        uniforms.uState.value = state;
        uniforms.uGrow.value = grow;
        uniforms.uFlare.value = flare;
        uniforms.uHalf.value = half;
        uniforms.uSnareFx.value.set(snareEnv, snareSeed);
        uniforms.uHatFx.value.set(hatEnv, hatSeed);
        uniforms.uDropFx.value.set(sinceDrop < 0.09 ? 1 : 0, sinceDrop < beatLen ? 1 : 0);
        quad.render(frame.renderer, target);
      },
      dispose() {
        material.dispose();
        quad.dispose();
        histTex.dispose();
        rowTex.dispose();
      },
    };
  },
};
