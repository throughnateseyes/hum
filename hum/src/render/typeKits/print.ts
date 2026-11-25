import type { Palette } from '../../core/types';
import type { Role, TypeLayout, Voice } from '../lyricAuto';
import { notePlate, PAD_H, PAD_V, platePad, safeInsets, type Insets } from '../lyricSpace';
import { KIT_FACES } from './fonts';
import { arrival, clamp01, contrast, css, easeOut, fromHsl, hash1, huesOf, lineCap, lum, mix, reach, roundRect, rowsBox, toHsl, wordFont, type KitLine, type RGB } from './common';

/**
 * Print: lettering for the risograph and ink-wash finishes (references 21, 22, 14), drawn before the
 * finish so the riso separates it into its inks, grains it and knocks it out of register with the
 * picture (or the ink wash bleeds it into the paper).
 *
 *   display     the words stretched to fill a band edge to edge, one flat ink band per row with wavy
 *               edges (the psychedelic poster); the band is the words' own plate, so they always read
 *   giant       Bagel Fat One, fat and rounded, on stacked offset outlines in three flat inks (the
 *               "ART! ART! ART!" stack), each layer a touch out of register
 *   subtitle    Bagel Fat One in paper on a rounded ink panel with a dark keyline (the rounded panels
 *               of ref. 21); fat letters on a flat ink survive the riso's dither where thin ones don't
 *   sparse      Fredoka with one offset ink copy behind it
 *   secondary   a small pill label with the part's name next to display lines ("( CHORUS )")
 *
 * Palette rule: the look's hues pushed toward pure printing inks (fluorescent pink, blue, yellow,
 * orange), a near-black keyline, and paper for panels.
 */

const SHOW = KIT_FACES.printDisplay;
const TEXT = KIT_FACES.printText;

export function printVoice(role: Role | 'kicker', base: Voice): Voice {
  const clean = { stretch: undefined, widen: undefined, enter: undefined, italic: false, italicKey: false, typed: false };
  if (role === 'caption') return { ...base, ...clean, family: SHOW, weight: 400, track: 0.02, case: 'asis', leading: 1.3, size: 0.05 };
  if (role === 'aside') return { ...base, ...clean, family: TEXT, weight: 600, track: 0, case: 'lower', leading: 1.16, size: 0.058 };
  if (role === 'kicker') return { ...base, ...clean, family: TEXT, weight: 650, track: 0.12, case: 'upper', leading: 1.4, size: 0.036 };
  if (role === 'giant') return { ...base, ...clean, family: SHOW, weight: 400, track: 0, case: 'upper', leading: 1, size: 0.27 };
  return { ...base, ...clean, family: SHOW, weight: 400, track: 0.01, case: 'upper', leading: 1.5, size: 0.08 };
}

const RISO: RGB[] = [
  [255, 72, 176],
  [0, 120, 191],
  [255, 232, 0],
  [255, 108, 47],
  [0, 169, 92],
];
const KEY: RGB = [24, 20, 38];
const PAPER: RGB = [247, 241, 228];

const dist = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
/** a colour as a printing ink: toward the nearest riso ink, saturated */
function inked(c: RGB): RGB {
  const near = RISO.reduce((a, b) => (dist(c, b) < dist(c, a) ? b : a));
  const [h, s, l] = toHsl(mix(c, near, 0.5));
  return fromHsl(h, Math.max(0.7, s), Math.min(0.62, Math.max(0.42, l)));
}

/** three inks from the look, all different */
export function printInks(pal: Palette): RGB[] {
  const out: RGB[] = [];
  for (const c of [...huesOf(pal).map(inked), ...RISO]) {
    if (out.every((o) => dist(o, c) > 9000)) out.push(c);
    if (out.length === 3) break;
  }
  return out;
}

/** the ink or paper that reads on a band (at least 4.5:1 when one exists) */
const onBand = (band: RGB): RGB => (contrast(KEY, band) >= contrast(PAPER, band) ? KEY : PAPER);

/* ───────────────────────── display: the stretched band ───────────────────────── */

/** a band's wavy edge: y offset at x (pure: fixed per row) */
const wave = (x: number, W: number, amp: number, ph: number) => Math.sin((x / W) * Math.PI * 2.2 + ph) * amp;

/** the stretch at most: across, and up (a little, so the letters fatten with the band) */
const MAX_SX = 2.4;
const MAX_SY = 1.08;

/**
 * One row's band: across the safe area edge to edge, the row's words stretched to fill it less the
 * end padding, and tall enough to pad the stretched letters by the plate rule plus the wave (the
 * padding is measured from the wave's inner crest, so the letters never touch the edge).
 */
