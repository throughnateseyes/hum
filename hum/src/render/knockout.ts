import type { Palette } from '../core/types';
import { seeded } from '../state/lyricPlan';
import { FACES } from './lyricFonts';
import type { Treatment } from './lyricAuto';
import { NEAR_BLACK, PAPER, hexRGB, lumOf, ratio, type RGB, type Rect, type RegionStats } from './legibility';

/**
 * Knockout: lyric type as the picture's main element. One word at a time, set enormous, filling the
 * frame edge to edge and often cropped by it. Each word lands on its sung time with a hard, physical
 * arrival (it falls onto the page, overshoots and settles in a few frames, never a fade) and knocks
 * the word before it out of the way (pushed off, squashed flat or cut in half). Between words the
 * type holds still, apart from a small nudge on each kick.
 *
 * A word's size follows the music: long held words are biggest and in the heavy weight, quick words
 * ride in small (two short ones sit above the next big word as a kicker; three or more quick ones
 * stack into a justified column), and the part's energy and the loudness at the word scale it.
 *
 * Type rules: one family per video (the song's lyric family), two weights at most, very tight
 * tracking that gets tighter as the size grows, ink edges aligned to the frame's margins (not the
 * glyph boxes), and either capitals or the words as written for a whole part, never both.
 *
 * Legibility: solid ink from the guard (legibility.ts), which adds a shadow or a scrim only when the
 * picture asks for it. The big held words, and every word when the picture is too busy for ink, are
 * "knocked out" instead: a flat field in one of the palette's colours covers the frame and the
 * letters are cut out of it, so the look shows through the words. That is where the name comes from.
 *
 * Everything here is a pure function of song time (the layout is fixed per showing; drawKnockout
 * only reads t and the kick), so offline renders match what plays.
 */

export interface KWord {
  text: string;
  t: number;
  end: number;
}

/** a word falls onto the page for this long before it lands on its sung time (s) */
const FALL = 0.05;
/** the word that's knocked out takes this long to leave once the next one lands (s) */
const OUT = 0.08;
/** how long the landing's overshoot rings (s) */
const SETTLE = 0.24;

interface KVoice {
  family: string;
  /** the two weights: normal and heavy */
  weights: [number, number];
  /** the heavy one is the italic (Instrument Serif has a single weight) */
  italicHeavy?: boolean;
  stretch?: CanvasFontStretch;
  /** tracking (em) at a modest size and at the biggest: tighter as it grows */
  track: [number, number];
  caps: 'always' | 'never' | 'maybe';
}

/** the song's family, set for huge sizes */
function voiceOf(family: string | undefined): KVoice {
  if (family === 'serif') return { family: FACES.instrument, weights: [400, 400], italicHeavy: true, track: [-0.015, -0.04], caps: 'never' };
  if (family === 'condensed') return { family: FACES.archivo, weights: [700, 900], stretch: 'extra-condensed', track: [0, -0.02], caps: 'always' };
  if (family === 'mono' || family === 'typewriter') return { family: FACES.mono, weights: [500, 800], track: [-0.04, -0.08], caps: 'never' };
  if (family === 'hand') return { family: FACES.hand, weights: [600, 700], track: [0, -0.015], caps: 'never' };
  return { family: FACES.tight, weights: [600, 900], track: [-0.02, -0.042], caps: 'maybe' };
}

/** capitals or as written, for a whole part: condensed is always capitals, serif and mono never, grotesk by the part's dice */
export function knockoutCaps(family: string | undefined, motion: Treatment, partSeed: number): boolean {
  const v = voiceOf(family);
  if (v.caps !== 'maybe') return v.caps === 'always';
  const r = seeded(partSeed ^ 0x5bd1e995)();
  return motion === 'aggressive' ? r < 0.75 : motion === 'punchy' ? r < 0.4 : r < 0.15;
}

export interface KRow {
  text: string;
  /** lands at (song time) */
  t: number;
  size: number;
  weight: number;
  italic: boolean;
  /** tracking, em */
  track: number;
  /** pen position (left, baseline) */
  x: number;
  y: number;
  /** ink box (px) */
  ink: { x0: number; y0: number; x1: number; y1: number };
  /** the point it lands on (scales about it) */
  px: number;
}

