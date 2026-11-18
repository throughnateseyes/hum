import type { EffectDef } from '../../core/types';
import { GLSL_INK_DIR, pBool, pNum, pReactive, pSelect } from './shared';

/* ───────────────────────── dither ───────────────────────── */

const dither: EffectDef = {
  id: 'dither',
  name: 'Dither',
  description: 'Ordered / noise dithering into the palette — the signature 1-bit look.',
  category: 'texture',
  params: [
    pSelect(
      'mode',
      'Pattern',
      [
        ['bayer', 'Bayer 8×8'],
        ['ign', 'Gradient noise'],
        ['blue', 'Blue-ish (R2)'],
        ['white', 'White noise'],
      ],
      'bayer',
    ),
    pSelect(
      'colorMode',
      'Colour',
      [
        ['duo', 'Palette 2-tone'],
        ['quad', 'Palette 4-tone'],
        ['source', 'Source quantized'],
      ],
      'duo',
    ),
    pNum('pixelSize', 'Pixel size', 1, 12, 2, 1),
    pNum('levels', 'Levels', 2, 8, 2, 1, { hint: 'Tones per channel (2-tone / source modes)' }),
    pNum('contrast', 'Contrast', 0.5, 2.5, 1.2, 0.01),
    pReactive(0.5),
  ],
  fragment: /* glsl */ `
${GLSL_INK_DIR}
float dt_ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float dt_r2(vec2 p) { return fract(dot(p, vec2(0.75487766624669, 0.56984029099805)) + 0.5); }

void main() {
  float px = max(1.0, floor(u_pixelSize * (1.0 + u_reactive * uDrop) + 0.5));
  vec2 cell = floor(gl_FragCoord.xy / px);
  vec2 suv = clamp((cell + 0.5) * px / uResolution, 0.0, 1.0);
  vec3 src = texture2D(tInput, suv).rgb;

  float thr;
  if (u_mode < 0.5) thr = bayer8(cell);
  else if (u_mode < 1.5) thr = dt_ign(cell);
  else if (u_mode < 2.5) thr = dt_r2(cell);
  else thr = hash21(cell + 0.37);

  float con = u_contrast * (1.0 + u_reactive * 0.35 * uKick);
  float bias = u_reactive * 0.06 * uKick;
  vec3 c = clamp((src - 0.5) * con + 0.5, 0.0, 1.0);

  vec3 outc;
  if (u_colorMode < 1.5) {
    float l = luma(c);
    float t = clamp(mix(l, 1.0 - l, fx_inkDir()) + bias, 0.0, 1.0);
    if (u_colorMode < 0.5) {
      float n = max(floor(u_levels + 0.5) - 1.0, 1.0);
      float q = clamp(floor(t * n + thr) / n, 0.0, 1.0);
      outc = mix(uBg, uFg, q);
    } else {
      float q = clamp(floor(t * 3.0 + thr), 0.0, 3.0);
      outc = q < 0.5 ? uBg : (q < 1.5 ? uMuted : (q < 2.5 ? uAccent : uFg));
    }
  } else {
    float n = max(floor(u_levels + 0.5) - 1.0, 1.0);
    outc = clamp(floor((c + bias) * n + thr) / n, 0.0, 1.0);
  }
  gl_FragColor = vec4(outc, 1.0);
}
`,
};

/* ───────────────────────── halftone ───────────────────────── */

