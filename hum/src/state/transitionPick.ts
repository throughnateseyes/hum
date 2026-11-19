/**
 * Which transition a look change uses, and for how long (in beats, so it locks to the tempo).
 *
 * The song decides: drops cut hard (or, on a small drop in a gentle song, a very fast punchy push or
 * burn), calm and tender parts get long dissolves and fades, builds get wipes and slit-scans, loud
 * busy songs mostly cut with the odd glitchy swap. The Transition setting in the Look tab can pin one
 * transition (or Cut) for everything and fix the length; strong drops always stay hard cuts.
 */
import type { TrackAnalysis, TrackSection } from '../core/types';
import { TRANSITIONS, type TransitionId } from '../core/transitionList';
import { useStudio } from './store';
import { playingDirection, preferredTransitions } from './direction';

export interface TransitionSpec {
  id: TransitionId;
  /** length in beats (ignored for a cut) */
  beats: number;
}

/** what a look change lands on */
export type TransitionMoment = 'section' | 'interlude' | 'phrase' | 'hit' | 'drop' | 'vocal' | 'lyric' | 'resolve' | 'manual' | 'auto';

/** moods that want slow dissolves and longer shots */
const SOFT_MOODS = ['melancholic', 'heartbroken', 'tender', 'dreamy', 'wistful', 'calm', 'bittersweet', 'spacious', 'warm', 'brooding'];
/** moods that want hard cuts and shorter shots */
const HARD_MOODS = ['aggressive', 'euphoric', 'explosive', 'energetic', 'menacing', 'driving', 'heavy', 'swaggering', 'uplifting', 'joyful'];

export type SongMood = 'soft' | 'hard' | 'mid';

export function moodOf(a: TrackAnalysis): SongMood {
  const m = a.character?.mood ?? a.tags[0] ?? '';
  if (SOFT_MOODS.includes(m)) return 'soft';
  if (HARD_MOODS.includes(m)) return 'hard';
  return a.mood.arousal > 0.62 ? 'hard' : a.mood.arousal < 0.3 ? 'soft' : 'mid';
}

export interface PickContext {
  on: TransitionMoment;
  /** the section the new look starts in */
  label?: TrackSection['label'];
  /** that section's energy 0..1 */
  energy?: number;
  /** the size of the drop this lands on (0 = none) */
  drop?: number;
  /** this lands on a drop big enough that it must cut */
  strongDrop?: boolean;
  /** the previous section was a board interlude */
  fromInterlude?: boolean;
  /** first shot of the song */
  first?: boolean;
  /** seconds free around the change (the shorter of the shots either side), caps the length */
  room?: number;
  /** stable per change, so a plan always plays the same way */
  seed: number;
  /** the transition used last, to avoid twice in a row */
  prev?: TransitionId;
  /** the video's motion vocabulary (its Direction's transition set): these are favoured, others thinned */
  prefer?: TransitionId[];
}

type Weights = Partial<Record<TransitionId, number>>;

