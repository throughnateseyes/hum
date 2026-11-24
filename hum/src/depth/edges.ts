/**
 * The straight lines a clip really has (cables, kerbs, window grids, the stripes of a crossing), and
 * following each of them through the seconds a shot shows, so things can be drawn along them while the
 * camera moves.
 *
 *   edgesOf     what one frame's lines are kept as (the measuring worker makes it)
 *   hasEdges    are the lines for these seconds in?
 *   linesOver   the lines of a stretch of the clip, each with where it is at every sample. Pure
 *
 * A line is first moved to where the background's own movement takes it, then pulled onto the line the
 * next frame really shows there. Across itself it goes where the picture says; its ends, which come and
 * go as people pass, move slowly. What the picture doesn't show again (a cloud's edge, someone's sleeve)
 * is dropped.
 */
import { findLines } from './geometry';
import { slid, unslid } from './track';
import type { ClipScene } from './types';

/** clip seconds between frames looked at, in samples */
export const EDGE_EVERY = 2;
/** the most lines kept of one frame */
const MOST = 220;
/** shorter than this (frame heights) says nothing about the place */
const SHORT = 0.045;
const UNIT = 12000;
/** (counting misses: it left the frame) */
const OUT = 100;

/** one frame's lines, the best first: x, y of the middle, dx, dy of half of it (frame heights), how strong */
export function edgesOf(luma: ArrayLike<number>, w: number, h: number): Int16Array {
  const ls = findLines(luma, w, h).filter((l) => l.len > SHORT);
  ls.sort((a, b) => b.len * Math.sqrt(b.strong) - a.len * Math.sqrt(a.strong));
  const n = Math.min(MOST, ls.length);
  const out = new Int16Array(n * 5);
  for (let i = 0; i < n; i++) {
    const l = ls[i];
    out.set([l.x * UNIT, l.y * UNIT, l.dx * l.len * 0.5 * UNIT, l.dy * l.len * 0.5 * UNIT, l.strong].map(Math.round), i * 5);
  }
  return out;
}

/** are the lines for these seconds of the clip all in? */
export function hasEdges(s: ClipScene | null, from: number, to: number): boolean {
  if (!s?.edges) return false;
  let any = false;
  for (let i = 0; i < s.times.length; i += EDGE_EVERY) {
    if (s.times[i] < from - 0.15 || s.times[i] > to + 0.15) continue;
    any = true;
    if (!s.edges[i]) return false;
  }
  return any || s.edges.some(Boolean);
}

/** a line at one sample: its ends, frame heights from the middle of the clip's frame */
export interface Seg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SceneLine {
  /** the line's ends at each of `Lines.times` (NaN where it isn't in the picture) */
  keys: Float32Array;
  /** nearness at each end (1 / distance runs straight along a line in the picture) */
  n0: number;
  n1: number;
  /** how sure, how long and how clear a line it is, 0.. */
  score: number;
  len: number;
}

export interface Lines {
  times: number[];
  lines: SceneLine[];
}

interface Run {
  segs: (Seg | null)[];
  seen: number;
  tried: number;
  strong: number;
}

const unpack = (e: Int16Array): (Seg & { strong: number })[] =>
  Array.from({ length: e.length / 5 }, (_, i) => {
    const [x, y, dx, dy, strong] = e.subarray(i * 5, i * 5 + 5);
    return { x0: (x - dx) / UNIT, y0: (y - dy) / UNIT, x1: (x + dx) / UNIT, y1: (y + dy) / UNIT, strong };
  });

/** nearness of the clip's picture at a point (frame heights), from the sample nearest `i` with a map */
function nearAt(s: ClipScene, i: number, x: number, y: number): number {
  let m: Uint8Array | null = s.maps[i];
  for (let d = 1; !m && d < 5; d++) m = s.maps[i - d] ?? s.maps[i + d] ?? null;
  if (!m) return 0;
  const u = Math.min(s.width - 1, Math.max(0, Math.floor((x / s.aspect + 0.5) * s.width)));
  const v = Math.min(s.height - 1, Math.max(0, Math.floor((y + 0.5) * s.height)));
  const b = m[v * s.width + u] / 255;
  return b * b;
}

/** where a point of sample i is at sample j, from how the background moved */
function carried(s: ClipScene, i: number, j: number, x: number, y: number): [number, number] {
  if (s.camera === 'ahead' && s.sure.ahead > 0.35) {
    const a = s.views[i];
    const b = s.views[j];
    const n = Math.max(1e-4, nearAt(s, i, x, y));
    const z = s.zScale / n;
    const z2 = Math.max(0.6, z - (s.ahead[j] - s.ahead[i]));
    const k = z / z2;
    const ax = (a.u - 0.5) * s.aspect;
    const ay = a.v - 0.5;
    const c = Math.cos(b.roll - a.roll) * k;
    const r = Math.sin(b.roll - a.roll) * k;
    return [(b.u - 0.5) * s.aspect + (x - ax) * c - (y - ay) * r, b.v - 0.5 + (x - ax) * r + (y - ay) * c];
  }
  return slid(s.slides[j], ...unslid(s.slides[i], x, y));
}

