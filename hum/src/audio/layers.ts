/**
 * Taking a song apart (runs inside the analysis worker).
 *
 *   drums  — 512-pt STFT (~12 ms hop): per-band log spectral flux → adaptive peak picking
 *            kick 30–140 Hz · snare 1.2–5 kHz noise (+ body) · hats 6.5 kHz and up
 *   bass   — low-passed and decimated to ~2.7 kHz, 1024-pt frames: harmonic-sum pitch of the low end
 *            (B0–G3), merged into notes, starts snapped to low-end onsets
 *   lead   — decimated to ~11 kHz, 2048-pt frames, peaks whitened: the most salient pitch in A2–A6
 *   vocals — the lead tracker's pitch glides (voices slide and wobble, synths and keys hold still),
 *            centre-panned presence in the voice band, and singing-range pitch, smoothed into spans
 *
 * Also hands back per-frame series the drop finder and the genre reading use.
 */
import type { TrackLayers, TrackNote } from '../core/types';
import { biquad, lowpassDecimate, percentile, stftMags } from './dsp';

export interface LayerInput {
  /** mono, ~22 kHz */
  x: Float32Array;
  xLen: number;
  sr: number;
  /** (L−R)/2 at the same rate, when the source was stereo */
  side?: Float32Array | null;
  beats: number[];
  bpm: number;
}

export interface LayerResult {
  layers: TrackLayers;
  /** frames per second of the series below */
  fr: number;
  /** log energy 30–140 Hz per drum frame */
  lowE: Float32Array;
  /** log energy of the whole spectrum per drum frame */
  allE: Float32Array;
  /** per drum frame: low-end onset strength (0..~1, normalised) */
  lowOdf: Float32Array;
  /** 0..1 how sure we are a voice is singing, at 4 Hz */
  vocal4: Float32Array;
  stats: LayerStats;
}

export interface LayerStats {
  /** fraction of beats that carry a kick (in parts where drums play) */
  kickOnBeat: number;
  /** kicks per beat where drums play */
  kickPerBeat: number;
  /** snares per beat where drums play */
  snarePerBeat: number;
  /** hats per beat where drums play */
  hatPerBeat: number;
  /** share of the song where drums play */
  drumShare: number;
  /** how often a snare is followed by another exactly 1, 2, 3, 4 beats later (backbeat → 2 high, halftime → 4 high, 2 low) */
  snareEvery: number[];
  /** the same for kicks (four-on-the-floor → 1 high) */
  kickEvery: number[];
  /** share of time with a pitched bass note */
  bassShare: number;
  /** mean bass note length (s) */
  bassNoteLen: number;
  /** bass notes that slide (808 glides) */
  bassGlide: number;
  /** lowest bass notes sit in the sub (below ~60 Hz) */
  subBass: number;
  /** share of time with a lead note */
  leadShare: number;
  /** lead notes that fade while held (plucked / struck: piano, guitar) vs held flat (synth, organ, voice) */
  leadDecay: number;
  /** share of time a voice is heard */
  vocalShare: number;
  /** stereo width of the mix (0 mono … 1 very wide), null without stereo */
  width: number | null;
}

const LOG_GAIN = 1000;

