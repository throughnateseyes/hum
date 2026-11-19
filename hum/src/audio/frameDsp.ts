/**
 * The listening half of the audio engine, on its own: turns one look at the sound (a spectrum in dB
 * and the last 4096 samples) into an AudioFrame — band energies, kick / snare / hat envelopes, a
 * tempo-locked beat phase, slow energy, build-up and drop.
 *
 * The live engine (engine.ts) feeds it from the speakers' AnalyserNode every animation frame. The
 * render timeline (offlineFrames.ts) feeds a separate copy from the decoded song, so a rendered video
 * hears the song exactly the way playback does, without touching what's playing.
 */
import type { AudioFrame, LayerId, TrackAnalysis } from '../core/types';

export const SPECTRUM_BINS = 128;
export const WAVE_SAMPLES = 512;
export const FFT_SIZE = 4096;

type Band = { lo: number; hi: number };
const BANDS: Record<'sub' | 'bass' | 'lowMid' | 'mid' | 'highMid' | 'air', Band> = {
  sub: { lo: 20, hi: 60 },
  bass: { lo: 60, hi: 250 },
  lowMid: { lo: 250, hi: 500 },
  mid: { lo: 500, hi: 2000 },
  highMid: { lo: 2000, hi: 6000 },
  air: { lo: 6000, hi: 18000 },
};
const ONSET_BANDS = {
  kick: { lo: 35, hi: 150, decay: 0.22, minGap: 0.14, k: 1.6 },
  snare: { lo: 1200, hi: 5000, decay: 0.2, minGap: 0.11, k: 1.7 },
  hat: { lo: 7000, hi: 15000, decay: 0.09, minGap: 0.06, k: 1.6 },
};

/** Adaptive peak follower used to normalise levels so quiet and loud tracks both "dance". */
class AGC {
  peak: number;
  constructor(
    private floorDb: number,
    private rangeDb: number,
    private releaseDbPerSec: number,
    private initial = -30,
  ) {
    this.peak = initial;
  }
  norm(db: number, dt: number) {
    if (db > this.peak) this.peak = db;
    else this.peak = Math.max(this.floorDb + this.rangeDb, this.peak - this.releaseDbPerSec * dt);
    if (db < this.floorDb) return 0;
    const v = (db - (this.peak - this.rangeDb)) / this.rangeDb;
    return Math.min(1, Math.max(0, v));
  }
  reset() {
    this.peak = this.initial;
  }
}

class OnsetDetector {
  hist = new Float32Array(43); // ~0.7 s of flux at 60 fps
  i = 0;
  last = -1;
  env = 0;
  prevMag: Float32Array | null = null;
  constructor(
    private lo: number,
    private hi: number,
    private decay: number,
    private minGap: number,
    private k: number,
  ) {}
  /** returns true on onset */
  step(logMag: Float32Array, binHz: number, t: number, dt: number): boolean {
    const a = Math.max(1, Math.floor(this.lo / binHz));
    const b = Math.min(logMag.length - 1, Math.ceil(this.hi / binHz));
    if (!this.prevMag) this.prevMag = new Float32Array(logMag.length);
    let flux = 0;
    for (let j = a; j <= b; j++) {
      const d = logMag[j] - this.prevMag[j];
      if (d > 0) flux += d;
      this.prevMag[j] = logMag[j];
    }
    flux /= b - a + 1;
    // adaptive threshold
    let mean = 0;
    for (let j = 0; j < this.hist.length; j++) mean += this.hist[j];
    mean /= this.hist.length;
    let v = 0;
    for (let j = 0; j < this.hist.length; j++) v += (this.hist[j] - mean) ** 2;
    const sd = Math.sqrt(v / this.hist.length);
    this.hist[this.i] = flux;
    this.i = (this.i + 1) % this.hist.length;
    this.env *= Math.exp(-dt / this.decay);
    const thresh = mean + this.k * sd + 0.012;
    if (flux > thresh && t - this.last > this.minGap) {
      this.last = t;
      const strength = Math.min(1, 0.55 + (flux - thresh) / (thresh + 1e-4) * 0.6);
      this.env = Math.max(this.env, strength);
      return true;
    }
    return false;
  }
  reset() {
    this.hist.fill(0);
    this.i = 0;
    this.env = 0;
    this.last = -1;
    this.prevMag = null;
  }
}

const smooth = (cur: number, target: number, attack: number, release: number, dt: number) => {
  const tc = target > cur ? attack : release;
  return cur + (target - cur) * (1 - Math.exp(-dt / tc));
};

