/**
 * Find timed lyrics for a song with no typing: lyrics stored in the file first, then LRCLIB
 * (lrclib.net — free, open, no key) by artist + title + duration. Only those words leave the
 * machine, never the audio.
 */
import type { LyricLine, Lyrics } from '../core/types';
import { tagsFromFilename, type SongTags } from './tags';

const LRCLIB = 'https://lrclib.net';
const CLIENT = 'Hum v0.1 (audio-reactive visual playground)';

/* ───────────────────────── parsing ───────────────────────── */

/** "[01:02.34] words" lines (several stamps per line allowed); <mm:ss.xx> word stamps become word timings */
export function parseLRC(text: string, duration: number): LyricLine[] {
  const out: LyricLine[] = [];
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const off = /^\[offset:\s*([+-]?\d+)\]/i.exec(raw);
    if (off) offset = Number(off[1]) / 1000;
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const body = raw.replace(/\[[^\]]*\]/g, '').trim();
    const words: { t: number; end: number; text: string }[] = [];
    for (const m of body.matchAll(/<(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)>\s*([^<]*)/g)) {
      if (m[3].trim()) words.push({ t: Number(m[1]) * 60 + Number(m[2]) - offset, end: 0, text: m[3].trim() });
    }
    const textOnly = words.length ? words.map((w) => w.text).join(' ') : body.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    for (const s of stamps) {
      const t = Number(s[1]) * 60 + Number(s[2].replace(':', '.')) - offset;
      out.push({ t, end: 0, text: textOnly, ...(words.length ? { words: words.map((w) => ({ ...w })) } : {}) });
    }
  }
  return finish(out, duration);
}

/**
 * LRCLIB's "lyricsfile" (YAML): lines with text, start_ms, end_ms and, when word-synced, a words
 * list. A tiny reader for just that shape.
 */
export function parseLyricsfile(yaml: string, duration: number): LyricLine[] {
  const lines: LyricLine[] = [];
  let inLines = false;
  let cur: LyricLine | null = null;
  let word: { t: number; end: number; text: string } | null = null;
  let lineIndent = -1;
  const val = (s: string) => {
    let v = s.trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1);
      v = v.replace(/''/g, "'").replace(/\\"/g, '"');
    }
    return v;
  };
  for (const raw of yaml.split(/\r?\n/)) {
    if (/^lines:\s*$/.test(raw)) {
      inLines = true;
      continue;
    }
    if (!inLines) continue;
    if (/^[A-Za-z_]/.test(raw)) break; // next top-level key
    const m = /^(\s*)(- )?(\w+):\s?(.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    const item = !!m[2];
    const key = m[3];
    const v = m[4];
    if (item && (lineIndent < 0 || indent <= lineIndent)) {
      lineIndent = indent;
      cur = { t: 0, end: 0, text: '' };
      lines.push(cur);
      word = null;
    } else if (item && cur) {
      word = { t: 0, end: 0, text: '' };
      (cur.words ??= []).push(word);
    }
    const target = word && indent > lineIndent + 1 ? word : cur;
    if (!target) continue;
    if (key === 'text') target.text = val(v);
    else if (key === 'start_ms') target.t = Number(v) / 1000;
    else if (key === 'end_ms') target.end = Number(v) / 1000;
    else if (key === 'words') word = null;
  }
  return finish(lines.filter((l) => l.text || l.words?.length), duration);
}

/** sort, fill line and word end times, drop empty spacer lines */
function finish(lines: LyricLine[], duration: number): LyricLine[] {
  lines.sort((a, b) => a.t - b.t);
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    const l = lines[i];
    if (!l.end || l.end <= l.t) l.end = next ? next.t : Math.min(duration || l.t + 5, l.t + 6);
    // cap how long a line lingers before an instrumental gap
    l.end = Math.min(l.end, l.t + Math.max(4, l.text.length * 0.12 + 2));
    if (l.words) {
      for (let j = 0; j < l.words.length; j++) {
        const w = l.words[j];
        if (!w.end || w.end <= w.t) w.end = l.words[j + 1]?.t ?? l.end;
      }
    }
  }
  return lines.filter((l) => l.text.trim());
}

/* ───────────────────────── LRCLIB ───────────────────────── */

interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration: number;
  instrumental: boolean;
  hasWordSync?: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
  lyricsfile?: string;
}

class RateLimited extends Error {}

