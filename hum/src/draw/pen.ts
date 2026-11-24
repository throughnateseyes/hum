/**
 * The pen: turns a drawing (format.ts) into ink that looks drawn by a person, at any size.
 *
 * What comes out depends only on the drawing, its seed, the hand, how much of it is drawn (0..1) and
 * which redraw this is (`boil`), so the same moment of a song always gives the same picture. A drawing
 * at rest is redrawn 8 to 12 times a second from a few traced versions of itself (VARIANTS), the way
 * hand animation "boils"; the versions are kept, so a redraw is only a handful of fills.
 *
 * What makes it a hand: every line strays from the true one in long slow errors, a middling wander and
 * a small tremor; pressure swells and lets go; corners and closed shapes overshoot; long contours get
 * a second, searching line; colour patches sit off register. A redraw strays much less than the hand
 * did, so the drawing stays itself.
 */
import { boundsOf, flatten, lengthOf, type Bounds, type Drawing, type HandId } from './format';

/** how many traced versions of a drawing a boil goes round (never the same one twice running) */
export const VARIANTS = 5;

interface HandDef {
  /** line width in drawing units */
  width: number;
  detail: number;
  hatch: number;
  /** how far lines stray: long errors, wander, tremor, and from one redraw to the next */
  drift: number;
  wander: number;
  tremor: number;
  boil: number;
  /** how much pressure varies, and how thin the ends get (1 = no taper) */
  press: number;
  head: number;
  tail: number;
  /** tapers as shares of a stroke, at most `taperMax` units */
  headLen: number;
  tailLen: number;
  taperMax: number;
  overshoot: number;
  /** chance a long contour gets a second line */
  again: number;
  /** slower through curves = thicker (brush) */
  curve: number;
  /** dry bristles at the end of fast strokes */
  dry: boolean;
  /** lines laid per stroke, and how opaque the ink is */
  passes: number;
  alpha: number;
  /** holes in the ink (paper tooth), 0..1 */
  grain: number;
}

export const HANDS: Record<HandId, HandDef> = {
  pen: { width: 6.4, detail: 0.68, hatch: 0.5, drift: 4.2, wander: 1.7, tremor: 0.42, boil: 1.5, press: 0.34, head: 0.55, tail: 0.28, headLen: 0.06, tailLen: 0.16, taperMax: 46, overshoot: 14, again: 0.5, curve: 0.1, dry: false, passes: 1, alpha: 1, grain: 0.06 },
  brush: { width: 17, detail: 0.46, hatch: 0.32, drift: 5, wander: 2, tremor: 0.3, boil: 2, press: 0.7, head: 0.3, tail: 0.06, headLen: 0.14, tailLen: 0.42, taperMax: 190, overshoot: 10, again: 0.06, curve: 0.5, dry: true, passes: 1, alpha: 1, grain: 0.1 },
  marker: { width: 13.5, detail: 0.6, hatch: 0.55, drift: 4.6, wander: 1.9, tremor: 0.28, boil: 1.7, press: 0.1, head: 0.92, tail: 0.86, headLen: 0.02, tailLen: 0.03, taperMax: 10, overshoot: 18, again: 0.1, curve: 0.05, dry: false, passes: 1, alpha: 0.94, grain: 0.03 },
  pencil: { width: 4.6, detail: 0.75, hatch: 0.7, drift: 4.6, wander: 2, tremor: 0.6, boil: 1.8, press: 0.5, head: 0.6, tail: 0.35, headLen: 0.12, tailLen: 0.22, taperMax: 70, overshoot: 26, again: 0.75, curve: 0.15, dry: false, passes: 3, alpha: 0.62, grain: 0.34 },
};

/* ───────────────────────── dice ───────────────────────── */

/** a number from whole numbers, 0..1 */
export function hash(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b) ^ Math.imul((c | 0) + 0x165667b1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** a smooth random line through -1..1, one bend per whole number */
function wave(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const a = hash(i, seed) * 2 - 1;
  const b = hash(i + 1, seed) * 2 - 1;
  return a + (b - a) * u;
}

/** a whole number from a name */
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** which traced version redraw number `n` uses */
export function variantAt(n: number, seed: number): number {
  const k = Math.floor(n);
  // a fixed order that never repeats a version back to back
  const order = [0, 2, 4, 1, 3];
  const off = Math.floor(hash(seed, 91) * VARIANTS);
  return order[(((k + off) % VARIANTS) + VARIANTS) % VARIANTS];
}

/* ───────────────────────── getting a drawing ready (once) ───────────────────────── */

type LineRole = 'outline' | 'detail' | 'hatch';

/** one pull of the pen */
interface Run {
  kind: 'run';
  p: Float32Array;
  len: number;
  weight: number;
  role: LineRole;
  colour: number;
  /** this end is free (tapers and overshoots); a cut end stops where something in front begins */
  free0: boolean;
  free1: boolean;
  closed: boolean;
  id: number;
}
/** a patch of colour, or a solid of ink */
interface Patch {
  kind: 'patch';
  poly: Float32Array;
  colour: number;
  solid: boolean;
  /** shapes in front that cover part of it */
  cuts: Float32Array[];
  box: Bounds;
  id: number;
}

export interface Prepared {
  bounds: Bounds;
  ground: number;
  runs: Run[];
  /** solids of ink, then colour patches, in order */
  solids: Patch[];
  patches: Patch[];
  /** when each run / patch is drawn: shares of 0..1 */
  runT: [number, number][];
  solidT: [number, number][];
  patchT: [number, number][];
  /** total length of line, to judge how long it takes to draw */
  length: number;
}

const prepared = new WeakMap<Drawing, Prepared>();

function inside(poly: Float32Array, x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const yi = poly[i + 1];
    const yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((poly[j] - poly[i]) * (y - yi)) / (yj - yi) + poly[i]) hit = !hit;
  }
  return hit;
}

