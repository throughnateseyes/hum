/**
 * Split: two moments side by side. The frame is cut into a large panel and a small one (rows in a tall
 * frame, columns in a wide one, about 5 to 3) by a thin paper gutter. Panel A shows the shot's clip;
 * panel B shows another moment: the next clip where it last stopped, or, with only one clip, the same
 * clip further on (src/shot/run.ts), printed in ink and the accent. Each panel carries a small
 * mono slate with the clip second it opened on, so the two moments read as two.
 *
 * Without a second clip (a part the scene cut itself, or a still) the small panel shows the same picture
 * pushed in close.
 *
 *   arrives   the shot opens as one panel; within 0.2 s the gutter slides in from the edge
 *   the beat  still; on each bar line the panels trade sizes at once
 *   hands over  in the last beat the gutter slides out again and the panels merge back into one
 */
import * as THREE from 'three';
import { arrival, barStep, Flat, handOver, lerp, MASK_A, settling, TONE, toU, toV, type StyleFactory } from '../kit';
import { MONO_FONT, placeLine, typeLine } from '../type';

/** the large panel's share of the frame */
const BIG = 0.62;

const stamp = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
};

export const split: StyleFactory = (ctx) => {
  const g = ctx.grid;
  const s = ctx.scheme;
  const group = new THREE.Group();
  const mask = new THREE.Group();
  const rows = g.portrait;
  const { halfW: W, halfH: H } = g;
  const gutter = g.margin * 0.16;
  const second = ctx.altFrom !== null;
  // which end the large panel starts on
  const bigFirst = ((ctx.layout >> 1) & 1) === 0;
  // panel 1 (the small one, by the mask) shows the second moment
  const cut = new Flat(mask, MASK_A, 'rect', 1);
  const line = new Flat(group, s.paper, 'rect', 4);
  const slates = [
    typeLine(`A  ${stamp(ctx.clipFrom)}`, s.paper, MONO_FONT, 64),
    typeLine(`B  ${stamp(second ? (ctx.altFrom ?? 0) : ctx.clipFrom)}`, s.paper, MONO_FONT, 64),
  ];
  for (const l of slates) group.add(l.mesh);
  const clean = ctx.colour === 'clean';

  return {
    object: group,
    mask,
    update(f, bed) {
      const a = arrival(ctx, f.t);
      const merge = Math.max(handOver(ctx, f.t), settling(ctx, f.t));
      const k = a * (1 - merge);
      const { n, e } = barStep(ctx, f.t);
      // the gutter's place, as a share of the frame from the top (or the left): panel A before it shows
      // the shot's clip, panel B after it the second moment
      const at = (m: number) => ((m % 2 === 0) === bigFirst ? BIG : 1 - BIG);
      const share = n === 0 ? at(0) : lerp(at(n - 1), at(n), e);
      const len = rows ? 2 * H : 2 * W;
      // collapsed: panel B squeezed off the far edge
      const edge = lerp(len, len * share, k);
      const box = rows ? { x0: -W, x1: W, y0: -H, y1: H - edge } : { x0: -W + edge, x1: W, y0: -H, y1: H };
      const open = Math.abs(box.x1 - box.x0) > 1e-4 && Math.abs(box.y1 - box.y0) > 1e-4;
      if (open) cut.rect(box.x0, box.y0, box.x1, box.y1);
      else cut.hide();

      bed.tone[0] = ctx.tone;
      bed.tone[1] = clean ? TONE.clean : TONE.duo;
      bed.src[1] = second ? 1 : 0;
      bed.zoom[1] = second ? 1 : 2.2;
      const u0 = toU(g, box.x0);
      const v0 = toV(g, box.y0);
      bed.rect[1].set(u0, v0, Math.max(1e-3, toU(g, box.x1) - u0), Math.max(1e-3, toV(g, box.y1) - v0));

      // the gutter on the edge between them
      if (!open || k < 0.02) line.hide();
      else if (rows) line.rect(-W, H - edge - gutter / 2, W, H - edge + gutter / 2);
      else line.rect(-W + edge - gutter / 2, -H, -W + edge + gutter / 2, H);

      // a slate in each panel's top-left corner, on the margin
      const settled = k > 0.98 && (n === 0 || e > 0.999);
      const places = [{ x0: -W, y1: H }, { x0: box.x0, y1: box.y1 }];
      slates.forEach((l, i) => {
        placeLine(l, places[i].x0 + g.margin, places[i].y1 - g.margin * (i ? 0.7 : 1) - g.tiny, g.tiny);
        l.mesh.visible = settled;
      });    },
    dispose() {
      cut.dispose();
      line.dispose();
      for (const l of slates) l.dispose();
    },
  };
};
