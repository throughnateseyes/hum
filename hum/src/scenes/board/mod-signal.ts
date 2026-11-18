/**
 * Signal instruments: spectrogram, stacked band waveforms, piano roll, radial meter, pad grid,
 * knob row, scope, spectrum bars, vector scope, track overview, line graph, chroma, meters,
 * step sequencer.
 */
import type { LayerId } from '../../core/types';
import {
  MONO,
  NOTE_NAMES,
  Ring,
  TAU,
  binHz,
  clamp01,
  crisp,
  damp,
  fmt2,
  hzBin,
  labelPx,
  makeTicker,
  mix,
  pad3,
  rgba,
  setFont,
  text,
} from './kit';
import type { BF, Ink, Module, RGB, Rect, SF } from './kit';

const strongest = (vals: ArrayLike<number>) => {
  let bi = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] > vals[bi]) bi = i;
  return bi;
};

/* ───────────────────────── Spectrogram ───────────────────────── */

export function spectrogram(): Module {
  const COLS = 256;
  const ROWS = 128;
  const raw = new Uint8Array(COLS * ROWS);
  const lut = new Uint8ClampedArray(256 * 3);
  let cv: HTMLCanvasElement | null = null;
  let cx: CanvasRenderingContext2D | null = null;
  let col: ImageData | null = null;
  let head = 0;
  let lutKey = '';
  const tick = makeTicker();

  const buildLut = (ink: Ink) => {
    const stops: [number, RGB][] = [
      [0, ink.bg],
      [0.28, mix(ink.bg, ink.ac2, 0.85)],
      [0.62, ink.ac],
      [1, ink.fg],
    ];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let k = 0;
      while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const [t0, c0] = stops[k];
      const [t1, c1] = stops[k + 1];
      const c = mix(c0, c1, clamp01((t - t0) / (t1 - t0)));
      lut[i * 3] = c[0];
      lut[i * 3 + 1] = c[1];
      lut[i * 3 + 2] = c[2];
    }
  };
  const repaint = () => {
    const img = cx!.createImageData(COLS, ROWS);
    const d = img.data;
    for (let x = 0; x < COLS; x++)
      for (let y = 0; y < ROWS; y++) {
        const v = raw[x * ROWS + y] * 3;
        const o = (y * COLS + x) * 4;
        d[o] = lut[v];
        d[o + 1] = lut[v + 1];
        d[o + 2] = lut[v + 2];
        d[o + 3] = 255;
      }
    cx!.putImageData(img, 0, 0);
  };
  const push = (spec: Float32Array) => {
    const d = col!.data;
    for (let y = 0; y < ROWS; y++) {
      const bin = ROWS - 1 - y;
      const v = Math.round(Math.pow(clamp01((spec[bin] || 0) * 1.08), 0.85) * 255);
      raw[head * ROWS + y] = v;
      d[y * 4] = lut[v * 3];
      d[y * 4 + 1] = lut[v * 3 + 1];
      d[y * 4 + 2] = lut[v * 3 + 2];
      d[y * 4 + 3] = 255;
    }
    cx!.putImageData(col!, head, 0);
    head = (head + 1) % COLS;
  };

  return {
    label: 'SPECTROGRAM',
    meta: '128 BIN · LOG',
    draw(ctx, r, bf) {
      if (!cv) {
        cv = document.createElement('canvas');
        cv.width = COLS;
        cv.height = ROWS;
        cx = cv.getContext('2d')!;
        col = cx.createImageData(1, ROWS);
      }
      if (lutKey !== bf.ink.key) {
        lutKey = bf.ink.key;
        buildLut(bf.ink);
        repaint();
      }
      if (bf.live) {
        const n = tick(bf.dt, 50 * bf.speed);
        for (let i = 0; i < n; i++) push(bf.a.spectrum);
      }
      ctx.imageSmoothingEnabled = true;
      const a = COLS - head;
      const xa = (r.w * a) / COLS;
      ctx.drawImage(cv, head, 0, a, ROWS, r.x, r.y, xa, r.h);
      if (head > 0) ctx.drawImage(cv, 0, 0, head, ROWS, r.x + xa, r.y, r.w - xa, r.h);
      // frequency guides
      const { ink, s } = bf;
      ctx.strokeStyle = rgba(ink.fg, 0.28);
      ctx.lineWidth = Math.max(1, s);
      ctx.setLineDash([2 * s + 1, 4 * s + 1]);
      ctx.beginPath();
      const fs = Math.max(6.5, 8.5 * s);
      const marks: [number, string][] = [
        [100, '100'],
        [1000, '1K'],
        [10000, '10K'],
      ];
      for (const [hz] of marks) {
        const y = crisp(r.y + r.h * (1 - hzBin(hz) / 127), 1);
        ctx.moveTo(r.x, y);
        ctx.lineTo(r.x + r.w, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      for (const [hz, lab] of marks) {
        const y = r.y + r.h * (1 - hzBin(hz) / 127);
        text(ctx, lab, r.x + r.w - 3 * s, y - fs * 0.7, fs, rgba(ink.fg, 0.6), 'right');
      }
      // now-line
      ctx.fillStyle = rgba(ink.ac, 0.9);
      ctx.fillRect(r.x + r.w - Math.max(1, bf.hl), r.y, Math.max(1, bf.hl), r.h);
    },
  };
}

/* ───────────────────────── Stacked band waveforms ───────────────────────── */

export function bandWaves(): Module {
  const N = 200;
  const rows: { label: string; get: (a: BF['a']) => number }[] = [
    { label: 'SUB', get: (a) => a.sub },
    { label: 'BASS', get: (a) => a.bass },
    { label: 'MID', get: (a) => Math.max(a.mid, a.lowMid * 0.9) },
    { label: 'HIGH', get: (a) => Math.max(a.highMid, a.air) },
  ];
  const rings = rows.map(() => new Ring(N));
  const sm = new Float32Array(rows.length);
  const tick = makeTicker();
  const lcw = (s: number) => Math.round(58 * s);
  return {
    label: 'BANDS',
    meta: 'SUB · BASS · MID · HIGH',
    drawStatic(ctx, r, sf) {
      const rh = r.h / rows.length;
      ctx.fillStyle = rgba(sf.ink.line);
      for (let i = 1; i < rows.length; i++) ctx.fillRect(r.x, Math.round(r.y + i * rh), r.w, sf.hl);
      ctx.fillStyle = rgba(sf.ink.fg, 0.12);
      for (let i = 0; i < rows.length; i++) ctx.fillRect(r.x + lcw(sf.s), Math.round(r.y + (i + 0.5) * rh), r.w - lcw(sf.s), 1);
      rows.forEach((row, i) => text(ctx, row.label, r.x, r.y + i * rh + rh * 0.32, labelPx(sf.s) * 0.9, rgba(sf.ink.fg, 0.75)));
    },
    draw(ctx, r, bf) {
      const { ink, s, a } = bf;
      const n = bf.live ? tick(bf.dt, 55 * bf.speed) : 0;
      rows.forEach((row, i) => {
        const v = row.get(a);
        sm[i] = damp(sm[i], v, 18, bf.dt);
        for (let k = 0; k < n; k++) rings[i].push(clamp01(v) * (0.4 + 0.6 * Math.random()));
      });
      const hot = strongest(sm);
      const rh = r.h / rows.length;
      const x0 = r.x + lcw(s);
      const step = (r.w - lcw(s)) / N;
      ctx.lineWidth = Math.max(1, Math.min(step * 0.62, 2.6 * s));
      const fs = labelPx(s) * 0.9;
      for (let i = 0; i < rows.length; i++) {
        const cy = r.y + (i + 0.5) * rh;
        const amp = rh * 0.42;
        ctx.strokeStyle = rgba(i === hot ? ink.ac : ink.fg, i === hot ? 1 : 0.85);
        ctx.beginPath();
        const ring = rings[i];
        for (let k = 0; k < N; k++) {
          const hh = Math.max(0.5, ring.at(k) * amp);
          const x = x0 + (k + 0.5) * step;
          ctx.moveTo(x, cy - hh);
          ctx.lineTo(x, cy + hh);
        }
        ctx.stroke();
        text(ctx, fmt2(sm[i]), r.x, r.y + i * rh + rh * 0.32 + fs * 1.3, fs, rgba(i === hot ? ink.ac : ink.fg, 0.9));
      }
    },
  };
}

/* ───────────────────────── Piano roll ───────────────────────── */

export function pianoRoll(): Module {
  const N = 128;
  const lane = new Int8Array(N).fill(-1);
  const mag = new Float32Array(N);
  const beatMark = new Uint8Array(N);
  let head = 0;
  let pendingBeat = 0;
  let cur = -1;
  let curHz = 0;
  const tick = makeTicker();
  const LANES = 12;
  const lc = (s: number) => Math.round(28 * s);
  const lo = Math.round(hzBin(110));
  const hi = Math.round(hzBin(3500));
  const sample = (spec: Float32Array) => {
    let bi = -1;
    let bv = 0.14;
    for (let i = lo; i <= hi; i++) {
      // favour peaks over broadband slope
      const v = spec[i] - 0.5 * (spec[i - 3] + spec[i + 3]) * 0.6;
      if (v > bv) {
        bv = v;
        bi = i;
      }
    }
    if (bi < 0) return [-1, 0, 0];
    const hz = binHz(bi);
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    return [((midi % 12) + 12) % 12, clamp01(spec[bi]), hz];
  };
  return {
    label: 'PIANO ROLL',
    meta: 'DOMINANT PITCH',
    drawStatic(ctx, r, sf) {
      const lh = r.h / LANES;
      const fs = Math.max(6.5, Math.min(lh * 0.62, 9 * sf.s));
      for (let k = 0; k < LANES; k++) {
        const pc = LANES - 1 - k;
        const y = r.y + k * lh;
        if (NOTE_NAMES[pc].length > 1) {
          ctx.fillStyle = rgba(sf.ink.fg, 0.045);
          ctx.fillRect(r.x + lc(sf.s), y, r.w - lc(sf.s), lh);
        }
        ctx.fillStyle = rgba(sf.ink.line, pc === 0 ? 1 : 0.55);
        ctx.fillRect(r.x, Math.round(y), r.w, 1);
        text(ctx, NOTE_NAMES[pc], r.x, y + lh * 0.5, fs, rgba(sf.ink.fg, NOTE_NAMES[pc].length > 1 ? 0.4 : 0.75));
      }
      ctx.fillStyle = rgba(sf.ink.line);
      ctx.fillRect(r.x + lc(sf.s) - 4 * sf.s, r.y, 1, r.h);
    },
    draw(ctx, r, bf) {
      const { ink, s, a } = bf;
      if (a.beat) pendingBeat = 1;
      if (bf.live) {
        const n = tick(bf.dt, 18 * bf.speed);
        for (let i = 0; i < n; i++) {
          const [l, m, hz] = sample(a.spectrum);
          lane[head] = l;
          mag[head] = m;
          beatMark[head] = pendingBeat;
          pendingBeat = 0;
          head = (head + 1) % N;
          cur = l;
          if (l >= 0) curHz = hz;
        }
      }
      const x0 = r.x + lc(s);
      const W = r.w - lc(s);
      const step = W / N;
      const lh = r.h / LANES;
      // scrolling beat grid
      ctx.fillStyle = rgba(ink.fg, 0.14);
      for (let k = 0; k < N; k++) if (beatMark[(head + k) % N]) ctx.fillRect(Math.round(x0 + k * step), r.y, 1, r.h);
      // dashes: merge runs of the same lane
      let k = 0;
      while (k < N) {
        const l = lane[(head + k) % N];
        if (l < 0) {
          k++;
          continue;
        }
        let e = k;
        let m = 0;
        while (e < N && lane[(head + e) % N] === l) {
          m = Math.max(m, mag[(head + e) % N]);
          e++;
        }
        const recent = e > N - 10;
        const th = Math.max(2, lh * (0.28 + 0.4 * m));
        const y = r.y + (LANES - 1 - l + 0.5) * lh - th / 2;
        ctx.fillStyle = rgba(recent ? ink.ac : ink.fg, recent ? 1 : 0.82);
        ctx.fillRect(x0 + k * step + 1, y, Math.max(2, (e - k) * step - 2), th);
        k = e;
      }
      // playhead
      const px = Math.round(x0 + W) - 1;
      ctx.fillStyle = rgba(ink.ac);
      ctx.fillRect(px, r.y, Math.max(1, bf.hl), r.h);
      const tri = 5 * s + 2;
      ctx.beginPath();
      ctx.moveTo(px - tri, r.y);
      ctx.lineTo(px + 1, r.y);
      ctx.lineTo(px + 1, r.y + tri);
      ctx.fill();
      if (cur >= 0) {
        const oct = Math.floor(69 / 12 + Math.log2(curHz / 440)) - 1;
        const y = r.y + (LANES - 1 - cur + 0.5) * lh;
        text(ctx, `${NOTE_NAMES[cur]}${oct}`, px - tri - 4 * s, y, Math.max(7, 10 * s), rgba(ink.ac), 'right', 600);
      }
    },
  };
}

/* ───────────────────────── Radial meter ───────────────────────── */

export function radial(): Module {
  const bands: [LayerId, string][] = [
    ['sub', 'SUB'],
    ['bass', 'BAS'],
    ['mid', 'MID'],
    ['air', 'AIR'],
  ];
  const sm = new Float32Array(bands.length);
  let ring = 0;
  let pop = 0;
  const geo = (r: Rect) => ({ cx: r.x + r.w / 2, cy: r.y + r.h / 2, R: (Math.min(r.w, r.h) / 2) * 0.96 });
  const radii = (R: number) => bands.map((_, i) => R * (0.8 - i * 0.1));
  return {
    label: 'BEAT',
    meta: 'RADIAL · 4 BAND',
    drawStatic(ctx, r, sf) {
      const { cx, cy, R } = geo(r);
      const { ink, s } = sf;
      ctx.strokeStyle = rgba(ink.fg, 0.55);
      ctx.lineWidth = sf.hl;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      for (let i = 0; i < 60; i++) {
        const an = (i / 60) * TAU - Math.PI / 2;
        const r0 = i % 5 === 0 ? R * 0.88 : R * 0.93;
        ctx.moveTo(cx + Math.cos(an) * r0, cy + Math.sin(an) * r0);
        ctx.lineTo(cx + Math.cos(an) * R, cy + Math.sin(an) * R);
      }
      ctx.stroke();
      ctx.strokeStyle = rgba(ink.mu, 0.9);
      ctx.lineWidth = Math.max(1, 4 * s * sf.lw);
      const fs = Math.max(6, 7.5 * s);
      radii(R).forEach((rr, i) => {
        ctx.beginPath();
        ctx.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + TAU * 0.85);
        ctx.stroke();
        text(ctx, bands[i][1], cx - 4 * s, cy - rr, fs, rgba(ink.fg, 0.55), 'right');
      });
    },
    draw(ctx, r, bf) {
      const { cx, cy, R } = geo(r);
      const { ink, s, a, dt } = bf;
      for (let i = 0; i < bands.length; i++) sm[i] = damp(sm[i], clamp01(a[bands[i][0]]), 14, dt);
      const hot = strongest(sm);
      ctx.lineCap = 'butt';
      ctx.lineWidth = Math.max(1.5, 4 * s * bf.lw);
      radii(R).forEach((rr, i) => {
        ctx.strokeStyle = rgba(i === hot ? ink.ac : ink.fg, 1);
        ctx.beginPath();
        ctx.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + Math.max(0.01, sm[i]) * TAU * 0.85);
        ctx.stroke();
      });
      // sweep + trailing ticks
      const ph = a.beatPhase;
      const an = ph * TAU - Math.PI / 2;
      ctx.strokeStyle = rgba(ink.ac);
      ctx.lineWidth = Math.max(1.5, 2.2 * s);
      ctx.beginPath();
      const ti = Math.floor(ph * 60);
      for (let k = 0; k < 8; k++) {
        const tk = (((ti - k) % 60) + 60) % 60;
        const ta = (tk / 60) * TAU - Math.PI / 2;
        const r0 = R * (0.93 - 0.05 * (1 - k / 8));
        ctx.moveTo(cx + Math.cos(ta) * r0, cy + Math.sin(ta) * r0);
        ctx.lineTo(cx + Math.cos(ta) * R, cy + Math.sin(ta) * R);
      }
      ctx.stroke();
      ctx.strokeStyle = rgba(ink.fg, 0.7);
      ctx.lineWidth = bf.hl;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(an) * R * 0.44, cy + Math.sin(an) * R * 0.44);
      ctx.lineTo(cx + Math.cos(an) * R * 0.86, cy + Math.sin(an) * R * 0.86);
      ctx.stroke();
      // kick ring
      ring = Math.max(ring * Math.exp(-dt * 6), a.kick);
      if (ring > 0.02) {
        ctx.strokeStyle = rgba(ink.ac, ring);
        ctx.lineWidth = Math.max(1, (1 + ring * 4) * s);
        ctx.beginPath();
        ctx.arc(cx, cy, R * (1 - 0.02 * ring) - 3 * s, 0, TAU);
        ctx.stroke();
      }
      // centre counter
      pop = a.kickHit ? 1 : pop * Math.exp(-dt * 9);
      const big = R * 0.3 * (1 + 0.05 * pop);
      setFont(ctx, big, 500, MONO, -0.02);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = rgba(ink.fg);
      ctx.fillText(pad3(a.beatCount % 1000), cx, cy + big * 0.04);
      const fs = Math.max(6.5, R * 0.065);
      text(ctx, `BAR ${pad3(Math.floor(a.beatCount / 4) + 1)}`, cx, cy - big * 0.78, fs, rgba(ink.fg, 0.55), 'center');
      const beat = ((a.beatCount % 4) + 4) % 4;
      const q = Math.max(3, R * 0.04);
      for (let i = 0; i < 4; i++) {
        const x = cx + (i - 1.5) * q * 2.2 - q / 2;
        const y = cy + big * 0.7;
        ctx.fillStyle = i === beat ? rgba(ink.ac) : rgba(ink.fg, 0.2);
        ctx.fillRect(x, y, q, q);
      }
    },
  };
}