interface Cover {
  poly: Float32Array;
  box: Bounds;
}

/** inside, and not just on its edge (a line that ends on the shape keeps its end) */
function covered(c: Cover, x: number, y: number): boolean {
  if (x < c.box.x0 || x > c.box.x1 || y < c.box.y0 || y > c.box.y1) return false;
  const e = 5;
  return inside(c.poly, x, y) && inside(c.poly, x + e, y) && inside(c.poly, x - e, y) && inside(c.poly, x, y + e) && inside(c.poly, x, y - e);
}

/** the parts of a line that nothing in front covers */
function visible(p: Float32Array, covers: Cover[]): { p: Float32Array; cut0: boolean; cut1: boolean }[] {
  if (!covers.length) return [{ p, cut0: false, cut1: false }];
  const box = boundsOf([p]);
  const near = covers.filter((c) => c.box.x0 < box.x1 && c.box.x1 > box.x0 && c.box.y0 < box.y1 && c.box.y1 > box.y0);
  if (!near.length) return [{ p, cut0: false, cut1: false }];
  const n = p.length / 2;
  const out: { p: Float32Array; cut0: boolean; cut1: boolean }[] = [];
  let from = -1;
  for (let i = 0; i <= n; i++) {
    const open = i < n && !near.some((c) => covered(c, p[i * 2], p[i * 2 + 1]));
    if (open && from < 0) from = i;
    if (!open && from >= 0) {
      if (i - from > 1) out.push({ p: p.slice(from * 2, i * 2), cut0: from > 0, cut1: i < n });
      from = -1;
    }
  }
  return out.filter((r) => !(r.cut0 || r.cut1) || lengthOf(r.p) > 14);
}

/** a patch and a shape in front that are really the same shape: the shape doesn't cover its own colour */
function sameShape(a: Bounds, b: Bounds): boolean {
  const w = Math.max(a.x1 - a.x0, b.x1 - b.x0, 1);
  const h = Math.max(a.y1 - a.y0, b.y1 - b.y0, 1);
  return Math.abs(a.x0 - b.x0) + Math.abs(a.x1 - b.x1) < w * 0.22 && Math.abs(a.y0 - b.y0) + Math.abs(a.y1 - b.y1) < h * 0.22;
}

