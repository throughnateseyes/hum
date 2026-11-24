/**
 * The shape of the place a clip shows, worked out from its depth maps and its picture.
 *
 *   fitGround     the flat ground: on it nearness falls off in a straight line up the picture, and where
 *                 that line reaches nothing is the horizon
 *   findLines     straight edges in the picture
 *   vanishing     where the straight edges that run away from the camera meet, near a known horizon
 *   layersOf      nearness values with clear gaps round them
 *   focalFor      how long a lens a picture of this shape was most likely taken with
 *
 * Positions are in frame heights from the frame's centre: x to the right, y up (see types.ts). Maps and
 * brightness pictures are rows bottom to top. Pure functions: no canvas, no network, the same every run.
 */

/** the same every run */
export function dice(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** the main camera of a phone: a 16:9 frame is 1.25 frame heights of focal length, held either way round */
export function focalFor(aspect: number, photo: boolean): number {
  // a photo uses the whole sensor (4:3), a video a 16:9 cut across it; wider than 16:9 is that, cut again
  if (photo) return 0.75 * Math.max(1, aspect);
  if (aspect > 16 / 9) return (1.25 * aspect * 9) / 16;
  return 1.25 * Math.min(1, aspect);
}

/** nearness on the ground is a*x + b*y + c */
export interface Ground {
  a: number;
  b: number;
  c: number;
  /** the share of the picture's lower part (below the horizon) that lies on it */
  support: number;
  /** 0..1 */
  sure: number;
}

/** how far off the plane (as a share of the plane's nearness) still counts as on it */
const ON = 0.06;
/** ... and how far behind it is impossible: nothing can be seen through the ground */
const THROUGH = 0.12;

/** the ground's horizon: its height on the frame's centre line, and its tilt */
export const horizonOf = (g: { a: number; b: number; c: number }) => ({ y: -g.c / g.b, roll: Math.atan(-g.a / g.b) });

/** The ground in one or more maps (several maps of one place agree better than one). `before`: a ground found earlier, tried first. */
export function fitGround(maps: Float32Array[], w: number, h: number, before?: Ground | null): Ground | null {
  const aspect = w / h;
  const xs: number[] = [];
  const ys: number[] = [];
  const ds: number[] = [];
  let top = 0;
  const step = Math.max(2, Math.round(Math.sqrt((w * h * 0.65 * maps.length) / 5000)));
  for (const m of maps)
    for (let y = step >> 1; y < h * 0.65; y += step)
      for (let x = step >> 1; x < w; x += step) {
        const d = m[y * w + x];
        xs.push(((x + 0.5) / w - 0.5) * aspect);
        ys.push((y + 0.5) / h - 0.5);
        ds.push(d);
        if (d > top) top = d;
      }
  const n = xs.length;
  if (!(top > 0)) return null;
  const score = (a: number, b: number, c: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const p = a * xs[i] + b * ys[i] + c;
      if (p < top * 0.02) continue;
      const r = (ds[i] - p) / p;
      if (r > ON) continue;
      if (r > -ON) s += 1 - (r / ON) * (r / ON) * 0.5;
      else if (r < -THROUGH) s -= 1.2;
    }
    return s;
  };
  const sane = (a: number, b: number, c: number) => {
    if (!(b < 0)) return false;
    const y = -c / b;
    return Math.abs(a / b) < 0.36 && y > -0.42 && y < 1.1;
  };
  const rand = dice(7);
  const each = n / maps.length;
  let best: [number, number, number] | null = null;
  let bestS = n * 0.02;
  if (before) {
    const s = score(before.a, before.b, before.c);
    if (s > bestS) {
      bestS = s * 1.02;
      best = [before.a, before.b, before.c];
    }
  }
  // the bottom of the picture is where ground is likeliest: two of the three points come from there
  for (let k = 0; k < 500; k++) {
    const i = Math.floor(rand() * maps.length) * each + Math.floor(rand() * each * 0.5);
    const j = Math.floor(rand() * maps.length) * each + Math.floor(rand() * each * 0.5);
    const l = Math.floor(rand() * n);
    const x1 = xs[j] - xs[i];
    const y1 = ys[j] - ys[i];
    const d1 = ds[j] - ds[i];
    const x2 = xs[l] - xs[i];
    const y2 = ys[l] - ys[i];
    const d2 = ds[l] - ds[i];
    const det = x1 * y2 - x2 * y1;
    if (Math.abs(det) < 0.01) continue;
    const a = (d1 * y2 - d2 * y1) / det;
    const b = (x1 * d2 - x2 * d1) / det;
    const c = ds[i] - a * xs[i] - b * ys[i];
    if (!sane(a, b, c)) continue;
    const s = score(a, b, c);
    if (s > bestS) {
      bestS = s;
      best = [a, b, c];
    }
  }
  if (!best) return null;
  // settle it on everything that lies on it
  let [a, b, c] = best;
  for (let pass = 0; pass < 6; pass++) {
    const on = ON * (pass < 2 ? 1.3 : 1);
    let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, s1 = 0, sxd = 0, syd = 0, sd = 0;
    for (let i = 0; i < n; i++) {
      const p = a * xs[i] + b * ys[i] + c;
      if (p < top * 0.02) continue;
      const r = (ds[i] - p) / p / on;
      if (r * r >= 1) continue;
      // off by a share counts the same near and far, but not so much that the far end decides alone
      const k = ((1 - r * r) ** 2) / (p + top * 0.1) ** 2;
      const x = xs[i], y = ys[i], d = ds[i];
      sxx += k * x * x; sxy += k * x * y; sx += k * x; syy += k * y * y; sy += k * y; s1 += k;
      sxd += k * x * d; syd += k * y * d; sd += k * d;
    }
    const sol = solve([[sxx + 1e-9, sxy, sx], [sxy, syy, sy], [sx, sy, s1]], [sxd, syd, sd]);
    if (!sol || !sane(sol[0], sol[1], sol[2])) break;
    [a, b, c] = sol;
  }
  let on = 0;
  let under = 0;
  let below = 0;
  let lowY = 9;
  let highY = -9;
  const rows = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const p = a * xs[i] + b * ys[i] + c;
    if (p < top * 0.02) continue;
    below++;
    const r = (ds[i] - p) / p;
    if (Math.abs(r) < ON) {
      on++;
      rows.set(ys[i], (rows.get(ys[i]) ?? 0) + 1);
    } else if (r < -THROUGH) under++;
  }
  const wide = (w / step) * maps.length;
  for (const [y, k] of rows)
    if (k > wide * 0.08) {
      lowY = Math.min(lowY, y);
      highY = Math.max(highY, y);
    }
  const support = below ? on / below : 0;
  // a believable ground covers a fair part of what is below the horizon, over a fair height, and nothing shows through it
  const tall = Math.max(0, highY - lowY);
  const ramp = (x: number, lo: number, hi: number) => Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  const sure = ramp(support, 0.12, 0.4) * ramp(tall, 0.04, 0.14) * (1 - ramp(below ? under / below : 1, 0.04, 0.25)) * ramp(below / n, 0.03, 0.12);
  return { a, b, c, support, sure };
}