/** small deterministic random from a seed */
function rng(seed: number) {
  let t = (Math.floor(seed * 9301 + 49297) >>> 0) || 1;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** the transition set the pick being made leans on (set by pickTransition for the length of one pick) */
let leaning: TransitionId[] | undefined;

/**
 * Lean a weight table toward the video's transition set: its members count three times as much and
 * the rest a third, and members the moment didn't offer join in lightly so the set is always heard.
 * Cuts keep their weight: they're punctuation in every style.
 */
function lean(w: Weights): Weights {
  if (!leaning?.length) return w;
  const out: Weights = {};
  const vals = Object.values(w).filter((v) => v! > 0) as number[];
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
  for (const [id, v] of Object.entries(w) as [TransitionId, number][]) out[id] = id === 'cut' ? v : leaning.includes(id) ? v * 3 : v / 3;
  for (const id of leaning) if (id !== 'cut' && !(id in w)) out[id] = mean * 0.6;
  return out;
}

function choose(w: Weights, rand: () => number, prev?: TransitionId): TransitionId {
  w = lean(w);
  const all = Object.entries(w).filter(([, v]) => v! > 0) as [TransitionId, number][];
  const fresh = all.filter(([id]) => id !== prev || id === 'cut');
  const entries = fresh.length ? fresh : all;
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let r = rand() * total;
  for (const [id, v] of entries) {
    r -= v;
    if (r <= 0) return id;
  }
  return entries[entries.length - 1]?.[0] ?? 'crossfade';
}

/** the nearest offered length in beats to `sec` seconds */
function beatsFor(sec: number, bpm: number): number {
  const beat = 60 / clampBpm(bpm);
  const opts = [0.25, 0.5, 1, 2, 4, 8];
  return opts.reduce((best, b) => (Math.abs(Math.log((b * beat) / sec)) < Math.abs(Math.log((best * beat) / sec)) ? b : best), 1);
}

const clampBpm = (bpm: number) => Math.max(50, Math.min(200, bpm || 120));

/** pick a transition for a look change in a song with analysis `a` (null: no song loaded) */
export function pickTransition(a: TrackAnalysis | null, c: PickContext): TransitionSpec {
  leaning = c.prefer;
  try {
    return pickFor(a, c);
  } finally {
    leaning = undefined;
  }
}

function pickFor(a: TrackAnalysis | null, c: PickContext): TransitionSpec {
  const rand = rng(c.seed);
  const mood: SongMood = a ? moodOf(a) : 'mid';
  const bpm = a?.bpm || 120;
  const fit = (id: TransitionId, sec: number): TransitionSpec => {
    if (id === 'cut') return { id, beats: 0 };
    const s = Math.min(sec, c.room ? c.room * 0.6 : Infinity);
    return { id, beats: Math.max(0.25, beatsFor(Math.max(0.18, s), bpm)) };
  };
  const vary = (lo: number, hi: number) => lo + (hi - lo) * rand();

  if (c.first) return { id: 'cut', beats: 0 };
  if (c.strongDrop) return { id: 'cut', beats: 0 };
  // drops: a hard cut, or in gentler songs a very fast punchy push / burn
  if (c.on === 'drop' || (c.drop ?? 0) > 0) {
    if (mood === 'hard' || (c.drop ?? 0) >= 0.4) return { id: 'cut', beats: 0 };
    return fit(choose(mood === 'soft' ? { burn: 2, push: 2, luma: 1 } : { push: 3, cut: 2, mosaic: 1 }, rand, c.prev), vary(0.18, 0.35));
  }
  if (c.on === 'interlude') return fit(choose({ glyph: 3, mosaic: 2, slit: 1 }, rand, c.prev), vary(0.35, 0.6));
  if (c.fromInterlude) return fit(choose({ slit: 2, wipe: 2, mosaic: 1, cut: mood === 'hard' ? 2 : 0 }, rand, c.prev), vary(0.3, 0.55));

  const label = c.label ?? 'verse';
  const calm = (c.energy ?? 0.5) < 0.35;

  // builds: wipes and slit-scans that keep the motion going
  if (label === 'build') {
    if (c.on === 'hit' && mood === 'hard') return { id: 'cut', beats: 0 };
    return fit(choose({ wipe: 3, slit: 3, iris: 1, push: 1 }, rand, c.prev), mood === 'soft' ? vary(1, 1.8) : vary(0.4, 0.9));
  }

  if (c.on === 'section') {
    if (label === 'outro') return fit(mood === 'soft' ? choose({ 'fade-bg': 2, luma: 1, crossfade: 1 }, rand, c.prev) : 'fade-black', mood === 'hard' ? vary(0.8, 1.2) : vary(2, 3.5));
    if (label === 'break' || label === 'intro') return fit(choose(mood === 'soft' ? { 'fade-bg': 2, luma: 2, burn: 1 } : { 'fade-black': 2, 'fade-bg': 1, luma: 1, noise: 1 }, rand, c.prev), mood === 'hard' ? vary(0.6, 1) : vary(1.6, 3));
    if (label === 'chorus') {
      if (mood === 'hard') return { id: 'cut', beats: 0 };
      if (mood === 'mid') return fit(choose({ push: 2, iris: 2, cut: 1, burn: 1 }, rand, c.prev), vary(0.3, 0.6));
      return fit(choose({ burn: 2, 'fade-bg': 1, luma: 2, ink: 1 }, rand, c.prev), vary(1.2, 2.2));
    }
    if (label === 'drop') return { id: 'cut', beats: 0 };
    if (mood === 'soft') return fit(choose({ 'fade-bg': 2, luma: 3, crossfade: 2, burn: 2, noise: 2, ink: 1 }, rand, c.prev), vary(2.2, 3.8));
    if (mood === 'mid') return fit(choose({ iris: 2, wipe: 2, burn: 2, noise: 2, push: 1, ink: 1, luma: 1 }, rand, c.prev), vary(0.8, 1.4));
    return fit(choose({ cut: 4, push: 2, slit: 1, glyph: 1 }, rand, c.prev), vary(0.25, 0.45));
  }

  if (c.on === 'hit') {
    if (mood === 'soft') return fit(choose({ luma: 3, ripple: 2, burn: 1, crossfade: 1 }, rand, c.prev), vary(1, 1.8));
    // loud parts: mostly hard cuts with the odd very fast glitchy swap; quiet parts of loud songs a bit softer
    if (label === 'drop' || label === 'chorus' || (c.energy ?? 0) > 0.7) return fit(choose({ cut: 4, push: 1, slit: 1, glyph: 1, mosaic: 1 }, rand, c.prev), vary(0.15, 0.3));
    if (calm) return fit(choose({ cut: 2, push: 1, iris: 1, wipe: 1, noise: 1 }, rand, c.prev), vary(0.4, 0.8));
    return fit(choose({ cut: 3, push: 2, mosaic: 1, slit: 1 }, rand, c.prev), vary(0.2, 0.35));
  }

  // the harmony coming home: the picture settles into the new look rather than snapping to it
  if (c.on === 'resolve') {
    const w: Weights = mood === 'hard' ? { push: 2, iris: 2, cut: 1, luma: 1 } : { luma: 3, crossfade: 2, 'fade-bg': 1, ripple: 1 };
    return fit(choose(w, rand, c.prev), mood === 'soft' ? vary(1.6, 2.6) : mood === 'mid' ? vary(0.8, 1.4) : vary(0.3, 0.5));
  }

  if (c.on === 'vocal' || c.on === 'lyric') {
    const w: Weights = mood === 'hard' ? { cut: 2, wipe: 1, iris: 1, glyph: 1 } : { luma: 2, iris: 2, ripple: 2, wipe: 1, 'fade-bg': mood === 'soft' ? 1 : 0 };
    return fit(choose(w, rand, c.prev), mood === 'soft' ? vary(1.4, 2.4) : mood === 'mid' ? vary(0.6, 1.1) : vary(0.25, 0.4));
  }

  // phrase lines, manual picks and auto-pilot
  const loud = label === 'drop' || label === 'chorus' || (c.energy ?? 0) > 0.7;
  if (mood === 'soft' || (calm && mood === 'mid'))
    return fit(choose({ luma: 3, crossfade: 3, noise: 2, ripple: 1, iris: 1, burn: 1, 'fade-bg': 1 }, rand, c.prev), mood === 'soft' ? vary(1.8, 3.2) : vary(1, 1.8));
  if (mood === 'mid' && !loud)
    return fit(choose({ noise: 2, wipe: 2, luma: 2, mosaic: 1, glyph: 1, iris: 1, ripple: 1, crossfade: 1, ink: 1 }, rand, c.prev), vary(0.6, 1.2));
  const w: Weights = { slit: 2, mosaic: 2, glyph: 2, push: 2, wipe: 1, cut: c.on === 'manual' ? 0 : 3 };
  return fit(choose(w, rand, c.prev), vary(0.25, 0.5));
}

/** what the stage needs to run a transition */
export interface ResolvedTransition {
  id: TransitionId;
  ms: number;
  seed: number;
}

/**
 * Apply the Transition and Length settings to a picked transition and turn its beats into ms at the
 * song's tempo. A fixed transition is used everywhere except strong drops, which always cut.
 */
export function resolveTransition(spec: TransitionSpec, o: { strongDrop?: boolean; bpm?: number; seed?: number } = {}): ResolvedTransition {
  const s = useStudio.getState();
  const bpm = clampBpm(o.bpm ?? s.analysis?.bpm ?? 120);
  const seed = o.seed ?? Math.random() * 1000;
  let id = spec.id;
  let beats = spec.beats;
  if (s.transition === 'cut') id = 'cut';
  else if (s.transition !== 'auto' && !o.strongDrop) {
    if (id === 'cut') beats = 0.5;
    id = s.transition;
  }
  if (id === 'cut') return { id, ms: 1, seed };
  if (s.transitionBeats > 0) beats = s.transitionBeats;
  return { id, ms: Math.max(160, Math.min(7000, beats * (60000 / bpm))), seed };
}

/** a look change nobody planned (a pick in the library, auto-pilot): from the setting and the music */
export function transitionForNow(on: TransitionMoment, songTime: number | null, seed = Math.random() * 1000, strongDrop = false): ResolvedTransition {
  const s = useStudio.getState();
  const a = s.analysis;
  let label: TrackSection['label'] | undefined;
  let energy: number | undefined;
  if (a && songTime !== null) {
    const sec = [...a.sections].reverse().find((x) => songTime >= x.start);
    label = sec?.label;
    energy = sec?.energy;
  }
  const prefer = preferredTransitions(playingDirection(s) ? s.plan : null);
  const spec = pickTransition(songTime !== null ? a : null, { on, label, energy, seed, strongDrop, room: on === 'manual' ? 2.6 : undefined, prefer });
  return resolveTransition(spec, { strongDrop, seed });
}

export const transitionName = (id: TransitionId) => TRANSITIONS.find((t) => t.id === id)?.name ?? id;
