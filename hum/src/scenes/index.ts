import { noteSceneStyle } from '../core/styles';
import type { SceneDef } from '../core/types';
import { scenes as threeScenes } from './three';
import { scenes as shaderScenes } from './shader';
import { scenes as photoScenes } from './photo';
import { scenes as boardScenes } from './board';
import { scenes as natureScenes } from './nature';
import { scenes as worldScenes } from './worlds';
import { scenes as printScenes } from './print';
import { scenes as typeScenes } from './type';

const builtin: SceneDef[] = [...boardScenes, ...threeScenes, ...shaderScenes, ...photoScenes, ...natureScenes, ...worldScenes, ...printScenes, ...typeScenes];

for (const s of builtin) noteSceneStyle(s);

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
  noteSceneStyle(def);
}
export function unregisterScene(id: string) {
  runtime.delete(id);
}
