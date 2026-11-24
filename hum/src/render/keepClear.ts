import type { KeepOut, Rect } from './legibility';

/**
 * Pop-up windows keep clear of the lyrics (popups.ts and sceneWindows.ts share this).
 *
 * The lyric layer lays the sung line out before any window draws and hands over its box, plus where
 * the next line will likely land (lyricLayer.keepOut()). Windows use it twice:
 *
 *   opening   a new window's place is scored against the line (heavily) and the next line (less),
 *             so it opens somewhere else when there's room
 *   gliding   a window already open where a line arrives eases out of the way: up, down or to the
 *             side, whichever is the shortest trip that clears the words and covers other windows
 *             least, on a critically damped spring (no jump, no overshoot). With no room for that
 *             (small phone frames, big words) it shrinks until there is, and where even a small one
 *             would still cover the words it shuts until they have gone: the words always win.
 *
 * A window that has moved stays where it went: nothing slides back when the line ends.
 */

/** a box in a layer's own pixels */
export interface PxBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** what a window carries to glide (fields on each layer's window) */
export interface Glide {
  /** where it's heading (top-left, px) */
  gx: number;
  gy: number;
  /** spring velocity (px/s) */
  vx: number;
  vy: number;
  /** size multiplier now and where it's heading (1, or a little smaller with no room to move) */
  fit: number;
  fitTo: number;
  /** the keep-out box it last planned around */
  keepKey: string;
}

export const newGlide = (x: number, y: number): Glide => ({ gx: x, gy: y, vx: 0, vy: 0, fit: 1, fitTo: 1, keepKey: '' });

/** the sizes a window tries when there's nowhere to go at its own; smaller than the last it isn't worth showing */
const FITS = [1, 0.84, 0.7, 0.58];
/** spring stiffness (1/s²): settles in about 0.4 s */
const K = 150;

export const overlap = (a: PxBox, b: PxBox) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** a normalized box in pixels of a W×H layer, grown by `pad` px each side */
export function toPx(r: Rect | null, W: number, H: number, pad = 0): PxBox | null {
  if (!r) return null;
  return { x: r.x0 * W - pad, y: r.y0 * H - pad, w: (r.x1 - r.x0) * W + pad * 2, h: (r.y1 - r.y0) * H + pad * 2 };
}

/** a pixel box as a normalized one */
export const toRect = (b: PxBox, W: number, H: number): Rect => ({ x0: b.x / W, y0: b.y / H, x1: (b.x + b.w) / W, y1: (b.y + b.h) / H });

/** extra cost for opening a window at box `b`: the line now weighs most, the next line less */
export function keepCost(b: PxBox, keep: KeepOut, W: number, H: number, pad: number): number {
  const now = toPx(keep.now, W, H, pad);
  const next = toPx(keep.next, W, H, pad);
  return (now ? overlap(b, now) * 12 : 0) + (next ? overlap(b, next) * 5 : 0);
}

/**
 * Plan where a w×h window at (x, y) should go to clear `keep` (px). Tries staying put, then the four
 * sides of the words (and the corners between them), each kept inside the frame's margin `m`; the
 * winner is the one that clears the words with the shortest trip and the least cover of `others`.
 */
export function dodge(x: number, y: number, w: number, h: number, keep: PxBox, W: number, H: number, m: number, others: PxBox[]): { x: number; y: number; clear: boolean } {
  const cx = (v: number) => Math.max(m, Math.min(W - w - m, v));
  const cy = (v: number) => Math.max(m, Math.min(H - h - m, v));
  const up = cy(keep.y - h);
  const down = cy(keep.y + keep.h);
  const left = cx(keep.x - w);
  const right = cx(keep.x + keep.w);
  const cands: [number, number][] = [
    [cx(x), up],
    [cx(x), down],
    [left, cy(y)],
    [right, cy(y)],
    [left, up],
    [right, up],
    [left, down],
    [right, down],
  ];
  const area = w * h;
  let best = { x, y, cost: Infinity, hit: Infinity };
  for (const [px, py] of cands) {
    const box = { x: px, y: py, w, h };
    const hit = overlap(box, keep);
    let cost = hit * 20 + Math.hypot(px - x, py - y) * Math.min(w, h) * 0.6;
    for (const o of others) cost += overlap(box, o) * 1.5;
    if (cost < best.cost) best = { x: px, y: py, cost, hit };
  }
  return { x: best.x, y: best.y, clear: best.hit < area * 0.02 };
}

/**
 * Step a window's glide: when a new box of words arrives, re-plan if the place it's heading would
 * cover them, then ease toward it. `pos` is the window's top-left (moved in place), `size` its w×h.
 * Returns true while it is still moving.
 */
export function glide(pos: { x: number; y: number }, g: Glide, w: number, h: number, keep: PxBox | null, W: number, H: number, m: number, others: PxBox[], dt: number): boolean {
  if (keep) {
    const key = `${Math.round(keep.x)},${Math.round(keep.y)},${Math.round(keep.w)},${Math.round(keep.h)}`;
    const goal = { x: g.gx, y: g.gy, w, h };
    // planned once per box of words (re-planning every frame would let the goal wander)
    if (key !== g.keepKey) {
      g.keepKey = key;
      if (overlap(goal, keep) > w * h * 0.02) {
        g.fitTo = 0;
        for (const f of FITS) {
          // (a smaller window stays centred in its own box)
          const dx = (w * (1 - f)) / 2;
          const dy = (h * (1 - f)) / 2;
          const d = dodge(g.gx + dx, g.gy + dy, w * f, h * f, keep, W, H, m, others);
          if (!d.clear) continue;
          g.gx = d.x - dx;
          g.gy = d.y - dy;
          g.fitTo = f;
          break;
        }
      } else g.fitTo = 1;
    }
  } else g.fitTo = 1;
  // a critically damped spring in small steps (frame-rate independent, no overshoot)
  const c = 2 * Math.sqrt(K);
  let left = Math.min(0.25, Math.max(0, dt));
  while (left > 1e-4) {
    const s = Math.min(left, 1 / 120);
    left -= s;
    g.vx += (K * (g.gx - pos.x) - c * g.vx) * s;
    g.vy += (K * (g.gy - pos.y) - c * g.vy) * s;
    pos.x += g.vx * s;
    pos.y += g.vy * s;
  }
  g.fit += (g.fitTo - g.fit) * (1 - Math.exp(-Math.max(0, dt) * 9));
  return Math.abs(g.gx - pos.x) + Math.abs(g.gy - pos.y) > 0.5 || Math.abs(g.fitTo - g.fit) > 0.005;
}