export interface KCard {
  /** first row lands */
  t: number;
  /** the next card lands then and knocks this one out (or the showing ends) */
  until: number;
  rows: KRow[];
  /** field colour when the letters are cut out of a flat field (null: solid ink) */
  field: RGB | null;
  exit: 'push' | 'squash' | 'cut';
  axis: 'x' | 'y';
  dir: 1 | -1;
  /** the big held word, in the accent when it reads */
  accent: boolean;
  /** ink box of all its rows */
  box: { x0: number; y0: number; x1: number; y1: number };
}

export interface KnockoutLayout {
  family: string;
  stretch?: CanvasFontStretch;
  cards: KCard[];
  /** normalized box around every card (for the guard and the windows) */
  rect: Rect;
  /** a reading size for shadows (huge type takes a shadow no wider than this) */
  shadowSize: number;
}

export interface KnockoutOpts {
  W: number;
  H: number;
  family?: string;
  caps: boolean;
  /** the part's energy against the song's loudest part, 0..1 */
  energy: number;
  /** loudness at a song time, 0..1 */
  loud: (t: number) => number;
  seed: number;
  /** the showing's end (song time): its last card leaves then */
  end: number;
  pal: Palette;
  /** the picture under the band at layout time (null: not sampled yet) */
  pic: RegionStats | null;
  /** the picture needs more than a shadow for solid ink: knock every word out of a field */
  needsField: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').length;

/** a word alone on the frame: no trailing comma or full stop, no quotes round it (? and ! stay) */
const clean = (s: string, caps: boolean) => {
  const t = s.replace(/^["“‘'(]+/u, '').replace(/["”’)]+$/u, '').replace(/[,;:.]+$/u, '') || s;
  return caps ? t.toUpperCase() : t;
};

interface Ink {
  /** ink left / right of the pen, top / bottom of the baseline, at 100 px */
  x0: number;
  x1: number;
  asc: number;
  desc: number;
}

function font(v: KVoice, size: number, weight: number, italic: boolean) {
  return `${italic ? 'italic ' : ''}${weight} ${size.toFixed(1)}px ${v.family}`;
}

/** the word's ink box at 100 px (metrics scale with the size) */
function inkOf(g: CanvasRenderingContext2D, v: KVoice, text: string, weight: number, italic: boolean, track: number): Ink {
  g.font = font(v, 100, weight, italic);
  g.fontStretch = v.stretch ?? 'normal';
  g.letterSpacing = `${(track * 100).toFixed(2)}px`;
  const m = g.measureText(text);
  g.letterSpacing = '0px';
  g.fontStretch = 'normal';
  return { x0: -m.actualBoundingBoxLeft, x1: m.actualBoundingBoxRight, asc: m.actualBoundingBoxAscent, desc: m.actualBoundingBoxDescent };
}

/** the field the letters are cut from: a palette colour that stands well apart from the picture */
export function fieldFor(pal: Palette, pic: RegionStats | null): RGB | null {
  if (!pic) return null;
  const cands: RGB[] = [hexRGB(pal.accent), hexRGB(pal.bg), hexRGB(pal.fg), hexRGB(pal.accent2), NEAR_BLACK, PAPER];
  for (const c of cands) {
    const L = lumOf(c);
    // the picture inside the letters must read against the field, its dark and light parts both
    const worst = L > pic.mean ? ratio(L, pic.hi) : ratio(L, pic.lo);
    if (ratio(L, pic.mean) >= 3.2 && worst >= 1.8) return c;
  }
  return null;
}

/**
 * Lay a showing out as cards. Pure: the same words, options and seed give the same cards.
 */
