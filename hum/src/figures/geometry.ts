/**
 * Line figures: solids as points.
 *
 * Every solid becomes its vertices at rest (tilt included), the triangles that fill it, and what its
 * lines are worked out from each frame: a convex solid (box, disc, ball) is outlined by the hull of its
 * projected points, an extruded outline (poly) by the edges where the surface turns away, and a tube by
 * its path pushed out sideways.
 *
 * Parts of this file (the rounded rectangle and circle rings, the corner fillet, and drawing a solid as
 * the hull of two rounded rings with one crease just inside it) are adapted from hairline
 * (github.com/lucasmarkes/hairline), used under the MIT license:
 *
 *   MIT License. Copyright (c) 2026 Lucas Marques.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 *   associated documentation files (the "Software"), to deal in the Software without restriction,
 *   including without limitation the rights to use, copy, modify, merge, publish, distribute,
 *   sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions: The above copyright notice and this
 *   permission notice shall be included in all copies or substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 *   NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
 *   OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * (the full notice is also in hum/THIRD_PARTY.md)
 */
import { ShapeUtils, Vector2 } from 'three';
import { axisIndex, crossAxes, faceAxis, type Axis, type Figure, type FigureSolid, type V3 } from './format';

/* ───────── rings (adapted from hairline) ───────── */

interface Sample {
  a: number;
  b: number;
  na: number;
  nb: number;
}

/** a rounded rectangle pulled in by `inset`, `n` steps round each corner */
function rrect(a0: number, b0: number, a1: number, b1: number, r: number, inset: number, n: number): Sample[] {
  const x0 = a0 + inset;
  const y0 = b0 + inset;
  const x1 = a1 - inset;
  const y1 = b1 - inset;
  const q = Math.max(0.02, Math.min(Math.max(r - inset, 0.02), (x1 - x0) / 2, (y1 - y0) / 2));
  const out: Sample[] = [];
  const corners: [number, number, number][] = [
    [x1 - q, y1 - q, 0],
    [x0 + q, y1 - q, 90],
    [x0 + q, y0 + q, 180],
    [x1 - q, y0 + q, 270],
  ];
  for (const [ca, cb, a0deg] of corners)
    for (let k = 0; k <= n; k++) {
      const t = ((a0deg + (90 * k) / n) * Math.PI) / 180;
      out.push({ a: ca + q * Math.cos(t), b: cb + q * Math.sin(t), na: Math.cos(t), nb: Math.sin(t) });
    }
  return out;
}

function oval(a0: number, b0: number, a1: number, b1: number, inset: number, n: number): Sample[] {
  const ra = Math.max(0.01, (a1 - a0) / 2 - inset);
  const rb = Math.max(0.01, (b1 - b0) / 2 - inset);
  const out: Sample[] = [];
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const l = Math.hypot(c / ra, s / rb) || 1;
    out.push({ a: (a0 + a1) / 2 + ra * c, b: (b0 + b1) / 2 + rb * s, na: c / ra / l, nb: s / rb / l });
  }
  return out;
}

interface OutlinePoint {
  a: number;
  b: number;
  /** a corner worth a dim line down the side, when both its sides show */
  corner: boolean;
}

/** round every corner of an outline with the same radius (each cut to half its shorter edge) */
function fillet(pts: [number, number][], radius: number, n: number): OutlinePoint[] {
  const m = pts.length;
  const out: OutlinePoint[] = [];
  for (let i = 0; i < m; i++) {
    const a = pts[(i + m - 1) % m];
    const p = pts[i];
    const b = pts[(i + 1) % m];
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]) || 1e-6;
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1e-6;
    const dot = ((p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1])) / (la * lb);
    const turn = Math.acos(Math.max(-1, Math.min(1, dot)));
    const t = Math.min(radius, la / 2, lb / 2);
    const p1 = [p[0] + ((a[0] - p[0]) / la) * t, p[1] + ((a[1] - p[1]) / la) * t];
    const p2 = [p[0] + ((b[0] - p[0]) / lb) * t, p[1] + ((b[1] - p[1]) / lb) * t];
    for (let k = 0; k <= n; k++) {
      const s = k / n;
      const w = 1 - s;
      out.push({
        a: w * w * p1[0] + 2 * w * s * p[0] + s * s * p2[0],
        b: w * w * p1[1] + 2 * w * s * p[1] + s * s * p2[1],
        corner: k === Math.floor(n / 2) && turn > 0.6,
      });
    }
  }
  return out;
}

