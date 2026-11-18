/**
 * Two tiny synthesized demo tracks so the app works with zero setup.
 * Pure JS DSP → WAV blob. Each renders in well under a second.
 */

const SR = 44100;

export interface DemoTrack {
  id: string;
  name: string;
  description: string;
  render: () => Blob;
}

/* ───────── DSP helpers ───────── */
let seed = 1;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed / 2147483647) * 2 - 1;
};
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

class SVF {
  low = 0;
  band = 0;
  process(x: number, cutoff: number, q: number) {
    const f = 2 * Math.sin((Math.PI * Math.min(cutoff, SR / 6)) / SR);
    const high = x - this.low - q * this.band;
    this.band += f * high;
    this.low += f * this.band;
    return { low: this.low, band: this.band, high };
  }
}

function softclip(x: number) {
  return Math.tanh(x);
}

function toWav(L: Float32Array, R: Float32Array): Blob {
  const n = L.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 4, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 4, true);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = 0.92 / Math.max(peak, 1e-6);
  let o = 44;
  for (let i = 0; i < n; i++) {
    v.setInt16(o, Math.max(-1, Math.min(1, L[i] * g)) * 32767, true);
    v.setInt16(o + 2, Math.max(-1, Math.min(1, R[i] * g)) * 32767, true);
    o += 4;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/* ───────── "Pressure" — 140 bpm halftime bass music ───────── */
function renderPressure(): Blob {
  seed = 7;
  const bpm = 140;
  const beat = 60 / bpm;
  const bar = beat * 4;
  const introBars = 8;
  const buildBars = 8;
  const dropBars = 16;
  const outroBars = 4;
  const total = (introBars + buildBars + dropBars + outroBars) * bar;
  const n = Math.floor(total * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const tBuild = introBars * bar;
  const tDrop = tBuild + buildBars * bar;
  const tOutro = tDrop + dropBars * bar;

  // chord roots (F minor): Fm, Db, Ab, Eb
  const chords = [
    [53, 56, 60],
    [49, 53, 56],
    [56, 60, 63],
    [51, 55, 58],
  ];
  const bassNotes = [29, 25, 32, 27];
  const padF = [new SVF(), new SVF()];
  const bassF = new SVF();
  const riserF = new SVF();
  const hatF = new SVF();
  const snareF = new SVF();
  const phases = new Float64Array(16);
  let bassPh = 0;
  let subPh = 0;

  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const barIdx = Math.floor(t / bar);
    const inBar = t - barIdx * bar;
    const bt = t / beat;
    const beatIdx = Math.floor(bt);
    const inBeat = t - beatIdx * beat;
    const chord = chords[barIdx % 4];
    let l = 0;
    let r = 0;

    // ── pad (everywhere except drop is quieter) ──
    const padAmp = t < tDrop ? 0.16 : t < tOutro ? 0.07 : 0.14 * Math.max(0, 1 - (t - tOutro) / (outroBars * bar));
    if (padAmp > 0) {
      let sL = 0;
      let sR = 0;
      for (let k = 0; k < 3; k++) {
        const f = midi(chord[k]);
        for (let d = 0; d < 2; d++) {
          const idx = k * 2 + d;
          phases[idx] += (f * (d ? 1.006 : 0.994)) / SR;
          const saw = (phases[idx] % 1) * 2 - 1;
          if (d) sR += saw;
          else sL += saw;
        }
      }
      const cutoff = 500 + 900 * (0.5 + 0.5 * Math.sin(t * 0.4)) + (t > tBuild && t < tDrop ? ((t - tBuild) / (tDrop - tBuild)) * 2500 : 0);
      l += padF[0].process(sL / 3, cutoff, 0.7).low * padAmp;
      r += padF[1].process(sR / 3, cutoff, 0.7).low * padAmp;
    }

    // ── hats ──
    const hatOn = t > bar * 2 && t < tOutro + bar * 2;
    if (hatOn) {
      const step = beat / 2;
      const ht = t % step;
      const open = Math.floor(t / step) % 4 === 3;
      const env = Math.exp(-ht * (open ? 18 : 70));
      const hh = hatF.process(rnd(), 9000, 0.4).high * env * (t >= tDrop ? 0.13 : 0.08);
      l += hh * 0.8;
      r += hh;
    }

    // ── build: accelerating snare roll + riser ──
    if (t >= tBuild && t < tDrop) {
      const p = (t - tBuild) / (tDrop - tBuild);
      const div = p < 0.5 ? 1 : p < 0.75 ? 2 : p < 0.9 ? 4 : 8;
      const step = beat / div;
      const st = t % step;
      const env = Math.exp(-st * 30);
      const s = snareF.process(rnd(), 1800 + p * 3000, 0.8).band * env * (0.15 + p * 0.3);
      l += s;
      r += s;
      const rz = riserF.process(rnd(), 400 + p * p * 9000, 0.3).band * p * p * 0.35;
      l += rz;
      r += rz * 0.9;
      // pitch riser
      const rf = 200 + p * p * 1600;
      phases[10] += rf / SR;
      const sine = Math.sin(phases[10] * Math.PI * 2) * p * 0.05;
      l += sine;
      r += sine;
    }
    // silence gap right before the drop
    const gap = t > tDrop - beat * 0.5 && t < tDrop;

    // ── drop: halftime drums + wobble bass ──
    if (t >= tDrop && t < tOutro) {
      // kick on beat 1 (and a ghost on the "and" of 2 every other bar)
      const kt1 = inBar;
      const kt2 = inBar - beat * 2.5;
      const kickAt = (kt: number) => {
        if (kt < 0 || kt > 0.5) return 0;
        const f = 45 + 110 * Math.exp(-kt * 30);
        phases[12] += f / SR;
        return Math.sin(phases[12] * Math.PI * 2) * Math.exp(-kt * 6) * 0.9 + (kt < 0.004 ? rnd() * 0.3 : 0);
      };
      let k = kickAt(kt1);
      if (barIdx % 2 === 1) k += kickAt(kt2) * 0.7;
      // snare on beat 3
      const stt = inBar - beat * 2;
      let sn = 0;
      if (stt >= 0 && stt < 0.4) {
        sn = snareF.process(rnd(), 2200, 0.9).band * Math.exp(-stt * 16) * 0.7 + Math.sin(stt * 2 * Math.PI * 190) * Math.exp(-stt * 25) * 0.3;
      }
      // wobble: LFO rate changes per bar (1/2, 1/3, 1/4, 1/8 beat)
      const rates = [2, 3, 1, 4, 2, 6, 1.5, 8];
      const rate = rates[barIdx % rates.length] / beat;
      const lfo = 0.5 - 0.5 * Math.cos(2 * Math.PI * rate * (t - tDrop));
      const note = bassNotes[barIdx % 4];
      const bf = midi(note);
      bassPh += bf / SR;
      subPh += bf / SR;
      const saw = ((bassPh % 1) * 2 - 1) + ((bassPh * 1.01) % 1) * 2 - 1;
      const cutoff = 90 + lfo * lfo * 2600;
      const wob = softclip(bassF.process(saw * 0.6, cutoff, 0.25).low * 2.2) * 0.45;
      const sub = Math.sin(subPh * Math.PI * 2) * 0.45;
      const duck = 1 - Math.exp(-inBeat * 8) * 0.0; // keep simple
      l += (k + sn + wob * duck + sub) * 1;
      r += (k + sn * 0.95 + wob * duck * 0.97 + sub) * 1;
    }

    // ── intro/outro soft kick every bar ──
    if ((t > bar * 4 && t < tBuild) || t >= tOutro) {
      const kt = inBar;
      if (kt < 0.4) {
        const f = 50 + 70 * Math.exp(-kt * 25);
        phases[13] += f / SR;
        const k = Math.sin(phases[13] * Math.PI * 2) * Math.exp(-kt * 7) * 0.45;
        l += k;
        r += k;
      }
    }

    if (gap) {
      l *= 0.05;
      r *= 0.05;
    }
    L[i] = softclip(l * 1.1);
    R[i] = softclip(r * 1.1);
  }
  return toWav(L, R);
}

/* ───────── "Driftwood" — 72 bpm, slow and sad ───────── */
function renderDriftwood(): Blob {
  seed = 3;
  const bpm = 72;
  const beat = 60 / bpm;
  const bar = beat * 4;
  const bars = 14;
  const total = bars * bar;
  const n = Math.floor(total * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  // Am – F – C – G  (melancholic loop)
  const chords = [
    [57, 60, 64],
    [53, 57, 60],
    [48, 52, 55],
    [55, 59, 62],
  ];
  const melody = [76, 74, 72, 71, 72, 69, 67, 69, 72, 74, 76, 79, 76, 74, 72, 71];
  const rainF = new SVF();
  const rainF2 = new SVF();
  const padF = [new SVF(), new SVF()];
  const ph = new Float64Array(16);
  // piano-ish pluck voices: store [startTime, freq, amp]
  const notes: [number, number, number][] = [];
  for (let b = 0; b < bars; b++) {
    const ch = chords[b % 4];
    // arpeggio 8ths
    for (let s = 0; s < 8; s++) {
      const nn = ch[[0, 1, 2, 1, 0, 2, 1, 2][s]] + (s > 4 ? 12 : 0);
      notes.push([b * bar + (s * beat) / 2, midi(nn), 0.12 + (s === 0 ? 0.06 : 0)]);
    }
    if (b >= 4) {
      const m1 = melody[(b * 2) % melody.length];
      const m2 = melody[(b * 2 + 1) % melody.length];
      notes.push([b * bar, midi(m1), 0.16]);
      notes.push([b * bar + beat * 2.5, midi(m2), 0.13]);
    }
  }
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const barIdx = Math.floor(t / bar);
    const inBar = t - barIdx * bar;
    const ch = chords[barIdx % 4];
    let l = 0;
    let r = 0;
    // rain bed
    const rain = rainF.process(rnd(), 3500, 0.5).band * 0.05 + (Math.random() < 0.0009 ? rnd() * 0.25 : 0);
    const rain2 = rainF2.process(rnd(), 1200, 1.2).low * 0.03;
    l += rain + rain2;
    r += rain * 0.8 + rain2;
    // pad swell
    const swell = 0.5 + 0.5 * Math.sin((t / bar) * Math.PI);
    let sL = 0;
    let sR = 0;
    for (let k = 0; k < 3; k++) {
      ph[k] += (midi(ch[k] - 12) * 0.997) / SR;
      ph[k + 3] += (midi(ch[k] - 12) * 1.003) / SR;
      sL += (ph[k] % 1) * 2 - 1;
      sR += (ph[k + 3] % 1) * 2 - 1;
    }
    l += padF[0].process(sL / 3, 700, 0.9).low * 0.09 * (0.6 + 0.4 * swell);
    r += padF[1].process(sR / 3, 700, 0.9).low * 0.09 * (0.6 + 0.4 * swell);
    // soft heartbeat kick on 1 and 3 after bar 2
    if (barIdx >= 2) {
      for (const off of [0, beat * 2]) {
        const kt = inBar - off;
        if (kt >= 0 && kt < 0.5) {
          const f = 48 + 40 * Math.exp(-kt * 20);
          ph[10] += f / SR;
          const k = Math.sin(ph[10] * 2 * Math.PI) * Math.exp(-kt * 6) * (off ? 0.22 : 0.32);
          l += k;
          r += k;
        }
      }
      // brushed snare on 2 and 4 after bar 6
      if (barIdx >= 6) {
        for (const off of [beat, beat * 3]) {
          const st = inBar - off;
          if (st >= 0 && st < 0.3) {
            const s = rnd() * Math.exp(-st * 22) * 0.08;
            l += s;
            r += s;
          }
        }
      }
    }
    L[i] = l;
    R[i] = r;
  }
  // plucks (rendered additively per note — cheap)
  for (const [st, f, amp] of notes) {
    const i0 = Math.floor(st * SR);
    const len = Math.min(n - i0, Math.floor(2.4 * SR));
    const pan = 0.5 + 0.35 * Math.sin(f);
    for (let j = 0; j < len; j++) {
      const t = j / SR;
      const env = Math.exp(-t * 2.6) * (1 - Math.exp(-t * 400));
      const s = (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t) * Math.exp(-t * 4) + 0.12 * Math.sin(6 * Math.PI * f * t) * Math.exp(-t * 7)) * env * amp;
      L[i0 + j] += s * (1 - pan) * 1.4;
      R[i0 + j] += s * pan * 1.4;
    }
  }
  // tiny reverb-ish smear (feedback delays)
  const d1 = Math.floor(0.113 * SR);
  const d2 = Math.floor(0.171 * SR);
  for (let i = d2; i < n; i++) {
    L[i] += L[i - d1] * 0.35 + R[i - d2] * 0.2;
    R[i] += R[i - d1] * 0.35 + L[i - d2] * 0.2;
  }
  // fade in/out
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const g = Math.min(1, t / 2) * Math.min(1, (total - t) / 3);
    L[i] *= g;
    R[i] *= g;
  }
  return toWav(L, R);
}

export const DEMO_TRACKS: DemoTrack[] = [
  { id: 'pressure', name: 'Pressure', description: '140 bpm halftime bass · build → drop', render: renderPressure },
  { id: 'driftwood', name: 'Driftwood', description: '72 bpm · rain, piano, sorrow', render: renderDriftwood },
];