/* ───────────────────────── Pad grid (4×4) ───────────────────────── */

const PADS: [LayerId, string, boolean][] = [
  ['kick', 'KICK', true],
  ['snare', 'SNARE', true],
  ['hat', 'HAT', true],
  ['drop', 'DROP', true],
  ['sub', 'SUB', false],
  ['bass', 'BASS', false],
  ['lowMid', 'LO-MID', false],
  ['mid', 'MID', false],
  ['highMid', 'HI-MID', false],
  ['air', 'AIR', false],
  ['flux', 'FLUX', false],
  ['brightness', 'BRIGHT', false],
  ['energy', 'ENERGY', false],
  ['build', 'BUILD', false],
  ['level', 'LEVEL', false],
  ['beatPhase', 'PHASE', false],
];

function padGeo(r: Rect, n: number, s: number) {
  const ar = r.w / r.h;
  const cols = ar > 2.2 ? 8 : ar < 0.45 ? 2 : 4;
  const rows = Math.ceil(n / cols);
  const g = Math.max(2, Math.round(5 * s));
  const pw = (r.w - g * (cols - 1)) / cols;
  const ph = (r.h - g * (rows - 1)) / rows;
  return { cols, g, pw, ph };
}

export function pads(): Module {
  const sm = new Float32Array(PADS.length);
  return {
    label: 'PADS',
    meta: '16 LAYERS',
    drawStatic(ctx, r, sf) {
      const { cols, g, pw, ph } = padGeo(r, PADS.length, sf.s);
      ctx.strokeStyle = rgba(sf.ink.line);
      ctx.lineWidth = sf.hl;
      for (let i = 0; i < PADS.length; i++) {
        const x = r.x + (i % cols) * (pw + g);
        const y = r.y + Math.floor(i / cols) * (ph + g);
        ctx.beginPath();
        ctx.roundRect(crisp(x, sf.hl), crisp(y, sf.hl), Math.round(pw) - 1, Math.round(ph) - 1, 3 * sf.s);
        ctx.stroke();
      }
    },
    draw(ctx, r, bf) {
      const { ink, s, a, dt } = bf;
      const { cols, g, pw, ph } = padGeo(r, PADS.length, s);
      const fs = Math.max(6, Math.min(8.5 * s, ph * 0.2));
      for (let i = 0; i < PADS.length; i++) {
        const [id, lab, hit] = PADS[i];
        let v = clamp01(a[id]);
        if (id === 'beatPhase') v = 1 - v;
        sm[i] = hit ? Math.max(v, sm[i] * Math.exp(-dt * 10)) : damp(sm[i], v, 16, dt);
        const x = r.x + (i % cols) * (pw + g);
        const y = r.y + Math.floor(i / cols) * (ph + g);
        const val = sm[i];
        const fillA = hit ? val : Math.pow(val, 1.6) * 0.8;
        if (fillA > 0.01) {
          ctx.fillStyle = rgba(hit ? ink.ac : ink.fg, fillA);
          ctx.beginPath();
          ctx.roundRect(x + 2 * s, y + 2 * s, pw - 4 * s - 1, ph - 4 * s - 1, 2 * s);
          ctx.fill();
        }
        const onDark = fillA > 0.5;
        const tc = onDark ? rgba(ink.bg, 0.95) : rgba(ink.fg, 0.7);
        text(ctx, lab, x + 5 * s, y + fs * 1.1, fs, tc);
        // value bar along the bottom
        ctx.fillStyle = onDark ? rgba(ink.bg, 0.9) : rgba(ink.fg, 0.8);
        ctx.fillRect(x + 5 * s, y + ph - 6 * s, (pw - 10 * s) * val, Math.max(1, 1.5 * s));
      }
    },
  };
}

