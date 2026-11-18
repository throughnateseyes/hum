/**
 * Find timed lyrics for a song with no typing: lyrics stored in the file first, then LRCLIB
 * (lrclib.net — free, open, no key) by artist + title + duration. Only those words leave the
 * machine, never the audio.
 */
import type { LyricLine, Lyrics } from '../core/types';
import { cleanArtist, cleanTitle, mainArtist, tagsFromFilename, type SongTags } from './tags';

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

export interface LrclibRecord {
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
  const q = Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
  const res = await fetch(`${LRCLIB}${path}${q}`, { headers: { 'Lrclib-Client': CLIENT }, signal });
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
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)|\[.*?\]|feat\..*$|ft\..*$/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export function toLyrics(r: LrclibRecord, duration: number): Lyrics {
  if (r.instrumental) return { lines: [], synced: false, source: 'lrclib', title: r.trackName, artist: r.artistName, instrumental: true };
  // parse against the record's own length: lines are re-timed to the file afterwards if it differs
  const len = Math.max(duration, r.duration || 0);
  let lines: LyricLine[] = [];
  if (r.hasWordSync && r.lyricsfile) lines = parseLyricsfile(r.lyricsfile, len);
  if (!lines.length && r.syncedLyrics) lines = parseLRC(r.syncedLyrics, len);
  if (!lines.length && r.lyricsfile) lines = parseLyricsfile(r.lyricsfile, len);
  return {
    lines,
    synced: lines.length > 0,
    source: 'lrclib',
    title: r.trackName,
    artist: r.artistName,
    plain: r.plainLyrics ?? (lines.length ? lines.map((l) => l.text).join('\n') : undefined),
  };
}

/** how well a record's title / artist match what we searched for: 2 same, 1 close, 0 no */
function titleMatch(r: LrclibRecord, title: string) {
  const a = norm(r.trackName);
  const b = norm(title);
  if (!a || !b) return 0;
  if (a === b) return 2;
  return a.includes(b) || b.includes(a) ? 1 : 0;
}
function artistMatch(r: LrclibRecord, artist?: string) {
  if (!artist) return 0;
  const a = norm(r.artistName);
  const b = norm(artist);
  const m = norm(mainArtist(artist));
  if (!a || !b) return 0;
  if (a === b || a === m) return 2;
  return a.includes(m) || b.includes(a) ? 1 : 0;
}
const hasLyrics = (r: LrclibRecord) => !!(r.syncedLyrics || r.lyricsfile || r.plainLyrics || r.instrumental);

/**
 * The best record for a song. Within the length window: the closest one with lyrics (timed first).
 * Otherwise, a music video is often longer or shorter than the song (intros, outros, edits), so a
 * record with the same title and artist is still taken, and re-timed to the file afterwards.
 */
function choose(list: LrclibRecord[], duration: number, title: string, artist?: string): { r: LrclibRecord; lengthDiff: number } | null {
  const scored = list
    .filter(hasLyrics)
    .map((r) => ({ r, tm: titleMatch(r, title), am: artistMatch(r, artist), dd: Math.abs(r.duration - duration) }))
    .filter((x) => x.tm > 0 && (!artist || x.am > 0 || x.dd <= 1.2));
  const timed = (r: LrclibRecord) => (r.syncedLyrics || r.lyricsfile ? 0 : 5);
  const rank = (a: (typeof scored)[0]) => a.dd + timed(a.r) + (a.r.instrumental ? 8 : 0) + (2 - a.tm) * 2 + (2 - a.am);
  const tol = artist ? 4 : 2.5;
  const close = scored.filter((x) => !duration || x.dd <= tol).sort((a, b) => rank(a) - rank(b));
  if (close[0]) return { r: close[0].r, lengthDiff: 0 };
  // a strong title + artist match with timed lines, whatever its length. Uploads disagree about
  // length (some add silence, some are other edits), so trust the length most of them agree on
  const strong = scored.filter((x) => x.tm === 2 && x.am >= 1 && (x.r.syncedLyrics || x.r.lyricsfile) && x.dd <= Math.max(60, duration * 0.5));
  if (!strong.length) return null;
  const votes = new Map<number, number>();
  for (const x of strong) {
    const k = Math.round(x.r.duration / 3);
    votes.set(k, (votes.get(k) ?? 0) + 1 + (x.am === 2 ? 0.5 : 0));
  }
  const top = Math.max(...votes.values());
  const pickFrom = strong.filter((x) => votes.get(Math.round(x.r.duration / 3)) === top).sort((a, b) => b.am - a.am || a.dd - b.dd);
  return { r: pickFrom[0].r, lengthDiff: pickFrom[0].r.duration - duration };
}

