/**
 * Shared helpers for the post-effects library: param constructors and small GLSL snippets.
 * Snippet function names are prefixed (fx_*) so they never collide with GLSL_COMMON.
 */
import type { BoolParam, ColorParam, NumberParam, SelectParam } from '../../core/types';

interface Extra {
  group?: string;
  hint?: string;
}

export function pNum(
  id: string,
  label: string,
  min: number,
  max: number,
  def: number,
  step?: number,
  extra: Extra = {},
): NumberParam {
  return { type: 'number', id, label, min, max, default: def, ...(step !== undefined ? { step } : {}), ...extra };
}

export function pBool(id: string, label: string, def: boolean, extra: Extra = {}): BoolParam {
  return { type: 'bool', id, label, default: def, ...extra };
}

export function pColor(id: string, label: string, def: string, extra: Extra = {}): ColorParam {
  return { type: 'color', id, label, default: def, ...extra };
}

/** options: [value, label][]; the uniform receives the option index as a float. */
export function pSelect(
  id: string,
  label: string,
  options: [string, string][],
  def: string,
  extra: Extra = {},
): SelectParam {
  return { type: 'select', id, label, options: options.map(([value, l]) => ({ value, label: l })), default: def, ...extra };
}

/** The standard "how much do the hits drive it" knob. */
export function pReactive(def = 0.6): NumberParam {
  return pNum('reactive', 'Reactivity', 0, 1, def, 0.01, {
    group: 'Audio',
    hint: 'How strongly the music drives this effect',
  });
}

/** Trigger select used by flash / zoom-punch. Pair with GLSL_TRIGGER. */
export function pTrigger(def: 'kick' | 'snare' | 'beat' | 'drop' = 'kick'): SelectParam {
  return pSelect(
    'trigger',
    'Trigger',
    [
      ['kick', 'Kick'],
      ['snare', 'Snare'],
      ['beat', 'Beat (tempo)'],
      ['drop', 'Drop'],
    ],
    def,
    { group: 'Audio' },
  );
}

/** float fx_trigger(float sel) → 0..1 envelope for the pTrigger options. */
export const GLSL_TRIGGER = /* glsl */ `
float fx_trigger(float sel) {
  if (sel < 0.5) return uKick;
  if (sel < 1.5) return uSnare;
  if (sel < 2.5) {
    float bp = 1.0 - clamp(uBeatPhase, 0.0, 1.0);
    return bp * bp * bp * smoothstep(0.01, 0.06, uLevel) * step(1.0, uBpm);
  }
  return uDrop;
}
`;

/**
 * float fx_inkDir() → 1.0 when the palette background is lighter than the foreground
 * (light palette: "ink" = dark), 0.0 otherwise. Use t = mix(l, 1.0 - l, fx_inkDir())
 * to turn luminance into "how much foreground ink" so palettes never invert the image.
 */
export const GLSL_INK_DIR = /* glsl */ `
float fx_inkDir() { return step(luma(uFg), luma(uBg)); }
`;

/**
 * vec3 fx_fade(prev, target, keep) — feedback decay toward target that always moves at
 * least ~1.5/255 per frame, so 8-bit render targets never leave stuck ghost residue.
 */
export const GLSL_FADE = /* glsl */ `
vec3 fx_fade(vec3 prev, vec3 target, float keep) {
  vec3 d = target - prev;
  vec3 mag = max(abs(d) * (1.0 - keep), min(abs(d), vec3(1.5 / 255.0)));
  return prev + sign(d) * mag;
}
`;

/** vec2 fx_mirrorUv(uv) — mirrored repeat, avoids clamp streaks at the edges. */
export const GLSL_MIRROR_UV = /* glsl */ `
vec2 fx_mirrorUv(vec2 uv) { return 1.0 - abs(1.0 - mod(uv, 2.0)); }
`;