/* ───────────────────────── Knob row ───────────────────────── */

const KNOBS: [LayerId, string, boolean][] = [
  ['sub', 'SUB', false],
  ['bass', 'BASS', false],
  ['lowMid', 'LOW', false],
  ['mid', 'MID', false],
  ['highMid', 'HIGH', false],
  ['air', 'AIR', false],
  ['kick', 'KICK', true],
  ['snare', 'SNARE', true],
  ['hat', 'HAT', true],
  ['energy', 'NRG', false],
];

export function knobs(): Module {
  const sm = new Float32Array(KNOBS.length);
  const pk = new Float32Array(KNOBS.length);
  const A0 = Math.PI * 0.75;
  const SW = Math.PI * 1.5;
  const geo = (r: Rect, s: number) => {
    const n = Math.max(1, Math.min(KNOBS.length, Math.floor(r.w / (54 * s))));
    const cw = r.w / n;
    const R = Math.max(4, Math.min(cw * 0.34, r.h * 0.27));
    return { n, cw, R, cy: r.y + r.h * 0.5 };
  };
  return {
    label: 'LAYERS',
    meta: 'KNOB · PEAK HOLD',
    drawStatic(ctx, r, sf) {
      const { n, cw, R, cy } = geo(r, sf.s);
      const { ink, s } = sf;
      const fs = Math.max(6.5, Math.min(9.5 * s, cw * 0.16));
      for (let i = 0; i < n; i++) {
        const cx = r.x + cw * (i + 0.5);
        ctx.strokeStyle = rgba(ink.mu);
        ctx.lineWidth = Math.max(1, 2.5 * s * sf.lw);
        ctx.beginPath();
        ctx.arc(cx, cy, R, A0, A0 + SW);
        ctx.stroke();
        ctx.strokeStyle = rgba(ink.fg, 0.4);
        ctx.lineWidth = sf.hl;
        ctx.beginPath();
        for (let k = 0; k <= 10; k++) {
          const an = A0 + (SW * k) / 10;
          const r0 = R * 1.18;
          const r1 = R * (k % 5 === 0 ? 1.34 : 1.26);
          ctx.moveTo(cx + Math.cos(an) * r0, cy + Math.sin(an) * r0);
          ctx.lineTo(cx + Math.cos(an) * r1, cy + Math.sin(an) * r1);
        }
        ctx.stroke();
        text(ctx, KNOBS[i][1], cx, r.y + fs * 0.7, fs, rgba(ink.fg, 0.8), 'center');
      }
    },
    draw(ctx, r, bf) {
      const { ink, s, a, dt } = bf;
      const { n, cw, R, cy } = geo(r, s);
      const fs = Math.max(6.5, Math.min(9.5 * s, cw * 0.16));
      for (let i = 0; i < n; i++) {
        const [id, , hit] = KNOBS[i];
        const v = clamp01(a[id]);
        sm[i] = hit ? Math.max(v, sm[i] * Math.exp(-dt * 7)) : damp(sm[i], v, 12, dt);
        pk[i] = Math.max(pk[i] - dt * 0.35, sm[i]);
        const val = sm[i];
        const cx = r.x + cw * (i + 0.5);
        if (hit && val > 0.02) {
          ctx.fillStyle = rgba(ink.ac, val * 0.18);
          ctx.beginPath();
          ctx.arc(cx, cy, R * 0.92, 0, TAU);
          ctx.fill();
        }
        const end = A0 + SW * Math.max(0.005, val);
        ctx.lineCap = 'round';
        ctx.strokeStyle = rgba(ink.ac, 0.1 + 0.22 * val);
        ctx.lineWidth = Math.max(3, 8 * s * bf.lw);
        ctx.beginPath();
        ctx.arc(cx, cy, R, A0, end);
        ctx.stroke();
        ctx.strokeStyle = rgba(ink.ac);
        ctx.lineWidth = Math.max(1.2, 2.5 * s * bf.lw);
        ctx.beginPath();
        ctx.arc(cx, cy, R, A0, end);
        ctx.stroke();
        ctx.lineCap = 'butt';
        // pointer
        ctx.strokeStyle = rgba(ink.fg);
        ctx.lineWidth = Math.max(1, 1.5 * s);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(end) * R * 0.2, cy + Math.sin(end) * R * 0.2);
        ctx.lineTo(cx + Math.cos(end) * R * 0.72, cy + Math.sin(end) * R * 0.72);
        ctx.stroke();
        // peak hold tick
        const pa = A0 + SW * pk[i];
        ctx.strokeStyle = rgba(ink.fg, 0.8);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(pa) * R * 0.86, cy + Math.sin(pa) * R * 0.86);
        ctx.lineTo(cx + Math.cos(pa) * R * 1.12, cy + Math.sin(pa) * R * 1.12);
        ctx.stroke();
        text(ctx, fmt2(val), cx, r.y + r.h - fs * 0.6, fs, rgba(ink.fg, 0.9), 'center');
      }
    },
  };
}

