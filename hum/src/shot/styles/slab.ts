/**
 * Slab: the footage full frame, and one enormous flat shape in the accent that crops it from an edge.
 *
 * The shape, by the shot's layout number:
 *   block   a rectangle from one edge of the frame to a grid line about two fifths of the way in; each bar
 *           it slides across to stand on the opposite edge. The bar count is set big in it, with the
 *           song's title small on the margin.
 *   disc    a circle wider than the frame's short side, its centre on a corner; each bar it rolls to
 *           the next corner. The song's title small on the margin.
 *
 *   arrives   slides in from off the frame within 0.2 s
 *   the beat  one slide per bar, then still
 *   hands over  in the last beat it grows to cover the frame, so the cut is a wipe in the accent
 */
import * as THREE from 'three';
import { arrival, barStep, Flat, handOver, lerp, settling, type StyleFactory } from '../kit';
import { DISPLAY_FONT, MONO_FONT, placeLine, riseLetters, typeLine } from '../type';
import { choose } from './common';

export const slab: StyleFactory = (ctx) => {
  const g = ctx.grid;
  const s = ctx.scheme;
  const group = new THREE.Group();
  const kind = choose(ctx, ['block', 'disc', 'block'] as const);
  const { halfW: W, halfH: H } = g;
  const piece = new Flat(group, s.accent, kind === 'disc' ? 'disc' : 'rect', 3);
  const title = typeLine((ctx.labels.title || 'HUM').toUpperCase(), s.onAccent, MONO_FONT, 64);
  group.add(title.mesh);

  // block: which pair of edges it moves between, and which one it starts on
  const across = g.portrait; // a tall frame: top and bottom; a wide one: left and right
  const startSide = (ctx.layout >> 2) & 1;
  const deep = across ? g.rowY(0) - g.rowY(Math.round(g.rows * 0.4)) + g.margin : g.colX(Math.round(g.cols * 0.4)) - g.colX(0) + g.margin;
  const bars = Math.max(1, Math.round((ctx.end - ctx.start) / (ctx.beat * 4)));
  const firstBar = Math.max(0, Math.round((ctx.start - ctx.partStart) / (ctx.beat * 4)));
  const numbers = Array.from({ length: bars }, (_, i) => typeLine(String(firstBar + i + 1).padStart(2, '0'), s.onAccent, DISPLAY_FONT, 300));
  if (kind === 'block') for (const nb of numbers) group.add(nb.mesh);
  else for (const nb of numbers) nb.mesh.visible = false;

  /** the block standing on side 0 (top / left) or 1 (bottom / right), pushed `off` of its depth out of the frame */
  const blockAt = (side: number, off: number) => {
    const d = deep * (1 - off);
    if (across) return side === 0 ? { x0: -W, x1: W, y0: H - d, y1: H + 0.01 } : { x0: -W, x1: W, y0: -H - 0.01, y1: -H + d };
    return side === 0 ? { x0: -W - 0.01, x1: -W + d, y0: -H, y1: H } : { x0: W - d, x1: W + 0.01, y0: -H, y1: H };
  };
  // disc: corners in order round the frame
  const corners = [
    [-W, H],
    [W, H],
    [W, -H],
    [-W, -H],
  ];
  const r = Math.min(W, H) * 2 * 0.78;

  return {
    object: group,
    mask: null,
    update(f, bed) {
      bed.tone[0] = ctx.tone;
      const a = arrival(ctx, f.t);
      const cover = handOver(ctx, f.t);
      const gone = settling(ctx, f.t);
      const { n, e } = barStep(ctx, f.t);
      let tx = 0;
      let ty = 0;
      let tAlign: 'left' | 'right' = 'left';
      let box = { x0: 0, x1: 0, y0: 0, y1: 0 };
      if (kind === 'block') {
        const sideA = (startSide + Math.max(0, n - 1)) % 2;
        const sideB = (startSide + n) % 2;
        const A = blockAt(sideA, n === 0 ? 1 - a : 0);
        const B = blockAt(sideB, n === 0 ? 1 - a : gone);
        const k = n === 0 ? 1 : e;
        box = { x0: lerp(A.x0, B.x0, k), x1: lerp(A.x1, B.x1, k), y0: lerp(A.y0, B.y0, k), y1: lerp(A.y1, B.y1, k) };
        // the hand-over: the block grows to cover the frame
        box = { x0: lerp(box.x0, -W - 0.01, cover), x1: lerp(box.x1, W + 0.01, cover), y0: lerp(box.y0, -H - 0.01, cover), y1: lerp(box.y1, H + 0.01, cover) };
        piece.rect(box.x0, box.y0, box.x1, box.y1);
        // the bar number: big, on the grid inside the block's inner corner
        const inner = across ? (sideB === 0 ? box.y0 : box.y1) : sideB === 0 ? box.x1 : box.x0;
        numbers.forEach((nb, i) => (nb.mesh.visible = i === Math.min(n, numbers.length - 1) && a > 0.5 && cover < 0.3));
        const nb = numbers[Math.min(n, numbers.length - 1)];
        const big = across ? deep * 0.42 : g.rowH * 1.1;
        if (across) {
          const base = sideB === 0 ? inner + g.margin : inner - g.margin - big;
          placeLine(nb, g.x0, base, big);
          tx = g.x1;
          ty = base;
          tAlign = 'right';
        } else {
          // on the bottom margin, a margin in from the block's left edge (the frame's margin when it stands on the left)
          const left = Math.max(g.x0, box.x0 + g.margin);
          placeLine(nb, left, g.y0, big);
          tx = left;
          ty = g.y1 - g.tiny;
        }
        riseLetters(nb, f.t, ctx.start + ctx.freeze + (n ? n * ctx.beat * 4 : 0) + 0.04, 0.2);
      } else {
        const c0 = corners[(startSide * 2 + Math.max(0, n - 1)) % 4];
        const c1 = corners[(startSide * 2 + n) % 4];
        const k = n === 0 ? 1 : e;
        const rr = r * a * (1 - gone) + cover * Math.hypot(W, H) * 2.2;
        piece.disc(lerp(c0[0], c1[0], k), lerp(c0[1], c1[1], k), rr);
        // the title on the margin, inside the circle's quarter
        const c = c1;
        tAlign = c[0] < 0 ? 'left' : 'right';
        tx = c[0] < 0 ? g.x0 : g.x1;
        ty = c[1] > 0 ? g.y1 - g.tiny : g.y0;
      }
      placeLine(title, tx, ty, g.tiny, tAlign);
      title.mesh.visible = a > 0.9 && cover < 0.3 && (n === 0 || e > 0.99);
    },
    dispose() {
      piece.dispose();
      title.dispose();
      for (const nb of numbers) nb.dispose();
    },
  };
};
