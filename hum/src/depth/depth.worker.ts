/// <reference lib="webworker" />
/**
 * Tells how far away everything in a picture is. Runs Depth Anything V2 (small) on this computer
 * through transformers.js: no picture ever leaves the machine. The model downloads once (~50 MB, or
 * ~27 MB on a computer without a usable graphics chip) and the browser keeps it.
 *
 * in:  { type: 'load', id, device? } · { type: 'depth', id, bitmap, width, height, short? } · { type: 'cancel', id }
 * out: { id, type: 'download', frac } · { id, type: 'ready', device }
 *      · { id, type: 'done', map, width, height, ms, device } · { id, type: 'cancelled' } · { id, type: 'error', message }
 *
 * A map is nearness as the model gives it (not squeezed to 0..1): 0 is the sky, bigger is nearer, and
 * twice the number is half as far. Rows run bottom to top. Pictures are done one at a time, in order.
 */
import { AutoModel, env, Tensor } from '@huggingface/transformers';
import type { DepthDevice } from './estimate';

const MODEL = 'onnx-community/depth-anything-v2-small';
/** the model looks at squares of this many pixels, so its picture's sides are multiples of it */
const PATCH = 14;
/** the picture's short side as the model sees it: thin things (cables, railings) need the detail. 518 looks the same and takes half as long again */
const SHORT: Record<DepthDevice, number> = { webgpu: 462, wasm: 308 };
/** a very wide picture is seen a little smaller, so it takes no longer than a 16:9 one */
const MAX_PATCHES: Record<DepthDevice, number> = { webgpu: 2500, wasm: 900 };
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

env.allowLocalModels = false;

type Model = (inputs: Record<string, unknown>) => Promise<{ predicted_depth: Tensor }>;
let model: Model | null = null;
let device: DepthDevice = 'wasm';
/** the job being worked on (its id goes on every message) */
let job = 0;
const post = (m: Record<string, unknown>, move: Transferable[] = []) => (self as unknown as Worker).postMessage({ id: job, ...m }, move);
const cancelled = new Set<number>();
class Cancelled extends Error {}
/** let a waiting cancel message in, then stop if it was for this job */
async function checkpoint(id: number) {
  await new Promise((r) => setTimeout(r, 0));
  if (cancelled.has(id)) throw new Cancelled();
}

/** can the graphics chip run the half-size model? */
async function hasGpu() {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: object): Promise<{ features: Set<string>; info?: { isFallbackAdapter?: boolean } } | null> } }).gpu;
    const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' });
    return !!adapter?.features.has('shader-f16') && !adapter.info?.isFallbackAdapter;
  } catch {
    return false;
  }
}

async function make(on: DepthDevice): Promise<Model> {
  const files = new Map<string, { loaded: number; total: number }>();
  const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== 'progress' || !p.file) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    let l = 0;
    let t = 0;
    for (const f of files.values()) {
      l += f.loaded;
      t += f.total;
    }
    if (t > 0) post({ type: 'download', frac: l / t });
  };
  return (await AutoModel.from_pretrained(MODEL, { progress_callback, device: on, dtype: on === 'webgpu' ? 'fp16' : 'q8' } as never)) as unknown as Model;
}

async function load(want?: DepthDevice) {
  if (model && (!want || want === device)) return model;
  const gpu = want !== 'wasm' && (await hasGpu());
  try {
    model = await make(gpu ? 'webgpu' : 'wasm');
    device = gpu ? 'webgpu' : 'wasm';
  } catch (e) {
    if (!gpu) throw e;
    model = await make('wasm');
    device = 'wasm';
  }
  return model;
}

/** the size the model sees a picture of this shape at */
function sizeFor(aspect: number, short: number, most: number): [number, number] {
  let w = aspect >= 1 ? short * aspect : short;
  let h = aspect >= 1 ? short : short / aspect;
  const k = Math.min(1, Math.sqrt((most * PATCH * PATCH) / (w * h)));
  w *= k;
  h *= k;
  return [Math.max(PATCH * 8, Math.round(w / PATCH) * PATCH), Math.max(PATCH * 8, Math.round(h / PATCH) * PATCH)];
}

