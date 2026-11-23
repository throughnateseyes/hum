/**
 * The layout grid every footage style places its graphics on.
 *
 * Worked out from the frame alone, so the same rules give a composed result at 9:16, 1:1 and 16:9:
 *   margin   a fixed share of the frame's short side, the same on all four edges
 *   columns  4 in a tall frame, 6 in a square one, 8 in a wide one, inside the margins
 *   rows     as many as keep the modules close to square
 *   tiny     the cap height of small type (captions, labels), also from the short side
 *
 * All values are world units on the plane in focus (see kit.ts): x to the right, y up, 0 in the middle.
 */
export interface Grid {
  halfW: number;
  halfH: number;
  portrait: boolean;
  margin: number;
  cols: number;
  rows: number;
  /** the box inside the margins */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  colW: number;
  rowH: number;
  /** cap height for small type */
  tiny: number;
  /** x of column line i (0 = the left margin, cols = the right margin) */
  colX(i: number): number;
  /** y of row line j (0 = the top margin, rows = the bottom margin) */
  rowY(j: number): number;
}

export function frameGrid(halfW: number, halfH: number): Grid {
  const aspect = halfW / halfH;
  const short = Math.min(halfW, halfH) * 2;
  const margin = short * 0.06;
  const cols = aspect < 0.8 ? 4 : aspect > 1.3 ? 8 : 6;
  const x0 = -halfW + margin;
  const x1 = halfW - margin;
  const y0 = -halfH + margin;
  const y1 = halfH - margin;
  const colW = (x1 - x0) / cols;
  const rows = Math.max(2, Math.round((y1 - y0) / colW));
  const rowH = (y1 - y0) / rows;
  return {
    halfW,
    halfH,
    portrait: aspect < 1,
    margin,
    cols,
    rows,
    x0,
    x1,
    y0,
    y1,
    colW,
    rowH,
    tiny: short * 0.023,
    colX: (i) => x0 + colW * i,
    rowY: (j) => y1 - rowH * j,
  };
}