export function buildKnockout(g: CanvasRenderingContext2D, words: KWord[], o: KnockoutOpts): KnockoutLayout {
  const { W, H } = o;
  const v = voiceOf(o.family);
  const R = seeded(o.seed);
  const portrait = H > W * 1.2;
  // the band type lives in: tall frames keep clear of the top bar and the captions and buttons at the bottom
  const band = portrait ? { y0: H * 0.2, y1: H * 0.76 } : { y0: H * 0.12, y1: H * 0.9 };
  const bandH = band.y1 - band.y0;
  const mx = Math.round(W * (portrait ? 0.07 : 0.06));
  const availW = W - mx * 2;
  const n = words.length;
  const gapAt = (i: number) => (i + 1 < n ? words[i + 1].t : o.end) - words[i].t;
  const quick = (i: number) => gapAt(i) < 0.34 && letters(words[i].text) <= 6;
  const field = fieldFor(o.pal, o.pic);
  const capH = inkOf(g, v, 'H', v.weights[1], false, 0).asc / 100;

  // group the words: a lone word per card; quick words ride above the next one, or stack up
  type Group = { kind: 'solo' | 'kick' | 'stack'; idx: number[] };
  const groups: Group[] = [];
  let pend: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < n - 1 && quick(i)) {
      pend.push(i);
      continue;
    }
    const pl = pend.reduce((a, k) => a + letters(words[k].text), 0);
    if (pend.length >= 3 || (pend.length === 2 && pl > 8)) {
      groups.push({ kind: 'stack', idx: pend });
      groups.push({ kind: 'solo', idx: [i] });
    } else if (pend.length) groups.push({ kind: 'kick', idx: [...pend, i] });
    else groups.push({ kind: 'solo', idx: [i] });
    pend = [];
  }

  const cards: KCard[] = [];
  let lastAlign = '';
  let lastField = false;
  groups.forEach((gr, gi) => {
    const nextT = gi + 1 < groups.length ? words[groups[gi + 1].idx[0]].t : o.end;
    const rows: KRow[] = [];
    const heroI = gr.idx[gr.idx.length - 1];
    const hw = words[heroI];
    // how much this word weighs: how long it's held, how loud it is there, how big the part is
    const hold = Math.min(gapAt(heroI), hw.end - hw.t + 0.15);
    const e = clamp01((hold - 0.3) / 1.3);
    const s = gr.kind === 'stack' ? 0.3 : clamp01(0.15 + 0.7 * e + 0.15 * o.loud(hw.t)) * (0.72 + 0.28 * o.energy);
    const heavy = s > 0.48;
    const weight = heavy ? v.weights[1] : v.weights[0];
    const italic = !!v.italicHeavy && heavy;
    const track = lerp(v.track[0], v.track[1], s);

    // alignment: mostly on the left margin, sometimes the right or the middle; not the same twice running
    let align: 'left' | 'right' | 'center' = R() < 0.55 ? 'left' : R() < 0.55 ? 'center' : 'right';
    if (align === lastAlign && R() < 0.6) align = align === 'left' ? (R() < 0.5 ? 'right' : 'center') : 'left';
    lastAlign = align;
    const penX = (ink: Ink, size: number) => {
      const k = size / 100;
      return align === 'left' ? mx - ink.x0 * k : align === 'right' ? W - mx - ink.x1 * k : W / 2 - ((ink.x0 + ink.x1) / 2) * k;
    };
    const anchorX = (x: number, ink: Ink, size: number) => {
      const k = size / 100;
      return align === 'left' ? x + ink.x0 * k : align === 'right' ? x + ink.x1 * k : x + ((ink.x0 + ink.x1) / 2) * k;
    };
    const place = (text: string, t: number, size: number, wt: number, it: boolean, tr: number, ink: Ink, y: number): KRow => {
      const x = penX(ink, size);
      const k = size / 100;
      return { text, t, size, weight: wt, italic: it, track: tr, x, y, ink: { x0: x + ink.x0 * k, x1: x + ink.x1 * k, y0: y - ink.asc * k, y1: y + ink.desc * k }, px: anchorX(x, ink, size) };
    };

    if (gr.kind === 'stack') {
      // a justified column: every word set to the same width, so the sizes differ row to row
      const colW = availW * (portrait ? 0.72 + 0.16 * R() : 0.42 + 0.16 * R());
      const texts = gr.idx.map((i) => clean(words[i].text, o.caps));
      const inks = texts.map((t) => inkOf(g, v, t, v.weights[1], false, v.track[0]));
      let sizes = inks.map((ink) => (100 * colW) / Math.max(1, ink.x1 - ink.x0));
      const minS = Math.min(...sizes);
      sizes = sizes.map((z) => Math.min(z, minS * 1.6));
      const lead = 0.14;
      const total = sizes.reduce((a, z) => a + z * capH * (1 + lead), 0);
      const fit = Math.min(1, (bandH * 0.86) / Math.max(1, total));
      sizes = sizes.map((z) => z * fit);
      const blockH = sizes.reduce((a, z) => a + z * capH * (1 + lead), 0) - sizes[sizes.length - 1] * capH * lead;
      let y = band.y0 + (bandH - blockH) * (0.35 + 0.3 * R());
      gr.idx.forEach((wi, r) => {
        y += sizes[r] * capH;
        rows.push(place(texts[r], words[wi].t, sizes[r], v.weights[1], false, v.track[0], inks[r], y));
        y += sizes[r] * capH * lead;
      });
    } else {
      const text = clean(hw.text, o.caps);
      const ink = inkOf(g, v, text, weight, italic, track);
      const inkW = Math.max(1, ink.x1 - ink.x0);
      // as wide as the frame, and wider for the big held words: cropped by its right edge. The crop only
      // ever takes part of the last letter, so the word still reads
      const fill = portrait ? 0.92 + 0.5 * s : 0.72 + 0.48 * s;
      const letterW = inkW / Math.max(1, letters(text));
      let size = (100 * availW * fill) / inkW;
      size = Math.min(size, (100 * (W - mx)) / Math.max(1, inkW - 0.3 * letterW));
      const kick = gr.kind === 'kick';
      const hMax = bandH * (kick ? 0.62 : 0.86) * (0.6 + 0.4 * s);
      size = Math.min(size, hMax / capH);
      const k = size / 100;
      // too wide for the margins: hang it from the left margin and let the frame crop its end
      if (inkW * k > availW + 1) align = 'left';
      // the kicker: the quick words before it, small, on a line above it, each landing on its own time
      let kickH = 0;
      let kinks: Ink[] = [];
      let ks = 0;
      let ktexts: string[] = [];
      if (kick) {
        ktexts = gr.idx.slice(0, -1).map((i) => clean(words[i].text, o.caps));
        ks = Math.max(Math.min(W, H) * 0.045, size * 0.3);
        const line = ktexts.join(' ');
        const lw = inkOf(g, v, line, v.weights[0], false, v.track[0]);
        ks = Math.min(ks, (100 * availW) / Math.max(1, lw.x1 - lw.x0));
        kinks = ktexts.map((t) => inkOf(g, v, t, v.weights[0], false, v.track[0]));
        kickH = ks * capH * 1.3;
      }
      const blockH = kickH + ink.asc * k + ink.desc * k;
      const top = band.y0 + Math.max(0, bandH - blockH) * (0.25 + 0.5 * R());
      const base = top + kickH + ink.asc * k;
      if (kick) {
        // laid out as one line on the hero's edge; each word is its own row so it lands on its own time
        const ky = top + ks * capH;
        g.font = font(v, ks, v.weights[0], false);
        g.letterSpacing = `${(v.track[0] * ks).toFixed(2)}px`;
        const space = g.measureText(' ').width;
        g.letterSpacing = '0px';
        const widths = kinks.map((q) => ((q.x1 - q.x0) * ks) / 100);
        const lineW = widths.reduce((a, b) => a + b, 0) + space * (widths.length - 1);
        const heroInk = { x0: penX(ink, size) + ink.x0 * k, x1: penX(ink, size) + ink.x1 * k };
        let x = align === 'left' ? Math.max(mx, heroInk.x0) : align === 'right' ? Math.min(W - mx, heroInk.x1) - lineW : W / 2 - lineW / 2;
        ktexts.forEach((t, j) => {
          const q = kinks[j];
          const pen = x - (q.x0 * ks) / 100;
          rows.push({ text: t, t: words[gr.idx[j]].t, size: ks, weight: v.weights[0], italic: false, track: v.track[0], x: pen, y: ky, ink: { x0: x, x1: x + widths[j], y0: ky - (q.asc * ks) / 100, y1: ky + (q.desc * ks) / 100 }, px: x + widths[j] / 2 });
          x += widths[j] + space;
        });
      }
      rows.push(place(text, hw.t, size, weight, italic, track, ink, base));
    }

    const box = {
      x0: Math.min(...rows.map((r) => r.ink.x0)),
      y0: Math.min(...rows.map((r) => r.ink.y0)),
      x1: Math.max(...rows.map((r) => r.ink.x1)),
      y1: Math.max(...rows.map((r) => r.ink.y1)),
    };
    // the big held words are cut out of a field; every word is when the picture is too busy for ink
    const wantField = field && gr.kind !== 'stack' && (o.needsField || (s > 0.62 && !lastField && R() < 0.8));
    lastField = !!wantField;
    // how it's knocked out: pushed off (up mostly), squashed flat by the next word, or cut in half
    const r = R();
    const exit: KCard['exit'] = wantField ? 'push' : r < 0.45 ? 'push' : r < 0.75 ? 'squash' : 'cut';
    const axis: KCard['axis'] = exit === 'push' && R() < 0.3 ? 'x' : 'y';
    const dir: 1 | -1 = axis === 'y' ? (R() < 0.8 ? -1 : 1) : R() < 0.5 ? -1 : 1;
    cards.push({ t: rows[0].t, until: nextT, rows, field: wantField ? field : null, exit, axis, dir, accent: !wantField && s > 0.78, box });
  });

  const all = cards.flatMap((c) => [c.box]);
  const rect: Rect = all.length
    ? {
        x0: clamp01(Math.min(...all.map((b) => b.x0)) / W - 0.01),
        y0: clamp01(Math.min(...all.map((b) => b.y0)) / H - 0.01),
        x1: clamp01(Math.max(...all.map((b) => b.x1)) / W + 0.01),
        y1: clamp01(Math.max(...all.map((b) => b.y1)) / H + 0.01),
      }
    : { x0: 0.1, y0: 0.4, x1: 0.9, y1: 0.6 };
  return { family: v.family, stretch: v.stretch, cards, rect, shadowSize: Math.min(W, H) * 0.04 };
}

