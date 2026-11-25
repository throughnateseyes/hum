/**
 * Which pop-ups a part gets is dealt from a seed, so a part shows the same pop-ups every time it
 * plays (live, after a seek, after a reload and in a render) until someone asks for a different deal.
 *
 * The seed is made of three things:
 *   the song      its per-song key (songKey: the file's name and the shape of its first analysis,
 *                 so splitting or combining parts doesn't change it)
 *   the part      where it starts, to the millisecond, so cutting or joining OTHER parts leaves this
 *                 part's pop-ups alone (an index would shift every part after a split)
 *   the deal      a number per part that "Shuffle pop-ups" (reshufflePops) counts up, saved per song
 *                 in this browser under the part's start time, so a reshuffle survives a reload
 *
 * popDealsVersion() changes on every reshuffle, so the pop-up layers know to deal again at once.
 */
import type { TrackAnalysis } from '../core/types';
import { songKey } from './planCache';
import { useStudio } from './store';

const KEY = 'hum.popDeals';
/** songs kept, oldest dropped first (as many as the other per-song settings) */
const MAX_SONGS = 24;

type Deals = Record<string, Record<string, number>>;

let version = 0;
let cache: { song: string; deals: Record<string, number> } | null = null;

function readAll(): Deals {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** the song that's loaded, as the per-song settings name it (a stand-in when nothing names it) */
function currentSong(): string {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a) return 'none';
  // asked every frame by the pop-up layers: work it out once per song (and per re-cut)
  if (songMemo?.a === a && songMemo.name === s.track?.name) return songMemo.key;
  const key = s.track ? songKey(s.track.name, a) : `song|${a.duration.toFixed(1)}|${Math.round(a.bpm)}`;
  songMemo = { a, name: s.track?.name, key };
  return key;
}
let songMemo: { a: TrackAnalysis; name: string | undefined; key: string } | null = null;

function dealsFor(song: string): Record<string, number> {
  if (cache?.song !== song) {
    const d = readAll()[song];
    cache = { song, deals: d && typeof d === 'object' ? { ...d } : {} };
  }
  return cache.deals;
}

/** a part's key in the saved deals: where it starts, in whole milliseconds */
const startKey = (start: number) => String(Math.round(start * 1000));

/** FNV-1a over a string, then mixed: the same text always gives the same 32-bit number */
function hashStr(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

/** where part `index` starts in the song that's loaded (null when there's no such part) */
function partStart(a: TrackAnalysis | null, index: number): number | null {
  const sec = a?.sections[index];
  return sec ? sec.start : null;
}

/** the seed for the stretch of song starting at `start` (seconds): what popSeedFor uses, by time */
export function popSeedAt(start: number): number {
  const song = currentSong();
  const deal = dealsFor(song)[startKey(start)] ?? 0;
  return hashStr(`${song}|${startKey(start)}|${deal}`);
}

/** the seed for part `index` of the song that is loaded (the same number until it is reshuffled) */
export function popSeedFor(index: number): number {
  const start = partStart(useStudio.getState().analysis, index);
  return popSeedAt(start ?? index * 30);
}

/** how many times part `index` has been reshuffled (0 for the first deal) */
export function popDealOf(index: number): number {
  const start = partStart(useStudio.getState().analysis, index);
  return start === null ? 0 : (dealsFor(currentSong())[startKey(start)] ?? 0);
}

/** counts up on every reshuffle, so the pop-up layers deal again straight away */
export function popDealsVersion(): number {
  return version;
}

/** every reshuffle made in this song, by where the part starts (a project carries them) */
export const dealsHere = (name: string, a: TrackAnalysis): Record<string, number> => ({ ...dealsFor(songKey(name, a)) });

/** a song's reshuffles as a project has them */
export function bringDeals(name: string, a: TrackAnalysis, deals: Record<string, number>) {
  const song = songKey(name, a);
  cache = { song, deals: { ...deals } };
  version++;
  saveDeals(song, deals);
}

/** deal these parts a different set of pop-ups (the Part panel's "Shuffle pop-ups") */
export function reshufflePops(parts: number[]): void {
  const a = useStudio.getState().analysis;
  if (!a || !parts.length) return;
  const song = currentSong();
  const deals = dealsFor(song);
  let changed = false;
  for (const i of new Set(parts)) {
    const start = partStart(a, i);
    if (start === null) continue;
    const k = startKey(start);
    deals[k] = (deals[k] ?? 0) + 1;
    changed = true;
  }
  if (!changed) return;
  version++;
  saveDeals(song, deals);
}

function saveDeals(song: string, deals: Record<string, number>) {
  try {
    const all = readAll();
    delete all[song];
    all[song] = { ...deals };
    // newest last; keep as many songs as the other per-song settings
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SONGS))) delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked: the new deal lasts until the page is reloaded */
  }
}