export function analyzeLayers(inp: LayerInput): LayerResult {
  const { xLen, sr } = inp;
  // level-normalise so the thresholds below work for quiet and loud masters alike
  let peak = 1e-6;
  for (let i = 0; i < xLen; i += 7) {
    const v = Math.abs(inp.x[i]);
    if (v > peak) peak = v;
  }
  const gain = 1 / peak;

  const d = drumPass(inp.x, xLen, sr, gain);
  const beatsPerSec = Math.max(0.5, inp.bpm / 60);

  // drums
  const ft = (f: number) => round2((f * d.hop + d.n / 2) / sr);
  const loudLow = percentile(d.lowE, 0.95);
  const loudSn = percentile(d.snE, 0.95);
  const loudHat = percentile(d.hatE, 0.95);
  /** the band's level just after frame f (the hit itself), in log10 power */
  const after = (e: Float32Array, f: number) => Math.max(e[f] ?? -9, e[f + 1] ?? -9, e[f + 2] ?? -9);
  /** how much a band rose into the hit: level just after vs the quietest of the frames just before */
  const rise = (e: Float32Array, f: number) => after(e, f) - Math.min(e[f - 1] ?? 9, e[f - 2] ?? 9, e[f - 3] ?? 9);
  // a kick lifts the low end more than the low mids (a wobble or a chord opening up lifts the mids most)
  // …and stands out within its beat (a wobble pulses the low end many times per beat, a kick once or twice)
  const halfBeat = Math.max(2, Math.round((30 / Math.max(60, inp.bpm)) * d.fr));
  const kickF = pickPeaks(d.kick, d.fr, { minGap: 0.11, delta: 0.32, floor: d.silent }).filter((f) => {
    const rl = rise(d.lowE, f);
    if (after(d.lowE, f) <= loudLow - 1.6 || rl <= 0.15) return false;
    let mx = 0;
    for (let j = Math.max(0, f - halfBeat); j <= Math.min(d.kick.length - 1, f + halfBeat); j++) if (d.kick[j] > mx) mx = d.kick[j];
    if (d.kick[f] < 0.6 * mx) return false;
    return rl >= 0.5 * rise(d.lmE, f) || d.kick[f] >= 0.95 * mx;
  });
  const flat = (a: Float32Array, f: number) => Math.max(a[f], a[f + 1] ?? 0);
  // a snare is noise in the presence band, louder there than in the air band; a hat lives in the air
  const snareF = pickPeaks(d.snare, d.fr, { minGap: 0.1, delta: 0.36, floor: d.silent }).filter(
    (f) => after(d.snE, f) > loudSn - 1.8 && flat(d.snFlat, f) > 0.5 && after(d.snE, f) - after(d.hatE, f) > 0.15 && rise(d.snE, f) > 0.25,
  );
  const snareSet = new Set(snareF);
  const hatF = pickPeaks(d.hat, d.fr, { minGap: 0.06, delta: 0.3, floor: d.silent }).filter(
    (f) => after(d.hatE, f) > loudHat - 2 && flat(d.hatFlat, f) > 0.5 && !(snareSet.has(f) || snareSet.has(f - 1) || snareSet.has(f + 1)),
  );
  const kick = kickF.map(ft);
  const snare = snareF.map(ft);
  const hat = hatF.map(ft);

  // bass: low-pass to ~1 kHz and decimate to ~2.7 kHz
  const bd = Math.max(1, Math.round(sr / 2756));
  const bassSig = lowpassDecimate(inp.x, xLen, sr, bd, 900);
  const bassTrack = trackPitch(bassSig.y, bassSig.sr, gain, {
    n: 1024,
    hop: 128,
    lo: 23,
    hi: 55,
    weights: [1, 0.5, 0.33, 0.25],
    whiten: false,
    bandLo: 28,
    bandHi: 260,
  });
  const lowOnsets = pickPeaks(d.kick, d.fr, { minGap: 0.08, delta: 0.18, floor: d.silent }).map(ft);
  const bass = toNotes(bassTrack, { minFrames: 2, relFloor: 0.12, snap: lowOnsets, snapDist: 0.16 });

  // lead / melody: decimate to ~11 kHz
  const ld = Math.max(1, Math.round(sr / 11025));
  const leadSig = ld > 1 ? lowpassDecimate(inp.x, xLen, sr, ld, 4500) : { y: inp.x.subarray(0, xLen) as Float32Array, sr };
  const leadTrack = trackPitch(leadSig.y, leadSig.sr, gain, {
    n: 2048,
    hop: 256,
    lo: 45,
    hi: 93,
    weights: [1, 0.85, 0.7, 0.55, 0.45, 0.35],
    whiten: true,
    bandLo: 100,
    bandHi: 4000,
  });
  const lead = toNotes(leadTrack, { minFrames: 3, relFloor: 0.2, snap: null, snapDist: 0 });

  // vocals
  const voice = vocalPass(inp, leadTrack, bassTrack);

  const duration = xLen / sr;
  const layers: TrackLayers = { kick, snare, hat, bass, lead, vocal: voice.spans };
  const stats = drumStats(kick, snare, hat, inp.beats, beatsPerSec, duration);
  const noteTime = (ns: TrackNote[]) => ns.reduce((s, x) => s + (x.end - x.t), 0);
  stats.bassShare = clamp01(noteTime(bass) / Math.max(1, duration));
  stats.bassNoteLen = bass.length ? noteTime(bass) / bass.length : 0;
  stats.bassGlide = bassTrack.glide;
  stats.subBass = bass.length ? bass.filter((x) => x.midi <= 34).reduce((s, x) => s + (x.end - x.t), 0) / Math.max(1e-6, noteTime(bass)) : 0;
  stats.leadShare = clamp01(noteTime(lead) / Math.max(1, duration));
  stats.leadDecay = noteDecay(lead, leadTrack);
  stats.vocalShare = clamp01(voice.spans.reduce((s, [a, b]) => s + b - a, 0) / Math.max(1, duration));
  stats.width = voice.width;

  return { layers, fr: d.fr, lowE: d.lowE, allE: d.allE, lowOdf: norm(d.kick), vocal4: voice.score4, stats };
}

