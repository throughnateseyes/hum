/** Photo instruments: block-dissolve datamosh panel with lyric overlay, posterized mosaic panel. */
import { createPhotoClock } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { PhotoAsset } from '../../core/types';
import { SANS, blitCover, clamp, clamp01, cover, hash, labelPx, mix, pad2, rgba, setFont, smoothstep, text } from './kit';
import type { BF, Ink, Module, RGB, Rect } from './kit';

function cornerMarks(ctx: CanvasRenderingContext2D, r: Rect, s: number, c: string) {
  const i = 10 * s + 2;
  const L = 14 * s + 3;
  ctx.strokeStyle = c;
  ctx.lineWidth = Math.max(1, 1.2 * s);
  ctx.beginPath();
  for (const [x, y, dx, dy] of [
    [r.x + i, r.y + i, 1, 1],
    [r.x + r.w - i, r.y + i, -1, 1],
    [r.x + i, r.y + r.h - i, 1, -1],
    [r.x + r.w - i, r.y + r.h - i, -1, -1],
  ]) {
    ctx.moveTo(x, y + dy * L);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * L, y);
  }
  ctx.stroke();
}

function photoLabel(ctx: CanvasRenderingContext2D, r: Rect, bf: BF, left: string, right: string) {
  const fs = labelPx(bf.s);
  const pad = 10 * bf.s + 2;
  const plate = (str: string, x: number, align: CanvasTextAlign) => {
    setFont(ctx, fs, 500);
    const w = ctx.measureText(str).width + fs;
    const bx = align === 'left' ? x : x - w;
    ctx.fillStyle = rgba(bf.ink.bg, 0.88);
    ctx.fillRect(bx, r.y + pad, w, fs * 1.8);
    text(ctx, str, align === 'left' ? bx + fs * 0.5 : x - fs * 0.5, r.y + pad + fs * 0.92, fs, rgba(bf.ink.fg, 0.9), align);
  };
  plate(left, r.x + pad + 20 * bf.s, 'left');
  if (right) plate(right, r.x + r.w - pad - 20 * bf.s, 'right');
}

/* ───────────────────────── Block-dissolve photo ───────────────────────── */