/** solve a small set of linear equations */
export function solve(m: number[][], r: number[]): number[] | null {
  const n = r.length;
  const a = m.map((row, i) => [...row, r[i]]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(a[j][i]) > Math.abs(a[p][i])) p = j;
    if (Math.abs(a[p][i]) < 1e-14) return null;
    [a[i], a[p]] = [a[p], a[i]];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const k = a[j][i] / a[i][i];
      if (k) for (let c = i; c <= n; c++) a[j][c] -= k * a[i][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

/** a straight edge, its middle, its direction and its length, in frame heights */
export interface Line {
  x: number;
  y: number;
  dx: number;
  dy: number;
  len: number;
}

/** Straight edges: neighbouring pixels whose edges point the same way, grown into runs */
export function findLines(luma: ArrayLike<number>, w: number, h: number): Line[] {
  const ang = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  const order: number[] = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = luma[i + 1 - w] + 2 * luma[i + 1] + luma[i + 1 + w] - luma[i - 1 - w] - 2 * luma[i - 1] - luma[i - 1 + w];
      const gy = luma[i + w - 1] + 2 * luma[i + w] + luma[i + w + 1] - luma[i - w - 1] - 2 * luma[i - w] - luma[i - w + 1];
      const m = Math.hypot(gx, gy);
      if (m < 36) continue;
      mag[i] = m;
      ang[i] = Math.atan2(gy, gx);
      order.push(i);
    }
  // strongest first
  order.sort((p, q) => mag[q] - mag[p]);
  const used = new Uint8Array(w * h);
  const out: Line[] = [];
  const run: number[] = [];
  for (const s of order) {
    if (used[s]) continue;
    run.length = 0;
    run.push(s);
    used[s] = 1;
    let cx = Math.cos(ang[s]);
    let cy = Math.sin(ang[s]);
    for (let k = 0; k < run.length; k++) {
      const i = run[k];
      const l = Math.hypot(cx, cy);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const j = i + dy * w + dx;
          if (used[j] || !mag[j]) continue;
          // the same way, within a sixteenth of a turn
          const ex = Math.cos(ang[j]);
          const ey = Math.sin(ang[j]);
          if ((ex * cx + ey * cy) / l < 0.92) continue;
          used[j] = 1;
          run.push(j);
          cx += ex;
          cy += ey;
        }
    }
    if (run.length < 14) continue;
    let sm = 0, mx = 0, my = 0;
    for (const i of run) {
      const m = mag[i];
      sm += m;
      mx += m * (i % w);
      my += m * Math.floor(i / w);
    }
    mx /= sm;
    my /= sm;
    let xx = 0, xy = 0, yy = 0;
    for (const i of run) {
      const m = mag[i];
      const px = (i % w) - mx;
      const py = Math.floor(i / w) - my;
      xx += m * px * px;
      xy += m * px * py;
      yy += m * py * py;
    }
    const t = 0.5 * Math.atan2(2 * xy, xx - yy);
    const dx = Math.cos(t);
    const dy = Math.sin(t);
    let lo = Infinity, hi = -Infinity, wide = 0;
    for (const i of run) {
      const px = (i % w) - mx;
      const py = Math.floor(i / w) - my;
      const u = px * dx + py * dy;
      lo = Math.min(lo, u);
      hi = Math.max(hi, u);
      wide += Math.abs(-px * dy + py * dx);
    }
    wide = (wide / run.length) * 4;
    const len = hi - lo;
    if (len < 12 || len < wide * 4) continue;
    const mid = (lo + hi) / 2;
    out.push({ x: (mx + mid * dx + 0.5 - w / 2) / h, y: (my + mid * dy + 0.5 - h / 2) / h, dx, dy, len: len / h });
  }
  return out;
}

