import type { EffectDef } from '../../core/types';
import { pNum, pReactive } from './shared';

const glitch: EffectDef = {
  id: 'glitch',
  name: 'Glitch',
  description: 'Block displacement, RGB split and line tears, fired by snares, kicks and drops.',
  category: 'glitch',
  params: [
    pNum('amount', 'Amount', 0, 1, 0.5, 0.01),
    pNum('blockSize', 'Block size', 8, 200, 48, 1),
    pNum('split', 'RGB split', 0, 1, 0.5, 0.01),
    pNum('tears', 'Line tears', 0, 1, 0.4, 0.01),
    pReactive(0.8),
  ],
  fragment: /* glsl */ `
void main() {
  float g = clamp(u_amount * (0.1 + u_reactive * (uSnare * 1.0 + uKick * 0.45 + uDrop * 1.2)), 0.0, 1.0);
  float t = floor(uTime * 12.0) + mod(uBeatCount, 256.0) * 7.0;
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = vUv;
  float bs = max(4.0, u_blockSize);

  // coarse blocks
  vec2 b1 = floor(fc / vec2(bs * 2.5, bs));
  float r1 = hash21(b1 + vec2(t * 1.37, t * 0.71));
  float hit1 = step(r1, g * 0.35);
  uv.x += hit1 * (hash21(b1 + vec2(t, 9.1)) - 0.5) * 0.25 * g;
  uv.y += hit1 * (hash21(b1 + vec2(4.7, t)) - 0.5) * 0.04 * g;

  // fine blocks
  vec2 b2 = floor(fc / vec2(bs * 0.6, bs * 0.3));
  float r2 = hash21(b2 + vec2(t * 2.11, 3.3));
  float hit2 = step(r2, g * 0.12);
  uv.x += hit2 * (hash21(b2 + vec2(1.9, t)) - 0.5) * 0.08;

  // line tears
  float row = floor(fc.y / max(2.0, bs * 0.08));
  float tr = hash11(row * 0.37 + t * 3.17);
  float tear = step(tr, u_tears * g * 0.25);
  uv.x += tear * (hash11(row + t * 1.91) - 0.5) * 0.3 * g;

  uv.x = fract(uv.x);
  uv.y = clamp(uv.y, 0.0, 1.0);

  // RGB split
  float sp = u_split * (g * 0.03 + 0.0015);
  float sd = hit1 > 0.5 ? -1.0 : 1.0;
  float cr = texture2D(tInput, vec2(fract(uv.x + sp * sd), uv.y)).r;
  float cg = texture2D(tInput, uv).g;
  float cb = texture2D(tInput, vec2(fract(uv.x - sp * sd), uv.y)).b;
  vec3 col = vec3(cr, cg, cb);

  // a few blocks flood with the accent
  col = mix(col, uAccent, 0.55 * step(r1, g * 0.05));
  gl_FragColor = vec4(col, 1.0);
}
`,
};

export const glitchEffects: EffectDef[] = [glitch];
