/**
 * How a clip's camera moves, worked out from its frames. Points with detail round them are found in one
 * frame and looked for in the next; where the points went says how the camera went.
 *
 *   Tracker        fed a clip's frames in order, it says how the background sits in each (against the
 *                  stretch's first) and how far the camera moved ahead between the frames with a map
 *   fitSlide       the turn, scale and slide that carries one set of points onto another
 *   fitMotion      the camera's turn and movement that explains how points at known distances moved
 *
 * Pictures are brightness, 0..255, rows bottom to top. Pure: no canvas, the same every run.
 */
import { dice, solve } from './geometry';
import type { Slide } from './types';

interface Level {
  w: number;
  h: number;
  d: Float32Array;
}

export function pyramid(luma: ArrayLike<number>, w: number, h: number, levels = 4): Level[] {
  let cur: Level = { w, h, d: Float32Array.from(luma) };
  const out = [cur];
  for (let l = 1; l < levels && Math.min(cur.w, cur.h) >= 32; l++) {
    const nw = cur.w >> 1;
    const nh = cur.h >> 1;
    const d = new Float32Array(nw * nh);
    const { w: cw, h: ch, d: s } = cur;
    // a 1-3-3-1 blur, so nothing shimmers as it shrinks
    const K = [1 / 8, 3 / 8, 3 / 8, 1 / 8];
    const tmp = new Float32Array(nw * ch);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < nw; x++) {
        let v = 0;
        for (let k = 0; k < 4; k++) v += K[k] * s[y * cw + Math.min(cw - 1, Math.max(0, 2 * x - 1 + k))];
        tmp[y * nw + x] = v;
      }
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        let v = 0;
        for (let k = 0; k < 4; k++) v += K[k] * tmp[Math.min(ch - 1, Math.max(0, 2 * y - 1 + k)) * nw + x];
        d[y * nw + x] = v;
      }
    cur = { w: nw, h: nh, d };
    out.push(cur);
  }
  return out;
}

/** Points with detail in both directions, spread over the picture: x, y pairs in pixels. `ok` says where they may be. */
export function corners(luma: ArrayLike<number>, w: number, h: number, count: number, ok?: (i: number) => boolean): Float32Array {
  const cell = Math.max(6, Math.round(Math.sqrt((w * h) / count)));
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const best = new Float32Array(gw * gh);
  const at = new Int32Array(gw * gh).fill(-1);
  const R = 2;
  const B = 7;
  let top = 0;
  for (let y = B; y < h - B; y += 1)
    for (let x = B + (y & 1); x < w - B; x += 2) {
      const i = y * w + x;
      if (ok && !ok(i)) continue;
      let xx = 0, xy = 0, yy = 0;
      for (let j = -R; j <= R; j++)
        for (let k = -R; k <= R; k++) {
          const p = i + j * w + k;
          const gx = luma[p + 1] - luma[p - 1];
          const gy = luma[p + w] - luma[p - w];
          xx += gx * gx;
          xy += gx * gy;
          yy += gy * gy;
        }
      const s = (xx + yy) / 2 - Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy);
      if (s > top) top = s;
      const c = Math.floor(y / cell) * gw + Math.floor(x / cell);
      if (s > best[c]) {
        best[c] = s;
        at[c] = i;
      }
    }
  const out: number[] = [];
  const least = Math.max(260, top * 0.004);
  for (let c = 0; c < at.length; c++) if (at[c] >= 0 && best[c] > least) out.push(at[c] % w, Math.floor(at[c] / w));
  return Float32Array.from(out);
}

/** the window a point is recognised by: this many pixels either way */
const WIN = 5;
const SIDE = WIN * 2 + 1;
const patch = new Float32Array(SIDE * SIDE);
const pgx = new Float32Array(SIDE * SIDE);
const pgy = new Float32Array(SIDE * SIDE);

