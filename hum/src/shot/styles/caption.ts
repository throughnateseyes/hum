/**
 * Caption: the footage carries the frame, under one word of the title set as large as the frame allows
 * and cut off by its edge, like the title of a film. One line of small mono type on the far margin
 * names the part, its time and the tempo, with four small squares counting the beats of the bar. The
 * calm style, for intros, outros and quiet parts: nothing moves once it has arrived.
 *
 * Where the word stands, by the shot's layout number: in a tall frame it runs up the left edge (its
 * tops cut off) or the right edge (its feet cut off); in a wide one it stands on the bottom edge or
 * hangs from the top. It is set in paper, or in the accent.
 *
 *   arrives   the word's letters come out of the edge one after another, within 0.2 s
 *   the beat  only the small squares change, one step per beat
 *   hands over  the word sinks back into its edge in the last beat (slowly, at the end of the song)
 */
import * as THREE from 'three';
import { arrival, beatIndex, Flat, handOver, settling, type StyleFactory } from '../kit';
import { DISPLAY_FONT, lineWidth, MONO_FONT, placeLine, riseLetters, typeLine, type TypeLine } from '../type';
import { choose } from './common';

/** how much of the word's cap height the frame's edge cuts off */
const CROP = 0.22;

/** turn a placed line a quarter turn about the frame's centre, so it reads up the frame */
function turnUp(l: TypeLine) {
  const { x, y } = l.mesh.position;
  l.mesh.position.set(-y, x, 0);
  l.mesh.rotation.z = Math.PI / 2;
}

export const caption: StyleFactory = (ctx) => {
  const g = ctx.grid;
  const s = ctx.scheme;
  const group = new THREE.Group();
  // which edge: in a tall frame 'left' or 'right', in a wide one 'bottom' or 'top'
  const first = choose(ctx, [true, false, true] as const);
  const upright = g.portrait;
  const ink = choose(ctx, [s.paper, s.paper, s.accent] as const, 2);
  const word = (ctx.word || ctx.labels.title || 'HUM').toUpperCase();
  const big = typeLine(word, ink, DISPLAY_FONT, 360);
  group.add(big.mesh);
  // the frame's side the word runs along, and the side across it
  const along = upright ? g.halfH * 2 : g.halfW * 2;
  const across = upright ? g.halfW * 2 : g.halfH * 2;
  const cap = Math.min(across * 0.42, (along * 0.96) / lineWidth(big, 1));
  const length = lineWidth(big, cap);
  // the word starts on the margin (the bottom one when upright), or is centred when that won't fit
  const from = length < along - g.margin * 2 ? -along / 2 + g.margin : -length / 2;
  // tops toward the edge (left or top) or feet toward it (right or bottom)
  const topsOut = upright ? first : !first;

  const slate = typeLine(`${ctx.labels.part}  ${ctx.labels.time}  ${ctx.labels.tempo}`.toUpperCase(), ink, MONO_FONT, 64);
  group.add(slate.mesh);
  const ticks = [0, 1, 2, 3].map(() => new Flat(group, ink, 'rect', 5));

  return {
    object: group,
    mask: null,
    update(f, bed) {
      bed.tone[0] = ctx.tone;
      const a = arrival(ctx, f.t);
      const away = Math.max(handOver(ctx, f.t), settling(ctx, f.t));
      // how far the word sits out past its edge: CROP of its cap height, and all of it as it leaves
      const out = cap * (CROP + (1 - CROP) * away);
      const half = across / 2;
      // baseline before the turn (upright) or as it is: tops out → the cap line sits `out` past the edge
      const base = topsOut ? half + out - cap : -half - out;
      if (upright) {
        // before the turn, +y becomes -x: the top edge of the unturned line is the left edge of the frame
        placeLine(big, from, base, cap);
        turnUp(big);
      } else placeLine(big, from, topsOut ? half + out - cap : -half - out, cap);
      riseLetters(big, f.t, ctx.start + ctx.freeze, 0.22);
      if (topsOut) for (let i = 0; i < big.count; i++) big.reveal[i] = 2 - big.reveal[i];
      big.mesh.visible = a > 0.001;

      // the slate on the top margin, away from the word (a wide frame: on the margin across from it)
      const right = upright ? first : false;
      const sy = upright || first ? g.y1 - g.tiny : g.y0;
      const sx = right ? g.x1 : g.x0;
      placeLine(slate, sx, sy, g.tiny, right ? 'right' : 'left');
      const on = a > 0.6 && away < 0.5;
      slate.mesh.visible = on;
      // four squares under the slate (or beside it in a wide frame), the beat of the bar filled
      const b = beatIndex(ctx, f.t) % 4;
      ticks.forEach((tk, i) => {
        const step = g.tiny * 1.5;
        const x = right ? g.x1 - (4 - i) * step + g.tiny * 0.5 : upright ? g.x0 + i * step : g.x1 - (4 - i) * step + g.tiny * 0.5;
        const y = upright ? sy - g.tiny * 2 : sy;
        tk.rect(x, y, x + g.tiny, y + g.tiny);
        tk.alpha(i === b ? 1 : 0.3);
        tk.mesh.visible = on;
      });
    },
    dispose() {
      big.dispose();
      slate.dispose();
      for (const tk of ticks) tk.dispose();
    },
  };
};