/** the last card of the showing before, to be knocked out by this showing's first word */
export function withLead(L: KnockoutLayout, prev: KnockoutLayout | null): KnockoutLayout {
  const last = prev?.cards[prev.cards.length - 1];
  if (!last || !L.cards.length) return L;
  return { ...L, cards: [{ ...last, until: Math.min(last.until, L.cards[0].t) }, ...L.cards] };
}

/** is anything moving at song time t? (otherwise the layer keeps its last drawing) */
export function knockoutMoving(L: KnockoutLayout, t: number): boolean {
  for (const c of L.cards) {
    if (t < c.t - FALL - 0.02 || t > c.until + OUT + 0.02) continue;
    if (t > c.until - FALL) return true;
    for (const r of c.rows) if (t > r.t - FALL - 0.02 && t < r.t + SETTLE) return true;
  }
  return false;
}

/** the kick nudge in coarse steps: the layer redraws a held word only when this changes */
export const kickStep = (kick: number) => Math.round(Math.min(1, kick) * 6) / 6;

/** the ink boxes up at song time t (for scrims, when the guard asks for one) */
export function knockoutBoxes(L: KnockoutLayout, t: number): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const c of L.cards) {
    if (c.field || t < c.t - FALL || t >= c.until) continue;
    for (const r of c.rows) if (t >= r.t - FALL) out.push({ x: r.ink.x0, y: r.ink.y0, w: r.ink.x1 - r.ink.x0, h: r.ink.y1 - r.ink.y0 });
  }
  return out;
}

