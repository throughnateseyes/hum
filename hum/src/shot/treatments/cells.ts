/**
 * Cells: the picture rebuilt on a character grid (reference: a figure in blocks, digits and
 * punctuation in grey, yellow, magenta and green on black).
 *
 * The rule: each cell reads the picture's brightness under it and its edge. Bright cells are solid
 * blocks and shades in grey and white, so the figures stay readable as silhouettes; mid-dark cells are
 * digits and punctuation; dark cells are the field with a stray dot; a strong edge is a half block or
 * a slash in one of the flat colours, turned with the edge. Cells flip to another glyph of their kind
 * on the hats, a few columns slide by whole cells on each bar, and a few cells carry real data: the
 * bar, the time, the tempo.
 */
import * as THREE from 'three';
import { ATLAS_GLSL, BLOCK, TEXT_GLSL, TextLines, atlasTexture, glyphOf } from './glyphs';
import { HEAD_GLSL, TAIL_GLSL, barOf, clock, headUniforms, hitsBefore, makeMaterial, readable, strictFor, unit, type TreatFrame } from './common';

const FRAG = /* glsl */ `
${HEAD_GLSL}
${ATLAS_GLSL}
${TEXT_GLSL}
${TAIL_GLSL}
uniform float uCell;
uniform vec2 uCuts;
uniform float uBarN, uHatN, uSinceBar, uSeed, uHues;
uniform vec3 uField, uGrey, uWhite, uA, uB, uC;

// glyphs by kind, two or three of each so a cell can flip to another of its kind
float pick3(float a, float b, float c, float v) { return v < 0.34 ? a : v < 0.67 ? b : c; }

vec3 hue(float i) { return i < 0.5 ? uA : i < 1.5 ? uB : uC; }

// a cell's brightness, four taps spread across it
float cellLuma(vec2 at, vec2 d) {
  return 0.25 * (luma(bed(at + d * vec2(-0.3, -0.3)).rgb) + luma(bed(at + d * vec2(0.3, -0.3)).rgb) + luma(bed(at + d * vec2(-0.3, 0.3)).rgb) + luma(bed(at + d * vec2(0.3, 0.3)).rgb));
}

void main() {
  vec2 px = vUv * uRes;
  vec2 count = floor(uRes / uCell);
  vec2 off = floor((uRes - count * uCell) * 0.5);
  vec2 q = px - off;
  vec2 cell = floor(q / uCell);
  vec2 local = fract(q / uCell);
  vec4 b = bed(vUv);

  // a few columns slide by whole cells on each bar (a quick slide in the bar's first moment)
  float bar = uBarN;
  float roll = 0.0;
  if (hash(vec2(cell.x * 1.37 + uSeed, bar * 0.71)) < 0.2) {
    float by = floor(hash(vec2(cell.x, bar + 9.1)) * 7.0) - 3.0;
    roll = by * smoothstep(0.0, 0.16, uSinceBar);
  }
  float rollCells = floor(roll + 0.5);
  vec2 src = cell + vec2(0.0, rollCells);

  // the picture under the cell, averaged over nine taps so fine texture (grass, fur, gravel) settles
  // into one value instead of flipping each cell to a different kind of glyph
  vec2 cuv = (off + (src + 0.5) * uCell) / uRes;
  vec2 d = vec2(uCell) / uRes;
  vec3 c0 = vec3(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) c0 += bed(cuv + d * vec2(float(i), float(j)) * 0.33).rgb;
  c0 /= 9.0;
  // a vivid colour counts as bright as its strongest channel half way, so a red bird is a body, not a hole
  float l = mix(luma(c0), max(c0.r, max(c0.g, c0.b)), 0.45);
  // the edge is read between whole neighbouring cells (each averaged), so only the picture's real
  // contours count, not its fine texture
  float gx = cellLuma(cuv + vec2(d.x * 1.3, 0.0), d) - cellLuma(cuv - vec2(d.x * 1.3, 0.0), d);
  float gy = cellLuma(cuv + vec2(0.0, d.y * 1.3), d) - cellLuma(cuv - vec2(0.0, d.y * 1.3), d);
  float edge = length(vec2(gx, gy));

  // brightness against the picture's own range, so a dark picture and a bright one both fill the scale
  float lo = uCuts.x * 0.45;
  float k = clamp((l - lo) / max(0.08, (uCuts.y + (1.0 - uCuts.y) * 0.3) - lo), 0.0, 1.0);

  // hats flip a third of the cells to another glyph of their kind
  float v = hash(src * 1.31 + uSeed);
  if (hash(src + vec2(floor(uHatN) * 0.613, 3.7)) < 0.33) v = fract(v + 0.37 + 0.21 * hash1(floor(uHatN)));
  float hv = hash(src * 2.17 + 5.3);

  float g = 0.0;
  vec3 ink = uGrey;
  if (edge > 0.3 && k > 0.15 && hv < 0.8) {
    // an edge: a half block or a slash in a flat colour, turned with the edge
    bool across = abs(gx) > abs(gy) * 1.4;
    bool along = abs(gy) > abs(gx) * 1.4;
    if (across) g = gx > 0.0 ? ${BLOCK.right}.0 : ${BLOCK.left}.0;
    else if (along) g = gy > 0.0 ? ${BLOCK.upper}.0 : ${BLOCK.lower}.0;
    else g = (gx * gy > 0.0) ? ${glyphOf('/')}.0 : ${glyphOf('\\')}.0;
    if (v > 0.8) g = ${BLOCK.full}.0;
    // the colour follows the edge's direction, so a contour keeps one colour along its length
    float dirHue = across ? 0.0 : along ? 1.0 : 2.0;
    ink = hue(min(uHues - 1.0, dirHue));
    if (uHues < 1.5 && !across) ink = uWhite;
  } else if (k > 0.8) {
    g = v < 0.8 ? ${BLOCK.full}.0 : ${BLOCK.dark}.0;
    ink = mix(uGrey, uWhite, step(0.93, k));
  } else if (k > 0.6) {
    g = v < 0.7 ? ${BLOCK.dark}.0 : ${BLOCK.mid}.0;
    ink = uGrey;
  } else if (k > 0.42) {
    g = pick3(${BLOCK.mid}.0, ${BLOCK.light}.0, ${glyphOf('0')}.0, v);
    ink = uGrey * 0.8;
  } else if (k > 0.24) {
    g = pick3(${glyphOf('0')}.0, ${glyphOf('1')}.0, ${glyphOf('0')}.0, v);
    if (hv > 0.86) g = pick3(${glyphOf(':')}.0, ${glyphOf('"')}.0, ${glyphOf('/')}.0, v);
    ink = uWhite;
  } else if (k > 0.1) {
    g = hv > 0.55 ? pick3(${glyphOf('.')}.0, ${glyphOf(':')}.0, ${glyphOf('·')}.0, v) : 0.0;
    ink = uGrey * 0.75;
  } else {
    g = hv > 0.965 ? ${glyphOf('·')}.0 : 0.0;
    ink = uGrey * 0.5;
  }
  // a few specks of colour inside the body, like stuck pixels
  if (k > 0.5 && hv > 0.99) {
    g = ${BLOCK.full}.0;
    ink = hue(mod(floor(hv * 97.0), uHues));
  }

  // a sliding column draws between whole cells while it moves
  vec2 gl = local;
  gl.y = fract(local.y + (roll - rollCells));
  vec3 col = mix(uField, ink, atlas(g, gl));
  col = textOver(px, col);
  gl_FragColor = finish(col, b);
}
`;