/** straight strokes across a closed shape, back and forth, at `angle` degrees */
function hatchLines(poly: Float32Array, angle: number, gap: number, seed: number): Float32Array[] {
  const a = (angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // turned so the strokes run along x
  const q = new Float32Array(poly.length);
  for (let i = 0; i < poly.length; i += 2) {
    q[i] = poly[i] * c + poly[i + 1] * s;
    q[i + 1] = -poly[i] * s + poly[i + 1] * c;
  }
  const b = boundsOf([q]);
  const out: Float32Array[] = [];
  let k = 0;
  for (let y = b.y0 + gap * 0.6; y < b.y1 && k < 70; y += gap * (0.78 + 0.44 * hash(seed, k, 3)), k++) {
    const xs: number[] = [];
    for (let i = 0, j = q.length - 2; i < q.length; j = i, i += 2) {
      const yi = q[i + 1];
      const yj = q[j + 1];
      if (yi > y !== yj > y) xs.push(((q[j] - q[i]) * (y - yi)) / (yj - yi) + q[i]);
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      // strokes stop a little short of the edge, or run a hair past it
      let x0 = xs[i] + (hash(seed, k, 5 + i) * 1.3 - 0.3) * 7;
      let x1 = xs[i + 1] - (hash(seed, k, 6 + i) * 1.3 - 0.3) * 9;
      if (x1 - x0 < 8) continue;
      const tilt = (hash(seed, k, 9) - 0.5) * gap * 0.25;
      if (k % 2) [x0, x1] = [x1, x0];
      const n = Math.max(2, Math.ceil(Math.abs(x1 - x0) / 8));
      const line = new Float32Array((n + 1) * 2);
      for (let j = 0; j <= n; j++) {
        const u = j / n;
        const x = x0 + (x1 - x0) * u;
        const yy = y + tilt * (u - 0.5) * 2;
        line[j * 2] = x * c - yy * s;
        line[j * 2 + 1] = x * s + yy * c;
      }
      out.push(line);
    }
  }
  return out;
}

/** straight-edged shapes are drawn edge by edge, the way people draw them; small zigzags in one go */
function edges(pts: number[], closed: boolean): number[][] {
  const n = pts.length / 2;
  const P = (i: number) => [pts[(i % n) * 2], pts[(i % n) * 2 + 1]];
  const m = closed ? n : n - 1;
  const out: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < m; i++) {
    const a = P(i);
    const b = P(i + 1);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 64) {
      if (!cur.length) cur.push(...a);
      cur.push(...b);
      continue;
    }
    if (cur.length) out.push(cur);
    cur = [];
    out.push([...a, ...b]);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function prepare(d: Drawing): Prepared {
  const hit = prepared.get(d);
  if (hit) return hit;
  const flat = d.strokes.map((s) => flatten(s));
  const covers: (Cover | null)[] = d.strokes.map((s, i) => (s.hides ? { poly: flat[i], box: boundsOf([flat[i]]) } : null));
  const runs: Run[] = [];
  const solids: Patch[] = [];
  const patches: Patch[] = [];
  let id = 0;
  d.strokes.forEach((s, i) => {
    const front = covers.slice(i + 1).filter((c): c is Cover => !!c);
    if (s.role === 'fill' || s.role === 'ink') {
      const box = boundsOf([flat[i]]);
      const cuts = front.filter((c) => c.box.x0 < box.x1 && c.box.x1 > box.x0 && c.box.y0 < box.y1 && c.box.y1 > box.y0 && !sameShape(c.box, box)).map((c) => c.poly);
      (s.role === 'ink' ? solids : patches).push({ kind: 'patch', poly: flat[i], colour: s.role === 'ink' ? s.colour : s.colour || 1, solid: s.role === 'ink', cuts, box, id: id++ });
      return;
    }
    const role: LineRole = s.role;
    const lines: { p: Float32Array; closed: boolean }[] =
      role === 'hatch'
        ? hatchLines(flat[i], s.angle, s.gap, i + 17).map((p) => ({ p, closed: false }))
        : s.kind === 'line' && s.pts.length > 4
          ? edges(s.pts, s.closed).map((e) => ({ p: flatten({ kind: 'line', pts: e, closed: false }), closed: false }))
          : [{ p: flat[i], closed: s.closed }];
    for (const l of lines)
      for (const v of visible(l.p, front)) {
        const len = lengthOf(v.p);
        if (len < 2) continue;
        runs.push({ kind: 'run', p: v.p, len, weight: s.weight, role, colour: s.colour, free0: !v.cut0, free1: !v.cut1, closed: l.closed && !v.cut0 && !v.cut1, id: id++ });
      }
  });

  // how the drawing goes: line by line in order, long ones taking longer (but not in proportion), a
  // breath between strokes; solids are blocked in as the lines pass them; colour comes last
  const cost = (r: Run) => Math.pow(r.len, 0.72) * (r.role === 'hatch' ? 0.45 : 1) + (r.role === 'hatch' ? 2 : 9);
  const all = runs.reduce((a, r) => a + cost(r), 0) || 1;
  const inkEnd = patches.length ? 0.84 : solids.length ? 0.94 : 1;
  let at = 0;
  const runT = runs.map((r) => {
    const c = cost(r) / all;
    const rest = (r.role === 'hatch' ? 1 : 7) / all;
    const t: [number, number] = [at * inkEnd, (at + Math.max(c - rest, c * 0.4)) * inkEnd];
    at += c;
    return t;
  });
  const solidT = solids.map((p, i): [number, number] => {
    // a solid is blocked in once the lines drawn before it are down
    const before = runs.filter((r) => r.id < p.id).length;
    const t0 = Math.min(0.86, before ? runT[before - 1][1] : 0.02) + i * 0.004;
    return [t0, Math.min(1, t0 + 0.1)];
  });
  const patchT = patches.map((_, i): [number, number] => {
    const each = 0.44 / Math.max(1, patches.length * 0.7 + 0.3);
    const t0 = 0.56 + i * each * 0.7;
    return [t0, Math.min(1, t0 + each)];
  });
  const prep: Prepared = {
    bounds: boundsOf([...runs.map((r) => r.p), ...solids.map((s) => s.poly)]),
    ground: d.ground,
    runs,
    solids,
    patches,
    runT,
    solidT,
    patchT,
    length: runs.reduce((a, r) => a + r.len, 0),
  };
  prepared.set(d, prep);
  return prep;
}

/** how long a person would take over it at video speed (s): 0.7 for a doodle, up to 3.2 */
export function drawSeconds(d: Drawing): number {
  return Math.min(3.2, 0.5 + prepare(d).length / 7500);
}

/* ───────────────────────── one stroke's ink ───────────────────────── */

const spread = new WeakMap<Float32Array, Float32Array>();
/** distance along a line at each of its points */
function along(p: Float32Array): Float32Array {
  let s = spread.get(p);
  if (!s) {
    s = new Float32Array(p.length / 2);
    for (let i = 1; i < s.length; i++) s[i] = s[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
    spread.set(p, s);
  }
  return s;
}

interface InkOpts {
  hand: HandDef;
  seed: number;
  variant: number;
  /** draw only this much of it, 0..1 */
  upTo: number;
  /** thicken lines (small pictures) */
  fat: number;
  /** a second, searching line over the same stroke: which stretch of it */
  part?: [number, number];
  thin?: number;
  salt?: number;
}

/** add a stroke's ink to `path`, in drawing units */
function inkRun(path: Path2D, r: Run, o: InkOpts) {
  const h = o.hand;
  const s0 = hash(o.seed, r.id, o.salt ?? 0) * 1e6;
  const base = Math.floor(s0);
  const boil = Math.floor(hash(o.seed, r.id, 400 + o.variant) * 1e6);
  // small strokes stray less, or they stop being what they are
  const tame = Math.min(1, 0.3 + r.len / 210);
  const S = along(r.p);
  let p = r.p;
  let L = r.len;
  // past the corner, past the join
  let over0 = 0;
  let over1 = 0;
  if (r.role !== 'hatch' && !o.part) {
    const room = Math.min(h.overshoot, r.len * 0.09);
    if (r.closed) over1 = room * (0.5 + 1.2 * hash(base, 5));
    else {
      if (r.free0) over0 = room * 0.5 * hash(base, 3);
      if (r.free1) over1 = room * 0.62 * hash(base, 4);
    }
  }
  const n0 = p.length / 2;
  const xs: number[] = [];
  const ys: number[] = [];
  const ss: number[] = [];
  const add = (x: number, y: number, s: number) => {
    xs.push(x);
    ys.push(y);
    ss.push(s);
  };
  const a = o.part ? o.part[0] * L : 0;
  const b = o.part ? o.part[1] * L : L;
  if (over0 > 1 && n0 > 2) {
    const dx = p[0] - p[4];
    const dy = p[1] - p[5];
    const l = Math.hypot(dx, dy) || 1;
    add(p[0] + (dx / l) * over0, p[1] + (dy / l) * over0, -over0);
  }
  for (let i = 0; i < n0; i++) if (S[i] >= a - 0.01 && S[i] <= b + 0.01) add(p[i * 2], p[i * 2 + 1], S[i] - a);
  L = b - a;
  if (over1 > 1) {
    if (r.closed) {
      // round again past where it began
      for (let i = 1; i < n0 && S[i] <= over1; i++) add(p[i * 2], p[i * 2 + 1], L + S[i]);
      L += over1;
    } else if (n0 > 2) {
      const k = n0 - 1;
      const dx = p[k * 2] - p[k * 2 - 4];
      const dy = p[k * 2 + 1] - p[k * 2 - 3];
      const l = Math.hypot(dx, dy) || 1;
      for (let j = 1; j <= 2; j++) add(p[k * 2] + (dx / l) * over1 * (j / 2), p[k * 2 + 1] + (dy / l) * over1 * (j / 2), L + over1 * (j / 2));
      L += over1;
    }
  }
  const n = xs.length;
  if (n < 2) return;
  const total = L + over0;
  const upto = -over0 + total * Math.min(1, o.upTo);

  // where the hand really went
  const ox = (hash(base, 11) - 0.5) * h.wander * 1.2 * tame;
  const oy = (hash(base, 12) - 0.5) * h.wander * 1.2 * tame;
  const bx = (hash(boil, 13) - 0.5) * h.boil * 0.9;
  const by = (hash(boil, 14) - 0.5) * h.boil * 0.9;
  const salt = o.part ? 1.5 : 1;
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const s = ss[i];
    if (s > upto + 6) break;
    const dx = wave(s / 210, base + 1) * h.drift + wave(s / 62, base + 2) * h.wander + wave(s / 15, base + 3) * h.tremor;
    const dy = wave(s / 190, base + 4) * h.drift + wave(s / 58, base + 5) * h.wander + wave(s / 14, base + 6) * h.tremor;
    const ex = wave(s / 120, boil + 1) * h.boil + wave(s / 34, boil + 2) * h.boil * 0.35;
    const ey = wave(s / 110, boil + 3) * h.boil + wave(s / 36, boil + 4) * h.boil * 0.35;
    X[i] = xs[i] + dx * tame * salt + ox + (ex + bx) * Math.max(0.5, tame);
    Y[i] = ys[i] + dy * tame * salt + oy + (ey + by) * Math.max(0.5, tame);
    m = i + 1;
  }
  if (m < 2) return;
  // the pen's tip is part of the way along the last step
  if (ss[m - 1] > upto) {
    const u = (upto - ss[m - 2]) / Math.max(1e-3, ss[m - 1] - ss[m - 2]);
    X[m - 1] = X[m - 2] + (X[m - 1] - X[m - 2]) * u;
    Y[m - 1] = Y[m - 2] + (Y[m - 1] - Y[m - 2]) * u;
  }

  // pressure
  const W = (h.width * (r.role === 'detail' ? h.detail : r.role === 'hatch' ? h.hatch : 1) * r.weight * (o.thin ?? 1) * 0.5) * o.fat;
  const hl = Math.min(h.taperMax, total * h.headLen) || 1;
  const tl = Math.min(h.taperMax, total * h.tailLen) || 1;
  const half = new Float64Array(m);
  const heavy = 1 + (hash(base, 21) - 0.5) * h.press * 0.5;
  for (let i = 0; i < m; i++) {
    const s = ss[i] + over0;
    let w = heavy * (1 + wave(s / 105, base + 31) * h.press * 0.62 + wave(s / 27, base + 32) * h.press * 0.2 + wave(s / 60, boil + 5) * h.press * 0.12);
    if (h.curve && i > 1 && i < m - 2) {
      const ax = X[i] - X[i - 2];
      const ay = Y[i] - Y[i - 2];
      const cx = X[i + 2] - X[i];
      const cy = Y[i + 2] - Y[i];
      const turn = Math.abs(Math.atan2(ax * cy - ay * cx, ax * cx + ay * cy));
      w *= 1 + h.curve * (Math.min(1, turn * 2.2) - 0.3);
    }
    if (s < hl) w *= h.head + (1 - h.head) * Math.sin(((s / hl) * Math.PI) / 2);
    const left = total - s;
    // the tail only lets go once the stroke is really ending
    if (left < tl) w *= h.tail + (1 - h.tail) * Math.sin(((left / tl) * Math.PI) / 2);
    half[i] = Math.max(0.32 * o.fat, w * W);
  }
  // smooth the curve term's jumps
  for (let k = 0; k < 2; k++) for (let i = 1; i < m - 1; i++) half[i] = (half[i - 1] + half[i] * 2 + half[i + 1]) / 4;

  ribbon(path, X, Y, half, m);

  // a brush running out of ink: bristles split off and trail on their own
  if (h.dry && r.role !== 'hatch' && L > 220 && W > 3 && o.upTo >= 1) {
    const k0 = Math.floor(m * (0.62 + 0.14 * hash(base, 41)));
    const bristles = 3 + Math.floor(hash(base, 42) * 3);
    for (let j = 0; j < bristles; j++) {
      const at = ((j + 0.5) / bristles - 0.5) * 1.5 + (hash(base, 43, j) - 0.5) * 0.3;
      const from = k0 + Math.floor(hash(base, 44, j) * m * 0.12);
      const to = Math.min(m - 1, from + Math.floor(m * (0.1 + 0.2 * hash(base, 45, j))));
      if (to - from < 4) continue;
      const bx2: number[] = [];
      const by2: number[] = [];
      const bw: number[] = [];
      for (let i = from; i <= to; i++) {
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(m - 1, i + 1);
        const tx = X[i1] - X[i0];
        const ty = Y[i1] - Y[i0];
        const l = Math.hypot(tx, ty) || 1;
        const off = at * W * 1.05;
        bx2.push(X[i] - (ty / l) * off);
        by2.push(Y[i] + (tx / l) * off);
        const u = (i - from) / (to - from);
        bw.push(Math.max(0.3, W * 0.15 * Math.sin(Math.PI * Math.min(1, u * 1.1))));
      }
      ribbon(path, bx2, by2, bw, bx2.length);
    }
  }
}

/** a line of changing width as one closed shape with round ends */
function ribbon(path: Path2D, X: ArrayLike<number>, Y: ArrayLike<number>, half: ArrayLike<number>, n: number) {
  if (n < 2) return;
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    const dx = X[i1] - X[i0];
    const dy = Y[i1] - Y[i0];
    const l = Math.hypot(dx, dy);
    nx[i] = l > 1e-6 ? -dy / l : i ? nx[i - 1] : 0;
    ny[i] = l > 1e-6 ? dx / l : i ? ny[i - 1] : 1;
  }
  path.moveTo(X[0] + nx[0] * half[0], Y[0] + ny[0] * half[0]);
  for (let i = 1; i < n; i++) path.lineTo(X[i] + nx[i] * half[i], Y[i] + ny[i] * half[i]);
  const e = n - 1;
  const a1 = Math.atan2(ny[e], nx[e]);
  path.arc(X[e], Y[e], half[e], a1, a1 - Math.PI, true);
  for (let i = e; i >= 0; i--) path.lineTo(X[i] - nx[i] * half[i], Y[i] - ny[i] * half[i]);
  const a0 = Math.atan2(-ny[0], -nx[0]);
  path.arc(X[0], Y[0], half[0], a0, a0 - Math.PI, true);
  path.closePath();
}

