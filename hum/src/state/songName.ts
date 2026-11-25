/**
 * What the song is called in the video: the title and artist the person typed, else the ones in the file's
 * name with everything that only describes the upload left out ("(Official Audio)", "[HQ]", a track number).
 * The file's own name stays what the song is saved under (TrackInfo.name), so renaming it loses nothing.
 * Imports no store: the store keeps these (songName) and scenes read them through it.
 */
import { tagsFromFilename } from '../audio/tags';

/** typed by the person, for one song */
export interface SongName {
  title: string;
  artist: string;
  /** not written on clips and photos at all */
  hidden?: boolean;
}

const KEY = 'hum.songNames';
const MAX_SONGS = 120;
const text = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 80) : '');

export function cleanSongName(raw: unknown): SongName | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const n: SongName = { title: text(r.title), artist: text(r.artist), ...(r.hidden === true ? { hidden: true } : {}) };
  return n.title || n.artist || n.hidden ? n : null;
}

function readAll(): Record<string, unknown> {
  try {
    const j: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const loadSongName = (song: string): SongName | null => (song ? cleanSongName(readAll()[song]) : null);

export function saveSongName(song: string, name: SongName | null) {
  if (!song) return;
  try {
    const all = readAll();
    delete all[song];
    if (name) all[song] = name;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SONGS))) delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage may be unavailable */
  }
}

/** what a song's file name says it is */
export function nameInFile(file: string): { title: string; artist: string } {
  const t = tagsFromFilename(file);
  return { title: t.title ?? file.trim(), artist: t.artist ?? '' };
}

interface Named {
  track: { name: string; source: string } | null;
  songName: SongName | null;
}

/** the song's title and artist as the video writes them ('' when there is none) */
export function songCredit(s: Named): { title: string; artist: string } {
  if (!s.track) return { title: '', artist: '' };
  const file = s.track.source === 'file' ? nameInFile(s.track.name) : { title: s.track.name, artist: '' };
  return { title: s.songName?.title || file.title, artist: s.songName?.artist || file.artist };
}

/** "Artist - Title", for a menu or a file's name */
export function songLabel(s: Named): string {
  const c = songCredit(s);
  return [c.artist, c.title].filter(Boolean).join(' - ');
}
