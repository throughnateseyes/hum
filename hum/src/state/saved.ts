/**
 * Keeping the song and the video clips across a reload.
 *
 * They are files, far too big for localStorage, so they go in the browser's IndexedDB: on this
 * computer, for this site's address only. Nothing here is sent anywhere. Everything fails quietly
 * (a private window, a full disk): the app then simply starts empty, as it did before.
 *
 *   rememberSong / recallSong / forgetSong   the one song that is loaded
 *   recallClips, keepClipsSaved              the clips; once started, the saved set follows the store
 *   recallPhotos, keepPhotosSaved            the photos, the same way (each kept as a JPEG of the picture as loaded)
 *   recallPlan, keepPlanSaved                the video on screen, hand changes included (small: localStorage)
 */
import type { ClipAsset, PhotoAsset, TrackAnalysis } from '../core/types';
import type { VideoPlan } from './plan';
import { cutAnalysis } from './planCache';
import { useStudio } from './store';

const DB_NAME = 'hum';
const DB_VERSION = 2;
const SONG = 'song';
const CLIPS = 'clips';
const PHOTOS = 'photos';

export interface SavedSong {
  name: string;
  /** a demo is saved by its id (it is made again from code); a file, as the file */
  source: 'file' | 'demo';
  id?: string;
  blob?: Blob;
}

/** a clip as it is kept: everything but its object URL, which only lasts as long as the page */
type SavedClip = Omit<ClipAsset, 'url'> & { added: number };

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SONG)) db.createObjectStore(SONG);
        if (!db.objectStoreNames.contains(CLIPS)) db.createObjectStore(CLIPS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(PHOTOS)) db.createObjectStore(PHOTOS, { keyPath: 'id' });
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

/** one request against one store; resolves to its result, or undefined if anything went wrong */
async function ask<T>(store: string, mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest<T>): Promise<{ ok: boolean; value?: T }> {
  const db = await open();
  if (!db) return { ok: false };
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const req = make(tx.objectStore(store));
      tx.oncomplete = () => resolve({ ok: true, value: req.result });
      tx.onerror = () => resolve({ ok: false });
      tx.onabort = () => resolve({ ok: false });
    } catch {
      resolve({ ok: false });
    }
  });
}

let warned = false;
/** said once: the browser would not keep something (usually its storage is full) */
function warn() {
  if (warned) return;
  warned = true;
  useStudio.getState().flash('This browser is out of room to keep your song and clips for next time. They still work until you reload.');
}

export async function rememberSong(song: SavedSong) {
  const r = await ask(SONG, 'readwrite', (s) => s.put(song, 'current'));
  if (!r.ok) warn();
}

export async function forgetSong() {
  await ask(SONG, 'readwrite', (s) => s.delete('current'));
}

export async function recallSong(): Promise<SavedSong | null> {
  const r = await ask<SavedSong | undefined>(SONG, 'readonly', (s) => s.get('current'));
  const v = r.value;
  if (!v || typeof v.name !== 'string' || (v.source !== 'file' && v.source !== 'demo')) return null;
  if (v.source === 'file' && !(v.blob instanceof Blob)) return null;
  return v;
}

/** ids of the clips known to be saved */
const kept = new Set<string>();

/** The clips saved last time, oldest first, each with a fresh address for its file */
export async function recallClips(): Promise<ClipAsset[]> {
  const r = await ask<SavedClip[]>(CLIPS, 'readonly', (s) => s.getAll());
  const list = (r.value ?? []).filter((c) => c && typeof c.id === 'string' && c.file instanceof Blob && c.palette && Array.isArray(c.palette.flats));
  list.sort((a, b) => a.added - b.added);
  for (const c of list) kept.add(c.id);
  return list.map(({ added: _added, ...c }) => ({ ...c, url: URL.createObjectURL(c.file) }));
}

let following = false;
/** From now on, save every clip that is added and forget every clip that is removed. Call once, after recallClips. */
export function keepClipsSaved() {
  if (following) return;
  following = true;
  let order = Date.now();
  const sync = (clips: ClipAsset[]) => {
    const ids = new Set(clips.map((c) => c.id));
    for (const c of clips) {
      if (kept.has(c.id)) continue;
      kept.add(c.id);
      const { url: _url, ...rest } = c;
      const record: SavedClip = { ...rest, added: order++ };
      void ask(CLIPS, 'readwrite', (s) => s.put(record)).then((r) => {
        if (r.ok) return;
        kept.delete(c.id);
        warn();
      });
    }
    for (const id of [...kept]) {
      if (ids.has(id)) continue;
      kept.delete(id);
      void ask(CLIPS, 'readwrite', (s) => s.delete(id));
    }
  };
  sync(useStudio.getState().clips);
  useStudio.subscribe((s, prev) => {
    if (s.clips !== prev.clips) sync(s.clips);
  });
}

