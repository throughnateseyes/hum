/**
 * Saved video plans, one per song, in this browser.
 *
 * A plan from Claude costs a request, so the last one made for a song is kept: "Make a video" on a
 * song that already has one plays it straight away, for free. "Remake video" (or a typed wish) always
 * asks again and replaces it. Changes to the plan (picking a look for a part, an edit in the Director
 * chat) are saved too, so the saved plan is the one the person last saw.
 *
 * A song is recognised by its name and the shape of its analysis (length, tempo, where the parts
 * start) plus its lyrics and whether there are video clips, so a different file with the same name,
 * lyrics added later, or clips added later, asks again.
 * At most MAX_SAVED songs are kept, oldest dropped first.
 *
 * The person's own pop-up levels per part (store.partPops, set with setPartPops) are kept beside the
 * plans, per song but not per plan: they come back when the song is loaded again and stay through
 * "Remake video", offline plans and saved plans alike, until the song's parts change.
 */
import type { Lyrics, TrackAnalysis } from '../core/types';
import type { VideoPlan } from './plan';
import { useStudio } from './store';

const KEY = 'hum.plans';
const MAX_SAVED = 24;
/** a saved list bigger than this is trimmed from the oldest end (plans are a few kB each) */
const MAX_BYTES = 400_000;

interface Entry {
  key: string;
  at: number;
  plan: VideoPlan;
}

/** short stable hash (FNV-1a) */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/* ── the person's own part lines (split and combine on the timeline) ── */

/** a re-cut analysis → the analysis it was cut from (the song as Hum heard it) */
const cutFrom = new WeakMap<TrackAnalysis, TrackAnalysis>();
/** re-cuts made from one analysis, by their part lines, so the same lines always give the same object */
const cutsOf = new WeakMap<TrackAnalysis, Map<string, TrackAnalysis>>();

/** the analysis as Hum made it, before any split or combine (itself when it was never re-cut) */
export function originalOf(a: TrackAnalysis): TrackAnalysis {
  return cutFrom.get(a) ?? a;
}

/** where every part starts, rounded to the millisecond (what a plan keeps as `bounds`) */
export function boundsOf(a: TrackAnalysis): number[] {
  return a.sections.map((s) => Math.round(s.start * 1000) / 1000);
}

/**
 * The song cut into parts at `bounds` (the start of every part, first one at the song's start). Each
 * new part takes its label, group and energy from the part of the original it starts in: a split gives
 * both halves the part they came from, a combine keeps the first part's. The same lines always give
 * the same object (caches keyed by the analysis keep working). Null when the lines don't fit the song.
 */
export function cutAnalysis(a: TrackAnalysis, bounds: number[] | undefined | null): TrackAnalysis | null {
  const orig = originalOf(a);
  const secs = orig.sections;
  if (!bounds?.length || !secs.length) return orig;
  const end = secs[secs.length - 1].end;
  const ok = bounds.every((b, k) => Number.isFinite(b) && b >= 0 && b < end && (k === 0 || b > bounds[k - 1] + 0.05)) && Math.abs(bounds[0] - secs[0].start) < 0.01;
  if (!ok) return null;
  const key = bounds.join(',');
  if (key === boundsOf(orig).join(',')) return orig;
  let byKey = cutsOf.get(orig);
  if (!byKey) cutsOf.set(orig, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit) return hit;
  const parents: number[] = [];
  const sections = bounds.map((b, k) => {
    let j = 0;
    for (let x = secs.length - 1; x >= 0; x--) if (b + 0.001 >= secs[x].start) {
      j = x;
      break;
    }
    parents.push(j);
    return { ...secs[j], start: k === 0 ? secs[0].start : b, end: bounds[k + 1] ?? end };
  });
  // the harmony of each part is its section's (feel.ts and the planner read it by part index); a
  // repeat points at the first part of the section it repeats
  const H = orig.harmony;
  const harmony = H && H.sections.length === secs.length
    ? {
        ...H,
        sections: parents.map((j) => {
          const h = H.sections[j];
          const r = h.repeatOf;
          return r === undefined ? h : { ...h, repeatOf: Math.max(0, parents.indexOf(r)) };
        }),
      }
    : H;
  const cut: TrackAnalysis = { ...orig, sections, ...(harmony ? { harmony } : {}) };
  cutFrom.set(cut, orig);
  parentsBy.set(cut, parents);
  sectionsOf.set(sections, cut);
  byKey.set(key, cut);
  return cut;
}

/** for each part of a re-cut, the section of the original it lies in */
const parentsBy = new WeakMap<TrackAnalysis, number[]>();
/** a re-cut's part list → the re-cut (so names can be told from a bare list of parts) */
const sectionsOf = new WeakMap<TrackAnalysis['sections'], TrackAnalysis>();

