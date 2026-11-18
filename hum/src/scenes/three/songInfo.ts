/**
 * Song facts for the poster-style scenes (paper visualizer, pixel cube, flip cards): title,
 * artist, the line being sung and which section we're in. The store is read lazily (inside
 * render only), because the store imports the scene registry.
 */
import type { FrameContext, LyricLine } from '../../core/types';
import { lineAt } from '../../audio/lyrics';
import { useStudio } from '../../state/store';

export interface SongInfo {
  title: string;
  artist: string;
}

const strip = (s: string) => s.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/_/g, ' ').trim();

export function songInfo(): SongInfo {
  try {
    const s = useStudio.getState();
    const name = strip(s.track?.name ?? '');
    let title = (s.lyrics?.title || '').trim();
    let artist = (s.lyrics?.artist || '').trim();
    if (!title) {
      const m = name.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      if (m) {
        title = m[2];
        if (!artist) artist = m[1];
      } else title = name;
    }
    if (!artist && s.track?.source === 'demo') artist = 'Hum demo';
    if (!artist && s.track?.source === 'mic') artist = 'Live';
    return { title: title || 'Untitled', artist: artist || 'Unknown artist' };
  } catch {
    return { title: 'Untitled', artist: 'Unknown artist' };
  }
}

function syncedLines(): LyricLine[] | null {
  try {
    const l = useStudio.getState().lyrics;
    return l?.synced && l.lines.length ? l.lines : null;
  } catch {
    return null;
  }
}

/** the synced lyric line being sung now ({index, text}), or null between lines / without lyrics */
export function currentLyric(time: number): { i: number; text: string } | null {
  const lines = syncedLines();
  if (!lines) return null;
  const hit = lineAt(lines, time + 0.1);
  if (!hit || time > hit.line.end + 0.8 || !hit.line.text.trim()) return null;
  return { i: hit.i, text: hit.line.text };
}

export const hasSyncedLyrics = () => syncedLines() !== null;

/**
 * Index of the current analysed section (-1 before analysis). Changes when the song moves into
 * a new section, so scenes can react to "section change".
 */
export function sectionIndex(frame: FrameContext): number {
  const secs = frame.analysis?.sections;
  if (!secs?.length) return -1;
  const t = frame.audio.time;
  for (let i = secs.length - 1; i >= 0; i--) if (t >= secs[i].start) return i;
  return 0;
}

/** detects the frame a drop fires (drop envelope rising through 0.6) */
export function dropEdge() {
  let prev = 0;
  return (frame: FrameContext) => {
    const d = frame.audio.drop;
    const hit = d > 0.6 && prev <= 0.6;
    prev = d;
    return hit;
  };
}

export const fmtClock = (t: number) => {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export const FONT_SANS = `'Inter Variable', 'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif`;
export const FONT_MONO = `'IBM Plex Mono', ui-monospace, Menlo, monospace`;