/** Looks for points of `a` in `b`. `to` holds where to start looking (pixels), and where they were found. 0 in `ok` is lost. */
export function follow(a: Level[], b: Level[], from: Float32Array, to: Float32Array, ok: Uint8Array, start = 99) {
  const n = from.length >> 1;
  const levels = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (!ok[i]) continue;
    const s0 = 2 ** Math.min(start, levels - 1);
    let gx = (to[i * 2] - from[i * 2]) / s0;
    let gy = (to[i * 2 + 1] - from[i * 2 + 1]) / s0;
    let good = true;
    for (let l = Math.min(start, levels - 1); l >= 0; l--) {
      const A = a[l];
      const B = b[l];
      const k = 2 ** l;
      const px = (from[i * 2] + 0.5) / k - 0.5;
      const py = (from[i * 2 + 1] + 0.5) / k - 0.5;
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      const room = ix - WIN - 1 >= 0 && iy - WIN - 1 >= 0 && ix + WIN + 2 < A.w && iy + WIN + 2 < A.h;
      if (room) {
        const fx = px - ix;
        const fy = py - iy;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        let mean = 0;
        for (let y = -WIN, o = 0; y <= WIN; y++)
          for (let x = -WIN; x <= WIN; x++, o++) {
            const q = (iy + y) * A.w + ix + x;
            const s = A.d;
            const v = s[q] * w00 + s[q + 1] * w10 + s[q + A.w] * w01 + s[q + A.w + 1] * w11;
            patch[o] = v;
            mean += v;
            pgx[o] = ((s[q + 1] - s[q - 1]) * w00 + (s[q + 2] - s[q]) * w10 + (s[q + A.w + 1] - s[q + A.w - 1]) * w01 + (s[q + A.w + 2] - s[q + A.w]) * w11) / 2;
            pgy[o] = ((s[q + A.w] - s[q - A.w]) * w00 + (s[q + A.w + 1] - s[q - A.w + 1]) * w10 + (s[q + 2 * A.w] - s[q]) * w01 + (s[q + 2 * A.w + 1] - s[q + 1]) * w11) / 2;
          }
        mean /= SIDE * SIDE;
        let xx = 0, xy = 0, yy = 0;
        for (let o = 0; o < SIDE * SIDE; o++) {
          xx += pgx[o] * pgx[o];
          xy += pgx[o] * pgy[o];
          yy += pgy[o] * pgy[o];
        }
        const det = xx * yy - xy * xy;
        if (det > 1e-3) {
          for (let it = 0; it < 12; it++) {
            const qx = px + gx;
            const qy = py + gy;
            const jx = Math.floor(qx);
            const jy = Math.floor(qy);
            if (jx - WIN < 0 || jy - WIN < 0 || jx + WIN + 1 >= B.w || jy + WIN + 1 >= B.h) {
              if (l === 0) good = false;
              break;
            }
            const ex = qx - jx;
            const ey = qy - jy;
            const v00 = (1 - ex) * (1 - ey), v10 = ex * (1 - ey), v01 = (1 - ex) * ey, v11 = ex * ey;
            const s = B.d;
            let mb = 0, sx = 0, sy = 0, tx = 0, ty = 0;
            for (let y = -WIN, o = 0; y <= WIN; y++) {
              let q = (jy + y) * B.w + jx - WIN;
              for (let x = -WIN; x <= WIN; x++, o++, q++) {
                const v = s[q] * v00 + s[q + 1] * v10 + s[q + B.w] * v01 + s[q + B.w + 1] * v11;
                mb += v;
                const e = patch[o] - mean - v;
                sx += e * pgx[o];
                sy += e * pgy[o];
                tx += pgx[o];
                ty += pgy[o];
              }
            }
            mb /= SIDE * SIDE;
            // (brightness may have changed between the frames: only the pattern counts)
            sx += mb * tx;
            sy += mb * ty;
            const dx = (sx * yy - sy * xy) / det;
            const dy = (sy * xx - sx * xy) / det;
            gx += dx;
            gy += dy;
            if (dx * dx + dy * dy < 0.0004) break;
          }
        } else if (l === 0) good = false;
      } else if (l === 0) good = false;
      if (!good) break;
      if (l > 0) {
        gx *= 2;
        gy *= 2;
      }
    }
    if (!good || !Number.isFinite(gx + gy)) {
      ok[i] = 0;
      continue;
    }
    to[i * 2] = from[i * 2] + gx;
    to[i * 2 + 1] = from[i * 2 + 1] + gy;
  }
}

