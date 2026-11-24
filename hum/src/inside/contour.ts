/** The outline of what is near in a depth map: where its nearness crosses `level`, as paths in the clip's frame (0..1) */
export type Path = [number, number][];

/** every other point of the map is enough for an outline, and keeps it smooth */
const SKIP = 2;

export function outline(map: Uint8Array, w: number, h: number, level: number, least = 24, most = 6): Path[] {
  const W = Math.floor(w / SKIP);
  const H = Math.floor(h / SKIP);
  // softened a little, so the outline doesn't shiver
  const v = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const px = x * SKIP + dx * SKIP;
          const py = y * SKIP + dy * SKIP;
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          s += map[py * w + px];
          n++;
        }
      const b = s / n / 255;
      v[y * W + x] = b * b;
    }
  const at = (x: number, y: number) => v[y * W + x] - level;
  const cut = (a: number, b: number) => a / (a - b || 1e-9);
  // each cell the level runs through gives one step or two; steps are joined by the cell edges they share
  const next = new Map<number, { to: number; p: [number, number] }[]>();
  const edge = (x: number, y: number, up: boolean) => (y * W + x) * 2 + (up ? 1 : 0);
  const spot = new Map<number, [number, number]>();
  const link = (a: number, b: number) => {
    for (const [p, q] of [
      [a, b],
      [b, a],
    ]) {
      const l = next.get(p) ?? [];
      l.push({ to: q, p: spot.get(q)! });
      next.set(p, l);
    }
  };
  for (let y = 0; y < H - 1; y++)
    for (let x = 0; x < W - 1; x++) {
      const c = [at(x, y), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1)];
      const on = c.map((k) => k > 0);
      if (on.every((k) => k === on[0])) continue;
      const es: number[] = [];
      const add = (id: number, px: number, py: number) => {
        spot.set(id, [((px + 0.5) * SKIP) / w, ((py + 0.5) * SKIP) / h]);
        es.push(id);
      };
      if (on[0] !== on[1]) add(edge(x, y, false), x + cut(c[0], c[1]), y);
      if (on[1] !== on[2]) add(edge(x + 1, y, true), x + 1, y + cut(c[1], c[2]));
      if (on[2] !== on[3]) add(edge(x, y + 1, false), x + 1 - cut(c[2], c[3]), y + 1);
      if (on[3] !== on[0]) add(edge(x, y, true), x, y + 1 - cut(c[3], c[0]));
      if (es.length === 2) link(es[0], es[1]);
      else if (es.length === 4) {
        link(es[0], es[1]);
        link(es[2], es[3]);
      }
    }
  const used = new Set<number>();
  const paths: Path[] = [];
  const walk = (from: number) => {
    const p: Path = [];
    let k = from;
    for (;;) {
      used.add(k);
      p.push(spot.get(k)!);
      const n = next.get(k)!.find((e) => !used.has(e.to));
      if (!n) return p;
      k = n.to;
    }
  };
  // open runs (they leave the frame) from an end, then the closed ones
  for (const [k, l] of next) if (l.length === 1 && !used.has(k)) paths.push(walk(k));
  for (const k of next.keys()) if (!used.has(k)) paths.push(walk(k));
  return paths
    .filter((p) => p.length > least)
    .sort((a, b) => b.length - a.length)
    .slice(0, most)
    .map((p) => {
      const out: Path = [];
      for (let i = 0; i < p.length; i += 2) {
        const a = p[Math.max(0, i - 2)];
        const b = p[i];
        const c = p[Math.min(p.length - 1, i + 2)];
        out.push([a[0] * 0.25 + b[0] * 0.5 + c[0] * 0.25, a[1] * 0.25 + b[1] * 0.5 + c[1] * 0.25]);
      }
      return out;
    });
}
