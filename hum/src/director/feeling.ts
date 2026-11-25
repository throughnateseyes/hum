/**
 * Reading a song's words for their feeling (src/feeling): Claude once per song, kept in this browser by the
 * words themselves, so a remake sends nothing. Until Claude has read them, a small word list stands in.
 */
import type { Lyrics, TrackAnalysis } from '../core/types';
import { EMOTION_IDS, curvesOf, feelingByWords, isEmotion, lineKey, type Curves, type SongFeeling } from '../feeling';
import { originalOf } from '../state/planCache';
import type { VideoPlan } from '../state/plan';

const KEY = 'hum.feeling';
const MAX = 24;

interface Kept {
  key: string;
  f: SongFeeling;
}

const texts = (lyr: Lyrics | null): string[] => (lyr?.lines.length ? lyr.lines.map((l) => l.text) : (lyr?.plain ?? '').split(/\r?\n/)).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);

/** the same words are the same song, however they are timed */
const songOf = (lyr: Lyrics | null) => {
  const t = texts(lyr);
  return t.length ? `${t.length}.${lineKey(t.join('\n'))}` : '';
};

const isFeeling = (f: unknown): f is SongFeeling => !!f && typeof f === 'object' && (f as SongFeeling).v === 1 && !!(f as SongFeeling).lines && typeof (f as SongFeeling).lines === 'object';

let memory: Kept[] | null = null;
function kept(): Kept[] {
  if (memory) return memory;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    memory = Array.isArray(raw) ? raw.filter((x) => x && typeof x.key === 'string' && isFeeling(x.f)) : [];
  } catch {
    memory = [];
  }
  return memory;
}

function keep(key: string, f: SongFeeling) {
  memory = [...kept().filter((x) => x.key !== key), { key, f }].slice(-MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* storage full or blocked: it is asked again next time */
  }
}

/** what Claude read in these words (null: it hasn't), for a project to carry */
export const feelingFor = (lyr: Lyrics | null): SongFeeling | null => kept().find((x) => x.key === songOf(lyr))?.f ?? null;

/** what a project says the words feel like, unless it is known here */
export function bringFeeling(lyr: Lyrics | null, f: unknown) {
  const key = songOf(lyr);
  if (key && isFeeling(f) && !feelingFor(lyr)) keep(key, f);
}

const byWords = new WeakMap<Lyrics, SongFeeling>();
const NONE: SongFeeling = { v: 1, by: 'hum', about: '', lines: {} };

/** what is known of the song's feeling now */
export function feelingNow(lyr: Lyrics | null): SongFeeling {
  const key = songOf(lyr);
  const had = key ? kept().find((x) => x.key === key) : undefined;
  if (had) return had.f;
  if (!lyr) return NONE;
  let f = byWords.get(lyr);
  if (!f) byWords.set(lyr, (f = feelingByWords(lyr)));
  return f;
}

/** against the clock, as things are known now */
export const curvesNow = (a: TrackAnalysis, lyr: Lyrics | null): Curves => curvesOf(originalOf(a), feelingNow(lyr), lyr);

/** the feeling a plan was made with, against the clock (null: made before there was one, so nothing of it applies) */
export function curvesFor(plan: VideoPlan | null | undefined, a: TrackAnalysis, lyr: Lyrics | null): Curves | null {
  const f = plan?.feeling ?? plan?.flat?.src.feeling;
  return isFeeling(f) ? curvesOf(originalOf(a), f, lyr) : null;
}

/** have Claude read the words, unless it has; false when it couldn't (nothing is lost: the word list stands in) */
export async function readFeeling(a: TrackAnalysis, lyr: Lyrics | null, signal: AbortSignal): Promise<boolean> {
  const key = songOf(lyr);
  if (!key || kept().some((x) => x.key === key)) return true;
  const energyAt = (t: number) => a.sections.find((s) => t >= s.start && t < s.end)?.energy ?? 0.5;
  const byKey = new Map<string, { text: string; t?: number; energy?: number; times: number }>();
  const add = (text: string, t?: number) => {
    const k = lineKey(text);
    const had = byKey.get(k);
    if (had) had.times++;
    else byKey.set(k, { text: text.slice(0, 140), times: 1, ...(t !== undefined ? { t: Math.round(t), energy: Math.round(energyAt(t) * 100) / 100 } : {}) });
  };
  if (lyr!.synced) for (const l of lyr!.lines) add(l.text.replace(/\s+/g, ' ').trim(), l.t);
  else for (const t of texts(lyr)) add(t);
  const asked = [...byKey].filter(([, x]) => x.text).slice(0, 120);
  // someone is waiting on the story meanwhile: a refusal is said there, never twice
  const { requestStep } = await import('./client');
  const r = await requestStep('feel', { summary: a.summary, lines: asked.map(([, x]) => x) }, { signal, quiet: true });
  if (!r.ok) return false;
  const lines: SongFeeling['lines'] = {};
  for (const x of Array.isArray(r.json.lines) ? (r.json.lines as Record<string, unknown>[]) : []) {
    const k = typeof x?.i === 'number' ? asked[x.i]?.[0] : undefined;
    if (!k || !isEmotion(x.emotion)) continue;
    const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    lines[k] = [EMOTION_IDS.indexOf(x.emotion), n(x.tone, -1, 1, 0), n(x.weight, 0, 1, 0.3), Math.round(n(x.word, -1, 99, -1)), x.turn === true ? 1 : 0];
  }
  if (!Object.keys(lines).length) return false;
  keep(key, { v: 1, by: 'claude', about: typeof r.json.about === 'string' ? r.json.about.slice(0, 200) : '', lines });
  return true;
}
