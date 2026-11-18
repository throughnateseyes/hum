/** Generative instruments: tetris-on-kick, topographic contours, voronoi cells, flow-field hairlines. */
import { num } from '../../core/uniforms';
import type { LayerId } from '../../core/types';
import { TAU, clamp, clamp01, damp, hash, labelPx, lerp, noise3, pad3, rgba, smoothstep, text } from './kit';
import type { BF, Module, RGB, Rect } from './kit';

/* ───────────────────────── Tetris on kick ───────────────────────── */

const SHAPES: number[][] = [
  [0, 0, 1, 0, 2, 0, 3, 0], // I
  [0, 0, 1, 0, 0, 1, 1, 1], // O
  [0, 0, 1, 0, 2, 0, 1, 1], // T
  [0, 0, 1, 0, 2, 0, 0, 1], // L
  [0, 0, 1, 0, 2, 0, 2, 1], // J
  [1, 0, 2, 0, 0, 1, 1, 1], // S
  [0, 0, 1, 0, 1, 1, 2, 1], // Z
];
function rotateShape(c: number[], rot: number): number[] {
  let p = c.slice();
  for (let r = 0; r < rot; r++) {
    const q: number[] = [];
    for (let i = 0; i < p.length; i += 2) q.push(-p[i + 1], p[i]);
    p = q;
  }
  let mx = 1e9;
  let my = 1e9;
  for (let i = 0; i < p.length; i += 2) {
    mx = Math.min(mx, p[i]);
    my = Math.min(my, p[i + 1]);
  }
  for (let i = 0; i < p.length; i += 2) {
    p[i] -= mx;
    p[i + 1] -= my;
  }
  return p;
}
interface Piece {
  c: number[];
  x: number;
  y: number;
  w: number;
  h: number;
  col: number;
}