/** Follow there and back: a point that does not come back to where it started was not followed */
export function followBothWays(a: Level[], b: Level[], from: Float32Array, to: Float32Array, ok: Uint8Array, start = 99, slack = 0.6) {
  follow(a, b, from, to, ok, start);
  const back = Float32Array.from(from);
  const ok2 = Uint8Array.from(ok);
  follow(b, a, to, back, ok2, 1);
  for (let i = 0; i < ok.length; i++) if (ok[i] && (!ok2[i] || Math.hypot(back[i * 2] - from[i * 2], back[i * 2 + 1] - from[i * 2 + 1]) > slack)) ok[i] = 0;
}

export const NO_SLIDE: Slide = { x: 0, y: 0, scale: 1, turn: 0 };
/** where a slide puts a point */
export function slid(s: Slide, x: number, y: number): [number, number] {
  const c = Math.cos(s.turn) * s.scale;
  const k = Math.sin(s.turn) * s.scale;
  return [c * x - k * y + s.x, k * x + c * y + s.y];
}
/** where the point came from that a slide puts at x, y */
export function unslid(s: Slide, x: number, y: number): [number, number] {
  const c = Math.cos(s.turn) / s.scale;
  const k = Math.sin(s.turn) / s.scale;
  const px = x - s.x;
  const py = y - s.y;
  return [c * px + k * py, -k * px + c * py];
}
/** first a, then b */
export function slideAfter(a: Slide, b: Slide): Slide {
  const [x, y] = slid(b, a.x, a.y);
  return { x, y, scale: a.scale * b.scale, turn: a.turn + b.turn };
}

/** The slide that carries points p onto q (frame heights, x y pairs), led by the most points that agree. `who` gets 1 for those. `rigid`: nothing grows or shrinks. */
export function fitSlide(p: number[], q: number[], tol: number, who?: Uint8Array, rigid = false): { slide: Slide; share: number } | null {
  const n = p.length >> 1;
  if (n < 6) return null;
  const rand = dice(11);
  const t2 = tol * tol;
  let bc = 1, bs = 0, bx = 0, by = 0, best = -1;
  for (let k = 0; k < 160; k++) {
    const i = Math.floor(rand() * n);
    const j = Math.floor(rand() * n);
    const dx = p[j * 2] - p[i * 2];
    const dy = p[j * 2 + 1] - p[i * 2 + 1];
    const l = dx * dx + dy * dy;
    if (l < 0.01) continue;
    const ex = q[j * 2] - q[i * 2];
    const ey = q[j * 2 + 1] - q[i * 2 + 1];
    let c = (dx * ex + dy * ey) / l;
    let s = (dx * ey - dy * ex) / l;
    const m = Math.hypot(c, s);
    if (m < 0.8 || m > 1.25) continue;
    if (rigid) {
      if (Math.abs(m - 1) > 0.03) continue;
      c /= m;
      s /= m;
    }
    const x = q[i * 2] - c * p[i * 2] + s * p[i * 2 + 1];
    const y = q[i * 2 + 1] - s * p[i * 2] - c * p[i * 2 + 1];
    let score = 0;
    for (let a = 0; a < n; a++) {
      const rx = c * p[a * 2] - s * p[a * 2 + 1] + x - q[a * 2];
      const ry = s * p[a * 2] + c * p[a * 2 + 1] + y - q[a * 2 + 1];
      const r = rx * rx + ry * ry;
      if (r < t2) score += 1 - r / t2;
    }
    if (score > best) {
      best = score;
      [bc, bs, bx, by] = [c, s, x, y];
    }
  }
  if (best <= 0) return null;
  let on = 0;
  for (let pass = 0; pass < 8; pass++) {
    let sw = 0, px = 0, py = 0, qx = 0, qy = 0;
    const ws = new Float64Array(n);
    on = 0;
    for (let a = 0; a < n; a++) {
      const rx = bc * p[a * 2] - bs * p[a * 2 + 1] + bx - q[a * 2];
      const ry = bs * p[a * 2] + bc * p[a * 2 + 1] + by - q[a * 2 + 1];
      const r = (rx * rx + ry * ry) / t2;
      const k = r < 1 ? (1 - r) ** 2 : 0;
      if (who) who[a] = r < 1 ? 1 : 0;
      if (r < 1) on++;
      ws[a] = k;
      sw += k;
      px += k * p[a * 2];
      py += k * p[a * 2 + 1];
      qx += k * q[a * 2];
      qy += k * q[a * 2 + 1];
    }
    if (sw < 1e-6) return null;
    px /= sw;
    py /= sw;
    qx /= sw;
    qy /= sw;
    let c = 0, s = 0, l = 0;
    for (let a = 0; a < n; a++) {
      const k = ws[a];
      if (!k) continue;
      const ax = p[a * 2] - px, ay = p[a * 2 + 1] - py, cx = q[a * 2] - qx, cy = q[a * 2 + 1] - qy;
      c += k * (ax * cx + ay * cy);
      s += k * (ax * cy - ay * cx);
      l += k * (ax * ax + ay * ay);
    }
    if (l < 1e-9) return null;
    const size = rigid ? Math.hypot(c, s) : l;
    bc = c / size;
    bs = s / size;
    bx = qx - bc * px + bs * py;
    by = qy - bs * px - bc * py;
  }
  if (on < 6) return null;
  return { slide: { x: bx, y: by, scale: Math.hypot(bc, bs), turn: Math.atan2(bs, bc) }, share: on / n };
}

