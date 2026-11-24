/**
 * Line figures: the data format.
 *
 * A figure is a list of rounded solids with thin marks on their faces, groups for parts that move
 * together, and motions bound to what the song is doing. It is data only: Claude writes it, we check
 * every number here, and nothing in it is ever run as code.
 *
 * World: x runs to the right and toward you (down-right on screen), y runs to the left and toward you
 * (down-left), z is up. So the faces you see are the top (+z), the right (+x) and the front (+y).
 * A figure is about 100 units across; the engine fits it to the frame whatever its size.
 *
 *   validateFigure(raw)   the checked figure and what was changed, or null when it can't be drawn
 *   FIGURE_SCHEMA         the JSON schema Claude answers with (server/steps/figure.ts)
 *
 * The server imports this file too, so it imports nothing.
 */

export type V3 = [number, number, number];
export type Axis = 'x' | 'y' | 'z';
export type Face = 'top' | 'bottom' | 'front' | 'back' | 'right' | 'left';

export const SHAPES = ['box', 'disc', 'ball', 'poly', 'tube'] as const;
export const FACES: Face[] = ['top', 'bottom', 'front', 'back', 'right', 'left'];
export const MARKS = ['dot', 'dots', 'line', 'lines', 'ring', 'rect'] as const;
export const MOTIONS = ['lift', 'slide', 'hinge', 'spin', 'spread', 'ripple', 'stack', 'breathe'] as const;
export const DRIVERS = ['bass', 'kick', 'snare', 'hat', 'energy', 'beat', 'build', 'drop'] as const;
export type Shape = (typeof SHAPES)[number];
export type MotionKind = (typeof MOTIONS)[number];
export type Driver = (typeof DRIVERS)[number];

export interface FigureMark {
  face: Face;
  kind: (typeof MARKS)[number];
  /** u0, v0, u1, v1 on the face, 0..1 (see faceAxes) */
  box: [number, number, number, number];
  /** dots: columns and rows; lines: how many upright and how many level */
  n: [number, number];
  /** radius in units (dots, ring) or corner radius (rect) */
  r: number;
}

export interface FigureSolid {
  id: string;
  shape: Shape;
  /** the way it stands: its footprint lies across this axis */
  axis: Axis;
  /** its box in the world: lowest and highest corner (a tube's is worked out from its path) */
  from: V3;
  to: V3;
  /** footprint corner radius, units */
  round: number;
  /** how far the rims are rounded over, units */
  edge: number;
  /** size of the far end (the high end of `axis`) against the near end */
  taper: [number, number];
  /** how far the far end is shifted across, units */
  shift: [number, number];
  /** poly: the outline in the footprint, 0..1 */
  outline?: [number, number][];
  /** tube: its path and half-thickness */
  path?: V3[];
  r?: number;
  closed?: boolean;
  smooth?: boolean;
  /** tube: its first / last end stands on a face (worked out here) and ends flat on it */
  seats?: [boolean, boolean];
  tilt?: { axis: Axis; deg: number; about: V3 };
  group?: string;
  /** 0 paper, 1 a soft tint, 2 a solid tone */
  tone: 0 | 1 | 2;
  /** the one bright part */
  bright?: boolean;
  marks: FigureMark[];
}

export interface FigureGroup {
  id: string;
  parent?: string;
}

export interface FigureMotion {
  do: MotionKind;
  of: string[];
  by: Driver;
  /** units (lift, slide, spread, ripple, stack), degrees (hinge), turns a bar (spin), fraction (breathe) */
  amt: number;
  axis: Axis | 'out';
  pivot?: V3;
  /** beats between one item of `of` and the next */
  lag: number;
}

export interface Figure {
  name: string;
  why: string;
  solids: FigureSolid[];
  groups: FigureGroup[];
  motions: FigureMotion[];
}

