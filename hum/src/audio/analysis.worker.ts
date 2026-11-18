/**
 * Offline track analysis, run in a module Worker.
 *
 * Input: mono samples + sample rate + preset tags. Output: a TrackAnalysis.
 * Self-contained: its own radix-2 FFT, no three / react / npm imports (types only).
 *
 * Pipeline (all on a ~22 kHz decimated copy):
 *   1024-pt STFT, hop 512 (~23 ms) → per-frame rms, band powers, centroid, log-flux, L1 flux
 *   → onset envelope → tempo (autocorrelation, 70–180 BPM) + beat phase
 *   → 2 Hz harmony/timbre/energy features → self-similarity → sections (bar-aligned) → repeats grouped → labels
 *   → the song taken apart (layers.ts): kick / snare / hat hits, bass and lead notes, vocal spans
 *   → drops: the low end and kick coming back after a build, breakdown or gap, each with a strength and a why
 *   → sparse 4096-pt chroma → major/minor lean
 *   → MoodProfile → character (one genre, instruments, a mood word) → sections → tags → preset suggestions → summary
 */
import type { MoodProfile, TrackAnalysis, TrackCharacter, TrackDrop, TrackSection } from '../core/types';
import { FFT, hann, percentile } from './dsp';
import { analyzeLayers, type LayerResult, type LayerStats } from './layers';

export interface AnalysisRequest {
  channel: Float32Array;
  sampleRate: number;
  presetTags: { id: string; tags: string[] }[];
  /** (L−R)/2 when the source is stereo — helps tell a centred voice from wide synths */
  side?: Float32Array | null;
}

export type AnalysisReply = { ok: true; analysis: TrackAnalysis } | { ok: false; error: string };

/* ───────────────────────── small helpers ───────────────────────── */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);
const map01 = (v: number, a: number, b: number) => clamp01((v - a) / (b - a));

function normalize(arr: Float32Array, q = 0.98): Float32Array {
  const ref = percentile(arr, q) || 1e-9;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = clamp01(arr[i] / ref);
  return out;
}

/** average `src` (length n) into `points` buckets */
function bucket(src: ArrayLike<number>, points: number): Float32Array {
  const out = new Float32Array(points);
  const n = src.length;
  if (n === 0) return out;
  for (let i = 0; i < points; i++) {
    const a = Math.floor((i * n) / points);
    const b = Math.max(a + 1, Math.floor(((i + 1) * n) / points));
    let s = 0;
    for (let j = a; j < b && j < n; j++) s += src[j];
    out[i] = s / Math.max(1, Math.min(b, n) - a);
  }
  return out;
}

function boxSmooth(src: Float32Array, radius: number): Float32Array {
  if (radius <= 0) return src.slice();
  const n = src.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + src[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(n, i + radius + 1);
    out[i] = (pre[b] - pre[a]) / (b - a);
  }
  return out;
}

function meanRange(arr: ArrayLike<number>, a: number, b: number): number {
  a = Math.max(0, Math.floor(a));
  b = Math.min(arr.length, Math.floor(b));
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += arr[i];
  return s / (b - a);
}

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/* ───────────────────────── tempo ───────────────────────── */

interface Tempo {
  bpm: number;
  /** beat times (s) */
  beats: number[];
}

function estimateTempo(env: Float32Array, fr: number, duration: number): Tempo {
  const n = env.length;
  if (n < fr * 4) return { bpm: 120, beats: [] };
  // detrend + half-wave rectify
  const w = Math.max(1, Math.round(fr * 0.5));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + env[i];
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w + 1);
    o[i] = Math.max(0, env[i] - (pre[b] - pre[a]) / (b - a));
  }
  const minLag = Math.max(2, Math.floor((60 * fr) / 400));
  const maxLag = Math.min(n - 2, Math.ceil((60 * fr) / 33));
  const ac = new Float64Array(maxLag + 2);
  for (let l = minLag; l <= maxLag; l++) {
    let s = 0;
    for (let i = 0; i + l < n; i++) s += o[i] * o[i + l];
    ac[l] = s / (n - l);
  }
  const acAt = (lag: number) => {
    if (lag < minLag || lag > maxLag) return 0;
    const i = Math.floor(lag);
    const f = lag - i;
    return ac[i] * (1 - f) + ac[Math.min(maxLag, i + 1)] * f;
  };
  let best = 120;
  let bestScore = -Infinity;
  const scoreOf = (bpm: number) => {
    const lag = (60 * fr) / bpm;
    const s = acAt(lag) + 0.5 * acAt(lag * 2) + 0.25 * acAt(lag / 2) + 0.15 * acAt(lag * 3);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 122) / 0.85, 2));
    return s * (0.75 + 0.25 * prior);
  };
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const s = scoreOf(bpm);
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }
  // refine to 0.1 BPM
  for (let bpm = best - 0.5; bpm <= best + 0.5; bpm += 0.1) {
    const s = scoreOf(bpm);
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }
  // fold into a sensible range
  while (best < 70) best *= 2;
  while (best > 180) best /= 2;
  const bpm = Math.round(best * 10) / 10;

  // beat phase: offset that collects the most onset energy on the grid
  const lag = (60 * fr) / bpm;
  let bestP = 0;
  let bestSum = -1;
  for (let p = 0; p < Math.ceil(lag); p++) {
    let s = 0;
    for (let t = p; t < n; t += lag) s += o[Math.round(t)] ?? 0;
    if (s > bestSum) {
      bestSum = s;
      bestP = p;
    }
  }
  const beats: number[] = [];
  for (let t = bestP / fr; t < duration; t += 60 / bpm) beats.push(t);
  return { bpm, beats };
}

function snapToBeat(t: number, beats: number[], maxDist: number): number {
  if (beats.length === 0) return t;
  // binary search
  let lo = 0;
  let hi = beats.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < t) lo = mid;
    else hi = mid;
  }
  const c = Math.abs(beats[lo] - t) < Math.abs(beats[hi] - t) ? beats[lo] : beats[hi];
  return Math.abs(c - t) <= maxDist ? c : t;
}

/* ───────────────────────── key / mode ───────────────────────── */

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function correlate(a: number[], b: number[], rot: number): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(i + rot) % 12] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db + 1e-12);
}

function estimateMode(chroma: number[]): { mode: number; key: string; minor: boolean; confidence: number } {
  let bestMaj = -2;
  let bestMin = -2;
  let kMaj = 0;
  let kMin = 0;
  for (let k = 0; k < 12; k++) {
    const cM = correlate(chroma, MAJOR, k);
    const cm = correlate(chroma, MINOR, k);
    if (cM > bestMaj) {
      bestMaj = cM;
      kMaj = k;
    }
    if (cm > bestMin) {
      bestMin = cm;
      kMin = k;
    }
  }
  const minor = bestMin > bestMaj;
  return {
    mode: clamp01(0.5 + (bestMaj - bestMin) * 3),
    key: minor ? `${NOTE_NAMES[kMin]} minor` : `${NOTE_NAMES[kMaj]} major`,
    minor,
    confidence: Math.max(bestMaj, bestMin),
  };
}

/* ───────────────────────── main analysis ───────────────────────── */

