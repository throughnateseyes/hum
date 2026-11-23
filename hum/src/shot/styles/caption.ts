/**
 * Caption: the footage carries the frame; a small accent tag on one corner of the grid names the song
 * and the part, set in mono like a slate. The calm style, for intros, outros and quiet parts.
 *
 *   arrives   the tag wipes open from its edge and the letters rise, within 0.2 s
 *   the beat  a small square in the tag marks each beat of the bar, filling one more per beat
 *   leaves    the song's last shot: the tag closes again
 */
import * as THREE from 'three';
import { arrival, beatIndex, Flat, settling, type StyleFactory } from '../kit';
import { MONO_FONT, lineWidth, placeLine, riseLetters, typeLine } from '../type';
import { choose } from './common';

export const caption: StyleFactory = (ctx) => {
  const g = ctx.grid;
  const s = ctx.scheme;
  const group = new THREE.Group();
  const where = choose(ctx, ['bl', 'tl', 'bl', 'tr'] as const);
  const top = where[0] === 't';
  const right = where[1] === 'r';

  const tag = new Flat(group, s.accent, 'rect', 4);
  const lines = [ctx.labels.title || 'HUM', `${ctx.labels.part}  ${ctx.labels.time}`].map((text) => typeLine(text.toUpperCase(), s.onAccent, MONO_FONT, 64));
  for (const l of lines) group.add(l.mesh);
  const pad = g.tiny * 1.1;
  const lead = g.tiny * 1.8;
  const dot = g.tiny;
  const textW = Math.max(...lines.map((l) => lineWidth(l, g.tiny)));
  const w = textW + pad * 3 + dot;
  const h = pad * 2 + g.tiny + lead;
  // the tag's outer corner sits on the grid's margin corner
  const ox = right ? g.x1 : g.x0;
  const oy = top ? g.y1 : g.y0;
  const sx = right ? -1 : 1;
  const sy = top ? -1 : 1;
  const ticks = [0, 1, 2, 3].map(() => new Flat(group, s.onAccent, 'rect', 5));

  return {
    object: group,
    mask: null,
    update(f, bed) {
      bed.tone[0] = ctx.tone;
      const open = arrival(ctx, f.t) * (1 - settling(ctx, f.t));
      const tw = w * open;
      tag.rect(ox, oy, ox + sx * tw, oy + sy * h);
      // text inside the tag, left-aligned to its padding
      const left = right ? ox - w + pad : ox + pad;
      const firstBase = top ? oy - pad - g.tiny : oy + pad + lead;
      lines.forEach((l, i) => {
        placeLine(l, left, firstBase - i * lead, g.tiny);
        riseLetters(l, f.t, ctx.start + ctx.freeze + 0.06 + i * 0.04, 0.18);
        l.mesh.visible = open > 0.98;
      });
      // the beat of the bar, as four small squares stacked in the tag's free corner
      const beat = beatIndex(ctx, f.t) % 4;
      const tx = left + textW + pad;
      ticks.forEach((tk, i) => {
        const y = firstBase - lead + g.tiny * 0.05 + (i * (lead + g.tiny)) / 4;
        tk.rect(tx, y, tx + dot, y + (lead + g.tiny) / 4 - g.tiny * 0.18);
        tk.mesh.visible = open > 0.98 && i <= beat;
      });
    },
    dispose() {
      tag.dispose();
      for (const t of ticks) t.dispose();
      for (const l of lines) l.dispose();
    },
  };
};