export const LIMITS = { solids: 80, marks: 8, markTotal: 90, dots: 120, groups: 16, motions: 8, poly: 16, path: 10, reach: 160, depth: 4 };
/** the most each motion may do */
const MAX_AMT: Record<MotionKind, number> = { lift: 24, slide: 24, hinge: 110, spin: 2, spread: 22, ripple: 14, stack: 48, breathe: 0.12 };

const AXES: readonly Axis[] = ['x', 'y', 'z'];
export const axisIndex = (a: Axis): 0 | 1 | 2 => (a === 'x' ? 0 : a === 'y' ? 1 : 2);
/** the two world axes a footprint across `axis` is written in, in order */
export const crossAxes = (a: Axis): [0 | 1 | 2, 0 | 1 | 2] => (a === 'x' ? [1, 2] : a === 'y' ? [0, 2] : [0, 1]);
/** which axis a face looks along, and which way */
export const faceAxis = (f: Face): { axis: Axis; dir: 1 | -1 } =>
  f === 'top' ? { axis: 'z', dir: 1 } : f === 'bottom' ? { axis: 'z', dir: -1 } : f === 'front' ? { axis: 'y', dir: 1 } : f === 'back' ? { axis: 'y', dir: -1 } : f === 'right' ? { axis: 'x', dir: 1 } : { axis: 'x', dir: -1 };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const numOr = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => ((list as readonly unknown[]).includes(v) ? (v as T) : d);
const text = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[^\p{L}\p{N} ,.'’()&-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');
const idOf = (v: unknown) => (typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(v) ? v : '');

function v3(v: unknown): V3 | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const out = v.slice(0, 3).map((x) => (typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= LIMITS.reach ? x : NaN));
  return out.some(Number.isNaN) ? null : (out as V3);
}
function pair(v: unknown, d: number, lo: number, hi: number): [number, number] {
  if (typeof v === 'number') return [numOr(v, d, lo, hi), numOr(v, d, lo, hi)];
  if (!Array.isArray(v)) return [d, d];
  return [numOr(v[0], d, lo, hi), numOr(v[1], d, lo, hi)];
}

/** no edge of the outline crosses another (a figure-eight can't be filled) */
function simplePolygon(p: [number, number][]): boolean {
  const n = p.length;
  const side = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a = p[i];
      const b = p[(i + 1) % n];
      const c = p[j];
      const d = p[(j + 1) % n];
      if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return false;
    }
  return true;
}
const polygonArea = (p: [number, number][]) => p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1], 0) / 2;

function readMark(raw: unknown, s: FigureSolid): FigureMark | null {
  if (!isObj(raw)) return null;
  const face = oneOf(raw.face, FACES, 'top');
  // a curved side has no flat face to print on: a disc or a poly only takes marks on its two ends
  if (s.shape === 'ball' || s.shape === 'tube') return null;
  if (s.shape !== 'box' && faceAxis(face).axis !== s.axis) return null;
  const b = Array.isArray(raw.box) ? raw.box : [];
  const box = [0, 1, 2, 3].map((i) => numOr(b[i], i < 2 ? 0.2 : 0.8, 0, 1)) as FigureMark['box'];
  const n = pair(raw.n, 1, 0, 24).map(Math.round) as [number, number];
  const kind = oneOf(raw.kind, MARKS, 'line');
  if (kind === 'dots') while (n[0] * n[1] > LIMITS.dots) n[n[0] > n[1] ? 0 : 1]--;
  return { face, kind, box, n, r: numOr(raw.r, 0.8, 0.2, 40) };
}

