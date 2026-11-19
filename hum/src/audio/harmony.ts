/**
 * Harmony: the song's key, its chords and how they move, worked out on this computer (no AI, no
 * network). Runs inside the analysis worker; no three / react / npm imports.
 *
 * 1. `chromagram` — eight times a second, a 4096-point spectrum (about 186 ms of sound) folded onto
 *    the 12 notes of the scale (a "chroma"). Only spectral peaks count, each placed by its exact
 *    frequency once the whole song's tuning is known, so a track tuned a little sharp or flat still
 *    lands on the right notes. A second chroma of just the low end (40–250 Hz) tells the bass note,
 *    which is usually the chord's root. The same spectra also feed the section finder and the old
 *    major/minor lean, so the analysis does fewer FFTs than it did before harmony existed.
 * 2. `analyzeHarmony` — the chroma averaged over each beat → the major or minor chord that fits each
 *    beat best, smoothed so chords don't flicker (a Viterbi pass that makes changing chords cost a
 *    little, less on a bar line) → the chord changes, which sit on beats → the key of the song and of
 *    each section (key profiles, which chords are used, which chord phrases come home to) → key
 *    changes, including the lift up a step for a last chorus → harmonic tension per beat (how far
 *    the chord is from home, how dissonant it sounds) → resolutions (V → I, or tension falling onto
 *    the home chord) → which sections repeat which (even when transposed).
 */
import type { SectionHarmony, TrackChord, TrackHarmony, TrackKey, TrackResolution, TrackSection } from '../core/types';
import { FFT, hann, percentile } from './dsp';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);
const mod12 = (v: number) => ((v % 12) + 12) % 12;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** "A minor", "Eb major": flats for the keys that are written with flats */
export function keyName(tonic: number, minor: boolean): string {
  const flatKeys = minor ? [0, 2, 3, 5, 7, 10] : [1, 3, 5, 8, 10];
  const names = flatKeys.includes(tonic) ? FLAT_NAMES : NOTE_NAMES;
  return `${names[tonic]} ${minor ? 'minor' : 'major'}`;
}
function chordName(root: number, minor: boolean, flats: boolean): string {
  return (flats ? FLAT_NAMES : NOTE_NAMES)[root] + (minor ? 'm' : '');
}

/* ───────────────────────── 1. chroma ───────────────────────── */

export interface Chromagram {
  /** frames per second; frame j is centred on j / hz seconds */
  hz: number;
  n: number;
  /** n × 12: tuned pitch-class energy, 110–5000 Hz (spectral peaks only) */
  treble: Float32Array;
  /** n × 12: the same for the low end, 40–250 Hz */
  bass: Float32Array;
  /** n: how loud each frame is (rms) */
  level: Float32Array;
  /** n × 12: plain nearest-semitone fold of 60–4200 Hz (what the section finder always used) */
  plain: Float64Array;
  /** 12: loudness-weighted pitch-class shares over the whole song, 80–5000 Hz (the major/minor lean) */
  lean: number[];
  /** how far the song sits off A440, in semitones (−0.5 … 0.5) */
  tuning: number;
}

export const CHROMA_HZ = 8;
const CN = 4096;
const MAX_PEAKS = 72;

/**
 * Chroma frames for the whole track. `frames` should be 4 × the section finder's 2 Hz step count, so
 * frames 4i + 1 and 4i + 3 are exactly the two spectra it used to compute for its step i.
 */
