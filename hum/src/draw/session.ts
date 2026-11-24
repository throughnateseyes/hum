/**
 * The drawings in the app: bringing them back, keeping them, and the questions everything else asks
 * (which drawings does this song have, may they show at all, which ones does this part use).
 *
 * Drawings are locked to people whose access allows them (useAccessGate.canDraw). Without it nothing here
 * even reads the saved ones: no drawing, no look and no control that mentions them exists.
 */
import { useAccessGate, learnCan } from '../director/access';
import { ask, DRAWINGS } from '../state/saved';
import { useStudio, type StudioState } from '../state/store';
import type { Figure } from '../figures/format';
import { isHandId } from './format';
import { kindOf } from './kinds';
import { drawPartAt } from './parts';
import { seedOf } from './pen';
import type { DrawingAsset, DrawPart, DrawShape, DrawStyle } from './types';

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const texts = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, n).map((x) => x.slice(0, max)) : []);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function cleanStyle(raw: unknown): DrawStyle {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { hand: isHandId(s.hand) ? s.hand : 'pen', colour: s.colour === true, manner: text(s.manner, 300) };
}

export const cleanShape = (v: unknown): DrawShape => (v === 'tall' || v === 'wide' ? v : 'square');

const cleanSpans = (v: unknown): { start: number; end: number }[] =>
  (Array.isArray(v) ? v : []).slice(0, 24).flatMap((p) => {
    const start = num((p as Record<string, unknown> | null)?.start);
    const end = num((p as Record<string, unknown> | null)?.end);
    return start !== null && end !== null && end > start ? [{ start, end }] : [];
  });

/** a saved drawing made safe; null for one that can't be used, or of a kind this version doesn't know */
export function cleanAsset(raw: unknown): DrawingAsset | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = text(o.id, 60);
  const kind = kindOf(text(o.kind, 20));
  if (!id || !kind) return null;
  const data = kind.clean(o.data);
  if (!data) return null;
  return {
    id,
    kind: o.kind as string,
    name: text(o.name, 40) || 'Drawing',
    why: text(o.why, 240),
    brief: text(o.brief, 700),
    wide: cleanShape(o.wide),
    ...(typeof o.suits === 'string' ? { suits: text(o.suits, 20) } : {}),
    words: texts(o.words, 8, 24).map((w) => w.toLowerCase()),
    lines: texts(o.lines, 16, 140),
    parts: cleanSpans(o.parts),
    songs: texts(o.songs, 60, 200),
    style: cleanStyle(o.style),
    seed: num(o.seed) ?? seedOf(id),
    data,
    added: num(o.added) ?? 0,
    ...(typeof o.from === 'string' ? { from: text(o.from, 60) } : {}),
  };
}

/* ───────────────────────── keeping them ───────────────────────── */

let started = false;
let recalled = false;
/** ids saved, with the object last saved for each */
const kept = new Map<string, DrawingAsset>();

function sync(s: StudioState) {
  const gone = new Set(s.drawTrash);
  const now = s.drawings.filter((d) => !gone.has(d.id));
  const ids = new Set(now.map((d) => d.id));
  for (const d of now) {
    if (kept.get(d.id) === d) continue;
    kept.set(d.id, d);
    void ask(DRAWINGS, 'readwrite', (st) => st.put(d)).then((r) => {
      if (!r.ok) kept.delete(d.id);
    });
  }
  // deleted: out of the saved set now (an undo puts it back, and saves it again)
  for (const id of [...kept.keys()]) {
    if (ids.has(id)) continue;
    kept.delete(id);
    void ask(DRAWINGS, 'readwrite', (st) => st.delete(id));
  }
}

async function recall() {
  if (recalled) return;
  recalled = true;
  const r = await ask<unknown[]>(DRAWINGS, 'readonly', (s) => s.getAll());
  const list = (r.value ?? []).flatMap((x) => cleanAsset(x) ?? []).sort((a, b) => a.added - b.added);
  for (const d of list) kept.set(d.id, d);
  const have = new Set(useStudio.getState().drawings.map((d) => d.id));
  const fresh = list.filter((d) => !have.has(d.id));
  if (fresh.length) useStudio.getState().set({ drawings: [...fresh, ...useStudio.getState().drawings] });
  useStudio.subscribe((s, prev) => {
    if (s.drawings !== prev.drawings || s.drawTrash !== prev.drawTrash) sync(s);
  });
  sync(useStudio.getState());
}

