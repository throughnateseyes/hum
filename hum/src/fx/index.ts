import type { EffectDef } from '../core/types';
import { effects } from './library';

export function allEffects(): EffectDef[] {
  return effects;
}
export function getEffect(id: string): EffectDef | undefined {
  return effects.find((e) => e.id === id);
}