/**
 * Where the lines that run away from the camera meet, looked for along the horizon and a little above
 * and below it. Uprights and lines along the horizon say nothing about it, so they don't vote.
 */
export function vanishing(lines: Line[], aspect: number, horizon: { y: number; roll: number }, give = 0.05): { x: number; y: number; sure: number } | null {
  const ux = Math.cos(horizon.roll);
  const uy = Math.sin(horizon.roll);
  const votes = lines.filter((l) => {
    const along = Math.abs(l.dx * ux + l.dy * uy);
    // (an upright on the road straight ahead is a lane line, and those do vote)
    const below = l.y - horizon.y - Math.tan(horizon.roll) * l.x < -0.06;
    return along < 0.995 && (along > (below ? 0.04 : 0.1)) && Math.abs(l.y - horizon.y) > 0.015;
  });
  if (votes.length < 4) return null;
  const at = (x: number, y: number) => {
    let s = 0;
    for (const l of votes) {
      const vx = x - l.x;
      const vy = y - l.y;
      const d = Math.hypot(vx, vy);
      if (d < l.len * 0.5) continue;
      const off = Math.abs(vx * l.dy - vy * l.dx) / d;
      // how well a line this short can be aimed
      const sig = Math.max(0.012, 0.004 / l.len);
      if (off < sig * 3) s += Math.min(0.25, l.len) * Math.exp((-off * off) / (2 * sig * sig));
    }
    return s;
  };
  let best = -1;
  let bx = 0;
  let by = 0;
  let sum = 0;
  let n = 0;
  for (let x = -0.9 * aspect; x <= 0.9 * aspect; x += 0.015)
    for (let o = -give; o <= give + 1e-9; o += give > 0 ? give / 4 : 1) {
      const px = x;
      const py = horizon.y + Math.tan(horizon.roll) * x + o;
      // a place outside the frame, or off the horizon, has to be better
      const s = at(px, py) * (Math.abs(x) > aspect / 2 ? 0.8 : 1) * Math.exp(give > 0 ? -0.5 * (o / give) ** 2 : 0);
      sum += s;
      n++;
      if (s > best) {
        best = s;
        bx = px;
        by = py;
      }
      if (give <= 0) break;
    }
  for (const st of [0.007, 0.0035]) {
    let go = true;
    while (go) {
      go = false;
      for (const [dx, dy] of [[st, 0], [-st, 0], [0, st], [0, -st]]) {
        if (dy && Math.abs(by + dy - horizon.y - Math.tan(horizon.roll) * bx) > give) continue;
        const s = at(bx + dx, by + dy);
        if (s > best * 1.0005) {
          best = s;
          bx += dx;
          by += dy;
          go = true;
        }
      }
    }
  }
  const mean = sum / Math.max(1, n);
  const peak = best / Math.max(1e-6, mean);
  return { x: bx, y: by, sure: Math.min(1, Math.max(0, (peak - 2) / 4)) * Math.min(1, best / 1.2) };
}