/** how the camera moved between two frames: turns in radians, moves in the units 1/nearness is in */
export interface Motion {
  turnX: number;
  turnY: number;
  roll: number;
  right: number;
  up: number;
  ahead: number;
  /** points that agree, as a share, and how many */
  share: number;
  count: number;
  /** how well the ahead part is pinned down: its error as a share of itself (small is good) */
  aheadError: number;
}

/**
 * The camera's movement from points that went (dx, dy) and have a known nearness. x, y are the point
 * half way along (that makes a step the size of a few percent exact enough).
 */
export function fitMotion(x: number[], y: number[], dx: number[], dy: number[], near: number[], focal: number, tol: number): Motion | null {
  const n = x.length;
  if (n < 12) return null;
  const rowX = (i: number) => [(x[i] * y[i]) / focal, -(focal + (x[i] * x[i]) / focal), y[i], -focal * near[i], 0, x[i] * near[i]];
  const rowY = (i: number) => [focal + (y[i] * y[i]) / focal, -(x[i] * y[i]) / focal, -x[i], 0, -focal * near[i], y[i] * near[i]];
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) rows.push(rowX(i), rowY(i));
  const val = (i: number) => (i & 1 ? dy[i >> 1] : dx[i >> 1]);
  const dot = (r: number[], m: number[]) => r[0] * m[0] + r[1] * m[1] + r[2] * m[2] + r[3] * m[3] + r[4] * m[4] + r[5] * m[5];
  const fit = (w: (i: number) => number, ridge: number) => {
    const A = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
    const b = new Array<number>(6).fill(0);
    for (let i = 0; i < n; i++) {
      const k = w(i);
      if (!k) continue;
      for (let e = 0; e < 2; e++) {
        const r = rows[i * 2 + e];
        const v = val(i * 2 + e);
        for (let p = 0; p < 6; p++) {
          b[p] += k * r[p] * v;
          for (let q = p; q < 6; q++) A[p][q] += k * r[p] * r[q];
        }
      }
    }
    for (let p = 0; p < 6; p++) for (let q = 0; q < p; q++) A[p][q] = A[q][p];
    // sideways movement and turning look alike when everything is far: turning is the likelier story
    A[3][3] += ridge;
    A[4][4] += ridge;
    A[5][5] += ridge * 0.02;
    const m = solve(A, b);
    return m ? { m, A } : null;
  };
  const rand = dice(5);
  let best: number[] | null = null;
  let bestS = -1;
  const t2 = tol * tol;
  const res = (m: number[], i: number) => {
    const ex = dot(rows[i * 2], m) - dx[i];
    const ey = dot(rows[i * 2 + 1], m) - dy[i];
    return ex * ex + ey * ey;
  };
  for (let k = 0; k < 120; k++) {
    const pick = new Set<number>();
    while (pick.size < 5) pick.add(Math.floor(rand() * n));
    const f = fit((i) => (pick.has(i) ? 1 : 0), 1e-4);
    if (!f) continue;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const r = res(f.m, i);
      if (r < t2) s += 1 - r / t2;
    }
    if (s > bestS) {
      bestS = s;
      best = f.m;
    }
  }
  if (!best) return null;
  let m = best;
  let A: number[][] | null = null;
  let on = 0;
  let sse = 0;
  for (let pass = 0; pass < 6; pass++) {
    const prev = m;
    const f = fit((i) => {
      const r = res(prev, i) / t2;
      return r < 1 ? (1 - r) ** 2 : 0;
    }, 1e-3);
    if (!f) return null;
    m = f.m;
    A = f.A;
  }
  for (let i = 0; i < n; i++) {
    const r = res(m, i);
    if (r < t2) {
      on++;
      sse += r;
    }
  }
  if (on < 10 || !A) return null;
  const unit = solve(A, [0, 0, 0, 0, 0, 1]);
  const sd = unit ? Math.sqrt(Math.max(0, unit[5]) * (sse / Math.max(1, on * 2 - 6))) : Infinity;
  return { turnX: m[0], turnY: m[1], roll: m[2], right: m[3], up: m[4], ahead: m[5], share: on / n, count: on, aheadError: sd / Math.max(1e-6, Math.abs(m[5])) };
}

