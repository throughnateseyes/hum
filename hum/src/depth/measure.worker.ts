/// <reference lib="webworker" />
/**
 * The arithmetic of reading a clip (quick.ts, stretch.ts), away from the page so nothing on it stutters.
 *
 * in:  { type: 'quick', id, frames, width, height, photo }
 *      · { type: 'open', id, key, width, height, focal, scale, lift, base?, like?, ahead? }
 *      · { type: 'edges', id, luma, width, height } (the frame's lines: edges.ts)
 *      · { type: 'push', id, key, sample } · { type: 'finish', id, key } · { type: 'drop', key }
 * out: { id, type: 'done', ... } · { id, type: 'error', message }
 *
 * Maps go out as the bytes they are kept as (types.ts). A stretch is fed in order; see stretch.ts.
 */
import { quickRead, toByte, type QuickIn } from './quick';
import { edgesOf } from './edges';
import { lowered, Stretch, type SampleIn, type Scale } from './stretch';
import type { Slide } from './types';

type Msg =
  | { type: 'quick'; id: number; frames: QuickIn[]; width: number; height: number; photo: boolean }
  | { type: 'open'; id: number; key: number; width: number; height: number; focal: number; scale: Scale; lift: number; base?: Slide; like?: { map: Float32Array; luma: Float32Array }; ahead?: boolean }
  | { type: 'push'; id: number; key: number; sample: SampleIn }
  | { type: 'edges'; id: number; luma: Float32Array; width: number; height: number }
  | { type: 'finish'; id: number; key: number }
  | { type: 'drop'; key: number }
  | { type: 'cancel'; id: number };

const post = (m: Record<string, unknown>, move: Transferable[] = []) => (self as unknown as Worker).postMessage(m, move);
const open = new Map<number, { s: Stretch; lift: number }>();
const bytes = (map: Float32Array, lift: number) => Uint8Array.from(map, (n) => toByte(lowered(Math.min(1, n), lift)));

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === 'cancel') return;
  if (m.type === 'drop') {
    open.delete(m.key);
    return;
  }
  try {
    if (m.type === 'quick') {
      const { maps, ...rest } = quickRead(m.frames, m.width, m.height, m.photo);
      post({ id: m.id, type: 'done', quick: { ...rest, maps: maps.map((x) => bytes(x, 0)) } });
    } else if (m.type === 'edges') {
      const edges = edgesOf(m.luma, m.width, m.height);
      post({ id: m.id, type: 'done', edges }, [edges.buffer as ArrayBuffer]);
    } else if (m.type === 'open') {
      open.set(m.key, { s: new Stretch(m.width, m.height, m.focal, m.scale, m.base, m.like ?? null, m.ahead), lift: m.lift });
      post({ id: m.id, type: 'done' });
    } else {
      const o = open.get(m.key);
      if (!o) throw new Error('that stretch is not open');
      if (m.type === 'push') {
        const r = o.s.push(m.sample);
        const map = r.map && bytes(r.map, o.lift);
        post({ id: m.id, type: 'done', map, slide: r.slide, slideSure: r.slideSure }, map ? [map.buffer as ArrayBuffer] : []);
      } else {
        open.delete(m.key);
        post({ id: m.id, type: 'done', out: o.s.finish() });
      }
    }
  } catch (err) {
    post({ id: m.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
