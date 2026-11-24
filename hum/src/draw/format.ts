/**
 * What a drawing is: pen strokes as numbers, in a 0..1000 box (x right, y down). Claude writes one,
 * the pen (pen.ts) draws it. There is no SVG and no script anywhere in it, so nothing from outside is
 * ever run or injected: every value is a clamped number or one of a few known words.
 *
 * No DOM here: the server checks the same format with the same code (server/steps/draw.ts).
 */

/** how a stroke's points are joined: a smooth curve, straight edges, or an oval */
export const STROKE_KINDS = ['curve', 'line', 'oval'] as const;
export type StrokeKind = (typeof STROKE_KINDS)[number];
/**
 * outline: the object's main contours. detail: lighter lines inside. ink: a closed shape filled solid
 * with ink. fill: a flat patch of colour under the lines. hatch: a closed shape shaded with strokes
 * (the pen draws them).
 */
export const STROKE_ROLES = ['outline', 'detail', 'ink', 'fill', 'hatch'] as const;
export type StrokeRole = (typeof STROKE_ROLES)[number];

export interface Stroke {
  kind: StrokeKind;
  role: StrokeRole;
  /** x,y pairs. An oval is [cx, cy, rx, ry, turn°, from°, to°] */
  pts: number[];
  /** line weight, 0.4 light … 2 heavy */
  weight: number;
  /** 0 ink, 1 the strong colour, 2 the second colour, 3 the quiet one */
  colour: number;
  closed: boolean;
  /** hides what was drawn before it and lies inside it (something in front) */
  hides: boolean;
  /** hatch: the strokes' direction in degrees and the space between them */
  angle: number;
  gap: number;
}

export interface Drawing {
  strokes: Stroke[];
  /** where the object's middle is, and the height it stands on */
  centre: [number, number];
  ground: number;
}

export const HAND_IDS = ['pen', 'brush', 'marker', 'pencil'] as const;
export type HandId = (typeof HAND_IDS)[number];
export const isHandId = (v: unknown): v is HandId => typeof v === 'string' && (HAND_IDS as readonly string[]).includes(v);

export const MAX_STROKES = 110;
export const MIN_STROKES = 3;
export const MAX_POINTS = 60;
export const MAX_TOTAL_POINTS = 1800;

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const round = (v: number) => Math.round(v * 10) / 10;

/** a drawing from outside (Claude, or storage) made safe, or null when there is nothing usable in it */
export function cleanDrawing(raw: unknown): Drawing | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.strokes)) return null;
  const strokes: Stroke[] = [];
  let total = 0;
  for (const x of o.strokes) {
    if (strokes.length >= MAX_STROKES || total >= MAX_TOTAL_POINTS) break;
    if (!x || typeof x !== 'object') continue;
    const s = x as Record<string, unknown>;
    if (!Array.isArray(s.pts)) continue;
    const kind: StrokeKind = s.kind === 'line' || s.kind === 'oval' ? s.kind : 'curve';
    const role: StrokeRole = (STROKE_ROLES as readonly unknown[]).includes(s.role) ? (s.role as StrokeRole) : 'outline';
    const raws = s.pts.slice(0, kind === 'oval' ? 7 : MAX_POINTS * 2).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN));
    let pts: number[];
    let closed = s.closed === true;
    if (kind === 'oval') {
      if (raws.length < 4 || raws.slice(0, 4).some(Number.isNaN)) continue;
      const rx = num(Math.abs(raws[2]), 2, 500, 2);
      const ry = num(Math.abs(raws[3]), 2, 500, 2);
      const from = num(raws[5], -720, 720, 0);
      let to = num(raws[6], -720, 720, from + 360);
      if (Math.abs(to - from) < 4) to = from + 360;
      if (to - from > 360) to = from + 360;
      if (from - to > 360) to = from - 360;
      pts = [num(raws[0], 0, 1000, 500), num(raws[1], 0, 1000, 500), rx, ry, num(raws[4], -360, 360, 0), from, to];
      closed = Math.abs(to - from) >= 359;
    } else {
      pts = [];
      for (let i = 0; i + 1 < raws.length; i += 2) {
        const px = raws[i];
        const py = raws[i + 1];
        // one bad number drops that point, never the rest
        if (Number.isNaN(px) || Number.isNaN(py)) continue;
        pts.push(round(num(px, 0, 1000, 0)), round(num(py, 0, 1000, 0)));
      }
      if (pts.length < 4) continue;
    }
    // a patch, a solid or a hatched area is always a closed shape
    if (role === 'fill' || role === 'ink' || role === 'hatch') {
      if (kind !== 'oval' && pts.length < 6) continue;
      closed = true;
    }
    total += kind === 'oval' ? 8 : pts.length / 2;
    strokes.push({
      kind,
      role,
      pts,
      weight: num(s.weight, 0.4, 2, role === 'detail' ? 0.7 : 1),
      colour: Math.round(num(s.colour, 0, 3, role === 'fill' ? 1 : 0)),
      closed,
      hides: s.hides === true && closed,
      angle: num(s.angle, -180, 180, 45),
      gap: num(s.gap, 8, 60, 20),
    });
  }
  if (strokes.length < MIN_STROKES || !strokes.some((s) => s.role !== 'fill')) return null;
  const c = Array.isArray(o.centre) ? o.centre : [];
  return { strokes, centre: [num(c[0], 0, 1000, 500), num(c[1], 0, 1000, 500)], ground: num(o.ground, 0, 1000, 900) };
}

