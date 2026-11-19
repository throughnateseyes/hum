/**
 * Prism — light seen through cut crystal, held too close and slightly overexposed. A pearly field of
 * caustic filaments curves round a glowing core, with thin spectral fringes where the light splits.
 * For the tender, stinging moment of a song: quiet is a dim, defocused pearl; the chorus is sharp,
 * bright and busy with light.
 *
 * How the light is made: the "glass" is a height field h built from a few sine waves, so its slope
 * and curvature are exact and cheap. Light bunches up where the refracted grid p + s∇h collapses,
 * i.e. where det(I + s·Hess h) = 1 + s·tr + s²·det goes to zero. That determinant is a polynomial in
 * the refraction strength s, so the three spectral taps (three slightly different s) cost nothing
 * extra: where they agree the light is white, where they part it fringes. Four layers at different
 * focus: a soft net of pools (flat space), arcs that run round the core, a second set of arcs swung
 * from a pivot off-frame so the filaments cross, and quills that run out of the core (the last three
 * in log-polar space, with whole angular numbers so the seam closes). On top: snare needles, hat
 * glints and the core's own glow, all through one soft exposure curve.
 *
 * Palette roles: bg = the shadow tone of the field, muted = the mid-tone haze, fg = the light itself,
 * accent and accent2 = the two fringe hues (the third fringe is their complement about fg, so the
 * three always add back up to fg).
 */
import type { ClockDef } from './lib';
import { num } from '../../core/uniforms';
import { HM_LIB, defineClockedShaderScene, sinceKickClock, speedClock } from './lib';