function readSolid(raw: unknown, i: number): FigureSolid | null {
  if (!isObj(raw)) return null;
  const shape = oneOf(raw.shape, SHAPES, 'box');
  const s: FigureSolid = {
    id: idOf(raw.id) || `s${i}`,
    shape,
    axis: oneOf(raw.axis, AXES, 'z'),
    from: [0, 0, 0],
    to: [0, 0, 0],
    round: numOr(raw.round, 1.5, 0, 60),
    edge: numOr(raw.edge, 0.9, 0, 30),
    taper: pair(raw.taper, 1, 0.05, 1.8),
    shift: pair(raw.shift, 0, -60, 60),
    tone: raw.tone === 2 ? 2 : raw.tone === 1 ? 1 : 0,
    marks: [],
  };
  const group = idOf(raw.group);
  if (group) s.group = group;
  if (raw.bright === true) s.bright = true;
  if (shape === 'tube') {
    const path = (Array.isArray(raw.path) ? raw.path : []).slice(0, LIMITS.path).map(v3);
    if (path.length < 2 || path.some((p) => !p)) return null;
    s.path = path as V3[];
    s.r = numOr(raw.r, 1.5, 0.3, 20);
    s.closed = raw.closed === true && path.length > 2;
    s.smooth = raw.smooth !== false;
    for (let k = 0; k < 3; k++) {
      s.from[k] = Math.min(...s.path.map((p) => p[k])) - s.r;
      s.to[k] = Math.max(...s.path.map((p) => p[k])) + s.r;
    }
  } else {
    const a = v3(raw.from);
    const b = v3(raw.to);
    if (!a || !b) return null;
    for (let k = 0; k < 3; k++) {
      s.from[k] = Math.min(a[k], b[k]);
      s.to[k] = Math.max(a[k], b[k]);
      // nothing is paper-thin: a plate with no thickness has no side to draw
      if (s.to[k] - s.from[k] < 0.4) s.to[k] = s.from[k] + 0.4;
    }
  }
  if (shape === 'poly') {
    const pts = (Array.isArray(raw.outline) ? raw.outline : []).slice(0, LIMITS.poly).map((p) => pair(p, 0, 0, 1));
    const near = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.004;
    const clean = pts.filter((p, k) => k === 0 || !near(p, pts[k - 1]));
    if (clean.length > 2 && near(clean[0], clean[clean.length - 1])) clean.pop();
    const area = polygonArea(clean);
    if (clean.length < 3 || Math.abs(area) < 0.02 || !simplePolygon(clean)) return null;
    s.outline = area < 0 ? clean.reverse() : clean;
  }
  if (isObj(raw.tilt)) {
    const deg = numOr(raw.tilt.deg, 0, -180, 180);
    if (Math.abs(deg) > 0.1) s.tilt = { axis: oneOf(raw.tilt.axis, AXES, 'x'), deg, about: v3(raw.tilt.about) ?? (s.from.map((v, k) => (v + s.to[k]) / 2) as V3) };
  }
  for (const m of (Array.isArray(raw.marks) ? raw.marks : []).slice(0, LIMITS.marks)) {
    const r = readMark(m, s);
    if (r) s.marks.push(r);
  }
  return s;
}

/**
 * A part sunk into another has no line where they meet (the seam is inside). When a part plainly
 * stands on a face of a plain box, move its foot out to that face so the seam is drawn, and close
 * hairline gaps the same way.
 */