export interface Track {
  t: number;
  /** against the stretch's first frame */
  slide: Slide;
  /** 0..1: how many background points agree, and how many there were */
  slideSure: number;
  /** from the frame with a map before this one to this one (only on frames with a map) */
  motion: Motion | null;
}

/** points followed for the slide, and for the motion */
const BACK = 220;
const ALL = 420;

export class Tracker {
  private key: { pyr: Level[]; pts: Float32Array; base: Slide; drop: Uint8Array; had: number; map: Float32Array } | null = null;
  private last: { pyr: Level[]; to: Float32Array; ok: Uint8Array; luma: Float32Array } | null = null;
  private mo: { pyr: Level[]; luma: Float32Array; from: Float32Array; to: Float32Array; ok: Uint8Array; near: Float32Array } | null = null;
  private slide: Slide = NO_SLIDE;

  constructor(
    private w: number,
    private h: number,
    private focal: number,
    /** the camera moves ahead: only what is as good as infinitely far says how it turned, and that never grows */
    private ahead = false,
  ) {}

  private far(map: Float32Array, luma: Float32Array): Float32Array {
    const { w, h } = this;
    // the background: the farther part of what can be told apart, and the sky if there are clouds in it
    const r = this.ahead ? 7 : 4;
    const room = [-r, r, -r * w, r * w, ...(this.ahead ? [-12, 12, -5 - 5 * w, 5 - 5 * w, 5 * w - 5, 5 * w + 5] : [])];
    const some: number[] = [];
    for (let i = 0; i < map.length; i += 17) if (map[i] > 0) some.push(map[i]);
    some.sort((a, b) => a - b);
    const at = (share: number) => (some.length ? some[Math.min(some.length - 1, Math.floor(some.length * share))] : Infinity);
    // as good as infinitely far is best of all: it only ever moves when the camera turns
    for (const limit of [at(0.9) * 0.07, at(0.45), at(0.65), Infinity]) {
      // points right on the edge of something near belong to neither side
      const clear = (i: number) => {
        if (map[i] > limit) return false;
        for (const d of room) if (!(map[i + d] <= limit * 1.3)) return false;
        return true;
      };
      const pts = corners(luma, w, h, BACK, clear);
      if (pts.length >= (this.ahead ? 40 : limit < at(0.3) ? 110 : 60) || limit === Infinity) return pts;
    }
    return new Float32Array(0);
  }

