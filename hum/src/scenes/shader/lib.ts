import { defineShaderScene, type ShaderSceneOptions } from '../../core/sceneHelpers';
import type { FrameContext, NumberParam, SceneDef } from '../../core/types';
import { num } from '../../core/uniforms';

/**
 * Small GLSL helpers shared by the built-in shader scenes (prefixed `hm` so they never collide
 * with the common library). Prepend to a fragment: `${HM_LIB}\nvoid main() { ... }`.
 */
export const HM_LIB = /* glsl */ `
float hmGrain(vec2 fc, float t) {
  return hash21(fc + vec2(fract(t * 7.31) * 517.0, fract(t * 3.17) * 211.0)) - 0.5;
}
vec3 hmSat(vec3 c, float s) { return mix(vec3(luma(c)), c, s); }
vec3 hmLight() { return luma(uBg) >= luma(uFg) ? uBg : uFg; }
vec3 hmDark() { return luma(uBg) >= luma(uFg) ? uFg : uBg; }
float hmIsLight() { return step(0.5, luma(uBg)); }

// 3x5 pixel digit. c = glyph-pixel coords (x right, y up), valid in [0,3)x[0,5).
float hmDigit(vec2 c, float d) {
  if (c.x < 0.0 || c.y < 0.0 || c.x >= 3.0 || c.y >= 5.0) return 0.0;
  float code = 31599.0;
  if (d > 0.5) code = 11415.0;
  if (d > 1.5) code = 29671.0;
  if (d > 2.5) code = 29647.0;
  if (d > 3.5) code = 23497.0;
  if (d > 4.5) code = 31183.0;
  if (d > 5.5) code = 31215.0;
  if (d > 6.5) code = 29330.0;
  if (d > 7.5) code = 31727.0;
  if (d > 8.5) code = 31695.0;
  float bit = floor(c.y) * 3.0 + (2.0 - floor(c.x));
  return mod(floor(code / exp2(bit)), 2.0);
}

// Prints |v| as <intDigits> digits + "." + 1 decimal. Each char is 4 glyph px wide, 5 tall.
float hmNumber(vec2 c, float v, float intDigits) {
  if (c.y < 0.0 || c.y >= 5.0 || c.x < 0.0) return 0.0;
  float ci = floor(c.x / 4.0);
  vec2 lc = vec2(c.x - ci * 4.0, c.y);
  float av = abs(v);
  if (ci < intDigits) {
    return hmDigit(lc, mod(floor(av / pow(10.0, intDigits - 1.0 - ci) + 0.0001), 10.0));
  }
  if (ci < intDigits + 0.5) {
    return (floor(lc.x) == 1.0 && floor(lc.y) == 0.0) ? 1.0 : 0.0;
  }
  if (ci < intDigits + 1.5) {
    return hmDigit(lc, mod(floor(av * 10.0 + 0.0001), 10.0));
  }
  return 0.0;
}
`;

/* ───────────────────────── Clocks ───────────────────────── */

export type ClockState = Record<string, number>;
/**
 * Advance one hidden clock. `state` holds every clock's value (clocks are stepped in declaration
 * order, so later ones see earlier ones' new values); `mem` is per-instance scratch memory.
 */
export type ClockStep = (prev: number, f: FrameContext, state: ClockState, mem: Record<string, number>) => number;
export interface ClockDef {
  init?: number;
  step: ClockStep;
}

/**
 * Like `defineShaderScene`, plus hidden per-instance accumulators that arrive in GLSL as
 * `u_<clockId>` floats. Use them for audio-scaled time (integrate speed instead of multiplying
 * uTime by an audio level, which makes the phase jump), time-since-kick ripples, kick counters, etc.
 * The clocks are not exposed as params in the inspector / modulation matrix.
 */
export function defineClockedShaderScene(opts: ShaderSceneOptions, clocks: Record<string, ClockDef>): SceneDef {
  const ids = Object.keys(clocks);
  const hidden: NumberParam[] = ids.map((id) => ({
    id,
    label: id,
    type: 'number',
    min: -1e9,
    max: 1e9,
    default: clocks[id].init ?? 0,
  }));
  const inner = defineShaderScene({ ...opts, params: [...opts.params, ...hidden] });
  return {
    ...inner,
    params: opts.params,
    create(init) {
      const instance = inner.create(init);
      const state: ClockState = {};
      const mem: Record<string, number> = {};
      for (const id of ids) state[id] = clocks[id].init ?? 0;
      return {
        render(frame, target) {
          const f = frame.dt > 0.1 || frame.dt < 0 ? { ...frame, dt: frame.dt < 0 ? 0 : 0.1 } : frame;
          for (const id of ids) state[id] = clocks[id].step(state[id], f, state, mem);
          instance.render({ ...frame, params: { ...frame.params, ...state } }, target);
        },
        resize(w, h) {
          instance.resize?.(w, h);
        },
        dispose() {
          instance.dispose();
        },
      };
    },
  };
}

/** Accumulates dt × rate(frame). Wraps at 10 000 to keep float precision sane. */
export function rateClock(rate: (f: FrameContext) => number): ClockDef {
  return { step: (v, f) => (v + f.dt * rate(f)) % 10000 };
}

/** Accumulates dt × param × (base + audio boost). */
export function speedClock(paramId: string, fallback: number, boost: (f: FrameContext) => number): ClockDef {
  return rateClock((f) => num(f.params, paramId, fallback) * boost(f));
}

/** Seconds since the last kick (starts large so nothing fires on load). */
export const sinceKickClock: ClockDef = {
  init: 100,
  step: (v, f) => (f.audio.kickHit ? 0 : Math.min(v + f.dt, 100)),
};

/** Counts kicks (wraps at 997) — use as a random seed per kick. */
export const kickCountClock: ClockDef = {
  step: (v, f) => (f.audio.kickHit ? (v + 1) % 997 : v),
};

/** Eases between 0 and PI, flipping on each drop. */
export const dropFlipClock: ClockDef = {
  step: (v, f, _s, mem) => {
    const d = f.audio.drop;
    if (d > 0.6 && (mem.dropPrev ?? 0) <= 0.6) mem.flipTarget = (mem.flipTarget ?? 0) === 0 ? Math.PI : 0;
    mem.dropPrev = d;
    const target = mem.flipTarget ?? 0;
    return v + (target - v) * (1 - Math.exp(-f.dt * 2.2));
  },
};