/** all of one stroke: its line(s), and the second look some long contours get */
function inkAll(path: Path2D, r: Run, o: InkOpts, pass: number) {
  const h = o.hand;
  if (pass > 0) {
    // a pencil goes over the line again, not quite in the same place
    inkRun(path, r, { ...o, salt: pass, thin: 1 - pass * 0.18 });
    return;
  }
  // the second line is drawn after the first, in the last quarter of the stroke's time
  const again = r.role === 'outline' && r.len > 130 && hash(o.seed, r.id, 77) < h.again;
  inkRun(path, r, again ? { ...o, upTo: Math.min(1, o.upTo / 0.74) } : o);
  if (!again || o.upTo <= 0.75) return;
  const from = hash(o.seed, r.id, 78) * 0.45;
  const to = Math.min(1, from + 0.28 + hash(o.seed, r.id, 79) * 0.5);
  inkRun(path, r, { ...o, upTo: (o.upTo - 0.74) / 0.26, part: [from, to], thin: 0.5, salt: 3 });
}

/* ───────────────────────── patches ───────────────────────── */

function patchPath(p: Patch, seed: number, variant: number, off: number): Path2D {
  const path = new Path2D();
  const b = hash(seed, p.id, 50) * 1e6;
  const v = hash(seed, p.id, 60 + variant) * 1e6;
  const size = Math.min(1, Math.max(p.box.x1 - p.box.x0, p.box.y1 - p.box.y0) / 160);
  const ang = hash(seed, 7) * Math.PI * 2;
  // every patch is off register the same way, as one printed layer would be
  const dx = p.solid ? 0 : Math.cos(ang) * off;
  const dy = p.solid ? 0 : Math.sin(ang) * off;
  const stray = p.solid ? 2 : 5;
  let s = 0;
  for (let i = 0; i < p.poly.length; i += 2) {
    if (i) s += Math.hypot(p.poly[i] - p.poly[i - 2], p.poly[i + 1] - p.poly[i - 1]);
    const x = p.poly[i] + dx + (wave(s / 90, b) * stray + wave(s / 60, v) * 1.1) * size;
    const y = p.poly[i + 1] + dy + (wave(s / 85, b + 9) * stray + wave(s / 64, v + 9) * 1.1) * size;
    if (i) path.lineTo(x, y);
    else path.moveTo(x, y);
  }
  path.closePath();
  return path;
}