  /** The stretch's next frame, in order. `map`: its nearness, when there is one (the first frame must have one). */
  push(t: number, luma: Float32Array, map: Float32Array | null): Track {
    const { w, h } = this;
    const pyr = pyramid(luma, w, h);
    const fx = (p: number) => (p + 0.5 - w / 2) / h;
    const fy = (p: number) => (p + 0.5 - h / 2) / h;
    let sure = 1;
    let motion: Motion | null = null;

    if (this.key && this.last) {
      const { key, last } = this;
      const n = key.pts.length >> 1;
      // start looking where the background was heading
      const to = Float32Array.from(last.to);
      const ok = Uint8Array.from(last.ok);
      followBothWays(last.pyr, pyr, last.to, to, ok, 99, 0.8);
      // then pin each to how it looked in the key frame, so nothing creeps
      const fine = Float32Array.from(to);
      const fineOk = Uint8Array.from(ok);
      follow(key.pyr, pyr, key.pts, fine, fineOk, 0);
      const p: number[] = [];
      const q: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i < n; i++) {
        if (!ok[i] || key.drop[i] > 3) continue;
        if (fineOk[i] && Math.hypot(fine[i * 2] - to[i * 2], fine[i * 2 + 1] - to[i * 2 + 1]) < 1) {
          to[i * 2] = fine[i * 2];
          to[i * 2 + 1] = fine[i * 2 + 1];
        }
        p.push(fx(key.pts[i * 2]), fy(key.pts[i * 2 + 1]));
        q.push(fx(to[i * 2]), fy(to[i * 2 + 1]));
        idx.push(i);
      }
      const who = new Uint8Array(idx.length);
      const f = fitSlide(p, q, (this.ahead ? 1 : 1.6) / h, who, this.ahead);
      let on = 0;
      if (f) {
        for (let k = 0; k < idx.length; k++) {
          if (who[k]) {
            on++;
            if (key.drop[idx[k]]) key.drop[idx[k]]--;
          } else key.drop[idx[k]]++;
        }
        this.slide = slideAfter(key.base, f.slide);
        sure = Math.min(1, f.share * 1.4) * Math.min(1, on / 24);
      } else sure = 0;
      this.last = { pyr, to, ok, luma };
      const moved = f ? Math.hypot(f.slide.x, f.slide.y) : 1;
      const grown = f ? Math.abs(f.slide.scale - 1) : 1;
      if (!f || on < (this.ahead ? 10 : 18) || on < key.had * (this.ahead ? 0.2 : 0.5) || moved > 0.14 || grown > 0.07) this.newKey(pyr, luma, map ?? key.map);
    } else if (map) this.newKey(pyr, luma, map);

    if (this.mo) {
      const m = this.mo;
      // chained from frame to frame, then checked straight back to the frame with the map
      const to = Float32Array.from(m.to);
      follow(m.pyr, pyr, m.to, to, m.ok);
      m.to = to;
      m.pyr = pyr;
      if (map) {
        const start = this.moStart!;
        const back = Float32Array.from(m.from);
        const ok = Uint8Array.from(m.ok);
        follow(pyr, start, to, back, ok, 1);
        const xs: number[] = [], ys: number[] = [], dx: number[] = [], dy: number[] = [], near: number[] = [];
        for (let i = 0; i < ok.length; i++) {
          if (!ok[i] || Math.hypot(back[i * 2] - m.from[i * 2], back[i * 2 + 1] - m.from[i * 2 + 1]) > 1.2) continue;
          const x0 = fx(m.from[i * 2]), y0 = fy(m.from[i * 2 + 1]), x1 = fx(to[i * 2]), y1 = fy(to[i * 2 + 1]);
          // the nearness half way along, from both ends: an end on an edge that changed hands is thrown out
          const j = Math.round(to[i * 2 + 1]) * w + Math.round(to[i * 2]);
          const n0 = m.near[i];
          const n1 = map[j];
          if (!(Math.abs(n1 - n0) <= 0.25 * Math.max(n0, n1) + 1e-3)) continue;
          xs.push((x0 + x1) / 2);
          ys.push((y0 + y1) / 2);
          dx.push(x1 - x0);
          dy.push(y1 - y0);
          near.push((n0 + n1) / 2);
        }
        motion = fitMotion(xs, ys, dx, dy, near, this.focal, 1.5 / h);
      }
    }
    if (map) {
      const from = corners(luma, w, h, ALL);
      const near = new Float32Array(from.length >> 1);
      for (let i = 0; i < near.length; i++) near[i] = map[from[i * 2 + 1] * w + from[i * 2]];
      this.mo = { pyr, luma, from, to: Float32Array.from(from), ok: new Uint8Array(near.length).fill(1), near };
      this.moStart = pyr;
    }
    return { t, slide: this.slide, slideSure: sure, motion };
  }
  private moStart: Level[] | null = null;

  private newKey(pyr: Level[], luma: Float32Array, map: Float32Array) {
    const pts = this.far(map, luma);
    const n = pts.length >> 1;
    this.key = { pyr, pts, base: this.slide, drop: new Uint8Array(n), had: n, map };
    this.last = { pyr, to: Float32Array.from(pts), ok: new Uint8Array(n).fill(1), luma };
  }
}