/* ───────── solids ───────── */

export interface MarkSeg {
  /** world, at rest */
  a: V3;
  b: V3;
}
export interface MarkDot {
  p: V3;
  /** two half-axes on the face */
  u: V3;
  v: V3;
}
export interface BuiltMarks {
  n: V3;
  segs: MarkSeg[];
  dots: MarkDot[];
}

export interface BuiltSolid {
  src: FigureSolid;
  kind: 'hull' | 'edges' | 'tube';
  /** xyz per vertex, in the world, at rest */
  verts: Float32Array;
  /** 0..1 per vertex: how far the face there is turned from the light */
  shade: Float32Array;
  tris: number[];
  /** hull: the vertices that can be on the outline */
  hullStart: number;
  hullCount: number;
  /** hull: the crease ring of each end, with the outward direction of the side at each sample */
  creases: { start: number; count: number; side: Float32Array; cap: V3; inset: number }[];
  /** edges: faces (normal and a vertex on it) and the edges between them */
  faces: { n: V3; v: number }[];
  edges: { a: number; b: number; f: number; g: number; ca: number; cb: number; corner: boolean }[];
  /** tube: path samples */
  path: V3[];
  tubeR: number;
  tubeRing: number;
  closed: boolean;
  marks: BuiltMarks[];
  /** the build-in pushes the solid out along this, from here */
  axis: V3;
  base: V3;
  height: number;
  /** middle of the solid and its lowest / highest corner, at rest */
  mid: V3;
  lo: V3;
  hi: V3;
  /** footprint area, for choosing which part of a lifted group drops guides */
  area: number;
  /** the corners guides drop from */
  feet: V3[];
}

export interface BuiltFigure {
  fig: Figure;
  solids: BuiltSolid[];
  verts: number;
  tris: number;
  lo: V3;
  hi: V3;
  mid: V3;
}