/* ───────────────────────── drums ───────────────────────── */

interface DrumPass {
  n: number;
  hop: number;
  fr: number;
  kick: Float32Array;
  snare: Float32Array;
  body: Float32Array;
  hat: Float32Array;
  lowE: Float32Array;
  allE: Float32Array;
  /** log10 power in the snare and hat bands */
  snE: Float32Array;
  hatE: Float32Array;
  /** log10 power 150 Hz–1.2 kHz */
  lmE: Float32Array;
  /** spectral flatness (0 tonal … 1 noise) in the snare and hat bands */
  snFlat: Float32Array;
  hatFlat: Float32Array;
  /** per frame: true when the track is (nearly) silent */
  silent: Uint8Array;
}

export function drumPass(x: Float32Array, xLen: number, sr: number, gain: number): DrumPass {
  const N = 512;
  const HOP = 256;
  const half = N / 2;
  const nF = Math.max(1, Math.floor((Math.max(xLen, N) - N) / HOP) + 1);
  const binHz = sr / N;
  const range = (lo: number, hi: number): [number, number] => [Math.max(1, Math.round(lo / binHz)), Math.min(half - 1, Math.round(hi / binHz))];
  const [k0, k1] = range(30, 125);
  const [b0, b1] = range(150, 400);
  const [s0, s1] = range(1200, 5000);
  const [h0, h1] = range(6500, sr * 0.48);
  const kick = new Float32Array(nF);
  const snare = new Float32Array(nF);
  const body = new Float32Array(nF);
  const hat = new Float32Array(nF);
  const lowE = new Float32Array(nF);
  const allE = new Float32Array(nF);
  const snE = new Float32Array(nF);
  const hatE = new Float32Array(nF);
  const lmE = new Float32Array(nF);
  const [m0, m1] = range(150, 1200);
  const snFlat = new Float32Array(nF);
  const hatFlat = new Float32Array(nF);
  const prev = new Float64Array(half);
  const prev2 = new Float64Array(half);
  stftMags(x, xLen, N, HOP, gain, (f, mag) => {
    let kf = 0;
    let sf = 0;
    let bf = 0;
    let hf = 0;
    let le = 0;
    let ae = 0;
    let se = 0;
    let he = 0;
    let lme = 0;
    let sLog = 0;
    let sLin = 0;
    let hLog = 0;
    let hLin = 0;
    for (let k = 1; k < half; k++) {
      const m = mag[k];
      const p = m * m;
      ae += p;
      if (k >= m0 && k <= m1) lme += p;
      const lm = Math.log1p(LOG_GAIN * m);
      // rise against the louder of the last two frames (a slow swell doesn't count as a hit)
      const ref = prev[k] > prev2[k] ? prev[k] : prev2[k];
      const dd = lm - ref;
      prev2[k] = prev[k];
      prev[k] = lm;
      if (k >= k0 && k <= k1) {
        le += p;
        if (dd > 0) kf += dd;
      } else if (k >= b0 && k <= b1) {
        if (dd > 0) bf += dd;
      } else if (k >= s0 && k <= s1) {
        se += p;
        sLog += Math.log(m + 1e-9);
        sLin += m;
        if (dd > 0) sf += dd;
      } else if (k >= h0 && k <= h1) {
        he += p;
        hLog += Math.log(m + 1e-9);
        hLin += m;
        if (dd > 0) hf += dd;
      }
    }
    const sN = s1 - s0 + 1;
    const hN = Math.max(1, h1 - h0 + 1);
    snE[f] = Math.log10(1e-9 + se);
    lmE[f] = Math.log10(1e-9 + lme);
    hatE[f] = Math.log10(1e-9 + he);
    snFlat[f] = sLin > 0 ? Math.exp(sLog / sN) / (sLin / sN) : 0;
    hatFlat[f] = hLin > 0 ? Math.exp(hLog / hN) / (hLin / hN) : 0;
    kick[f] = kf / (k1 - k0 + 1);
    body[f] = bf / (b1 - b0 + 1);
    snare[f] = sf / (s1 - s0 + 1);
    hat[f] = hf / Math.max(1, h1 - h0 + 1);
    lowE[f] = Math.log10(1e-9 + le);
    allE[f] = Math.log10(1e-9 + ae);
  });
  const loud = percentile(allE, 0.95);
  const silent = new Uint8Array(nF);
  for (let f = 0; f < nF; f++) silent[f] = allE[f] < loud - 3.5 ? 1 : 0;
  return { n: N, hop: HOP, fr: sr / HOP, kick, snare, body, hat, lowE, allE, snE, hatE, lmE, snFlat, hatFlat, silent };
}

