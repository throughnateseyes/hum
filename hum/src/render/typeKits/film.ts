import type { Palette } from '../../core/types';
import type { Placed, Role, Voice } from '../lyricAuto';
import { KIT_FACES } from './fonts';
import { arrival, clamp01, css, easeOut, fromHsl, hexRGB, huesOf, lum, mix, parseRGB, reach, rowsBox, toHsl, wordFont, type KitLine, type RGB } from './common';

/**
 * Film: '70s title lettering (references 18, 19, 22, 23, 24), drawn before the film finish so its
 * grain, gate weave, halation and dust print over the letters too.
 *
 *   display     Shrikhand, the fat '70s italic, with a stacked, offset shadow in two flat colours, each
 *               layer keylined in dark brown (the "Good Life" wordmark); three rounded stripes wrap
 *               round the start of the line and run off the frame under it (the "California" badge)
 *   giant       Shrikhand huge on a long striped extruded shadow (the "Cosmic" tee)
 *   subtitle    Fraunces at a reading weight, warm cream (or warm red on a light picture) with one
 *               flat offset shadow: a caption off a '70s title card
 *   sparse      Fraunces italic with the same flat shadow
 *   secondary   a small tracked line in Fraunces capitals above display lines: "CHORUS · 0:36"
 *
 * Palette rule: the look's colours warmed toward a '70s print set (tomato, mustard, cream, brown,
 * teal) and limited to a main colour, two shadow colours and the keyline.
 */

const SHOW = KIT_FACES.filmDisplay;
const TEXT = KIT_FACES.filmText;

export function filmVoice(role: Role | 'kicker', base: Voice): Voice {
  const clean = { stretch: undefined, widen: undefined, enter: undefined, italicKey: false, typed: false };
  if (role === 'caption') return { ...base, ...clean, family: TEXT, weight: 600, italic: false, track: 0.004, case: 'asis', leading: 1.3, size: 0.045 };
  if (role === 'aside') return { ...base, ...clean, family: TEXT, weight: 500, italic: true, track: 0, case: 'asis', leading: 1.14, size: 0.062 };
  if (role === 'kicker') return { ...base, ...clean, family: TEXT, weight: 650, italic: false, track: 0.18, case: 'upper', leading: 1.4, size: 0.032 };
  if (role === 'giant') return { ...base, ...clean, family: SHOW, weight: 400, italic: false, track: -0.01, case: 'asis', leading: 1, size: 0.3 };
  return { ...base, ...clean, family: SHOW, weight: 400, italic: false, track: 0, case: 'asis', leading: 1.12, size: 0.086 };
}

const WARM: RGB[] = [
  [217, 80, 43],
  [232, 162, 58],
  [243, 230, 200],
  [43, 111, 115],
];
const KEYLINE: RGB = [42, 22, 12];
const CREAM: RGB = [246, 233, 204];

/** warm a colour: pull its hue toward the nearest '70s ink and soften it like print */
function warmed(c: RGB): RGB {
  const near = WARM.reduce((a, b) => (dist(c, b) < dist(c, a) ? b : a));
  const m = mix(c, near, 0.6);
  const [h, s, l] = toHsl(m);
  return fromHsl(h, Math.min(0.78, s), l);
}
const dist = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

export interface FilmInks {
  main: RGB;
  sh1: RGB;
  sh2: RGB;
  key: RGB;
}

/** main, two shadows and the keyline, from the look, for light ink (dark picture) or dark ink */
export function filmInks(pal: Palette, light: boolean): FilmInks {
  const hs = huesOf(pal).map(warmed);
  const a = hs[0] ?? WARM[0];
  const b = hs.find((c) => dist(c, a) > 6000) ?? WARM[1];
  if (light) {
    // cream letters on a dark picture; the shadows are the look's two warm colours, kept mid-dark so
    // the cream stands off them
    const main = mix(CREAM, hexRGB(pal.fg), 0.12);
    return { main, sh1: reach(a, [0, 0, 0], 0, 0.32), sh2: reach(b, [0, 0, 0], 0, 0.2), key: KEYLINE };
  }
  // on a light picture: the letters in the deepest warm colour, shadows lighter behind
  const deep = reach(lum(a) < lum(b) ? a : b, KEYLINE, 0, 0.14);
  const other = lum(a) < lum(b) ? b : a;
  return { main: deep, sh1: reach(other, [255, 255, 255], 0.3), sh2: reach(mix(other, WARM[1], 0.5), [255, 255, 255], 0.45), key: KEYLINE };
}

