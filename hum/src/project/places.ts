/**
 * Where projects are kept: folders on this computer (Chrome and Edge let a page keep one, with the
 * person's leave), and the list of the ones opened lately. The list and the leave are in the browser's
 * IndexedDB; the projects themselves are ordinary files.
 */

type Leave = 'granted' | 'denied' | 'prompt';
type WithLeave = { queryPermission?: (o: { mode: 'readwrite' }) => Promise<Leave>; requestPermission?: (o: { mode: 'readwrite' }) => Promise<Leave> };

interface Pickers {
  showDirectoryPicker?: (o: { id?: string; mode?: string; startIn?: string | FileSystemHandle }) => Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker?: (o: { id?: string; suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
}
const pickers = () => window as unknown as Pickers;

/** can this browser keep a project in a folder? (Chrome and Edge on a computer) */
export const canKeepFolders = () => typeof window !== 'undefined' && !!pickers().showDirectoryPicker;

export const pickFolder = () => pickers().showDirectoryPicker!({ id: 'hum', mode: 'readwrite', startIn: 'documents' });

/** where to put one file; undefined when the browser can't ask (it is downloaded instead) */
export const pickFile = (name: string) => pickers().showSaveFilePicker?.({ id: 'hum', suggestedName: name, types: [{ description: 'Hum project', accept: { 'application/x-hum': ['.hum'] } }] });

/** the person closed the picker */
export const cancelled = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** may we write there? `ask`: ask for leave if need be (only from a click) */
export async function allowed(h: FileSystemHandle, ask: boolean): Promise<boolean> {
  const p = h as unknown as WithLeave;
  try {
    if (!p.queryPermission) return true;
    if ((await p.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return ask && (await p.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/** a file or folder name that every system takes */
export const safeName = (s: string, most = 60) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, most)
    .trim() || 'Untitled';

async function dirOf(root: FileSystemDirectoryHandle, path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = path.split('/');
  const name = parts.pop()!;
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name };
}

export async function readIn(root: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  try {
    const { dir, name } = await dirOf(root, path, false);
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

/** written beside the old one and put in its place at the end: a write that is cut short leaves the old file */
export async function writeIn(root: FileSystemDirectoryHandle, path: string, blob: Blob) {
  const { dir, name } = await dirOf(root, path, true);
  await writeTo(await dir.getFileHandle(name, { create: true }), blob);
}

export async function writeTo(h: FileSystemFileHandle, blob: Blob) {
  const w = await h.createWritable();
  try {
    await blob.stream().pipeTo(w);
  } catch (e) {
    await w.abort().catch(() => undefined);
    throw e;
  }
}

export async function namesIn(root: FileSystemDirectoryHandle, path: string): Promise<string[]> {
  try {
    const dir = path ? await root.getDirectoryHandle(path) : root;
    const out: string[] = [];
    for await (const [name] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) out.push(name);
    return out;
  } catch {
    return [];
  }
}

/* ───────── what was opened lately, and where new ones go ───────── */

export interface Recent {
  id: string;
  name: string;
  at: number;
  handle: FileSystemDirectoryHandle;
}

const DB = 'hum-projects';
let opening: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('recent', { keyPath: 'id' });
        req.result.createObjectStore('place');
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
async function ask<T>(store: string, mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const req = make(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

const MOST_RECENT = 12;
export async function recents(): Promise<Recent[]> {
  return ((await ask<Recent[]>('recent', 'readonly', (s) => s.getAll())) ?? []).filter((r) => r?.handle).sort((a, b) => b.at - a.at);
}
export async function noteRecent(r: Recent) {
  await ask('recent', 'readwrite', (s) => s.put(r));
  for (const old of (await recents()).slice(MOST_RECENT)) await ask('recent', 'readwrite', (s) => s.delete(old.id));
}
export const forgetRecent = (id: string) => ask('recent', 'readwrite', (s) => s.delete(id));
export const recentById = async (id: string) => (await recents()).find((r) => r.id === id) ?? null;

/** the folder new projects go in */
export const home = () => ask<FileSystemDirectoryHandle | undefined>('place', 'readonly', (s) => s.get('home'));
export const setHome = (h: FileSystemDirectoryHandle) => ask('place', 'readwrite', (s) => s.put(h, 'home'));
