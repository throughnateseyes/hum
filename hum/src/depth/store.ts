/**
 * Keeping what was read from a clip, so a second video or a reload doesn't read it again. It goes in
 * the browser's IndexedDB (a database of its own), on this computer only. The maps are packed small.
 * Everything fails quietly: a clip that can't be kept is simply read again.
 *
 *   keyOf        what a clip or photo is known by: its content, not its name
 *   recall       what is kept for it (with every map)
 *   keep         keep it; what was used longest ago makes room
 */
import type { PhotoAsset } from '../core/types';
import type { Scale } from './stretch';
import type { ClipScene } from './types';

const DB = 'hum-depth';
const SCENES = 'scenes';
const MAPS = 'maps';
/** the shape (and the method) of what is kept; older ones are read again */
export const READING = 1;
/** the most all clips' maps may take up, bytes */
const ROOM = 250e6;

/** what is known of a clip besides its scene: enough to carry on reading it */
export interface Reading {
  scene: ClipScene;
  scale: Scale;
  lift: number;
  /** the lift and the scale are fixed (a stretch has been read whole) */
  settled: boolean;
  /** per sample: read as part of a stretch */
  done: boolean[];
  /** world units a second, for the parts not read yet */
  speed: number;
}

interface Kept extends Omit<Reading, 'scene'> {
  key: string;
  v: number;
  used: number;
  bytes: number;
  scene: Omit<ClipScene, 'maps' | 'id'>;
  /** the samples whose maps are kept */
  have: number[];
}

let opening: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(SCENES, { keyPath: 'key' });
        req.result.createObjectStore(MAPS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

async function ask<T>(stores: string[], mode: IDBTransactionMode, make: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(stores, mode);
      const req = make(tx);
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

const hex = async (b: BufferSource) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

/** A clip is known by its size, its length, and what its file starts and ends with */
export async function keyOfClip(file: Blob, duration: number): Promise<string> {
  const ends = await new Blob([file.slice(0, 65536), file.slice(Math.max(0, file.size - 65536))]).arrayBuffer();
  return `${file.size}-${Math.round(duration * 1000)}-${await hex(ends)}`;
}

/** A photo is known by its shape and how it looks small */
export async function keyOfPhoto(p: Pick<PhotoAsset, 'image' | 'width' | 'height'>): Promise<string> {
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(p.image, 0, 0, 48, 48);
  return `photo-${p.width}x${p.height}-${await hex(g.getImageData(0, 0, 48, 48).data)}`;
}

const through = async (b: Uint8Array, s: { readable: ReadableStream; writable: WritableStream }) =>
  new Uint8Array(await new Response(new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(s as ReadableWritablePair<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>)).arrayBuffer());

/** a map as what each byte adds to a guess from its neighbours (mostly nothing), then deflated */
export async function pack(m: Uint8Array, w: number): Promise<Uint8Array> {
  const d = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) {
    const l = i % w ? m[i - 1] : 0;
    const b = i >= w ? m[i - w] : 0;
    const c = i % w && i >= w ? m[i - w - 1] : 0;
    d[i] = m[i] - Math.max(Math.min(l, b), Math.min(Math.max(l, b), l + b - c));
  }
  return through(d, new CompressionStream('deflate-raw'));
}

export async function unpack(p: Uint8Array, w: number): Promise<Uint8Array> {
  const m = await through(p, new DecompressionStream('deflate-raw'));
  for (let i = 0; i < m.length; i++) {
    const l = i % w ? m[i - 1] : 0;
    const b = i >= w ? m[i - w] : 0;
    const c = i % w && i >= w ? m[i - w - 1] : 0;
    m[i] += Math.max(Math.min(l, b), Math.min(Math.max(l, b), l + b - c));
  }
  return m;
}

export async function recall(key: string, id: string): Promise<Reading | null> {
  try {
    const k = await ask<Kept | undefined>([SCENES], 'readonly', (tx) => tx.objectStore(SCENES).get(key));
    if (!k || k.v !== READING) return null;
    const maps: (Uint8Array | null)[] = k.scene.times.map(() => null);
    const packed = await Promise.all(k.have.map((i) => ask<Uint8Array | undefined>([MAPS], 'readonly', (tx) => tx.objectStore(MAPS).get(`${key}:${i}`))));
    for (const [n, i] of k.have.entries()) {
      const p = packed[n];
      const m = p ? await unpack(p, k.scene.width) : null;
      if (m?.length !== k.scene.width * k.scene.height) return null;
      maps[i] = m;
    }
    void ask([SCENES], 'readwrite', (tx) => tx.objectStore(SCENES).put({ ...k, used: Date.now() }));
    return { scene: { ...k.scene, id, maps }, scale: k.scale, lift: k.lift, settled: k.settled, done: k.done, speed: k.speed };
  } catch {
    return null;
  }
}

/** Keep a reading. `fresh`: the samples whose maps changed since it was last kept. */
export async function keep(key: string, r: Reading, fresh: Iterable<number>): Promise<void> {
  try {
    const { scene } = r;
    const packed: [number, Uint8Array][] = [];
    for (const i of fresh) {
      const m = scene.maps[i];
      if (m) packed.push([i, await pack(m, scene.width)]);
    }
    const before = await ask<Kept | undefined>([SCENES], 'readonly', (tx) => tx.objectStore(SCENES).get(key));
    const old = before?.v === READING ? before : undefined;
    const { maps, id: _id, ...rest } = scene;
    const have = maps.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
    const each = packed.length ? packed.reduce((s, p) => s + p[1].length, 0) / packed.length : old && old.have.length ? old.bytes / old.have.length : 0;
    const record: Kept = { key, v: READING, used: Date.now(), bytes: each * have.length, scene: rest, have, scale: r.scale, lift: r.lift, settled: r.settled, done: r.done, speed: r.speed };
    await ask([SCENES, MAPS], 'readwrite', (tx) => {
      for (const [i, p] of packed) tx.objectStore(MAPS).put(p, `${key}:${i}`);
      tx.objectStore(SCENES).put(record);
    });
    await makeRoom(key);
  } catch {
    // kept or not, the reading itself is fine
  }
}

async function makeRoom(but: string) {
  const all = (await ask<Kept[]>([SCENES], 'readonly', (tx) => tx.objectStore(SCENES).getAll())) ?? [];
  all.sort((a, b) => a.used - b.used);
  let sum = all.reduce((s, k) => s + k.bytes, 0);
  for (const k of all) {
    if (sum <= ROOM && k.v === READING) continue;
    if (k.key === but) continue;
    sum -= k.bytes;
    await ask([SCENES, MAPS], 'readwrite', (tx) => {
      tx.objectStore(SCENES).delete(k.key);
      tx.objectStore(MAPS).delete(IDBKeyRange.bound(`${k.key}:`, `${k.key}:~`));
    });
  }
}
