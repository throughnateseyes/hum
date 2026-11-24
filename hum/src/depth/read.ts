/**
 * Reading a clip (or a photo) as a place: how far away everything in it is, where its horizon is, how
 * its camera moves (types.ts says what comes out). All of it happens on this computer.
 *
 *   readClip     a first look: six frames, a few seconds. Enough to choose shots by
 *   ClipReader   .scene fills in as more is read; .need(ranges) reads the seconds a video will use
 *   readPhoto    the one look a photo needs
 *
 * One clip is read at a time, on a player of its own (frames.ts); the model and the arithmetic run in
 * workers. What was read is kept (store.ts), so the same clip is never read twice.
 */
import type { ClipAsset, PhotoAsset } from '../core/types';
import { Desk } from './desk';
import { depthOf, loadDepth, type DepthDevice } from './estimate';
import { FrameReader, Shrinker, takeTurn } from './frames';
import { fromByte, toByte, type QuickIn, type QuickOut } from './quick';
import { keep, keyOfClip, keyOfPhoto, recall, type Reading } from './store';
import { lowered, raised, type SampleIn, type StretchOut } from './stretch';
import { slid, unslid } from './track';
import { EYE, type ClipScene, type Slide, type View } from './types';

/** seconds between samples */
export const STEP = 0.1;
/** frames of the first look */
const LOOKS = 6;
/** pictures after each of the first look's bursts, and which looks get one */
const BURST = 8;
const BURSTS = [1, 4];
/** maps a second: every sample on the graphics chip, every third on the processor */
const EVERY: Record<DepthDevice, number> = { webgpu: 1, wasm: 3 };
/** the most maps one `need` makes on the processor (about two seconds each) */
const MOST_SLOW = 90;
/** samples read at once; a longer range is read in pieces that carry on from each other */
const PIECE = 120;
/** pictures waiting for the model */
const WAITING = 3;
/** lands just inside the frame, whichever way the clip's times were rounded */
const NUDGE = 0.004;

export type ReadProgress = { stage: 'download' | 'look' | 'read'; frac: number };

export interface ReadOptions {
  signal?: AbortSignal;
  onProgress?: (p: ReadProgress) => void;
  /** seconds of the clip to read as soon as the first look is done (as `need` would) */
  stretches?: [number, number][];
  /** for tests */
  device?: DepthDevice;
}

const desk = new Desk(() => new Worker(new URL('./measure.worker.ts', import.meta.url), { type: 'module' }), 'Reading the clip failed to start');
let nextKey = 1;

const stopIf = (s: AbortSignal) => {
  if (s.aborted) throw new DOMException('Cancelled', 'AbortError');
};

/** the slide that takes b's place when everything that followed a is moved to follow a2 */
function reslide(b: Slide, a: Slide, a2: Slide): Slide {
  // b = (a, then x): take a back off, then put a2 on
  const scale = b.scale / a.scale;
  const turn = b.turn - a.turn;
  const c = Math.cos(turn) * scale;
  const k = Math.sin(turn) * scale;
  const ox = b.x - (c * a.x - k * a.y);
  const oy = b.y - (k * a.x + c * a.y);
  const [x, y] = [c * a2.x - k * a2.y + ox, k * a2.x + c * a2.y + oy];
  return { x, y, scale: a2.scale * scale, turn: a2.turn + turn };
}

const toView = (v: { x: number; y: number; roll: number }, aspect: number): View => ({ u: v.x / aspect + 0.5, v: v.y + 0.5, roll: v.roll });

function newScene(id: string, aspect: number, duration: number, w: number, h: number, times: number[]): ClipScene {
  return {
    id,
    aspect,
    duration,
    width: w,
    height: h,
    times,
    maps: times.map(() => null),
    step: STEP,
    focal: 1.25,
    zScale: 4,
    views: times.map(() => ({ u: 0.5, v: 0.5, roll: 0 })),
    slides: times.map(() => ({ x: 0, y: 0, scale: 1, turn: 0 })),
    ahead: times.map(() => 0),
    sure: { horizon: 0, slide: 0, ahead: 0 },
    sky: 0,
    ground: 0,
    near: 0,
    splits: [],
    camera: 'still',
  };
}

