/**
 * A short run of shots round one hit (prototype, see src/dev/shot.ts).
 *
 *   beats  -12 … -2   footage, clean and slow, speeding up into the cut          (the wait)
 *           -2 …  0   a card: the phrase in type on a dark field, dead still      (the held breath)
 *            0 …  8   footage on the hit: freeze, burst, bands of flat colour     (the drop)
 *            8 … 14   one of Hum's looks, full frame, in the shot's colours       (the cutaway)
 *           14 … 24   footage again on a second, smaller hit: a look shows through
 *                     its bands and the camera flies through shapes, then settles (the ride out)
 *
 * sequenceFromAnalysis() lays that out on the song; planFootage() gives every footage shot its speed
 * curve and its stretch of a clip. All of it is a pure function of song time.
 */
import type { TrackAnalysis } from '../core/types';
import { clamp01, easeInCubic, feltBeat, scoreFromAnalysis, since, smooth } from './time';

export type ShotKind = 'footage' | 'look' | 'card';

export interface Shot {
  index: number;
  kind: ShotKind;
  /** song time (s) */
  start: number;
  end: number;
  /** footage shots count up from 0; the stage deals clips to them in turn */
  footageIndex: number;
  /** 'hit': lands with a flash, a few frozen frames and a burst. 'cold': just starts. */
  arrive: 'hit' | 'cold';
  /** 'ramp': speeds up into the cut. 'settle': slows to a stop. 'cut': just ends. */
  leave: 'ramp' | 'settle' | 'cut';
  /** beats spent speeding up when it leaves on a ramp */
  rampBeats: number;
  /** footage only. clean: untouched. bands: shadows and highlights go flat. look: those bands show a look. */
  treat: 'clean' | 'bands' | 'look';
  /** the motifs drawn over it, by id (see src/shot/motifs) */
  motifs: string[];
  word: string;
}

export interface Sequence {
  start: number;
  hit: number;
  end: number;
  beat: number;
  kicks: number[];
  snares: number[];
  shots: Shot[];
}

/** beats before the hit, and after it */
export const SEQ_LEAD = 12;
export const SEQ_TAIL = 24;
const RAMP = 4;

const inRange = (times: number[] | undefined, from: number, to: number, gap: number) => {
  const out: number[] = [];
  for (const t of times ?? []) {
    if (t < from - 0.02 || t > to) continue;
    if (out.length && t - out[out.length - 1] < gap) continue;
    out.push(t);
  }
  return out;
};

/** `phrase` is the words to set in type: the card shows all of it, the shots one word each */
export function sequenceFromAnalysis(a: TrackAnalysis, phrase: string, at?: number): Sequence {
  const base = scoreFromAnalysis(a, at);
  const beat = base.beat;
  const lead = SEQ_LEAD * beat;
  const tail = SEQ_TAIL * beat;
  const hit = Math.min(Math.max(base.hit, lead), Math.max(lead, a.duration - tail));
  const start = hit - lead;
  const end = Math.min(a.duration, hit + tail);
  const at8 = hit + 8 * beat;
  const at14 = Math.min(end - 4 * beat, hit + 14 * beat);

  let kicks = inRange(a.layers?.kick, start, end, beat * 0.45);
  if (kicks.filter((k) => k >= hit).length < 6) kicks = Array.from({ length: Math.floor((end - start) / beat) }, (_, i) => start + i * beat);
  let snares = inRange(a.layers?.snare, start, end, beat * 0.45);
  if (snares.filter((s) => s >= hit).length < 3) snares = Array.from({ length: Math.floor((end - hit) / (beat * 2)) }, (_, i) => hit + beat + i * beat * 2);

  const words = phrase.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? '';
  const last = words[words.length - 1] ?? first;
  const shot = (kind: ShotKind, s: number, e: number, rest: Partial<Shot>): Shot => ({ index: 0, kind, start: s, end: e, footageIndex: -1, arrive: 'cold', leave: 'cut', rampBeats: RAMP, treat: 'clean', motifs: [], word: '', ...rest });
  const shots = [
    shot('footage', start, hit - 2 * beat, { leave: 'ramp', motifs: ['threads', 'guides', 'ruler'] }),
    shot('card', hit - 2 * beat, hit, { motifs: ['cardType'], word: phrase.trim() }),
    shot('footage', hit, at8, { arrive: 'hit', treat: 'bands', motifs: ['bars', 'arcs', 'burst', 'word', 'ruler'], word: first }),
    shot('look', at8, at14, { motifs: ['ruler'] }),
    shot('footage', at14, end, { arrive: 'hit', leave: 'settle', treat: 'look', motifs: ['floor', 'ribbons', 'blocks', 'typeStack', 'ruler'], word: last }),
  ];
  let n = 0;
  shots.forEach((s, i) => {
    s.index = i;
    if (s.kind === 'footage') s.footageIndex = n++;
  });
  return { start, hit, end, beat, kicks, snares, shots };
}