export function tetris(): Module {
  let C = 10;
  let R = 0;
  let cs = 0;
  let key = '';
  let grid = new Uint8Array(0);
  let clearing = new Uint8Array(0);
  let clearT = 0;
  let lines = 0;
  let count = 0;
  let lastDrop = 0;
  const pieces: Piece[] = [];
  const CLEAR_TIME = 0.22;

  const geo = (r: Rect) => {
    let c = Math.min(r.w / 10, r.h / 12);
    const cols = clamp(Math.floor(r.w / c), 6, 16);
    c = Math.floor(Math.min(r.w / cols, r.h / 8));
    const rows = Math.max(6, Math.floor(r.h / c));
    return { cols, rows, c, bx: Math.round(r.x + (r.w - cols * c) / 2), by: Math.round(r.y + r.h - rows * c) };
  };
  const collides = (p: Piece, x: number, row: number) => {
    for (let i = 0; i < 8; i += 2) {
      const gx = x + p.c[i];
      const gy = row + p.c[i + 1];
      if (gx < 0 || gx >= C || gy >= R) return true;
      if (gy >= 0 && grid[gy * C + gx]) return true;
    }
    return false;
  };
  const markFull = () => {
    let any = false;
    for (let y = 0; y < R; y++) {
      let full = true;
      for (let x = 0; x < C && full; x++) if (!grid[y * C + x]) full = false;
      if (full) {
        clearing[y] = 1;
        any = true;
      }
    }
    if (any && clearT <= 0) clearT = CLEAR_TIME;
  };
  const markBottom = (n: number) => {
    let any = false;
    for (let y = R - 1; y >= Math.max(0, R - n); y--) {
      let filled = false;
      for (let x = 0; x < C; x++) if (grid[y * C + x]) filled = true;
      if (filled) {
        clearing[y] = 1;
        any = true;
      }
    }
    if (any && clearT <= 0) clearT = CLEAR_TIME;
  };
  const compact = () => {
    let w = R - 1;
    let removed = 0;
    for (let y = R - 1; y >= 0; y--) {
      if (clearing[y]) {
        removed++;
        continue;
      }
      if (w !== y) grid.copyWithin(w * C, y * C, y * C + C);
      w--;
    }
    for (let y = w; y >= 0; y--) grid.fill(0, y * C, y * C + C);
    clearing.fill(0);
    lines += removed;
  };
  const stackTop = () => {
    for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) if (grid[y * C + x]) return y;
    return R;
  };
  const spawn = () => {
    const rot = Math.floor(Math.random() * 4);
    const c = rotateShape(SHAPES[Math.floor(Math.random() * SHAPES.length)], rot);
    let w = 0;
    let h = 0;
    for (let i = 0; i < 8; i += 2) {
      w = Math.max(w, c[i] + 1);
      h = Math.max(h, c[i + 1] + 1);
    }
    let x = 0;
    for (let t = 0; t < 4; t++) {
      x = Math.floor(Math.random() * (C - w + 1));
      if (!pieces.some((p) => x < p.x + p.w + 1 && p.x < x + w + 1)) break;
    }
    const q = Math.random();
    const col = q < 0.42 ? 1 : q < 0.74 ? 2 : q < 0.9 ? 3 : 4;
    pieces.push({ c, x, y: -h, w, h, col });
    count++;
  };

  const update = (bf: BF) => {
    const a = bf.a;
    if (a.kickHit && pieces.length < 5) spawn();
    if (a.snareHit && stackTop() < R * 0.55) markBottom(1);
    if (a.drop > 0.6 && lastDrop <= 0.6) markBottom(4);
    lastDrop = a.drop;
    const g = (12 + 20 * a.energy + 10 * a.drop) * clamp(num(bf.f.params, 'fall', 1), 0.1, 4);
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      const ny = p.y + g * bf.dt;
      let row = Math.floor(p.y);
      let locked = false;
      while (row < Math.floor(ny)) {
        if (collides(p, p.x, row + 1)) {
          locked = true;
          break;
        }
        row++;
      }
      if (!locked && collides(p, p.x, Math.floor(ny) + 1) && ny - Math.floor(ny) > 0.85) locked = true;
      if (locked) {
        let overflow = false;
        for (let k = 0; k < 8; k += 2) {
          const gy = row + p.c[k + 1];
          if (gy < 0) overflow = true;
          else grid[gy * C + p.x + p.c[k]] = p.col;
        }
        pieces.splice(i, 1);
        if (overflow) {
          clearing.fill(1);
          clearT = CLEAR_TIME * 2;
        } else markFull();
      } else p.y = ny;
    }
    if (clearT > 0) {
      clearT -= bf.dt;
      if (clearT <= 0) compact();
    }
  };

  return {
    label: 'TETRIS',
    meta: 'KICK → PIECE',
    clip: true,
    drawStatic(ctx, r, sf) {
      const { cols, rows, c, bx, by } = geo(r);
      ctx.fillStyle = rgba(sf.ink.fg, 0.2);
      const d = Math.max(1, Math.round(1.5 * sf.s));
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) ctx.fillRect(Math.round(bx + (x + 0.5) * c - d / 2), Math.round(by + (y + 0.5) * c - d / 2), d, d);
      ctx.fillStyle = rgba(sf.ink.fg, 0.55);
      ctx.fillRect(bx, by + rows * c - sf.hl, cols * c, sf.hl);
    },
    draw(ctx, r, bf) {
      const gm = geo(r);
      const k = `${gm.cols}x${gm.rows}`;
      if (k !== key) {
        key = k;
        C = gm.cols;
        R = gm.rows;
        cs = gm.c;
        grid = new Uint8Array(C * R);
        clearing = new Uint8Array(R);
        pieces.length = 0;
        clearT = 0;
      }
      if (bf.live) update(bf);
      const { ink, s } = bf;
      const colors: RGB[] = [ink.fg, ink.fg, ink.ac, ink.ac2, ink.mu];
      const ins = Math.max(1, Math.round(cs * 0.07));
      const { bx, by } = gm;
      for (let ci = 1; ci <= 4; ci++) {
        ctx.fillStyle = rgba(colors[ci]);
        for (let y = 0; y < R; y++) {
          if (clearing[y]) continue;
          for (let x = 0; x < C; x++) if (grid[y * C + x] === ci) ctx.fillRect(bx + x * cs + ins, by + y * cs + ins, cs - ins * 2, cs - ins * 2);
        }
      }
      if (clearT > 0) {
        const f = clamp01(clearT / CLEAR_TIME);
        for (let y = 0; y < R; y++) {
          if (!clearing[y]) continue;
          ctx.fillStyle = rgba(ink.ac, 0.25 + 0.75 * f);
          ctx.fillRect(bx, by + y * cs + ins, C * cs, cs - ins * 2);
        }
      }
      ctx.lineWidth = Math.max(1, s * bf.lw);
      for (const p of pieces) {
        const py = Math.floor(p.y);
        ctx.fillStyle = rgba(colors[p.col], 0.92);
        ctx.strokeStyle = rgba(ink.fg);
        for (let i = 0; i < 8; i += 2) {
          const gy = py + p.c[i + 1];
          if (gy < 0) continue;
          const x = bx + (p.x + p.c[i]) * cs + ins;
          const y = by + gy * cs + ins;
          ctx.fillRect(x, y, cs - ins * 2, cs - ins * 2);
          ctx.strokeRect(x + 0.5, y + 0.5, cs - ins * 2 - 1, cs - ins * 2 - 1);
        }
      }
      const fs = labelPx(s) * 0.82;
      text(ctx, `LINES ${pad3(lines)}  PCS ${pad3(count)}`, r.x + r.w, r.y + fs * 0.6, fs, rgba(ink.fg, 0.55), 'right');
    },
  };
}