const halftone: EffectDef = {
  id: 'halftone',
  name: 'Halftone',
  description: 'Rotated dot screen — mono ink, CMYK-ish, or palette duotone on paper. Kicks swell the dots.',
  category: 'texture',
  params: [
    pSelect(
      'mode',
      'Ink',
      [
        ['mono', 'Mono'],
        ['cmyk', 'CMYK-ish'],
        ['palette', 'Palette duotone'],
      ],
      'mono',
    ),
    pNum('size', 'Cell size', 3, 40, 9, 0.5),
    pNum('angle', 'Angle', 0, 90, 45, 1),
    pNum('softness', 'Softness', 0, 1, 0.2, 0.01),
    pNum('contrast', 'Contrast', 0.5, 2.5, 1.1, 0.01),
    pReactive(0.6),
  ],
  fragment: /* glsl */ `
${GLSL_INK_DIR}
vec3 ht_sample(vec2 fc, float cell, float ang, out vec2 f) {
  vec2 p = rot2(ang) * fc / cell;
  vec2 id = floor(p);
  f = p - id - 0.5;
  vec2 centre = rot2(-ang) * ((id + 0.5) * cell);
  vec3 s = texture2D(tInput, clamp(centre / uResolution, 0.0, 1.0)).rgb;
  return clamp((s - 0.5) * u_contrast + 0.5, 0.0, 1.0);
}

float ht_dot(vec2 f, float cov, float cell) {
  cov = clamp(cov, 0.0, 1.0);
  float e = u_softness * 0.3 + 1.0 / cell;
  float r = sqrt(cov) * (0.7071 + e);
  float d = length(f);
  return (1.0 - smoothstep(r - e, r + e, d)) * smoothstep(0.0, 0.06, cov);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float cell = max(2.0, u_size);
  float ang = radians(u_angle);
  float swell = u_reactive * (uKick * 0.35 + uDrop * 0.25);
  vec2 f;
  vec3 col;

  if (u_mode < 0.5) {
    vec3 s = ht_sample(fc, cell, ang, f);
    float l = luma(s);
    float t = mix(l, 1.0 - l, fx_inkDir());
    float cov = t * (1.0 + swell) + swell * 0.08;
    col = mix(uBg, uFg, ht_dot(f, cov, cell));
  } else if (u_mode < 1.5) {
    vec3 paper = luma(uBg) > 0.5 ? uBg : vec3(0.95, 0.94, 0.9);
    col = paper;
    vec3 s;
    float k;
    // cyan 15°
    s = ht_sample(fc, cell, ang - 0.5236, f);
    k = 1.0 - max(s.r, max(s.g, s.b));
    float cc = (1.0 - s.r - k) / max(1.0 - k, 0.001);
    col *= mix(vec3(1.0), vec3(0.0, 0.68, 0.94), ht_dot(f, cc * (1.0 + swell), cell));
    // magenta 75°
    s = ht_sample(fc, cell, ang + 0.5236, f);
    k = 1.0 - max(s.r, max(s.g, s.b));
    float mm = (1.0 - s.g - k) / max(1.0 - k, 0.001);
    col *= mix(vec3(1.0), vec3(0.93, 0.05, 0.55), ht_dot(f, mm * (1.0 + swell), cell));
    // yellow 0°
    s = ht_sample(fc, cell, ang - 0.7854, f);
    k = 1.0 - max(s.r, max(s.g, s.b));
    float yy = (1.0 - s.b - k) / max(1.0 - k, 0.001);
    col *= mix(vec3(1.0), vec3(1.0, 0.92, 0.0), ht_dot(f, yy * (1.0 + swell), cell));
    // black 45°
    s = ht_sample(fc, cell, ang, f);
    k = 1.0 - max(s.r, max(s.g, s.b));
    col *= mix(vec3(1.0), vec3(0.1, 0.1, 0.12), ht_dot(f, k * (1.0 + swell), cell));
  } else {
    col = uBg;
    vec3 s = ht_sample(fc, cell, ang + 0.5236, f);
    float l = luma(s);
    float t = mix(l, 1.0 - l, fx_inkDir());
    col = mix(col, uAccent, ht_dot(f, smoothstep(0.05, 0.85, t) * (1.0 + swell), cell));
    s = ht_sample(fc, cell, ang, f);
    l = luma(s);
    t = mix(l, 1.0 - l, fx_inkDir());
    col = mix(col, uFg, ht_dot(f, smoothstep(0.45, 1.0, t) * (1.0 + swell), cell));
  }
  gl_FragColor = vec4(col, 1.0);
}
`,
};

/* ───────────────────────── ascii ───────────────────────── */

/** 5×7 bitmaps, top row first. Sorted by ink density at module load. */
const GLYPHS: string[][] = [
  ['.....', '.....', '.....', '.....', '.....', '.....', '.....'], // ' '
  ['.....', '.....', '.....', '.....', '.....', '..#..', '.....'], // .
  ['.....', '..#..', '.....', '.....', '.....', '..#..', '.....'], // :
  ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'], // -
  ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'], // +
  ['.....', '.....', '#####', '.....', '#####', '.....', '.....'], // =
  ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'], // &
  ['.....', '#.#.#', '.###.', '#####', '.###.', '#.#.#', '.....'], // *
  ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'], // #
  ['.###.', '#...#', '#.###', '#.#.#', '#.###', '#....', '.####'], // @
];

