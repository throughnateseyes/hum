/**
 * Dev helper (served at /depth.html by `npm run dev`, not part of the build): reads a clip with
 * src/depth/ and hands over what it found, to check by eye and by number. Driven from a script.
 */
import { depthOf, loadDepth, type DepthDevice } from '../depth/estimate';
import { FrameReader } from '../depth/frames';
import { readClip, readPhoto, sceneToDump, type ClipReader, type ReadOptions } from '../depth';
import type { PhotoAsset } from '../core/types';

const b64 = (a: ArrayBufferView) => {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const open = new Map<string, FrameReader>();
const reader = async (url: string) => {
  let r = open.get(url);
  if (r) return r;
  for (const [k, o] of open) {
    o.close();
    open.delete(k);
  }
  r = new FrameReader();
  const blob = await (await fetch(url)).blob();
  await r.open(URL.createObjectURL(blob));
  open.set(url, r);
  return r;
};

const readers = new Map<string, ClipReader>();

const api = {
  /** read a clip the way the app does: the first look, then the seconds asked for (all of it by default) */
  async read(url: string, ranges?: [number, number][], opts: ReadOptions & { every?: number } = {}) {
    const file = await (await fetch(url)).blob();
    const at = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.src = at;
    await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    const t0 = performance.now();
    let said = '';
    const onProgress: ReadOptions['onProgress'] = (p) => {
      const s = `${p.stage} ${Math.round(p.frac * 10) * 10}%`;
      if (s !== said) console.log((said = s));
    };
    const r = await readClip({ id: url, url: at, file, duration: v.duration }, { ...opts, onProgress });
    readers.set(url, r);
    const t1 = performance.now();
    if (!ranges || ranges.length) await r.need(ranges ?? [[0, v.duration]], { onProgress, every: opts.every });
    return { look: t1 - t0, need: performance.now() - t1 };
  },
  /** is the frame taken while playing up to a second the one that starts there? (mean difference from it, and from the frames either side) */
  async frames(url: string, from: number, n: number) {
    const file = await (await fetch(url)).blob();
    const at = URL.createObjectURL(file);
    const a = new FrameReader();
    await a.open(at);
    await a.at(from);
    (a as unknown as { cost: number }).cost = 999;
    const got: { t: number; l: Float32Array }[] = [];
    for (let i = 1; i <= n; i++) {
      const t = await a.at(from + i * 0.1 + 0.004);
      (a as unknown as { cost: number }).cost = 999;
      got.push({ t, l: a.shrinker.luma() });
    }
    a.close();
    const b = new FrameReader();
    await b.open(at);
    const off = (p: Float32Array, q: Float32Array) => p.reduce((s, v, i) => s + Math.abs(v - q[i]), 0) / p.length;
    const out: string[] = [];
    for (const g of got) {
      const d: string[] = [];
      for (const k of [-1, 0, 1]) {
        await b.at(g.t + 0.003 + k / 30);
        d.push(off(g.l, b.shrinker.luma()).toFixed(2));
      }
      out.push(`${g.t.toFixed(3)}: ${d.join(' ')}`);
    }
    b.close();
    return out;
  },
  dump(url: string) {
    const d = sceneToDump(readers.get(url)!.scene);
    return { json: JSON.stringify(d.json), bytes: b64(d.bytes) };
  },
  async need(url: string, ranges: [number, number][]) {
    const t = performance.now();
    await readers.get(url)!.need(ranges);
    return performance.now() - t;
  },
  async photo(url: string) {
    const image = new Image();
    image.src = url;
    await image.decode();
    const t = performance.now();
    const s = await readPhoto({ id: url, name: url, image, width: image.naturalWidth, height: image.naturalHeight } as PhotoAsset);
    const d = sceneToDump(s);
    return { json: JSON.stringify(d.json), bytes: b64(d.bytes), ms: performance.now() - t };
  },
  load: (device?: DepthDevice) => loadDepth({ device, onDownload: (f) => console.log('download', f.toFixed(2)) }),
  async info(url: string) {
    const r = await reader(url);
    return { duration: r.duration, aspect: r.aspect, w: r.shrinker.width, h: r.shrinker.height };
  },
  /** one frame: its brightness, and its raw depth */
  async raw(url: string, t: number, depth: boolean, short?: number) {
    const r = await reader(url);
    const a = performance.now();
    const real = await r.at(t);
    const b = performance.now();
    const luma = r.shrinker.luma();
    const c = performance.now();
    const pic = depth ? await r.shrinker.picture() : null;
    const d = performance.now();
    const m = pic ? await depthOf(pic, r.shrinker.width, r.shrinker.height, { short }) : null;
    const e = performance.now();
    return { real, luma: b64(Uint8Array.from(luma, (v) => Math.round(v))), map: m ? b64(m.map) : null, ms: { seek: b - a, luma: c - b, pic: d - c, depth: e - d, net: m?.ms }, device: m?.device };
  },
};
declare global {
  interface Window {
    __depth: typeof api;
  }
}
window.__depth = api;
