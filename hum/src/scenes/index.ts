import type { SceneDef } from '../core/types';
import { scenes as threeScenes } from './three';
import { scenes as shaderScenes } from './shader';
import { scenes as photoScenes } from './photo';
import { scenes as boardScenes } from './board';

const builtin: SceneDef[] = [...boardScenes, ...threeScenes, ...shaderScenes, ...photoScenes];

/** runtime-registered scenes (AI-generated / custom GLSL) */
const runtime = new Map<string, SceneDef>();

export function allScenes(): SceneDef[] {
  return [...builtin, ...runtime.values()];
}
export function getScene(id: string): SceneDef | undefined {
  return runtime.get(id) ?? builtin.find((s) => s.id === id);
}
export function registerScene(def: SceneDef) {
  runtime.set(def.id, def);
}
export function unregisterScene(id: string) {
  runtime.delete(id);
}