/** for each part of `a`, the section of the song as Hum heard it that the part lies in */
export function parentsOf(a: TrackAnalysis): number[] {
  return parentsBy.get(a) ?? a.sections.map((_, i) => i);
}

/** the re-cut a list of parts belongs to (undefined: the song's own parts, or a list from elsewhere) */
export function cutOfSections(secs: TrackAnalysis['sections']): TrackAnalysis | undefined {
  return sectionsOf.get(secs);
}

// a song is recognised by the parts Hum heard in it, whatever the person split or combined since
const songShape = (a: TrackAnalysis) => {
  const o = originalOf(a);
  return `${o.duration.toFixed(1)}|${Math.round(o.bpm)}|${o.sections.map((s) => `${s.label[0]}${s.start.toFixed(1)}`).join(',')}`;
};

/** which song a person's per-part settings belong to (its name and parts, whatever its lyrics) */
export function songKey(name: string, a: TrackAnalysis): string {
  return `${name}|${hash(songShape(a))}`;
}

/**
 * Which song (and which version of its lyrics) a plan belongs to, and whether the person had added
 * video clips: a plan made without clips has no footage in it, so once clips are added "Make a video"
 * must plan again rather than replay it (and a footage plan isn't replayed after the clips are gone).
 * Keys without clips are spelled as before, so plans saved earlier still play.
 */
export function planKey(name: string, a: TrackAnalysis, lyr: Lyrics | null): string {
  const shape = songShape(a);
  const words = lyr?.synced && lyr.lines.length ? `s${hash(lyr.lines.map((l) => `${l.t.toFixed(1)}${l.text}`).join('\n'))}` : lyr?.plain ? `p${hash(lyr.plain)}` : 'n';
  const st = useStudio.getState();
  // photos alone (two or more) make a footage video too (director/footage.ts)
  const clips = (st.clips?.length ?? 0) > 0 ? '|clips' : (st.photos?.filter((p) => !p.builtin).length ?? 0) >= 2 ? '|photos' : '';
  return `${name}|${hash(shape)}|${words}${clips}`;
}

function readAll(): Entry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.key === 'string' && e.plan && Array.isArray(e.plan.looks)) : [];
  } catch {
    return [];
  }
}

function writeAll(list: Entry[]) {
  let out = list.slice(-MAX_SAVED);
  try {
    let json = JSON.stringify(out);
    while (json.length > MAX_BYTES && out.length > 1) {
      out = out.slice(1);
      json = JSON.stringify(out);
    }
    localStorage.setItem(KEY, json);
  } catch {
    /* storage full or blocked: plans just aren't remembered */
  }
}

/**
 * The saved plan for this song, if it still fits the analysis and every look it uses still exists
 * (a look the person deleted makes the plan unusable, so it's dropped).
 */
export function savedPlan(key: string, a: TrackAnalysis, lookExists: (id: string) => boolean): VideoPlan | null {
  const list = readAll();
  const e = list.find((x) => x.key === key);
  if (!e) return null;
  const p = e.plan;
  // a plan with the person's own part lines fits the song cut at those lines
  const cut = cutAnalysis(a, p.bounds);
  const ok =
    !!cut &&
    p.looks.length === cut.sections.length &&
    Math.abs(p.duration - a.duration) < 0.5 &&
    p.looks.every((id) => !id || lookExists(id)) &&
    (p.rotate ?? []).every((r) => !r || r.every(lookExists)) &&
    (p.interludes ?? []).every((id) => !id || lookExists(id));
  if (!ok) {
    writeAll(list.filter((x) => x !== e));
    return null;
  }
  // most recently used last
  writeAll([...list.filter((x) => x !== e), { ...e, at: Date.now() }]);
  return p;
}

export function savePlan(key: string, plan: VideoPlan) {
  writeAll([...readAll().filter((x) => x.key !== key), { key, at: Date.now(), plan }]);
}

export function forgetPlans() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing saved */
  }
}

/**
 * Save the plan on screen for the loaded song now, and keep saving its changes. A plan changed by
 * hand (the part sheet) is the person's video, so it's kept whoever planned it.
 */
export function keepPlan(plan: VideoPlan) {
  const s = useStudio.getState();
  if (!s.track || s.track.source === 'mic' || !s.analysis || plan.looks.length !== s.analysis.sections.length) return;
  const key = planKey(s.track.name, s.analysis, s.lyrics);
  savePlan(key, plan);
  watchPlan(key, plan, s.analysis);
}

/* ── keep the saved plan up to date as the person edits it ── */

let watching: { key: string; plan: VideoPlan; analysis: TrackAnalysis } | null = null;
let unsub: (() => void) | null = null;
let pending = 0;

