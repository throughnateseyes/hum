/**
 * Auto lyrics as a lyric video: a plan that says, per song part, which medium carries the words.
 *
 *   subtitle   the line low (or high) in the frame, sung words brightening: verses, dense parts
 *   big        the line huge, words landing one by one in the song's motion: choruses, drops
 *   cutout     ransom-note clippings: choruses and drops on loud songs, bridges
 *   sparse     only a word or two of each line, small, in a calm corner: builds, intros, breaks
 *   own        the look shows the words itself (typewriter, lyric wall, word cards): overlay stands down
 *
 * plus one-off moments: a single giant word on the biggest drop, a burst of cutouts on one chorus.
 *
 * The local planner (`localLyricPlan`) decides from each part's label, energy, words per second and
 * the look planned there, seeded so every render is different but the song keeps one type family
 * and one motion. Claude's plan can say the same per section (see server/director.ts); its gaps are
 * filled from the local plan. While lyrics play, `chooseForLine` turns the plan into a choice for the
 * line on screen, checking the look actually on screen (shots rotate looks) and its lyric profile.
 */
import { useSyncExternalStore } from 'react';
import type { LyricLine, Lyrics, TrackAnalysis, TrackSection } from '../core/types';
import { treatmentFor, type Treatment } from '../render/lyricAuto';
import { profileFor, type LyricProfile, type Medium } from '../render/lyricProfiles';
import type { VideoPlan } from './plan';

export type LyricMedium = Medium | 'own';
export const LYRIC_MEDIUMS: LyricMedium[] = ['subtitle', 'big', 'cutout', 'sparse', 'own'];
export type LyricMoment = 'giant' | 'burst';
export const LYRIC_MOMENTS: LyricMoment[] = ['giant', 'burst'];
export type TypeFamily = 'grotesk' | 'serif' | 'condensed' | 'mono' | 'rounded' | 'typewriter';
export const TYPE_FAMILIES: TypeFamily[] = ['grotesk', 'serif', 'condensed', 'mono', 'rounded', 'typewriter'];

export interface LyricPart {
  medium: LyricMedium;
  moment?: LyricMoment | null;
  why?: string;
}

export interface LyricPlan {
  seed: number;
  family: TypeFamily;
  motion: Treatment;
  /** per section (null: no words sung there) */
  parts: (LyricPart | null)[];
  source: 'local' | 'claude';
}

export const MEDIUM_NAME: Record<LyricMedium, string> = {
  subtitle: 'Subtitles',
  big: 'Big words',
  cutout: 'Cutouts',
  sparse: 'A word or two',
  own: 'The look’s own lyrics',
};
export const MOMENT_NAME: Record<LyricMoment, string> = { giant: 'one giant word', burst: 'a cutout burst' };
export const FAMILY_NAME: Record<TypeFamily, string> = {
  grotesk: 'grotesk',
  serif: 'display serif',
  condensed: 'condensed',
  mono: 'mono',
  rounded: 'rounded',
  typewriter: 'typewriter',
};

/* ───────────────────────── helpers ───────────────────────── */

/** small seeded random generator (mulberry32) */
export function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T extends string>(w: Partial<Record<T, number>>, r: number): T {
  const entries = Object.entries(w).filter(([, v]) => (v as number) > 0) as [T, number][];
  const total = entries.reduce((a, [, v]) => a + v, 0);
  let acc = r * total;
  for (const [k, v] of entries) {
    acc -= v;
    if (acc < 0) return k;
  }
  return entries[entries.length - 1][0];
}