export function emptyFrame(): AudioFrame {
  const layers = {} as Record<LayerId, number>;
  return {
    playing: false,
    time: 0,
    duration: 0,
    level: 0,
    sub: 0,
    bass: 0,
    lowMid: 0,
    mid: 0,
    highMid: 0,
    air: 0,
    kick: 0,
    snare: 0,
    hat: 0,
    energy: 0,
    brightness: 0.4,
    flux: 0,
    beatPhase: 0,
    build: 0,
    drop: 0,
    sway: 0,
    onset: false,
    beat: false,
    kickHit: false,
    snareHit: false,
    hatHit: false,
    beatCount: 0,
    bpm: 0,
    spectrum: new Float32Array(SPECTRUM_BINS),
    waveform: new Float32Array(WAVE_SAMPLES),
    layers,
  };
}

/** one look at the sound: the spectrum in dB (FFT_SIZE / 2 bins) and the last FFT_SIZE samples */
export interface DspInput {
  freqDb: Float32Array;
  timeData: Float32Array;
  sampleRate: number;
}

export interface DspMoment {
  /** what goes in frame.time: the song position for a file, a running clock for live input */
  time: number;
  duration: number;
  playing: boolean;
  /** the song position when a known song plays (build-ups and drops come from its analysis); null for live input */
  songTime: number | null;
}

/** where the beat grid sits: the kicks' average position inside a beat (s), so beat 0 starts on a kick */
export function beatOffset(a: TrackAnalysis, bpm: number): number {
  const beat = 60 / bpm;
  const kicks = a.layers?.kick ?? [];
  if (!kicks.length) return 0;
  let x = 0;
  let y = 0;
  for (const k of kicks) {
    const ang = ((k % beat) / beat) * Math.PI * 2;
    x += Math.cos(ang);
    y += Math.sin(ang);
  }
  const ang = Math.atan2(y, x);
  return ((ang < 0 ? ang + Math.PI * 2 : ang) / (Math.PI * 2)) * beat;
}

export class FrameDsp {
  analysis: TrackAnalysis | null = null;
  readonly frame: AudioFrame = emptyFrame();
  /** manual tempo override (tap tempo / analysis). 0 = auto */
  bpmOverride = 0;
  /** global input gain multiplier for the reactive signals (sensitivity) */
  sensitivity = 1;

  private logMag = new Float32Array(FFT_SIZE / 2);
  private prevLogMag = new Float32Array(FFT_SIZE / 2);
  private bandAgc = Object.fromEntries(Object.keys(BANDS).map((k) => [k, new AGC(-100, 38, 2.5)])) as Record<keyof typeof BANDS, AGC>;
  private levelAgc = new AGC(-80, 40, 1.5);
  private energyAgc = new AGC(-80, 30, 0.6);
  private fluxPeak = 0.05;
  private specPeakDb = -30;
  private onsets = {
    kick: new OnsetDetector(ONSET_BANDS.kick.lo, ONSET_BANDS.kick.hi, ONSET_BANDS.kick.decay, ONSET_BANDS.kick.minGap, ONSET_BANDS.kick.k),
    snare: new OnsetDetector(ONSET_BANDS.snare.lo, ONSET_BANDS.snare.hi, ONSET_BANDS.snare.decay, ONSET_BANDS.snare.minGap, ONSET_BANDS.snare.k),
    hat: new OnsetDetector(ONSET_BANDS.hat.lo, ONSET_BANDS.hat.hi, ONSET_BANDS.hat.decay, ONSET_BANDS.hat.minGap, ONSET_BANDS.hat.k),
  };
  // energy / build / drop
  private fastE = 0;
  private slowE = 0;
  private buildAcc = 0;
  private lastDropT = -10;
  private nextDropIdx = 0;
  // tempo
  private onsetTimes: number[] = [];
  private bpmEstimate = 0;
  private phase = 0;
  private beatCount = 0;
  private clock = 0;

  /** a new song analysis; `t` is where the song is now, so drops behind it don't fire */
  setAnalysis(a: TrackAnalysis | null, t: number) {
    this.analysis = a;
    this.nextDropIdx = 0;
    if (a?.drops?.length) {
      this.nextDropIdx = a.drops.findIndex((d) => d > t);
      if (this.nextDropIdx < 0) this.nextDropIdx = a.drops.length;
    }
  }