/** follow this plan: later changes to it (for the same song) are saved under the same key */
export function watchPlan(key: string, plan: VideoPlan, analysis: TrackAnalysis) {
  watching = { key, plan, analysis };
  unsub ??= useStudio.subscribe((s) => {
    const w = watching;
    if (!w || s.plan === w.plan) return;
    if (!s.plan || !s.analysis || originalOf(s.analysis) !== originalOf(w.analysis)) {
      watching = null; // a new song, or the plan was cleared (a split or combine is still the same song)
      return;
    }
    w.plan = s.plan;
    w.analysis = s.analysis;
    // a burst of edits (dragging through looks) saves once
    clearTimeout(pending);
    const { key: k, plan: p } = w;
    pending = window.setTimeout(() => savePlan(k, p), 800);
  });
}

/* ── the person's own settings per part (pop-ups, hand-drawn, words, footage picture), per song ── */

type PartField = 'partPops' | 'partHand' | 'partWords' | 'partShot';
const PART_KEYS: Record<PartField, string> = { partPops: 'hum.partPops', partHand: 'hum.partHand', partWords: 'hum.partWords', partShot: 'hum.partShot' };
const PART_OK: Record<PartField, (v: unknown) => boolean> = {
  partPops: (v) => v === null || (typeof v === 'number' && v >= 0 && v <= 3),
  partHand: (v) => v === null || typeof v === 'boolean',
  partWords: (v) => v === null || (typeof v === 'string' && v.length <= 200),
  partShot: (v) => v === null || okShot(v),
};

/** a saved footage picture record (store.partShot) still reads as one */
function okShot(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const num = (k: string, lo: number, hi: number) => r[k] === undefined || (typeof r[k] === 'number' && (r[k] as number) >= lo && (r[k] as number) <= hi);
  const text = (k: string) => r[k] === undefined || (typeof r[k] === 'string' && (r[k] as string).length <= 40);
  const media = r.media === undefined || (Array.isArray(r.media) && r.media.length <= 50 && r.media.every((x) => typeof x === 'string'));
  return text('style') && text('treatment') && text('motion') && text('moment') && media && num('from', 0, 36000) && num('seed', 1, 999) && num('focusX', 0, 1) && num('focusY', 0, 1) && num('zoom', 1, 3);
}
const FIELDS = Object.keys(PART_KEYS) as PartField[];

function readPart(field: PartField): Record<string, unknown[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(PART_KEYS[field]) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writePart(field: PartField, key: string, values: unknown[] | null) {
  try {
    const all = readPart(field);
    delete all[key];
    if (values) all[key] = values;
    // newest last; keep as many songs as plans
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SAVED))) delete all[k];
    localStorage.setItem(PART_KEYS[field], JSON.stringify(all));
  } catch {
    /* storage full or blocked: the settings just aren't remembered */
  }
}

/** the saved values for this song when they fit its parts as they are now */
function savedPart(field: PartField, key: string, n: number): unknown[] | null {
  const v = readPart(field)[key];
  return Array.isArray(v) && v.length === n && v.every(PART_OK[field]) && v.some((x) => x !== null) ? v : null;
}

let recutting = false;
/**
 * Run a split, a combine or an undo of one: the store change it makes carries every per-part setting
 * already re-indexed, so those are saved as they are (none set means none saved), never read back.
 */
export function duringRecut(fn: () => void) {
  recutting = true;
  try {
    fn();
  } finally {
    recutting = false;
  }
}

// a song's parts are known: bring back its per-part settings; the person changes one: remember it.
// A split or combine swaps the analysis for a re-cut of the same song: that keeps (and saves) the
// settings it re-indexed, or, after a reload, finds the ones saved for the re-cut parts.
useStudio.subscribe((s, prev) => {
  const a = s.analysis;
  if (!a || !s.track) return;
  const key = songKey(s.track.name, a);
  const n = a.sections.length;
  if (a !== prev.analysis) {
    const same = !!prev.analysis && originalOf(prev.analysis) === originalOf(a);
    const patch: Partial<Record<PartField, unknown[] | null>> = {};
    if (!same) {
      // a new song: the last song's hand-drawn, words, pictures and picked parts go (tracks.ts clears pop-ups)
      if (s.partHand) patch.partHand = null;
      if (s.partWords) patch.partWords = null;
      if (s.partShot) patch.partShot = null;
      if (s.selectedParts.length) (patch as { selectedParts?: number[] }).selectedParts = [];
    }
    for (const f of FIELDS) {
      const cur = f in patch ? patch[f] : s[f];
      if (same && (recutting || (cur && cur.length === n))) writePart(f, key, cur && cur.length === n ? cur : null);
      else {
        const saved = savedPart(f, key, n);
        if (saved) patch[f] = saved;
      }
    }
    if (Object.keys(patch).length) s.set(patch as Partial<typeof s>);
    return;
  }
  for (const f of FIELDS) if (s[f] !== prev[f]) writePart(f, key, s[f]);
});
