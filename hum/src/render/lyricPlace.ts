import { PROBE_H, PROBE_W, coveredShare, type FrameProbe, type Rect } from './legibility';

/**
 * Words placed in the picture: for Sparse lines (always) and Subtitle lines on calm parts (when the
 * lyric plan says so), the line sits in the calmest open place in the frame, the way an editor
 * places a title, instead of the fixed lower third.
 *
 * The candidates are the lower left and lower right and a vertical column up either side (the words
 * turned a quarter, reading upward). There is no band across the top: lyrics never start above
 * SAFE_TOP (lyricLayer.ts), so 'top' stays in SlotId for a frame rule that allows it. Each is scored
 * on the frame under it: how busy it is, how many bright face-sized patches it would sit on, and how
 * much a pop-up window covers it.
 *
 * A place is held for the whole line and only changes between lines, and then at most once every
 * BLOCK lines (and only for a clearly better place), so the words don't hop about the frame. The
 * choice for each block is remembered, so seeking back lands the words where they were, and an
 * export rendered start to finish places them the same way every time.
 */

export type SlotId = 'lowL' | 'lowR' | 'sideL' | 'sideR' | 'top';

export interface Slot {
  id: SlotId;
  /** normalized box the words occupy on screen (for a side column: the column itself) */
  r: Rect;
  align: 'left' | 'center' | 'right';
  anchor: 'bottom' | 'center';
  /** set up the column, turned a quarter turn (reads bottom to top) */
  turned?: boolean;
}

/** lines a place is held for at the least */
export const BLOCK = 3;

/**
 * The places, as shares of the frame. Tall frames keep everything between the safe top (0.34) and
 * the bottom 24% where Reels and TikTok put their own captions, and inside a 7% side margin.
 */
export function slots(portrait: boolean): Slot[] {
  if (portrait) {
    return [
      { id: 'lowL', r: { x0: 0.07, y0: 0.55, x1: 0.7, y1: 0.75 }, align: 'left', anchor: 'bottom' },
      { id: 'lowR', r: { x0: 0.3, y0: 0.55, x1: 0.93, y1: 0.75 }, align: 'right', anchor: 'bottom' },
      { id: 'sideL', r: { x0: 0.07, y0: 0.36, x1: 0.2, y1: 0.75 }, align: 'left', anchor: 'center', turned: true },
      { id: 'sideR', r: { x0: 0.8, y0: 0.36, x1: 0.93, y1: 0.75 }, align: 'left', anchor: 'center', turned: true },
    ];
  }
  return [
    { id: 'lowL', r: { x0: 0.06, y0: 0.62, x1: 0.52, y1: 0.88 }, align: 'left', anchor: 'bottom' },
    { id: 'lowR', r: { x0: 0.48, y0: 0.62, x1: 0.94, y1: 0.88 }, align: 'right', anchor: 'bottom' },
    { id: 'sideL', r: { x0: 0.04, y0: 0.36, x1: 0.11, y1: 0.88 }, align: 'left', anchor: 'center', turned: true },
    { id: 'sideR', r: { x0: 0.89, y0: 0.36, x1: 0.96, y1: 0.88 }, align: 'left', anchor: 'center', turned: true },
  ];
}

/**
 * Bright patches the size of a face (a probe cell is ~1/96 of the width): the share of the box's
 * cells that are both bright and well above the frame's own level. Words laid over a face or a sun
 * are the thing an editor never does.
 */
function brightShare(p: Pick<FrameProbe, 'L'>, r: Rect, frameHi: number): number {
  const x0 = Math.max(0, Math.floor(r.x0 * PROBE_W));
  const x1 = Math.min(PROBE_W, Math.ceil(r.x1 * PROBE_W));
  const y0 = Math.max(0, Math.floor(r.y0 * PROBE_H));
  const y1 = Math.min(PROBE_H, Math.ceil(r.y1 * PROBE_H));
  const cut = Math.max(0.3, frameHi);
  let hit = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      n++;
      if (p.L[y * PROBE_W + x] > cut) hit++;
    }
  }
  return n ? hit / n : 0;
}

