/**
 * Grid: the frame ruled into square cells by hairlines, edge to edge, and one large block of cells (two
 * by two) that jumps to a new place on every beat. Inside the block the footage is pushed in close and
 * printed in ink and the accent, like a loupe laid on the picture. The block's corner carries the bar
 * and the beat in small mono type (03.2).
 *
 * The path the block takes, by the shot's layout number: round the frame's corners, down the frame in
 * a zigzag, or a fixed scatter. Each shot starts its path somewhere else.
 *
 *   arrives   the hairlines and the block appear on the shot's first beat, at once
 *   the beat  every beat a hard jump, nothing in between
 *   hands over  in the last beat every cell fills, in reading order, so the cut lands on a full print
 */
import * as THREE from 'three';
import { beatIndex, Flat, handOver, MASK_A, settling, TONE, type StyleFactory } from '../kit';
import { dice } from '../time';
import { MONO_FONT, placeLine, typeLine } from '../type';

export const grid: StyleFactory = (ctx) => {
  const g = ctx.grid;
  const s = ctx.scheme;
  const group = new THREE.Group();
  const mask = new THREE.Group();
  // cells edge to edge: as many columns as the layout grid (4 tall, 8 wide), rows to keep them near square
  const cols = g.cols;
  const cw = (2 * g.halfW) / cols;
  const rows = Math.max(2, Math.round((2 * g.halfH) / cw));
  const ch = (2 * g.halfH) / rows;
  const px = (2 * g.halfH) / ctx.height;
  const hair = px * 1.5;
  const lines = [...Array.from({ length: cols - 1 }, () => new Flat(group, s.paper, 'rect', 2)), ...Array.from({ length: rows - 1 }, () => new Flat(group, s.paper, 'rect', 2))];
  for (const l of lines) l.alpha(0.6);
  const block = new Flat(mask, MASK_A, 'rect', 1);
  const cells = Array.from({ length: cols * rows }, () => new Flat(mask, MASK_A, 'rect', 1));

  // the block's places: the top-left cell of a two-by-two block
  const spots: [number, number][] = [];
  const pattern = (['corners', 'zigzag', 'scatter'] as const)[ctx.layout % 3];
  const maxC = cols - 2;
  const maxR = rows - 2;
  if (pattern === 'corners') spots.push([0, 0], [maxC, 0], [maxC, maxR], [0, maxR]);
  else if (pattern === 'zigzag') for (let r = 0; r <= maxR; r += 2) spots.push(r % 4 === 0 ? [0, r] : [maxC, r]);
  else {
    const rnd = dice(ctx.layout * 7 + 11);
    for (let i = 0; i < 6; i++) spots.push([Math.floor(rnd() * (maxC + 1)), Math.floor(rnd() * (maxR + 1))]);
  }
  const offset = (ctx.layout >> 2) % spots.length;
  // bar.beat labels for the beats of this shot, counted from the start of its section
  const firstBeat = Math.max(0, Math.round((ctx.start - ctx.partStart) / ctx.beat));
  const beats = Math.max(1, Math.ceil((ctx.end - ctx.start) / ctx.beat) + 1);
  const labels = Array.from({ length: Math.min(32, beats) }, (_, i) => {
    const n = firstBeat + i;
    const l = typeLine(`${String(Math.floor(n / 4) + 1).padStart(2, '0')}.${(n % 4) + 1}`, s.paper, MONO_FONT, 64);
    l.mesh.visible = false;
    group.add(l.mesh);
    return l;
  });

  return {
    object: group,
    mask,
    update(f, bed) {
      bed.tone[0] = ctx.tone;
      bed.tone[1] = TONE.duo;
      bed.zoom[1] = 2;
      const on = f.t >= ctx.start + ctx.freeze && settling(ctx, f.t) < 0.5;
      const fill = handOver(ctx, f.t);
      const sweep = Math.floor(fill * (cols * rows + 1));
      // hairlines
      lines.forEach((l, i) => {
        if (i < cols - 1) {
          const x = -g.halfW + (i + 1) * cw;
          l.rect(x - hair / 2, -g.halfH, x + hair / 2, g.halfH);
        } else {
          const y = g.halfH - (i - cols + 2) * ch;
          l.rect(-g.halfW, y - hair / 2, g.halfW, y + hair / 2);
        }
        l.mesh.visible = on && fill < 0.05;
      });
      const b = beatIndex(ctx, f.t);
      const [c, r] = spots[(offset + b) % spots.length];
      const x0 = -g.halfW + c * cw;
      const y1 = g.halfH - r * ch;
      block.rect(x0, y1 - 2 * ch, x0 + 2 * cw, y1);
      block.mesh.visible = on && fill < 0.05;
      // the beat in its corner
      const k = Math.min(b, labels.length - 1);
      labels.forEach((l, i) => (l.mesh.visible = on && fill < 0.05 && i === k));
      placeLine(labels[k], x0 + g.tiny * 0.9, y1 - 2 * ch + g.tiny * 0.9, g.tiny);
      cells.forEach((cell, i) => {
        const cc = i % cols;
        const rr = Math.floor(i / cols);
        const x = -g.halfW + cc * cw;
        const y = g.halfH - rr * ch;
        cell.rect(x, y, x + cw, y - ch);
        cell.mesh.visible = on && i < sweep;
      });
      // with the loupe full, the print isn't pushed in any more (the cut lands on the whole picture)
      if (fill > 0.05) bed.zoom[1] = 1;
    },
    dispose() {
      for (const l of lines) l.dispose();
      for (const l of labels) l.dispose();
      for (const cell of cells) cell.dispose();
      block.dispose();
    },
  };
};
