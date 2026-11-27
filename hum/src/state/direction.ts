/**
 * Direction at play time: which finish is on screen, and the offline planner's pick of a direction for
 * a song (the lists and the Claude rule live in core/direction.ts).
 *
 * The Finish setting (Look tab → Video) is either a fixed finish or Auto. Auto follows the playing
 * video's Direction; with no video playing (or a plan made before directions existed) it falls back on
 * the Hand-drawn switch, so Hum outside a video looks as it always has. The Hand-drawn switch (H) and
 * the Finish picker are the same control: switching Hand-drawn on picks Hand-drawn, off picks Clean.
 */
import { FINISH_MOTION, finishName, TRANSITION_SETS, type Direction, type FinishId, type TransitionSetId } from '../core/direction';
import { lookStyle, type StyleId } from '../core/styles';
import type { Preset, TrackAnalysis } from '../core/types';
import { getScene } from '../scenes';
import { moodFinish, type Mood } from '../presets/moods';
import type { TransitionId } from '../core/transitionList';
import type { VideoPlan } from './plan';
import { useStudio, type StudioState } from './store';

/** the playing video's direction, when a video plan for this song is on */
export function playingDirection(s: Pick<StudioState, 'planOn' | 'plan' | 'analysis'>): Direction | undefined {
  const p = s.plan;
  const a = s.analysis;
  if (!s.planOn || !p?.direction || !a || p.looks.length !== a.sections.length || Math.abs(p.duration - a.duration) >= 0.5) return undefined;
  return p.direction;
}

type FinishState = Pick<StudioState, 'finish' | 'finishPicked' | 'finishPreview' | 'hand' | 'planOn' | 'plan' | 'analysis' | 'sceneId' | 'partHand'>;

/**
 * Hand-drawn as the person set it for the part playing at song time t (Part tab, timeline menu):
 * true on, false off, null as the video is set. Only while the video plan plays, since parts are the plan's.
 */
export function partHandAt(s: Pick<StudioState, 'planOn' | 'plan' | 'analysis' | 'partHand'>, t: number): boolean | null {
  return partValueAt(s, s.partHand, t);
}

/** the words the person gave the part playing at song time t, for looks that write text ('' when none) */
export function partWordsAt(s: Pick<StudioState, 'planOn' | 'plan' | 'analysis' | 'partWords'>, t: number): string {
  return partValueAt(s, s.partWords, t)?.trim() ?? '';
}

function partValueAt<T>(s: Pick<StudioState, 'planOn' | 'plan' | 'analysis'>, values: (T | null)[] | null, t: number): T | null {
  const secs = s.analysis?.sections;
  if (!values || !secs || values.length !== secs.length || !playingDirectionOk(s)) return null;
  let i = 0;
  for (let k = secs.length - 1; k >= 0; k--) {
    if (t >= secs[k].start) {
      i = k;
      break;
    }
  }
  return values[i] ?? null;
}

const playingDirectionOk = (s: Pick<StudioState, 'planOn' | 'plan' | 'analysis'>) =>
  s.planOn && !!s.plan && !!s.analysis && s.plan.looks.length === s.analysis.sections.length && Math.abs(s.plan.duration - s.analysis.duration) < 0.5;

/**
 * The finish to draw now. `t` (the song time of the frame being drawn, live or in a render) lets a part's
 * own Hand-drawn setting win: On draws it hand-drawn, Off draws the video's finish, or Clean when that
 * finish is Hand-drawn. Without `t` it is the finish of the whole video.
 */
export function activeFinish(s: FinishState, t?: number): FinishId {
  // a finish tried on draws as it would once picked (picked, so a clean-leaning look doesn't refuse it)
  const tried = s.finishPreview;
  const pick = tried ?? s.finish;
  const f = pick !== 'auto' ? pick : (playingDirection(s)?.finish ?? (s.hand.on ? 'hand' : 'clean'));
  const own = t === undefined ? null : partHandAt(s, t);
  if (own === true) return 'hand';
  if (own === false) return f === 'hand' ? 'clean' : f;
  // a look that falls apart under hand-drawn (fine snow, soft glows) shows clean until the person picks a finish
  if (f === 'hand' && !tried && !s.finishPicked && getScene(s.sceneId)?.prefersClean) return 'clean';
  return f;
}

