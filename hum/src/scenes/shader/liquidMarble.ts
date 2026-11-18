import { HM_LIB, defineClockedShaderScene, dropFlipClock, speedClock } from './lib';

const fragment = /* glsl */ `
${HM_LIB}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float t = u_clk;
  int oct = int(u_detail + 0.5);

  // kick: a fold that pinches and twists the ink toward the centre
  float r = length(p);
  float fold = u_fold * uKick;
  p *= 1.0 - 0.2 * fold * exp(-r * r * 3.0);
  p = rot2(0.4 * fold * exp(-r * 2.0)) * p;
  p *= u_scale;

  // two layers of domain warping; bass deepens, drop flips the direction (u_flip eases 0 <-> PI)
  float w = u_warp * (1.0 + 0.9 * uBass + 0.5 * uSub + 0.6 * uDrop);
  mat2 flip = rot2(u_flip);
  vec2 q = vec2(fbm(p + vec2(t * 0.31, -t * 0.17), oct),
                fbm(p + vec2(5.2, 1.3) - vec2(t * 0.23, t * 0.29), oct));
  q = flip * q;
  vec2 s = vec2(fbm(p + w * q + vec2(1.7, 9.2) + t * 0.15, oct),
                fbm(p + w * q + vec2(8.3, 2.8) - t * 0.12, oct));
  s = flip * s;
  float f = fbm(p + w * 1.25 * s + vec2(t * 0.05, -t * 0.04), oct);

  // thick ink body
  float ink = clamp(0.5 + 0.8 * f * u_contrast, 0.0, 1.0);
  ink = smoothstep(0.12, 0.88, ink);
  vec3 col = mix(uBg, uAccent, ink);
  // shadowed folds where the warp is deep
  float depth = clamp(length(q) * 0.9, 0.0, 1.0);
  col = mix(col, uMuted, 0.3 * depth * (1.0 - ink));
  col = mix(col, mix(uAccent, hmDark(), 0.55), smoothstep(0.6, 1.0, ink) * 0.55);

  // gold veins on the ridges of the second warp layer
  float ridge = clamp(1.0 - abs(s.x - 0.6 * s.y + 0.1 * f), 0.0, 1.0);
  float vw = mix(22.0, 6.0, u_veins) * (1.0 - 0.3 * uKick);
  float vein = pow(ridge, vw);
  col = mix(col, uAccent2, clamp(vein * (0.6 + 0.6 * u_veins) * (0.75 + 0.25 * uBrightness), 0.0, 1.0));
  col = mix(col, uFg, pow(ridge, vw * 4.0) * u_veins * 0.45);

  // print: grain + ink mottling + soft vignette
  col += hmGrain(fc, uTime) * u_grain;
  col *= 1.0 + (vnoise(fc * 0.35) - 0.5) * u_grain * 0.7;
  vec2 vv = vUv - 0.5;
  col *= 1.0 - dot(vv, vv) * 0.3;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export const liquidMarble = defineClockedShaderScene(
  {
    id: 'liquid-marble',
    name: 'Liquid Marble',
    description:
      'Domain-warped fbm ink folding into itself — ultramarine body with gold veins (accent / accent2). Bass deepens and speeds the warp, kicks pinch a fold into the centre, a drop flips the warp direction. Grainy, print-like.',
    category: 'field',
    fragment,
    tags: ['liquid', 'luxurious', 'hypnotic', 'flowing', 'organic', 'deep', 'marble', 'psychedelic'],
    params: [
      { id: 'scale', label: 'Scale', group: 'Shape', type: 'number', min: 0.8, max: 6, step: 0.01, default: 2.2 },
      { id: 'warp', label: 'Warp', group: 'Shape', type: 'number', min: 0, max: 3, step: 0.01, default: 1.4 },
      { id: 'detail', label: 'Detail', group: 'Shape', type: 'number', min: 2, max: 7, step: 1, default: 5, hint: 'fbm octaves (lower = faster)' },
      { id: 'speed', label: 'Speed', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.12 },
      { id: 'fold', label: 'Kick fold', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'veins', label: 'Gold veins', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
      { id: 'contrast', label: 'Contrast', group: 'Color', type: 'number', min: 0.4, max: 2, step: 0.01, default: 1.1 },
      { id: 'grain', label: 'Grain', group: 'Color', type: 'number', min: 0, max: 0.3, step: 0.005, default: 0.09 },
    ],
    modulations: [
      { source: 'bass', param: 'warp', amount: 0.15 },
      { source: 'brightness', param: 'veins', amount: 0.25 },
      { source: 'energy', param: 'scale', amount: -0.08 },
    ],
  },
  {
    clk: speedClock('speed', 0.12, (f) => 0.5 + 1.5 * f.audio.bass + 0.6 * f.audio.sub + 0.8 * f.audio.energy),
    flip: dropFlipClock,
  },
);
