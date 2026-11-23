/**
 * Taste memory: what the person keeps and skips, remembered in this browser (localStorage) so Hum's
 * choices get sharper with use. Nothing here leaves the browser except `tasteSummary`, a short list of
 * look ids, tags and counts that goes along with a "Make a video" request the person started.
 *
 * Signals, strongest first:
 *   Keep (♥, K)          +1    the look on screen right now, in this part of this song
 *   Skip (✕, X)          −1    and Hum moves on to another look
 *   placed on a part     +0.7  a look dragged onto the timeline
 *   picked by hand       +0.4  a look clicked in the library
 *   replaced quickly     −0.35 a look Hum put up that the person swapped out within a few seconds
 *
 * Each reaction keeps its context (section label, the song's genre, mood and energy, the transition and
 * lyric style in use), so "likes Paper looks on choruses" and "skips Glyph on tender songs" can both be
 * true. Recent reactions count most: a reaction loses half its weight every 30 days, and only the
 * newest 300 are kept.
 */
import { create } from 'zustand';
import type { Preset, TrackAnalysis, TrackSection } from '../core/types';
import { audioEngine } from '../audio/engine';
import { PRESETS } from '../presets';
import { useStudio } from './store';
import { mayPlanId } from '../director/footage';

export type TasteKind = 'keep' | 'skip' | 'place' | 'pick' | 'replace';
type Label = TrackSection['label'];
type Energy = 'calm' | 'steady' | 'loud';

export interface Reaction {
  look: string;
  tags: string[];
  kind: TasteKind;
  /** signed weight */
  w: number;
  /** ms since epoch */
  at: number;
  label?: Label;
  genre?: string;
  mood?: string;
  energy?: Energy;
  transition?: string;
  lyric?: string;
}

export interface TasteContext {
  label?: Label;
  genre?: string;
  mood?: string;
  energy?: Energy;
}

interface TasteFile {
  v: 1;
  on: boolean;
  reactions: Reaction[];
  /** song key → signatures of its last few plans, newest last */
  plans: Record<string, string[]>;
}

const KEY = 'hum.taste.v1';
const MAX_REACTIONS = 300;
const MAX_SONGS = 30;
const PLANS_PER_SONG = 5;
const HALF_LIFE_MS = 30 * 24 * 3600 * 1000;
/** share of picks that ignore taste on purpose, so Hum still surprises */
export const EXPLORE = 0.2;

const WEIGHT: Record<TasteKind, number> = { keep: 1, skip: -1, place: 0.7, pick: 0.4, replace: -0.35 };

function load(): TasteFile {
  const empty: TasteFile = { v: 1, on: true, reactions: [], plans: {} };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!raw || raw.v !== 1 || !Array.isArray(raw.reactions)) return empty;
    return {
      v: 1,
      on: raw.on !== false,
      reactions: raw.reactions.filter((r: Reaction) => r && typeof r.look === 'string' && typeof r.w === 'number' && typeof r.at === 'number').slice(-MAX_REACTIONS),
      plans: raw.plans && typeof raw.plans === 'object' ? raw.plans : {},
    };
  } catch {
    return empty;
  }
}

function save(f: TasteFile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    /* storage full or blocked: taste just isn't remembered */
  }
}

export const useTaste = create<TasteFile>(() => load());

const persist = (patch: Partial<TasteFile>) => {
  useTaste.setState(patch);
  save(useTaste.getState());
};

/* ───────────────────────── context ───────────────────────── */

const lookById = (id: string | null | undefined): Preset | undefined =>
  id ? useStudio.getState().customPresets.find((p) => p.id === id) ?? PRESETS.find((p) => p.id === id) : undefined;