/* ───────────────────────── Topographic contours ───────────────────────── */

// marching squares edge pairs per case (corners: tl=8 tr=4 br=2 bl=1; edges: 0 top 1 right 2 bottom 3 left)
const MS: number[][] = [[], [3, 2], [2, 1], [3, 1], [0, 1], [3, 0, 2, 1], [0, 2], [3, 0], [3, 0], [0, 2], [3, 2, 0, 1], [0, 1], [3, 1], [2, 1], [3, 2], []];

export function topo(): Module {
  let field = new Float32Array(0);
  let ph = 0;
  let bump = 0;
  let hi = 0;
  return {
    label: 'TOPOGRAPHY',
    meta: 'CONTOUR · BASS RELIEF',
    clip: true,
    draw(ctx, r, bf) {
      const { ink, s, a, dt } = bf;
      const dens = clamp01(num(bf.f.params, 'density', 0.5));
      const relief = clamp(num(bf.f.params, 'relief', 0.6), 0, 2);
      const nx = Math.round(26 + dens * 18);
      const ny = Math.max(4, Math.round((nx * r.h) / r.w));
      if (field.length !== (nx + 1) * (ny + 1)) field = new Float32Array((nx + 1) * (ny + 1));
      ph += dt * (0.035 + 0.16 * a.energy * (bf.live ? 1 : 0.3));
      if (bf.live) bump = Math.max(bump * Math.exp(-dt * 3.2), a.kick);
      const asp = r.w / r.h;
      const cx = 0.5 + 0.16 * a.sway;
      const cy = 0.52;
      const amp = relief * (0.35 * a.bass + 0.55 * bump);
      let mn = 1e9;
      let mx = -1e9;
      let mxI = 0;
      for (let j = 0; j <= ny; j++) {
        const v = j / ny;
        for (let i = 0; i <= nx; i++) {
          const u = i / nx;
          const xx = u * asp * 1.5;
          const yy = v * 1.5;
          const dx = (u - cx) * asp;
          const dy = v - cy;
          let val = noise3(xx * 1.4, yy * 1.4, ph) * 0.62 + noise3(xx * 3.1 + 5.2, yy * 3.1, ph * 1.6) * 0.26;
          val += amp * Math.exp(-(dx * dx + dy * dy) / 0.035);
          const o = j * (nx + 1) + i;
          field[o] = val;
          if (val < mn) mn = val;
          if (val > mx) {
            mx = val;
            mxI = o;
          }
        }
      }
      const K = 7 + Math.round(dens * 8);
      if (bf.live && a.beat) hi = (hi + 1) % K;
      if (hi >= K) hi = 0;
      const cw = r.w / nx;
      const ch = r.h / ny;
      const level = (k: number) => mn + ((mx - mn) * (k + 0.5)) / K;
      const trace = (L: number) => {
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const o = j * (nx + 1) + i;
            const tl = field[o];
            const tr = field[o + 1];
            const br = field[o + nx + 2];
            const bl = field[o + nx + 1];
            const c = (tl > L ? 8 : 0) | (tr > L ? 4 : 0) | (br > L ? 2 : 0) | (bl > L ? 1 : 0);
            const seg = MS[c];
            if (!seg.length) continue;
            const x0 = r.x + i * cw;
            const y0 = r.y + j * ch;
            for (let q = 0; q < seg.length; q += 2) {
              for (let e = 0; e < 2; e++) {
                const ed = seg[q + e];
                let px = 0;
                let py = 0;
                if (ed === 0) {
                  px = x0 + cw * ((L - tl) / (tr - tl));
                  py = y0;
                } else if (ed === 1) {
                  px = x0 + cw;
                  py = y0 + ch * ((L - tr) / (br - tr));
                } else if (ed === 2) {
                  px = x0 + cw * ((L - bl) / (br - bl));
                  py = y0 + ch;
                } else {
                  px = x0;
                  py = y0 + ch * ((L - tl) / (bl - tl));
                }
                if (e === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
              }
            }
          }
        }
      };
      const lw = Math.max(0.75, s * bf.lw);
      ctx.lineWidth = lw;
      ctx.strokeStyle = rgba(ink.fg, 0.38);
      ctx.beginPath();
      for (let k = 0; k < K; k++) if (k % 4 !== 0 && k !== hi) trace(level(k));
      ctx.stroke();
      ctx.strokeStyle = rgba(ink.fg, 0.85);
      ctx.beginPath();
      for (let k = 0; k < K; k++) if (k % 4 === 0 && k !== hi) trace(level(k));
      ctx.stroke();
      ctx.strokeStyle = rgba(ink.ac);
      ctx.lineWidth = lw * 2;
      ctx.beginPath();
      trace(level(hi));
      ctx.stroke();
      // summit marker
      const si = mxI % (nx + 1);
      const sj = Math.floor(mxI / (nx + 1));
      const sx = r.x + si * cw;
      const sy = r.y + sj * ch;
      const m = 5 * s + 2;
      ctx.strokeStyle = rgba(ink.fg);
      ctx.lineWidth = Math.max(1, s);
      ctx.beginPath();
      ctx.moveTo(sx - m, sy);
      ctx.lineTo(sx + m, sy);
      ctx.moveTo(sx, sy - m);
      ctx.lineTo(sx, sy + m);
      ctx.stroke();
      const fs = labelPx(s) * 0.8;
      const right = sx > r.x + r.w * 0.7;
      text(ctx, `▲ ${(mx - mn).toFixed(2)}`, sx + (right ? -m * 1.4 : m * 1.4), sy - m, fs, rgba(ink.fg, 0.85), right ? 'right' : 'left');
      text(ctx, `ISO ${String(hi + 1).padStart(2, '0')}/${K}`, r.x + 2 * s, r.y + r.h - fs, fs, rgba(ink.ac), 'left');
    },
  };
}

