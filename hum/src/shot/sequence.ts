/**
 * How a stretch of the song is cut into shots, and how fast each shot's footage runs.
 *
 *   partSequence()          one part (section) of the song, for the footage looks in the app: cut on
 *                           the beat grid, landing on a hit when the song does, speeding up into its
 *                           cuts when loud, every footage shot drawn in one style (src/shot/styles)
 *   sequenceFromAnalysis()  a short run round the song's biggest drop, for the dev page (src/dev/shot.ts):
 *       beats  -12 … -2   footage, speeding up into the cut          (the wait)
 *               -2 …  0   a card: the phrase in type on ink          (the held breath)
 *                0 …  8   footage on the hit                         (the drop)
 *                8 … 14   one of Hum's looks, full frame             (the cutaway)
 *               14 … 24   footage again on a second hit, settling    (the ride out)
 *   planFootage()           every footage shot's speed curve and its stretch of a clip
 *
 * All of it is a pure function of song time.
 */
import type { TrackAnalysis } from '../core/types';
import type { Colour } from './kit';
import { bend, type Curves } from '../feeling';
import { RECIPES, type MomentId } from '../moments';
import { isMotion, type MotionId } from './motion';
import { styleForPart, type StyleId } from './styles';
import { treatmentForShot, type TreatmentId } from './treatments';
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
  /** 'hit': lands with a flash and a few frozen frames. 'cold': just starts. */
  arrive: 'hit' | 'cold';
  /** 'ramp': speeds up into the cut. 'settle': slows to a stop. 'cut': just ends. */
  leave: 'ramp' | 'settle' | 'cut';
  /** beats spent speeding up when it leaves on a ramp */
  rampBeats: number;
  /** footage only: how strongly the clip is printed in the shot's colours */
  colour: Colour;
  /** footage only: the style its graphics are drawn in ('' for none) */
  style: StyleId | '';
  /** a whole number for this shot's arrangement within its style (from the seed) */
  layout: number;
  word: string;
  /**
   * Set when the shot's stretch of its clip was decided across the whole song (src/shot/run.ts): the
   * second of the clip it starts on, and how fast the clip runs against the speed curve (1, or slower
   * when the clip is too short for the shot). Unset: planFootage shares each clip out within the run.
   */
  clipFrom?: number;
  clipRate?: number;
  /** a second clip shown in some of the style's regions (Split), by footage index, and where it starts */
  alt?: number;
  altFrom?: number;
  /** the second clip is the shot's own clip opened a second time (there is only one clip) */
  altEcho?: boolean;
  /** how the picture itself is broken down (src/shot/treatments); missing: none */
  treatment?: TreatmentId;
  /** Collage and Trace: the other pictures it lays out, by footage index */
  extra?: number[];
  /** what a video clip does in time (motion.ts); missing: plays */
  motion?: MotionId;
  /** what the shot is meant to feel like (src/moments): its speed and camera; missing: as ever */
  moment?: MomentId;
  /** Inside: the words that stand in the picture when nothing is sung */
  say?: string;
  /** something in the clip lands on the song here (src/timing): the song second, the clip second, and what the speed does round it */
  hit?: { at: number; clip: number; ramp: RampId };
}

/**
 * What the speed does round something that lands:
 *   land    rushes up to it, all but stops on it, and lets go again
 *   sink    eases down into it and hangs there
 *   burst   hangs back, and bursts off it
 *   ride    nothing: the shot runs as its moment says, and it lands all the same
 */
export type RampId = 'land' | 'sink' | 'burst' | 'ride';
export const RAMP_IDS: readonly RampId[] = ['land', 'sink', 'burst', 'ride'];
export const isRamp = (v: unknown): v is RampId => RAMP_IDS.includes(v as RampId);