export function chromagram(x: Float32Array, xLen: number, sr: number, frames: number, silent: number): Chromagram {
  const hz = CHROMA_HZ;
  const n = Math.max(1, frames);
  const half = CN / 2;
  const fft = new FFT(CN);
  const win = hann(CN);
  const { re, im } = fft;
  const cbin = sr / CN;
  const kTop = Math.min(half - 2, Math.ceil(5200 / cbin));
  // plain folds: nearest semitone, as the section finder and the old key lean did it
  const pcPlain = new Int8Array(half).fill(-1);
  const pcLean = new Int8Array(half).fill(-1);
  for (let k = 1; k <= kTop; k++) {
    const f = k * cbin;
    const pc = mod12(Math.round(12 * Math.log2(f / 440) + 69));
    if (f >= 60 && f <= 4200) pcPlain[k] = pc;
    if (f >= 80 && f <= 5000) pcLean[k] = pc;
  }
  const kPeakLo = Math.max(2, Math.floor(38 / cbin));
  const kPeakHi = Math.min(kTop, Math.ceil(5000 / cbin));

  const plain = new Float64Array(n * 12);
  const level = new Float32Array(n);
  const lean = new Array<number>(12).fill(0);
  const pkMidi = new Float32Array(n * MAX_PEAKS);
  const pkAmp = new Float32Array(n * MAX_PEAKS);
  const pkCount = new Uint8Array(n);
  const magA = new Float64Array(half);
  const magB = new Float64Array(half);
  const frame12 = new Float64Array(12);
  const cand: { m: number; a: number }[] = [];
  let tuneC = 0;
  let tuneS = 0;

  const offOf = (j: number) => Math.round((j / hz) * sr) - CN / 2;
  const inside = (o: number) => o >= 0 && o + CN <= xLen;

  const fold = (j: number, mag: Float64Array, off: number) => {
    let sq = 0;
    for (let i = 0; i < CN; i++) sq += x[off + i] * x[off + i];
    level[j] = Math.sqrt(sq / CN);
    // plain folds
    frame12.fill(0);
    let tot = 0;
    for (let k = 1; k <= kTop; k++) {
      const m = mag[k];
      const p = pcPlain[k];
      if (p >= 0) plain[j * 12 + p] += m;
      const q = pcLean[k];
      if (q >= 0) {
        frame12[q] += m;
        tot += m;
      }
    }
    if (level[j] > silent && tot > 0) for (let i = 0; i < 12; i++) lean[i] += (frame12[i] / tot) * level[j];
    // spectral peaks, placed by their interpolated frequency
    let top = 0;
    for (let k = kPeakLo; k <= kPeakHi; k++) if (mag[k] > top) top = mag[k];
    const thr = Math.max(top * 0.01, 1e-3);
    cand.length = 0;
    for (let k = kPeakLo; k <= kPeakHi; k++) {
      const b = mag[k];
      if (b <= thr || b <= mag[k - 1] || b < mag[k + 1]) continue;
      const la = Math.log(mag[k - 1] + 1e-12);
      const lb = Math.log(b);
      const lc = Math.log(mag[k + 1] + 1e-12);
      const den = la - 2 * lb + lc;
      const p = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (la - lc)) / den)) : 0;
      const f = (k + p) * cbin;
      const amp = Math.exp(lb - 0.25 * (la - lc) * p);
      const midi = 69 + 12 * Math.log2(f / 440);
      cand.push({ m: midi, a: amp });
      if (f >= 100 && f <= 2000) {
        const ang = 2 * Math.PI * midi;
        tuneC += amp * Math.cos(ang);
        tuneS += amp * Math.sin(ang);
      }
    }
    if (cand.length > MAX_PEAKS) {
      cand.sort((u, v) => v.a - u.a);
      cand.length = MAX_PEAKS;
    }
    pkCount[j] = cand.length;
    for (let i = 0; i < cand.length; i++) {
      pkMidi[j * MAX_PEAKS + i] = cand[i].m;
      pkAmp[j * MAX_PEAKS + i] = cand[i].a;
    }
  };

  // two real frames per complex FFT (one in re, one in im), separated afterwards
  for (let j = 0; j < n; j += 2) {
    const oa = offOf(j);
    const ob = offOf(j + 1);
    const va = inside(oa);
    const vb = j + 1 < n && inside(ob);
    if (!va && !vb) continue;
    for (let i = 0; i < CN; i++) {
      re[i] = va ? x[oa + i] * win[i] : 0;
      im[i] = vb ? x[ob + i] * win[i] : 0;
    }
    fft.run();
    for (let k = 1; k <= kTop + 1; k++) {
      const zr = re[k];
      const zi = im[k];
      const wr = re[CN - k];
      const wi = im[CN - k];
      const ar = zr + wr;
      const ai = zi - wi;
      const br = zi + wi;
      const bi = wr - zr;
      magA[k] = Math.sqrt(ar * ar + ai * ai) * 0.5;
      magB[k] = Math.sqrt(br * br + bi * bi) * 0.5;
    }
    if (va) fold(j, magA, oa);
    if (vb) fold(j + 1, magB, ob);
  }

  // the song's tuning: where its peaks sit between semitones, on average
  const tuning = tuneC === 0 && tuneS === 0 ? 0 : Math.atan2(tuneS, tuneC) / (2 * Math.PI);
  const treble = new Float32Array(n * 12);
  const bass = new Float32Array(n * 12);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < pkCount[j]; i++) {
      const m = pkMidi[j * MAX_PEAKS + i] - tuning;
      const r = Math.round(m);
      const d = m - r;
      // a peak halfway between two notes is noise, not a note
      const c = Math.cos(Math.PI * d);
      const w = pkAmp[j * MAX_PEAKS + i] * c * c;
      const pc = mod12(r);
      const f = 440 * Math.pow(2, (m - 69) / 12);
      if (f >= 110) treble[j * 12 + pc] += w;
      if (f <= 250) bass[j * 12 + pc] += w;
    }
  }
  return { hz, n, treble, bass, level, plain, lean, tuning: round2(tuning) };
}

/* ───────────────────────── 2. chords, key, tension ───────────────────────── */

/** a note's chroma including its first few overtones (octave, fifth, octave, major third, fifth) */
const NOTE_PROFILE = (() => {
  const p = new Float64Array(12);
  const offs = [0, 0, 7, 0, 4, 7];
  for (let h = 0; h < offs.length; h++) p[offs[h]] += Math.pow(0.6, h);
  return p;
})();

/** 24 triad templates (0–11 major on C…B, 12–23 minor), with overtones, square-rooted like the data, unit length */
const TEMPLATES: Float64Array[] = (() => {
  const out: Float64Array[] = [];
  for (let q = 0; q < 2; q++) {
    for (let r = 0; r < 12; r++) {
      const t = new Float64Array(12);
      for (const iv of [0, q ? 3 : 4, 7]) for (let k = 0; k < 12; k++) t[mod12(r + iv + k)] += NOTE_PROFILE[k];
      let nn = 0;
      for (let k = 0; k < 12; k++) {
        t[k] = Math.sqrt(t[k]);
        nn += t[k] * t[k];
      }
      nn = Math.sqrt(nn);
      for (let k = 0; k < 12; k++) t[k] /= nn;
      out.push(t);
    }
  }
  return out;
})();

const NC = 24; // chord states; 24 = no chord
const rootOf = (c: number) => c % 12;
const isMinor = (c: number) => c >= 12 && c < 24;
const chordId = (root: number, minor: boolean) => mod12(root) + (minor ? 12 : 0);

// Krumhansl–Kessler key profiles
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** chords that belong to a key, by (semitones above the tonic, minor?) */
const DIATONIC_MAJOR: [number, boolean][] = [
  [0, false],
  [2, true],
  [4, true],
  [5, false],
  [7, false],
  [9, true],
];
const DIATONIC_MINOR: [number, boolean][] = [
  [0, true],
  [3, false],
  [5, true],
  [7, true],
  [7, false],
  [8, false],
  [10, false],
];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10, 11]; // natural minor plus the raised 7th of V