type Quick = Omit<QuickOut, 'maps'> & { maps: Uint8Array[] };

function takeQuick(scene: ClipScene, q: Quick) {
  Object.assign(scene, { focal: q.focal, zScale: q.zScale, sure: q.sure, sky: q.sky, ground: q.ground, near: q.near, splits: q.splits, camera: q.camera });
}

/** Read a photo: one map, its horizon, its layers. */
export async function readPhoto(photo: PhotoAsset, opts: ReadOptions = {}): Promise<ClipScene> {
  const key = await keyOfPhoto(photo);
  const kept = await recall(key, photo.id);
  if (kept) return kept.scene;
  const say = opts.onProgress;
  await loadDepth({ signal: opts.signal, device: opts.device, onDownload: (frac) => say?.({ stage: 'download', frac }) });
  const s = new Shrinker(photo.width, photo.height);
  try {
    s.take(photo.image);
    const luma = s.luma();
    const d = await depthOf(await s.picture(), s.width, s.height, { signal: opts.signal });
    const { quick } = await desk.ask<{ quick: Quick }>({ type: 'quick', frames: [{ t: 0, map: d.map, luma }], width: s.width, height: s.height, photo: true }, [], opts.signal);
    const scene = newScene(photo.id, photo.width / photo.height, 0, s.width, s.height, [0]);
    takeQuick(scene, quick);
    scene.sure = { ...scene.sure, slide: 1, ahead: 1 };
    scene.maps[0] = quick.maps[0];
    scene.views[0] = toView(quick.views[0], scene.aspect);
    scene.step = 1e9;
    void keep(key, { scene, scale: quick.scale, lift: 0, settled: true, done: [true], speed: 0 }, [0]);
    say?.({ stage: 'look', frac: 1 });
    return scene;
  } finally {
    s.close();
  }
}

/** Take a first look at a clip. What comes back can be asked for more. */
export async function readClip(asset: Pick<ClipAsset, 'id' | 'url' | 'file' | 'duration'>, opts: ReadOptions = {}): Promise<ClipReader> {
  const key = await keyOfClip(asset.file, asset.duration);
  const kept = await recall(key, asset.id);
  const r = kept ? new ClipReader(asset, key, kept, opts) : await look(asset, key, opts);
  if (opts.stretches?.length) r.need(opts.stretches, { onProgress: opts.onProgress }).catch(() => undefined);
  return r;
}