export interface Sequence {
  start: number;
  hit: number;
  end: number;
  beat: number;
  kicks: number[];
  snares: number[];
  /** hi-hat hits (the beat's eighths when the song has none) */
  hats?: number[];
  shots: Shot[];
  /** the part's name for small type (e.g. CHORUS), its start, and how loud it is */
  part: string;
  partStart: number;
  energy: number;
  /** the words the shots set, in order */
  words: string[];
  /** what the song feels like as it goes (src/feeling): bends the moments' speeds and cameras */
  feel?: Curves;
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

/** a shot's arrangement number: the same seed, part and shot always give the same one */
export function layoutOf(seed: number, part: number, shot: number): number {
  let h = (Math.floor(seed) * 374761393 + part * 668265263 + shot * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) & 0x7fffffff;
}

const blank = (kind: ShotKind, start: number, end: number, rest: Partial<Shot>): Shot => ({ index: 0, kind, start, end, footageIndex: -1, arrive: 'cold', leave: 'cut', rampBeats: RAMP, colour: 'clean', style: '', layout: 0, word: '', ...rest });

/** `phrase` is the words to set in type: the card shows all of it, the shots one word each */
export function sequenceFromAnalysis(a: TrackAnalysis, phrase: string, at?: number, o: { style?: string; seed?: number; colour?: Colour; treatment?: string; motion?: string } = {}): Sequence {
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
  const seed = o.seed ?? 1;
  const colour = o.colour ?? 'tinted';
  // with Auto, each footage shot plays the style a part of its kind would get
  const pick = (label: 'build' | 'drop' | 'chorus', energy: number, i: number) => styleForPart([{ start: 0, end: 1, energy, label, group: i }], 0, o.style ?? 'auto', seed + i);
  const shots = [
    blank('footage', start, hit - 2 * beat, { leave: 'ramp', colour, style: pick('build', 0.5, 0), layout: layoutOf(seed, 0, 0) }),
    blank('card', hit - 2 * beat, hit, { word: phrase.trim() }),
    blank('footage', hit, at8, { arrive: 'hit', colour, style: pick('drop', 0.9, 1), layout: layoutOf(seed, 0, 2), word: first }),
    blank('look', at8, at14, {}),
    blank('footage', at14, end, { arrive: 'hit', leave: 'settle', colour, style: pick('chorus', 0.7, 2), layout: layoutOf(seed, 0, 4), word: last }),
  ];
  let n = 0;
  const labels = ['build', 'drop', 'chorus'] as const;
  shots.forEach((s, i) => {
    s.index = i;
    if (s.kind !== 'footage') return;
    const k = n++;
    s.footageIndex = k;
    s.treatment = treatmentForShot({ start: 0, end: 1, energy: [0.5, 0.9, 0.7][k] ?? 0.7, label: labels[k] ?? 'chorus', group: k }, 0, o.treatment ?? 'none', seed, '', 3);
    s.extra = [k + 1, k + 2, k + 3, k + 4, k + 5];
    if (isMotion(o.motion)) s.motion = o.motion;
  });
  return { start, hit, end, beat, kicks, snares, hats: hatsIn(a, start, end, beat), shots, part: 'DROP', partStart: start, energy: 0.8, words };
}

/* ───────── one part of a song, in the app ───────── */

export interface PartOptions {
  /** a style id, or 'auto' to pick one for the part */
  style: string;
  /** the arrangement: the same style laid out differently for every seed */
  seed: number;
  /** how strongly the footage is printed in the shot's colours */
  colour: Colour;
  /** beats per shot */
  shotBeats: number;
  /** words to set in type, dealt to the shots in turn (none: the part's name stands in) */
  words: string[];
  /** hold a card of type for the two beats before a hit */
  card: boolean;
  /** a treatment id, 'auto', or missing for none */
  treatment?: string;
  /** how many pictures there are to cut between (Auto only picks Collage with several) */
  pictures?: number;
  /** what a video clip does in time (motion.ts), 'play' or missing for plain playing */
  motion?: string;
  /** the pictures this part uses, as places in the deck, in order (missing: dealt round the deck) */
  media?: number[];
}

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
  const style = styleForPart(a.sections, index, o.style, o.seed);
  // the calm style keeps its long shots even when the part is loud
  const loud = sec.energy > 0.55 && style !== 'caption';

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