export function photoDissolve(): Module {
  const clock = createPhotoClock();
  const CAP = 320;
  const gx = new Int16Array(CAP);
  const gy = new Int16Array(CAP);
  const gw = new Int8Array(CAP);
  const gh = new Int8Array(CAP);
  const gt = new Uint8Array(CAP);
  const gox = new Int16Array(CAP);
  const goy = new Int16Array(CAP);
  const glife = new Float32Array(CAP);
  let gn = 0;
  let lastBase = -1;
  let dq = 0;
  let orgX = 0.5;
  let orgY = 0.5;
  let sliceT = 0;
  let sliceY = 0;
  let sliceH = 0;
  let sliceShift = 0;
  let lastDrop = 0;
  let kickZ = 0;
  // lyric state
  let lastLine = -1;
  let lineT = 0;
  const wrapCache = new Map<string, string[]>();

  const spawn = (count: number, cols: number, rows: number, energy: number, glitch: number, multi: boolean) => {
    const cx = Math.floor(Math.random() * cols);
    const cy = Math.floor(Math.random() * rows);
    const spread = 1 + energy * 5 + glitch * 3;
    for (let k = 0; k < count && gn < CAP; k++) {
      const i = gn++;
      gx[i] = Math.round(cx + (Math.random() + Math.random() - 1) * spread * 1.4);
      gy[i] = Math.round(cy + (Math.random() + Math.random() - 1) * spread);
      gw[i] = 1 + Math.floor(Math.random() ** 2 * 4);
      gh[i] = 1 + Math.floor(Math.random() ** 3 * 3);
      const q = Math.random();
      gt[i] = q < 0.45 ? (multi ? 0 : 1) : q < 0.8 ? 1 : q < 0.94 ? 2 : 3;
      gox[i] = Math.round((Math.random() - 0.5) * 9);
      goy[i] = Math.round((Math.random() - 0.5) * 2);
      glife[i] = 0.12 + Math.random() * 0.5 * (0.5 + glitch);
    }
  };

  const wrap = (ctx: CanvasRenderingContext2D, line: string, maxW: number, key: string) => {
    const hit = wrapCache.get(key);
    if (hit) return hit;
    const words = line.split(/\s+/);
    const out: string[] = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(t).width > maxW && cur) {
        out.push(cur);
        cur = w;
      } else cur = t;
    }
    if (cur) out.push(cur);
    if (wrapCache.size > 64) wrapCache.clear();
    wrapCache.set(key, out);
    return out;
  };

  const lyrics = (ctx: CanvasRenderingContext2D, r: Rect, bf: BF) => {
    const raw = (bf.f.text || '').trim();
    if (!raw) return;
    const lines = raw
      .split(/\n|\s\/\s|\s\|\s/)
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean);
    if (!lines.length) return;
    const li = bf.idle || lines.length === 1 ? 0 : Math.floor(Math.max(0, bf.a.beatCount) / 8) % lines.length;
    if (li !== lastLine) {
      lastLine = li;
      lineT = 0;
    }
    lineT += bf.dt;
    const size = clamp(num(bf.f.params, 'textSize', 1), 0.3, 3);
    const fs = Math.min(r.w * 0.085 * size, r.h * 0.14 * size);
    setFont(ctx, fs, 600, SANS, -0.035);
    const pad = Math.max(16 * bf.s, r.w * 0.05);
    const rows = wrap(ctx, lines[li], r.w - pad * 2, `${li}|${Math.round(fs)}|${Math.round(r.w)}|${lines[li]}`);
    const bps = bf.a.bpm > 0 ? bf.a.bpm / 60 : 1.5;
    const totalWords = rows.reduce((n, row) => n + row.split(' ').length, 0);
    let shown = Math.min(totalWords, 1 + Math.floor(lineT * bps * 2.5));
    if (!bf.a.playing && !bf.idle) shown = totalWords;
    const lh = fs * 1.02;
    const y0 = r.y + r.h - pad - (rows.length - 1) * lh;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const k = bf.a.kick;
    let left = shown;
    rows.forEach((row, ri) => {
      const words = row.split(' ');
      const vis = words.slice(0, Math.max(0, left)).join(' ');
      left -= words.length;
      if (!vis) return;
      const y = y0 + ri * lh;
      if (k > 0.06) {
        ctx.fillStyle = rgba(bf.ink.ac, Math.min(0.9, k));
        ctx.fillText(vis, r.x + pad + k * 7 * bf.s, y);
      }
      ctx.fillStyle = rgba(bf.ink.paper);
      ctx.fillText(vis, r.x + pad, y);
    });
  };

  return {
    bleed: true,
    clip: true,
    label: 'FRAME',
    draw(ctx, r, bf) {
      const { a, dt, s, ink } = bf;
      const photos = bf.f.photos;
      const n = photos.length;
      if (!n) return;
      const pc = clock(bf.f);
      const base = Math.floor(pc);
      const frac = pc - base;
      const idx = ((base % n) + n) % n;
      const A = photos[idx];
      const B = photos[(idx + 1) % n];
      const multi = n > 1;
      const glitch = clamp01(num(bf.f.params, 'glitch', 0.6)) * (bf.idle ? 0.55 : 1);
      if (base !== lastBase) {
        lastBase = base;
        dq = 0;
        orgX = Math.random();
        orgY = Math.random();
      }
      kickZ = Math.max(kickZ * Math.exp(-dt * 6), a.kick);
      const cA = cover(A.width, A.height, r, 1.03 + 0.05 * frac + 0.012 * kickZ);
      const cB = cover(B.width, B.height, r, 1.03 + 0.012 * kickZ);
      ctx.drawImage(A.image, cA.ox, cA.oy, A.width * cA.sc, A.height * cA.sc);

      const u = Math.max(8, Math.round(Math.min(r.w, r.h) / 16));
      const cols = Math.ceil(r.w / u);
      const rows = Math.ceil(r.h / u);

      // beat-quantized block dissolve into the next photo
      const d = smoothstep(0.84, 0.995, frac);
      if (bf.live && a.kickHit) dq = Math.max(dq, d);
      dq = Math.max(dq, d - 0.18);
      if (multi && dq > 0) {
        const bs = u * 2;
        const bc = Math.ceil(r.w / bs);
        const br = Math.ceil(r.h / bs);
        const maxD = Math.hypot(bc, br);
        for (let j = 0; j < br; j++)
          for (let i = 0; i < bc; i++) {
            const thr = 0.55 * hash(i, j, base) + 0.43 * (Math.hypot(i - orgX * bc, j - orgY * br) / maxD);
            if (thr < dq) blitCover(ctx, B.image, cB, r.x + i * bs, r.y + j * bs, bs, bs);
          }
      }

      // spawns
      if (bf.live) {
        if (a.kickHit) spawn(Math.round(glitch * (3 + 22 * a.energy + 10 * a.kick)), cols, rows, a.energy, glitch, multi);
        if (a.drop > 0.6 && lastDrop <= 0.6) for (let q = 0; q < 3; q++) spawn(Math.round(20 + 40 * glitch), cols, rows, 1, glitch, multi);
        if (a.hatHit && glitch > 0.3 && Math.random() < 0.6) spawn(1 + Math.floor(Math.random() * 2), cols, rows, 0.2, glitch, multi);
        if (a.snareHit && glitch > 0.15) {
          sliceT = 0.14;
          sliceH = u * (0.4 + Math.random() * 1.6);
          sliceY = r.y + Math.random() * (r.h - sliceH);
          sliceShift = (Math.random() - 0.5) * u * 4 * glitch;
        }
        lastDrop = a.drop;
      }
      // draw + age glitch blocks
      let w = 0;
      for (let i = 0; i < gn; i++) {
        glife[i] -= bf.live ? dt : 0;
        if (glife[i] <= 0) continue;
        if (w !== i) {
          gx[w] = gx[i];
          gy[w] = gy[i];
          gw[w] = gw[i];
          gh[w] = gh[i];
          gt[w] = gt[i];
          gox[w] = gox[i];
          goy[w] = goy[i];
          glife[w] = glife[i];
        }
        const dx = r.x + gx[w] * u;
        const dy = r.y + gy[w] * u;
        const dw = gw[w] * u;
        const dh = gh[w] * u;
        const t = gt[w];
        if (t === 0) blitCover(ctx, B.image, cB, dx, dy, dw, dh);
        else if (t === 1) blitCover(ctx, A.image, cA, dx, dy, dw, dh, gox[w] * u, goy[w] * u);
        else if (t === 2) blitCover(ctx, A.image, cA, dx, dy, dw, dh, 0, 0, Math.max(1, 2 / cA.sc));
        else {
          ctx.fillStyle = rgba(gox[w] > 0 ? ink.ac : ink.fg, 0.85);
          ctx.fillRect(dx, dy, dw, Math.max(2, dh * 0.25));
        }
        w++;
      }
      gn = w;
      if (sliceT > 0) {
        sliceT -= dt;
        blitCover(ctx, A.image, cA, r.x, sliceY, r.w, sliceH, sliceShift, 0);
        ctx.fillStyle = rgba(ink.ac, 0.85);
        ctx.fillRect(r.x, sliceY, r.w, Math.max(1, s));
      }

      lyrics(ctx, r, bf);
      cornerMarks(ctx, r, s, rgba(ink.paper, 0.85));
      if (bf.labels) photoLabel(ctx, r, bf, `IMG ${pad2(idx + 1)}/${pad2(n)}`, `DISSOLVE ${dq.toFixed(2).slice(1)}`);
    },
  };
}

