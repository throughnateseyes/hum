import type { ClockDef } from './lib';
import { HM_LIB, defineClockedShaderScene, sinceKickClock, speedClock } from './lib';

const fragment = /* glsl */ `
${HM_LIB}
float gT;
float gBase;
float gTurb;
float gScale;
vec2 gComb;
float gWaveR;
float gWaveA;
float gBurst;
float gTens;

// 0 → ~1 in ~0.15 s after a drop, then a slow ~1.5 s fall
float fhBurst(float s) { return clamp((1.0 - exp(-s * 16.0)) * exp(-s * 1.5) * 1.35, 0.0, 1.0); }

// bend direction d toward axis a (either sign of a, whichever is closer, so they never cancel)
vec2 fhBend(vec2 d, vec2 a, float k) {
  a *= dot(d, a) < 0.0 ? -1.0 : 1.0;
  return normalize(mix(d, a, k) + vec2(0.00001, 0.0));
}

// direction of the hair at pixel position q
vec2 hairDir(vec2 q) {
  vec2 p = (q - 0.5 * uResolution) / uResolution.y;
  float n = snoise(p * gScale + vec2(gT * 0.11, -gT * 0.07) + gComb);
  float a = gBase + n * PI * gTurb;
  vec2 d = vec2(cos(a), sin(a));
  float rl = length(p);
  vec2 radial = p / max(rl, 0.0001);
  // spectrum: strands stand up from the bottom edge to the height of their band (lows centre, highs out)
  float xs = clamp(abs(p.x) / (0.5 * uAspect), 0.0, 1.0);
  float hgt = spectrum(0.03 + 0.8 * xs) * (1.0 + 0.8 * xs) * u_bands * 0.75;
  float stand = (1.0 - smoothstep(-0.5 + hgt - 0.06, -0.5 + hgt + 0.02, p.y)) * smoothstep(0.01, 0.05, hgt);
  d = fhBend(d, vec2(0.0, 1.0), stand * 0.9);
  // build: the hair is drawn in toward the centre
  d = fhBend(d, radial, gTens * 0.3);
  // kick wave: strands inside the expanding ring bend outward
  float rw = (rl - gWaveR) * 7.0;
  float ring = exp(-rw * rw) * gWaveA;
  d = fhBend(d, radial, clamp(ring, 0.0, 0.9));
  // drop: a gust from the centre blows every strand outward
  return fhBend(d, radial, gBurst * 0.85 * smoothstep(0.0, 0.08, rl));
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float pxs = max(1.0, uResolution.y / 1080.0);
  gT = u_clk;
  gBurst = u_burst * fhBurst(u_sinceDrop);
  gTens = clamp(uBuild * u_tension, 0.0, 1.0);
  float flinch = u_flinch;
  // mid sweeps the comb direction, air drags the comb through the field, snares flick it
  gBase = radians(u_direction) + u_comb * (0.9 * (uMid - 0.25) + 0.2 * uSway) + 0.45 * uSnare * flinch;
  // the drop slide drags the whole field a long way while the gust blows
  gComb = vec2(u_slide, u_comb * 0.6 * uAir);
  // kicks make every strand kink at once; build-ups twist and tighten the field
  gTurb = u_curl * (0.6 + 0.3 * uHighMid + 0.9 * uKick * flinch) * (1.0 + gTens);
  gScale = u_scale * (1.0 + 0.7 * gTens);
  gWaveR = u_sinceKick * 1.2;
  gWaveA = u_wave * u_kickAmp * exp(-u_sinceKick * 1.8);

  // the kick ring physically shoves the strands outward as it passes
  vec2 pc = (fc - 0.5 * uResolution) / uResolution.y;
  float rc = length(pc);
  float fw = (rc - gWaveR) * 7.0;
  float front = exp(-fw * fw) * gWaveA;
  vec2 fs = fc - (pc / max(rc, 0.0001)) * front * 0.05 * uResolution.y;

  // line-integral convolution of fine noise along the field (12 steps each way)
  float len = u_length * (1.0 + 0.35 * uSub + 0.8 * gBurst) * (1.0 - 0.35 * gTens);
  float h = len * pxs / 12.0;
  float cell = max(1.0, u_fineness * pxs);
  vec2 qf = fs;
  vec2 qb = fs;
  float acc = vnoise(fs / cell);
  for (int i = 0; i < 12; i++) {
    qf += hairDir(qf) * h;
    qb -= hairDir(qb) * h;
    acc += vnoise(qf / cell) + vnoise(qb / cell);
  }
  acc /= 25.0;
  float z = (acc - 0.5) * 25.0; // ~ unit variance

  // clumps: strands bunch in soft locks
  z += u_clump * snoise(fs / (140.0 * pxs) + vec2(gT * 0.03, 0.0)) * 0.9;
  float th = u_threshold - 0.9 * uEnergy - 0.5 * gTens - 0.7 * gBurst;
  float ink = smoothstep(th, th + 1.1, z);

  vec3 col = uBg * (1.0 + (hash21(fc) - 0.5) * 0.04); // paper tooth
  vec3 strand = mix(uAccent, uAccent2, 0.6 * smoothstep(0.25, 0.9, vnoise(fs / (180.0 * pxs) + gT * 0.05)));
  // the kick wave front picks up accent2
  strand = mix(strand, uAccent2, clamp(front, 0.0, 1.0) * 0.6);
  col = mix(col, strand, ink * 0.92);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/** Seconds since the drop fired (rising edge of the drop envelope). */
const sinceDropClock: ClockDef = {
  init: 100,
  step: (v, f, _s, mem) => {
    const d = f.audio.drop;
    const fired = d > 0.6 && (mem.sdPrev ?? 0) <= 0.6;
    mem.sdPrev = d;
    return fired ? 0 : Math.min(v + f.dt, 100);
  },
};

/** Strength of the last kick (already shaped by Impact), held until the next one. */
const kickAmpClock: ClockDef = { step: (v, f) => (f.audio.kickHit ? f.audio.kick : v) };

/** Noise-space offset that glides 5 units on each drop (eased, ~1 s), so the field is re-combed. */
const dropSlideClock: ClockDef = {
  step: (v, f, s, mem) => {
    if (s.sinceDrop === 0) mem.slideTarget = ((mem.slideTarget ?? 0) + 5) % 1000;
    const target = mem.slideTarget ?? 0;
    if (target < v - 500) return target; // wrapped
    return v + (target - v) * (1 - Math.exp(-f.dt * 2.6));
  },
};

export const flowHair = defineClockedShaderScene(
  {
    id: 'flow-hair',
    name: 'Flow Hair',
    description:
      'Thousands of hairline strokes combed through a noise flow field (line-integral convolution) — ultramarine on paper. The spectrum makes strands stand up from the bottom edge like a field of grass, every kick makes the hair flinch and pushes a ring out through it, snares flick the comb, build-ups twist the field tighter and draw it inward, and a drop blows a gust out of the centre that re-combs everything.',
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
      { id: 'wave', label: 'Kick wave', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1 },
      { id: 'flinch', label: 'Kick flinch', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.6, hint: 'Kicks kink every strand at once; snares flick the comb' },
      { id: 'bands', label: 'Spectrum grass', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8, hint: 'Strands stand up from the bottom edge to the height of their band' },
      { id: 'burst', label: 'Drop gust', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
      { id: 'tension', label: 'Build tension', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'Build-ups twist the field tighter and draw it inward' },
    ],
    modulations: [
      { source: 'mid', param: 'direction', amount: 0.06 },
      { source: 'air', param: 'curl', amount: 0.12 },
      { source: 'energy', param: 'threshold', amount: -0.15 },
    ],
  },
  {
    clk: speedClock('speed', 0.15, (f) => 0.5 + 1.2 * f.audio.energy + 0.4 * f.audio.mid + 1.0 * f.audio.build),
    sinceKick: sinceKickClock,
    kickAmp: kickAmpClock,
    sinceDrop: sinceDropClock,
    slide: dropSlideClock,
  },
);
