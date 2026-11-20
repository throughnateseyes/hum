/**
 * Look families at runtime: who belongs to which family, each family's fit (curated in families.ts,
 * inferred from tags for anything new), and the scores the planner, the library and the director use:
 *
 *   fitScore(look, label, energy)   how well a look suits a part of the song (-3 … 1.5)
 *   neighbourScore(a, b)            how well two looks sit next to each other (siblings, pairs, clashes)
 *   takeFit(look)                   a take's own fit: its family's, with the energy shifted by its tags
 *
 * Nothing here changes look ids; a family is a grouping over them.
 */
import { lookStyle, type StyleId } from '../core/styles';
import type { LookFit, LookMotion, LookRole, LookTheme, Preset, TrackSection } from '../core/types';
import { FAMILY_TABLE } from './families';
import { PRESETS } from './library';

export interface LookFamily {
  id: string;
  name: string;
  blurb: string;
  fit: LookFit;
  /** built-in takes in display order, lead first (custom takes come from `withCustom`) */
  takes: Preset[];
  /** no curated entry: its fit was inferred from tags */
  inferred: boolean;
}

/* ───────── vocabularies (the library's filters use these labels) ───────── */

export const ROLES: { id: LookRole; label: string; hint: string }[] = [
  { id: 'intro', label: 'Intro', hint: 'Opens the song: sets the place, leaves room' },
  { id: 'verse', label: 'Verse', hint: 'The body of the song: holds attention without peaking' },
  { id: 'build', label: 'Build-up', hint: 'The come-up: tension, tightening, something about to happen' },
  { id: 'peak', label: 'Drop & chorus', hint: 'The release: the biggest, brightest moments' },
  { id: 'break', label: 'Breakdown', hint: 'The floor drops out: space, air, a breath' },
  { id: 'bridge', label: 'Bridge', hint: 'A new chapter before the last chorus' },
  { id: 'outro', label: 'Outro', hint: 'Lets the song go' },
];

export const THEMES: { id: LookTheme; label: string; hint: string }[] = [
  { id: 'nature', label: 'Nature', hint: 'Sky, water, plants and creatures' },
  { id: 'city', label: 'Night city', hint: 'Towers, trains, streetlight and screens after dark' },
  { id: 'club', label: 'Club', hint: 'Dark rooms, chrome, tunnels and bass' },
  { id: 'light', label: 'Light', hint: 'Glow, glass, silk, liquid and crystal' },
  { id: 'paper', label: 'Paper', hint: 'Print, riso, halftone, cut paper and ink' },
  { id: 'graphic', label: 'Graphic', hint: 'Bold shapes, toys, cubes and confetti' },
  { id: 'type', label: 'Type', hint: 'Words are the picture: lyric walls, posters, cards' },
  { id: 'retro', label: 'Retro tech', hint: 'Old computers, CRTs, pixel art and games' },
  { id: 'data', label: 'Data', hint: 'Scans, read-outs, contours and machine vision' },
  { id: 'photo', label: 'Photo', hint: 'Your photos, taken apart by the music' },
  { id: 'board', label: 'Boards', hint: 'Instrument sheets: many small modules reading the song' },
];

const ROLE_BY_LABEL: Record<TrackSection['label'], LookRole> = {
  intro: 'intro',
  verse: 'verse',
  chorus: 'peak',
  drop: 'peak',
  build: 'build',
  break: 'break',
  bridge: 'bridge',
  outro: 'outro',
};
export const roleOf = (label: TrackSection['label']): LookRole => ROLE_BY_LABEL[label];

/* ───────── membership ───────── */

const tableFamilyOf = new Map<string, string>();
const tableTakeName = new Map<string, string>();
for (const [fid, def] of Object.entries(FAMILY_TABLE)) {
  for (const [id, name] of Object.entries(def.takes ?? { [fid]: '' })) {
    tableFamilyOf.set(id, fid);
    if (name) tableTakeName.set(id, name);
  }
}

/** the family id of a look: its own `family`, else the table's, else its own id */
export function familyIdOf(p: Pick<Preset, 'id' | 'family'>): string {
  return p.family ?? tableFamilyOf.get(p.id) ?? p.id;
}

/** a take's short name inside its family ("Moonlight"); one-take families use the look's name */
export function takeName(p: Preset): string {
  return p.variant ?? tableTakeName.get(p.id) ?? p.name;
}

/* ───────── inference (looks without curated fit) ───────── */