/** colouring in: a fat scribble across the patch, drawn `k` of the way */
function scribble(g: CanvasRenderingContext2D, p: Patch, seed: number, k: number) {
  const w = p.box.x1 - p.box.x0;
  const h = p.box.y1 - p.box.y0;
  const a = -0.6 - hash(seed, p.id, 71) * 0.5;
  const cx = (p.box.x0 + p.box.x1) / 2;
  const cy = (p.box.y0 + p.box.y1) / 2;
  const R = Math.hypot(w, h) / 2 + 20;
  const rows = Math.max(3, Math.min(16, Math.ceil(R / 26)));
  const step = (R * 2) / rows;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const pt = (x: number, y: number): [number, number] => [cx + x * ca - y * sa, cy + x * sa + y * ca];
  g.beginPath();
  const n = rows * k;
  g.moveTo(...pt(-R, -R));
  for (let i = 0; i < n; i++) {
    const u = Math.min(1, n - i);
    const dir = i % 2 ? -1 : 1;
    const y = -R + step * (i + 0.5) + (hash(seed, p.id, 80 + i) - 0.5) * step * 0.3;
    g.lineTo(...pt(dir * -R, y));
    g.lineTo(...pt(dir * -R + dir * 2 * R * u, y + step * 0.3 * u));
  }
  g.lineWidth = step * 1.5;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.stroke();
}