function rowBits(row: string): number {
  let v = 0;
  for (let i = 0; i < 5; i++) v = v * 2 + (row[i] === '#' ? 1 : 0);
  return v;
}
function packGlyph(rows: string[]): [number, number] {
  const r = rows.map(rowBits);
  const a = ((r[0] * 32 + r[1]) * 32 + r[2]) * 32 + r[3];
  const b = (r[4] * 32 + r[5]) * 32 + r[6];
  return [a, b];
}
const inkCount = (rows: string[]) => rows.join('').split('').filter((ch) => ch === '#').length;
const SORTED = [...GLYPHS].sort((x, y) => inkCount(x) - inkCount(y)).map(packGlyph);
const GLYPH_N = SORTED.length;
const GLSL_GLYPHS =
  'vec2 as_glyph(float i) {\n' +
  SORTED.slice(0, -1)
    .map(([a, b], i) => `  if (i < ${i}.5) return vec2(${a}.0, ${b}.0);`)
    .join('\n') +
  `\n  return vec2(${SORTED[GLYPH_N - 1][0]}.0, ${SORTED[GLYPH_N - 1][1]}.0);\n}\n`;

const ascii: EffectDef = {
  id: 'ascii',
  name: 'ASCII',
  description: 'Rebuilds the image from a tiny procedural 5×7 glyph font.',
  category: 'texture',
  params: [
    pNum('scale', 'Glyph scale', 1, 6, 2, 0.5, { hint: 'Pixels per glyph dot (cell = 6×8 dots)' }),
    pSelect(
      'colorMode',
      'Colour',
      [
        ['palette', 'Palette'],
        ['source', 'Source'],
        ['accent', 'Accent'],
      ],
      'palette',
    ),
    pBool('invert', 'Invert', false),
    pNum('contrast', 'Contrast', 0.5, 2.5, 1.2, 0.01),
    pReactive(0.5),
  ],
  fragment: /* glsl */ `
${GLSL_INK_DIR}
${GLSL_GLYPHS}
float as_bit(vec2 g, float col, float row) {
  float rv;
  if (row < 3.5) rv = mod(floor((g.x + 0.5) / exp2(5.0 * (3.0 - row))), 32.0);
  else rv = mod(floor((g.y + 0.5) / exp2(5.0 * (6.0 - row))), 32.0);
  return mod(floor((rv + 0.5) / exp2(4.0 - col)), 2.0);
}

void main() {
  float unit = max(1.0, u_scale);
  vec2 cell = vec2(6.0, 8.0) * unit;
  vec2 id = floor(gl_FragCoord.xy / cell);
  vec2 local = gl_FragCoord.xy - id * cell;
  vec2 g = floor(local / unit);
  float col = g.x;
  float row = 7.0 - g.y;

  vec3 src = texture2D(tInput, clamp((id + 0.5) * cell / uResolution, 0.0, 1.0)).rgb;
  float l = clamp((luma(src) - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  float t = mix(l, 1.0 - l, fx_inkDir());
  if (u_invert > 0.5) t = 1.0 - t;
  t = clamp(t * (1.0 + u_reactive * 0.3 * uKick) + u_reactive * 0.05 * uKick, 0.0, 1.0);

  float n = ${GLYPH_N}.0;
  float gi = min(floor(t * n), n - 1.0);
  float sparkle = step(hash21(id + floor(uTime * 12.0) * 0.731), u_reactive * uHat * 0.12);
  gi = min(gi + sparkle * 2.0, n - 1.0);

  float on = 0.0;
  if (col < 4.5 && row < 6.5 && row > -0.5) on = as_bit(as_glyph(gi), col, row);

  vec3 ink = u_colorMode < 0.5 ? uFg : (u_colorMode < 1.5 ? clamp(src * 1.2, 0.0, 1.0) : uAccent);
  gl_FragColor = vec4(mix(uBg, ink, on), 1.0);
}
`,
};

/* ───────────────────────── pixelate ───────────────────────── */

const pixelate: EffectDef = {
  id: 'pixelate',
  name: 'Pixelate',
  description: 'Chunky blocks, optionally crunching bigger on kicks and drops.',
  category: 'texture',
  params: [
    pNum('size', 'Block size', 1, 64, 8, 1),
    pNum('crunch', 'Audio crunch', 0, 1, 0.4, 0.01, { group: 'Audio', hint: 'Kicks and drops enlarge the blocks' }),
    pNum('gap', 'Grid gap', 0, 0.4, 0, 0.01, { hint: 'Hairline grid between blocks in the palette background' }),
  ],
  fragment: /* glsl */ `
void main() {
  float px = max(1.0, floor(u_size * (1.0 + u_crunch * (uKick * 1.2 + uDrop * 2.0)) + 0.5));
  vec2 cell = floor(gl_FragCoord.xy / px);
  vec2 uv = clamp((cell + 0.5) * px / uResolution, 0.0, 1.0);
  vec3 col = texture2D(tInput, uv).rgb;
  vec2 local = fract(gl_FragCoord.xy / px);
  float g = step(min(local.x, local.y), u_gap) * step(0.001, u_gap) * step(3.0, px);
  gl_FragColor = vec4(mix(col, uBg, g), 1.0);
}
`,
};