/** brightness with its slow changes taken out: what is left is marks and texture */
export function texture(luma: ArrayLike<number>, w: number, h: number, r = 4): Float32Array {
  const a = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const o = y * w;
    for (let x = -r; x <= r; x++) s += luma[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      a[o + x] = s / (2 * r + 1);
      s += luma[o + Math.min(w - 1, x + r + 1)] - luma[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += a[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      b[y * w + x] = luma[y * w + x] - s / (2 * r + 1);
      s += a[Math.min(h - 1, y + r + 1) * w + x] - a[Math.max(0, y - r) * w + x];
    }
  }
  return b;
}

/** what groundSpeeds needs of one frame's ground: the marks on it (only the lower rows of the picture) */
export interface Marks {
  /** marks, -127..127 */
  d: Int8Array;
  w: number;
  /** rows kept, from the bottom */
  rows: number;
  /** the whole picture's height */
  h: number;
}

/**
 * How well each forward speed explains what the ground did between two frames: -1..1 for each of
 * `speeds`. Moving ahead by d carries a ground point z away straight out from the vanishing point,
 * z / (z - d) times as far. `pts`: the pixels of `a` that show bare ground. `va`, `vb`: the vanishing
 * point in each, frame heights. `fe`: focal length times eye height.
 */
export function groundSpeeds(a: Marks, b: Marks, pts: ArrayLike<number>, va: View3, vb: View3, fe: number, dt: number, speeds: ArrayLike<number>, most = 2500, out = new Float32Array(speeds.length)): Float32Array | null {
  const { w, h, rows } = a;
  const step = Math.max(1, Math.floor(pts.length / most));
  const n = Math.floor(pts.length / step);
  if (n < 120) return null;
  const cr = Math.cos(vb.roll - va.roll);
  const sr = Math.sin(vb.roll - va.roll);
  const tan = Math.tan(va.roll);
  for (let s = 0; s < speeds.length; s++) {
    const d = speeds[s] * dt;
    let ab = 0, aa = 0, bb = 0, used = 0;
    for (let k = 0; k < n; k++) {
      const i = pts[k * step];
      const px = ((i % w) + 0.5 - w / 2) / h - va.x;
      const py = (Math.floor(i / w) + 0.5 - h / 2) / h - va.y;
      const z = fe / (tan * px - py);
      if (!(z > 0) || z - d < 0.8) continue;
      const g = z / (z - d);
      const qx = (vb.x + (px * cr - py * sr) * g) * h + w / 2 - 0.5;
      const qy = (vb.y + (px * sr + py * cr) * g) * h + h / 2 - 0.5;
      const jx = Math.floor(qx);
      const jy = Math.floor(qy);
      if (jx < 0 || jy < 0 || jx >= w - 1 || jy >= rows - 1) continue;
      const ex = qx - jx;
      const ey = qy - jy;
      const j = jy * w + jx;
      const v = (b.d[j] * (1 - ex) + b.d[j + 1] * ex) * (1 - ey) + (b.d[j + w] * (1 - ex) + b.d[j + w + 1] * ex) * ey;
      const u = a.d[i];
      ab += u * v;
      aa += u * u;
      bb += v * v;
      used++;
    }
    out[s] = used > n * 0.25 ? ab / Math.sqrt(aa * bb + 1e-6) : -1;
  }
  return out;
}

/** a vanishing point and the horizon's tilt, frame heights */
export interface View3 {
  x: number;
  y: number;
  roll: number;
}
