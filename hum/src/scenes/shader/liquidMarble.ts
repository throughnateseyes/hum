import type { ClockDef } from './lib';
import { HM_LIB, defineClockedShaderScene, dropFlipClock, kickCountClock, sinceKickClock, speedClock } from './lib';

const fragment = /* glsl */ `
${HM_LIB}
// 0 → ~1 in ~0.15 s after a drop, then a slow ~1.5 s fall
float lmBurst(float s) { return clamp((1.0 - exp(-s * 16.0)) * exp(-s * 1.5) * 1.35, 0.0, 1.0); }
// a few neighbouring bins averaged, so adjacent-bin jitter doesn't band the ink
float lmBand(float x) { return (spectrum(x - 0.035) + spectrum(x) + spectrum(x + 0.035)) / 3.0; }

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float t = u_clk;
  int oct = int(u_detail + 0.5);
  float r0 = length(p);

  float burst = u_burst * lmBurst(u_sinceDrop);
  float tens = clamp(uBuild * u_tension, 0.0, 1.0);

  // kick: a fold that pinches and twists the ink toward a new point on every kick
  float seed = u_kickN;
  vec2 kc = (vec2(hash11(seed * 1.37 + 0.2), hash11(seed * 2.71 + 0.7)) - 0.5) * vec2(0.55 * uAspect, 0.45);
  vec2 kp = p - kc;
  float kr = length(kp);
  float fold = u_fold * uKick;
  float tw = hash11(seed * 4.3 + 1.9) > 0.5 ? 1.0 : -1.0;
  kp *= 1.0 - 0.45 * fold * exp(-kr * kr * 5.0);
  kp = rot2(tw * 0.9 * fold * exp(-kr * 2.5)) * kp;
  // ...and the fold rings out as a ripple through the ink
  float sk = u_sinceKick;
  float rx = kr - sk * 0.85;
  float ring = sin(rx * 26.0) * exp(-rx * rx * 40.0) * exp(-sk * 2.2) * u_ripple * u_kickAmp;
  kp += (kp / max(kr, 0.0001)) * ring * 0.035;
  p = kp + kc;

  // snare: a quick sideways tear
  p.x += uSnare * u_ripple * 0.06 * sin(p.y * 7.0 + seed * 1.7);

  // drop: a bubble blows out of the centre and spins the ink into a whirlpool
  float r = length(p);
  p *= 1.0 - 0.55 * burst * exp(-r * r * 1.6);
  p = rot2(burst * 2.2 * exp(-r * 1.8)) * p;
  // sub: slow heavy swell; build: the ink winds into a tightening vortex
  p *= 1.0 - 0.12 * uSub * exp(-r * r * 2.0);
  p = rot2(tens * 1.3 * exp(-r * 1.4)) * p;
  p *= u_scale * (1.0 + 0.55 * tens);

  // two layers of domain warping; bass deepens, kicks lurch, drop flips the direction (u_flip eases 0 <-> PI)
  // the spectrum sets the depth by radius: lows fold the centre, highs the edges
  float band = lmBand(0.04 + 0.8 * clamp(r0, 0.0, 1.0)) * (1.0 + r0);
  float w = u_warp * (1.0 + 0.9 * uBass + 0.5 * uSub + 0.6 * uDrop + 0.5 * uKick * u_fold + 0.7 * burst + u_bands * 1.2 * band);
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

  // gold veins on the ridges of the second warp layer (finer and tauter during a build)
  float ridge = clamp(1.0 - abs(s.x - 0.6 * s.y + 0.1 * f), 0.0, 1.0);
  float vw = mix(22.0, 6.0, u_veins) * (1.0 - 0.3 * uKick) * (1.0 + 0.8 * tens);
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

export const liquidMarble = defineClockedShaderScene(
  {
    id: 'liquid-marble',
    name: 'Liquid Marble',
    description:
      'Domain-warped fbm ink folding into itself — ultramarine body with gold veins (accent / accent2). Bass deepens the warp and the spectrum sets its depth by radius (lows in the centre), every kick pinches and twists a fold at a new spot that rings out as a ripple, snares tear it sideways, build-ups wind it into a tightening vortex, and a drop blows a whirlpool out of the centre and flips the flow. Grainy, print-like.',
    category: 'field',
    style: 'light',
    fragment,
    tags: ['liquid', 'luxurious', 'hypnotic', 'flowing', 'organic', 'deep', 'marble', 'psychedelic'],
    params: [
      { id: 'scale', label: 'Scale', group: 'Shape', type: 'number', min: 0.8, max: 6, step: 0.01, default: 2.2 },
      { id: 'warp', label: 'Warp', group: 'Shape', type: 'number', min: 0, max: 3, step: 0.01, default: 1.3 },
      { id: 'detail', label: 'Detail', group: 'Shape', type: 'number', min: 2, max: 7, step: 1, default: 5, hint: 'fbm octaves (lower = faster)' },
      { id: 'speed', label: 'Speed', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.12 },
      { id: 'fold', label: 'Kick fold', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1.1, hint: 'Each kick pinches and twists the ink at a new spot' },
      { id: 'ripple', label: 'Kick ripple', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8, hint: 'The ring that spreads from each fold; also the snare tear' },
      { id: 'bands', label: 'Spectrum depth', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.6, hint: 'Warp depth by radius follows the spectrum' },
      { id: 'burst', label: 'Drop whirlpool', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
      { id: 'tension', label: 'Build tension', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'Build-ups wind the ink into a tight vortex of finer folds' },
      { id: 'veins', label: 'Gold veins', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
      { id: 'contrast', label: 'Contrast', group: 'Color', type: 'number', min: 0.4, max: 2, step: 0.01, default: 1.1 },
      { id: 'grain', label: 'Grain', group: 'Color', type: 'number', min: 0, max: 0.3, step: 0.005, default: 0.09 },
    ],
    modulations: [
      { source: 'sub', param: 'warp', amount: 0.12 },
      { source: 'brightness', param: 'veins', amount: 0.25 },
      { source: 'kick', param: 'fold', amount: 0.15 },
    ],
  },
  {
    clk: speedClock('speed', 0.12, (f) => 0.5 + 1.2 * f.audio.bass + 0.6 * f.audio.sub + 0.8 * f.audio.energy + 1.0 * f.audio.build),
    flip: dropFlipClock,
    sinceKick: sinceKickClock,
    kickAmp: kickAmpClock,
    kickN: kickCountClock,
    sinceDrop: sinceDropClock,
  },
);
