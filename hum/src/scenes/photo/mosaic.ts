import type { ClockDef } from '../shader/lib';
import { defineClockedShaderScene, kickCountClock, sinceKickClock } from '../shader/lib';
import { PHOTO_GLSL } from './common';

/** Age of the kick before the latest one (declared before `sk`, so it reads sk's old value). */
const prevKickClock: ClockDef = {
  init: 100,
  step: (v, f, s) => (f.audio.kickHit ? Math.min((s.sk ?? 100) + f.dt, 100) : Math.min(v + f.dt, 100)),
};

const fragment = /* glsl */ `
${PHOTO_GLSL}

vec2 kickOrigin(float k) {
  return (vec2(hash11(k * 1.37 + 0.11), hash11(k * 2.71 + 0.73)) - 0.5) * vec2(uAspect * 0.7, 0.7);
}
// a ring travelling out of the kick's impact point (aspect space); returns envelope, dir in d
float kickRing(vec2 b, float age, float k, out vec2 d) {
  vec2 dv = b - kickOrigin(k);
  float l = length(dv) + 1e-4;
  d = dv / l;
  float x = (l - age * 1.5) / 0.1;
  return exp(-x * x) * exp(-age * 2.6) * step(age, 3.0);
}

void main() {
  float cycle = floor(uPhotoIndex);
  float tt = smoothstep(0.6, 0.95, fract(uPhotoIndex));
  float tens = smoothstep(0.08, 1.0, uBuild * u_tension);
  float boom = uDrop * u_shatter;

  // cell count: bass grows the cells, build-ups coarsen them more and more, drop shatters them
  float cells = u_cells * (1.0 - u_breathe * (0.32 * uBass + 0.12 * uSub)) * (1.0 + 0.04 * uSway);
  cells *= 1.0 - tens * 0.6;
  cells *= 1.0 + boom * 4.0;
  cells = max(cells, 2.0);

  float ang = uSway * 0.03 * u_drift;
  vec2 base = (vUv - 0.5) * vec2(uAspect, 1.0);

  // drop: the shards fly outward and twist, then settle back as the drop decays
  float rb = length(base);
  base = rot2(boom * 0.55 * (0.7 - rb)) * base;
  base -= base / max(rb, 1e-3) * boom * 0.12 * (0.6 + 0.4 * snoise(base * 3.0 + uTime * 0.2));

  // kick shockwaves (the latest kick and the one before it) push the tiles outward
  vec2 d0, d1;
  float e0 = kickRing(base, u_sk, u_kc, d0);
  float e1 = kickRing(base, u_pk, u_kc - 1.0, d1);
  base -= (d0 * e0 + d1 * e1) * 0.035 * u_shock;

  vec2 p = rot2(ang) * base * cells;
  vec2 ip = floor(p);
  vec2 fp = fract(p);

  float dd1 = 8.0;
  float dd2 = 8.0;
  vec2 bestId = vec2(0.0);
  vec2 bestPt = vec2(0.0);
  float jit = clamp(u_jitter, 0.0, 1.0) * 0.8;
  float tq = floor(uTime * 20.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 id = ip + g;
      vec2 h = hash22(id);
      vec2 o = 0.5 + (h - 0.5) * jit
        + 0.18 * u_drift * vec2(sin(uTime * 0.37 + h.x * TAU), cos(uTime * 0.29 + h.y * TAU))
        + (hash22(id + tq) - 0.5) * 0.22 * tens * tens; // build tremble
      vec2 rr = g + o - fp;
      float d = dot(rr, rr);
      if (d < dd1) { dd2 = dd1; dd1 = d; bestId = id; bestPt = id + o; }
      else if (d < dd2) { dd2 = d; }
    }
  }

  // the cell as a unit: how hard the shockwave is hitting it right now
  vec2 cc = rot2(-ang) * (bestPt / cells);
  vec2 cd0, cd1;
  float hit = (kickRing(cc, u_sk, u_kc, cd0) + kickRing(cc, u_pk, u_kc - 1.0, cd1)) * u_shock;

  // sample the photo once at the cell's seed point → flat posterized tile (hit tiles slide)
  vec2 cuv = cc / vec2(uAspect, 1.0) + 0.5;
  cuv -= (cd0 + cd1) * 0.5 * hit * 0.04 / vec2(uAspect, 1.0);
  float sw = step(hash21(bestId + cycle * 13.7), tt * 1.05 - 0.0001);
  vec3 src = mix(photo1(cuv), photo2(cuv), sw);
  float l = luma(src);
  l = clamp((l - 0.5) * (1.12 + uKick * 0.5) + 0.5 + (hash21(bestId + 4.2) - 0.5) * 0.05, 0.0, 1.0);
  float lv = max(u_levels, 2.0);
  float pl = floor(min(l, 0.999) * lv) / (lv - 1.0);

  vec3 col;
  if (u_style < 0.5) col = duoTone(pl);
  else if (u_style < 1.5) col = triTone(pl);
  else col = floor(min(src, vec3(0.999)) * lv) / (lv - 1.0);

  // spectrum bars: tiles under the live spectrum (lows on the left) turn back into the real,
  // posterized photo colours — an equalizer drawn in tiles, rising from the bottom
  float sp = spectrum(0.03 + clamp(cuv.x, 0.0, 1.0) * 0.8);
  float bar = step(clamp(cuv.y, 0.0, 1.0) + 0.02, sp * u_specBars * 1.3) * step(0.001, u_specBars);
  vec3 barCol = u_style < 1.5 ? floor(min(src, vec3(0.999)) * lv) / (lv - 1.0) : duoTone(pl);
  col = mix(col, barCol, bar * 0.9);

  // hats flip random cells back to the real photo
  float q = floor(uTime * 6.0);
  float flip = step(hash21(bestId * 0.73 + q), uHat * u_flip * 0.6 + uDrop * 0.25 * u_flip);
  vec3 real = mix(photo1(vUv), photo2(vUv), sw);
  col = mix(col, real, flip);

  // grout lines between cells; shockwave-hit tiles shrink into islands, drop shards scatter
  float e = sqrt(dd2) - sqrt(dd1);
  float pxc = cells / uResolution.y;
  float lw = u_edges * 0.07 * (1.0 + uKick * 1.2);
  float gap = hit * 0.5 + tens * 0.1 + boom * (0.15 + 0.35 * hash21(bestId + 9.1));
  float wGrout = lw + gap;
  float edge = (1.0 - smoothstep(wGrout, wGrout + pxc * 1.5, e)) * step(0.001, u_edges + gap);
  float lost = step(hash21(bestId + 17.3), boom * 0.3);
  col = mix(col, uBg, max(edge * 0.9, lost));

  gl_FragColor = vec4(col, 1.0);
}
`;