/* ───────────────────────── Voronoi cells ───────────────────────── */

const VB: [LayerId, string, boolean][] = [
  ['sub', 'SUB', false],
  ['bass', 'BAS', false],
  ['lowMid', 'LMD', false],
  ['mid', 'MID', false],
  ['highMid', 'HMD', false],
  ['air', 'AIR', false],
  ['kick', 'KCK', true],
  ['snare', 'SNR', true],
  ['hat', 'HAT', true],
];

function clipHalf(src: Float64Array, n: number, dst: Float64Array, nx: number, ny: number, c: number): number {
  let m = 0;
  for (let k = 0; k < n; k++) {
    const ax = src[k * 2];
    const ay = src[k * 2 + 1];
    const k2 = (k + 1) % n;
    const bx = src[k2 * 2];
    const by = src[k2 * 2 + 1];
    const da = ax * nx + ay * ny - c;
    const db = bx * nx + by * ny - c;
    if (da <= 0) {
      dst[m++] = ax;
      dst[m++] = ay;
    }
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      dst[m++] = ax + (bx - ax) * t;
      dst[m++] = ay + (by - ay) * t;
    }
  }
  return m / 2;
}

export function voronoi(): Module {
  const MAXN = 40;
  const sm = new Float32Array(MAXN);
  const sx = new Float64Array(MAXN);
  const sy = new Float64Array(MAXN);
  const A = new Float64Array(256);
  const B = new Float64Array(256);
  const polys = new Float64Array(MAXN * 128);
  const cnt = new Int32Array(MAXN);
  let kick = 0;
  return {
    label: 'VORONOI',
    meta: 'CELL ← BAND',
    clip: true,
    draw(ctx, r, bf) {
      const { ink, s, a, dt } = bf;
      const dens = clamp01(num(bf.f.params, 'density', 0.5));
      const N = Math.min(MAXN, 14 + Math.round(dens * 20));
      const t = bf.t;
      kick = Math.max(kick * Math.exp(-dt * 5), bf.live ? a.kick : 0);
      for (let i = 0; i < N; i++) {
        const u0 = 0.05 + 0.9 * hash(i, 11);
        const v0 = 0.05 + 0.9 * hash(i, 23);
        const du = 0.07 * noise3(i * 7.13, t * 0.06, 1.7) + 0.012 * kick * (hash(i, 5) - 0.5);
        const dv = 0.07 * noise3(i * 3.71, t * 0.06, 9.1) + 0.012 * kick * (hash(i, 7) - 0.5);
        sx[i] = r.x + r.w * clamp(u0 + du, 0.01, 0.99);
        sy[i] = r.y + r.h * clamp(v0 + dv, 0.01, 0.99);
      }
      for (let i = 0; i < N; i++) {
        let src = A;
        let dst = B;
        src[0] = r.x;
        src[1] = r.y;
        src[2] = r.x + r.w;
        src[3] = r.y;
        src[4] = r.x + r.w;
        src[5] = r.y + r.h;
        src[6] = r.x;
        src[7] = r.y + r.h;
        let n = 4;
        for (let j = 0; j < N && n > 0; j++) {
          if (j === i) continue;
          const nx = sx[j] - sx[i];
          const ny = sy[j] - sy[i];
          const c = (sx[j] * sx[j] + sy[j] * sy[j] - sx[i] * sx[i] - sy[i] * sy[i]) * 0.5;
          n = Math.min(60, clipHalf(src, n, dst, nx, ny, c));
          const tmp = src;
          src = dst;
          dst = tmp;
        }
        cnt[i] = n;
        polys.set(src.subarray(0, n * 2), i * 128);
      }
      const path = (i: number) => {
        const o = i * 128;
        ctx.moveTo(polys[o], polys[o + 1]);
        for (let k = 1; k < cnt[i]; k++) ctx.lineTo(polys[o + k * 2], polys[o + k * 2 + 1]);
        ctx.closePath();
      };
      for (let i = 0; i < N; i++) {
        const [id, , hit] = VB[i % VB.length];
        const v = clamp01(a[id]);
        sm[i] = hit ? Math.max(v, sm[i] * Math.exp(-dt * 8)) : damp(sm[i], v, 10, dt);
        const al = hit ? sm[i] * 0.95 : Math.pow(sm[i], 1.4) * 0.75;
        if (al < 0.02 || cnt[i] < 3) continue;
        ctx.fillStyle = rgba(hit ? ink.ac2 : ink.ac, al);
        ctx.beginPath();
        path(i);
        ctx.fill();
      }
      ctx.strokeStyle = rgba(ink.fg, 0.8);
      ctx.lineWidth = Math.max(0.75, s * bf.lw);
      ctx.lineJoin = 'miter';
      ctx.beginPath();
      for (let i = 0; i < N; i++) if (cnt[i] >= 3) path(i);
      ctx.stroke();
      const d = Math.max(2, 3 * s);
      const fs = Math.max(6, 7.5 * s);
      for (let i = 0; i < N; i++) {
        const [, lab, hit] = VB[i % VB.length];
        const strong = (hit ? sm[i] : Math.pow(sm[i], 1.4) * 0.75) > 0.5;
        ctx.fillStyle = strong ? rgba(ink.bg) : rgba(ink.fg);
        ctx.fillRect(sx[i] - d / 2, sy[i] - d / 2, d, d);
        if (i < VB.length) text(ctx, lab, sx[i] + d * 1.5, sy[i] + fs * 0.1, fs, strong ? rgba(ink.bg, 0.95) : rgba(ink.fg, 0.6));
      }
    },
  };
}