const word = (v: string | undefined) => (v ? v.toLowerCase().replace(/[^a-z0-9 &'-]/g, '').trim().slice(0, 24) || undefined : undefined);

/** the song's genre, mood and energy (no section) */
export function songContext(a: TrackAnalysis | null | undefined): TasteContext {
  if (!a) return {};
  const arousal = a.mood?.arousal ?? 0.5;
  return {
    genre: word(a.character?.genre),
    mood: word(a.character?.mood ?? a.tags?.[0]),
    energy: arousal < 0.38 ? 'calm' : arousal > 0.66 ? 'loud' : 'steady',
  };
}

/** context for a section label of the loaded song */
export function contextFor(label?: Label): TasteContext {
  return { ...songContext(useStudio.getState().analysis), ...(label ? { label } : {}) };
}

/** the part of the song playing right now */
function labelNow(): Label | undefined {
  const a = useStudio.getState().analysis;
  if (!a?.sections.length || audioEngine.kind !== 'file') return undefined;
  const t = audioEngine.currentTime;
  let i = 0;
  for (let k = a.sections.length - 1; k >= 0; k--)
    if (t >= a.sections[k].start) {
      i = k;
      break;
    }
  return a.sections[i].label;
}

/** the transition and lyric treatment in use (best effort) */
let currentTransition: () => string | undefined = () => {
  const tr = useStudio.getState().transition;
  return tr === 'auto' ? undefined : tr;
};
/** plan.ts tells taste which transition the playing shot uses */
export function setTransitionProbe(fn: () => string | undefined) {
  currentTransition = fn;
}

function lyricNow(): string | undefined {
  const s = useStudio.getState();
  return s.lyrics?.synced && s.lyricStyle !== 'off' ? s.lyricStyle : undefined;
}

/* ───────────────────────── recording ───────────────────────── */

/** told about every Keep, learning on or off (a Keep also likes the shot playing: flatPlan.ts) */
let keepHook: (lookId: string) => void = () => {};
export function onKeep(fn: (lookId: string) => void) {
  keepHook = fn;
}

export function record(kind: TasteKind, lookId: string, label: Label | undefined = labelNow()) {
  if (kind === 'keep') keepHook(lookId);
  const f = useTaste.getState();
  if (!f.on) return;
  const p = lookById(lookId);
  if (!p) return;
  const now = Date.now();
  const last = f.reactions[f.reactions.length - 1];
  // a double press, or the same signal twice in a row, counts once
  if (last && last.look === lookId && last.kind === kind && now - last.at < 2500) return;
  const r: Reaction = {
    look: p.id,
    tags: p.tags.slice(0, 10),
    kind,
    w: WEIGHT[kind],
    at: now,
    ...contextFor(label),
  };
  const tr = currentTransition();
  if (tr) r.transition = tr;
  const ly = lyricNow();
  if (ly) r.lyric = ly;
  persist({ reactions: [...f.reactions, r].slice(-MAX_REACTIONS) });
  // the person has already said what they think of the look on screen: no implicit signal on top
  if (onScreen?.id === p.id && kind !== 'replace') onScreen.byHand = true;
}

/* implicit: hand picks, and looks Hum put up that the person swaps out within seconds */

let onScreen: { id: string; since: number; byHand: boolean } | null = null;
let handPending: string | null = null;
const QUICK_MS = 6000;

/** a look the person chose themselves: 'pick' from the library, 'place' onto a part, 'browse' for arrow keys (no credit) */
export function noteHandPick(p: Preset, how: 'pick' | 'place' | 'browse', label?: Label) {
  if (how !== 'browse') record(how, p.id, label);
  // the look Hum chose gets a small minus when the person replaces it this fast
  if (onScreen && !onScreen.byHand && onScreen.id !== p.id && Date.now() - onScreen.since < QUICK_MS && how !== 'place') record('replace', onScreen.id);
  handPending = p.id;
}

useStudio.subscribe((s, prev) => {
  if (s.presetId === prev.presetId || !s.presetId) return;
  onScreen = { id: s.presetId, since: Date.now(), byHand: handPending === s.presetId };
  handPending = null;
});

/* ───────────────────────── reading taste ───────────────────────── */

const decay = (at: number, now: number) => Math.pow(0.5, Math.max(0, now - at) / HALF_LIFE_MS);

function contextMatch(r: Reaction, ctx: TasteContext): number {
  const lab = ctx.label ? (r.label === ctx.label ? 1 : r.label ? 0.4 : 0.7) : 0.75;
  const hasSong = !!(ctx.genre || ctx.mood || ctx.energy);
  const song = !hasSong
    ? 0.8
    : (ctx.genre && r.genre === ctx.genre) || (ctx.mood && r.mood === ctx.mood)
    ? 1
    : ctx.energy && r.energy === ctx.energy
    ? 0.8
    : 0.55;
  return lab * song;
}

/**
 * How much the person likes a look here, −1 … 1 (0 = no idea, or learning is off). Reactions on the
 * look itself count most; reactions on looks that share its tags count a little.
 */
export function affinity(lookId: string, ctx: TasteContext = {}): number {
  const f = useTaste.getState();
  if (!f.on || !f.reactions.length) return 0;
  const p = lookById(lookId);
  if (!p) return 0;
  const now = Date.now();
  let direct = 0;
  let near = 0;
  for (const r of f.reactions) {
    const v = r.w * decay(r.at, now) * contextMatch(r, ctx);
    if (r.look === p.id) direct += v;
    else {
      const shared = r.tags.filter((t) => p.tags.includes(t)).length;
      if (shared) near += (v * shared) / Math.max(3, r.tags.length);
    }
  }
  return Math.tanh(0.5 * direct + 0.15 * near);
}

/** a scorer for a whole batch of looks in one context (same as `affinity`, cached per look) */
export function affinityIn(ctx: TasteContext): (id: string) => number {
  const memo = new Map<string, number>();
  return (id) => {
    let v = memo.get(id);
    if (v === undefined) memo.set(id, (v = affinity(id, ctx)));
    return v;
  };
}

export const tasteOn = () => useTaste.getState().on;
export const hasTaste = () => useTaste.getState().on && useTaste.getState().reactions.length > 0;

/* ───────────────────────── variety ───────────────────────── */

/** small seeded random generator (mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a song's identity for remembering its plans (length and tempo, nothing personal) */
export const songKey = (a: TrackAnalysis) => `${Math.round(a.duration)}s-${Math.round(a.bpm)}bpm-${a.sections.length}`;

/** what makes two plans the same: the main look and rotation of every section */
export const planSignature = (p: { looks: (string | null)[]; rotate?: (string[] | null)[]; interludes?: (string | null)[] }) =>
  p.looks.map((id, i) => `${id ?? '-'}+${(p.rotate?.[i] ?? []).join('/')}${p.interludes?.[i] ? `^${p.interludes[i]}` : ''}`).join(',');

export function recentPlans(a: TrackAnalysis): string[] {
  return useTaste.getState().plans[songKey(a)] ?? [];
}

/** remember a plan made for this song (kept even with learning off, so renders still vary) */
export function rememberPlan(a: TrackAnalysis, sig: string) {
  const f = useTaste.getState();
  const k = songKey(a);
  const list = [...(f.plans[k] ?? []).filter((x) => x !== sig), sig].slice(-PLANS_PER_SONG);
  const plans = { ...f.plans };
  delete plans[k];
  plans[k] = list;
  const keys = Object.keys(plans);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SONGS))) delete plans[old];
  persist({ plans });
}

