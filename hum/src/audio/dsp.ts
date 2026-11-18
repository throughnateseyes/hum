/**
 * Small DSP kit shared by the offline analysis (runs inside the analysis worker).
 * No three / react / npm imports.
 */

/* ───────────────────────── FFT ───────────────────────── */

export class FFT {
  readonly n: number;
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;
  readonly re: Float64Array;
  readonly im: Float64Array;

  constructor(n: number) {
    this.n = n;
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n);
      this.sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  /** in-place forward transform of this.re / this.im */
  run() {
    const { n, rev, cos, sin, re, im } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = cos[k];
          const s = sin[k];
          const tre = re[l] * c + im[l] * s;
          const tim = im[l] * c - re[l] * s;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }
}

export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** RBJ biquad, run in place over `x[0..n)` */
export function biquad(x: Float32Array, n: number, kind: 'lp' | 'hp' | 'bp', f0: number, sr: number, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * Math.min(f0, sr * 0.49)) / sr;
  const cw = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (kind === 'lp') {
    b0 = (1 - cw) / 2;
    b1 = 1 - cw;
    b2 = b0;
  } else if (kind === 'hp') {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = b0;
  } else {
    b0 = al;
    b1 = 0;
    b2 = -al;
  }
  const a0 = 1 + al;
  const a1 = -2 * cw;
  const a2 = 1 - al;
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  const c1 = a1 / a0;
  const c2 = a2 / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    const y = b0 * v + b1 * x1 + b2 * x2 - c1 * y1 - c2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/** 4th-order low-pass at `fc`, then keep every `d`-th sample */
export function lowpassDecimate(x: Float32Array, n: number, sr: number, d: number, fc: number): { y: Float32Array; sr: number } {
  const t = x.slice(0, n);
  biquad(t, n, 'lp', fc, sr, 0.5412);
  biquad(t, n, 'lp', fc, sr, 1.3066);
  const m = Math.floor(n / d);
  const y = new Float32Array(m);
  for (let i = 0; i < m; i++) y[i] = t[i * d];
  return { y, sr: sr / d };
}

export function percentile(arr: ArrayLike<number>, q: number): number {
  if (arr.length === 0) return 0;
  const s = Float64Array.from(arr as ArrayLike<number>).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/**
 * Short-time magnitude spectra of a real signal, two frames per complex FFT (one in the real part,
 * one in the imaginary part, separated afterwards). Calls `frame(f, mag)` for f = 0, 1, 2… in order;
 * `mag` (length n/2, scaled so a full-scale sine reads about 1 × `gain`) is reused between calls.
 */
export function stftMags(sig: ArrayLike<number>, len: number, n: number, hop: number, gain: number, frame: (f: number, mag: Float64Array) => void): number {
  const half = n / 2;
  const nF = Math.max(1, Math.floor((Math.max(len, n) - n) / hop) + 1);
  const fft = new FFT(n);
  const win = hann(n);
  const { re, im } = fft;
  const ma = new Float64Array(half);
  const mb = new Float64Array(half);
  const scale = (4 / n) * gain;
  const at = (i: number) => (i < len ? sig[i] : 0);
  for (let f = 0; f < nF; f += 2) {
    const oa = f * hop;
    const ob = (f + 1) * hop;
    const two = f + 1 < nF;
    for (let i = 0; i < n; i++) {
      re[i] = at(oa + i) * win[i];
      im[i] = two ? at(ob + i) * win[i] : 0;
    }
    fft.run();
    for (let k = 1; k < half; k++) {
      const zr = re[k];
      const zi = im[k];
      const wr = re[n - k];
      const wi = im[n - k];
      // A = (Z[k] + conj Z[n−k]) / 2,  B = (Z[k] − conj Z[n−k]) / 2i
      const ar = zr + wr;
      const ai = zi - wi;
      const br = zi + wi;
      const bi = wr - zr;
      ma[k] = Math.sqrt(ar * ar + ai * ai) * 0.5 * scale;
      mb[k] = Math.sqrt(br * br + bi * bi) * 0.5 * scale;
    }
    frame(f, ma);
    if (two) frame(f + 1, mb);
  }
  return nF;
}