/* ───────── one part of a song, in the app ───────── */

export interface PartOptions {
  /** how the footage is treated, and which family of motifs sits on it */
  treat: 'clean' | 'bands' | 'look';
  kit: 'quiet' | 'graphic' | 'depth';
  /** beats per shot */
  shotBeats: number;
  /** words to set in type, dealt to the shots in turn (none: no type) */
  words: string[];
  /** hold a card of type for the two beats before a hit */
  card: boolean;
}

const KITS: Record<PartOptions['kit'], string[][]> = {
  quiet: [['threads']],
  graphic: [
    ['bars', 'arcs', 'burst', 'word'],
    ['threads', 'bars', 'burst', 'word'],
  ],
  depth: [
    ['floor', 'ribbons', 'blocks', 'typeStack'],
    ['threads', 'ribbons', 'blocks'],
    ['floor', 'bars', 'typeStack'],
  ],
};

/**
 * The run of shots for one part (section) of the song, for the footage looks in the app: the part is
 * cut into shots on the beat grid; it lands with a hit when the song does (a drop, or a jump in
 * energy), its shots speed up into the next cut when the part is loud, and it ramps into the next
 * part when that one lands with a hit. The last part of the song settles to a stop.
 */
export function partSequence(a: TrackAnalysis, index: number, o: PartOptions): Sequence {
  const beat = feltBeat(a.bpm);
  const sec = a.sections[Math.min(Math.max(0, index), a.sections.length - 1)];
  const prev = a.sections[index - 1];
  const next = a.sections[index + 1];
  const { start, end } = sec;
  const dropNear = (t: number) => (a.dropInfo?.length ? a.dropInfo.some((d) => Math.abs(d.t - t) < 0.4 && d.strength >= 0.3) : a.drops.some((d) => Math.abs(d - t) < 0.4));
  const lands = (s: typeof sec, before: typeof sec | undefined) => dropNear(s.start) || s.label === 'drop' || (!!before && s.energy - before.energy > 0.25);
  const hitIn = lands(sec, prev);
  const hitOut = !!next && lands(next, sec);
  const loud = sec.energy > 0.55 && o.treat !== 'clean';

  let kicks = inRange(a.layers?.kick, start, end, beat * 0.45);
  if (kicks.length < 4) kicks = Array.from({ length: Math.floor((end - start) / beat) }, (_, i) => start + i * beat);
  let snares = inRange(a.layers?.snare, start, end, beat * 0.45);
  if (snares.length < 2) snares = Array.from({ length: Math.floor((end - start) / (beat * 2)) }, (_, i) => start + beat + i * beat * 2);

  // a card of type holds the last two beats before a hit, when there are words and room for it
  const cardFrom = o.card && hitOut && o.words.length && end - start > beat * 6 ? end - beat * 2 : end;
  // cuts on the grid; a short leftover joins the shot before it
  const len = Math.max(2, o.shotBeats) * beat;
  const cuts = [start];
  for (let t = start + len; t < cardFrom - len * 0.5; t += len) cuts.push(t);
  cuts.push(cardFrom);

  const kits = KITS[o.kit];
  const shots: Shot[] = [];
  for (let j = 0; j < cuts.length - 1; j++) {
    const last = j === cuts.length - 2;
    const leave: Shot['leave'] = last ? (hitOut ? 'ramp' : !next ? 'settle' : 'cut') : loud ? 'ramp' : 'cut';
    const beats = (cuts[j + 1] - cuts[j]) / beat;
    const motifs = [...kits[(index + j) % kits.length]];
    // the ring that closes in belongs to a shot that speeds up into its cut
    if (o.kit === 'quiet' && leave === 'ramp') motifs.push('guides');
    shots.push({
      index: shots.length,
      kind: 'footage',
      start: cuts[j],
      end: cuts[j + 1],
      // parts start on different clips, and every cut moves on to the next one
      footageIndex: index + j,
      arrive: j === 0 ? (hitIn ? 'hit' : 'cold') : loud ? 'hit' : 'cold',
      leave,
      rampBeats: Math.min(RAMP, Math.max(1, beats / 2)),
      treat: o.treat,
      motifs,
      word: o.words.length ? o.words[(index + j) % o.words.length] : '',
    });
  }
  if (cardFrom < end) shots.push({ index: shots.length, kind: 'card', start: cardFrom, end, footageIndex: -1, arrive: 'cold', leave: 'cut', rampBeats: RAMP, treat: 'clean', motifs: ['cardType'], word: o.words.slice(0, 4).join(' ') });
  return { start, hit: hitIn ? start : (shots.find((s) => s.arrive === 'hit')?.start ?? start), end, beat, kicks, snares, shots };
}