/* ───────────────────────── Flow-field hairlines ───────────────────────── */

export function flow(): Module {
  const MAXP = 5200;
  const px = new Float32Array(MAXP);
  const py = new Float32Array(MAXP);
  const age = new Float32Array(MAXP);
  const life = new Float32Array(MAXP);
  let GW = 0;
  let GH = 0;
  let gvx = new Float32Array(0);
  let gvy = new Float32Array(0);
  let gm = new Float32Array(0);
  let rectKey = '';
  let ph = 0;
  let kickE = 0;
  let dropE = 0;
  let W = 1;
  let H = 1;
  let kx = 1;
  let ky = 1;
  let SVX = 0;
  let SVY = 0;
  let SM = 0;
  const sample = (x: number, y: number) => {
    const fx = clamp(x * kx, 0, GW - 1.001);
    const fy = clamp(y * ky, 0, GH - 1.001);
    const i = fx | 0;
    const j = fy | 0;
    const tx = fx - i;
    const ty = fy - j;
    const o = j * GW + i;
    const a0 = gvx[o] + (gvx[o + 1] - gvx[o]) * tx;
    const a1 = gvx[o + GW] + (gvx[o + GW + 1] - gvx[o + GW]) * tx;
    const b0 = gvy[o] + (gvy[o + 1] - gvy[o]) * tx;
    const b1 = gvy[o + GW] + (gvy[o + GW + 1] - gvy[o + GW]) * tx;
    const m0 = gm[o] + (gm[o + 1] - gm[o]) * tx;
    const m1 = gm[o + GW] + (gm[o + GW + 1] - gm[o + GW]) * tx;
    SVX = a0 + (a1 - a0) * ty;
    SVY = b0 + (b1 - b0) * ty;
    SM = m0 + (m1 - m0) * ty;
  };
  const spawn = (k: number) => {
    let x = 0;
    let y = 0;
    for (let t = 0; t < 14; t++) {
      x = Math.random() * W;
      y = Math.random() * H;
      sample(x, y);
      if (SM > 0.55) break;
    }
    px[k] = x;
    py[k] = y;
    life[k] = 1.6 + Math.random() * 4;
    age[k] = 0;
  };
  return {
    label: 'FLOW',
    meta: 'HAIRLINE FIELD',
    clip: true,
    draw(ctx, r, bf) {
      const { ink, s, a, dt } = bf;
      const p = bf.f.params;
      const dens = clamp01(num(p, 'density', 0.55));
      const swirl = clamp01(num(p, 'swirl', 0.55));
      const sl = clamp(num(p, 'strokeLength', 1), 0.1, 3);
      W = r.w;
      H = r.h;
      const minWH = Math.min(W, H);
      const key = `${Math.round(W)}x${Math.round(H)}`;
      if (key !== rectKey) {
        rectKey = key;
        GW = 56;
        GH = Math.max(8, Math.round((56 * H) / W));
        gvx = new Float32Array(GW * GH);
        gvy = new Float32Array(GW * GH);
        gm = new Float32Array(GW * GH);
      }
      kx = (GW - 1) / W;
      ky = (GH - 1) / H;
      kickE = Math.max(kickE * Math.exp(-dt * 4), bf.live ? a.kick : 0);
      dropE = Math.max(dropE * Math.exp(-dt * 1.5), bf.live ? a.drop : 0);
      ph += dt * (0.045 + 0.12 * a.energy + 0.25 * kickE * (bf.live ? 1 : 0));
      if (bf.live && a.snareHit) ph += 0.04;
      // field grid
      const cx = W * (0.5 + 0.035 * a.sway);
      const cy = H * 0.5;
      const R0 = minWH * 0.43 * (1 + 0.06 * a.bass + 0.05 * kickE);
      const sw = clamp01(swirl + 0.3 * dropE);
      const turb = 1.5 + 0.8 * a.energy;
      for (let j = 0; j < GH; j++) {
        for (let i = 0; i < GW; i++) {
          const x = (i / (GW - 1)) * W;
          const y = (j / (GH - 1)) * H;
          const nxp = x / minWH;
          const nyp = y / minWH;
          const n = noise3(nxp * turb, nyp * turb, ph);
          const ang = n * TAU * 0.85 + 0.7;
          const dx = x - cx;
          const dy = y - cy;
          const d = Math.sqrt(dx * dx + dy * dy) + 1e-3;
          const tx = -dy / d;
          const ty = dx / d;
          let vx = Math.cos(ang) * (1 - sw) + (tx * 0.92 - (dx / d) * 0.22) * sw;
          let vy = Math.sin(ang) * (1 - sw) + (ty * 0.92 - (dy / d) * 0.22) * sw;
          const vl = Math.sqrt(vx * vx + vy * vy) + 1e-6;
          vx /= vl;
          vy /= vl;
          const rt = R0 * (0.84 + 0.2 * noise3((dx / d) * 1.2, (dy / d) * 1.2, ph * 0.6 + 3.3));
          const o = j * GW + i;
          gvx[o] = vx;
          gvy[o] = vy;
          gm[o] = (1 - smoothstep(rt * 0.82, rt, d)) * smoothstep(R0 * 0.06, R0 * 0.2, d);
        }
      }
      const N = Math.round(lerp(700, MAXP, dens));
      const L = clamp(Math.round(10 * sl * (1 + 0.5 * kickE)), 3, 32);
      const step = 3.1 * s * (1 + 0.35 * kickE);
      const adv = (0.3 + 1.2 * a.energy + 2.2 * kickE) * s * 60 * dt;
      const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      const ox = r.x;
      const oy = r.y;
      for (let k = 0; k < N; k++) {
        if (life[k] === 0) {
          spawn(k);
          age[k] = Math.random() * life[k];
        }
        sample(px[k], py[k]);
        px[k] += SVX * adv;
        py[k] += SVY * adv;
        age[k] += dt * (bf.live ? 1 : 0.6);
        if (age[k] > life[k] || SM < 0.04 || px[k] < 0 || py[k] < 0 || px[k] > W || py[k] > H) {
          spawn(k);
          continue;
        }
        const fade = Math.sin((Math.PI * age[k]) / life[k]) * clamp01(SM * 1.4);
        if (fade < 0.1) continue;
        const bucket = fade > 0.7 ? 2 : fade > 0.4 ? 1 : 0;
        const path = paths[(k % 7 === 0 ? 3 : 0) + bucket];
        let x = px[k];
        let y = py[k];
        path.moveTo(ox + x, oy + y);
        for (let q = 0; q < L; q++) {
          sample(x, y);
          if (SM < 0.02) break;
          x += SVX * step;
          y += SVY * step;
          path.lineTo(ox + x, oy + y);
        }
      }
      ctx.lineWidth = Math.max(0.5, 0.85 * s * bf.lw);
      const alphas = [0.22, 0.5, 0.88];
      for (let b = 0; b < 3; b++) {
        ctx.strokeStyle = rgba(ink.ac, alphas[b]);
        ctx.stroke(paths[b]);
        ctx.strokeStyle = rgba(ink.fg, alphas[b] * 0.9);
        ctx.stroke(paths[3 + b]);
      }
      // annotations
      const fs = labelPx(s) * 0.82;
      const c2x = ox + cx;
      const c2y = oy + cy;
      const m = 6 * s + 2;
      ctx.strokeStyle = rgba(ink.fg, 0.5);
      ctx.lineWidth = Math.max(1, s);
      ctx.beginPath();
      ctx.moveTo(c2x - m, c2y);
      ctx.lineTo(c2x + m, c2y);
      ctx.moveTo(c2x, c2y - m);
      ctx.lineTo(c2x, c2y + m);
      ctx.stroke();
      ctx.setLineDash([2 * s + 1, 5 * s + 2]);
      ctx.strokeStyle = rgba(ink.fg, 0.22);
      ctx.beginPath();
      ctx.arc(c2x, c2y, R0 * 1.04, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      text(ctx, `N=${N}  L=${L}  Ω=${sw.toFixed(2)}`, r.x + 2 * s, r.y + r.h - fs, fs, rgba(ink.fg, 0.6));
      text(ctx, `Φ ${ph.toFixed(3)}  R ${(R0 / minWH).toFixed(3)}`, r.x + r.w - 2 * s, r.y + r.h - fs, fs, rgba(ink.fg, 0.6), 'right');
      text(ctx, `X ${(cx / W).toFixed(3)}  Y ${(cy / H).toFixed(3)}`, c2x + m * 1.5, c2y - m * 1.2, fs * 0.9, rgba(ink.fg, 0.55));
    },
  };
}