/* ───────────────────────── Scope ───────────────────────── */

function divGrid(ctx: CanvasRenderingContext2D, r: Rect, sf: SF, nx: number, ny: number) {
  ctx.fillStyle = rgba(sf.ink.fg, 0.16);
  const d = Math.max(1, Math.round(sf.s));
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny * 4; j++) ctx.fillRect(Math.round(r.x + (r.w * i) / nx), Math.round(r.y + (r.h * j) / (ny * 4)), d, d);
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx * 4; i++) ctx.fillRect(Math.round(r.x + (r.w * i) / (nx * 4)), Math.round(r.y + (r.h * j) / ny), d, d);
  ctx.fillStyle = rgba(sf.ink.line);
  ctx.fillRect(r.x, Math.round(r.y + r.h / 2), r.w, sf.hl);
  ctx.fillRect(Math.round(r.x + r.w / 2), r.y, sf.hl, r.h);
}

export function scope(): Module {
  return {
    label: 'SCOPE',
    meta: '512 SMP',
    drawStatic(ctx, r, sf) {
      divGrid(ctx, r, sf, 8, 4);
    },
    draw(ctx, r, bf) {
      const w = bf.a.waveform;
      let trig = 0;
      for (let i = 1; i < 256; i++)
        if (w[i - 1] <= 0 && w[i] > 0) {
          trig = i;
          break;
        }
      let amp = 0.12;
      for (let i = 0; i < 512; i += 4) amp = Math.max(amp, Math.abs(w[i]));
      const g = (r.h * 0.42) / amp;
      const N = 256;
      const cy = r.y + r.h / 2;
      ctx.strokeStyle = rgba(bf.ink.ac);
      ctx.lineWidth = Math.max(1, 1.6 * bf.s * bf.lw);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let k = 0; k < N; k++) {
        const x = r.x + (r.w * k) / (N - 1);
        const y = cy - (w[(trig + k) % 512] || 0) * g;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      text(ctx, `×${(1 / amp).toFixed(1)}`, r.x + r.w - 2 * bf.s, r.y + r.h - 8 * bf.s, Math.max(6, 8 * bf.s), rgba(bf.ink.fg, 0.5), 'right');
    },
  };
}