  const shots: Shot[] = [];
  const mine = o.media ?? [];
  const motion = isMotion(o.motion) ? o.motion : undefined;
  for (let j = 0; j < cuts.length - 1; j++) {
    const last = j === cuts.length - 2;
    const leave: Shot['leave'] = last ? (hitOut ? 'ramp' : !next ? 'settle' : 'cut') : loud ? 'ramp' : 'cut';
    const beats = (cuts[j + 1] - cuts[j]) / beat;
    // parts start on different pictures, and every cut moves on to the next one; a part with its
    // own pictures takes them in turn from its first
    const pic = mine.length ? mine[j % mine.length] : index + j;
    // a part given its pictures keeps to them (one picture: Trace shows close-ups of it)
    const others = mine.length ? [...mine.slice(j % mine.length + 1), ...mine.slice(0, j % mine.length)] : [1, 2, 3, 4, 5].map((k) => pic + k);
    shots.push({
      index: shots.length,
      kind: 'footage',
      start: cuts[j],
      end: cuts[j + 1],
      footageIndex: pic,
      arrive: j === 0 ? (hitIn ? 'hit' : 'cold') : loud ? 'hit' : 'cold',
      leave,
      rampBeats: Math.min(RAMP, Math.max(1, beats / 2)),
      colour: o.colour,
      style,
      layout: layoutOf(o.seed, index, j),
      word: o.words.length ? o.words[(index + j) % o.words.length] : '',
      treatment: treatmentForShot(sec, j, o.treatment ?? 'none', o.seed, '', mine.length || (o.pictures ?? 1), mine.length > 1),
      extra: others,
      motion,
    });
  }
  if (cardFrom < end) shots.push(blank('card', cardFrom, end, { index: shots.length, word: o.words.slice(0, 4).join(' ') }));
  return {
    start,
    // the moment the part lands (it gets the full white-out); a part that doesn't land has none, and
    // the cuts on the beat inside it only glint
    hit: hitIn ? start : -1,
    end,
    beat,
    kicks,
    snares,
    hats: hatsIn(a, start, end, beat),
    shots,
    part: sec.label.toUpperCase(),
    partStart: start,
    energy: sec.energy,
    words: o.words,
  };
}

/** hi-hat hits in a stretch of the song, or the beat's eighths when it has none */
export function hatsIn(a: TrackAnalysis, start: number, end: number, beat: number): number[] {
  const hats = inRange(a.layers?.hat, start, end, beat * 0.2);
  if (hats.length >= 4) return hats;
  return Array.from({ length: Math.max(1, Math.floor((end - start) / (beat / 2))) }, (_, i) => start + (i * beat) / 2);
}

export const shotAt = (seq: Sequence, t: number): Shot => seq.shots.find((s) => t < s.end) ?? seq.shots[seq.shots.length - 1];

/* ───────── speed ───────── */

const HOLD = 0.3;
const PEAK = 3.4;
const STEP = 1 / 240;

export interface ShotCurve {
  /** how fast the picture runs at song time t (1 = real time) */
  speed(t: number): number;
  /** the rate to play the clip at (speed, slowed if the clip is short) */
  rate(t: number): number;
  /** which second of the clip is on screen */
  footage(t: number): number;
  /** frames held still on arrival (s); 0 for a shot that starts cold */
  freeze: number;
  /** the clip is shown mirrored (it was needed twice and is too short to cut somewhere new) */
  flip: boolean;
  /** which second of the second clip is on screen (a shot with one; otherwise the same as footage) */
  alt(t: number): number;
}

/** the speed `s` a shot would run at, bent by what lands at `h.at` */
function ramped(s: number, t: number, h: NonNullable<Shot['hit']>, beat: number): number {
  const d = (t - h.at) / beat;
  if (h.ramp === 'ride' || d < -4 || d > 6) return s;
  if (h.ramp === 'land') {
    if (d < 0) return s + (Math.max(2.3, Math.min(3.4, s * 1.9)) - s) * easeInCubic(clamp01(1 + d / 2));
    return Math.max(0.1, s * (0.16 + 0.84 * smooth(0.9, 2.6, d)));
  }
  if (h.ramp === 'sink') {
    const down = d < 0 ? smooth(-2, 0, d) : d < 0.5 ? 1 : Math.exp(-(d - 0.5) / 1.6);
    return s - (s - Math.min(s, Math.max(0.14, s * 0.3))) * down;
  }
  if (d < 0) return s - (s - Math.min(s, Math.max(0.12, s * 0.28))) * smooth(-2.4, -0.6, d);
  return s + 2.3 * Math.exp(-d / 1.5);
}

function speedOf(shot: Shot, seq: Sequence, freeze: number) {
  const s = plainSpeedOf(shot, seq, freeze);
  const h = shot.hit;
  if (!h) return s;
  return (t: number): number => (shot.arrive === 'hit' && t < shot.start + freeze ? 0 : ramped(s(t), t, h, seq.beat));
}