async function look(asset: Pick<ClipAsset, 'id' | 'url'>, key: string, opts: ReadOptions): Promise<ClipReader> {
  const { signal, onProgress: say } = opts;
  await loadDepth({ signal, device: opts.device, onDownload: (frac) => say?.({ stage: 'download', frac }) });
  return takeTurn(async () => {
    const fr = new FrameReader(signal);
    try {
      await fr.open(asset.url);
      const { width, height } = fr.shrinker;
      const n = Math.max(1, Math.floor((fr.duration - 0.03) / STEP) + 1);
      const times = Array.from({ length: n }, (_, i) => i * STEP);
      const looks = [...new Set(Array.from({ length: Math.min(LOOKS, n) }, (_, i) => Math.round((0.03 + (0.9 * i) / (LOOKS - 1)) * (n - 1))))];
      const frames: QuickIn[] = [];
      for (const [k, i] of looks.entries()) {
        const t = await fr.at(times[i] + NUDGE);
        times[i] = t;
        const luma = fr.shrinker.luma();
        const pic = await fr.shrinker.picture();
        const map = depthOf(pic, width, height, { signal });
        map.catch(() => undefined);
        const next: QuickIn['next'] = [];
        if (BURSTS.includes(k))
          for (let j = 1; j <= BURST && i + j < n; j++) {
            const at = await fr.at(i * STEP + j * STEP + NUDGE);
            if (at > (next[next.length - 1]?.t ?? t) + 0.01) next.push({ t: at, luma: fr.shrinker.luma() });
          }
        frames.push({ t, map: (await map).map, luma, next });
        say?.({ stage: 'look', frac: ((k + 1) / looks.length) * 0.95 });
      }
      const { quick } = await desk.ask<{ quick: Quick }>({ type: 'quick', frames, width, height, photo: false }, [], signal);
      const scene = newScene(asset.id, fr.aspect, fr.duration, width, height, times);
      takeQuick(scene, quick);
      looks.forEach((i, k) => {
        scene.maps[i] = quick.maps[k];
        scene.views[i] = toView(quick.views[k], scene.aspect);
      });
      const reading: Reading = { scene, scale: quick.scale, lift: 0, settled: false, done: times.map(() => false), speed: quick.speed };
      const r = new ClipReader(asset, key, reading, opts);
      r.fill();
      void keep(key, reading, looks);
      say?.({ stage: 'look', frac: 1 });
      return r;
    } finally {
      fr.close();
    }
  });
}

export interface NeedOptions {
  onProgress?: (p: ReadProgress) => void;
  signal?: AbortSignal;
  /** read a map only every so many samples (the rest is followed from the picture alone) */
  every?: number;
}

/** A clip that has been looked at. `scene` is filled in place as more of it is read. */
export class ClipReader {
  private stop = new AbortController();
  private turn: Promise<void> = Promise.resolve();

  constructor(
    private asset: Pick<ClipAsset, 'id' | 'url'>,
    private key: string,
    private r: Reading,
    private opts: ReadOptions,
  ) {
    opts.signal?.addEventListener('abort', () => this.cancel(), { once: true });
  }

  get scene(): ClipScene {
    return this.r.scene;
  }

  /** are these seconds all read? */
  has(ranges: [number, number][]): boolean {
    return this.runs(ranges).length === 0;
  }

  /** Stop reading. What has been read stays, and is kept. */
  cancel() {
    this.stop.abort();
    this.stop = new AbortController();
  }

  /**
   * Read these seconds of the clip (with a little either side). Settles once they are read; what was
   * read before is not read again. Several calls queue up.
   */
  need(ranges: [number, number][], opts: NeedOptions = {}): Promise<void> {
    const signal = opts.signal ? AbortSignal.any([this.stop.signal, opts.signal]) : this.stop.signal;
    const mine = this.turn.then(() => this.read(ranges, opts, signal));
    this.turn = mine.catch(() => undefined);
    return mine;
  }