/** how far a chord is from home in a key, 0 home … 1 far (its function more than its notes) */
function chordDistance(c: number, tonic: number, minor: boolean): number {
  if (c >= NC) return 0.2;
  const d = mod12(rootOf(c) - tonic);
  const m = isMinor(c);
  if (!minor) {
    if (d === 0 && !m) return 0;
    if (d === 9 && m) return 0.25; // vi
    if (d === 5 && !m) return 0.35; // IV
    if (d === 4 && m) return 0.4; // iii
    if (d === 2 && m) return 0.45; // ii
    if (d === 7 && !m) return 0.75; // V
    if (d === 10 && !m) return 0.5; // bVII
    if (d === 5 && m) return 0.5; // iv borrowed
    if ((d === 2 || d === 4 || d === 9) && !m) return 0.7; // secondary dominants
    return 0.65;
  }
  if (d === 0 && m) return 0;
  if (d === 8 && !m) return 0.3; // VI
  if (d === 3 && !m) return 0.3; // III
  if (d === 5 && m) return 0.45; // iv
  if (d === 10 && !m) return 0.5; // VII
  if (d === 7 && m) return 0.55; // v
  if (d === 7 && !m) return 0.8; // V
  if (d === 5 && !m) return 0.45; // IV (dorian)
  return 0.65;
}

export interface HarmonyOptions {
  beats: number[];
  /** downbeats (every 4th beat), so chords change most easily on bar lines */
  bars: number[];
  bpm: number;
  duration: number;
  sections: TrackSection[];
  /** resolution of the tension curve (same as the energy curve) */
  points: number;
}

export interface HarmonyResult {
  harmony: TrackHarmony;
  /** section groups after harmony confirmed which parts repeat (same length as `sections`) */
  groups: number[];
}

interface KeyGuess {
  tonic: number;
  minor: boolean;
  score: number;
  confidence: number;
}

