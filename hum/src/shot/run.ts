/**
 * Footage across a whole video whose parts are single shots.
 *
 * When a video plan plays, every shot the planner cut is a part of its own (state/flatPlan.ts), so a
 * footage part IS one shot: the timeline's cut is the cut. This file decides, for every footage part
 * of the song at once, what it shows:
 *
 *   the clip     every cut moves to the next picture in the deck (clips and photos in the order they
 *                were added), counted across the song, and a clip used again carries on from where it
 *                stopped; a part with its own media list deals only from that list, first one first
 *   treatment    a fixed treatment as it is; Auto picks one per shot from the section and its energy
 *   the hit      a part that opens a section landing on a drop (or a jump in energy), or that starts
 *                on a drop, arrives with the flash, the frozen frames and the burst
 *   the ramp     a part speeds up into its cut when the part after it lands on a hit
 *   the style    a fixed style as it is; Auto picks from what suits the section the part belongs to
 *                (the section as Hum heard it, before the cut), never the previous footage part's
 *   motion       what a clip does in time (play, stutter, echo, reverse, slices; motion.ts)
 *   long parts   a part longer than one and a half times the look's "Beats per shot" (and longer than
 *                8 beats) is still cut inside, into shots of about that many beats, 6 at the least
 *                (with 8 beats per shot: parts over 12 beats; with 4: parts over 8 beats, in shots of 6)
 *
 * Everything is worked out from the song's parts and the looks' settings alone, so it is a pure
 * function of song time: seeking anywhere, or rendering frame by frame, gives the same picture.
 */
import type { DrawnShot } from '../inside/drawnIds';
import type { ClipAsset, ParamValues, PartShot, PhotoAsset, TrackAnalysis, TrackSection } from '../core/types';
import type { Curves } from '../feeling';
import { num, str } from '../core/uniforms';
import { PRESETS } from '../presets';
import { useStudio } from '../state/store';
import type { Colour } from './kit';
import { isMoment } from '../moments';
import { isMotion } from './motion';
import { footageNeed, footageUpTo, hatsIn, isRamp, layoutOf, type RampId, type Sequence, type Shot } from './sequence';
import { shotOfPart } from './partShots';
import { styleForShot, type StyleId } from './styles';
import { treatmentForShot, type TreatmentId } from './treatments';
import { feltBeat } from './time';

/** one footage part's settings (its look's, or a per-part choice laid over them) */
export interface RunPart {
  style: string;
  seed: number;
  colour: Colour;
  /** beats per shot: only parts longer than 1.5 times this are cut inside */
  shotBeats: number;
  /** a treatment id, 'auto' or 'none' */
  treatment: string;
  /** a motion id ('play' for plain playing) */
  motion?: string;
  /**
   * The pictures this part uses, as places in the deck, in order (a per-part choice; missing: dealt
   * automatically). The first is the picture; Split's second panel and Collage's fragments take the rest.
   */
  media?: number[];
  /** the second of its first clip the part starts on (missing: carries on from where that clip stopped) */
  from?: number;
  /** something in the first clip that lands on the song: its second, how long after the part starts, and the ramp (src/timing) */
  hit?: { clip: number; on: number; ramp: RampId };
  /** what the part is meant to feel like (src/moments) */
  moment?: string;
  /** Inside: the words that stand in the picture when nothing is sung */
  say?: string;
  /** Inside: a drawing that stands in the picture */
  drawn?: DrawnShot;
}

export interface RunInput {
  /** the song cut into its parts (one per shot) */
  analysis: TrackAnalysis;
  /** the song's sections as Hum heard them, and for each part the section it lies in */
  sections: TrackSection[];
  parents: number[];
  /** each part's settings, or null when the part is not footage */
  parts: (RunPart | null)[];
  /** the deck's lengths (s; a still lasts for ever), at least one */
  clips: number[];
  /** words to set in type, dealt to the shots in turn */
  words: string[];
  /** what the song feels like as it goes (src/feeling); missing: the moments alone */
  feel?: Curves | null;
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
  /** take `need` seconds of clip c from where it stopped (round to its start when it runs out), or from second `at` */
  const take = (c: number, need: number, at?: number): { from: number; k: number } => {
    const usable = usableOf(c);
    if (at !== undefined && need < usable - 0.05) {
      // a chosen start is kept as near as the clip's length allows; a clip used again carries on from its end
      const from = Math.max(0.05, Math.min(at, usable - need));
      cursor[c] = from + need;
      return { from, k: 1 };
    }
    if (need >= usable - 0.05) {
      cursor[c] = 0.05;
      return { from: 0.05, k: Math.min(1, (usable - 0.05) / need) };
    }
    if (cursor[c] + need > usable) cursor[c] = 0.05;
    const from = cursor[c];
    cursor[c] += need;
    return { from, k: 1 };
  };

