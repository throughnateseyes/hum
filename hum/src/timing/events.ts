/**
 * What happens in a clip, worked out from its frames.
 *
 *   stepOf       two frames a moment apart → how the camera went, how much else moved, where and which way
 *   findEvents   the steps of a whole clip → the moments a cut could land on
 *   pinPoint     frames close together round a moment → the exact second of it
 *
 * Pictures are brightness, 0..255, rows bottom to top (depth/frames.ts). Pure: the same every run.
 */
import { corners, fitSlide, followBothWays, NO_SLIDE, pyramid, unslid } from '../depth/track';
import type { ClipEvent, EventKind } from './types';

/** the grid movement is located on */
const GX = 16;
const GY = 9;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export interface Frame {
  t: number;
  w: number;
  h: number;
  levels: ReturnType<typeof pyramid>;
  mean: number;
}

export function frameOf(luma: Float32Array, w: number, h: number, t: number): Frame {
  // half the size is plenty for seeing what moved, and follows bigger movements
  const all = pyramid(luma, w, h, 5);
  const levels = all.length > 2 ? all.slice(1) : all;
  const s = levels[levels.length - 1].d;
  let m = 0;
  for (let i = 0; i < s.length; i++) m += s[i];
  return { t, w: levels[0].w, h: levels[0].h, levels, mean: m / s.length };
}

export interface Step {
  /** the middle of it, and how long */
  t: number;
  dt: number;
  act: number;
  camX: number;
  camY: number;
  push: number;
  goX: number;
  goY: number;
  x: number;
  y: number;
  bright: number;
  /** brightness gained, 0..1 of full, per step */
  lit: number;
  /** 0..1: how likely it is that the picture was replaced altogether */
  torn: number;
}

export function stepOf(a: Frame, b: Frame): Step {
  const { w, h } = a;
  const dt = Math.max(1e-3, b.t - a.t);
  const from = corners(a.levels[0].d, w, h, 150);
  const to = Float32Array.from(from);
  const ok = new Uint8Array(from.length >> 1).fill(1);
  followBothWays(a.levels, b.levels, from, to, ok, 99, 0.8);
  const p: number[] = [];
  const q: number[] = [];
  for (let i = 0; i < ok.length; i++) {
    if (!ok[i]) continue;
    p.push((from[i * 2] + 0.5 - w / 2) / h, (from[i * 2 + 1] + 0.5 - h / 2) / h);
    q.push((to[i * 2] + 0.5 - w / 2) / h, (to[i * 2 + 1] + 0.5 - h / 2) / h);
  }
  const fit = p.length >= 24 ? fitSlide(p, q, 0.011) : null;
  const held = fit && fit.share > 0.3 ? fit.slide : NO_SLIDE;
  const found = ok.length ? p.length / 2 / ok.length : 1;

  // points that went their own way
  let gx = 0, gy = 0, gn = 0;
  for (let i = 0; i < p.length; i += 2) {
    const c = Math.cos(held.turn) * held.scale;
    const s = Math.sin(held.turn) * held.scale;
    const dx = q[i] - (c * p[i] - s * p[i + 1] + held.x);
    const dy = q[i + 1] - (s * p[i] + c * p[i + 1] + held.y);
    if (dx * dx + dy * dy < 0.012 * 0.012) continue;
    gx += dx;
    gy += dy;
    gn++;
  }

  // what is left over once the camera's own movement is taken out, a size smaller
  const l = Math.min(1, a.levels.length - 1);
  const A = a.levels[l];
  const B = b.levels[l];
  const gain = Math.min(1.6, Math.max(0.62, (b.mean + 4) / (a.mean + 4)));
  const cell = new Float32Array(GX * GY);
  const n = new Float32Array(GX * GY);
  let raw = 0;
  let seen = 0;
  for (let y = 2; y < B.h - 2; y++)
    for (let x = 2; x < B.w - 2; x++) {
      const [ux, uy] = unslid(held, (x + 0.5 - B.w / 2) / B.h, (y + 0.5 - B.h / 2) / B.h);
      const sx = ux * B.h + B.w / 2 - 0.5;
      const sy = uy * B.h + B.h / 2 - 0.5;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      if (ix < 1 || iy < 1 || ix >= A.w - 2 || iy >= A.h - 2) continue;
      const fx = sx - ix;
      const fy = sy - iy;
      const o = iy * A.w + ix;
      const v = (A.d[o] * (1 - fx) + A.d[o + 1] * fx) * (1 - fy) + (A.d[o + A.w] * (1 - fx) + A.d[o + A.w + 1] * fx) * fy;
      const bo = y * B.w + x;
      const d = Math.abs(B.d[bo] - v * gain);
      // a strong edge a hair off its place is not movement
      const edge = Math.abs(A.d[o + 1] - A.d[o - 1]) + Math.abs(A.d[o + A.w] - A.d[o - A.w]);
      const c = Math.min(GY - 1, Math.floor((y / B.h) * GY)) * GX + Math.min(GX - 1, Math.floor((x / B.w) * GX));
      cell[c] += Math.max(0, d - 3 - edge * 0.16);
      n[c]++;
      raw += d;
      seen++;
    }
  let sum = 0, cx = 0, cy = 0;
  const vals: number[] = [];
  for (let c = 0; c < cell.length; c++) {
    const v = n[c] ? cell[c] / n[c] : 0;
    cell[c] = v;
    vals.push(v);
  }
  vals.sort((x, y) => y - x);
  const mid = vals[vals.length >> 1];
  for (let c = 0; c < cell.length; c++) {
    const v = Math.max(0, cell[c] - mid * 1.5) ** 1.5;
    sum += v;
    cx += v * (((c % GX) + 0.5) / GX);
    cy += v * ((Math.floor(c / GX) + 0.5) / GY);
  }
  const top = vals.slice(0, Math.max(3, Math.round(vals.length * 0.14)));
  const move = top.reduce((s, v) => s + v, 0) / top.length;
  const diff = seen ? raw / seen : 0;
  return {
    t: (a.t + b.t) / 2,
    dt,
    act: 1 - Math.exp(-move / 16),
    camX: held.x / dt,
    camY: held.y / dt,
    push: (held.scale - 1) / dt,
    goX: gn > 4 ? gx / gn / dt : 0,
    goY: gn > 4 ? gy / gn / dt : 0,
    x: sum > 1e-3 ? cx / sum : 0.5,
    y: sum > 1e-3 ? cy / sum : 0.5,
    bright: b.mean / 255,
    lit: (b.mean - a.mean) / 255,
    torn: clamp01((0.34 - found) / 0.26) * clamp01((diff - 9) / 16) * (fit && fit.share > 0.5 && found > 0.2 ? 0.3 : 1),
  };
}