/* ───────────────────────── Posterized mosaic photo ───────────────────────── */

export function photoMosaic(): Module {
  const clock = createPhotoClock();
  let cache: HTMLCanvasElement | null = null;
  let prev: HTMLCanvasElement | null = null;
  let key = '';
  let photoKey = '';
  let swapT = 1;
  let small: HTMLCanvasElement | null = null;
  let sctx: CanvasRenderingContext2D | null = null;
  let gridC = 0;
  let gridR = 0;
  let sliceE = 0;
  const sliceY = new Float32Array(3);
  const sliceDir = new Float32Array(3);
  const hot = new Float32Array(12 * 3);

  const build = (photo: PhotoAsset, r: Rect, cols: number, ink: Ink) => {
    const rows = Math.max(2, Math.round((cols * r.h) / r.w));
    gridC = cols;
    gridR = rows;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(r.w));
    out.height = Math.max(1, Math.round(r.h));
    const o = out.getContext('2d')!;
    if (!small) {
      small = document.createElement('canvas');
      sctx = small.getContext('2d', { willReadFrequently: true })!;
    }
    small.width = cols;
    small.height = rows;
    const c = cover(photo.width, photo.height, { x: 0, y: 0, w: cols, h: rows });
    sctx!.drawImage(photo.image, c.ox, c.oy, photo.width * c.sc, photo.height * c.sc);
    const ramp: RGB[] = [ink.fg, ink.ac, mix(ink.ac2, ink.bg, 0.15), ink.bg];
    o.fillStyle = rgba(ink.bg);
    o.fillRect(0, 0, out.width, out.height);
    let data: Uint8ClampedArray | null = null;
    try {
      data = sctx!.getImageData(0, 0, cols, rows).data;
    } catch {
      data = null;
    }
    const cw = out.width / cols;
    const ch = out.height / rows;
    const g = Math.max(1, Math.round(cw * 0.08));
    if (!data) {
      // tainted / unreadable source: fall back to the plain photo
      const c2 = cover(photo.width, photo.height, { x: 0, y: 0, w: out.width, h: out.height });
      o.drawImage(photo.image, c2.ox, c2.oy, photo.width * c2.sc, photo.height * c2.sc);
      return out;
    }
    // adaptive levels: stretch luminance to the photo's own range
    let lo = 1;
    let hi = 0;
    const L = new Float32Array(cols * rows);
    for (let i = 0; i < cols * rows; i++) {
      const l = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
      L[i] = l;
      lo = Math.min(lo, l);
      hi = Math.max(hi, l);
    }
    const span = Math.max(0.05, hi - lo);
    for (let level = 0; level < 4; level++) {
      o.fillStyle = rgba(ramp[level]);
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          const q = Math.min(3, Math.floor(((L[y * cols + x] - lo) / span) * 4));
          if (q !== level) continue;
          if (level === 3) {
            const dd = Math.max(1, cw * 0.14);
            o.fillStyle = rgba(ink.mu);
            o.fillRect(x * cw + cw / 2 - dd / 2, y * ch + ch / 2 - dd / 2, dd, dd);
            o.fillStyle = rgba(ramp[level]);
          } else o.fillRect(Math.round(x * cw) + g / 2, Math.round(y * ch) + g / 2, Math.ceil(cw) - g, Math.ceil(ch) - g);
        }
    }
    return out;
  };

  return {
    bleed: true,
    clip: true,
    label: 'MOSAIC',
    draw(ctx, r, bf) {
      const { a, dt, s, ink } = bf;
      const photos = bf.f.photos;
      const n = photos.length;
      if (!n) return;
      const pc = clock(bf.f);
      const idx = ((Math.floor(pc) % n) + n) % n;
      const photo = photos[idx];
      const cols = Math.round(clamp(num(bf.f.params, 'mosaic', 28), 8, 96));
      const pk = `${photo.id}`;
      const k = `${pk}|${cols}|${Math.round(r.w)}x${Math.round(r.h)}|${ink.key}`;
      if (k !== key) {
        if (pk !== photoKey && cache) {
          prev = cache;
          swapT = 0;
        }
        photoKey = pk;
        key = k;
        cache = build(photo, r, cols, ink);
      }
      swapT = Math.min(1, swapT + dt * 1.4);
      const cw = r.w / gridC;
      const ch = r.h / gridR;
      if (swapT < 1 && prev) {
        ctx.drawImage(prev, r.x, r.y, r.w, r.h);
        for (let c = 0; c < gridC; c++) {
          if (hash(c, 3, pc | 0) * 0.85 > swapT) continue;
          const sx = Math.round(c * cw);
          const sw = Math.round((c + 1) * cw) - sx;
          ctx.drawImage(cache!, sx, 0, sw, cache!.height, r.x + sx, r.y, sw, r.h);
        }
      } else ctx.drawImage(cache!, r.x, r.y, r.w, r.h);

      if (bf.live && a.kickHit) {
        sliceE = 1;
        for (let i = 0; i < 3; i++) {
          sliceY[i] = Math.floor(Math.random() * gridR);
          sliceDir[i] = Math.random() < 0.5 ? -1 : 1;
        }
      }
      if (bf.live && a.hatHit) {
        for (let i = 0; i < 12; i++)
          if (hot[i * 3 + 2] <= 0) {
            hot[i * 3] = Math.floor(Math.random() * gridC);
            hot[i * 3 + 1] = Math.floor(Math.random() * gridR);
            hot[i * 3 + 2] = 1;
            if (Math.random() < 0.5) break;
          }
      }
      sliceE *= Math.exp(-dt * 8);
      if (sliceE > 0.03) {
        const src = cache!;
        for (let i = 0; i < 3; i++) {
          const y = Math.round(sliceY[i] * ch);
          const hh = Math.round(ch * (1 + (i % 2)));
          const sh = Math.round(sliceE * cw * 2.5) * sliceDir[i];
          ctx.drawImage(src, 0, (y / r.h) * src.height, src.width, (hh / r.h) * src.height, r.x + sh, r.y + y, r.w, hh);
        }
      }
      for (let i = 0; i < 12; i++) {
        const l = hot[i * 3 + 2];
        if (l <= 0) continue;
        hot[i * 3 + 2] = l - dt * 3;
        ctx.fillStyle = rgba(ink.ac2, clamp01(l));
        ctx.fillRect(r.x + hot[i * 3] * cw, r.y + hot[i * 3 + 1] * ch, Math.ceil(cw), Math.ceil(ch));
      }
      // scan row
      const row = Math.floor(a.beatPhase * gridR) % gridR;
      ctx.strokeStyle = rgba(ink.ac, 0.9);
      ctx.lineWidth = Math.max(1, 1.2 * s);
      ctx.strokeRect(r.x + 0.5, Math.round(r.y + row * ch) + 0.5, r.w - 1, Math.round(ch));
      if (bf.labels) photoLabel(ctx, r, bf, `MOSAIC ${gridC}×${gridR}`, 'Q4');
    },
  };
}