export function computeAnalysis(
  channel: Float32Array,
  sampleRate: number,
  presetTags: AnalysisRequest['presetTags'],
  sideIn?: Float32Array | null,
): TrackAnalysis {
  const duration = channel.length / sampleRate;
  const POINTS = 1000;

  // overview — peak per bucket on the full-rate signal
  const overview = new Float32Array(POINTS);
  {
    const n = channel.length;
    let gmax = 1e-9;
    for (let i = 0; i < POINTS; i++) {
      const a = Math.floor((i * n) / POINTS);
      const b = Math.max(a + 1, Math.floor(((i + 1) * n) / POINTS));
      let m = 0;
      for (let j = a; j < b && j < n; j++) {
        const v = channel[j] < 0 ? -channel[j] : channel[j];
        if (v > m) m = v;
      }
      overview[i] = m;
      if (m > gmax) gmax = m;
    }
    for (let i = 0; i < POINTS; i++) overview[i] = clamp01(overview[i] / gmax);
  }

  // decimate to ~22 kHz (box average — fine for analysis)
  const dec = Math.max(1, Math.round(sampleRate / 22050));
  const sr = sampleRate / dec;
  const xLen = Math.floor(channel.length / dec);
  const x = new Float32Array(Math.max(xLen, 4096));
  const decimate = (src: Float32Array, dst: Float32Array) => {
    if (dec === 1) dst.set(src.subarray(0, xLen));
    else {
      for (let i = 0; i < xLen; i++) {
        let s = 0;
        const o = i * dec;
        for (let k = 0; k < dec; k++) s += src[o + k];
        dst[i] = s / dec;
      }
    }
  };
  decimate(channel, x);
  let side: Float32Array | null = null;
  if (sideIn && sideIn.length >= channel.length) {
    side = new Float32Array(x.length);
    decimate(sideIn, side);
  }

  const N = 1024;
  const HOP = 512;
  const half = N / 2;
  const fr = sr / HOP;
  const nFrames = Math.max(1, Math.floor((Math.max(xLen, N) - N) / HOP) + 1);
  const fft = new FFT(N);
  const win = hann(N);
  const binHz = sr / N;

  // band index per bin: 0 sub, 1 bass, 2 lowMid, 3 mid, 4 highMid, 5 air, -1 ignore
  const bandOf = new Int8Array(half);
  for (let k = 0; k < half; k++) {
    const f = k * binHz;
    bandOf[k] = f < 20 ? -1 : f < 60 ? 0 : f < 250 ? 1 : f < 500 ? 2 : f < 2000 ? 3 : f < 6000 ? 4 : 5;
  }

  const rms = new Float32Array(nFrames);
  const lowP = new Float32Array(nFrames);
  const midP = new Float32Array(nFrames);
  const highP = new Float32Array(nFrames);
  const centroid = new Float32Array(nFrames);
  const logFlux = new Float32Array(nFrames);
  const l1Flux = new Float32Array(nFrames);
  const bandTotals = new Float64Array(6);
  const bands6 = new Float32Array(nFrames * 6);

  const mag = new Float64Array(half);
  const prevLog = new Float64Array(half);
  const prevNorm = new Float64Array(half);
  const scale = 4 / N;

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    const { re, im } = fft;
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const v = x[off + i] ?? 0;
      sq += v * v;
      re[i] = v * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sq / N);
    fft.run();
    let total = 0;
    let wsum = 0;
    let lp = 0;
    let mp = 0;
    let hp = 0;
    let lf = 0;
    for (let k = 1; k < half; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale;
      mag[k] = m;
      const b = bandOf[k];
      if (b >= 0) {
        const p = m * m;
        bandTotals[b] += p;
        bands6[f * 6 + b] += p;
        if (b <= 1) lp += p;
        else if (b <= 3) mp += p;
        else hp += p;
      }
      total += m;
      wsum += m * k * binHz;
      const lm = Math.log1p(1000 * m);
      const d = lm - prevLog[k];
      if (d > 0) lf += d;
      prevLog[k] = lm;
    }
    let nf = 0;
    const inv = total > 1e-12 ? 1 / total : 0;
    for (let k = 1; k < half; k++) {
      const v = mag[k] * inv;
      const d = v - prevNorm[k];
      if (d > 0) nf += d;
      prevNorm[k] = v;
    }
    lowP[f] = Math.sqrt(lp);
    midP[f] = Math.sqrt(mp);
    highP[f] = Math.sqrt(hp);
    centroid[f] = total > 1e-9 ? wsum / total : 0;
    logFlux[f] = lf;
    l1Flux[f] = total > 1e-6 ? nf : 0;
  }

  /* silence mask */
  const silentThresh = Math.max(1e-4, percentile(rms, 0.95) * 0.02);
  let activeFrames = 0;
  let dbSum = 0;
  let centroidSum = 0;
  let fluxSum = 0;
  let wCentroid = 0;
  for (let f = 0; f < nFrames; f++) {
    if (rms[f] <= silentThresh) continue;
    activeFrames++;
    dbSum += 20 * Math.log10(rms[f]);
    centroidSum += centroid[f] * rms[f];
    wCentroid += rms[f];
    fluxSum += l1Flux[f];
  }
  const active = Math.max(1, activeFrames);
  const activeDuration = Math.max(1, activeFrames / fr);
  const meanDb = activeFrames ? dbSum / active : -60;
  const meanCentroid = wCentroid > 0 ? centroidSum / wCentroid : 1000;
  const meanFlux = fluxSum / active;

  /* tempo */
  const tempo = estimateTempo(logFlux, fr, duration);
  const bpm = tempo.bpm;

  /* the song taken apart: drums, bass and lead notes, vocals */
  const lay = analyzeLayers({ x, xLen, sr, side, beats: tempo.beats, bpm });

  /* onset rate (density) */
  let onsets = 0;
  {
    const w = Math.max(1, Math.round(fr * 0.5));
    const pre = new Float64Array(nFrames + 1);
    for (let i = 0; i < nFrames; i++) pre[i + 1] = pre[i] + logFlux[i];
    const o = new Float32Array(nFrames);
    for (let i = 0; i < nFrames; i++) {
      const a = Math.max(0, i - w);
      const b = Math.min(nFrames, i + w + 1);
      o[i] = Math.max(0, logFlux[i] - (pre[b] - pre[a]) / (b - a));
    }
    let m = 0;
    let s2 = 0;
    for (let i = 0; i < nFrames; i++) {
      m += o[i];
      s2 += o[i] * o[i];
    }
    m /= nFrames;
    const sd = Math.sqrt(Math.max(0, s2 / nFrames - m * m));
    const thr = m + sd * 0.75;
    const gap = Math.max(1, Math.round(fr * 0.09));
    let last = -gap;
    for (let i = 1; i < nFrames - 1; i++) {
      if (rms[i] <= silentThresh) continue;
      if (o[i] > thr && o[i] >= o[i - 1] && o[i] >= o[i + 1] && i - last >= gap) {
        onsets++;
        last = i;
      }
    }
  }
  const onsetRate = onsets / activeDuration;

  /* chroma (sparse 4096-pt frames) */
  const chroma = new Array<number>(12).fill(0);
  {
    const CN = 4096;
    const cfft = new FFT(CN);
    const cwin = hann(CN);
    const cbin = sr / CN;
    const pcOf = new Int8Array(CN / 2).fill(-1);
    for (let k = 1; k < CN / 2; k++) {
      const f = k * cbin;
      if (f < 80 || f > 5000) continue;
      const midi = 12 * Math.log2(f / 440) + 69;
      pcOf[k] = ((Math.round(midi) % 12) + 12) % 12;
    }
    const step = Math.max(1, Math.round(nFrames / 1500));
    const frame = new Float64Array(12);
    for (let f = 0; f < nFrames; f += step) {
      if (rms[f] <= silentThresh) continue;
      const off = f * HOP;
      if (off + CN > xLen) break;
      for (let i = 0; i < CN; i++) {
        cfft.re[i] = x[off + i] * cwin[i];
        cfft.im[i] = 0;
      }
      cfft.run();
      frame.fill(0);
      let tot = 0;
      for (let k = 1; k < CN / 2; k++) {
        const pc = pcOf[k];
        if (pc < 0) continue;
        const m = Math.sqrt(cfft.re[k] * cfft.re[k] + cfft.im[k] * cfft.im[k]);
        frame[pc] += m;
        tot += m;
      }
      if (tot <= 0) continue;
      for (let i = 0; i < 12; i++) chroma[i] += (frame[i] / tot) * rms[f];
    }
  }
  const keyInfo = estimateMode(chroma);

  /* curves at overview resolution */
  const rmsN = normalize(rms);
  const energyCurve = boxSmooth(bucket(rmsN, POINTS), 2);
  const lowCurve = normalize(boxSmooth(bucket(lowP, POINTS), 1));
  const midCurve = normalize(boxSmooth(bucket(midP, POINTS), 1));
  const highCurve = normalize(boxSmooth(bucket(highP, POINTS), 1));

  /* 2 Hz series for structure */
  const R = 2;
  const S = Math.max(1, Math.ceil(duration * R));
  const E2 = boxSmooth(bucket(rmsN, S), 1);
  const L2 = boxSmooth(normalize(bucket(lowP, S)), 1);
  const H2 = boxSmooth(normalize(bucket(highP, S)), 1);
  const dbSeries = bucket(rms, S);

  /* dynamics: spread of short-term loudness (dB) over non-silent parts */
  let dynamicsDb = 0;
  {
    const vals: number[] = [];
    for (let i = 0; i < S; i++) if (dbSeries[i] > silentThresh) vals.push(20 * Math.log10(dbSeries[i]));
    if (vals.length > 4) {
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      dynamicsDb = Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length);
    }
  }

  /* drops: the low end and the kick coming back after a build, a breakdown or a gap */
  const dropInfo = duration > 16 ? findDrops(lay, E2, H2, R, duration, tempo.beats, bpm) : [];
  const drops = dropInfo.map((d) => d.t);

  /* mood */
  const totalBand = bandTotals.reduce((a, b) => a + b, 0) || 1;
  const lowEnd = clamp01((bandTotals[0] + bandTotals[1]) / totalBand);
  const subShare = bandTotals[0] / totalBand;
  const loud = map01(meanDb, -32, -8);
  const tempoF = map01(bpm, 70, 175);
  const fluxN = map01(meanFlux, 0.08, 0.35);
  const density = map01(onsetRate, 1, 7);
  const brightness = map01(Math.log2(Math.max(1, meanCentroid) / 600) / Math.log2(4500 / 600), 0, 1);
  const dynamics = map01(dynamicsDb, 1.5, 9);
  const arousal = clamp01(0.4 * loud + 0.2 * tempoF + 0.25 * fluxN + 0.15 * density);
  const valence = clamp01(0.4 * keyInfo.mode + 0.3 * brightness + 0.3 * map01(bpm, 60, 160));
  const mood: MoodProfile = {
    arousal: round3(arousal),
    valence: round3(valence),
    brightness: round3(brightness),
    density: round3(density),
    lowEnd: round3(lowEnd),
    dynamics: round3(dynamics),
  };

  /* what kind of song: one decisive reading, used by tags, presets, section names and the summary */
  const character = judgeCharacter(lay.stats, mood, bpm, keyInfo, subShare, dropInfo);
  const genreKind = GENRES[character.genre];

  /* sections (drops are always boundaries; songs that aren't dance music call their big parts choruses) */
  const feats = structureFeatures(x, xLen, sr, HOP, nFrames, bands6, E2, S, R);
  const bars = downbeats(tempo.beats, lowP, fr);
  const sections = findSections(E2, L2, H2, R, duration, tempo.beats, bars, dropInfo, feats, genreKind?.dance ?? true);

  const moodTags = focusTags(deriveTags(mood, bpm, subShare, drops.length, duration).moodTags, character);
  const genres = genreKind ? [...genreKind.tags] : [];
  const tags = [...moodTags, ...genres.filter((g) => !moodTags.includes(g))];
  const suggestedPresets = suggestPresets(presetTags, moodTags, genres, bpm);
  const summary = summarize(mood, bpm, keyInfo, subShare, sections, dropInfo, moodTags, character, lay.stats, duration);

  return {
    duration,
    bpm,
    overview,
    energyCurve,
    lowCurve,
    midCurve,
    highCurve,
    sections,
    drops,
    dropInfo,
    mood,
    tags,
    suggestedPresets,
    summary,
    layers: lay.layers,
    character,
  };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/* ───────────────────────── drops ───────────────────────── */

