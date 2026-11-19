import type { ClockDef } from './lib';
import { HM_LIB, defineClockedShaderScene, kickCountClock, sinceKickClock } from './lib';

/**
 * Glyph Mosaic — a grid of cells, each printing one glyph (dot, ring, plus, x, asterisk, square)
 * in a single ink on paper. Blobby, blocky patches of cells (cellular-automaton-like regions)
 * flip to a new glyph on kicks with a quick card-flip; which glyphs appear follows the bands;
 * snares knock patches to negative for an instant; drops dissolve the whole field to its inverse.
 */
const fragment = /* glsl */ `
${HM_LIB}

// glyph distance in cell units (q in -0.5..0.5). r = size 0..1, w = stroke weight
float glyphSd(float k, vec2 q, float r, float w) {
  if (k < 0.5) return length(q) - r * 0.42;                                         // dot
  if (k < 1.5) return abs(length(q) - r * 0.34) - w * 0.5;                          // ring
  if (k < 2.5) return min(sdBox(q, vec2(r * 0.46, w * 0.5)), sdBox(q, vec2(w * 0.5, r * 0.46))); // plus
  if (k < 3.5) { vec2 p = rot2(0.785398) * q;                                         // x
    return min(sdBox(p, vec2(r * 0.5, w * 0.5)), sdBox(p, vec2(w * 0.5, r * 0.5))); }
  if (k < 4.5) { vec2 p = rot2(0.785398) * q; float ww = w * 0.8;                     // asterisk
    float a = min(sdBox(q, vec2(r * 0.46, ww * 0.5)), sdBox(q, vec2(ww * 0.5, r * 0.46)));
    return min(a, min(sdBox(p, vec2(r * 0.4, ww * 0.5)), sdBox(p, vec2(ww * 0.5, r * 0.4)))); }
  if (k < 5.5) return sdBox(q, vec2(r * 0.38));                                       // filled square
  if (k < 6.5) return sdBox(q, vec2(0.5 + 0.01));                                     // solid cell
  return 1e3;                                                                          // empty
}

// pick a glyph for a region + seed; the smoothed bands weight the choice
float glyphPick(float region, float seed) {
  float t = hash21(vec2(region * 1.37 + 0.31, seed * 0.713 + 4.1));
  float t2 = hash21(vec2(region * 2.11 + 9.7, seed * 1.31 + 0.7));
  float solid = 0.03 + 0.12 * u_sEn * u_blocks;
  float empty = 0.012 * u_blocks;
  if (t2 < solid) return 6.0;
  if (t2 < solid + empty) return 7.0;
  float w0 = 0.12 + u_sBass * 1.2;   // dot
  float w1 = 0.12 + u_sLow * 1.1;    // ring
  float w2 = 0.12 + u_sMid * 1.2;    // plus
  float w3 = 0.12 + u_sHiMid * 1.4;  // x
  float w4 = 0.10 + u_sAir * 1.8;    // asterisk
  float w5 = 0.08 + u_sSub * 1.0;    // square
  float tot = w0 + w1 + w2 + w3 + w4 + w5;
  t *= tot;
  if (t < w0) return 0.0; t -= w0;
  if (t < w1) return 1.0; t -= w1;
  if (t < w2) return 2.0; t -= w2;
  if (t < w3) return 3.0; t -= w3;
  if (t < w4) return 4.0;
  return 5.0;
}

// blobby regions: value noise sampled at cell centres, so outlines follow the grid
float regionAt(vec2 cell, float gen) {
  vec2 rp = (cell + 0.5) / max(u_patch, 1.0);
  float n = vnoise(rp + vec2(gen * 7.13, gen * 3.71));
  float n2 = vnoise(rp * 0.45 + vec2(40.0 + gen * 1.9, 11.0));
  return floor(n * 7.0) + 7.0 * floor(n2 * 4.0) + gen * 41.0;
}

// the last kick (at or before kc) on which this region flipped, and the one before it
vec2 flipSeeds(float region, float kc) {
  float last = -1.0;
  float prev = -1.0;
  for (int k = 0; k < 10; k++) {
    float j = kc - float(k);
    if (hash21(vec2(region * 0.917 + 3.3, j * 1.13 + 0.5)) < u_flip) {
      if (last < 0.0) last = j; else { prev = j; break; }
    }
  }
  if (last < 0.0) last = kc - 10.0;
  if (prev < 0.0) prev = last - 10.0;
  return vec2(last, prev);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float pxs = max(1.0, uResolution.y / 1080.0);
  float cs = max(4.0, u_cell * pxs);
  vec2 g = fc / cs;
  vec2 cid = floor(g);
  vec2 q = fract(g) - 0.5;
  float kc = u_kc;
  float gen = floor(kc / 16.0);

  // big glyphs: some regions print one glyph across a 2x2 block
  vec2 bid = floor(g * 0.5);
  float bigRegion = regionAt(bid * 2.0, gen);
  float big = step(hash21(vec2(bigRegion, gen + 0.3)), u_big * 0.35) * step(0.5, mod(bigRegion, 3.0));
  if (big > 0.5) { cid = bid * 2.0; q = fract(g * 0.5) - 0.5; }

  float region = regionAt(cid, gen);
  vec2 seeds = flipSeeds(region, kc);
  bool fresh = seeds.x == kc || mod(kc, 16.0) == 0.0;

  // card flip on the kick that changed this patch: squeeze sideways, swap at the midpoint
  float delay = hash21(cid + 7.7) * 0.07;
  float fl = fresh ? clamp((u_sk - delay) / 0.17, 0.0, 1.0) : 1.0;
  float glyph = fl < 0.5 ? glyphPick(region, seeds.y) : glyphPick(region, seeds.x);
  float squeeze = max(abs(cos(fl * PI)), 0.06);
  vec2 qq = q;
  if (mod(region, 2.0) < 0.5) qq.x /= squeeze; else qq.y /= squeeze;

  // size follows the spectrum by column + a kick pulse on freshly flipped patches
  float cols = uResolution.x / cs;
  float sp = spectrum(clamp(cid.x / max(cols, 1.0), 0.0, 1.0) * 0.8 + 0.02);
  float pop = fresh ? exp(-u_sk * 7.0) : 0.0;
  float r = clamp(u_density * (0.72 + 0.5 * sp + 0.2 * uKick) + pop * 0.35, 0.08, 1.15);
  float w = u_weight * (0.8 + 0.4 * sp);
  float d = glyphSd(glyph, qq, r, w);
  float aa = 0.75 / (cs * (big > 0.5 ? 2.0 : 1.0));
  float ink = 1.0 - smoothstep(-aa, aa, d);

  // negatives: snares knock random patches to negative for a moment; drops dissolve the field
  float snap = step(hash21(vec2(region * 1.7, u_sc + 2.0)), 0.14 * u_snap) * step(u_ss, 0.14);
  float cellInv = step(hash21(cid * 0.37 + 1.3), u_inv);
  float neg = abs(cellInv - snap);
  neg = abs(neg - u_invert);
  ink = mix(ink, 1.0 - ink, neg);

  vec3 paper = uBg;
  vec3 col = mix(paper, uAccent, ink);
  // printed: faint grain, and ink a touch uneven
  col += hmGrain(fc, uTime) * 0.035;
  col = mix(col, col * (0.94 + 0.06 * vnoise(fc / (14.0 * pxs))), ink);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const smooth = (pick: (a: import('../../core/types').AudioFrame) => number, rate = 3): ClockDef => ({
  step: (v, f) => v + (pick(f.audio) - v) * (1 - Math.exp(-f.dt * rate)),
});

export const glyphMosaic = defineClockedShaderScene(
  {
    id: 'glyph-mosaic',
    name: 'Glyph Mosaic',
    description:
      'A printed grid of dots, rings, crosses and asterisks in one ink. Blocky patches flip to new glyphs on every kick, the bands choose which glyphs appear, snares knock patches negative and drops dissolve the whole field to its inverse.',
    category: 'field',
    style: 'print',
    fragment,
    light: true,
    tags: ['graphic', 'minimal', 'rhythmic', 'playful', 'techno', 'house', 'bouncy', 'clean'],
    params: [
      { id: 'cell', label: 'Cell size', group: 'Shape', type: 'number', min: 8, max: 60, step: 1, default: 22 },
      { id: 'patch', label: 'Patch size', group: 'Shape', type: 'number', min: 1, max: 12, step: 0.5, default: 4.5, hint: 'Size of the blobs that flip together' },
      { id: 'density', label: 'Glyph size', group: 'Shape', type: 'number', min: 0.2, max: 1, step: 0.01, default: 0.7 },
      { id: 'weight', label: 'Stroke', group: 'Shape', type: 'number', min: 0.04, max: 0.3, step: 0.005, default: 0.13 },
      { id: 'big', label: 'Big glyphs', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4, hint: 'Patches printed at double size' },
      { id: 'flip', label: 'Flip on kick', group: 'Reactivity', type: 'number', min: 0.05, max: 1, step: 0.01, default: 0.32, hint: 'Share of patches that flip on each kick' },
      { id: 'blocks', label: 'Solid blocks', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'snap', label: 'Snare negatives', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
      { id: 'invert', label: 'Start inverted', group: 'Color', type: 'bool', default: false, hint: 'Paper ink on an ink field' },
    ],
    modulations: [{ source: 'energy', param: 'density', amount: 0.12 }],
  },
  {
    kc: kickCountClock,
    sk: sinceKickClock,
    sc: { step: (v, f) => (f.audio.snareHit ? (v + 1) % 997 : v) },
    ss: { init: 100, step: (v, f) => (f.audio.snareHit ? 0 : Math.min(v + f.dt, 100)) },
    // each drop dissolves the field to its inverse (and the next one back)
    inv: {
      step: (v, f, _s, mem) => {
        const d = f.audio.drop;
        if (d > 0.6 && (mem.dropPrev ?? 0) <= 0.6) mem.target = (mem.target ?? 0) > 0.5 ? 0 : 1;
        mem.dropPrev = d;
        const t = mem.target ?? 0;
        const step = f.dt / 0.45;
        return t > v ? Math.min(t, v + step) : Math.max(t, v - step);
      },
    },
    sBass: smooth((a) => a.bass),
    sSub: smooth((a) => a.sub),
    sLow: smooth((a) => a.lowMid),
    sMid: smooth((a) => a.mid),
    sHiMid: smooth((a) => a.highMid),
    sAir: smooth((a) => a.air),
    sEn: smooth((a) => a.energy, 1),
  },
);
