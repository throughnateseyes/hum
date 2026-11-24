/**
 * Reading clips and photos as places (see types.ts for what comes out, read.ts for how to ask).
 *
 *   sceneToDump / sceneFromDump   a scene as JSON and one run of bytes, to keep as files and open again
 */
import type { ClipScene } from './types';

export { EYE, type ClipScene, type Slide, type View } from './types';
export { ClipReader, momentAt, pinned, readClip, readPhoto, STEP, type Moment, type NeedOptions, type ReadOptions, type ReadProgress } from './read';
export { loadDepth, type DepthDevice } from './estimate';
export { slid, unslid } from './track';

export interface SceneDump extends Omit<ClipScene, 'maps'> {
  /** the samples whose maps are in the bytes, in order */
  have: number[];
}

export function sceneToDump(s: ClipScene): { json: SceneDump; bytes: Uint8Array } {
  const { maps, ...rest } = s;
  const have = maps.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
  const each = s.width * s.height;
  const bytes = new Uint8Array(each * have.length);
  have.forEach((i, k) => bytes.set(maps[i]!, k * each));
  return { json: { ...rest, have }, bytes };
}

export function sceneFromDump(json: SceneDump | string, bytes: ArrayBuffer): ClipScene {
  const { have, ...rest } = typeof json === 'string' ? (JSON.parse(json) as SceneDump) : json;
  const each = rest.width * rest.height;
  const maps: (Uint8Array | null)[] = rest.times.map(() => null);
  have.forEach((i, k) => {
    maps[i] = new Uint8Array(bytes, k * each, each);
  });
  return { ...rest, maps };
}
