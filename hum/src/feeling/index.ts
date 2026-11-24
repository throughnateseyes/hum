/**
 * The feeling of a song, moment by moment: what its words mean, and where its sound is going.
 *
 *   SongFeeling     what each sung line feels like, how much it matters and the word that carries it.
 *                   Claude reads it once per song (director/feeling.ts); without Claude a small word list does
 *                   (lexicon.ts). Kept by the line's words, never its time, so a line sung again feels the same
 *                   and lyrics timed later (or moved) still fit. It is part of the plan it made.
 *   Curves          the same against the clock, with the sound: the tone (dark to bright), the wind-up to every
 *                   landing, and the words a picture should wait for
 *
 * The sound alone is read from the key it is in, how bright it is and how far its harmony is from home, so
 * tempo never makes a song happy; where there are words, they have most of the say.
 *
 * Everything is a pure function of the song, the feeling and the lyrics' times.
 */
import type { LyricLine, Lyrics, TrackAnalysis } from '../core/types';
import type { MomentId } from '../moments/list';
import { EMOTION_IDS, type Emotion } from './list';
import { readLine } from './lexicon';

export * from './list';

/** [emotion's place in EMOTION_IDS, tone -1..1, weight 0..1, the place of the word that carries it (-1 none), 1 when the song turns here] */
export type LineNote = [number, number, number, number, 0 | 1];

export interface SongFeeling {
  v: 1;
  by: 'claude' | 'hum';
  /** what the song is really about, one sentence ('' when nobody read it) */
  about: string;
  lines: Record<string, LineNote>;
}

