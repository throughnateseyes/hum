/**
 * Footage across a whole video whose parts are single shots.
 *
 * When a video plan plays, every shot the planner cut is a part of its own (state/flatPlan.ts), so a
 * footage part IS one shot: the timeline's cut is the cut. This file decides, for every footage part
 * of the song at once, what it shows:
 *
 *   the clip     every cut moves to the next clip, counted across the song (so the clips rotate
 *                through the video), and a clip used again carries on from where it stopped
 *   the hit      a part that opens a section landing on a drop (or a jump in energy), or that starts
 *                on a drop, arrives with the flash, the frozen frames and the burst
 *   the ramp     a part speeds up into its cut when the part after it lands on a hit
 *   the style    a fixed style as it is; Auto picks from what suits the section the part belongs to
 *                (the section as Hum heard it, before the cut), never the previous footage part's
 *   long parts   a part longer than one and a half times the look's "Beats per shot" (and longer than
 *                8 beats) is still cut inside, into shots of about that many beats, 6 at the least
 *                (with 8 beats per shot: parts over 12 beats; with 4: parts over 8 beats, in shots of 6)
 *
 * Everything is worked out from the song's parts and the looks' settings alone, so it is a pure
 * function of song time: seeking anywhere, or rendering frame by frame, gives the same picture.
 */
import type { TrackAnalysis, TrackSection } from '../core/types';
import type { Colour } from './kit';
import { footageNeed, layoutOf, type Sequence, type Shot } from './sequence';
import { styleForShot, type StyleId } from './styles';
import { feltBeat } from './time';

/** one footage part's settings (its look's, or a per-part choice laid over them) */
export interface RunPart {
  style: string;
  seed: number;
  colour: Colour;
  /** beats per shot: only parts longer than 1.5 times this are cut inside */
  shotBeats: number;
}

export interface RunInput {
  /** the song cut into its parts (one per shot) */
  analysis: TrackAnalysis;
  /** the song's sections as Hum heard them, and for each part the section it lies in */
  sections: TrackSection[];
  parents: number[];
  /** each part's settings, or null when the part is not footage */
  parts: (RunPart | null)[];
  /** clip lengths (s), at least one */
  clips: number[];
  /** words to set in type, dealt to the shots in turn */
  words: string[];
}

export interface Run {
  /** each footage part's run of shots (one, or a few for a long part); null for the other parts */
  seqs: (Sequence | null)[];
}

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

