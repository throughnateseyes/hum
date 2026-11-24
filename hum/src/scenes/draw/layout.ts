/**
 * Where the Sketchbook puts things. Pure: the song time, the parts, the drawings' shapes and the frame
 * decide everything, so seeking back and forth and exporting give the same picture.
 *
 * Boxes are pixels, y down.
 */
import { drawPartAt } from '../../draw/parts';
import { kindOf } from '../../draw/kinds';
import { hash, seedOf } from '../../draw/pen';
import { lineKey, type DrawingAsset, type DrawPart } from '../../draw/types';
import { safeInsets } from '../../render/lyricSpace';
import type { Showing } from '../../render/lyricTiming';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const inset = (b: Box, kx: number, ky = kx): Box => ({ x: b.x + b.w * kx, y: b.y + b.h * ky, w: b.w * (1 - 2 * kx), h: b.h * (1 - 2 * ky) });
/** `b` cut to a box of w:h = r, as large as fits, in its middle */
export function fitIn(b: Box, r: number): Box {
  const w = Math.min(b.w, b.h * r);
  const h = w / r;
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
}
export const safeBox = (W: number, H: number): Box => {
  const s = safeInsets(W, H);
  return { x: s.l, y: s.t, w: W - s.l - s.r, h: H - s.t - s.b };
};
export type Shape = 'tall' | 'wide' | 'square';
export const shapeOf = (W: number, H: number): Shape => (W / H < 0.75 ? 'tall' : W / H > 1.3 ? 'wide' : 'square');

/** a drawing's width over its height */
export function ratioOf(d: DrawingAsset): number {
  const s = kindOf(d.kind)?.size(d.data) ?? { w: 1, h: 1 };
  return s.w / s.h;
}
export const secondsOf = (d: DrawingAsset) => kindOf(d.kind)?.seconds(d.data) ?? 1.5;

/* ───────────────────────── when ───────────────────────── */

export interface Span {
  start: number;
  end: number;
  /** how many Sketchbook stretches came before, so neighbours get different drawings and layouts */
  order: number;
}

export interface SectionLike {
  start: number;
  end: number;
}

/**
 * The stretch of song the picture at time t stands for.
 * - `run` false: the part itself, cut into chunks of whole bars when it is long (one drawing each)
 * - `run` true: every neighbouring part with the same look, cut into longer chunks (a page, a board)
 */
export function spanAt(t: number, secs: SectionLike[], same: (i: number, j: number) => boolean, bar: number, run: boolean): Span {
  if (!secs.length) {
    const len = run ? 24 : 8;
    const k = Math.max(0, Math.floor(t / len));
    return { start: k * len, end: (k + 1) * len, order: k };
  }
  let i = 0;
  while (i < secs.length - 1 && t >= secs[i + 1].start) i++;
  let a = i;
  let b = i;
  if (run) {
    while (a > 0 && same(a - 1, i)) a--;
    while (b < secs.length - 1 && same(b + 1, i)) b++;
  }
  const start = secs[a].start;
  const end = secs[b].end;
  const want = run ? 22 : 5.2;
  let order = 0;
  for (let k = 0; k < a; k++) order += run ? (k === 0 || !same(k - 1, k) ? 1 : 0) : 1;
  // long stretches turn over on a bar
  const bars = Math.max(1, Math.round(want / bar));
  const len = bars * bar;
  const n = Math.max(1, Math.round((end - start) / len));
  if (n === 1) return { start, end, order };
  const k = Math.min(n - 1, Math.max(0, Math.floor((t - start) / len)));
  return { start: start + k * len, end: k === n - 1 ? end : start + (k + 1) * len, order: order + k };
}

/* ───────────────────────── which drawings ───────────────────────── */

/** the drawings sung about between two times, in the order they come up */
export function sungIn(list: DrawingAsset[], shows: Showing[], start: number, end: number): DrawingAsset[] {
  const out: DrawingAsset[] = [];
  for (const s of shows) {
    // a line that was mostly sung before this stretch belongs to the one before
    if (s.t >= end - 0.3 || s.t < start - 0.5) continue;
    for (const d of list) if (!out.includes(d) && belongsTo(d, s)) out.push(d);
  }
  return out;
}

/** does this drawing belong to what is being sung? */
export function belongsTo(d: DrawingAsset, s: Showing): boolean {
  const text = ` ${lineKey(s.text)} `;
  return d.words.some((w) => text.includes(` ${w} `)) || d.lines.some((l) => l && text.includes(` ${l} `));
}

/**
 * The drawings for a stretch: the ones the person picked for it, else what is sung in it, then what it was
 * drawn for, then the rest dealt round so that neighbouring stretches show different ones.
 */
export function deal(list: DrawingAsset[], span: Span, shows: Showing[], picks: DrawPart[], now: (id: string) => DrawingAsset | null): DrawingAsset[] {
  const mid = (span.start + span.end) / 2;
  const ids = drawPartAt(picks, mid)?.ids;
  if (ids?.length) {
    const own = ids.flatMap((id) => now(id) ?? []);
    if (own.length) return own.map((_, i) => own[(i + span.order) % own.length]);
  }
  if (!list.length) return [];
  const sung = sungIn(list, shows, span.start, span.end);
  const turned = list.map((_, i) => list[(i + span.order) % list.length]);
  const meant = turned.filter((d) => d.parts.some((p) => mid >= p.start && mid < p.end));
  return [...new Set([...sung, ...meant, ...turned])];
}

/* ───────────────────────── where ───────────────────────── */