  /** the samples still to read, as runs of whole pieces */
  private runs(ranges: [number, number][]): [number, number][] {
    const { scene, done } = this.r;
    const n = scene.times.length;
    const want = new Uint8Array(n);
    for (const [a, b] of ranges) {
      const lo = Math.max(0, Math.floor(Math.min(a, b) / STEP));
      const hi = Math.min(n - 1, Math.ceil(Math.max(a, b) / STEP));
      for (let i = Math.min(lo, n - 1); i <= hi; i++) want[i] = 1;
    }
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      if (!want[i] || done[i]) continue;
      let j = i;
      // a gap of a few samples is not worth stopping for
      for (let k = i; k < n && k < j + 8 && k - i < PIECE; k++) if (want[k] && !done[k]) j = k;
      // too short to tell anything from: take a little more of the clip
      let a = i;
      while (j - a < 8 && (j < n - 1 || a > 0)) {
        if (j < n - 1) j++;
        if (a > 0 && !done[a - 1]) a--;
        else if (j >= n - 1) break;
      }
      out.push([a, j]);
      i = j;
    }
    return out;
  }

  private async read(ranges: [number, number][], opts: NeedOptions, signal: AbortSignal) {
    stopIf(signal);
    const say = opts.onProgress;
    const total = this.runs(ranges).reduce((s, [a, b]) => s + b - a + 1, 0);
    if (!total) {
      say?.({ stage: 'read', frac: 1 });
      return;
    }
    const device = await loadDepth({ signal, device: this.opts.device, onDownload: (frac) => say?.({ stage: 'download', frac }) });
    const every = opts.every ?? (device === 'wasm' ? Math.max(EVERY.wasm, Math.ceil(total / MOST_SLOW)) : EVERY.webgpu);
    this.scene.step = Math.max(STEP, every * STEP);
    let before = 0;
    for (;;) {
      const [run] = this.runs(ranges);
      if (!run) break;
      await takeTurn(() => this.piece(run[0], run[1], every, signal, (k) => say?.({ stage: 'read', frac: Math.min(0.99, (before + k) / total) })));
      before += run[1] - run[0] + 1;
    }
    say?.({ stage: 'read', frac: 1 });
  }

  /** read samples from..to as one stretch, joined to what is read on either side */
  private async piece(from: number, to: number, every: number, signal: AbortSignal, tick: (k: number) => void) {
    const { scene, scale, done } = this.r;
    const { width, height } = scene;
    const n = scene.times.length;
    // carry on from the sample before, and meet the sample after
    const first = from > 0 && done[from - 1] && scene.maps[from - 1] ? from - 1 : from;
    const last = to < n - 1 && done[to + 1] && scene.maps[to + 1] ? to + 1 : to;
    const key = nextKey++;
    const fr = new FrameReader(signal);
    const inScale = (i: number) => Float32Array.from(scene.maps[i]!, (b) => raised(fromByte(b), this.r.lift) * scale.max);
    const fresh = new Set<number>();
    let finished = false;
    try {
      await fr.open(this.asset.url);
      let like: { map: Float32Array; luma: Float32Array } | undefined;
      if (first === from) {
        // the nearest sample already on the clip's scale
        let best = -1;
        for (let i = 0; i < n; i++) if (scene.maps[i] && (best < 0 || Math.abs(i - first) < Math.abs(best - first))) best = i;
        if (best >= 0) {
          await fr.at(scene.times[best] + NUDGE);
          like = { map: inScale(best), luma: fr.shrinker.luma() };
        }
      }
      const ahead = scene.camera === 'ahead';
      await desk.ask({ type: 'open', key, width, height, focal: scene.focal, scale, lift: this.r.lift, base: first < from ? scene.slides[first] : undefined, like, ahead }, [], signal);
      const slides = new Map<number, Slide>();
      const waiting: Promise<void>[] = [];
      let order: Promise<void> = Promise.resolve();
      const maps = new Map<number, Uint8Array>();
      for (let i = first; i <= last; i++) {
        stopIf(signal);
        const placed = (i === first && first < from) || (i === last && last > to);
        const want = placed || i === first || (i - first) % every === 0 || i === last;
        const real = await fr.at(i * STEP + NUDGE);
        const t = i > 0 && real <= scene.times[i - 1] ? i * STEP : real;
        if (i >= from && i <= to) scene.times[i] = t;
        const luma = fr.shrinker.luma();
        const pic = want && !placed ? await fr.shrinker.picture() : null;
        let soon: SampleIn['soon'];
        if (ahead) {
          const s = await fr.at(t + 1 / 24 + NUDGE);
          if (s > t + 0.005 && s < t + STEP * 0.8) soon = { t: s, luma: fr.shrinker.luma() };
        }
        const depth = pic ? depthOf(pic, width, height, { signal }) : null;
        depth?.catch(() => undefined);
        // a stretch is fed in order, however the model's answers come
        order = order.then(async () => {
          const map = placed ? inScale(i) : depth ? (await depth).map : null;
          const p = await desk.ask<{ map: Uint8Array | null; slide: Slide }>({ type: 'push', key, sample: { t, map, luma, soon, placed } }, [], signal);
          slides.set(i, p.slide);
          if (i < from || i > to) return;
          scene.slides[i] = p.slide;
          if (p.map) {
            maps.set(i, p.map);
            scene.maps[i] = p.map;
            fresh.add(i);
          }
          tick(i - from + 1);
        });
        order.catch(() => undefined);
        waiting.push(order);
        if (waiting.length > WAITING) await waiting.shift();
      }
      await order;
      const { out } = await desk.ask<{ out: StretchOut }>({ type: 'finish', key }, [], signal);
      finished = true;
      this.join(first, from, to, last, out);
    } finally {
      if (!finished) desk.tell({ type: 'drop', key });
      fr.close();
      const all = this.relifted ? scene.maps.keys() : fresh;
      this.relifted = false;
      void keep(this.key, this.r, all);
    }
  }
  private relifted = false;

  /** put a stretch's findings into the scene */
  private join(first: number, from: number, to: number, last: number, out: StretchOut) {
    const { scene, done, scale } = this.r;
    const n = scene.times.length;
    if (!this.r.settled) {
      this.r.settled = true;
      if (out.lift > 0) {
        this.r.lift = out.lift;
        const table = Uint8Array.from({ length: 256 }, (_, b) => toByte(lowered(fromByte(b), out.lift)));
        // new arrays, so whoever keeps a map on the graphics card sees that it changed
        scene.maps.forEach((m, k) => {
          if (m) scene.maps[k] = m.map((b) => table[b]);
        });
        scene.splits = scene.splits.map((s) => lowered(s, out.lift));
        this.relifted = true;
      }
      if (out.slope > 0) scene.zScale = scene.focal * EYE * (scale.slope > 0 && out.camera === 'ahead' ? scale.slope / scale.max : out.slope);
      // a moment of it standing still doesn't undo what the first look saw over the whole clip
      if (to - from >= 25 || scene.camera !== 'ahead') scene.camera = out.camera;
      scene.sure = { ...out.sure };
    } else {
      const part = (to - from + 1) / Math.max(1, to - from + 1 + done.filter(Boolean).length);
      for (const k of ['horizon', 'slide', 'ahead'] as const) scene.sure[k] += (out.sure[k] - scene.sure[k]) * part;
    }
    const views = out.views.map((v) => toView(v, scene.aspect));
    // a view never jumps where two stretches meet: what they differ by fades away over half a second
    const fade = (at: number, side: 1 | -1) => {
      const k = at - first;
      const old = scene.views[at];
      const d = { u: old.u - views[k].u, v: old.v - views[k].v, roll: old.roll - views[k].roll };
      for (let j = 0; j < 6; j++) {
        const v = views[k + j * side];
        if (!v) break;
        const f = 1 - j / 6;
        v.u += d.u * f;
        v.v += d.v * f;
        v.roll += d.roll * f;
      }
    };
    if (first < from) fade(first, 1);
    if (last > to) fade(last, -1);
    const start = first < from ? scene.ahead[first] : (scene.ahead[from] ?? 0);
    const old = last > to ? { slide: { ...scene.slides[last] }, ahead: scene.ahead[last] } : null;
    for (let i = from; i <= to; i++) {
      scene.views[i] = views[i - first];
      scene.slides[i] = out.slides[i - first];
      scene.ahead[i] = start + out.ahead[i - first];
      done[i] = true;
    }
    if (old) {
      // what follows was read before: it now carries on from here
      const s2 = out.slides[last - first];
      const a2 = start + out.ahead[last - first];
      for (let i = last; i < n && done[i]; i++) {
        scene.slides[i] = reslide(scene.slides[i], old.slide, s2);
        scene.ahead[i] += a2 - old.ahead;
      }
    }
    if (out.camera === 'ahead') this.r.speed = out.speeds.reduce((s, v) => s + v, 0) / Math.max(1, out.speeds.length);
    this.fill();
  }

  /** what is not read yet stands in with the nearest that is (the maps stay null) */
  fill() {
    const { scene, done, speed } = this.r;
    const { times, views, maps } = scene;
    const n = times.length;
    const known = done.map((d, i) => d || !!maps[i]);
    let a = -1;
    let b = known.indexOf(true);
    for (let i = 0; i < n; i++) {
      if (known[i]) {
        a = i;
        b = known.indexOf(true, i + 1);
        continue;
      }
      const p = a >= 0 ? views[a] : b >= 0 ? views[b] : null;
      const q = b >= 0 ? views[b] : p;
      if (p && q) {
        const f = a >= 0 && b >= 0 ? (times[i] - times[a]) / Math.max(1e-6, times[b] - times[a]) : 0;
        views[i] = { u: p.u + (q.u - p.u) * f, v: p.v + (q.v - p.v) * f, roll: p.roll + (q.roll - p.roll) * f };
      }
    }
    // slides and movement carry on from what was read; a stretch read on its own starts where the guess left off
    const firstDone = done.indexOf(true);
    if (firstDone < 0) {
      for (let i = 0; i < n; i++) scene.ahead[i] = times[i] * speed;
      return;
    }
    for (let i = firstDone - 1; i >= 0; i--) {
      scene.slides[i] = { ...scene.slides[i + 1] };
      scene.ahead[i] = scene.ahead[i + 1] - (times[i + 1] - times[i]) * speed;
    }
    for (let i = firstDone + 1; i < n; i++) {
      if (done[i]) continue;
      scene.slides[i] = { ...scene.slides[i - 1] };
      scene.ahead[i] = scene.ahead[i - 1] + (times[i] - times[i - 1]) * speed;
    }
  }
}