const fragment = /* glsl */ `
${HM_LIB}
// one sine wave of the glass: adds its slope to g and its curvature to H = (xx, yy, xy).
// Amplitude is w / |k|², so every wave bends the light by the same amount whatever its size.
void prWave(vec2 u, vec2 k, float w, float ph, inout vec2 g, inout vec3 H) {
  float th = dot(k, u) + ph;
  float a = w / dot(k, k);
  g += a * k * cos(th);
  H -= a * sin(th) * vec3(k.x * k.x, k.y * k.y, k.x * k.y);
}

// soft pools: the big slow swells of the glass
void prPools(vec2 u, float t, out vec2 g, out vec3 H) {
  g = vec2(0.0); H = vec3(0.0);
  prWave(u, vec2( 1.00,  0.31), 0.36,  t * 0.61, g, H);
  prWave(u, vec2(-0.47,  1.13), 0.32, -t * 0.47 + 1.7, g, H);
  prWave(u, vec2( 1.21, -1.36), 0.28,  t * 0.83 + 4.1, g, H);
  prWave(u, vec2(-1.93, -0.62), 0.24, -t * 0.71 + 2.9, g, H);
}

// arcs: ripples that run round a centre. u = (log radius, angle); whole angular numbers close the seam
void prArcs(vec2 u, float t, out vec2 g, out vec3 H) {
  g = vec2(0.0); H = vec3(0.0);
  prWave(u, vec2(  7.0,  2.0), 0.30,  t * 0.52, g, H);
  prWave(u, vec2(-10.0,  3.0), 0.28,  t * 0.43 + 2.3, g, H);
  prWave(u, vec2( 13.0, -5.0), 0.26, -t * 0.67 + 0.9, g, H);
  prWave(u, vec2(  4.0,  7.0), 0.24,  t * 0.37 + 5.2, g, H);
  prWave(u, vec2(-16.0,  4.0), 0.20, -t * 0.79 + 3.6, g, H);
}

// quills: fine facets that run out from the core
void prQuills(vec2 u, float t, out vec2 g, out vec3 H) {
  g = vec2(0.0); H = vec3(0.0);
  prWave(u, vec2(  2.0,   9.0), 0.34,  t * 0.71, g, H);
  prWave(u, vec2( -3.0,  13.0), 0.30, -t * 0.58 + 1.1, g, H);
  prWave(u, vec2(  4.0,  -7.0), 0.28,  t * 0.44 + 3.9, g, H);
  prWave(u, vec2( -1.0, -17.0), 0.22, -t * 0.93 + 5.5, g, H);
}

// light per spectral tap: 1 / |det(I + s·H)| for three refraction strengths, softened by the focus
vec3 prCaustic(vec3 H, float s, float split, float eps) {
  float tr = H.x + H.y;
  float dt = H.x * H.y - H.z * H.z;
  vec3 sv = s * (1.0 + split * vec3(-1.0, 0.0, 1.0));
  vec3 D = 1.0 + sv * tr + sv * sv * dt;
  float e = max(eps, fwidth(D.y) * 0.75);
  vec3 c = 1.0 / sqrt(D * D + e * e);
  // inside a fold three sheets of light overlap
  c *= 1.0 + 0.6 * (1.0 - smoothstep(-0.3, 0.1, D));
  // the taps only part company on the brights, so shadows stay neutral
  return mix(vec3(c.y), c, 1.0 - smoothstep(0.5, 1.5, abs(D.y)));
}

// thin curved needles round the core, one per angular slot. reach pushes them outward; fan = (direction,
// cosine of the half-width) keeps them to one side. The three taps sit at slightly different angles,
// which fringes each needle.
vec3 prNeedles(float r, float ang, float slots, float seed, float reach, vec2 fan, float wild, float split, float px) {
  float a = (ang / TAU + 0.5) * slots;
  float id = mod(floor(a), slots);
  float f = fract(a) - 0.5;
  vec3 h = vec3(hash11(id * 7.31 + seed * 13.7 + 1.0), hash11(id * 3.17 + seed * 5.3 + 2.0), hash11(id * 5.71 + seed * 9.1 + 3.0));
  float keep = smoothstep(fan.y, fan.y + 0.35, cos(ang - fan.x));
  if (h.x < 0.5 || keep <= 0.0) return vec3(0.0);
  float r0 = 0.03 + 0.13 * h.y + reach * (0.12 + 0.5 * h.z);
  float len = (0.05 + 0.2 * h.z) * (0.6 + 1.4 * reach);
  float x = (r - r0) / len;
  if (x < 0.0 || x > 1.0) return vec3(0.0);
  float off = (h.z - 0.5) * 0.3;
  float tilt = (h.x - 0.71) * 1.1 * wild * x;
  float bend = (h.y - 0.5) * (0.2 + 0.3 * wild) * x * x;
  float d = (f - off - tilt - bend) * (TAU / slots) * r;
  float w = max(0.004 * (1.0 - x) * (0.4 + h.y), px);
  vec3 dd = (vec3(d) + split * 0.005 * vec3(-1.0, 0.0, 1.0)) / w;
  return keep * smoothstep(0.0, 0.12, x) * (1.0 - x) * (0.4 + h.x) * exp(-dd * dd);
}

// pin glints: one tiny four-point star per cell, a different handful on every hat
float prGlints(vec2 p, float seed, float px) {
  vec2 g = p * 6.0;
  vec2 id = floor(g);
  vec2 h = hash22(id + seed * 17.3);
  if (h.x > 0.3) return 0.0;
  vec2 d = (fract(g) - 0.5 - (hash22(id * 1.7 + seed * 3.1) - 0.5) * 0.56) / 6.0;
  float w = px * 2.0;
  float s = 0.7 + 2.3 * h.y;
  float pin = exp(-dot(d, d) / (w * w * s));
  float arms = exp(-abs(d.x) / (0.012 * s)) * exp(-d.y * d.y / (px * px)) + exp(-abs(d.y) / (0.007 * s)) * exp(-d.x * d.x / (px * px));
  return (pin + 0.6 * arms) * (0.5 + h.y);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float tall = 1.0 - smoothstep(0.7, 1.3, uAspect);
  float px = 1.0 / uResolution.y;
  float t = u_clk;

  // the song's arc
  float e = uEnergy;
  float tens = max(uBuild, uFeelTension);
  float sd = u_sinceDrop;
  float white = exp(-sd * 3.5);                               // the white-out
  float spill = (1.0 - exp(-sd * 2.5)) * exp(-sd * 0.5);      // then the light spills back out
  float sk = u_sinceKick;
  float kAmp = u_flare * u_kickAmp * exp(-sk * 2.0);

  // the core sits off-centre and above the lyric zone
  vec2 core = vec2(-0.2 * min(uAspect, 1.9) * (1.0 - 0.55 * tall), 0.09 + 0.07 * tall);
  core += 0.018 * vec2(sin(t * 0.21), cos(t * 0.17));
  vec2 q = p - core;

  // the glass is not perfect: a slow, large warp of everything
  vec2 wq = q * 1.3;
  vec2 warp = vec2(snoise(vec3(wq, t * 0.05)), snoise(vec3(wq + 7.3, -t * 0.04)));
  q += warp * 0.09;
  float r = length(q);
  float ang = atan(q.y, q.x);

  // kick: a flare leaves the core and travels out along the filaments
  float kx = (r - 0.02 - sk * 0.9) / (0.05 + 0.2 * sk);
  float ring = kAmp * exp(-kx * kx);

  // focus: energy pulls it sharp. The focal plane is shallow, so some of the glass is always soft:
  // patches of it, the far edges and the lyric zone at the bottom. A build tightens all of it.
  float calm = 1.0 - smoothstep(0.04, 0.46, vUv.y);
  float sharp = clamp(u_focus * (0.3 + 0.85 * e + 0.6 * tens), 0.0, 1.0);
  float fz = 0.5 + 0.5 * sin(3.0 * warp.x + 2.0 * warp.y + 1.0);
  float soft = (0.6 + 1.1 * fz) * (1.0 + 0.6 * smoothstep(0.3, 1.0, r) + calm);
  float eps = min(mix(0.7, 0.07, sharp) * mix(soft, 0.8, tens), 0.85);
  // fold: how hard the glass bends the light (bass, the kick's ring and the build all fold it more)
  float fold = u_fold * (0.75 + 0.45 * e + 0.5 * uBass + 0.5 * tens + 0.7 * ring + 0.5 * spill);
  float split = min(u_split * (0.35 + 0.5 * uAir + 0.3 * uBrightness + 1.5 * spill), 0.62);

  vec2 g;
  vec3 H;

  // layer 1, far and soft: a net of pools
  vec2 uA = rot2(u_rot * 0.4 + 0.6) * q * (8.0 * u_scale);
  float sA = fold * 1.5;
  prPools(uA, t, g, H);
  prPools(uA - sA * g, t, g, H);
  prPools(uA - sA * g, t, g, H);
  vec3 cA = prCaustic(H, sA, split * 1.5, eps * 1.1 + 0.14);

  // layer 2: arcs round the core, in log-polar space
  vec2 qB = q + 0.035 * vec2(sin(q.y * 9.0 + t * 0.31), cos(q.x * 8.0 - t * 0.23));
  vec2 uP = vec2(3.0 * u_scale * log(length(qB) + 0.1) + u_flow, atan(qB.y, qB.x) + u_rot);
  float sB = fold * 1.25;
  prArcs(uP, t, g, H);
  prArcs(uP - sB * g, t, g, H);
  vec3 cB = prCaustic(H, sB, split, eps);

  // layer 3, near and sharp: a second set of arcs swung from a pivot off to one side, so the
  // filaments cross instead of nesting
  vec2 q2 = q - vec2(0.55, -1.0);
  vec2 uS = vec2(6.0 * u_scale * log(length(q2) + 0.1) - 0.6 * u_flow, 3.0 * atan(q2.y, q2.x) - 0.5 * u_rot);
  float sS = fold * 1.2;
  prArcs(uS, t * 0.8 + 11.0, g, H);
  prArcs(uS - sS * g, t * 0.8 + 11.0, g, H);
  vec3 cS = prCaustic(H, sS, split * 0.8, eps * 0.6);

  // layer 4: quills that run out of the core
  vec2 uQ = vec2(uP.x * 0.8, ang - u_rot * 0.6);
  float sC = fold * 1.1;
  prQuills(uQ, t * 1.3, g, H);
  prQuills(uQ - sC * g, t * 1.3, g, H);
  vec3 cC = prCaustic(H, sC, split * 0.8, eps * 0.75);

  // keep the lower part of the frame calmer, for lyrics; each layer only catches the light in places
  float near = exp(-r * r / 0.16);
  float wA = 0.55 * (1.0 - 0.5 * tens) * (1.0 - 0.3 * calm);
  float wB = (0.32 + 0.22 * e) * (0.12 + 0.88 * smoothstep(-0.5, 0.35, warp.x)) * (1.0 - 0.65 * calm);
  float wS = (0.08 + 0.5 * e + 0.2 * tens) * smoothstep(-0.45, 0.4, warp.y) * (1.0 - 0.8 * calm);
  float wC = (0.1 + 0.45 * e + 0.3 * tens) * near * smoothstep(0.02, 0.1, r) * (1.0 - 0.7 * calm);
  wC *= 0.15 + 0.85 * smoothstep(-0.3, 0.7, sin(ang * 2.0 - u_rot * 0.8 + 3.0 * warp.x));
  vec3 lum = wA * cA + wB * cB + wS * cS + wC * cC;
  lum *= 1.0 + 4.0 * ring;
  lum += 0.7 * ring;

  // needles: a few always sit round the core; each snare throws a fresh fan to one side
  float ss = u_sinceSnare;
  vec2 qn = q - vec2(0.035, -0.02);
  vec3 nd = prNeedles(length(qn), atan(qn.y, qn.x) + u_rot * 0.5, 11.0, 3.0, 0.0, vec2(0.0, -2.0), 1.0, split, px) * e * (0.2 + 0.8 * e);
  float fanDir = hash11(u_snareN * 3.7 + 0.5) * TAU;
  nd += prNeedles(r, ang - u_rot * 0.3, 58.0, u_snareN, ss * 1.8, vec2(fanDir, -0.1), 0.0, split, px) * 6.0 * exp(-ss * 5.0);
  lum += nd * u_needles * 5.0;

  // hats: pin glints, only where there is already light
  float gl = prGlints(rot2(0.4) * p, u_hatN, px * max(1.0, uResolution.y / 1080.0)) * uHat * u_glints;
  lum += gl * 12.0 * smoothstep(0.6, 2.0, lum.y);

  // the core itself: a hot point inside a wide soft halo. A build pinches it tight.
  float hot = (2.0 + 2.6 * e + 1.8 * uKick * u_flare + 1.5 * tens) / (1.0 + r * r / (0.003 + 0.005 * e + 0.02 * uKick * u_flare));
  float halo = (0.55 + 0.5 * e) * (1.0 + 0.12 * sin(t * 0.9)) * (1.0 - 0.7 * tens) / (1.0 + r * r / 0.1);
  lum += hot + halo + 5.0 * white / (1.0 + r * r / (0.02 + 0.12 * white));

  // drop: a ring of split light spreads from the core
  vec3 rr = (r - sd * 0.4 * (1.0 + 0.3 * vec3(-1.0, 0.0, 1.0))) / (0.05 + 0.07 * sd);
  lum += 2.6 * spill * exp(-rr * rr);

  // falloff; a build darkens the field round the core
  lum *= 1.0 - 0.45 * smoothstep(0.35, 1.2, r);
  lum *= mix(1.0, 0.04 + 1.4 * exp(-r * r / 0.06), 0.9 * min(tens * 1.15, 1.0));

  // exposure → pearl
  float expo = u_exposure * (0.25 + 0.31 * e + 0.08 * uLevel) * (1.0 - 0.3 * calm) * (1.0 + 1.5 * white);
  vec3 I = 1.0 - exp(-lum * expo);

  float haze = 0.5 + 0.5 * snoise(q * 1.1 + vec2(t * 0.03, -t * 0.02));
  vec3 shadow = mix(uBg, uMuted, haze * (0.35 + 0.4 * e) * (1.0 - 0.6 * tens));
  // the shadows lean a little cool on one side of the glass and warm on the other
  shadow += 0.1 * (uAccent - shadow) * smoothstep(0.0, 0.8, warp.y) + 0.08 * (uAccent2 - shadow) * smoothstep(0.0, 0.8, -warp.y);
  // fringe hues are pushed past the accents on dark palettes (the middle tap then runs hot, which is
  // the overexposed pearl); on paper palettes the light is ink and the accents are used as they are
  float sat = mix(1.8, 1.0, hmIsLight());
  vec3 tA = uFg + sat * (uAccent - uFg);
  vec3 tC = uFg + sat * (uAccent2 - uFg);
  vec3 tB = max(3.0 * uFg - tA - tC, 0.0);
  // where all three taps land together the light is exactly fg again
  vec3 whole = uFg - (tA + tB + tC) / 3.0;
  vec3 col = shadow + (I.x * (tA - shadow) + I.y * (tB - shadow) + I.z * (tC - shadow)) / 3.0;
  col += whole * min(I.x, min(I.y, I.z));

  col += hmGrain(fc, uTime) * 0.035;
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

/** Strength of the last kick, held until the next one. */
const kickAmpClock: ClockDef = { step: (v, f) => (f.audio.kickHit ? Math.max(0.5, f.audio.kick) : v) };

/** Seconds since the last snare. */
const sinceSnareClock: ClockDef = {
  init: 100,
  step: (v, f) => (f.audio.snareHit ? 0 : Math.min(v + f.dt, 100)),
};

/** Counts hits (wraps at 997): a fresh seed for each fan of needles / handful of glints. */
const countClock = (hit: (f: Parameters<ClockDef['step']>[1]) => boolean): ClockDef => ({
  step: (v, f) => (hit(f) ? (v + 1) % 997 : v),
});

export const prism = defineClockedShaderScene(
  {
    id: 'prism',
    name: 'Prism',
    description:
      'Light through cut crystal, out of focus and a little overexposed: pearly caustic filaments curve round a glowing core, with thin spectral fringes where the light splits. Quiet parts are a dim, soft pearl; energy pulls it into focus. Bass folds and turns the glass, each kick sends a flare out along the filaments, snares throw a fan of needles, hats are pin glints. A build tightens and darkens round the core, and a drop whites out, then spills back as a slow spectral bloom.',
    category: 'field',
    style: 'light',
    fragment,
    tags: ['tender', 'dreamy', 'euphoric', 'cinematic', 'ambient', 'romantic', 'uplifting', 'spacious', 'pop', 'melancholic', 'warm', 'organic'],
    params: [
      { id: 'scale', label: 'Facet size', group: 'Shape', type: 'number', min: 0.5, max: 2, step: 0.01, default: 1, hint: 'Higher is a finer cut: more, thinner filaments' },
      { id: 'fold', label: 'Refraction', group: 'Shape', type: 'number', min: 0.3, max: 2, step: 0.01, default: 1, hint: 'How hard the glass bends the light; more folds it into more filaments' },
      { id: 'focus', label: 'Focus', group: 'Shape', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.9, hint: 'Low stays a soft pearl; high lets energy pull the filaments sharp' },
      { id: 'turn', label: 'Turn', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3, hint: 'How fast the crystal turns (bass turns it faster)' },
      { id: 'speed', label: 'Shimmer', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
      { id: 'flare', label: 'Kick flare', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.9, hint: 'Each kick blooms the core and sends light out along the filaments' },
      { id: 'needles', label: 'Snare needles', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.9 },
      { id: 'glints', label: 'Hat glints', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8 },
      { id: 'split', label: 'Spectral split', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'Width of the coloured fringes (air and brightness widen it)' },
      { id: 'exposure', label: 'Exposure', group: 'Color', type: 'number', min: 0.4, max: 2, step: 0.01, default: 1 },
    ],
    modulations: [
      { source: 'sub', param: 'fold', amount: 0.12 },
      { source: 'air', param: 'split', amount: 0.2 },
      { source: 'sway', param: 'exposure', amount: 0.05 },
    ],
  },
  {
    clk: speedClock('speed', 0.3, (f) => 0.5 + 1.1 * f.audio.energy + 0.3 * f.audio.mid + 0.7 * Math.max(f.audio.build, f.feel.tension)),
    // the crystal's turn: always moving, faster with bass. Wraps at 20π, where every layer closes.
    rot: {
      step: (v, f) =>
        (v + f.dt * num(f.params, 'turn', 0.3) * (0.22 + 0.9 * f.audio.bass + 0.45 * f.audio.energy)) % (20 * Math.PI),
    },
    sinceDrop: sinceDropClock,
    // radial drift of the arcs: out a little all the time, in toward the core during a build, out
    // fast after a drop. Wraps at 10π, where every layer closes.
    flow: {
      step: (v, f, s) =>
        (v + f.dt * (-0.04 - 0.12 * f.audio.energy + 1.1 * Math.max(f.audio.build, f.feel.tension) - 2.4 * Math.exp(-s.sinceDrop * 1.4))) %
        (10 * Math.PI),
    },
    sinceKick: sinceKickClock,
    kickAmp: kickAmpClock,
    sinceSnare: sinceSnareClock,
    snareN: countClock((f) => f.audio.snareHit),
    hatN: countClock((f) => f.audio.hatHit),
  },
);