export function analyzeHarmony(cg: Chromagram, o: HarmonyOptions): HarmonyResult | null {
  const { duration, sections } = o;
  if (duration < 8 || cg.n < 16) return null;
  const beatLen = 60 / Math.max(40, Math.min(220, o.bpm || 120));

  /* cells: one per beat (or every half second without a beat grid) */
  const edges: number[] = [];
  if (o.beats.length >= 8) {
    if (o.beats[0] > 0.15) edges.push(0);
    for (const b of o.beats) if (b < duration - 0.05) edges.push(b);
  } else for (let t = 0; t < duration - 0.05; t += 0.5) edges.push(t);
  edges.push(duration);
  const K = edges.length - 1;
  if (K < 8) return null;

  const T = new Float64Array(K * 12);
  const B = new Float64Array(K * 12);
  const lev = new Float64Array(K);
  const cnt = new Float64Array(K);
  for (let j = 0, k = 0; j < cg.n; j++) {
    const t = j / cg.hz;
    while (k < K - 1 && t >= edges[k + 1]) k++;
    if (t < edges[0] || t >= edges[K]) continue;
    for (let p = 0; p < 12; p++) {
      T[k * 12 + p] += cg.treble[j * 12 + p];
      B[k * 12 + p] += cg.bass[j * 12 + p];
    }
    lev[k] += cg.level[j];
    cnt[k]++;
  }
  for (let k = 0; k < K; k++) {
    if (cnt[k]) lev[k] /= cnt[k];
    else if (k > 0) {
      // a beat shorter than a frame step: borrow the one before
      for (let p = 0; p < 12; p++) {
        T[k * 12 + p] = T[(k - 1) * 12 + p];
        B[k * 12 + p] = B[(k - 1) * 12 + p];
      }
      lev[k] = lev[k - 1];
    }
  }
  const silentLev = Math.max(1e-4, percentile(lev, 0.95) * 0.04);

  // unit-length, square-rooted treble chroma per cell; bass chroma scaled to its loudest note
  const V = new Float64Array(K * 12);
  const Bn = new Float64Array(K * 12);
  const flat = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    let nn = 0;
    let mx = 0;
    let bm = 0;
    for (let p = 0; p < 12; p++) {
      const v = Math.sqrt(T[k * 12 + p]);
      V[k * 12 + p] = v;
      nn += v * v;
      mx = Math.max(mx, v);
      bm = Math.max(bm, B[k * 12 + p]);
    }
    nn = Math.sqrt(nn);
    if (nn > 0) for (let p = 0; p < 12; p++) V[k * 12 + p] /= nn;
    if (bm > 0) for (let p = 0; p < 12; p++) Bn[k * 12 + p] = Math.sqrt(B[k * 12 + p] / bm);
    // 1 when every note is about as loud (noise, drums), 0 when a few notes stand out
    flat[k] = nn > 0 ? clamp01((1 / Math.sqrt(12) / ((mx / nn) || 1) - 0.35) / 0.5) : 1;
  }

  /* chord per cell: template fit + the bass note, smoothed with Viterbi */
  const S = NC + 1;
  const emit = new Float64Array(K * S);
  for (let k = 0; k < K; k++) {
    const silent = lev[k] < silentLev;
    for (let c = 0; c < NC; c++) {
      const tp = TEMPLATES[c];
      let d = 0;
      for (let p = 0; p < 12; p++) d += V[k * 12 + p] * tp[p];
      const r = rootOf(c);
      d += 0.12 * Bn[k * 12 + r] + 0.04 * Bn[k * 12 + mod12(r + 7)] - 0.04 * Bn[k * 12 + mod12(r + (isMinor(c) ? 4 : 3))];
      emit[k * S + c] = silent ? 0 : d;
    }
    emit[k * S + NC] = silent ? 1 : 0.5 + 0.3 * flat[k];
  }
  const downSet = new Set(o.bars.map((b) => Math.round(b * 100)));
  const beatInBar = (k: number) => {
    if (!o.bars.length) return 0;
    if (downSet.has(Math.round(edges[k] * 100))) return 0;
    // two beats after a downbeat = the half bar
    return downSet.has(Math.round((edges[k] - 2 * beatLen) * 100)) || downSet.has(Math.round((edges[k - 2] ?? -9) * 100)) ? 2 : 1;
  };
  const KAPPA = 18;
  const path = viterbi(K, S, (k, s) => KAPPA * emit[k * S + s], (k) => {
    const pos = beatInBar(k);
    return pos === 0 ? 2.6 : pos === 2 ? 3.6 : 4.6;
  });

  /* chord segments */
  const flats = guessFlats(V, K);
  const segs: { a: number; b: number; c: number }[] = [];
  for (let k = 0; k < K; k++) {
    const last = segs[segs.length - 1];
    if (last && last.c === path[k]) last.b = k + 1;
    else segs.push({ a: k, b: k + 1, c: path[k] });
  }

  /* change times: the cell grid puts every change on a beat line, which is only as good as the beat
     grid. Look at the 8 Hz frames around each change for where the chord really turns, then land it
     on the nearest beat or half-beat when one is close */
  const changeAt = segs.map((sg) => edges[sg.a]);
  {
    const Vf = new Float64Array(cg.n * 12);
    for (let j = 0; j < cg.n; j++) {
      let nn = 0;
      for (let q = 0; q < 12; q++) {
        const v = Math.sqrt(cg.treble[j * 12 + q]);
        Vf[j * 12 + q] = v;
        nn += v * v;
      }
      nn = Math.sqrt(nn);
      if (nn > 0) for (let q = 0; q < 12; q++) Vf[j * 12 + q] /= nn;
    }
    const fit = (j: number, c: number) => {
      const tp = TEMPLATES[c];
      let d = 0;
      for (let q = 0; q < 12; q++) d += Vf[j * 12 + q] * tp[q];
      return d;
    };
    const grid: number[] = [];
    for (let k = 0; k < o.beats.length; k++) {
      grid.push(o.beats[k]);
      if (k + 1 < o.beats.length) grid.push((o.beats[k] + o.beats[k + 1]) / 2);
    }
    const nearestGrid = (t: number) => {
      let lo = 0;
      let hi = grid.length - 1;
      if (hi < 0) return t;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (grid[mid] < t) lo = mid;
        else hi = mid;
      }
      return Math.abs(grid[lo] - t) < Math.abs(grid[hi] - t) ? grid[lo] : grid[hi];
    };
    for (let i = 1; i < segs.length; i++) {
      const p = segs[i - 1];
      const q = segs[i];
      if (p.c >= NC || q.c >= NC) continue;
      const e = edges[q.a];
      const lo = Math.max(e - beatLen, (changeAt[i - 1] + e) / 2);
      const hi = Math.min(e + beatLen, (e + edges[q.b]) / 2);
      const j0 = Math.max(0, Math.ceil(lo * cg.hz));
      const j1 = Math.min(cg.n - 1, Math.floor(hi * cg.hz));
      if (j1 - j0 < 2) continue;
      let before = 0;
      let after = 0;
      for (let j = j0; j <= j1; j++) after += fit(j, q.c);
      let best = -Infinity;
      let bestS = Math.round(e * cg.hz);
      for (let sp = j0 + 1; sp <= j1; sp++) {
        before += fit(sp - 1, p.c);
        after -= fit(sp - 1, q.c);
        if (before + after > best) {
          best = before + after;
          bestS = sp;
        }
      }
      let t = (bestS - 0.5) / cg.hz;
      const g = nearestGrid(t);
      if (Math.abs(g - t) <= 0.13) t = g;
      if (t > lo && t < hi) changeAt[i] = t;
    }
  }

  /* where each section starts and ends, in cells */
  const cellOf = (t: number) => {
    let lo = 0;
    let hi = K - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (edges[mid] <= t + 1e-6) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const secCells = sections.map((s) => [cellOf(s.start), Math.max(cellOf(s.start) + 1, cellOf(Math.max(s.start, s.end - 1e-3)) + 1)] as [number, number]);
  const voicedIn = (a: number, b: number) => {
    let v = 0;
    for (let k = a; k < b; k++) if (path[k] < NC) v++;
    return v;
  };
  const keyable = (i: number) => voicedIn(secCells[i][0], secCells[i][1]) >= 8 && sections[i].end - sections[i].start >= 7;
  const scaleOf = (g: { tonic: number; minor: boolean }) => mod12(g.tonic + (g.minor ? 3 : 0));
  const sameKey = (p: { tonic: number; minor: boolean }, q: { tonic: number; minor: boolean }) => p.tonic === q.tonic && p.minor === q.minor;

  /* key of the song: the set of notes most of the song sits in (so a lifted last chorus doesn't drag
     the answer halfway), then major or minor from the sections in it and the chord the song opens on */
  const all = keyGuesses(V, path, segs, 0, K, null);
  const secGuess = sections.map((_, i) => (keyable(i) ? keyGuesses(V, path, segs, secCells[i][0], secCells[i][1], null) : null));
  const vote = new Float64Array(12);
  const firstSeen = new Array<number>(12).fill(Infinity);
  // each section votes for the set of notes it fits best, by its length; a section that can't decide
  // between two splits its vote. Earlier parts count a little more: a song is in the key it starts in,
  // even if it lifts later
  sections.forEach((s, i) => {
    const g = secGuess[i];
    if (!g) return;
    const w = (s.end - s.start) * (1.15 - 0.3 * ((s.start + s.end) / 2 / duration));
    const s1 = scaleOf(g[0]);
    const r2 = g.find((x) => scaleOf(x) !== s1)!;
    const share = Math.min(1, 0.5 + (g[0].score - r2.score) / 0.12);
    vote[s1] += w * share;
    vote[scaleOf(r2)] += w * (1 - share);
    firstSeen[s1] = Math.min(firstSeen[s1], s.start);
  });
  let songKey = all[0];
  let voted = -1;
  const anyKeyable = secGuess.some(Boolean);
  for (let sc = 0; sc < 12; sc++) if (anyKeyable && (voted < 0 || vote[sc] > vote[voted] + 1e-6 || (Math.abs(vote[sc] - vote[voted]) < 1e-6 && firstSeen[sc] < firstSeen[voted]))) voted = sc;
  if (voted >= 0) {
    // the relative major and minor share every note, and key profiles lean to the major (its home note
    // is the most common one in both); what tells them apart is where the song starts and ends
    const voicedSegs = segs.filter((sg) => sg.c < NC && sg.b - sg.a >= 2);
    const opener = voicedSegs[0]?.c ?? -1;
    const closer = voicedSegs[voicedSegs.length - 1]?.c ?? -1;
    let total = 0;
    sections.forEach((x, i) => (total += secGuess[i] ? x.end - x.start : 0));
    let dur = 0;
    let topConf = 0;
    const candScore = [0, 0];
    const cands = [
      { tonic: voted, minor: false },
      { tonic: mod12(voted + 9), minor: true },
    ];
    sections.forEach((s, i) => {
      const g = secGuess[i];
      if (!g || scaleOf(g[0]) !== voted) return;
      const d = s.end - s.start;
      dur += d;
      topConf += g[0].confidence * d;
      cands.forEach((c, ci) => (candScore[ci] += d * (g.find((x) => sameKey(x, c))?.score ?? 0)));
    });
    cands.forEach((c, ci) => {
      const home = chordId(c.tonic, c.minor);
      candScore[ci] = candScore[ci] / Math.max(1e-6, dur) + (opener === home ? 0.15 : 0) + (closer === home ? 0.1 : 0);
    });
    const win = candScore[1] > candScore[0] ? 1 : 0;
    // how much of the song plainly sits in these notes
    const share = dur / Math.max(1e-6, total);
    songKey = {
      ...cands[win],
      score: candScore[win],
      confidence: clamp01(0.6 * share * (topConf / Math.max(1e-6, dur)) + 0.4 * clamp01(Math.abs(candScore[1] - candScore[0]) / 0.15)),
    };
  }
  const key: TrackKey = { tonic: songKey.tonic, minor: songKey.minor, name: keyName(songKey.tonic, songKey.minor), confidence: round2(songKey.confidence) };

  /* key of each section: the key before it unless the section clearly sits in another */
  const secKeys: KeyGuess[] = [];
  sections.forEach((_, i) => {
    const [a, b] = secCells[i];
    const prev = secKeys[i - 1] ?? songKey;
    if (!keyable(i)) {
      secKeys.push({ ...prev, confidence: prev.confidence * 0.8 });
      return;
    }
    const g = keyGuesses(V, path, segs, a, b, { prev, song: songKey });
    let best = g[0];
    const prevScore = g.find((x) => sameKey(x, prev))?.score ?? -Infinity;
    // a neighbouring key (one sharp or flat apart) is more often borrowed chords than a real move
    const near = [5, 7].includes(mod12(scaleOf(best) - scaleOf(prev)));
    // the relative major / minor is the same set of notes: not a key change
    if (scaleOf(best) === scaleOf(prev)) best = { ...best, tonic: prev.tonic, minor: prev.minor };
    // a change has to win clearly
    else if (best.score - prevScore < (near ? 0.25 : 0.12)) best = { ...best, tonic: prev.tonic, minor: prev.minor };
    secKeys.push(best);
  });
  // a one-section excursion that only just won goes back to its neighbours' key
  for (let i = 1; i < secKeys.length - 1; i++) {
    const p = secKeys[i - 1];
    const q = secKeys[i + 1];
    const c = secKeys[i];
    if (p.tonic === q.tonic && p.minor === q.minor && (c.tonic !== p.tonic || c.minor !== p.minor) && c.confidence < 0.45) secKeys[i] = { ...p };
  }

  const keyChanges: TrackHarmony['keyChanges'] = [];
  const liftAt: boolean[] = sections.map(() => false);
  for (let i = 1; i < sections.length; i++) {
    const p = secKeys[i - 1];
    const c = secKeys[i];
    if (p.tonic === c.tonic && p.minor === c.minor) {
      liftAt[i] = liftAt[i - 1];
      continue;
    }
    let semis = mod12(c.tonic - p.tonic);
    if (semis > 6) semis -= 12;
    const lift = c.minor === p.minor && (semis === 1 || semis === 2);
    liftAt[i] = lift || (liftAt[i - 1] && semis > 0);
    keyChanges.push({ t: round2(sections[i].start), section: i, from: keyName(p.tonic, p.minor), to: keyName(c.tonic, c.minor), semitones: semis, lift });
  }

  /* tension per cell, in the key of its section */
  const keyAtCell = new Int16Array(K);
  const minorAtCell = new Uint8Array(K);
  for (let k = 0; k < K; k++) {
    keyAtCell[k] = songKey.tonic;
    minorAtCell[k] = songKey.minor ? 1 : 0;
  }
  sections.forEach((_, i) => {
    const [a, b] = secCells[i];
    for (let k = a; k < Math.min(K, b); k++) {
      keyAtCell[k] = secKeys[i].tonic;
      minorAtCell[k] = secKeys[i].minor ? 1 : 0;
    }
  });
  const tens = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    const c = path[k];
    const tonic = keyAtCell[k];
    const minor = !!minorAtCell[k];
    if (c >= NC) {
      tens[k] = lev[k] < silentLev ? 0.1 : 0.25;
      continue;
    }
    const func = chordDistance(c, tonic, minor);
    // dissonance: how much of the sound sits off the chord's own notes
    const tones = [rootOf(c), mod12(rootOf(c) + (isMinor(c) ? 3 : 4)), mod12(rootOf(c) + 7)];
    let on = 0;
    let off = 0;
    let out = 0;
    const scale = minor ? MINOR_SCALE : MAJOR_SCALE;
    for (let p = 0; p < 12; p++) {
      const e = V[k * 12 + p] * V[k * 12 + p];
      if (tones.includes(p)) on += e;
      else off += e;
      if (!scale.includes(mod12(p - tonic))) out += e;
    }
    const diss = clamp01((off / Math.max(1e-9, on + off) - 0.3) / 0.45);
    const outKey = clamp01(out / 0.35);
    tens[k] = clamp01(0.6 * func + 0.25 * diss + 0.15 * outKey);
  }
  // a touch of smoothing so a passing chord doesn't spike
  const tsm = new Float64Array(K);
  for (let k = 0; k < K; k++) tsm[k] = (tens[Math.max(0, k - 1)] + 2 * tens[k] + tens[Math.min(K - 1, k + 1)]) / 4;
  const tension = new Float32Array(o.points);
  for (let i = 0; i < o.points; i++) {
    const t = ((i + 0.5) / o.points) * duration;
    tension[i] = Math.round(tsm[cellOf(t)] * 1000) / 1000;
  }

  /* chords, changes and resolutions */
  const chords: TrackChord[] = segs.map((s, i) => ({
    t: round2(changeAt[i]),
    end: round2(i + 1 < segs.length ? changeAt[i + 1] : edges[s.b]),
    root: s.c < NC ? rootOf(s.c) : -1,
    minor: isMinor(s.c),
    name: s.c < NC ? chordName(rootOf(s.c), isMinor(s.c), flats) : 'N',
  }));
  const changes: number[] = [];
  const resolutions: TrackResolution[] = [];
  for (let i = 1; i < segs.length; i++) {
    const p = segs[i - 1];
    const q = segs[i];
    if (q.c >= NC) continue;
    changes.push(round2(changeAt[i]));
    if (p.c >= NC) continue;
    const tonic = keyAtCell[q.a];
    const minor = !!minorAtCell[q.a];
    const home = rootOf(q.c) === tonic && isMinor(q.c) === minor;
    if (!home) continue;
    const d = mod12(rootOf(p.c) - tonic);
    const pm = isMinor(p.c);
    let s = 0;
    if (d === 7 && !pm) s = 1; // V → I: the perfect cadence
    else if (d === 7 && pm) s = 0.65; // v → i
    else if (d === 5) s = 0.6; // IV → I: the "amen" cadence
    else if (d === 10 && !pm) s = 0.55; // bVII → I
    else if (d === 11) s = 0.7; // leading-tone chord
    const drop = (tsm[p.b - 1] + tsm[Math.max(p.a, p.b - 2)]) / 2 - (tsm[q.a] + tsm[Math.min(q.b - 1, q.a + 1)]) / 2;
    s = Math.max(s, clamp01(drop / 0.6));
    // it only settles if home holds for a moment
    const holds = q.b - q.a;
    s *= holds >= 2 ? 1 : 0.6;
    if (s >= 0.4) resolutions.push({ t: round2(changeAt[i]), strength: round2(s), from: chords[i - 1].name, to: chords[i].name });
  }

  /* per section: key, how fast the chords move, and what it repeats */
  const cen = sectionCentred(V, K, secCells);
  const repeats = sections.map(() => null as null | { of: number; sim: number; transpose: number });
  for (let j = 1; j < sections.length; j++) {
    let best: { of: number; sim: number; transpose: number } | null = null;
    for (let i = 0; i < j; i++) {
      if (sections[i].label !== sections[j].label && sections[i].group !== sections[j].group) continue;
      const m = matchSections(cen, secCells[i], secCells[j]);
      if (m && m.sim >= 0.75 && (!best || m.sim > best.sim + 0.02)) best = { of: i, ...m };
    }
    repeats[j] = best;
  }
  const secOut: SectionHarmony[] = sections.map((s, i) => {
    const [a, b] = secCells[i];
    let ch = 0;
    for (const seg of segs) if (seg.a > a && seg.a < b && seg.c < NC) ch++;
    // typical chord length: the median of the chords centred in this section (a section that starts or
    // ends mid-chord would otherwise read as faster than it is)
    const lens = segs
      .map((sg, si) => ({ sg, t0: changeAt[si], t1: si + 1 < segs.length ? changeAt[si + 1] : edges[sg.b] }))
      .filter(({ sg, t0, t1 }) => sg.c < NC && (t0 + t1) / 2 >= s.start && (t0 + t1) / 2 < s.end)
      .map(({ t0, t1 }) => (t1 - t0) / beatLen)
      .sort((p, q) => p - q);
    const medianLen = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
    let voiced = 0;
    for (let k = a; k < b; k++) if (path[k] < NC) voiced++;
    const beats = Math.max(1, (s.end - s.start) / beatLen);
    const k = secKeys[i];
    const r = repeats[i];
    const out: SectionHarmony = {
      key: { tonic: k.tonic, minor: k.minor, name: keyName(k.tonic, k.minor), confidence: round2(k.confidence) },
      beatsPerChord: voiced < 4 ? 0 : round2(medianLen),
      changesPerBar: voiced < 4 ? 0 : round2((ch / beats) * 4),
      tension: round2(meanOf(tsm, a, b)),
    };
    if (liftAt[i]) out.lift = true;
    if (r) {
      out.repeatOf = r.of;
      out.repeatSim = round2(r.sim);
      if (r.transpose) out.transpose = r.transpose;
    }
    return out;
  });

  /* groups: a part that plays the same chords as an earlier part with the same name joins its group */
  const groups = sections.map((s) => s.group);
  sections.forEach((s, j) => {
    const r = repeats[j];
    if (!r || r.sim < 0.85 || sections[r.of].label !== s.label) return;
    if (s.end - s.start < 4 * 4 * beatLen || sections[r.of].end - sections[r.of].start < 4 * 4 * beatLen) return;
    groups[j] = groups[r.of];
  });
  // renumber in order of first appearance
  const remap = new Map<number, number>();
  const finalGroups = groups.map((g) => {
    if (!remap.has(g)) remap.set(g, remap.size);
    return remap.get(g)!;
  });

  return {
    harmony: { key, tuning: cg.tuning, chords, changes, resolutions, keyChanges, sections: secOut, tension },
    groups: finalGroups,
  };
}