export interface Placed {
  d: DrawingAsset;
  /** the box the drawing is fitted into */
  box: Box;
  /** radians */
  turn: number;
  /** when it starts drawing itself, and how long it takes */
  t0: number;
  dur: number;
}

/** how the picture and the words share the frame */
export interface Split {
  art: Box;
  words: Box;
  align: 'left' | 'right' | 'center';
  /** where the words sit in their box */
  valign: 'top' | 'middle' | 'bottom';
}

/**
 * `share`: how much of the frame the picture takes; `ratio`: the picture's own shape, when it is one
 * drawing, so a wide drawing in a tall frame hands the room it can't use to the words.
 */
export function splitOf(W: number, H: number, variant: number, share: number, ratio?: number): Split {
  const s = safeBox(W, H);
  const gap = Math.min(W, H) * 0.045;
  const v = ((variant % 3) + 3) % 3;
  if (shapeOf(W, H) === 'wide') {
    if (ratio) share = Math.min(share, Math.max(0.42, (s.h * ratio * 1.06) / s.w));
    const ww = s.w * (1 - share) - gap / 2;
    const left = v === 1;
    return {
      art: { x: left ? s.x + ww + gap : s.x, y: s.y, w: s.w - ww - gap, h: s.h },
      words: { x: left ? s.x : s.x + s.w - ww, y: s.y, w: ww, h: s.h },
      align: 'left',
      valign: v === 0 ? 'middle' : v === 1 ? 'bottom' : 'top',
    };
  }
  if (ratio) share = Math.min(share, Math.max(0.42, ((s.w / ratio) * 1.06) / s.h));
  const wh = s.h * (1 - share) - gap / 2;
  const top = v === 1;
  return {
    art: { x: s.x, y: top ? s.y + wh + gap : s.y, w: s.w, h: s.h - wh - gap },
    words: { x: s.x, y: top ? s.y : s.y + s.h - wh, w: s.w, h: wh },
    align: 'left',
    valign: top ? 'top' : 'bottom',
  };
}

export const PAGE_MAX = 6;

/**
 * Put the drawings on a page in rows that fill it: every row runs the full width with its drawings at one
 * height (plus a little give), so shapes decide the rows and no slot is left half empty. The order is kept,
 * because it is the order they are sung in.
 */
export function pageOf(list: DrawingAsset[], region: Box, seed: number, name: number): { d: DrawingAsset; box: Box; turn: number }[] {
  const n = Math.min(PAGE_MAX, list.length);
  if (!n) return [];
  const ds = list.slice(0, n);
  // very tall or wide drawings give a little, so one can't own the page
  const r = ds.map((d) => Math.min(2.1, Math.max(0.55, ratioOf(d))));
  const gap = Math.min(region.w, region.h) * 0.05;
  let best: { rows: number[][]; heights: number[]; score: number } | null = null;
  for (let cut = 0; cut < 1 << (n - 1); cut++) {
    const rows: number[][] = [[0]];
    for (let i = 1; i < n; i++) if ((cut >> (i - 1)) & 1) rows.push([i]);
      else rows[rows.length - 1].push(i);
    const room = region.h - gap * (rows.length - 1) - name * 1.7 * rows.length;
    const full = rows.map((row) => (region.w - gap * (row.length - 1)) / row.reduce((x, i) => x + r[i], 0));
    // nothing gets more than about half the page unless it is alone
    const cap = region.h * (n === 1 ? 1 : n === 2 ? 0.6 : 0.46);
    let heights = full.map((h) => Math.min(h, cap));
    const total = heights.reduce((x, h) => x + h, 0);
    const k = Math.min(1, room / total);
    heights = heights.map((h) => h * k);
    // how much of the page is drawn on, less a little for rows that are all alike
    const area = rows.reduce((x, row, j) => x + row.reduce((y, i) => y + Math.min(1.6, r[i]) * heights[j] ** 2, 0), 0);
    const alike = rows.length > 1 && rows.every((row) => row.length === rows[0].length) ? 0.07 : 0;
    const score = area / (region.w * region.h) - alike + hash(seed, 5, cut) * 0.03;
    if (!best || score > best.score) best = { rows, heights, score };
  }
  const { rows, heights } = best!;
  const used = heights.reduce((x, h) => x + h + name * 1.7, 0);
  const air = rows.length > 1 ? Math.min(gap * 2.2, (region.h - used) / (rows.length - 1)) : 0;
  let y = region.y + (region.h - used - air * (rows.length - 1)) / 2;
  const out: { d: DrawingAsset; box: Box; turn: number }[] = [];
  rows.forEach((row, j) => {
    const h = heights[j];
    const widths = row.map((i) => r[i] * h);
    const sum = widths.reduce((x, w) => x + w, 0);
    const side = row.length > 1 ? (region.w - sum) / (row.length - 1) : 0;
    const gapX = Math.min(side, gap * 2.4);
    const slack = region.w - sum - gapX * (row.length - 1);
    // a row with room to spare leans to one side rather than sitting dead centre
    let x = region.x + slack * (0.25 + 0.5 * hash(seed, 13, j));
    row.forEach((i, c) => {
      out.push({ d: ds[i], box: { x, y, w: widths[c], h: h + name * 1.7 }, turn: (hash(seed, 11, i) - 0.5) * 0.07 });
      x += widths[c] + gapX;
    });
    y += h + name * 1.7 + air;
  });
  return out;
}

/** a number from text, steady between visits */
export const steady = (...parts: (string | number)[]) => seedOf(parts.join('|')) % 100000;