const at = (xs: number[], p: number) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] : 0;
};

/** each step with its neighbours' say in it */
const soft = (xs: number[], r: number) =>
  xs.map((_, i) => {
    let s = 0, w = 0;
    for (let k = -r; k <= r; k++) {
      if (i + k < 0 || i + k >= xs.length) continue;
      const g = 1 - Math.abs(k) / (r + 1);
      s += xs[i + k] * g;
      w += g;
    }
    return s / w;
  });

/** how fast the camera goes, all its movements as one number (frame heights a second) */
export const camOf = (s: Pick<Step, 'camX' | 'camY' | 'push'>) => Math.hypot(s.camX, s.camY) + Math.abs(s.push) * 0.6;

export function findEvents(steps: Step[], duration: number): ClipEvent[] {
  const out: ClipEvent[] = [];
  const n = steps.length;
  if (n < 5) return out;
  const dt = duration / n;
  // how many steps make a third of a second: what comes before is held against what comes after
  const r = Math.max(1, Math.round(0.32 / dt));
  const put = (i: number, kind: EventKind, of: ClipEvent['of'], strength: number) => {
    const s = steps[i];
    if (s.t < 0.25 || s.t > duration - 0.3 || strength < 0.15) return;
    out.push({ at: s.t, kind, of, strength: clamp01(strength), x: of === 'camera' ? 0.5 : s.x, y: of === 'camera' ? 0.5 : s.y });
  };
  steps.forEach((s, i) => {
    if (s.torn > 0.45 && s.torn >= (steps[i - 1]?.torn ?? 0) && s.torn > (steps[i + 1]?.torn ?? 0)) put(i, 'cut', 'camera', s.torn);
  });
  const torn = (i: number) => steps.slice(Math.max(0, i - 1), i + 2).some((s) => s.torn > 0.45);
  // across a cut of its own nothing is compared
  const calm = steps.map((s, i) => (torn(i) ? { ...s, act: 0, camX: 0, camY: 0, push: 0 } : s));

  for (const of of ['subject', 'camera'] as const) {
    const raw = calm.map((s) => (of === 'subject' ? s.act : Math.min(1.5, camOf(s))));
    const c = soft(raw, 1);
    const lo = at(c, 0.15);
    const hi = at(c, 0.95);
    // a clip that never changes pace has nothing to land on, however much of it moves
    const span = Math.max(of === 'subject' ? 0.16 : 0.22, hi - lo);
    const mean = (i0: number, i1: number) => {
      let s = 0, k = 0;
      for (let i = Math.max(0, i0); i <= Math.min(n - 1, i1); i++) {
        s += c[i];
        k++;
      }
      return k ? s / k : 0;
    };
    const weight = of === 'subject' ? 1 : 0.7;
    // a small change counts for less than its share of a steady clip's small range
    const strong = (d: number) => d * Math.sqrt(clamp01(d / 0.35));
    const falls = c.map((_, i) => mean(i - r, i - 1) - mean(i + 1, i + r));
    for (let i = 1; i < n - 1; i++) {
      const before = Math.min(...c.slice(Math.max(0, i - 2 * r), i + 1));
      const after = Math.min(...c.slice(i, i + 2 * r + 1));
      let top = true;
      for (let k = -r; k <= r; k++) if (c[i + k] !== undefined && (c[i + k] > c[i] || (c[i + k] === c[i] && k < 0))) top = false;
      if (top) put(i, 'peak', of, (weight * strong(c[i] - Math.max(before, after))) / span);
      let fall = true, rise = true;
      for (let k = -r; k <= r; k++) {
        const f = falls[i + k];
        if (f === undefined || !k) continue;
        if (f > falls[i] || (f === falls[i] && k < 0)) fall = false;
        if (f < falls[i] || (f === falls[i] && k < 0)) rise = false;
      }
      if (torn(i)) continue;
      if (fall && falls[i] > 0) put(i, 'stop', of, (weight * 1.1 * strong(falls[i])) / span);
      if (rise && falls[i] < 0) put(i, 'start', of, (weight * 0.8 * strong(-falls[i])) / span);
    }
    // what moves turns back
    const gx = soft(calm.map((s) => (of === 'subject' ? s.goX : s.camX)), 1);
    const gy = soft(calm.map((s) => (of === 'subject' ? s.goY : s.camY)), 1);
    let best = -1;
    for (let i = r; i < n - r; i++) {
      let ax = 0, ay = 0, bx = 0, by = 0;
      for (let k = 1; k <= r; k++) {
        ax += gx[i - k] / r;
        ay += gy[i - k] / r;
        bx += gx[i + k] / r;
        by += gy[i + k] / r;
      }
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      const back = la > 0.16 && lb > 0.16 ? -(ax * bx + ay * by) / (la * lb) : 0;
      const s = back > 0.3 ? back * clamp01(Math.min(la, lb) / 0.7) * (of === 'subject' ? 0.8 : 0.6) : 0;
      if (s > 0 && s > best) {
        best = s;
        put(i, 'turn', of, s);
        // the best of one run of them is kept
        const was = out.findIndex((e, k) => k < out.length - 1 && e.kind === 'turn' && e.of === of && Math.abs(e.at - steps[i].t) < 0.6);
        if (was >= 0 && out[out.length - 1].at === steps[i].t) out.splice(was, 1);
      } else if (!s) best = -1;
    }
  }
  steps.forEach((s, i) => {
    if (torn(i)) return;
    const gain = Math.abs(s.lit);
    if (gain > 0.06 && gain >= Math.abs(steps[i - 1]?.lit ?? 0) && gain > Math.abs(steps[i + 1]?.lit ?? 0)) put(i, 'flash', 'subject', gain / 0.22);
  });

  // one moment, one event: the strongest of those that fall together (a cut is always kept)
  const keep: ClipEvent[] = [];
  for (const e of [...out].sort((x, y) => (y.kind === 'cut' ? 2 : y.strength) - (x.kind === 'cut' ? 2 : x.strength) || x.at - y.at)) {
    if (keep.some((k) => Math.abs(k.at - e.at) < 0.34)) continue;
    keep.push(e);
    if (keep.filter((k) => k.kind !== 'cut').length >= 10) break;
  }
  return keep.sort((x, y) => x.at - y.at);
}