function plainSpeedOf(shot: Shot, seq: Sequence, freeze: number) {
  const { beat, kicks } = seq;
  return (t: number): number => {
    if (shot.kind !== 'footage') return 0.5;
    const tau = t - shot.start - freeze;
    if (shot.arrive === 'hit' && tau < 0) return 0;
    const m = shot.moment ? RECIPES[shot.moment] : null;
    if (m) {
      const run = Math.max(1e-3, shot.end - shot.start - freeze);
      let s = m.speed({ u: clamp01(tau / run), tau: Math.max(0, tau), left: shot.end - t, beat });
      if (seq.feel) s *= bend(seq.feel, t, shot.moment!);
      // a held breath stays held: the kick and the burst are the moment's own, and may be nothing
      s += m.kick * Math.exp(-since(kicks, t) / (beat * 0.22));
      if (shot.arrive === 'hit') s += m.burst * Math.exp(-tau / (beat * 3));
      if (shot.leave === 'ramp') s += (m.peak - s) * easeInCubic(clamp01((t - (shot.end - shot.rampBeats * beat)) / (shot.rampBeats * beat)));
      if (shot.leave === 'settle') s *= 1 - 0.75 * smooth(shot.end - beat * 3, shot.end, t);
      return s;
    }
    let v = HOLD;
    if (shot.arrive === 'hit') {
      // the burst off the hit, and a small push on every kick
      v = 1 + 2.4 * Math.exp(-tau / (beat * 3)) + 0.45 * Math.exp(-since(kicks, t) / (beat * 0.22));
    }
    if (shot.leave === 'ramp') v += (PEAK - v) * easeInCubic(clamp01((t - (shot.end - shot.rampBeats * beat)) / (shot.rampBeats * beat)));
    if (shot.leave === 'settle') v *= 1 - 0.75 * smooth(shot.end - beat * 3, shot.end, t);
    return v;
  };
}

/** a shot's speed curve, summed: sum[i] is the clip seconds used in the shot's first i steps */
interface Table {
  shot: Shot;
  freeze: number;
  speed: (t: number) => number;
  sum: Float32Array;
  n: number;
}

function tableOf(shot: Shot, seq: Sequence): Table {
  const freeze = shot.arrive === 'hit' ? Math.min(0.14, seq.beat * 0.3) : 0;
  const speed = speedOf(shot, seq, freeze);
  const n = Math.max(1, Math.ceil((shot.end - shot.start) / STEP));
  const sum = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i] + speed(shot.start + (i + 0.5) * STEP) * STEP;
  return { shot, freeze, speed, sum, n };
}

/** the seconds of clip a shot has played through by song time t, before any slowing for a short clip */
export function footageUpTo(seq: Sequence, shot: Shot, t: number): number {
  const tab = tableOf(shot, seq);
  const x = (Math.min(shot.end, Math.max(shot.start, t)) - shot.start) / STEP;
  const i = Math.min(tab.n - 1, Math.max(0, Math.floor(x)));
  return tab.sum[i] + (tab.sum[i + 1] - tab.sum[i]) * clamp01(x - i);
}

/** the seconds of clip a footage shot plays through (before any slowing for a short clip) */
export function footageNeed(seq: Sequence, shot: Shot): number {
  const tab = tableOf(shot, seq);
  return tab.sum[tab.n];
}

/**
 * Speed curves for every shot, and for the footage shots a stretch of a clip each. `clips` are the
 * clip lengths in seconds (at least one; shots take them in turn). A shot whose stretch was decided
 * across the whole song (clipFrom, see src/shot/run.ts) keeps it. Otherwise two shots on the same clip
 * get separate stretches of it when it is long enough; if not, the clip runs slower and the later
 * shot shows it mirrored.
 */
export function planFootage(seq: Sequence, clips: number[]): ShotCurve[] {
  const tables = seq.shots.map((shot) => tableOf(shot, seq));
  const read = (tab: Table, t: number) => {
    const x = (Math.min(tab.shot.end, Math.max(tab.shot.start, t)) - tab.shot.start) / STEP;
    const i = Math.min(tab.n - 1, Math.max(0, Math.floor(x)));
    return tab.sum[i] + (tab.sum[i + 1] - tab.sum[i]) * clamp01(x - i);
  };

  // which shots share each clip, in order
  const count = Math.max(1, clips.length);
  const users = new Map<number, Table[]>();
  for (const tab of tables) {
    if (tab.shot.kind !== 'footage' || tab.shot.clipFrom !== undefined) continue;
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
    const { shot } = tab;
    const p = shot.clipFrom !== undefined ? { from: shot.clipFrom, k: shot.clipRate ?? 1, flip: false } : (place.get(shot) ?? { from: 0, k: 1, flip: false });
    const altFrom = shot.altFrom ?? p.from;
    return {
      speed: tab.speed,
      rate: (t) => tab.speed(t) * p.k,
      footage: (t) => p.from + read(tab, t) * p.k,
      alt: (t) => altFrom + read(tab, t) * p.k,
      freeze: tab.freeze,
      flip: p.flip,
    };
  });
}
