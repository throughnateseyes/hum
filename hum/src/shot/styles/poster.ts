/**
 * Poster: one word set enormous on a flat field, with the footage inside the letters. The word is the
 * song's title (one word per shot), or the part's name when there is no title to set.
 *
 * Two arrangements, by the shot's layout number:
 *   tower   one line so large that only two or three letters fit; it runs up the frame in a tall
 *           picture (across it in a wide one), bleeding off both ends. Each bar it steps along the word.
 *   block   (wide frames, and words under three letters) the word broken onto two lines, each set to the full width between
 *           the margins, sitting on the top or the bottom margin. Each bar it cuts to the next word.
 * Small type on the opposite corners: the song and the part.
 *
 *   arrives   the shot opens on the footage alone; within 0.2 s the field closes round the letters
 *   the beat  one move per bar (a step along the word, or the next word)
 *   hands over  the field drops away in the last beat, so the cut lands on full-frame footage
 */
import * as THREE from 'three';
import { arrival, barStep, disposeGroup, handOver, lerp, MASK_A, settling, type StyleFactory } from '../kit';
import { DISPLAY_FONT, lineWidth, placeLine, typeLine, type TypeLine } from '../type';
import { cornerLine, fieldFor } from './common';

const SIZE = 360;

/** turn a placed line a quarter turn about the frame's centre, so it reads up the frame */
function turnUp(l: TypeLine) {
  const { x, y } = l.mesh.position;
  l.mesh.position.set(-y, x, 0);
  l.mesh.rotation.z = Math.PI / 2;
}

export const poster: StyleFactory = (ctx) => {
  const g = ctx.grid;
  const field = fieldFor(ctx);
  const group = new THREE.Group();
  const mask = new THREE.Group();
  const own = (ctx.word || ctx.labels.part || 'HUM').toUpperCase();
  const words = ctx.words.length ? ctx.words.map((w) => w.toUpperCase()) : [own];
  const first = Math.max(0, words.indexOf(own));
  // a tall frame always runs the word up the frame (set across it, a word only fills a strip); a wide one picks
  const tower = own.length >= 3 && (g.portrait || (ctx.layout & 1) === 0);
  const width = g.x1 - g.x0;

  // small type: the song and the part, on the two corners the word leaves free
  const low = ((ctx.layout >> 1) & 1) === 1;
  const small = [cornerLine(group, ctx, ctx.labels.title || 'HUM', field.text, low ? 'tl' : 'bl'), cornerLine(group, ctx, `${ctx.labels.part} ${ctx.labels.time}`, field.text, low ? 'tr' : 'br')];

  /* tower: one line, larger than the frame */
  let line: TypeLine | null = null;
  let cap = 0;
  let length = 0;
  if (tower) {
    line = typeLine(own, MASK_A, DISPLAY_FONT, SIZE);
    mask.add(line.mesh);
    // the letters fill the short side, with a sliver of field either side
    cap = (g.portrait ? 2 * g.halfW : 2 * g.halfH) * 0.8;
    length = lineWidth(line, cap);
    if (g.portrait) {
      // the small type runs up the two strips of field beside the word, from the bottom margin
      const strip = (g.halfW - cap / 2) / 2;
      small.forEach((l, i) => {
        const cx = (i ? 1 : -1) * (g.halfW - strip);
        placeLine(l, g.y0, -(cx + g.tiny / 2), g.tiny);
        turnUp(l);
      });
    }
  }

  /* block: each word broken onto lines set to the full width */
  const blocks = tower
    ? []
    : words.map((w) => {
        const parts = w.length >= 6 ? [w.slice(0, Math.ceil(w.length / 2)), w.slice(Math.ceil(w.length / 2))] : [w];
        const lines = parts.map((p) => typeLine(p, MASK_A, DISPLAY_FONT, SIZE));
        const caps = lines.map((l) => Math.min((width / lineWidth(l, 1)) * 1, (g.y1 - g.y0) * (g.portrait ? 0.3 : 0.62)));
        for (const l of lines) mask.add(l.mesh);
        return { lines, caps };
      });

  return {
    object: group,
    mask,
    update(f, bed) {
      const a = arrival(ctx, f.t);
      const out = Math.max(handOver(ctx, f.t) > 0.5 ? 1 : 0, settling(ctx, f.t) > 0.5 ? 1 : 0);
      const on = a > 0.01 && out < 1;
      bed.tone[0] = on ? field.field : field.inside;
      bed.tone[1] = field.inside;
      for (const l of small) l.mesh.visible = on;
      const { n, e } = barStep(ctx, f.t);
      // the field closes in: the letters start a little larger and settle onto their places
      const grow = 1 + 0.35 * (1 - a);

      if (line) {
        // steps along the word: each bar shows the next stretch of it
        const view = g.portrait ? 2 * g.halfH : 2 * g.halfW;
        const span = Math.max(0, length - view * 0.8);
        const stops = Math.max(1, Math.round((ctx.end - ctx.start) / (ctx.beat * 4)));
        // where the word starts: its first letters just inside the frame, then each bar further along,
        // until its last letters sit just inside the far end
        const at = (k: number) => -view * 0.4 - (span * Math.min(k, stops - 1)) / Math.max(1, stops - 1);
        const from = lerp(at(Math.max(0, n - 1)), at(n), e);
        // the cap band across the middle of the short side
        placeLine(line, from, (-cap * grow) / 2, cap * grow);
        // turned to read up the frame: its start at the bottom
        if (g.portrait) turnUp(line);
        line.mesh.visible = on;
        return;
      }

      const k = words.length ? (first + n) % words.length : 0;
      blocks.forEach((b, i) => {
        for (const l of b.lines) l.mesh.visible = on && i === k;
      });
      const b = blocks[k];
      if (!b) return;
      const lead = 0.12;
      const total = b.caps.reduce((s, c) => s + c * (1 + lead), 0) - b.caps[b.caps.length - 1] * lead;
      // on the top margin, or standing on the bottom one
      let y = low ? g.y0 + total : g.y1;
      b.lines.forEach((l, j) => {
        const c = b.caps[j];
        y -= c;
        placeLine(l, g.x0, y, c * grow);
        y -= c * lead;
      });
    },
    dispose() {
      disposeGroup(mask);
      for (const l of small) l.dispose();
    },
  };
};