/* ───────────────────────── Spectrum bars ───────────────────────── */

export function spectrumBars(): Module {
  const NB = 48;
  const sm = new Float32Array(NB);
  const peak = new Float32Array(NB);
  return {
    label: 'SPECTRUM',
    meta: '48 BAND',
    drawStatic(ctx, r, sf) {
      ctx.fillStyle = rgba(sf.ink.fg, 0.14);
      for (let j = 1; j < 4; j++) {
        const y = Math.round(r.y + (r.h * j) / 4);
        for (let x = r.x; x < r.x + r.w; x += 4 * sf.s + 2) ctx.fillRect(Math.round(x), y, Math.max(1, sf.s), 1);
      }
      ctx.fillStyle = rgba(sf.ink.fg, 0.6);
      ctx.fillRect(r.x, r.y + r.h - sf.hl, r.w, sf.hl);
    },
    draw(ctx, r, bf) {
      const { ink, s, a, dt } = bf;
      const bw = r.w / NB;
      for (let i = 0; i < NB; i++) {
        const b0 = Math.floor((i / NB) * 124) + 2;
        const v = Math.max(a.spectrum[b0], a.spectrum[b0 + 1], a.spectrum[b0 + 2]) || 0;
        sm[i] = damp(sm[i], v, 20, dt);
        peak[i] = Math.max(peak[i] - dt * 0.45, sm[i]);
      }
      const bwi = Math.max(1, bw * 0.58);
      ctx.fillStyle = rgba(ink.fg, 0.88);
      for (let i = 0; i < NB; i++) {
        const hh = sm[i] * r.h;
        if (sm[i] < 0.7) ctx.fillRect(r.x + i * bw, r.y + r.h - hh, bwi, hh);
      }
      ctx.fillStyle = rgba(ink.ac);
      for (let i = 0; i < NB; i++) {
        const hh = sm[i] * r.h;
        if (sm[i] >= 0.7) ctx.fillRect(r.x + i * bw, r.y + r.h - hh, bwi, hh);
        ctx.fillRect(r.x + i * bw, r.y + r.h - peak[i] * r.h - Math.max(1, 1.5 * s), bwi, Math.max(1, 1.5 * s));
      }
    },
  };
}

/* ───────────────────────── Vector (lissajous) ───────────────────────── */