/* ───────────────────────── paper tooth ───────────────────────── */

const tiles = new Map<string, HTMLCanvasElement>();
/** a tile of colour with holes where the paper shows through */
function tooth(colour: string, amount: number, fibre: boolean): HTMLCanvasElement | string {
  if (amount < 0.02) return colour;
  const key = `${colour}|${amount}|${fibre}`;
  let t = tiles.get(key);
  if (t) return t;
  if (tiles.size > 40) tiles.clear();
  const N = 256;
  t = document.createElement('canvas');
  t.width = t.height = N;
  const g = t.getContext('2d')!;
  g.fillStyle = colour;
  g.fillRect(0, 0, N, N);
  const img = g.getImageData(0, 0, N, N);
  const d = img.data;
  // two sizes of grain that wrap at the tile's edge
  const grid = (cell: number, salt: number) => (x: number, y: number) => {
    const k = N / cell;
    const gx = x / cell;
    const gy = y / cell;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    const v = (a: number, b: number) => hash(((a % k) + k) % k, ((b % k) + k) % k, salt);
    const top = v(i, j) * (1 - fx) + v(i + 1, j) * fx;
    const bot = v(i, j + 1) * (1 - fx) + v(i + 1, j + 1) * fx;
    return top * (1 - fy) + bot * fy;
  };
  const a = grid(2, 1);
  const b = grid(8, 2);
  const c = grid(32, 3);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const v = fibre ? a(x, y) * 0.5 + b(x, y) * 0.3 + c(x, y) * 0.2 : hash(x, y, 5) * 0.55 + a(x, y) * 0.25 + b(x, y) * 0.2;
      const hole = (amount * 1.5 - v) * (fibre && amount > 0.2 ? 1.9 : 3.2);
      const k = Math.min(1, Math.max(0, hole + 0.18 * amount));
      d[(y * N + x) * 4 + 3] = Math.round(255 * (1 - k));
    }
  g.putImageData(img, 0, 0);
  tiles.set(key, t);
  return t;
}

function paint(g: CanvasRenderingContext2D, colour: string, amount: number, fibre: boolean, scale: number): string | CanvasPattern {
  const t = tooth(colour, amount, fibre);
  if (typeof t === 'string') return t;
  const p = g.createPattern(t, 'repeat');
  if (!p) return colour;
  // the tooth belongs to the paper: its size follows the picture's, whatever the drawing's own size
  p.setTransform(new DOMMatrix().scale(scale));
  return p;
}

/* ───────────────────────── drawing it ───────────────────────── */

export interface Inks {
  ink: string;
  /** the strong colour, the second, the quiet one */
  a: string;
  b: string;
  c: string;
}

export interface DrawOpts {
  seed: number;
  hand: HandId;
  /** which redraw (a whole number, e.g. floor(time × 10)) */
  boil: number;
  /** how much is drawn, 0..1 */
  progress: number;
  /** where, in the context's units: the drawing is fitted inside and centred, standing on its ground */
  box: { x: number; y: number; w: number; h: number };
  inks: Inks;
  /** colour patches under the lines */
  colour: boolean;
  /** thicken the lines (small pictures) */
  fat?: number;
  /** device pixels per unit of the context, for the paper tooth (default 1) */
  tooth?: number;
  /** stand on the box's bottom edge instead of sitting in its middle */
  stand?: boolean;
  /** one colour round everything, this many drawing units wide, under it (a cut-out's edge) */
  halo?: { colour: string; width: number };
}