/** the frame's 85th-percentile luminance (what counts as "bright" here) */
export function frameHigh(p: Pick<FrameProbe, 'L'>): number {
  const s = Array.from(p.L).sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.85)] ?? 1;
}

/**
 * How poor a place is (lower is better): the legibility verdict for it (`level` and `bad` from
 * judge()), its bright patches, and the pop-up windows over it. Side columns cost a little extra so
 * they're used when they're clearly the calmer place, not by default.
 */
export function slotCost(s: Slot, verdict: { level: number; bad: number }, p: Pick<FrameProbe, 'L'>, frameHi: number, occluders: readonly Rect[], words: number): number {
  let c = verdict.level + verdict.bad * 3 + brightShare(p, s.r, frameHi) * 4 + coveredShare(s.r, occluders) * 3;
  // a long line turned up a column is hard to read: columns are for short lines
  if (s.turned) c += 1 + Math.max(0, words - 5) * 0.5;
  return c;
}

/**
 * The remembered places for one song, per block of lines. `pick` is called once per line with that
 * line's showing index; it decides only on a block's first line, keeps the previous block's place
 * unless the new best beats it clearly, and remembers the answer.
 */
export class PlaceMemo {
  private byBlock = new Map<string, SlotId>();
  private owner: unknown = null;

  /** forget everything when the song (its lines) or the frame shape changes */
  reset(owner: unknown) {
    if (owner === this.owner) return;
    this.owner = owner;
    this.byBlock.clear();
  }

  pick(showIdx: number, part: number, cands: Slot[], cost: (s: Slot) => number): Slot {
    const block = Math.floor(showIdx / BLOCK);
    const key = `${part}|${block}`;
    const known = this.byBlock.get(key);
    const hit = known && cands.find((s) => s.id === known);
    if (hit) return hit;
    const costs = cands.map((s) => ({ s, c: cost(s) }));
    let best = costs[0];
    for (const x of costs) if (x.c < best.c) best = x;
    // hold the place the block before used unless the new one is clearly calmer
    const prev = this.byBlock.get(`${part}|${block - 1}`);
    const held = prev && costs.find((x) => x.s.id === prev);
    const out = held && held.c - best.c < 0.5 ? held.s : best.s;
    this.byBlock.set(key, out.id);
    return out;
  }
}

/**
 * A side column as a layout box: the box to lay the words out in flat (the column's length across,
 * its width down), and the centre to turn them about. Turned −90°, the flat box lands on the column.
 */
export function turnedBox(col: { x0: number; y0: number; x1: number; y1: number }) {
  const cx = (col.x0 + col.x1) / 2;
  const cy = (col.y0 + col.y1) / 2;
  const len = col.y1 - col.y0;
  const wide = col.x1 - col.x0;
  return { box: { x0: cx - len / 2, x1: cx + len / 2, y0: cy - wide / 2, y1: cy + wide / 2 }, cx, cy };
}

/**
 * Where turned rows land on screen, as a normalized rect (padded by `pad` of the frame): the rows'
 * flat pixel bounds turned −90° about (cx, cy). The flat box hangs off the frame before turning, so
 * this works from pixels, never from a clamped rect.
 */
export function turnedRect(rows: readonly { x: number; y: number; w: number; h: number }[], cx: number, cy: number, W: number, H: number, pad: number): Rect | null {
  if (!rows.length) return null;
  const fx0 = Math.min(...rows.map((r) => r.x));
  const fx1 = Math.max(...rows.map((r) => r.x + r.w));
  const fy0 = Math.min(...rows.map((r) => r.y));
  const fy1 = Math.max(...rows.map((r) => r.y + r.h));
  // (x, y) → (cx + (y − cy), cy − (x − cx))
  const x0 = cx + (fy0 - cy);
  const x1 = cx + (fy1 - cy);
  const y0 = cy - (fx1 - cx);
  const y1 = cy - (fx0 - cx);
  return { x0: Math.max(0, x0 / W - pad), x1: Math.min(1, x1 / W + pad), y0: Math.max(0, y0 / H - pad), y1: Math.min(1, y1 / H + pad) };
}
