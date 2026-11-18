import type { EffectDef } from '../../core/types';
import { GLSL_FADE, pNum, pReactive, pSelect } from './shared';

/* ───────────────────────── trails ───────────────────────── */

const trails: EffectDef = {
  id: 'trails',
  name: 'Trails',
  description: 'Feedback echo: the last frame, zoomed and rotated, decaying behind the new one.',
  category: 'time',
  feedback: true,
  params: [
    pSelect(
      'mode',
      'Blend',
      [
        ['auto', 'Auto (palette)'],
        ['lighten', 'Lighten'],
        ['darken', 'Darken'],
        ['mix', 'Echo mix'],
      ],
      'auto',
      { hint: 'Auto keeps whatever stands out from the palette background' },
    ),
    pNum('decay', 'Persistence', 0, 0.99, 0.85, 0.01),
    pNum('zoom', 'Zoom', -0.05, 0.05, 0.01, 0.001),
    pNum('rotate', 'Rotate', -0.05, 0.05, 0, 0.001),
    pReactive(0.5),
  ],
  fragment: /* glsl */ `
${GLSL_FADE}
void main() {
  vec3 cur = texture2D(tInput, vUv).rgb;
  vec2 p = vUv - 0.5;
  p.x *= uAspect;
  float z = 1.0 + u_zoom * (1.0 + u_reactive * 4.0 * uKick);
  float ang = u_rotate * (1.0 + u_reactive * 0.5 * uSway);
  p = rot2(ang) * p / max(z, 0.01);
  p.x /= uAspect;
  vec2 puv = p + 0.5;
  float inb = step(0.0, puv.x) * step(puv.x, 1.0) * step(0.0, puv.y) * step(puv.y, 1.0);
  vec3 prev = mix(cur, texture2D(tPrev, clamp(puv, 0.0, 1.0)).rgb, inb);
  float keep = clamp(u_decay + u_reactive * (1.0 - u_decay) * 0.6 * uDrop, 0.0, 0.99);

  vec3 outc;
  if (u_mode < 0.5) {
    vec3 pf = fx_fade(prev, uBg, keep);
    float w = smoothstep(-0.02, 0.02, distance(cur, uBg) - distance(pf, uBg));
    outc = mix(pf, cur, w);
  } else if (u_mode < 1.5) {
    outc = max(cur, fx_fade(prev, vec3(0.0), keep));
  } else if (u_mode < 2.5) {
    outc = min(cur, fx_fade(prev, vec3(1.0), keep));
  } else {
    outc = fx_fade(prev, cur, keep);
  }
  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}
`,
};

/* ───────────────────────── smear ───────────────────────── */

const smear: EffectDef = {
  id: 'smear',
  name: 'Smear',
  description: 'Directional feedback smear / slit-scan; streak length follows the energy.',
  category: 'time',
  feedback: true,
  params: [
    pSelect(
      'mode',
      'Mode',
      [
        ['smear', 'Smear'],
        ['slit', 'Slit-scan'],
      ],
      'smear',
      { hint: 'Slit-scan: only a centre slit is live, the rest flows outward from it' },
    ),
    pNum('angle', 'Angle', 0, 360, 90, 1),
    pNum('length', 'Length', 0, 20, 4, 0.1, { hint: 'Pixels travelled per frame' }),
    pNum('hold', 'Persistence', 0, 0.99, 0.9, 0.01),
    pNum('slitWidth', 'Slit width', 0.002, 0.3, 0.02, 0.001),
    pReactive(0.7),
  ],
  fragment: /* glsl */ `
void main() {
  vec3 cur = texture2D(tInput, vUv).rgb;
  float a = radians(u_angle) + u_reactive * uSway * 0.15;
  vec2 dir = vec2(cos(a), sin(a));
  float drive = mix(1.0, 0.25 + uEnergy * 1.2 + uBass * 0.6 + uKick * 0.8, u_reactive);
  float len = u_length * drive;
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  float s = dot(q, dir);
  float side = (u_mode > 0.5 && s < 0.0) ? -1.0 : 1.0;
  vec2 puv = vUv - side * dir * len / uResolution;
  vec3 prev = texture2D(tPrev, clamp(puv, 0.0, 1.0)).rgb;

  float hold = clamp(u_hold, 0.0, 0.995);
  float emit = 1.0 - hold;
  if (u_mode > 0.5) {
    float hw = max(u_slitWidth, 0.001) * 0.5;
    float mask = 1.0 - smoothstep(hw, hw + 0.004, abs(s));
    emit = max(mask, emit * 0.25);
  }
  vec3 d = cur - prev;
  float mn = clamp(emit * 10.0, 0.0, 1.0) * (1.5 / 255.0);
  vec3 mag = max(abs(d) * emit, min(abs(d), vec3(mn)));
  gl_FragColor = vec4(clamp(prev + sign(d) * mag, 0.0, 1.0), 1.0);
}
`,
};

export const timeEffects: EffectDef[] = [trails, smear];