/** Up to three nearness bytes in the clear gaps of how often each byte turns up (256 counts, sky left out), far to near */
export function layersOf(counts: ArrayLike<number>): number[] {
  let h = new Float64Array(256);
  let total = 0;
  for (let i = 4; i < 256; i++) {
    h[i] = counts[i];
    total += counts[i];
  }
  if (!total) return [];
  for (let pass = 0; pass < 3; pass++) {
    const s = new Float64Array(256);
    for (let i = 0; i < 256; i++) {
      let a = 0;
      for (let k = -4; k <= 4; k++) a += h[Math.min(255, Math.max(0, i + k))];
      s[i] = a / 9;
    }
    h = s;
  }
  const gaps: { at: number; worth: number }[] = [];
  for (let i = 8; i < 248; i++) {
    if (!(h[i] <= h[i - 1] && h[i] < h[i + 1])) continue;
    let l = 0;
    let r = 0;
    let before = 0;
    let after = 0;
    for (let k = 0; k < i; k++) {
      l = Math.max(l, h[k]);
      before += h[k];
    }
    for (let k = i + 1; k < 256; k++) {
      r = Math.max(r, h[k]);
      after += h[k];
    }
    // a gap worth cutting at: much emptier than the heaps either side, with a fair part of the picture on both sides
    const small = Math.min(before, after) / total;
    const depth = 1 - h[i] / Math.max(1e-9, Math.min(l, r));
    if (small > 0.03 && depth > 0.35) gaps.push({ at: i, worth: depth * Math.min(0.2, small) });
  }
  gaps.sort((p, q) => q.worth - p.worth);
  const keep: number[] = [];
  for (const g of gaps) if (keep.length < 3 && keep.every((k) => Math.abs(k - g.at) > 22)) keep.push(g.at);
  return keep.sort((p, q) => p - q);
}

/**
 * With no ground to be seen but a crowd along the bottom: seen from among them, everyone's head is at
 * the horizon, near or far. Answers with where the crowd stops, or null when nothing like that is there.
 */
export function headLine(map: Float32Array, w: number, h: number): number | null {
  // how near each row is on the whole
  const rows: number[] = [];
  const row: number[] = [];
  for (let y = 0; y < Math.floor(h * 0.6); y++) {
    row.length = 0;
    for (let x = 0; x < w; x++) row.push(map[y * w + x]);
    row.sort((a, b) => a - b);
    rows.push(row[w >> 1]);
  }
  const reach = Math.max(2, Math.round(h * 0.06));
  let best = 0;
  let at = -1;
  for (let y = Math.round(h * 0.05); y < rows.length - reach; y++) {
    let below = 0;
    let above = 0;
    for (let k = 0; k < reach; k++) {
      below += rows[Math.max(0, y - 1 - k)];
      above += rows[y + k];
    }
    // the crowd goes all the way down: nothing under the line is as far as what is over it
    let least = Infinity;
    for (let k = 0; k < y - 1; k++) least = Math.min(least, rows[k]);
    if (least < (above / reach) * 1.15) continue;
    const step = below / Math.max(1e-4, above);
    if (step > best) {
      best = step;
      at = y;
    }
  }
  return best > 1.45 ? at / h - 0.5 : null;
}