/** one moment of a clip: everything that changes over it, in between the samples */
export interface Moment {
  view: View;
  slide: Slide;
  ahead: number;
  /** the nearest samples with maps either side, and how far between them (0 the first .. 1 the second) */
  a: number;
  b: number;
  mix: number;
}

/** The scene at a second of the clip. For a frame on screen, give the second the frame starts at (mediaTime), not the player's clock. */
export function momentAt(scene: ClipScene, t: number): Moment {
  const { times, maps, views, slides, ahead } = scene;
  const n = times.length;
  let i = Math.min(n - 1, Math.max(0, Math.floor(t / STEP)));
  while (i > 0 && times[i] > t) i--;
  while (i < n - 1 && times[i + 1] <= t) i++;
  const j = Math.min(n - 1, i + 1);
  const f = j > i ? Math.min(1, Math.max(0, (t - times[i]) / (times[j] - times[i]))) : 0;
  const m = (p: number, q: number) => p + (q - p) * f;
  let a = i;
  while (a > 0 && !maps[a]) a--;
  let b = j;
  while (b < n - 1 && !maps[b]) b++;
  if (!maps[a]) a = b;
  if (!maps[b]) b = a;
  return {
    view: { u: m(views[i].u, views[j].u), v: m(views[i].v, views[j].v), roll: m(views[i].roll, views[j].roll) },
    slide: { x: m(slides[i].x, slides[j].x), y: m(slides[i].y, slides[j].y), scale: m(slides[i].scale, slides[j].scale), turn: m(slides[i].turn, slides[j].turn) },
    ahead: m(ahead[i], ahead[j]),
    a,
    b,
    mix: b > a ? Math.min(1, Math.max(0, (t - times[a]) / (times[b] - times[a]))) : 0,
  };
}

/** Where a point pinned to the background at second `from` sits at second `to` (frame heights from the centre) */
export function pinned(scene: ClipScene, from: number, to: number, x: number, y: number): [number, number] {
  const [bx, by] = unslid(momentAt(scene, from).slide, x, y);
  return slid(momentAt(scene, to).slide, bx, by);
}
