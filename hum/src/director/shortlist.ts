/**
 * Which looks go into a "Make a video" request.
 *
 * Sending every look (100+) to Claude for every plan is most of the request. A plan only ever uses a
 * dozen or so, so the request gets a shortlist that still leaves Claude real choices:
 *
 *   - the looks the analysis suggests for this song, and the ones whose tags match its mood
 *   - the calmest and the most intense looks (every song needs quiet parts and big moments)
 *   - at least one look from every style family, and a few instrument boards for interludes
 *   - every look the person made, the ones they like, and the last plan's looks (taste refers to them)
 *   - a few at random, so two takes of one song don't always pick from the same list
 *
 * When the person types a wish ("all black and white", "use the paper looks") the full list goes,
 * since the wish may ask for something the song alone wouldn't suggest.
 */
import type { Preset, TrackAnalysis } from '../core/types';
import { lookStyle } from '../core/styles';

/** at most this many looks in a plan request without a wish */
export const SHORTLIST_SIZE = 56;

const LOUD = ['heavy', 'aggressive', 'intense', 'dubstep', 'glitch', 'euphoric', 'energetic', 'driving', 'techno', 'trance'];
const SOFT = ['calm', 'minimal', 'sad', 'dreamy', 'ambient', 'tender', 'spacious', 'slow', 'melancholic', 'piano'];
const intensity = (p: Preset) => p.tags.filter((t) => LOUD.includes(t)).length - p.tags.filter((t) => SOFT.includes(t)).length;

export interface ShortlistOptions {
  wish?: string;
  /** look ids that must be in the list (liked looks, the last plan's looks) */
  keep?: string[];
  /** scene category of a look, to find the instrument boards */
  categoryOf: (p: Preset) => string;
  /** for the random picks (default: Math.random) */
  random?: () => number;
  size?: number;
}

export function shortlistLooks(looks: Preset[], a: TrackAnalysis, opts: ShortlistOptions): Preset[] {
  const size = opts.size ?? SHORTLIST_SIZE;
  if (opts.wish?.trim() || looks.length <= size) return looks;
  const random = opts.random ?? Math.random;
  const songWords = new Set([...a.tags, ...(a.character ? [a.character.mood, ...a.character.genre.split(/\s+/)] : [])].map((t) => t.toLowerCase()));
  const loudSong = a.tags.some((t) => LOUD.includes(t));
  const softSong = a.tags.some((t) => SOFT.includes(t));
  const suggested = a.suggestedPresets;
  const score = (p: Preset) => {
    const r = suggested.indexOf(p.id);
    const match = p.tags.filter((t) => songWords.has(t.toLowerCase())).length;
    const lean = loudSong && !softSong ? 0.15 * intensity(p) : softSong && !loudSong ? -0.15 * intensity(p) : 0;
    return (r >= 0 ? 3 - r * 0.2 : 0) + match + lean + 0.6 * random();
  };
  const scored = looks.map((p) => ({ p, s: score(p) })).sort((x, y) => y.s - x.s);
  const pick = new Set<Preset>();
  const add = (p: Preset | undefined) => p && pick.size < size + 12 && pick.add(p);

  // must-haves: the person's own looks, liked looks and the last plan's looks
  const keep = new Set(opts.keep ?? []);
  for (const p of looks) if (p.custom || keep.has(p.id)) add(p);
  for (const id of suggested) add(looks.find((p) => p.id === id));
  // the best matches for the song
  const boards = scored.filter(({ p }) => opts.categoryOf(p) === 'board');
  const plain = scored.filter(({ p }) => opts.categoryOf(p) !== 'board');
  for (const { p } of plain.slice(0, 22)) add(p);
  // the quiet end and the loud end
  const byIntensity = [...plain].sort((x, y) => intensity(x.p) - intensity(y.p) || y.s - x.s);
  for (const { p } of byIntensity.slice(0, 5)) add(p);
  for (const { p } of byIntensity.slice(-5)) add(p);
  // every style family gets its best two
  const families = new Map<string, number>();
  for (const { p } of plain) {
    const f = lookStyle(p);
    const n = families.get(f) ?? 0;
    if (n < 2) {
      families.set(f, n + 1);
      add(p);
    }
  }
  // instrument boards for interludes
  for (const { p } of boards.slice(0, 4)) add(p);
  // a few at random from the rest, so takes vary
  const rest = plain.filter(({ p }) => !pick.has(p));
  while (pick.size < size && rest.length) add(rest.splice(Math.floor(random() * rest.length), 1)[0].p);
  // keep the app's order (built-in looks in catalogue order)
  return looks.filter((p) => pick.has(p));
}