export class Cells {
  readonly material: THREE.ShaderMaterial;
  private readonly lines = new TextLines();

  constructor() {
    this.material = makeMaterial(FRAG, {
      ...headUniforms(),
      tAtlas: { value: atlasTexture() },
      ...this.lines.uniforms(),
      uCell: { value: 12 },
      uCuts: { value: new THREE.Vector2(0.33, 0.66) },
      uBarN: { value: 0 },
      uHatN: { value: 0 },
      uSinceBar: { value: 0 },
      uSeed: { value: 0 },
      uHues: { value: 3 },
      uField: { value: new THREE.Color() },
      uGrey: { value: new THREE.Color() },
      uWhite: { value: new THREE.Color() },
      uA: { value: new THREE.Color() },
      uB: { value: new THREE.Color() },
      uC: { value: new THREE.Color() },
    });
  }

  update(f: TreatFrame, w: number, h: number) {
    const u = this.material.uniforms;
    const short = Math.min(w, h);
    // about 56 cells across the short side
    const cell = Math.max(6, Math.round(short / 56));
    u.uCell.value = cell;
    (u.uCuts.value as THREE.Vector2).set(f.scheme.cuts[0], f.scheme.cuts[1]);
    const barLen = f.beat * 4;
    const barN = Math.floor((f.t - f.partStart) / barLen + 1e-4);
    u.uBarN.value = barN;
    u.uSinceBar.value = f.t - (f.partStart + barN * barLen);
    u.uHatN.value = hitsBefore(f.hats, f.t, f.shotStart).n;
    u.uSeed.value = (f.layout % 997) * 0.731;
    const s = strictFor(f.scheme, f.palette, f.colour);
    u.uHues.value = s.hues;
    (u.uField.value as THREE.Color).copy(s.field);
    (u.uGrey.value as THREE.Color).copy(s.grey);
    (u.uWhite.value as THREE.Color).copy(s.white);
    (u.uA.value as THREE.Color).copy(s.a);
    (u.uB.value as THREE.Color).copy(s.b);
    (u.uC.value as THREE.Color).copy(s.c);

    // the data: whole cells of type on the field, at places on the grid the arrangement picks
    const L = this.lines;
    L.clear();
    const cols = Math.floor(w / cell);
    const rows = Math.floor(h / cell);
    const ox = Math.floor((w - cols * cell) / 2);
    const oy = Math.floor((h - rows * cell) / 2);
    const at = (c: number, r: number) => [ox + c * cell, oy + r * cell] as const;
    const bar = String(barOf(f)).padStart(3, '0');
    const items = [`BAR ${bar}`, clock(f.t, true), `${f.labels.tempo.replace(' ', '')}`, f.labels.part];
    // two places along the left and right margins, moved round by the arrangement and on every bar
    const r = (k: number) => unit(f.layout, k, barN);
    const spots: [number, number][] = [
      [2, rows - 3 - Math.floor(r(1) * 4)],
      [cols - 12, 2 + Math.floor(r(2) * 4)],
      [2 + Math.floor(r(3) * (cols - 16)), Math.floor(rows * (0.35 + r(4) * 0.3))],
    ];
    spots.forEach(([c, row], i) => {
      const [x, y] = at(c, row);
      L.add(items[(i + barN) % items.length], x, y, cell, i === 2 ? readable(s.a, s.field) : s.white, s.field, cell);
    });
    L.without(f.taken, w, h);
    L.commit();
    u.uLines.value = L.count;
  }

  dispose() {
    this.material.dispose();
    this.lines.texture.dispose();
  }
}