function meanOf(a: ArrayLike<number>, lo: number, hi: number): number {
  let s = 0;
  let n = 0;
  for (let k = Math.max(0, lo); k < Math.min(a.length, hi); k++, n++) s += a[k];
  return n ? s / n : 0;
}

/** best path through `S` states over `K` steps: emission log-score, and a cost to change state at step k */
function viterbi(K: number, S: number, logE: (k: number, s: number) => number, switchCost: (k: number) => number): Int16Array {
  const score = new Float64Array(S);
  const next = new Float64Array(S);
  const back = new Int16Array(K * S);
  for (let s = 0; s < S; s++) score[s] = logE(0, s);
  for (let k = 1; k < K; k++) {
    let best = 0;
    for (let s = 1; s < S; s++) if (score[s] > score[best]) best = s;
    const cost = switchCost(k);
    for (let s = 0; s < S; s++) {
      const stay = score[s];
      const move = score[best] - cost;
      if (stay >= move) {
        next[s] = stay;
        back[k * S + s] = s;
      } else {
        next[s] = move;
        back[k * S + s] = best;
      }
      next[s] += logE(k, s);
    }
    score.set(next);
  }
  const path = new Int16Array(K);
  let s = 0;
  for (let q = 1; q < S; q++) if (score[q] > score[s]) s = q;
  for (let k = K - 1; k >= 0; k--) {
    path[k] = s;
    s = back[k * S + s];
  }
  return path;
}