interface Traced {
  runs: (Path2D | null)[];
  /** everything, when all of it is drawn: per pass and colour */
  whole: Map<string, Path2D> | null;
  halo: Path2D | null;
}
const traced = new WeakMap<Drawing, Map<string, Traced>>();

function tracedFor(d: Drawing, key: string): Traced {
  let m = traced.get(d);
  if (!m) traced.set(d, (m = new Map()));
  let t = m.get(key);
  if (!t) {
    // a handful of sizes and hands at once is plenty
    if (m.size > VARIANTS * 4) m.clear();
    m.set(key, (t = { runs: [], whole: null, halo: null }));
  }
  return t;
}

/** the drawing's silhouette as a small picture in one colour, covering -100..1100 of its units */
const insides = new WeakMap<Drawing, { mask: Uint8Array; by: Map<string, HTMLCanvasElement> }>();
const INSIDE = 240;
const INSIDE_PAD = 100;
/**
 * Everything the outlines shut in, as a picture of one colour. Found by pouring in from the edges of the
 * page, so a shape drawn with several strokes that only nearly meet still counts as a shape.
 */
function insideOf(d: Drawing, colour: string): HTMLCanvasElement {
  let e = insides.get(d);
  if (!e) {
    const c = document.createElement('canvas');
    c.width = c.height = INSIDE;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.scale(INSIDE / (1000 + INSIDE_PAD * 2), INSIDE / (1000 + INSIDE_PAD * 2));
    g.translate(INSIDE_PAD, INSIDE_PAD);
    g.lineWidth = 16;
    g.lineJoin = g.lineCap = 'round';
    for (const s of d.strokes) {
      if (s.role === 'hatch') continue;
      const f = flatten(s);
      g.beginPath();
      for (let i = 0; i < f.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, f[i], f[i + 1]);
      if (s.closed) g.closePath();
      if (s.closed && s.role !== 'detail') g.fill();
      g.stroke();
    }
    const px = g.getImageData(0, 0, INSIDE, INSIDE).data;
    const out = new Uint8Array(INSIDE * INSIDE);
    const todo: number[] = [];
    const pour = (i: number) => {
      if (out[i] || px[i * 4 + 3] > 90) return;
      out[i] = 1;
      todo.push(i);
    };
    for (let k = 0; k < INSIDE; k++) {
      pour(k);
      pour((INSIDE - 1) * INSIDE + k);
      pour(k * INSIDE);
      pour(k * INSIDE + INSIDE - 1);
    }
    while (todo.length) {
      const i = todo.pop()!;
      const x = i % INSIDE;
      if (x > 0) pour(i - 1);
      if (x < INSIDE - 1) pour(i + 1);
      if (i >= INSIDE) pour(i - INSIDE);
      if (i < INSIDE * (INSIDE - 1)) pour(i + INSIDE);
    }
    insides.set(d, (e = { mask: out, by: new Map() }));
  }
  let c = e.by.get(colour);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = INSIDE;
    const g = c.getContext('2d')!;
    const img = g.createImageData(INSIDE, INSIDE);
    for (let i = 0; i < e.mask.length; i++) img.data[i * 4 + 3] = e.mask[i] ? 0 : 255;
    g.putImageData(img, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = colour;
    g.fillRect(0, 0, INSIDE, INSIDE);
    if (e.by.size > 3) e.by.clear();
    e.by.set(colour, c);
  }
  return c;
}

/** the drawing's place in `box`: scale and offset from drawing units */
export function fitBox(p: Prepared, box: DrawOpts['box'], stand = false): { k: number; x: number; y: number } {
  const b = p.bounds;
  const w = Math.max(40, b.x1 - b.x0);
  const h = Math.max(40, b.y1 - b.y0);
  const k = Math.min(box.w / w, box.h / h);
  return { k, x: box.x + (box.w - w * k) / 2 - b.x0 * k, y: stand ? box.y + box.h - b.y1 * k : box.y + (box.h - h * k) / 2 - b.y0 * k };
}

const colourOf = (i: Inks, c: number) => (c === 1 ? i.a : c === 2 ? i.b : c === 3 ? i.c : i.ink);
const ease = (u: number) => u * u * (3 - 2 * u) * 0.55 + u * 0.45;