/** how well a found line answers a looked-for one: the less the better, null when it doesn't */
function answers(want: Seg, f: Seg): number | null {
  const wx = want.x1 - want.x0;
  const wy = want.y1 - want.y0;
  const wl = Math.hypot(wx, wy);
  const fx = f.x1 - f.x0;
  const fy = f.y1 - f.y0;
  const fl = Math.hypot(fx, fy);
  if (wl < 1e-4 || fl < 1e-4) return null;
  const dot = Math.abs(wx * fx + wy * fy) / (wl * fl);
  if (dot < 0.992) return null;
  const ux = fx / fl;
  const uy = fy / fl;
  const mx = (want.x0 + want.x1) / 2 - f.x0;
  const my = (want.y0 + want.y1) / 2 - f.y0;
  const off = Math.abs(-mx * uy + my * ux);
  if (off > 0.014) return null;
  const a = (want.x0 - f.x0) * ux + (want.y0 - f.y0) * uy;
  const b = (want.x1 - f.x0) * ux + (want.y1 - f.y0) * uy;
  const over = Math.min(fl, Math.max(a, b)) - Math.max(0, Math.min(a, b));
  if (over < Math.min(fl, wl) * 0.3) return null;
  return off + (1 - dot) * 0.6;
}

/** the looked-for line pulled onto the found one */
function pulled(want: Seg, f: Seg): Seg {
  const fx = f.x1 - f.x0;
  const fy = f.y1 - f.y0;
  const fl = Math.hypot(fx, fy);
  const ux = fx / fl;
  const uy = fy / fl;
  const on = (x: number, y: number) => (x - f.x0) * ux + (y - f.y0) * uy;
  let a = on(want.x0, want.y0);
  let b = on(want.x1, want.y1);
  const [lo, hi] = a < b ? [0, fl] : [fl, 0];
  // an end moves towards the found one's a little at a time
  a += (lo - a) * 0.22;
  b += (hi - b) * 0.22;
  const k = 0.7;
  const to = (t: number, x: number, y: number): [number, number] => {
    const px = f.x0 + ux * t;
    const py = f.y0 + uy * t;
    return [x + (px - x) * k, y + (py - y) * k];
  };
  const [x0, y0] = to(a, want.x0, want.y0);
  const [x1, y1] = to(b, want.x1, want.y1);
  return { x0, y0, x1, y1 };
}

