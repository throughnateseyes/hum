/**
 * Room round the words: the one place the spacing rules for lyrics live, so every kit and medium
 * (and any new one) gets the same margins and padding.
 *
 *   safe area   no ink and no plate nearer a frame edge than 6% of the frame's short side. Phone-tall
 *               frames (9:16) keep 10% of the height clear at the top (the app's top bar) and 14% at
 *               the bottom (Reels and TikTok captions and buttons). Named exceptions only: Knockout's
 *               cropped giant word and Film's stripes, which run off the frame on purpose.
 *   plates      any plate, band or panel behind words pads them by at least 0.35 cap heights above
 *               and below the ink (from the accented capitals and the descenders, not the baseline)
 *               and 0.5 cap heights at each end. When the plate and the safe area can't both fit,
 *               the type gets smaller, never the padding.
 *
 * Kits draw their plates from the padding here and tell the layer how far their plates and secondary
 * lines reach past the type (TypeKit.reach), and the layer fits the type into the safe area minus that.
 *
 * The dev measuring tool (src/dev/space.ts) reads what was drawn through noteInk / notePlate /
 * noteDeco. They do nothing unless it switches the log on.
 */

export interface Insets {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** the frame's margin, as a share of its short side */
export const SAFE_SIDE = 0.06;
/** phone-tall frames: the top and bottom keep this share of the height clear */
export const TALL_TOP = 0.1;
export const TALL_BOTTOM = 0.14;
/** plates pad the ink by this many cap heights above and below, and at each end */
export const PAD_V = 0.35;
export const PAD_H = 0.5;

/** a frame this tall for its width gets the phone margins (9:16 is 1.78; 4:5 is 1.25 and doesn't) */
const TALL = 1.5;

/** the safe area's insets in pixels for a W×H frame */
export function safeInsets(W: number, H: number): Insets {
  const side = Math.min(W, H) * SAFE_SIDE;
  const tall = H / Math.max(1, W) >= TALL;
  return { l: side, r: side, t: tall ? Math.max(side, H * TALL_TOP) : side, b: tall ? Math.max(side, H * TALL_BOTTOM) : side };
}

export interface PxBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** a box pulled in so that, with `reach` added round it, it stays inside the safe area */
export function insideSafe(box: PxBox, W: number, H: number, reach: Insets = { l: 0, t: 0, r: 0, b: 0 }): PxBox {
  const s = safeInsets(W, H);
  const x0 = Math.max(box.x0, s.l + reach.l);
  const x1 = Math.min(box.x1, W - s.r - reach.r);
  const y0 = Math.max(box.y0, s.t + reach.t);
  const y1 = Math.min(box.y1, H - s.b - reach.b);
  // never inside out: a box squeezed past nothing keeps a sliver at its middle
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { x0: Math.min(x0, cx - 1), x1: Math.max(x1, cx + 1), y0: Math.min(y0, cy - 1), y1: Math.max(y1, cy + 1) };
}

/** how far a box must move to sit inside the safe area (0 when it does; centred when it can't fit) */
export function nudgeInside(b: PxBox, W: number, H: number): { dx: number; dy: number } {
  const s = safeInsets(W, H);
  const fit = (lo: number, hi: number, a: number, z: number) => {
    if (z - a > hi - lo) return (lo + hi) / 2 - (a + z) / 2;
    if (a < lo) return lo - a;
    if (z > hi) return hi - z;
    return 0;
  };
  return { dx: fit(s.l, W - s.r, b.x0, b.x1), dy: fit(s.t, H - s.b, b.y0, b.y1) };
}

/** padding round ink of this cap height */
export const platePad = (cap: number) => ({ v: cap * PAD_V, h: cap * PAD_H });

/* ───────────────────────── a face's real metrics ───────────────────────── */

export interface FaceMetrics {
  /** cap height */
  cap: number;
  /** the ascenders' top above the baseline (the capitals', for words set in capitals) */
  asc: number;
  /** top of the accented capitals (Å, É) */
  acc: number;
  /** the descenders' depth below the baseline (lower case; capitals: J, Q and commas) */
  desc: number;
}
const metricMemo = new Map<string, FaceMetrics>();

/**
 * The cap height, accent height and descender depth of the font set on `g` (at its size), measured
 * from real glyphs once per font. `upper`: the words are all capitals (their descenders are J, Q, ',').
 */
export function faceMetrics(g: CanvasRenderingContext2D, upper: boolean): FaceMetrics {
  const key = `${g.font}|${g.fontStretch}|${upper}`;
  const hit = metricMemo.get(key);
  if (hit) return hit;
  const ls = g.letterSpacing;
  g.letterSpacing = '0px';
  const cap = g.measureText('H').actualBoundingBoxAscent;
  const acc = g.measureText('ÅÉÎ').actualBoundingBoxAscent;
  const asc = Math.max(cap, upper ? 0 : g.measureText('bdfhkl').actualBoundingBoxAscent);
  const desc = g.measureText(upper ? 'JQ,' : 'gjpqy,').actualBoundingBoxDescent;
  g.letterSpacing = ls;
  const m = { cap, asc, acc, desc };
  if (metricMemo.size > 400) metricMemo.clear();
  metricMemo.set(key, m);
  return m;
}

/* ───────────────────────── the dev measuring log ───────────────────────── */

export type SpaceKind = 'ink' | 'plate' | 'deco';
export interface SpaceItem {
  kind: SpaceKind;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** cap height of the ink (ink items, and plates: of the type on them) */
  cap: number;
  label: string;
  /** a named exception to the safe area (empty: none) */
  exempt: string;
}

/** what was drawn this frame, when the dev measuring tool asks (off: nothing is kept) */
export const spaceLog = { on: false, items: [] as SpaceItem[], tag: '' };

/** a box drawn under g's transform, in canvas pixels (lines set up a side column are turned) */
export function onCanvas(g: CanvasRenderingContext2D, b: PxBox): PxBox {
  const m = g.getTransform();
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
    xs.push(m.a * x + m.c * y + m.e);
    ys.push(m.b * x + m.d * y + m.f);
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function note(g: CanvasRenderingContext2D, kind: SpaceKind, b0: PxBox, cap: number, label: string, exempt = '') {
  if (!spaceLog.on) return;
  const b = onCanvas(g, b0);
  const m = g.getTransform();
  spaceLog.items.push({ kind, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, cap: cap * Math.hypot(m.c, m.d), label, exempt: exempt || spaceLog.tag });
}
/** ink drawn without fillText (the LED sign's dots): the measuring tool records text ink itself */
export const noteInk = (g: CanvasRenderingContext2D, b: PxBox, cap: number, label: string, exempt = '') => note(g, 'ink', b, cap, label, exempt);
/** a plate, band or panel behind words */
export const notePlate = (g: CanvasRenderingContext2D, b: PxBox, cap: number, label: string) => note(g, 'plate', b, cap, label);
/** a secondary line or ornament (frames, bars, stripes) */
export const noteDeco = (g: CanvasRenderingContext2D, b: PxBox, label: string, exempt = '') => note(g, 'deco', b, 0, label, exempt);