export interface KInks {
  ink: string;
  accent: string;
  shadow: (g: CanvasRenderingContext2D, size: number) => void;
}

const fieldCss = (c: RGB, a: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a.toFixed(3)})`;

/**
 * The landing: the word falls onto the page (scaling down from a little bigger, speeding up), hits
 * on its sung time, squashes wide and short, rings once and settles.
 */
function landing(age: number): { sx: number; sy: number } {
  if (age < 0) {
    const u = Math.min(1, -age / FALL);
    const s = 1 + 0.24 * (1 - (1 - u) * (1 - u));
    return { sx: s, sy: s };
  }
  const ring = Math.exp(-age * 15) * Math.sin((age * 2 * Math.PI) / 0.15);
  const sy = 1 - 0.075 * ring;
  return { sx: 1 + 0.06 * ring, sy };
}

/**
 * Draw the knockout at song time t. `alpha` only fades it when a cut hands the words to a look that
 * shows them itself; arrivals and exits never fade.
 */
export function drawKnockout(g: CanvasRenderingContext2D, L: KnockoutLayout, t: number, alpha: number, c: KInks, kick: number, W: number, H: number) {
  if (alpha <= 0.01) return;
  g.save();
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  for (const card of L.cards) {
    if (t < card.t - FALL || t >= card.until + OUT) continue;
    const ex = clamp01((t - (card.until - FALL)) / (FALL + OUT));
    // accelerating out: it was hit
    const q = ex * ex;
    const b = card.box;
    g.save();
    if (ex > 0 && card.exit === 'push') {
      const dist = card.axis === 'y' ? (card.dir < 0 ? b.y1 + H * 0.02 : H - b.y0 + H * 0.02) : card.dir < 0 ? b.x1 + W * 0.02 : W - b.x0 + W * 0.02;
      const d = card.dir * dist * q;
      // squashed along the push as it goes
      const cx = (b.x0 + b.x1) / 2;
      const cy = (b.y0 + b.y1) / 2;
      if (card.axis === 'y') {
        g.translate(0, d);
        g.translate(cx, cy);
        g.scale(1 + 0.08 * q, 1 - 0.3 * q);
        g.translate(-cx, -cy);
      } else {
        g.translate(d, 0);
        g.translate(cx, cy);
        g.scale(1 - 0.3 * q, 1 + 0.06 * q);
        g.translate(-cx, -cy);
      }
    } else if (ex > 0 && card.exit === 'squash') {
      // flattened onto its baseline by the word landing on it
      const sy = Math.max(0.001, 1 - ex * ex * (3 - 2 * ex));
      g.translate(0, b.y1);
      g.scale(1 + 0.22 * ex, sy);
      g.translate(0, -b.y1);
    }
    if (card.field) {
      g.globalAlpha = alpha;
      g.fillStyle = fieldCss(card.field, 1);
      // the field is the whole frame (and more, so a push never shows its edge early)
      g.fillRect(-W * 0.02, -H * 0.02, W * 1.04, H * 1.04);
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = '#000';
      g.shadowBlur = 0;
      g.shadowColor = 'transparent';
    } else {
      g.globalAlpha = alpha;
    }
    const halves = ex > 0 && card.exit === 'cut' ? 2 : 1;
    for (let h = 0; h < halves; h++) {
      if (halves === 2) {
        // cut through the middle of the letters: the top half flies one way, the bottom the other
        const mid = (b.y0 + b.y1) / 2;
        g.save();
        g.beginPath();
        if (h === 0) g.rect(-W, -H, W * 3, mid + H);
        else g.rect(-W, mid, W * 3, H * 2);
        g.clip();
        g.translate((h === 0 ? -1 : 1) * card.dir * W * 0.9 * q, 0);
      }
      for (const r of card.rows) {
        const age = t - r.t;
        if (age < -FALL) continue;
        const { sx, sy } = landing(age);
        // kicks nudge the type a few percent once it has landed, decaying with the kick itself
        const nudge = age > 0.12 ? 1 + 0.035 * kickStep(kick) : 1;
        g.save();
        g.translate(r.px, r.y);
        g.scale(sx * nudge, sy * nudge);
        g.translate(-r.px, -r.y);
        g.font = `${r.italic ? 'italic ' : ''}${r.weight} ${r.size.toFixed(1)}px ${L.family}`;
        g.fontStretch = L.stretch ?? 'normal';
        g.letterSpacing = `${(r.track * r.size).toFixed(2)}px`;
        if (!card.field) {
          c.shadow(g, Math.min(r.size, L.shadowSize));
          g.fillStyle = card.accent && r === card.rows[card.rows.length - 1] ? c.accent : c.ink;
        }
        g.fillText(r.text, r.x, r.y);
        g.restore();
      }
      if (halves === 2) g.restore();
    }
    g.restore();
  }
  g.letterSpacing = '0px';
  g.fontStretch = 'normal';
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.shadowBlur = 0;
  g.restore();
}