function seat(solids: FigureSolid[]): number {
  let moved = 0;
  // a tube that runs into a plain box stops at its face
  for (const b of solids) {
    if (b.shape !== 'tube' || b.closed || b.tilt) continue;
    const seats: [boolean, boolean] = [false, false];
    for (const end of [0, 1] as const) {
      const p = b.path![end ? b.path!.length - 1 : 0];
      const q = b.path![end ? b.path!.length - 2 : 1];
      for (const a of solids) {
        if (a.shape !== 'box' || a.tilt || a.group !== b.group || a.taper[0] !== 1 || a.taper[1] !== 1 || a.shift[0] || a.shift[1]) continue;
        const inside = (v: V3, pad: number) => v.every((x, k) => x >= a.from[k] - pad && x <= a.to[k] + pad);
        if (!inside(p, 0.6) || inside(q, 0)) continue;
        // where the run from q enters the box
        let t = 0;
        for (let k = 0; k < 3; k++) {
          const d = p[k] - q[k];
          if (Math.abs(d) < 1e-6) continue;
          const at = ((d > 0 ? a.from[k] : a.to[k]) - q[k]) / d;
          if (at > t) t = at;
        }
        for (let k = 0; k < 3; k++) p[k] = q[k] + (p[k] - q[k]) * Math.min(1.2, t);
        seats[end] = true;
        break;
      }
    }
    if (seats[0] || seats[1]) b.seats = seats;
  }
  for (const b of solids) {
    if (b.shape === 'tube' || b.shape === 'ball' || b.tilt) continue;
    for (const a of solids) {
      if (a === b || a.shape !== 'box' || a.tilt || a.group !== b.group || a.taper[0] !== 1 || a.taper[1] !== 1 || a.shift[0] || a.shift[1]) continue;
      for (let k = 0; k < 3; k++) {
        // b's section across k lies inside a's, and b sticks out of a's high side only
        if (![0, 1, 2].every((j) => j === k || (b.from[j] >= a.from[j] - 0.3 && b.to[j] <= a.to[j] + 0.3))) continue;
        if (b.to[k] <= a.to[k] + 0.3 || b.from[k] < a.from[k]) continue;
        const gap = b.from[k] - a.to[k];
        if (Math.abs(gap) < 1e-6 || gap > 0.6) continue;
        // only where moving the foot doesn't bend the shape
        if (b.shape !== 'box' && AXES[k] !== b.axis) continue;
        b.from[k] = a.to[k];
        moved++;
      }
    }
  }
  return moved;
}

export interface Checked {
  figure: Figure;
  /** what had to be changed, in plain words (also told to Claude on the fix round) */
  notes: string[];
}

export function validateFigure(raw: unknown): Checked | null {
  if (!isObj(raw) || !Array.isArray(raw.solids)) return null;
  const notes: string[] = [];
  const solids: FigureSolid[] = [];
  const ids = new Set<string>();
  let marks = 0;
  if (raw.solids.length > LIMITS.solids) notes.push(`Only the first ${LIMITS.solids} solids were kept.`);
  raw.solids.slice(0, LIMITS.solids).forEach((r, i) => {
    const s = readSolid(r, i);
    if (!s) {
      notes.push(`Solid ${(isObj(r) && idOf(r.id)) || i + 1} could not be read and was left out.`);
      return;
    }
    if (ids.has(s.id)) s.id = `${s.id.slice(0, 24)}_${i}`;
    ids.add(s.id);
    s.marks = s.marks.filter(() => ++marks <= LIMITS.markTotal);
    solids.push(s);
  });
  if (solids.length < 3) return null;
  const spanOf = (k: number) => Math.max(...solids.map((s) => s.to[k])) - Math.min(...solids.map((s) => s.from[k]));
  if (!(Math.max(spanOf(0), spanOf(1), spanOf(2)) > 8)) return null;

  // one bright part: the first asked for
  for (const s of solids.filter((x) => x.bright).slice(1)) s.bright = undefined;

  const groups: FigureGroup[] = [];
  const gids = new Set<string>();
  for (const g of (Array.isArray(raw.groups) ? raw.groups : []).slice(0, LIMITS.groups)) {
    const id = isObj(g) ? idOf(g.id) : '';
    if (!id || gids.has(id) || ids.has(id)) continue;
    gids.add(id);
    groups.push({ id, parent: (isObj(g) && idOf(g.parent)) || undefined });
  }
  for (const g of groups) {
    // a parent must exist, and the chain must end
    let p = g.parent;
    let depth = 0;
    while (p) {
      const up = groups.find((x) => x.id === p);
      if (!up || up.id === g.id || ++depth > LIMITS.depth) {
        g.parent = undefined;
        break;
      }
      p = up.parent;
    }
  }
  for (const s of solids) if (s.group && !gids.has(s.group)) s.group = undefined;

  const seated = seat(solids);
  if (seated) notes.push(`${seated} part${seated === 1 ? ' was' : 's were'} moved to rest on the face under it instead of sinking in.`);

  const motions: FigureMotion[] = [];
  for (const m of (Array.isArray(raw.motions) ? raw.motions : []).slice(0, LIMITS.motions)) {
    if (!isObj(m) || !(MOTIONS as readonly unknown[]).includes(m.do)) continue;
    const kind = m.do as MotionKind;
    const named = (Array.isArray(m.of) ? m.of : []).map(idOf);
    const of = named.filter((id, i) => id && (ids.has(id) || gids.has(id)) && named.indexOf(id) === i).slice(0, 24);
    if (!of.length) {
      notes.push(`A ${kind} motion named no part that exists and was left out.`);
      continue;
    }
    const max = MAX_AMT[kind];
    const amt = numOr(m.amt, max * 0.4, -max, max);
    if (Math.abs(amt) < max * 0.004) continue;
    const pivot = v3(m.pivot) ?? undefined;
    if (kind === 'hinge' && !pivot) {
      notes.push('A hinge had no pivot and was left out.');
      continue;
    }
    motions.push({
      do: kind,
      of,
      by: oneOf(m.by, DRIVERS, 'beat'),
      amt,
      axis: m.axis === 'out' ? (kind === 'spread' ? 'out' : 'z') : oneOf(m.axis, AXES, kind === 'spread' ? 'x' : 'z'),
      pivot,
      lag: numOr(m.lag, 0, 0, 1),
    });
  }
  return { figure: { name: text(raw.name, 60) || 'Figure', why: text(raw.why, 200), solids, groups, motions }, notes };
}

