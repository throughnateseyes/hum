import { HM_LIB, defineClockedShaderScene, speedClock } from './lib';

const fragment = /* glsl */ `
${HM_LIB}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float t = u_clk;

  // gentle domain drift so the blobs read as fabric, not circles
  vec2 dp = p + u_drift * 0.18 * vec2(snoise(p * 1.3 + vec2(t * 0.11, 3.1)),
                                      snoise(p * 1.3 + vec2(7.4, -t * 0.09)));
  float breathe = 1.0 + 0.35 * uMid + 0.1 * uLowMid + 0.08 * sin(t * 0.7);
  float rad = u_softness * 0.42 * breathe;
  float lightBg = hmIsLight();

  vec3 acc = uBg * 0.6;
  float wsum = 0.6;
  float glow = 0.0;
  for (int i = 0; i < 7; i++) {
    if (float(i) >= u_count) break;
    float fi = float(i);
    float h1 = hash11(fi * 7.13 + 1.0);
    float h2 = hash11(fi * 3.71 + 9.0);
    float h3 = hash11(fi * 1.97 + 4.0);
    vec2 c = vec2(sin(t * (0.21 + 0.17 * h1) + h2 * TAU) * 0.55 * uAspect,
                  cos(t * (0.17 + 0.13 * h2) + h3 * TAU) * 0.42);
    float rr = rad * (0.7 + 0.6 * h3);
    vec2 d = dp - c;
    float wgt = exp(-dot(d, d) / (rr * rr));
    float m = mod(fi, 4.0);
    vec3 ci = uAccent;
    if (m > 0.5) ci = uAccent2;
    if (m > 1.5) ci = mix(uMuted, uAccent, 0.5);
    if (m > 2.5) ci = mix(uAccent2, uFg, 0.25);
    ci = mix(ci, uBg, 0.22 * lightBg); // pastel on paper
    acc += ci * wgt * 1.6;
    wsum += wgt * 1.6;
    glow += wgt;
  }
  vec3 col = acc / wsum;

  // warmth: lean toward accent2
  col = mix(col, mix(col, uAccent2, 0.35), u_warmth);
  // energy raises saturation
  col = hmSat(col, u_saturation * (0.75 + 0.6 * uEnergy));

  // faint bloom pulse on the beat (screen blend so it works on paper and on black)
  float pulse = (0.7 * uKick + 0.5 * exp(-uBeatPhase * 6.0) * uLevel) * u_bloom;
  vec3 glowCol = mix(uAccent2, hmLight(), 0.5);
  col = 1.0 - (1.0 - col) * (1.0 - glowCol * clamp(glow, 0.0, 1.0) * pulse * 0.35);

  // film grain + soft vignette
  col += hmGrain(fc, uTime) * u_grain;
  float vig = smoothstep(0.3, 0.95, length((vUv - 0.5) * vec2(uAspect * 0.8, 1.0)));
  col = mix(col, col * 0.82, vig * 0.5);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export const aura = defineClockedShaderScene(
  {
    id: 'aura',
    name: 'Aura',
    description:
      'Soft, slow gradient-mesh colour fields with film grain — for sad, ambient or romantic music. Mid breathes the blobs, energy raises saturation and drift speed, beats add a faint bloom pulse. Pastel on paper palettes, glowing on dark ones.',
    category: 'field',
    fragment,
    tags: ['ambient', 'sad', 'romantic', 'dreamy', 'calm', 'soft', 'melancholic', 'warm', 'minimal'],
    light: true,
    params: [
      { id: 'count', label: 'Blobs', group: 'Shape', type: 'number', min: 2, max: 7, step: 1, default: 5 },
      { id: 'softness', label: 'Softness', group: 'Shape', type: 'number', min: 0.2, max: 1.6, step: 0.01, default: 0.75 },
      { id: 'drift', label: 'Drift warp', group: 'Shape', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.45 },
      { id: 'speed', label: 'Speed', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.2 },
      { id: 'saturation', label: 'Saturation', group: 'Color', type: 'number', min: 0, max: 1.6, step: 0.01, default: 0.9 },
      { id: 'warmth', label: 'Warmth', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.15 },
      { id: 'bloom', label: 'Beat bloom', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
      { id: 'grain', label: 'Film grain', group: 'Color', type: 'number', min: 0, max: 0.25, step: 0.005, default: 0.06 },
    ],
    modulations: [
      { source: 'mid', param: 'softness', amount: 0.12 },
      { source: 'energy', param: 'saturation', amount: 0.2 },
      { source: 'sway', param: 'warmth', amount: 0.1 },
    ],
  },
  {
    clk: speedClock('speed', 0.2, (f) => 0.4 + 1.6 * f.audio.energy + 0.3 * f.audio.mid),
  },
);
