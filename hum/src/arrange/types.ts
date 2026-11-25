/**
 * What the person has placed by hand: pop-ups, live look windows and drawings laid over the picture, each
 * with when it is up and where it sits, and the drawings beside the words they took away. Kept by song
 * time, so parts that are cut again keep it. (A drawing that stands in the place an inside shot shows is
 * part of that shot: inside/drawnIds.ts.)
 *
 * Where a thing sits is kept per shape of frame: what is placed in a wide frame is put about there in a
 * tall one until it is placed there too. A spot set by hand is kept exactly; one carried over, or dealt,
 * still steps out of the words' way.
 */

export type FrameShape = 'wide' | 'tall' | 'square';
export const SHAPES: FrameShape[] = ['wide', 'square', 'tall'];
/** the same line the drawn looks use (scenes/draw/layout.ts shapeOf) */
export const shapeOfFrame = (W: number, H: number): FrameShape => (W / H < 0.75 ? 'tall' : W / H > 1.3 ? 'wide' : 'square');

export interface Spot {
  /** its middle, 0..1 from the frame's top-left */
  x: number;
  y: number;
  /** pop-ups and windows: times their own size; drawings laid over: their longest side as a share of the frame's short one; drawings in the place: their height as a share of the frame's */
  size: number;
  /** where the deal put it, not the person */
  dealt?: true;
}
export type Spots = Partial<Record<FrameShape, Spot>>;

/** the dice behind a look window's frame (render/sceneWindows.ts) */
export interface WindowShape {
  f: number;
  aspect: number;
  circle: number;
  size: number;
  bar: number;
}

export interface PlacedPop {
  id: string;
  /** an instrument by its title, or a look by its id with its frame */
  title?: string;
  look?: string;
  shape?: WindowShape;
  /** an instrument's title bar: 0 striped, 1 accent, 2 ink */
  style: number;
  from: number;
  to: number;
  spots: Spots;
  /** slammed shut by a drop; bursts open with its copies behind it (as it was dealt) */
  snap?: true;
  trail?: true;
}
/** all the pop-ups of a stretch of song, instead of the ones that would be dealt there */
export interface PopSet {
  from: number;
  to: number;
  wins: PlacedPop[];
}
export interface PlacedDrawing {
  id: string;
  /** the drawing (src/draw); one redrawn since stands in for it */
  drawing: string;
  from: number;
  to: number;
  enter: 'draw' | 'there';
  spots: Spots;
}
/** no drawing beside the words here */
export interface Hidden {
  from: number;
  to: number;
}

export interface Placed {
  pops: PopSet[];
  drawings: PlacedDrawing[];
  hidden: Hidden[];
}
export const NOTHING: Placed = { pops: [], drawings: [], hidden: [] };

export const POP_SIZE: [number, number] = [0.45, 2.6];
export const DRAWING_SIZE: [number, number] = [0.08, 1.1];
export const STANDING_SIZE: [number, number] = [0.08, 0.95];
export const clampTo = ([lo, hi]: [number, number], v: number) => Math.min(hi, Math.max(lo, v));

/** where a thing sits in this shape of frame, and whether it was put exactly there by hand */
export function spotFor(spots: Spots | undefined, shape: FrameShape): { spot: Spot; exact: boolean; of: FrameShape } | null {
  const own = spots?.[shape];
  if (own) return { spot: own, exact: !own.dealt, of: shape };
  const near: Record<FrameShape, FrameShape[]> = { wide: ['square', 'tall'], square: ['wide', 'tall'], tall: ['square', 'wide'] };
  for (const s of near[shape]) if (spots?.[s]) return { spot: spots[s]!, exact: false, of: s };
  return null;
}

/** a box's corner with its middle on the spot: kept well inside the frame when it was placed in another shape of it, else only kept findable */
export function cornerAt(s: Spot, box: { w: number; h: number }, W: number, H: number, inside: boolean): { x: number; y: number } {
  const m = Math.min(W, H) * 0.04;
  const along = (v: number, size: number, frame: number) => (inside ? clampTo([Math.min(m, (frame - size) / 2), Math.max(frame - size - m, (frame - size) / 2)], v) : clampTo([-size * 0.6, frame - size * 0.4], v));
  return { x: Math.round(along(s.x * W - box.w / 2, box.w, W)), y: Math.round(along(s.y * H - box.h / 2, box.h, H)) };
}

/** the pop-ups set by hand for a part (by its middle) */
export function popSetFor(p: Placed, start: number, end: number): PopSet | null {
  const mid = (start + end) / 2;
  for (let i = p.pops.length - 1; i >= 0; i--) if (mid >= p.pops[i].from && mid < p.pops[i].to) return p.pops[i];
  return null;
}

interface Stretch {
  start: number;
  end: number;
}
const within = (x: { from: number; to: number }, parts: Stretch[]) => parts.some((p) => (x.from + x.to) / 2 >= p.start && (x.from + x.to) / 2 < p.end);