function sectionAt(sections: TrackSection[], t: number): number {
  for (let i = sections.length - 1; i >= 0; i--) if (t >= sections[i].start) return i;
  return 0;
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** words per second sung in a section, and how many lines start there */
export function vocalDensity(lines: LyricLine[], sec: TrackSection): { wps: number; lines: number } {
  let words = 0;
  let time = 0;
  let n = 0;
  for (const l of lines) {
    if (l.t < sec.start || l.t >= sec.end) continue;
    n++;
    words += wordCount(l.text);
    time += Math.max(0.3, Math.min(l.end, sec.end) - l.t);
  }
  return { wps: time > 0 ? words / time : 0, lines: n };
}

/** type families that suit each motion, most fitting first */
const FAMILIES_FOR: Record<Treatment, TypeFamily[]> = {
  tender: ['serif', 'typewriter', 'grotesk'],
  dreamy: ['serif', 'rounded', 'grotesk'],
  punchy: ['grotesk', 'condensed', 'rounded'],
  aggressive: ['condensed', 'grotesk', 'mono'],
};

/* ───────────────────────── local planner ───────────────────────── */

interface LookInfo {
  /** lyric profile of the main look planned for each section (null: unknown) */
  profiles: (LyricProfile | null)[];
}

/**
 * A lyric plan without Claude. `seed` changes every render; the same seed gives the same plan.
 * `looks` are each section's main look (from the video plan), when there is one.
 */
export function localLyricPlan(a: TrackAnalysis, lyrics: Lyrics | null, seed: number, looks?: LookInfo): LyricPlan {
  const R = seeded(seed);
  const motion = treatmentFor(a).id;
  const fams = FAMILIES_FOR[motion];
  // the fitting family most of the time, a sideways one now and then
  const family = fams[R() < 0.55 ? 0 : R() < 0.7 ? 1 : 2];
  const lines = lyrics?.synced ? lyrics.lines : [];
  const secs = a.sections;
  const loud = motion === 'punchy' || motion === 'aggressive';
  const maxE = Math.max(0.01, ...secs.map((s) => s.energy));
  const strongestDrop = (() => {
    let best = -1;
    // quiet songs only get a giant word on a real drop; loud ones on their biggest moment
    let bestS = loud ? 0 : 0.5;
    for (const d of a.dropInfo ?? a.drops.map((t) => ({ t, strength: 1, why: '' }))) {
      const i = secs.findIndex((s) => Math.abs(s.start - d.t) < 2.5);
      if (i >= 0 && d.strength > bestS && vocalDensity(lines, secs[i]).lines) {
        best = i;
        bestS = d.strength;
      }
    }
    return best;
  })();
  const byGroup = new Map<number, LyricMedium>();
  const lastOfGroup = new Map<number, number>();
  secs.forEach((s, i) => lastOfGroup.set(s.group, i));
  let burstUsed = false;
  let prev: LyricMedium | null = null;
  const parts: (LyricPart | null)[] = secs.map((sec, i) => {
    const dens = vocalDensity(lines, sec);
    if (!dens.lines) return null;
    const prof = looks?.profiles[i] ?? null;
    const e = sec.energy / maxE;
    const why: string[] = [];
    if (prof?.own === 'carries') return { medium: 'own', why: 'the look types the words itself' };
    let medium: LyricMedium;
    const known = byGroup.get(sec.group);
    // a returning part keeps its treatment (the last time it comes back it may escalate)
    if (known && !(lastOfGroup.get(sec.group) === i && i > 0 && R() < 0.35 && (sec.label === 'chorus' || sec.label === 'drop'))) {
      medium = known;
      why.push('same as last time this part came round');
    } else {
      const w: Partial<Record<Medium, number>> = (() => {
        switch (sec.label) {
          case 'verse':
            return { subtitle: 3, sparse: dens.wps < 1.4 ? 1.2 : 0.3, big: e > 0.65 ? 0.9 : 0.3, cutout: 0.25 };
          case 'chorus':
            return { big: 2.5, cutout: loud ? 2 : 0.8, subtitle: 0.4, sparse: 0.2 };
          case 'drop':
            return { big: 2, cutout: loud ? 2 : 0.6, sparse: 0.3 };
          case 'build':
            return { sparse: 3, big: 1, subtitle: 0.4 };
          case 'bridge':
            return { cutout: 1.2, sparse: 1.2, big: 0.8, subtitle: 0.6 };
          case 'break':
            return { sparse: 2, subtitle: 1.5 };
          default:
            return { sparse: 2, subtitle: 2, big: 0.3 };
        }
      })();
      // lots of words fly by: slamming each one in is unreadable, subtitles carry it
      if (dens.wps > 2.6) {
        w.big = (w.big ?? 0) * 0.3;
        w.cutout = (w.cutout ?? 0) * 0.3;
        w.subtitle = (w.subtitle ?? 0.5) * 2;
      } else if (dens.wps < 1) {
        w.big = (w.big ?? 0) * 1.3;
        w.sparse = (w.sparse ?? 0) * 1.3;
      }
      // what the planned look is good for
      if (prof) for (const k of Object.keys(w) as Medium[]) w[k] = (w[k] ?? 0) * (0.15 + prof.suits[k]);
      // variety: a new part tends to change medium
      if (prev && prev !== 'own' && w[prev as Medium] !== undefined) w[prev as Medium] = (w[prev as Medium] ?? 0) * 0.55;
      medium = pickWeighted(w, R());
      why.push(`${sec.label}${dens.wps ? `, ${dens.wps.toFixed(1)} words/s` : ''}`);
    }
    if (!byGroup.has(sec.group)) byGroup.set(sec.group, medium);
    let moment: LyricMoment | null = null;
    if (i === strongestDrop && (loud || R() < 0.6)) moment = 'giant';
    else if (!burstUsed && sec.label === 'chorus' && (loud ? R() < 0.6 : R() < 0.3) && (!prof || prof.suits.cutout > 0.3)) {
      moment = 'burst';
      burstUsed = true;
    }
    prev = medium;
    return { medium, moment, why: why.join('; ') };
  });

  // a lyric video needs at least a couple of mediums: if one took over, give a contrasting part another
  const used = new Set(parts.filter((p): p is LyricPart => !!p && p.medium !== 'own').map((p) => p.medium));
  const sung = parts.filter((p) => p && p.medium !== 'own').length;
  if (used.size < 2 && sung >= 3) {
    const only = [...used][0];
    let at = -1;
    let best = -1;
    parts.forEach((p, i) => {
      if (!p || p.medium === 'own') return;
      const score = only === 'subtitle' ? secs[i].energy : 1 - secs[i].energy;
      if (score > best) {
        best = score;
        at = i;
      }
    });
    if (at >= 0) parts[at] = { ...parts[at]!, medium: only === 'subtitle' ? (loud ? 'cutout' : 'big') : only === 'big' || only === 'cutout' ? 'subtitle' : 'big', why: 'contrast with the rest of the song' };
  }
  return { seed, family, motion, parts, source: 'local' };
}

/** Claude's per-section lyric choices over the local plan (anything missing or unusable stays local) */
export function mergeLyricPlan(local: LyricPlan, claude: { family?: TypeFamily | null; parts: (LyricPart | null)[] } | null): LyricPlan {
  if (!claude || !claude.parts.some(Boolean)) return local;
  return {
    ...local,
    family: claude.family ?? local.family,
    parts: local.parts.map((p, i) => (p ? (claude.parts[i] ? { ...claude.parts[i]!, moment: claude.parts[i]!.moment ?? null } : p) : null)),
    source: 'claude',
  };
}

/* ───────────────────────── while lyrics play ───────────────────────── */

const localCache = new WeakMap<TrackAnalysis, { lyrics: Lyrics | null; plan: LyricPlan }>();

/** the lyric plan in force: the playing video plan's, else one made up for this song (once per load) */
export function lyricPlanNow(o: { analysis: TrackAnalysis | null; lyrics: Lyrics | null; plan: VideoPlan | null; planOn: boolean }): LyricPlan | null {
  const a = o.analysis;
  if (!a?.sections.length) return null;
  const p = o.plan;
  if (p?.lyricPlan && o.planOn && p.looks.length === a.sections.length && Math.abs(p.duration - a.duration) < 0.5) return p.lyricPlan;
  const hit = localCache.get(a);
  if (hit && hit.lyrics === o.lyrics) return hit.plan;
  const plan = localLyricPlan(a, o.lyrics, (Math.random() * 2 ** 31) | 0);
  localCache.set(a, { lyrics: o.lyrics, plan });
  return plan;
}

export interface LyricChoice {
  medium: LyricMedium;
  moment: LyricMoment | null;
  family: TypeFamily;
  motion: Treatment;
  section: number;
  /** seed for this line's variations (size, case, corner) */
  seed: number;
  why: string;
}

/**
 * What to do with line `li`: the section's planned medium, adjusted to the look on screen.
 * `look` is that look's lyric profile; `show` is the "Show anyway" setting for lyric looks.
 */
export function chooseForLine(plan: LyricPlan, a: TrackAnalysis, lines: LyricLine[], li: number, look: LyricProfile, show: boolean): LyricChoice {
  const line = lines[li];
  const si = sectionAt(a.sections, line.t);
  const sec = a.sections[si];
  const part = plan.parts[si] ?? { medium: sec.label === 'chorus' || sec.label === 'drop' ? 'big' : 'subtitle' };
  const base = { family: plan.family, motion: plan.motion, section: si, seed: (plan.seed ^ (li * 2654435761)) >>> 0 };
  if (look.own === 'carries' && !show) return { ...base, medium: 'own', moment: null, why: 'this look shows the words itself' };
  let medium = part.medium;
  let why = part.why ?? '';
  if (medium === 'own') {
    // planned for a lyric look, but the shot rotated to one that doesn't show words
    medium = look.suits.subtitle >= look.suits.sparse ? 'subtitle' : 'sparse';
    why = 'the look on screen doesn’t show the words';
  }
  if (look.suits[medium as Medium] < 0.2) {
    const order: Medium[] = medium === 'big' ? ['cutout', 'sparse', 'subtitle'] : medium === 'cutout' ? ['big', 'subtitle', 'sparse'] : medium === 'sparse' ? ['subtitle', 'big'] : ['sparse', 'big'];
    const alt = order.find((m) => look.suits[m] >= 0.2) ?? 'subtitle';
    why = `${MEDIUM_NAME[medium]} would fight this look`;
    medium = alt;
  }
  // moments land on one line: the giant word on the first line of the drop, the burst on a chorus line
  let moment: LyricMoment | null = null;
  if (part.moment) {
    let first = -1;
    let count = 0;
    for (let k = 0; k < lines.length; k++) {
      if (lines[k].t >= sec.start && lines[k].t < sec.end) {
        if (first < 0) first = k;
        count++;
      }
    }
    const at = part.moment === 'giant' ? first : first + (count > 2 ? 1 + (plan.seed % Math.min(3, count - 1)) : 0);
    if (li === at && (part.moment !== 'burst' || look.suits.cutout >= 0.2)) moment = part.moment;
  }
  return { ...base, medium, moment, why };
}

/* ───────────────────────── what Auto is doing now (for the lyrics chip) ───────────────────────── */

export interface LyricNow {
  medium: LyricMedium | null;
  moment: LyricMoment | null;
  family: TypeFamily | null;
  section: string;
  why: string;
  /** backing the legibility guard is using */
  backing: string;
  source: 'local' | 'claude' | null;
}

let now: LyricNow = { medium: null, moment: null, family: null, section: '', why: '', backing: 'none', source: null };
const subs = new Set<() => void>();

export function setLyricNow(next: LyricNow) {
  if (next.medium === now.medium && next.moment === now.moment && next.family === now.family && next.section === now.section && next.backing === now.backing && next.why === now.why && next.source === now.source) return;
  now = next;
  for (const f of subs) f();
}

export function useLyricNow(): LyricNow {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => now,
  );
}

/** compact description of a plan for the chat / tooltip: "Verse: Subtitles · Chorus: Big words…" */
export function describeLyricPlan(plan: LyricPlan, names: string[]): string {
  const seen = new Set<string>();
  const bits: string[] = [];
  plan.parts.forEach((p, i) => {
    if (!p) return;
    const k = `${names[i].replace(/ \d+$/, '')}:${p.medium}`;
    if (seen.has(k)) return;
    seen.add(k);
    bits.push(`${names[i].replace(/ \d+$/, '')}: ${MEDIUM_NAME[p.medium].toLowerCase()}${p.moment ? ` + ${MOMENT_NAME[p.moment]}` : ''}`);
  });
  return `${FAMILY_NAME[plan.family]} type · ${bits.join(' · ')}`;
}

/** profile of the look on screen (re-exported for the layer) */
export { profileFor };