/** spell chords with flats when the flat notes are the ones heard most (Eb rather than D#) */
function guessFlats(V: Float64Array, K: number): boolean {
  const tot = new Float64Array(12);
  for (let k = 0; k < K; k++) for (let p = 0; p < 12; p++) tot[p] += V[k * 12 + p];
  // sharp keys use F# and C#; flat keys Bb and Eb
  return tot[10] + tot[3] > tot[6] + tot[1];
}

/**
 * Every key scored for cells [a, b): how well the notes fit its key profile, how many of the chords
 * belong to it, how much of the time sits on its home chord, how often V goes home, and whether
 * phrases start and end at home. Best first, with a confidence from the margin over the runner-up.
 */
function keyGuesses(
  V: Float64Array,
  path: Int16Array,
  segs: { a: number; b: number; c: number }[],
  a: number,
  b: number,
  bias: { prev: KeyGuess; song: KeyGuess } | null,
): KeyGuess[] {
  const prof = new Array<number>(12).fill(0);
  const dur = new Float64Array(NC);
  let voiced = 0;
  for (let k = a; k < b; k++) {
    if (path[k] >= NC) continue;
    voiced++;
    const c = path[k];
    dur[c]++;
    // mostly the notes of the chords heard, a little of the raw chroma: overtones (every note's fifth
    // rings in its third harmonic) make the chroma alone lean a fifth away, toward the dominant's key
    for (let p = 0; p < 12; p++) prof[p] += 0.3 * V[k * 12 + p];
    for (const iv of [0, isMinor(c) ? 3 : 4, 7]) prof[mod12(rootOf(c) + iv)] += 0.7;
  }
  const inside = segs.filter((s) => s.b > a && s.a < b && s.c < NC);
  const moves: [number, number][] = [];
  for (let i = 1; i < inside.length; i++) moves.push([inside[i - 1].c, inside[i].c]);
  const out: KeyGuess[] = [];
  for (let q = 0; q < 2; q++) {
    const minor = q === 1;
    for (let tonic = 0; tonic < 12; tonic++) {
      const ks = corr(prof, minor ? KK_MINOR : KK_MAJOR, tonic);
      let diat = 0;
      for (const [iv, m] of minor ? DIATONIC_MINOR : DIATONIC_MAJOR) diat += dur[chordId(tonic + iv, m)];
      const home = dur[chordId(tonic, minor)];
      const v = voiced || 1;
      let cad = 0;
      const dom = chordId(tonic + 7, false);
      const homeId = chordId(tonic, minor);
      // only V → I counts as a cadence here (VII → i is just as common as a passing move in major loops)
      for (const [p, n] of moves) if (n === homeId && p === dom) cad++;
      let score = 0.6 * ks + 0.4 * (diat / v) + 0.3 * (home / v) + 0.2 * Math.min(1, cad / Math.max(1, moves.length / 4));
      if (bias) {
        if (tonic === bias.prev.tonic && minor === bias.prev.minor) score += 0.06;
        if (tonic === bias.song.tonic && minor === bias.song.minor) score += 0.04;
      }
      out.push({ tonic, minor, score, confidence: 0 });
    }
  }
  out.sort((p, q) => q.score - p.score);
  const margin = out[0].score - out[1].score;
  // the runner-up that isn't just the relative key says how sure the set of notes is
  const rel = (g: KeyGuess) => mod12(g.tonic + (g.minor ? 3 : 0));
  const other = out.find((g) => rel(g) !== rel(out[0]))!;
  const scaleMargin = out[0].score - other.score;
  out[0].confidence = clamp01(0.55 * clamp01(scaleMargin / 0.35) + 0.45 * clamp01(margin / 0.15));
  return out;
}