/**
 * A drop is where the low end and the kick come back in, loud, after they were gone or held back
 * (a build, a breakdown, a gap). Each candidate is scored on how much the sub/bass and the kick
 * return, how much louder it gets, how quiet it was before and how long the wait was; the exact
 * moment is the first big low-end hit at the step.
 */
function findDrops(lay: LayerResult, E2: Float32Array, H2: Float32Array, R: number, duration: number, beats: number[], bpm: number): TrackDrop[] {
  const S = E2.length;
  const fr = lay.fr;
  const nF = lay.lowE.length;
  // 2 Hz series: low-end and overall level in log10 power relative to the loud parts (−1 = 10 dB down)
  const per = Math.max(1, Math.round(fr / R));
  const low = new Float32Array(S);
  const all = new Float32Array(S);
  for (let i = 0; i < S; i++) {
    const a = Math.min(nF, i * per);
    const b = Math.min(nF, a + per);
    let l = 0;
    let e = 0;
    for (let f = a; f < b; f++) {
      l += Math.pow(10, lay.lowE[f]);
      e += Math.pow(10, lay.allE[f]);
    }
    low[i] = Math.log10(1e-9 + l / Math.max(1, b - a));
    all[i] = Math.log10(1e-9 + e / Math.max(1, b - a));
  }
  const lowRef = percentile(low, 0.9);
  const allRef = percentile(all, 0.9);
  for (let i = 0; i < S; i++) {
    low[i] = Math.max(-4, low[i] - lowRef);
    all[i] = Math.max(-4, all[i] - allRef);
  }
  const kick = new Float32Array(S);
  const snare = new Float32Array(S);
  for (const t of lay.layers.kick) kick[Math.min(S - 1, Math.floor(t * R))]++;
  for (const t of lay.layers.snare) snare[Math.min(S - 1, Math.floor(t * R))]++;
  const mean = (arr: Float32Array, a: number, b: number) => meanRange(arr, Math.max(0, a), Math.min(S, b));
  const rate = (arr: Float32Array, a: number, b: number) => (mean(arr, a, b) * R);

  const W = 4 * R; // 4 s either side
  const cands: { i: number; score: number; lowJump: number; kickBack: number; jump: number; gap: number; after: number }[] = [];
  for (let i = 2 * R; i < S - 2 * R; i++) {
    const lowB = mean(low, i - W, i);
    const lowA = mean(low, i, i + W);
    const allB = mean(all, i - W, i);
    const allA = mean(all, i, i + W);
    const lowJump = lowA - lowB;
    const jump = allA - allB;
    const kB = rate(kick, i - W, i);
    const kA = rate(kick, i, i + W);
    const kickBack = clamp01((kA - kB) / Math.max(0.75, kA));
    // a short hole right before (the classic half-beat of silence)
    const gapLow = Math.min(all[i - 1] ?? 0, all[i - 2] ?? 0);
    const gap = clamp01((allA - gapLow - 0.4) / 0.8);
    // it has to land loud and heavy, and something has to come back
    if (allA < -0.45 || lowA < -0.5) continue;
    // …that was really held back: most of the 4 s before sits well under what follows
    // (an 808 that comes and goes inside the groove isn't a drop)
    const heldLow = percentileOf(low, i - W, i, 0.75);
    // …or a short hole right before where everything dips, not just the bass
    const holeLow = Math.max(low[i - 1], low[i - 2], low[i - 3] ?? low[i - 2]);
    const holeAll = Math.max(all[i - 1], all[i - 2], all[i - 3] ?? all[i - 2]);
    const hole = holeLow < lowA - 0.4 && holeAll < allA - 0.2;
    const held = heldLow < lowA - 0.3 || kB < 0.35 * kA || hole;
    if (!held) continue;
    if (!(lowJump > 0.25 || (kickBack > 0.45 && jump > 0.12) || (gap > 0.5 && lowJump > 0.12))) continue;
    const score = 0.45 * clamp01(lowJump / 0.9) + 0.25 * kickBack + 0.2 * clamp01(jump / 0.6) + 0.1 * gap;
    cands.push({ i, score, lowJump, kickBack, jump, gap, after: allA });
  }
  // strongest first, at least 8 s apart
  cands.sort((p, q) => q.score - p.score);
  const kept: typeof cands = [];
  for (const c of cands) {
    if (kept.length >= 10) break;
    if (c.score < 0.3) break;
    if (kept.every((k) => Math.abs(k.i - c.i) >= 8 * R)) kept.push(c);
  }
  if (!kept.length) return [];
  const barLen = (4 * 60) / Math.max(40, bpm);
  const bars = (sec: number) => {
    const b = sec / barLen;
    for (const n of [2, 4, 8, 16, 32]) if (Math.abs(b - n) / n < 0.2) return n;
    return Math.max(1, Math.round(b));
  };

  const out: TrackDrop[] = [];
  for (const c of kept) {
    // exact moment: the frame where the low end steps up most, then the onset peak next to it
    const lowE = lay.lowE;
    const centre = Math.round((c.i / R) * fr);
    const half = Math.round(0.35 * fr);
    let bestF = centre;
    let bestStep = -Infinity;
    const pre = new Float64Array(nF + 1);
    const a0 = Math.max(half + 1, centre - Math.round(2.2 * fr));
    const a1 = Math.min(nF - half - 1, centre + Math.round(1.6 * fr));
    for (let f = Math.max(0, a0 - half - 1); f <= Math.min(nF - 1, a1 + half + 1); f++) pre[f + 1] = pre[f] + lowE[f];
    for (let f = a0; f <= a1; f++) {
      const st = (pre[f + half] - pre[f]) / half - (pre[f] - pre[f - half]) / half;
      if (st > bestStep) {
        bestStep = st;
        bestF = f;
      }
    }
    let onF = bestF;
    for (let f = Math.max(0, bestF - 4); f <= Math.min(nF - 1, bestF + 4); f++) if (lay.lowOdf[f] > lay.lowOdf[onF]) onF = f;
    let t = onF / fr;
    // the drum frame's centre, then onto a kick hit or the beat when one is right there
    const kicks = lay.layers.kick;
    const nearKick = kicks.length ? kicks.reduce((p, q) => (Math.abs(q - t) < Math.abs(p - t) ? q : p), kicks[0]) : t;
    if (Math.abs(nearKick - t) < 0.06) t = nearKick;
    else t = snapToBeat(t, beats, 0.06);
    if (t < 1 || t > duration - 2) continue;

    // what came before: how long the low end was held back, and whether it was building
    const i = Math.round(t * R);
    const lowA = mean(low, i, i + W);
    // walk back while the low end (over ~2 s) stays well under what the drop brings
    let j = i - 1;
    while (j > 0 && mean(low, j - 2, j + 2) < lowA - 0.35) j--;
    const heldBack = (i - 1 - j) / R;
    const preStart = Math.max(0, i - Math.max(4 * R, Math.round(heldBack * R)));
    const q = Math.max(1, Math.round((i - preStart) / 4));
    const rising =
      mean(all, i - q, i) - mean(all, preStart, preStart + q) > 0.12 ||
      mean(H2, i - q, i) - mean(H2, preStart, preStart + q) > 0.12 ||
      rate(snare, i - q, i) > rate(snare, preStart, preStart + q) + 0.8;
    const what =
      c.lowJump > 0.25 && c.kickBack > 0.35 ? 'bass and kick come back' : c.lowJump > 0.25 ? 'the bass comes back' : c.kickBack > 0.35 ? 'the drums kick in' : 'the full band hits';
    let after = '';
    const longHold = heldBack >= barLen * 1.6;
    const fromStart = t < 12 && mean(low, 0, i) < lowA - 0.35;
    if (fromStart) after = ' as the song gets going';
    else if (longHold && rising) after = ` after a ${bars(heldBack)}-bar build`;
    else if (longHold && heldBack >= 4) after = ` after a ${bars(heldBack)}-bar breakdown`;
    else if (rising) after = ' after a short build';
    else if (heldBack >= 1.5) after = ' after a short break';
    else if (c.gap > 0.5) after = ' after a gap';
    else if (t < 30) after = ' after the intro';

    // size: how much returns and how loud it lands, and how long it was held back
    let abs = clamp01(0.35 * clamp01(c.lowJump / 1) + 0.2 * c.kickBack + 0.2 * clamp01(c.jump / 0.6) + 0.15 * clamp01(heldBack / 16) + 0.1 * clamp01(1 + c.after / 0.3));
    // the beat arriving a few seconds into the song is a start, not the song's big moment
    if (fromStart) abs *= 0.5;
    const rel = c.score;
    out.push({ t: round2(t), strength: 0, why: `${what}${after}`, _abs: abs, _rel: rel, _start: fromStart } as TrackDrop & { _abs: number; _rel: number; _start: boolean });
  }
  // strengths: mostly how big it is next to the song's biggest drop, partly how big it is at all
  // (the beat arriving at the very start doesn't set the scale)
  type Raw = TrackDrop & { _abs: number; _rel: number; _start: boolean };
  const scaleBy = (out as Raw[]).filter((d) => !d._start);
  const ref = scaleBy.length ? scaleBy : (out as Raw[]);
  const absMax = Math.max(...ref.map((d) => d._abs), 1e-6);
  const relMax = Math.max(...ref.map((d) => d._rel), 1e-6);
  const result = out
    .map((d) => {
      const x = d as Raw;
      const strength = clamp01((0.55 * x._rel) / relMax + 0.45 * (x._abs / Math.max(absMax, 0.75))) * (x._start ? 0.5 : 1);
      return { t: x.t, strength: round2(strength), why: x.why };
    })
    .sort((p, q) => p.t - q.t);
  // the same moment found twice after snapping
  return result.filter((d, k) => k === 0 || d.t - result[k - 1].t >= 6);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function percentileOf(arr: Float32Array, a: number, b: number, q: number): number {
  a = Math.max(0, a);
  b = Math.min(arr.length, b);
  if (b <= a) return 0;
  return percentile(arr.subarray(a, b), q);
}

/* ───────────────────────── structure ───────────────────────── */

/**
 * One feature vector per 0.5 s for finding sections that sound alike: harmony (12 pitch classes),
 * timbre (the shape of six bands, loudness removed) and energy. Each part is centred over the track
 * and scaled to unit length, so the cosine between two moments says "same chords, same sound".
 */
function structureFeatures(
  x: Float32Array,
  xLen: number,
  sr: number,
  hop: number,
  nFrames: number,
  bands6: Float32Array,
  E2: Float32Array,
  S: number,
  R: number,
): Float32Array[] {
  const CN = 4096;
  const fft = new FFT(CN);
  const win = hann(CN);
  const cbin = sr / CN;
  const pcOf = new Int8Array(CN / 2).fill(-1);
  for (let k = 1; k < CN / 2; k++) {
    const f = k * cbin;
    if (f < 60 || f > 4200) continue;
    const midi = 12 * Math.log2(f / 440) + 69;
    pcOf[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const chroma: Float64Array[] = [];
  const timbre: Float64Array[] = [];
  for (let i = 0; i < S; i++) {
    const c = new Float64Array(12);
    for (const dt of [-0.125, 0.125]) {
      const off = Math.round(((i + 0.5) / R + dt) * sr) - CN / 2;
      if (off < 0 || off + CN > xLen) continue;
      for (let j = 0; j < CN; j++) {
        fft.re[j] = x[off + j] * win[j];
        fft.im[j] = 0;
      }
      fft.run();
      for (let k = 1; k < CN / 2; k++) {
        const pc = pcOf[k];
        if (pc >= 0) c[pc] += Math.sqrt(fft.re[k] * fft.re[k] + fft.im[k] * fft.im[k]);
      }
    }
    let tot = 0;
    for (let k = 0; k < 12; k++) tot += c[k];
    if (tot > 0) for (let k = 0; k < 12; k++) c[k] = Math.sqrt(c[k] / tot);
    chroma.push(c);

    const t = new Float64Array(6);
    const fa = Math.floor((i / R) * (sr / hop));
    const fb = Math.min(nFrames, Math.max(fa + 1, Math.floor(((i + 1) / R) * (sr / hop))));
    for (let f = fa; f < fb; f++) for (let b = 0; b < 6; b++) t[b] += bands6[f * 6 + b];
    let mean = 0;
    for (let b = 0; b < 6; b++) {
      t[b] = Math.log(1e-9 + t[b] / Math.max(1, fb - fa));
      mean += t[b] / 6;
    }
    for (let b = 0; b < 6; b++) t[b] -= mean;
    timbre.push(t);
  }

  // smooth over ±1 s, centre each part, scale to unit length, join
  const smooth = (arr: Float64Array[], d: number) =>
    arr.map((_, i) => {
      const o = new Float64Array(d);
      let n = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(arr.length - 1, i + 2); j++, n++) for (let k = 0; k < d; k++) o[k] += arr[j][k];
      for (let k = 0; k < d; k++) o[k] /= n;
      return o;
    });
  const C = smooth(chroma, 12);
  const T = smooth(timbre, 6);
  const centre = (arr: Float64Array[], d: number) => {
    const m = new Float64Array(d);
    for (const v of arr) for (let k = 0; k < d; k++) m[k] += v[k] / arr.length;
    for (const v of arr) {
      let n = 0;
      for (let k = 0; k < d; k++) {
        v[k] -= m[k];
        n += v[k] * v[k];
      }
      n = Math.sqrt(n) || 1;
      for (let k = 0; k < d; k++) v[k] /= n;
    }
  };
  centre(C, 12);
  centre(T, 6);
  let eMean = 0;
  for (let i = 0; i < S; i++) eMean += E2[i] / S;
  let eVar = 0;
  for (let i = 0; i < S; i++) eVar += (E2[i] - eMean) ** 2 / S;
  const eSd = Math.sqrt(eVar) || 1;

  const out: Float32Array[] = [];
  for (let i = 0; i < S; i++) {
    const v = new Float32Array(19);
    for (let k = 0; k < 12; k++) v[k] = C[i][k] * 1.0;
    for (let k = 0; k < 6; k++) v[12 + k] = T[i][k] * 0.8;
    v[18] = Math.max(-2, Math.min(2, (E2[i] - eMean) / eSd)) * 0.3;
    let n = 0;
    for (let k = 0; k < 19; k++) n += v[k] * v[k];
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < 19; k++) v[k] /= n;
    out.push(v);
  }
  return out;
}

/** every 4th beat, starting on the beat with the heaviest low end (a good guess at the downbeat) */
function downbeats(beats: number[], lowP: Float32Array, fr: number): number[] {
  if (beats.length < 8) return beats;
  const score = [0, 0, 0, 0];
  beats.forEach((t, k) => {
    const f = Math.round(t * fr);
    let m = 0;
    for (let j = Math.max(0, f - 2); j <= Math.min(lowP.length - 1, f + 2); j++) m = Math.max(m, lowP[j]);
    score[k % 4] += m;
  });
  const phase = score.indexOf(Math.max(...score));
  return beats.filter((_, k) => k % 4 === phase);
}

function findSections(
  E2: Float32Array,
  L2: Float32Array,
  H2: Float32Array,
  R: number,
  duration: number,
  beats: number[],
  bars: number[],
  dropInfo: TrackDrop[],
  feats: Float32Array[],
  dance: boolean,
): TrackSection[] {
  const drops = dropInfo.map((d) => d.t);
  const strongAt = (t: number) => dropInfo.some((d) => d.strength >= 0.5 && Math.abs(d.t - t) < 0.01);
  const S = E2.length;
  if (duration < 20 || S < 24) {
    return [{ start: 0, end: duration, energy: round3(meanRange(E2, 0, S)), label: 'verse', group: 0 }];
  }

  // self-similarity: how alike every half-second is to every other
  const M = new Float32Array(S * S);
  for (let i = 0; i < S; i++) {
    M[i * S + i] = 1;
    for (let j = i + 1; j < S; j++) {
      let d = 0;
      const a = feats[i];
      const b = feats[j];
      for (let k = 0; k < a.length; k++) d += a[k] * b[k];
      M[i * S + j] = M[j * S + i] = d;
    }
  }

  // novelty 1: where the sound changes (checkerboard kernel slid along the diagonal)
  const K = 12;
  const foote = new Float32Array(S);
  for (let i = K; i < S - K; i++) {
    let v = 0;
    for (let u = -K; u < K; u++) {
      for (let w = -K; w < K; w++) {
        const g = Math.exp(-4 * (((u + 0.5) / K) ** 2 + ((w + 0.5) / K) ** 2));
        const sign = u < 0 === w < 0 ? 1 : -1;
        v += sign * g * M[(i + u) * S + (i + w)];
      }
    }
    foote[i] = Math.max(0, v);
  }
  // novelty 2: where the energy steps up or down
  const W = 6 * R;
  const enov = new Float32Array(S);
  for (let i = W; i < S - W; i++) {
    enov[i] =
      Math.abs(meanRange(E2, i, i + W) - meanRange(E2, i - W, i)) +
      0.5 * Math.abs(meanRange(L2, i, i + W) - meanRange(L2, i - W, i)) +
      0.5 * Math.abs(meanRange(H2, i, i + W) - meanRange(H2, i - W, i));
  }
  const fMax = percentile(foote, 0.98) || 1;
  const eMax = percentile(enov, 0.98) || 1;
  const nov = new Float32Array(S);
  for (let i = 0; i < S; i++) nov[i] = 0.6 * Math.min(1.2, foote[i] / fMax) + 0.4 * Math.min(1.2, enov[i] / eMax);

  let m = 0;
  let s2 = 0;
  let cnt = 0;
  for (let i = W; i < S - W; i++) {
    m += nov[i];
    s2 += nov[i] * nov[i];
    cnt++;
  }
  m /= Math.max(1, cnt);
  const sd = Math.sqrt(Math.max(0, s2 / Math.max(1, cnt) - m * m));
  const thr = m + 0.4 * sd;
  const peaks: { t: number; v: number }[] = [];
  const nb = 4 * R;
  for (let i = Math.min(W, K); i < S - Math.min(W, K); i++) {
    if (nov[i] < thr) continue;
    let isMax = true;
    for (let j = Math.max(0, i - nb); j <= Math.min(S - 1, i + nb); j++) {
      if (nov[j] > nov[i] || (nov[j] === nov[i] && j < i)) {
        isMax = false;
        break;
      }
    }
    if (isMax) peaks.push({ t: i / R, v: nov[i] });
  }
  // drops are always boundaries, exactly on the drop
  for (const d of drops) {
    for (let k = peaks.length - 1; k >= 0; k--) if (Math.abs(peaks[k].t - d) < 4) peaks.splice(k, 1);
    peaks.push({ t: d, v: Infinity });
  }
  peaks.sort((a, b) => b.v - a.v);
  const chosen: number[] = [];
  const maxSections = Math.max(2, Math.min(16, Math.round(duration / 12)));
  for (const p of peaks) {
    if (chosen.length >= maxSections - 1) break;
    // drops may sit close to the ends; other boundaries keep 6 s clear
    const isDrop = p.v === Infinity;
    if (p.t < (isDrop ? 1.5 : 6) || p.t > duration - (isDrop ? 3 : 6)) continue;
    if (chosen.every((c) => Math.abs(c - p.t) >= 8)) chosen.push(p.t);
  }
  // land boundaries on bar lines (drops stay on their beat)
  const barLen = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.5;
  const snapped = chosen.map((t) => (drops.some((d) => Math.abs(d - t) < 0.01) ? t : snapToBeat(snapToBeat(t, bars, barLen * 2.1), beats, 0.35)));
  const bounds = [0, ...[...new Set(snapped)].sort((a, b) => a - b), duration];

  const raw = [] as { start: number; end: number; energy: number; slope: number; a: number; b: number }[];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = Math.round(bounds[i] * R);
    const b = Math.max(a + 1, Math.round(bounds[i + 1] * R));
    const len = Math.max(1, b - a);
    raw.push({
      start: bounds[i],
      end: bounds[i + 1],
      energy: meanRange(E2, a, b),
      slope: meanRange(E2, b - len / 4, b) - meanRange(E2, a, a + len / 4),
      a,
      b: Math.min(S, b),
    });
  }

  // group sections that sound alike (a chorus that comes back joins its first appearance)
  const block = (p: (typeof raw)[number], q: (typeof raw)[number]) => {
    let v = 0;
    let n = 0;
    for (let i = p.a; i < p.b; i++) for (let j = q.a; j < q.b; j++, n++) v += M[i * S + j];
    return n ? v / n : 0;
  };
  const self = raw.map((r) => Math.max(0.05, block(r, r)));
  const sim = (i: number, j: number) => block(raw[i], raw[j]) / Math.sqrt(self[i] * self[j]);
  const groups: number[][] = [];
  const groupOf: number[] = [];
  raw.forEach((r, i) => {
    let best = -1;
    let bestV = -Infinity;
    groups.forEach((g, gi) => {
      const v = g.reduce((acc, j) => acc + sim(i, j), 0) / g.length;
      const eGap = Math.abs(r.energy - g.reduce((acc, j) => acc + raw[j].energy, 0) / g.length);
      if (eGap < 0.22 && v > bestV) {
        bestV = v;
        best = gi;
      }
    });
    if (best >= 0 && bestV >= 0.55) {
      groups[best].push(i);
      groupOf.push(best);
    } else {
      groups.push([i]);
      groupOf.push(groups.length - 1);
    }
  });

  let eLo = Infinity;
  let eHi = -Infinity;
  for (const r of raw) {
    eLo = Math.min(eLo, r.energy);
    eHi = Math.max(eHi, r.energy);
  }
  const span = Math.max(0.08, eHi - eLo);
  const n = raw.length;
  const labels: TrackSection['label'][] = raw.map((r, i) => {
    const rel = (r.energy - eLo) / span;
    const next = raw[i + 1];
    const startsAtDrop = drops.some((d) => Math.abs(d - r.start) < 2.5);
    const nextIsDrop = next ? drops.some((d) => Math.abs(d - next.start) < 2.5) : false;
    if (startsAtDrop && (rel > 0.45 || (strongAt(r.start) && rel > 0.25))) return 'drop';
    if (i === 0 && rel < 0.5 && n > 2) return 'intro';
    if (i === n - 1 && rel < 0.5 && n > 2) return 'outro';
    if (nextIsDrop && (r.slope > 0.03 || rel < 0.7)) return 'build';
    if (rel >= 0.75) return 'drop';
    if (r.slope > 0.12 && next && next.energy > r.energy) return 'build';
    if (rel < 0.3) return 'break';
    return 'verse';
  });

  // songs without drops (or that aren't dance music): the loudest part that comes back is the chorus,
  // a one-off later on is a bridge
  if (!drops.length || !dance) {
    const groupEnergy = groups.map((g) => g.reduce((acc, j) => acc + raw[j].energy, 0) / g.length);
    const recurring = groups.map((g, gi) => ({ gi, g })).filter(({ g }) => g.length >= 2);
    const chorus = recurring.sort((p, q) => groupEnergy[q.gi] - groupEnergy[p.gi])[0];
    // it's only a chorus if something else in the body of the song sounds different
    const bodyGroups = new Set(raw.map((_, i) => i).filter((i) => labels[i] === 'verse' || labels[i] === 'drop').map((i) => groupOf[i]));
    if (chorus && bodyGroups.size >= 2 && (groupEnergy[chorus.gi] - eLo) / span > 0.45) {
      for (const j of chorus.g) if (labels[j] === 'verse' || labels[j] === 'drop') labels[j] = 'chorus';
    }
    const firstChorus = labels.indexOf('chorus');
    labels.forEach((l, i) => {
      if (l === 'drop') labels[i] = firstChorus >= 0 || strongAt(raw[i].start) ? 'chorus' : 'verse';
      else if (l === 'verse' && firstChorus >= 0 && i > firstChorus && i < n - 1 && groups[groupOf[i]].length === 1) labels[i] = 'bridge';
    });
  }

  // a loud part that doesn't start at a drop and doesn't sound like one is a chorus, not a drop
  if (drops.length && dance) {
    const dropGroups = new Set(raw.map((r, i) => (labels[i] === 'drop' && drops.some((d) => Math.abs(d - r.start) < 2.5) ? groupOf[i] : -1)));
    labels.forEach((l, i) => {
      if (l === 'drop' && !dropGroups.has(groupOf[i])) labels[i] = 'chorus';
    });
  }

  return raw.map((r, i) => ({ start: round3(r.start), end: round3(r.end), energy: round3(r.energy), label: labels[i], group: groupOf[i] }));
}