/* ───────────────────────── points along a stroke ───────────────────────── */

const STEP = 6;

type P = [number, number];

/** a stroke as a run of points about 6 units apart, x,y pairs (closed shapes come back to their start) */
export function flatten(s: Pick<Stroke, 'kind' | 'pts' | 'closed'>): Float32Array {
  const out: number[] = [];
  if (s.kind === 'oval') {
    const [cx, cy, rx, ry, turn = 0, from = 0, to = 360] = s.pts;
    const a0 = (from * Math.PI) / 180;
    const a1 = (to * Math.PI) / 180;
    const len = Math.abs(a1 - a0) * Math.max(rx, ry);
    const n = Math.max(10, Math.ceil(len / STEP));
    const ct = Math.cos((turn * Math.PI) / 180);
    const st = Math.sin((turn * Math.PI) / 180);
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      const x = Math.cos(a) * rx;
      const y = Math.sin(a) * ry;
      out.push(cx + x * ct - y * st, cy + x * st + y * ct);
    }
    return new Float32Array(out);
  }
  const p = s.pts;
  const n = p.length / 2;
  const push = (x: number, y: number) => {
    out.push(x, y);
  };
  const straight = (x0: number, y0: number, x1: number, y1: number) => {
    const k = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / STEP));
    for (let i = 1; i <= k; i++) push(x0 + ((x1 - x0) * i) / k, y0 + ((y1 - y0) * i) / k);
  };
  if (s.kind === 'line' || n < 3) {
    push(p[0], p[1]);
    for (let i = 1; i < n; i++) straight(p[i * 2 - 2], p[i * 2 - 1], p[i * 2], p[i * 2 + 1]);
    if (s.closed) straight(p[n * 2 - 2], p[n * 2 - 1], p[0], p[1]);
    return new Float32Array(out);
  }
  // a point written twice is a corner: the curve is broken into pieces there
  let pieces: P[][] = [[]];
  for (let i = 0; i < n; i++) {
    const a: P = [p[i * 2], p[i * 2 + 1]];
    const cur = pieces[pieces.length - 1];
    const last = cur[cur.length - 1];
    if (last && Math.abs(last[0] - a[0]) < 0.5 && Math.abs(last[1] - a[1]) < 0.5) pieces.push([a]);
    else cur.push(a);
  }
  pieces = pieces.filter((q) => q.length > 0);
  const first = pieces[0][0];
  let loop = false;
  if (s.closed) {
    const lastP = pieces[pieces.length - 1];
    const end = lastP[lastP.length - 1];
    if (Math.hypot(end[0] - first[0], end[1] - first[1]) >= 1.5) lastP.push(first);
    // a closed curve with no corners joins up smoothly
    loop = pieces.length === 1 && pieces[0].length > 3;
  }
  push(first[0], first[1]);
  for (const q of pieces) {
    for (let i = 0; i + 1 < q.length; i++) {
      const p1 = q[i];
      const p2 = q[i + 1];
      const p0 = i > 0 ? q[i - 1] : loop ? q[q.length - 2] : mirror(p2, p1);
      const p3 = i + 2 < q.length ? q[i + 2] : loop ? q[1] : mirror(p1, p2);
      spline(p0, p1, p2, p3, push);
    }
  }
  return new Float32Array(out);
}

/** the point as far past b as a is before it */
const mirror = (a: P, b: P): P => [2 * b[0] - a[0], 2 * b[1] - a[1]];

