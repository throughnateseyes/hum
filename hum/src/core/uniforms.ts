import * as THREE from 'three';
import { AUDIO_UNIFORM_NAMES } from './glsl';
import type { AudioFrame, ParamDef, ParamValues, ResolvedPalette, SharedResources } from './types';

export type UniformMap = Record<string, THREE.IUniform>;

/** Base uniforms shared by scenes and effects. */
export function createBaseUniforms(shared: SharedResources, params: ParamDef[]): UniformMap {
  const u: UniformMap = {
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uSpectrum: { value: shared.spectrumTex },
    uWaveform: { value: shared.waveformTex },
    uBg: { value: new THREE.Color() },
    uFg: { value: new THREE.Color() },
    uAccent: { value: new THREE.Color() },
    uAccent2: { value: new THREE.Color() },
    uMuted: { value: new THREE.Color() },
  };
  for (const n of AUDIO_UNIFORM_NAMES) u[n] = { value: 0 };
  for (const p of params) {
    u[`u_${p.id}`] = { value: p.type === 'color' ? new THREE.Color(p.default) : paramToFloat(p, p.default) };
  }
  return u;
}

export function paramToFloat(p: ParamDef, v: unknown): number {
  switch (p.type) {
    case 'number':
      return typeof v === 'number' ? v : p.default;
    case 'bool':
      return (typeof v === 'boolean' ? v : p.default) ? 1 : 0;
    case 'select': {
      const i = p.options.findIndex((o) => o.value === v);
      return i >= 0 ? i : Math.max(0, p.options.findIndex((o) => o.value === p.default));
    }
    default:
      return 0;
  }
}

export function updateBaseUniforms(
  u: UniformMap,
  o: { width: number; height: number; time: number; audio: AudioFrame; palette: ResolvedPalette },
) {
  (u.uResolution.value as THREE.Vector2).set(o.width, o.height);
  u.uTime.value = o.time;
  u.uAspect.value = o.width / Math.max(1, o.height);
  const a = o.audio;
  u.uLevel.value = a.level;
  u.uSub.value = a.sub;
  u.uBass.value = a.bass;
  u.uLowMid.value = a.lowMid;
  u.uMid.value = a.mid;
  u.uHighMid.value = a.highMid;
  u.uAir.value = a.air;
  u.uKick.value = a.kick;
  u.uSnare.value = a.snare;
  u.uHat.value = a.hat;
  u.uEnergy.value = a.energy;
  u.uBrightness.value = a.brightness;
  u.uFlux.value = a.flux;
  u.uBeatPhase.value = a.beatPhase;
  u.uBuild.value = a.build;
  u.uDrop.value = a.drop;
  u.uSway.value = a.sway;
  u.uBeat.value = a.beat ? 1 : 0;
  u.uBeatCount.value = a.beatCount;
  u.uBpm.value = a.bpm;
  const c = o.palette.c;
  (u.uBg.value as THREE.Color).copy(c.bg);
  (u.uFg.value as THREE.Color).copy(c.fg);
  (u.uAccent.value as THREE.Color).copy(c.accent);
  (u.uAccent2.value as THREE.Color).copy(c.accent2);
  (u.uMuted.value as THREE.Color).copy(c.muted);
}

export function updateParamUniforms(u: UniformMap, defs: ParamDef[], values: ParamValues) {
  for (const p of defs) {
    const un = u[`u_${p.id}`];
    if (!un) continue;
    const v = values[p.id] ?? p.default;
    if (p.type === 'color') (un.value as THREE.Color).set(typeof v === 'string' ? v : p.default);
    else un.value = paramToFloat(p, v);
  }
}

/** Read a param with its default as fallback — handy inside scenes. */
export function num(values: ParamValues, id: string, fallback = 0): number {
  const v = values[id];
  return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : fallback;
}
export function str(values: ParamValues, id: string, fallback = ''): string {
  const v = values[id];
  return typeof v === 'string' ? v : fallback;
}
export function bool(values: ParamValues, id: string, fallback = false): boolean {
  const v = values[id];
  return typeof v === 'boolean' ? v : typeof v === 'number' ? v > 0.5 : fallback;
}