/* ───────────────────────── what Claude answers with ───────────────────────── */

const num = { type: 'number' };
const vec = { type: 'array', items: num, minItems: 3, maxItems: 3 };
const two = { type: 'array', items: num, minItems: 2, maxItems: 2 };
const axis = { type: 'string', enum: ['x', 'y', 'z'] };
const obj = (required: string[], properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required, properties });

export const FIGURE_SCHEMA: Record<string, unknown> = obj(['name', 'why', 'solids', 'groups', 'motions'], {
  name: { type: 'string' },
  why: { type: 'string' },
  solids: {
    type: 'array',
    minItems: 3,
    maxItems: LIMITS.solids,
    items: obj(['id', 'shape'], {
      id: { type: 'string' },
      shape: { type: 'string', enum: [...SHAPES] },
      axis,
      from: vec,
      to: vec,
      round: num,
      edge: num,
      taper: two,
      shift: two,
      outline: { type: 'array', items: two, minItems: 3, maxItems: LIMITS.poly },
      path: { type: 'array', items: vec, minItems: 2, maxItems: LIMITS.path },
      r: num,
      closed: { type: 'boolean' },
      smooth: { type: 'boolean' },
      tilt: obj(['axis', 'deg'], { axis, deg: num, about: vec }),
      group: { type: 'string' },
      tone: { type: 'integer', enum: [0, 1, 2] },
      bright: { type: 'boolean' },
      marks: {
        type: 'array',
        maxItems: LIMITS.marks,
        items: obj(['face', 'kind', 'box'], { face: { type: 'string', enum: FACES }, kind: { type: 'string', enum: [...MARKS] }, box: { type: 'array', items: num, minItems: 4, maxItems: 4 }, n: two, r: num }),
      },
    }),
  },
  groups: { type: 'array', maxItems: LIMITS.groups, items: obj(['id'], { id: { type: 'string' }, parent: { type: 'string' } }) },
  motions: {
    type: 'array',
    maxItems: LIMITS.motions,
    items: obj(['do', 'of', 'by', 'amt'], {
      do: { type: 'string', enum: [...MOTIONS] },
      of: { type: 'array', items: { type: 'string' }, maxItems: 24 },
      by: { type: 'string', enum: [...DRIVERS] },
      amt: num,
      axis: { type: 'string', enum: ['x', 'y', 'z', 'out'] },
      pivot: vec,
      lag: num,
    }),
  },
});