  /** forget what was heard (full: the tempo, energy and beat count too) */
  reset(full = true) {
    Object.values(this.onsets).forEach((o) => o.reset());
    this.onsetTimes = [];
    if (full) {
      this.bpmEstimate = 0;
      this.beatCount = 0;
      this.phase = 0;
      this.fastE = this.slowE = 0;
      this.buildAcc = 0;
    }
  }

  /**
   * Everything back to how it is when a page first loads, for a render that must come out the same
   * every time: levels, followers, envelopes and the frame itself.
   */
  resetAll() {
    this.reset(true);
    Object.values(this.bandAgc).forEach((g) => g.reset());
    this.levelAgc.reset();
    this.energyAgc.reset();
    this.fluxPeak = 0.05;
    this.specPeakDb = -30;
    this.lastDropT = -10;
    this.clock = 0;
    this.logMag.fill(0);
    this.prevLogMag.fill(0);
    Object.assign(this.frame, emptyFrame());
  }

  /**
   * Put the beat grid where the song's own beats are at song time `t` (from the analysis tempo and its
   * kicks), so the beat phase and beat count only depend on where in the song we are.
   */
  alignBeat(t: number) {
    const bpm = this.bpmOverride || this.analysis?.bpm || 0;
    if (!bpm || !this.analysis) return;
    const off = beatOffset(this.analysis, bpm);
    this.phase = Math.max(0, ((t - off) * bpm) / 60);
    this.beatCount = Math.floor(this.phase);
  }