export function footageRun(o: RunInput): Run {
  const a = o.analysis;
  const parts = a.sections;
  const beat = feltBeat(a.bpm);
  const n = parts.length;
  const count = Math.max(1, o.clips.length);
  const dropNear = (t: number) => (a.dropInfo?.length ? a.dropInfo.some((d) => Math.abs(d.t - t) < 0.4 && d.strength >= 0.3) : a.drops.some((d) => Math.abs(d - t) < 0.4));
  const sectionOf = (i: number) => o.sections[o.parents[i]] ?? parts[i];
  const firstOfSection = (i: number) => i === 0 || o.parents[i - 1] !== o.parents[i];
  /** part i lands on a hit: it opens a section that lands, or starts on a drop */
  const lands = (i: number): boolean => {
    if (i < 0 || i >= n) return false;
    if (dropNear(parts[i].start)) return true;
    if (!firstOfSection(i)) return false;
    const sec = sectionOf(i);
    const before = o.parents[i] > 0 ? o.sections[o.parents[i] - 1] : undefined;
    return sec.label === 'drop' || dropNear(sec.start) || (!!before && sec.energy - before.energy > 0.25);
  };

  // where each clip has got to (s): a clip used again carries on from here
  const cursor = o.clips.map(() => 0.05);
  const usableOf = (c: number) => Math.max(0.5, (o.clips[c] ?? 1e6) - 0.25);
  /** take `need` seconds of clip c from where it stopped (round to its start when it runs out) */
  const take = (c: number, need: number): { from: number; k: number } => {
    const usable = usableOf(c);
    if (need >= usable - 0.05) {
      cursor[c] = 0.05;
      return { from: 0.05, k: Math.min(1, (usable - 0.05) / need) };
    }
    if (cursor[c] + need > usable) cursor[c] = 0.05;
    const from = cursor[c];
    cursor[c] += need;
    return { from, k: 1 };
  };

  let ordinal = 0;
  let prevStyle: StyleId | '' = '';
  const seqs: (Sequence | null)[] = parts.map((part, i) => {
    const o2 = o.parts[i];
    if (!o2) return null;
    const sec = sectionOf(i);
    // the shot's place in its section (the first shot of a section is 0)
    let k = 0;
    while (i - k > 0 && o.parents[i - k - 1] === o.parents[i]) k++;
    const style = styleForShot(sec, k, o2.style, o2.seed, prevStyle);
    prevStyle = style;
    const loud = sec.energy > 0.55 && style !== 'caption';
    const hitIn = lands(i);
    const hitOut = lands(i + 1);
    const last = i === n - 1;
    const { start, end } = part;

    // one shot, unless the part is long: over 1.5 shots and over 8 beats, cut into shots of the look's
    // length (6 beats at the least, so a fast look doesn't chop a part into flickers)
    const cuts = [start];
    if (end - start > Math.max(8, o2.shotBeats * 1.5) * beat) {
      const pieces = Math.max(2, Math.round((end - start) / (Math.max(6, o2.shotBeats) * beat)));
      for (let m = 1; m < pieces; m++) {
        const at = start + Math.round(((end - start) * m) / pieces / beat) * beat;
        if (at > cuts[cuts.length - 1] + beat && at < end - beat) cuts.push(at);
      }
    }
    cuts.push(end);

    let kicks = inRange(a.layers?.kick, start, end, beat * 0.45);
    if (kicks.length < 2) kicks = Array.from({ length: Math.max(1, Math.floor((end - start) / beat)) }, (_, j) => start + j * beat);
    let snares = inRange(a.layers?.snare, start, end, beat * 0.45);
    if (snares.length < 1) snares = Array.from({ length: Math.max(1, Math.floor((end - start) / (beat * 2))) }, (_, j) => start + beat + j * beat * 2);

    const seq: Sequence = {
      start,
      hit: hitIn ? start : -1,
      end,
      beat,
      kicks,
      snares,
      shots: [],
      part: sec.label.toUpperCase(),
      // bar numbers and the part's time count from the section's start, so they carry on across its shots
      partStart: sec.start,
      energy: sec.energy,
      words: o.words,
    };
    for (let j = 0; j < cuts.length - 1; j++) {
      const lastShot = j === cuts.length - 2;
      const beats = (cuts[j + 1] - cuts[j]) / beat;
      const shot: Shot = {
        index: j,
        kind: 'footage',
        start: cuts[j],
        end: cuts[j + 1],
        footageIndex: ordinal,
        arrive: j === 0 ? (hitIn ? 'hit' : 'cold') : loud ? 'hit' : 'cold',
        leave: lastShot ? (hitOut ? 'ramp' : last ? 'settle' : 'cut') : loud ? 'ramp' : 'cut',
        rampBeats: Math.min(RAMP, Math.max(1, beats / 2)),
        colour: o2.colour,
        style,
        layout: layoutOf(o2.seed, i, j),
        word: o.words.length ? o.words[ordinal % o.words.length] : '',
      };
      const c = ordinal % count;
      const need = footageNeed(seq, shot);
      const own = take(c, need);
      shot.clipFrom = own.from;
      shot.clipRate = own.k;
      if (style === 'split') {
        // Split shows a second moment: the next clip where it stopped, or, with one clip, this clip further on
        const c2 = count > 1 ? (c + 1) % count : c;
        const alt = take(c2, need);
        shot.alt = count > 1 ? ordinal + 1 : ordinal;
        shot.altFrom = alt.from;
        shot.altEcho = count === 1;
      }
      seq.shots.push(shot);
      ordinal++;
    }
    return seq;
  });
  return { seqs };
}