/* ───────────────────────── character ───────────────────────── */

interface GenreKind {
  /** dance music: its big moments are drops (otherwise they're choruses) */
  dance: boolean;
  /** words the look library uses for this kind of song */
  tags: string[];
}

export const GENRES: Record<string, GenreKind> = {
  dubstep: { dance: true, tags: ['dubstep', 'bass', 'heavy', 'aggressive'] },
  'future bass': { dance: true, tags: ['euphoric', 'bass', 'electronic', 'bright'] },
  house: { dance: true, tags: ['house', 'driving', 'bouncy', 'electronic'] },
  techno: { dance: true, tags: ['techno', 'driving', 'hypnotic', 'minimal'] },
  trance: { dance: true, tags: ['trance', 'euphoric', 'hypnotic', 'electronic'] },
  'drum and bass': { dance: true, tags: ['drum-and-bass', 'driving', 'energetic', 'electronic'] },
  edm: { dance: true, tags: ['edm', 'electronic', 'energetic', 'driving'] },
  trap: { dance: true, tags: ['hip-hop', 'trap', 'heavy', 'bass'] },
  'hip hop': { dance: false, tags: ['hip-hop', 'heavy', 'bouncy'] },
  'lo-fi hip hop': { dance: false, tags: ['lofi', 'hip-hop', 'calm', 'warm'] },
  pop: { dance: false, tags: ['pop', 'bouncy', 'happy', 'upbeat'] },
  'dance pop': { dance: false, tags: ['pop', 'bouncy', 'energetic', 'house'] },
  'r&b': { dance: false, tags: ['romantic', 'warm', 'pop', 'tender'] },
  'indie rock': { dance: false, tags: ['rock', 'indie', 'energetic'] },
  'piano ballad': { dance: false, tags: ['piano', 'tender', 'melancholic', 'calm'] },
  acoustic: { dance: false, tags: ['acoustic', 'tender', 'warm', 'indie'] },
  ambient: { dance: false, tags: ['ambient', 'calm', 'spacious', 'minimal'] },
};