export function drawDrawing(g: CanvasRenderingContext2D, d: Drawing, o: DrawOpts) {
  const prep = prepare(d);
  const H = HANDS[o.hand];
  const prog = Math.min(1, Math.max(0, o.progress));
  if (prog <= 0) return;
  const at = fitBox(prep, o.box, o.stand);
  const v = variantAt(o.boil, o.seed);
  // lines keep their weight on the page when a drawing doesn't fill its 1000 box
  const size = Math.max(prep.bounds.x1 - prep.bounds.x0, prep.bounds.y1 - prep.bounds.y0);
  const fat = (o.fat ?? 1) * Math.min(1.25, Math.max(0.8, size / 900));
  const fatKey = Math.round(fat * 20) / 20;
  const tr = tracedFor(d, `${o.seed}|${o.hand}|${v}|${fatKey}`);

  g.save();
  g.translate(at.x, at.y);
  g.scale(at.k, at.k);
  const inv = 1 / at.k;
  const fillOf = (c: string, amount: number, fibre: boolean) => paint(g, c, amount, fibre, inv * (o.tooth ?? 1));

  const pathOf = (i: number): Path2D => {
    let p = tr.runs[i];
    if (!p) {
      p = new Path2D();
      for (let k = 0; k < H.passes; k++) inkAll(p, prep.runs[i], { hand: H, seed: o.seed, variant: v, upTo: 1, fat: fatKey }, k);
      tr.runs[i] = p;
    }
    return p;
  };

  if (o.halo) {
    // the paper inside the shapes comes in behind the lines as they go down
    const in01 = Math.min(1, Math.max(0, (prog - 0.12) / 0.4));
    if (in01 > 0) {
      g.globalAlpha = in01 * in01 * (3 - 2 * in01);
      g.imageSmoothingEnabled = true;
      g.drawImage(insideOf(d, o.halo.colour), -INSIDE_PAD, -INSIDE_PAD, 1000 + INSIDE_PAD * 2, 1000 + INSIDE_PAD * 2);
      g.globalAlpha = 1;
    }
    g.strokeStyle = o.halo.colour;
    g.fillStyle = o.halo.colour;
    g.lineWidth = o.halo.width * 2;
    g.lineJoin = 'round';
    if (prog >= 1) {
      if (!tr.halo) {
        tr.halo = new Path2D();
        for (let i = 0; i < prep.runs.length; i++) tr.halo.addPath(pathOf(i));
        for (const s of prep.solids) tr.halo.addPath(patchPath(s, o.seed, v, 0));
      }
      g.stroke(tr.halo);
    } else {
      // still being drawn: only round what is there
      for (let i = 0; i < prep.runs.length; i++) {
        const [t0, t1] = prep.runT[i];
        if (prog <= t0) break;
        if (prog >= t1) g.stroke(pathOf(i));
        else {
          const p = new Path2D();
          inkAll(p, prep.runs[i], { hand: H, seed: o.seed, variant: v, upTo: ease((prog - t0) / Math.max(1e-4, t1 - t0)), fat: fatKey }, 0);
          g.stroke(p);
        }
      }
    }
  }

  const patch = (p: Patch, k: number, style: string | CanvasPattern) => {
    g.save();
    for (const c of p.cuts) {
      // everything but the shape in front
      const clip = new Path2D();
      clip.rect(-400, -400, 1800, 1800);
      for (let i = 0; i < c.length; i += 2) (i ? clip.lineTo : clip.moveTo).call(clip, c[i], c[i + 1]);
      clip.closePath();
      g.clip(clip, 'evenodd');
    }
    const path = patchPath(p, o.seed, v, 9);
    if (k >= 1) {
      g.fillStyle = style;
      g.fill(path);
    } else {
      g.clip(path);
      g.strokeStyle = style;
      scribble(g, p, o.seed, k);
    }
    g.restore();
  };
  const part = (t: [number, number]) => Math.min(1, Math.max(0, (prog - t[0]) / Math.max(1e-4, t[1] - t[0])));

  if (o.colour)
    prep.patches.forEach((p, i) => {
      const k = part(prep.patchT[i]);
      if (k > 0) patch(p, k, fillOf(colourOf(o.inks, p.colour), 0.16, false));
    });
  prep.solids.forEach((p, i) => {
    const k = part(prep.solidT[i]);
    if (k > 0) patch(p, k, fillOf(colourOf(o.inks, p.colour), Math.max(H.grain, 0.05), H.grain > 0.2));
  });

  g.globalAlpha = H.alpha;
  if (prog >= 1) {
    if (!tr.whole) {
      tr.whole = new Map();
      for (let k = 0; k < H.passes; k++)
        for (let i = 0; i < prep.runs.length; i++) {
          const key = `${k}|${prep.runs[i].colour}`;
          let p = tr.whole.get(key);
          if (!p) tr.whole.set(key, (p = new Path2D()));
          inkAll(p, prep.runs[i], { hand: H, seed: o.seed, variant: v, upTo: 1, fat: fatKey }, k);
        }
    }
    for (const [key, p] of tr.whole) {
      const c = Number(key.split('|')[1]);
      g.fillStyle = fillOf(colourOf(o.inks, c), H.grain, true);
      g.fill(p);
    }
  } else {
    const styles = new Map<number, string | CanvasPattern>();
    for (let i = 0; i < prep.runs.length; i++) {
      const [t0, t1] = prep.runT[i];
      if (prog < t0) break;
      const r = prep.runs[i];
      let st = styles.get(r.colour);
      if (!st) styles.set(r.colour, (st = fillOf(colourOf(o.inks, r.colour), H.grain, true)));
      g.fillStyle = st;
      if (prog >= t1) {
        if (H.passes > 1) for (let k = 0; k < H.passes; k++) fillPass(g, r, k, H, o.seed, v, fatKey, 1);
        else g.fill(pathOf(i));
      } else {
        const u = ease((prog - t0) / Math.max(1e-4, t1 - t0));
        fillPass(g, r, 0, H, o.seed, v, fatKey, u);
      }
    }
  }
  g.restore();
}

function fillPass(g: CanvasRenderingContext2D, r: Run, pass: number, hand: HandDef, seed: number, variant: number, fat: number, upTo: number) {
  const p = new Path2D();
  inkAll(p, r, { hand, seed, variant, upTo, fat }, pass);
  g.fill(p);
}
