/**
 * Window: a picture and a word, like a poster. The footage fills one large opening (about two thirds of
 * the frame); the flat field takes the rest, and on it one word of the title is set as wide as the field
 * allows. A line of small mono type sits on the edge of the field against the opening: the part, its
 * time and the tempo.
 *
 * The opening, by the shot's layout number:
 *   bleed    a rectangle running off three edges of the frame
 *   inset    a rectangle inside the margins, on the grid's lines
 * and the word below the picture or above it.
 *
 *   arrives   the shot opens on full-frame footage; within 0.2 s the field closes in to the opening and
 *             the word's letters rise
 *   the beat  still; on a bar line (when the shot is that long) picture and word trade places at once
 *   hands over  in the last beat the opening grows back to the full frame, so the cut lands on footage
 */
import * as THREE from 'three';
import { arrival, barStep, Flat, handOver, lerp, MASK_A, settling, type StyleFactory } from '../kit';
import { DISPLAY_FONT, lineWidth, MONO_FONT, placeLine, riseLetters, typeLine } from '../type';
import { choose, fieldFor } from './common';

type Box = { x0: number; y0: number; x1: number; y1: number };

export const window: StyleFactory = (ctx) => {
  const g = ctx.grid;
  const field = fieldFor(ctx);
  const group = new THREE.Group();
  const mask = new THREE.Group();
  const shape = choose(ctx, ['bleed', 'inset'] as const);
  const hole = new Flat(mask, MASK_A, 'rect', 1);
  const { halfW: W, halfH: H } = g;
  const wordBelow = ((ctx.layout >> 3) & 1) === 0;

  // the field's strip for the word: the last third of the frame (in rows of the grid)
  const stripRows = Math.max(1, Math.round(g.rows * (g.portrait ? 0.3 : 0.36)));
  const stripH = stripRows * g.rowH + g.margin;

  /** the opening with the word below it (below = true) or above it */
  const openingFor = (below: boolean): Box => {
    const y0 = below ? -H + stripH : -H - 0.01;
    const y1 = below ? H + 0.01 : H - stripH;
    if (shape === 'bleed') return { x0: -W - 0.01, x1: W + 0.01, y0, y1 };
    return { x0: g.x0, x1: g.x1, y0: below ? y0 + g.margin * 0.5 : g.y0, y1: below ? g.y1 : y1 - g.margin * 0.5 };
  };

  const word = (ctx.word || ctx.labels.title || 'HUM').toUpperCase();
  const big = typeLine(word, field.text, DISPLAY_FONT, 360);
  group.add(big.mesh);
  const cap = Math.min((g.x1 - g.x0) / lineWidth(big, 1), (stripH - g.margin * 2) * 0.82);
  const slate = typeLine(`${ctx.labels.part}  ${ctx.labels.time}  ${ctx.labels.tempo}`.toUpperCase(), field.text, MONO_FONT, 64);
  group.add(slate.mesh);
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
      // a hard trade on each bar line: the move is quick and lands on the bar
      const below = (n % 2 === 0) === wordBelow;
      const was = n === 0 ? below : !below;
      const from = openingFor(was);
      const to = openingFor(below);
      const k = n === 0 ? 1 : e;
      const shut = a * (1 - open);
      const box = {
        x0: lerp(full.x0, lerp(from.x0, to.x0, k), shut),
        x1: lerp(full.x1, lerp(from.x1, to.x1, k), shut),
        y0: lerp(full.y0, lerp(from.y0, to.y0, k), shut),
        y1: lerp(full.y1, lerp(from.y1, to.y1, k), shut),
      };
      hole.rect(box.x0, box.y0, box.x1, box.y1);

      // the word on the field, standing on the bottom margin (or under the top one), and the slate
      // between it and the picture
      const settled = n === 0 || e > 0.999;
      const base = below ? g.y0 : g.y1 - cap;
      placeLine(big, g.x0, base, cap);
      riseLetters(big, f.t, ctx.start + ctx.freeze + 0.05 + (n ? n * ctx.beat * 4 : 0), 0.22);
      big.mesh.visible = a > 0.5 && open < 0.3 && settled;
      const sy = below ? base + cap + g.tiny * 1.4 : base - g.tiny * 2.4;
      placeLine(slate, g.x0, sy, g.tiny);
      slate.mesh.visible = a > 0.9 && open < 0.3 && settled;
    },
    dispose() {
      hole.dispose();
      big.dispose();
      slate.dispose();
    },
  };
};