const canvas = new OffscreenCanvas(1, 1);
const brush = canvas.getContext('2d', { willReadFrequently: true })!;

function pixels(bitmap: ImageBitmap, w: number, h: number): Float32Array {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  brush.imageSmoothingQuality = 'high';
  brush.drawImage(bitmap, 0, 0, w, h);
  const d = brush.getImageData(0, 0, w, h).data;
  const n = w * h;
  const out = new Float32Array(n * 3);
  for (let c = 0; c < 3; c++) {
    const k = 1 / (255 * STD[c]);
    const b = MEAN[c] / STD[c];
    for (let i = 0, p = c, o = c * n; i < n; i++, p += 4) out[o + i] = d[p] * k - b;
  }
  return out;
}

/**
 * Shrink the model's map to the size it is kept at. Where a cell holds both something near and
 * something far (an edge, a cable) averaging would invent a distance nothing is at, so the cell takes
 * a side: the near one when it fills a third of the cell, else the far one.
 */
function shrink(src: ArrayLike<number>, sw: number, sh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const fx = sw / w;
  const fy = sh / h;
  for (let y = 0; y < h; y++) {
    // kept maps run bottom to top, the model's top to bottom
    const row = (h - 1 - y) * w;
    const y0 = Math.min(sh - 1, Math.floor(y * fy));
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((y + 1) * fy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(sw - 1, Math.floor(x * fx));
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((x + 1) * fx)));
      let lo = Infinity;
      let hi = -Infinity;
      let sum = 0;
      for (let j = y0; j < y1; j++)
        for (let i = x0; i < x1; i++) {
          const v = src[j * sw + i];
          sum += v;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      const n = (y1 - y0) * (x1 - x0);
      if (hi - lo < hi * 0.15) {
        out[row + x] = sum / n;
        continue;
      }
      const mid = (lo + hi) / 2;
      let near = 0;
      let nearN = 0;
      let far = 0;
      for (let j = y0; j < y1; j++)
        for (let i = x0; i < x1; i++) {
          const v = src[j * sw + i];
          if (v > mid) {
            near += v;
            nearN++;
          } else far += v;
        }
      out[row + x] = nearN * 3 >= n ? near / nearN : far / (n - nearN);
    }
  }
  return out;
}

type Msg =
  | { type: 'load'; id: number; device?: DepthDevice }
  | { type: 'depth'; id: number; bitmap: ImageBitmap; width: number; height: number; short?: number }
  | { type: 'cancel'; id: number };
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === 'cancel') cancelled.add(m.id);
  else queue = queue.then(() => run(m));
};

async function run(m: Exclude<Msg, { type: 'cancel' }>) {
  job = m.id;
  try {
    if (m.type === 'load') {
      await load(m.device);
      post({ type: 'ready', device });
      return;
    }
    await checkpoint(m.id);
    let net = await load();
    await checkpoint(m.id);
    const t0 = performance.now();
    const aspect = m.bitmap.width / Math.max(1, m.bitmap.height);
    const look = async () => {
      const [w, h] = sizeFor(aspect, m.short ?? SHORT[device], MAX_PATCHES[device]);
      const out = await net({ pixel_values: new Tensor('float32', pixels(m.bitmap, w, h), [1, 3, h, w]) });
      const d = out.predicted_depth;
      const [, dh, dw] = d.dims;
      const map = shrink(d.data as Float32Array, dw, dh, m.width, m.height);
      d.dispose();
      return map;
    };
    let map: Float32Array;
    try {
      map = await look();
    } catch (err) {
      // the graphics chip gave up (asleep, out of memory): carry on without it
      if (device === 'wasm') throw err;
      net = await load('wasm');
      map = await look();
    }
    post({ type: 'done', map, width: m.width, height: m.height, ms: performance.now() - t0, device }, [map.buffer as ArrayBuffer]);
  } catch (err) {
    if (err instanceof Cancelled) post({ type: 'cancelled' });
    else post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    if (m.type === 'depth') m.bitmap.close();
    cancelled.delete(m.id);
  }
}
