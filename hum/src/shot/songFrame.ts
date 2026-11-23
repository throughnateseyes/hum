/**
 * An AudioFrame made from a song's analysis alone (prototype, see src/dev/shot.ts).
 *
 * The shot prototype is a pure function of song time, so it can't read the live audio engine. This
 * fills the same AudioFrame the engine does, from the analysis: the beat grid from the bpm, drum
 * envelopes from the analysed hit times, band levels from the energy curves, build and drop from the
 * sections and drops. It mirrors testFrame() in src/dev/testSong.ts, field for field, and it is the
 * same every run (no Math.random).
 */
import type { AudioFrame, LayerId, TrackAnalysis } from '../core/types';

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const hash = (n: number) => {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
};
/** smooth 1D noise, 0..1 */
const noise = (x: number) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
};

/** a curve (points spread evenly across the song) at time t, linearly interpolated */
function sample(curve: Float32Array, t: number, duration: number): number {
  const n = curve.length;
  if (!n || duration <= 0) return 0;
  const x = Math.max(0, Math.min(n - 1, (t / duration) * n));
  const i = Math.floor(x);
  const j = Math.min(n - 1, i + 1);
  return curve[i] + (curve[j] - curve[i]) * (x - i);
}

/** index of the last time in a sorted list at or before t (-1 when none) */
function lastAtOrBefore(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** seconds since the most recent time in a sorted list (large when none yet) */
function since(times: number[], t: number): number {
  const i = lastAtOrBefore(times, t);
  return i < 0 ? 100 : t - times[i];
}
const crossed = (times: number[], prev: number, t: number) => since(times, t) < t - prev;

interface Hits {
  kick: number[];
  snare: number[];
  hat: number[];
  /** vocal span starts, and the matching ends */
  vocalStart: number[];
  vocalEnd: number[];
  /** drop times with their strength, sorted */
  drops: number[];
  dropStrength: number[];
}

/**
 * The hit lists for an analysis, worked out once and kept. With no `layers` (older analyses) the
 * drums fall back to the beat grid: kick on every beat, snare on 2 and 4, hats on the off-beats.
 */
const hitCache = new WeakMap<TrackAnalysis, Hits>();
function hitsFor(a: TrackAnalysis): Hits {
  const cached = hitCache.get(a);
  if (cached) return cached;
  const sorted = (xs: number[]) => [...xs].sort((p, q) => p - q);
  let kick: number[];
  let snare: number[];
  let hat: number[];
  if (a.layers) {
    kick = sorted(a.layers.kick);
    snare = sorted(a.layers.snare);
    hat = sorted(a.layers.hat);
  } else {
    const beat = 60 / (a.bpm > 0 ? a.bpm : 120);
    kick = [];
    snare = [];
    hat = [];
    for (let b = 0; b * beat < a.duration; b++) {
      kick.push(b * beat);
      if (b % 2 === 1) snare.push(b * beat);
      hat.push(b * beat + beat / 2);
    }
  }
  const spans = [...(a.layers?.vocal ?? [])].sort((p, q) => p[0] - q[0]);
  const drops = a.drops.map((t, i) => ({ t, s: a.dropInfo?.[i]?.strength ?? 1 })).sort((p, q) => p.t - q.t);
  const hits: Hits = {
    kick,
    snare,
    hat,
    vocalStart: spans.map((s) => s[0]),
    vocalEnd: spans.map((s) => s[1]),
    drops: drops.map((d) => d.t),
    dropStrength: drops.map((d) => d.s),
  };
  hitCache.set(a, hits);
  return hits;
}

/**
 * Fill `out` with the song at `t` seconds, from the analysis alone; `prev` is the time of the
 * previous frame (for the one-frame booleans: beat, kickHit, snareHit, hatHit, onset).
 */
export function frameFromAnalysis(out: AudioFrame, a: TrackAnalysis, t: number, prev: number): AudioFrame {
  const f = out;
  const dur = Math.max(0.001, a.duration);
  t = Math.max(0, Math.min(dur, t));
  // a jump (scrubbing, a restart) is not a run of hits: treat it as one ordinary frame
  if (prev > t || t - prev > 0.5) prev = t - 1 / 60;
  const hits = hitsFor(a);
  const bpm = a.bpm > 0 ? a.bpm : 120;
  const BEAT = 60 / bpm;

  const energy = clamp01(sample(a.energyCurve, t, dur));
  const low = clamp01(sample(a.lowCurve, t, dur));
  const midC = clamp01(sample(a.midCurve, t, dur));
  const high = clamp01(sample(a.highCurve, t, dur));

  // build: 0→1 across a section labelled 'build'
  const sec = a.sections.find((s) => t >= s.start && t < s.end) ?? null;
  const build = sec?.label === 'build' && sec.end > sec.start ? clamp01((t - sec.start) / (sec.end - sec.start)) : 0;
  // drop: fires at each drop and dies away over a few seconds
  const di = lastAtOrBefore(hits.drops, t);
  const drop = di >= 0 && t - hits.drops[di] < 6 ? Math.exp(-(t - hits.drops[di]) * 1.2) * hits.dropStrength[di] : 0;

  const loud = 0.55 + 0.45 * energy;
  const kick = Math.exp(-since(hits.kick, t) * 7) * loud;
  const snare = Math.exp(-since(hits.snare, t) * 9) * (build > 0 ? 0.55 + 0.45 * build : loud);
  const hat = Math.exp(-since(hits.hat, t) * 16) * (0.5 + 0.4 * energy);
  // vocals: inside an analysed vocal span, else lean on the mid curve
  let vocal: number;
  if (hits.vocalStart.length) {
    const vi = lastAtOrBefore(hits.vocalStart, t);
    vocal = vi >= 0 && t < hits.vocalEnd[vi] ? 0.55 + 0.35 * Math.abs(Math.sin(t * 5.1)) : 0;
  } else vocal = midC * (0.6 + 0.3 * Math.abs(Math.sin(t * 5.1)));
  const pad = 0.25 + 0.2 * Math.sin(t * 0.7) * Math.sin(t * 0.31);
  // a wobbling sub while the low end is heavy and a drop is ringing out
  const wobble = drop > 0.05 ? low * (0.5 + 0.5 * Math.sin(t * Math.PI * 4)) : 0;

  const beats = t / BEAT;
  f.playing = true;
  f.time = t;
  f.duration = a.duration;
  f.bpm = bpm;
  f.beatPhase = beats - Math.floor(beats);
  f.beatCount = Math.floor(beats);
  f.beat = Math.floor(prev / BEAT) !== Math.floor(t / BEAT);
  f.kickHit = crossed(hits.kick, prev, t);
  f.snareHit = crossed(hits.snare, prev, t);
  f.hatHit = crossed(hits.hat, prev, t);
  f.onset = f.kickHit || f.snareHit;
  f.kick = kick;
  f.snare = snare;
  f.hat = hat;
  f.energy = energy;
  f.sub = Math.min(1, 0.1 * energy + 0.25 * low + 0.45 * kick * energy + 0.5 * wobble);
  f.bass = Math.min(1, 0.1 + 0.25 * energy + 0.2 * low + 0.4 * kick + 0.15 * wobble);
  f.lowMid = Math.min(1, pad * 0.6 + 0.15 * energy + 0.2 * midC + 0.15 * snare);
  f.mid = Math.min(1, pad * 0.4 + 0.15 * energy + 0.2 * midC + 0.45 * vocal);
  f.highMid = Math.min(1, 0.08 + 0.15 * energy + 0.2 * high + 0.45 * snare + 0.2 * vocal);
  f.air = Math.min(1, 0.04 + 0.1 * energy + 0.2 * high + 0.55 * hat);
  f.level = Math.min(1, 0.12 + 0.6 * energy + 0.18 * kick + 0.08 * snare);
  // brightness leans on the song's mood (0.5 is neutral)
  f.brightness = clamp01(0.22 + 0.3 * energy + 0.15 * high + 0.2 * build + 0.3 * (a.mood.brightness - 0.5));
  f.flux = Math.min(1, 0.1 + 0.6 * Math.max(kick, snare) + 0.2 * hat);
  f.build = build;
  f.drop = drop;
  f.sway = Math.sin((t / (BEAT * 4)) * Math.PI * 2);

  // spectrum: a tilted bed shaped by the three band curves, a kick bump at the bottom, two melody
  // peaks that move every bar, hats on top
  const bar = Math.floor(beats / 4);
  const m1 = 0.26 + 0.1 * hash(bar + 1) + 0.04 * Math.sin(t * 1.3);
  const m2 = 0.44 + 0.1 * hash(bar + 7) + 0.04 * Math.sin(t * 0.83 + 2);
  for (let i = 0; i < f.spectrum.length; i++) {
    const x = i / (f.spectrum.length - 1);
    const band = low * (1 - smooth(0.1, 0.4, x)) + midC * smooth(0.1, 0.4, x) * (1 - smooth(0.5, 0.8, x)) + high * smooth(0.5, 0.8, x);
    let v = (0.15 + 0.35 * energy + 0.3 * band) * Math.pow(1 - x, 1.4) * (0.55 + 0.45 * noise(i * 0.37 + t * 3));
    v += (0.7 * kick + 0.4 * wobble) * Math.exp(-(x * x) / 0.004);
    v += (0.3 + 0.5 * vocal) * (0.3 + energy) * (Math.exp(-((x - m1) ** 2) / 0.0015) + 0.7 * Math.exp(-((x - m2) ** 2) / 0.001));
    v += 0.5 * snare * Math.exp(-((x - 0.55) ** 2) / 0.02) * noise(i * 1.7 + t * 40);
    v += 0.6 * hat * smooth(0.7, 0.95, x) * noise(i * 2.3 + t * 60);
    f.spectrum[i] = clamp01(v);
  }
  for (let i = 0; i < f.waveform.length; i++) {
    const x = i / f.waveform.length;
    let v = Math.sin(x * 18 + t * 9) * (0.25 + 0.5 * f.bass);
    v += Math.sin(x * 73 + t * 31) * 0.3 * f.mid;
    v += (hash(i + Math.floor(t * 60) * 513) - 0.5) * 0.7 * (f.air + 0.6 * snare);
    f.waveform[i] = Math.max(-1, Math.min(1, v * (0.4 + 0.8 * f.level)));
  }

  const L = f.layers as Record<LayerId, number>;
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
  L.sway = f.sway;
  return f;
}
