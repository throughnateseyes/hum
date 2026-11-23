/**
 * Split: the frame cut into two or three panels (rows in a tall frame, columns in a wide one), each
 * showing the same clip as its own shot: one wide, one pushed in on the focus, one close and printed
 * in ink and the accent. Thin paper gutters between them, and a small index on each.
 *
 *   arrives   the shot opens as one panel; within 0.2 s the gutters slide in from the edge
 *   the beat  each bar the panels trade their crops and treatments, a cut inside every panel at once
 *   hands over  in the last beat the gutters slide out again and the panels merge back into one
 */
import * as THREE from 'three';
import { arrival, barStep, Flat, handOver, lerp, MASK_A, MASK_B, settling, TONE, toU, toV, type StyleFactory } from '../kit';
import { MONO_FONT, placeLine, typeLine } from '../type';

export const split: StyleFactory = (ctx) => {
  const g = ctx.grid;
  const s = ctx.scheme;
  const group = new THREE.Group();
  const mask = new THREE.Group();
  const count = (ctx.layout & 1) === 0 ? 3 : 2;
  const rows = g.portrait;
  const { halfW: W, halfH: H } = g;
  const gutter = g.margin * 0.28;
  // panel 0 is the frame region, 1 and 2 are cut by the mask
  const cut = [null, new Flat(mask, MASK_A, 'rect', 1), new Flat(mask, MASK_B, 'rect', 1)];
  const gutters = [0, 1].map(() => new Flat(group, s.paper, 'rect', 4));
  const index = Array.from({ length: count }, (_, i) => typeLine(String(i + 1).padStart(2, '0'), s.ink, MONO_FONT, 64));
  const chips = index.map(() => new Flat(group, s.paper, 'rect', 5));
  for (const l of index) group.add(l.mesh);

  // what each panel shows, rotating one place every bar: [push-in, tone]
  const clean = ctx.colour === 'clean';
  const looks: [number, number][] = [
    [1, ctx.tone],
    [2.1, clean ? TONE.clean : TONE.mono],
    [3.4, TONE.duo],
  ];
  const turn = (ctx.layout >> 1) % 3;

  return {
    object: group,
    mask,
    update(f, bed) {
      const a = arrival(ctx, f.t);
      const merge = Math.max(handOver(ctx, f.t), settling(ctx, f.t));
      const k = a * (1 - merge);
      const { n } = barStep(ctx, f.t);
      // panel edges, from the top (or the left): collapsed onto the far edge, then spread evenly
      const len = rows ? 2 * H : 2 * W;
      const edges = Array.from({ length: count + 1 }, (_, i) => lerp(len, (len * i) / count, i === 0 ? 1 : k));
      for (let i = 0; i < 3; i++) {
        const live = i < count;
        const p0 = live ? edges[i] : len;
        const p1 = live ? edges[i + 1] : len;
        // as a box in world units: rows run down from the top, columns across from the left
        const box = rows ? { x0: -W, x1: W, y0: H - p1, y1: H - p0 } : { x0: -W + p0, x1: -W + p1, y0: -H, y1: H };
        const [zoom, tone] = looks[(i + turn + n) % 3];
        bed.tone[i] = tone;
        bed.zoom[i] = zoom;
        const u0 = toU(g, box.x0);
        const v0 = toV(g, box.y0);
        bed.rect[i].set(u0, v0, Math.max(1e-3, toU(g, box.x1) - u0), Math.max(1e-3, toV(g, box.y1) - v0));
        const c = cut[i];
        if (c) {
          if (live && p1 - p0 > 1e-4) c.rect(box.x0, box.y0, box.x1, box.y1);
          else c.hide();
        }
        if (i < count) {
          // the index chip on each panel's top-left, inside the margin
          const l = index[i];
          const x = box.x0 + g.margin * 0.6;
          const y = box.y1 - g.margin * 0.6 - g.tiny;
          const w = placeLine(l, x + g.tiny * 0.5, y, g.tiny);
          chips[i].rect(x, y - g.tiny * 0.6, x + w + g.tiny, y + g.tiny * 1.6);
          const show = k > 0.98 && p1 - p0 > len * 0.2;
          l.mesh.visible = show;
          chips[i].mesh.visible = show;
        }
      }
      // gutters on the inner edges
      gutters.forEach((gt, j) => {
        const e = edges[j + 1];
        if (j + 1 >= count || e >= len - 1e-4) return gt.hide();
        if (rows) gt.rect(-W, H - e - gutter / 2, W, H - e + gutter / 2);
        else gt.rect(-W + e - gutter / 2, -H, -W + e + gutter / 2, H);
      });
    },
    dispose() {
      for (const c of cut) c?.dispose();
      for (const gt of gutters) gt.dispose();
      for (const c of chips) c.dispose();
      for (const l of index) l.dispose();
    },
  };
};