/** the main looks of the last plan made for this song */
export function lastPlanLooks(a: TrackAnalysis): string[] {
  const sig = recentPlans(a).slice(-1)[0];
  if (!sig) return [];
  return [...new Set(sig.split(',').map((x) => x.split('+')[0]).filter((x) => x && x !== '-'))];
}

/* ───────────────────────── what's been learned ───────────────────────── */

const LABEL_WORD: Record<Label, string> = {
  intro: 'intros',
  verse: 'verses',
  chorus: 'choruses',
  bridge: 'bridges',
  build: 'builds',
  drop: 'drops',
  break: 'breaks',
  outro: 'outros',
};
/** tags too generic to say anything about taste */
const BORING = new Set(['photo', 'board', 'abstract', 'pop', 'electronic', 'any']);

interface Agg {
  score: number;
  n: number;
  where: Map<string, number>;
}
function aggregate(key: (r: Reaction) => string[], now = Date.now()): Map<string, Agg> {
  const out = new Map<string, Agg>();
  for (const r of useTaste.getState().reactions) {
    const v = r.w * decay(r.at, now);
    for (const k of key(r)) {
      const a = out.get(k) ?? { score: 0, n: 0, where: new Map() };
      a.score += v;
      a.n++;
      if (r.label) a.where.set(r.label, (a.where.get(r.label) ?? 0) + v);
      out.set(k, a);
    }
  }
  return out;
}
const topWhere = (a: Agg, sign: 1 | -1): Label | undefined => {
  const best = [...a.where.entries()].sort((x, y) => sign * (y[1] - x[1]))[0];
  return best && sign * best[1] > 0.3 ? (best[0] as Label) : undefined;
};

export interface TasteLine {
  sign: 1 | -1;
  text: string;
}

/** what Hum has learned, in plain words, strongest first */
export function tasteLines(max = 8): TasteLine[] {
  const lines: (TasteLine & { s: number })[] = [];
  const looks = aggregate((r) => [r.look]);
  for (const [id, a] of looks) {
    if (Math.abs(a.score) < 0.6) continue;
    const name = lookById(id)?.name ?? id;
    const sign = a.score > 0 ? 1 : -1;
    const w = topWhere(a, sign);
    lines.push({ sign, s: Math.abs(a.score) + 0.2, text: `${sign > 0 ? 'Likes' : 'Skips'} ${name}${w ? ` on ${LABEL_WORD[w]}` : ''}` });
  }
  // tags by section and by kind of song
  const byPart = aggregate((r) => (r.label ? r.tags.filter((t) => !BORING.has(t)).map((t) => `${t}|${r.label}`) : []));
  for (const [k, a] of byPart) {
    if (Math.abs(a.score) < 1.2 || a.n < 2) continue;
    const [tag, label] = k.split('|');
    lines.push({ sign: a.score > 0 ? 1 : -1, s: Math.abs(a.score) * 0.7, text: `${a.score > 0 ? 'Likes' : 'Skips'} ${tag} looks on ${LABEL_WORD[label as Label]}` });
  }
  const bySong = aggregate((r) => (r.mood ? r.tags.filter((t) => !BORING.has(t)).map((t) => `${t}|${r.mood}`) : []));
  for (const [k, a] of bySong) {
    if (Math.abs(a.score) < 1.2 || a.n < 2) continue;
    const [tag, mood] = k.split('|');
    lines.push({ sign: a.score > 0 ? 1 : -1, s: Math.abs(a.score) * 0.6, text: `${a.score > 0 ? 'Likes' : 'Skips'} ${tag} looks on ${mood} songs` });
  }
  lines.sort((x, y) => y.s - x.s);
  // one line per subject, so a liked look doesn't also show up as a liked tag in the same words
  const seen = new Set<string>();
  return lines.filter((l) => (seen.has(l.text) ? false : (seen.add(l.text), true))).slice(0, max).map(({ sign, text }) => ({ sign, text }));
}