function bandOf(L: TypeLayout, ri: number, W: number, H: number) {
  const row = L.rows[ri];
  const words = L.words.filter((w) => w.row === ri);
  const s = safeInsets(W, H);
  const x0 = s.l;
  const x1 = W - s.r;
  const bandW = x1 - x0;
  const base = words[0]?.y ?? row.y + row.h;
  const cap = words.length ? lineCap(words) : L.size * 0.7;
  // the end padding is in the stretched letters' cap height (they grow up to MAX_SY), plus a hair for rounding
  const padH = cap * MAX_SY * PAD_H + 1;
  const sx = Math.max(1, Math.min(MAX_SX, (bandW - padH * 2) / Math.max(1, row.w)));
  const sy = Math.min(MAX_SY, 1 + (sx - 1) * 0.1);
  const pad = cap * sy * PAD_V;
  const amp = L.size * 0.045;
  const top = base - (base - row.y) * sy - pad - amp;
  const bot = base + (row.y + row.h - base) * sy + pad + amp;
  // where the row's ink starts once stretched: centred in the band
  const inkX = x0 + (bandW - row.w * sx) / 2;
  return { words, row, x0, x1, bandW, base, sx, sy, top, bot, amp, inkX };
}

/** how far past the ink the bands, the pill above them and the stretch reach (see TypeKit.reach) */
export function printReach(L: TypeLayout, medium: KitLine['medium'], W: number, H: number): Insets {
  const box = rowsBox(L, 0);
  const cap = lineCap(L.words);
  const pad = platePad(cap);
  if (L.role === 'caption') {
    const p = panelOf(L);
    return { l: box.x0 - p.x0 + 1, t: box.y0 - p.y0 + 1, r: p.x1 - box.x1 + L.size * 0.12 + 1, b: p.y1 - box.y1 + L.size * 0.14 + 1 };
  }
  if (L.role === 'display' && medium === 'big' && L.rows.length) {
    // the bands themselves always span the safe area; up and down they reach past the ink
    const first = bandOf(L, 0, W, H);
    const last = bandOf(L, L.rows.length - 1, W, H);
    const pl = pillOf(L, W, H, first.top);
    return { l: pad.h, r: pad.h, t: box.y0 - Math.min(first.top, pl.y) + 1, b: last.bot - box.y1 + 1 };
  }
  // stacked copies and offset shadows step down and right
  const big = Math.max(...L.words.map((w) => w.size));
  const d = L.role === 'aside' ? L.size * 0.08 : big * 0.06 * 3 + Math.max(2, big * 0.03);
  return { l: 2, t: 2, r: d + 2, b: d + 2 };
}

function drawBands(k: KitLine) {
  const { g, L, t, alpha, W, H } = k;
  const inks = printInks(k.pal);
  const size = L.size;
  let firstTop = Infinity;
  L.rows.forEach((_, ri) => {
    const b = bandOf(L, ri, W, H);
    const { words, x0, bandW, base, sx, sy, top, bot, amp } = b;
    firstTop = Math.min(firstTop, top);
    if (!words.length) return;
    const first = words[0];
    // the band comes in when its first word is sung
    const age = t - first.t;
    if (age < 0) return;
    const grow = easeOut(clamp01(age / 0.22));
    const band = inks[(ri + k.seed) % inks.length];
    const ink = onBand(band);
    const ph = hash1(k.seed + ri * 13) * 6.28;
    g.save();
    g.globalAlpha = alpha;
    // the band: wavy top and bottom, wiping in from the left as the row starts
    const bx1 = x0 + bandW * grow;
    const p = new Path2D();
    p.moveTo(x0, top + wave(x0, W, amp, ph));
    for (let x = x0; x <= bx1; x += W / 48) p.lineTo(x, top + wave(x, W, amp, ph));
    p.lineTo(bx1, top + wave(bx1, W, amp, ph));
    p.lineTo(bx1, bot + wave(bx1, W, amp, ph + 1.3));
    for (let x = bx1; x >= x0; x -= W / 48) p.lineTo(x, bot + wave(x, W, amp, ph + 1.3));
    p.lineTo(x0, bot + wave(x0, W, amp, ph + 1.3));
    p.closePath();
    g.fillStyle = css(band);
    g.fill(p);
    g.lineWidth = Math.max(1.5, size * 0.03);
    g.strokeStyle = css(KEY);
    g.stroke(p);
    notePlate(g, { x0, y0: top + amp, x1: x0 + bandW, y1: bot - amp }, lineCap(words) * sy, 'print band');
    g.clip(p);
    // the words stretched across the band edge to edge (never more than 2.4 times their width), with
    // the plate rule's padding at each end
    g.fillStyle = css(ink);
    g.textBaseline = 'alphabetic';
    for (const w of words) {
      const a = arrival(L, w, t);
      if (!a.on) continue;
      g.save();
      g.translate(b.inkX + (w.x - b.row.x) * sx, base + a.dy);
      g.scale(sx, sy);
      wordFont(g, w);
      g.globalAlpha = alpha * a.op;
      g.fillText(w.text, 0, 0);
      g.restore();
    }
    g.restore();
  });
  pill(k, inks, firstTop);
}