function corr(a: number[], prof: number[], rot: number): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i];
    mb += prof[i];
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(i + rot) % 12] - ma;
    const y = prof[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db + 1e-12);
}

/** each cell's chroma with its section's average taken out, unit length: the chord motion, key-free */
function sectionCentred(V: Float64Array, K: number, cells: [number, number][]): Float64Array {
  const out = new Float64Array(K * 12);
  for (const [a, b] of cells) {
    const m = new Float64Array(12);
    for (let k = a; k < b; k++) for (let p = 0; p < 12; p++) m[p] += V[k * 12 + p] / Math.max(1, b - a);
    for (let k = a; k < Math.min(K, b); k++) {
      let nn = 0;
      for (let p = 0; p < 12; p++) {
        const v = V[k * 12 + p] - m[p];
        out[k * 12 + p] = v;
        nn += v * v;
      }
      nn = Math.sqrt(nn);
      if (nn > 1e-6) for (let p = 0; p < 12; p++) out[k * 12 + p] /= nn;
    }
  }
  return out;
}

/** do sections i and j play the same chords (maybe transposed, maybe a beat apart)? */
function matchSections(cen: Float64Array, ci: [number, number], cj: [number, number]): { sim: number; transpose: number } | null {
  const li = ci[1] - ci[0];
  const lj = cj[1] - cj[0];
  const L = Math.min(li, lj);
  if (L < 8) return null;
  let best = -2;
  let bestT = 0;
  let atZero = -2;
  for (let tr = 0; tr < 12; tr++) {
    for (let off = -1; off <= 1; off++) {
      let s = 0;
      let n = 0;
      for (let k = 0; k < L; k++) {
        const ki = ci[0] + k;
        const kj = cj[0] + k + off;
        if (kj < cj[0] || kj >= cj[1]) continue;
        let d = 0;
        // j is i moved up `tr` semitones
        for (let p = 0; p < 12; p++) d += cen[ki * 12 + p] * cen[kj * 12 + ((p + tr) % 12)];
        s += d;
        n++;
      }
      const v = n ? s / n : -2;
      if (tr === 0) atZero = Math.max(atZero, v);
      if (v > best) {
        best = v;
        bestT = tr;
      }
    }
  }
  if (atZero >= best - 0.03) return { sim: atZero, transpose: 0 };
  return { sim: best, transpose: bestT > 6 ? bestT - 12 : bestT };
}