/** what a line is kept by: its words alone */
export function lineKey(text: string): string {
  const s = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** the feeling of a song nobody has read: by its words, if it has any */
export function feelingByWords(lyr: Lyrics | null): SongFeeling {
  const lines: SongFeeling['lines'] = {};
  for (const l of lyr?.lines ?? []) {
    const r = readLine(l.text);
    if (r) lines[lineKey(l.text)] = [EMOTION_IDS.indexOf(r.emotion), Math.round(r.tone * 100) / 100, Math.round(r.weight * 100) / 100, r.word, 0];
  }
  return { v: 1, by: 'hum', about: '', lines };
}

/* ───────── against the clock ───────── */

export interface FeltLine {
  t: number;
  end: number;
  emotion: Emotion;
  tone: number;
  weight: number;
  turn: boolean;
  /** the word that carries it, and when it is sung */
  word: string;
  at: number;
}

/** the approach to a landing */
export interface WindUp {
  from: number;
  to: number;
  strength: number;
}

export interface Curves {
  /** tells one set from another (caches) */
  id: number;
  lines: FeltLine[];
  winds: WindUp[];
  /** the words heavy enough for the picture to wait for, in order */
  held: FeltLine[];
  about: string;
  by: SongFeeling['by'];
  /** 0 dark .. 1 bright */
  tone(t: number): number;
  /** 0..1: how far into a wind-up, times how big what it leads to is */
  wind(t: number): number;
  /** 0..1: how close to a word the picture waits for, times its weight */
  hold(t: number): number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};
const HZ = 4;

/** the places the song lands: drops, and parts that come in much louder than the one before */
function landings(a: TrackAnalysis): { t: number; strength: number }[] {
  const out = (a.dropInfo?.length ? a.dropInfo.map((d) => ({ t: d.t, strength: d.strength })) : a.drops.map((t) => ({ t, strength: 1 }))).filter((d) => d.strength >= 0.3);
  a.sections.forEach((s, i) => {
    const prev = a.sections[i - 1];
    if (!prev) return;
    const jump = s.energy - prev.energy;
    if ((jump > 0.25 || (s.label === 'chorus' && jump > 0.12)) && !out.some((d) => Math.abs(d.t - s.start) < 1.5)) out.push({ t: s.start, strength: clamp01(0.3 + jump) });
  });
  return out.sort((x, y) => x.t - y.t);
}

/** where the song winds up: from the build before a landing (or its last bars), never across the landing before */
function windUps(a: TrackAnalysis): WindUp[] {
  const beat = 60 / Math.max(50, Math.min(200, a.bpm || 120));
  const out: WindUp[] = [];
  let before = 0;
  for (const l of landings(a)) {
    const sec = [...a.sections].reverse().find((s) => s.start < l.t - 0.5);
    const build = sec && (sec.label === 'build' || sec.label === 'break') ? sec.start : l.t - beat * 16;
    const from = Math.max(before + beat * 4, l.t - beat * 32, Math.min(build, l.t - beat * 8), sec ? Math.min(sec.start, l.t - beat * 8) : 0, 0);
    if (l.t - from > beat * 3) out.push({ from, to: l.t, strength: l.strength });
    before = l.t;
  }
  return out;
}

function feltLines(f: SongFeeling, lyr: Lyrics | null): FeltLine[] {
  if (!lyr?.synced) return [];
  return lyr.lines.flatMap((l: LyricLine) => {
    const n = f.lines[lineKey(l.text)];
    if (!n || !EMOTION_IDS[n[0]]) return [];
    const words = l.text.split(/\s+/).filter(Boolean);
    const k = n[3] >= 0 && n[3] < words.length ? n[3] : -1;
    // the timed word, when the line has one for every word; else its share of the line
    const at = k < 0 ? l.t : l.words?.length === words.length ? l.words[k].t : l.t + ((l.end - l.t) * k) / Math.max(1, words.length);
    return [{ t: l.t, end: l.end, emotion: EMOTION_IDS[n[0]], tone: n[1], weight: n[2], turn: n[4] === 1, word: k < 0 ? '' : words[k].replace(/[^\p{L}\p{N}'’-]/gu, ''), at }];
  });
}

/** the few words worth waiting for: the heaviest first, never two close together */
function heldWords(lines: FeltLine[]): FeltLine[] {
  const out: FeltLine[] = [];
  for (const l of [...lines].filter((x) => x.weight >= 0.65).sort((x, y) => y.weight - x.weight || x.t - y.t)) if (l.word && !out.some((x) => Math.abs(x.at - l.at) < 6)) out.push(l);
  return out.sort((x, y) => x.t - y.t);
}

let ids = 0;
const made = new WeakMap<TrackAnalysis, WeakMap<SongFeeling, { lyr: Lyrics | null; c: Curves }>>();

/** `a`: the song's own sections (planCache.originalOf) */
export function curvesOf(a: TrackAnalysis, f: SongFeeling, lyr: Lyrics | null): Curves {
  let mine = made.get(a);
  if (!mine) made.set(a, (mine = new WeakMap()));
  const had = mine.get(f);
  if (had && had.lyr === lyr) return had.c;
  const lines = feltLines(f, lyr);
  const winds = windUps(a);
  const held = heldWords(lines);
  const n = Math.max(2, Math.ceil(a.duration * HZ) + 1);
  const raw = new Float32Array(n);
  const at = (c: ArrayLike<number> | undefined, t: number) => (c?.length && a.duration ? c[Math.max(0, Math.min(c.length - 1, Math.floor((t / a.duration) * c.length)))] : 0);
  const mean = (c: ArrayLike<number>) => Array.from(c).reduce((s, x) => s + x, 0) / Math.max(1, c.length);
  const high = a.highCurve?.length ? mean(a.highCurve) : 0;
  let si = 0;
  let li = 0;
  for (let i = 0; i < n; i++) {
    const t = i / HZ;
    while (si < a.sections.length - 1 && t >= a.sections[si].end) si++;
    const key = a.harmony?.sections[si]?.key ?? a.harmony?.key;
    const mode = key ? (key.minor ? -1 : 1) * key.confidence : ((a.mood?.valence ?? 0.5) - 0.5) * 0.6;
    const sound = clamp01(0.5 + 0.2 * mode + 0.16 * ((a.mood?.brightness ?? 0.5) - 0.5) + 0.2 * (at(a.highCurve, t) - high) - 0.16 * (a.harmony ? at(a.harmony.tension, t) - 0.35 : 0));
    // the line being sung, or the last one while it still hangs in the air
    while (li < lines.length - 1 && t >= lines[li + 1].t - 0.3) li++;
    const l = lines[li];
    const sung = !l || t < l.t - 0.3 ? 0 : t <= l.end ? 1 : Math.exp(-(t - l.end) / 5);
    raw[i] = l ? sound + ((l.tone + 1) / 2 - sound) * 0.75 * sung * (0.5 + 0.5 * l.weight) : sound;
  }
  // eased over about a second and a half either way
  const tone = raw.map((_, i) => {
    let s = 0;
    let w = 0;
    for (let k = -6; k <= 6; k++) {
      const v = raw[i + k];
      if (v === undefined) continue;
      const g = Math.exp(-(k * k) / 14);
      s += v * g;
      w += g;
    }
    return s / w;
  });
  const c: Curves = {
    id: ++ids,
    lines,
    winds,
    held,
    about: f.about,
    by: f.by,
    tone: (t) => {
      const x = Math.max(0, Math.min(n - 1.001, t * HZ));
      const i = Math.floor(x);
      return tone[i] + (tone[i + 1] - tone[i]) * (x - i);
    },
    wind: (t) => {
      const w = winds.find((x) => t >= x.from && t < x.to);
      return w ? Math.pow((t - w.from) / (w.to - w.from), 1.6) * (0.4 + 0.6 * w.strength) : 0;
    },
    hold: (t) => {
      let best = 0;
      for (const h of held) {
        const d = t - h.at;
        if (d < -0.5 || d > 4) continue;
        best = Math.max(best, h.weight * (d < 0 ? smooth(1 + d / 0.5) : Math.exp(-Math.max(0, d - 0.25) / 0.8)));
      }
      return best;
    },
  };
  mine.set(f, { lyr, c });
  return c;
}

/* ───────── what it does to a shot ───────── */

const SOFT: Partial<Record<MomentId, number>> = { ache: 1, hush: 0.6, held: 0.4, float: 0.8, drift: 0.8, glow: 0.7, reveal: 0.7, aftermath: 0.8, release: 0.25 };

/** how much faster or slower than its moment's own curve the picture runs */
export function bend(c: Curves, t: number, m: MomentId): number {
  let k = 1 - 0.6 * (SOFT[m] ?? 0) * c.hold(t);
  const w = c.wind(t);
  // the whole build speeds up as one, across however many shots it is cut into; a held breath runs down instead
  if (w > 0) k *= m === 'lift' || m === 'rush' || m === 'drift' ? 1 + 0.75 * w : m === 'held' || m === 'hush' || m === 'ache' || m === 'float' ? 1 - 0.5 * w : 1;
  return k;
}

/** how much further in the camera leans: through a wind-up (let go when it lands), and towards a word that matters */
export const lean = (c: Curves, t: number, m: MomentId): number => 0.11 * c.wind(t) + 0.045 * (SOFT[m] ?? 0.3) * c.hold(t);

/* ───────── what it asks of a section or a part ───────── */

/** the moments each emotion leans towards */
export const EMOTION_LEAN: Record<Emotion, Partial<Record<MomentId, number>>> = {
  sad: { ache: 1, aftermath: 0.4, hush: 0.4 },
  longing: { ache: 0.8, float: 0.6, reveal: 0.3 },
  tender: { glow: 0.7, ache: 0.4, hush: 0.4 },
  hopeful: { lift: 0.7, glow: 0.6, reveal: 0.4 },
  joyful: { release: 0.7, glow: 0.6, rush: 0.4 },
  desire: { glow: 0.7, drift: 0.4, rush: 0.3 },
  defiant: { rush: 0.7, release: 0.6, fury: 0.5 },
  angry: { fury: 1, rush: 0.5 },
  afraid: { held: 0.7, hush: 0.5, fury: 0.3 },
  numb: { float: 0.8, hush: 0.6, aftermath: 0.4 },
  playful: { rush: 0.7, drift: 0.5 },
  calm: { float: 0.6, drift: 0.6, hush: 0.4 },
};

export interface Felt {
  tone: number;
  wind: number;
  /** the strongest line in it, if any */
  line: FeltLine | null;
  lean: Partial<Record<MomentId, number>>;
}

/** a stretch of the song */
export function feltIn(c: Curves, from: number, to: number): Felt {
  const lines = c.lines.filter((l) => l.t >= from - 0.3 && l.t < to - 0.3);
  const out: Partial<Record<MomentId, number>> = {};
  const total = lines.reduce((s, l) => s + l.weight, 0);
  for (const l of lines) for (const [m, v] of Object.entries(EMOTION_LEAN[l.emotion]) as [MomentId, number][]) out[m] = (out[m] ?? 0) + (v * l.weight) / total;
  let tone = 0;
  const steps = 8;
  for (let i = 0; i < steps; i++) tone += c.tone(from + ((to - from) * (i + 0.5)) / steps) / steps;
  return { tone, wind: c.wind(to - 0.05), line: [...lines].sort((x, y) => y.weight - x.weight)[0] ?? null, lean: total > 0 ? out : {} };
}

/** a stretch in a few words, for Claude */
export function feltLine(c: Curves, from: number, to: number): string {
  const f = feltIn(c, from, to);
  const bits: string[] = [];
  const names = [...new Set(c.lines.filter((l) => l.t >= from - 0.3 && l.t < to - 0.3 && l.weight >= 0.4).sort((x, y) => y.weight - x.weight).map((l) => l.emotion))].slice(0, 2);
  if (names.length) bits.push(`feels ${names.join(' then ')}`);
  else bits.push(f.tone < 0.38 ? 'sounds dark' : f.tone > 0.62 ? 'sounds bright' : 'neither dark nor bright');
  if (f.line && f.line.weight >= 0.65) bits.push(`a line that matters${f.line.word ? `, on the word "${f.line.word}" ${Math.max(0, f.line.at - from).toFixed(1)}s in` : ''}`);
  if (c.lines.some((l) => l.turn && l.t >= from - 0.3 && l.t < to - 0.3)) bits.push('the song turns here');
  const w = c.winds.find((x) => to > x.from + 0.5 && from < x.to - 0.2);
  if (w) bits.push(to >= w.to - 0.3 ? 'winds up to its end' : `winding up, lands ${(w.to - to).toFixed(1)}s after it ends`);
  return bits.join('; ');
}