/** the pill's size and place: on the safe area's left edge, a clear gap above the first band */
function pillOf(L: TypeLayout, W: number, H: number, bandTop: number) {
  const fs = Math.max(12, Math.min(L.size * 0.3, W * 0.028));
  const ph = fs * 1.7;
  return { fs, ph, x: safeInsets(W, H).l, y: bandTop - fs * 0.6 - ph };
}

/** a small pill label with the part's name, by the line */
function pill(k: KitLine, inks: RGB[], bandTop: number) {
  const { g, L, t, W, H, facts } = k;
  const { fs, ph, x, y } = pillOf(L, W, H, bandTop);
  g.save();
  g.font = `650 ${fs.toFixed(1)}px ${TEXT}`;
  g.letterSpacing = `${(fs * 0.14).toFixed(1)}px`;
  const label = facts.part.toUpperCase();
  const tw = g.measureText(label).width - fs * 0.14;
  const pw = tw + fs * 1.6;
  g.globalAlpha = k.alpha * clamp01((t - k.start) / 0.3);
  roundRect(g, x, y, pw, ph, ph / 2);
  g.fillStyle = css(PAPER);
  g.fill();
  g.lineWidth = Math.max(1.5, fs * 0.12);
  g.strokeStyle = css(KEY);
  g.stroke();
  notePlate(g, { x0: x, y0: y, x1: x + pw, y1: y + ph }, fs * 0.7, 'print pill');
  g.fillStyle = css(mix(KEY, inks[0], 0.15));
  g.textBaseline = 'middle';
  g.fillText(label, x + fs * 0.8, y + ph / 2 + fs * 0.05);
  g.restore();
}

/* ───────────────────────── giant: stacked outlines ───────────────────────── */

function drawStack(k: KitLine) {
  const { g, L, t, alpha } = k;
  const inks = printInks(k.pal);
  const fill = k.light ? mix(PAPER, inks[0], 0.35) : PAPER;
  g.save();
  g.textBaseline = 'alphabetic';
  for (const w of L.words) {
    const a = arrival(L, w, t);
    if (!a.on) continue;
    g.globalAlpha = alpha * a.op;
    wordFont(g, w);
    if (w.part === 'kicker') {
      g.lineJoin = 'round';
      g.lineWidth = Math.max(2, w.size * 0.22);
      g.strokeStyle = css(PAPER);
      g.strokeText(w.text, w.x, w.y + a.dy);
      g.fillStyle = css(KEY);
      g.fillText(w.text, w.x, w.y + a.dy);
      continue;
    }
    const masked = a.wipe < 1;
    if (masked) {
      g.save();
      g.beginPath();
      g.rect(w.x - w.size * 0.2, w.y - w.size * 1.2, (w.w + w.size * 0.6) * a.wipe, w.size * 1.9);
      g.clip();
    }
    const d = w.size * 0.06;
    const keyW = Math.max(2, w.size * 0.03);
    g.lineJoin = 'round';
    g.lineWidth = keyW;
    g.strokeStyle = css(KEY);
    // back to front: three ink copies stepping down-right, each slightly off register (it jumps a
    // little every eighth of a second, like a drum turning)
    const tick = Math.floor(t * 8);
    for (let i = 3; i >= 0; i--) {
      const jx = i ? (hash1(tick * 7 + i) - 0.5) * d * 0.35 : 0;
      const jy = i ? (hash1(tick * 11 + i * 3) - 0.5) * d * 0.35 : 0;
      const x = w.x + i * d + jx;
      const y = w.y + a.dy + i * d + jy;
      g.strokeText(w.text, x, y);
      g.fillStyle = css(i ? inks[(i - 1) % inks.length] : fill);
      g.fillText(w.text, x, y);
    }
    if (masked) g.restore();
  }
  g.letterSpacing = '0px';
  g.restore();
}

/* ───────────────────────── subtitle: rounded panel ───────────────────────── */

/**
 * The caption panel round the rows' ink: padded by the plate rule, a little more at the ends so the
 * rounded corners stay clear of the first and last letters
 */
function panelOf(L: TypeLayout) {
  const box = rowsBox(L, 0);
  const cap = lineCap(L.words);
  // the print finishes (riso, ink wash) redraw the frame: the wash eats the panel's edge and the
  // letters bleed fatter, so what is left round them on screen is well under what was drawn. The
  // panel is drawn with twice the plate rule's padding so that, after the finish, the rule still holds.
  const rule = platePad(cap);
  const pad = { v: rule.v * 2, h: rule.h * 1.5 };
  const h = box.y1 - box.y0 + pad.v * 2;
  const r = Math.min(L.size * 0.6, h / 2);
  const ph = Math.max(pad.h, r * 0.75);
  return { x0: box.x0 - ph, y0: box.y0 - pad.v, x1: box.x1 + ph, y1: box.y1 + pad.v, r, cap };
}

