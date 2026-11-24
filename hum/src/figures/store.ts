/**
 * Line figures: the ones the person has, in memory and kept in the browser's DRAWINGS store (the same
 * store pen drawings use, told apart by kind: 'figure').
 *
 *   listFigures()        what there is, oldest first (kept figures arrive a moment after the app opens)
 *   addFigure(saved)     add or replace one, and keep it
 *   removeFigure(id)     forget one
 *   recallFigures()      read the kept ones (runs once on its own)
 *   onFigures(fn)        told when the list changes; returns the way to stop
 */
import { DRAWINGS, ask } from '../state/saved';
import { validateFigure, type Figure } from './format';

export interface SavedFigure {
  id: string;
  kind: 'figure';
  /** the object, in a word or two */
  object: string;
  brief: string;
  mood: string;
  figure: Figure;
  /** when it was made (ms) */
  made: number;
  /** the song it was made for */
  song?: string;
}

let list: SavedFigure[] = [];
const ears = new Set<() => void>();
const tell = () => ears.forEach((f) => f());

export const listFigures = (): readonly SavedFigure[] => list;
export const figureCount = () => list.length;
export const getFigure = (id: string) => list.find((f) => f.id === id);
export function onFigures(fn: () => void): () => void {
  ears.add(fn);
  return () => {
    ears.delete(fn);
  };
}

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');

/** a figure from storage or a file is checked again before it is drawn */
export function readSaved(raw: unknown): SavedFigure | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'figure' || typeof r.id !== 'string' || !r.id) return null;
  const c = validateFigure(r.figure);
  if (!c) return null;
  return {
    id: r.id.slice(0, 80),
    kind: 'figure',
    object: clip(r.object, 80) || c.figure.name,
    brief: clip(r.brief, 600),
    mood: clip(r.mood, 120),
    figure: c.figure,
    made: typeof r.made === 'number' && Number.isFinite(r.made) ? r.made : 0,
    ...(typeof r.song === 'string' ? { song: r.song.slice(0, 200) } : {}),
  };
}

export const newFigureId = () => `figure-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/** add or replace a figure; `keep: false` for one that should not outlive the page */
export function addFigure(saved: SavedFigure, keep = true): boolean {
  const s = readSaved(saved);
  if (!s) return false;
  list = [...list.filter((x) => x.id !== s.id), s].sort((a, b) => a.made - b.made);
  tell();
  if (keep) void ask(DRAWINGS, 'readwrite', (st) => st.put(s));
  return true;
}

export function removeFigure(id: string) {
  if (!list.some((x) => x.id === id)) return;
  list = list.filter((x) => x.id !== id);
  tell();
  void ask(DRAWINGS, 'readwrite', (st) => st.delete(id));
}

let recalling: Promise<void> | null = null;
export function recallFigures(): Promise<void> {
  recalling ??= (async () => {
    if (typeof indexedDB === 'undefined') return;
    const r = await ask<unknown[]>(DRAWINGS, 'readonly', (st) => st.getAll());
    const found = (r.value ?? []).map(readSaved).filter((x): x is SavedFigure => !!x);
    if (!found.length) return;
    // anything added while we were reading is newer
    const have = new Set(list.map((x) => x.id));
    list = [...list, ...found.filter((x) => !have.has(x.id))].sort((a, b) => a.made - b.made);
    tell();
  })();
  return recalling;
}