/* ───────────────────────── words ───────────────────────── */

/** "every 2 beats", "every bar", "every 2 bars" */
export function chordPace(beatsPerChord: number): string {
  if (!(beatsPerChord > 0)) return 'rarely';
  const nice = [1, 2, 3, 4, 6, 8, 12, 16];
  const b = nice.reduce((p, q) => (Math.abs(Math.log(q / beatsPerChord)) < Math.abs(Math.log(p / beatsPerChord)) ? q : p), 4);
  if (b === 1) return 'every beat';
  if (b === 4) return 'every bar';
  if (b >= 8 && b % 4 === 0) return `every ${b / 4} bars`;
  return `every ${b} beats`;
}

const STEP_WORD: Record<number, string> = { 1: 'a half step', 2: 'a whole step', 3: 'a minor third', 4: 'a major third', 5: 'a fourth', 6: 'a tritone' };

/** one compact sentence for the song summary (and the director): key, chord pace, key changes */
export function describeHarmony(h: TrackHarmony, sections: TrackSection[], fmt: (t: number) => string): string {
  const sure = h.key.confidence >= 0.6 ? '' : h.key.confidence >= 0.3 ? 'probably ' : 'maybe ';
  // the song's usual chord pace, weighted by time, and the part that moves fastest
  const rated = h.sections.map((s, i) => ({ i, b: s.beatsPerChord, len: sections[i].end - sections[i].start })).filter((x) => x.b > 0);
  let pace = '';
  if (rated.length) {
    const sorted = [...rated].sort((p, q) => p.b - q.b);
    const total = sorted.reduce((s, x) => s + x.len, 0);
    let acc = 0;
    let median = sorted[0].b;
    for (const x of sorted) {
      acc += x.len;
      if (acc >= total / 2) {
        median = x.b;
        break;
      }
    }
    pace = `chords change about ${chordPace(median)}`;
    // the fastest-moving main part (not an intro or outro trailing off)
    const fast = sorted.find((x) => ['verse', 'chorus', 'drop', 'bridge', 'build'].includes(sections[x.i].label) && x.len >= 8) ?? sorted[0];
    if (['verse', 'chorus', 'drop', 'bridge', 'build'].includes(sections[fast.i].label) && fast.b <= median * 0.6 && chordPace(fast.b) !== chordPace(median)) pace += `, ${chordPace(fast.b)} in the ${sections[fast.i].label}`;
  }
  const moves = h.keyChanges.slice(0, 2).map((k) => {
    const up = k.semitones > 0;
    const step = STEP_WORD[Math.abs(k.semitones)] ?? `${Math.abs(k.semitones)} semitones`;
    return k.lift ? `lifts up ${step} at ${fmt(k.t)}` : `moves ${up ? 'up' : 'down'} ${step} to ${k.to} at ${fmt(k.t)}`;
  });
  const parts = [`Harmony: ${sure}${h.key.name}`, pace, ...moves].filter(Boolean);
  return `${parts.join('; ')}.`;
}