/* ───────────────────────── drawing ───────────────────────── */

/** one word in its stack: back shadow, front shadow, then the letters, each keylined */
function stacked(g: CanvasRenderingContext2D, w: Placed, x: number, y: number, c: FilmInks, d: number, keyW: number) {
  wordFont(g, w);
  g.lineJoin = 'round';
  g.lineWidth = keyW;
  g.strokeStyle = css(c.key);
  const layers: [RGB, number][] = [
    [c.sh2, 2],
    [c.sh1, 1],
    [c.main, 0],
  ];
  for (const [col, k] of layers) {
    const lx = x + d * k;
    const ly = y + d * k;
    g.strokeText(w.text, lx, ly);
    g.fillStyle = css(col);
    g.fillText(w.text, lx, ly);
  }
}

/** the giant word on a long striped extrusion, down and a little right */
function extruded(g: CanvasRenderingContext2D, w: Placed, x: number, y: number, c: FilmInks, keyW: number) {
  wordFont(g, w);
  const step = Math.max(1.5, w.size * 0.011);
  const n = Math.round((w.size * 0.24) / step);
  g.fillStyle = css(c.sh1);
  for (let k = n; k >= 1; k--) {
    // stripes: two steps drawn, one left out
    if (k % 3 === 0) continue;
    g.fillText(w.text, x + k * step * 0.35, y + k * step);
  }
  g.lineJoin = 'round';
  g.lineWidth = keyW;
  g.strokeStyle = css(c.key);
  g.strokeText(w.text, x, y);
  g.fillStyle = css(c.main);
  g.fillText(w.text, x, y);
}

/**
 * Three fat rounded stripes that come in from the frame edge under the block, turn up round the end
 * of the last row and rise beside it (the swoosh of a '70s title card), drawn on as the line arrives.
 * When the last row ends too near the right edge to turn, they mirror and wrap its start instead.
 */
function stripes(k: KitLine, c: FilmInks, words: Placed[]) {
  const { g, L, t, W } = k;
  if (!words.length) return;
  const size = L.size;
  const lastBase = Math.max(...words.map((w) => w.y));
  const last = words.filter((w) => w.y > lastBase - size * 0.3);
  const rowL = Math.min(...last.map((w) => w.x));
  const rowR = Math.max(...last.map((w) => w.x + w.w));
  const th = size * 0.15;
  const gap = size * 0.055;
  const r0 = size * 0.22;
  const reach3 = r0 + 3 * (th + gap);
  // turn round the end of the row when there's room, else round its start
  const atEnd = rowR + size * 0.14 + reach3 < W - size * 0.1 || rowL - size * 0.14 - reach3 < size * 0.1;
  const cx = atEnd ? rowR + size * 0.14 : rowL - size * 0.14;
  const cy = lastBase + size * 0.3;
  const yTop = lastBase - size * 0.72;
  const grow = easeOut(clamp01((t - k.start) / 0.7));
  const cols = [c.sh2, c.sh1, c.main];
  g.save();
  g.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const r = r0 + i * (th + gap);
    const p = new Path2D();
    const edge = atEnd ? -th * 2 : W + th * 2;
    p.moveTo(edge, cy + r);
    p.lineTo(cx, cy + r);
    if (atEnd) p.arc(cx, cy, r, Math.PI / 2, 0, true);
    else p.arc(cx, cy, r, Math.PI / 2, Math.PI, false);
    // the outer stripes rise a little less, so their ends step like the reference cards
    p.lineTo(atEnd ? cx + r : cx - r, yTop + i * size * 0.12);
    const len = Math.abs(cx - edge) + (Math.PI * r) / 2 + (cy - yTop);
    g.setLineDash([len * grow, len * 2]);
    // keyline under each stripe, as printed
    g.strokeStyle = css(c.key);
    g.lineWidth = th + Math.max(1.5, size * 0.03);
    g.stroke(p);
    g.strokeStyle = css(cols[i]);
    g.lineWidth = th;
    g.stroke(p);
  }
  g.setLineDash([]);
  g.restore();
}