/** soft "between a and b" → 0..1 with a ramp of `w` on either side */
const within = (v: number, a: number, b: number, w: number) => clamp01(Math.min((v - (a - w)) / w, ((b + w) - v) / w));
/** tempo in range, counting half- and double-time readings at a small discount */
const tempoIn = (bpm: number, a: number, b: number) => Math.max(within(bpm, a, b, 6), 0.8 * within(bpm * 2, a, b, 6), 0.8 * within(bpm / 2, a, b, 6));

/**
 * One decisive reading of what the song is: every genre gets a score from the layers (four-on-the-floor,
 * halftime drums, 808s and sub, vocals, struck vs held notes), the tempo, the drops and the mood; the
 * best one wins and the margin over the runner-up is the confidence.
 */
function judgeCharacter(
  st: LayerStats,
  m: MoodProfile,
  bpm: number,
  key: { minor: boolean },
  subShare: number,
  drops: TrackDrop[],
): TrackCharacter {
  const bigDrops = drops.filter((d) => d.strength >= 0.6).length;
  const dropy = clamp01(bigDrops / 2) * (drops.length ? Math.max(...drops.map((d) => d.strength)) : 0);
  const four = clamp01((st.kickOnBeat - 0.45) / 0.25);
  const drums = clamp01((st.kickPerBeat * st.drumShare - 0.25) / 0.5);
  const sub = clamp01(Math.max((m.lowEnd - 0.6) / 0.25, (subShare - 0.12) / 0.15));
  const vox = clamp01((st.vocalShare - 0.2) / 0.3);
  const struck = clamp01((st.leadDecay - 0.12) / 0.2);
  const hatsBusy = clamp01((st.hatPerBeat - 1.5) / 1.5);
  const dark = clamp01((0.55 - m.valence) / 0.25);
  const happy = clamp01((m.valence - 0.5) / 0.25);
  const calm = clamp01((0.45 - m.arousal) / 0.2);
  const hype = clamp01((m.arousal - 0.5) / 0.2);

  const score: Record<string, number> = {
    dubstep: tempoIn(bpm, 136, 152) * (0.45 * dropy + 0.3 * sub + 0.15 * (1 - four) + 0.1 * dark) * (1 - 0.25 * happy) * (0.4 + 0.6 * sub),
    'future bass': within(bpm, 70, 165, 8) * (0.35 * dropy + 0.2 * sub + 0.15 * happy + 0.1 * vox + 0.1 * (1 - four) + 0.1 * clamp01((m.brightness - 0.5) / 0.3)) * (0.75 + 0.25 * vox),
    house: tempoIn(bpm, 118, 130) * (0.55 * four + 0.15 * hype + 0.15 * happy + 0.15 * clamp01(st.hatPerBeat / 1.5)),
    techno: tempoIn(bpm, 124, 140) * (0.55 * four + 0.2 * dark + 0.15 * (1 - vox) + 0.1 * (1 - happy)),
    trance: tempoIn(bpm, 130, 142) * (0.45 * four + 0.25 * dropy + 0.2 * happy + 0.1 * (1 - vox)),
    'drum and bass': within(bpm, 164, 180, 6) * (0.4 * hype + 0.3 * drums + 0.2 * clamp01(m.density / 0.6) + 0.1 * dropy),
    edm: within(bpm, 100, 150, 10) * (0.5 * dropy + 0.2 * hype + 0.15 * four + 0.15 * sub) * 0.85,
    trap: tempoIn(bpm, 130, 160) * (0.35 * sub + 0.25 * hatsBusy + 0.15 * (1 - four) + 0.15 * dark + 0.1 * st.bassGlide * 3) * (1 - 0.3 * happy),
    'hip hop': within(bpm, 78, 112, 8) * (0.35 * vox + 0.3 * sub + 0.2 * (1 - four) + 0.15 * (1 - happy)) * (1 - 0.5 * dropy * (1 - vox)),
    'lo-fi hip hop': within(bpm, 65, 95, 6) * (0.4 * calm + 0.3 * drums + 0.3 * (1 - vox)) * (0.4 + 0.6 * clamp01((0.6 - m.brightness) / 0.2)) * (1 - 0.5 * struck),
    pop: within(bpm, 88, 135, 8) * (0.4 * vox + 0.3 * happy + 0.15 * (1 - sub) + 0.15 * (1 - calm)) * (1 - 0.5 * dropy * (1 - vox)) * (1 - 0.45 * dropy * sub),
    'dance pop': within(bpm, 105, 130, 6) * (0.4 * four + 0.3 * vox + 0.2 * happy + 0.1 * hype),
    'r&b': within(bpm, 60, 100, 8) * (0.4 * vox + 0.25 * calm + 0.2 * (1 - four) + 0.15 * clamp01((0.6 - m.brightness) / 0.3)),
    'indie rock': within(bpm, 90, 170, 10) * (0.3 * vox + 0.3 * clamp01((0.35 - st.subBass) / 0.25) + 0.2 * clamp01((m.density - 0.4) / 0.3) + 0.2 * (1 - four)) * (1 - sub) * (1 - dropy) * 0.8,
    'piano ballad': (0.45 * struck + 0.3 * calm + 0.15 * (1 - drums) + 0.1 * (1 - sub)) * (1 - dropy) * (1 - 0.6 * hype),
    acoustic: (0.35 * struck + 0.25 * calm + 0.2 * (1 - sub) + 0.2 * vox) * (1 - dropy) * (1 - 0.6 * hype) * clamp01((0.7 - m.lowEnd) / 0.2),
    ambient: (0.5 * calm + 0.25 * (1 - drums) + 0.25 * clamp01((0.3 - m.density) / 0.2)) * (1 - dropy) * (1 - vox * 0.5),
  };
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [genre, best] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  const confidence = round2(clamp01(0.35 + 1.6 * (best - second) + 0.4 * (best - 0.45)));

  // instruments heard, most prominent first
  const inst: { name: string; w: number }[] = [];
  const hiphop = genre === 'trap' || genre === 'hip hop' || genre === 'lo-fi hip hop';
  const bassName = hiphop && sub > 0.3 && (st.bassGlide > 0.08 || st.bassNoteLen > 0.3) ? '808' : st.subBass > 0.5 || sub > 0.6 ? 'sub bass' : 'bass';
  if (st.bassShare > 0.08) inst.push({ name: bassName, w: 0.4 + st.bassShare + 0.3 * sub });
  if (st.drumShare > 0.3 && st.kickPerBeat > 0.3) inst.push({ name: four > 0.5 ? 'four-on-the-floor kick' : 'kick drum', w: 0.3 + st.drumShare * Math.min(1, st.kickPerBeat) });
  if (st.snarePerBeat > 0.25 && st.drumShare > 0.3) inst.push({ name: genre === 'trap' || genre === 'hip hop' || genre === 'pop' || genre === 'dance pop' ? 'snare and claps' : 'snare', w: 0.2 + 0.3 * Math.min(1, st.snarePerBeat) });
  if (st.hatPerBeat > 0.5 && st.drumShare > 0.3) inst.push({ name: hatsBusy > 0.5 && (genre === 'trap' || genre === 'hip hop') ? 'rolling hi-hats' : 'hi-hats', w: 0.15 + 0.2 * hatsBusy });
  if (st.vocalShare > 0.2) inst.push({ name: 'vocals', w: 0.3 + st.vocalShare * 1.2 });
  if (st.leadShare > 0.2) {
    const name = struck > 0.5 ? (m.lowEnd < 0.7 && !dropy ? 'piano' : 'keys') : GENRES[genre]?.dance || genre === 'trap' ? 'synth lead' : 'melody';
    inst.push({ name, w: 0.2 + st.leadShare * 0.6 });
  }
  if (genre === 'dubstep' && dropy > 0.3) inst.push({ name: 'wobble bass', w: 0.5 });
  if ((genre === 'future bass' || genre === 'trance' || genre === 'ambient') && st.leadShare > 0.3) inst.push({ name: 'pads', w: 0.15 });
  const instruments = inst
    .sort((a, b) => b.w - a.w)
    .map((x) => x.name)
    .filter((n, i, all) => all.indexOf(n) === i)
    .slice(0, 6);

  return { genre, confidence, instruments, mood: moodWord(m, genre, key.minor, vox, dropy) };
}

