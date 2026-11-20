/**
 * Which looks go into a "Make a video" request.
 *
 * Sending every look to Claude for every plan is most of the request, and a plan only ever uses a dozen
 * or so. Looks are chosen a family at a time (presets/fit.ts): a family's takes go up together on one
 * compressed line, so a family costs little more than a single look, and the shortlist is counted in
 * families. It still leaves Claude real choices:
 *
 *   - the families the analysis suggests for this song, and the ones whose tags match its mood
 *   - families for every part the song has (intro, build, drop…), by their curated fit
 *   - the calmest and the most intense families (every song needs quiet parts and big moments)
 *   - at least one family from every theme, and a few instrument boards for interludes
 *   - every look the person made, the ones they like, and the last plan's looks (taste refers to them)
 *   - a few at random, so two takes of one song don't always pick from the same list
 *
 * When the person types a wish ("all black and white", "use the paper looks") the full list goes,
 * since the wish may ask for something the song alone wouldn't suggest.
 */
import type { Preset, TrackAnalysis } from '../core/types';
import { familyIdOf, familyOf, fitScore, relationsOf, roleOf, takeFit, tagIntensity } from '../presets/fit';

/** at most this many families in a plan request without a wish */
export const SHORTLIST_FAMILIES = 30;

export interface ShortlistOptions {
  wish?: string;
  /** look ids that must be in the list (liked looks, the last plan's looks) */
  keep?: string[];
  /** scene category of a look, to find the instrument boards */
  categoryOf: (p: Preset) => string;
  /** for the random picks (default: Math.random) */
  random?: () => number;
  /** families, not looks */
  size?: number;
}

export function shortlistLooks(looks: Preset[], a: TrackAnalysis, opts: ShortlistOptions): Preset[] {
  const size = opts.size ?? SHORTLIST_FAMILIES;
  const groups = new Map<string, Preset[]>();
  for (const p of looks) {
    const f = familyIdOf(p);
    (groups.get(f) ?? groups.set(f, []).get(f)!).push(p);
  }
  if (opts.wish?.trim() || groups.size <= size) return looks;
  const random = opts.random ?? Math.random;
  const songWords = new Set([...a.tags, ...(a.character ? [a.character.mood, ...a.character.genre.split(/\s+/)] : [])].map((t) => t.toLowerCase()));
  const LOUD = ['heavy', 'aggressive', 'intense', 'dubstep', 'techno', 'trance', 'energetic', 'driving'];
  const SOFT = ['calm', 'sad', 'tender', 'ambient', 'piano', 'melancholic', 'slow'];
  const loudSong = a.tags.some((t) => LOUD.includes(t));
  const softSong = a.tags.some((t) => SOFT.includes(t));
  const suggested = a.suggestedPresets;
  const lookScore = (p: Preset) => {
    const r = suggested.indexOf(p.id);
    const match = p.tags.filter((t) => songWords.has(t.toLowerCase())).length;
    const lvl = tagIntensity(p.tags);
    const lean = loudSong && !softSong ? 0.15 * lvl : softSong && !loudSong ? -0.15 * lvl : 0;
    return (r >= 0 ? 3 - r * 0.2 : 0) + match + lean;
  };
  const fams = [...groups].map(([id, takes]) => {
    const lead = takes[0];
    const s = Math.max(...takes.map(lookScore)) + 0.6 * random();
    const [lo, hi] = takeFit(lead).energy;
    return { id, takes, lead, s, mid: (lo + hi) / 2, board: opts.categoryOf(lead) === 'board', themes: takeFit(lead).themes };
  });
  type Fam = (typeof fams)[number];
  const byScore = [...fams].sort((x, y) => y.s - x.s);
  const pick = new Set<string>();
  const add = (f: Fam | undefined) => f && pick.size < size + 8 && pick.add(f.id);

  // must-haves: the person's own looks, liked looks and the last plan's looks, and the suggestions
  const keep = new Set(opts.keep ?? []);
  for (const f of fams) if (f.takes.some((p) => p.custom || keep.has(p.id) || suggested.includes(p.id))) add(f);
  const plain = byScore.filter((f) => !f.board);
  // the best matches for the song
  for (const f of plain.slice(0, 12)) add(f);
  // the best few for each kind of part the song has, by fit (a song with a breakdown gets breakdown looks)
  const roles = [...new Set(a.sections.map((x) => roleOf(x.label)))];
  for (const role of roles) {
    const ranked = [...plain].sort((x, y) => fitScore(y.lead, role) + 0.3 * y.s - (fitScore(x.lead, role) + 0.3 * x.s));
    for (const f of ranked.slice(0, 3)) add(f);
  }
  // the quiet end and the loud end
  const byEnergy = [...plain].sort((x, y) => x.mid - y.mid || y.s - x.s);
  for (const f of byEnergy.slice(0, 3)) add(f);
  for (const f of byEnergy.slice(-3)) add(f);
  // every theme gets its best one
  const seen = new Set<string>();
  for (const f of plain) {
    const t = f.themes[0];
    if (!seen.has(t)) {
      seen.add(t);
      add(f);
    }
  }
  // instrument boards for interludes
  for (const f of byScore.filter((f) => f.board).slice(0, 3)) add(f);
  // a few at random from the rest, so takes vary
  const rest = plain.filter((f) => !pick.has(f.id));
  while (pick.size < size && rest.length) add(rest.splice(Math.floor(random() * rest.length), 1)[0]);
  // each chosen family sends its takes that suit the song best (at most TAKES_PER_FAMILY, plus any the
  // person made, likes or used last time), in the app's order
  const send = new Set<Preset>();
  for (const f of fams) {
    if (!pick.has(f.id)) continue;
    const must = f.takes.filter((p) => p.custom || keep.has(p.id) || suggested.includes(p.id));
    const rest = f.takes.filter((p) => !must.includes(p)).sort((x, y) => lookScore(y) - lookScore(x));
    for (const p of [...must, ...rest.slice(0, Math.max(0, TAKES_PER_FAMILY - must.length))]) send.add(p);
  }
  return looks.filter((p) => send.has(p));
}