/** scale so the loud end of the series sits near 1 */
function norm(a: Float32Array): Float32Array {
  const ref = percentile(a, 0.98) || 1e-9;
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] / ref;
  return o;
}

/**
 * Peak picking on an onset curve: a local maximum (±35 ms) that clears the local mean
 * (150 ms before, 50 ms after) by `delta` × the track's typical hit size.
 */
export function pickPeaks(odf: Float32Array, fr: number, o: { minGap: number; delta: number; floor: Uint8Array }): number[] {
  const n = odf.length;
  const ref = percentile(odf, 0.97) || 1e-9;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + odf[i];
  const wb = Math.max(2, Math.round(0.15 * fr));
  const wa = Math.max(1, Math.round(0.05 * fr));
  const lm = Math.max(1, Math.round(0.035 * fr));
  const gap = Math.max(1, Math.round(o.minGap * fr));
  const delta = o.delta * ref;
  const out: number[] = [];
  let last = -gap;
  for (let i = 1; i < n - 1; i++) {
    const v = odf[i];
    if (v < delta || o.floor[i]) continue;
    let isMax = true;
    for (let j = Math.max(0, i - lm); j <= Math.min(n - 1, i + lm); j++) {
      if (odf[j] > v || (odf[j] === v && j < i)) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    const a = Math.max(0, i - wb);
    const b = Math.min(n, i + wa + 1);
    const mean = (pre[b] - pre[a]) / (b - a);
    if (v < mean + delta) continue;
    if (i - last < gap) {
      // keep the bigger of two hits that are too close
      if (out.length && v > odf[out[out.length - 1]]) {
        out[out.length - 1] = i;
        last = i;
      }
      continue;
    }
    out.push(i);
    last = i;
  }
  return out;
}

function drumStats(kick: number[], snare: number[], hat: number[], beats: number[], bps: number, duration: number): LayerStats {
  const beatLen = 1 / bps;
  // where drums play: 2 s windows with at least a couple of hits
  const W = 2;
  const nW = Math.max(1, Math.ceil(duration / W));
  const cnt = new Uint16Array(nW);
  for (const t of kick) cnt[Math.min(nW - 1, Math.floor(t / W))]++;
  for (const t of snare) cnt[Math.min(nW - 1, Math.floor(t / W))]++;
  const on = new Uint8Array(nW);
  let onN = 0;
  for (let i = 0; i < nW; i++) {
    if (cnt[i] < 2) continue;
    on[i] = 1;
    onN++;
  }
  const drumTime = Math.max(W, onN * W);
  const inDrums = (t: number) => on[Math.min(nW - 1, Math.floor(t / W))] === 1;
  const kd = kick.filter(inDrums);
  const sd = snare.filter(inDrums);
  const hd = hat.filter(inDrums);
  const beatsInDrums = beats.filter(inDrums);
  // kick on beat
  let hit = 0;
  let ki = 0;
  for (const b of beatsInDrums) {
    while (ki < kd.length && kd[ki] < b - 0.07) ki++;
    if (ki < kd.length && Math.abs(kd[ki] - b) <= 0.07) hit++;
  }
  // periodicity: share of hits with a partner exactly k beats later (±60 ms)
  const every = (hits: number[]) =>
    [1, 2, 3, 4].map((k) => {
      if (hits.length < 8) return 0;
      let yes = 0;
      let j = 0;
      for (const t of hits) {
        const want = t + k * beatLen;
        while (j < hits.length && hits[j] < want - 0.06) j++;
        if (j < hits.length && Math.abs(hits[j] - want) <= 0.06) yes++;
      }
      return Math.round((yes / hits.length) * 100) / 100;
    });
  const beatsN = Math.max(1, drumTime * bps);
  return {
    kickOnBeat: beatsInDrums.length ? hit / beatsInDrums.length : 0,
    kickPerBeat: kd.length / beatsN,
    snarePerBeat: sd.length / beatsN,
    hatPerBeat: hd.length / beatsN,
    drumShare: onN / nW,
    snareEvery: every(sd),
    kickEvery: every(kd),
    bassShare: 0,
    bassNoteLen: 0,
    bassGlide: 0,
    subBass: 0,
    leadShare: 0,
    leadDecay: 0,
    vocalShare: 0,
    width: null,
  };
}

/* ───────────────────────── pitch ───────────────────────── */

interface PitchTrack {
  fr: number;
  /** seconds from frame index to frame centre */
  t0: number;
  /** best MIDI note per frame, −1 when nothing is pitched */
  midi: Int16Array;
  /** fine pitch (fractional MIDI) per frame */
  fine: Float32Array;
  sal: Float32Array;
  energy: Float32Array;
  /** share of voiced frames that slide (pitch moving 0.3–1 semitone between frames) */
  glide: number;
}

interface PitchOpts {
  n: number;
  hop: number;
  lo: number;
  hi: number;
  weights: number[];
  whiten: boolean;
  bandLo: number;
  bandHi: number;
}

function trackPitch(y: Float32Array, sr: number, gain: number, o: PitchOpts): PitchTrack {
  const { n: N, hop: HOP } = o;
  const half = N / 2;
  const len = y.length;
  const nF = Math.max(1, Math.floor((Math.max(len, N) - N) / HOP) + 1);
  const binHz = sr / N;
  const H = o.weights.length;
  const nC = o.hi - o.lo + 1;
  // bin range per (candidate, harmonic): ± half a semitone
  const ra = new Int32Array(nC * H);
  const rb = new Int32Array(nC * H);
  for (let c = 0; c < nC; c++) {
    const f0 = 440 * Math.pow(2, (o.lo + c - 69) / 12);
    for (let h = 0; h < H; h++) {
      const f = f0 * (h + 1);
      ra[c * H + h] = Math.max(1, Math.floor((f * 0.9715) / binHz));
      rb[c * H + h] = Math.min(half - 1, Math.ceil((f * 1.0293) / binHz));
    }
  }
  const e0 = Math.max(1, Math.floor(o.bandLo / binHz));
  const e1 = Math.min(half - 1, Math.ceil(o.bandHi / binHz));
  const wm = new Float64Array(half);
  const pre = new Float64Array(half + 1);
  const midi = new Int16Array(nF).fill(-1);
  const fine = new Float32Array(nF);
  const sal = new Float32Array(nF);
  const energy = new Float32Array(nF);
  const W = Math.max(3, Math.round(40 / binHz));
  const sc = new Float64Array(nC);
  stftMags(y, len, N, HOP, gain, (f, mag) => {
    let e = 0;
    for (let k = e0; k <= e1; k++) e += mag[k] * mag[k];
    energy[f] = e;
    let spec: Float64Array = mag;
    if (o.whiten) {
      // keep only what stands above the local spectral floor (tonal peaks, not noise or a wash of chords)
      pre[0] = 0;
      for (let k = 0; k < half; k++) pre[k + 1] = pre[k] + mag[k];
      for (let k = 1; k < half; k++) {
        const a = Math.max(1, k - W);
        const b = Math.min(half, k + W + 1);
        const floor = (pre[b] - pre[a]) / (b - a);
        const v = mag[k] - 1.5 * floor;
        wm[k] = v > 0 ? Math.sqrt(v) : 0;
      }
      spec = wm;
    }
    let best = -1;
    let bestS = 0;
    let tot = 0;
    for (let c = 0; c < nC; c++) {
      let s = 0;
      for (let h = 0; h < H; h++) {
        let mx = 0;
        const a = ra[c * H + h];
        const b = rb[c * H + h];
        for (let k = a; k <= b; k++) if (spec[k] > mx) mx = spec[k];
        s += o.weights[h] * mx;
      }
      // a candidate with nothing at its own fundamental is an octave error
      let f1 = 0;
      for (let k = ra[c * H]; k <= rb[c * H]; k++) if (spec[k] > f1) f1 = spec[k];
      s *= 0.4 + 0.6 * Math.min(1, f1 / (s / H + 1e-12));
      sc[c] = s;
      tot += s;
      if (s > bestS) {
        bestS = s;
        best = c;
      }
    }
    if (best < 0 || bestS <= 0) return;
    // prefer the higher octave when it explains the sound about as well (harmonic sums favour sub-octaves)
    if (best + 12 < nC && sc[best + 12] > 0.8 * bestS) best += 12;
    sal[f] = bestS / (tot / nC + 1e-12);
    midi[f] = o.lo + best;
    // fine pitch from the strongest of the first three harmonics (parabolic interpolation on log magnitude)
    let ph = 0;
    let pk = ra[best * H];
    let pv = -1;
    for (let h = 0; h < Math.min(3, H); h++) {
      for (let k = ra[best * H + h]; k <= rb[best * H + h]; k++) {
        if (mag[k] > pv) {
          pv = mag[k];
          pk = k;
          ph = h;
        }
      }
    }
    let fr0 = pk;
    if (pk > 1 && pk < half - 1) {
      const a = Math.log(mag[pk - 1] + 1e-12);
      const b = Math.log(mag[pk] + 1e-12);
      const c = Math.log(mag[pk + 1] + 1e-12);
      const den = a - 2 * b + c;
      if (den < 0) fr0 = pk + (0.5 * (a - c)) / den;
    }
    fine[f] = 69 + 12 * Math.log2(Math.max(1, (fr0 * binHz) / (ph + 1)) / 440);
  });
  // voicing: clear salience and enough level in the band
  const eRef = percentile(energy, 0.95) || 1e-12;
  const sRef = percentile(sal, 0.9) || 1;
  for (let f = 0; f < nF; f++) {
    if (midi[f] < 0) continue;
    if (energy[f] < eRef * 0.02 || sal[f] < Math.max(2.2, 0.45 * sRef)) midi[f] = -1;
  }
  // median of 3 to clear single-frame flickers
  const m2 = midi.slice();
  for (let f = 1; f < nF - 1; f++) {
    const a = midi[f - 1];
    const b = midi[f];
    const c = midi[f + 1];
    if (a === c && a >= 0 && b !== a) m2[f] = a;
    else if (b >= 0 && a < 0 && c < 0) m2[f] = -1;
  }
  let gl = 0;
  let pairs = 0;
  for (let f = 1; f < nF; f++) {
    if (m2[f] < 0 || m2[f - 1] < 0) continue;
    const dc = Math.abs(fine[f] - fine[f - 1]);
    if (dc > 2) continue;
    pairs++;
    if (dc > 0.3 && dc < 1) gl++;
  }
  return { fr: sr / HOP, t0: N / 2 / sr, midi: m2, fine, sal, energy, glide: pairs ? gl / pairs : 0 };
}

function toNotes(p: PitchTrack, o: { minFrames: number; relFloor: number; snap: number[] | null; snapDist: number }): TrackNote[] {
  const nF = p.midi.length;
  const eRef = percentile(p.energy, 0.95) || 1e-12;
  const out: TrackNote[] = [];
  let f = 0;
  while (f < nF) {
    const m = p.midi[f];
    if (m < 0) {
      f++;
      continue;
    }
    let g = f + 1;
    let eSum = p.energy[f];
    while (g < nF) {
      const mg = p.midi[g];
      if (mg === m) {
        // a fresh attack on the same pitch starts a new note
        if (p.energy[g] > 2.2 * p.energy[g - 1] && g - f >= o.minFrames) break;
        eSum += p.energy[g];
        g++;
        continue;
      }
      // bridge a single-frame dropout
      if (mg < 0 && g + 1 < nF && p.midi[g + 1] === m) {
        g++;
        continue;
      }
      break;
    }
    const frames = g - f;
    const e = eSum / frames;
    if (frames >= o.minFrames && e >= eRef * o.relFloor * 0.25) {
      let t = f / p.fr + p.t0 - 0.5 / p.fr;
      const end = (g - 1) / p.fr + p.t0 + 0.5 / p.fr;
      if (o.snap && o.snap.length) {
        const s = nearest(o.snap, t);
        if (Math.abs(s - t) <= o.snapDist) t = s;
      }
      if (end - t > 0.05) out.push({ t: round2(Math.max(0, t)), end: round2(end), midi: m, v: round2(clamp01(Math.sqrt(e / eRef))) });
    }
    f = g;
  }
  // merge back-to-back notes of the same pitch that were split by a flicker
  const merged: TrackNote[] = [];
  for (const n of out) {
    const last = merged[merged.length - 1];
    if (last && last.midi === n.midi && n.t - last.end < 0.03 && Math.abs(n.v - last.v) < 0.25) last.end = n.end;
    else merged.push(n);
  }
  return merged;
}

/** share of lead notes whose level falls a lot while the pitch is held (struck/plucked instruments) */
function noteDecay(notes: TrackNote[], p: PitchTrack): number {
  let dec = 0;
  let n = 0;
  for (const x of notes) {
    if (x.end - x.t < 0.3) continue;
    const a = Math.round((x.t - p.t0) * p.fr) + 1;
    const b = Math.round((x.end - p.t0) * p.fr) - 1;
    if (b - a < 4) continue;
    const head = (p.energy[a] + p.energy[a + 1]) / 2;
    const tail = (p.energy[b] + p.energy[b - 1]) / 2;
    n++;
    if (tail < head * 0.3) dec++;
  }
  return n ? dec / n : 0;
}

/* ───────────────────────── vocals ───────────────────────── */

function vocalPass(inp: LayerInput, lead: PitchTrack, bassP: PitchTrack): { spans: [number, number][]; score4: Float32Array; width: number | null } {
  const duration = inp.xLen / inp.sr;
  const R = 4;
  const S = Math.max(1, Math.ceil(duration * R));
  // centre vs side in the voice band (300 Hz–3.5 kHz), per quarter second
  let centre: Float32Array | null = null;
  let width: number | null = null;
  if (inp.side) {
    const blk = Math.max(1, Math.floor(inp.sr / R));
    const band = (sig: Float32Array) => {
      const t = sig.slice(0, inp.xLen);
      biquad(t, inp.xLen, 'hp', 300, inp.sr, 0.7);
      biquad(t, inp.xLen, 'lp', 3500, inp.sr, 0.7);
      const e = new Float32Array(S);
      for (let i = 0; i < inp.xLen; i++) e[Math.min(S - 1, Math.floor(i / blk))] += t[i] * t[i];
      return e;
    };
    const m = band(inp.x);
    const s = band(inp.side);
    centre = new Float32Array(S);
    let ms = 0;
    let ss = 0;
    for (let i = 0; i < S; i++) {
      centre[i] = m[i] / (m[i] + s[i] + 1e-12);
      ms += m[i];
      ss += s[i];
    }
    width = clamp01((ss / (ms + ss + 1e-12)) * 3);
    // a mono file (or a mono-ish mix) can't tell us anything
    if (ss < ms * 0.003) centre = null;
  }
  // per quarter second: how much of the time a pitch in singing range is heard, and how much it slides
  const voiced = new Float32Array(S);
  const glide = new Float32Array(S);
  const steady = new Float32Array(S);
  const frames = new Float32Array(S);
  const overtone = new Float32Array(S);
  // signed and unsigned pitch movement: a riser sweeps one way, a voice goes up and down
  const moveSigned = new Float32Array(S);
  const moveAbs = new Float32Array(S);
  const { midi, fine } = lead;
  // intervals at which a bass note's own overtones sit (octave, octave+fifth, 2 octaves, …)
  const HARM = new Set([12, 19, 24, 28, 31, 34, 36, 38, 40]);
  for (let f = 1; f < midi.length; f++) {
    const t = f / lead.fr + lead.t0;
    const i = Math.min(S - 1, Math.floor(t * R));
    frames[i]++;
    const m = midi[f];
    if (m < 45 || m > 84) continue;
    voiced[i]++;
    const bf = Math.round((t - bassP.t0) * bassP.fr);
    const bm = bf >= 0 && bf < bassP.midi.length ? bassP.midi[bf] : -1;
    if (bm >= 0 && HARM.has(m - bm)) overtone[i]++;
    if (midi[f - 1] < 0) continue;
    const dc = Math.abs(fine[f] - fine[f - 1]);
    if (dc < 0.06) steady[i]++;
    else if (dc < 1.2) {
      glide[i]++;
      moveSigned[i] += fine[f] - fine[f - 1];
      moveAbs[i] += dc;
    }
  }
  const raw = new Float32Array(S);
  // a part that suddenly goes mono (a mono bass or lead taking over a wide mix) isn't a voice;
  // a mix that's narrow all the way through tells us nothing either way
  const centreMid = centre ? percentile(centre, 0.5) : 0;
  for (let i = 0; i < S; i++) {
    const n = Math.max(1, frames[i]);
    const v = voiced[i] / n;
    const g = glide[i] / Math.max(1, voiced[i]);
    const ot = overtone[i] / Math.max(1, voiced[i]);
    // voices slide and wobble; a held synth or key doesn't, and a bass's overtones aren't a voice
    // direction over ~2 s around this moment
    let ms = 0;
    let ma = 0;
    for (let j = Math.max(0, i - 4); j <= Math.min(S - 1, i + 4); j++) {
      ms += moveSigned[j];
      ma += moveAbs[j];
    }
    const sweep = ma > 0 ? Math.abs(ms) / ma : 0;
    let s = v * clamp01((g - 0.1) / 0.18) * clamp01(1.4 - 1.6 * ot) * clamp01(1 - (sweep - 0.55) / 0.3);
    if (centre) {
      s *= clamp01((centre[i] - 0.6) / 0.2);
      if (centre[i] > 0.975 && centre[i] - centreMid > 0.12) s *= 0.1;
    }
    raw[i] = s;
  }
  // smooth over ~1.5 s
  const sm = new Float32Array(S);
  const r = 3;
  for (let i = 0; i < S; i++) {
    let a = 0;
    let c = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(S - 1, i + r); j++, c++) a += raw[j];
    sm[i] = a / c;
  }
  const on = 0.2;
  const spans: [number, number][] = [];
  let st = -1;
  for (let i = 0; i <= S; i++) {
    const v = i < S ? sm[i] : 0;
    if (v >= on && st < 0) st = i;
    else if (v < on * 0.75 && st >= 0) {
      spans.push([st / R, i / R]);
      st = -1;
    }
  }
  // close small gaps, drop blips
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] - last[1] < 1.2) last[1] = s[1];
    else merged.push([s[0], s[1]]);
  }
  const keep = merged.filter(([a, b]) => b - a >= 1.5).map(([a, b]) => [round2(a), round2(Math.min(duration, b))] as [number, number]);
  return { spans: keep, score4: sm, width };
}

/* ───────────────────────── helpers ───────────────────────── */

function nearest(sorted: number[], t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(sorted[lo] - t) <= Math.abs(sorted[hi] - t) ? sorted[lo] : sorted[hi];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);
const round2 = (v: number) => Math.round(v * 100) / 100;