/** the pop-ups of these parts are dealt again */
export function withoutPops(p: Placed, parts: Stretch[]): Placed {
  let pops = p.pops;
  for (const part of parts) {
    const set = popSetFor({ ...p, pops }, part.start, part.end);
    if (!set) continue;
    // a set made before the part was cut may cover more than this part: that stays
    const rest = [
      { ...set, to: Math.min(set.to, part.start) },
      { ...set, from: Math.max(set.from, part.end) },
    ].filter((s) => s.to - s.from > 0.3);
    pops = pops.flatMap((s) => (s === set ? rest : [s]));
  }
  return pops === p.pops ? p : { ...p, pops };
}

/** nothing placed by hand in these parts */
export function withoutAny(p: Placed, parts: Stretch[]): Placed {
  const q = withoutPops(p, parts);
  const drawings = q.drawings.filter((d) => !within(d, parts));
  const hidden = q.hidden.filter((h) => !within(h, parts));
  return q === p && drawings.length === p.drawings.length && hidden.length === p.hidden.length ? p : { ...q, drawings, hidden };
}

/* ───────── reading it back ───────── */

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown, most: number): unknown[] => (Array.isArray(v) ? v.slice(0, most) : []);
const text = (v: unknown, most: number) => (typeof v === 'string' && v && v.length <= most ? v : null);
const times = (o: Record<string, unknown>): { from: number; to: number } | null => {
  const from = num(o.from, 0, 36000);
  const to = num(o.to, 0, 36000);
  return from === null || to === null || to <= from ? null : { from, to };
};

export function cleanSpots(v: unknown, size: [number, number]): Spots | null {
  if (!obj(v)) return null;
  const out: Spots = {};
  for (const s of SHAPES) {
    const o = v[s];
    if (!obj(o)) continue;
    const x = num(o.x, -0.5, 1.5);
    const y = num(o.y, -0.5, 1.5);
    const z = num(o.size, size[0], size[1]);
    if (x === null || y === null || z === null) continue;
    out[s] = { x, y, size: z, ...(o.dealt === true ? { dealt: true as const } : {}) };
  }
  return Object.keys(out).length ? out : null;
}

function cleanPop(v: unknown): PlacedPop | null {
  if (!obj(v)) return null;
  const id = text(v.id, 60);
  const t = times(v);
  const spots = cleanSpots(v.spots, POP_SIZE);
  const title = text(v.title, 40);
  const look = text(v.look, 80);
  if (!id || !t || !spots || (!title && !look)) return null;
  const sh = obj(v.shape) ? v.shape : {};
  const roll = (k: string) => num(sh[k], 0, 0.9999) ?? 0.2;
  return {
    id,
    ...t,
    ...(look ? { look, shape: { f: roll('f'), aspect: roll('aspect'), circle: roll('circle'), size: roll('size'), bar: roll('bar') } } : { title: title! }),
    style: Math.round(num(v.style, 0, 2) ?? 0),
    spots,
    ...(v.snap === true ? { snap: true as const } : {}),
    ...(v.trail === true ? { trail: true as const } : {}),
  };
}

export function cleanPlaced(v: unknown): Placed {
  if (!obj(v)) return NOTHING;
  const pops = list(v.pops, 400).flatMap((s): PopSet[] => {
    if (!obj(s)) return [];
    const t = times(s);
    return t ? [{ ...t, wins: list(s.wins, 60).flatMap((w) => cleanPop(w) ?? []) }] : [];
  });
  const drawings = list(v.drawings, 300).flatMap((d): PlacedDrawing[] => {
    if (!obj(d)) return [];
    const id = text(d.id, 60);
    const drawing = text(d.drawing, 60);
    const t = times(d);
    const spots = cleanSpots(d.spots, DRAWING_SIZE);
    return id && drawing && t && spots ? [{ id, drawing, ...t, enter: d.enter === 'there' ? 'there' : 'draw', spots }] : [];
  });
  const hidden = list(v.hidden, 400).flatMap((h): Hidden[] => {
    const t = obj(h) ? times(h) : null;
    return t ? [t] : [];
  });
  return pops.length || drawings.length || hidden.length ? { pops, drawings, hidden } : NOTHING;
}

/* ───────── kept per song in this browser ───────── */

const KEY = 'hum.placed';
/** songs kept, oldest dropped first (as many as the other per-song settings) */
const MAX_SONGS = 24;

function readAll(): Record<string, unknown> {
  try {
    const j: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return obj(j) ? j : {};
  } catch {
    return {};
  }
}

export const loadPlaced = (song: string): Placed => cleanPlaced(song ? readAll()[song] : null);

export function savePlaced(song: string, p: Placed) {
  if (!song) return;
  try {
    const all = readAll();
    delete all[song];
    if (p.pops.length || p.drawings.length || p.hidden.length) all[song] = p;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SONGS))) delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage may be unavailable */
  }
}
