/**
 * Dev helper: a scripted 64-second test song (120 bpm), so a look can be built and checked without
 * loading audio. It produces the same AudioFrame the real engine does, plus matching lyrics and an
 * analysis, and it is the same every run.
 *
 *    0– 8 s  intro   quiet pad, no drums
 *    8–24 s  verse   kick on every beat, snare on 2 and 4, off-beat hats, vocals
 *   24–32 s  build   snare roll speeds up, the kick drops out for the last bar
 *   32 s     DROP
 *   32–48 s  chorus  everything loud, 16th hats, wobbling sub
 *   48–56 s  break   quiet, no drums
 *   56–64 s  outro   kick and hats, fading
 */
import type { AudioFrame, LayerId, Lyrics, TrackAnalysis, TrackSection } from '../core/types';

export const TEST_SONG = { duration: 64, bpm: 120, title: 'Louder Than The Dark', artist: 'Test Signal' };

const BEAT = 0.5;
const SECTIONS: TrackSection[] = [
  { start: 0, end: 8, energy: 0.15, label: 'intro', group: 0 },
  { start: 8, end: 24, energy: 0.5, label: 'verse', group: 1 },
  { start: 24, end: 32, energy: 0.7, label: 'build', group: 2 },
  { start: 32, end: 48, energy: 0.92, label: 'drop', group: 3 },
  { start: 48, end: 56, energy: 0.22, label: 'break', group: 4 },
  { start: 56, end: 64, energy: 0.4, label: 'outro', group: 0 },
];

export function sectionAt(t: number): TrackSection {
  return SECTIONS.find((s) => t >= s.start && t < s.end) ?? SECTIONS[SECTIONS.length - 1];
}

/** hit times (s) for each drum, in order */
function drumTimes() {
  const kick: number[] = [];
  const snare: number[] = [];
  const hat: number[] = [];
  for (let b = 0; b < TEST_SONG.duration / BEAT; b++) {
    const t = b * BEAT;
    const sec = sectionAt(t).label;
    if (sec === 'verse' || sec === 'drop') {
      kick.push(t);
      if (b % 2 === 1) snare.push(t);
      if (sec === 'verse') hat.push(t + BEAT / 2);
      else for (let k = 0; k < 4; k++) hat.push(t + (k * BEAT) / 4);
    } else if (sec === 'build') {
      const bar = Math.floor((t - 24) / 2);
      if (bar < 3) kick.push(t);
      const div = bar === 0 ? 1 : bar < 3 ? 2 : 4; // quarters → eighths → sixteenths
      for (let k = 0; k < div; k++) snare.push(t + (k * BEAT) / div);
      hat.push(t + BEAT / 2);
    } else if (sec === 'outro') {
      if (t < 62) kick.push(t);
      hat.push(t + BEAT / 2);
    }
  }
  return { kick, snare, hat };
}
const DRUMS = drumTimes();

const LINES: [number, string][] = [
  [8, 'Streetlights hum a quiet tune'],
  [12, 'I keep the window open wide'],
  [16, 'Every colour sounds like you'],
  [20, 'Hold the note and let it ride'],
  [32, 'We are louder than the dark'],
  [36, 'Turn the feeling into light'],
  [40, 'We are louder than the dark'],
  [44, 'Sing it till the morning comes'],
  [56, 'Streetlights hum a quiet tune'],
];