  /** the stretch of clip c that puts its second `clip` on the song second `at` of a shot (null: the clip has no room for it) */
  const landing = (c: number, seq: Sequence, shot: Shot, at: number, clip: number): { from: number; k: number } | null => {
    const before = footageUpTo(seq, shot, at);
    const k = slowedToFit(before, footageNeed(seq, shot) - before, clip, o.clips[c] ?? 1e6);
    if (k < 0.2) return null;
    const from = clip - before * k;
    cursor[c] = from + footageNeed(seq, shot) * k;
    return { from, k };
  };

  let ordinal = 0;
  let prevStyle: StyleId | '' = '';
  let prevTreat: TreatmentId | '' = '';
  const seqs: (Sequence | null)[] = parts.map((part, i) => {
    const o2 = o.parts[i];
    if (!o2) return null;
    const sec = sectionOf(i);
    // the shot's place in its section (the first shot of a section is 0)
    let k = 0;
    while (i - k > 0 && o.parents[i - k - 1] === o.parents[i]) k++;
    const moment = isMoment(o2.moment) ? o2.moment : undefined;
    const style = styleForShot(sec, k, o2.style, o2.seed, prevStyle, moment);
    prevStyle = style;
    // the part's own pictures, when it has a choice of them (places that are still in the deck)
    const mine = o2.media?.filter((m) => m >= 0 && m < count) ?? [];
    // Inside is its own way of breaking a picture up: nothing else is done to it
    const treatment = style === 'inside' ? 'none' : treatmentForShot(sec, k, o2.treatment, o2.seed, prevTreat, mine.length || count, mine.length > 1, moment);
    prevTreat = treatment;
    const loud = sec.energy > 0.55 && style !== 'caption';
    const hitIn = lands(i);
    const hitOut = lands(i + 1);
    const last = i === n - 1;
    const { start, end } = part;

    const cuts = cutsOf(start, end, beat, o2.shotBeats);
    const motion = isMotion(o2.motion) && o2.motion !== 'play' ? o2.motion : undefined;

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
      hats: hatsIn(a, start, end, beat),
      shots: [],
      part: sec.label.toUpperCase(),
      // bar numbers and the part's time count from the section's start, so they carry on across its shots
      partStart: sec.start,
      energy: sec.energy,
      words: o.words,
      ...(o.feel ? { feel: o.feel } : {}),
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
        treatment,
        motion,
        ...(moment ? { moment } : {}),
        ...(o2.say ? { say: o2.say } : {}),
        ...(o2.drawn ? { drawn: o2.drawn } : {}),
      };
      // a part with its own pictures takes them in turn from its first; the rest are dealt round the deck
      const c = mine.length ? mine[j % mine.length] : ordinal % count;
      shot.footageIndex = c;
      const at = o2.hit && mine.length && c === mine[0] ? start + o2.hit.on : -1;
      // what lands at the very end of a shot belongs to it, not to the next
      const lands = at >= 0 && (at >= shot.start - 0.001 || j === 0) && (at < shot.end - 0.02 || lastShot) ? o2.hit! : null;
      if (lands) shot.hit = { at: Math.min(shot.end, Math.max(shot.start, at)), clip: lands.clip, ramp: lands.ramp };
      const landed = shot.hit ? landing(c, seq, shot, shot.hit.at, shot.hit.clip) : null;
      if (!landed) delete shot.hit;
      const need = footageNeed(seq, shot);
      // the part's chosen second is for its first shot; the ones after carry on
      const own = landed ?? take(c, need, j === 0 && mine.length ? o2.from : undefined);
      shot.clipFrom = own.from;
      shot.clipRate = own.k;
      if (style === 'split') {
        // Split shows a second moment: the part's next picture, else the next in the deck where it
        // stopped, or, with one clip, this clip further on
        const c2 = mine.length > 1 ? mine[(j + 1) % mine.length] : count > 1 ? (c + 1) % count : c;
        const alt = take(c2, need);
        shot.alt = c2;
        shot.altFrom = alt.from;
        shot.altEcho = c2 === c;
      }
      if (treatment === 'collage' || treatment === 'trace') {
        // Collage's fragments and Trace's other tiles: the part's other pictures (from the one after
        // this shot's), else the next few in the deck. A part given one picture keeps Trace to that
        // picture (its tiles become close-ups of it); Collage still needs fragments from elsewhere.
        const want = treatment === 'trace' ? 5 : 3;
        const at = mine.indexOf(c);
        const own = mine.length > 1 || (treatment === 'trace' && mine.length === 1);
        const rest = own ? [...mine.slice(at + 1), ...mine.slice(0, Math.max(0, at))].filter((m) => m !== c) : Array.from({ length: Math.min(want, count - 1) }, (_, m) => (c + 1 + m) % count);
        shot.extra = rest.slice(0, want);
      }
      seq.shots.push(shot);
      ordinal++;
    }
    return seq;
  });
  return { seqs };
}

