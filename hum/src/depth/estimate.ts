/**
 * Asking the depth worker (depth.worker.ts) how far away everything in a picture is. One worker for
 * the whole page, started the first time it is needed.
 *
 *   loadDepth   get the model ready (it downloads the first time) and say what it runs on
 *   depthOf     the nearness map of one picture
 */
import { Desk } from './desk';

/** what the model runs on: the graphics chip, or the processor (much slower) */
export type DepthDevice = 'webgpu' | 'wasm';

export interface DepthMap {
  /** nearness as the model gives it: 0 the sky, twice the number is half as far. Rows bottom to top */
  map: Float32Array;
  width: number;
  height: number;
  /** how long the model took */
  ms: number;
  device: DepthDevice;
}

const desk = new Desk(() => new Worker(new URL('./depth.worker.ts', import.meta.url), { type: 'module' }), 'The depth model failed to start');

/** Get the model ready. A download under way carries on when cancelled, and is kept. `device` is for tests. */
export async function loadDepth(opts: { signal?: AbortSignal; onDownload?: (frac: number) => void; device?: DepthDevice } = {}): Promise<DepthDevice> {
  const r = await desk.ask<{ device: DepthDevice }>({ type: 'load', device: opts.device }, [], opts.signal, opts.onDownload);
  return r.device;
}

/** The map of one picture, `width` x `height`. The picture is used up (it moves to the worker). `short`: the model's picture's short side. */
export function depthOf(bitmap: ImageBitmap, width: number, height: number, opts: { signal?: AbortSignal; short?: number } = {}): Promise<DepthMap> {
  return desk.ask<DepthMap>({ type: 'depth', bitmap, width, height, short: opts.short }, [bitmap], opts.signal);
}
