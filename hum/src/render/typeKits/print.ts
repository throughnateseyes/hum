import type { Palette } from '../../core/types';
import type { Role, Voice } from '../lyricAuto';
import { KIT_FACES } from './fonts';
import { arrival, clamp01, contrast, css, easeOut, fromHsl, hash1, huesOf, lum, mix, reach, roundRect, rowsBox, toHsl, wordFont, type KitLine, type RGB } from './common';

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
  return { ...base, ...clean, family: SHOW, weight: 400, track: 0.01, case: 'upper', leading: 1.02, size: 0.08 };
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

function drawBands(k: KitLine) {
  const { g, L, t, alpha, W } = k;
  const inks = printInks(k.pal);
  const size = L.size;
  const margin = W * 0.055;
  const x0 = margin;
  const x1 = W - margin;
  const bandW = x1 - x0;
  const lh = size * 1.06;
  L.rows.forEach((row, ri) => {
    const words = L.words.filter((w) => Math.abs(w.y - (row.y + row.h * 0.78)) < row.h * 0.6);
    if (!words.length) return;
    const first = words[0];
    // the band comes in when its first word is sung
    const age = t - first.t;
    if (age < 0) return;
    const grow = easeOut(clamp01(age / 0.22));
    const band = inks[(ri + k.seed) % inks.length];
    const ink = onBand(band);
    const base = first.y;
    const top = base - size * 0.86;
    const bot = top + lh;
    const amp = size * 0.07;
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
    g.clip(p);
    // the words stretched across the band edge to edge (never more than 2.4 times their width)
    const rw = words[words.length - 1].x + words[words.length - 1].w - first.x;
    const pad = size * 0.25;
    const sx = Math.min(2.4, (bandW - pad * 2) / Math.max(1, rw));
    const sy = Math.min(1.12, 1 + (sx - 1) * 0.12);
    const startX = x0 + pad + (bandW - pad * 2 - rw * sx) / 2;
    g.fillStyle = css(ink);
    g.textBaseline = 'alphabetic';
    for (const w of words) {
      const a = arrival(L, w, t);
      if (!a.on) continue;
      g.save();
      g.translate(startX + (w.x - first.x) * sx, base + a.dy - size * 0.06);
      g.scale(sx, sy);
      wordFont(g, w);
      g.globalAlpha = alpha * a.op;
      g.fillText(w.text, 0, 0);
      g.restore();
    }
    g.restore();
  });
  pill(k, inks);
}

/** a small pill label with the part's name, by the line */
function pill(k: KitLine, inks: RGB[]) {
  const { g, L, t, W, facts } = k;
  const box = rowsBox(L, 0);
  const fs = Math.max(12, Math.min(L.size * 0.3, W * 0.028));
  g.save();
  g.font = `650 ${fs.toFixed(1)}px ${TEXT}`;
  g.letterSpacing = `${(fs * 0.14).toFixed(1)}px`;
  const label = facts.part.toUpperCase();
  const tw = g.measureText(label).width;
  const pw = tw + fs * 1.6;
  const ph = fs * 1.7;
  const x = W * 0.055;
  const y = box.y0 - L.size * 0.25 - ph - fs * 0.5;
  g.globalAlpha = k.alpha * clamp01((t - k.start) / 0.3);
  roundRect(g, x, y, pw, ph, ph / 2);
  g.fillStyle = css(PAPER);
  g.fill();
  g.lineWidth = Math.max(1.5, fs * 0.12);
  g.strokeStyle = css(KEY);
  g.stroke();
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

function drawPanel(k: KitLine) {
  const { g, L, t, alpha } = k;
  const inks = printInks(k.pal);
  const size = L.size;
  const box = rowsBox(L, size * 0.45);
  g.save();
  g.globalAlpha = alpha;
  roundRect(g, box.x0, box.y0 + size * 0.1, box.x1 - box.x0, box.y1 - box.y0, size * 0.7);
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
