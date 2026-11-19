import { HM_LIB, defineClockedShaderScene, rateClock, speedClock } from './lib';

const fragment = /* glsl */ `
${HM_LIB}
void main() {
  vec2 fc = gl_FragCoord.xy;
  float pxs = max(1.0, uResolution.y / 1080.0);
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float t = u_clk;

  // kick screen-shake (stepped, so it reads as a hit rather than a wobble)
  vec2 sh = hash22(vec2(floor(uTime * 24.0), 7.0)) - 0.5;
  p += sh * uKick * uKick * u_shake * 0.06;

  // blomp: the centre bulges toward you with sub + bass, like a speaker cone
  float r = length(p);
  float blomp = u_blomp * (0.45 * uSub + 0.25 * uBass + 0.2 * uKick);
  p *= 1.0 - blomp * 0.45 * exp(-r * r * 2.2);

  // wobble: bands bend with the sub (every LFO wobble shows up here)
  p.y += sin(p.x * 3.0 + t * 1.3) * 0.05 * u_wobble * (uSub + 0.12);
  p.y += sin(p.x * 7.0 - t * 2.1) * 0.015 * u_wobble * uBass;

  // heavy horizontal bands
  float N = max(u_bands, 1.0);
  float yy = (p.y + 0.5) * N;
  float bi = floor(yy);
  float fy = fract(yy);
  float bn = clamp(bi / max(N - 1.0, 1.0), 0.0, 1.0); // 0 bottom … 1 top
  float sp = spectrum(bn * 0.55);
  float th = clamp(u_thickness + 0.4 * sp + 0.3 * uSub * (1.0 - bn) + 0.15 * uBass, 0.04, 0.96);
  float aa = max(fwidth(yy) * 1.2, 0.001);
  float bar = 1.0 - smoothstep(th * 0.5 - aa, th * 0.5 + aa, abs(fy - 0.5));

  // bands are cut into blocks that slide; alternate rows run opposite ways
  float dir = mod(bi, 2.0) < 0.5 ? 1.0 : -1.0;
  float xx = p.x * (2.0 + hash11(bi * 1.3 + 0.7) * 3.0) + dir * u_scroll * (0.4 + hash11(bi * 2.1 + 0.3)) + sp * dir * 0.6;
  float si = floor(xx);
  float sf = fract(xx);
  float gap = 0.04 + 0.1 * hash21(vec2(si, bi));
  float aax = max(fwidth(xx) * 1.2, 0.001);
  float seg = smoothstep(gap, gap + aax, sf) * (1.0 - smoothstep(1.0 - aax, 1.0, sf));
  float solid = step(0.28, hash21(vec2(si * 1.7, bi + 11.0)));
  float shape = bar * seg * solid;

  // halftone: dots shade each slab toward its bottom edge
  float v = clamp((fy - 0.5) / max(th, 0.05) + 0.5, 0.0, 1.0); // 0 bottom edge … 1 top edge
  vec2 hp = rot2(0.785398) * fc / (u_dot * pxs);
  vec2 hcell = fract(hp) - 0.5;
  float tone = clamp(1.0 - v * 1.3 + 0.2 * uSub, 0.0, 1.0);
  float dotR = sqrt(tone) * 0.55;
  float ht = 1.0 - smoothstep(dotR - 0.08, dotR + 0.08, length(hcell));

  float isAcc = mod(bi, 5.0) < 0.5 ? 1.0 : 0.0;
  vec3 barCol = mix(uFg, uAccent, isAcc);
  barCol = mix(barCol, uAccent2, clamp(uKick * (1.0 - smoothstep(0.15, 0.35, bn)), 0.0, 1.0));
  barCol = mix(barCol, mix(barCol, uBg, 0.6), ht * u_halftone);

  // background: a pressure field of muted dots that swells with the sub
  float pressure = (0.12 + 0.85 * uSub) * exp(-r * r * 1.5) * u_halftone;
  float bgR = sqrt(clamp(pressure, 0.0, 1.0)) * 0.5;
  float bgDot = 1.0 - smoothstep(bgR - 0.08, bgR + 0.08, length(hcell));
  vec3 col = mix(uBg, uMuted, bgDot);
  col = mix(col, barCol, shape);

  // grit: grain + specks knocked out of the slabs
  float speck = step(1.0 - u_grit * 0.12, hash21(floor(fc / pxs) + floor(uTime * 24.0) * 3.7));
  col = mix(col, uBg, speck * shape * 0.8);
  col += hmGrain(fc, uTime) * u_grit;
  vec2 vv = vUv - 0.5;
  col *= 1.0 - dot(vv, vv) * (0.45 + 0.4 * uSub);

  // hard inversion on the drop
  col = clamp(col, 0.0, 1.0);
  col = mix(col, vec3(1.0) - col, step(0.4, uDrop));
  gl_FragColor = vec4(col, 1.0);
}
`;

export const subPressure = defineClockedShaderScene(
  {
    id: 'sub-pressure',
    name: 'Sub Pressure',
    description:
      'Made for dubstep and bass music: heavy halftoned bars that bend with every sub wobble and bulge out like a speaker cone, blocks sliding with the spectrum, screen-shake on kicks and a hard colour inversion on the drop.',
    category: 'field',
    style: 'data',
    fragment,
    tags: ['dubstep', 'bass', 'heavy', 'aggressive', 'gritty', 'industrial', 'dark', 'intense'],
    params: [
      { id: 'bands', label: 'Bands', group: 'Shape', type: 'number', min: 4, max: 32, step: 1, default: 12 },
      { id: 'thickness', label: 'Thickness', group: 'Shape', type: 'number', min: 0.1, max: 0.9, step: 0.01, default: 0.42 },
      { id: 'blomp', label: 'Blomp', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'sub/bass bulge' },
      { id: 'wobble', label: 'Wobble', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'shake', label: 'Kick shake', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'speed', label: 'Slide speed', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 0.35 },
      { id: 'halftone', label: 'Halftone', group: 'Texture', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
      { id: 'dot', label: 'Dot size', group: 'Texture', type: 'number', min: 3, max: 16, step: 0.5, default: 6 },
      { id: 'grit', label: 'Grit', group: 'Texture', type: 'number', min: 0, max: 0.4, step: 0.005, default: 0.12 },
    ],
    modulations: [
      { source: 'sub', param: 'thickness', amount: 0.15 },
      { source: 'bass', param: 'blomp', amount: 0.15 },
      { source: 'drop', param: 'grit', amount: 0.3 },
    ],
  },
  {
    clk: rateClock((f) => 0.5 + 1.0 * f.audio.energy),
    scroll: speedClock('speed', 0.35, (f) => 0.4 + 1.2 * f.audio.energy + 0.8 * f.audio.bass),
  },
);