export const photoMosaic = defineClockedShaderScene(
  {
    id: 'photo-mosaic',
    name: 'Cell Mosaic',
    description:
      'The photo as a posterized voronoi mosaic in a palette duotone (ultramarine on paper by default), with paper grout between cells. Every kick sends a shockwave out of an impact point that shoves the tiles and cracks them apart into islands; the live spectrum rises from the bottom as an equalizer of real-colour tiles; build-ups coarsen and rattle the cells; a drop explodes everything into twisting shards that settle back. Bass makes the cells breathe, hats flip random cells to the real photo. New photos arrive cell by cell.',
    category: 'photo',
    usesPhotos: true,
    fragment,
    light: true,
    tags: ['editorial', 'graphic', 'minimal', 'playful', 'rhythmic', 'clean'],
    params: [
      { id: 'cells', label: 'Cells', type: 'number', min: 8, max: 140, step: 1, default: 46, group: 'Shape' },
      { id: 'breathe', label: 'Bass breathe', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, group: 'Motion' },
      { id: 'shatter', label: 'Drop shatter', type: 'number', min: 0, max: 1, step: 0.01, default: 0.75, group: 'Motion' },
      { id: 'levels', label: 'Tone levels', type: 'number', min: 2, max: 8, step: 1, default: 4, group: 'Color' },
      {
        id: 'style',
        label: 'Tone style',
        type: 'select',
        options: [
          { value: 'duotone', label: 'Duotone' },
          { value: 'tritone', label: 'Tritone' },
          { value: 'poster', label: 'Posterized photo' },
        ],
        default: 'duotone',
        group: 'Color',
      },
      { id: 'edges', label: 'Grout', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3, group: 'Shape' },
      { id: 'flip', label: 'Hat flips', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, group: 'Motion' },
      { id: 'jitter', label: 'Irregularity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.85, group: 'Shape' },
      { id: 'drift', label: 'Idle drift', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4, group: 'Motion' },
      { id: 'shock', label: 'Kick shockwave', type: 'number', min: 0, max: 1, step: 0.01, default: 0.75, group: 'Reactivity', hint: 'Kicks shove the tiles and crack them apart in a travelling ring' },
      { id: 'specBars', label: 'Spectrum bars', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45, group: 'Reactivity', hint: 'Tiles under the spectrum turn back into the real photo' },
      { id: 'tension', label: 'Build tension', type: 'number', min: 0, max: 1, step: 0.01, default: 0.65, group: 'Reactivity', hint: 'Build-ups coarsen and rattle the cells' },
    ],
    modulations: [{ source: 'mid', param: 'drift', amount: 0.3 }],
  },
  {
    pk: prevKickClock,
    sk: sinceKickClock,
    kc: kickCountClock,
  },
);