export function vectorScope(): Module {
  const P = 256;
  const prev = new Float32Array(P * 2);
  const curr = new Float32Array(P * 2);
  return {
    label: 'VECTOR',
    meta: 'LISSAJOUS',
    drawStatic(ctx, r, sf) {
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const R = Math.min(r.w, r.h) * 0.46;
      ctx.strokeStyle = rgba(sf.ink.line);
      ctx.lineWidth = sf.hl;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.moveTo(cx - R * 0.707, cy - R * 0.707);
      ctx.lineTo(cx + R * 0.707, cy + R * 0.707);
      ctx.moveTo(cx + R * 0.707, cy - R * 0.707);
      ctx.lineTo(cx - R * 0.707, cy + R * 0.707);
      ctx.stroke();
      const fs = Math.max(6, 7.5 * sf.s);
      text(ctx, 'L', cx - R * 0.78, cy - R * 0.78, fs, rgba(sf.ink.fg, 0.5), 'center');
      text(ctx, 'R', cx + R * 0.78, cy - R * 0.78, fs, rgba(sf.ink.fg, 0.5), 'center');
    },
    draw(ctx, r, bf) {
      const w = bf.a.waveform;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const R = Math.min(r.w, r.h) * 0.46;
      let amp = 0.15;
      for (let i = 0; i < 512; i += 4) amp = Math.max(amp, Math.abs(w[i]));
      const g = (R * 0.9) / (amp * 1.414);
      if (bf.live) {
        prev.set(curr);
        for (let i = 0; i < P; i++) {
          const x = w[i * 2] || 0;
          const y = w[(i * 2 + 37) % 512] || 0;
          curr[i * 2] = (x - y) * 0.707 * g;
          curr[i * 2 + 1] = -(x + y) * 0.707 * g;
        }
      }
      const line = (buf: Float32Array, c: string) => {
        ctx.strokeStyle = c;
        ctx.beginPath();
        for (let i = 0; i < P; i++) {
          const x = cx + buf[i * 2];
          const y = cy + buf[i * 2 + 1];
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
      ctx.lineWidth = Math.max(0.8, 1.1 * bf.s * bf.lw);
      ctx.lineJoin = 'round';
      line(prev, rgba(bf.ink.ac2, 0.55));
      line(curr, rgba(bf.ink.ac, 0.95));
    },
  };
}

/* ───────────────────────── Track overview waveform ───────────────────────── */

export function overview(): Module {
  let bars: Float32Array | null = null;
  let barsFor: Float32Array | null = null;
  const hist = new Ring(320);
  const tick = makeTicker();
  return {
    label: 'WAVEFORM',
    meta: 'TRACK',
    drawStatic(ctx, r, sf) {
      ctx.fillStyle = rgba(sf.ink.fg, 0.12);
      ctx.fillRect(r.x, Math.round(r.y + r.h / 2), r.w, 1);
    },
    draw(ctx, r, bf) {
      const { ink, s, a } = bf;
      const an = bf.f.analysis;
      const step = Math.max(2, 3 * s);
      const n = Math.max(8, Math.floor(r.w / step));
      const cy = r.y + r.h / 2;
      ctx.lineWidth = Math.max(1, step * 0.55);
      if (an && an.overview && an.overview.length) {
        if (barsFor !== an.overview || !bars || bars.length !== n) {
          barsFor = an.overview;
          bars = new Float32Array(n);
          const src = an.overview;
          for (let i = 0; i < n; i++) {
            const i0 = Math.floor((i / n) * src.length);
            const i1 = Math.max(i0 + 1, Math.floor(((i + 1) / n) * src.length));
            let m = 0;
            for (let k = i0; k < i1; k++) m = Math.max(m, src[k]);
            bars[i] = m;
          }
        }
        const dur = a.duration || an.duration || 1;
        const prog = clamp01(a.time / dur);
        const pxp = r.x + r.w * prog;
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass === 0 ? rgba(ink.fg, 0.9) : rgba(ink.fg, 0.28);
          ctx.beginPath();
          for (let i = 0; i < n; i++) {
            const x = r.x + (i + 0.5) * (r.w / n);
            if ((x < pxp) !== (pass === 0)) continue;
            const hh = Math.max(0.5, bars![i] * r.h * 0.46);
            ctx.moveTo(x, cy - hh);
            ctx.lineTo(x, cy + hh);
          }
          ctx.stroke();
        }
        ctx.fillStyle = rgba(ink.ac);
        ctx.fillRect(Math.round(pxp), r.y, Math.max(1, bf.hl), r.h);
      } else {
        if (bf.live) {
          const k = tick(bf.dt, 40 * bf.speed);
          for (let i = 0; i < k; i++) hist.push(clamp01(a.level) * (0.45 + 0.55 * Math.random()));
        }
        ctx.strokeStyle = rgba(ink.fg, 0.88);
        ctx.beginPath();
        const N = Math.min(n, hist.n);
        for (let i = 0; i < N; i++) {
          const v = hist.at(hist.n - N + i);
          const x = r.x + (i + 0.5) * (r.w / N);
          const hh = Math.max(0.5, v * r.h * 0.46);
          ctx.moveTo(x, cy - hh);
          ctx.lineTo(x, cy + hh);
        }
        ctx.stroke();
        ctx.fillStyle = rgba(ink.ac);
        ctx.fillRect(r.x + r.w - Math.max(1, bf.hl), r.y, Math.max(1, bf.hl), r.h);
      }
    },
  };
}

/* ───────────────────────── Line graph ───────────────────────── */

export function lineGraph(series: { id: LayerId; label: string; tone: 'fg' | 'ac' | 'ac2' }[], label = 'ENERGY', meta = 'NRG · LVL · BRT'): Module {
  const N = 200;
  const rings = series.map(() => new Ring(N));
  const sm = new Float32Array(series.length);
  const tick = makeTicker();
  const lc = (s: number) => Math.round(26 * s);
  const rc = (s: number) => Math.round(62 * s);
  return {
    label,
    meta,
    drawStatic(ctx, r, sf) {
      const fs = Math.max(6, 7.5 * sf.s);
      for (let j = 0; j <= 4; j++) {
        const y = Math.round(r.y + r.h - (r.h * j) / 4);
        ctx.fillStyle = rgba(sf.ink.fg, j === 0 ? 0.5 : 0.12);
        ctx.fillRect(r.x + lc(sf.s), Math.min(y, r.y + r.h - 1), r.w - lc(sf.s) - rc(sf.s), 1);
        text(ctx, (j / 4).toFixed(2).slice(j === 4 ? 0 : 1), r.x, y, fs, rgba(sf.ink.fg, 0.45));
      }
    },
    draw(ctx, r, bf) {
      const { ink, s, a } = bf;
      const n = bf.live ? tick(bf.dt, 24 * bf.speed) : 0;
      series.forEach((se, i) => {
        sm[i] = damp(sm[i], clamp01(a[se.id]), 10, bf.dt);
        for (let k = 0; k < n; k++) rings[i].push(sm[i]);
      });
      const x0 = r.x + lc(s);
      const W = r.w - lc(s) - rc(s);
      const tone = (t: string): RGB => (t === 'ac' ? ink.ac : t === 'ac2' ? ink.ac2 : ink.fg);
      // area under first series
      ctx.fillStyle = rgba(tone(series[0].tone), 0.07);
      ctx.beginPath();
      ctx.moveTo(x0, r.y + r.h);
      for (let k = 0; k < N; k++) ctx.lineTo(x0 + (W * k) / (N - 1), r.y + r.h - rings[0].at(k) * r.h);
      ctx.lineTo(x0 + W, r.y + r.h);
      ctx.fill();
      ctx.lineWidth = Math.max(1, 1.4 * s * bf.lw);
      ctx.lineJoin = 'round';
      const fs = Math.max(6, 8 * s);
      let lastY = -1e9;
      const order = series.map((_, i) => i).sort((p, q) => sm[q] - sm[p]);
      for (const i of order) {
        const se = series[i];
        const c = tone(se.tone);
        ctx.strokeStyle = rgba(c);
        ctx.beginPath();
        for (let k = 0; k < N; k++) {
          const x = x0 + (W * k) / (N - 1);
          const y = r.y + r.h - rings[i].at(k) * r.h;
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        const ey = r.y + r.h - rings[i].at(N - 1) * r.h;
        ctx.fillStyle = rgba(c);
        ctx.fillRect(x0 + W - 2 * s, ey - 2 * s, 4 * s + 1, 4 * s + 1);
        let ly = Math.max(ey, lastY + fs * 1.3);
        ly = Math.min(ly, r.y + r.h - fs * 0.5);
        lastY = ly;
        text(ctx, `${se.label} ${fmt2(sm[i])}`, x0 + W + 6 * s, ly, fs, rgba(c));
      }
    },
  };
}

/* ───────────────────────── Chroma / pitch ───────────────────────── */

export function chroma(): Module {
  const pcOf = new Int8Array(128).fill(-1);
  const lo = Math.round(hzBin(80));
  const hi = Math.round(hzBin(5000));
  for (let i = lo; i <= hi; i++) {
    const m = Math.round(69 + 12 * Math.log2(binHz(i) / 440));
    pcOf[i] = ((m % 12) + 12) % 12;
  }
  const acc = new Float32Array(12);
  const sm = new Float32Array(12);
  let dom = 0;
  let domHz = 440;
  return {
    label: 'PITCH',
    meta: 'CHROMA · 12',
    draw(ctx, r, bf) {
      const { ink, s, a, dt } = bf;
      acc.fill(0);
      let best = -1;
      let bestV = 0;
      for (let i = lo; i <= hi; i++) {
        const v = a.spectrum[i] || 0;
        acc[pcOf[i]] += v * v;
        if (v > bestV) {
          bestV = v;
          best = i;
        }
      }
      let mx = 1e-6;
      for (let k = 0; k < 12; k++) mx = Math.max(mx, acc[k]);
      for (let k = 0; k < 12; k++) sm[k] = damp(sm[k], acc[k] / mx, 10, dt);
      if (bf.live && best >= 0) {
        dom = strongest(sm);
        domHz = damp(domHz, binHz(best), 6, dt);
      }
      const tall = r.h > r.w * 0.8;
      const big = Math.min(tall ? r.w * 0.3 : r.h * 0.5, r.w * 0.22) * (tall ? 1.3 : 1);
      const rx = r.x;
      setFont(ctx, big, 500, MONO, -0.03);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = rgba(ink.ac2);
      ctx.fillText(NOTE_NAMES[dom], rx, r.y + big * 0.82);
      const fs = Math.max(6.5, 8 * s);
      text(ctx, `${domHz.toFixed(1)} HZ`, rx, r.y + big * 0.82 + fs * 1.4, fs, rgba(ink.fg, 0.6));
      const bx = tall ? r.x : r.x + big * 1.55 + 8 * s;
      const by = tall ? r.y + big * 0.82 + fs * 2.6 : r.y;
      const bw = r.x + r.w - bx;
      const bh = r.y + r.h - by - fs * 1.5;
      if (bh < 6 || bw < 20) return;
      const cw = bw / 12;
      for (let k = 0; k < 12; k++) {
        const hh = Math.max(1, sm[k] * bh);
        ctx.fillStyle = k === dom ? rgba(ink.ac2) : rgba(ink.fg, 0.25 + 0.6 * sm[k]);
        ctx.fillRect(bx + k * cw + cw * 0.18, by + bh - hh, cw * 0.64, hh);
        text(ctx, NOTE_NAMES[k], bx + (k + 0.5) * cw, by + bh + fs * 0.9, Math.min(fs, cw * 0.42), rgba(ink.fg, k === dom ? 1 : 0.45), 'center');
      }
    },
  };
}

/* ───────────────────────── LED meters ───────────────────────── */

const METERS: [LayerId, string][] = [
  ['level', 'LVL'],
  ['sub', 'SUB'],
  ['bass', 'BAS'],
  ['mid', 'MID'],
  ['highMid', 'HMD'],
  ['air', 'AIR'],
];

export function meters(): Module {
  const SEG = 16;
  const sm = new Float32Array(METERS.length);
  const pk = new Float32Array(METERS.length);
  const geo = (r: Rect, s: number) => {
    const cw = r.w / METERS.length;
    const mw = Math.max(3, Math.min(cw * 0.5, 16 * s));
    const fs = Math.max(6, Math.min(8 * s, cw * 0.3));
    const top = r.y + fs * 1.4;
    const H = r.h - fs * 2.8;
    const g = Math.max(1, Math.round(1.5 * s));
    const sh = (H - g * (SEG - 1)) / SEG;
    return { cw, mw, fs, top, H, g, sh };
  };
  return {
    label: 'METERS',
    meta: 'PEAK',
    drawStatic(ctx, r, sf) {
      const { cw, mw, fs, top, g, sh } = geo(r, sf.s);
      ctx.fillStyle = rgba(sf.ink.fg, 0.07);
      for (let m = 0; m < METERS.length; m++) {
        const x = r.x + cw * (m + 0.5) - mw / 2;
        for (let k = 0; k < SEG; k++) ctx.fillRect(Math.round(x), Math.round(top + k * (sh + g)), Math.round(mw), Math.max(1, Math.round(sh)));
      }
      METERS.forEach(([, lab], m) => text(ctx, lab, r.x + cw * (m + 0.5), r.y + r.h - fs * 0.6, fs, rgba(sf.ink.fg, 0.7), 'center'));
    },
    draw(ctx, r, bf) {
      const { ink, a, dt } = bf;
      const { cw, mw, fs, top, g, sh } = geo(r, bf.s);
      for (let m = 0; m < METERS.length; m++) {
        sm[m] = damp(sm[m], clamp01(a[METERS[m][0]]), 22, dt);
        pk[m] = Math.max(pk[m] - dt * 0.3, sm[m]);
        const lit = Math.round(sm[m] * SEG);
        const x = Math.round(r.x + cw * (m + 0.5) - mw / 2);
        for (let k = 0; k < lit; k++) {
          const seg = SEG - 1 - k;
          ctx.fillStyle = k >= SEG - 3 ? rgba(ink.ac2) : rgba(ink.fg, 0.88);
          ctx.fillRect(x, Math.round(top + seg * (sh + g)), Math.round(mw), Math.max(1, Math.round(sh)));
        }
        const pseg = SEG - 1 - Math.min(SEG - 1, Math.floor(pk[m] * SEG));
        ctx.fillStyle = rgba(ink.ac);
        ctx.fillRect(x, Math.round(top + pseg * (sh + g)), Math.round(mw), Math.max(1, Math.round(sh * 0.5)));
        text(ctx, fmt2(sm[m]), r.x + cw * (m + 0.5), r.y + fs * 0.5, fs * 0.9, rgba(ink.fg, 0.55), 'center');
      }
    },
  };
}

/* ───────────────────────── Step sequencer ───────────────────────── */

const LANES: ['kickHit' | 'snareHit' | 'hatHit' | 'onset', string][] = [
  ['kickHit', 'KCK'],
  ['snareHit', 'SNR'],
  ['hatHit', 'HAT'],
  ['onset', 'ONS'],
];

export function stepSeq(): Module {
  const STEPS = 16;
  const pat = new Float32Array(LANES.length * STEPS);
  const flash = new Float32Array(LANES.length);
  let last = -1;
  const geo = (r: Rect, s: number) => {
    const lc = Math.round(36 * s);
    const top = Math.round(14 * s);
    const gg = Math.max(1, Math.round(3 * s));
    const big = gg * 3;
    const pw = (r.w - lc - gg * (STEPS - 1) - big * 3) / STEPS;
    const ph = (r.h - top - gg * (LANES.length - 1)) / LANES.length;
    const xOf = (k: number) => r.x + lc + k * (pw + gg) + Math.floor(k / 4) * big;
    const yOf = (l: number) => r.y + top + l * (ph + gg);
    return { lc, top, pw, ph, xOf, yOf };
  };
  return {
    label: 'SEQUENCER',
    meta: '16 STEP · 1/16',
    drawStatic(ctx, r, sf) {
      const { pw, ph, xOf, yOf } = geo(r, sf.s);
      const fs = Math.max(6, Math.min(7.5 * sf.s, pw * 0.45));
      ctx.strokeStyle = rgba(sf.ink.line);
      ctx.lineWidth = sf.hl;
      for (let l = 0; l < LANES.length; l++) {
        text(ctx, LANES[l][1], r.x, yOf(l) + ph / 2, Math.max(6.5, 8.5 * sf.s), rgba(sf.ink.fg, 0.75));
        for (let k = 0; k < STEPS; k++) ctx.strokeRect(crisp(xOf(k), sf.hl), crisp(yOf(l), sf.hl), Math.round(pw) - 1, Math.round(ph) - 1);
      }
      for (let k = 0; k < STEPS; k++) text(ctx, String(k + 1).padStart(2, '0'), xOf(k) + pw / 2, r.y + fs * 0.6, fs, rgba(sf.ink.fg, k % 4 === 0 ? 0.7 : 0.35), 'center');
    },
    draw(ctx, r, bf) {
      const { ink, a, dt, s } = bf;
      const { pw, ph, xOf, yOf } = geo(r, s);
      const step = ((Math.floor((a.beatCount + a.beatPhase) * 4) % STEPS) + STEPS) % STEPS;
      if (bf.live) {
        if (step !== last) {
          for (let l = 0; l < LANES.length; l++) pat[l * STEPS + step] *= 0.55;
          last = step;
        }
        LANES.forEach(([flag], l) => {
          if (a[flag]) {
            pat[l * STEPS + step] = 1;
            flash[l] = 1;
          }
        });
      }
      for (let l = 0; l < LANES.length; l++) flash[l] *= Math.exp(-dt * 9);
      // current column wash
      ctx.fillStyle = rgba(ink.ac, 0.1);
      ctx.fillRect(xOf(step) - 1, yOf(0) - 1, pw + 2, yOf(LANES.length - 1) + ph - yOf(0) + 2);
      ctx.fillStyle = rgba(ink.ac);
      ctx.fillRect(xOf(step), r.y + Math.round(11 * s), pw, Math.max(1, 2 * s));
      const ins = Math.max(1, Math.round(2 * s));
      for (let l = 0; l < LANES.length; l++)
        for (let k = 0; k < STEPS; k++) {
          const v = pat[l * STEPS + k];
          if (v < 0.04) continue;
          const now = k === step && flash[l] > 0.05;
          ctx.fillStyle = now ? rgba(ink.ac2, 0.4 + 0.6 * flash[l]) : rgba(l === 0 ? ink.ac : ink.fg, 0.15 + 0.8 * v);
          ctx.fillRect(xOf(k) + ins, yOf(l) + ins, pw - ins * 2 - 1, ph - ins * 2 - 1);
        }
    },
  };
}
