/**
 * Reading what happens in a clip. A clip is gone through once, on a player of its own, a small picture
 * every tenth of a second or so; the moments found are then looked at frame by frame for the exact
 * second. What was found is kept in this browser (by the clip's content), so a clip is read once ever.
 * Nothing is sent anywhere.
 */
import type { ClipAsset } from '../core/types';
import { FrameReader } from '../depth/frames';
import { keyOfClip } from '../depth/store';
import { findEvents, frameOf, pinPoint, stepOf, type Frame, type Step } from './events';
import type { ClipMotion } from './types';

/** raised when the reading changes: clips are then read again */
const VERSION = 1;
const DB = 'hum-timing';
const STORE = 'motions';
/** the most steps a clip is gone through in */
const STEPS = 260;

let opening: Promise<IDBDatabase | null> | null = null;
const open = () =>
  (opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));

async function ask<T>(mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = make(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

let busy: () => boolean = () => false;
/** a reading under way stands still while this says so (quiet.ts) */
export function standAside(when: () => boolean) {
  busy = when;
}

const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** go through a clip (see above); throws when it can't be opened, or was cancelled */
async function read(c: Pick<ClipAsset, 'url'>, signal?: AbortSignal): Promise<ClipMotion> {
  const r = new FrameReader(signal, true);
  try {
    await r.open(c.url);
    const duration = r.duration;
    const step = Math.max(0.1, duration / STEPS);
    const { shrinker } = r;
    // a picture every `apart` seconds, each held against the one `apart` before (a long clip is stepped
    // through, but what is compared is never more than a seventh of a second apart)
    const take = async (t: number): Promise<Frame> => {
      while (busy()) await new Promise((r2) => setTimeout(r2, 300));
      const got = await r.at(t);
      const f = frameOf(shrinker.luma(), shrinker.width, shrinker.height, got);
      await breathe();
      return f;
    };
    const steps: Step[] = [];
    const n = Math.max(4, Math.floor(duration / step));
    let prev: Frame | null = null;
    for (let i = 0; i < n; i++) {
      const t0 = i * step;
      const a: Frame = step <= 0.14 && prev ? prev : await take(t0 + 0.004);
      const b = await take(Math.min(duration - 0.03, t0 + Math.min(step, 0.12) + 0.004));
      steps.push({ ...(b.t > a.t + 0.01 ? stepOf(a, b) : { ...(steps[i - 1] ?? stepOf(a, b)), lit: 0, torn: 0 }), t: t0 + step / 2 });
      prev = b;
    }
    const events = findEvents(steps, n * step);
    const gaps: number[] = [];
    for (const e of events) {
      // finely, every thirtieth, held against a tenth before
      const reach = Math.max(0.2, step * 0.8);
      const fine: Frame[] = [];
      for (let t = Math.max(0, e.at - reach - 0.05); t <= Math.min(duration - 0.03, e.at + reach + 0.05); t += 1 / 30) {
        const f = await take(t + 0.004);
        const last = fine[fine.length - 1];
        if (last && f.t <= last.t + 0.004) continue;
        if (last) gaps.push(f.t - last.t);
        fine.push(f);
      }
      const back = e.kind === 'cut' || e.kind === 'flash' ? 1 : 3;
      const pairs = fine.slice(back).map((b, k) => stepOf(fine[k], b));
      e.at = pinPoint(e, pairs);
    }
    gaps.sort((x, y) => x - y);
    const gap = gaps[gaps.length >> 1] ?? 1 / 30;
    const of = (get: (s: Step) => number) => steps.map((s) => r3(get(s)));
    return {
      v: VERSION,
      step: r3(step) === 0.1 ? 0.1 : step,
      duration,
      fps: Math.round(1 / Math.max(1 / 60, gap)),
      act: of((s) => s.act),
      camX: of((s) => s.camX),
      camY: of((s) => s.camY),
      push: of((s) => s.push),
      goX: of((s) => s.goX),
      goY: of((s) => s.goY),
      bright: of((s) => s.bright),
      events: events.map((e) => ({ ...e, at: r3(e.at), strength: r3(e.strength), x: r3(e.x), y: r3(e.y) })).sort((x, y) => x.at - y.at),
    };
  } finally {
    r.close();
  }
}

// one clip at a time (but not in turn with the depth of them, which may take minutes)
let turn: Promise<unknown> = Promise.resolve();
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const mine = turn.then(fn);
  turn = mine.catch(() => undefined);
  return mine;
}

const known = new Map<string, ClipMotion>();
const reading = new Map<string, Promise<ClipMotion | null>>();

/** how a clip moves, if it has been read */
export const motionOf = (id: string): ClipMotion | undefined => known.get(id);

/** how a clip moves; null when it can't be read. One reading at a time; asked for twice, it is read once. */
export function readMotion(c: Pick<ClipAsset, 'id' | 'url' | 'file' | 'duration'>): Promise<ClipMotion | null> {
  const had = reading.get(c.id);
  if (had) return had;
  const p = (async () => {
    try {
      const key = await keyOfClip(c.file, c.duration);
      const kept = await ask<ClipMotion | undefined>('readonly', (s) => s.get(key));
      const m = kept?.v === VERSION ? kept : await inTurn(() => read(c));
      if (m !== kept) void ask('readwrite', (s) => s.put(m, key));
      known.set(c.id, m);
      return m;
    } catch {
      // (perhaps it can be later)
      reading.delete(c.id);
      return null;
    }
  })();
  reading.set(c.id, p);
  return p;
}

/** Read several clips, one after the other. Stops waiting (the reading itself carries on) when `signal` says so. */
export async function readMotions(clips: ClipAsset[], signal?: AbortSignal, say?: (done: number, of: number) => void): Promise<void> {
  let done = 0;
  const all = Promise.all(
    clips.map(async (c) => {
      await readMotion(c);
      say?.(++done, clips.length);
    }),
  );
  if (!signal) return void (await all);
  let stop = () => {};
  const cancelled = new Promise<never>((_, no) => {
    stop = () => no(new DOMException('Cancelled', 'AbortError'));
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop);
  });
  try {
    await Promise.race([all, cancelled]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}
