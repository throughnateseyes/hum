import { defineShaderScene } from '../../core/sceneHelpers';
import { PHOTO_GLSL } from './common';

const fragment = /* glsl */ `
${PHOTO_GLSL}

void main() {
  float cycle = floor(uPhotoIndex);
  float tt = smoothstep(0.6, 0.95, fract(uPhotoIndex));

  // cell count: bass grows the cells, drop shatters them into tiny shards
  float cells = u_cells * (1.0 - u_breathe * (0.32 * uBass + 0.12 * uSub)) * (1.0 + 0.04 * uSway);
  cells *= 1.0 + uDrop * u_shatter * 4.0;
  cells = max(cells, 2.0);

  float ang = uSway * 0.03 * u_drift;
  vec2 base = (vUv - 0.5) * vec2(uAspect, 1.0);
  vec2 p = rot2(ang) * base * cells;
  vec2 ip = floor(p);
  vec2 fp = fract(p);

  float d1 = 8.0;
  float d2 = 8.0;
  vec2 bestId = vec2(0.0);
  vec2 bestPt = vec2(0.0);
  float jit = clamp(u_jitter, 0.0, 1.0) * 0.8;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 id = ip + g;
      vec2 h = hash22(id);
      vec2 o = 0.5 + (h - 0.5) * jit
        + 0.18 * u_drift * vec2(sin(uTime * 0.37 + h.x * TAU), cos(uTime * 0.29 + h.y * TAU));
      vec2 rr = g + o - fp;
      float d = dot(rr, rr);
      if (d < d1) { d2 = d1; d1 = d; bestId = id; bestPt = id + o; }
      else if (d < d2) { d2 = d; }
    }
  }

  // sample the photo once at the cell's seed point → flat posterized tile
  vec2 cuv = rot2(-ang) * (bestPt / cells) / vec2(uAspect, 1.0) + 0.5;
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

  // hats flip random cells back to the real photo
  float q = floor(uTime * 6.0);
  float flip = step(hash21(bestId * 0.73 + q), uHat * u_flip * 0.6 + uDrop * 0.25 * u_flip);
  vec3 real = mix(photo1(vUv), photo2(vUv), sw);
  col = mix(col, real, flip);

  // grout lines between cells
  float e = sqrt(d2) - sqrt(d1);
  float pxc = cells / uResolution.y;
  float lw = u_edges * 0.07 * (1.0 + uKick * 1.2);
  float edge = (1.0 - smoothstep(lw, lw + pxc * 1.5, e)) * step(0.001, u_edges);
  col = mix(col, uBg, edge * 0.9);

  gl_FragColor = vec4(col, 1.0);
}
`;

export const photoMosaic = defineShaderScene({
  id: 'photo-mosaic',
  name: 'Cell Mosaic',
  description:
    'The photo as a posterized voronoi mosaic in a palette duotone (ultramarine on paper by default), with paper grout between cells. Bass makes the cells breathe bigger, kicks punch the contrast and thicken the grout, hats flip random cells back to the real photo, a drop shatters everything into tiny shards. New photos arrive cell by cell.',
  category: 'photo',
  usesPhotos: true,
  fragment,
  light: true,
  tags: ['editorial', 'graphic', 'minimal', 'playful', 'rhythmic', 'clean'],
  params: [
    { id: 'cells', label: 'Cells', type: 'number', min: 8, max: 140, step: 1, default: 46, group: 'Shape' },
    { id: 'breathe', label: 'Bass breathe', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, group: 'Motion' },
    { id: 'shatter', label: 'Drop shatter', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, group: 'Motion' },
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
  ],
  modulations: [
    { source: 'mid', param: 'drift', amount: 0.3 },
    { source: 'build', param: 'cells', amount: 0.2 },
  ],
});