/** pick a finish (or Auto) in the UI; keeps the Hand-drawn switch in step */
export function setFinish(v: 'auto' | FinishId) {
  const s = useStudio.getState();
  if (v === 'auto') s.set({ finish: v, finishPicked: true });
  else s.set({ finish: v, finishPicked: true, hand: { ...s.hand, on: v === 'hand' } });
}

/** the transitions a plan's direction leans on (undefined: no preference) */
export function preferredTransitions(plan: VideoPlan | null | undefined): TransitionId[] | undefined {
  const set = plan?.direction?.transitions;
  return set ? TRANSITION_SETS[set].ids : undefined;
}

/* ───────────────────────── the offline planner's pick ───────────────────────── */

/** how well each finish suits a style family */
const BY_STYLE: Record<StyleId, Partial<Record<FinishId, number>>> = {
  world: { ink: 1.0, film: 0.8, hand: 0.8, riso: 0.3 },
  light: { film: 1.2, clean: 0.6, tape: 0.3 },
  particles: { film: 0.8, clean: 0.7, tape: 0.4 },
  form: { clean: 0.9, film: 0.6, tape: 0.4 },
  print: { riso: 1.3, hand: 0.9, ink: 0.3 },
  type: { riso: 1.0, hand: 0.6, clean: 0.5, tape: 0.4 },
  data: { tape: 1.0, clean: 0.8, film: 0.2 },
  photo: { film: 1.1, tape: 0.6, riso: 0.5 },
  board: { clean: 1.0, tape: 0.6, riso: 0.4 },
};

/** song words that pull toward a finish */
const BY_WORD: [string[], Partial<Record<FinishId, number>>][] = [
  [['lofi', 'lo-fi', 'retro', 'vhs', 'gritty', 'grunge', 'vaporwave', 'synthwave', '80s', '90s'], { tape: 0.9, film: 0.3 }],
  [['cinematic', 'nostalgic', 'warm', 'romantic', 'melancholic', 'bittersweet', 'wistful', 'soul', 'folk', 'jazz'], { film: 0.7 }],
  [['calm', 'tender', 'spacious', 'acoustic', 'piano', 'ambient', 'sad', 'minimal', 'meditative', 'classical'], { ink: 0.7, film: 0.2 }],
  [['playful', 'happy', 'bouncy', 'indie', 'upbeat', 'punk', 'quirky', 'pop', 'joyful'], { riso: 0.7, hand: 0.5 }],
  [['aggressive', 'heavy', 'dubstep', 'techno', 'glitch', 'industrial', 'metal', 'menacing'], { tape: 0.6, clean: 0.4, ink: -0.8 }],
  [['euphoric', 'energetic', 'electronic', 'house', 'trance', 'futuristic', 'driving'], { clean: 0.5, film: 0.2 }],
];

/** a type pairing per finish, starting with one of the lyric type families */
const TYPE_HINT: Record<FinishId, [soft: string, hard: string]> = {
  clean: ['grotesk, light weight, generous spacing', 'grotesk, heavy, tight'],
  film: ['serif display, italic captions', 'condensed grotesk, wide tracking'],
  riso: ['grotesk, bold and tight', 'condensed, poster weight'],
  ink: ['serif, light, lots of air', 'serif, bold brush accents'],
  tape: ['mono, VHS timecode captions', 'mono, chunky and glitchy'],
  hand: ['rounded, hand-lettered feel', 'rounded, bouncy weight'],
};

const WHY: Record<FinishId, string> = {
  clean: 'kept clean and sharp',
  film: 'shot on 16mm film',
  riso: 'printed in riso inks',
  ink: 'painted in ink wash',
  tape: 'played off an old tape',
  hand: 'drawn by hand',
};

