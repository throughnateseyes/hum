/**
 * Where a drawing can stand in an inside shot, how big it is and how it arrives: the ids a part's setting
 * and the art director's answer are checked against (no drawing code here; the server reads this too).
 */
export const DRAWN_PUTS = ['ground', 'between', 'far', 'wall'] as const;
export type DrawnPut = (typeof DRAWN_PUTS)[number];
export const DRAWN_SIZES = ['small', 'medium', 'large'] as const;
export type DrawnSize = (typeof DRAWN_SIZES)[number];
export const DRAWN_ENTERS = ['draw', 'rise', 'there'] as const;
export type DrawnEnter = (typeof DRAWN_ENTERS)[number];

export const PUT_LINES: Record<DrawnPut, string> = {
  ground: 'stands on the ground or floor of the picture, with a shadow under it, hidden by whoever passes in front',
  between: 'stands behind the nearest people and things and in front of what is further off',
  far: 'huge, behind everything: over the skyline, behind the hills, in the sky',
  wall: 'lies flat along a side wall or a row of buildings, in perspective',
};

/** a part's drawing, as the part keeps it (PartShot.drawn) */
export interface DrawnShot {
  /** the drawing's id (src/draw); one redrawn since stands in for it */
  id: string;
  put: DrawnPut;
  size: DrawnSize;
  enter: DrawnEnter;
  /** what it does there, in a few words */
  why?: string;
}

export function cleanDrawn(v: unknown): DrawnShot | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  const pick = <T extends string>(x: unknown, ids: readonly T[], d: T): T => (ids.includes(x as T) ? (x as T) : d);
  return {
    id: o.id.slice(0, 60),
    put: pick(o.put, DRAWN_PUTS, 'between'),
    size: pick(o.size, DRAWN_SIZES, 'medium'),
    enter: pick(o.enter, DRAWN_ENTERS, 'draw'),
    ...(typeof o.why === 'string' && o.why ? { why: o.why.slice(0, 110) } : {}),
  };
}
