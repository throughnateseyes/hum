import { HM_LIB, defineClockedShaderScene, kickCountClock, sinceKickClock, speedClock } from './lib';

const fragment = /* glsl */ `
${HM_LIB}
void main() {
  vec2 fc = gl_FragCoord.xy;
  float pxs = max(1.0, uResolution.y / 1080.0);
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float t = u_clk;

  // evolving height field
  vec2 q = p * u_scale;
  float h = fbm(q + vec2(t * 0.13, -t * 0.07), 5);
  h += 0.35 * snoise(q * 0.45 - vec2(t * 0.05, t * 0.03));

  // bass lifts a broad, wandering hill
  vec2 hc = vec2(sin(t * 0.21) * 0.35 * uAspect, cos(t * 0.17) * 0.25);
  vec2 dh = p - hc;
  h += u_lift * (0.2 + 0.9 * uBass + 0.4 * uSub) * exp(-dot(dh, dh) * 3.5);

  // each kick drops a ripple at a random spot
  vec2 kc = (vec2(hash11(u_kickN * 1.37 + 0.11), hash11(u_kickN * 2.71 + 0.53)) - 0.5) * vec2(uAspect * 0.7, 0.7);
  float age = u_sinceKick;
  float rd = length(p - kc);
  float front = rd - age * 0.55;
  float fade = exp(-age * 1.6);
  h += u_ripple * 0.35 * sin(front * 40.0) * exp(-front * front * 81.0) * fade;

  // contour lines (hairline, anti-aliased with screen-space derivatives)
  float dens = u_density * (1.0 + 0.8 * uEnergy);
  float L = h * dens;
  float fw = max(fwidth(L), 0.0001);
  float dl = abs(fract(L + 0.5) - 0.5) / fw;
  float idx = floor(L + 0.5);
  float major = 1.0 - step(0.5, mod(idx, max(u_major, 1.0)));
  float lw = u_lineWidth * pxs * (1.0 + 0.6 * major);
  float line = 1.0 - smoothstep(lw * 0.5 - 0.5, lw * 0.5 + 0.5, dl);
  line *= 1.0 - smoothstep(0.35, 0.9, fw); // fade where lines would merge into grey

  vec3 col = uBg;
  col = mix(col, uMuted, u_fill * 0.6 * smoothstep(-0.6, 0.9, h));
  vec3 ink = mix(uFg, uAccent, major);
  col = mix(col, ink, line * mix(0.7, 0.95, major));
  // the ripple front glows briefly in accent2 where it crosses lines
  float ring = exp(-front * front * 200.0) * fade;
  col = mix(col, uAccent2, clamp(ring * u_ripple * line * 0.8, 0.0, 1.0));

  // crosshair + kick counter at the ripple origin
  vec2 kpx = (kc / vec2(uAspect, 1.0) + 0.5) * uResolution;
  vec2 dk = fc - kpx;
  float crossA = clamp(exp(-age * 0.8), 0.0, 1.0);
  float xh = 0.0;
  if ((abs(dk.x) < 0.5 * pxs + 0.25 && abs(dk.y) < 7.0 * pxs && abs(dk.y) > 2.0 * pxs) ||
      (abs(dk.y) < 0.5 * pxs + 0.25 && abs(dk.x) < 7.0 * pxs && abs(dk.x) > 2.0 * pxs)) xh = 1.0;
  xh = max(xh, hmNumber(floor((dk - vec2(9.0, 3.0) * pxs) / (2.0 * pxs)), u_kickN, 3.0));
  col = mix(col, uAccent2, xh * crossA * step(0.01, u_ripple));

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

export const topo = defineClockedShaderScene(
  {
    id: 'topo',
    name: 'Topo',
    description:
      'Topographic contour lines of an evolving noise terrain — hairline strokes on cream, every Nth line in the accent colour. Bass lifts a wandering hill, each kick drops a ripple (with a tiny crosshair), energy densifies the lines.',
    category: 'field',
    fragment,
    tags: ['minimal', 'editorial', 'calm', 'scientific', 'clean', 'map', 'instrument', 'focused'],
    light: true,
    params: [
      { id: 'scale', label: 'Scale', group: 'Shape', type: 'number', min: 0.5, max: 4, step: 0.01, default: 1.5 },
      { id: 'density', label: 'Line density', group: 'Shape', type: 'number', min: 4, max: 40, step: 0.1, default: 12 },
      { id: 'lineWidth', label: 'Line width', group: 'Shape', type: 'number', min: 0.5, max: 3, step: 0.05, default: 1 },
      { id: 'major', label: 'Accent every', group: 'Shape', type: 'number', min: 2, max: 10, step: 1, default: 5 },
      { id: 'speed', label: 'Speed', group: 'Motion', type: 'number', min: 0, max: 0.6, step: 0.005, default: 0.08 },
      { id: 'lift', label: 'Bass lift', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 0.8 },
      { id: 'ripple', label: 'Kick ripple', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
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
    clk: speedClock('speed', 0.08, (f) => 0.5 + 1.0 * f.audio.energy + 0.3 * f.audio.bass),
    sinceKick: sinceKickClock,
    kickN: kickCountClock,
  },
);