/** turn p about an axis through c: +deg about x takes +y toward +z, about y takes +z toward +x, about z takes +x toward +y */
export function turn(p: V3, axis: Axis, rad: number, c: V3): V3 {
  const k = axisIndex(axis);
  const i = (k + 1) % 3;
  const j = (k + 2) % 3;
  const s = Math.sin(rad);
  const q = Math.cos(rad);
  const out: V3 = [p[0], p[1], p[2]];
  const a = p[i] - c[i];
  const b = p[j] - c[j];
  out[i] = c[i] + a * q - b * s;
  out[j] = c[j] + a * s + b * q;
  return out;
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** light from above and a little from the front: tops are clean, the right side is the darkest */
const shadeOf = (n: V3) => Math.max(0, Math.min(1, 0.36 * (1 - n[2]) + 0.34 * Math.max(0, n[0])));

function buildSolid(s: FigureSolid): BuiltSolid {
  const k = axisIndex(s.axis);
  const [ia, ib] = crossAxes(s.axis);
  const a0 = s.from[ia];
  const a1 = s.to[ia];
  const b0 = s.from[ib];
  const b1 = s.to[ib];
  const h0 = s.from[k];
  const H = Math.max(0.1, s.to[k] - h0);
  const ca = (a0 + a1) / 2;
  const cb = (b0 + b1) / 2;
  const halfMin = Math.min(a1 - a0, b1 - b0) / 2;
  const centre: V3 = [(s.from[0] + s.to[0]) / 2, (s.from[1] + s.to[1]) / 2, (s.from[2] + s.to[2]) / 2];
  const tilted = (p: V3, about?: V3): V3 => (s.tilt ? turn(p, s.tilt.axis, (s.tilt.deg * Math.PI) / 180, about ?? s.tilt.about) : p);
  /** a footprint point at height fraction f, tapered and shifted, tilted */
  const at = (a: number, b: number, f: number): V3 => {
    const p: V3 = [0, 0, 0];
    p[ia] = ca + (a - ca) * (1 + (s.taper[0] - 1) * f) + s.shift[0] * f;
    p[ib] = cb + (b - cb) * (1 + (s.taper[1] - 1) * f) + s.shift[1] * f;
    p[k] = h0 + H * f;
    return tilted(p);
  };
  const dir = (na: number, nb: number, nk: number): V3 => {
    const p: V3 = [0, 0, 0];
    p[ia] = na;
    p[ib] = nb;
    p[k] = nk;
    return unit(tilted(p, [0, 0, 0]));
  };

  const verts: number[] = [];
  const shade: number[] = [];
  const tris: number[] = [];
  const push = (p: V3, n: V3) => {
    verts.push(p[0], p[1], p[2]);
    shade.push(shadeOf(n));
    return verts.length / 3 - 1;
  };
  const out: BuiltSolid = {
    src: s,
    kind: 'hull',
    verts: new Float32Array(0),
    shade: new Float32Array(0),
    tris,
    hullStart: 0,
    hullCount: 0,
    creases: [],
    faces: [],
    edges: [],
    path: [],
    tubeR: 0,
    tubeRing: 0,
    closed: false,
    marks: [],
    axis: dir(0, 0, 1),
    base: at(ca, cb, 0),
    height: H,
    mid: tilted(centre),
    lo: [0, 0, 0],
    hi: [0, 0, 0],
    area: (s.to[0] - s.from[0]) * (s.to[1] - s.from[1]),
    feet: [],
  };

  if (s.shape === 'tube') {
    out.kind = 'tube';
    const r = s.r ?? 1.5;
    const path = tubePath(s);
    const ring = 10;
    const n = path.length;
    // a frame carried along the path so the skin doesn't twist
    let up: V3 = [0, 0, 1];
    const t0 = unit(sub(path[1], path[0]));
    if (Math.abs(t0[2]) > 0.9) up = [1, 0, 0];
    for (let i = 0; i < n; i++) {
      const t = unit(sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)]));
      let u = cross(t, up);
      if (Math.hypot(...u) < 1e-3) u = cross(t, [0, 1, 0.1]);
      u = unit(u);
      up = unit(cross(u, t));
      for (let j = 0; j < ring; j++) {
        const g = (j / ring) * Math.PI * 2;
        const nrm: V3 = [0, 1, 2].map((q) => u[q] * Math.cos(g) + up[q] * Math.sin(g)) as V3;
        push([path[i][0] + nrm[0] * r, path[i][1] + nrm[1] * r, path[i][2] + nrm[2] * r], nrm);
      }
    }
    for (let i = 0; i < n - 1; i++)
      for (let j = 0; j < ring; j++) {
        const p = i * ring + j;
        const q = i * ring + ((j + 1) % ring);
        tris.push(p, q, p + ring, q, q + ring, p + ring);
      }
    // round ends: a cap of two rings and a tip
    if (!s.closed)
      for (const end of [0, n - 1]) {
        const t = unit(end === 0 ? sub(path[0], path[1]) : sub(path[n - 1], path[n - 2]));
        const baseV = end * ring;
        let prev = baseV;
        for (const f of [0.5, 0.82]) {
          const first = verts.length / 3;
          for (let j = 0; j < ring; j++) {
            const q = (baseV + j) * 3;
            const c = Math.cos((f * Math.PI) / 2);
            const g = Math.sin((f * Math.PI) / 2) * r;
            push([path[end][0] + (verts[q] - path[end][0]) * c + t[0] * g, path[end][1] + (verts[q + 1] - path[end][1]) * c + t[1] * g, path[end][2] + (verts[q + 2] - path[end][2]) * c + t[2] * g], t);
          }
          for (let j = 0; j < ring; j++) {
            const j2 = (j + 1) % ring;
            tris.push(prev + j, prev + j2, first + j, prev + j2, first + j2, first + j);
          }
          prev = first;
        }
        const tip = push([path[end][0] + t[0] * r, path[end][1] + t[1] * r, path[end][2] + t[2] * r], t);
        for (let j = 0; j < ring; j++) tris.push(prev + j, prev + ((j + 1) % ring), tip);
      }
    out.path = path;
    out.tubeR = r;
    out.tubeRing = ring;
    out.closed = !!s.closed;
    out.axis = [0, 0, 1];
    out.base = path[0];
  } else if (s.shape === 'poly') {
    out.kind = 'edges';
    const pts = s.outline!.map(([u, v]) => [a0 + (a1 - a0) * u, b0 + (b1 - b0) * v] as [number, number]);
    const ring = fillet(pts, Math.max(0.15, s.round), 5);
    const m = ring.length;
    // crease: the outline pulled in a little
    const pull = Math.min(Math.max(0.5, s.edge), halfMin * 0.12);
    const inner = ring.map((p, i) => {
      const a = ring[(i + m - 1) % m];
      const b = ring[(i + 1) % m];
      let na = b.b - a.b;
      let nb = -(b.a - a.a);
      const l = Math.hypot(na, nb) || 1;
      na /= l;
      nb /= l;
      return [p.a - na * pull, p.b - nb * pull] as [number, number];
    });
    const mid = (f: number, list: { a: number; b: number }[] | null) => (list ?? ring).map((p) => push(at(p.a, p.b, f), dir(0, 0, f ? 1 : -1)));
    const lowCap = mid(0, null);
    const highCap = mid(1, null);
    const flat = ShapeUtils.triangulateShape(ring.map((p) => new Vector2(p.a, p.b)), []);
    for (const [x, y, z] of flat) {
      tris.push(lowCap[x], lowCap[y], lowCap[z]);
      tris.push(highCap[x], highCap[y], highCap[z]);
    }
    const capN = dir(0, 0, 1);
    out.faces.push({ n: [-capN[0], -capN[1], -capN[2]], v: lowCap[0] }, { n: capN, v: highCap[0] });
    for (let i = 0; i < m; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % m];
      const outN: V3 = dir(q.b - p.b, -(q.a - p.a), 0);
      // the true normal of a tapered side, kept pointing out
      const e0 = at(p.a, p.b, 0);
      let n = unit(cross(sub(at(q.a, q.b, 0), e0), sub(at(p.a, p.b, 1), e0)));
      if (n[0] * outN[0] + n[1] * outN[1] + n[2] * outN[2] < 0) n = [-n[0], -n[1], -n[2]];
      const v = [push(e0, n), push(at(q.a, q.b, 0), n), push(at(q.a, q.b, 1), n), push(at(p.a, p.b, 1), n)];
      tris.push(v[0], v[1], v[2], v[0], v[2], v[3]);
      out.faces.push({ n, v: v[0] });
    }
    const innerLow = inner.map(([a, b]) => push(at(a, b, 0), [0, 0, 1]));
    const innerHigh = inner.map(([a, b]) => push(at(a, b, 1), [0, 0, 1]));
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      out.edges.push({ a: lowCap[i], b: lowCap[j], f: 0, g: 2 + i, ca: innerLow[i], cb: innerLow[j], corner: true });
      out.edges.push({ a: highCap[i], b: highCap[j], f: 1, g: 2 + i, ca: innerHigh[i], cb: innerHigh[j], corner: true });
      out.edges.push({ a: lowCap[i], b: highCap[i], f: 2 + ((i + m - 1) % m), g: 2 + i, ca: lowCap[i], cb: highCap[i], corner: ring[i].corner });
    }
  } else {
    const disc = s.shape !== 'box';
    const steps = Math.max(3, Math.min(10, Math.round(2 + 1.5 * Math.sqrt(Math.min(s.round, halfMin)))));
    const around = Math.max(28, Math.min(72, Math.round(26 + halfMin * 2.2)));
    const ringAt = (inset: number) => (disc ? oval(a0, b0, a1, b1, inset, around) : rrect(a0, b0, a1, b1, s.round, Math.min(inset, halfMin - 0.02), steps));
    const rings: { samples: Sample[]; f: number; nk: number; ns: number }[] = [];
    if (s.shape === 'ball') {
      const lat = 10;
      for (let i = 0; i <= lat; i++) {
        const t = -Math.PI / 2 + (Math.PI * i) / lat;
        // an oval footprint shrunk toward the poles
        const c = Math.max(0.004, Math.cos(t));
        rings.push({ samples: oval(ca + (a0 - ca) * c, cb + (b0 - cb) * c, ca + (a1 - ca) * c, cb + (b1 - cb) * c, 0, 32), f: (Math.sin(t) + 1) / 2, nk: Math.sin(t), ns: Math.cos(t) });
      }
    } else {
      const e = Math.min(s.edge, H * 0.96, halfMin * 0.98);
      rings.push({ samples: ringAt(0), f: 0, nk: 0, ns: 1 });
      const bend = e < 0.05 ? 0 : e < 2 ? 2 : 4;
      for (let i = 0; i <= bend; i++) {
        const t = bend ? (Math.PI / 2) * (i / bend) : 0;
        rings.push({ samples: ringAt(e * (1 - Math.cos(t))), f: (H - e + e * Math.sin(t)) / H, nk: Math.sin(t), ns: Math.cos(t) });
      }
      // the crease just inside the rim of each end
      const inset = Math.max(e, Math.min(0.9, halfMin * 0.2));
      if (inset < halfMin * 0.9) {
        for (const f of [0, 1]) {
          const ring = ringAt(inset);
          const start = verts.length / 3;
          const side = new Float32Array(ring.length * 3);
          ring.forEach((q, i) => {
            push(at(q.a, q.b, f), [0, 0, 1]);
            side.set(dir(q.na, q.nb, 0), i * 3);
          });
          out.creases.push({ start, count: ring.length, side, cap: dir(0, 0, f ? 1 : -1), inset });
        }
      }
    }
    const m = rings[0].samples.length;
    const first = verts.length / 3;
    for (const g of rings) for (const q of g.samples) push(at(q.a, q.b, g.f), dir(q.na * g.ns, q.nb * g.ns, g.nk));
    for (let g = 0; g < rings.length - 1; g++)
      for (let i = 0; i < m; i++) {
        const p = first + g * m + i;
        const q = first + g * m + ((i + 1) % m);
        tris.push(p, q, p + m, q, q + m, p + m);
      }
    for (const g of [0, rings.length - 1]) {
      const r = rings[g];
      const n = dir(0, 0, g ? 1 : -1);
      const v = r.samples.map((q) => push(at(q.a, q.b, r.f), n));
      for (let i = 1; i < m - 1; i++) tris.push(v[0], v[i], v[i + 1]);
    }
    // the outline only ever runs through the rings (the caps repeat them)
    out.hullStart = first;
    out.hullCount = rings.length * m;
  }

  out.verts = new Float32Array(verts);
  out.shade = new Float32Array(shade);
  const lo: V3 = [1e9, 1e9, 1e9];
  const hi: V3 = [-1e9, -1e9, -1e9];
  for (let i = 0; i < verts.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], verts[i]);
    hi[i % 3] = Math.max(hi[i % 3], verts[i]);
  }
  out.lo = lo;
  out.hi = hi;
  if (s.axis === 'z' && s.shape !== 'tube') {
    const inset = Math.min(s.shape === 'disc' ? halfMin : Math.max(0.6, s.round * 0.3), halfMin);
    out.feet = s.shape === 'disc' ? [at(a0, cb, 0), at(a1, cb, 0)] : [at(a1 - inset, b0 + inset, 0), at(a0 + inset, b1 - inset, 0), at(a1 - inset, b1 - inset, 0)];
  }

  for (const m of s.marks) {
    const { axis, dir: side } = faceAxis(m.face);
    const f = axisIndex(axis);
    const [fu, fv] = crossAxes(axis);
    /** a point on the face, lifted off it by a hair */
    const on = (u: number, v: number): V3 => {
      const p: V3 = [0, 0, 0];
      p[f] = side > 0 ? s.to[f] : s.from[f];
      p[fu] = s.from[fu] + (s.to[fu] - s.from[fu]) * u;
      p[fv] = s.from[fv] + (s.to[fv] - s.from[fv]) * v;
      return at(p[ia], p[ib], (p[k] - h0) / H);
    };
    const o = on(0.5, 0.5);
    let n = unit(cross(sub(on(1, 0.5), o), sub(on(0.5, 1), o)));
    if ((n[0] * (o[0] - out.mid[0]) + n[1] * (o[1] - out.mid[1]) + n[2] * (o[2] - out.mid[2])) < 0) n = [-n[0], -n[1], -n[2]];
    const uHat = unit(sub(on(1, 0.5), on(0, 0.5)));
    const vHat = unit(sub(on(0.5, 1), on(0.5, 0)));
    const off = (p: V3): V3 => [p[0] + n[0] * 0.03, p[1] + n[1] * 0.03, p[2] + n[2] * 0.03];
    const P = (u: number, v: number) => off(on(u, v));
    const [u0, v0, u1, v1] = m.box;
    const built: BuiltMarks = { n, segs: [], dots: [] };
    const seg = (p: V3, q: V3) => built.segs.push({ a: p, b: q });
    const dot = (u: number, v: number) => built.dots.push({ p: P(u, v), u: uHat.map((x) => x * Math.min(m.r, 8)) as V3, v: vHat.map((x) => x * Math.min(m.r, 8)) as V3 });
    const step = (i: number, count: number) => (count <= 1 ? 0.5 : i / (count - 1));
    if (m.kind === 'dot') dot((u0 + u1) / 2, (v0 + v1) / 2);
    else if (m.kind === 'dots') {
      for (let i = 0; i < m.n[0]; i++) for (let j = 0; j < m.n[1]; j++) dot(u0 + (u1 - u0) * step(i, m.n[0]), v0 + (v1 - v0) * step(j, m.n[1]));
    } else if (m.kind === 'line') seg(P(u0, v0), P(u1, v1));
    else if (m.kind === 'lines') {
      for (let i = 0; i < m.n[0]; i++) seg(P(u0 + (u1 - u0) * step(i, m.n[0]), v0), P(u0 + (u1 - u0) * step(i, m.n[0]), v1));
      for (let i = 0; i < m.n[1]; i++) seg(P(u0, v0 + (v1 - v0) * step(i, m.n[1])), P(u1, v0 + (v1 - v0) * step(i, m.n[1])));
    } else {
      const c = P((u0 + u1) / 2, (v0 + v1) / 2);
      const loop: V3[] = [];
      if (m.kind === 'ring') {
        for (let i = 0; i < 40; i++) {
          const t = (i / 40) * Math.PI * 2;
          loop.push([0, 1, 2].map((q) => c[q] + uHat[q] * Math.cos(t) * m.r + vHat[q] * Math.sin(t) * m.r) as V3);
        }
      } else {
        const wu = Math.hypot(...sub(P(u1, 0.5), P(u0, 0.5)));
        const wv = Math.hypot(...sub(P(0.5, v1), P(0.5, v0)));
        for (const q of rrect(-wu / 2, -wv / 2, wu / 2, wv / 2, Math.min(m.r, wu / 2, wv / 2), 0, 4)) loop.push([0, 1, 2].map((i) => c[i] + uHat[i] * q.a + vHat[i] * q.b) as V3);
      }
      loop.forEach((p, i) => seg(p, loop[(i + 1) % loop.length]));
    }
    if (built.segs.length || built.dots.length) out.marks.push(built);
  }
  return out;
}