/** how far a shot is slowed so that a clip has the seconds it needs before and after the one that lands (1: not at all) */
export const slowedToFit = (before: number, after: number, clip: number, length: number): number =>
  Math.min(1, before > 1e-3 ? Math.max(0, clip - 0.03) / before : 1, after > 1e-3 ? Math.max(0, length - 0.2 - clip) / after : 1);

/**
 * Where a part is cut inside: one shot, unless the part is long (over 1.5 shots and over 8 beats),
 * then shots of the look's length (6 beats at the least, so a fast look doesn't chop a part into
 * flickers). The cut times, with the part's start and end.
 */
function cutsOf(start: number, end: number, beat: number, shotBeats: number): number[] {
  const cuts = [start];
  if (end - start > Math.max(8, shotBeats * 1.5) * beat) {
    const pieces = Math.max(2, Math.round((end - start) / (Math.max(6, shotBeats) * beat)));
    for (let m = 1; m < pieces; m++) {
      const at = start + Math.round(((end - start) * m) / pieces / beat) * beat;
      if (at > cuts[cuts.length - 1] + beat && at < end - beat) cuts.push(at);
    }
  }
  cuts.push(end);
  return cuts;
}

/* ───────── a part's settings, from its look and its own choices ───────── */

/** looks saved before the styles carried the old settings: read them the nearest new way */
function colourOf(p: ParamValues): Colour {
  const c = str(p, 'colour', '');
  if (c === 'clean' || c === 'tinted' || c === 'flat') return c;
  const old = str(p, 'treat', '');
  return old === 'clean' ? 'clean' : old ? 'flat' : 'tinted';
}

/** the settings that decide a part's shots, from a footage look's params */
export function runPartOf(p: ParamValues): RunPart {
  return {
    style: str(p, 'style', 'auto'),
    seed: Math.max(1, Math.round(num(p, 'seed', 1))),
    colour: colourOf(p),
    shotBeats: Number(str(p, 'pace', '8')) || 8,
    treatment: str(p, 'treatment', 'none'),
    motion: str(p, 'motion', 'play'),
  };
}

/** a part's own choices (partShots.ts, or soloShot for a look playing on its own) laid over its look's */
export function withOwn(look: RunPart, own: PartShot | null | undefined, deckIds: string[]): RunPart {
  if (!own) return look;
  const media = (own.media ?? []).map((id) => deckIds.indexOf(id)).filter((x) => x >= 0);
  return {
    ...look,
    ...(own.style ? { style: own.style } : {}),
    ...(own.seed ? { seed: Math.max(1, Math.round(own.seed)) } : {}),
    ...(own.treatment ? { treatment: own.treatment } : {}),
    ...(own.motion ? { motion: own.motion } : {}),
    ...(media.length ? { media } : {}),
    // a start belongs to the first picture of the list it was chosen with: gone if that picture is
    ...(typeof own.from === 'number' && media.length && deckIds[media[0]] === own.media?.[0] ? { from: own.from } : {}),
    // and so does what lands
    ...(typeof own.hit === 'number' && typeof own.on === 'number' && media.length && deckIds[media[0]] === own.media?.[0] ? { hit: { clip: own.hit, on: own.on, ramp: isRamp(own.ramp) ? own.ramp : 'ride' } } : {}),
    ...(isMoment(own.moment) ? { moment: own.moment } : {}),
    ...(own.say ? { say: own.say } : {}),
    ...(own.drawn ? { drawn: own.drawn } : {}),
  };
}