  /** One step: `input` is the sound right now (null when nothing plays: everything eases toward idle). */
  step(dtRaw: number, input: DspInput | null, m: DspMoment): AudioFrame {
    const f = this.frame;
    const dt = Math.min(0.1, Math.max(1 / 240, dtRaw));
    this.clock += dt;
    f.onset = f.beat = f.kickHit = f.snareHit = f.hatHit = false;
    f.playing = m.playing;
    f.time = m.time;
    f.duration = m.duration;

    if (!input || !m.playing) {
      // decay everything gently toward idle
      const decay = (x: number) => x * Math.exp(-dt / 0.35);
      f.level = decay(f.level);
      f.sub = decay(f.sub);
      f.bass = decay(f.bass);
      f.lowMid = decay(f.lowMid);
      f.mid = decay(f.mid);
      f.highMid = decay(f.highMid);
      f.air = decay(f.air);
      f.kick = decay(f.kick);
      f.snare = decay(f.snare);
      f.hat = decay(f.hat);
      f.flux = decay(f.flux);
      f.drop = decay(f.drop);
      f.build = decay(f.build);
      f.energy = f.energy * Math.exp(-dt / 2);
      for (let i = 0; i < SPECTRUM_BINS; i++) f.spectrum[i] *= Math.exp(-dt / 0.4);
      for (let i = 0; i < WAVE_SAMPLES; i++) f.waveform[i] *= 0.85;
      this.advancePhase(dt, f, false);
      this.writeLayers();
      return f;
    }

    const freqDb = input.freqDb;
    const timeData = input.timeData;
    const binHz = input.sampleRate / FFT_SIZE;

    // log magnitude (dB/20 → log10 magnitude) for flux
    const n = freqDb.length;
    for (let i = 0; i < n; i++) {
      const db = Math.max(-140, freqDb[i]);
      this.logMag[i] = db / 20;
    }

    // ── bands ──
    const sens = this.sensitivity;
    for (const key of Object.keys(BANDS) as (keyof typeof BANDS)[]) {
      const { lo, hi } = BANDS[key];
      const a = Math.max(1, Math.floor(lo / binHz));
      const b = Math.min(n - 1, Math.ceil(hi / binHz));
      let p = 0;
      for (let i = a; i <= b; i++) p += Math.pow(10, freqDb[i] / 10);
      const db = 10 * Math.log10(p / (b - a + 1) + 1e-14);
      let v = this.bandAgc[key].norm(db, dt);
      v = Math.min(1, Math.pow(v, 1.6) * sens);
      f[key] = smooth(f[key], v, 0.025, key === 'sub' || key === 'bass' ? 0.12 : 0.09, dt);
    }

    // ── level (rms of time domain) ──
    let rms = 0;
    for (let i = 0; i < timeData.length; i++) rms += timeData[i] * timeData[i];
    rms = Math.sqrt(rms / timeData.length);
    const rmsDb = 20 * Math.log10(rms + 1e-9);
    f.level = smooth(f.level, Math.min(1, Math.pow(this.levelAgc.norm(rmsDb, dt), 1.4) * sens), 0.03, 0.15, dt);

    // ── onsets ──
    const t = this.clock;
    f.kickHit = this.onsets.kick.step(this.logMag, binHz, t, dt);
    f.snareHit = this.onsets.snare.step(this.logMag, binHz, t, dt);
    f.hatHit = this.onsets.hat.step(this.logMag, binHz, t, dt);
    f.kick = Math.min(1, this.onsets.kick.env * Math.min(1.2, 0.5 + sens * 0.5));
    f.snare = Math.min(1, this.onsets.snare.env * Math.min(1.2, 0.5 + sens * 0.5));
    f.hat = Math.min(1, this.onsets.hat.env * Math.min(1.2, 0.5 + sens * 0.5));
    f.onset = f.kickHit || f.snareHit;
    if (f.kickHit || f.snareHit) {
      this.onsetTimes.push(t);
      while (this.onsetTimes.length && t - this.onsetTimes[0] > 8) this.onsetTimes.shift();
    }

    // ── spectral flux (overall) + centroid ──
    let flux = 0;
    let cNum = 0;
    let cDen = 0;
    const maxBin = Math.min(n - 1, Math.ceil(16000 / binHz));
    for (let i = 1; i <= maxBin; i++) {
      const d = this.logMag[i] - this.prevLogMag[i];
      if (d > 0) flux += d;
      this.prevLogMag[i] = this.logMag[i];
      const mg = Math.pow(10, this.logMag[i]);
      cNum += mg * i * binHz;
      cDen += mg;
    }
    flux /= maxBin;
    this.fluxPeak = Math.max(flux, this.fluxPeak * Math.exp(-dt / 6), 0.01);
    f.flux = smooth(f.flux, Math.min(1, flux / this.fluxPeak), 0.03, 0.2, dt);
    const centroid = cDen > 0 ? cNum / cDen : 1000;
    const bright = Math.min(1, Math.max(0, Math.log2(centroid / 150) / Math.log2(8000 / 150)));
    f.brightness = smooth(f.brightness, bright, 0.3, 0.6, dt);

    // ── spectrum: 128 log bins, 30 Hz – 16 kHz ──
    let framePeak = -140;
    for (let i = 0; i < n; i++) if (freqDb[i] > framePeak) framePeak = freqDb[i];
    this.specPeakDb = Math.max(framePeak, this.specPeakDb - 3 * dt);
    const lo = Math.log(30);
    const hi = Math.log(16000);
    for (let k = 0; k < SPECTRUM_BINS; k++) {
      const f0 = Math.exp(lo + ((hi - lo) * k) / SPECTRUM_BINS);
      const f1 = Math.exp(lo + ((hi - lo) * (k + 1)) / SPECTRUM_BINS);
      const a = Math.max(1, Math.floor(f0 / binHz));
      const b = Math.max(a, Math.min(n - 1, Math.floor(f1 / binHz)));
      let mx = -140;
      for (let i = a; i <= b; i++) if (freqDb[i] > mx) mx = freqDb[i];
      // gentle tilt so highs aren't always tiny
      mx += (k / SPECTRUM_BINS) * 12;
      const v = Math.min(1, Math.max(0, (mx - (this.specPeakDb - 65)) / 65));
      f.spectrum[k] = smooth(f.spectrum[k], Math.pow(v, 1.5) * Math.min(1.3, sens), 0.02, 0.12, dt);
    }

    // ── waveform: stable from a rising zero crossing ──
    let start = 0;
    for (let i = 1; i < timeData.length - WAVE_SAMPLES * 4; i++) {
      if (timeData[i - 1] < 0 && timeData[i] >= 0) {
        start = i;
        break;
      }
    }
    let wpk = 0.05;
    for (let i = 0; i < WAVE_SAMPLES; i++) wpk = Math.max(wpk, Math.abs(timeData[start + i * 4] ?? 0));
    const wg = Math.min(4, 0.9 / wpk);
    for (let i = 0; i < WAVE_SAMPLES; i++) f.waveform[i] = (timeData[start + i * 4] ?? 0) * wg;

    // ── energy / build / drop ──
    const eNorm = this.energyAgc.norm(rmsDb, dt);
    this.fastE = smooth(this.fastE, eNorm, 0.4, 0.6, dt);
    this.slowE = smooth(this.slowE, eNorm, 4, 4, dt);
    f.energy = smooth(f.energy, Math.min(1, this.fastE * 1.1), 0.8, 1.5, dt);

    let buildTarget: number;
    let dropFired = false;
    /** how big the drop that just fired is (the drop envelope peaks there: small drops flash less) */
    let dropSize = 1;
    const an2 = this.analysis;
    if (m.songTime !== null && an2) {
      const tt = m.songTime;
      const sec = an2.sections.find((s) => tt >= s.start && tt < s.end);
      buildTarget = sec?.label === 'build' ? Math.min(1, (tt - sec.start) / Math.max(1, sec.end - sec.start)) : 0;
      if (this.nextDropIdx < an2.drops.length && tt >= an2.drops[this.nextDropIdx]) {
        if (tt - an2.drops[this.nextDropIdx] < 0.5) {
          dropFired = true;
          const st = an2.dropInfo?.[this.nextDropIdx]?.strength;
          if (typeof st === 'number') dropSize = 0.55 + 0.45 * Math.max(0, Math.min(1, st));
        }
        this.nextDropIdx++;
      }
    } else {
      // realtime heuristic: rising energy + rising brightness
      const rise = this.fastE - this.slowE;
      this.buildAcc = Math.max(0, Math.min(1, this.buildAcc + (rise > 0.04 ? dt * 0.25 : -dt * 0.5)));
      buildTarget = this.buildAcc;
      if (rise > 0.22 && f.kickHit && t - this.lastDropT > 8) dropFired = true;
    }
    f.build = smooth(f.build, buildTarget, 0.5, 0.25, dt);
    if (dropFired) {
      this.lastDropT = t;
      f.drop = dropSize;
      this.buildAcc = 0;
    } else {
      f.drop *= Math.exp(-dt / 1.2);
    }

    this.advancePhase(dt, f, true);
    this.writeLayers();
    return f;
  }