/** one or two words for what the song is going for */
function moodWord(m: MoodProfile, genre: string, minor: boolean, vox: number, dropy: number): string {
  const a = m.arousal;
  const v = m.valence;
  // heavy bass music with real drops is going for impact unless it's clearly bright and happy
  if ((genre === 'dubstep' || genre === 'trap') && a >= 0.5) return v >= 0.75 ? 'euphoric' : dropy > 0.4 ? 'aggressive' : 'menacing';
  if (a >= 0.62) {
    if (v >= 0.62) return dropy > 0.4 ? 'euphoric' : 'joyful';
    if (v < 0.42) return genre === 'hip hop' || genre === 'trap' ? 'menacing' : 'aggressive';
    return dropy > 0.4 ? 'explosive' : 'energetic';
  }
  if (a < 0.42) {
    if (v < 0.42) return vox > 0.4 ? 'heartbroken' : 'melancholic';
    if (v >= 0.6) return 'tender';
    return minor ? 'wistful' : 'dreamy';
  }
  if (v < 0.4) return genre === 'hip hop' || genre === 'trap' ? 'swaggering' : 'brooding';
  if (v >= 0.65) return dropy > 0.4 ? 'uplifting' : 'carefree';
  return minor ? 'bittersweet' : 'warm';
}