/** a look's signature: two parts with the same one play the same look (see the footage scene) */
export const sigOf = (r: RunPart) => `${r.style}|${r.seed}|${r.colour}|${r.shotBeats}|${r.treatment}|${r.motion ?? 'play'}`;

/**
 * The parts' settings when a video plan with one look per part plays this song cut (null otherwise):
 * for each part, its look's settings (the preset with the person's tweaks) when the look is footage,
 * with the part's own choices laid over them; and each part's look-level signature.
 */
export function planParts(a: TrackAnalysis, deckIds: string[]): { parts: (RunPart | null)[]; sigs: (string | null)[] } | null {
  const s = useStudio.getState();
  const plan = s.plan;
  if (!s.planOn || !plan?.flat || plan.looks.length !== a.sections.length) return null;
  const all = [...s.customPresets, ...PRESETS];
  const sigs: (string | null)[] = [];
  const parts = plan.looks.map((id, i) => {
    const p = id ? all.find((x) => x.id === id) : undefined;
    if (!p || p.sceneId !== 'footage') {
      sigs.push(null);
      return null;
    }
    const look = runPartOf({ ...(p.sceneParams ?? {}), ...(s.tweaks[p.id]?.sceneParams ?? {}) });
    sigs.push(sigOf(look));
    return withOwn(look, shotOfPart(i, s), deckIds);
  });
  return { parts, sigs };
}

/* ───────── the deck ───────── */

/** how many clips one picture opens players for, and how many photos its deck holds */
export const MAX_OPEN = 6;
export const MAX_STILLS = 24;

/** when a clip or photo was added (its id carries the time it was made) */
export const addedAt = (id: string) => parseInt(id.split('-')[1] ?? '', 36) || 0;

/**
 * The ids of the pictures a footage look deals from, in order: the person's clips (the first six) and
 * photos, in the order they were added; with neither, the built-in placeholder photo.
 */
export function deckIdsOf(clips: ClipAsset[], photos: PhotoAsset[]): string[] {
  const own = photos.filter((p) => !p.builtin).slice(0, MAX_STILLS);
  const ids = [...clips.slice(0, MAX_OPEN).map((c) => c.id), ...own.map((p) => p.id)];
  ids.sort((x, y) => addedAt(x) - addedAt(y));
  return ids.length ? ids : photos.slice(0, 1).map((p) => p.id);
}

/**
 * The id of the clip or photo part `partIndex` shows first, as the footage look would deal it now
 * (null: the part isn't a footage part, or there are no pictures). With a video plan playing it
 * follows the run across the song (every cut moves to the next picture; a part with its own pictures
 * takes its first); with no plan, the part as the look on screen cuts it. Cheap: it counts the cuts
 * before the part rather than building the run.
 */
export function mediaForPart(analysis: TrackAnalysis, partIndex: number): string | null {
  const s = useStudio.getState();
  const deck = deckIdsOf(s.clips, s.photos);
  if (!deck.length || partIndex < 0 || partIndex >= analysis.sections.length) return null;
  const fp = planParts(analysis, deck);
  if (fp) {
    const own = fp.parts[partIndex];
    if (!own) return null;
    const mine = (own.media ?? []).filter((m) => m < deck.length);
    if (mine.length) return deck[mine[0]];
    const beat = feltBeat(analysis.bpm);
    let ordinal = 0;
    for (let i = 0; i < partIndex; i++) {
      const p = fp.parts[i];
      if (!p) continue;
      const sec = analysis.sections[i];
      ordinal += cutsOf(sec.start, sec.end, beat, p.shotBeats).length - 1;
    }
    return deck[ordinal % deck.length];
  }
  // no plan: the look on screen cuts each part itself, its first shot on the part's own place in the deck
  if (s.sceneId !== 'footage') return null;
  const solo = withOwn(runPartOf(s.sceneParams), s.soloShot, deck);
  const mine = (solo.media ?? []).filter((m) => m < deck.length);
  return deck[(mine.length ? mine[0] : partIndex) % deck.length];
}