export interface LyricsResult {
  lyrics: Lyrics | null;
  /** what we searched for, to show the person */
  query: { title?: string; artist?: string };
  reason?: string;
  /** record length − file length in seconds, when the lyrics came from a song of a different length */
  lengthDiff?: number;
}

/**
 * Find lyrics for a track: embedded timed lyrics → LRCLIB exact match → LRCLIB search (closest
 * length, or a strong title + artist match of another length) → embedded plain lyrics. Never throws.
 * Only the title, artist and length are sent.
 */
export async function findLyrics(opts: { tags: SongTags; fileName?: string; duration: number; signal?: AbortSignal }): Promise<LyricsResult> {
  const { duration, signal } = opts;
  const fromName = opts.fileName ? tagsFromFilename(opts.fileName) : {};
  const tagTitle = opts.tags.title ? cleanTitle(opts.tags.title) : undefined;
  const tagArtist = opts.tags.artist ? cleanArtist(opts.tags.artist) : undefined;
  const title = tagTitle || fromName.title;
  const artist = tagArtist || (tagTitle ? undefined : fromName.artist);
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

  // every way of asking: as tagged, with just the first artist, as the file name says, title alone
  const asks: { title: string; artist?: string }[] = [];
  const add = (t?: string, a?: string) => {
    if (t && !asks.some((x) => x.title === t && x.artist === a)) asks.push({ title: t, artist: a });
  };
  add(title, artist);
  if (artist) add(title, mainArtist(artist));
  if (fromName.title && (fromName.title !== title || fromName.artist !== artist)) add(fromName.title, fromName.artist);
  add(title, undefined);

  try {
    const d = String(Math.round(duration));
    // 2. exact signature match
    for (const a of asks.filter((x) => x.artist).slice(0, 2)) {
      for (const params of [
        { track_name: a.title, artist_name: a.artist!, ...(album ? { album_name: album } : {}), duration: d },
        ...(album ? [{ track_name: a.title, artist_name: a.artist!, duration: d }] : []),
      ]) {
        const r = (await lrclib('/api/get', params, signal)) as LrclibRecord | null;
        if (r && (r.syncedLyrics || r.lyricsfile || r.instrumental)) return { lyrics: toLyrics(r, duration), query };
      }
    }
    // 3. search each way, keep the best
    const seen = new Map<number, LrclibRecord>();
    let best: ReturnType<typeof choose> = null;
    for (const a of asks.slice(0, 4)) {
      const params: Record<string, string> = a.artist ? { track_name: a.title, artist_name: a.artist } : { q: a.title };
      const list = ((await lrclib('/api/search', params, signal)) as LrclibRecord[] | null) ?? [];
      for (const r of list) seen.set(r.id, r);
      best = choose([...seen.values()], duration, title, artist ?? fromName.artist);
      if (best && best.lengthDiff === 0) break;
    }
    if (best) return { lyrics: toLyrics(best.r, duration), query, ...(best.lengthDiff ? { lengthDiff: best.lengthDiff } : {}) };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { lyrics: plainFallback, query, reason: e instanceof RateLimited ? e.message : 'Couldn’t reach LRCLIB.' };
  }
  return { lyrics: plainFallback, query, reason: 'No lyrics found for this song.' };
}

/* ───────────────────────── manual search ───────────────────────── */

/** search LRCLIB the way a person types it; records with lyrics first, closest length first */
export async function searchLrclib(artist: string, title: string, duration: number): Promise<LrclibRecord[]> {
  const t = title.trim();
  const a = artist.trim();
  if (!t && !a) return [];
  const params: Record<string, string> = t && a ? { track_name: t, artist_name: a } : { q: `${a} ${t}`.trim() };
  let list = ((await lrclib('/api/search', params)) as LrclibRecord[] | null) ?? [];
  if (!list.length && t && a) list = ((await lrclib('/api/search', { q: `${a} ${t}` })) as LrclibRecord[] | null) ?? [];
  const score = (r: LrclibRecord) => (r.syncedLyrics || r.lyricsfile ? 0 : r.plainLyrics ? 1 : 2) * 1000 + Math.abs(r.duration - duration);
  return list.sort((x, y) => score(x) - score(y)).slice(0, 20);
}

/** an LRCLIB record by its id, or from a lrclib.net link (the number in it) */
export async function lrclibById(idOrLink: string): Promise<LrclibRecord | null> {
  const m = /(\d{2,})(?!.*\d)/.exec(idOrLink.trim());
  if (!m) return null;
  return (await lrclib(`/api/get/${m[1]}`, {})) as LrclibRecord | null;
}

/** does the text look like a lrclib.net link or a bare record id? */
export function isLrclibRef(s: string) {
  return /lrclib\.net/i.test(s) || /^\s*\d{2,}\s*$/.test(s);
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