async function lrclib(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${LRCLIB}${path}?${new URLSearchParams(params)}`, { headers: { 'Lrclib-Client': CLIENT }, signal });
  if (res.status === 404) return null;
  if (res.status === 429) throw new RateLimited('LRCLIB is rate limiting right now');
  if (!res.ok) throw new Error(`LRCLIB error ${res.status}`);
  if (!(res.headers.get('content-type') ?? '').includes('json')) return null;
  return res.json();
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]|feat\..*$|ft\..*$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function toLyrics(r: LrclibRecord, duration: number): Lyrics {
  if (r.instrumental) return { lines: [], synced: false, source: 'lrclib', title: r.trackName, artist: r.artistName, instrumental: true };
  let lines: LyricLine[] = [];
  if (r.hasWordSync && r.lyricsfile) lines = parseLyricsfile(r.lyricsfile, duration);
  if (!lines.length && r.syncedLyrics) lines = parseLRC(r.syncedLyrics, duration);
  if (!lines.length && r.lyricsfile) lines = parseLyricsfile(r.lyricsfile, duration);
  return {
    lines,
    synced: lines.length > 0,
    source: 'lrclib',
    title: r.trackName,
    artist: r.artistName,
    plain: r.plainLyrics ?? undefined,
  };
}

/** the closest-length record that has lyrics, preferring timed ones; null if nothing is within `tol` seconds */
function pick(list: LrclibRecord[], duration: number, tol: number, title?: string): LrclibRecord | null {
  const t = title ? norm(title) : '';
  const scored = list
    .filter((r) => !duration || Math.abs(r.duration - duration) <= tol)
    .filter((r) => !t || norm(r.trackName).includes(t) || t.includes(norm(r.trackName)))
    .map((r) => ({ r, s: Math.abs(r.duration - duration) + (r.syncedLyrics ? 0 : 5) + (r.instrumental ? 8 : 0) }))
    .sort((a, b) => a.s - b.s);
  return scored[0]?.r ?? null;
}

export interface LyricsResult {
  lyrics: Lyrics | null;
  /** what we searched for, to show the person */
  query: { title?: string; artist?: string };
  reason?: string;
}

/**
 * Find lyrics for a track: embedded timed lyrics → LRCLIB exact match → LRCLIB search (closest
 * duration) → embedded plain lyrics. Never throws.
 */
export async function findLyrics(opts: { tags: SongTags; fileName?: string; duration: number; signal?: AbortSignal }): Promise<LyricsResult> {
  const { duration, signal } = opts;
  const fromName = opts.fileName ? tagsFromFilename(opts.fileName) : {};
  const title = opts.tags.title ?? fromName.title;
  const artist = opts.tags.artist ?? (opts.tags.title ? undefined : fromName.artist);
  const album = opts.tags.album;
  const query = { title, artist };

  // 1. lyrics already in the file
  const embedded = opts.tags.lyrics;
  if (embedded && /\[\d{1,3}:\d{1,2}/.test(embedded)) {
    const lines = parseLRC(embedded, duration);
    if (lines.length) return { lyrics: { lines, synced: true, source: 'file', title, artist }, query };
  }
  const plainFallback: Lyrics | null = embedded ? { lines: [], synced: false, source: 'file', title, artist, plain: embedded } : null;
  if (!title) return { lyrics: plainFallback, query, reason: 'The file has no title to search for.' };

  try {
    const d = String(Math.round(duration));
    // 2. exact signature match
    if (artist) {
      for (const params of [
        { track_name: title, artist_name: artist, ...(album ? { album_name: album } : {}), duration: d },
        ...(album ? [{ track_name: title, artist_name: artist, duration: d }] : []),
      ]) {
        const r = (await lrclib('/api/get', params, signal)) as LrclibRecord | null;
        if (r && (r.syncedLyrics || r.lyricsfile || r.instrumental)) return { lyrics: toLyrics(r, duration), query };
      }
    }
    // 3. search, keep the closest length
    const params: Record<string, string> = artist ? { track_name: title, artist_name: artist } : { q: title };
    const list = ((await lrclib('/api/search', params, signal)) as LrclibRecord[] | null) ?? [];
    // without an artist, insist on a matching title, or failing that a near-exact length
    const best = artist ? pick(list, duration, 4) : (pick(list, duration, 2.5, title) ?? pick(list, duration, 1.2));
    if (best) return { lyrics: toLyrics(best, duration), query };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { lyrics: plainFallback, query, reason: e instanceof RateLimited ? e.message : 'Couldn’t reach LRCLIB.' };
  }
  return { lyrics: plainFallback, query, reason: 'No lyrics found for this song.' };
}

/** index of the last line that has started by time t (-1 before the first) */
export function indexAt(lines: LyricLine[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** the line being sung at time t (null between lines) */
export function lineAt(lines: LyricLine[], t: number): { i: number; line: LyricLine } | null {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const line = lines[found];
  return t < line.end ? { i: found, line } : null;
}

/** all lyric text between two times (for the video planner) */
export function textBetween(lines: LyricLine[], a: number, b: number, max = 220): string {
  const s = lines
    .filter((l) => l.t >= a - 0.3 && l.t < b - 0.3)
    .map((l) => l.text)
    .join(' / ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