export const shotAt = (seq: Sequence, t: number): Shot => seq.shots.find((s) => t < s.end) ?? seq.shots[seq.shots.length - 1];

/* ───────── speed ───────── */

const HOLD = 0.3;
const PEAK = 3.4;
const STEP = 1 / 240;
/** world units the shapes slide toward the camera for every second of footage run */
const TRAVEL = 1.15;

export interface ShotCurve {
  /** how fast the picture runs at song time t (1 = real time) */
  speed(t: number): number;
  /** the rate to play the clip at (speed, slowed if the clip is short) */
  rate(t: number): number;
  /** which second of the clip is on screen */
  footage(t: number): number;
  /** how far the 3D space has slid toward the camera since the shot began */
  travel(t: number): number;
  /** the same at the shot's end */
  depth: number;
  /** frames held still on arrival (s); 0 for a shot that starts cold */
  freeze: number;
  /** the clip is shown mirrored (it was needed twice and is too short to cut somewhere new) */
  flip: boolean;
}

function speedOf(shot: Shot, seq: Sequence, freeze: number) {
  const { beat, kicks } = seq;
  return (t: number): number => {
    if (shot.kind !== 'footage') return 0.5;
    const tau = t - shot.start - freeze;
    let v = HOLD;
    if (shot.arrive === 'hit') {
      if (tau < 0) return 0;
      // the burst off the hit, and a small push on every kick
      v = 1 + 2.4 * Math.exp(-tau / (beat * 3)) + 0.45 * Math.exp(-since(kicks, t) / (beat * 0.22));
    }
    if (shot.leave === 'ramp') v += (PEAK - v) * easeInCubic(clamp01((t - (shot.end - shot.rampBeats * beat)) / (shot.rampBeats * beat)));
    if (shot.leave === 'settle') v *= 1 - 0.75 * smooth(shot.end - beat * 3, shot.end, t);
    return v;
  };
}

/**
 * Speed curves for every shot, and for the footage shots a stretch of a clip each. `clips` are the
 * clip lengths in seconds (at least one; shots take them in turn). Two shots on the same clip get
 * separate stretches of it when it is long enough; otherwise the clip runs slower and the later shot
 * shows it mirrored.
 */
export function planFootage(seq: Sequence, clips: number[]): ShotCurve[] {
  const tables = seq.shots.map((shot) => {
    const freeze = shot.arrive === 'hit' ? Math.min(0.14, seq.beat * 0.3) : 0;
    const speed = speedOf(shot, seq, freeze);
    const n = Math.max(1, Math.ceil((shot.end - shot.start) / STEP));
    const sum = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) sum[i + 1] = sum[i] + speed(shot.start + (i + 0.5) * STEP) * STEP;
    return { shot, freeze, speed, sum, n };
  });
  const read = (tab: (typeof tables)[number], t: number) => {
    const x = (Math.min(tab.shot.end, Math.max(tab.shot.start, t)) - tab.shot.start) / STEP;
    const i = Math.min(tab.n - 1, Math.max(0, Math.floor(x)));
    return tab.sum[i] + (tab.sum[i + 1] - tab.sum[i]) * clamp01(x - i);
  };

  // which shots share each clip, in order
  const count = Math.max(1, clips.length);
  const users = new Map<number, (typeof tables)[number][]>();
  for (const tab of tables) {
    if (tab.shot.kind !== 'footage') continue;
    const c = tab.shot.footageIndex % count;
    users.set(c, [...(users.get(c) ?? []), tab]);
  }
  const place = new Map<Shot, { from: number; k: number; flip: boolean }>();
  for (const [c, list] of users) {
    const usable = Math.max(0.5, (clips[c] ?? 1e6) - 0.25);
    const need = list.reduce((s, tab) => s + tab.sum[tab.n], 0);
    const k = Math.min(1, usable / need);
    const spare = usable - need * k;
    const gap = list.length > 1 ? Math.min(spare / (list.length - 1), Math.max(1, usable * 0.2)) : 0;
    let cursor = 0.05;
    list.forEach((tab, i) => {
      place.set(tab.shot, { from: cursor, k, flip: i % 2 === 1 && gap < 0.75 });
      cursor += tab.sum[tab.n] * k + gap;
    });
  }

  return tables.map((tab) => {
    const p = place.get(tab.shot) ?? { from: 0, k: 1, flip: false };
    return {
      speed: tab.speed,
      rate: (t) => tab.speed(t) * p.k,
      footage: (t) => p.from + read(tab, t) * p.k,
      travel: (t) => read(tab, t) * TRAVEL,
      depth: tab.sum[tab.n] * TRAVEL,
      freeze: tab.freeze,
      flip: p.flip,
    };
  });
}