  private advancePhase(dt: number, f: AudioFrame, live: boolean) {
    // tempo: override > analysis > onset-interval estimate
    let bpm = this.bpmOverride || this.analysis?.bpm || 0;
    if (!bpm && live) {
      if (this.onsetTimes.length > 6) this.bpmEstimate = estimateBpm(this.onsetTimes) || this.bpmEstimate;
      bpm = this.bpmEstimate;
    }
    const effBpm = bpm || 120;
    f.bpm = bpm;
    const prevPhase = this.phase;
    this.phase += (dt * effBpm) / 60 * (live ? 1 : 0.25);
    // phase correction: nudge toward kick onsets near a beat boundary
    if (live && f.kickHit) {
      const err = this.phase - Math.round(this.phase);
      if (Math.abs(err) < 0.25) this.phase -= err * 0.35;
    }
    if (Math.floor(this.phase) > Math.floor(prevPhase)) {
      this.beatCount++;
      f.beat = live;
    }
    f.beatPhase = this.phase - Math.floor(this.phase);
    f.beatCount = this.beatCount;
    const bar = (this.phase / 4) % 1;
    f.sway = Math.sin(bar * Math.PI * 2);
  }

  private writeLayers() {
    const f = this.frame;
    const L = f.layers;
    L.level = f.level;
    L.sub = f.sub;
    L.bass = f.bass;
    L.lowMid = f.lowMid;
    L.mid = f.mid;
    L.highMid = f.highMid;
    L.air = f.air;
    L.kick = f.kick;
    L.snare = f.snare;
    L.hat = f.hat;
    L.energy = f.energy;
    L.brightness = f.brightness;
    L.flux = f.flux;
    L.beatPhase = f.beatPhase;
    L.build = f.build;
    L.drop = f.drop;
    L.sway = f.sway * 0.5 + 0.5;
  }
}

/** Inter-onset-interval histogram → bpm in 70–180. */
function estimateBpm(times: number[]): number {
  const hist = new Float32Array(111); // 70..180
  for (let i = 0; i < times.length; i++) {
    for (let j = i + 1; j < Math.min(times.length, i + 8); j++) {
      const d = times[j] - times[i];
      if (d < 0.25 || d > 3) continue;
      for (const mult of [1, 2, 0.5, 4]) {
        const bpm = (60 / d) * mult;
        if (bpm >= 70 && bpm <= 180) {
          const k = Math.round(bpm - 70);
          hist[k] += 1 / mult;
          if (k > 0) hist[k - 1] += 0.5 / mult;
          if (k < 110) hist[k + 1] += 0.5 / mult;
        }
      }
    }
  }
  let best = 0;
  let bi = -1;
  for (let k = 0; k < hist.length; k++) if (hist[k] > best) (best = hist[k]), (bi = k);
  return bi >= 0 && best > 3 ? bi + 70 : 0;
}
