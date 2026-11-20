/**
 * Saved video plans, one per song, in this browser.
 *
 * A plan from Claude costs a request, so the last one made for a song is kept: "Make a video" on a
 * song that already has one plays it straight away, for free. "Remake video" (or a typed wish) always
 * asks again and replaces it. Changes to the plan (picking a look for a part, an edit in the Director
 * chat) are saved too, so the saved plan is the one the person last saw.
 *
 * A song is recognised by its name and the shape of its analysis (length, tempo, where the parts
 * start) plus its lyrics, so a different file with the same name, or lyrics added later, asks again.
 * At most MAX_SAVED songs are kept, oldest dropped first.
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

/** which song (and which version of its lyrics) a plan belongs to */
export function planKey(name: string, a: TrackAnalysis, lyr: Lyrics | null): string {
  const shape = `${a.duration.toFixed(1)}|${Math.round(a.bpm)}|${a.sections.map((s) => `${s.label[0]}${s.start.toFixed(1)}`).join(',')}`;
  const words = lyr?.synced && lyr.lines.length ? `s${hash(lyr.lines.map((l) => `${l.t.toFixed(1)}${l.text}`).join('\n'))}` : lyr?.plain ? `p${hash(lyr.plain)}` : 'n';
  return `${name}|${hash(shape)}|${words}`;
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
  const ok =
    p.looks.length === a.sections.length &&
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
    if (!s.plan || s.analysis !== w.analysis) {
      watching = null; // a new song, or the plan was cleared
      return;
    }
    w.plan = s.plan;
    // a burst of edits (dragging through looks) saves once
    clearTimeout(pending);
    const { key: k, plan: p } = w;
    pending = window.setTimeout(() => savePlan(k, p), 800);
  });
}