const LOUD = ['heavy', 'aggressive', 'intense', 'dubstep', 'glitch', 'euphoric', 'energetic', 'driving', 'techno', 'trance', 'fast', 'bold'];
const SOFT = ['calm', 'minimal', 'sad', 'dreamy', 'ambient', 'tender', 'spacious', 'slow', 'melancholic', 'piano'];
/** loud tags minus soft tags */
export const tagIntensity = (tags: string[]) => tags.filter((t) => LOUD.includes(t)).length - tags.filter((t) => SOFT.includes(t)).length;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const STYLE_THEME: Record<StyleId, LookTheme> = {
  world: 'nature',
  light: 'light',
  particles: 'light',
  form: 'graphic',
  print: 'paper',
  type: 'type',
  data: 'data',
  photo: 'photo',
  board: 'board',
};
const TAG_THEME: [string[], LookTheme][] = [
  [['nature', 'organic', 'rain', 'ocean', 'forest', 'sky'], 'nature'],
  [['city', 'urban', 'neon', 'synthwave', 'night'], 'city'],
  [['dubstep', 'techno', 'trance', 'club', 'bass', 'industrial'], 'club'],
  [['lyrics', 'typographic'], 'type'],
  [['photo'], 'photo'],
  [['retro', 'pixel', '8-bit', 'vhs'], 'retro'],
  [['tactile', 'paper', 'riso', 'print', 'ink'], 'paper'],
  [['glitch', 'data', 'hud', 'scan'], 'data'],
  [['graphic', 'playful', 'bold'], 'graphic'],
];

/** fit worked out from a look's tags and style, for looks nobody has judged yet */
export function inferFit(tags: string[], style: StyleId): LookFit {
  const t = tags.map((x) => x.toLowerCase());
  const lvl = tagIntensity(t);
  const centre = clamp(0.45 + 0.09 * lvl, 0.12, 0.88);
  const energy: [number, number] = [Math.max(0, +(centre - 0.22).toFixed(2)), Math.min(1, +(centre + 0.22).toFixed(2))];
  const has = (...xs: string[]) => xs.some((x) => t.includes(x));
  const motion: LookMotion =
    lvl >= 3 || (has('heavy', 'aggressive') && lvl >= 1)
      ? 'explosive'
      : has('bouncy', 'rhythmic', 'driving', 'energetic', 'upbeat') || lvl > 0
        ? 'pulsing'
        : has('minimal', 'still') && lvl <= -2
          ? 'still'
          : 'drifting';
  const roles: LookRole[] =
    centre < 0.3 ? ['intro', 'break', 'outro', 'verse'] : centre < 0.5 ? ['verse', 'intro', 'bridge', 'break'] : centre < 0.7 ? ['verse', 'build', 'peak'] : ['peak', 'build'];
  const themes: LookTheme[] = [STYLE_THEME[style]];
  for (const [words, theme] of TAG_THEME) if (themes.length < 2 && !themes.includes(theme) && has(...words)) themes.push(theme);
  return { roles, energy, motion, themes, pairs: [], clashes: [] };
}

/* ───────── families ───────── */

let builtin: LookFamily[] | null = null;
let byId = new Map<string, LookFamily>();
const pairsOf = new Map<string, Set<string>>();
const clashesOf = new Map<string, Set<string>>();

