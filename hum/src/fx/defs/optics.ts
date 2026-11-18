import type { EffectDef } from '../../core/types';
import { pNum, pReactive, pSelect } from './shared';

/* ───────────────────────── chroma ───────────────────────── */

const chroma: EffectDef = {
  id: 'chroma',
  name: 'Chromatic aberration',
  description: 'Spectral RGB fringing, radial or linear, kicked wider by the hits.',
  category: 'optics',
  params: [
    pSelect(
      'mode',
      'Mode',
      [
        ['radial', 'Radial'],
        ['linear', 'Linear'],
      ],
      'radial',
    ),
    pNum('amount', 'Amount', 0, 1, 0.25, 0.01),
    pNum('angle', 'Angle (linear)', 0, 360, 0, 1),
    pReactive(0.6),
  ],
  fragment: /* glsl */ `
void main() {
  float amt = u_amount * (1.0 + u_reactive * (uKick * 2.0 + uDrop * 2.5));
  vec2 off;
  if (u_mode < 0.5) {
    off = (vUv - 0.5) * amt * 0.045;
  } else {
    float a = radians(u_angle);
    off = vec2(cos(a) / uAspect, sin(a)) * amt * 0.012;
  }
  vec3 acc = vec3(0.0);
  vec3 wsum = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    float t = float(i) / 8.0;
    vec3 w = max(1.0 - abs(t * 2.0 - vec3(0.0, 1.0, 2.0)), 0.0) + 0.02;
    vec3 c = texture2D(tInput, clamp(vUv + off * (t * 2.0 - 1.0), 0.0, 1.0)).rgb;
    acc += c * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}
`,
};

/* ───────────────────────── bloom ───────────────────────── */

const bloom: EffectDef = {
  id: 'bloom',
  name: 'Bloom',
  description: 'Cheap single-pass glow of the bright parts (golden-angle blur, screen blend).',
  category: 'optics',
  params: [
    pNum('threshold', 'Threshold', 0, 1, 0.6, 0.01),
    pNum('strength', 'Strength', 0, 2, 0.8, 0.01),
    pNum('radius', 'Radius', 0, 1, 0.4, 0.01),
    pNum('tint', 'Accent tint', 0, 1, 0, 0.01),
    pReactive(0.5),
  ],
  fragment: /* glsl */ `
void main() {
  vec3 src = texture2D(tInput, vUv).rgb;
  float R = u_radius * 0.08 * (1.0 + u_reactive * uKick * 0.3);
  vec2 ext = vec2(R / uAspect, R);
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * TAU;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 24; i++) {
    float fi = float(i);
    float r = sqrt((fi + 0.5) / 24.0);
    float a = fi * 2.39996323 + jit;
    vec3 c = texture2D(tInput, clamp(vUv + vec2(cos(a), sin(a)) * r * ext, 0.0, 1.0)).rgb;
    float m = max(c.r, max(c.g, c.b));
    float b = smoothstep(u_threshold, u_threshold + 0.2, m);
    float w = 1.0 - r * 0.6;
    acc += c * b * w;
    wsum += w;
  }
  vec3 glow = acc / wsum;
  vec3 accN = uAccent / max(max(uAccent.r, max(uAccent.g, uAccent.b)), 0.01);
  glow = mix(glow, accN * max(glow.r, max(glow.g, glow.b)), u_tint);
  glow = clamp(glow * u_strength * (1.0 + u_reactive * (uKick * 0.8 + uDrop)), 0.0, 1.0);
  gl_FragColor = vec4(1.0 - (1.0 - clamp(src, 0.0, 1.0)) * (1.0 - glow), 1.0);
}
`,
};

/* ───────────────────────── crt ───────────────────────── */

const crt: EffectDef = {
  id: 'crt',
  name: 'CRT',
  description: 'Scanlines, barrel curvature, aperture-grille mask and vignette. Snares jitter the lines.',
  category: 'optics',
  params: [
    pNum('scanlines', 'Scanlines', 0, 1, 0.35, 0.01),
    pNum('density', 'Line count', 80, 800, 320, 1),
    pNum('curvature', 'Curvature', 0, 1, 0.3, 0.01),
    pNum('mask', 'RGB mask', 0, 1, 0.25, 0.01),
    pNum('vignette', 'Vignette', 0, 1, 0.4, 0.01),
    pReactive(0.5),
  ],
  fragment: /* glsl */ `
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float k = u_curvature * 0.3;
  p *= (1.0 + k * 0.5 * dot(p, p)) / (1.0 + k * 0.5);
  vec2 uv = p * 0.5 + 0.5;
  float line = floor(uv.y * u_density);
  uv.x += (hash11(line * 0.618 + floor(uTime * 30.0)) - 0.5) * 0.006 * u_reactive * uSnare;
  vec3 col = texture2D(tInput, clamp(uv, 0.0, 1.0)).rgb;

  float s = 0.5 + 0.5 * cos(uv.y * u_density * TAU);
  col *= mix(1.0, 0.55 + 0.45 * s, u_scanlines) * (1.0 + u_scanlines * 0.3);

  float m = mod(floor(gl_FragCoord.x), 3.0);
  vec3 mk = m < 0.5 ? vec3(1.0, 0.7, 0.7) : (m < 1.5 ? vec3(0.7, 1.0, 0.7) : vec3(0.7, 0.7, 1.0));
  col *= mix(vec3(1.0), mk * 1.15, u_mask);

  vec2 vv = clamp(uv * (1.0 - uv), 0.0, 1.0);
  float vig = pow(clamp(vv.x * vv.y * 16.0, 0.0, 1.0), 0.35);
  col *= mix(1.0, vig, u_vignette);
  col *= 1.0 + u_reactive * uKick * 0.12;

  vec2 bd = min(uv, 1.0 - uv);
  float inside = smoothstep(0.0, 0.004, min(bd.x, bd.y));
  gl_FragColor = vec4(mix(vec3(0.02), clamp(col, 0.0, 1.0), inside), 1.0);
}
`,
};

/* ───────────────────────── vignette ───────────────────────── */

const vignette: EffectDef = {
  id: 'vignette',
  name: 'Vignette',
  description: 'Soft edge falloff into the palette background (or black / foreground). Breathes with the kick.',
  category: 'optics',
  params: [
    pNum('amount', 'Amount', 0, 1, 0.4, 0.01),
    pNum('softness', 'Softness', 0.05, 1, 0.5, 0.01),
    pSelect(
      'color',
      'Colour',
      [
        ['bg', 'Palette bg'],
        ['black', 'Black'],
        ['fg', 'Palette fg'],
      ],
      'bg',
    ),
    pReactive(0.3),
  ],
  fragment: /* glsl */ `
void main() {
  vec3 src = texture2D(tInput, vUv).rgb;
  float d = length((vUv - 0.5) * vec2(uAspect, 1.0)) / (0.5 * length(vec2(uAspect, 1.0)));
  float amt = clamp(u_amount * (1.0 - u_reactive * uKick * 0.3), 0.0, 1.0);
  float inner = 1.0 - amt;
  float v = smoothstep(inner, inner + u_softness, d);
  vec3 vc = u_color < 0.5 ? uBg : (u_color < 1.5 ? vec3(0.0) : uFg);
  gl_FragColor = vec4(mix(src, vc, v), 1.0);
}
`,
};

export const opticsEffects: EffectDef[] = [chroma, bloom, crt, vignette];