/** words that pull against each other: once the song has one, the other goes */
const CLASH: Record<string, string[]> = {
  euphoric: ['melancholic', 'dark', 'calm', 'tender'],
  joyful: ['melancholic', 'dark'],
  aggressive: ['tender', 'calm', 'dreamy', 'euphoric'],
  menacing: ['tender', 'calm', 'dreamy', 'euphoric'],
  melancholic: ['euphoric', 'energetic', 'aggressive'],
  heartbroken: ['euphoric', 'energetic', 'aggressive'],
  tender: ['aggressive', 'driving', 'heavy'],
  dreamy: ['aggressive', 'driving'],
  energetic: ['calm', 'melancholic'],
  explosive: ['calm', 'tender', 'dreamy'],
  brooding: ['euphoric'],
  swaggering: ['tender', 'dreamy', 'euphoric'],
};

/** put the song's one mood first and drop the tags that contradict it, so the app reads it one way */
function focusTags(moodTags: string[], c: TrackCharacter): string[] {
  const out = moodTags.filter((t) => !(CLASH[c.mood] ?? []).includes(t));
  const vocab = ['euphoric', 'aggressive', 'melancholic', 'dreamy', 'dark', 'driving', 'spacious', 'heavy', 'tender', 'hypnotic', 'energetic', 'calm', 'bright'];
  const alias: Record<string, string> = { joyful: 'euphoric', menacing: 'aggressive', heartbroken: 'melancholic', brooding: 'dark', explosive: 'energetic', uplifting: 'euphoric', swaggering: 'heavy' };
  const lead = vocab.includes(c.mood) ? c.mood : alias[c.mood];
  if (lead) {
    const i = out.indexOf(lead);
    if (i >= 0) out.splice(i, 1);
    out.unshift(lead);
  }
  return out;
}

/* ───────────────────────── tags / genres ───────────────────────── */

function deriveTags(
  m: MoodProfile,
  bpm: number,
  subShare: number,
  dropCount: number,
  duration: number,
): { moodTags: string[]; genres: string[] } {
  const t: string[] = [];
  const add = (cond: boolean, tag: string) => {
    if (cond && !t.includes(tag)) t.push(tag);
  };
  add(m.arousal < 0.4 && m.valence < 0.45, 'melancholic');
  add(m.arousal > 0.62 && m.valence > 0.55, 'euphoric');
  add(m.arousal > 0.68 && m.brightness > 0.5 && m.valence < 0.5, 'aggressive');
  add(m.arousal < 0.5 && m.density < 0.5 && m.brightness > 0.25 && m.brightness < 0.7, 'dreamy');
  add(m.brightness < 0.32 || m.valence < 0.3, 'dark');
  add(bpm >= 110 && m.density > 0.45 && m.arousal > 0.5, 'driving');
  add(m.density < 0.35 || (m.density < 0.5 && m.dynamics > 0.55), 'spacious');
  add(m.lowEnd > 0.68 || subShare > 0.22, 'heavy');
  add(m.arousal < 0.38 && m.valence >= 0.45, 'tender');
  add(m.dynamics < 0.3 && m.density > 0.35 && m.density < 0.75, 'hypnotic');
  add(m.arousal > 0.55 && m.valence >= 0.45 && m.valence <= 0.55, 'energetic');
  add(m.arousal < 0.3, 'calm');
  add(m.brightness > 0.7, 'bright');
  add(m.dynamics > 0.6, 'dynamic');
  // tempo words
  t.push(bpm < 85 ? 'slow' : bpm < 110 ? 'mid-tempo' : bpm < 135 ? 'upbeat' : 'fast');

  const g: string[] = [];
  const near = (v: number, c: number, tol: number) => Math.abs(v - c) <= tol;
  const subHeavy = subShare > 0.18 || m.lowEnd > 0.7;
  if (subHeavy && (near(bpm, 140, 6) || near(bpm, 70, 4)) && (dropCount > 0 || m.arousal > 0.55)) g.push('dubstep', 'bass');
  else if (subHeavy && dropCount > 0 && m.arousal > 0.55) g.push('bass');
  if (bpm >= 160 && bpm <= 180 && m.density > 0.55) g.push('drum-and-bass');
  if (bpm >= 118 && bpm <= 132 && m.density > 0.45 && m.dynamics < 0.5) g.push(m.brightness < 0.45 || m.valence < 0.4 ? 'techno' : 'house');
  if (bpm >= 70 && bpm <= 95 && m.arousal < 0.5 && m.brightness < 0.55 && m.density > 0.25) g.push('lofi', 'hip-hop');
  if (m.arousal < 0.3 && m.density < 0.3) g.push('ambient');
  if (subHeavy && (near(bpm, 140, 8) || near(bpm, 70, 4)) && m.density > 0.4 && !g.includes('dubstep')) g.push('trap');
  if (m.arousal < 0.45 && m.lowEnd < 0.45 && m.brightness > 0.35 && m.dynamics > 0.45) g.push('acoustic');
  if (m.arousal > 0.6 && m.valence > 0.55 && bpm >= 100 && bpm <= 130 && !g.length) g.push('pop');
  if (dropCount > 0 && duration > 60) g.push('edm');
  return { moodTags: t, genres: [...new Set(g)] };
}

