/**
 * Grid: the frame divided edge to edge into square-ish cells that fill and empty on the beat. Over
 * clean footage the cells are flat paper and one marker cell is the accent; over printed footage the
 * cells are windows printed in ink and the accent, and the marker is ink. The marker carries the beat's
 * number.
 *
 * The pattern, by the shot's layout number:
 *   march    one column (one row in a wide frame) filled, stepping across one place per beat
 *   build    cells fill in a fixed scattered order, a few more every beat, and all clear on the bar
 *   rise     rows fill from the bottom up, one per beat, and clear on the bar
 *
 *   arrives   on the shot's first beat, at once
 *   the beat  every beat a hard change, nothing in between
 *   hands over  in the last beat every cell fills, in reading order, so the cut lands on a full grid
 */
import * as THREE from 'three';
import { beatIndex, Flat, handOver, MASK_A, settling, TONE, type StyleFactory } from '../kit';
import { MONO_FONT, placeLine, typeLine } from '../type';
import { dice } from '../time';

export const grid: StyleFactory = (ctx) => {
  const g = ctx.grid;
  const s = ctx.scheme;
  const group = new THREE.Group();
  const windows = ctx.colour !== 'clean';
  const mask = windows ? new THREE.Group() : null;
  // cells edge to edge: as many columns as the layout grid (4 tall, 8 wide), rows to keep them near square
  const cols = g.cols;
  const cw = (2 * g.halfW) / cols;
  const rows = Math.max(2, Math.round((2 * g.halfH) / cw));
  const ch = (2 * g.halfH) / rows;
  const n = cols * rows;
  const cells = Array.from({ length: n }, () => (windows ? new Flat(mask!, MASK_A, 'rect', 1) : new Flat(group, s.paper, 'rect', 2)));
  // over printed footage the cells are windows printed in ink and the accent, and the marker cell is ink
  const accent = new Flat(group, windows ? s.ink : s.accent, 'rect', 3);
  const numbers = Array.from({ length: 16 }, (_, i) => {
    const l = typeLine(String(i + 1).padStart(2, '0'), windows ? s.paper : s.onAccent, MONO_FONT, 64);
    l.mesh.visible = false;
    group.add(l.mesh);
    return l;
  });

  // (a checkerboard was tried and dropped: on busy footage it reads as noise)
  const patterns = ['march', 'build', 'rise'] as const;
  const pattern = patterns[ctx.layout % patterns.length];
  // a fixed scattered order for 'build'
  const rnd = dice(ctx.layout * 7 + 11);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const at = (i: number) => ({ c: i % cols, r: Math.floor(i / cols) });

  /** is cell i filled on beat b, and which cell is the accent */
  const filled = (i: number, b: number): boolean => {
    const { c, r } = at(i);
    const inBar = b % 4;
    if (pattern === 'march') return g.portrait ? c === b % cols : r === b % rows;
    if (pattern === 'rise') return rows - 1 - r <= Math.min(inBar, Math.ceil(rows / 2) - 1);
    // build: an eighth of the cells more every beat, at most half of them
    const k = order.indexOf(i);
    return k < Math.ceil((n / 8) * (inBar + 1));
  };
  const accentOf = (b: number): number => {
    if (pattern === 'march') return g.portrait ? (b % cols) + cols * ((b * 3) % rows) : ((b * 3) % cols) + cols * (b % rows);
    if (pattern === 'rise') return (rows - 1 - (b % 4)) * cols + ((b * 3 + 1) % cols);
    return order[Math.ceil((n / 8) * ((b % 4) + 1)) - 1] ?? 0;
  };

  return {
    object: group,
    mask,
    update(f, bed) {
      bed.tone[0] = ctx.tone;
      bed.tone[1] = TONE.duo;
      const on = f.t >= ctx.start + ctx.freeze && settling(ctx, f.t) < 0.5;
      const b = beatIndex(ctx, f.t);
      const fillAll = handOver(ctx, f.t);
      const sweep = Math.floor(fillAll * (n + 1));
      const acc = accentOf(b);
      for (let i = 0; i < n; i++) {
        const { c, r } = at(i);
        const x = -g.halfW + c * cw;
        const y = g.halfH - r * ch;
        cells[i].rect(x, y, x + cw, y - ch);
        cells[i].mesh.visible = on && (i < sweep || (i !== acc && filled(i, b)));
      }
      const { c, r } = at(acc);
      const ax = -g.halfW + c * cw;
      const ay = g.halfH - r * ch;
      accent.rect(ax, ay, ax + cw, ay - ch);
      accent.mesh.visible = on && fillAll < 0.05;
      numbers.forEach((l, i) => (l.mesh.visible = on && fillAll < 0.05 && i === b % 16));
      const label = numbers[b % 16];
      placeLine(label, ax + g.tiny * 0.9, ay - ch + g.tiny * 0.9, g.tiny);
    },
    dispose() {
      for (const cell of cells) cell.dispose();
      accent.dispose();
      for (const l of numbers) l.dispose();
    },
  };
};