/** one span of a centripetal Catmull-Rom curve (no loops or overshoots where points crowd together) */
function spline(p0: P, p1: P, p2: P, p3: P, push: (x: number, y: number) => void) {
  const d = (a: P, b: P) => Math.max(1e-3, Math.sqrt(Math.hypot(a[0] - b[0], a[1] - b[1])));
  const t1 = d(p0, p1);
  const t2 = t1 + d(p1, p2);
  const t3 = t2 + d(p2, p3);
  const k = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / STEP));
  const mix = (a: P, b: P, ta: number, tb: number, t: number): P => {
    const u = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  };
  for (let i = 1; i <= k; i++) {
    const t = t1 + ((t2 - t1) * i) / k;
    const a1 = mix(p0, p1, 0, t1, t);
    const a2 = mix(p1, p2, t1, t2, t);
    const a3 = mix(p2, p3, t2, t3, t);
    const c = mix(mix(a1, a2, 0, t2, t), mix(a2, a3, t1, t3, t), t1, t2, t);
    push(c[0], c[1]);
  }
}

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function boundsOf(lines: Iterable<ArrayLike<number>>): Bounds {
  const b = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  for (const p of lines)
    for (let i = 0; i + 1 < p.length; i += 2) {
      if (p[i] < b.x0) b.x0 = p[i];
      if (p[i] > b.x1) b.x1 = p[i];
      if (p[i + 1] < b.y0) b.y0 = p[i + 1];
      if (p[i + 1] > b.y1) b.y1 = p[i + 1];
    }
  return b.x1 < b.x0 ? { x0: 0, y0: 0, x1: 1000, y1: 1000 } : b;
}

export function lengthOf(p: ArrayLike<number>): number {
  let l = 0;
  for (let i = 2; i + 1 < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return l;
}

/** the area a closed run of points goes round */
export function areaOf(p: ArrayLike<number>): number {
  let a = 0;
  for (let i = 0, j = p.length - 2; i + 1 < p.length; j = i, i += 2) a += p[j] * p[i + 1] - p[i] * p[j + 1];
  return Math.abs(a) / 2;
}

/* ───────────────────────── does it look broken? ───────────────────────── */

/**
 * What is plainly wrong with a drawing, in words Claude can act on (empty: nothing). Only faults a
 * computer can be sure of: whether it reads as its object is judged by looking at it.
 */
export function drawingFaults(d: Drawing): string[] {
  const out: string[] = [];
  const ink = d.strokes.filter((s) => s.role !== 'fill').map((s) => ({ s, p: flatten(s) }));
  const b = boundsOf(ink.map((x) => x.p));
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  if (Math.max(w, h) < 520) out.push(`it is small: it only spans ${Math.round(w)} by ${Math.round(h)} of the 1000 box; fill 800 or more of it on its longer side`);
  if (ink.length < 5) out.push(`only ${ink.length} strokes: too bare to read as the object`);
  let len = 0;
  for (const x of ink) len += x.s.role === 'hatch' || x.s.role === 'ink' ? 0 : lengthOf(x.p);
  if (len < 1600) out.push('very little line work: it needs its defining contours');
  // strokes drawn twice over
  let twins = 0;
  for (let i = 0; i < ink.length; i++)
    for (let j = i + 1; j < ink.length; j++) {
      if (ink[i].s.role !== ink[j].s.role) continue;
      const la = lengthOf(ink[i].p);
      if (la < 60) continue;
      const bi = boundsOf([ink[i].p]);
      const bj = boundsOf([ink[j].p]);
      if (Math.abs(bi.x0 - bj.x0) + Math.abs(bi.y0 - bj.y0) + Math.abs(bi.x1 - bj.x1) + Math.abs(bi.y1 - bj.y1) < 16 && Math.abs(la - lengthOf(ink[j].p)) < la * 0.05) twins++;
    }
  if (twins > 1) out.push(`${twins} strokes lie exactly on top of others`);
  // a line that keeps turning back on itself (and isn't hatching)
  let broken = 0;
  for (const x of ink) {
    if (x.s.kind === 'oval' || x.s.role === 'hatch' || x.s.role === 'ink') continue;
    const p = x.s.pts;
    let back = 0;
    let far = 0;
    for (let i = 2; i + 3 < p.length; i += 2) {
      const ax = p[i] - p[i - 2];
      const ay = p[i + 1] - p[i - 1];
      const bx = p[i + 2] - p[i];
      const by = p[i + 3] - p[i + 1];
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la < 2 || lb < 2) continue;
      if ((ax * bx + ay * by) / (la * lb) < -0.94) {
        back++;
        if (la > 260 && lb > 260) far++;
      }
    }
    if (far > 1 || (p.length > 12 && back > p.length / 4)) broken++;
  }
  if (broken) out.push(`${broken} ${broken > 1 ? 'strokes double' : 'stroke doubles'} back on ${broken > 1 ? 'themselves' : 'itself'}`);
  // ink or colour over nearly everything
  for (const s of d.strokes) {
    if (s.role !== 'fill' && s.role !== 'ink') continue;
    const a = areaOf(flatten(s));
    if (a > 0.82e6 || (s.role === 'ink' && a > 0.55 * Math.max(1, w * h))) {
      out.push(s.role === 'ink' ? 'a solid black area covers most of it' : 'a colour patch covers the whole page');
      break;
    }
  }
  return out;
}