export function linesOver(s: ClipScene, from: number, to: number, most = 130): Lines {
  const at: number[] = [];
  const n = s.times.length;
  const step = n < 2 ? 1 : EDGE_EVERY;
  for (let i = 0; i < n; i += step) if (s.edges?.[i] && s.times[i] >= from - 0.35 && s.times[i] <= to + 0.35) at.push(i);
  if (!at.length && s.edges) {
    let best = -1;
    s.edges.forEach((e, i) => {
      if (e && (best < 0 || Math.abs(s.times[i] - from) < Math.abs(s.times[best] - from))) best = i;
    });
    if (best >= 0) at.push(best);
  }
  const times = at.map((i) => s.times[i]);
  if (!at.length) return { times, lines: [] };
  const frames = at.map((i) => unpack(s.edges![i]!));
  const runs: Run[] = [];
  /** follow a run from sample a to the next one, b: how many times in a row it has now been missed */
  const follow = (r: Run, a: number, b: number, lost: number): number => {
    const g = r.segs[a]!;
    const [x0, y0] = carried(s, at[a], at[b], g.x0, g.y0);
    const [x1, y1] = carried(s, at[a], at[b], g.x1, g.y1);
    const want = { x0, y0, x1, y1 };
    r.tried++;
    let best: Seg | null = null;
    let least = Infinity;
    for (const f of frames[b]) {
      const k = answers(want, f);
      if (k !== null && k < least) {
        least = k;
        best = f;
      }
    }
    r.segs[b] = best ? pulled(want, best) : want;
    if (best) r.seen++;
    const inside = Math.max(Math.abs(want.x0), Math.abs(want.x1)) < s.aspect * 0.75 && Math.max(Math.abs(want.y0), Math.abs(want.y1)) < 0.75;
    return best ? 0 : inside ? lost + 1 : OUT + lost;
  };
  // lines are taken up where they are first seen: the middle of the stretch, then out to both ends
  const mid = at.length >> 1;
  const order = at.map((_, k) => k).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  for (const k of order) {
    for (const f of frames[k]) {
      if (runs.length >= most * 2.2) break;
      if (Math.hypot(f.x1 - f.x0, f.y1 - f.y0) < 0.06) continue;
      // one that is there already (a thin thing has an edge on both sides of it)
      if (runs.some((r) => r.segs[k] && answers(r.segs[k]!, f) !== null)) continue;
      const r: Run = { segs: at.map(() => null), seen: 1, tried: 1, strong: f.strong };
      r.segs[k] = { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 };
      for (const d of [1, -1]) {
        let lost = 0;
        for (let j = k + d; j >= 0 && j < at.length; j += d) {
          lost = follow(r, j - d, j, lost);
          if (lost > 2) {
            // it was gone by the time it was first missed
            const missed = Math.min(lost >= OUT ? lost - OUT + 1 : lost, Math.abs(j - k));
            for (let m = 0; m < missed; m++) r.segs[j - d * m] = null;
            r.tried -= missed;
            break;
          }
        }
      }
      runs.push(r);
    }
  }
  const lines: SceneLine[] = [];
  for (const r of runs) {
    const have = r.segs.filter(Boolean).length;
    if (at.length > 2 && (have < Math.min(4, at.length * 0.5) || r.seen / Math.max(1, r.tried) < 0.55)) continue;
    // steadied: each sample with the ones either side of it
    const keys = new Float32Array(at.length * 4).fill(NaN);
    let len = 0;
    r.segs.forEach((g, k) => {
      if (!g) return;
      const prev = r.segs[k - 1];
      const next = r.segs[k + 1];
      const v = (['x0', 'y0', 'x1', 'y1'] as const).map((c) => (prev && next ? g[c] * 0.5 + (prev[c] + next[c]) * 0.25 : g[c]));
      keys.set(v, k * 4);
      len += Math.hypot(v[2] - v[0], v[3] - v[1]) / have;
    });
    const later = r.segs.findIndex((g, i) => g && i >= mid);
    const k = later >= 0 ? later : r.segs.findIndex(Boolean);
    const g = r.segs[k]!;
    // how far it is: the nearer side of it, away from its very ends
    const near = (u: number) => {
      const x = g.x0 + (g.x1 - g.x0) * u;
      const y = g.y0 + (g.y1 - g.y0) * u;
      const l = Math.hypot(g.x1 - g.x0, g.y1 - g.y0) || 1;
      const ox = (-(g.y1 - g.y0) / l) * 0.007;
      const oy = ((g.x1 - g.x0) / l) * 0.007;
      return Math.max(nearAt(s, at[k], x + ox, y + oy), nearAt(s, at[k], x - ox, y - oy));
    };
    const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
    const a = med([0.06, 0.14, 0.22, 0.3, 0.38].map(near));
    const b = med([0.62, 0.7, 0.78, 0.86, 0.94].map(near));
    const floor = 0.0012;
    const n0 = Math.max(floor, a + (a - b) * 0.39);
    const n1 = Math.max(floor, b + (b - a) * 0.39);
    lines.push({ keys, n0, n1, len, score: len * Math.sqrt(r.strong) * (r.seen / Math.max(1, r.tried)) * (0.5 + (0.5 * have) / at.length) });
  }
  lines.sort((a, b) => b.score - a.score);
  // spread over the picture: no part of it takes them all
  const cells = new Map<number, number>();
  const out = lines.filter((l) => {
    const k = l.keys.findIndex((v) => !Number.isNaN(v));
    const cx = (l.keys[k] + l.keys[k + 2]) / 2 / s.aspect + 0.5;
    const cy = (l.keys[k + 1] + l.keys[k + 3]) / 2 + 0.5;
    const c = Math.floor(cx * 6) + Math.floor(cy * 4) * 10;
    const had = cells.get(c) ?? 0;
    cells.set(c, had + 1);
    return had < 14;
  });
  return { times, lines: out.slice(0, most) };
}

/** a line's ends at clip second t (frame heights); null when it isn't in the picture */
export function segAt(l: Lines, i: number, t: number): Seg | null {
  const { times } = l;
  const keys = l.lines[i].keys;
  const n = times.length;
  let k = 0;
  while (k < n - 2 && times[k + 1] <= t) k++;
  const j = Math.min(n - 1, k + 1);
  const f = j === k ? 0 : Math.min(1, Math.max(0, (t - times[k]) / Math.max(1e-6, times[j] - times[k])));
  const a = k * 4;
  const b = j * 4;
  if (Number.isNaN(keys[a]) || Number.isNaN(keys[b])) return null;
  const v = (c: number) => keys[a + c] + (keys[b + c] - keys[a + c]) * f;
  return { x0: v(0), y0: v(1), x1: v(2), y1: v(3) };
}
