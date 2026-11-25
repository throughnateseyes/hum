/**
 * The card: the two beats of held breath before a hit. An ink field with the phrase set in paper, one
 * word to a line, every line set to the width between the margins so short words stand taller, the
 * block standing on the bottom margin, and a short accent rule above it on the grid.
 */
import * as THREE from 'three';
import { Flat, type StyleFactory } from '../kit';
import { easeOutExpo, clamp01 } from '../time';
import { DISPLAY_FONT, lineWidth, placeLine, riseLetters, typeLine } from '../type';
import { cornerLine } from './common';

export const card: StyleFactory = (ctx) => {
  const g = ctx.grid;
  const s = ctx.scheme;
  const group = new THREE.Group();
  const words = ctx.word.split(/\s+/).filter(Boolean).slice(0, 4);
  const lines = words.map((w) => typeLine(w.toUpperCase(), s.paper, DISPLAY_FONT, 300));
  for (const l of lines) group.add(l.mesh);
  const width = g.x1 - g.x0;
  const caps = lines.map((l) => Math.min(width / lineWidth(l, 1), (g.y1 - g.y0) * (g.portrait ? 0.16 : 0.24)));
  const lead = 0.16;
  const rule = new Flat(group, s.accent, 'rect', 5);
  const small = cornerLine(group, ctx, ctx.labels.title, s.paper, 'tl');

  return {
    object: group,
    mask: null,
    update(f) {
      let y = g.y0;
      for (let i = lines.length - 1; i >= 0; i--) {
        placeLine(lines[i], g.x0, y, caps[i]);
        riseLetters(lines[i], f.t, ctx.start + i * 0.03, 0.2);
        y += caps[i] * (1 + lead);
      }
      const k = easeOutExpo(clamp01((f.t - ctx.start) / 0.3));
      rule.rect(g.x0, y + g.rowH * 0.3, g.x0 + g.colW * k, y + g.rowH * 0.3 + g.tiny * 0.8);
      small.mesh.visible = true;
    },
    dispose() {
      for (const l of lines) l.dispose();
      rule.dispose();
      small.dispose();
    },
  };
};