/* ───────────────────────── for the AI planner ───────────────────────── */

export interface TasteSummary {
  /** looks the person keeps, with where they liked them most and a rough strength */
  liked: { id: string; where?: string; n: number }[];
  skipped: { id: string; where?: string; n: number }[];
  /** tags they lean toward or away from in parts like these */
  likedTags: string[];
  skippedTags: string[];
  /** main looks of the last plan for this song: vary away from them */
  avoid: string[];
}

/**
 * A short, anonymous summary for the AI planner: look ids, tags, section labels and counts only. Null
 * when learning is off and there's no earlier plan to vary from.
 */
export function tasteSummary(a: TrackAnalysis): TasteSummary | null {
  const f = useTaste.getState();
  // footage looks only count while there are clips to play (director/footage.ts)
  const avoid = lastPlanLooks(a).filter(mayPlanId).slice(0, 8);
  if (!f.on || !f.reactions.length) return avoid.length ? { liked: [], skipped: [], likedTags: [], skippedTags: [], avoid } : null;
  const ctx = songContext(a);
  const now = Date.now();
  // weight each reaction by how much its song resembles this one
  const looks = new Map<string, Agg>();
  const tags = new Map<string, number>();
  for (const r of f.reactions) {
    const v = r.w * decay(r.at, now) * contextMatch(r, ctx);
    const g = looks.get(r.look) ?? { score: 0, n: 0, where: new Map() };
    g.score += v;
    g.n++;
    if (r.label) g.where.set(r.label, (g.where.get(r.label) ?? 0) + v);
    looks.set(r.look, g);
    for (const t of r.tags) if (!BORING.has(t)) tags.set(t, (tags.get(t) ?? 0) + v / Math.max(3, r.tags.length));
  }
  const ranked = [...looks.entries()].filter(([id]) => lookById(id) && mayPlanId(id));
  const pick = (sign: 1 | -1) =>
    ranked
      .filter(([, g]) => sign * g.score > 0.3)
      .sort((x, y) => sign * (y[1].score - x[1].score))
      .slice(0, 6)
      .map(([id, g]) => {
        const w = topWhere(g, sign);
        return { id, ...(w ? { where: w } : {}), n: Math.max(1, Math.round(Math.abs(g.score))) };
      });
  const tagList = [...tags.entries()];
  return {
    liked: pick(1),
    skipped: pick(-1),
    likedTags: tagList.filter(([, v]) => v > 0.25).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([t]) => t),
    skippedTags: tagList.filter(([, v]) => v < -0.25).sort((x, y) => x[1] - y[1]).slice(0, 6).map(([t]) => t),
    avoid,
  };
}

/* ───────────────────────── settings ───────────────────────── */

export function setLearning(on: boolean) {
  persist({ on });
}

/** forget every reaction and remembered plan */
export function resetTaste() {
  persist({ reactions: [], plans: {} });
}

/* ───────────────────────── picking one look ───────────────────────── */

/**
 * Pick one look from candidates: usually weighted toward what the person likes here, but one time in
 * five (EXPLORE) any candidate they haven't turned down, so it still surprises.
 */
export function pickByTaste<T extends { id: string }>(all: T[], ctx: TasteContext = contextFor(labelNow()), random: () => number = Math.random): T | undefined {
  // a footage look is never suggested while there are no clips for it to play (director/footage.ts)
  const candidates = all.filter((p) => mayPlanId(p.id));
  if (!candidates.length) return undefined;
  const aff = affinityIn(ctx);
  if (random() < EXPLORE) {
    const open = candidates.filter((p) => aff(p.id) > -0.25);
    const from = open.length ? open : candidates;
    return from[Math.floor(random() * from.length)];
  }
  const w = candidates.map((p) => Math.exp(2.2 * aff(p.id)));
  let r = random() * w.reduce((x, y) => x + y, 0);
  for (let i = 0; i < candidates.length; i++) if ((r -= w[i]) <= 0) return candidates[i];
  return candidates[candidates.length - 1];
}

export { labelNow };
