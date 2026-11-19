/**
 * The audio engine's ears, fed from the decoded song instead of the speakers.
 *
 * A render (render/timeline.ts) needs the AudioFrame playback would have produced at any moment of
 * the song, frame after frame, without playing anything. This computes the same spectrum the
 * browser's AnalyserNode gives the live engine (a Blackman window over the last 4096 samples, an FFT,
 * magnitude / N in dB) straight from the PCM, and runs it through its own copy of the engine's DSP
 * (frameDsp.ts). The live engine is never touched.
 *
 * Listening steps at a steady 60 a second whatever the video's frame rate, like playback on a normal
 * screen, so a 30 fps and a 60 fps render hear the same hits.
 */
import type { AudioFrame, TrackAnalysis } from '../core/types';
import { FFT_SIZE, FrameDsp } from './frameDsp';

/** listening steps per second (playback runs at the screen's rate, usually 60) */
export const LISTEN_RATE = 60;
/**
 * How far ahead of the frame's time the listening window ends (s). The window is tapered (Blackman),
 * so a hit only weighs in once it is a little way inside it; looking ~20 ms ahead puts a kick's flash
 * on the frame that shows it, like playback does once the speakers' own delay is counted.
 */
export const LOOKAHEAD = 0.02;

/** the decoded song, one Float32Array per channel */
export interface SongPcm {
  channels: Float32Array[];
  sampleRate: number;
}

/** A browser AnalyserNode in plain code: getFloatFrequencyData / getFloatTimeDomainData for any moment. */
export class SpectrumProbe {
  readonly n: number;
  private win: Float64Array;
  private re: Float64Array;
  private im: Float64Array;
  private cos: Float64Array;
  private sin: Float64Array;
  private rev: Uint32Array;

  constructor(n = FFT_SIZE) {
    this.n = n;
    this.win = new Float64Array(n);
    // the Web Audio spec's Blackman window (alpha 0.16)
    for (let i = 0; i < n; i++) this.win[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / n) + 0.08 * Math.cos((4 * Math.PI * i) / n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /**
   * Fill `timeData` with the mono samples ending just before sample `end` (zeros before the song
   * starts), and `freqDb` with their spectrum in dB, exactly as an AnalyserNode with
   * smoothingTimeConstant 0 reports it.
   */
  read(mono: Float32Array, end: number, freqDb: Float32Array, timeData: Float32Array) {
    const n = this.n;
    const s0 = end - n;
    for (let i = 0; i < n; i++) {
      const j = s0 + i;
      timeData[i] = j >= 0 && j < mono.length ? mono[j] : 0;
    }
    const re = this.re;
    const im = this.im;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      re[rev[i]] = timeData[i] * this.win[i];
      im[rev[i]] = 0;
    }
    // iterative radix-2 FFT
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step];
          const s = this.sin[k * step];
          const a = i + k;
          const b = a + half;
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    const scale = 1 / n;
    for (let k = 0; k < n / 2; k++) {
      const mag = Math.hypot(re[k], im[k]) * scale;
      freqDb[k] = 20 * Math.log10(mag);
    }
  }
}

/** the song folded to mono the way an AnalyserNode hears it (stereo: half of left plus right) */
export function downmix(pcm: SongPcm): Float32Array {
  const ch = pcm.channels;
  if (ch.length === 1) return ch[0];
  const n = ch[0].length;
  const out = new Float32Array(n);
  if (ch.length === 2) {
    const [l, r] = ch;
    for (let i = 0; i < n; i++) out[i] = 0.5 * (l[i] + r[i]);
    return out;
  }
  for (const c of ch) for (let i = 0; i < n; i++) out[i] += c[i] / ch.length;
  return out;
}

/**
 * AudioFrames for a stretch of the song, computed from its samples. `start(t)` begins listening at
 * song time t (pass a moment a few seconds early so the levels settle), then `advanceTo` walks
 * forward frame by frame. The same song, settings and start always give the same frames.
 */
export class OfflineAudioFrames {
  readonly dsp = new FrameDsp();
  private probe = new SpectrumProbe(FFT_SIZE);
  private freqDb = new Float32Array(FFT_SIZE / 2);
  private timeData = new Float32Array(FFT_SIZE);
  private mono: Float32Array;
  private t = 0;
  readonly duration: number;

  constructor(
    private pcm: SongPcm,
    analysis: TrackAnalysis | null,
    opts: { sensitivity?: number; bpmOverride?: number; mono?: Float32Array } = {},
  ) {
    this.mono = opts.mono ?? downmix(pcm);
    this.duration = this.mono.length / pcm.sampleRate;
    this.dsp.sensitivity = opts.sensitivity ?? 1;
    this.dsp.bpmOverride = opts.bpmOverride ?? 0;
    this.dsp.analysis = analysis;
  }

  get frame(): AudioFrame {
    return this.dsp.frame;
  }

  /** start listening at song time t, from a clean slate (beats line up with the song's own grid) */
  start(t: number) {
    this.dsp.resetAll();
    this.dsp.setAnalysis(this.dsp.analysis, t);
    this.dsp.alignBeat(t);
    this.t = t;
  }

  private stepAt(t: number, dt: number) {
    const sr = this.pcm.sampleRate;
    const end = Math.round((t + LOOKAHEAD) * sr);
    this.probe.read(this.mono, end, this.freqDb, this.timeData);
    const songT = Math.max(0, t);
    this.dsp.step(dt, { freqDb: this.freqDb, timeData: this.timeData, sampleRate: sr }, { time: songT, duration: this.duration, playing: true, songTime: songT });
  }

  /**
   * Listen up to song time t and return the frame there. Hits, beats and onsets that happened in
   * between (when the video's frames are further apart than the listening steps) are kept on it.
   */
  advanceTo(t: number): AudioFrame {
    const span = t - this.t;
    const f = this.dsp.frame;
    if (span <= 1e-9) return f;
    const n = Math.max(1, Math.round(span * LISTEN_RATE));
    const dt = span / n;
    let kick = false;
    let snare = false;
    let hat = false;
    let onset = false;
    let beat = false;
    for (let i = 1; i <= n; i++) {
      this.stepAt(this.t + dt * i, dt);
      kick ||= f.kickHit;
      snare ||= f.snareHit;
      hat ||= f.hatHit;
      onset ||= f.onset;
      beat ||= f.beat;
    }
    this.t = t;
    f.kickHit = kick;
    f.snareHit = snare;
    f.hatHit = hat;
    f.onset = onset;
    f.beat = beat;
    return f;
  }
}