/** On start-up: find out whether drawings are allowed here, and if they are, bring the saved ones back. */
export function startDrawings() {
  if (started) return;
  started = true;
  if (useAccessGate.getState().canDraw) void recall();
  useAccessGate.subscribe((g) => {
    if (g.canDraw) void recall();
  });
  if (!useAccessGate.getState().canDraw) void learnCan();
}

/* ───────────────────────── what each part does with them ───────────────────────── */

/** change what the parts covering these stretches do; a part left with nothing to say is dropped */
export function setDrawParts(spans: { start: number; end: number }[], patch: Partial<Pick<DrawPart, 'ids' | 'off'>>) {
  const s = useStudio.getState();
  let list = s.drawParts;
  for (const span of spans) {
    const was = drawPartAt(list, (span.start + span.end) / 2);
    const next: DrawPart = { ...was, from: span.start, to: span.end, ...patch };
    if (!next.ids?.length) delete next.ids;
    if (!next.off) delete next.off;
    // the stretch is cut out of whatever covered it, then set on its own
    list = list.flatMap((p) => {
      if (p.to <= span.start || p.from >= span.end) return [p];
      const out: DrawPart[] = [];
      if (p.from < span.start - 0.01) out.push({ ...p, to: span.start });
      if (p.to > span.end + 0.01) out.push({ ...p, from: span.end });
      return out;
    });
    if (next.ids || next.off) list = [...list, next];
  }
  s.set({ drawParts: [...list].sort((a, b) => a.from - b.from) });
}

/* ───────────────────────── the questions everyone asks ───────────────────────── */

export const songName = (s: StudioState) => s.track?.name ?? '';

const NONE: DrawingAsset[] = [];
let memo: { drawings: DrawingAsset[]; trash: string[]; song: string; all: DrawingAsset[]; here: DrawingAsset[] } | null = null;

function lists(s: StudioState) {
  const song = songName(s);
  if (!memo || memo.drawings !== s.drawings || memo.trash !== s.drawTrash || memo.song !== song) {
    const gone = new Set(s.drawTrash);
    const all = s.drawings.filter((d) => !gone.has(d.id));
    memo = { drawings: s.drawings, trash: s.drawTrash, song, all, here: song ? all.filter((d) => d.songs.includes(song)) : NONE };
  }
  return memo;
}

/** may drawings show at all? */
export const drawOpen = () => useAccessGate.getState().canDraw;

/** every drawing that isn't deleted, oldest first (the same array until something changes) */
export const allDrawings = (s: StudioState = useStudio.getState()): DrawingAsset[] => (drawOpen() ? lists(s).all : NONE);

/** this song's drawings */
export const drawingsHere = (s: StudioState = useStudio.getState()): DrawingAsset[] => (drawOpen() ? lists(s).here : NONE);

/** a Sketchbook look has something to show right now (the one question every planner and list asks) */
export const drawingsReady = () => drawingsHere().some((d) => d.kind === 'pen');

/** a line figure look has something to show right now */
export const figuresReady = () => drawingsHere().some((d) => d.kind === 'figure');

/** the line figures for song time t: the ones picked for the part playing, else all of the song's, oldest first */
export function figuresAt(t: number, s: StudioState = useStudio.getState()): Figure[] {
  const all = drawingsHere(s).filter((d) => d.kind === 'figure');
  const picked = (drawPartAt(s.drawParts, t)?.ids ?? []).flatMap((id) => {
    const d = drawingNow(id, all);
    return d ? [d] : [];
  });
  return (picked.length ? picked : all).map((d) => d.data as Figure);
}

/** the drawing now standing in for this id (one that was redrawn points at its newer self) */
export function drawingNow(id: string, list: DrawingAsset[]): DrawingAsset | null {
  let at = id;
  for (let i = 0; i < 12; i++) {
    const here = list.find((d) => d.id === at);
    if (here) return here;
    const next = useStudio.getState().drawings.find((d) => d.from === at);
    if (!next) return null;
    at = next.id;
  }
  return null;
}

/** put a drawing in this song, or take it out (it stays in the library) */
export function setInSong(id: string, on: boolean) {
  const s = useStudio.getState();
  const song = songName(s);
  if (!song) return;
  s.set({
    drawings: s.drawings.map((d) => (d.id !== id || d.songs.includes(song) === on ? d : { ...d, songs: on ? [...d.songs, song] : d.songs.filter((x) => x !== song) })),
  });
}

export function deleteDrawing(id: string) {
  const s = useStudio.getState();
  if (!s.drawTrash.includes(id)) s.set({ drawTrash: [...s.drawTrash, id] });
}
