import type { EffectDef } from '../../core/types';
import { GLSL_INK_DIR, GLSL_TRIGGER, pBool, pNum, pReactive, pSelect, pTrigger } from './shared';

/* ───────────────────────── gradient-map ───────────────────────── */

const gradientMap: EffectDef = {
  id: 'gradient-map',
  name: 'Gradient map',
  description: 'Maps luminance onto the palette ramp (bg → accent → accent 2 → fg).',
  category: 'color',
  params: [
    pNum('mix', 'Mix', 0, 1, 1, 0.01),
    pNum('contrast', 'Contrast', 0.5, 2.5, 1, 0.01),
    pNum('offset', 'Offset', -0.5, 0.5, 0, 0.01),
    pBool('invert', 'Invert', false),
    pReactive(0.4),
  ],
  fragment: /* glsl */ `
${GLSL_INK_DIR}
void main() {
  vec3 src = texture2D(tInput, vUv).rgb;
  float l = clamp((luma(src) - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  float t = mix(l, 1.0 - l, fx_inkDir());
  if (u_invert > 0.5) t = 1.0 - t;
  t = clamp(t + u_offset + u_reactive * (uKick * 0.12 + uDrop * 0.1), 0.0, 1.0);
  gl_FragColor = vec4(mix(src, paletteRamp(t), u_mix), 1.0);
}
`,
};

/* ───────────────────────── posterize ───────────────────────── */

const posterize: EffectDef = {
  id: 'posterize',
  name: 'Posterize',
  description: 'Quantizes colour into flat bands, per channel or by luminance.',
  category: 'color',
  params: [
    pNum('levels', 'Levels', 2, 16, 5, 1),
    pNum('gamma', 'Gamma', 0.4, 2.5, 1, 0.01),
    pSelect(
      'mode',
      'Mode',
      [
        ['rgb', 'Per channel'],
        ['luma', 'Luminance'],
      ],
      'rgb',
    ),
    pReactive(0.3),
  ],
  fragment: /* glsl */ `
void main() {
  vec3 c = clamp(texture2D(tInput, vUv).rgb, 0.0, 1.0);
  float g = max(u_gamma, 0.01);
  float lv = max(2.0, floor(u_levels - u_reactive * uKick * (u_levels - 2.0) * 0.6 + 0.5));
  float n = lv - 1.0;
  vec3 outc;
  if (u_mode < 0.5) {
    vec3 cg = pow(c, vec3(g));
    cg = floor(cg * n + 0.5) / n;
    outc = pow(clamp(cg, 0.0, 1.0), vec3(1.0 / g));
  } else {
    float l = luma(c);
    float lg = pow(l, g);
    float lq = pow(clamp(floor(lg * n + 0.5) / n, 0.0, 1.0), 1.0 / g);
    outc = clamp(c * (lq / max(l, 0.002)), 0.0, 1.0);
  }
  gl_FragColor = vec4(outc, 1.0);
}
`,
};

/* ───────────────────────── grade ───────────────────────── */

const grade: EffectDef = {
  id: 'grade',
  name: 'Colour grade',
  description: 'Exposure, contrast, saturation, hue and temperature. Brightness of the music warms/cools it.',
  category: 'color',
  params: [
    pNum('exposure', 'Exposure', -2, 2, 0, 0.01),
    pNum('contrast', 'Contrast', 0.5, 2, 1, 0.01),
    pNum('saturation', 'Saturation', 0, 2, 1, 0.01),
    pNum('hue', 'Hue shift', -180, 180, 0, 1),
    pNum('temperature', 'Temperature', -1, 1, 0, 0.01),
    pReactive(0.3),
  ],
  fragment: /* glsl */ `
void main() {
  vec3 c = texture2D(tInput, vUv).rgb;
  float ex = u_exposure + u_reactive * (uKick * 0.3 + uDrop * 0.3);
  c *= exp2(ex);
  float temp = u_temperature + u_reactive * (uBrightness - 0.5) * 0.6;
  c *= vec3(1.0 + 0.12 * temp, 1.0 + 0.02 * temp, 1.0 - 0.12 * temp);
  c = (c - 0.5) * u_contrast + 0.5;
  float l = luma(c);
  c = mix(vec3(l), c, u_saturation);
  float h = radians(u_hue);
  float ch = cos(h);
  float sh = sin(h);
  vec3 k = vec3(0.57735027);
  c = c * ch + cross(k, c) * sh + k * dot(k, c) * (1.0 - ch);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`,
};

/* ───────────────────────── flash ───────────────────────── */

const flash: EffectDef = {
  id: 'flash',
  name: 'Flash',
  description: 'Strobe on the hits — invert, white or accent flash, triggered by kick, snare, beat or drop.',
  category: 'color',
  params: [
    pSelect(
      'mode',
      'Mode',
      [
        ['invert', 'Invert'],
        ['white', 'White'],
        ['accent', 'Accent'],
      ],
      'white',
    ),
    pTrigger('kick'),
    pNum('amount', 'Amount', 0, 1, 0.5, 0.01),
    pNum('sharpness', 'Sharpness', 1, 8, 2.5, 0.1, { hint: 'Higher = shorter, snappier flashes' }),
  ],
  fragment: /* glsl */ `
${GLSL_TRIGGER}
void main() {
  vec3 c = texture2D(tInput, vUv).rgb;
  float e = pow(clamp(fx_trigger(u_trigger), 0.0, 1.0), u_sharpness);
  vec3 outc;
  if (u_mode < 0.5) {
    float edge0 = 1.0 - u_amount;
    float k = smoothstep(edge0, edge0 + 0.12, e) * step(0.001, u_amount);
    outc = mix(c, 1.0 - c, k);
  } else if (u_mode < 1.5) {
    outc = mix(c, vec3(1.0), e * u_amount);
  } else {
    outc = mix(c, uAccent, e * u_amount);
  }
  gl_FragColor = vec4(outc, 1.0);
}
`,
};

export const colorEffects: EffectDef[] = [gradientMap, posterize, grade, flash];
