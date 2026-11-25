/**
 * Where in a shot a form can go: who or what stands in it (the person in the middle, not the post at the
 * edge), how far off the open end of the place is, and which columns of the picture have room to stand in.
 * Read from the depth map at one clip second, in frame fractions from the bottom-left.
 */
import type { ClipScene } from '../depth/types';
import { groundNear } from './pass';
import { mapAt, nearnessAt, type Crop, type Lens } from './place';

export interface Body {
  /** the box round it, in the frame */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** how far off, metres */
  w: number;
}
export interface Spot {
  body: Body | null;
  /** how far off most of what is not standing close by is */
  open: number;
  /** nearness at a frame point, 0 unknown */
  near: (fx: number, fy: number) => number;
}
const GW = 96;
const GH = 54;

export function spotAt(s: ClipScene | null, l: Lens, clip: number, crop: Crop, cut: number): Spot {
  const map = s ? mapAt(s, clip) : null;
  if (!s || !map) return { body: null, open: 20, near: () => 0 };
  const near = (fx: number, fy: number) => nearnessAt(s, map, crop, fx, fy);
  const n = new Float32Array(GW * GH);
  const up = new Uint8Array(GW * GH);
  const rest: number[] = [];
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const fx = (i + 0.5) / GW;
      const fy = (j + 0.5) / GH;
      const v = near(fx, fy);
      const g = Math.max(0, groundNear(l, fx, fy, s.zScale));
      n[j * GW + i] = v;
      up[j * GW + i] = v > cut && v > g * 1.14 ? 1 : 0;
      if (!up[j * GW + i] && v > 0.0006 && v > g * 1.14) rest.push(v);
    }
  }
  // what hangs together at about one distance
  const seen = new Uint8Array(GW * GH);
  let best: Body | null = null;
  let most = 0;
  for (let k = 0; k < GW * GH; k++) {
    if (!up[k] || seen[k]) continue;
    const stack = [k];
    seen[k] = 1;
    let [x0, x1, y0, y1, area, sum, edge, side] = [GW, 0, GH, 0, 0, 0, 0, 0];
    while (stack.length) {
      const c = stack.pop()!;
      const i = c % GW;
      const j = (c - i) / GW;
      area++;
      sum += n[c];
      if (j === GH - 1) edge++;
      if (i === 0 || i === GW - 1) side++;
      x0 = Math.min(x0, i);
      x1 = Math.max(x1, i);
      y0 = Math.min(y0, j);
      y1 = Math.max(y1, j);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= GW || b >= GH) continue;
        const d = b * GW + a;
        if (seen[d] || !up[d] || Math.abs(n[d] / n[c] - 1) > 0.16) continue;
        seen[d] = 1;
        stack.push(d);
      }
    }
    const mid = (x0 + x1 + 1) / 2 / GW;
    const high = (y1 + 1 - y0) / GH;
    const mean = sum / area;
    // nearest first: the person crossing, not the crowd behind; never a post or a wall running out of the frame
    const score = Math.sqrt(area) * mean ** 1.2 * Math.max(0.1, 1 - Math.abs(mid - 0.5) * 1.6);
    const person = area > 14 && edge < 1 && high > 0.1 && high < 0.85 && (x1 - x0) / GW < high * 1.6;
    if (person && area > 40 && side < 3 && high > 0.15 && high < 0.85 && x1 - x0 < GW * 0.55 && score > most) {
      most = score;
      best = { x0: x0 / GW, x1: (x1 + 1) / GW, y0: y0 / GH, y1: (y1 + 1) / GH, w: s.zScale / (sum / area) };
    }
  }
  rest.sort((a, b) => a - b);
  const open = rest.length ? s.zScale / rest[Math.floor(rest.length * 0.5)] : 30;
  return { body: best, open: Math.min(80, Math.max(6, open)), near };
}
