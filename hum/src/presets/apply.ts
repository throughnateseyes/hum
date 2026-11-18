import type { EffectInstance, Modulation, Palette, ParamValues, Preset, PresetModulation } from '../core/types';
import { getEffect } from '../fx';
import { getScene } from '../scenes';
import { uid } from '../state/modulation';

export interface LookState {
  sceneId: string;
  sceneParams: ParamValues;
  effects: EffectInstance[];
  modulations: Modulation[];
  palette: Palette;
}

/** Expand a preset into concrete studio state (instance ids, defaults filled, fx targets resolved). */
export function presetToLook(p: Preset): LookState {
  const scene = getScene(p.sceneId);
  const sceneParams: ParamValues = {};
  for (const d of scene?.params ?? []) sceneParams[d.id] = p.sceneParams?.[d.id] ?? d.default;

  const effects: EffectInstance[] = [];
  const indexToInstance: Record<number, string> = {};
  p.effects.forEach((e, i) => {
    const def = getEffect(e.effectId);
    if (!def) return;
    const params: ParamValues = {};
    for (const d of def.params) params[d.id] = e.params?.[d.id] ?? d.default;
    const instanceId = uid('fx');
    indexToInstance[i] = instanceId;
    effects.push({ instanceId, effectId: def.id, enabled: e.enabled ?? true, params });
  });

  const modulations: Modulation[] = [];
  for (const m of p.modulations) {
    const t = resolveTarget(m, indexToInstance);
    if (t) modulations.push({ id: uid('mod'), source: m.source, target: t, amount: m.amount, enabled: true });
  }
  return { sceneId: p.sceneId, sceneParams, effects, modulations, palette: { ...p.palette } };
}

function resolveTarget(m: PresetModulation, map: Record<number, string>): string | null {
  const parts = m.target.split('.');
  if (parts[0] === 'scene' && parts.length === 2) return m.target;
  if (parts[0] === 'fx' && parts.length === 3) {
    const idx = Number(parts[1]);
    const inst = Number.isFinite(idx) ? map[idx] : parts[1];
    return inst ? `fx.${inst}.${parts[2]}` : null;
  }
  return null;
}

/** Inverse: snapshot current studio state as a preset (fx targets become indices). */
export function lookToPreset(look: LookState, meta: { id: string; name: string; description: string; tags: string[] }): Preset {
  const idx: Record<string, number> = {};
  look.effects.forEach((e, i) => (idx[e.instanceId] = i));
  return {
    ...meta,
    custom: true,
    sceneId: look.sceneId,
    sceneParams: { ...look.sceneParams },
    effects: look.effects.map((e) => ({ effectId: e.effectId, params: { ...e.params }, enabled: e.enabled })),
    modulations: look.modulations
      .filter((m) => m.enabled)
      .map((m) => {
        const parts = m.target.split('.');
        const target = parts[0] === 'fx' ? `fx.${idx[parts[1]]}.${parts[2]}` : m.target;
        return { source: m.source, target, amount: m.amount };
      })
      .filter((m) => !m.target.includes('undefined')),
    palette: { ...look.palette },
  };
}