function drawPanel(k: KitLine) {
  const { g, L, t, alpha } = k;
  const inks = printInks(k.pal);
  const size = L.size;
  const box = panelOf(L);
  g.save();
  g.globalAlpha = alpha;
  roundRect(g, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, box.r);
  // a step of ink behind the panel, out of register like the rest of the print
  g.save();
  g.translate(size * 0.12, size * 0.14);
  g.fillStyle = css(inks[0]);
  g.fill();
  g.restore();
  // the panel is a solid ink with paper letters: the riso and ink finishes dither mid-tones and thin
  // dark strokes into dots, but a flat ink and fat paper-white letters come through whole
  const deep = [...inks].sort((a, b) => lum(a) - lum(b))[0];
  const panel = reach(deep, [0, 0, 0], 0, 0.16);
  g.fillStyle = css(panel);
  g.fill();
  g.lineWidth = Math.max(1.5, size * 0.07);
  g.strokeStyle = css(KEY);
  g.stroke();
  notePlate(g, box, box.cap, 'print panel');
  g.textBaseline = 'alphabetic';
  for (const w of L.words) {
    const a = arrival(L, w, t);
    wordFont(g, w);
    // unsung words half-way into the panel, sung ones in paper
    g.fillStyle = css(a.p >= 1 ? PAPER : mix(panel, PAPER, 0.45 + 0.55 * a.p));
    g.fillText(w.text, w.x, w.y);
  }
  g.letterSpacing = '0px';
  g.restore();
}

/* ───────────────────────── sparse ───────────────────────── */

function drawAside(k: KitLine) {
  const { g, L, t, alpha } = k;
  const inks = printInks(k.pal);
  const ink: RGB = k.light ? PAPER : KEY;
  const back = reach(inks[0], k.light ? [0, 0, 0] : [255, 255, 255], k.light ? 0 : 0.35, k.light ? 0.3 : 1);
  g.save();
  g.textBaseline = 'alphabetic';
  for (const w of L.words) {
    const a = arrival(L, w, t);
    if (!a.on) continue;
    wordFont(g, w);
    const d = w.size * 0.08;
    g.globalAlpha = alpha * a.op;
    g.fillStyle = css(back);
    g.fillText(w.text, w.x + d, w.y + a.dy + d);
    g.fillStyle = css(ink);
    g.fillText(w.text, w.x, w.y + a.dy);
  }
  g.letterSpacing = '0px';
  g.restore();
}

export function drawPrint(k: KitLine) {
  const r = k.L.role;
  if (r === 'caption') drawPanel(k);
  else if (r === 'aside') drawAside(k);
  else if (r === 'display' && k.medium === 'big') drawBands(k);
  else drawStack(k);
}

/* ───────────────────────── without panels ───────────────────────── */

/**
 * The same fat letters with nothing behind them (Panels and bands switched off): paper on a dark keyline
 * as thick as a stroke, which holds on black, white and everything between, and one ink out of register.
 */
export function drawPrintBare(k: KitLine) {
  const r = k.L.role;
  if (r === 'aside') return drawAside(k);
  if (r !== 'caption') return drawStack(k);
  const { g, L, t, alpha } = k;
  const back = printInks(k.pal)[0];
  g.save();
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  for (const pass of [0, 1, 2])
    for (const w of L.words) {
      const a = arrival(L, w, t);
      wordFont(g, w);
      // (words still to come stand a little back, never so far that they can't be read)
      g.globalAlpha = alpha * (0.72 + 0.28 * a.p);
      const d = w.size * 0.07;
      g.lineWidth = Math.max(2, w.size * 0.2);
      if (pass === 0) {
        g.strokeStyle = g.fillStyle = css(back);
        g.lineWidth *= 0.6;
        g.strokeText(w.text, w.x + d, w.y + d);
        g.fillText(w.text, w.x + d, w.y + d);
      } else if (pass === 1) {
        g.strokeStyle = css(KEY);
        g.strokeText(w.text, w.x, w.y);
      } else {
        g.fillStyle = css(PAPER);
        g.fillText(w.text, w.x, w.y);
      }
    }
  g.letterSpacing = '0px';
  g.restore();
}

export function printReachBare(L: TypeLayout): Insets {
  const big = Math.max(...L.words.map((w) => w.size));
  const d = L.role === 'aside' ? L.size * 0.08 : L.role === 'caption' ? L.size * 0.14 : big * 0.06 * 3 + Math.max(2, big * 0.03);
  const e = L.role === 'caption' ? L.size * 0.1 : 2;
  return { l: e, t: e, r: d + 2, b: d + 2 };
}