/** takes per family in a shortlist (the rest of a big family stays home; the wish list sends all) */
export const TAKES_PER_FAMILY = 3;

/** one family's entry in a plan request: its fit, for the server's one-line-per-family catalogue */
export interface FamilyEntry {
  id: string;
  blurb: string;
  themes: string[];
  roles: string[];
  energy: [number, number];
  motion: string;
  pairs: string[];
  clashes: string[];
}

/**
 * The looks of a plan request in the order they go up: each family's takes together, the take that
 * suits this song best first (it's the one a reply naming only the family gets), plus one entry per
 * family with its fit.
 */
export function familyPayload(looks: Preset[], a: TrackAnalysis): { looks: Preset[]; families: FamilyEntry[] } {
  const groups = new Map<string, Preset[]>();
  for (const p of looks) {
    const f = familyIdOf(p);
    (groups.get(f) ?? groups.set(f, []).get(f)!).push(p);
  }
  const rank = (p: Preset) => {
    const r = a.suggestedPresets.indexOf(p.id);
    return r < 0 ? 99 : r;
  };
  const ordered: Preset[] = [];
  const families: FamilyEntry[] = [];
  for (const [id, takes] of groups) {
    const sorted = takes.map((p, i) => ({ p, i })).sort((x, y) => rank(x.p) - rank(y.p) || x.i - y.i).map((x) => x.p);
    ordered.push(...sorted);
    const fam = familyOf(sorted[0]);
    const rel = relationsOf(id);
    families.push({ id, blurb: fam.blurb, themes: fam.fit.themes, roles: fam.fit.roles, energy: fam.fit.energy, motion: fam.fit.motion, pairs: rel.pairs, clashes: rel.clashes });
  }
  return { looks: ordered, families };
}
