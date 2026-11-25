/**
 * Slab: the footage full frame, and one flat band in the accent that crops it from an edge: about a fifth
 * of a wide frame, a sixth of a tall one, so the picture keeps the rest. Each bar it slides across to stand
 * on the opposite edge. The part and its time are set small at one end of it, the song's title at the other.
 *
 *   arrives   slides in from off the frame within 0.2 s
 *   the beat  one slide per bar, then still
 *   hands over  in the last beat it grows to cover the frame, so the cut is a wipe in the accent
 */
import * as THREE from 'three';
import { arrival, barStep, Flat, handOver, lerp, settling, type StyleFactory } from '../kit';
import { lineWidth, MONO_FONT, placeLine, typeLine } from '../type';

export const slab: StyleFactory = (ctx) => {
  const g = ctx.grid;
  const s = ctx.scheme;
  const group = new THREE.Group();
  const { halfW: W, halfH: H } = g;
  const piece = new Flat(group, s.accent, 'rect', 3);

  // which pair of edges it moves between (a tall frame: top and bottom; a wide one: left and right), and
  // which one it starts on
  const across = g.portrait;
  const startSide = (ctx.layout >> 2) & 1;
  const deep = across ? 2 * H * 0.16 : 2 * W * 0.2;
  const part = typeLine(`${ctx.labels.part} ${ctx.labels.time}`.trim().toUpperCase(), s.onAccent, MONO_FONT, 64);
  const title = typeLine(ctx.labels.title.toUpperCase(), s.onAccent, MONO_FONT, 64);
  const lines = [part, title];
  for (const l of lines) group.add(l.mesh);
  // small type stays inside the band, whatever the song is called
  const room = (across ? (g.x1 - g.x0) * 0.46 : deep - g.margin * 2);
  const caps = lines.map((l) => Math.min(g.tiny, room / Math.max(1e-6, lineWidth(l, 1))));

  /** the band standing on side 0 (top / left) or 1 (bottom / right), pushed `off` of its depth out of the frame */
  const blockAt = (side: number, off: number) => {
    const d = deep * (1 - off);
    if (across) return side === 0 ? { x0: -W, x1: W, y0: H - d, y1: H + 0.01 } : { x0: -W, x1: W, y0: -H - 0.01, y1: -H + d };
    return side === 0 ? { x0: -W - 0.01, x1: -W + d, y0: -H, y1: H } : { x0: W - d, x1: W + 0.01, y0: -H, y1: H };
  };

  return {
    object: group,
    mask: null,
    update(f, bed) {
      bed.tone[0] = ctx.tone;
      const a = arrival(ctx, f.t);
      const cover = handOver(ctx, f.t);
      const gone = settling(ctx, f.t);
      const { n, e } = barStep(ctx, f.t);
      const A = blockAt((startSide + Math.max(0, n - 1)) % 2, n === 0 ? 1 - a : 0);
      const side = (startSide + n) % 2;
      const B = blockAt(side, n === 0 ? 1 - a : gone);
      const k = n === 0 ? 1 : e;
      const to = (x: number, y: number, full: number) => lerp(lerp(x, y, k), full, cover);
      // the hand-over: the band grows to cover the frame
      const box = { x0: to(A.x0, B.x0, -W - 0.01), x1: to(A.x1, B.x1, W + 0.01), y0: to(A.y0, B.y0, -H - 0.01), y1: to(A.y1, B.y1, H + 0.01) };
      piece.rect(box.x0, box.y0, box.x1, box.y1);
      const on = a > 0.9 && cover < 0.05 && gone < 0.05 && (n === 0 || e > 0.99);
      if (across) {
        // on one line, against the picture's edge of the band
        const y = side === 0 ? box.y0 + g.margin * 0.6 : box.y1 - g.margin * 0.6 - g.tiny;
        placeLine(part, g.x0, y, caps[0]);
        placeLine(title, g.x1, y, caps[1], 'right');
      } else {
        // top and bottom of the band, a margin in from its left edge (the frame's own margin at the frame's edge)
        const x = side === 0 ? g.x0 : box.x0 + g.margin;
        placeLine(part, x, g.y1 - g.tiny, caps[0]);
        placeLine(title, x, g.y0, caps[1]);
      }
      for (const l of lines) l.mesh.visible = on;
    },
    dispose() {
      piece.dispose();
      for (const l of lines) l.dispose();
    },
  };
};