/* ───────── the video on screen ───────── */

const PLAN_KEY = 'hum.session.plan';

let planFollowing = false;
/** From now on, keep the video that is on (with any changes made by hand) for the next load. Call after recallPlan has had its chance. */
export function keepPlanSaved() {
  if (planFollowing) return;
  planFollowing = true;
  const save = (plan: VideoPlan | null, name: string | undefined) => {
    // a song that is still loading has no plan yet: that is not "no video", so leave what is saved
    if (!plan || !name) return;
    try {
      localStorage.setItem(PLAN_KEY, JSON.stringify({ name, plan }));
    } catch {
      /* no room: the song comes back with a freshly planned video instead */
    }
  };
  const now = useStudio.getState();
  save(now.plan, now.track?.name);
  useStudio.subscribe((s, prev) => {
    if (s.plan !== prev.plan) save(s.plan, s.track?.name);
  });
}

/**
 * The video this song had when the page was last open, if it still fits the song and every look in it
 * still exists. A plan the person split or combined parts in keeps its part lines (`bounds`): it fits
 * the fresh analysis cut at those lines, and startPlan (plan.ts) puts that cut on with it.
 */
export function recallPlan(name: string, a: TrackAnalysis, lookExists: (id: string) => boolean): VideoPlan | null {
  try {
    const j = JSON.parse(localStorage.getItem(PLAN_KEY) ?? 'null') as { name?: unknown; plan?: VideoPlan } | null;
    const p = j?.plan;
    if (!j || j.name !== name || !p || !Array.isArray(p.looks)) return null;
    const cut = cutAnalysis(a, p.bounds);
    const ok =
      !!cut &&
      p.looks.length === cut.sections.length &&
      Math.abs(p.duration - a.duration) < 0.5 &&
      p.looks.every((id) => !id || lookExists(id)) &&
      (p.rotate ?? []).every((r) => !r || r.every(lookExists)) &&
      (p.interludes ?? []).every((id) => !id || lookExists(id));
    return ok ? p : null;
  } catch {
    return null;
  }
}

/* ───────── the photos ───────── */

interface SavedPhoto {
  id: string;
  name: string;
  blob: Blob;
  added: number;
}

const keptPhotos = new Set<string>();

/** The photos saved last time, oldest first, as files to load again (each keeps its id, so a part that picked one still finds it) */
export async function recallPhotos(): Promise<{ id: string; file: File }[]> {
  const r = await ask<SavedPhoto[]>(PHOTOS, 'readonly', (s) => s.getAll());
  const list = (r.value ?? []).filter((p) => p && typeof p.id === 'string' && p.blob instanceof Blob);
  list.sort((a, b) => a.added - b.added);
  for (const p of list) keptPhotos.add(p.id);
  return list.map((p) => ({ id: p.id, file: new File([p.blob], `${p.name || 'photo'}.jpg`, { type: p.blob.type || 'image/jpeg' }) }));
}

/** the picture as it was loaded (already scaled down), as a JPEG */
function photoBlob(p: PhotoAsset): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      const c = document.createElement('canvas');
      c.width = p.width;
      c.height = p.height;
      c.getContext('2d')!.drawImage(p.image, 0, 0, p.width, p.height);
      c.toBlob((b) => resolve(b), 'image/jpeg', 0.9);
    } catch {
      resolve(null);
    }
  });
}

let photosFollowing = false;
/** From now on, save every photo that is added and forget every photo that is removed. Call once, after recallPhotos. */
export function keepPhotosSaved() {
  if (photosFollowing) return;
  photosFollowing = true;
  let order = Date.now();
  const sync = (photos: PhotoAsset[]) => {
    const ids = new Set(photos.map((p) => p.id));
    for (const p of photos) {
      if (p.builtin || keptPhotos.has(p.id)) continue;
      keptPhotos.add(p.id);
      const added = order++;
      void photoBlob(p).then(async (blob) => {
        const r = blob ? await ask(PHOTOS, 'readwrite', (s) => s.put({ id: p.id, name: p.name, blob, added } satisfies SavedPhoto)) : { ok: false };
        if (r.ok) return;
        keptPhotos.delete(p.id);
        warn();
      });
    }
    for (const id of [...keptPhotos]) {
      if (ids.has(id)) continue;
      keptPhotos.delete(id);
      void ask(PHOTOS, 'readwrite', (s) => s.delete(id));
    }
  };
  sync(useStudio.getState().photos);
  useStudio.subscribe((s, prev) => {
    if (s.photos !== prev.photos) sync(s.photos);
  });
}