export function testLyrics(): Lyrics {
  return {
    synced: true,
    source: 'pasted',
    title: TEST_SONG.title,
    artist: TEST_SONG.artist,
    lines: LINES.map(([t, text]) => {
      const parts = text.split(' ');
      const step = 3 / parts.length;
      return { t, end: t + 3.4, text, words: parts.map((w, i) => ({ t: t + i * step, end: t + (i + 1) * step, text: w })) };
    }),
  };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
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

/** slow section energy, eased over about a second at each boundary (the drop lands at once) */
function energyAt(t: number): number {
  let e = SECTIONS[0].energy;
  for (let i = 1; i < SECTIONS.length; i++) {
    const s = SECTIONS[i];
    const w = s.label === 'drop' ? 0.15 : 1.2;
    e += (s.energy - SECTIONS[i - 1].energy) * smooth(s.start - w * 0.3, s.start + w, t);
  }
  if (t >= 24 && t < 32) e += 0.15 * ((t - 24) / 8); // the build climbs
  if (t >= 56) e *= 1 - 0.6 * smooth(58, 64, t);
  return Math.min(1, e);
}

/** seconds since the most recent time in a sorted list (large when none yet) */
function since(times: number[], t: number): number {
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
  return found < 0 ? 100 : t - times[found];
}
const crossed = (times: number[], prev: number, t: number) => since(times, t) < t - prev;

/** Fill `f` with the test song at `t` seconds; `prev` is the time of the previous frame. */
export function testFrame(f: AudioFrame, t: number, prev: number): AudioFrame {
  t = ((t % TEST_SONG.duration) + TEST_SONG.duration) % TEST_SONG.duration;
  if (prev > t) prev = t - 1 / 60;
  const sec = sectionAt(t).label;
  const energy = energyAt(t);
  const loud = sec === 'drop' ? 1 : sec === 'verse' ? 0.75 : sec === 'build' ? 0.8 : 0.6;

  const kick = Math.exp(-since(DRUMS.kick, t) * 7) * loud;
  const snare = Math.exp(-since(DRUMS.snare, t) * 9) * (sec === 'build' ? 0.55 + 0.45 * ((t - 24) / 8) : loud);
  const hat = Math.exp(-since(DRUMS.hat, t) * 16) * (0.5 + 0.4 * energy);
  const vocal = LINES.some(([s]) => t >= s && t < s + 3.2) ? 0.55 + 0.35 * Math.abs(Math.sin(t * 5.1)) : 0;
  const pad = 0.25 + 0.2 * Math.sin(t * 0.7) * Math.sin(t * 0.31);
  const wobble = sec === 'drop' ? 0.5 + 0.5 * Math.sin(t * Math.PI * 4) : 0;

  const beats = t / BEAT;
  f.playing = true;
  f.time = t;
  f.duration = TEST_SONG.duration;
  f.bpm = TEST_SONG.bpm;
  f.beatPhase = beats - Math.floor(beats);
  f.beatCount = Math.floor(beats);
  f.beat = Math.floor(prev / BEAT) !== Math.floor(t / BEAT);
  f.kickHit = crossed(DRUMS.kick, prev, t);
  f.snareHit = crossed(DRUMS.snare, prev, t);
  f.hatHit = crossed(DRUMS.hat, prev, t);
  f.onset = f.kickHit || f.snareHit;
  f.kick = kick;
  f.snare = snare;
  f.hat = hat;
  f.energy = energy;
  f.sub = Math.min(1, 0.12 * energy + 0.5 * kick * energy + 0.55 * wobble);
  f.bass = Math.min(1, 0.15 + 0.35 * energy + 0.4 * kick + 0.15 * wobble);
  f.lowMid = Math.min(1, pad * 0.8 + 0.3 * energy + 0.15 * snare);
  f.mid = Math.min(1, pad * 0.5 + 0.25 * energy + 0.5 * vocal);
  f.highMid = Math.min(1, 0.1 + 0.3 * energy + 0.45 * snare + 0.2 * vocal);
  f.air = Math.min(1, 0.05 + 0.25 * energy + 0.55 * hat);
  f.level = Math.min(1, 0.12 + 0.6 * energy + 0.18 * kick + 0.08 * snare);
  f.brightness = Math.min(1, 0.28 + 0.4 * energy + (sec === 'build' ? 0.2 * ((t - 24) / 8) : 0));
  f.flux = Math.min(1, 0.1 + 0.6 * Math.max(kick, snare) + 0.2 * hat);
  f.build = sec === 'build' ? (t - 24) / 8 : 0;
  f.drop = t >= 32 && t < 38 ? Math.exp(-(t - 32) * 1.2) : 0;
  f.sway = Math.sin((t / (BEAT * 4)) * Math.PI * 2);

  // spectrum: a tilted bed, a kick bump at the bottom, two melody peaks, hats on top
  const m1 = 0.3 + 0.12 * Math.sin(t * 1.3);
  const m2 = 0.48 + 0.1 * Math.sin(t * 0.83 + 2);
  for (let i = 0; i < f.spectrum.length; i++) {
    const x = i / (f.spectrum.length - 1);
    let v = (0.25 + 0.55 * energy) * Math.pow(1 - x, 1.4) * (0.55 + 0.45 * noise(i * 0.37 + t * 3));
    v += (0.7 * kick + 0.4 * wobble) * Math.exp(-(x * x) / 0.004);
    v += (0.3 + 0.5 * vocal) * (0.3 + energy) * (Math.exp(-((x - m1) ** 2) / 0.0015) + 0.7 * Math.exp(-((x - m2) ** 2) / 0.001));
    v += 0.5 * snare * Math.exp(-((x - 0.55) ** 2) / 0.02) * noise(i * 1.7 + t * 40);
    v += 0.6 * hat * smooth(0.7, 0.95, x) * noise(i * 2.3 + t * 60);
    f.spectrum[i] = Math.min(1, Math.max(0, v));
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

export function testAnalysis(): TrackAnalysis {
  const n = 1000;
  const curve = (fn: (t: number) => number) => Float32Array.from({ length: n }, (_, i) => fn((i / n) * TEST_SONG.duration));
  const notes = (base: number, every: number) =>
    Array.from({ length: Math.floor(TEST_SONG.duration / every) }, (_, i) => ({ t: i * every, end: i * every + every * 0.8, midi: base + [0, 3, 7, 5][i % 4], v: 0.7 })).filter(
      (nt) => sectionAt(nt.t).label !== 'intro' && sectionAt(nt.t).label !== 'break',
    );
  return {
    duration: TEST_SONG.duration,
    bpm: TEST_SONG.bpm,
    overview: curve((t) => 0.2 + 0.8 * energyAt(t)),
    energyCurve: curve(energyAt),
    lowCurve: curve((t) => energyAt(t) * 0.9),
    midCurve: curve((t) => energyAt(t) * 0.7),
    highCurve: curve((t) => energyAt(t) * 0.6),
    sections: SECTIONS,
    drops: [32],
    dropInfo: [{ t: 32, strength: 1, why: 'bass and kick return after a 4-bar build' }],
    mood: { arousal: 0.65, valence: 0.6, brightness: 0.55, density: 0.6, lowEnd: 0.45, dynamics: 0.7 },
    tags: ['euphoric', 'driving', 'electronic', 'bright'],
    suggestedPresets: [],
    summary: 'A scripted 64 s test song at 120 bpm: quiet intro, verse, build, a drop at 0:32, break, outro.',
    layers: { ...DRUMS, bass: notes(36, 1), lead: notes(72, 0.5), vocal: LINES.map(([t]) => [t, t + 3.2] as [number, number]) },
    character: { genre: 'dance pop', confidence: 0.8, instruments: ['synth bass', 'drums', 'vocals', 'pads'], mood: 'euphoric' },
  };
}
