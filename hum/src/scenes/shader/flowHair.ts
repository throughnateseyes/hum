import { HM_LIB, defineClockedShaderScene, sinceKickClock, speedClock } from './lib';

const fragment = /* glsl */ `
${HM_LIB}
float gT;
float gBase;
float gTurb;
vec2 gComb;
float gWaveR;
float gWaveA;

// direction of the hair at pixel position q
vec2 hairDir(vec2 q) {
  vec2 p = (q - 0.5 * uResolution) / uResolution.y;
  float n = snoise(p * u_scale + vec2(gT * 0.11, -gT * 0.07) + gComb);
  float a = gBase + n * PI * gTurb;
  vec2 d = vec2(cos(a), sin(a));
  // kick wave: strands inside the expanding ring bend outward
  float rl = length(p);
  float rw = (rl - gWaveR) * 9.0;
  float ring = exp(-rw * rw) * gWaveA;
  vec2 radial = p / max(rl, 0.0001);
  return normalize(mix(d, radial, clamp(ring, 0.0, 0.9)) + vec2(0.00001, 0.0));
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float pxs = max(1.0, uResolution.y / 1080.0);
  gT = u_clk;
  // mid sweeps the comb direction, air drags the comb through the field
  gBase = radians(u_direction) + u_comb * (0.9 * (uMid - 0.25) + 0.2 * uSway);
  gComb = vec2(0.0, u_comb * 0.6 * uAir);
  gTurb = u_curl * (0.6 + 0.3 * uHighMid);
  gWaveR = u_sinceKick * 0.9;
  gWaveA = u_wave * exp(-u_sinceKick * 1.8);

  // line-integral convolution of fine noise along the field (12 steps each way)
  float h = u_length * pxs / 12.0;
  float cell = max(1.0, u_fineness * pxs);
  vec2 qf = fc;
  vec2 qb = fc;
  float acc = vnoise(fc / cell);
  for (int i = 0; i < 12; i++) {
    qf += hairDir(qf) * h;
    qb -= hairDir(qb) * h;
    acc += vnoise(qf / cell) + vnoise(qb / cell);
  }
  acc /= 25.0;
  float z = (acc - 0.5) * 25.0; // ~ unit variance

  // clumps: strands bunch in soft locks
  z += u_clump * snoise(fc / (140.0 * pxs) + vec2(gT * 0.03, 0.0)) * 0.9;
  float ink = smoothstep(u_threshold - 0.9 * uEnergy, u_threshold - 0.9 * uEnergy + 1.1, z);

  vec3 col = uBg * (1.0 + (hash21(fc) - 0.5) * 0.04); // paper tooth
  vec3 strand = mix(uAccent, uAccent2, 0.6 * smoothstep(0.25, 0.9, vnoise(fc / (180.0 * pxs) + gT * 0.05)));
  // the kick wave front picks up accent2
  vec2 pc = (fc - 0.5 * uResolution) / uResolution.y;
  float fw = (length(pc) - gWaveR) * 9.0;
  float front = exp(-fw * fw) * gWaveA;
  strand = mix(strand, uAccent2, clamp(front, 0.0, 1.0) * 0.6);
  col = mix(col, strand, ink * 0.92);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export const flowHair = defineClockedShaderScene(
  {
    id: 'flow-hair',
    name: 'Flow Hair',
    description:
      'Thousands of hairline strokes combed through a noise flow field (line-integral convolution) — ultramarine on paper. Mid sweeps the comb, air drags it through the strands, energy thickens the ink, and every kick pushes a radial wave out through the hair.',
    category: 'field',
    fragment,
    tags: ['organic', 'editorial', 'calm', 'textured', 'flowing', 'minimal', 'delicate', 'hypnotic'],
    light: true,
    params: [
      { id: 'scale', label: 'Field scale', group: 'Shape', type: 'number', min: 0.3, max: 4, step: 0.01, default: 1.4 },
      { id: 'curl', label: 'Curl', group: 'Shape', type: 'number', min: 0, max: 2, step: 0.01, default: 0.8 },
      { id: 'direction', label: 'Direction', group: 'Shape', type: 'number', min: -180, max: 180, step: 1, default: 30, hint: 'degrees' },
      { id: 'length', label: 'Stroke length', group: 'Strokes', type: 'number', min: 8, max: 120, step: 1, default: 48, hint: 'px' },
      { id: 'fineness', label: 'Fineness', group: 'Strokes', type: 'number', min: 1, max: 4, step: 0.05, default: 1.5, hint: 'strand width in px' },
      { id: 'threshold', label: 'Sparseness', group: 'Strokes', type: 'number', min: -1, max: 2, step: 0.01, default: 0.4 },
      { id: 'clump', label: 'Clumping', group: 'Strokes', type: 'number', min: 0, max: 2, step: 0.01, default: 0.6 },
      { id: 'speed', label: 'Speed', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.15 },
      { id: 'comb', label: 'Comb (mid/air)', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'wave', label: 'Kick wave', group: 'Motion', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8 },
    ],
    modulations: [
      { source: 'mid', param: 'direction', amount: 0.06 },
      { source: 'air', param: 'curl', amount: 0.12 },
      { source: 'energy', param: 'threshold', amount: -0.15 },
    ],
  },
  {
    clk: speedClock('speed', 0.15, (f) => 0.5 + 1.2 * f.audio.energy + 0.4 * f.audio.mid),
    sinceKick: sinceKickClock,
  },
);
