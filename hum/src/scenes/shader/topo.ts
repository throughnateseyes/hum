import { HM_LIB, defineClockedShaderScene, kickCountClock, sinceKickClock, speedClock, type ClockDef } from './lib';
import type { FrameContext } from '../../core/types';

const fragment = /* glsl */ `
${HM_LIB}

// one kick event: a mound that pops up, overshoots into a crater and settles,
// plus a raised ring that runs outward and bunches the contours as it passes
float kickBump(vec2 p, float age, float seed, float amp) {
  if (age > 4.0) return 0.0;
  vec2 kc = (vec2(hash11(seed * 1.37 + 0.11), hash11(seed * 2.71 + 0.53)) - 0.5) * vec2(uAspect * 0.7, 0.7);
  vec2 d = p - kc;
  float r2 = dot(d, d);
  float snap = (1.0 - exp(-age * 38.0)) * exp(-age * 3.2) * cos(age * 8.0);
  float h = u_punch * 0.75 * snap * exp(-r2 * 26.0);
  float front = sqrt(r2) - age * 0.85;
  float fade = exp(-age * 1.5);
  h += u_ripple * fade * (0.32 * exp(-front * front * 140.0) + 0.1 * sin(front * 40.0) * exp(-front * front * 45.0));
  return h * amp;
}

// drop shatter: voronoi plates, each jolted to its own height (+ a little slide)
vec3 plates(vec2 p) {
  vec2 g = p * 3.2;
  vec2 i = floor(g);
  vec2 f = fract(g);
  float best = 8.0;
  vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 r = o + hash22(i + o) - f;
    float d = dot(r, r);
    if (d < best) { best = d; id = i + o; }
  }
  return vec3(id, hash21(id + 7.3));
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float pxs = max(1.0, uResolution.y / 1080.0);
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float t = u_clk;

  // build tension: the map winds into a slow whirl around the centre
  float tens = uBuild * (1.0 - uDrop) * u_tension;
  float rr = length(p);
  p = rot2(tens * 1.1 * exp(-rr * 2.2)) * p;
  p *= 1.0 + tens * 0.2; // contract (features pulled in)

  // drop shatter: plates jolt apart and slide
  float sh = uDrop * u_shatter;
  vec3 pl = vec3(0.0);
  if (sh > 0.002) {
    pl = plates(p + vec2(t * 0.05, 0.0));
    p += (hash22(pl.xy + 3.1) - 0.5) * sh * 0.08;
  }

  // evolving height field
  vec2 q = p * u_scale;
  float h = fbm(q + vec2(t * 0.13, -t * 0.07), 5);
  h += 0.35 * snoise(q * 0.45 - vec2(t * 0.05, t * 0.03));
  if (sh > 0.002) h += (pl.z - 0.5) * sh * 1.6;

  // bass lifts a broad, wandering hill; the spectrum carves lobes around it
  vec2 hc = vec2(sin(t * 0.21) * 0.35 * uAspect, cos(t * 0.17) * 0.25);
  vec2 dh = p - hc;
  float hr2 = dot(dh, dh);
  h += u_lift * (0.2 + 0.9 * uBass + 0.4 * uSub) * exp(-hr2 * 3.5);
  if (u_spectrum > 0.001) {
    float bin = abs(atan(dh.y, dh.x)) / PI * 0.8 + 0.03;
    float sp = (spectrum(bin - 0.03) + spectrum(bin) + spectrum(bin + 0.03)) / 3.0;
    float hr = sqrt(hr2);
    h += u_spectrum * 0.75 * sp * exp(-hr2 * 4.0) * smoothstep(0.0, 0.12, hr);
  }

  // kicks (three alive at once so fast patterns overlap instead of cutting off)
  h += kickBump(p, u_k0Age, u_k0Seed, u_k0Amp);
  h += kickBump(p, u_k1Age, u_k1Seed, u_k1Amp);
  h += kickBump(p, u_k2Age, u_k2Seed, u_k2Amp);

  // contour lines (hairline, anti-aliased with screen-space derivatives)
  float dens = u_density * (1.0 + 0.8 * uEnergy) * (1.0 + tens * 1.1);
  float L = h * dens;
  float fw = max(fwidth(L), 0.0001);
  float dl = abs(fract(L + 0.5) - 0.5) / fw;
  float idx = floor(L + 0.5);
  float major = 1.0 - step(0.5, mod(idx, max(u_major, 1.0)));
  float lw = u_lineWidth * pxs * (1.0 + 0.6 * major);
  float line = 1.0 - smoothstep(lw * 0.5 - 0.5, lw * 0.5 + 0.5, dl);
  line *= 1.0 - smoothstep(0.35, 0.9, fw); // fade where lines would merge into grey (also breaks lines at plate edges)

  vec3 col = uBg;
  col = mix(col, uMuted, u_fill * 0.6 * smoothstep(-0.6, 0.9, h));
  vec3 ink = mix(uFg, uAccent, major);
  col = mix(col, ink, line * mix(0.7, 0.95, major));

  // the newest ripple front glows briefly in accent2 where it crosses lines
  vec2 kc = (vec2(hash11(u_kickN * 1.37 + 0.11), hash11(u_kickN * 2.71 + 0.53)) - 0.5) * vec2(uAspect * 0.7, 0.7);
  float age = u_sinceKick;
  float front = length(p - kc) - age * 0.85;
  float ring = exp(-front * front * 200.0) * exp(-age * 1.5);
  col = mix(col, uAccent2, clamp(ring * min(u_ripple, 1.0) * line * 0.8, 0.0, 1.0));

  // crosshair + kick counter at the ripple origin
  vec2 kpx = (kc / vec2(uAspect, 1.0) + 0.5) * uResolution;
  vec2 dk = fc - kpx;
  float crossA = clamp(exp(-age * 0.8), 0.0, 1.0);
  float xh = 0.0;
  if ((abs(dk.x) < 0.5 * pxs + 0.25 && abs(dk.y) < 7.0 * pxs && abs(dk.y) > 2.0 * pxs) ||
      (abs(dk.y) < 0.5 * pxs + 0.25 && abs(dk.x) < 7.0 * pxs && abs(dk.x) > 2.0 * pxs)) xh = 1.0;
  xh = max(xh, hmNumber(floor((dk - vec2(9.0, 3.0) * pxs) / (2.0 * pxs)), u_kickN, 3.0));
  col = mix(col, uAccent2, xh * crossA * step(0.01, u_ripple + u_punch));

  // hairline frame inset
  vec2 e = min(fc, uResolution - fc);
  float inset = 18.0 * pxs;
  float frame = (abs(min(e.x, e.y) - inset) < 0.5 * pxs + 0.25 && e.x >= inset - 1.0 && e.y >= inset - 1.0) ? 1.0 : 0.0;
  col = mix(col, uFg, frame * 0.5 * u_frame);

  // paper tooth (static)
  col += (hash21(fc) - 0.5) * 0.025;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* Three kick slots: kick n lands in slot n % 3 (kickN is stepped first, so slots see the new count). */
const slotHit = (i: number, f: FrameContext, s: Record<string, number>) =>
  f.audio.kickHit && Math.round(s.kickN) % 3 === i;
const kickSlot = (i: number): Record<string, ClockDef> => ({
  [`k${i}Age`]: { init: 100, step: (v, f, s) => (slotHit(i, f, s) ? 0 : Math.min(v + f.dt, 100)) },
  [`k${i}Seed`]: { step: (v, f, s) => (slotHit(i, f, s) ? s.kickN : v) },
  [`k${i}Amp`]: { step: (v, f, s) => (slotHit(i, f, s) ? 0.55 + Math.min(1, f.audio.kick) * 0.45 : v) },
});

export const topo = defineClockedShaderScene(
  {
    id: 'topo',
    name: 'Topo',
    description:
      'Topographic contour lines of an evolving noise terrain — hairline strokes on cream, every Nth line in the accent colour. Bass lifts a wandering hill and the spectrum carves lobes into it, each kick pops a mound and sends a ridge running outward (with a tiny crosshair), builds wind the map into a tightening whirl and a drop shatters it into plates.',
    category: 'field',
    style: 'data',
    fragment,
    tags: ['minimal', 'editorial', 'calm', 'scientific', 'clean', 'map', 'instrument', 'focused'],
    light: true,
    params: [
      { id: 'scale', label: 'Scale', group: 'Shape', type: 'number', min: 0.5, max: 4, step: 0.01, default: 1.5 },
      { id: 'density', label: 'Line density', group: 'Shape', type: 'number', min: 4, max: 40, step: 0.1, default: 12 },
      { id: 'lineWidth', label: 'Line width', group: 'Shape', type: 'number', min: 0.5, max: 3, step: 0.05, default: 1 },
      { id: 'major', label: 'Accent every', group: 'Shape', type: 'number', min: 2, max: 10, step: 1, default: 5 },
      { id: 'speed', label: 'Speed', group: 'Motion', type: 'number', min: 0, max: 0.6, step: 0.005, default: 0.08 },
      { id: 'lift', label: 'Bass lift', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 0.8 },
      { id: 'ripple', label: 'Kick ripple', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'A raised ridge that runs outward from each kick' },
      { id: 'punch', label: 'Kick punch', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Each kick pops a mound that rebounds into a crater' },
      { id: 'shatter', label: 'Drop shatter', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'The drop cracks the map into jolted plates that settle back' },
      { id: 'spectrum', label: 'Spectrum lobes', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'The spectrum carves lobes around the bass hill (by angle)' },
      { id: 'tension', label: 'Build tension', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Build-ups wind the map into a whirl, pack the lines tighter and speed it up' },
      { id: 'fill', label: 'Elevation tint', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
      { id: 'frame', label: 'Frame', group: 'Color', type: 'bool', default: true },
    ],
    modulations: [
      { source: 'energy', param: 'density', amount: 0.12 },
      { source: 'bass', param: 'lift', amount: 0.2 },
      { source: 'sway', param: 'scale', amount: 0.04 },
    ],
  },
  {
    // integrated terrain time: calm in silence, quicker in builds, a lurch on the drop
    clk: speedClock(
      'speed',
      0.08,
      (f) =>
        0.45 +
        0.9 * f.audio.energy +
        0.3 * f.audio.bass +
        1.6 * f.audio.build * (1 - f.audio.drop) * (typeof f.params.tension === 'number' ? f.params.tension : 0.6) +
        3.0 * f.audio.drop,
    ),
    sinceKick: sinceKickClock,
    kickN: kickCountClock,
    ...kickSlot(0),
    ...kickSlot(1),
    ...kickSlot(2),
  },
);