const SOFT = ['melancholic', 'heartbroken', 'tender', 'dreamy', 'wistful', 'calm', 'bittersweet', 'spacious', 'warm', 'brooding'];

/**
 * A direction for a song without Claude: the finish that best fits the plan's main look's world and
 * the song's words and energy, with a little seeded variety so every take isn't the same, then the
 * transition set that suits that finish and the song.
 */
export function localDirection(a: TrackAnalysis, looks: (Preset | undefined)[], seed = 0): Direction {
  const words = [...a.tags, a.character?.mood ?? '', a.character?.genre ?? ''].map((w) => w.toLowerCase());
  const score: Record<FinishId, number> = { clean: 0.2, film: 0.3, riso: 0, ink: 0, tape: 0, hand: 0.15 };
  // the worlds the video lives in: each section's look counts, the first (most used) a little more
  const styles = new Map<StyleId, number>();
  looks.forEach((p) => p && styles.set(lookStyle(p), (styles.get(lookStyle(p)) ?? 0) + 1));
  const total = Math.max(1, looks.filter(Boolean).length);
  for (const [st, n] of styles) for (const [f, v] of Object.entries(BY_STYLE[st])) score[f as FinishId] += (v as number) * (n / total) * 1.6;
  for (const [ws, add] of BY_WORD) {
    const hits = ws.filter((w) => words.some((x) => x.includes(w))).length;
    if (hits) for (const [f, v] of Object.entries(add)) score[f as FinishId] += (v as number) * Math.min(2, hits) * 0.6;
  }
  // energy: busy loud songs fight the calm of ink; quiet ones suit it
  const ar = a.mood.arousal;
  score.ink += 0.6 - 1.2 * ar;
  score.tape += 0.5 * ar - 0.2;
  score.clean += 0.3 * ar;
  // a little seeded variety so two takes of one song can differ
  let r = (Math.floor(seed) >>> 0) || 1;
  const rand = () => {
    r = (r + 0x6d2b79f5) >>> 0;
    let t = Math.imul(r ^ (r >>> 15), 1 | r);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (const f of Object.keys(score) as FinishId[]) score[f] += (rand() - 0.5) * 0.7;
  const finish = (Object.keys(score) as FinishId[]).sort((x, y) => score[y] - score[x])[0];

  const m = a.character?.mood ?? a.tags[0] ?? '';
  const soft = SOFT.includes(m) || ar < 0.3;
  const hard = !soft && ar > 0.62;
  let transitions: TransitionSetId = FINISH_MOTION[finish];
  if (finish === 'clean') transitions = hard ? 'kinetic' : soft ? 'soft' : 'graphic';
  if (finish === 'hand') transitions = soft ? 'organic' : 'graphic';
  const main = looks.find(Boolean);
  return {
    finish,
    transitions,
    type: TYPE_HINT[finish][hard ? 1 : 0],
    why: `${finishName(finish)}: the whole video ${WHY[finish]}${main ? `, around “${main.name}”` : ''}, with ${TRANSITION_SETS[transitions].ai}.`,
  };
}

/**
 * The direction of a video planned in a mood (presets/moods.ts): the mood's own finish (its soft or
 * its loud one, by the song) and transition set. `type` keeps a type hint another planner chose.
 */
export function moodDirection(a: TrackAnalysis, mood: Mood, looks: (Preset | undefined)[], type?: string): Direction {
  const ar = a.mood.arousal;
  const finish = moodFinish(mood, ar);
  const transitions = mood.transitions;
  const m = a.character?.mood ?? a.tags[0] ?? '';
  const hard = !(SOFT.includes(m) || ar < 0.3) && ar > 0.62;
  const main = looks.find(Boolean);
  return {
    finish,
    transitions,
    type: type ?? TYPE_HINT[finish][hard ? 1 : 0],
    why: `${mood.name}: one world all the way through, ${WHY[finish]}${main ? `, around “${main.name}”` : ''}, with ${TRANSITION_SETS[transitions].ai}.`,
  };
}
