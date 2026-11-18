import type { EffectDef } from '../../core/types';
import { GLSL_MIRROR_UV, GLSL_TRIGGER, pBool, pNum, pReactive, pSelect, pTrigger } from './shared';

/* ───────────────────────── kaleido ───────────────────────── */

const kaleido: EffectDef = {
  id: 'kaleido',
  name: 'Kaleidoscope',
  description: 'Mirrored radial segments with optional tempo-locked spin.',
  category: 'distort',
  params: [
    pNum('segments', 'Segments', 2, 16, 6, 1),
    pNum('rotation', 'Rotation', 0, 360, 0, 1),
    pNum('spin', 'Spin', -1, 1, 0.1, 0.01, { group: 'Motion' }),
    pBool('tempoLock', 'Lock spin to tempo', true, { group: 'Motion', hint: 'Spin advances per beat instead of per second' }),
    pNum('zoom', 'Zoom', 0.5, 3, 1, 0.01),
    pReactive(0.5),
  ],
  fragment: /* glsl */ `
${GLSL_MIRROR_UV}
void main() {
  float n = max(2.0, floor(u_segments + 0.5));
  float seg = TAU / n;
  float beats = mod(uBeatCount + uBeatPhase, 1024.0);
  float spin = u_tempoLock > 0.5 ? u_spin * beats * seg * 0.5 : u_spin * uTime * 0.4;
  float ang = radians(u_rotation) + spin;
  float z = max(u_zoom, 0.05) * (1.0 + u_reactive * (uKick * 0.12 + uBass * 0.05));
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0) / z;
  float r = length(p);
  float a = atan(p.y, p.x + 1e-6) + ang;
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  vec2 q = vec2(cos(a), sin(a)) * r;
  q.x /= uAspect;
  vec2 uv = fx_mirrorUv(q + 0.5);
  gl_FragColor = vec4(texture2D(tInput, uv).rgb, 1.0);
}
`,
};

/* ───────────────────────── mirror ───────────────────────── */

const mirror: EffectDef = {
  id: 'mirror',
  name: 'Mirror',
  description: 'Reflects one half (or quarter) of the frame onto the other.',
  category: 'distort',
  params: [
    pSelect(
      'mode',
      'Mode',
      [
        ['horizontal', 'Horizontal'],
        ['vertical', 'Vertical'],
        ['quad', 'Quad'],
      ],
      'horizontal',
    ),
    pBool('flip', 'Flip source side', false),
    pNum('center', 'Axis offset', -0.3, 0.3, 0, 0.01),
  ],
  fragment: /* glsl */ `
void main() {
  vec2 uv = vUv;
  float s = u_flip > 0.5 ? -1.0 : 1.0;
  vec2 c = vec2(0.5 + u_center);
  if (u_mode < 0.5 || u_mode > 1.5) uv.x = c.x - s * abs(uv.x - c.x);
  if (u_mode > 0.5) uv.y = c.y - s * abs(uv.y - c.y);
  gl_FragColor = vec4(texture2D(tInput, clamp(uv, 0.0, 1.0)).rgb, 1.0);
}
`,
};

/* ───────────────────────── displace ───────────────────────── */

const displace: EffectDef = {
  id: 'displace',
  name: 'Displace',
  description: 'Noise or wave displacement of the image, swelling with the bass.',
  category: 'distort',
  params: [
    pSelect(
      'mode',
      'Mode',
      [
        ['noise', 'Noise'],
        ['wave', 'Wave'],
      ],
      'noise',
    ),
    pNum('amount', 'Amount', 0, 1, 0.3, 0.01),
    pNum('scale', 'Scale', 0.5, 10, 3, 0.1),
    pNum('speed', 'Speed', 0, 2, 0.3, 0.01),
    pReactive(0.6),
  ],
  fragment: /* glsl */ `
${GLSL_MIRROR_UV}
void main() {
  float amt = u_amount * (1.0 + u_reactive * (uBass * 1.5 + uKick * 1.0 + uDrop * 1.0));
  float t = uTime * u_speed;
  vec2 p = vec2(vUv.x * uAspect, vUv.y) * u_scale;
  vec2 off;
  if (u_mode < 0.5) {
    off = vec2(snoise(vec3(p, t)), snoise(vec3(p + 31.7, t + 11.3))) * 0.05;
  } else {
    off = vec2(sin(vUv.y * u_scale * TAU + t * 3.0) * 0.03,
               sin(vUv.x * u_scale * TAU * 0.7 + t * 3.9) * 0.015);
  }
  off.x /= uAspect;
  vec2 uv = fx_mirrorUv(vUv + off * amt);
  gl_FragColor = vec4(texture2D(tInput, uv).rgb, 1.0);
}
`,
};

/* ───────────────────────── zoom-punch ───────────────────────── */

const zoomPunch: EffectDef = {
  id: 'zoom-punch',
  name: 'Zoom punch',
  description: 'Scale-in pulse on the hits with a touch of radial blur.',
  category: 'distort',
  params: [
    pNum('amount', 'Amount', 0, 0.5, 0.1, 0.005),
    pTrigger('kick'),
    pNum('blur', 'Blur', 0, 1, 0.5, 0.01),
    pNum('sharpness', 'Sharpness', 1, 6, 1.5, 0.1, { hint: 'Higher = shorter punch' }),
  ],
  fragment: /* glsl */ `
${GLSL_TRIGGER}
void main() {
  float e = pow(clamp(fx_trigger(u_trigger), 0.0, 1.0), u_sharpness);
  float s = 1.0 + u_amount * e;
  float spread = u_blur * e * 0.05;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float fi = float(i) / 7.0;
    float si = s * (1.0 - spread * fi);
    vec2 uv = (vUv - 0.5) / max(si, 0.01) + 0.5;
    acc += texture2D(tInput, clamp(uv, 0.0, 1.0)).rgb;
  }
  gl_FragColor = vec4(acc / 8.0, 1.0);
}
`,
};

export const distortEffects: EffectDef[] = [kaleido, mirror, displace, zoomPunch];