const SYNONYMS: Record<string, string[]> = {
  sad: ['melancholic'],
  lonely: ['melancholic', 'spacious'],
  rain: ['melancholic', 'dreamy'],
  happy: ['euphoric'],
  uplifting: ['euphoric'],
  angry: ['aggressive'],
  intense: ['aggressive', 'driving'],
  hard: ['aggressive', 'heavy'],
  chill: ['calm', 'dreamy'],
  soft: ['tender', 'calm'],
  gentle: ['tender', 'calm'],
  ambient: ['calm', 'spacious'],
  minimal: ['spacious', 'hypnotic'],
  trance: ['hypnotic', 'euphoric'],
  energetic: ['driving', 'energetic', 'fast'],
  groovy: ['driving', 'upbeat'],
  dance: ['driving', 'upbeat'],
  bass: ['heavy'],
  sub: ['heavy'],
  wobble: ['heavy'],
  night: ['dark'],
  moody: ['dark', 'melancholic'],
  ethereal: ['dreamy', 'spacious'],
  lush: ['dreamy'],
  warm: ['tender'],
  loud: ['aggressive'],
  big: ['euphoric', 'heavy'],
  bright: ['bright'],
  glitchy: ['aggressive'],
  organic: ['tender', 'acoustic'],
  lofi: ['lofi'],
  'lo-fi': ['lofi'],
  dnb: ['drum-and-bass'],
  edm: ['edm'],
};

function suggestPresets(presets: AnalysisRequest['presetTags'], moodTags: string[], genres: string[], bpm: number): string[] {
  const weight = new Map<string, number>();
  const set = (k: string, w: number) => weight.set(k, Math.max(weight.get(k) ?? 0, w));
  moodTags.forEach((t, i) => set(t, 1.5 - Math.min(0.5, i * 0.08)));
  for (const g of genres) set(g, 2.2);
  set(bpm < 85 ? 'slow' : bpm < 110 ? 'mid-tempo' : bpm < 135 ? 'upbeat' : 'fast', 0.6);
  const scored: { id: string; s: number }[] = [];
  for (const p of presets) {
    if (!p || !p.id) continue;
    let s = 0;
    const tags = (p.tags ?? []).map((t) => String(t).toLowerCase());
    for (const tag of tags) {
      const direct = weight.get(tag) ?? 0;
      let syn = 0;
      for (const alt of SYNONYMS[tag] ?? []) syn = Math.max(syn, (weight.get(alt) ?? 0) * 0.7);
      s += Math.max(direct, syn);
    }
    if (s > 0) scored.push({ id: p.id, s: s / Math.sqrt(Math.max(1, tags.length)) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, 8).map((x) => x.id);
}

/* ───────────────────────── summary ───────────────────────── */

function summarize(
  m: MoodProfile,
  bpm: number,
  key: { key: string; minor: boolean; confidence: number },
  subShare: number,
  sections: TrackSection[],
  dropInfo: TrackDrop[],
  moodTags: string[],
  c: TrackCharacter,
  st: LayerStats,
  duration: number,
): string {
  const tempoWord = bpm < 85 ? 'slow' : bpm < 110 ? 'mid-tempo' : bpm < 135 ? 'upbeat' : 'fast';
  const sure = c.confidence >= 0.7 ? '' : c.confidence >= 0.45 ? 'probably ' : 'maybe ';
  const lean = key.confidence > 0.45 ? `, leaning ${key.minor ? 'minor' : 'major'} (maybe ${key.key})` : '';
  const article = /^[aeiou]/.test(c.mood) && !/^(eu|uni|use)/.test(c.mood) ? 'An' : 'A';
  const s1 = `${article} ${c.mood}, ${tempoWord} track at about ${Math.round(bpm)} BPM — ${sure}${c.genre}${lean}.`;
  const s2 = c.instruments.length ? `Heard: ${c.instruments.join(', ')}.` : '';

  const brightWord = m.brightness < 0.33 ? 'dark and warm' : m.brightness < 0.66 ? 'balanced in tone' : 'bright and crisp';
  const lowWord = subShare > 0.2 ? 'a sub-heavy' : m.lowEnd > 0.65 ? 'a heavy' : m.lowEnd > 0.4 ? 'a solid' : 'a light';
  const dynWord = m.dynamics < 0.3 ? 'tight, compressed' : m.dynamics < 0.6 ? 'moderate' : 'wide';
  const densWord = m.density < 0.35 ? 'sparse' : m.density < 0.65 ? 'steady' : 'busy';
  const vocalWord = st.vocalShare > 0.6 ? ' Vocals carry most of it.' : st.vocalShare > 0.25 ? ' Vocals come and go.' : st.vocalShare < 0.08 ? ' Mostly instrumental.' : '';
  const s3 = `It sounds ${brightWord}, with ${lowWord} low end, ${densWord} rhythm and ${dynWord} dynamics.${vocalWord}`;

  let s4: string;
  if (dropInfo.length) {
    const big = [...dropInfo].sort((p, q) => q.strength - p.strength)[0];
    const others = dropInfo.filter((d) => d !== big);
    const strongOthers = others.filter((d) => d.strength >= 0.5).map((d) => fmtTime(Math.round(d.t)));
    const small = others.filter((d) => d.strength < 0.5).map((d) => fmtTime(Math.round(d.t)));
    const word = GENRES[c.genre]?.dance ? 'drop' : 'hit';
    s4 = `The biggest ${word} lands at ${fmtTime(Math.round(big.t))} (${big.why}).`;
    if (strongOthers.length) s4 += ` Other big ${word}s at ${listWords(strongOthers)}.`;
    if (small.length) s4 += ` Smaller ones at ${listWords(small)}.`;
  } else if (sections.length > 1) {
    let peak = sections[0];
    for (const x of sections) if (x.energy > peak.energy) peak = x;
    s4 = `No real drops; energy moves through ${sections.length} sections and peaks around ${fmtTime(peak.start)}.`;
  } else {
    s4 = `Energy stays fairly even across its ${fmtTime(duration)}.`;
  }
  const extra = moodTags.filter((t) => t !== c.mood && !['slow', 'mid-tempo', 'upbeat', 'fast', 'bright', 'dynamic', 'calm'].includes(t)).slice(0, 2);
  const s5 = extra.length ? `Also ${extra.join(' and ')}.` : '';
  return [s1, s2, s3, s4, s5].filter(Boolean).join(' ');
}

function listWords(xs: string[]): string {
  return xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0];
}

/* ───────────────────────── worker entry ───────────────────────── */

type WorkerScope = {
  onmessage: ((e: MessageEvent<AnalysisRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const isWorkerScope =
  typeof self !== 'undefined' &&
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined' &&
  typeof (globalThis as { document?: unknown }).document === 'undefined';

if (isWorkerScope) {
  const scope = self as unknown as WorkerScope;
  scope.onmessage = (e) => {
    try {
      const { channel, sampleRate, presetTags, side } = e.data;
      const analysis = computeAnalysis(channel, sampleRate, presetTags ?? [], side);
      const reply: AnalysisReply = { ok: true, analysis };
      scope.postMessage(reply, [
        analysis.overview.buffer,
        analysis.energyCurve.buffer,
        analysis.lowCurve.buffer,
        analysis.midCurve.buffer,
        analysis.highCurve.buffer,
      ] as Transferable[]);
    } catch (err) {
      const reply: AnalysisReply = { ok: false, error: err instanceof Error ? err.message : String(err) };
      scope.postMessage(reply);
    }
  };
}