const link = (m: Map<string, Set<string>>, a: string, b: string) => {
  if (a === b) return;
  (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
  (m.get(b) ?? m.set(b, new Set()).get(b)!).add(a);
};

function fitFor(id: string, takes: Preset[]): { fit: LookFit; inferred: boolean } {
  const def = FAMILY_TABLE[id];
  const lead = takes[0];
  const tags = [...new Set(takes.flatMap((p) => p.tags))];
  const guess = inferFit(tags, lead ? lookStyle(lead) : 'light');
  const own = !def && lead?.fit ? lead.fit : undefined;
  const src = def ?? own;
  const fit: LookFit = {
    roles: src?.roles?.length ? src.roles : guess.roles,
    energy: src?.energy ?? guess.energy,
    motion: src?.motion ?? guess.motion,
    themes: src?.themes?.length ? src.themes : guess.themes,
    pairs: src?.pairs ?? [],
    clashes: src?.clashes ?? [],
  };
  return { fit, inferred: !def && !(own?.roles && own.energy && own.motion) };
}

/** every built-in family, in library order (the order their first take appears in PRESETS) */
export function allFamilies(): LookFamily[] {
  if (builtin) return builtin;
  const groups = new Map<string, Preset[]>();
  for (const p of PRESETS) {
    const f = familyIdOf(p);
    (groups.get(f) ?? groups.set(f, []).get(f)!).push(p);
  }
  const out: LookFamily[] = [];
  for (const [id, list] of groups) {
    // takes in the table's order first, then any that joined by naming the family themselves
    const order = Object.keys(FAMILY_TABLE[id]?.takes ?? {});
    const takes = [...list].sort((a, b) => {
      const i = order.indexOf(a.id);
      const j = order.indexOf(b.id);
      return (i < 0 ? 999 : i) - (j < 0 ? 999 : j);
    });
    const def = FAMILY_TABLE[id];
    const { fit, inferred } = fitFor(id, takes);
    out.push({ id, name: def?.name ?? takes[0].name, blurb: def?.blurb ?? takes[0].description, fit, takes, inferred });
  }
  builtin = out;
  byId = new Map(out.map((f) => [f.id, f]));
  for (const f of out) {
    for (const o of f.fit.pairs) link(pairsOf, f.id, o);
    for (const o of f.fit.clashes) link(clashesOf, f.id, o);
  }
  if (import.meta.env?.DEV) {
    // a typo in the table silently drops a take or a pair, so say so while developing
    const known = new Set(PRESETS.map((p) => p.id));
    for (const [fid, def] of Object.entries(FAMILY_TABLE)) {
      for (const id of Object.keys(def.takes ?? { [fid]: '' })) if (!known.has(id)) console.warn(`[families] ${fid}: no look "${id}"`);
      for (const o of [...(def.pairs ?? []), ...(def.clashes ?? [])]) if (!byId.has(o)) console.warn(`[families] ${fid}: no family "${o}"`);
    }
  }
  return out;
}

export function familyById(id: string): LookFamily | undefined {
  allFamilies();
  return byId.get(id);
}

/** the built-in family whose lead runs on this scene (custom looks borrow its fit) */
function sceneFamily(sceneId: string): LookFamily | undefined {
  return allFamilies().find((f) => f.takes.some((p) => p.sceneId === sceneId));
}

/**
 * The family a new custom look should join: the family of the look it was made from when it's on the
 * same scene, else the one family built on its scene (none when a scene has several families or none).
 */
export function familyForNew(sceneId: string, from?: Preset): string | undefined {
  if (from && from.sceneId === sceneId) return familyById(familyIdOf(from)) ? familyIdOf(from) : undefined;
  const on = allFamilies().filter((f) => f.takes.some((p) => p.sceneId === sceneId));
  return on.length === 1 ? on[0].id : undefined;
}

const customFamilies = new WeakMap<Preset, LookFamily>();

/** the family a look belongs to; a custom look outside any family gets one of its own (fit from its scene's family) */
export function familyOf(p: Preset): LookFamily {
  const hit = familyById(familyIdOf(p));
  if (hit) return hit;
  let f = customFamilies.get(p);
  if (!f) {
    const borrowed = sceneFamily(p.sceneId);
    const fit = borrowed && !p.fit ? borrowed.fit : fitFor(p.id, [p]).fit;
    f = { id: familyIdOf(p), name: p.name, blurb: p.description, fit, takes: [p], inferred: !borrowed };
    customFamilies.set(p, f);
  }
  return f;
}

/** families with the person's own takes added to the families they were saved into */
export function withCustom(custom: Preset[]): { families: LookFamily[]; loose: Preset[] } {
  const extra = new Map<string, Preset[]>();
  const loose: Preset[] = [];
  for (const p of custom) {
    const f = p.family && familyById(p.family);
    if (f) (extra.get(f.id) ?? extra.set(f.id, []).get(f.id)!).push(p);
    else loose.push(p);
  }
  const families = allFamilies().map((f) => (extra.has(f.id) ? { ...f, takes: [...f.takes, ...extra.get(f.id)!] } : f));
  return { families, loose };
}

/* ───────── scores ───────── */

const takeFits = new WeakMap<Preset, LookFit>();

/**
 * A take's own fit: its family's, with the energy range shifted by how loud this take's tags are
 * compared with its siblings' (Toy Box sits higher than Sorbet), at most ±0.15.
 */
export function takeFit(p: Preset): LookFit {
  let f = takeFits.get(p);
  if (f) return f;
  const fam = familyOf(p);
  const sibs = fam.takes.length > 1 ? fam.takes : [];
  let shift = 0;
  if (sibs.length) {
    const mean = sibs.reduce((s, x) => s + tagIntensity(x.tags), 0) / sibs.length;
    shift = clamp((tagIntensity(p.tags) - mean) * 0.05, -0.15, 0.15);
  }
  const [lo, hi] = fam.fit.energy;
  f = { ...fam.fit, energy: [clamp(lo + shift, 0, 1), clamp(hi + shift, 0, 1)] };
  takeFits.set(p, f);
  return f;
}

/** what a part wants from a look's motion (added to the fit score) */
const MOTION_FOR: Record<LookRole, Record<LookMotion, number>> = {
  intro: { still: 0.3, drifting: 0.3, pulsing: 0, explosive: -0.6 },
  verse: { still: 0, drifting: 0.15, pulsing: 0.2, explosive: -0.3 },
  build: { still: -0.4, drifting: 0, pulsing: 0.3, explosive: 0.15 },
  peak: { still: -0.7, drifting: -0.1, pulsing: 0.25, explosive: 0.45 },
  break: { still: 0.3, drifting: 0.3, pulsing: -0.1, explosive: -0.6 },
  bridge: { still: 0.1, drifting: 0.2, pulsing: 0.1, explosive: -0.2 },
  outro: { still: 0.4, drifting: 0.3, pulsing: -0.1, explosive: -0.7 },
};
/** the energy a part usually has, when the section's own isn't known */
export const ROLE_ENERGY: Record<LookRole, number> = { intro: 0.25, verse: 0.45, build: 0.6, peak: 0.85, break: 0.25, bridge: 0.4, outro: 0.2 };

/**
 * How well a look suits a part of the song: its role list (best first), whether the part's energy sits
 * in its range, and its motion. About 1.5 for a perfect fit, 0 for neutral, below -1 for a poor one.
 */
export function fitScore(p: Preset, label: TrackSection['label'] | LookRole, energy?: number): number {
  const role = (label in ROLE_BY_LABEL ? ROLE_BY_LABEL[label as TrackSection['label']] : label) as LookRole;
  const f = takeFit(p);
  const k = f.roles.indexOf(role);
  const roleS = k === 0 ? 1 : k > 0 ? 0.8 - 0.12 * k : -0.5;
  const e = energy ?? ROLE_ENERGY[role];
  const [lo, hi] = f.energy;
  const dist = e < lo ? lo - e : e > hi ? e - hi : 0;
  return roleS - 2.5 * dist + MOTION_FOR[role][f.motion];
}

/**
 * How well two looks sit next to each other: takes of the same family score low (with Song colours on
 * they look almost alike, so the change doesn't show), curated pairs high, clashes very low, and a
 * shared theme a little.
 */
export function neighbourScore(a: Preset, b: Preset): number {
  allFamilies();
  const fa = familyIdOf(a);
  const fb = familyIdOf(b);
  if (fa === fb) return -0.8;
  if (clashesOf.get(fa)?.has(fb)) return -1.6;
  let s = pairsOf.get(fa)?.has(fb) ? 1 : 0;
  const ta = takeFit(a).themes;
  if (takeFit(b).themes.some((t) => ta.includes(t))) s += 0.35;
  return s;
}

/** the families a family pairs with / clashes with (both directions) */
export function relationsOf(familyId: string): { pairs: string[]; clashes: string[] } {
  allFamilies();
  return { pairs: [...(pairsOf.get(familyId) ?? [])], clashes: [...(clashesOf.get(familyId) ?? [])] };
}

/* ───────── which take a family card plays ───────── */

const TAKES_KEY = 'hum.takes.v1';
let remembered: Record<string, string> = {};
try {
  remembered = JSON.parse(localStorage.getItem(TAKES_KEY) ?? '{}') ?? {};
} catch {
  remembered = {};
}

/** remember the take last used in a family, so its card plays that one next time */
export function rememberTake(p: Preset) {
  const f = familyIdOf(p);
  if (remembered[f] === p.id) return;
  remembered[f] = p.id;
  try {
    localStorage.setItem(TAKES_KEY, JSON.stringify(remembered));
  } catch {
    /* storage full or blocked: memory only */
  }
}

/** the take a family card plays: the one that ranks best for the song, else the last one used, else the lead */
export function bestTake(f: LookFamily, suggested: string[] = []): Preset {
  let best: Preset | undefined;
  let rank = Infinity;
  for (const p of f.takes) {
    const r = suggested.indexOf(p.id);
    if (r >= 0 && r < rank) {
      rank = r;
      best = p;
    }
  }
  return best ?? f.takes.find((p) => p.id === remembered[f.id]) ?? f.takes[0];
}