function secondary(k: KitLine, c: FilmInks, words: Placed[]) {
  const { g, L, t, facts, W } = k;
  if (!words.length) return;
  const box = rowsBox(L, 0);
  const fs = Math.max(12, Math.min(L.size * 0.28, W * 0.026));
  g.save();
  g.font = `650 ${fs.toFixed(1)}px ${TEXT}`;
  g.letterSpacing = `${(fs * 0.22).toFixed(1)}px`;
  g.globalAlpha = k.alpha * clamp01((t - k.start) / 0.4) * 0.92;
  g.fillStyle = css(k.light ? c.main : c.main);
  const left = !(box.x0 > W * 0.45);
  g.textAlign = left ? 'left' : 'right';
  g.fillText(`${facts.part.toUpperCase()}  ·  ${facts.time}`, left ? box.x0 + fs * 0.2 : box.x1, box.y0 - fs * 0.9);
  g.restore();
}

export function drawFilm(k: KitLine) {
  const { g, L, t, alpha } = k;
  const c = filmInks(k.pal, k.light);
  g.save();
  g.textBaseline = 'alphabetic';
  if (L.role === 'caption' || L.role === 'aside') {
    // one flat offset shadow; the film finish supplies the wear
    const d = Math.max(1.5, L.size * 0.07);
    // small type takes the ink the legibility guard checked against this picture (warmed a touch,
    // its lightness kept), so a caption never goes cream on cream paper; the shadow is a warm ink
    // on the far side of it
    const ink = parseRGB(k.inks.ink);
    const [ih, , il] = toHsl(ink);
    const [wh, ws] = toHsl(warmed(ink));
    const main = fromHsl(wh * 0.5 + ih * 0.5, Math.min(0.5, ws), il);
    const sh: RGB = lum(main) > 0.4 ? reach(c.sh1, [0, 0, 0], 0, 0.12) : reach(c.sh1, [255, 255, 255], 0.45);
    c.main = main;
    for (const w of L.words) {
      const a = arrival(L, w, t);
      if (!a.on) continue;
      wordFont(g, w);
      // the shadow drops in as the word is sung, so unsung words are the bare ink, not a pale blur
      g.globalAlpha = alpha * a.op * a.p;
      g.fillStyle = css(sh);
      g.fillText(w.text, w.x + d, w.y + a.dy + d);
      g.globalAlpha = alpha * a.op;
      g.fillStyle = css(c.main);
      g.fillText(w.text, w.x, w.y + a.dy);
    }
    g.restore();
    return;
  }
  g.globalAlpha = alpha;
  const shown = L.words.filter((w) => w.part !== 'kicker');
  if (L.role === 'display') stripes(k, c, shown);
  secondary(k, c, shown);
  for (const w of L.words) {
    const a = arrival(L, w, t);
    if (!a.on) continue;
    g.globalAlpha = alpha * a.op;
    const keyW = Math.max(1.5, w.size * 0.036);
    const masked = a.wipe < 1;
    if (masked) {
      g.save();
      g.beginPath();
      g.rect(w.x - w.size * 0.2, w.y - w.size * 1.2, (w.w + w.size * 0.6) * a.wipe, w.size * 1.9);
      g.clip();
    }
    if (w.part === 'kicker') {
      wordFont(g, w);
      g.fillStyle = css(c.main);
      g.fillText(w.text, w.x, w.y + a.dy);
    } else if (w.part === 'giant') extruded(g, w, w.x, w.y + a.dy, c, keyW);
    else stacked(g, w, w.x, w.y + a.dy, c, Math.max(1.5, w.size * 0.05), keyW);
    if (masked) g.restore();
  }
  g.letterSpacing = '0px';
  g.restore();
}