/** the tube's path, sampled: a Catmull-Rom curve through its points, or straight runs with rounded bends */
function tubePath(s: FigureSolid): V3[] {
  const pts = s.path!;
  const n = pts.length;
  const out: V3[] = [];
  if (s.smooth && n > 2) {
    const at = (i: number) => (s.closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
    const spans = s.closed ? n : n - 1;
    for (let i = 0; i < spans; i++) {
      const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
      for (let k = 0; k < 10; k++) {
        const t = k / 10;
        out.push([0, 1, 2].map((q) => 0.5 * (2 * p1[q] + (p2[q] - p0[q]) * t + (2 * p0[q] - 5 * p1[q] + 4 * p2[q] - p3[q]) * t * t + (3 * p1[q] - p0[q] - 3 * p2[q] + p3[q]) * t * t * t)) as V3);
      }
    }
    out.push(s.closed ? out[0] : pts[n - 1]);
    return out;
  }
  // straight: round each bend by the tube's own thickness
  const rad = (s.r ?? 1.5) * 2.2;
  const loop = s.closed ? [...pts, pts[0]] : pts;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const a = i > 0 ? loop[i - 1] : s.closed ? loop[loop.length - 2] : null;
    const b = i < loop.length - 1 ? loop[i + 1] : s.closed ? loop[1] : null;
    if (!a || !b) {
      out.push(p);
      continue;
    }
    const la = Math.hypot(...sub(a, p)) || 1;
    const lb = Math.hypot(...sub(b, p)) || 1;
    const t = Math.min(rad, la / 2, lb / 2);
    for (let k = 0; k <= 6; k++) {
      const f = k / 6;
      const w = 1 - f;
      out.push([0, 1, 2].map((q) => w * w * (p[q] + ((a[q] - p[q]) / la) * t) + 2 * w * f * p[q] + f * f * (p[q] + ((b[q] - p[q]) / lb) * t)) as V3);
    }
  }
  return out;
}

const cache = new WeakMap<Figure, BuiltFigure>();
export function buildFigure(fig: Figure): BuiltFigure {
  let b = cache.get(fig);
  if (b) return b;
  const solids = fig.solids.map(buildSolid);
  const lo: V3 = [1e9, 1e9, 1e9];
  const hi: V3 = [-1e9, -1e9, -1e9];
  for (const s of solids)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], s.lo[k]);
      hi[k] = Math.max(hi[k], s.hi[k]);
    }
  b = { fig, solids, verts: solids.reduce((n, s) => n + s.verts.length / 3, 0), tris: solids.reduce((n, s) => n + s.tris.length, 0), lo, hi, mid: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] };
  cache.set(fig, b);
  return b;
}
