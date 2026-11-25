/**
 * Poster: one word set enormous on a flat field, with the footage inside the letters. The word is the
 * song's title (one word per shot). With no word to set the stage plays the shot plain instead.
 *
 * Two arrangements, by the shot's layout number:
 *   tower   the word as tall as the frame's short side allows while it still stands whole, running up
 *           the frame in a tall picture (across it in a wide one); a word too long for that is broken
 *           in two, the halves side by side. It never moves: one word, held.
 *   block   (wide frames, and words under three letters) the word broken onto two lines, each set to the
 *           full width between the margins, sitting on the top or the bottom margin. Each bar it cuts
 *           to the next word of the title.
 * Small type on the opposite corners: the song and the part.
 *
 *   arrives   the shot opens on the footage alone; within 0.2 s the field closes round the letters
 *   the beat  still (a block cuts to the next word on a bar line)
 *   hands over  the field drops away in the last beat, so the cut lands on full-frame footage
 */
import * as THREE from 'three';
import { arrival, barStep, disposeGroup, handOver, MASK_A, settling, type StyleFactory } from '../kit';
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
  const own = (ctx.word || 'HUM').toUpperCase();
  const words = ctx.words.length ? ctx.words.map((w) => w.toUpperCase()) : [own];
  const first = Math.max(0, words.indexOf(own));
  // a tall frame runs the word up the frame (set across it, a word only fills a strip); a wide one picks.
  // The whole word always shows: a word cut to a fragment ("PR") reads as noise. A word too long to
  // stand in the frame at half its short side or more is broken in two, the halves side by side.
  const short = g.portrait ? 2 * g.halfW : 2 * g.halfH;
  const long = g.portrait ? 2 * g.halfH : 2 * g.halfW;
  const probe = typeLine(own, MASK_A, DISPLAY_FONT, SIZE);
  const whole = (long * 0.92) / lineWidth(probe, 1) >= short * 0.5;
  const halves = [own.slice(0, Math.ceil(own.length / 2)), own.slice(Math.ceil(own.length / 2))];
  const tower = own.length >= 3 && (whole || own.length >= 6) && (g.portrait || (ctx.layout & 1) === 0);
  const width = g.x1 - g.x0;

  // small type: the song and the part, on the two corners the word leaves free
  const low = ((ctx.layout >> 1) & 1) === 1;
  const small = [cornerLine(group, ctx, ctx.labels.title, field.text, low ? 'tl' : 'bl'), cornerLine(group, ctx, `${ctx.labels.part} ${ctx.labels.time}`, field.text, low ? 'tr' : 'br')];

  /* tower: one line (or two side by side) as tall as the short side allows, standing whole in the frame */
  const tl: TypeLine[] = [];
  let cap = 0;
  const gap = 0.06;
  if (tower) {
    if (whole) tl.push(probe);
    else {
      probe.dispose();
      for (const h of halves) tl.push(typeLine(h, MASK_A, DISPLAY_FONT, SIZE));
    }
    for (const l of tl) mask.add(l.mesh);
    const longest = Math.max(...tl.map((l) => lineWidth(l, 1)));
    // one line fills the short side with a sliver of field either side; two share it
    const room = tl.length === 1 ? 0.8 : 0.92 / (2 + gap);
    cap = Math.min(short * room, (long * 0.92) / longest);
    if (g.portrait) {
      // the small type runs up the two strips of field beside the word, from the bottom margin
      const block = cap * (tl.length + gap * (tl.length - 1));
      const strip = (g.halfW - block / 2) / 2;
      small.forEach((l, i) => {
        const cx = (i ? 1 : -1) * (g.halfW - strip);
        placeLine(l, g.y0, -(cx + g.tiny / 2), g.tiny);
        turnUp(l);
      });
    }
  } else probe.dispose();

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
      const { n } = barStep(ctx, f.t);
      // the field closes in: the letters start a little larger and settle onto their places
      const grow = 1 + 0.35 * (1 - a);

      if (tl.length) {
        // the lines stand whole and still in the middle of the frame, one above the other before the
        // turn (so side by side, reading up, in a tall frame)
        const c = cap * grow;
        const block = c * (tl.length + gap * (tl.length - 1));
        tl.forEach((l, i) => {
          const base = block / 2 - c - i * c * (1 + gap);
          placeLine(l, -lineWidth(l, c) / 2, base, c);
          if (g.portrait) turnUp(l);
          l.mesh.visible = on;
        });
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