/* ───────────────────────── grain ───────────────────────── */

const grain: EffectDef = {
  id: 'grain',
  name: 'Film grain',
  description: 'Soft-light film grain, weighted to the midtones. Hats add sparkle.',
  category: 'texture',
  params: [
    pNum('amount', 'Amount', 0, 1, 0.18, 0.01),
    pNum('size', 'Size', 1, 4, 1.5, 0.1),
    pNum('chroma', 'Colour grain', 0, 1, 0, 0.01),
    pBool('animated', 'Animated', true),
    pReactive(0.4),
  ],
  fragment: /* glsl */ `
float gr_n(vec2 fc, float seed) {
  vec2 o = vec2(seed * 17.13, seed * 31.71);
  return vnoise(fc / max(u_size, 1.0) + o) * 0.65 + hash21(floor(fc) + o) * 0.35;
}

void main() {
  vec3 src = texture2D(tInput, vUv).rgb;
  vec2 fc = gl_FragCoord.xy;
  float seed = u_animated > 0.5 ? mod(floor(uTime * 24.0), 97.0) : 0.0;
  float n = gr_n(fc, seed) - 0.5;
  vec3 nc = vec3(n);
  if (u_chroma > 0.001) {
    vec3 cn = vec3(n, gr_n(fc, seed + 41.0) - 0.5, gr_n(fc, seed + 83.0) - 0.5);
    nc = mix(nc, cn, u_chroma);
  }
  float l = luma(src);
  float w = 0.35 + 2.6 * l * (1.0 - l);
  float amt = u_amount * (1.0 + u_reactive * (uHat * 0.8 + uAir * 0.4));
  gl_FragColor = vec4(clamp(src + nc * amt * w, 0.0, 1.0), 1.0);
}
`,
};

/* ───────────────────────── edge ───────────────────────── */

const edge: EffectDef = {
  id: 'edge',
  name: 'Ink edges',
  description: 'Sobel edge detection drawn as ink lines on paper or over the source.',
  category: 'texture',
  params: [
    pSelect(
      'mode',
      'Style',
      [
        ['ink', 'Ink on paper'],
        ['overlay', 'Over source'],
        ['accent', 'Accent on paper'],
      ],
      'ink',
    ),
    pNum('strength', 'Strength', 0.5, 4, 1.5, 0.01),
    pNum('threshold', 'Threshold', 0, 1, 0.15, 0.01),
    pNum('thickness', 'Thickness', 1, 4, 1, 0.1),
    pReactive(0.5),
  ],
  fragment: /* glsl */ `
float ed_l(vec2 uv) { return luma(texture2D(tInput, uv).rgb); }

void main() {
  float th = u_thickness * (1.0 + u_reactive * uKick * 0.8);
  vec2 o = th / uResolution;
  float tl = ed_l(vUv + vec2(-o.x, o.y));
  float tc = ed_l(vUv + vec2(0.0, o.y));
  float tr = ed_l(vUv + vec2(o.x, o.y));
  float ml = ed_l(vUv + vec2(-o.x, 0.0));
  float mr = ed_l(vUv + vec2(o.x, 0.0));
  float bl = ed_l(vUv + vec2(-o.x, -o.y));
  float bc = ed_l(vUv + vec2(0.0, -o.y));
  float br = ed_l(vUv + vec2(o.x, -o.y));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = tl + 2.0 * tc + tr - bl - 2.0 * bc - br;
  float e = length(vec2(gx, gy)) * u_strength * (1.0 + u_reactive * uSnare * 0.5);
  float ink = smoothstep(u_threshold, u_threshold + 0.25, e);
  vec3 src = texture2D(tInput, vUv).rgb;
  vec3 outc;
  if (u_mode < 0.5) outc = mix(uBg, uFg, ink);
  else if (u_mode < 1.5) outc = mix(src, uFg, ink);
  else outc = mix(uBg, uAccent, ink);
  gl_FragColor = vec4(outc, 1.0);
}
`,
};

export const textureEffects: EffectDef[] = [dither, halftone, ascii, pixelate, grain, edge];
