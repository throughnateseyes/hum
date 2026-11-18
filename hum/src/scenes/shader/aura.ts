import type { ClockDef } from './lib';
import { HM_LIB, defineClockedShaderScene, sinceKickClock, speedClock } from './lib';

const fragment = /* glsl */ `
${HM_LIB}
// 0 → ~1 in ~0.15 s after a drop, then a slow ~1.5 s fall
float auBurst(float s) { return clamp((1.0 - exp(-s * 16.0)) * exp(-s * 1.5) * 1.35, 0.0, 1.0); }
float auBand(float x) { return (spectrum(x - 0.03) + spectrum(x) + spectrum(x + 0.03)) / 3.0; }

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float t = u_clk;
  float lightBg = hmIsLight();

  float burst = u_burst * auBurst(u_sinceDrop);
  float tens = clamp(uBuild * u_tension, 0.0, 1.0);
  float kick = uKick * u_punch;

  // kick shockwave: a pressure ring travels out from the centre and shoves the colour ahead of it
  float r = length(p);
  vec2 radial = p / max(r, 0.0001);
  float sk = u_sinceKick;
  float kx = (r - sk * 1.25) / 0.16;
  float kAmp = u_punch * u_kickAmp * exp(-sk * 2.4);
  // drop: a much bigger, slower ring
  float sd = u_sinceDrop;
  float dx = (r - sd * 0.9) / 0.3;
  float dAmp = burst * 0.9;
  vec2 dp = p - radial * (kAmp * 0.13 * exp(-kx * kx) + dAmp * 0.22 * exp(-dx * dx));
  // snare: a quick twist of the fabric
  dp = rot2(0.35 * uSnare * u_punch * exp(-r * 1.4)) * dp;

  // gentle domain drift so the blobs read as fabric, not circles (finer and busier during a build)
  float wf = 1.3 * (1.0 + 1.4 * tens);
  dp += u_drift * (0.18 + 0.1 * tens) * vec2(snoise(dp * wf + vec2(t * 0.11, 3.1)),
                                              snoise(dp * wf + vec2(7.4, -t * 0.09)));
  float breathe = 1.0 + 0.15 * uMid + 0.1 * uLowMid + 0.3 * uSub + 0.08 * sin(t * 0.7);
  float rad = u_softness * 0.42 * breathe;
  // build pulls everything in tight; kicks breathe out; the drop blows the blobs apart
  float spread = (1.0 - 0.42 * tens) * (1.0 + 0.22 * kick + 1.5 * burst);
  float grow = (1.0 - 0.3 * tens) * (1.0 + 0.4 * kick + 0.7 * burst);

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
    // build: a nervous shiver as the tension rises
    c += tens * 0.025 * vec2(snoise(vec2(fi * 3.3, uTime * 5.0)), snoise(vec2(fi * 5.1 + 9.0, uTime * 5.0)));
    c *= spread;
    // each blob breathes with its own slice of the spectrum (low → high), highs boosted
    float bx = 0.05 + 0.72 * fi / 6.0;
    float band = auBand(bx) * (1.0 + 1.2 * bx);
    float rr = rad * (0.7 + 0.6 * h3) * grow * (1.0 + u_bands * 1.1 * band);
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
  col = hmSat(col, u_saturation * (0.75 + 0.6 * uEnergy + 0.3 * burst));

  // faint bloom pulse on the beat (screen blend so it works on paper and on black)
  float pulse = (0.7 * uKick + 0.5 * exp(-uBeatPhase * 6.0) * uLevel) * u_bloom;
  // the shock fronts catch a little light as they pass
  float front = kAmp * exp(-kx * kx) * 0.5 + dAmp * exp(-dx * dx) * 0.6;
  vec3 glowCol = mix(uAccent2, hmLight(), 0.5);
  col = 1.0 - (1.0 - col) * (1.0 - glowCol * clamp(clamp(glow, 0.0, 1.0) * pulse * 0.35 + front * 0.25, 0.0, 0.6));

  // film grain + soft vignette
  col += hmGrain(fc, uTime) * u_grain;
  float vig = smoothstep(0.3, 0.95, length((vUv - 0.5) * vec2(uAspect * 0.8, 1.0)));
  col = mix(col, col * 0.82, vig * (0.5 + 0.3 * tens));
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

export const aura = defineClockedShaderScene(
  {
    id: 'aura',
    name: 'Aura',
    description:
      'Soft, slow gradient-mesh colour fields with film grain — for sad, ambient or romantic music. Each blob breathes with its own slice of the spectrum, kicks breathe the field out and send a soft pressure ring through it, snares twist it, build-ups draw the blobs into a tight, shivering knot and a drop blows them apart. Pastel on paper palettes, glowing on dark ones.',
    category: 'field',
    fragment,
    tags: ['ambient', 'sad', 'romantic', 'dreamy', 'calm', 'soft', 'melancholic', 'warm', 'minimal'],
    light: true,
    params: [
      { id: 'count', label: 'Blobs', group: 'Shape', type: 'number', min: 2, max: 7, step: 1, default: 5 },
      { id: 'softness', label: 'Softness', group: 'Shape', type: 'number', min: 0.2, max: 1.6, step: 0.01, default: 0.7 },
      { id: 'drift', label: 'Drift warp', group: 'Shape', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.45 },
      { id: 'speed', label: 'Speed', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.2 },
      { id: 'punch', label: 'Kick breath', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8, hint: 'Kicks push the blobs out and send a pressure ring; snares twist' },
      { id: 'bands', label: 'Spectrum breath', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.7, hint: 'Each blob swells with its own frequency band' },
      { id: 'burst', label: 'Drop burst', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
      { id: 'tension', label: 'Build tension', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'Build-ups pull the blobs into a tight, shivering knot' },
      { id: 'saturation', label: 'Saturation', group: 'Color', type: 'number', min: 0, max: 1.6, step: 0.01, default: 0.9 },
      { id: 'warmth', label: 'Warmth', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.15 },
      { id: 'bloom', label: 'Beat bloom', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
      { id: 'grain', label: 'Film grain', group: 'Color', type: 'number', min: 0, max: 0.25, step: 0.005, default: 0.06 },
    ],
    modulations: [
      { source: 'sub', param: 'drift', amount: 0.15 },
      { source: 'energy', param: 'saturation', amount: 0.2 },
      { source: 'sway', param: 'warmth', amount: 0.1 },
    ],
  },
  {
    clk: speedClock('speed', 0.2, (f) => 0.4 + 1.4 * f.audio.energy + 0.3 * f.audio.mid + 1.2 * f.audio.build),
    sinceKick: sinceKickClock,
    kickAmp: kickAmpClock,
    sinceDrop: sinceDropClock,
  },
);