/** the exact second of an event, from steps a frame or two apart round it */
export function pinPoint(e: ClipEvent, steps: Step[]): number {
  if (steps.length < 4) return e.at;
  const c = soft(steps.map((s) => (e.of === 'subject' ? s.act : camOf(s))), 1);
  let i = -1;
  if (e.kind === 'cut') i = steps.reduce((b, s, k) => (s.torn > steps[b].torn ? k : b), 0);
  else if (e.kind === 'flash') i = steps.reduce((b, s, k) => (Math.abs(s.lit) > Math.abs(steps[b].lit) ? k : b), 0);
  else if (e.kind === 'peak') i = c.reduce((b, v, k) => (v > c[b] ? k : b), 0);
  else if (e.kind === 'turn') {
    // where it is slowest in between
    const sp = soft(steps.map((s) => (e.of === 'subject' ? Math.hypot(s.goX, s.goY) : Math.hypot(s.camX, s.camY))), 1);
    i = sp.reduce((b, v, k) => (v < sp[b] ? k : b), 0);
  } else {
    // a stop is where it has nearly ended, a start where it has barely begun
    const hi = Math.max(...c);
    const lo = Math.min(...c);
    const line = lo + (hi - lo) * 0.4;
    for (let k = 1; k < c.length; k++)
      if (e.kind === 'stop' ? c[k - 1] > line && c[k] <= line : c[k - 1] <= line && c[k] > line) {
        i = k;
        if (e.kind === 'start') break;
      }
  }
  return i < 0 ? e.at : steps[i].t;
}
