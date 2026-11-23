/**
 * Window: a flat field with one large opening in it, and the footage only inside the opening.
 *
 * The opening is one of three shapes, by the shot's layout number, each with its own places on the grid:
 *   band     a thick band right across the frame, two rows deep (it bleeds off both sides), on the top,
 *            middle or bottom third
 *   circle   as wide as the margins allow, on the upper or lower half (left or right in a wide frame)
 *   column   half the columns wide, from the top margin to the bottom one, on the left or the right
 * Small type on two corners of the field: the song, and the part with its time.
 *
 *   arrives   the shot opens on full-frame footage; within 0.2 s the field closes in to the opening
 *   the beat  each bar the opening slides to its next place
 *   hands over  in the last beat the opening grows back to the full frame, so the cut lands on footage
 */
import * as THREE from 'three';
import { arrival, barStep, Flat, handOver, lerp, MASK_A, settling, type StyleFactory } from '../kit';
import { choose, cornerLine, fieldFor } from './common';

type Box = { x0: number; y0: number; x1: number; y1: number };

export const window: StyleFactory = (ctx) => {
  const g = ctx.grid;
  const field = fieldFor(ctx);
  const group = new THREE.Group();
  const mask = new THREE.Group();
  const shape = choose(ctx, ['band', 'circle', 'column'] as const);
  const hole = new Flat(mask, MASK_A, shape === 'circle' ? 'disc' : 'rect', 1);
  const { halfW: W, halfH: H } = g;

  // the places the opening takes, in order; it starts on a different one in every shot
  let places: Box[];
  if (shape === 'band') {
    const deep = g.portrait ? g.rowH * 2 : g.rowH * 1.5;
    const at = (y: number) => ({ x0: -W * 1.02, x1: W * 1.02, y0: y - deep / 2, y1: y + deep / 2 });
    const third = (g.y1 - g.y0) / 3;
    places = [at(g.y1 - third / 2 - (g.portrait ? g.rowH * 0.5 : 0)), at(0), at(g.y0 + third / 2 + (g.portrait ? g.rowH * 0.5 : 0))];
  } else if (shape === 'circle') {
    const r = g.portrait ? (g.x1 - g.x0) / 2 : (g.y1 - g.y0) / 2;
    const c = (x: number, y: number) => ({ x0: x - r, x1: x + r, y0: y - r, y1: y + r });
    places = g.portrait ? [c(0, g.y1 - r - g.rowH), c(0, g.y0 + r + g.rowH)] : [c(g.x0 + r + g.colW, 0), c(g.x1 - r - g.colW, 0)];
  } else {
    const span = Math.max(1, Math.floor(g.cols / 2)) * g.colW;
    places = [
      { x0: g.x0, x1: g.x0 + span, y0: g.y0, y1: g.y1 },
      { x0: g.x1 - span, x1: g.x1, y0: g.y0, y1: g.y1 },
    ];
  }
  const offset = (ctx.layout >> 3) % places.length;
  const place = (k: number) => places[(offset + k) % places.length];

  // small type in the top margin, which the opening never reaches: the song on the left, the part on the right
  const small = [cornerLine(group, ctx, ctx.labels.title || 'HUM', field.text, 'tl'), cornerLine(group, ctx, `${ctx.labels.part} ${ctx.labels.time}`, field.text, 'tr')];
  for (const l of small) l.mesh.position.y += (g.margin + g.tiny) / 2;
  const full: Box = { x0: -W * 1.6, x1: W * 1.6, y0: -H * 1.6, y1: H * 1.6 };

  return {
    object: group,
    mask,
    update(f, bed) {
      const a = arrival(ctx, f.t);
      const open = Math.max(handOver(ctx, f.t), settling(ctx, f.t));
      bed.tone[0] = field.field;
      bed.tone[1] = field.inside;
      const { n, e } = barStep(ctx, f.t);
      const from = place(Math.max(0, n - 1));
      const to = place(n);
      // 0 the whole frame is footage, 1 the field has closed in to the opening
      const shut = a * (1 - open);
      const box = {
        x0: lerp(full.x0, lerp(from.x0, to.x0, e), shut),
        x1: lerp(full.x1, lerp(from.x1, to.x1, e), shut),
        y0: lerp(full.y0, lerp(from.y0, to.y0, e), shut),
        y1: lerp(full.y1, lerp(from.y1, to.y1, e), shut),
      };
      if (shape === 'circle') {
        // grows from (and back to) a circle that covers the whole frame
        const r = (box.x1 - box.x0) / 2;
        hole.disc((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, r * (1 + (1 - (shut)) * 0.6));
      } else hole.rect(box.x0, box.y0, box.x1, box.y1);
      for (const l of small) l.mesh.visible = a > 0.5 && open < 0.5;
    },
    dispose() {
      hole.dispose();
      for (const l of small) l.dispose();
    },
  };
};
